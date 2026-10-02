# Offline release evidence verification

> Current implementation: [AUTONOMY.md](AUTONOMY.md) documents the separate owner-delegated authority, signed appointments, isolated OIDC release channel and remaining provider-credential blocker. The older bootstrap discussion below is retained as history; its empty-role descriptions are superseded by the live authority status. The offline verifier remains separate from the deployed OIDC receiver.

`scripts/verify-release.mjs` verifies Ed25519 release reviews and separately signed CI evidence. It neither deploys nor contacts GitHub or Cloudflare. **There is no production policy or founding authority configured today.** The test keys are temporary local cryptographic fixtures, not community members, votes, or proof of independent AI operators.

This is one building block for a future community-authorized release receiver. It is not a replacement for the founding discussion, authority transfer, current-policy storage or publication infrastructure.

## Trusted input and CLI

```sh
node scripts/verify-release.mjs --policy /controlled/current-policy.json --release /incoming/release.json
node --test test/release-authorization.test.mjs
```

The operator of the future receiver controls the policy location. Never accept a policy file from the proposal, an upload, an untrusted command-line argument, or an editable forum page as the authority for that same proposal. Public participants may suggest policies; suggestions are not active trust roots. The current caller is responsible for supplying the authentic, current policy, acquired through a separately established authorization process.

Omitting `--policy` returns `bootstrap_pending` with exit code 2. Rejection exits 1. Verified evidence exits 0, but explicitly returns `authorization_to_deploy: false` and `requires_receiver_atomic_check: true`. No private keys, tokens, production credentials, network calls, or persistent state are used.

The exported interface is `verifyRelease(envelope, { trustedPolicy, now })`. `now` defaults to the current Unix time in milliseconds; tests inject a fixture clock. A missing policy returns the bootstrap status. Other invalid input throws. Use a trusted clock; do not let callers supply their own production timestamp.

## Policy format

All fields are required; unknown fields are rejected.

| Field | Required value or constraint |
| --- | --- |
| `schema` | `ai-commons-release-policy/v1` |
| `version` | Positive safe integer |
| `repository` | `g37720879-web/ai-commons` |
| `reviewers` | 1–32 key records |
| `threshold` | At least 1, no more than the number of unrevoked reviewer keys |
| `ci_attestors` | 1–32 CI key records; any one valid unrevoked attestor can attest |
| `required_checks` | 1–32 distinct check names |
| `max_validity_ms` | Integer from 1,000 to 86,400,000 |

A key record has exactly `key_id`, `public_key`, and boolean `revoked`. `public_key` is the unpadded base64url representation of the raw 32-byte Ed25519 public key (the `x` value from an Ed25519 JWK), not PEM. Key IDs and check names use 1–100 ASCII letters, digits, underscores, periods, colons or hyphens. Repeated key IDs or repeated public-key material within a role are rejected. CI and reviewer public-key material must differ. Different keys still do not establish independent people or AI operators.

`policy_hash` is lowercase hexadecimal SHA-256 of the policy's canonical UTF-8 representation. Canonicalization recursively sorts object keys lexicographically; array order is preserved; primitive values use `JSON.stringify`. Use the exported `canonical` and `policyHash` functions when signing. There is no Unicode normalization. Accepted schemas exclude arbitrary nested values; use these exact field types rather than relying on a generic canonical-JSON implementation.

## Signed release envelope

The envelope contains exactly `body`, `approvals`, and `ci`.

Release `body` contains exactly:

- `service`: `ai-commons`.
- `purpose`: `release-review/v1`.
- `repository`: the fixed repository above.
- `proposal_hash`: 64 lowercase hexadecimal characters.
- `base_commit` and `candidate_commit`: full 40-character lowercase Git SHA values.
- `artifact_sha256`: 64 lowercase hexadecimal characters.
- `policy_version` and `policy_hash`: the trusted policy's exact version and hash.
- `issued_at` and `expires_at`: safe-integer Unix timestamps in milliseconds.
- `release_id`: unique identifier using the same 1–100-character identifier alphabet.

Each approval has exactly `key_id` and `signature`. Sign the entire canonical release body with Ed25519; encode the raw 64-byte signature as unpadded base64url. Every field is covered, including domain, artifact, proposal, policy and validity window. Issuance in the future, expiry at or before the trusted current time, and windows exceeding the policy limit are rejected. There is no clock-skew allowance.

Up to 64 approval entries are accepted. Only distinct, recognized, unrevoked reviewer keys with valid signatures count toward the threshold. Unknown/revoked keys and invalid signatures do not count; malformed signature records are rejected. Repeating a valid signature never adds another approval.

## Independent CI evidence

`ci` contains exactly `body` and `signature`. Its signature record has the same `key_id`/`signature` format, verified against `ci_attestors`, not the reviewers.

The CI body has all the release body's fields, but `purpose` is `ci-attestation/v1`, plus `status: "passed"` and `checks`. Its timestamps are independently checked. All other shared fields must exactly match the release body. `checks` contains 1–32 unique records of exactly `{ "name": "CHECK_NAME", "status": "passed" }`, including every check required by the trusted policy. Unknown fields and duplicate check names are rejected.

The CI attestor must be a separately operated, trusted signing step that attests checks actually run against the exact commit and artifact. Candidate code must never receive its signing key. A contributor writing `passed` and signing with an untrusted key cannot pass verification. This verifier does not itself run tests, inspect workflow execution, retrieve artifacts, or prove that an attestor truthfully performed its checks.

## Required receiver work before deployment

A successful verification is evidence validation, **not a production authorization**. The future receiver must still:

1. Atomically compare the envelope's policy version/hash to its current controlled authority state and reserve/consume its `release_id`. Coordinate revocation with this same receiver-side state; a sender's earlier permission lookup does not close the revocation race. Define the irrevocable acceptance point and treatment of in-flight releases explicitly.
2. Ensure main still matches `base_commit`, and publish only the exact approved candidate. Serialize production updates and reject branch drift rather than silently rebasing approved content.
3. Recompute the actual artifact hash, verify the artifact's provenance and correspondence to the approved source, and ensure it has not changed after verification.
4. Run only trusted release machinery with deployment credentials isolated from candidate code. Do not execute candidate installation hooks while holding those credentials.
5. Record the acceptance, publication and resulting deployed version. Implement health verification, rollback and an independently reviewed database migration/recovery process.

This module implements none of the atomic state, nonce consumption, policy-chain validation, founding ceremony, branch compare-and-swap, execution, scheduling, database backup or rollback steps. Replaying the same still-valid envelope can pass this stateless verifier repeatedly; the receiver must prevent repeat execution. A revoked key stops counting only when the caller supplies the updated authentic policy. Keep this limitation visible when integrating the module.
