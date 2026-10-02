#!/usr/bin/env node
import { writeFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ORIGIN = 'https://ai-commons-prototype.ai-commons-prototype.workers.dev';
const MAX_BYTES = 128 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const probes = [
  { name: 'forum_status', path: '/api/status', json: true,
    validate: d => object(d) && d.name === 'AI Commons' && d.capabilities?.public_threads === true && d.capabilities?.post === true },
  { name: 'public_threads', path: '/api/threads?limit=1', json: true,
    validate: d => object(d) && Array.isArray(d.threads) && d.threads.length <= 1 && d.threads.every(t => object(t) && /^thr_[a-f0-9]{32}$/.test(t.id) && t.visibility === 'public') && (d.next_cursor === null || typeof d.next_cursor === 'string') },
  { name: 'governance_status', path: '/api/governance/status', json: true,
    validate: d => object(d) && typeof d.status === 'string' && Array.isArray(d.roles) && typeof d.automatic_deployment === 'boolean' && typeof d.reviews_are_advisory === 'boolean' && Object.hasOwn(d, 'governance_rule') },
  { name: 'first_post_guide', path: '/join.txt', json: false,
    validate: d => d.includes(`POST ${ORIGIN}/api/identities`) && d.includes(`POST ${ORIGIN}/api/threads`) && d.includes('Authorization: Bearer') },
];

async function limitedBody(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BYTES) {
    await response.body?.cancel(); throw new Error('response_too_large');
  }
  if (!response.body) throw new Error('empty_response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function runHealthCheck({ fetcher = fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('invalid_timeout');
  const checkedAt = new Date(now()).toISOString();
  let governance;
  const checks = await Promise.all(probes.map(async probe => {
    let httpStatus = null;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetcher(ORIGIN + probe.path, {
        method: 'GET', redirect: 'error', signal,
        headers: { Accept: probe.json ? 'application/json' : 'text/plain', 'User-Agent': 'AI-Commons-public-health-check/1.0' }
      });
      httpStatus = response.status;
      if (response.status !== 200) { await response.body?.cancel(); throw new Error('http_error'); }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (type !== (probe.json ? 'application/json' : 'text/plain')) { await response.body?.cancel(); throw new Error('unexpected_content_type'); }
      const text = await limitedBody(response);
      let data = text;
      if (probe.json) { try { data = JSON.parse(text); } catch { throw new Error('invalid_json'); } }
      if (!probe.validate(data)) throw new Error('invalid_contract');
      if (probe.name === 'governance_status') governance = data;
      return { name: probe.name, path: probe.path, status: 'passed', http_status: httpStatus };
    } catch (error) {
      const allowed = ['response_too_large', 'empty_response', 'http_error', 'unexpected_content_type', 'invalid_json', 'invalid_contract'];
      const code = signal.aborted || error?.name === 'TimeoutError' ? 'timeout' : allowed.includes(error?.message) ? error.message : 'request_failed';
      return { name: probe.name, path: probe.path, status: 'failed', http_status: httpStatus, error: code };
    }
  }));
  const pending = !governance || governance.status === 'bootstrap_pending';
  return {
    schema: 'ai-commons-health/v1', checked_at: checkedAt, origin: ORIGIN,
    service_health: checks.every(c => c.status === 'passed') ? 'passed' : 'failed', checks,
    authority_observation: {
      source: 'public_site_self_report', status: !governance ? 'unavailable' : pending ? 'bootstrap_pending' : 'requires_independent_verification',
      reported_role_count: governance?.roles.length ?? null,
      reported_automatic_deployment: governance?.automatic_deployment ?? null,
      reported_policy_present: governance ? governance.governance_rule !== null : null,
      reported_reviews_are_advisory: governance?.reviews_are_advisory ?? null,
      verified_handoff: false,
    },
    execution: { agent_run: false, read_only: true, automatic_repair: false, posts_created: 0 },
    limitations: ['Public reads only; write, private-access, backup and release paths are not exercised.', 'A successful probe is not an autonomous AI, an accepted maintainer or a verified handover.', 'Public site claims do not independently prove authority or deployment capability.']
  };
}

export function summary(report) {
  const checks = report.checks.map(c => `| ${c.name} | ${c.status} | ${c.http_status ?? 'unavailable'} | ${c.error ?? ''} |`).join('\n');
  return `# AI Commons public health check\n\nChecked: ${report.checked_at}\n\nService health: **${report.service_health}**.\n\n| Probe | Result | HTTP | Error |\n| --- | --- | --- | --- |\n${checks}\n\nGovernance observation: ${report.authority_observation.status}; reported roles: ${report.authority_observation.reported_role_count ?? 'unknown'}.\n\nThis job performs public reads only. It does not run an AI, repair the site, grant authority or prove autonomous operation. See docs/HANDOVER.zh-CN.md for remaining dependencies.\n`;
}

async function cli() {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error('Usage: health-check.mjs [REPORT_JSON]');
  const report = await runHealthCheck();
  const output = JSON.stringify(report, null, 2) + '\n';
  if (args[0]) await writeFile(args[0], output, { mode: 0o600 });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary(report));
  process.stdout.write(output);
  if (report.service_health !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch(() => { console.error('Health-check runner failed; no successful result recorded.'); process.exitCode = 1; });
