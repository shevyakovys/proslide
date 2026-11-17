import { validateDeck, validateAnswer, summarize, fail, checkedText } from './domain.js';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
// This credential stays in the Edge runtime. It is never sent to the browser.
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const siteUrl = 'https://shevyakovys.github.io/proslide/';
const origin = new URL(siteUrl).origin;
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'apikey, content-type, x-author-token, x-participant-token', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
const hash = async value => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 600000 }, key, 256));
}
function constantEqual(a, b) { let diff = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }

async function db(table, { method = 'GET', query = {}, body, prefer = 'return=representation' } = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${new URLSearchParams(query)}`, {
    method, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await res.text(), data = raw ? JSON.parse(raw) : null;
  if (!res.ok) throw Object.assign(new Error(data?.message || 'Database request failed'), { code: data?.code });
  return data;
}
const rpc = (name, body) => db(`rpc/proslide_${name}`, { method: 'POST', body });
async function rate(bucket, limit, seconds) { if (!await rpc('rate', { p_bucket: bucket, p_limit: limit, p_seconds: seconds })) fail(429, 'Слишком много запросов. Попробуйте позже.'); }
async function count(table, query) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${new URLSearchParams({ ...query, select: '*', limit: '0' })}`, { method: 'HEAD', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'count=exact' } });
  if (!res.ok) throw new Error('Не удалось получить статистику');
  return Number(res.headers.get('content-range')?.split('/')[1] || 0);
}
async function author(req) {
  const raw = req.headers.get('x-author-token') || '';
  if (!/^[a-f0-9]{64}$/.test(raw)) fail(401, 'Войдите в аккаунт');
  const rows = await db('proslide_auth', { query: { token_hash: `eq.${await hash(raw)}`, expires: `gt.${new Date().toISOString()}`, select: 'proslide_users(id,email,name)' } });
  if (!rows.length || !rows[0].proslide_users) fail(401, 'Сессия истекла. Войдите снова');
  return rows[0].proslide_users;
}
async function room(code) {
  const rows = await db('proslide_rooms', { query: { code: `eq.${code}` } });
  if (!rows.length) fail(404, 'Сессия не найдена. Проверьте код.');
  return rows[0];
}
async function getDeck(id, owner) {
  const rows = await db('proslide_decks', { query: { id: `eq.${id}`, owner: `eq.${owner}` } });
  if (!rows.length) fail(404, 'Презентация не найдена');
  return { id: rows[0].id, ...rows[0].data, updated: rows[0].updated };
}
async function answers(code, slide) {
  const values = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await db('proslide_answers', { query: { room: `eq.${code}`, slide_id: `eq.${slide}`, select: 'value', order: 'participant_hash', limit: '1000', offset: String(offset) } });
    values.push(...page.map(a => a.value));
    if (page.length < 1000) break;
  }
  return values;
}
async function state(r, participantHash, owner = false) {
  const d = r.snapshot, s = d.slides[r.slide];
  const [participants, answered, values] = await Promise.all([
    count('proslide_participants', { room: `eq.${r.code}` }),
    participantHash ? db('proslide_answers', { query: { room: `eq.${r.code}`, slide_id: `eq.${s.id}`, participant_hash: `eq.${participantHash}`, select: 'slide_id' } }) : [],
    owner || r.show_results ? answers(r.code, s.id) : null
  ]);
  return { code: r.code, title: d.title, theme: d.theme, status: r.status, accepting: r.accepting, showResults: r.show_results, index: r.slide, slideCount: d.slides.length, slide: s, participants, answered: !!answered.length, results: values ? summarize(s, values) : null };
}
async function readBody(req) {
  const reader = req.body?.getReader(); if (!reader) return {};
  const chunks = []; let size = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 262144) { await reader.cancel(); fail(413, 'Слишком большой запрос'); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const value = JSON.parse(new TextDecoder().decode(bytes) || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Некорректный запрос'); return value; } catch { fail(400, 'Некорректный JSON'); }
}

Deno.serve(async req => {
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: jsonHeaders });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: jsonHeaders });
  try {
    if (req.headers.has('origin') && req.headers.get('origin') !== origin) fail(403, 'Недопустимый источник запроса');
    const path = new URL(req.url).pathname.replace(/^.*\/proslide-api/, ''), method = req.method;
    if (path === '/health') return json({ ok: true, storage: 'postgres' });
    if (path === '/config') return json({ publicUrl: siteUrl.replace(/\/$/, '') });
    if (['/register', '/login'].includes(path) && method === 'POST') {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
      await rate(`auth:${await hash(ip)}`, 20, 600);
      const b = await readBody(req), email = checkedText(b.email, 254, 'Email').toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Введите корректный email');
      if (typeof b.password !== 'string' || b.password.length < 10 || b.password.length > 128) fail(400, 'Пароль: от 10 до 128 символов');
      let u;
      if (path === '/register') {
        const name = checkedText(b.name, 80, 'Имя'), salt = randomToken();
        const password = `${salt}:${await passwordHash(b.password, salt)}`;
        try { const rows = await db('proslide_users', { method: 'POST', body: { email, name, password }, query: { select: 'id,email,name' } }); u = rows[0]; }
        catch (e) { if (e.code === '23505') fail(409, 'Этот email уже зарегистрирован'); throw e; }
      } else {
        const rows = await db('proslide_users', { query: { email: `eq.${email}` } });
        const [salt, stored] = (rows[0]?.password || `${'0'.repeat(64)}:${'0'.repeat(64)}`).split(':');
        const computed = await passwordHash(b.password, salt);
        if (!constantEqual(computed, stored) || !rows.length) fail(401, 'Неверный email или пароль');
        u = { id: rows[0].id, email: rows[0].email, name: rows[0].name };
      }
      const raw = randomToken();
      await db('proslide_auth', { method: 'DELETE', query: { expires: `lt.${new Date().toISOString()}` }, prefer: 'return=minimal' });
      await db('proslide_auth', { method: 'POST', body: { token_hash: await hash(raw), user_id: u.id, expires: new Date(Date.now() + 2592000000).toISOString() }, prefer: 'return=minimal' });
      return json({ ...u, authorToken: raw });
    }
    if (path === '/logout' && method === 'POST') {
      const raw = req.headers.get('x-author-token') || '';
      await db('proslide_auth', { method: 'DELETE', query: { token_hash: `eq.${await hash(raw)}` }, prefer: 'return=minimal' });
      return json({ ok: true });
    }
    if (path === '/me' && method === 'GET') return json(await author(req));
    if (path === '/decks') {
      const u = await author(req);
      if (method === 'GET') return json((await db('proslide_decks', { query: { owner: `eq.${u.id}`, order: 'updated.desc' } })).map(d => ({ id: d.id, ...d.data, updated: d.updated })));
      if (method === 'POST') { const data = validateDeck(await readBody(req)); const rows = await db('proslide_decks', { method: 'POST', body: { owner: u.id, data, updated: Date.now() } }); return json({ id: rows[0].id, ...data, updated: rows[0].updated }, 201); }
    }
    let m = path.match(/^\/decks\/([a-f0-9-]{36})(\/start)?$/);
    if (m) {
      const u = await author(req), d = await getDeck(m[1], u.id);
      if (m[2] && method === 'POST') {
        await rate(`start:${u.id}`, 30, 3600);
        for (let attempt = 0; attempt < 10; attempt++) {
          const code = String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
          try { await db('proslide_rooms', { method: 'POST', body: { code, owner: u.id, deck_id: d.id, snapshot: d, created: Date.now() }, prefer: 'return=minimal' }); return json({ code }, 201); }
          catch (e) { if (e.code !== '23505') throw e; }
        }
        fail(503, 'Попробуйте запустить сессию ещё раз');
      }
      if (!m[2] && method === 'GET') return json(d);
      if (!m[2] && method === 'PUT') { const data = validateDeck(await readBody(req)); await db('proslide_decks', { method: 'PATCH', query: { id: `eq.${d.id}`, owner: `eq.${u.id}` }, body: { data, updated: Date.now() } }); return json(await getDeck(d.id, u.id)); }
      if (!m[2] && method === 'DELETE') { await db('proslide_decks', { method: 'DELETE', query: { id: `eq.${d.id}`, owner: `eq.${u.id}` } }); return json({ ok: true }); }
    }
    if (path === '/rooms' && method === 'GET') {
      const u = await author(req);
      return json((await db('proslide_rooms', { query: { owner: `eq.${u.id}`, select: 'code,snapshot,status,created', order: 'created.desc' } })).map(r => ({ code: r.code, title: r.snapshot.title, status: r.status, created: r.created })));
    }
    m = path.match(/^\/rooms\/(\d{6})(?:\/(join|answer|host|export))?$/);
    if (m) {
      const r = await room(m[1]);
      if (m[2] === 'join' && method === 'POST') {
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
        await rate(`join:${await hash(ip)}`, 300, 60);
        const existing = req.headers.get('x-participant-token') || '', raw = /^[a-f0-9]{64}$/.test(existing) ? existing : randomToken();
        const tokenHash = await hash(raw);
        await rpc('join', { p_room: r.code, p_token: tokenHash });
        return json({ ...await state(await room(r.code), tokenHash), participantToken: raw });
      }
      if (['host', 'export'].includes(m[2])) {
        const u = await author(req); if (u.id !== r.owner) fail(403, 'Доступ только автору');
        if (m[2] === 'export' && method === 'GET') {
          const slides = await Promise.all(r.snapshot.slides.map(async s => ({ ...s, results: summarize(s, await answers(r.code, s.id), true) })));
          return json({ title: r.snapshot.title, code: r.code, created: r.created, slides });
        }
        if (m[2] === 'host' && method === 'PATCH') {
          const b = await readBody(req), update = {};
          if (b.index !== undefined) { if (!Number.isInteger(b.index) || b.index < 0 || b.index >= r.snapshot.slides.length) fail(400, 'Некорректный номер слайда'); update.slide = b.index; }
          if (b.status !== undefined) { if (!['live', 'ended'].includes(b.status)) fail(400, 'Некорректный статус'); update.status = b.status; }
          for (const [key, column] of [['accepting', 'accepting'], ['showResults', 'show_results']]) if (b[key] !== undefined) { if (typeof b[key] !== 'boolean') fail(400, 'Некорректная настройка'); update[column] = b[key]; }
          if (!Object.keys(update).length) fail(400, 'Нет изменений');
          const rows = await db('proslide_rooms', { method: 'PATCH', query: { code: `eq.${r.code}`, owner: `eq.${u.id}`, status: 'eq.live' }, body: update });
          if (!rows.length) fail(409, 'Сессия завершена. Запустите новую из редактора.');
        } else if (method !== 'GET' || m[2] !== 'host') fail(405, 'Метод не поддерживается');
        return json(await state(await room(r.code), null, true));
      }
      const raw = req.headers.get('x-participant-token') || '';
      if (!/^[a-f0-9]{64}$/.test(raw)) fail(401, 'Сначала подключитесь к сессии');
      const tokenHash = await hash(raw);
      if (!(await db('proslide_participants', { query: { room: `eq.${r.code}`, token_hash: `eq.${tokenHash}`, select: 'room' } })).length) fail(401, 'Сначала подключитесь к сессии');
      if (m[2] === 'answer' && method === 'POST') {
        await rate(`vote:${tokenHash}`, 30, 60);
        if (r.status !== 'live' || !r.accepting) fail(409, 'Приём ответов остановлен');
        const b = await readBody(req), s = r.snapshot.slides[r.slide];
        if (b.slideId !== s.id) fail(409, 'Ведущий уже переключил слайд');
        const value = validateAnswer(s, b.value);
        await rpc('vote', { p_room: r.code, p_slide: s.id, p_participant: tokenHash, p_value: value });
        return json(await state(await room(r.code), tokenHash), 201);
      }
      if (!m[2] && method === 'GET') return json(await state(r, tokenHash));
    }
    fail(404, 'Неизвестный API-запрос');
  } catch (e) {
    if (e.code === '23505') return json({ error: 'Ваш ответ уже принят' }, 409);
    if (e.code === 'P0001') return json({ error: e.message }, 409);
    if (!e.status) console.error('proslide-api', e.code || 'internal', e.message);
    return json({ error: e.status ? e.message : 'Ошибка сервера. Попробуйте позже.' }, e.status || 500);
  }
});
