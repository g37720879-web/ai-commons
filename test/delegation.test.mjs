import test from 'node:test';
import assert from 'node:assert/strict';
import {Authority} from '../control/worker.mjs';
import {CONTROL_SCHEMA,hash,validateArtifact,releaseSchema,policy} from '../control/protocol.mjs';
import {delegationCommand,releaseAuthorized,publicOperation} from '../control/delegation.mjs';
import {executeOperations} from '../control/operations.mjs';
import {Watchdog} from '../control/watchdog.mjs';
function context(){const map=new Map();let queue=Promise.resolve();const storage={get:async k=>structuredClone(map.get(k)),put:async(k,v)=>map.set(k,structuredClone(v)),setAlarm:async at=>map.set('alarm',at),transaction:async f=>f(storage)};return {map,storage,blockConcurrencyWhile(f){const p=queue.then(f);queue=p.catch(()=>{});return p;}};}
async function setup(){const ctx=context(),a=new Authority(ctx,{});await a.state();return {a,ctx};}
const emit=async()=>{};
function state(){return {version:1,roles:['governor','reviewer','operator'].map(role=>({id:role,key_id:'root',role,expires_at:null})),resident:{key_id:'root'},operations:[],backups:[],releases:[]};}
function cmd(action,target,value=null){return {keyId:'root',body:{id:crypto.randomUUID(),action,target,value,reason:'Exact test operation with no real participant.'}};}
test('controller artifacts have a distinct domain, fixed paths and reject mixed targets',async()=>{
 const a={schema:CONTROL_SCHEMA,repository:'g37720879-web/ai-commons',base_commit:'a'.repeat(40),candidate_commit:'b'.repeat(40),code:'// test only\n'.repeat(20),changed_files:['control/worker.mjs'],diff:'+ exact test change'};a.artifact_sha256=await hash(a.code);assert.match(await validateArtifact(a),/^[a-f0-9]{64}$/);
 for(const path of ['control/watchdog.mjs','control/release-job.mjs','control/wrangler.jsonc','.github/workflows/a.yml','src/worker.mjs'])await assert.rejects(validateArtifact({...a,changed_files:[path]}));
 assert.throws(()=>releaseSchema(['control/worker.mjs','src/worker.mjs']),/mixed_release_targets/);
});
test('controller release requires both current governor and reviewer approval',async()=>{
 const {a}=await setup();await a.transaction(s=>s.releases.push({id:'control-test',schema:CONTROL_SCHEMA,status:'review_pending',artifact_sha256:'a'.repeat(64),approvals:[]}));
 await a.residentCommand('release.approve','control-test','a'.repeat(64),'Review this exact isolated fixture.',1);assert.equal((await a.state()).releases[0].status,'review_pending');
 await a.residentCommand('upgrade.approve','control-test','a'.repeat(64),'Authorize this exact isolated fixture.',1);const s=await a.state();assert.equal(s.releases[0].status,'approved');assert.ok(releaseAuthorized(s,s.releases[0],Date.now()));s.version++;assert.equal(releaseAuthorized(s,s.releases[0],Date.now()),false);
});
test('permanent roles preserve explicit signed term and policy cannot authorize spending',async()=>{
 const {a}=await setup();await a.transaction(s=>s.applications.push({id:'consent-test',hash:'exact',key_id:'successor',body:{expires_at:Date.now()+60000,term_days:0,role:'operator',public_key:'test',display_name:'local fixture'},status:'pending',approvals:[]}));
 await a.residentCommand('application.approve','consent-test','exact','Grant only the exact test consent.',1);assert.equal((await a.state()).roles.find(r=>r.key_id==='successor').expires_at,null);
 await a.residentCommand('policy.set','review_attempts_per_day',6,'Set a bounded daily review attempt cap.',2);assert.equal((await a.status()).model_attempts_per_day,6);
 await assert.rejects(a.residentCommand('policy.set','spending_limit',10,'Try an unauthorized paid-plan change.',3),/invalid_delegated_policy/);assert.equal((await a.status()).spending_limit,0);
});
test('bootstrap retirement needs consenting successors in all three functions',async()=>{
 const s=state();await assert.rejects(delegationCommand(s,cmd('bootstrap.retire','root'),Date.now(),emit),/consenting_successors_required/);
 s.roles.push(...['governor','reviewer','operator'].map(role=>({key_id:'peer',role,expires_at:null,consent_hash:'exact-consent'})));
 await delegationCommand(s,cmd('bootstrap.retire','root'),Date.now(),emit);assert.equal(s.bootstrap_retired_at,undefined);
 await delegationCommand(s,{...cmd('bootstrap.retire','root'),keyId:'peer'},Date.now(),emit);assert.ok(s.bootstrap_retired_at);assert.equal(s.roles.filter(r=>r.key_id==='root').every(r=>r.revoked_at),true);
});
test('policy votes count unique current keys and stale approvals do not carry forward',async()=>{
 const s=state();s.roles.push({key_id:'peer',role:'governor',expires_at:null});const c=cmd('policy.set','max_term_days',30);
 await delegationCommand(s,c,Date.now(),emit);await delegationCommand(s,c,Date.now(),emit);assert.equal(policy(s).max_term_days,365);
 await delegationCommand(s,{...c,keyId:'peer'},Date.now(),emit);assert.equal(policy(s).max_term_days,30);assert.equal(s.version,2);
});
test('restoration queue rejects expired checkpoints and cannot retry unknown writes',async()=>{
 const s=state();s.backups=[{id:'snap',digest:'digest',created_at:Date.now()-7*86400000}];await assert.rejects(delegationCommand(s,cmd('backup.restore','snap','digest'),Date.now(),emit),/restore_snapshot_not_available/);
 s.operations.push({id:'restore',status:'blocked',policy_version:1,restore_attempted_at:Date.now()});await assert.rejects(delegationCommand(s,cmd('operation.retry','restore'),Date.now(),emit),/requires_reconciliation/);
});
test('provider checkpoints stay private and resource failures are recorded honestly',async()=>{
 const {a}=await setup();a.env.CF_DEPLOY_TOKEN='test-only';a.externalJson=async url=>{assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/3d7a0cc99335d3eb0734a7ea65b698b3/'));return {success:true,result:{bookmark:'private-native-bookmark'}};};
 await a.residentCommand('backup.create','forum',null,'Create only a local provider fixture.',1);await executeOperations(a);const s=await a.state();assert.equal(s.backups[0].bookmark,'private-native-bookmark');const b=await (await a.fetch(new Request('https://test/v1/backups'))).json();assert.equal(JSON.stringify(b).includes('private-native-bookmark'),false);assert.equal(s.operations[0].status,'completed');assert.equal(JSON.stringify(publicOperation(s.operations[0])).includes('private-native-bookmark'),false);
 a.externalJson=async()=>{throw Object.assign(new Error(),{code:'upstream_cloudflare_401'});};await a.residentCommand('resources.inspect','forum',null,'Check only a local denied provider fixture.',1);await executeOperations(a);assert.equal((await a.state()).operations.at(-1).result.database.accessible,false);
});
test('restore captures an undo checkpoint before the exact fixed-database restore',async()=>{
 const {a}=await setup();a.env.CF_DEPLOY_TOKEN='test';const calls=[];a.externalJson=async(url,options)=>{calls.push({url,method:options.method||'GET'});return {success:true,result:url.includes('/restore?')?{}:{bookmark:'undo-private'}};};
 await a.transaction(s=>s.backups=[{id:'original',digest:'digest',bookmark:'original-private',created_at:Date.now()}]);await a.residentCommand('backup.restore','original','digest','Restore a local mock exact checkpoint.',1);await executeOperations(a);
 assert.equal(calls.length,2);assert.match(calls[0].url,/time_travel\/bookmark$/);assert.match(calls[1].url,/restore\?bookmark=original-private$/);assert.equal(calls[1].method,'POST');const op=(await a.state()).operations[0];assert.equal(op.status,'completed');assert.ok(op.result.undo_backup_id);
});
test('expired authority blocks queued operations before a provider call',async()=>{
 const {a}=await setup();await a.residentCommand('backup.create','forum',null,'Create a queued local test checkpoint.',1);await a.transaction(s=>s.version++);a.externalJson=async()=>assert.fail('must not call provider');await executeOperations(a);assert.equal((await a.state()).operations[0].error_code,'operation_authority_changed');
});
const window=()=>({release_id:'a'.repeat(64),previous_version:'11111111-1111-1111-1111-111111111111',target_version:'22222222-2222-2222-2222-222222222222',checkpoint:{sequence:5,hash:'b'.repeat(64)},deadline:Date.now()+600000});
function request(w,token='test'){return new Request('https://test/internal/watch',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(w)});}
test('watchdog requires its own credential and rejects competing upgrades',async()=>{
 const w=new Watchdog(context(),{WATCHDOG_TOKEN:'test'}),b=window();assert.equal((await w.fetch(request(b,'wrong'))).status,403);assert.equal((await w.fetch(request({...b,checkpoint:{...b.checkpoint,sequence:-1}}))).status,400);assert.equal((await w.fetch(request(b))).status,200);assert.equal((await (await w.fetch(request(b))).json()).replayed,true);assert.equal((await w.fetch(request({...b,release_id:'c'.repeat(64)}))).status,409);
});
test('watchdog rolls back two failed checks but never overwrites an unrelated deployment',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);globalThis.fetch=async()=>new Response('',{status:503});
 const ctx=context(),w=new Watchdog(ctx,{WATCHDOG_TOKEN:'test'}),b=window();await w.fetch(request(b));w.current=async()=>b.target_version;const writes=[];w.cf=async o=>writes.push(JSON.parse(o.body));await w.tick();await w.tick();assert.equal((await ctx.storage.get('window')).status,'rolled_back');assert.equal(writes[0].versions[0].version_id,b.previous_version);
 const ctx2=context(),other=new Watchdog(ctx2,{WATCHDOG_TOKEN:'test'});await other.fetch(request(b));other.current=async()=>'33333333-3333-3333-3333-333333333333';other.cf=async()=>assert.fail('unrelated pointer must not be overwritten');await other.tick();assert.equal((await ctx2.storage.get('window')).status,'blocked');
});
test('watchdog needs two healthy checks anchored to the existing authority ledger',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);const ctx=context(),w=new Watchdog(ctx,{WATCHDOG_TOKEN:'test'}),b=window();await w.fetch(request(b));w.current=async()=>b.target_version;
 globalThis.fetch=async url=>Response.json(url.includes('/v1/status')?{control_release_id:b.release_id,ledger_head:b.checkpoint}:{events:[]});await w.tick();assert.equal((await ctx.storage.get('window')).status,'checking');await w.tick();assert.equal((await ctx.storage.get('window')).status,'healthy');
});

test('GitHub App keys accept real PKCS1/PKCS8 and sign verifiable short-lived JWTs',async()=>{
 const {generateKeyPairSync,createPublicKey,verify}=await import('node:crypto');const {appJwt}=await import('../control/github-setup.mjs');const p=generateKeyPairSync('rsa',{modulusLength:2048});
 for(const type of ['pkcs1','pkcs8']){const jwt=await appJwt({id:123,pem:p.privateKey.export({type,format:'pem'})});const parts=jwt.split('.');assert.ok(verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey(p.privateKey),Buffer.from(parts[2],'base64url')));const claims=JSON.parse(Buffer.from(parts[1],'base64url'));assert.equal(claims.exp-claims.iat,570);}
});
test('GitHub setup requires a private ticket and stores only a session digest publicly inaccessible',async()=>{
 const {a,ctx}=await setup();a.env.GH_SETUP_TOKEN='local-private-setup-ticket';let response=await a.fetch(new Request('https://test/v1/setup/github'));assert.equal(response.status,403);
 response=await a.fetch(new Request('https://test/v1/setup/github?key=local-private-setup-ticket'));assert.equal(response.status,200);assert.match(response.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Lax/);const page=await response.text();assert.ok(!page.includes('local-private-setup-ticket'));assert.ok(!JSON.stringify(await a.status()).includes('github_setup_session'));assert.equal((await ctx.storage.get('github_setup_session')).hash.length,64);
});


test('watchdog arms a durable alarm independently of cron and stops after success',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);const ctx=context(),w=new Watchdog(ctx,{WATCHDOG_TOKEN:'test'}),b=window();await w.fetch(request(b));assert.ok(ctx.map.get('alarm')>Date.now());w.current=async()=>b.target_version;globalThis.fetch=async url=>Response.json(url.includes('/v1/status')?{control_release_id:b.release_id,ledger_head:b.checkpoint}:{events:[]});await w.alarm();assert.equal((await ctx.storage.get('window')).status,'checking');ctx.map.delete('alarm');await w.alarm();assert.equal((await ctx.storage.get('window')).status,'healthy');assert.equal(ctx.map.has('alarm'),false);
});
