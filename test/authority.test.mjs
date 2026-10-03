import test from 'node:test';
import assert from 'node:assert/strict';
import {ORIGIN,DAY,MODEL,SECOND_OPINION_MODEL,canonical,bytes,b64,hash,validateApplication,validateArtifact,validateCommand,threshold,allowedReleasePath} from '../control/protocol.mjs';
import {Authority,applyCommand,verifyOidc,externalJson,mainFromAdvertisement,repositoryMain} from '../control/worker.mjs';
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
const packet=line=>(Buffer.byteLength(line)+4).toString(16).padStart(4,'0')+line;
const advertisement=(sha,extra='')=>packet('# service=git-upload-pack\n')+'0000'+packet(sha+' HEAD\x00symref=HEAD:refs/heads/main\n')+packet(sha+' refs/heads/main\n')+extra+'0000';
const gitResponse=sha=>new Response(advertisement(sha),{headers:{'Content-Type':'application/x-git-upload-pack-advertisement'}});
test('Worker-side upstream reads use supported manual redirect mode and refuse redirects',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(_url,options)=>{assert.equal(options.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://other.invalid/'}});};
  await assert.rejects(externalJson('https://token.actions.githubusercontent.com/.well-known/jwks'),/upstream_redirect_rejected/);
});
test('upstream failures identify provider limits without exposing credentials or response content',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>new Response('sensitive provider response',{status:403,headers:{'x-ratelimit-remaining':'0'}});
  await assert.rejects(externalJson('https://api.github.com/repos/fixed/ref'),e=>e.code==='upstream_github_403_rate_limited' && !e.message.includes('sensitive'));
  globalThis.fetch=async()=>new Response('sensitive credential detail',{status:401});
  await assert.rejects(externalJson('https://api.cloudflare.com/client/v4/fixed?private=query'),e=>e.code==='upstream_cloudflare_401' && !e.message.includes('private'));
});
test('Git branch verification parses complete framed data and rejects ambiguous or partial main refs',()=>{
  const sha='a'.repeat(40),good=advertisement(sha,packet('b'.repeat(40)+' refs/heads/other\n'));
  assert.equal(mainFromAdvertisement(bytes(good)),sha);
  for(const bad of [good.slice(0,-1),good.slice(0,-4),good+'junk',good.replace('refs/heads/main\n','refs/heads/main-other\n'),advertisement(sha,packet('b'.repeat(40)+' refs/heads/main\n'))])assert.throws(()=>mainFromAdvertisement(bytes(bad)));
});
test('repository main uses the fixed read-only Git endpoint and rejects redirects and HTML responses',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://github.com/g37720879-web/ai-commons.git/info/refs?service=git-upload-pack');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,undefined);return gitResponse('a'.repeat(40));};
  assert.equal(await repositoryMain(),'a'.repeat(40));
  globalThis.fetch=async()=>new Response('',{status:302,headers:{Location:'https://other.invalid/'}});
  await assert.rejects(repositoryMain(),/upstream_github_git_302/);
  globalThis.fetch=async()=>new Response(advertisement('a'.repeat(40)),{headers:{'Content-Type':'text/html'}});
  await assert.rejects(repositoryMain(),/invalid_git_content_type/);
});
test('installed controllers read the exact main ref with a repository-scoped read-only App token',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async()=>assert.fail('installed reads must not use shared anonymous Git access');
  const {generateKeyPairSync}=await import('node:crypto'),p=generateKeyPairSync('rsa',{modulusLength:2048});const {a,ctx}=await setup();await ctx.storage.put('github_app_credentials',{id:123,installation_id:456,pem:p.privateKey.export({type:'pkcs8',format:'pem'})});
  let wide=false,invalidRef=false;const urls=[];a.externalJson=async(url,options)=>{urls.push(url);if(url.endsWith('/access_tokens')){assert.deepEqual(JSON.parse(options.body),{repositories:['ai-commons'],permissions:{contents:'read'}});return {token:'local-fixture-token',permissions:{contents:wide?'write':'read',metadata:'read'}};}
    assert.equal(url,'https://api.github.com/repos/g37720879-web/ai-commons/git/ref/heads/main');assert.equal(options.headers.Authorization,'Bearer local-fixture-token');return {ref:invalidRef?'refs/heads/other':'refs/heads/main',object:{type:'commit',sha:'a'.repeat(40)}};};
  assert.equal(await a.repositoryMain(),'a'.repeat(40));assert.equal(urls.length,2);invalidRef=true;await assert.rejects(a.repositoryMain(),/invalid_github_main_ref/);
  wide=true;await assert.rejects(a.repositoryMain(),/github_read_token_scope_mismatch/);
  a.externalJson=async()=>{throw Object.assign(new Error('denied'),{code:'upstream_github_401'});};await assert.rejects(a.repositoryMain(),/denied/);
  assert.ok(!JSON.stringify(await a.status()).includes('local-fixture-token'));
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
test('granted application consent remains readable after leaving the active application list',async()=>{
  const {a}=await setup(),k=await keys(),envelope=await application(k),app=await a.submitApplication(envelope);
  await a.residentCommand('application.approve',app.id,app.hash,'Reviewed local fixture consent and role.',1);
  await a.transaction(s=>{s.applications=[];});
  const read=await a.fetch(new Request(ORIGIN+'/v1/applications/'+app.id));const data=await read.json();
  assert.equal(data.application.signature,envelope.signature);assert.equal(data.application.status,'granted');assert.equal(data.application.hash,app.hash);
  assert.equal((await a.submitApplication(envelope)).replayed,true);assert.equal((await a.state()).roles.length,4);
});
test('a second checked artifact preserves the first waiting approval and archives its exact decision',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const {a,ctx}=await setup(),base='a'.repeat(40),candidate='b'.repeat(40),first='c'.repeat(64);
  await a.transaction(s=>s.releases.push({id:first,base_commit:base,status:'approved',created_at:Date.now(),approvals:[{key_id:s.resident.key_id,policy_version:1}],decision:{decision:'approve'}}));
  globalThis.fetch=async()=>gitResponse(base);
  const code='// complete fixture module\n'.repeat(10),artifact={schema:'ai-commons-worker/v1',repository:'g37720879-web/ai-commons',base_commit:base,candidate_commit:candidate,code,artifact_sha256:await hash(code),changed_files:['docs/new.md'],diff:'+ documentation'};
  await a.submitRelease(artifact,{run_id:'2',run_attempt:'1'});assert.equal((await a.state()).releases.find(r=>r.id===first).status,'approved');
  assert.equal((await ctx.storage.get('release:'+first)).decision.decision,'approve');
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
  globalThis.fetch=async()=>gitResponse('a'.repeat(40));
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
test('code reviews use code criteria without incorrectly requiring an applicant appointment history',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async()=>gitResponse('b'.repeat(40));
  const {a}=await setup();let input;
  a.env.RELEASE_HARNESS_SHA='c'.repeat(40);
  await a.transaction(s=>s.releases.push({id:'fixture-release',base_commit:'b'.repeat(40),ci:{harness:a.env.RELEASE_HARNESS_SHA},status:'review_pending',artifact_sha256:'a'.repeat(64),created_at:Date.now(),approvals:[]}));
  a.artifact=async()=>({candidate_commit:'b'.repeat(40),changed_files:['docs/receipts.md'],diff:'+ Check the exact release receipt before claiming publication.'});
  a.env.AI={run:async(_model,request)=>{input=request;return {response:{decision:'defer',reason:'Mocked decision; this test verifies the review scope only.'}};}};
  await a.modelReview();const context=JSON.parse(input.messages[1].content);
  assert.equal(context.evidence.verified_delivery.isolated_tests_and_worker_build_passed,true);
  assert.match(context.evidence.verified_delivery.meaning,/do not replace review/);
  assert.equal(context.review_type,'release');assert.match(input.messages[0].content,/author need not hold an authority role/);assert.ok(!input.messages[0].content.includes('Defer governor applications'));
  assert.equal((await a.state()).releases[0].decision.decision,'defer');
});
async function reviewFixture(t){
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async()=>gitResponse('a'.repeat(40));
  const {a}=await setup();a.env.RELEASE_HARNESS_SHA='c'.repeat(40);
  await a.transaction(s=>s.releases.push({id:'d'.repeat(64),schema:'ai-commons-worker/v1',status:'review_pending',base_commit:'a'.repeat(40),candidate_commit:'b'.repeat(40),artifact_sha256:'e'.repeat(64),created_at:Date.now(),ci:{harness:a.env.RELEASE_HARNESS_SHA},approvals:[]}));
  a.artifact=async()=>({schema:'ai-commons-worker/v1',base_commit:'a'.repeat(40),candidate_commit:'b'.repeat(40),changed_files:['docs/example.md'],diff:'+ Useful documentation fixture.'});return a;
}
test('a deferred exact release gets one bounded second opinion, preserving the first decision and signed approval',async t=>{
  const a=await reviewFixture(t),models=[];
  a.env.AI={run:async(model,request)=>{models.push(model);const input=JSON.parse(request.messages[1].content);if(models.length===2)assert.equal(input.evidence.previous_assessment.decision,'defer');return {response:{decision:models.length===1?'defer':'approve',reason:'Mocked exact-artifact assessment for local regression.'}};}};
  await a.modelReview();await a.modelReview();await a.modelReview();const s=await a.state(),r=s.releases[0];
  assert.deepEqual(models,[MODEL,SECOND_OPINION_MODEL]);assert.equal(s.budget.model,2);assert.equal(r.status,'approved');assert.equal(r.review_history[0].decision,'defer');assert.equal(r.decision.pass,2);assert.equal(r.approvals[0].key_id,s.resident.key_id);
  const visible=await (await a.fetch(new Request(ORIGIN+'/v1/releases/'+r.id))).json();assert.equal(visible.release.review_history[0].decision,'defer');
});
test('two deferrals stay pending without a third review or a fabricated approval',async t=>{
  const a=await reviewFixture(t);let calls=0;a.env.AI={run:async()=>{calls++;return {response:{decision:'defer',reason:'Insufficient local evidence remains after both reviews.'}};}};
  await a.modelReview();await a.modelReview();await a.modelReview();const r=(await a.state()).releases[0];assert.equal(calls,2);assert.equal(r.status,'review_pending');assert.equal(r.approvals.length,0);
});
test('the second opinion consumes the shared daily budget and cannot bypass its ceiling',async t=>{
  const a=await reviewFixture(t);await a.transaction(s=>s.policy={review_attempts_per_day:1});
  a.env.AI={run:async()=>({response:{decision:'defer',reason:'Mocked first review consumes the complete daily budget.'}})};
  await a.modelReview();await assert.rejects(a.modelReview(),/daily_budget_reached/);const s=await a.state();assert.equal(s.budget.model,1);assert.equal(s.releases[0].second_opinion_started,undefined);
});
test('stale bases and harnesses do not consume model calls; a branch change during inference cannot approve',async t=>{
  const a=await reviewFixture(t);let calls=0;
  a.env.AI={run:async()=>{calls++;globalThis.fetch=async()=>gitResponse('f'.repeat(40));return {response:{decision:'approve',reason:'This model answer must not authorize a stale branch.'}};}};
  await a.transaction(s=>s.releases[0].base_commit='f'.repeat(40));await a.modelReview();
  await a.transaction(s=>{s.releases[0].base_commit='a'.repeat(40);s.releases[0].ci.harness='f'.repeat(40);});await a.modelReview();assert.equal(calls,0);assert.equal((await a.state()).budget.model,undefined);
  await a.transaction(s=>s.releases[0].ci.harness=a.env.RELEASE_HARNESS_SHA);await a.modelReview();const r=(await a.state()).releases[0];assert.equal(calls,1);assert.equal(r.approvals.length,0);assert.equal(r.review_error,'stale_main');
});
test('a failed second model call cannot be retried indefinitely or erase the prior deferral',async t=>{
  const a=await reviewFixture(t);let calls=0;a.env.AI={run:async()=>{if(++calls===2)throw new Error('local unavailable provider fixture');return {response:{decision:'defer',reason:'The first review requires more evidence to decide.'}};}};
  await a.modelReview();await a.modelReview();await a.modelReview();const r=(await a.state()).releases[0];assert.equal(calls,2);assert.equal(r.decision.decision,'defer');assert.equal(r.approvals.length,0);assert.ok(r.second_opinion_started);
});
test('resubmitting an expired exact artifact preserves both deferrals instead of resetting review limits',async t=>{
  const a=await reviewFixture(t),code='// local complete module\n'.repeat(10),artifact={schema:'ai-commons-worker/v1',repository:'g37720879-web/ai-commons',base_commit:'a'.repeat(40),candidate_commit:'b'.repeat(40),code,artifact_sha256:await hash(code),changed_files:['docs/example.md'],diff:'+ documentation'};
  const id=await validateArtifact(artifact);await a.transaction(s=>{s.releases[0].id=id;s.releases[0].created_at=Date.now()-2*DAY;s.releases[0].decision={decision:'defer',pass:2};s.releases[0].second_opinion_started=Date.now()-2*DAY;s.releases[0].review_history=[{decision:'defer',pass:1}];});
  const replay=await a.submitRelease(artifact,{harness:a.env.RELEASE_HARNESS_SHA,run_id:'2',run_attempt:'1'});assert.equal(replay.decision.pass,2);assert.equal(replay.review_history[0].pass,1);a.env.AI={run:async()=>assert.fail('the same deferred artifact must not be reviewed again')};await a.modelReview();
  await a.transaction(s=>s.releases=[]);const archived=await a.submitRelease(artifact,{harness:a.env.RELEASE_HARNESS_SHA,run_id:'3',run_attempt:'1'});assert.equal(archived.decision.pass,2);assert.equal(archived.review_history[0].pass,1);await a.modelReview();
});
test('role reviews can load fixed-repository GitHub evidence after Git branch verification changed',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const {a}=await setup(),app=await a.submitApplication(await application(await keys()));let input,reads=0;
  globalThis.fetch=async url=>{assert.equal(String(url),'https://api.github.com/repos/g37720879-web/ai-commons/pulls/1');reads++;return Response.json({title:'Local evidence fixture',body:'Untrusted public work excerpt',state:'closed',merged:false});};
  a.env.AI={run:async(_model,request)=>{input=request;return {response:{decision:'defer',reason:'Fixture is not sufficient evidence to grant a real role.'}};}};
  await a.modelReview();await a.modelReview();const context=JSON.parse(input.messages[1].content);
  assert.equal(reads,1);assert.equal(context.review_type,'application');assert.equal(context.evidence.evidence[0].title,'Local evidence fixture');
  const s=await a.state();assert.equal(s.applications.find(x=>x.id===app.id).decision.decision,'defer');assert.equal(s.roles.length,3);
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
