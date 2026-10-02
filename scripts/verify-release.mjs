#!/usr/bin/env node
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'g37720879-web/ai-commons';
const SERVICE = 'ai-commons';
const hex = (n) => new RegExp(`^[a-f0-9]{${n}}$`);
function requireThat(value, message) { if (!value) throw new Error(message); }
function exact(value, fields, label) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  requireThat(Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k)), `Unknown or missing ${label} field`);
}
function identifier(value) { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value); }
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export function policyHash(policy) { return createHash('sha256').update(canonical(policy)).digest('hex'); }
function decode(value, length, label) {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), `Invalid ${label}`);
  const bytes = Buffer.from(value, 'base64url');
  requireThat(bytes.length === length && bytes.toString('base64url') === value, `Invalid ${label}`);
  return bytes;
}
function keys(list, label) {
  requireThat(Array.isArray(list) && list.length >= 1 && list.length <= 32, `Invalid ${label}`);
  const ids = new Set(), material = new Set(), result = new Map();
  for (const key of list) {
    exact(key, ['key_id', 'public_key', 'revoked'], 'key');
    requireThat(identifier(key.key_id) && typeof key.revoked === 'boolean', 'Invalid key identity');
    const raw = decode(key.public_key, 32, 'Ed25519 public key');
    requireThat(!ids.has(key.key_id) && !material.has(key.public_key), 'Duplicate policy key');
    ids.add(key.key_id); material.add(key.public_key);
    result.set(key.key_id, { ...key, key: createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' }) });
  }
  return result;
}
function validSignature(entry, body, trustedKeys) {
  exact(entry, ['key_id', 'signature'], 'signature');
  requireThat(identifier(entry.key_id), 'Invalid signature key ID');
  const signature = decode(entry.signature, 64, 'signature');
  const key = trustedKeys.get(entry.key_id);
  return Boolean(key && !key.revoked && verify(null, Buffer.from(canonical(body)), key.key, signature));
}
function window(body, now, maxAge) {
  requireThat(Number.isSafeInteger(body.issued_at) && Number.isSafeInteger(body.expires_at), 'Invalid timestamps');
  requireThat(body.issued_at >= 0 && body.issued_at <= now, 'Future issuance');
  requireThat(body.expires_at > now && body.expires_at > body.issued_at && body.expires_at - body.issued_at <= maxAge, 'Expired or invalid validity window');
}

// trustedPolicy is a separate caller-controlled trust root, never envelope data.
export function verifyRelease(envelope, { trustedPolicy, now = Date.now() } = {}) {
  if (!trustedPolicy) return { status: 'bootstrap_pending', authorization_to_deploy: false, requires_receiver_atomic_check: true };
  requireThat(Number.isSafeInteger(now) && now >= 0, 'Invalid clock');
  exact(trustedPolicy, ['schema', 'version', 'repository', 'reviewers', 'threshold', 'ci_attestors', 'required_checks', 'max_validity_ms'], 'policy');
  requireThat(trustedPolicy.schema === 'ai-commons-release-policy/v1' && Number.isSafeInteger(trustedPolicy.version) && trustedPolicy.version >= 1, 'Invalid policy version');
  requireThat(trustedPolicy.repository === REPOSITORY, 'Wrong policy repository');
  requireThat(Number.isSafeInteger(trustedPolicy.max_validity_ms) && trustedPolicy.max_validity_ms >= 1000 && trustedPolicy.max_validity_ms <= 86400000, 'Invalid policy validity limit');
  const reviewers = keys(trustedPolicy.reviewers, 'reviewers'), attestors = keys(trustedPolicy.ci_attestors, 'CI attestors');
  const reviewerMaterial = new Set(trustedPolicy.reviewers.map(k => k.public_key));
  requireThat(trustedPolicy.ci_attestors.every(k => !reviewerMaterial.has(k.public_key)), 'CI and reviewer keys must be separate');
  requireThat(Number.isSafeInteger(trustedPolicy.threshold) && trustedPolicy.threshold >= 1 && trustedPolicy.threshold <= [...reviewers.values()].filter(k => !k.revoked).length, 'Invalid review threshold');
  requireThat(Array.isArray(trustedPolicy.required_checks) && trustedPolicy.required_checks.length >= 1 && trustedPolicy.required_checks.length <= 32 && trustedPolicy.required_checks.every(identifier) && new Set(trustedPolicy.required_checks).size === trustedPolicy.required_checks.length, 'Invalid required checks');
  exact(envelope, ['body', 'approvals', 'ci'], 'release envelope');
  const body = envelope.body;
  exact(body, ['service', 'purpose', 'repository', 'proposal_hash', 'base_commit', 'candidate_commit', 'artifact_sha256', 'policy_version', 'policy_hash', 'issued_at', 'expires_at', 'release_id'], 'release body');
  requireThat(body.service === SERVICE && body.purpose === 'release-review/v1' && body.repository === REPOSITORY, 'Wrong release domain');
  requireThat(hex(64).test(body.proposal_hash) && hex(64).test(body.artifact_sha256) && hex(40).test(body.base_commit) && hex(40).test(body.candidate_commit), 'Invalid release hash');
  requireThat(identifier(body.release_id), 'Invalid release ID');
  requireThat(body.policy_version === trustedPolicy.version && body.policy_hash === policyHash(trustedPolicy), 'Wrong policy binding');
  window(body, now, trustedPolicy.max_validity_ms);
  requireThat(Array.isArray(envelope.approvals) && envelope.approvals.length <= 64, 'Invalid approval list');
  const accepted = new Set();
  for (const approval of envelope.approvals) if (validSignature(approval, body, reviewers)) accepted.add(approval.key_id);
  requireThat(accepted.size >= trustedPolicy.threshold, 'Insufficient trusted reviewer signatures');
  exact(envelope.ci, ['body', 'signature'], 'CI attestation');
  const ci = envelope.ci.body;
  exact(ci, ['service', 'purpose', 'repository', 'release_id', 'proposal_hash', 'base_commit', 'candidate_commit', 'artifact_sha256', 'policy_version', 'policy_hash', 'issued_at', 'expires_at', 'status', 'checks'], 'CI body');
  requireThat(ci.service === SERVICE && ci.purpose === 'ci-attestation/v1' && ci.status === 'passed', 'Invalid CI domain or status');
  for (const key of ['repository', 'release_id', 'proposal_hash', 'base_commit', 'candidate_commit', 'artifact_sha256', 'policy_version', 'policy_hash']) requireThat(ci[key] === body[key], `CI ${key} mismatch`);
  window(ci, now, trustedPolicy.max_validity_ms);
  requireThat(Array.isArray(ci.checks) && ci.checks.length >= 1 && ci.checks.length <= 32, 'Invalid CI checks');
  const checked = new Set();
  for (const check of ci.checks) {
    exact(check, ['name', 'status'], 'CI check');
    requireThat(identifier(check.name) && check.status === 'passed' && !checked.has(check.name), 'Invalid or duplicate CI check');
    checked.add(check.name);
  }
  requireThat(trustedPolicy.required_checks.every(name => checked.has(name)), 'Missing required CI check');
  requireThat(validSignature(envelope.ci.signature, ci, attestors), 'Untrusted CI signature');
  return { status: 'evidence_verified', release_id: body.release_id, candidate_commit: body.candidate_commit, artifact_sha256: body.artifact_sha256, policy_version: body.policy_version, policy_hash: body.policy_hash, reviewers: [...accepted].sort(), authorization_to_deploy: false, requires_receiver_atomic_check: true };
}
async function readJson(path) { const raw = await readFile(path, 'utf8'); requireThat(Buffer.byteLength(raw) <= 262144, 'Input exceeds 256 KiB'); return JSON.parse(raw); }
async function cli() {
  const args = process.argv.slice(2); let policy, release;
  while (args.length) { const arg = args.shift(); if (arg === '--policy' && !policy) policy = args.shift(); else if (arg === '--release' && !release) release = args.shift(); else throw new Error('Usage: verify-release.mjs --policy TRUSTED_POLICY --release RELEASE'); }
  if (!policy) { console.log(JSON.stringify(verifyRelease(null), null, 2)); process.exitCode = 2; return; }
  requireThat(release, 'Release file required');
  console.log(JSON.stringify(verifyRelease(await readJson(release), { trustedPolicy: await readJson(policy) }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch(() => { console.error('Release verification failed; no deployment authorized.'); process.exitCode = 1; });
