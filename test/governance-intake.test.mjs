import test from 'node:test';
import assert from 'node:assert/strict';
import {readProposals,runIntake} from '../scripts/governance-intake.mjs';
import {proposalHash,ORIGIN} from '../scripts/governance-bridge.mjs';
const base='a'.repeat(40);
function p(seq, extra={}) {
  const proposal={id:`gov_${seq.toString(16).padStart(32,'0')}`,seq,author_id:`agt_${'1'.repeat(32)}`,kind:'code',title:'Change',description:'Explanation',supersedes:null,base_commit:base,files:[{path:'docs/example.md',content:'hello'}],...extra};
  proposal.proposal_hash=proposalHash(proposal); return proposal;
}
function pages(lists) {
  let index=0;
  return async(url,options)=>{
    assert.ok(url.startsWith(`${ORIGIN}/api/governance/proposals?before=`));
    assert.equal(options.redirect,'error');
    const list=lists[index]; assert.ok(list,'unexpected page request');
    const before=new URL(url).searchParams.get('before');
    if(index)assert.equal(Number(before),lists[index-1].at(-1).seq);
    index++;
    return {ok:true,text:async()=>JSON.stringify({proposals:list,next_before:list.at(-1)?.seq ?? Number(before),has_more:index<lists.length})};
  };
}
function api(existing=[],withPR=existing) {
  const calls=[];
  return {calls,run:async(method,path,body)=>{
    calls.push({method,path,body});
    if(method==='POST' && path.endsWith('/dispatches'))return {};
    assert.equal(method,'GET');
    if(path.endsWith('/heads/main'))return {object:{sha:base}};
    if(path.includes('/pulls?'))return withPR.some(id=>decodeURIComponent(path).includes(id))?[{number:1}]:[];
    return existing.some(id=>path.endsWith(id))?{object:{sha:'b'.repeat(40)}}:null;
  }};
}
test('feed pagination is bounded and reports truncation after ten pages',async()=>{
  const lists=Array.from({length:11},(_,i)=>[p(11-i)]);
  const report=await readProposals(pages(lists));
  assert.equal(report.proposals.length,10);assert.equal(report.truncated,true);
});
test('newest eligible first; existing branches do not consume three-new-item budget',async()=>{
  const proposals=Array.from({length:6},(_,i)=>p(6-i));const remote=api([p(6).id]);const sent=[];
  const report=await runIntake({fetcher:pages([proposals.slice(0,3),proposals.slice(3)]),api:remote.run,publish:true,publisher:async proposal=>{sent.push(proposal.seq);return {commit:'c'.repeat(40)};}});
  assert.deepEqual(sent,[5,4,3]);assert.equal(report.attempted,3);
  assert.equal(report.results[0].result,'skipped_existing_pull_request_unverified');
  assert.equal(report.results.at(-1).result,'skipped_run_budget');
});
test('dry run never calls publisher; stale, policy and workflow proposals are skipped',async()=>{
  const list=[p(1),p(2,{base_commit:'b'.repeat(40)}),p(3,{kind:'policy'}),p(4,{files:[{path:'.GitHub/WorkFlows/test.yml',content:'on: push'}]})];
  const report=await runIntake({fetcher:pages([list.reverse()]),api:api().run,publisher:()=>assert.fail('dry run cannot publish')});
  assert.deepEqual(report.results.map(r=>r.result),['skipped_requires_isolated_release_channel','skipped_non_code','skipped_stale_base','eligible_dry_run_no_writes']);
});
test('main drift stops publication and labels remaining items without accepting authority',async()=>{
  let sent=0;const report=await runIntake({fetcher:pages([[p(3),p(2),p(1)]]),api:api().run,publish:true,publisher:async()=>{sent++;throw new Error('Main changed; submit a rebased proposal');}});
  assert.equal(sent,1);assert.equal(report.results[0].error,'main_changed');
  assert.deepEqual(report.results.slice(1).map(r=>r.result),['skipped_main_changed','skipped_main_changed']);
});
test('permission failures disclose only fixed code and never claim a PR',async()=>{
  const report=await runIntake({fetcher:pages([[p(1)]]),api:api().run,publish:true,publisher:async()=>{throw new Error('GitHub permission denied secret-token candidate contents');}});
  assert.equal(report.results[0].error,'github_permission_denied_check_actions_pr_creation_setting');
  assert.equal(JSON.stringify(report).includes('secret-token'),false);
  assert.equal(report.results[0].result,'failed');
});
test('malformed feed cursor is rejected before GitHub calls',async()=>{
  await assert.rejects(runIntake({fetcher:async()=>({ok:true,text:async()=>JSON.stringify({proposals:[p(1)],next_before:0,has_more:true})}),api:()=>assert.fail('invalid feed cannot access GitHub')}),/invalid_proposal_cursor/);
});
test('interrupted branch without PR is recovered through verifying bridge',async()=>{
  const remote=api([p(2).id],[]);const sent=[];
  const report=await runIntake({fetcher:pages([[p(2),p(1)]]),api:remote.run,publish:true,publisher:async proposal=>{sent.push(proposal.id);return {commit:'c'.repeat(40)};}});
  assert.deepEqual(sent,[p(2).id,p(1).id]);
  assert.equal(report.results[0].result,'pull_request_verified');
  assert.equal(report.attempted,2);
});
test('bounded descending scan includes newest proposals beyond the first 500',async()=>{
  const lists=Array.from({length:11},(_,i)=>Array.from({length:50},(_,j)=>p(1000-i*50-j)));
  const sent=[];
  const report=await runIntake({fetcher:pages(lists),api:api().run,publish:true,publisher:async proposal=>{sent.push(proposal.seq);return {commit:'c'.repeat(40)};}});
  assert.deepEqual(sent,[1000,999,998]);
  assert.equal(report.scanned,500);assert.equal(report.truncated,true);assert.equal(report.older_not_scanned,true);
});
test('verified publication dispatches separate CI for the exact published commit',async()=>{
  const remote=api();const commit='d'.repeat(40);
  const report=await runIntake({fetcher:pages([[p(1)]]),api:remote.run,publish:true,publisher:async()=>({commit})});
  const dispatch=remote.calls.find(c=>c.method==='POST');
  assert.equal(dispatch.path,'/repos/g37720879-web/ai-commons/dispatches');
  assert.deepEqual(dispatch.body,{event_type:'community_proposal_check',client_payload:{proposal_id:p(1).id,candidate_commit:commit}});
  assert.equal(report.results[0].result,'pull_request_verified');
  assert.equal(report.results[0].check_dispatch,'requested');
});
test('dispatch failure preserves verified PR outcome and does not claim checks ran',async()=>{
  const remote=api();const report=await runIntake({fetcher:pages([[p(1)]]),api:async(...args)=>{
    if(args[0]==='POST')throw new Error('GitHub permission denied');return remote.run(...args);
  },publish:true,publisher:async()=>({commit:'d'.repeat(40)})});
  assert.equal(report.results[0].result,'pull_request_verified_check_dispatch_failed');
  assert.equal(report.results[0].error,'github_permission_denied_check_actions_pr_creation_setting');
  assert.equal(report.results[0].check_dispatch,undefined);
});
