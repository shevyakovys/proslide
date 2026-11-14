export const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const checkedText = (v, max, label = 'Текст') => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) fail(400, `${label}: от 1 до ${max} символов`);
  return v.trim();
};
const types = ['content', 'single', 'multiple', 'wordcloud', 'text', 'scale'];

export function validateTextStyle(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) fail(400, 'Некорректное оформление текста');
  const output = {};
  for (const [key, fallback, min, max] of [['titleSize',44,24,96],['bodySize',20,12,48]]) {
    const n = value[key] ?? fallback;
    if (!Number.isInteger(n) || n < min || n > max) fail(400, 'Размер текста вне допустимого диапазона');
    output[key] = n;
  }
  for (const key of ['titleColor','bodyColor']) {
    if (value[key] !== undefined && value[key] !== null && (typeof value[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[key]))) fail(400, 'Некорректный цвет текста');
    output[key] = value[key]?.toLowerCase() || null;
  }
  return output;
}

export function validateDeck(input) {
  const title = checkedText(input.title, 120, 'Название');
  if (!Array.isArray(input.slides) || input.slides.length < 1 || input.slides.length > 100) fail(400, 'Нужно от 1 до 100 слайдов');
  const ids = new Set();
  const slides = input.slides.map(s => {
    if (!s || !types.includes(s.type)) fail(400, 'Неизвестный тип слайда');
    const id = checkedText(s.id, 80);
    if (ids.has(id)) fail(400, 'Повторяющийся слайд');
    ids.add(id);
    const options = ['single', 'multiple'].includes(s.type) ? s.options : [];
    if (!Array.isArray(options) || (['single', 'multiple'].includes(s.type) && (options.length < 2 || options.length > 8))) fail(400, 'Добавьте от 2 до 8 вариантов');
    const textStyle = validateTextStyle(s.textStyle);
    return { ...(textStyle ? {textStyle} : {}), id, type: s.type, title: checkedText(s.title, 240, 'Заголовок слайда'), body: typeof s.body === 'string' ? s.body.slice(0, 2000) : '', options: options.map(o => checkedText(o, 160)), maxWords: Math.min(5, Math.max(1, Number(s.maxWords) || 3)) };
  });
  return { title, slides, theme: ['violet', 'ocean', 'forest'].includes(input.theme) ? input.theme : 'violet' };
}

export function validateAnswer(s, value) {
  if (['single', 'multiple'].includes(s.type)) {
    if (!Array.isArray(value) || !value.length || value.length > s.options.length || (s.type === 'single' && value.length !== 1) || new Set(value).size !== value.length || value.some(v => !Number.isInteger(v) || v < 0 || v >= s.options.length)) fail(400, 'Выберите корректный вариант ответа');
  } else if (s.type === 'wordcloud') {
    if (!Array.isArray(value) || !value.length || value.length > s.maxWords) fail(400, 'Превышено количество слов');
    value = [...new Set(value.map(v => checkedText(v, 40, 'Слово').normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/g, ' ')))];
  } else if (s.type === 'text') value = checkedText(value, 1000, 'Ответ');
  else if (s.type === 'scale') { if (!Number.isInteger(value) || value < 1 || value > 5) fail(400, 'Выберите оценку от 1 до 5'); }
  else fail(400, 'Этот слайд не принимает ответы');
  return value;
}
export function summarize(s, answers) {
  const counts = s.options.map((label, i) => ({ label, count: answers.filter(a => a.includes(i)).length }));
  const words = new Map();
  if (s.type === 'wordcloud') for (const a of answers) for (const word of a) words.set(word, (words.get(word) || 0) + 1);
  return { total: answers.length, counts, words: [...words].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count), texts: s.type === 'text' ? answers : [], average: s.type === 'scale' && answers.length ? answers.reduce((a, b) => a + b, 0) / answers.length : null, distribution: s.type === 'scale' ? [1, 2, 3, 4, 5].map(n => ({ label: String(n), count: answers.filter(a => a === n).length })) : [] };
}
