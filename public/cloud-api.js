import { cloudConfig as settings } from './cloud-config.js';

const storageKey = 'proslide.cloud.v1';
function credentials() {
  try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; }
}
export async function cloudApi(path, method = 'GET', body) {
  if (path === '/config') return { publicUrl: settings.siteUrl.replace(/\/$/, '') };
  const creds = credentials();
  const res = await fetch(`${settings.apiUrl}${path}`, {
    method,
    headers: {
      apikey: settings.publishableKey,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(creds.author ? { 'X-Author-Token': creds.author } : {}),
      ...(creds.participant ? { 'X-Participant-Token': creds.participant } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Не удалось связаться с сервером');
  // Polling in another tab must never overwrite a newer login/logout. Merge
  // newly issued tokens into the latest stored credentials only when necessary.
  if (result.authorToken || result.participantToken || path === '/logout') {
    const latest = credentials();
    if (result.authorToken) { latest.author = result.authorToken; delete result.authorToken; }
    if (result.participantToken) { latest.participant = result.participantToken; delete result.participantToken; }
    if (path === '/logout' && latest.author === creds.author) delete latest.author;
    localStorage.setItem(storageKey, JSON.stringify(latest));
  }
  return result;
}
