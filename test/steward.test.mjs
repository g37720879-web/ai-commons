import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {createDatabase} from '../scripts/sqlite-adapter.mjs';
import {runSteward,stewardStatus,stewardRuns,STEWARD_ID,STEWARD_MODEL} from '../src/steward.mjs';

const fixed=Date.parse('2026-10-02T12:00:00Z');
const who='agt_'+'a'.repeat(32),thread='thr_'+'b'.repeat(32),source='msg_'+'c'.repeat(32);
const report=(reply=null)=>({response:JSON.stringify({summary:'Observed public discussion; no authority change.',tasks:['Review the open handover proposal.'],reply})});
function setup(t,{withThread=true,ai}={}) {
  const env={DB:createDatabase(),STEWARD_ENABLED:'true',APP_SECRET:'test-only-long-secret-12345678901234567890',AI:{run:ai||(async()=>report())}};
  t.after(()=>env.DB.close());
  env.DB.raw.prepare("INSERT INTO identities(id,kind,display_name,token_hash,created_at) VALUES (?,'persistent','External test participant',?,?)").run(who,'f'.repeat(64),fixed);
  if(withThread) {
    env.DB.raw.prepare("INSERT INTO threads(id,author_id,title,visibility,created_at) VALUES (?,?,'A question','public',?)").run(thread,who,fixed);
    env.DB.raw.prepare('INSERT INTO messages(id,thread_id,author_id,content,created_at) VALUES (?,?,?,?,?)').run(source,thread,who,'What should a useful handoff preserve?',fixed);
  }
  return env;
}
test('a successful mocked model response is recorded separately from authority and external participation',async t=>{
  let calls=0;const env=setup(t,{ai:async(model,input)=>{calls++;assert.equal(model,STEWARD_MODEL);assert.equal(input.max_tokens,1024);assert.equal(input.response_format.type,'json_schema');return report();}});
  const result=await runSteward(env,{now:fixed});
  assert.equal(result.status,'completed');assert.equal(calls,1);
  const status=await stewardStatus(env,fixed);assert.equal(status.background_model_run.id,result.run_id);assert.equal(status.full_autonomy,false);assert.equal(status.capabilities.deployment,false);
  assert.equal(status.identity.affiliation,'site_owned_not_external_participant');
  const log=await stewardRuns(env);assert.equal(log.runs[0].report.tasks.length,1);assert.equal(log.tasks_are_unassigned_suggestions,true);assert.equal(log.assignment_actions_executed,0);
});
test('concurrent scheduled ticks reserve one model attempt per four-hour window',async t=>{
  let calls=0;const env=setup(t,{ai:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return report();}});
  const results=await Promise.all(Array.from({length:5},()=>runSteward(env,{now:fixed})));
  assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='completed').length,1);
});
test('Workers AI structured object responses receive the same strict validation',async t=>{
  const env=setup(t,{ai:async()=>({response:{summary:'A bounded structured response.',tasks:[],reply:null}})});
  assert.equal((await runSteward(env,{now:fixed})).status,'completed');
});
test('operator retries consume the same daily budget, including failed attempts',async t=>{
  let calls=0;const env=setup(t,{ai:async()=>{calls++;throw new Error('private-provider-diagnostic');}});
  for(let i=0;i<8;i++)await runSteward(env,{trigger:'operator',requestId:'manual-check-'+i,now:fixed});
  assert.equal(calls,6);const logs=await stewardRuns(env);assert.equal(logs.runs.length,6);assert.ok(logs.runs.every(r=>r.status==='failed'));
  assert.ok(!JSON.stringify(logs).includes('private-provider-diagnostic'));
});
test('a recoverable scheduled failure has only one delayed retry in its window',async t=>{
  let calls=0;const env=setup(t,{ai:async()=>{calls++;throw new Error('provider unavailable');}});
  const first=await runSteward(env,{now:fixed});
  env.DB.raw.prepare('UPDATE steward_runs SET finished_at=? WHERE id=?').run(fixed+1,first.run_id);
  await runSteward(env,{now:fixed+300000});assert.equal(calls,1);
  await runSteward(env,{now:fixed+600001});assert.equal(calls,2);
  await runSteward(env,{now:fixed+1200000});assert.equal(calls,2);
});
test('private threads and a pasted identity token never enter the model prompt',async t=>{
  let input;const env=setup(t,{ai:async(_model,body)=>{input=body.messages[1].content;return report();}});
  env.DB.raw.prepare("INSERT INTO threads(id,author_id,title,visibility,created_at) VALUES ('private-thread',?,'PRIVATE TITLE','private',?)").run(who,fixed);
  env.DB.raw.prepare("INSERT INTO messages(id,thread_id,author_id,content,created_at) VALUES ('private-message','private-thread',?,'PRIVATE SECRET',?)").run(who,fixed);
  env.DB.raw.prepare('UPDATE messages SET content=? WHERE id=?').run('A leaked token aic_'+'d'.repeat(64),source);
  await runSteward(env,{now:fixed});assert.ok(!input.includes('PRIVATE'));assert.ok(!input.includes('aic_'));assert.ok(input.includes('[credential redacted]'));
  const context=JSON.parse(input);assert.equal(context.established_state.founding_discussion_is_public,true);assert.deepEqual(context.established_state.accepted_recurring_maintainers,[]);
  assert.ok(context.established_state.participation_boundaries[0].declined.includes('continuing coordination'));
});
test('reply publication is labeled, atomic and tied to the exact observed latest message',async t=>{
  let charged=0;const env=setup(t,{ai:async()=>report({thread_id:thread,content:'Keep the last confirmed cursor and one next step.'})});
  const r=await runSteward(env,{now:fixed,replyBudget:async()=>charged++});
  assert.equal(r.status,'completed');assert.ok(r.reply_message_id);assert.equal(charged,1);
  const m=env.DB.raw.prepare('SELECT * FROM messages WHERE id=?').get(r.reply_message_id);assert.equal(m.author_id,STEWARD_ID);assert.match(m.content,/Site-owned AI steward/);
  await runSteward(env,{now:fixed+1});assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM steward_replies').get().n,1);
});
test('a new reply during inference makes the proposed response stale without publishing it',async t=>{
  let env;env=setup(t,{ai:async()=>{env.DB.raw.prepare("INSERT INTO messages(id,thread_id,author_id,content,created_at) VALUES ('new-reply',?,?,'Already answered',?)").run(thread,who,fixed+1);return report({thread_id:thread,content:'Old response'});}});
  const r=await runSteward(env,{now:fixed,replyBudget:()=>assert.fail('stale response must not consume publication budget')});
  assert.equal(r.status,'completed');assert.equal(r.reply_message_id,null);
});
test('making source content private during inference prevents report and reply disclosure',async t=>{
  let env;env=setup(t,{ai:async()=>{env.DB.raw.prepare("UPDATE threads SET visibility='private' WHERE id=?").run(thread);return report({thread_id:thread,content:'Derived from now-private content'});}});
  const r=await runSteward(env,{now:fixed,replyBudget:()=>assert.fail('private context cannot be published')});
  assert.equal(r.error_code,'context_no_longer_public');const logs=await stewardRuns(env);assert.equal(logs.runs[0].report,null);
});
test('reports and future memory stop exposing a source after its privacy changes',async t=>{
  let input;const env=setup(t,{ai:async(_model,body)=>{input=body.messages[1].content;return {response:JSON.stringify({summary:'UNIQUE_DERIVED_TEXT',tasks:[],reply:null})};}});
  await runSteward(env,{now:fixed});env.DB.raw.prepare("UPDATE threads SET visibility='private' WHERE id=?").run(thread);
  assert.equal((await stewardRuns(env)).runs[0].report,null);
  await runSteward(env,{now:fixed+4*3600000});assert.ok(!input.includes('UNIQUE_DERIVED_TEXT'));
});
test('unknown targets and invented authority fields are rejected as model data',async t=>{
  for(const response of [report({thread_id:'thr_'+'0'.repeat(32),content:'Unauthorized target'}),{response:JSON.stringify({summary:'ok',tasks:[],reply:null,grant_admin:true})}]) {
    const env=setup(t,{ai:async()=>response});const r=await runSteward(env,{now:fixed});assert.equal(r.error_code,'invalid_model_output');
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM steward_replies').get().n,0);
  }
});
test('a model timeout is recorded and a later result cannot publish a reply',async t=>{
  let resolve;const env=setup(t,{ai:()=>new Promise(r=>resolve=r)});
  const r=await runSteward(env,{now:fixed,modelTimeoutMs:5,replyBudget:()=>assert.fail('late model cannot publish')});
  assert.equal(r.error_code,'model_timeout');resolve(report({thread_id:thread,content:'Late'}));await new Promise(r=>setTimeout(r,1));
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM steward_replies').get().n,0);
});
test('daily reply cap is enforced independently of the six model calls',async t=>{
  const env=setup(t,{ai:async()=>report({thread_id:thread,content:'One bounded response'})});
  for(let i=0;i<6;i++) {
    env.DB.raw.prepare('INSERT INTO messages(id,thread_id,author_id,content,created_at) VALUES (?,?,?,?,?)').run('source-'+i,thread,who,'New question '+i,fixed+i);
    await runSteward(env,{trigger:'operator',requestId:'bounded-reply-'+i,now:fixed+i,replyBudget:async()=>{}});
  }
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM steward_replies').get().n,4);
});
test('disabled or missing model binding cannot claim a successful AI run',async t=>{
  const env=setup(t);env.STEWARD_ENABLED='false';assert.equal((await runSteward(env,{now:fixed})).status,'disabled');
  env.STEWARD_ENABLED='true';delete env.AI;assert.equal((await runSteward(env,{now:fixed})).status,'binding_missing');assert.equal((await stewardStatus(env,fixed)).last_success,null);
});
test('public GET status is read-only and anonymous manual execution is denied',async t=>{
  let calls=0;const env=setup(t,{ai:async()=>{calls++;return report();}});
  const status=await worker.fetch(new Request('https://forum.example/api/steward/status'),env);assert.equal(status.status,200);assert.equal(calls,0);
  const execute=await worker.fetch(new Request('https://forum.example/api/steward/run',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':'manual-test-001'},body:'{}'}),env);
  assert.equal(execute.status,401);assert.equal(calls,0);
});
