import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical, policyHash, verifyRelease, REPOSITORY } from '../scripts/verify-release.mjs';

// Local cryptographic fixtures, not independent AI identities or community votes.
function fixture() {
  const all = ['reviewer-1', 'reviewer-2', 'ci', 'outsider'].map(key_id => {
    const pair = generateKeyPairSync('ed25519');
    return { key_id, ...pair, public_key: pair.publicKey.export({ format: 'jwk' }).x, revoked: false };
  });
  const key = (i) => ({ key_id: all[i].key_id, public_key: all[i].public_key, revoked: false });
  const policy = { schema: 'ai-commons-release-policy/v1', version: 1, repository: REPOSITORY, reviewers: [key(0), key(1)], threshold: 2, ci_attestors: [key(2)], required_checks: ['unit-tests', 'worker-build'], max_validity_ms: 60000 };
  const now = 100000;
  const body = { service: 'ai-commons', purpose: 'release-review/v1', repository: REPOSITORY, proposal_hash: 'a'.repeat(64), base_commit: 'b'.repeat(40), candidate_commit: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64), policy_version: 1, policy_hash: policyHash(policy), issued_at: now - 1000, expires_at: now + 10000, release_id: 'local-fixture-1' };
  const signature = (body, i) => ({ key_id: all[i].key_id, signature: sign(null, Buffer.from(canonical(body)), all[i].privateKey).toString('base64url') });
  const ciBody = { ...body, purpose: 'ci-attestation/v1', status: 'passed', checks: [{ name: 'unit-tests', status: 'passed' }, { name: 'worker-build', status: 'passed' }] };
  const envelope = { body, approvals: [signature(body, 0), signature(body, 1)], ci: { body: ciBody, signature: signature(ciBody, 2) } };
  return { policy, now, envelope, signature, all, run: () => verifyRelease(envelope, { trustedPolicy: policy, now }) };
}
test('missing controlled policy is bootstrap_pending and never grants deployment', () => {
  assert.deepEqual(verifyRelease({ trustedPolicy: {} }), { status: 'bootstrap_pending', authorization_to_deploy: false, requires_receiver_atomic_check: true });
});
test('local signed evidence validates without granting deployment permission', () => {
  const result = fixture().run(); assert.equal(result.status, 'evidence_verified'); assert.equal(result.authorization_to_deploy, false); assert.equal(result.requires_receiver_atomic_check, true);
});
test('release tamper invalidates signatures', () => { const f = fixture(); f.envelope.body.artifact_sha256 = 'e'.repeat(64); assert.throws(f.run, /reviewer signatures/); });
test('duplicate signer does not meet threshold', () => { const f = fixture(); f.envelope.approvals = [f.envelope.approvals[0], f.envelope.approvals[0]]; assert.throws(f.run, /reviewer signatures/); });
test('unknown signer does not meet threshold', () => { const f = fixture(); f.envelope.approvals[1] = f.signature(f.envelope.body, 3); assert.throws(f.run, /reviewer signatures/); });
test('revoked signer does not count', () => {
  const f = fixture(); f.policy.reviewers[1].revoked = true; f.policy.threshold = 1; f.envelope.body.policy_hash = policyHash(f.policy); f.envelope.approvals = [f.signature(f.envelope.body, 1)]; assert.throws(f.run, /reviewer signatures/);
});
test('wrong controlled policy or version is rejected', () => {
  let f = fixture(); f.policy.version = 2; assert.throws(f.run, /policy binding/);
  f = fixture(); f.policy.required_checks.push('integration'); assert.throws(f.run, /policy binding/);
});
test('CI signature cannot certify a different commit or artifact', () => {
  for (const [key, value] of [['candidate_commit', 'e'.repeat(40)], ['artifact_sha256', 'e'.repeat(64)]]) {
    const f = fixture(); f.envelope.ci.body[key] = value; f.envelope.ci.signature = f.signature(f.envelope.ci.body, 2); assert.throws(f.run, /mismatch/);
  }
});
test('expired and future release and CI windows are rejected', () => {
  for (const target of ['release', 'ci']) for (const which of ['expired', 'future']) {
    const f = fixture(), body = target === 'release' ? f.envelope.body : f.envelope.ci.body;
    if (which === 'expired') body.expires_at = f.now; else body.issued_at = f.now + 1;
    if (target === 'release') f.envelope.approvals = [f.signature(body, 0), f.signature(body, 1)]; else f.envelope.ci.signature = f.signature(body, 2);
    assert.throws(f.run, /Expired|Future/);
  }
});
test('candidate self-signed CI is untrusted', () => { const f = fixture(); f.envelope.ci.signature = f.signature(f.envelope.ci.body, 3); assert.throws(f.run, /Untrusted CI/); });
test('signed CI must contain required checks and all must pass', () => {
  const f = fixture(); f.envelope.ci.body.checks.pop(); f.envelope.ci.signature = f.signature(f.envelope.ci.body, 2); assert.throws(f.run, /Missing required/);
  const g = fixture(); g.envelope.ci.body.checks[0].status = 'failed'; g.envelope.ci.signature = g.signature(g.envelope.ci.body, 2); assert.throws(g.run, /Invalid or duplicate/);
});
test('unknown fields and duplicated key material are rejected', () => {
  const f = fixture(); f.envelope.body.approved = true; assert.throws(f.run, /Unknown/);
  const g = fixture(); g.policy.reviewers[1].public_key = g.policy.reviewers[0].public_key; assert.throws(g.run, /Duplicate policy key/);
});
test('CI reviewer key reuse and incorrect domains are rejected', () => {
  const f = fixture(); f.policy.ci_attestors[0].public_key = f.policy.reviewers[0].public_key; assert.throws(f.run, /must be separate/);
  const g = fixture(); g.envelope.body.purpose = 'unrelated'; assert.throws(g.run, /domain/);
});
