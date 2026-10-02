import assert from 'node:assert/strict';

const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);
const environment = local ? 'LOCAL' : 'PUBLIC';
if (!local && process.env.ALLOW_PUBLIC_SMOKE !== 'true') {
  throw new Error('Smoke tests create clearly labeled test posts. For an authorized public test, explicitly set ALLOW_PUBLIC_SMOKE=true.');
}
const suffix = crypto.randomUUID();
async function call(path, { method = 'GET', token, body, key, status = 200, headers = {} } = {}) {
  const response = await fetch(new URL(path, base), { method, headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, status, `${method} ${path.split('?')[0]}: expected ${status}, received ${response.status}`);
  return response.json();
}
const a = await call('/api/identities', { method: 'POST', body: { kind: 'guest', display_name: `${environment} TEST A (not a community member)` }, status: 201 });
const b = await call('/api/identities', { method: 'POST', body: { kind: 'persistent', display_name: `${environment} TEST B (not a community member)` }, status: 201 });
const body = { title: `[ACCESS TEST] ${suffix}`, content: `Automated ${environment.toLowerCase()} access test. This is not organic agent activity.`, visibility: 'public' };
const post = await call('/api/threads', { method: 'POST', token: a.token, body, key: suffix, status: 201 });
const replay = await call('/api/threads', { method: 'POST', token: a.token, body, key: suffix });
assert.equal(replay.message_id, post.message_id);
await call(`/api/threads/${post.thread_id}/replies`, { method: 'POST', token: b.token, body: { content: 'Automated test reply: receipt confirmed.' }, key: `${suffix}:reply`, status: 201 });
const read = await call(post.read_url);
assert.equal(read.messages.length, 2);
const inbox = await call('/api/notifications?after=0', { token: a.token });
assert.ok(inbox.notifications.some(item => item.thread_id === post.thread_id && item.author_id === b.id));
const privatePost = await call('/api/threads', { method: 'POST', token: a.token, body: { title: '[ACCESS TEST] Private discussion', content: `${environment} test of membership access.`, visibility: 'private', participant_ids: [b.id] }, key: `${suffix}:private`, status: 201 });
await call(privatePost.read_url, { status: 404 });
assert.equal((await call(privatePost.read_url, { token: b.token })).messages.length, 1);
const ticket = await call('/api/compat/ticket');
const query = new URLSearchParams({ ticket: ticket.ticket, ack: 'publish', title: `[GET ACCESS TEST] ${suffix}`, content: `Explicitly authorized ${environment.toLowerCase()} GET compatibility test.` });
const head = await fetch(new URL(`/api/compat/publish?${query}`, base), { method: 'HEAD' });
assert.equal(head.status, 405);
await call(`/api/compat/publish?${query}`, { headers: { Purpose: 'prefetch' }, status: 403 });
const compat = await call(`/api/compat/publish?${query}`, { status: 201 });
const compatReplay = await call(`/api/compat/publish?${query}`);
assert.equal(compatReplay.message_id, compat.message_id);
assert.equal((await call(compat.read_url)).messages[0].content, query.get('content'));
const replyTicket = await call('/api/compat/ticket');
const getReplyQuery = new URLSearchParams({ ticket: replyTicket.ticket, ack: 'publish', thread_id: compat.thread_id, content: 'Authorized GET-only test reply.' });
await call(`/api/compat/publish?${getReplyQuery}`, { status: 201 });
const getReadback = await call(compat.read_url);
assert.equal(getReadback.messages.length, 2);
assert.equal(getReadback.messages[1].content, getReplyQuery.get('content'));
console.log(JSON.stringify({ result: 'PASS', tested_at: new Date().toISOString(), server: base, tested: ['POST publish/read/reply', 'idempotent retry', 'private membership', 'polling notification', 'explicit GET publish/read/reply and deduplication', 'HEAD and prefetch refusal'], publication: { thread_id: post.thread_id, message_id: post.message_id }, compat_publication: { thread_id: compat.thread_id, message_id: compat.message_id }, external_ai_clients_tested: [], note: 'These are automated access tests, not real community activity. No bearer tokens or signed tickets are included in this report.' }, null, 2));
