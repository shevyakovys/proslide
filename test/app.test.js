import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import vm from 'node:vm';

async function start(dbPath = ':memory:') {
  const app = createApp({ dbPath });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  return { app, url, close: () => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }) };
}
function client(url) {
  const cookies = new Map();
  return async (path, method = 'GET', body, extra = {}) => {
    const res = await fetch(`${url}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) { const [k, v] = line.split(';')[0].split('='); cookies.set(k, v); }
    return { status: res.status, body: await res.json() };
  };
}
const slide = (type, id = type) => ({ id, type, title: `Вопрос ${type}`, body: '', options: ['Да', 'Нет', 'Возможно'], maxWords: 3 });
const deck = { title: 'Тестовая встреча', theme: 'violet', slides: ['single', 'multiple', 'wordcloud', 'text', 'scale', 'content'].map(t => slide(t)) };
const account = (email = 'author@example.ru') => ({ name: 'Автор', email, password: 'long-test-password' });

test('Full meeting: author, two devices, six slide types, privacy, pause, export and finish', async t => {
  const server = await start(); t.after(server.close);
  const author = client(server.url), other = client(server.url), phone = client(server.url), second = client(server.url), stranger = client(server.url);
  assert.equal((await author('/register', 'POST', account())).status, 200);
  assert.equal((await other('/register', 'POST', account('other@example.ru'))).status, 200);
  const created = await author('/decks', 'POST', deck); assert.equal(created.status, 201); const id = created.body.id;
  assert.equal((await other(`/decks/${id}`)).status, 404);
  assert.equal((await stranger('/decks')).status, 401);
  const started = await author(`/decks/${id}/start`, 'POST'); assert.equal(started.status, 201); const code = started.body.code;
  assert.match(code, /^\d{6}$/);
  assert.equal((await stranger(`/rooms/${code}`)).status, 401);
  assert.equal((await other(`/rooms/${code}/host`)).status, 403);
  assert.equal((await phone(`/rooms/${code}/join`, 'POST')).status, 200);
  assert.equal((await phone(`/rooms/${code}/join`, 'POST')).body.participants, 1);
  await second(`/rooms/${code}/join`, 'POST');
  assert.equal((await author(`/rooms/${code}/host`)).body.participants, 2);
  const vote = (c, slideId, value) => c(`/rooms/${code}/answer`, 'POST', { slideId, value });
  const control = b => author(`/rooms/${code}/host`, 'PATCH', b);
  assert.equal((await vote(phone, 'single', [8])).status, 400);
  assert.equal((await vote(phone, 'single', [0])).status, 201);
  assert.equal((await vote(phone, 'single', [1])).status, 409);
  await vote(second, 'single', [1]);
  let r = (await author(`/rooms/${code}/host`)).body;
  assert.equal(r.results.total, 2); assert.deepEqual(r.results.counts.map(c => c.count), [1, 1, 0]);
  await control({ showResults: false });
  assert.equal((await phone(`/rooms/${code}`)).body.results, null);
  assert.equal((await author(`/rooms/${code}/host`)).body.results.total, 2);
  await control({ index: 1, showResults: true, accepting: false });
  assert.equal((await vote(phone, 'multiple', [0, 1])).status, 409);
  await control({ accepting: true });
  assert.equal((await vote(phone, 'single', [0])).status, 409);
  assert.equal((await vote(phone, 'multiple', [0, 0])).status, 400);
  assert.equal((await vote(phone, 'multiple', [0, 2])).status, 201);
  await control({ index: 2 });
  assert.equal((await vote(phone, 'wordcloud', ['Команда', ' идеи ', 'команда'])).status, 201);
  await vote(second, 'wordcloud', ['КОМАНДА']);
  r = (await author(`/rooms/${code}/host`)).body;
  assert.deepEqual(r.results.words, [{ word: 'команда', count: 2 }, { word: 'идеи', count: 1 }]);
  await control({ index: 3 });
  assert.equal((await vote(phone, 'text', '  ')).status, 400);
  assert.equal((await vote(phone, 'text', '<script>alert(1)</script>')).status, 201);
  await control({ index: 4 });
  assert.equal((await vote(phone, 'scale', 6)).status, 400);
  assert.equal((await vote(phone, 'scale', 4)).status, 201);
  await vote(second, 'scale', 5);
  assert.equal((await author(`/rooms/${code}/host`)).body.results.average, 4.5);
  await control({ index: 5 });
  assert.equal((await vote(phone, 'content', 'hello')).status, 400);
  assert.equal((await control({ index: 99 })).status, 400);
  const exported = await author(`/rooms/${code}/export`);
  assert.equal(exported.body.slides.length, 6); assert.equal(exported.body.slides[2].results.words[0].count, 2);
  assert.equal((await other(`/rooms/${code}/export`)).status, 403);
  // Editing the original never changes an already running meeting.
  await author(`/decks/${id}`, 'PUT', { ...deck, title: 'Новое название', slides: [slide('single', 'new')] });
  assert.equal((await author(`/rooms/${code}/host`)).body.title, deck.title);
  await control({ status: 'ended' });
  assert.equal((await phone(`/rooms/${code}`)).body.status, 'ended');
  assert.equal((await stranger(`/rooms/${code}/join`, 'POST')).status, 409);
  assert.equal((await vote(phone, 'content', 'x')).status, 409);
  assert.equal((await control({ status: 'live' })).status, 409);
  await author(`/decks/${id}`, 'DELETE');
  assert.equal((await author('/decks')).body.length, 0);
  assert.equal((await author(`/rooms/${code}/export`)).body.slides.length, 6);
});

test('Authentication, validation, CSRF and simultaneous duplicate answers', async t => {
  const server = await start(); t.after(server.close); const author = client(server.url), phone = client(server.url);
  assert.equal((await author('/register', 'POST', { ...account(), password: 'short' })).status, 400);
  assert.equal((await author('/register', 'POST', account())).status, 200);
  assert.equal((await author('/register', 'POST', account())).status, 409);
  assert.equal((await author('/decks', 'POST', { ...deck, slides: [] })).status, 400);
  assert.equal((await author('/decks', 'POST', { ...deck, slides: [slide('single'), slide('single')] })).status, 400);
  assert.equal((await author('/decks', 'POST', deck, { Origin: 'https://attacker.example' })).status, 403);
  const d = (await author('/decks', 'POST', deck)).body;
  const { code } = (await author(`/decks/${d.id}/start`, 'POST')).body;
  await phone(`/rooms/${code}/join`, 'POST');
  const requests = await Promise.all(Array.from({ length: 5 }, () => phone(`/rooms/${code}/answer`, 'POST', { slideId: 'single', value: [0] })));
  assert.equal(requests.filter(r => r.status === 201).length, 1);
  assert.equal(requests.filter(r => r.status === 409).length, 4);
  await author('/logout', 'POST'); assert.equal((await author('/me')).status, 401);
  assert.equal((await author('/login', 'POST', { ...account(), password: 'wrong-password' })).status, 401);
  assert.equal((await author('/login', 'POST', account())).status, 200);
  assert.equal((await author('/decks')).body.length, 1);
  const home = await fetch(server.url); assert.equal(home.status, 200); assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const secret = await fetch(`${server.url}/server.js`); assert.doesNotMatch(await secret.text(), /createApp/);
});

test('SQLite preserves account, session, participant and votes after restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'proslide-')), dbPath = join(dir, 'test.sqlite');
  let server = await start(dbPath), author = client(server.url), phone = client(server.url);
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  await author('/register', 'POST', account());
  const d = (await author('/decks', 'POST', deck)).body;
  const { code } = (await author(`/decks/${d.id}/start`, 'POST')).body;
  await phone(`/rooms/${code}/join`, 'POST');
  await phone(`/rooms/${code}/answer`, 'POST', { slideId: 'single', value: [2] });
  await server.close();
  server = await start(dbPath); author = client(server.url);
  await author('/login', 'POST', account());
  assert.equal((await author('/decks')).body[0].id, d.id);
  const r = (await author(`/rooms/${code}/host`)).body;
  assert.equal(r.participants, 1); assert.equal(r.results.total, 1); assert.equal(r.results.counts[2].count, 1);
});

test('Vendored QR library generates an SVG locally with a proper quiet zone', () => {
  const context = vm.createContext({}); vm.runInContext(readFileSync(new URL('../public/vendor/qrcode.js', import.meta.url), 'utf8'), context);
  const qr = context.qrcode(0, 'M'); qr.addData('https://slides.example.com/join/123456'); qr.make();
  assert.ok(qr.getModuleCount() >= 21); const svg = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  assert.match(svg, /<svg/); assert.match(svg, /<path/); assert.doesNotMatch(svg, /https:\/\/slides/);
});
