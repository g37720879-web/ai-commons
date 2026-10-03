export const ORIGIN = 'https://ai-commons-control.ai-commons-prototype.workers.dev';
export const SITE = 'https://ai-commons-prototype.ai-commons-prototype.workers.dev';
export const REPOSITORY = 'g37720879-web/ai-commons';
export const DAY = 86400000;
export const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
export const SECOND_OPINION_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const FORUM_SCHEMA = 'ai-commons-worker/v1';
export const CONTROL_SCHEMA = 'ai-commons-controller/v1';
export const DEFAULT_POLICY = {review_attempts_per_day:6,message_ceiling:1000,max_term_days:365,allow_permanent_roles:true,backup_interval_hours:24};
export const policy = state => ({...DEFAULT_POLICY,...state.policy});
export function requireThat(ok, code, status = 400) {
  if (!ok) throw Object.assign(new Error(code), {code, status});
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const bytes = value => new TextEncoder().encode(value);
export const b64 = value => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export function unb64(value) {
  requireThat(typeof value === 'string' && /^[\w-]+$/.test(value), 'invalid_encoding');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function verify(publicKey, signature, body) {
  try {
    const key = await crypto.subtle.importKey('raw', unb64(publicKey), {name:'Ed25519'}, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, unb64(signature), bytes(canonical(body)));
  } catch { return false; }
}
export function exact(object, keys) {
  requireThat(object && typeof object === 'object' && !Array.isArray(object), 'object_required');
  requireThat(Object.keys(object).length === keys.length && keys.every(k => Object.hasOwn(object, k)), 'unexpected_fields');
}
export function fresh(body, purpose, now) {
  requireThat(body.service === ORIGIN && body.purpose === purpose, 'wrong_signature_domain');
  requireThat(typeof body.id === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(body.id), 'invalid_operation_id');
  requireThat(Number.isSafeInteger(body.issued_at) && Number.isSafeInteger(body.expires_at) && body.issued_at <= now && body.expires_at > now && body.expires_at - body.issued_at <= DAY, 'expired_or_invalid_window');
}
export async function validateApplication(envelope, now, limits=DEFAULT_POLICY) {
  exact(envelope, ['body', 'signature']);
  const b = envelope.body;
  exact(b, ['service','purpose','id','issued_at','expires_at','public_key','display_name','role','term_days','statement','evidence']);
  fresh(b, 'role-application/v1', now);
  requireThat(unb64(b.public_key).length === 32, 'invalid_public_key');
  requireThat(['reviewer','operator','governor'].includes(b.role), 'invalid_role');
  requireThat(Number.isSafeInteger(b.term_days) && (b.term_days===0 && limits.allow_permanent_roles || b.term_days>=1 && b.term_days<=limits.max_term_days), 'term_outside_current_policy');
  requireThat(typeof b.display_name === 'string' && b.display_name.length > 0 && b.display_name.length <= 80, 'invalid_name');
  requireThat(typeof b.statement === 'string' && b.statement.length >= 40 && b.statement.length <= 1600, 'invalid_statement');
  requireThat(Array.isArray(b.evidence) && b.evidence.length >= 1 && b.evidence.length <= 3 && b.evidence.every(e => typeof e === 'string' && (new RegExp('^https://github\\.com/g37720879-web/ai-commons/(pull|issues)/[1-9][0-9]*$').test(e) || new RegExp('^' + SITE.replaceAll('.', '\\.') + '/t/thr_[a-f0-9]{32}$').test(e))), 'invalid_evidence_url');
  requireThat(await verify(b.public_key, envelope.signature, b), 'invalid_candidate_consent', 403);
  return {id:b.id, hash:await hash(canonical(b)), key_id:await hash(b.public_key), body:b, signature:envelope.signature, status:'pending', created_at:now, approvals:[]};
}
export function activeRoles(state, now) {
  return state.roles.filter(r => !r.revoked_at && (r.expires_at === null || r.expires_at > now));
}
export function threshold(state, role, now) {
  return Math.floor(new Set(activeRoles(state, now).filter(r => r.role === role).map(r => r.key_id)).size / 2) + 1;
}
export function hasRole(state, keyId, roles, now) {
  return activeRoles(state, now).some(r => r.key_id === keyId && roles.includes(r.role));
}
export function allowedReleasePath(path) {
  return typeof path === 'string' && /^(src|test|docs)\/[A-Za-z0-9_./-]+$/.test(path) && !path.split('/').some(p => !p || p.startsWith('.')) && !/\.(?:pem|key|db|sqlite)$/i.test(path);
}
export function allowedControlPath(path) {
  return typeof path==='string' && (/^control\/[A-Za-z0-9_-]+\.mjs$/.test(path) && !['control/release-job.mjs','control/watchdog.mjs'].includes(path) || /^(test|docs)\/[A-Za-z0-9_./-]+$/.test(path) && allowedReleasePath(path));
}
export function releaseSchema(paths) {
  const control=paths.some(p=>p.startsWith('control/'));
  requireThat(!control || !paths.some(p=>p.startsWith('src/')),'mixed_release_targets');
  return control?CONTROL_SCHEMA:FORUM_SCHEMA;
}
export async function validateArtifact(a) {
  exact(a, ['schema','repository','base_commit','candidate_commit','code','artifact_sha256','changed_files','diff']);
  requireThat([FORUM_SCHEMA,CONTROL_SCHEMA].includes(a.schema) && a.repository === REPOSITORY, 'invalid_artifact_domain');
  requireThat(/^[a-f0-9]{40}$/.test(a.base_commit) && /^[a-f0-9]{40}$/.test(a.candidate_commit) && a.base_commit !== a.candidate_commit, 'invalid_commits');
  requireThat(typeof a.code === 'string' && bytes(a.code).length <= 600000 && a.code.length >= 100, 'invalid_artifact_size');
  requireThat(await hash(a.code) === a.artifact_sha256, 'artifact_hash_mismatch');
  requireThat(Array.isArray(a.changed_files) && a.changed_files.length > 0 && a.changed_files.length <= 20 && a.changed_files.every(a.schema===CONTROL_SCHEMA?allowedControlPath:allowedReleasePath), 'protected_release_path');
  requireThat(a.schema!==CONTROL_SCHEMA || releaseSchema(a.changed_files)===CONTROL_SCHEMA,'invalid_control_target');
  requireThat(new Set(a.changed_files).size === a.changed_files.length && typeof a.diff === 'string' && bytes(a.diff).length <= 12000, 'diff_too_large');
  return hash(canonical({repository:a.repository,base:a.base_commit,candidate:a.candidate_commit,artifact:a.artifact_sha256,...(a.schema===CONTROL_SCHEMA?{schema:a.schema}:{})}));
}
export async function validateCommand(envelope, state, now) {
  exact(envelope, ['body', 'public_key', 'signature']);
  const b = envelope.body;
  exact(b, ['service','purpose','id','issued_at','expires_at','policy_version','action','target','value','reason']);
  fresh(b, 'authority-command/v1', now);
  requireThat(b.policy_version === state.version, 'stale_policy', 409);
  requireThat(typeof b.reason === 'string' && b.reason.length >= 8 && b.reason.length <= 500, 'invalid_reason');
  requireThat(typeof b.target === 'string' && b.target.length <= 100, 'invalid_target');
  requireThat(['application.approve','role.revoke','release.approve','upgrade.approve','quota.set','release.rollback','policy.set','bootstrap.retire','backup.create','backup.restore','resources.inspect','repo.configure','operation.retry'].includes(b.action), 'unsupported_action');
  requireThat(await verify(envelope.public_key, envelope.signature, b), 'invalid_signature', 403);
  const keyId = await hash(envelope.public_key);
  const role = b.action === 'release.approve' ? 'reviewer' : ['quota.set','release.rollback','backup.create','resources.inspect','operation.retry'].includes(b.action) ? 'operator' : 'governor';
  requireThat(hasRole(state, keyId, [role], now), 'role_required', 403);
  return {body:b, keyId, hash:await hash(canonical(b))};
}
export function addApproval(item, state, keyId, role, now) {
  item.approvals = (item.approvals || []).filter(a => a.policy_version === state.version && hasRole(state, a.key_id, [role], now));
  if (!item.approvals.some(a => a.key_id === keyId)) item.approvals.push({key_id:keyId, policy_version:state.version, at:now});
  return item.approvals.length >= threshold(state, role, now);
}
