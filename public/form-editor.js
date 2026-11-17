const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export const fieldLabels = {short:'Текстовое поле', phone:'Номер телефона', long:'Открытый ответ', single:'Выбор одного'};
export function newField(id, type = 'short') { return {id, type, label:'Новый вопрос', required:false, options:type === 'single' ? ['Да','Нет'] : []}; }
export function admissionFields(makeId) {
  return [
    {...newField(makeId()), label:'ФИО', required:true},
    {...newField(makeId(),'single'), label:'Планируете ли получение высшего образования?', options:['Да','Нет','Пока не определился(-ась)'], required:true},
    {...newField(makeId(),'long'), label:'Ваш вопрос приемной комиссии НШФ ЮФУ:'},
    {...newField(makeId(),'phone'), label:'Номер телефона для связи'}
  ];
}
export function fieldsEditor(fields) {
  return `<section class="form-settings"><div class="panel-title">ПОЛЯ АНКЕТЫ · ${fields.length}/20</div><p class="field-hint">Все поля на одном слайде, отправляются вместе. Ответы доступны автору в CSV.</p>${fields.map((f,i)=>`<fieldset class="form-field-editor" data-field="${esc(f.id)}"><legend>Поле ${i+1}</legend><label>Тип поля<select data-field-type>${Object.entries(fieldLabels).map(([k,v])=>`<option value="${k}" ${k===f.type?'selected':''}>${v}</option>`).join('')}</select></label><label>Вопрос<input data-field-label maxlength="240" value="${esc(f.label)}"></label>${f.type==='single'?`<label>Варианты — каждый с новой строки<textarea data-field-options rows="4">${esc(f.options.join('\n'))}</textarea></label>`:''}<label class="required-field"><input data-field-required type="checkbox" ${f.required?'checked':''}>Обязательное поле</label><div class="field-actions"><button type="button" data-field-up aria-label="Поле выше" ${i===0?'disabled':''}>↑</button><button type="button" data-field-down aria-label="Поле ниже" ${i===fields.length-1?'disabled':''}>↓</button><button type="button" data-field-delete ${fields.length===1?'disabled':''}>Удалить</button></div></fieldset>`).join('')}<button type="button" id="add-form-field" class="btn light wide" ${fields.length>=20?'disabled':''}>＋ Добавить поле</button></section>`;
}
export function formFieldsHTML(fields, preview = false) {
  return `<div class="survey-fields">${fields.map(f=>`<label class="survey-field">${esc(f.label)}${f.required?' <span aria-label="обязательное поле">*</span>':''}${f.type==='single'?`<select name="field_${esc(f.id)}" ${f.required?'required':''} ${preview?'disabled':''}><option value="">Выберите вариант</option>${f.options.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`:f.type==='long'?`<textarea name="field_${esc(f.id)}" rows="3" maxlength="2000" ${f.required?'required':''} ${preview?'disabled':''}></textarea>`:`<input name="field_${esc(f.id)}" type="${f.type==='phone'?'tel':'text'}" maxlength="${f.type==='phone'?40:240}" ${f.type==='phone'?'autocomplete="tel" placeholder="+7 (___) ___-__-__"':''} ${f.required?'required':''} ${preview?'disabled':''}>`}</label>`).join('')}</div>`;
}
