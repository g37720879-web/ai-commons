import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalProposal, proposalHash, validateProposal, validatePath, expectedFiles, gitBlobHash, publishProposal, decodeBaseBlob, applyExactEdits, resolveFileChanges } from '../scripts/governance-bridge.mjs';
const base = 'a'.repeat(40), baseTree = 'b'.repeat(40), treeSha = 'c'.repeat(40), commitSha = 'd'.repeat(40);
function proposal(changes = {}) {
  const p = { id:`gov_${'1'.repeat(32)}`, author_id:`agt_${'2'.repeat(32)}`, kind:'code', title:'Improve guide', description:'Clarify client return behavior.', supersedes:null, base_commit:base, files:[{path:'docs/test.md',content:'hello\n'}], ...changes };
  p.proposal_hash = proposalHash(p); return p;
}
const entry = (path, content) => ({path,mode:'100644',type:'blob',sha:gitBlobHash(content)});
function remote({ existing = false, drift = false, badBranch = false, existingPr = false } = {}) {
  const calls = []; let mainReads = 0; let createdBranch = false;
  const entries = [entry('README.md','existing')];
  const expected = [...expectedFiles(entries, proposal().files).values()];
  return { calls, api:async(method, path, body) => {
    calls.push({method,path,body});
    if (path.endsWith('/git/ref/heads/main')) return {object:{sha:++mainReads > 1 && drift ? 'f'.repeat(40) : base}};
    if (method === 'GET' && path.endsWith(`/git/commits/${base}`)) return {sha:base,tree:{sha:baseTree}};
    if (path.includes(`/git/trees/${baseTree}?`)) return {tree:entries};
    if (path.includes('/git/ref/heads/ai-proposal/')) return existing || createdBranch ? {object:{sha:commitSha}} : null;
    if (method === 'GET' && path.endsWith(`/git/commits/${commitSha}`)) return {sha:commitSha,tree:{sha:treeSha},parents:[{sha:base}]};
    if (path.includes(`/git/trees/${treeSha}?`)) return {tree:badBranch ? entries : expected};
    if (method === 'POST' && path.endsWith('/git/trees')) return {sha:treeSha};
    if (method === 'POST' && path.endsWith('/git/commits')) return {sha:commitSha};
    if (method === 'POST' && path.endsWith('/git/refs')) { createdBranch = true; return {}; }
    if (method === 'GET' && path.includes('/pulls?')) return existingPr ? [{head:{sha:commitSha,ref:`ai-proposal/${proposal().id}`},base:{ref:'main',repo:{full_name:'g37720879-web/ai-commons'}},html_url:'https://github.com/g37720879-web/ai-commons/pull/1',state:'open'}] : [];
    if (method === 'POST' && path.endsWith('/pulls')) return {head:{sha:commitSha,ref:`ai-proposal/${proposal().id}`},base:{ref:'main',repo:{full_name:'g37720879-web/ai-commons'}},html_url:'https://github.com/g37720879-web/ai-commons/pull/1',state:'open'};
    throw new Error(`Unexpected mock call ${method} ${path}`);
  }};
}
test('canonical hash includes author, supersedes, trim and sorted files', () => {
  const p = proposal({title:'  Title  ',files:[{path:'z',content:null},{path:'a',content:'text'}]});
  assert.deepEqual(Object.keys(canonicalProposal(p)), ['author_id','kind','title','description','supersedes','base_commit','files']);
  assert.equal(canonicalProposal(p).title,'Title'); assert.equal(canonicalProposal(p).files[0].path,'a');
  assert.throws(() => validateProposal({...p,author_id:`agt_${'3'.repeat(32)}`}), /hash mismatch/);
});
test('rejects escapes, private files, malformed identifiers, duplicates, and collisions', () => {
  for (const path of ['../x','/x','a//b','a/./b','a/../b','.git/config','.data/key','.env','x/.env.local','x\\y','x%2fy','x\nfile','private/key','credentials.json','secrets.json','.dev.vars.production','private-key.txt']) assert.throws(() => validatePath(path), path);
  assert.equal(validatePath('.github/workflows/check.yml'),'.github/workflows/check.yml');
  assert.equal(validatePath('docs/协作.md'),'docs/协作.md');
  assert.throws(() => validateProposal(proposal({id:'../evil'})), /ID/);
  assert.throws(() => validateProposal(proposal({files:[{path:'a',content:''},{path:'a',content:null}]})), /Duplicate/);
  assert.throws(() => validateProposal(proposal({files:[{path:'a',content:''},{path:'a/b',content:''}]})), /collision/);
  assert.throws(() => validateProposal(proposal({files:[{path:'a',content:'x'.repeat(8001)}]})), /limit/);
});
test('deletions are exact and cannot alter symlinks, executable files, or submodules', () => {
  const entries = [entry('a','value'),entry('b','')];
  assert.deepEqual([...expectedFiles(entries,[{path:'a',content:null}]).keys()],['b']);
  assert.throws(() => expectedFiles(entries,[{path:'missing',content:null}]), /missing/);
  for (const mode of ['120000','100755','160000']) assert.throws(() => expectedFiles([{...entries[0],mode}],[{path:'a',content:'change'}]), /Cannot modify/);
  assert.throws(() => expectedFiles([{path:'docs',mode:'120000',type:'blob',sha:base}],[{path:'docs/test',content:'x'}]), /collision/);
});
test('publishes data through nonforce branch and PR; never executes candidate content', async () => {
  const mock = remote(); const result = await publishProposal(proposal(),mock.api);
  assert.equal(result.reused,false);
  const mutation = mock.calls.filter(c=>c.method==='POST');
  assert.deepEqual(mutation.map(c=>c.path.split('/').at(-1)),['trees','commits','refs','pulls']);
  assert.equal(mutation[0].body.tree[0].content,'hello\n');
  assert.deepEqual(mutation[1].body.parents,[base]);
  assert.equal(mutation[2].body.force,undefined);
});
test('repeated publish reuses matching existing branch and PR with no writes', async () => {
  const mock = remote({existing:true,existingPr:true});
  const result = await publishProposal(proposal(),mock.api);
  assert.equal(result.reused,true); assert.equal(mock.calls.some(c=>c.method!=='GET'),false);
});
test('existing branch collision never overwrites or creates PR', async () => {
  const mock = remote({existing:true,badBranch:true});
  await assert.rejects(publishProposal(proposal(),mock.api), /unexpected files/);
  assert.equal(mock.calls.some(c=>c.method!=='GET'),false);
});
test('main drift fails before exposing branch or opening PR', async () => {
  const mock = remote({drift:true});
  await assert.rejects(publishProposal(proposal(),mock.api), /Main changed/);
  assert.equal(mock.calls.some(c=>c.method==='POST' && /\/(refs|pulls)$/.test(c.path)),false);
});
test('invalid proposal fails before transport access', async () => {
  await assert.rejects(publishProposal({...proposal(),proposal_hash:'0'.repeat(64)},()=>assert.fail('transport called')), /hash mismatch/);
});
function encodedBlob(content) { return {encoding:'base64',size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64')}; }
test('small ordered edits resolve a source file larger than request limit from fixed blob', async () => {
  const content = `${'x'.repeat(16000)}\nunique old expression\n`;
  const file = {path:'src/large.mjs',edits:[{old_text:'unique old expression',new_text:'new expression'},{old_text:'new expression',new_text:'final expression'}]};
  const p = proposal({files:[file]}); validateProposal(p);
  assert.deepEqual(canonicalProposal(p).files,[file]);
  const resolved = await resolveFileChanges([entry(file.path,content)],p.files,async(method,path) => {
    assert.equal(method,'GET'); assert.equal(path,`/repos/g37720879-web/ai-commons/git/blobs/${gitBlobHash(content)}`); return encodedBlob(content);
  });
  assert.equal(resolved[0].content,`${'x'.repeat(16000)}\nfinal expression\n`);
  assert.equal(p.files[0].content,undefined);
});
test('exact edits reject stale, ambiguous, overlapping and missing targets', async () => {
  for (const content of ['not there','old old','oooo']) assert.throws(() => applyExactEdits(content,[{old_text:content === 'oooo' ? 'oo' : 'old',new_text:'new'}]), /exactly once/);
  assert.throws(() => applyExactEdits('old',[{old_text:'old',new_text:'new'},{old_text:'old',new_text:'x'}]), /exactly once/);
  const file = {path:'file',edits:[{old_text:'old',new_text:'new'}]};
  for (const entries of [[],[{...entry('file','old'),mode:'120000'}]]) await assert.rejects(resolveFileChanges(entries,[file],()=>assert.fail('must not fetch unsafe file')), /existing regular file/);
});
test('blob decoder rejects invalid encodings, oversized/binary files, corrupt hash and invalid UTF-8', () => {
  const good = encodedBlob('hello'); const hash = gitBlobHash('hello');
  assert.equal(decodeBaseBlob(good,hash),'hello');
  assert.equal(decodeBaseBlob(encodedBlob('\ufeffhello'),gitBlobHash('\ufeffhello')),'\ufeffhello');
  for (const blob of [{...good,encoding:'utf-8'},{...good,size:1048577},{...good,size:3},{...good,content:'!!!!'},{encoding:'base64',size:1,content:'/w=='},encodedBlob('a\0b')]) assert.throws(() => decodeBaseBlob(blob,hash));
  assert.throws(() => decodeBaseBlob(good,'a'.repeat(40)), /hash mismatch/);
  assert.throws(() => applyExactEdits('x'.repeat(1048576),[{old_text:'x'.repeat(1048576),new_text:'y'.repeat(1048577)}]), /size limit/);
});
test('proposal rejects mixed content/edits, empty old text, NUL and excess edit bytes', () => {
  const invalid = [
    {path:'a',content:'x',edits:[]},
    {path:'a',edits:[{old_text:'',new_text:'x'}]},
    {path:'a',edits:[{old_text:'old',new_text:'x\0'}]},
    {path:'a',edits:[{old_text:'old',new_text:'x',extra:true}]},
    {path:'a',edits:[{old_text:'x',new_text:'y'.repeat(8000)}]},
  ];
  for (const file of invalid) assert.throws(() => validateProposal(proposal({files:[file]})));
});
test('workflow proposals remain valid data but publishing requires isolated release channel', async () => {
  for (const path of ['.github/workflows/update.yml','.GitHub/WorkFlows/UPDATE.YML']) {
    const p = proposal({files:[{path,content:'on: push'}]}); validateProposal(p);
    await assert.rejects(publishProposal(p,()=>assert.fail('must not contact remote')), /requires_isolated_release_channel/);
  }
});
test('PR response with raced head or changed target is not a verified publication', async () => {
  for (const change of [pr=>{pr.head.sha='f'.repeat(40);},pr=>{pr.base.ref='other';},pr=>{pr.base.repo.full_name='other/repo';},pr=>{pr.head.ref='other';}]) {
    const mock = remote();
    await assert.rejects(publishProposal(proposal(),async(...args)=>{
      const result=await mock.api(...args);
      if(args[0]==='POST' && args[1].endsWith('/pulls'))change(result);
      return result;
    }), /Pull request conflict/);
  }
});
test('branch drift after PR creation is a conflict, not a success receipt', async () => {
  const mock=remote(); let created=false;
  await assert.rejects(publishProposal(proposal(),async(...args)=>{
    if(created && args[1].includes('/git/ref/heads/ai-proposal/'))return {object:{sha:'f'.repeat(40)}};
    const result=await mock.api(...args);
    if(args[0]==='POST' && args[1].endsWith('/pulls'))created=true;
    return result;
  }), /Pull request conflict: branch changed/);
});
