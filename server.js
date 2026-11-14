import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const derive = promisify(scrypt);
const root = dirname(fileURLToPath(import.meta.url));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (v, max, label = 'Текст') => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) fail(400, `${label}: от 1 до ${max} символов`);
  return v.trim();
};
const types = ['content', 'single', 'multiple', 'wordcloud', 'text', 'scale'];
export function validateDeck(input) {
  const title = text(input.title, 120, 'Название');
  if (!Array.isArray(input.slides) || input.slides.length < 1 || input.slides.length > 100) fail(400, 'Нужно от 1 до 100 слайдов');
  const ids = new Set();
  const slides = input.slides.map(s => {
    if (!s || !types.includes(s.type)) fail(400, 'Неизвестный тип слайда');
    const id = text(s.id, 80);
    if (ids.has(id)) fail(400, 'Повторяющийся слайд');
    ids.add(id);
    const options = ['single', 'multiple'].includes(s.type) ? s.options : [];
    if (!Array.isArray(options) || (['single', 'multiple'].includes(s.type) && (options.length < 2 || options.length > 8))) fail(400, 'Добавьте от 2 до 8 вариантов');
    return { id, type: s.type, title: text(s.title, 240, 'Заголовок слайда'), body: typeof s.body === 'string' ? s.body.slice(0, 2000) : '', options: options.map(o => text(o, 160)), maxWords: Math.min(5, Math.max(1, Number(s.maxWords) || 3)) };
  });
  return { title, slides, theme: ['violet', 'ocean', 'forest'].includes(input.theme) ? input.theme : 'violet' };
}

export function createApp({ dbPath = process.env.DB_PATH || resolve(root, 'data/proslide.sqlite'), publicUrl = process.env.PUBLIC_URL || '' } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS decks(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),data TEXT NOT NULL,updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),deck_id TEXT NOT NULL,snapshot TEXT NOT NULL,slide INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'live',accepting INTEGER NOT NULL DEFAULT 1,show_results INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS participants(room TEXT NOT NULL REFERENCES rooms(code),token TEXT NOT NULL,PRIMARY KEY(room,token));
    CREATE TABLE IF NOT EXISTS answers(room TEXT NOT NULL REFERENCES rooms(code),slide_id TEXT NOT NULL,participant TEXT NOT NULL,value TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(room,slide_id,participant));
    CREATE INDEX IF NOT EXISTS decks_owner ON decks(owner);
    CREATE INDEX IF NOT EXISTS rooms_owner ON rooms(owner);
  `);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const limits = new Map();
  function rate(key, max, ms) {
    const now = Date.now();
    if (limits.size > 10000) for (const [k, v] of limits) if (v.until < now) limits.delete(k);
    let v = limits.get(key);
    if (!v || v.until < now) limits.set(key, v = { count: 0, until: now + ms });
    if (++v.count > max) fail(429, 'Слишком много запросов. Попробуйте позже.');
  }
  const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')));
  const user = req => {
    const row = get('SELECT users.id,users.email,users.name FROM users JOIN auth ON users.id=auth.user_id WHERE token=? AND expires>?', cookies(req).auth || '', Date.now());
    if (!row) fail(401, 'Войдите в аккаунт');
    return row;
  };
  const cookie = (res, key, value, age = 2592000) => res.setHeader('Set-Cookie', `${key}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${publicUrl.startsWith('https:') ? '; Secure' : ''}`);
  const deck = (id, owner) => { const d = get('SELECT * FROM decks WHERE id=? AND owner=?', id, owner); if (!d) fail(404, 'Презентация не найдена'); return { id: d.id, ...JSON.parse(d.data), updated: d.updated }; };
  const room = code => { const r = get('SELECT * FROM rooms WHERE code=?', code); if (!r) fail(404, 'Сессия не найдена. Проверьте код.'); return r; };
  function results(r, s) {
    const answers = all('SELECT value FROM answers WHERE room=? AND slide_id=?', r.code, s.id).map(a => JSON.parse(a.value));
    const counts = s.options.map((label, i) => ({ label, count: answers.filter(a => a.includes(i)).length }));
    const words = new Map();
    if (s.type === 'wordcloud') for (const a of answers) for (const word of a) words.set(word, (words.get(word) || 0) + 1);
    return { total: answers.length, counts, words: [...words].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count), texts: s.type === 'text' ? answers : [], average: s.type === 'scale' && answers.length ? answers.reduce((a, b) => a + b, 0) / answers.length : null, distribution: s.type === 'scale' ? [1, 2, 3, 4, 5].map(n => ({ label: String(n), count: answers.filter(a => a === n).length })) : [] };
  }
  function state(r, participant, owner = false) {
    const d = JSON.parse(r.snapshot), s = d.slides[r.slide];
    return { code: r.code, title: d.title, theme: d.theme, status: r.status, accepting: !!r.accepting, showResults: !!r.show_results, index: r.slide, slideCount: d.slides.length, slide: s, participants: get('SELECT COUNT(*) AS n FROM participants WHERE room=?', r.code).n, answered: !!get('SELECT 1 FROM answers WHERE room=? AND slide_id=? AND participant=?', r.code, s.id, participant || ''), results: owner || r.show_results ? results(r, s) : null };
  }
  async function body(req) {
    let data = '', size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 262144) fail(413, 'Слишком большой запрос'); data += chunk; }
    try { const b = JSON.parse(data || '{}'); if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'Некорректный запрос'); return b; } catch { fail(400, 'Некорректный JSON'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname, method = req.method;
      if (!['GET', 'HEAD'].includes(method) && req.headers.origin) {
        const expected = publicUrl ? new URL(publicUrl).origin : `http://${req.headers.host}`;
        if (req.headers.origin !== expected) fail(403, 'Недопустимый источник запроса');
      }
      if (path === '/api/health') return json({ ok: true });
      if (path === '/api/config') return json({ publicUrl });
      if (['/api/register', '/api/login'].includes(path) && method === 'POST') {
        rate(`auth:${req.socket.remoteAddress}`, 20, 600000);
        const b = await body(req), email = text(b.email, 254, 'Email').toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Введите корректный email');
        if (typeof b.password !== 'string' || b.password.length < 10 || b.password.length > 128) fail(400, 'Пароль: от 10 до 128 символов');
        let u;
        if (path === '/api/register') {
          const name = text(b.name, 80, 'Имя'), salt = randomBytes(16).toString('hex');
          const hash = (await derive(b.password, salt, 64)).toString('hex');
          u = { id: randomUUID(), email, name };
          try { run('INSERT INTO users VALUES(?,?,?,?)', u.id, email, name, `${salt}:${hash}`); } catch (e) { if (e.message.includes('UNIQUE')) fail(409, 'Этот email уже зарегистрирован'); throw e; }
        } else {
          const row = get('SELECT * FROM users WHERE email=?', email);
          const [salt, hash] = (row?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
          const computed = await derive(b.password, salt, 64);
          if (!timingSafeEqual(computed, Buffer.from(hash, 'hex')) || !row) fail(401, 'Неверный email или пароль');
          u = { id: row.id, email, name: row.name };
        }
        const token = randomBytes(32).toString('hex');
        run('DELETE FROM auth WHERE expires<?', Date.now());
        run('INSERT INTO auth VALUES(?,?,?)', token, u.id, Date.now() + 2592000000); cookie(res, 'auth', token); return json(u);
      }
      if (path === '/api/logout' && method === 'POST') { run('DELETE FROM auth WHERE token=?', cookies(req).auth || ''); cookie(res, 'auth', '', 0); return json({ ok: true }); }
      if (path === '/api/me') return json(user(req));
      if (path === '/api/decks') {
        const u = user(req);
        if (method === 'GET') return json(all('SELECT * FROM decks WHERE owner=? ORDER BY updated DESC', u.id).map(d => ({ id: d.id, ...JSON.parse(d.data), updated: d.updated })));
        if (method === 'POST') { const d = validateDeck(await body(req)), id = randomUUID(); run('INSERT INTO decks VALUES(?,?,?,?)', id, u.id, JSON.stringify(d), Date.now()); return json(deck(id, u.id), 201); }
      }
      let m = path.match(/^\/api\/decks\/([\w-]+)(\/start)?$/);
      if (m) {
        const u = user(req), d = deck(m[1], u.id);
        if (m[2] && method === 'POST') {
          let code; do { code = String(randomInt(100000, 1000000)); } while (get('SELECT 1 FROM rooms WHERE code=?', code));
          run('INSERT INTO rooms(code,owner,deck_id,snapshot,created) VALUES(?,?,?,?,?)', code, u.id, d.id, JSON.stringify(d), Date.now());
          return json({ code }, 201);
        }
        if (!m[2] && method === 'GET') return json(d);
        if (!m[2] && method === 'PUT') { const data = validateDeck(await body(req)); run('UPDATE decks SET data=?,updated=? WHERE id=?', JSON.stringify(data), Date.now(), d.id); return json(deck(d.id, u.id)); }
        if (!m[2] && method === 'DELETE') { run('DELETE FROM decks WHERE id=?', d.id); return json({ ok: true }); }
      }
      if (path === '/api/rooms' && method === 'GET') return json(all('SELECT code,snapshot,status,created FROM rooms WHERE owner=? ORDER BY created DESC', user(req).id).map(r => ({ code: r.code, title: JSON.parse(r.snapshot).title, status: r.status, created: r.created })));
      m = path.match(/^\/api\/rooms\/(\d{6})(?:\/(join|answer|host|export))?$/);
      if (m) {
        const r = room(m[1]);
        if (m[2] === 'join' && method === 'POST') {
          rate(`join:${req.socket.remoteAddress}`, 300, 60000);
          if (r.status === 'ended') fail(409, 'Эта сессия уже завершена');
          const existing = cookies(req).participant;
          const token = /^[a-f0-9]{64}$/.test(existing || '') ? existing : randomBytes(32).toString('hex');
          run('INSERT OR IGNORE INTO participants VALUES(?,?)', r.code, token); cookie(res, 'participant', token); return json(state(r, token));
        }
        if (['host', 'export'].includes(m[2])) {
          if (user(req).id !== r.owner) fail(403, 'Доступ только автору');
          if (m[2] === 'export' && method === 'GET') {
            const d = JSON.parse(r.snapshot);
            return json({ title: d.title, code: r.code, created: r.created, slides: d.slides.map(s => ({ ...s, results: results(r, s) })) });
          }
          if (method === 'PATCH') {
            const b = await body(req), count = JSON.parse(r.snapshot).slides.length;
            const index = b.index ?? r.slide;
            if (!Number.isInteger(index) || index < 0 || index >= count) fail(400, 'Некорректный номер слайда');
            if (b.status !== undefined && !['live', 'ended'].includes(b.status)) fail(400, 'Некорректный статус');
            for (const key of ['accepting', 'showResults']) if (b[key] !== undefined && typeof b[key] !== 'boolean') fail(400, 'Некорректная настройка');
            if (r.status === 'ended') fail(409, 'Сессия завершена. Запустите новую из редактора.');
            run('UPDATE rooms SET slide=?,status=?,accepting=?,show_results=? WHERE code=?', index, b.status ?? r.status, b.accepting === undefined ? r.accepting : Number(b.accepting), b.showResults === undefined ? r.show_results : Number(b.showResults), r.code);
          }
          return json(state(room(r.code), null, true));
        }
        const token = cookies(req).participant || '';
        if (!get('SELECT 1 FROM participants WHERE room=? AND token=?', r.code, token)) fail(401, 'Сначала подключитесь к сессии');
        if (m[2] === 'answer' && method === 'POST') {
          rate(`vote:${token}`, 30, 60000);
          if (r.status !== 'live' || !r.accepting) fail(409, 'Приём ответов остановлен');
          const b = await body(req), s = JSON.parse(r.snapshot).slides[r.slide];
          if (b.slideId !== s.id) fail(409, 'Ведущий уже переключил слайд');
          let value = b.value;
          if (['single', 'multiple'].includes(s.type)) {
            if (!Array.isArray(value) || !value.length || value.length > s.options.length || (s.type === 'single' && value.length !== 1) || new Set(value).size !== value.length || value.some(v => !Number.isInteger(v) || v < 0 || v >= s.options.length)) fail(400, 'Выберите корректный вариант ответа');
          } else if (s.type === 'wordcloud') {
            if (!Array.isArray(value) || !value.length || value.length > s.maxWords) fail(400, `Введите от 1 до ${s.maxWords} слов`);
            value = [...new Set(value.map(v => text(v, 40, 'Слово').normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/g, ' ')))];
          } else if (s.type === 'text') value = text(value, 1000, 'Ответ');
          else if (s.type === 'scale') { if (!Number.isInteger(value) || value < 1 || value > 5) fail(400, 'Выберите оценку от 1 до 5'); }
          else fail(400, 'Этот слайд не принимает ответы');
          try { run('INSERT INTO answers VALUES(?,?,?,?,?)', r.code, s.id, token, JSON.stringify(value), Date.now()); } catch (e) { if (e.message.includes('UNIQUE')) fail(409, 'Ваш ответ уже принят'); throw e; }
          return json(state(r, token), 201);
        }
        if (!m[2] && method === 'GET') return json(state(r, token));
      }
      if (path.startsWith('/api/')) fail(404, 'Неизвестный API-запрос');
      if (method !== 'GET' && method !== 'HEAD') fail(405, 'Метод не поддерживается');
      const files = { '/cloud-config.js': ['cloud-config.js', 'text/javascript'], '/cloud-api.js': ['cloud-api.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/vendor/qrcode.js': ['vendor/qrcode.js', 'text/javascript'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const [file, type] = files[path] || ['index.html', 'text/html'];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(method === 'HEAD' ? undefined : readFileSync(resolve(root, 'public', file)));
    } catch (e) { if (!e.status) console.error(e); json({ error: e.status ? e.message : 'Ошибка сервера' }, e.status || 500); }
  });
  server.on('close', () => db.close());
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, '0.0.0.0', () => console.log(`ProSlide: http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close(() => process.exit(0)));
}
