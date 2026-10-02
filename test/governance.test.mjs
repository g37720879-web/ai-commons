import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { createDatabase } from '../scripts/sqlite-adapter.mjs';
const endpoint = '/api/governance/proposals';
const policy = { kind: 'policy', title: 'Founding electorate', description: 'Discuss independent identity evidence before granting roles.' };
function setup(t, extra = {}) {
  const env = { DB: createDatabase(), APP_SECRET: 'test-governance-secret-000000000000000000', ...extra };
  t.after(() => env.DB.close());
  async function call(path, { token, body, key, method = body ? 'POST' : 'GET', headers = {} } = {}) {
    const response = await worker.fetch(new Request(`https://example.test${path}`, { method, headers: { 'CF-Connecting-IP': '192.0.2.1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: response.status, data: await response.json() };
  }
  async function actor(kind = 'guest') { const r = await call('/api/identities', { body: { kind } }); assert.equal(r.status, 201); return r.data; }
  const create = (who, body = policy, key = crypto.randomUUID()) => call(endpoint, { token: who.token, body, key });
  const review = (who, p, extra = {}, key = crypto.randomUUID()) => call(`${endpoint}/${p.proposal_id}/reviews`, { token: who.token, key, body: { proposal_hash: p.proposal_hash, decision: 'approve', text: 'Advisory review only.', ...extra } });
  return { env, call, actor, create, review };
}

test('open contributions authenticate; expired identities and browser cross-site writes fail', async t => {
  const { call, actor, create, env } = setup(t);
  assert.equal((await call(endpoint, { body: policy, key: 'anonymous-key' })).status, 401);
  const a = await actor();
  assert.equal((await call(endpoint, { body: policy, key: 'crosssite-key', token: a.token, headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await create(a)).status, 201);
  env.DB.raw.prepare('UPDATE identities SET expires_at = 1 WHERE id = ?').run(a.id);
  assert.equal((await create(a)).status, 401);
});

test('concurrent retries append once; receipt namespace conflicts with forum and reviews', async t => {
  const { call, actor, create, review, env } = setup(t); const a = await actor();
  const results = await Promise.all([create(a, policy, 'same-request'), create(a, policy, 'same-request')]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.equal(results[0].data.proposal_id, results[1].data.proposal_id);
  assert.equal(env.DB.raw.prepare('SELECT count(*) n FROM governance_proposals').get().n, 1);
  assert.equal((await create(a, { ...policy, title: 'Changed' }, 'same-request')).status, 409);
  assert.equal((await call('/api/threads', { token: a.token, key: 'same-request', body: { title: 'Forum', content: 'Conflict.' } })).status, 409);
  assert.equal((await review(a, results[0].data, {}, 'same-request')).status, 409);
  const reviews = await Promise.all([review(a, results[0].data, {}, 'same-review'), review(a, results[0].data, {}, 'same-review')]);
  assert.deepEqual(reviews.map(r => r.status).sort(), [200, 201]);
  assert.equal(env.DB.raw.prepare('SELECT count(*) n FROM governance_reviews').get().n, 1);
  assert.equal((await review(a, results[0].data, { text: 'Changed.' }, 'same-review')).status, 409);
});

test('code remains immutable data; exact hash reviews never authorize execution', async t => {
  const { call, actor, create, review, env } = setup(t); const a = await actor();
  const code = { kind: 'code', title: 'Change workflow', description: 'Proposed only.', base_commit: 'a'.repeat(40), files: [{ path: '.github/workflows/test.yml', content: 'untrusted: data' }, { path: 'obsolete.txt', content: null }] };
  const p = (await create(a, code)).data;
  assert.match(p.proposal_hash, /^[a-f0-9]{64}$/);
  assert.equal((await review(a, p, { proposal_hash: 'b'.repeat(64) })).status, 409);
  assert.equal((await review(a, p)).status, 201);
  assert.equal((await call(`${endpoint}/${p.proposal_id}`, { method: 'PATCH', body: code, token: a.token })).status, 405);
  assert.throws(() => env.DB.raw.prepare('UPDATE governance_proposals SET kind = ? WHERE id = ?').run('policy', p.proposal_id), /append-only/);
  assert.throws(() => env.DB.raw.prepare('DELETE FROM governance_reviews').run(), /append-only/);
  const replacement = (await create(a, { ...code, supersedes: p.proposal_id, title: 'Revised' })).data;
  assert.notEqual(replacement.proposal_hash, p.proposal_hash);
  const detail = (await call(replacement.read_url)).data;
  assert.deepEqual(detail.reviews, []);
  assert.equal((await create(a, { ...policy, supersedes: p.proposal_id })).status, 400);
  const exec = await call(`${endpoint}/${p.proposal_id}/execute`, { token: a.token, body: {} });
  assert.equal(exec.status, 503); assert.equal(exec.data.error, 'bootstrap_pending');
  assert.deepEqual(exec.data.roles, []); assert.equal(exec.data.automatic_deployment, false);
});

test('only persistent nominees can be proposed; acceptance authenticates candidate and grants nothing', async t => {
  const { call, actor, create, review } = setup(t); const a = await actor(), b = await actor('persistent');
  const nomination = { kind: 'maintainer', title: 'Nomination', description: 'Open discussion.', candidate_id: a.id };
  assert.equal((await create(a, nomination)).status, 400);
  const p = (await create(a, { ...nomination, candidate_id: b.id })).data;
  assert.equal((await review(a, p, { decision: 'accept' })).status, 403);
  assert.equal((await review(b, p, { decision: 'accept' })).data.advisory, true);
  assert.deepEqual((await call('/api/governance/status')).data.roles, []);
  assert.equal((await call('/api/governance/status')).data.governance_rule, null);
});

test('paths and UTF8 sizes checked; public ledger never includes credentials or private forum content', async t => {
  const { call, actor, create, env } = setup(t); const a = await actor();
  const code = { kind: 'code', title: 'Patch', description: 'Data.', base_commit: 'a'.repeat(40) };
  for (const path of ['/root/a', '../a', 'src/../a', '.git/config', '.data/x', '.env', 'x/.env.local', 'node_modules/a', 'secrets/x', 'secrets.json', 'credentials.json', '.dev.vars', 'private-key.pem', 'x\\y', 'a\u0000b', 'a//b', 'a/%2e%2e/b']) {
    assert.equal((await create(a, { ...code, files: [{ path, content: 'a' }] })).status, 400, path);
  }
  assert.equal((await create(a, { ...code, files: [{ path: 'a', content: '中'.repeat(2667) }] })).status, 413);
  assert.equal((await create(a, { ...code, files: [{ path: 'a', content: '' }, { path: 'a', content: null }] })).status, 400);
  assert.equal((await create(a, { ...policy, roles: ['maintainer'] })).status, 400);
  await call('/api/threads', { token: a.token, key: 'private-thread', body: { title: 'private', visibility: 'private', content: 'DO-NOT-LEAK-THIS' } });
  const p = (await create(a)).data;
  const publicText = JSON.stringify([(await call(endpoint)).data, (await call(p.read_url)).data]);
  assert.ok(!publicText.includes(a.token)); assert.ok(!publicText.includes('DO-NOT-LEAK-THIS'));
  assert.ok(!publicText.includes(env.DB.raw.prepare('SELECT token_hash FROM identities WHERE id=?').get(a.id).token_hash));
});

test('stable proposal and review pagination; separate governance quota leaves forum counters intact', async t => {
  const { call, actor, create, review, env } = setup(t, { MAX_DAILY_GOVERNANCE: '4' }); const a = await actor();
  const p = (await create(a)).data; await create(a, { ...policy, title: 'Second' });
  await review(a, p); await review(a, p, { text: 'Another comment', decision: 'comment' });
  const first = (await call(`${endpoint}?limit=1`)).data;
  assert.equal(first.proposals.length, 1); assert.equal(first.has_more, true);
  const second = (await call(`${endpoint}?limit=1&after=${first.next_after}`)).data;
  assert.equal(second.has_more, false); assert.notEqual(first.proposals[0].id, second.proposals[0].id);
  const r1 = (await call(`${p.read_url}?limit=1`)).data;
  const r2 = (await call(`${p.read_url}?limit=1&after=${r1.next_after}`)).data;
  assert.equal(r1.has_more, true); assert.equal(r2.has_more, false); assert.notEqual(r1.reviews[0].id, r2.reviews[0].id);
  assert.equal((await create(a)).status, 429);
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM rate_counters WHERE bucket LIKE 'message%'").get().n, 0);
  assert.equal((await call('/api/threads', { token: a.token, key: 'still-can-post', body: { title: 'Test', content: 'Separate quota' } })).status, 201);
});


test('IP and identity governance quotas enforce independently', async t => {
  const { call, actor, create, env } = setup(t); const a = await actor();
  await create(a);
  env.DB.raw.prepare("UPDATE rate_counters SET hits = 30 WHERE bucket LIKE 'governance-ip:%'").run();
  assert.equal((await create(a)).status, 429);
  env.DB.raw.prepare("UPDATE rate_counters SET hits = 1 WHERE bucket LIKE 'governance-ip:%'").run();
  env.DB.raw.prepare("UPDATE rate_counters SET hits = 30 WHERE bucket LIKE 'governance-identity:%'").run();
  assert.equal((await call(endpoint, { token: a.token, body: policy, key: 'new-outbound-ip', headers: { 'CF-Connecting-IP': '192.0.2.5' } })).status, 429);
});

test('bounded exact-text edits represent large files without uploading entire source', async t => {
  const { call, actor, create } = setup(t); const a = await actor();
  const files = [{ path: 'src/worker.mjs', edits: [{ old_text: "stage: 'access-prototype'", new_text: "stage: 'community-prototype'" }, { old_text: "stage: 'community-prototype'", new_text: "stage: 'community-bootstrap'" }] }];
  const body = { kind: 'code', title: 'Change large worker label', description: 'Sequential exact edits, not a complete file replacement.', base_commit: 'a'.repeat(40), files };
  const created = await create(a, body); assert.equal(created.status, 201);
  assert.deepEqual((await call(created.data.read_url)).data.proposal.files, files);
  const reversed = await create(a, { ...body, files: [{ ...files[0], edits: [...files[0].edits].reverse() }] });
  assert.notEqual(reversed.data.proposal_hash, created.data.proposal_hash);
  const invalidFiles = [
    { path: 'a', content: '', edits: [{ old_text: 'a', new_text: 'b' }] },
    { path: 'a' }, { path: 'a', edits: [] },
    { path: 'a', edits: Array.from({ length: 11 }, () => ({ old_text: 'a', new_text: '' })) },
    { path: 'a', edits: [{ old_text: '', new_text: 'b' }] },
    { path: 'a', edits: [{ old_text: 'a', new_text: 'b', count: 1 }] },
    { path: 'a', edits: [{ old_text: 'a', new_text: null }] },
    { path: 'a', edits: [{ old_text: 'a\0b', new_text: 'b' }] },
    { path: 'a', edits: [{ old_text: 'a', new_text: '\0' }] },
    { path: 'a', content: '\0' }
  ];
  for (const file of invalidFiles) assert.equal((await create(a, { ...body, files: [file] })).status, 400);
  assert.equal((await create(a, { ...body, files: [{ path: 'a', edits: [{ old_text: '中'.repeat(2000), new_text: '中'.repeat(1000) }] }] })).status, 413);
  assert.equal((await create(a, { ...body, files: [{ path: 'a', content: 'x'.repeat(5000) }, { path: 'b', edits: [{ old_text: 'x'.repeat(1501), new_text: 'x'.repeat(1500) }] }] })).status, 413);
});

test('newest-first proposal pages stay stable across insertions without skipping older rows', async t => {
  const { call, actor, create } = setup(t); const a = await actor();
  const ids = [];
  for (let n = 0; n < 3; n++) ids.push((await create(a, { ...policy, title: `Proposal ${n}` })).data.proposal_id);
  const first = (await call(`${endpoint}?before=${Number.MAX_SAFE_INTEGER}&limit=2`)).data;
  assert.deepEqual(first.proposals.map(p => p.id), [ids[2], ids[1]]);
  assert.equal(first.has_more, true); assert.ok(!Object.hasOwn(first, 'next_after'));
  const later = (await create(a, { ...policy, title: 'Inserted after first page' })).data;
  const second = (await call(`${endpoint}?before=${first.next_before}&limit=2`)).data;
  assert.deepEqual(second.proposals.map(p => p.id), [ids[0]]);
  assert.equal(second.has_more, false);
  const newest = (await call(`${endpoint}?before=${Number.MAX_SAFE_INTEGER}&limit=1`)).data;
  assert.equal(newest.proposals[0].id, later.proposal_id);
  const end = (await call(`${endpoint}?before=${second.next_before}`)).data;
  assert.deepEqual(end.proposals, []); assert.equal(end.next_before, second.next_before); assert.equal(end.has_more, false);
  const zero = (await call(`${endpoint}?before=0`)).data;
  assert.deepEqual(zero.proposals, []); assert.equal(zero.next_before, 0);
  assert.equal((await call(`${endpoint}?before=1&after=0`)).status, 400);
  assert.equal((await call(`${endpoint}?before=-1`)).status, 400);
  assert.equal((await call(`${endpoint}?before=9007199254740992`)).status, 400);
  assert.deepEqual((await call(endpoint)).data.proposals.map(p => p.id), [...ids, later.proposal_id]);
});
