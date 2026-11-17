const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
const fieldTypes = ['short', 'phone', 'long', 'single'];
export function validateFields(fields) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 20) invalid('В анкете должно быть от 1 до 20 полей');
  const ids = new Set();
  return fields.map(f => {
    if (!f || !/^[a-zA-Z0-9_-]{1,80}$/.test(f.id) || ids.has(f.id) || !fieldTypes.includes(f.type)) invalid('Некорректное поле анкеты');
    ids.add(f.id);
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.trim().length > 240) invalid('Укажите название поля: до 240 символов');
    let options = [];
    if (f.type === 'single') {
      if (!Array.isArray(f.options) || f.options.length < 2 || f.options.length > 12 || f.options.some(o => typeof o !== 'string' || !o.trim() || o.trim().length > 160)) invalid('Добавьте от 2 до 12 непустых вариантов ответа');
      options = f.options.map(o => o.trim());
      if (new Set(options).size !== options.length) invalid('Варианты ответа не должны повторяться');
    }
    return { id: f.id, type: f.type, label: f.label.trim(), required: f.required === true, options };
  });
}
export function validateFormAnswer(slide, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Заполните анкету');
  const entries = slide.fields.map(f => {
    const raw = Object.hasOwn(value, f.id) ? value[f.id] : '';
    if (typeof raw !== 'string') invalid(`Некорректный ответ: ${f.label}`);
    const v = raw.trim();
    if (!v) { if (f.required) invalid(`Заполните поле «${f.label}»`); return [f.id, '']; }
    if (v.length > (f.type === 'long' ? 2000 : f.type === 'phone' ? 40 : 240)) invalid(`Слишком длинный ответ: ${f.label}`);
    if (f.type === 'phone' && (!/^\+?[\d\s().-]+$/.test(v) || v.replace(/\D/g, '').length < 7 || v.replace(/\D/g, '').length > 15)) invalid(`Введите корректный номер телефона: ${f.label}`);
    if (f.type === 'single' && !f.options.includes(v)) invalid(`Выберите вариант: ${f.label}`);
    return [f.id, v];
  });
  if (!entries.some(([,v]) => v)) invalid('Заполните хотя бы одно поле анкеты');
  return Object.fromEntries(entries);
}
export function summarizeForm(answers, includeResponses = false) {
  return { total: answers.length, counts: [], words: [], texts: [], average: null, distribution: [], ...(includeResponses ? { responses: answers } : {}) };
}
