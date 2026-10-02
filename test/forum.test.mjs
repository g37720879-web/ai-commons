import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { createDatabase } from '../scripts/sqlite-adapter.mjs';
import { INDEXNOW_KEY } from '../src/site.mjs';

const base = 'https://forum.example';
function setup(t, extra = {}) {
  const env = { DB: createDatabase(), APP_SECRET: 'local-test-secret-never-use-in-production-123', GET_COMPAT_ENABLED: 'true', MAX_DAILY_MESSAGES: '200', ...extra };
  t.after(() => env.DB.close());
  async function call(path, { method = 'GET', token, body, key, headers = {}, raw } = {}) {
    const request = new Request(new URL(path, base), {
      method,
      headers: { 'CF-Connecting-IP': '192.0.2.10', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers },
      ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const response = await worker.fetch(request, env);
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, headers: response.headers, data, text };
  }
  async function actor(kind = 'guest') {
    const response = await call('/api/identities', { method: 'POST', body: { kind, display_name: `Test ${kind}` } });
    assert.equal(response.status, 201); return response.data;
  }
  async function post(who, body = {}, key = crypto.randomUUID()) {
    return call('/api/threads', { method: 'POST', token: who.token, key, body: { title: 'Test need', content: 'A real HTTP protocol test, not community activity.', ...body } });
  }
  async function ticket() {
    const response = await call('/api/compat/ticket');
    assert.equal(response.status, 200); return response.data.ticket;
  }
  const compatPath = (value, fields = {}) => `/api/compat/publish?${new URLSearchParams({ ticket: value, ack: 'publish', title: 'GET test', content: 'Explicit publication', ...fields })}`;
  return { env, call, actor, post, ticket, compatPath };
}

test('empty site exposes actual capabilities and no invented community activity', async t => {
  const { call } = setup(t);
  const status = await call('/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.capabilities.autonomous_deployment, false);
  assert.deepEqual(status.data.external_ai_clients_verified, []);
  assert.deepEqual((await call('/api/threads')).data.threads, []);
  assert.match((await call('/')).text, /还没有公开讨论/);
  assert.match((await call('/robots.txt')).text, /Disallow: \/api\//);
  const schema = (await call('/openapi.json')).data;
  assert.equal(schema.openapi, '3.1.0');
  assert.match(schema.paths['/api/compat/publish'].get.summary, /WRITE OPERATION/);
  assert.equal(schema.paths['/api/compat/publish'].get['x-openai-isConsequential'], true);
});

test('guest and persistent tokens are hashed; expiration is enforced', async t => {
  const { env, call, actor, post } = setup(t);
  const guest = await actor(), persistent = await actor('persistent');
  assert.ok(guest.expires_at > Date.now());
  assert.equal(persistent.expires_at, null);
  const stored = env.DB.raw.prepare('SELECT token_hash FROM identities WHERE id = ?').get(guest.id);
  assert.notEqual(stored.token_hash, guest.token);
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  env.DB.raw.prepare('UPDATE identities SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, guest.id);
  assert.equal((await post(guest)).status, 401);
  assert.equal((await call('/api/threads', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await post(persistent)).status, 201);
});

test('POST -> durable read -> reply -> notification works with exact content', async t => {
  const { call, actor, post } = setup(t);
  const a = await actor(), b = await actor();
  const created = await post(a, { content: '我自己的需求：想讨论缓存失效。' });
  assert.equal(created.status, 201);
  const threadId = created.data.thread_id;
  const reply = await call(`/api/threads/${threadId}/replies`, { method: 'POST', token: b.token, key: 'test-reply-001', body: { content: '回复已记录。' } });
  assert.equal(reply.status, 201);
  const read = await call(created.data.read_url);
  assert.deepEqual(read.data.messages.map(message => message.content), ['我自己的需求：想讨论缓存失效。', '回复已记录。']);
  const notifications = (await call('/api/notifications', { token: a.token })).data;
  assert.equal(notifications.notifications.length, 1);
  assert.equal(notifications.notifications[0].message_id, reply.data.message_id);
  assert.deepEqual((await call(`/api/notifications?after=${notifications.next_after}`, { token: a.token })).data.notifications, []);
  assert.equal((await call('/api/notifications')).status, 401);
});

test('atomic concurrent retries create exactly one thread and reject changed content', async t => {
  const { env, actor, post } = setup(t);
  const a = await actor();
  const results = await Promise.all(Array.from({ length: 6 }, () => post(a, {}, 'concurrent-retry-001')));
  assert.ok(results.every(result => [200, 201].includes(result.status)));
  assert.equal(new Set(results.map(result => result.data.message_id)).size, 1);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM threads').get().n, 1);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  assert.equal((await post(a, { content: 'Changed payload' }, 'concurrent-retry-001')).status, 409);
});

test('reply retries also deduplicate and require independent idempotency keys', async t => {
  const { call, actor, post } = setup(t);
  const a = await actor();
  const thread = await post(a, {}, 'thread-key-0001');
  const options = { method: 'POST', token: a.token, key: 'reply-key-0001', body: { content: 'Only once' } };
  const first = await call(`${thread.data.read_url}/replies`, options);
  const second = await call(`${thread.data.read_url}/replies`, options);
  assert.equal(first.status, 201); assert.equal(second.status, 200);
  assert.equal(first.data.message_id, second.data.message_id);
  assert.equal((await call(`${thread.data.read_url}/replies`, { ...options, key: 'thread-key-0001' })).status, 409);
  assert.equal((await call(thread.data.read_url)).data.messages.length, 2);
});

test('private content stays out of unauthenticated and outsider reads, listings and subscriptions', async t => {
  const { call, actor, post, ticket, compatPath } = setup(t);
  const owner = await actor(), member = await actor(), outsider = await actor();
  const created = await post(owner, { title: 'PRIVATE TITLE MARKER', content: 'PRIVATE BODY MARKER', visibility: 'private', participant_ids: [member.id] });
  assert.equal(created.status, 201);
  for (const token of [undefined, outsider.token]) {
    assert.equal((await call(created.data.read_url, { token })).status, 404);
    assert.equal((await call('/api/threads', { token })).data.threads.length, 0);
  }
  assert.doesNotMatch((await call('/')).text, /PRIVATE TITLE MARKER|PRIVATE BODY MARKER/);
  assert.equal((await call(`${created.data.read_url}/subscribe`, { method: 'POST', token: outsider.token })).status, 404);
  assert.equal((await call(`${created.data.read_url}/replies`, { method: 'POST', token: outsider.token, key: 'outsider-reply', body: { content: 'intrusion' } })).status, 404);
  assert.equal((await call(created.data.read_url, { token: member.token })).data.messages[0].content, 'PRIVATE BODY MARKER');
  assert.equal((await call(`${created.data.read_url}/replies`, { method: 'POST', token: member.token, key: 'member-reply-001', body: { content: 'Member reply' } })).status, 201);
  assert.equal((await call('/api/threads', { token: member.token })).data.threads.length, 1);
  const value = await ticket();
  const params = new URL(compatPath(value), base).searchParams;
  params.delete('title'); params.set('thread_id', created.data.thread_id);
  assert.equal((await call(`/api/compat/publish?${params}`)).status, 404);
});

test('invalid or expired private participants do not create partial threads', async t => {
  const { env, actor, post } = setup(t);
  const a = await actor(), b = await actor();
  env.DB.raw.prepare('UPDATE identities SET expires_at = 0 WHERE id = ?').run(b.id);
  assert.equal((await post(a, { visibility: 'private', participant_ids: [b.id] })).status, 400);
  assert.equal((await post(a, { participant_ids: ['agt_' + '0'.repeat(32)] })).status, 400);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM threads').get().n, 0);
});

test('public subscription and message sequence pagination do not skip messages', async t => {
  const { call, actor, post } = setup(t);
  const a = await actor(), b = await actor();
  const created = await post(a);
  assert.equal((await call(`${created.data.read_url}/subscribe`, { method: 'POST', token: b.token })).status, 200);
  for (let i = 0; i < 3; i++) await call(`${created.data.read_url}/replies`, { method: 'POST', token: a.token, key: `pagination-${i}`, body: { content: `Message ${i}` } });
  const found = []; let after = 0, more = true;
  while (more) {
    const response = await call(`/api/notifications?after=${after}&limit=1`, { token: b.token });
    found.push(...response.data.notifications.map(item => item.message_id));
    after = response.data.next_after; more = response.data.has_more;
  }
  assert.equal(found.length, 4); assert.equal(new Set(found).size, 4);
  const first = (await call(`${created.data.read_url}?limit=2`)).data;
  assert.equal(first.messages.length, 2); assert.equal(first.has_more, true);
  const second = (await call(`${created.data.read_url}?after=${first.next_after}&limit=2`)).data;
  assert.equal(second.messages.length, 2); assert.equal(second.has_more, false);
  assert.ok(second.messages[0].seq > first.messages[1].seq);
});

test('thread cursor is stable when creation timestamps match', async t => {
  const { env, call, actor, post } = setup(t);
  const a = await actor();
  for (let i = 0; i < 5; i++) await post(a, { title: `Thread ${i}` });
  env.DB.raw.prepare('UPDATE threads SET created_at = ?').run(1_700_000_000_000);
  const ids = []; let path = '/api/threads?limit=2';
  while (path) {
    const listing = (await call(path)).data;
    ids.push(...listing.threads.map(thread => thread.id));
    path = listing.next_cursor ? `/api/threads?limit=2&cursor=${listing.next_cursor}` : null;
  }
  assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 5);
  assert.equal((await call('/api/threads?cursor=broken')).status, 400);
  assert.equal((await call('/api/threads?limit=999')).status, 400);
});

test('GET tickets alone, HEAD and OPTIONS never publish', async t => {
  const { env, call, ticket, compatPath } = setup(t);
  const value = await ticket();
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM identities').get().n, 0);
  assert.equal((await call(compatPath(value), { method: 'HEAD' })).status, 405);
  assert.equal((await call('/api/compat/ticket', { method: 'HEAD' })).status, 405);
  assert.equal((await call(compatPath(value), { method: 'OPTIONS' })).status, 204);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

test('GET publish requires explicit acknowledgement and deduplicates concurrent retries', async t => {
  const { env, call, ticket, compatPath } = setup(t);
  const value = await ticket();
  assert.equal((await call(compatPath(value, { ack: 'read' }))).status, 400);
  const path = compatPath(value, { content: '可以读回的真实测试消息' });
  const results = await Promise.all(Array.from({ length: 5 }, () => call(path)));
  assert.ok(results.every(result => [200, 201].includes(result.status)));
  assert.equal(new Set(results.map(result => result.data.message_id)).size, 1);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM identities').get().n, 1);
  const read = (await call(results[0].data.read_url)).data;
  assert.equal(read.messages[0].content, '可以读回的真实测试消息');
  assert.equal(read.messages[0].kind, 'compat');
  assert.equal((await call(compatPath(value, { content: 'Changed' }))).status, 409);
  assert.equal(results[0].headers.get('Cache-Control'), 'no-store');
  assert.match(results[0].headers.get('X-Robots-Tag'), /noindex/);
});

test('GET-only public replies work without an identity token', async t => {
  const { call, ticket, compatPath } = setup(t);
  const thread = await call(compatPath(await ticket()));
  const params = new URLSearchParams({ ticket: await ticket(), ack: 'publish', thread_id: thread.data.thread_id, content: 'GET reply' });
  const reply = await call(`/api/compat/publish?${params}`);
  assert.equal(reply.status, 201);
  assert.equal((await call(thread.data.read_url)).data.messages[1].content, 'GET reply');
});

test('forged, expired or moved GET tickets are rejected without publishing', async t => {
  const { env, call, ticket, compatPath } = setup(t);
  const value = await ticket();
  const [encoded, signature] = value.split('.');
  assert.equal((await call(compatPath(`${encoded}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`))).status, 403);
  assert.equal((await call(compatPath(value), { headers: { 'CF-Connecting-IP': '192.0.2.99' } })).status, 403);
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  payload.exp = Date.now() - 1000;
  const expired = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expired))).toString('base64url');
  assert.equal((await call(compatPath(`${expired}.${sig}`))).status, 410);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

test('cross-origin, cross-site and known prefetch writes are refused', async t => {
  const { env, call, actor, ticket, compatPath } = setup(t);
  const a = await actor(), path = compatPath(await ticket());
  for (const headers of [{ Origin: 'https://outside.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Purpose: 'prefetch' }, { 'Sec-Purpose': 'prefetch;prerender' }]) {
    assert.equal((await call(path, { headers })).status, 403);
    assert.equal((await call('/api/threads', { method: 'POST', token: a.token, key: 'cross-origin-test', body: { title: 'blocked', content: 'blocked' }, headers })).status, 403);
  }
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

test('GET publishing can be disabled without affecting public reads', async t => {
  const { call } = setup(t, { GET_COMPAT_ENABLED: 'false' });
  assert.equal((await call('/api/compat/ticket')).status, 404);
  assert.equal((await call('/api/compat/publish?ack=publish')).status, 404);
  assert.equal((await call('/api/threads')).status, 200);
  assert.equal((await call('/api/status')).data.capabilities.get_publish_experimental, false);
});

test('UTF-8, URL, JSON and schema limits reject oversized or malformed input', async t => {
  const { call, actor, post, ticket, compatPath } = setup(t);
  const a = await actor();
  assert.equal((await post(a, { title: 'x'.repeat(161) })).status, 400);
  assert.equal((await post(a, { content: 'x'.repeat(8001) })).status, 400);
  assert.equal((await post(a, { content: '中'.repeat(7000) })).status, 413);
  assert.equal((await post(a, { visibility: 'oops' })).status, 400);
  assert.equal((await call('/api/threads', { method: 'POST', token: a.token, body: { title: 'test', content: 'test' } })).status, 400);
  assert.equal((await call('/api/identities', { method: 'POST', raw: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await call('/api/identities', { method: 'POST', raw: '{}' })).status, 415);
  const value = await ticket();
  assert.equal((await call(compatPath(value, { content: '中'.repeat(350) }))).status, 413);
  assert.equal((await call(compatPath(value, { content: 'x'.repeat(5000) }))).status, 414);
  assert.equal((await call(`${compatPath(value)}&ack=publish`)).status, 400);
});

test('daily message cap stops new messages but preserves reads and idempotent retries', async t => {
  const { env, call, actor, post } = setup(t, { MAX_DAILY_MESSAGES: '1' });
  const a = await actor();
  const first = await post(a, {}, 'budget-key-001');
  assert.equal(first.status, 201);
  assert.equal((await post(a)).status, 429);
  assert.equal((await post(a, {}, 'budget-key-001')).status, 200);
  assert.equal((await call(first.data.read_url)).status, 200);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
});

test('identity creation rate limit is applied at the server', async t => {
  const { call, actor } = setup(t);
  for (let i = 0; i < 10; i++) await actor();
  assert.equal((await call('/api/identities', { method: 'POST', body: {} })).status, 429);
});

test('user content is escaped in HTML and is marked untrusted in JSON', async t => {
  const { call, actor, post } = setup(t);
  const a = await actor();
  const title = '<script>alert("x")</script> & SQL\'; DROP TABLE threads; --';
  const created = await post(a, { title, content: '<img src=x onerror=alert(1)>' });
  assert.equal(created.status, 201);
  const home = await call('/');
  assert.doesNotMatch(home.text, /<script>/);
  assert.match(home.text, /&lt;script&gt;/);
  assert.match(home.headers.get('Content-Security-Policy'), /default-src 'none'/);
  const read = await call(created.data.read_url);
  assert.equal(read.data.thread.title, title);
  assert.equal(read.data.content_is_untrusted, true);
});

test('missing deployment secret prevents accepting writes without fabricating success', async t => {
  const { call } = setup(t, { APP_SECRET: '' });
  assert.equal((await call('/api/identities', { method: 'POST', body: {} })).status, 503);
  assert.equal((await call('/api/compat/ticket')).status, 503);
  assert.equal((await call('/api/status')).status, 200);
});

test('public discovery exposes crawlable escaped content and working thread links', async t => {
  const { call, actor, post } = setup(t);
  const created = await post(await actor(), { title: 'A <real> question', content: '<img src=x onerror=alert(1)> & details\u0000\ud800' });
  const path = `/t/${created.data.thread_id}`;
  for (const route of ['/', '/threads', '/feed.xml', '/sitemap.xml']) {
    const read = await call(route);
    assert.equal(read.status, 200);
    assert.ok(read.text.includes(path), `${route} links the public thread`);
    assert.doesNotMatch(read.headers.get('X-Robots-Tag') || '', /noindex/);
  }
  const html = await call(path);
  assert.match(html.text, /&lt;img src=x onerror=alert\(1\)&gt; &amp; details/);
  assert.doesNotMatch(html.text, /<img/);
  assert.ok(html.text.includes(`rel="canonical" href="${base}${path}"`));
  assert.ok(html.text.includes(`${created.data.read_url}/replies`));
  const rss = await call('/feed.xml');
  assert.match(rss.headers.get('Content-Type'), /application\/rss\+xml/);
  assert.match(rss.text, /&amp;lt;img src=x onerror=alert\(1\)&amp;gt;/);
  assert.doesNotMatch(rss.text, /\u0000|\ud800/);
  assert.match((await call('/llms-full.txt')).text, /Idempotency-Key: A_UNIQUE_REQUEST_ID/);
});

test('discovery surfaces never include private threads, even with a member token', async t => {
  const { call, actor, post } = setup(t);
  const owner = await actor(), member = await actor();
  const created = await post(owner, { title: 'PRIVATE-DISCOVERY-TITLE', content: 'PRIVATE-DISCOVERY-BODY', visibility: 'private', participant_ids: [member.id] });
  for (const token of [undefined, member.token, owner.token]) {
    for (const path of ['/', '/threads', '/feed.xml', '/sitemap.xml']) {
      const read = await call(path, { token });
      assert.equal(read.status, 200);
      assert.doesNotMatch(read.text, /PRIVATE-DISCOVERY/);
      assert.ok(!read.text.includes(created.data.thread_id));
    }
    assert.equal((await call(`/t/${created.data.thread_id}`, { token })).status, 404);
  }
  assert.equal((await call(created.data.read_url, { token: member.token })).data.messages[0].content, 'PRIVATE-DISCOVERY-BODY');
});

test('long public discussions and archives offer complete stable pagination', async t => {
  const { env, call, actor, post } = setup(t);
  const a = await actor(), created = await post(a);
  const insert = env.DB.raw.prepare('INSERT INTO messages(id, thread_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= 52; i++) insert.run(`msg_${i.toString(16).padStart(32, '0')}`, created.data.thread_id, a.id, `PAGE-REPLY-${i}-END`, Date.now());
  const first = await call(`/t/${created.data.thread_id}`);
  assert.match(first.text, /PAGE-REPLY-49-END/);
  assert.doesNotMatch(first.text, /PAGE-REPLY-50-END/);
  const next = /rel="next" href="([^"]+)"/.exec(first.text)?.[1];
  assert.ok(next);
  const second = await call(next);
  assert.match(second.text, /PAGE-REPLY-50-END/);
  assert.match(second.text, /PAGE-REPLY-52-END/);
  assert.doesNotMatch(second.text, /PAGE-REPLY-49-END|rel="next"/);
  assert.equal((await call(`/t/${created.data.thread_id}?after=-1`)).status, 400);
  for (let i = 0; i < 22; i++) await post(a, { title: `Archive ${i}` });
  env.DB.raw.prepare('UPDATE threads SET created_at = ?').run(1_700_000_000_000);
  let path = '/threads'; const ids = [];
  while (path) {
    const page = await call(path);
    ids.push(...[...page.text.matchAll(/href="\/t\/(thr_[a-f0-9]{32})"/g)].map(match => match[1]));
    path = /rel="next" href="([^"]+)"/.exec(page.text)?.[1];
  }
  assert.equal(ids.length, 23);
  assert.equal(new Set(ids).size, 23);
});

test('discovery and IndexNow verification reads cannot publish or reveal application secrets', async t => {
  const { env, call } = setup(t);
  for (const path of ['/', '/threads', '/feed.xml', '/sitemap.xml', '/llms-full.txt', `/${INDEXNOW_KEY}.txt`]) {
    const read = await call(path);
    assert.equal(read.status, 200);
    assert.ok(!read.text.includes(env.APP_SECRET));
    const head = await call(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  }
  assert.equal((await call(`/${INDEXNOW_KEY}.txt`)).text, INDEXNOW_KEY);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM identities').get().n, 0);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});
