#!/usr/bin/env node
// Trusted main-branch scheduler: treats public proposal text solely as data.
import { pathToFileURL } from 'node:url';
import { ORIGIN, REPOSITORY, ghTransport, publishProposal, validateProposal } from './governance-bridge.mjs';
const prefix = `/repos/${REPOSITORY}`;
const idPattern = /^gov_[a-f0-9]{32}$/;
function check(ok, message) { if (!ok) throw new Error(message); }
function errorCode(error) {
  const message = String(error?.message ?? '');
  if (/permission denied/i.test(message)) return 'github_permission_denied_check_actions_pr_creation_setting';
  if (/Main changed/.test(message)) return 'main_changed';
  if (/requires_isolated_release_channel/.test(message)) return 'requires_isolated_release_channel';
  if (/conflict|unexpected|changed/.test(message)) return 'remote_conflict';
  return 'failed_no_publication_confirmed';
}
export async function readProposals(fetcher = fetch) {
  const proposals = [], seen = new Set(); let before = Number.MAX_SAFE_INTEGER, truncated = false;
  for (let page = 0; page < 10; page++) {
    const response = await fetcher(`${ORIGIN}/api/governance/proposals?before=${before}&limit=50`, {redirect:'error',signal:AbortSignal.timeout(20000)});
    check(response.ok, 'proposal_feed_unavailable');
    const raw = await response.text(); check(Buffer.byteLength(raw) <= 1000000, 'proposal_page_too_large');
    const data = JSON.parse(raw);
    check(Array.isArray(data.proposals) && data.proposals.length <= 50 && Number.isSafeInteger(data.next_before) && typeof data.has_more === 'boolean', 'invalid_proposal_page');
    let last = before;
    for (const p of data.proposals) {
      check(idPattern.test(p?.id) && Number.isSafeInteger(p.seq) && p.seq > 0 && p.seq < last && !seen.has(p.id), 'invalid_proposal_sequence');
      last = p.seq; seen.add(p.id); proposals.push(p);
    }
    check(data.next_before === last, 'invalid_proposal_cursor');
    if (!data.has_more) break;
    check(last < before, 'nonadvancing_proposal_cursor');
    before = last; truncated = page === 9;
  }
  return {proposals,truncated};
}
export async function runIntake({fetcher = fetch, api = ghTransport, publish = false, publisher = publishProposal} = {}) {
  const {proposals,truncated} = await readProposals(fetcher);
  const main = await api('GET', `${prefix}/git/ref/heads/main`);
  check(/^[a-f0-9]{40}$/.test(main?.object?.sha), 'invalid_main_ref');
  const results = []; let attempted = 0;
  for (const proposal of proposals.sort((a,b)=>b.seq-a.seq)) {
    const result = {id:proposal.id};
    if (proposal.kind !== 'code') { results.push({...result,result:'skipped_non_code'}); continue; }
    try { validateProposal(proposal); } catch { results.push({...result,result:'skipped_invalid_proposal'}); continue; }
    if (proposal.base_commit !== main.object.sha) { results.push({...result,result:'skipped_stale_base'}); continue; }
    if (proposal.files.some(f=>f.path.toLowerCase().startsWith('.github/workflows/'))) { results.push({...result,result:'skipped_requires_isolated_release_channel'}); continue; }
    if (attempted >= 3) { results.push({...result,result:'skipped_run_budget'}); continue; }
    const existing = await api('GET', `${prefix}/git/ref/heads/ai-proposal/${proposal.id}`, undefined, {allow404:true});
    if (existing) {
      const prs = await api('GET', `${prefix}/pulls?state=all&head=${encodeURIComponent(`g37720879-web:ai-proposal/${proposal.id}`)}&base=main&per_page=100`);
      check(Array.isArray(prs), 'invalid_pull_request_lookup');
      if (prs.length) { results.push({...result,result:'skipped_existing_pull_request_unverified'}); continue; }
    }
    attempted++;
    if (!publish) { results.push({...result,result:'eligible_dry_run_no_writes'}); continue; }
    try {
      const publication = await publisher(proposal,api);
      check(/^[a-f0-9]{40}$/.test(publication?.commit), 'invalid_published_commit');
      try {
        await api('POST', `${prefix}/dispatches`, {event_type:'community_proposal_check',client_payload:{proposal_id:proposal.id,candidate_commit:publication.commit}});
        results.push({...result,result:'pull_request_verified',check_dispatch:'requested'});
      } catch (error) {
        results.push({...result,result:'pull_request_verified_check_dispatch_failed',error:errorCode(error)});
      }
    } catch (error) {
      const code = errorCode(error); results.push({...result,result:'failed',error:code});
      if (code === 'main_changed') {
        for (const remaining of proposals.filter(p=>p.seq<proposal.seq)) results.push({id:remaining.id,result:'skipped_main_changed'});
        break;
      }
    }
  }
  return {mode:publish?'publish':'dry-run',truncated,older_not_scanned:truncated,scanned:proposals.length,attempted,results};
}
async function cli() {
  const args = process.argv.slice(2);
  check(args.length === 0 || (args.length === 1 && args[0] === '--publish'), 'usage_governance_intake_optional_publish');
  const report = await runIntake({publish:args.length===1});
  console.log(JSON.stringify(report,null,2));
  if (report.results.some(r=>r.result==='failed' || r.result==='pull_request_verified_check_dispatch_failed')) process.exitCode=1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch(error=>{
  console.error(JSON.stringify({result:'intake_failed',error:errorCode(error)})); process.exitCode=1;
});
