import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTextStyle, slideStyle, moveSlide, answerCount } from '../public/editor-model.js';
import { validateDeck as cloudValidate } from '../supabase/functions/proslide-api/domain.js';
import { validateDeck as localValidate } from '../server.js';

const legacy={title:'Существующая презентация',theme:'violet',slides:[{id:'saved-slide',type:'single',title:'Старый вопрос',body:'Описание',options:['Да','Нет'],maxWords:3}]};
test('Existing presentations retain content and IDs with no mandatory style migration',()=>{
 for(const validate of [localValidate,cloudValidate]){
  const result=validate(structuredClone(legacy));assert.deepEqual(result,legacy);assert.equal(slideStyle(result.slides[0]),'');
 }
});
test('Text styling survives validation and rejects CSS injection and invalid sizes',()=>{
 const styled=structuredClone(legacy);styled.slides[0].textStyle={titleSize:64,bodySize:28,titleColor:'#AA1234',bodyColor:'#123ABC'};
 for(const validate of [localValidate,cloudValidate]){
  const roundtrip=validate(styled);assert.deepEqual(roundtrip.slides[0].textStyle,{titleSize:64,bodySize:28,titleColor:'#aa1234',bodyColor:'#123abc'});
  assert.equal(roundtrip.slides[0].id,'saved-slide');
  for(const bad of [{titleSize:999},{titleSize:3.5},{bodyColor:'red;display:none'},{titleColor:'#abc" onmouseover="x'}]){
   const input=structuredClone(legacy);input.slides[0].textStyle=bad;assert.throws(()=>validate(input));
  }
 }
 assert.equal(normalizeTextStyle({titleColor:'red;display:none'}).titleColor,null);
 assert.match(slideStyle(styled.slides[0]),/--title-color:#aa1234/);
});
test('Moving slides preserves all IDs, answers options and per-slide styles without mutation',()=>{
 const slides=[{id:'a',options:['A'],textStyle:{titleSize:48}},{id:'b'},{id:'c'}];
 const moved=moveSlide(slides,0,2);assert.deepEqual(moved.map(s=>s.id),['b','c','a']);assert.equal(moved[2],slides[0]);assert.deepEqual(slides.map(s=>s.id),['a','b','c']);
 assert.deepEqual(moveSlide(moved,2,0),slides);assert.deepEqual(moveSlide(slides,-1,2),slides);
});
test('Russian response counts are readable',()=>{
 assert.equal(answerCount(1),'1 ответ');assert.equal(answerCount(2),'2 ответа');assert.equal(answerCount(11),'11 ответов');assert.equal(answerCount(21),'21 ответ');
});
