// This file runs only from the pinned trusted harness, never from candidate source.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ORIGIN,REPOSITORY,allowedReleasePath,allowedControlPath,releaseSchema,CONTROL_SCHEMA,hash,validateArtifact} from './protocol.mjs';

const check=(ok,message)=>{if(!ok)throw new Error(message);};
async function api(path,method='GET',body) {
  const r=await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`,{method,headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`,'User-Agent':'AI-Commons-release-harness','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});
  check(r.ok,`github_${r.status}`);return r.json();
}
async function select() {
  const main=(await api('/git/ref/heads/main')).object.sha;
  const prs=await api('/pulls?state=open&base=main&per_page=50');
  let selected;
  for(const p of prs){
    if(p.head.repo?.full_name!==REPOSITORY || !/^ai-proposal\/gov_[a-f0-9]{32}$/.test(p.head.ref) || p.draft)continue;
    const comparison=await api(`/compare/${main}...${p.head.sha}`);
    if(comparison.status!=='ahead' || comparison.merge_base_commit?.sha!==main || comparison.total_commits>10 || !comparison.files?.length || comparison.files.length>20 || comparison.files.some(f=>!(allowedReleasePath(f.filename)||allowedControlPath(f.filename)) || !['added','modified','removed'].includes(f.status)))continue;
    try{releaseSchema(comparison.files.map(f=>f.filename));}catch{continue;}
    selected={base:main,candidate:p.head.sha,pr:p.number};break;
  }
  await appendFile(process.env.GITHUB_OUTPUT,`found=${!!selected}\nbase=${selected?.base||''}\ncandidate=${selected?.candidate||''}\npr=${selected?.pr||''}\n`);
  console.log(JSON.stringify(selected||{eligible_candidate:false}));
}
async function bundle() {
  const root=resolve(process.env.CANDIDATE_DIR||'candidate'),base=process.env.BASE_COMMIT,candidate=process.env.CANDIDATE_COMMIT;
  check(/^[a-f0-9]{40}$/.test(base||'') && /^[a-f0-9]{40}$/.test(candidate||''),'invalid_commits');
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:2000000}).trimEnd();
  check(git('rev-parse','HEAD')===candidate,'candidate_checkout_mismatch');
  const files=git('diff','--name-only',base,candidate).split('\n');check(files.length<=20 && files.every(p=>allowedReleasePath(p)||allowedControlPath(p)),'protected_release_path');
  // Refuse symlinks and submodules before the trusted compiler reads imports.
  const tree=git('ls-tree','-r',candidate).split('\n');check(tree.every(line=>line.startsWith('100644 ')||line.startsWith('100755 ')),'non_regular_candidate_file');
  const diff=git('diff','--no-ext-diff','--no-renames',base,candidate,'--',...files);check(Buffer.byteLength(diff)<=12000,'diff_too_large');
  const schema=releaseSchema(files);
  await mkdir('release-artifact',{recursive:true});
  const executable=resolve(new URL('../node_modules/.bin/esbuild',import.meta.url).pathname);
  execFileSync(executable,[`${root}/${schema===CONTROL_SCHEMA?'control':'src'}/worker.mjs`,'--bundle','--format=esm','--platform=browser','--target=es2022','--outfile=release-artifact/worker.mjs'],{stdio:'inherit'});
  const code=await readFile('release-artifact/worker.mjs','utf8');
  const artifact={schema,repository:REPOSITORY,base_commit:base,candidate_commit:candidate,code,artifact_sha256:await hash(code),changed_files:files,diff};
  await validateArtifact(artifact);await writeFile('release-artifact/release.json',JSON.stringify(artifact));
  console.log(JSON.stringify({candidate,artifact_sha256:artifact.artifact_sha256,changed_files:files}));
}
async function oidc() {
  const url=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);url.searchParams.set('audience',ORIGIN);
  const response=await fetch(url,{headers:{Authorization:`Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(10000)});check(response.ok,'oidc_unavailable');return (await response.json()).value;
}
async function send(path,body) {
  const token=await oidc();
  const response=await fetch(ORIGIN+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
  const data=await response.json();return {ok:response.ok,status:response.status,data};
}
async function publish() {
  // No eval, shell, package install, candidate checkout or imported artifact code here.
  const artifact=JSON.parse(await readFile('incoming/release.json','utf8'));
  await validateArtifact(artifact);
  const submission=await send('/v1/releases',artifact);check(submission.ok,submission.data.error||'submission_failed');
  const id=submission.data.id;
  console.log(JSON.stringify({release_id:id,controller_status:submission.data.status,credentials_in_controller_only:true}));
  await writeFile('publisher-receipt.json',JSON.stringify(submission.data,null,2));
  const status=await (await fetch(`${ORIGIN}/v1/status`,{redirect:'error',signal:AbortSignal.timeout(10000)})).json();
  if(!status.deployment_credential_configured){await appendFile(process.env.GITHUB_STEP_SUMMARY,`Checked artifact ${id} delivered to the isolated controller. Deployment waits for its Cloudflare service token. No main update or deployment occurred.\n`);return;}
  for(let attempt=0;attempt<40;attempt++){
    const list=await (await fetch(`${ORIGIN}/v1/releases`,{redirect:'error',signal:AbortSignal.timeout(10000)})).json();
    const release=list.releases?.find(r=>r.id===id);
    if(release?.status==='approved'){
      const accepted=await send(`/v1/releases/${id}/accept`,{});check(accepted.ok,accepted.data.error||'acceptance_failed');
      const main=await api('/git/ref/heads/main');check(main.object.sha===artifact.base_commit,'main_changed_after_acceptance');
      // The candidate descends from the exact approved base; GitHub rejects a concurrent divergent update.
      await api('/git/refs/heads/main','PATCH',{sha:artifact.candidate_commit,force:false});
      await appendFile(process.env.GITHUB_STEP_SUMMARY,`Release ${id} accepted under policy ${accepted.data.accepted_policy_version}; main advanced to ${artifact.candidate_commit}. The independent controller completes deployment and health/rollback checks.\n`);return;
    }
    if(release?.decision?.decision==='defer'){await appendFile(process.env.GITHUB_STEP_SUMMARY,`Release ${id} awaits further authorized review. No deployment.\n`);return;}
    await new Promise(resolve=>setTimeout(resolve,15000));
  }
  await appendFile(process.env.GITHUB_STEP_SUMMARY,`Release ${id} remains queued for review. No main update or deployment. A later scheduled run can continue.\n`);
}
const mode=process.argv[2];
try{if(mode==='select')await select();else if(mode==='bundle')await bundle();else if(mode==='publish')await publish();else throw new Error('unknown_mode');}
catch(error){console.error(JSON.stringify({error:String(error.message).slice(0,160)}));process.exitCode=1;}
