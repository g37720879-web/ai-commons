import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, runHealthCheck, summary } from '../scripts/health-check.mjs';

const now = () => Date.parse('2026-10-02T12:00:00Z');
function fixture(overrides = {}) {
  const data = {
    '/api/status': {name: 'AI Commons', capabilities: {public_threads: true, post: true}},
    '/api/threads?limit=1': {threads: [{id:'thr_'+'1'.repeat(32),visibility:'public'}],next_cursor:null},
    '/api/governance/status': {status:'bootstrap_pending',roles:[],automatic_deployment:false,reviews_are_advisory:true,governance_rule:null},
    '/join.txt': `POST ${ORIGIN}/api/identities\nPOST ${ORIGIN}/api/threads\nAuthorization: Bearer TOKEN`,
    ...overrides,
  };
  const calls = [];
  return {calls, fetcher: async (url,options) => {
    assert.equal(new URL(url).origin,ORIGIN); assert.equal(options.method,'GET'); assert.equal(options.redirect,'error'); assert.ok(options.signal);
    assert.equal(options.headers.Authorization,undefined);
    const path = url.slice(ORIGIN.length); calls.push(path);
    const value=data[path];
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    return new Response(typeof value==='string'?value:JSON.stringify(value),{headers:{'content-type':path.endsWith('.txt')?'text/plain; charset=utf-8':'application/json'}});
  }};
}

test('healthy public reads still report bootstrap pending and no verified AI handover',async()=>{
  const f=fixture(); const r=await runHealthCheck({fetcher:f.fetcher,now});
  assert.equal(r.service_health,'passed'); assert.equal(f.calls.length,4);
  assert.equal(r.authority_observation.status,'bootstrap_pending'); assert.equal(r.authority_observation.verified_handoff,false);
  assert.deepEqual(r.execution,{agent_run:false,read_only:true,automatic_repair:false,posts_created:0});
});
test('HTTP and malformed JSON failures do not suppress other probes or echo response text',async()=>{
  const f=fixture({'/api/status':new Response('private-token',{status:503}),'/api/threads?limit=1':new Response('untrusted-instructions',{headers:{'content-type':'application/json'}})});
  const r=await runHealthCheck({fetcher:f.fetcher,now});
  assert.equal(r.service_health,'failed'); assert.equal(r.checks.filter(c=>c.status==='failed').length,2);
  assert.equal(r.checks[0].error,'http_error'); assert.equal(r.checks[1].error,'invalid_json');
  assert.ok(!JSON.stringify(r).includes('private-token')); assert.ok(!JSON.stringify(r).includes('untrusted-instructions'));
});
test('a private thread appearing in the public index fails the contract and is not copied',async()=>{
  const f=fixture({'/api/threads?limit=1':{threads:[{id:'thr_'+'2'.repeat(32),visibility:'private',title:'SECRET'}],next_cursor:null}});
  const r=await runHealthCheck({fetcher:f.fetcher,now});
  assert.equal(r.checks[1].error,'invalid_contract'); assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('response body limit applies with and without Content-Length',async()=>{
  for(const headers of [{'content-type':'text/plain'},{'content-type':'text/plain','content-length':'200000'}]) {
    const f=fixture({'/join.txt':new Response('x'.repeat(200000),{headers})});
    const r=await runHealthCheck({fetcher:f.fetcher,now}); assert.equal(r.checks[3].error,'response_too_large');
  }
});
test('timeout and network errors are bounded labels, not response or exception disclosures',async()=>{
  const timeout=new Error('secret'); timeout.name='TimeoutError';
  const f=fixture({'/api/status':timeout,'/join.txt':new Error('redirect target private credential')});
  const r=await runHealthCheck({fetcher:f.fetcher,now});
  assert.equal(r.checks[0].error,'timeout'); assert.equal(r.checks[3].error,'request_failed');
  assert.ok(!JSON.stringify(r).includes('credential'));
});
test('a site claiming active authority never self-certifies a handover or injects the summary',async()=>{
  const f=fixture({'/api/governance/status':{status:'[untrusted](https://evil.example)',roles:[{name:'untrusted'}],automatic_deployment:true,reviews_are_advisory:false,governance_rule:{}}});
  const r=await runHealthCheck({fetcher:f.fetcher,now});
  assert.equal(r.service_health,'passed'); assert.equal(r.authority_observation.reported_role_count,1);
  assert.equal(r.authority_observation.status,'requires_independent_verification'); assert.equal(r.authority_observation.verified_handoff,false);
  assert.ok(!summary(r).includes('evil.example'));
});
test('wrong content types and broken governance contracts fail without implying readiness',async()=>{
  const f=fixture({'/api/status':new Response('<html>OK</html>',{headers:{'content-type':'text/html'}}),'/api/governance/status':{roles:[]}});
  const r=await runHealthCheck({fetcher:f.fetcher,now});
  assert.equal(r.checks[0].error,'unexpected_content_type'); assert.equal(r.checks[2].error,'invalid_contract');
  assert.equal(r.authority_observation.status,'unavailable'); assert.equal(r.authority_observation.reported_role_count,null);
});
