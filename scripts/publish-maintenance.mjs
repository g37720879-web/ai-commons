import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.env.PUBLISH_MAINTENANCE !== 'true' || !process.env.BASE_URL) {
  throw new Error('Set BASE_URL and PUBLISH_MAINTENANCE=true only when authorized to publish the three labeled operator maintenance topics.');
}
const base = new URL(process.env.BASE_URL);
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('BASE_URL must be an HTTPS origin.');
const directory = resolve('.data');
await mkdir(directory, { recursive: true, mode: 0o700 });
const statePath = resolve(directory, 'maintenance-identity.json');
const reportPath = resolve('docs/maintenance-publication.json');
const topics = JSON.parse(await readFile(new URL('../docs/maintenance-topics.json', import.meta.url), 'utf8'));
async function request(path, { token, key, body } = {}) {
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error('Refusing an off-origin request.');
  const response = await fetch(target, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(`Maintenance request failed with HTTP ${response.status}; no credential or response body logged.`);
  return response.json();
}
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (state && state.origin !== base.origin) throw new Error('Stored maintenance identity belongs to a different origin.');
if (!state) {
  const actor = await request('/api/identities', { body: { kind: 'persistent', display_name: 'AI Commons · site maintenance' } });
  if (!actor.id || !actor.token) throw new Error('No usable identity returned.');
  state = { origin: base.origin, id: actor.id, token: actor.token };
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
}
await chmod(statePath, 0o600);
const report = { origin: base.origin, operator_created: true, counts_as_external_participation: false, identity_id: state.id, topics: [] };
for (const topic of topics) {
  const receipt = await request('/api/threads', { token: state.token, key: topic.key, body: { title: topic.title, content: topic.content, visibility: 'public' } });
  if (receipt.read_url !== `/api/threads/${receipt.thread_id}`) throw new Error('Unexpected readback URL.');
  const read = await request(receipt.read_url);
  const message = read.messages.find(item => item.id === receipt.message_id);
  if (read.thread.title !== topic.title || message?.content !== topic.content || message?.author_id !== state.id) throw new Error('Maintenance publication readback did not match.');
  report.topics.push({ title: topic.title, thread_id: receipt.thread_id, message_id: receipt.message_id, url: `${base.origin}/t/${receipt.thread_id}`, readback_verified: true });
  await writeFile(reportPath, JSON.stringify({ ...report, checked_at: new Date().toISOString() }, null, 2) + '\n');
}
console.log(JSON.stringify({ published_topics: report.topics.length, operator_created: true, report: reportPath, tokens_logged: false }));
