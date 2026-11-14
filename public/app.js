import { normalizeTextStyle, slideStyle, moveSlide, answerCount } from './editor-model.js';
import { cloudConfig } from './cloud-config.js';
import { cloudApi } from './cloud-api.js';
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { content: 'Информационный слайд', single: 'Один ответ', multiple: 'Несколько ответов', wordcloud: 'Облако слов', text: 'Открытый ответ', scale: 'Шкала оценки' };
const symbols = { content: '▤', single: '◉', multiple: '☑', wordcloud: '☁', text: '≡', scale: '☆' };
const colors = ['#7964cd', '#e6a050', '#569f95', '#dc7c9e', '#719dcd'];
// randomUUID is restricted to secure contexts; LAN presentations may use HTTP.
const makeId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
let saveTimer, savingPromise, editRevision = 0, saveError = '', undoStack = [], redoStack = [], lastEditKey = '', lastEditTime = 0;
let activeUrl = location.href;
let me, config = {}, currentDeck, selected = 0, dirty = false, pollTimer, routeVersion = 0, roomState, answerSelection = [];
const logo = '<a class="logo" href="#/" data-nav><img src="./favicon.svg" alt="">sfedu-slide<span>·</span></a>';
const date = n => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' }).format(n);
async function api(path, method = 'GET', data) {
  if (cloudConfig.enabled) return cloudApi(path, method, data);
  const r = await fetch(`/api${path}`, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await r.json(); if (!r.ok) throw new Error(result.error || 'Ошибка запроса'); return result;
}
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(el.timer); el.timer = setTimeout(() => el.classList.remove('visible'), 4500); }
function nav(path) { path = path.replace(/^#/, ''); if (dirty && !confirm('Есть несохранённые изменения. Выйти без сохранения?')) return; dirty = false; history.pushState({}, '', `#${path}`); route(); }
document.addEventListener('click', e => { const a = e.target.closest('a[data-nav]'); if (a) { e.preventDefault(); nav(a.getAttribute('href')); } });
window.addEventListener('popstate', () => { if (dirty && !confirm('Есть несохранённые изменения. Выйти без сохранения?')) { history.pushState({}, '', activeUrl); return; } dirty = false; route(); });
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
function action(selector, fn) { const el = $(selector); if (el) el.onclick = async e => { if (el.disabled) return; el.disabled = true; try { await fn(e); } catch (e) { toast(e.message); } finally { if (el.isConnected && !el.dataset.locked) el.disabled = false; } }; }
function shell(content, active = 'decks') {
  app.innerHTML = `<div class="workspace"><aside class="sidebar">${logo}<div class="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div><nav><a data-nav href="#/" class="${active === 'decks' ? 'active' : ''}">▦ <span>Мои презентации</span></a><a data-nav href="#/history" class="${active === 'history' ? 'active' : ''}">◷ <span>История сессий</span></a><a data-nav href="#/join">↗ <span>Войти участником</span></a></nav><div class="sidebar-tip"><div class="tiny-icon">✦</div><strong>Дайте аудитории голос</strong><p>Один QR-код — и каждый становится частью выступления.</p></div><div class="profile"><span class="avatar">${esc(me.name.slice(0, 1).toUpperCase())}</span><div><strong>${esc(me.name)}</strong><small>Личное пространство</small></div><button id="logout" class="icon-btn" title="Выйти" aria-label="Выйти">↪</button></div></aside><main class="main">${content}</main></div>`;
  action('#logout', async () => { await api('/logout', 'POST'); me = null; nav('/'); });
}
function newSlide(type = 'single') { return { id: makeId(), type, title: type === 'wordcloud' ? 'Какое слово описывает ваше настроение?' : type === 'scale' ? 'Насколько вам понравилась встреча?' : type === 'content' ? 'Давайте начнём разговор' : 'Что вы думаете?', body: '', options: ['Первый вариант', 'Второй вариант', 'Третий вариант'], maxWords: 3 }; }
function demoDeck() { return { title: 'Знакомство с командой', theme: 'violet', slides: [{ ...newSlide('content'), title: 'Хорошие идеи начинаются с диалога', body: 'Добро пожаловать! Сегодня узнаем друг друга немного лучше.' }, { ...newSlide('wordcloud'), title: 'Одним словом: что вас вдохновляет?', body: 'Поделитесь ассоциациями. Можно отправить до трёх слов.' }, { ...newSlide('single'), title: 'Какой формат работы вам ближе?', options: ['Вместе в офисе', 'Из любой точки мира', 'Лучшее из двух миров'] }, { ...newSlide('scale'), title: 'Как ваше настроение сегодня?', body: 'От 1 — хочется ещё кофе, до 5 — готов свернуть горы.' }] }; }
async function route() {
  activeUrl = location.href;
  clearTimeout(pollTimer); clearTimeout(saveTimer); const version = ++routeVersion;
  try {
    if (!config.loaded) { config = { ...await api('/config'), loaded: true }; }
    const path = location.hash.startsWith('#/') ? location.hash.slice(1) : (cloudConfig.enabled ? '/' : location.pathname);
    if (path.startsWith('/join')) return joinPage(path.split('/')[2]);
    if (!me) { try { me = await api('/me'); } catch { if (version === routeVersion) authPage(); return; } }
    if (version !== routeVersion) return;
    if (path.startsWith('/edit/')) return await editor(path.split('/')[2]);
    if (path.startsWith('/present/')) return await presenter(path.split('/')[2]);
    if (path === '/history') return await historyPage();
    await dashboard();
  } catch (e) { app.innerHTML = `<div class="error-page">${logo}<h1>Не удалось открыть страницу</h1><p>${esc(e.message)}</p><a data-nav class="btn primary" href="#/">На главную</a></div>`; }
}
function authPage(register = false) {
  app.innerHTML = `<main class="auth-layout"><section class="auth-story">${logo}<div><span class="eyebrow">ПРЕЗЕНТАЦИЯ — ЭТО ДИАЛОГ</span><h1>Ваша идея.<br>Голос каждого.</h1><p>Опросы, живые ответы и облако слов.<br>Вовлекайте аудиторию с первого слайда.</p><div class="sample-cloud"><span>вдохновение</span><span>команда</span><span>идеи</span><span>вместе</span><span>развитие</span><span>диалог</span></div></div><small>Создано для встреч, которые запоминаются.</small></section><section class="auth-form"><a data-nav class="participant-link" href="#/join">Я участник →</a><div><span class="eyebrow">ВАШЕ ПРОСТРАНСТВО ДЛЯ ИДЕЙ</span><h2>${register ? 'Начнём знакомство' : 'С возвращением'}</h2><p class="muted">${register ? 'Создайте аккаунт и свою первую презентацию.' : 'Войдите, чтобы продолжить разговор с аудиторией.'}</p><form id="auth">${register ? '<label>Ваше имя<input name="name" autocomplete="name" required maxlength="80" placeholder="Как к вам обращаться?"></label>' : ''}<label>Email<input name="email" type="email" autocomplete="email" required placeholder="you@company.ru"></label><label>Пароль<input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="10" maxlength="128" required placeholder="Не менее 10 символов"></label><p id="form-error" class="error" role="alert"></p><button class="btn primary wide">${register ? 'Создать аккаунт' : 'Войти в sfedu-slide'} →</button></form><p class="switch-auth">${register ? 'Уже есть аккаунт?' : 'Первый раз здесь?'} <button id="switch" class="text-btn">${register ? 'Войти' : 'Создать аккаунт'}</button></p></div><small class="muted">Участникам аккаунт не нужен — достаточно QR-кода.</small></section></main>`;
  $('#switch').onclick = () => authPage(!register);
  $('#auth').onsubmit = async e => { e.preventDefault(); const button = $('button', e.target); button.disabled = true; try { me = await api(register ? '/register' : '/login', 'POST', Object.fromEntries(new FormData(e.target))); await route(); } catch (e) { $('#form-error').textContent = e.message; } finally { button.disabled = false; } };
}
async function dashboard() {
  const decks = await api('/decks');
  shell(`<header class="topline"><span>Личное пространство <span class="slash">/</span> <strong>Презентации</strong></span><a data-nav href="#/join" class="btn light small">Войти по коду ↗</a></header><section class="page-heading"><div><span class="eyebrow">ОТ ИДЕИ К ДИАЛОГУ</span><h1>Мои презентации<span class="count">${decks.length}</span></h1><p>Создавайте. Спрашивайте. Слушайте свою аудиторию.</p></div><button id="create" class="btn primary">＋ Создать презентацию</button></section><section class="welcome-banner"><div><span class="pill">✦ ВОВЛЕКАЙТЕ КАЖДОГО</span><h2>Не просто слайды.<br>Общий разговор.</h2><p>Добавьте вопрос, покажите QR-код<br>и наблюдайте, как оживают идеи.</p><button id="template" class="btn white">Попробовать готовый пример ↗</button></div><div class="banner-art" aria-hidden="true"><div class="float-label">● Ответы в реальном времени</div><div class="art-slide"><span>Что делает команду сильнее?</span><div class="art-cloud"><b>доверие</b><i>идеи</i><strong>люди</strong><em>поддержка</em><small>общение</small></div><div class="art-foot">☁ Облако слов <span>↗ 24 ответа</span></div></div><div class="art-mini"><span>↗</span> Каждый голос<br>имеет значение</div></div></section><section class="library"><div class="library-toolbar"><div class="tabs"><button class="tab active">Все презентации <span>${decks.length}</span></button></div><input id="search" class="search" type="search" aria-label="Поиск презентаций" placeholder="⌕ Найти презентацию"></div><div class="deck-grid" id="deck-grid"></div></section><footer class="workspace-footer">Ваши идеи заслуживают живого отклика.<span>sfedu-slide · Интерактивные презентации</span></footer>`);
  const render = term => {
    const filtered = decks.filter(d => d.title.toLowerCase().includes(term.toLowerCase()));
    $('#deck-grid').innerHTML = filtered.map(d => `<article class="deck-card"><a data-nav href="#/edit/${d.id}" class="deck-cover theme-${d.theme}"><span class="cover-type">${symbols[d.slides[0].type]} ${labels[d.slides[0].type]}</span><h3>${esc(d.slides[0].title)}</h3><span class="cover-footer">SFEDU-SLIDE <span>${d.slides.length} слайдов</span></span></a><div class="deck-info"><a data-nav href="#/edit/${d.id}"><strong>${esc(d.title)}</strong></a><span>Изменено ${date(d.updated)}</span><button class="rename-deck text-btn" data-id="${d.id}" aria-label="Переименовать ${esc(d.title)}">✎ Переименовать</button><button class="icon-btn delete-deck" data-id="${d.id}" title="Удалить презентацию" aria-label="Удалить ${esc(d.title)}">×</button></div></article>`).join('') + (!term ? '<button class="new-card" id="new-card"><span>＋</span><strong>Новая презентация</strong><small>Начните с чистого слайда</small></button>' : filtered.length ? '' : '<p class="muted">Ничего не найдено. Попробуйте другое название.</p>');
    action('#new-card', create);
    document.querySelectorAll('.rename-deck').forEach(b => b.onclick = async () => { const d = decks.find(d => d.id === b.dataset.id); const title = await nameDialog('Переименовать презентацию', d.title); if (!title || title === d.title) return; try { const fresh = await api(`/decks/${d.id}`); await api(`/decks/${d.id}`, 'PUT', { ...fresh, title }); await dashboard(); toast('Название изменено'); } catch (e) { toast(e.message); } });
    document.querySelectorAll('.delete-deck').forEach(b => b.onclick = async () => { if (!confirm('Удалить презентацию? История сессий сохранится.')) return; try { await api(`/decks/${b.dataset.id}`, 'DELETE'); dashboard(); } catch (e) { toast(e.message); } });
  };
  async function create() { const title = await nameDialog('Новая презентация', ''); if (!title) return; const d = await api('/decks', 'POST', { title, theme: 'violet', slides: [newSlide()] }); nav(`/edit/${d.id}`); }
  action('#create', create); action('#template', async () => { const d = await api('/decks', 'POST', demoDeck()); nav(`/edit/${d.id}`); });
  $('#search').oninput = e => render(e.target.value); render('');
}
function nameDialog(title, value = '') {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'name-dialog';
    dialog.innerHTML = `<form><h2>${esc(title)}</h2><label for="presentation-name">Название презентации</label><input id="presentation-name" name="title" maxlength="120" required placeholder="Например: Введение в курс" value="${esc(value)}"><p class="field-hint">Это название видно в вашей библиотеке и истории встреч.</p><div class="dialog-actions"><button type="button" class="btn light" id="cancel-name">Отмена</button><button class="btn primary">${value ? 'Переименовать' : 'Создать'}</button></div></form>`;
    document.body.append(dialog); dialog.showModal(); const input = $('input',dialog); input.focus(); input.select();
    let result = null;
    $('form',dialog).onsubmit = e => { e.preventDefault(); if (!input.value.trim()) { input.setCustomValidity('Введите название'); input.reportValidity(); return; } result = input.value.trim(); dialog.close(); };
    input.oninput = () => input.setCustomValidity(''); $('#cancel-name',dialog).onclick = () => dialog.close();
    dialog.onclose = () => { dialog.remove(); resolve(result); };
  });
}
async function editor(id) {
  currentDeck = await api(`/decks/${id}`); selected = 0; dirty = false; editRevision = 0; saveError = ''; undoStack = []; redoStack = []; drawEditor();
}
function remember(key = '') {
  const now = Date.now();
  if (!key || key !== lastEditKey || now - lastEditTime > 800) { undoStack.push({deck:structuredClone(currentDeck), selected}); if (undoStack.length > 40) undoStack.shift(); }
  lastEditKey = key; lastEditTime = now; redoStack = [];
}
function saveStatus() {
  const status = $('#save-status'); if (!status) return;
  status.textContent = saveError ? `Не сохранено: ${saveError}` : savingPromise ? 'Сохраняем…' : dirty ? 'Есть изменения…' : '✓ Все изменения сохранены';
  status.classList.toggle('error',!!saveError);
  if ($('#undo')) $('#undo').disabled = !undoStack.length;
  if ($('#redo')) $('#redo').disabled = !redoStack.length;
}
function changed() {
  dirty = true; editRevision++; saveError = ''; saveStatus(); preview();
  const title = currentDeck.slides[selected].title || 'Без заголовка';
  const thumb = $(`[data-index="${selected}"] strong`); if (thumb) thumb.textContent = title;
  $(`[data-index="${selected}"]`)?.setAttribute('aria-label', `Слайд ${selected+1}: ${title}`);
  clearTimeout(saveTimer); saveTimer = setTimeout(() => saveDeck(false).catch(() => {}), 1100);
}
async function saveDeck(announce = true) {
  clearTimeout(saveTimer);
  if (savingPromise) { await savingPromise; if (dirty) return saveDeck(announce); return; }
  const d = currentDeck, version = routeVersion;
  if (!dirty) { if (announce) toast('Все изменения сохранены'); return; }
  const revision = editRevision, snapshot = structuredClone(d);
  saveError = '';
  savingPromise = api(`/decks/${d.id}`, 'PUT', snapshot);
  saveStatus();
  try {
    await savingPromise;
    if (version !== routeVersion || currentDeck.id !== d.id) return;
    if (revision === editRevision) dirty = false;
  } catch (e) {
    if (version === routeVersion) { saveError = e.message; if (announce) toast(`Не удалось сохранить: ${e.message}`); }
    throw e;
  } finally { savingPromise = null; if (version === routeVersion) saveStatus(); }
  if (version === routeVersion && dirty) return saveDeck(announce);
  if (announce && version === routeVersion) toast('Презентация сохранена');
}
function reorderSlide(from, to) {
  if (from === to || to < 0 || to >= currentDeck.slides.length) return;
  remember(); currentDeck.slides = moveSlide(currentDeck.slides,from,to); selected = to; changed(); drawEditor();
  $(`[data-index="${selected}"]`)?.focus();
}
function undoEdit(redo = false) {
  const source = redo ? redoStack : undoStack, target = redo ? undoStack : redoStack;
  if (!source.length) return;
  target.push({deck:structuredClone(currentDeck),selected}); const previous = source.pop();
  currentDeck = previous.deck; selected = previous.selected; lastEditKey = ''; changed(); drawEditor();
}
function drawEditor() {
  const d = currentDeck, s = d.slides[selected], style = normalizeTextStyle(s.textStyle);
  const themeColor = {violet:'#5c477d',ocean:'#3e6b82',forest:'#45664e'}[d.theme] || '#5c477d';
  app.innerHTML = `<div class="editor"><header class="editor-header"><a data-nav class="back" href="#/">← <span>Презентации</span></a><label class="deck-name-label" for="deck-title">Название презентации<input id="deck-title" maxlength="120" placeholder="Введите название презентации" value="${esc(d.title)}"></label><div class="save-area"><span id="save-status" role="status" aria-live="polite"></span><button id="save" class="btn light" title="Ctrl+S">Сохранить</button></div><button id="start" class="btn primary">▷ Начать показ</button></header><div class="editor-body"><aside class="slide-list"><div class="panel-title">СЛАЙДЫ <span>${d.slides.length}</span></div><p class="reorder-hint">Перетащите слайд за ⋮⋮ или выберите позицию ниже</p>${d.slides.map((slide,i) => `<button draggable="true" class="slide-thumb ${i===selected?'selected':''}" data-index="${i}" aria-label="Слайд ${i+1}: ${esc(slide.title)}" aria-current="${i===selected?'true':'false'}" title="Перетащите для изменения порядка · Alt+↑/↓"><span class="drag-grip" aria-hidden="true">⋮⋮<small>${String(i+1).padStart(2,'0')}</small></span><div class="theme-${d.theme}"><small>${symbols[slide.type]} ${labels[slide.type]}</small><strong>${esc(slide.title)}</strong></div></button>`).join('')}<button id="add-slide" class="btn light wide">＋ Добавить слайд</button></aside><section class="canvas-area"><div class="canvas-label"><span>Слайд ${selected+1} / ${d.slides.length}</span><div class="undo-controls"><button id="undo" class="text-btn" title="Отменить действие">↶ Отменить</button><button id="redo" class="text-btn" title="Повторить действие">↷ Повторить</button></div></div><div id="preview" class="slide-canvas theme-${d.theme}"></div><div class="slide-actions"><button id="move-up" class="btn small light" ${selected===0?'disabled':''}>↑ Выше</button><label class="move-position">Позиция<select id="move-to" aria-label="Переместить слайд на позицию">${d.slides.map((_,i)=>`<option value="${i}" ${i===selected?'selected':''}>${i+1} из ${d.slides.length}</option>`).join('')}</select></label><button id="move-down" class="btn small light" ${selected===d.slides.length-1?'disabled':''}>↓ Ниже</button><button id="duplicate" class="btn small light">Дублировать</button><button id="delete-slide" class="btn small danger" ${d.slides.length===1?'disabled':''}>Удалить</button></div><div class="editor-hint">Изменения сохраняются автоматически. Ctrl+S — сохранить сейчас.<br>Оформление применяется к этому слайду. Идущие сессии сохраняют свою исходную версию.</div></section><aside class="settings"><div class="panel-title">НАСТРОЙКИ СЛАЙДА</div><label>Тип взаимодействия<select id="slide-type">${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${s.type===k?'selected':''}>${v}</option>`).join('')}</select></label><label>Заголовок<textarea id="slide-title" rows="3" maxlength="240">${esc(s.title)}</textarea></label><label>Описание<textarea id="slide-body" rows="3" maxlength="2000" placeholder="Подсказка для аудитории">${esc(s.body)}</textarea></label><fieldset class="text-settings"><legend>Оформление текста</legend><div class="style-row"><label>Размер заголовка<input id="title-size" type="number" min="24" max="96" value="${style.titleSize}"><small>24–96 px</small></label><label>Цвет заголовка<input id="title-color" type="color" value="${style.titleColor || themeColor}"></label></div><div class="style-row"><label>Размер описания<input id="body-size" type="number" min="12" max="48" value="${style.bodySize}"><small>12–48 px</small></label><label>Цвет описания<input id="body-color" type="color" value="${style.bodyColor || themeColor}"></label></div><div class="style-tools"><button id="reset-style" class="text-btn">Сбросить к теме</button><button id="apply-style-all" class="text-btn">Ко всем слайдам</button></div><p class="field-hint">Размер адаптируется к экрану участника. Точные настройки сохраняются в презентации.</p></fieldset>${['single','multiple'].includes(s.type)?`<div class="panel-title">ВАРИАНТЫ ОТВЕТОВ</div><div id="options">${s.options.map((o,i)=>`<div class="option-edit"><span>${String.fromCharCode(65+i)}</span><input data-option="${i}" aria-label="Вариант ${i+1}" maxlength="160" value="${esc(o)}"><button data-remove="${i}" class="icon-btn" aria-label="Удалить вариант ${i+1}" ${s.options.length<=2?'disabled':''}>×</button></div>`).join('')}</div><button id="add-option" class="text-btn" ${s.options.length>=8?'disabled':''}>＋ Добавить вариант</button>`:''}${s.type==='wordcloud'?`<label>Слов от одного участника<select id="max-words">${[1,2,3,4,5].map(n=>`<option ${n===s.maxWords?'selected':''}>${n}</option>`).join('')}</select></label><p class="field-hint">Повторяющиеся слова становятся крупнее. Регистр букв не учитывается.</p>`:''}${s.type==='scale'?'<p class="field-hint">Шкала от 1 до 5. Результат — распределение и средняя оценка.</p>':''}<div class="panel-title theme-label">ТЕМА ПРЕЗЕНТАЦИИ</div><div class="theme-picker">${['violet','ocean','forest'].map((theme,i)=>`<button data-theme="${theme}" class="theme-swatch theme-${theme} ${d.theme===theme?'selected':''}" aria-label="${['Лавандовая','Морская','Зелёная'][i]} тема">${d.theme===theme?'✓':''}</button>`).join('')}</div></aside></div></div>`;
  const input = (selector,fn) => { $(selector).oninput = e => { remember(selector); fn(e.target.value); changed(); }; };
  input('#deck-title',v=>d.title=v); input('#slide-title',v=>s.title=v); input('#slide-body',v=>s.body=v);
  $('#slide-type').onchange=e=>{remember();s.type=e.target.value;if(!s.options.length)s.options=['Первый вариант','Второй вариант'];changed();drawEditor();};
  if($('#max-words'))$('#max-words').onchange=e=>{remember();s.maxWords=Number(e.target.value);changed();};
  for(const [id,key,min,max] of [['title-size','titleSize',24,96],['body-size','bodySize',12,48]]) {
    $(`#${id}`).oninput=e=>{if(!e.target.validity.valid||!e.target.value)return;remember(id);s.textStyle={...normalizeTextStyle(s.textStyle),[key]:Math.round(Math.min(max,Math.max(min,Number(e.target.value))))};changed();};
  }
  for(const [id,key] of [['title-color','titleColor'],['body-color','bodyColor']])input(`#${id}`,v=>{s.textStyle={...normalizeTextStyle(s.textStyle),[key]:v};});
  $('#reset-style').onclick=()=>{remember();delete s.textStyle;changed();drawEditor();};
  $('#apply-style-all').onclick=()=>{remember();for(const slide of d.slides){if(s.textStyle)slide.textStyle=structuredClone(s.textStyle);else delete slide.textStyle;}changed();drawEditor();toast('Оформление применено ко всем слайдам');};
  document.querySelectorAll('[data-option]').forEach(el=>el.oninput=()=>{remember(`option-${el.dataset.option}`);s.options[Number(el.dataset.option)]=el.value;changed();});
  document.querySelectorAll('[data-remove]').forEach(el=>el.onclick=()=>{remember();s.options.splice(Number(el.dataset.remove),1);changed();drawEditor();});
  document.querySelectorAll('[data-theme]').forEach(el=>el.onclick=()=>{remember();d.theme=el.dataset.theme;changed();drawEditor();});
  let dragged = null;
  document.querySelectorAll('[data-index]').forEach(el=>{
    const index=Number(el.dataset.index);
    el.onclick=()=>{selected=index;lastEditKey='';drawEditor();};
    el.ondragstart=e=>{dragged=index;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(index));el.classList.add('dragging');};
    el.ondragover=e=>{if(dragged===null)return;e.preventDefault();e.dataTransfer.dropEffect='move';el.classList.add('drop-target');};
    el.ondragleave=()=>el.classList.remove('drop-target');
    el.ondrop=e=>{e.preventDefault();if(dragged!==null)reorderSlide(dragged,index);dragged=null;};
    el.ondragend=()=>{dragged=null;document.querySelectorAll('.dragging,.drop-target').forEach(n=>n.classList.remove('dragging','drop-target'));};
    el.onkeydown=e=>{if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();reorderSlide(index,index+(e.key==='ArrowUp'?-1:1));}};
  });
  $('#move-to').onchange=e=>reorderSlide(selected,Number(e.target.value));
  $('#move-up').onclick=()=>reorderSlide(selected,selected-1);$('#move-down').onclick=()=>reorderSlide(selected,selected+1);
  $('#undo').onclick=()=>undoEdit();$('#redo').onclick=()=>undoEdit(true);
  action('#add-option',()=>{remember();s.options.push(`Вариант ${s.options.length+1}`);changed();drawEditor();});
  action('#add-slide',()=>{if(d.slides.length>=100)throw Error('Максимум 100 слайдов');remember();d.slides.splice(selected+1,0,newSlide());selected++;changed();drawEditor();});
  action('#duplicate',()=>{if(d.slides.length>=100)throw Error('Максимум 100 слайдов');remember();d.slides.splice(selected+1,0,{...structuredClone(s),id:makeId()});selected++;changed();drawEditor();});
  action('#delete-slide',()=>{remember();d.slides.splice(selected,1);selected=Math.max(0,selected-1);changed();drawEditor();toast('Слайд удалён. Можно отменить действие.');});
  action('#save',()=>saveDeck());action('#start',async()=>{await saveDeck(false);const r=await api(`/decks/${currentDeck.id}/start`,'POST');nav(`/present/${r.code}`);});
  preview();saveStatus();
}
document.addEventListener('keydown',e=>{
  if(!$('.editor'))return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveDeck().catch(()=>{});}
});

function preview() {
  const s = currentDeck.slides[selected];
  $('#preview').setAttribute('style', slideStyle(s));
  $('#preview').className = `slide-canvas theme-${currentDeck.theme} ${s.textStyle ? 'custom-text' : ''}`;
  $('#preview').innerHTML = `<span class="slide-kicker">${symbols[s.type]} ${labels[s.type]}</span><h2>${esc(s.title || 'Заголовок слайда')}</h2><p>${esc(s.body)}</p><div class="preview-content">${s.type === 'wordcloud' ? '<div class="preview-cloud"><b>вдохновение</b><span>команда</span><strong>идеи</strong><i>вместе</i><em>развитие</em></div><small class="preview-note">Пример отображения · здесь будут слова участников</small>' : ['single', 'multiple'].includes(s.type) ? `<div class="preview-options">${s.options.map((o, i) => `<div><span>${String.fromCharCode(65 + i)}</span>${esc(o)}</div>`).join('')}</div>` : s.type === 'scale' ? '<div class="scale-preview">1　2　3　4　5</div><small class="preview-note">Оценка от 1 до 5</small>' : s.type === 'text' ? '<div class="answer-placeholder">Здесь появятся ответы вашей аудитории…</div>' : '<div class="content-mark">✦</div>'}</div><div class="slide-footer"><span>SFEDU-SLIDE</span><span>${String(selected + 1).padStart(2, '0')}</span></div>`;
}
function resultsHTML(s, r) {
  if (s.type === 'content') return '<div class="content-mark">✦</div>';
  if (!r || !r.total) return '<div class="empty-results"><span>✦</span><h3>Слово вашей аудитории</h3><p>Ответы появятся здесь, как только участники их отправят.</p></div>';
  if (s.type === 'wordcloud') { const max = r.words[0]?.count || 1; return `<div class="live-cloud">${r.words.slice(0, 100).map((w, i) => `<span style="font-size:${Math.max(16, Math.min(22 + 48 * w.count / max, 420 / w.word.length))}px;color:${colors[i % colors.length]}" title="${answerCount(w.count)}">${esc(w.word)}<small>${w.count}</small></span>`).join('')}</div>`; }
  if (s.type === 'text') return `<div class="text-results">${r.texts.map(t => `<blockquote>${esc(t)}</blockquote>`).join('')}</div>`;
  const counts = s.type === 'scale' ? r.distribution : r.counts;
  return `${s.type === 'scale' ? `<div class="average">${r.average.toFixed(1)}<small> / 5 · средняя оценка</small></div>` : ''}<div class="bars">${counts.map((c, i) => `<div class="bar-row"><div class="bar-label"><span>${esc(c.label)}</span><strong>${c.count} <small>· ${Math.round(c.count / r.total * 100)}%</small></strong></div><div class="bar-track"><div style="width:${c.count / r.total * 100}%;background:${colors[i % colors.length]}"></div></div></div>`).join('')}</div>`;
}
function joinUrl(code) { return `${config.publicUrl || location.origin}/#/join/${code}`; }
function qr(code) { const q = window.qrcode(0, 'M'); q.addData(joinUrl(code)); q.make(); return q.createSvgTag({ cellSize: 4, margin: 16, scalable: true }); }
async function presenter(code) {
  roomState = await api(`/rooms/${code}/host`);
  app.innerHTML = `<main class="presenter"><header class="presenter-header">${logo}<span id="room-title"></span><span class="live-badge" id="live-status"></span><button id="fullscreen" class="btn light small">⛶ На весь экран</button><a data-nav class="btn light small" href="#/history">Выйти из показа</a></header><div class="presenter-body"><section id="live-slide" class="live-slide"></section><aside class="join-panel"><span class="eyebrow">ПРИСОЕДИНЯЙТЕСЬ</span><h2>Ваш голос<br>важен</h2><div class="qr">${qr(code)}</div><p>Наведите камеру телефона<br>или введите код на странице входа</p><div class="room-code">${code.slice(0, 3)} ${code.slice(3)}</div><a class="join-url" href="${esc(joinUrl(code))}" target="_blank" rel="noopener">${esc(joinUrl(code))}</a><button id="copy-link" class="btn light wide">Скопировать ссылку ↗</button><div class="participant-count"><strong id="participants">0</strong><span>подключились к сессии</span></div>${/^localhost$|^127\./.test(new URL(joinUrl(code)).hostname) ? '<p class="local-warning">Это локальный адрес. Для входа с телефона откройте sfedu-slide по IP компьютера в одной Wi-Fi сети или настройте PUBLIC_URL.</p>' : ''}</aside></div><footer class="presenter-controls"><div><button id="previous" class="btn light" aria-label="Предыдущий слайд">←</button><span id="slide-position"></span><button id="next" class="btn light" aria-label="Следующий слайд">→</button></div><div><button id="toggle-results" class="btn light"></button><button id="toggle-answers" class="btn light"></button><button id="export" class="btn light">↓ Результаты</button><button id="end" class="btn danger">Завершить</button></div></footer><div id="connection" class="connection" role="status"></div></main>`;
  const change = async values => { roomState = await api(`/rooms/${code}/host`, 'PATCH', values); renderHost(); };
  action('#previous', () => change({ index: roomState.index - 1 })); action('#next', () => change({ index: roomState.index + 1 }));
  action('#toggle-results', () => change({ showResults: !roomState.showResults })); action('#toggle-answers', () => change({ accepting: !roomState.accepting }));
  action('#end', async () => { if (confirm('Завершить сессию? Участники больше не смогут отвечать.')) await change({ status: 'ended' }); });
  action('#export', () => exportRoom(code)); action('#copy-link', async () => { try { await navigator.clipboard.writeText(joinUrl(code)); toast('Ссылка скопирована'); } catch { prompt('Скопируйте ссылку:', joinUrl(code)); } });
  action('#fullscreen', async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); });
  const version = routeVersion;
  renderHost(); startPoll(async () => { const next = await api(`/rooms/${code}/host`); if (version !== routeVersion) return; roomState = next; renderHost(); });
}
function renderHost() {
  const r = roomState, s = r.slide;
  $('#room-title').textContent = r.title; $('#live-status').textContent = r.status === 'live' ? '● Прямой эфир' : 'Сессия завершена';
  const el = $('#live-slide'); el.className = `live-slide theme-${r.theme} ${s.textStyle ? 'custom-text' : ''}`; el.setAttribute('style', slideStyle(s));
  el.innerHTML = `<span class="slide-kicker">${symbols[s.type]} ${labels[s.type]}</span><h1>${esc(s.title)}</h1><p class="slide-description">${esc(s.body)}</p><div class="live-results">${r.showResults ? resultsHTML(s, r.results) : '<div class="empty-results"><span>◌</span><h3>Результаты скрыты</h3><p>Сначала соберём мнения, затем посмотрим ответы вместе.</p></div>'}</div><div class="slide-footer"><span>SFEDU-SLIDE</span><span>${answerCount(r.results?.total || 0)}</span></div>`;
  $('#participants').textContent = r.participants; $('#slide-position').textContent = `${r.index + 1} / ${r.slideCount}`;
  $('#previous').disabled = r.index === 0 || r.status === 'ended'; $('#next').disabled = r.index === r.slideCount - 1 || r.status === 'ended';
  $('#toggle-results').textContent = r.showResults ? '◉ Скрыть результаты' : '◉ Показать результаты'; $('#toggle-answers').textContent = r.accepting ? 'Ⅱ Приостановить ответы' : '▷ Принимать ответы';
  for (const id of ['#toggle-results', '#toggle-answers', '#end']) $(id).disabled = r.status === 'ended';
  for (const id of ['#previous','#next','#toggle-results','#toggle-answers','#end']) { if ($(id).disabled) $(id).dataset.locked='true'; else delete $(id).dataset.locked; }
}
function startPoll(fn) {
  const version = routeVersion;
  const tick = async () => { if (version !== routeVersion) return; try { await fn(); if (version !== routeVersion) return; if ($('#connection')) $('#connection').textContent = ''; } catch (e) { if (version === routeVersion && $('#connection')) $('#connection').textContent = `Связь прервана. Повторяем подключение… ${e.message}`; } if (version === routeVersion) pollTimer = setTimeout(tick, 1500); };
  pollTimer = setTimeout(tick, 1500);
}
async function joinPage(code) {
  app.innerHTML = `<main class="join-screen"><header>${logo}<a data-nav href="#/" class="text-btn">Я ведущий →</a></header><section class="join-card"><div class="join-icon">↗</div><span class="eyebrow">СТАНЬТЕ ЧАСТЬЮ РАЗГОВОРА</span><h1>Присоединиться<br>к презентации</h1><p>Введите шестизначный код с экрана ведущего.<br>Регистрация не нужна.</p><form id="join-form"><label for="room-input">Код презентации</label><input id="room-input" name="code" type="text" inputmode="numeric" autocomplete="off" pattern="[0-9]{6}" maxlength="6" required placeholder="000000" value="${/^\d{6}$/.test(code || '') ? code : ''}"><p id="join-error" class="error" role="alert"></p><button class="btn primary wide">Присоединиться →</button></form><small>Ваши ответы анонимны для ведущего</small></section><footer>Маленький ответ. Большое начало.</footer></main>`;
  async function join(c) { roomState = await api(`/rooms/${c}/join`, 'POST'); history.replaceState({}, '', `#/join/${c}`); participant(c); }
  $('#join-form').onsubmit = async e => { e.preventDefault(); const b = $('button', e.target); b.disabled = true; try { await join($('#room-input').value); } catch (e) { $('#join-error').textContent = e.message; b.disabled = false; } };
  if (/^\d{6}$/.test(code || '')) { try { await join(code); } catch (e) { $('#join-error').textContent = e.message; } }
}
function participant(code) {
  answerSelection = []; let lastKey = '', answerDraft = {};  const version = routeVersion;
  app.innerHTML = `<main class="participant-screen"><header>${logo}<span class="pill">Сессия ${code}</span></header><div id="participant-content"></div><div id="participant-results"></div><div id="connection" class="connection" role="status"></div><footer>Вы часть разговора · sfedu-slide</footer></main>`;
  const render = () => {
    const r = roomState, s = r.slide;
    const key = [s.id, r.status, r.accepting, r.answered].join(':');
    if (key !== lastKey) {
      if (lastKey.split(':')[0] !== s.id) { answerSelection = []; answerDraft = {}; }
      lastKey = key;
      $('#participant-content').innerHTML = r.status === 'ended' ? '<section class="participant-card"><div class="success-icon">✓</div><h1>Спасибо за участие!</h1><p>Сессия завершена. Ваши ответы сохранились.</p><a data-nav href="#/join" class="btn primary">Присоединиться к другой</a></section>' : `<section class="participant-card ${s.textStyle ? 'custom-text' : ''}" style="${slideStyle(s)}"><span class="eyebrow">ВОПРОС ${r.index + 1} ИЗ ${r.slideCount}</span><h1>${esc(s.title)}</h1><p>${esc(s.body)}</p>${r.answered ? '<div class="answer-sent"><span>✓</span><h2>Ответ принят!</h2><p>Ждём следующий слайд ведущего.</p></div>' : s.type === 'content' ? '<div class="waiting">✦ Следите за выступлением. Вопрос скоро появится здесь.</div>' : !r.accepting ? '<div class="waiting">Ⅱ Ведущий приостановил приём ответов.</div>' : `<form id="answer-form">${['single', 'multiple'].includes(s.type) ? `<p class="field-hint">${s.type === 'single' ? 'Выберите один вариант' : 'Можно выбрать несколько вариантов'}</p><div class="answer-options">${s.options.map((o, i) => `<label><input type="${s.type === 'single' ? 'radio' : 'checkbox'}" name="answer" value="${i}" ${answerSelection.includes(i) ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</div>` : s.type === 'wordcloud' ? `<label>Ваши слова <small>(до ${s.maxWords}, через запятую)</small><input name="words" maxlength="220" required placeholder="Идеи, команда, вдохновение" autocomplete="off"></label>` : s.type === 'text' ? '<label>Ваш ответ<textarea name="text" rows="5" maxlength="1000" required placeholder="Поделитесь своим мнением…"></textarea></label>' : '<div class="rating">' + [1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="rating" value="${n}" required><span>${n}</span></label>`).join('') + '</div><div class="rating-captions"><span>Минимум</span><span>Максимум</span></div>'}<p id="answer-error" class="error" role="alert"></p><button class="btn primary wide">Отправить ответ →</button></form>`}</section>`;
      if ($('#answer-form')) { const form = $('#answer-form'); for (const el of form.elements) { if (el.name && answerDraft[el.name] !== undefined) { if (['radio', 'checkbox'].includes(el.type)) el.checked = answerDraft[el.name].includes(el.value); else el.value = answerDraft[el.name]; } } form.oninput = () => { const fd = new FormData(form); for (const name of ['answer','rating']) answerDraft[name] = fd.getAll(name); for (const name of ['words','text']) if (fd.has(name)) answerDraft[name] = fd.get(name); }; }
      if ($('#answer-form')) $('#answer-form').onsubmit = async e => {
        e.preventDefault(); const form = e.target, b = $('button', form), data = new FormData(form); b.disabled = true;
        let value;
        if (['single', 'multiple'].includes(s.type)) value = data.getAll('answer').map(Number);
        else if (s.type === 'wordcloud') value = data.get('words').split(',').map(v => v.trim()).filter(Boolean);
        else if (s.type === 'text') value = data.get('text'); else value = Number(data.get('rating'));
        try { roomState = await api(`/rooms/${code}/answer`, 'POST', { slideId: s.id, value }); render(); } catch (e) { if ($('#answer-error')) $('#answer-error').textContent = e.message; b.disabled = false; }
      };
    }
    $('#participant-results').innerHTML = r.status !== 'ended' && r.answered && r.showResults ? `<section class="participant-card result-card"><span class="eyebrow">ОТВЕТЫ АУДИТОРИИ</span>${resultsHTML(s, r.results)}</section>` : '';
  };
  render(); startPoll(async () => { const next = await api(`/rooms/${code}`); if (version !== routeVersion || !$('#participant-content')) return; roomState = next; render(); });
}
async function historyPage() {
  const rooms = await api('/rooms');
  shell(`<header class="topline">Личное пространство <span class="slash">/</span> История сессий</header><section class="page-heading"><div><span class="eyebrow">КАЖДЫЙ ОТВЕТ СОХРАНЁН</span><h1>История сессий</h1><p>Возвращайтесь к результатам и продолжайте открытые встречи.</p></div></section><div class="history-list">${rooms.map(r => `<article class="history-row"><div class="history-icon">${r.status === 'live' ? '▷' : '✓'}</div><div><h3>${esc(r.title)}</h3><p>${date(r.created)} · Код ${r.code} · ${r.status === 'live' ? 'В эфире' : 'Завершена'}</p></div><a data-nav href="#/present/${r.code}" class="btn light">${r.status === 'live' ? 'Продолжить' : 'Посмотреть'}</a><button class="btn light export-room" data-code="${r.code}">↓ CSV</button></article>`).join('') || '<div class="empty-history"><h2>Ваш первый диалог ещё впереди</h2><p>Запустите показ из редактора — сессия и её ответы сохранятся здесь.</p><a data-nav class="btn primary" href="#/">К презентациям →</a></div>'}</div>`, 'history');
  document.querySelectorAll('.export-room').forEach(b => b.onclick = () => exportRoom(b.dataset.code).catch(e => toast(e.message)));
}
async function exportRoom(code) {
  const data = await api(`/rooms/${code}/export`), rows = [['Слайд', 'Тип', 'Ответ', 'Количество', 'Всего ответов']];
  for (const s of data.slides) { const r = s.results; const values = s.type === 'wordcloud' ? r.words.map(w => [w.word, w.count]) : s.type === 'text' ? r.texts.map(t => [t, 1]) : s.type === 'scale' ? r.distribution.map(c => [c.label, c.count]) : r.counts.map(c => [c.label, c.count]); for (const [label, count] of values) rows.push([s.title, labels[s.type], label, count, r.total]); }
  const cell = v => { let str = String(v); if (/^[=+@\-\t\r]/.test(str)) str = `'${str}`; return `"${str.replace(/"/g, '""')}"`; };
  const blob = new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `sfedu-slide-${code}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
route();
