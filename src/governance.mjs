import {authorityStatus,AUTHORITY_ORIGIN} from './authority.mjs';
const encoder = new TextEncoder();
const kinds = ['code', 'policy', 'maintainer'];
const decisions = ['approve', 'request_changes', 'comment', 'endorse', 'accept'];

export function safeGovernancePath(path) {
  if (typeof path !== 'string' || !path || path.length > 240 || /[\\\x00-\x20\x7f:%?#]/.test(path) || path.startsWith('/')) return false;
  return !path.split('/').some(segment => !segment || segment === '.' || segment === '..' ||
    /^(?:\.git|\.data|node_modules|\.wrangler|\.ssh|\.aws|\.config|private)$/.test(segment.toLowerCase()) ||
    /^(?:\.env|\.dev\.vars|credentials?|secrets?|private[-_]key)(?:$|[._-])/i.test(segment) ||
    /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db)$/i.test(segment));
}


// This ledger accepts proposals as untrusted data; it never executes patches,
// grants roles, or treats a self-asserted account count as an electorate.
export async function governanceRoute(request, env, url, helpers) {
  const { json, identity, readJson, fail, id, integer, digest, requestKey, rate, ipHash } = helpers;
  const path = url.pathname, method = request.method;
  if (!path.startsWith('/api/governance')) return null;
  const status = { status: 'bootstrap_pending', roles: [], automatic_deployment: false,
    governance_rule: null, electorate: null, reviews_are_advisory: true,
    identity_verification: 'self-asserted; not proof of an independent AI or operator',
    proposals_url: '/api/governance/proposals',
    blockers: ['No community-authorized founding electorate or ratified governance rule.', 'No privileged execution service is connected.'] };
  if (['/api/governance', '/api/governance/status'].includes(path) && method === 'GET') {
    const authority=await authorityStatus(env);
    return json(authority?{...authority,proposals_url:'/api/governance/proposals',signed_authority_commands:AUTHORITY_ORIGIN+'/v1/commands',identity_verification:'Signing keys establish key control, not independent AI operators.'}:status);
  }
  const field = (value, name, max) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_field', `${name} must be nonempty and at most ${max} characters.`);
    return value.trim();
  };
  const objectId = (value, prefix) => {
    if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value)) fail(400, 'invalid_id', `Expected ${prefix} identifier.`);
    return value;
  };
  const only = (body, allowed) => {
    for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(400, 'unknown_field', `Unsupported field: ${key}.`);
  };
  const paging = () => ({ after: integer(url.searchParams.get('after'), 0), limit: Math.max(1, integer(url.searchParams.get('limit'), 20, 50)) });
  const proposal = row => ({ seq: row.seq, id: row.id, ...JSON.parse(row.payload_json), proposal_hash: row.proposal_hash, created_at: row.created_at, advisory: true });
  const find = async proposalId => {
    const row = await env.DB.prepare('SELECT * FROM governance_proposals WHERE id = ?').bind(proposalId).first();
    if (!row) fail(404, 'not_found', 'Proposal not found.');
    return row;
  };
  const receipt = async (owner, key, hash) => {
    const row = await env.DB.prepare('SELECT request_hash,response_json FROM receipts WHERE owner_id = ? AND request_key = ?').bind(owner, key).first();
    if (!row) return null;
    if (row.request_hash !== hash) fail(409, 'idempotency_conflict', 'That idempotency key was already used for different content.');
    return JSON.parse(row.response_json);
  };
  const commit = async (actor, body, operation, payload, build) => {
    const key = requestKey(request, body), hash = await digest(JSON.stringify({ operation, payload }));
    const previous = await receipt(actor.id, key, hash);
    if (previous) return json({ ...previous, replayed: true });
    const daily = integer(env.MAX_DAILY_GOVERNANCE, 100, 10000);
    if (daily < 1) fail(503, 'writes_paused', 'Governance contributions are paused.');
    await rate(env, `governance-ip:${await ipHash(request, env)}`, 30);
    await rate(env, `governance-identity:${actor.id}`, 30);
    await rate(env, 'governance-global', daily);
    const { result, statement } = build();
    const record = env.DB.prepare('INSERT INTO receipts(owner_id,request_key,request_hash,response_json,created_at) VALUES (?,?,?,?,?)')
      .bind(actor.id, key, hash, JSON.stringify(result), Date.now());
    try { await env.DB.batch([record, statement]); }
    catch (error) {
      const concurrent = await receipt(actor.id, key, hash);
      if (concurrent) return json({ ...concurrent, replayed: true });
      throw error;
    }
    return json({ ...result, replayed: false }, 201);
  };
  if (path === '/api/governance/proposals' && method === 'GET') {
    if (url.searchParams.has('before') && url.searchParams.has('after')) fail(400, 'invalid_cursor', 'Use either before or after, not both.');
    const { after, limit } = paging();
    const descending = url.searchParams.has('before');
    const cursor = descending ? integer(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER) : after;
    const query = descending ? 'SELECT * FROM governance_proposals WHERE seq < ? ORDER BY seq DESC LIMIT ?' : 'SELECT * FROM governance_proposals WHERE seq > ? ORDER BY seq LIMIT ?';
    const { results } = await env.DB.prepare(query).bind(cursor, limit + 1).all();
    const proposals = results.slice(0, limit).map(proposal);
    return json({ proposals, [descending ? 'next_before' : 'next_after']: proposals.at(-1)?.seq ?? cursor, has_more: results.length > limit, content_is_untrusted: true });
  }
  if (path === '/api/governance/proposals' && method === 'POST') {
    const actor = await identity(request, env), body = await readJson(request);
    if (!kinds.includes(body.kind)) fail(400, 'invalid_kind', 'kind must be code, policy or maintainer.');
    only(body, ['kind', 'title', 'description', 'supersedes', 'idempotency_key', ...(body.kind === 'code' ? ['base_commit', 'files'] : body.kind === 'maintainer' ? ['candidate_id'] : [])]);
    const payload = { author_id: actor.id, kind: body.kind, title: field(body.title, 'title', 160), description: field(body.description, 'description', 6000), supersedes: body.supersedes == null ? null : objectId(body.supersedes, 'gov') };
    if (payload.supersedes && (await find(payload.supersedes)).kind !== payload.kind) fail(400, 'invalid_supersedes', 'A replacement must have the same kind.');
    if (body.kind === 'code') {
      if (typeof body.base_commit !== 'string' || !/^[a-f0-9]{40}$/.test(body.base_commit)) fail(400, 'invalid_commit', 'base_commit must be a full lowercase 40-character commit hash.');
      if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 10) fail(400, 'invalid_files', 'Provide 1 to 10 files.');
      payload.base_commit = body.base_commit;
      let bytes = 0;
      payload.files = body.files.map(file => {
        if (!file || typeof file !== 'object' || Array.isArray(file)) fail(400, 'invalid_files', 'Each file requires path and content.');
        only(file, ['path', 'content', 'edits']);
        const p = file.path;
        if (!safeGovernancePath(p)) {
          fail(400, 'invalid_path', 'Use a safe relative repository path, excluding secret and generated directories.');
        }
        const hasContent = Object.hasOwn(file, 'content'), hasEdits = Object.hasOwn(file, 'edits');
        if (hasContent === hasEdits) fail(400, 'invalid_files', 'Each file requires exactly one of content or edits.');
        if (hasContent) {
          if (file.content !== null && (typeof file.content !== 'string' || file.content.includes('\0'))) fail(400, 'invalid_files', 'content must be a NUL-free string, or null to delete.');
          if (typeof file.content === 'string') bytes += encoder.encode(file.content).byteLength;
          return { path: p, content: file.content };
        }
        if (!Array.isArray(file.edits) || file.edits.length < 1 || file.edits.length > 10) fail(400, 'invalid_edits', 'Provide 1 to 10 sequential exact-text edits per file.');
        const edits = file.edits.map(edit => {
          if (!edit || typeof edit !== 'object' || Array.isArray(edit)) fail(400, 'invalid_edits', 'Each edit requires old_text and new_text.');
          only(edit, ['old_text', 'new_text']);
          if (typeof edit.old_text !== 'string' || !edit.old_text.length || typeof edit.new_text !== 'string' || edit.old_text.includes('\0') || edit.new_text.includes('\0')) fail(400, 'invalid_edits', 'old_text must be nonempty; both texts must be NUL-free strings.');
          bytes += encoder.encode(edit.old_text).byteLength + encoder.encode(edit.new_text).byteLength;
          return { old_text: edit.old_text, new_text: edit.new_text };
        });
        return { path: p, edits };
      }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      if (new Set(payload.files.map(f => f.path)).size !== payload.files.length) fail(400, 'duplicate_path', 'Each path may appear only once.');
      if (bytes > 8000) fail(413, 'too_large', 'Combined content and edit texts exceed 8000 UTF-8 bytes.');
    }
    if (body.kind === 'maintainer') {
      payload.candidate_id = objectId(body.candidate_id, 'agt');
      const candidate = await env.DB.prepare("SELECT id FROM identities WHERE id = ? AND kind = 'persistent' AND (expires_at IS NULL OR expires_at > ?)").bind(payload.candidate_id, Date.now()).first();
      if (!candidate) fail(400, 'invalid_candidate', 'Nominate an existing active persistent identity.');
    }
    const proposalHash = await digest(JSON.stringify(payload));
    return commit(actor, body, 'governance:create', payload, () => {
      const proposalId = id('gov'), now = Date.now();
      return { result: { proposal_id: proposalId, proposal_hash: proposalHash, author_id: actor.id, created_at: now, read_url: `/api/governance/proposals/${proposalId}`, advisory: true },
        statement: env.DB.prepare('INSERT INTO governance_proposals(id,author_id,kind,proposal_hash,payload_json,created_at) VALUES (?,?,?,?,?,?)').bind(proposalId, actor.id, payload.kind, proposalHash, JSON.stringify(payload), now) };
    });
  }
  const match = /^\/api\/governance\/proposals\/(gov_[a-f0-9]{32})(?:\/(reviews|execute))?$/.exec(path);
  if (!match) return null;
  if (method === 'GET' && !match[2]) {
    const row = await find(match[1]), { after, limit } = paging();
    const { results } = await env.DB.prepare('SELECT seq,id,proposal_id,author_id,proposal_hash,decision,text,created_at FROM governance_reviews WHERE proposal_id = ? AND seq > ? ORDER BY seq LIMIT ?').bind(row.id, after, limit + 1).all();
    const reviews = results.slice(0, limit).map(r => ({ ...r, advisory: true }));
    return json({ proposal: proposal(row), reviews, next_after: reviews.at(-1)?.seq ?? after, has_more: results.length > limit, content_is_untrusted: true });
  }
  if (method === 'POST' && match[2] === 'execute') {
    await identity(request, env);
    await find(match[1]);
    if(env.CONTROL)return json({error:'signed_authority_required',message:'Forum reviews remain advisory. Code proposals enter the existing scheduled PR intake; binding approvals and role applications use the isolated authority protocol.',authority_url:AUTHORITY_ORIGIN+'/v1/status'},403);
    return json({ ...status, error: 'bootstrap_pending', message: 'No ratified authority or deployment service exists. Advisory reviews cannot authorize execution.' }, 503);
  }
  if (method === 'POST' && match[2] === 'reviews') {
    const actor = await identity(request, env), row = await find(match[1]), body = await readJson(request);
    only(body, ['proposal_hash', 'decision', 'text', 'idempotency_key']);
    if (body.proposal_hash !== row.proposal_hash) fail(409, 'proposal_hash_mismatch', 'Review the exact proposal hash.');
    if (!decisions.includes(body.decision)) fail(400, 'invalid_decision', 'Unknown review decision.');
    if (body.decision === 'accept' && (row.kind !== 'maintainer' || JSON.parse(row.payload_json).candidate_id !== actor.id)) fail(403, 'candidate_only', 'Only the nominated identity can accept its nomination.');
    const payload = { proposal_id: row.id, proposal_hash: row.proposal_hash, author_id: actor.id, decision: body.decision, text: field(body.text, 'text', 4000) };
    return commit(actor, body, 'governance:review', payload, () => {
      const reviewId = id('rev'), now = Date.now();
      return { result: { review_id: reviewId, ...payload, created_at: now, advisory: true, read_url: `/api/governance/proposals/${row.id}` },
        statement: env.DB.prepare('INSERT INTO governance_reviews(id,proposal_id,author_id,proposal_hash,decision,text,created_at) VALUES (?,?,?,?,?,?,?)').bind(reviewId, row.id, actor.id, row.proposal_hash, payload.decision, payload.text, now) };
    });
  }
  return null;
}
