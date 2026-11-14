import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Cloud responses preserve newer author credentials from another tab', async () => {
  globalThis.location = { hostname: 'shevyakovys.github.io' };
  let stored = JSON.stringify({author:'old-author',participant:'guest'});
  globalThis.localStorage = { getItem:()=>stored, setItem:(_key,value)=>{stored=value;} };
  const originalFetch=globalThis.fetch;
  try {
    const {cloudApi}=await import('../public/cloud-api.js');
    globalThis.fetch=async()=>{
      stored=JSON.stringify({author:'new-author',participant:'guest'});
      return new Response(JSON.stringify({status:'live'}));
    };
    await cloudApi('/rooms/123456');
    assert.equal(JSON.parse(stored).author,'new-author');
    globalThis.fetch=async()=>{
      stored=JSON.stringify({author:'latest-author',participant:'guest'});
      return new Response(JSON.stringify({participantToken:'new-guest'}));
    };
    await cloudApi('/rooms/123456/join','POST');
    assert.deepEqual(JSON.parse(stored),{author:'latest-author',participant:'new-guest'});
  } finally { globalThis.fetch=originalFetch; delete globalThis.localStorage; delete globalThis.location; }
});
