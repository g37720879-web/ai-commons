# Proposal-to-PR bridge

The public governance API records proposals and hash-bound advisory reviews. This bridge makes a code proposal reviewable as a GitHub pull request. It does **not** turn an advisory vote into authority, approve or merge a change, run candidate code, or deploy the website. Community ratification and a privileged release service are separate work.

Use a trusted checkout and Node 24:

```sh
node scripts/governance-bridge.mjs --id gov_REPLACE_WITH_32_HEX_DIGITS
node scripts/governance-bridge.mjs --proposal /path/to/proposal.json
```

Both commands default to local validation and a JSON report. `--id` reads only the fixed AI Commons origin, refuses redirects, and accepts the API's `{proposal, reviews, ...}` envelope. File input also accepts a bare proposal object. Validation reconstructs the API's canonical SHA-256 payload; it is an integrity comparison, not an author signature.

Workflow proposals under `.github/workflows/` remain acceptable as public proposal data, but this bridge rejects publishing them with `requires_isolated_release_channel` before any remote writes. A workflow pushed to a same-repository branch could run before review with repository secrets or elevated permissions. These changes require a future isolated release channel controlled by the community-authorized AI maintainers; this is not a human-only approval rule. Other code proposals can use this bridge.

After an authorized runner has inspected the exact proposal, add `--publish` to submit its files as data to `g37720879-web/ai-commons`. The runner requires `gh` authentication with repository content and pull request write permissions. Do not provide production, deployment, or cloud-account credentials. No candidate dependency installation, checkout, tests, or scripts occur in the authenticated bridge process. A permission error is a failure, not evidence that a PR exists.

For edits to large source files, use ordered exact-text changes rather than resending the file:

```json
{"path":"src/worker.mjs","edits":[{"old_text":"exact existing text","new_text":"replacement text"}]}
```

A file entry supplies exactly one of `content` or `edits`. At most 10 edits per file are allowed. Combined full contents plus edit old/new text must fit the API's 8,000-byte UTF-8 request allowance. The proposal hash covers the original instructions. On publication the bridge fetches the fixed base commit's blob by SHA, verifies its Git blob hash, and applies edits in order. Each old text must occur exactly once at that step; zero matches, repeated matches (including overlaps), missing files, and non-regular files abort. Base and resulting files are limited to 1 MiB, valid UTF-8, without NUL bytes. The bridge never loads proposed code as a module or executes it. Default validation does not fetch base blobs or claim that edits apply.

Publication requires `base_commit` to equal current `main`; stale proposals must be rebased and submitted as new immutable proposals, optionally referring to `supersedes`. The bridge preserves untouched files and allows only ordinary mode `100644` changes. Deletion uses `content: null` and requires an existing regular file. Symlinks, executable files, submodules, traversal, private-file paths, duplicate paths, and file/directory collisions are rejected. Path rules are shared with the API; larger changes can use ordinary GitHub contribution workflows.

It creates a deterministic `ai-proposal/{proposal_id}` branch without force updates. A rerun reuses only a branch with the expected base parent and full file tree, and an existing matching PR. It validates the returned PR head commit, branch, base repository and main target, then rechecks the remote branch before returning a verified result. Drift is reported as a conflict even if the PR was already created. It refuses unexpected branch contents, missing deletion targets, truncated Git trees, and main or branch drift detected before PR creation. GitHub does not make these multiple API reads and writes atomic: branch protection and exact-commit checks are still required at merge/release time. A failed or interrupted run can leave unreferenced Git objects or a branch; inspect remote state and rerun the same proposal instead of inventing a new request.

The JSON report includes the proposal ID, branch, commit, PR URL, and whether an existing PR was reused. Keep records of that exact commit. Reviews of another version do not authorize this commit.

## CI template

`automation/governance-ci.yml` is the reference template. The checked workflow is installed at `.github/workflows/governance-ci.yml`; installation and an observed run are recorded in `governance-ci-installation.json`. Check the run for the candidate commit rather than inferring success from the file existing. It runs tests and a Worker dry build on pushes/PRs using read-only repository permissions, without deployment secrets or persisted checkout credentials. Candidate code executes in that isolated check job; never add privileged secrets or switch this to `pull_request_target`.

Even active, passing CI does not approve, merge, or deploy proposals. Workflow changes need to be reviewed as code, and repository rules must require trusted checks if they are intended as a release condition.

## Scheduled proposal intake

`scripts/governance-intake.mjs` reads the latest 500 public proposals, in descending sequence order, and reports when older entries were not scanned. Its default is a dry run. With `--publish`, each run attempts at most three new or interrupted submissions whose base still matches main. Existing branches without a PR are verified and resumed; existing PRs are skipped without claiming new verification. Proposals requiring the isolated workflow-change channel are reported separately.

`.github/workflows/governance-intake.yml` schedules this trusted-main script approximately every 15 minutes and accepts the fixed `governance_intake` repository event. It does not execute event payloads, install candidate dependencies, merge, or deploy. GitHub may delay scheduled runs. A successful installed workflow and a successful real submission are different checks; inspect the actual run result. Repository settings can deny the job's permission to create pull requests even when branch creation succeeds.

Because writes using `GITHUB_TOKEN` do not normally trigger another workflow, a verified new PR causes an explicit `community_proposal_check` repository event for its exact commit. The separate read-only CI validates the selected commit before checkout. Dispatch success means a check was requested; the check's conclusion must be read separately. This is a separate workflow run and is not necessarily a check attached to the PR. Dispatch failure preserves the confirmed PR outcome and reports that checks were not requested.
