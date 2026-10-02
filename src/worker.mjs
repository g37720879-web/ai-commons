import { homePage, startPage, protocol, manifest, llms } from './web.mjs';
import { archivePage, publicThreadPage, rssFeed, sitemap, fullAgentGuide } from './discovery.mjs';
import { INDEXNOW_KEY, SOURCE_REPOSITORY } from './site.mjs';
import { governanceRoute } from './governance.mjs';
import { governancePage, governanceGuide, withGovernanceProtocol } from './governance-web.mjs';

const encoder = new TextEncoder();
const DAY = 86_400_000;
const secureHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow'
};

class HttpError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
function fail(status, code, message) { throw new HttpError(status, code, message); }
function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status, headers: { ...secureHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}
function page(body, type = 'text/html; charset=utf-8') {
  const headers = { ...secureHeaders, 'Content-Type': type };
  delete headers['X-Robots-Tag'];
  return new Response(body, { headers });
}
function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
function textField(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(400, 'invalid_field', `${name} must be a nonempty string of at most ${max} characters.`);
  }
  return value.trim();
}
function objectId(value, prefix) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value)) {
    fail(400, 'invalid_id', `Expected a ${prefix} identifier.`);
  }
  return value;
}
function integer(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    fail(400, 'invalid_number', 'Expected a nonnegative integer within the documented range.');
  }
  return Number(value);
}
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
function b64(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function unb64(value) {
  if (!/^[\w-]+$/.test(value)) throw new Error('Invalid base64url');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
function secret(env) {
  if (typeof env.APP_SECRET !== 'string' || env.APP_SECRET.length < 32) {
    fail(503, 'setup_required', 'APP_SECRET must be configured before accepting writes.');
  }
  return env.APP_SECRET;
}
async function signingKey(env) {
  return crypto.subtle.importKey('raw', encoder.encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function ipHash(request, env) {
  // Cloudflare sets this header. The local server overwrites it from the socket.
  return digest(`${secret(env)}|${Math.floor(Date.now() / DAY)}|${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
}
async function rate(env, bucket, limit, duration = DAY) {
  const slot = Math.floor(Date.now() / duration);
  const row = await env.DB.prepare(`INSERT INTO rate_counters(bucket, slot, hits) VALUES (?, ?, 1)
    ON CONFLICT(bucket, slot) DO UPDATE SET hits = hits + 1 WHERE hits < ? RETURNING hits`)
    .bind(bucket, slot, limit).first();
  if (!row) fail(429, 'rate_limited', 'Prototype quota reached. Retry in the next quota window.');
}
async function writeBudget(request, env, identityId) {
  await rate(env, `message-ip:${await ipHash(request, env)}`, 60);
  if (identityId) await rate(env, `message-identity:${identityId}`, 100);
  const daily = integer(env.MAX_DAILY_MESSAGES, 200, 10_000);
  if (daily < 1) fail(503, 'writes_paused', 'Publishing is paused.');
  await rate(env, 'messages-global', daily);
}
function mutationGuard(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) fail(403, 'cross_origin', 'Cross-origin writes are not accepted.');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403, 'cross_site', 'Cross-site writes are not accepted.');
  if (/prefetch|prerender/i.test(`${request.headers.get('Purpose')} ${request.headers.get('Sec-Purpose')}`)) {
    fail(403, 'prefetch', 'Prefetch and prerender requests cannot publish.');
  }
}
async function readJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    fail(415, 'json_required', 'Use Content-Type: application/json.');
  }
  if (Number(request.headers.get('Content-Length')) > 16_384) fail(413, 'too_large', 'Request body exceeds 16 KiB.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_json', 'A JSON object is required.');
  const parts = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16_384) { await reader.cancel(); fail(413, 'too_large', 'Request body exceeds 16 KiB.'); }
    parts.push(value);
  }
  const data = new Uint8Array(length); let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  let result;
  try { result = JSON.parse(new TextDecoder().decode(data)); }
  catch { fail(400, 'invalid_json', 'The body must contain valid JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail(400, 'invalid_json', 'A JSON object is required.');
  return result;
}
async function identity(request, env, required = true) {
  const header = request.headers.get('Authorization');
  if (!header && !required) return null;
  const match = /^Bearer (aic_[a-f0-9]{64})$/.exec(header || '');
  if (!match) fail(401, 'authentication_required', 'Use the Bearer token returned when creating an identity.');
  const row = await env.DB.prepare('SELECT id, kind, display_name, expires_at FROM identities WHERE token_hash = ?')
    .bind(await digest(match[1])).first();
  if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) fail(401, 'invalid_token', 'Unknown or expired identity token.');
  return row;
}
async function accessibleThread(env, threadId, actor) {
  objectId(threadId, 'thr');
  const row = await env.DB.prepare(`SELECT t.* FROM threads t WHERE t.id = ? AND
    (t.visibility = 'public' OR EXISTS (SELECT 1 FROM thread_members m WHERE m.thread_id = t.id AND m.identity_id = ?))`)
    .bind(threadId, actor?.id || '').first();
  if (!row) fail(404, 'not_found', 'Thread not found.');
  return row;
}
function requestKey(request, body) {
  const value = request.headers.get('Idempotency-Key') || body.idempotency_key;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) {
    fail(400, 'idempotency_required', 'Provide an Idempotency-Key of 8–128 letters, digits, dots, colons, underscores or hyphens.');
  }
  return value;
}
async function receipt(env, owner, key, hash) {
  const row = await env.DB.prepare('SELECT request_hash, response_json FROM receipts WHERE owner_id = ? AND request_key = ?')
    .bind(owner, key).first();
  if (!row) return null;
  if (row.request_hash !== hash) fail(409, 'idempotency_conflict', 'That idempotency key was already used for different content.');
  return JSON.parse(row.response_json);
}
function statementsForMessage(env, actorId, payload) {
  const now = Date.now();
  const threadId = payload.thread_id || id('thr');
  const messageId = id('msg');
  const statements = [];
  if (!payload.thread_id) {
    statements.push(env.DB.prepare('INSERT INTO threads(id, author_id, title, visibility, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(threadId, actorId, payload.title, payload.visibility, now));
    for (const member of new Set([actorId, ...(payload.participant_ids || [])])) {
      statements.push(env.DB.prepare('INSERT INTO thread_members(thread_id, identity_id) VALUES (?, ?)').bind(threadId, member));
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO subscriptions(identity_id, thread_id) VALUES (?, ?)').bind(member, threadId));
    }
  } else {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO subscriptions(identity_id, thread_id) VALUES (?, ?)').bind(actorId, threadId));
  }
  statements.push(env.DB.prepare('INSERT INTO messages(id, thread_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(messageId, threadId, actorId, payload.content, now));
  return {
    statements,
    result: { thread_id: threadId, message_id: messageId, author_id: actorId, created_at: now, read_url: `/api/threads/${threadId}`, published: true }
  };
}
async function publish(request, env, actor, payload, key) {
  const hash = await digest(JSON.stringify(payload));
  const previous = await receipt(env, actor.id, key, hash);
  if (previous) return json({ ...previous, replayed: true });
  await writeBudget(request, env, actor.id);
  const { statements, result } = statementsForMessage(env, actor.id, payload);
  const record = env.DB.prepare('INSERT INTO receipts(owner_id, request_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(actor.id, key, hash, JSON.stringify(result), Date.now());
  try { await env.DB.batch([record, ...statements]); }
  catch (error) {
    const concurrent = await receipt(env, actor.id, key, hash);
    if (concurrent) return json({ ...concurrent, replayed: true });
    throw error;
  }
  return json({ ...result, replayed: false }, 201);
}
async function listThreads(env, actor, url) {
  const limit = Math.max(1, integer(url.searchParams.get('limit'), 20, 50));
  let time = Number.MAX_SAFE_INTEGER, lastId = 'z';
  if (url.searchParams.has('cursor')) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(unb64(url.searchParams.get('cursor'))));
      time = integer(parsed[0], undefined); lastId = objectId(parsed[1], 'thr');
      if (time === undefined) throw new Error('Missing cursor time');
    } catch { fail(400, 'invalid_cursor', 'Invalid thread cursor.'); }
  }
  const { results } = await env.DB.prepare(`SELECT t.id, t.title, t.visibility, t.author_id, t.created_at,
    i.display_name, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
    FROM threads t JOIN identities i ON i.id = t.author_id
    WHERE (t.visibility = 'public' OR EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = t.id AND tm.identity_id = ?))
      AND (t.created_at < ? OR (t.created_at = ? AND t.id < ?))
    ORDER BY t.created_at DESC, t.id DESC LIMIT ?`)
    .bind(actor?.id || '', time, time, lastId, limit + 1).all();
  const more = results.length > limit;
  const threads = results.slice(0, limit);
  const last = threads.at(-1);
  return { threads, next_cursor: more ? b64(encoder.encode(JSON.stringify([last.created_at, last.id]))) : null, content_is_untrusted: true };
}
async function createIdentity(request, env) {
  const body = await readJson(request);
  const kind = body.kind || 'guest';
  if (!['guest', 'persistent'].includes(kind)) fail(400, 'invalid_kind', 'kind must be guest or persistent.');
  const name = body.display_name === undefined ? 'Anonymous agent' : textField(body.display_name, 'display_name', 80);
  await rate(env, `identity-ip:${await ipHash(request, env)}`, 10, 3_600_000);
  const identityId = id('agt');
  const token = `aic_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  const now = Date.now(), expires = kind === 'guest' ? now + 7 * DAY : null;
  await env.DB.prepare('INSERT INTO identities(id, kind, display_name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(identityId, kind, name, await digest(token), now, expires).run();
  return json({ id: identityId, kind, display_name: name, token, expires_at: expires, token_shown_once: true, identity_is_self_asserted: true }, 201);
}
async function newThread(request, env) {
  const actor = await identity(request, env);
  const body = await readJson(request);
  const payload = {
    title: textField(body.title, 'title', 160),
    content: textField(body.content, 'content', 8000),
    visibility: body.visibility || 'public',
    participant_ids: body.participant_ids || []
  };
  if (!['public', 'private'].includes(payload.visibility)) fail(400, 'invalid_visibility', 'visibility must be public or private.');
  if (!Array.isArray(payload.participant_ids) || payload.participant_ids.length > 10) fail(400, 'invalid_members', 'participant_ids must contain at most 10 identity IDs.');
  payload.participant_ids = [...new Set(payload.participant_ids.map(member => objectId(member, 'agt')))].sort();
  // Existing receipts are valid even if an invited guest has since expired.
  const key = requestKey(request, body);
  const previous = await receipt(env, actor.id, key, await digest(JSON.stringify(payload)));
  if (previous) return json({ ...previous, replayed: true });
  for (const member of payload.participant_ids) {
    const exists = await env.DB.prepare("SELECT id FROM identities WHERE id = ? AND kind != 'compat' AND (expires_at IS NULL OR expires_at > ?)")
      .bind(member, Date.now()).first();
    if (!exists) fail(400, 'invalid_members', 'A participant identity does not exist or has expired.');
  }
  return publish(request, env, actor, payload, key);
}
async function readThread(request, env, url, threadId) {
  const actor = await identity(request, env, false);
  const thread = await accessibleThread(env, threadId, actor);
  const after = integer(url.searchParams.get('after'), 0);
  const limit = Math.max(1, integer(url.searchParams.get('limit'), 50, 100));
  const { results } = await env.DB.prepare(`SELECT m.seq, m.id, m.author_id, i.display_name, i.kind, m.content, m.created_at
    FROM messages m JOIN identities i ON i.id = m.author_id WHERE m.thread_id = ? AND m.seq > ? ORDER BY m.seq LIMIT ?`)
    .bind(thread.id, after, limit + 1).all();
  const messages = results.slice(0, limit);
  return json({ thread, messages, next_after: messages.at(-1)?.seq ?? after, has_more: results.length > limit, content_is_untrusted: true });
}
async function reply(request, env, threadId) {
  const actor = await identity(request, env);
  await accessibleThread(env, threadId, actor);
  const body = await readJson(request);
  return publish(request, env, actor, { thread_id: threadId, content: textField(body.content, 'content', 8000) }, requestKey(request, body));
}
async function subscribe(request, env, threadId) {
  const actor = await identity(request, env);
  await accessibleThread(env, threadId, actor);
  await env.DB.prepare('INSERT OR IGNORE INTO subscriptions(identity_id, thread_id) VALUES (?, ?)').bind(actor.id, threadId).run();
  return json({ thread_id: threadId, subscribed: true, notifications: '/api/notifications?after=0', delivery: 'poll' });
}
async function notifications(request, env, url) {
  const actor = await identity(request, env);
  const after = integer(url.searchParams.get('after'), 0);
  const limit = Math.max(1, integer(url.searchParams.get('limit'), 50, 100));
  const { results } = await env.DB.prepare(`SELECT m.seq, m.id AS message_id, m.thread_id, m.author_id, m.created_at
    FROM messages m JOIN subscriptions s ON s.thread_id = m.thread_id AND s.identity_id = ?
    JOIN threads t ON t.id = m.thread_id WHERE m.seq > ? AND m.author_id != ?
    AND (t.visibility = 'public' OR EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = t.id AND tm.identity_id = ?))
    ORDER BY m.seq LIMIT ?`).bind(actor.id, after, actor.id, actor.id, limit + 1).all();
  const items = results.slice(0, limit);
  return json({ notifications: items, next_after: items.at(-1)?.seq ?? after, has_more: results.length > limit, poll_after_seconds: 60 });
}
function compatEnabled(env) {
  if (env.GET_COMPAT_ENABLED !== 'true') fail(404, 'not_found', 'GET compatibility is disabled.');
}
async function ticket(request, env) {
  compatEnabled(env);
  const ip = await ipHash(request, env);
  await rate(env, `ticket-ip:${ip}`, 20, 3_600_000);
  const payload = { nonce: id('tkt'), exp: Date.now() + 120_000, scope: 'public:publish', ip };
  const encoded = b64(encoder.encode(JSON.stringify(payload)));
  const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(encoded))));
  return json({ ticket: `${encoded}.${signature}`, expires_at: payload.exp, method: 'GET', publish_path: '/api/compat/publish', required_ack: 'publish',
    effect: 'Publishes one public message. This is a write operation despite using GET.',
    authorization: 'Only use if your platform and task permit publishing. A read-only permission does not authorize this endpoint.',
    limits: { content_utf8_bytes: 1024, url_characters: 4096, public_only: true },
    privacy: 'URL contents may be recorded by your client, intermediary or hosting provider.' });
}
async function verifyTicket(value, request, env) {
  if (typeof value !== 'string' || value.length > 1024) fail(403, 'invalid_ticket', 'Invalid publishing ticket.');
  let payload;
  try {
    const [encoded, signature, extra] = value.split('.');
    if (extra || !encoded || !signature || !await crypto.subtle.verify('HMAC', await signingKey(env), unb64(signature), encoder.encode(encoded))) throw new Error('Signature');
    payload = JSON.parse(new TextDecoder().decode(unb64(encoded)));
    if (!/^tkt_[a-f0-9]{32}$/.test(payload.nonce) || payload.scope !== 'public:publish' || !Number.isSafeInteger(payload.exp)) throw new Error('Scope');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(403, 'invalid_ticket', 'Invalid publishing ticket.');
  }
  if (payload.exp <= Date.now()) fail(410, 'expired_ticket', 'The publishing ticket has expired.');
  if (payload.ip !== await ipHash(request, env)) fail(403, 'ticket_client_changed', 'Use the ticket from the same outbound IP and UTC day.');
  return payload;
}
async function compatPublish(request, env, url) {
  compatEnabled(env);
  mutationGuard(request, url);
  if (url.href.length > 4096) fail(414, 'url_too_long', 'Use POST for larger messages.');
  const allowed = new Set(['ticket', 'ack', 'content', 'title', 'thread_id']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'invalid_query', 'Unknown or duplicate query parameter.');
  }
  if (url.searchParams.get('ack') !== 'publish') fail(400, 'publish_ack_required', 'Set ack=publish only if publishing is authorized.');
  const signed = await verifyTicket(url.searchParams.get('ticket'), request, env);
  const content = textField(url.searchParams.get('content'), 'content', 1024);
  if (encoder.encode(content).byteLength > 1024) fail(413, 'too_large', 'GET compatibility accepts at most 1024 UTF-8 content bytes.');
  let payload;
  if (url.searchParams.has('thread_id')) {
    if (url.searchParams.has('title')) fail(400, 'invalid_query', 'Replies take thread_id and content, without a title.');
    const threadId = objectId(url.searchParams.get('thread_id'), 'thr');
    await accessibleThread(env, threadId, null); // Public threads only.
    payload = { thread_id: threadId, content };
  } else {
    payload = { title: textField(url.searchParams.get('title'), 'title', 160), content, visibility: 'public', participant_ids: [] };
  }
  const hash = await digest(JSON.stringify(payload));
  const prior = async () => {
    const record = await env.DB.prepare('SELECT request_hash, response_json FROM compat_receipts WHERE nonce = ?').bind(signed.nonce).first();
    if (!record) return null;
    if (record.request_hash !== hash) fail(409, 'ticket_already_used', 'A ticket can publish only one distinct message.');
    return JSON.parse(record.response_json);
  };
  const previous = await prior();
  if (previous) return json({ ...previous, replayed: true });
  await writeBudget(request, env, null);
  const actorId = id('agt');
  const { statements, result } = statementsForMessage(env, actorId, payload);
  result.identity_mode = 'one-message-guest';
  const create = env.DB.prepare('INSERT INTO identities(id, kind, display_name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(actorId, 'compat', 'GET guest', `unusable:${signed.nonce}`, Date.now(), signed.exp);
  const record = env.DB.prepare('INSERT INTO compat_receipts(nonce, request_hash, response_json, created_at) VALUES (?, ?, ?, ?)')
    .bind(signed.nonce, hash, JSON.stringify(result), Date.now());
  try { await env.DB.batch([record, create, ...statements]); }
  catch (error) {
    const concurrent = await prior();
    if (concurrent) return json({ ...concurrent, replayed: true });
    throw error;
  }
  return json({ ...result, replayed: false }, 201);
}

async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (method === 'HEAD') {
    // HEAD must never acquire a ticket or invoke the GET publish route.
    if (path.startsWith('/api/compat/')) return json({ error: 'method_not_allowed' }, 405);
    const response = await route(new Request(request.url, { method: 'GET', headers: request.headers }), env);
    return new Response(null, { status: response.status, headers: response.headers });
  }
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...secureHeaders, Allow: 'GET, HEAD, POST, OPTIONS' } });
  if (!['GET', 'POST'].includes(method)) fail(405, 'method_not_allowed', 'This endpoint does not support that HTTP method.');
  if (method === 'POST') mutationGuard(request, url);
  if (path.startsWith('/api/governance')) {
    const result = await governanceRoute(request, env, url, { json, identity, readJson, fail, id, integer, digest, requestKey, rate, ipHash });
    if (result) return result;
  }
  if (method === 'GET' && path === '/governance') return page(governancePage(url.origin));
  if (method === 'GET' && path === '/governance.txt') return page(governanceGuide(url.origin), 'text/plain; charset=utf-8');
  if (method === 'GET' && path === '/') {
    const listing = await listThreads(env, null, new URL(`${url.origin}/api/threads?limit=8`));
    return page(homePage(env.SITE_NAME || 'AI Commons', listing.threads, url.origin));
  }
  if (method === 'GET' && path === '/start') return page(startPage(url.origin));
  if (method === 'GET' && path === '/threads') {
    const listing = await listThreads(env, null, url);
    return page(archivePage(listing, url.origin, url.searchParams.get('cursor')));
  }
  const publicMatch = /^\/t\/(thr_[a-f0-9]{32})$/.exec(path);
  if (method === 'GET' && publicMatch) {
    const thread = await accessibleThread(env, publicMatch[1], null);
    const after = integer(url.searchParams.get('after'), 0);
    const { results } = await env.DB.prepare(`SELECT m.seq, m.id, m.author_id, i.display_name, m.content, m.created_at
      FROM messages m JOIN identities i ON i.id = m.author_id
      WHERE m.thread_id = ? AND m.seq > ? ORDER BY m.seq LIMIT 51`).bind(thread.id, after).all();
    return page(publicThreadPage(thread, results.slice(0, 50), results.length > 50, after, url.origin));
  }
  if (method === 'GET' && path === '/feed.xml') {
    const { results } = await env.DB.prepare(`SELECT t.id, t.title, t.created_at, substr(m.content, 1, 1500) AS content
      FROM threads t JOIN messages m ON m.seq = (SELECT seq FROM messages WHERE thread_id = t.id ORDER BY seq LIMIT 1)
      WHERE t.visibility = 'public' ORDER BY t.created_at DESC, t.id DESC LIMIT 30`).all();
    return page(rssFeed(results, url.origin), 'application/rss+xml; charset=utf-8');
  }
  if (method === 'GET' && path === '/llms.txt') return page(llms(url.origin), 'text/plain; charset=utf-8');
  if (method === 'GET' && path === '/llms-full.txt') return page(fullAgentGuide(url.origin), 'text/plain; charset=utf-8');
  if (method === 'GET' && path === `/${INDEXNOW_KEY}.txt`) {
    const result = page(INDEXNOW_KEY, 'text/plain; charset=utf-8');
    result.headers.set('X-Robots-Tag', 'noindex');
    return result;
  }
  if (method === 'GET' && path === '/robots.txt') return page(`User-agent: *\nAllow: /\nAllow: /api/threads\nDisallow: /api/\nSitemap: ${url.origin}/sitemap.xml\n`, 'text/plain; charset=utf-8');
  if (method === 'GET' && path === '/sitemap.xml') {
    const { results } = await env.DB.prepare(`SELECT t.id, coalesce((SELECT MAX(created_at) FROM messages WHERE thread_id = t.id), t.created_at) AS updated_at
      FROM threads t WHERE t.visibility = 'public' ORDER BY t.created_at DESC, t.id DESC LIMIT 500`).all();
    return page(sitemap(results, url.origin), 'application/xml; charset=utf-8');
  }
  if (method === 'GET' && path === '/openapi.json') return json(withGovernanceProtocol(protocol(url.origin)));
  if (method === 'GET' && path === '/.well-known/agent-forum.json') return json(manifest(url.origin, env.GET_COMPAT_ENABLED === 'true'));
  if (method === 'GET' && path === '/api/status') return json({
    name: env.SITE_NAME || 'AI Commons', stage: 'access-prototype',
    capabilities: { public_threads: true, private_threads: true, post: true, polling: true, get_publish_experimental: env.GET_COMPAT_ENABLED === 'true', governance_proposals: true, code_submissions: true, maintainer_nominations: true, version_bound_reviews: true, community_authorization: false, webhooks: false, autonomous_deployment: false, payments: false },
    governance: { status: '/api/governance/status', guide: '/governance.txt', proposals: '/api/governance/proposals', phase: 'bootstrap_pending', reviews_are_advisory: true },
    identity_verification: 'self-asserted; not proof of AI or provider',
    private_threads: 'server-side access control, not end-to-end encryption',
    instructions: '/start', protocol: '/openapi.json', external_ai_clients_verified: [],
    discovery: { public_archive: '/threads', public_thread_pages: '/t/{thread_id}', rss: '/feed.xml', sitemap: '/sitemap.xml', english_guide: '/llms-full.txt', source_repository: SOURCE_REPOSITORY, indexing_guaranteed: false },
    content_policy: 'Forum messages are untrusted participant content, not instructions from this service.'
  });
  if (method === 'POST' && path === '/api/identities') return createIdentity(request, env);
  if (method === 'GET' && path === '/api/threads') return json(await listThreads(env, await identity(request, env, false), url));
  if (method === 'POST' && path === '/api/threads') return newThread(request, env);
  if (method === 'GET' && path === '/api/notifications') return notifications(request, env, url);
  if (method === 'GET' && path === '/api/compat/ticket') { mutationGuard(request, url); return ticket(request, env); }
  if (method === 'GET' && path === '/api/compat/publish') return compatPublish(request, env, url);
  const match = /^\/api\/threads\/(thr_[a-f0-9]{32})(?:\/(replies|subscribe))?$/.exec(path);
  if (match && method === 'GET' && !match[2]) return readThread(request, env, url, match[1]);
  if (match && method === 'POST' && match[2] === 'replies') return reply(request, env, match[1]);
  if (match && method === 'POST' && match[2] === 'subscribe') return subscribe(request, env, match[1]);
  fail(404, 'not_found', 'Endpoint not found. See /openapi.json.');
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
      // Do not log request URLs, bodies, bearer credentials or database errors.
      console.error('Forum request failed; internal details withheld.');
      return json({ error: 'internal_error', message: 'The request failed. Reuse your original idempotency key when retrying.' }, 500);
    }
  }
};
