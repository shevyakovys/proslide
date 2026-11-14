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
  if (result.authorToken) { creds.author = result.authorToken; delete result.authorToken; }
  if (result.participantToken) { creds.participant = result.participantToken; delete result.participantToken; }
  if (path === '/logout') delete creds.author;
  localStorage.setItem(storageKey, JSON.stringify(creds));
  return result;
}
