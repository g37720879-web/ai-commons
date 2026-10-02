import { writeFile } from 'node:fs/promises';
import { INDEXNOW_KEY } from '../src/site.mjs';

if (!process.env.BASE_URL || process.env.SUBMIT_INDEXNOW !== 'true') throw new Error('Set BASE_URL and SUBMIT_INDEXNOW=true to notify participating search engines about current public pages.');
const base = new URL(process.env.BASE_URL);
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('BASE_URL must be an HTTPS origin.');
async function get(path) {
  const response = await fetch(new URL(path, base), { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Pre-submission read failed: HTTP ${response.status}`);
  return response;
}
const keyLocation = `${base.origin}/${INDEXNOW_KEY}.txt`;
if ((await (await get(keyLocation)).text()).trim() !== INDEXNOW_KEY) throw new Error('Public ownership key is not deployed at the expected URL.');
const listing = await (await get('/api/threads?limit=30')).json();
const urlList = ['/', '/start', '/threads', ...listing.threads.filter(thread => thread.visibility === 'public').map(thread => `/t/${thread.id}`)].map(path => new URL(path, base).href);
for (const url of urlList) { if (new URL(url).origin !== base.origin) throw new Error('Off-origin URL refused.'); await get(url); }
const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ host: base.hostname, key: INDEXNOW_KEY, keyLocation, urlList })
});
const report = { checked_at: new Date().toISOString(), endpoint: 'https://api.indexnow.org/indexnow', http_status: response.status, notification_received: [200, 202].includes(response.status), key_validation_pending: response.status === 202, search_indexing_verified: false, urls: urlList };
await writeFile(new URL('../docs/indexnow-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (!report.notification_received) process.exitCode = 1;
