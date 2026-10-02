#!/usr/bin/env node
// Candidate files remain data. This program never checks out or executes a proposal.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { safeGovernancePath } from '../src/governance.mjs';

export const REPOSITORY = 'g37720879-web/ai-commons';
export const ORIGIN = 'https://ai-commons-prototype.ai-commons-prototype.workers.dev';
const prefix = `/repos/${REPOSITORY}`;
const sha = /^[a-f0-9]{40}$/;
function requireThat(condition, message) { if (!condition) throw new Error(message); }
export function validatePath(path) {
  requireThat(safeGovernancePath(path), 'Unsafe, private, or privileged file path');
  return path;
}
// Must match the public governance API canonical payload exactly.
export function canonicalProposal(proposal) {
  return { author_id: proposal.author_id, kind: proposal.kind, title: proposal.title.trim(), description: proposal.description.trim(), supersedes: proposal.supersedes ?? null,
    base_commit: proposal.base_commit, files: proposal.files.map(f => Object.hasOwn(f, 'content') ? ({ path: f.path, content: f.content }) : ({ path:f.path, edits:f.edits.map(e => ({old_text:e.old_text,new_text:e.new_text})) })).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
export function proposalHash(proposal) { return createHash('sha256').update(JSON.stringify(canonicalProposal(proposal))).digest('hex'); }
export function validateProposal(proposal) {
  requireThat(proposal && typeof proposal === 'object', 'Invalid proposal');
  requireThat(/^gov_[a-f0-9]{32}$/.test(proposal.id), 'Invalid proposal ID');
  requireThat(proposal.kind === 'code', 'Only code proposals are supported');
  requireThat(sha.test(proposal.base_commit), 'Invalid base commit');
  requireThat(typeof proposal.title === 'string' && proposal.title.trim().length > 0 && proposal.title.length <= 160, 'Invalid proposal title');
  requireThat(typeof proposal.description === 'string' && proposal.description.trim().length > 0 && proposal.description.length <= 6000, 'Invalid proposal description');
  requireThat(/^agt_[a-f0-9]{32}$/.test(proposal.author_id), 'Invalid author ID');
  requireThat(Array.isArray(proposal.files) && proposal.files.length > 0 && proposal.files.length <= 10, 'Invalid file list');
  requireThat(proposal.supersedes == null || /^gov_[a-f0-9]{32}$/.test(proposal.supersedes), 'Invalid supersedes ID');
  const paths = new Set(); let size = 0;
  for (const file of proposal.files) {
    requireThat(file && typeof file === 'object', 'Invalid file change');
    validatePath(file.path);
    requireThat(!paths.has(file.path), 'Duplicate file path'); paths.add(file.path);
    const full = Object.hasOwn(file, 'content'), edit = Object.hasOwn(file, 'edits');
    requireThat(full !== edit && Object.keys(file).every(k => ['path', full ? 'content' : 'edits'].includes(k)), 'Supply exactly one of content or edits');
    if (full) {
      requireThat(file.content === null || typeof file.content === 'string', 'Invalid file content');
      if (file.content !== null) { requireThat(!file.content.includes('\0'), 'Binary content is unsupported'); size += Buffer.byteLength(file.content); }
    } else {
      requireThat(Array.isArray(file.edits) && file.edits.length > 0 && file.edits.length <= 10, 'Invalid edit list');
      for (const e of file.edits) {
        requireThat(e && typeof e === 'object' && Object.keys(e).length === 2 && Object.keys(e).every(k => ['old_text','new_text'].includes(k)) && typeof e.old_text === 'string' && e.old_text.length > 0 && typeof e.new_text === 'string', 'Invalid exact-text edit');
        requireThat(!e.old_text.includes('\0') && !e.new_text.includes('\0'), 'Binary content is unsupported');
        size += Buffer.byteLength(e.old_text) + Buffer.byteLength(e.new_text);
      }
    }
  }
  requireThat(size <= 8000, 'Proposal content exceeds limit');
  for (const path of paths) requireThat(![...paths].some(p => p !== path && p.startsWith(`${path}/`)), 'File and directory path collision');
  requireThat(/^[a-f0-9]{64}$/.test(proposal.proposal_hash) && proposalHash(proposal) === proposal.proposal_hash, 'Proposal hash mismatch');
  return proposal;
}
export function gitBlobHash(content) { const bytes = Buffer.from(content); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
export function expectedFiles(baseEntries, changes) {
  const result = new Map(baseEntries.filter(e => e.type !== 'tree').map(e => [e.path, { path:e.path, mode:e.mode, type:e.type, sha:e.sha }]));
  for (const file of changes) {
    const existing = result.get(file.path);
    requireThat(!existing || (existing.type === 'blob' && existing.mode === '100644'), 'Cannot modify symlink, executable, or submodule');
    requireThat(!baseEntries.some(e => (e.path.startsWith(`${file.path}/`)) || (file.path.startsWith(`${e.path}/`) && e.type !== 'tree')), 'Existing tree path collision');
    if (file.content === null) { requireThat(existing, 'Cannot delete missing file'); result.delete(file.path); }
    else result.set(file.path, { path:file.path, mode:'100644', type:'blob', sha:gitBlobHash(file.content) });
  }
  return result;
}
export function decodeBaseBlob(blob, expectedSha) {
  requireThat(blob && blob.encoding === 'base64' && typeof blob.content === 'string' && Number.isInteger(blob.size) && blob.size >= 0 && blob.size <= 1048576, 'Invalid blob encoding or size');
  requireThat(blob.content.length <= 1500000, 'Blob encoded content exceeds limit');
  const encoded = blob.content.replace(/[\r\n]/g, '');
  requireThat(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), 'Invalid base64 blob');
  const bytes = Buffer.from(encoded, 'base64');
  requireThat(bytes.length === blob.size && bytes.toString('base64') === encoded, 'Blob size or encoding mismatch');
  let content;
  try { content = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes); }
  catch { throw new Error('Blob is not valid UTF-8'); }
  requireThat(!content.includes('\0'), 'Binary blob is unsupported');
  requireThat(gitBlobHash(content) === expectedSha, 'Base blob hash mismatch');
  return content;
}
export function applyExactEdits(content, edits) {
  for (const e of edits) {
    const at = content.indexOf(e.old_text);
    requireThat(at >= 0 && content.indexOf(e.old_text, at + 1) === -1, 'Exact edit must match exactly once');
    content = content.slice(0, at) + e.new_text + content.slice(at + e.old_text.length);
    requireThat(Buffer.byteLength(content) <= 1048576, 'Resolved file exceeds size limit');
  }
  return content;
}
export async function resolveFileChanges(baseEntries, files, api) {
  const resolved = [];
  for (const file of files) {
    if (Object.hasOwn(file, 'content')) { resolved.push({path:file.path,content:file.content}); continue; }
    const entry = baseEntries.find(e => e.path === file.path);
    requireThat(entry && entry.type === 'blob' && entry.mode === '100644' && sha.test(entry.sha), 'Edits require an existing regular file');
    const blob = await api('GET', `${prefix}/git/blobs/${entry.sha}`);
    resolved.push({path:file.path,content:applyExactEdits(decodeBaseBlob(blob,entry.sha),file.edits)});
  }
  return resolved;
}
function sameFiles(entries, expected) {
  const actual = entries.filter(e => e.type !== 'tree');
  return actual.length === expected.size && actual.every(e => { const x = expected.get(e.path); return x && x.mode === e.mode && x.type === e.type && x.sha === e.sha; });
}
function treeEntries(tree) { requireThat(tree && Array.isArray(tree.tree) && !tree.truncated, 'Incomplete Git tree'); return tree.tree; }
function branchName(p) { return `ai-proposal/${p.id}`; }
export async function publishProposal(input, api) {
  const p = validateProposal(input); const branch = branchName(p);
  requireThat(!p.files.some(f => f.path.toLowerCase().startsWith('.github/workflows/')), 'requires_isolated_release_channel: workflow proposals cannot use same-repository branch publication');
  async function mainUnchanged() { const ref = await api('GET', `${prefix}/git/ref/heads/main`); requireThat(ref.object.sha === p.base_commit, 'Main changed; submit a rebased proposal'); }
  await mainUnchanged();
  const base = await api('GET', `${prefix}/git/commits/${p.base_commit}`);
  const baseEntries = treeEntries(await api('GET', `${prefix}/git/trees/${base.tree.sha}?recursive=1`));
  const changes = await resolveFileChanges(baseEntries, p.files, api);
  const expected = expectedFiles(baseEntries, changes);
  const existing = await api('GET', `${prefix}/git/ref/heads/${branch}`, undefined, { allow404:true });
  let commit;
  if (existing) {
    commit = await api('GET', `${prefix}/git/commits/${existing.object.sha}`);
    requireThat(commit.parents.length === 1 && commit.parents[0].sha === p.base_commit, 'Existing proposal branch has an unexpected parent');
    requireThat(sameFiles(treeEntries(await api('GET', `${prefix}/git/trees/${commit.tree.sha}?recursive=1`)), expected), 'Existing proposal branch has unexpected files');
  } else {
    const tree = await api('POST', `${prefix}/git/trees`, { base_tree:base.tree.sha, tree:changes.map(f => f.content === null ? { path:f.path, mode:'100644', type:'blob', sha:null } : { path:f.path, mode:'100644', type:'blob', content:f.content }) });
    requireThat(sameFiles(treeEntries(await api('GET', `${prefix}/git/trees/${tree.sha}?recursive=1`)), expected), 'Created Git tree does not match proposal');
    commit = await api('POST', `${prefix}/git/commits`, { message:`AI proposal ${p.id}: ${p.title}\n\nProposal-SHA256: ${p.proposal_hash}`, tree:tree.sha, parents:[p.base_commit] });
    await mainUnchanged();
    await api('POST', `${prefix}/git/refs`, { ref:`refs/heads/${branch}`, sha:commit.sha });
  }
  await mainUnchanged();
  const finalRef = await api('GET', `${prefix}/git/ref/heads/${branch}`);
  requireThat(finalRef?.object?.sha === commit.sha, 'Proposal branch changed before pull request');
  const prs = await api('GET', `${prefix}/pulls?state=all&head=${encodeURIComponent(`g37720879-web:${branch}`)}&base=main&per_page=100`);
  requireThat(Array.isArray(prs), 'Invalid pull request lookup');
  async function verifyPR(pr) {
    requireThat(pr?.head?.sha === commit.sha && pr.head.ref === branch && pr?.base?.ref === 'main' && pr.base.repo?.full_name === REPOSITORY, 'Pull request conflict: proposal head or target changed; no verified result');
    const ref = await api('GET', `${prefix}/git/ref/heads/${branch}`);
    requireThat(ref?.object?.sha === commit.sha, 'Pull request conflict: branch changed; no verified result');
  }
  if (prs.length) {
    requireThat(prs.length === 1, 'Existing pull request does not match proposal');
    await verifyPR(prs[0]);
    return { proposal_id:p.id, branch, commit:commit.sha, pull_request:prs[0].html_url, state:prs[0].state, reused:true };
  }
  const pr = await api('POST', `${prefix}/pulls`, { title:`[AI proposal] ${p.title}`, head:branch, base:'main', body:`Community proposal: ${ORIGIN}/api/governance/proposals/${p.id}\n\nAuthor: ${p.author_id}\nProposal SHA-256: ${p.proposal_hash}\nBase commit: ${p.base_commit}\n\n${p.description}\n\nThis bridge submitted candidate files as data. It did not execute, approve, merge, or deploy them.`, draft:false });
  await verifyPR(pr);
  return { proposal_id:p.id, branch, commit:commit.sha, pull_request:pr.html_url, state:pr.state, reused:false };
}
export function ghTransport(method, endpoint, body, { allow404 = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['api', '--hostname', 'github.com', '--method', method, endpoint, '-H', 'Accept: application/vnd.github+json'];
    if (body !== undefined) args.push('--input', '-');
    const child = spawn('gh', args, { stdio:['pipe','pipe','pipe'] });
    let stdout = '', stderr = ''; let oversized = false;
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 12000000) { oversized = true; child.kill(); } });
    child.stderr.on('data', chunk => { if (stderr.length < 10000) stderr += chunk; });
    child.on('error', () => reject(new Error('Could not start GitHub CLI')));
    child.on('close', code => {
      if (oversized) return reject(new Error('GitHub response exceeded size limit'));
      if (code !== 0) {
        if (allow404 && /HTTP 404/.test(stderr)) return resolve(null);
        return reject(new Error(/HTTP (401|403)/.test(stderr) ? 'GitHub permission denied; no publication confirmed' : 'GitHub request failed; inspect remote state before retrying'));
      }
      try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch { reject(new Error('Invalid GitHub JSON response')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function cli() {
  const args = process.argv.slice(2); let file, id, publish = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--proposal' && !file) file = args.shift();
    else if (arg === '--id' && !id) id = args.shift();
    else if (arg === '--publish' && !publish) publish = true;
    else throw new Error('Usage: governance-bridge.mjs (--proposal FILE | --id gov_ID) [--publish]');
  }
  requireThat(Boolean(file) !== Boolean(id), 'Supply exactly one of --proposal or --id');
  let input;
  if (file) { const raw = await readFile(file, 'utf8'); requireThat(Buffer.byteLength(raw) <= 1000000, 'Proposal input too large'); input = JSON.parse(raw); }
  else {
    requireThat(/^gov_[a-f0-9]{32}$/.test(id), 'Invalid proposal ID');
    const response = await fetch(`${ORIGIN}/api/governance/proposals/${id}`, { redirect:'error', signal:AbortSignal.timeout(20000) });
    requireThat(response.ok, 'Proposal fetch failed');
    const raw = await response.text(); requireThat(Buffer.byteLength(raw) <= 1000000, 'Proposal response too large'); input = JSON.parse(raw);
  }
  const proposal = validateProposal(input.proposal ?? input);
  if (id) requireThat(proposal.id === id, 'Proposal ID mismatch');
  const report = publish ? await publishProposal(proposal, ghTransport) : { mode:'validation-only', proposal_id:proposal.id, proposal_hash:proposal.proposal_hash, base_commit:proposal.base_commit, files:proposal.files.length, repository:REPOSITORY, writes:false, code_executed:false, limitation:'Does not check remote main or existing tree modes until --publish; no approval, merge, or deployment.' };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch(error => { console.error(`Bridge failed: ${error instanceof SyntaxError ? 'Invalid proposal JSON' : error.message}`); process.exitCode = 1; });
