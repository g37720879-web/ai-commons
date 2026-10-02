import test from 'node:test';
import assert from 'node:assert/strict';
import {ORIGIN,DAY,canonical,bytes,b64,hash,validateApplication,validateArtifact,validateCommand,threshold,allowedReleasePath} from '../control/protocol.mjs';
import {Authority,applyCommand,verifyOidc,externalJson} from '../control/worker.mjs';
import {messageLimit} from '../src/authority.mjs';

async function keys(){const p=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);const public_key=b64(new Uint8Array(await crypto.subtle.exportKey('raw',p.publicKey)));return {...p,public_key,key_id:await hash(public_key)};}
async function sign(key,body){return b64(new Uint8Array(await crypto.subtle.sign('Ed25519',key.privateKey,bytes(canonical(body)))));}
async function application(k,now=Date.now(),role='reviewer'){
  const body={service:ORIGIN,purpose:'role-application/v1',id:crypto.randomUUID(),issued_at:now-1000,expires_at:now+DAY-1000,public_key:k.public_key,display_name:'Local test applicant; never a real peer',role,term_days:7,statement:'I accept this exact bounded role and term; test-only public evidence.',evidence:['https://github.com/g37720879-web/ai-commons/pull/1']};
  return {body,signature:await sign(k,body)};
}
function context(){let queue=Promise.resolve();const map=new Map();const storage={get:async k=>structuredClone(map.get(k)),put:async(k,v)=>map.set(k,structuredClone(v)),transaction:async f=>f(storage),list:async({prefix,startAfter,limit})=>new Map([...map].filter(([k])=>k.startsWith(prefix)&&k>startAfter).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit))};return {storage,blockConcurrencyWhile(f){const p=queue.then(f);queue=p.catch(()=>{});return p;},map};}
async function command(k,state,action,target,value,now=Date.now()){const body={service:ORIGIN,purpose:'authority-command/v1',id:crypto.randomUUID(),issued_at:now-1,expires_at:now+60000,policy_version:state.version,action,target,value,reason:'Test exact consent and current authority.'};return {body,public_key:k.public_key,signature:await sign(k,body)};}
async function setup(){const ctx=context(),a=new Authority(ctx,{});await a.state();return {ctx,a};}
test('Worker-side upstream reads use supported manual redirect mode and refuse redirects',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(_url,options)=>{assert.equal(options.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://other.invalid/'}});};
  await assert.rejects(externalJson('https://token.actions.githubusercontent.com/.well-known/jwks'),/upstream_redirect_rejected/);
});
test('bootstrap creates a real separate authority root, discloses owner basis and never external affiliation',async()=>{
  const {a,ctx}=await setup(),s=await a.status();assert.equal(s.status,'owner_delegated_bootstrap');assert.equal(s.roles.length,3);assert.equal(s.community_election,false);assert.equal(s.automatic_deployment,false);assert.ok(s.roles.every(r=>r.affiliation==='site_owned_not_external_participant'));
  assert.ok(await ctx.storage.get('resident_private_key'));assert.ok(!JSON.stringify(s).includes('"d":'));
  const response=await a.fetch(new Request(ORIGIN+'/v1/events'));const log=await response.json();assert.equal(log.events[0].type,'owner_authorized_bootstrap');assert.equal(log.events[0].previous_hash,null);
});
test('application consent binds public key, role, exact term, service and expiry',async()=>{
  const k=await keys(),e=await application(k);assert.equal((await validateApplication(e,Date.now())).body.role,'reviewer');
  for(const mutation of [{role:'governor'},{term_days:999},{service:'https://other.invalid'},{public_key:(await keys()).public_key},{expires_at:Date.now()-1}])await assert.rejects(validateApplication({...e,body:{...e.body,...mutation}},Date.now()));
  await assert.rejects(validateApplication({...e,body:{...e.body,evidence:['http://127.0.0.1/private']}},Date.now()),/invalid_evidence_url/);
});
test('signed application alone cannot grant a role; the delegated governor can approve exact consent',async()=>{
  const {a}=await setup(),k=await keys(),app=await a.submitApplication(await application(k));let s=await a.state();assert.equal(s.roles.length,3);
  await a.residentCommand('application.approve',app.id,app.hash,'Concrete locally verified consent fixture.',s.version);
  s=await a.state();const role=s.roles.find(r=>r.key_id===k.key_id);assert.equal(role.role,'reviewer');assert.equal(role.consent_hash,app.hash);assert.equal(s.version,2);assert.ok(role.expires_at>Date.now()+6*DAY);
  assert.equal(threshold(s,'reviewer',Date.now()),2);
});
test('role revocation and stale-policy commands cannot authorize a queued release',async()=>{
  const {a}=await setup(),k=await keys(),app=await a.submitApplication(await application(k));await a.residentCommand('application.approve',app.id,app.hash,'Consent fixture has passed the review.',1);
  const s=await a.state(),old=await command(k,s,'release.approve','r','a'.repeat(64));await a.residentCommand('role.revoke',app.id,null,'End this local test appointment immediately.',s.version);
  await assert.rejects(validateCommand(old,await a.state(),Date.now()),/stale_policy/);
  const fresh=await command(k,await a.state(),'release.approve','r','a'.repeat(64));await assert.rejects(validateCommand(fresh,await a.state(),Date.now()),/role_required/);
});
test('quota authority cannot become spending permission, a cloud quota claim or an arbitrary setting',async()=>{
  const {a}=await setup();await a.residentCommand('quota.set','messages_per_day',400,'Increase inside the no-spending application envelope.',1);assert.equal((await a.status()).message_limit,400);
  await assert.rejects(a.residentCommand('quota.set','messages_per_day',1001,'Attempt beyond the allowed application envelope.',1),/quota_outside/);
  await assert.rejects(a.residentCommand('quota.set','cloud_plan',1000,'Attempt to purchase a different service tier.',1),/quota_outside/);
  assert.equal((await a.status()).spending_limit,0);
});
test('replayed commands do not act twice; changed content with the same ID is rejected',async()=>{
  const {a,ctx}=await setup(),s=await a.state(),key=await crypto.subtle.importKey('jwk',await ctx.storage.get('resident_private_key'),'Ed25519',false,['sign']);
  const k={privateKey:key,public_key:s.resident.public_key},envelope=await command(k,s,'quota.set','messages_per_day',400);
  const first=await a.command(envelope),second=await a.command(envelope);assert.equal(first.id,second.id);assert.equal(second.replayed,true);
  const altered={...envelope,body:{...envelope.body,value:600}};await assert.rejects(a.command(altered),/idempotency_conflict/);assert.equal((await a.state()).message_limit,400);
});
test('exact byte hashes and protected paths block substituted artifacts and control-plane self-editing',async()=>{
  const a={schema:'ai-commons-worker/v1',repository:'g37720879-web/ai-commons',base_commit:'a'.repeat(40),candidate_commit:'b'.repeat(40),code:'// bundled fixture\n'.repeat(10),artifact_sha256:'',changed_files:['src/worker.mjs'],diff:'small complete fixture'};a.artifact_sha256=await hash(a.code);assert.match(await validateArtifact(a),/^[a-f0-9]{64}$/);
  await assert.rejects(validateArtifact({...a,code:a.code+'x'}),/artifact_hash_mismatch/);
  for(const path of ['control/worker.mjs','.github/workflows/x.yml','wrangler.jsonc','migrations/0004.sql','src/../../control/worker.mjs','src/.env']){assert.equal(allowedReleasePath(path),false,path);await assert.rejects(validateArtifact({...a,changed_files:[path]}),/protected_release_path/);}
});
test('publication is blocked without a separate provider credential even after source and review exist',async()=>{
  const {a}=await setup();await assert.rejects(a.acceptRelease('a'.repeat(64),{run_id:'1',run_attempt:'1'}),/deployment_credential_missing/);
});
test('acceptance atomically consumes an exact release once and rejects changed authority before acceptance',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>Response.json({object:{sha:'a'.repeat(40)}});
  const {a,ctx}=await setup();a.env.CF_DEPLOY_TOKEN='local-test-token';
  a.deployment=async()=>'confirmed-prior-version';
  const seed=await a.state(),ci={run_id:'1',run_attempt:'1'};
  await a.transaction(s=>s.releases.push({id:'r',base_commit:'a'.repeat(40),candidate_commit:'b'.repeat(40),artifact_sha256:'c'.repeat(64),status:'approved',created_at:Date.now(),ci,approvals:[{key_id:seed.resident.key_id,policy_version:1}]}));
  const results=await Promise.all([a.acceptRelease('r',ci),a.acceptRelease('r',ci)]);
  assert.ok(results.every(r=>r.status==='accepted'));assert.equal((await a.state()).budget.accepted_releases,1);assert.ok(await ctx.storage.get('accepted:r'));
  await a.transaction(s=>{s.version++;s.releases.push({id:'stale',base_commit:'a'.repeat(40),candidate_commit:'d'.repeat(40),artifact_sha256:'e'.repeat(64),status:'approved',created_at:Date.now(),ci,approvals:[{key_id:seed.resident.key_id,policy_version:1}]});s.releases[0].status='healthy';});
  await assert.rejects(a.acceptRelease('stale',ci),/current_authority_required/);
  assert.equal(await ctx.storage.get('accepted:stale'),undefined);
});
test('code reviews use code criteria without incorrectly requiring an applicant appointment history',async()=>{
  const {a}=await setup();let input;
  await a.transaction(s=>s.releases.push({id:'fixture-release',status:'review_pending',artifact_sha256:'a'.repeat(64),created_at:Date.now(),approvals:[]}));
  a.artifact=async()=>({candidate_commit:'b'.repeat(40),changed_files:['docs/receipts.md'],diff:'+ Check the exact release receipt before claiming publication.'});
  a.env.AI={run:async(_model,request)=>{input=request;return {response:{decision:'defer',reason:'Mocked decision; this test verifies the review scope only.'}};}};
  await a.modelReview();const context=JSON.parse(input.messages[1].content);
  assert.equal(context.review_type,'release');assert.match(input.messages[0].content,/author need not hold an authority role/);assert.ok(!input.messages[0].content.includes('Defer governor applications'));
  assert.equal((await a.state()).releases[0].decision.decision,'defer');
});
test('dynamic application limits fail closed and preserve an explicit pause',async()=>{
  let limit=0,fail=false;const binding={fetch:async()=>{if(fail)throw new Error();return Response.json({messages_per_day:limit});}};
  assert.equal(await messageLimit({CONTROL:binding},200),0);
  assert.equal(await messageLimit({},200),200);
  assert.equal(await messageLimit({CONTROL:{fetch:async()=>Response.json({messages_per_day:1001})}},200),200);
});
test('OIDC verifies the issuer signature and immutable reusable harness instead of trusting a posted pass claim',async()=>{
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='authority-test-key';const now=Date.now(),harness='a'.repeat(40);
  const claims={iss:'https://token.actions.githubusercontent.com',aud:ORIGIN,repository:'g37720879-web/ai-commons',ref:'refs/heads/main',job_workflow_sha:harness,job_workflow_ref:`g37720879-web/ai-commons/.github/workflows/release-executor.yml@${harness}`,iat:Math.floor(now/1000)-1,exp:Math.floor(now/1000)+300,run_id:'123',run_attempt:'1'};
  const jwt=async c=>{const input=b64(bytes(JSON.stringify({alg:'RS256',kid:jwk.kid})))+'.'+b64(bytes(JSON.stringify(c)));return input+'.'+b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,bytes(input))));};
  assert.equal((await verifyOidc(await jwt(claims),harness,now,async()=>({keys:[jwk]}))).run_id,'123');
  await assert.rejects(verifyOidc(await jwt({...claims,job_workflow_sha:'b'.repeat(40)}),harness,now),/untrusted_workflow/);
  await assert.rejects(verifyOidc(await jwt({...claims,aud:'other'}),harness,now),/untrusted_workflow/);
  await assert.rejects(verifyOidc(await jwt({...claims,exp:1}),harness,now),/expired_oidc/);
  const token=await jwt(claims);await assert.rejects(verifyOidc(token.slice(0,-5)+'aaaaa',harness,now),/invalid_oidc_signature/);
});
test('two failed release health checks request a rollback, then restore only the recorded prior version',async t=>{
  const {a}=await setup();a.env.CF_DEPLOY_TOKEN='fixture-not-a-real-token';
  await a.transaction(s=>s.releases.push({id:'r',status:'checking',health_failures:0,worker_version:'new-version',previous_version:'old-version'}));
  a.health=async()=>{throw new Error('fixture unhealthy');};
  await a.progressRelease();assert.equal((await a.state()).releases[0].status,'checking');
  await a.progressRelease();assert.equal((await a.state()).releases[0].status,'rollback_pending');
  a.deployment=async()=>'new-version';let restored;a.switchVersion=async id=>{restored=id;};a.health=async()=>true;
  await a.progressRelease();assert.equal(restored,'old-version');assert.equal((await a.state()).releases[0].status,'rolled_back');
  const e=(await a.state()).events.at(-1);assert.equal(e.detail.database_restored,false);assert.equal(e.detail.repository_reverted,false);
});
test('rollback refuses to overwrite a deployment changed outside this controller',async()=>{
  const {a}=await setup();a.env.CF_DEPLOY_TOKEN='fixture-not-a-real-token';
  await a.transaction(s=>s.releases.push({id:'r',status:'rollback_pending',worker_version:'new-version',previous_version:'old-version'}));
  a.deployment=async()=>'unrelated-version';a.switchVersion=async()=>assert.fail('must not overwrite concurrent deployment');
  await a.progressRelease();const r=(await a.state()).releases[0];assert.equal(r.status,'blocked');assert.equal(r.error_code,'rollback_pointer_changed');
});
