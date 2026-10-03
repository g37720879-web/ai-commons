import {appInstallationToken} from './github-setup.mjs';
import {REPOSITORY,ORIGIN,DAY,canonical,hash,b64,bytes,policy,hasRole,threshold,requireThat as check} from './protocol.mjs';

const ACCOUNT='3d7a0cc99335d3eb0734a7ea65b698b3',DB='83c69dff-3a36-4597-95d6-26b95596d965';
const base=`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
export async function provider(a,path,options={}) {
  check(a.env.CF_DEPLOY_TOKEN,'deployment_credential_missing',503);
  const j=await a.externalJson(base+path,{...options,headers:{...options.headers,Authorization:'Bearer '+a.env.CF_DEPLOY_TOKEN}});
  check(j.success===true,'provider_operation_failed',502);return j.result;
}
async function githubCredential(a){return a.env.GH_MAINTENANCE_TOKEN||await appInstallationToken(a);}
async function snapshot(a,label='scheduled') {
  const info=await provider(a,`/d1/database/${DB}/time_travel/bookmark`);
  check(typeof info.bookmark==='string' && info.bookmark.length<=200,'invalid_database_bookmark',502);
  const item={id:crypto.randomUUID(),created_at:Date.now(),bookmark:info.bookmark,digest:await hash(info.bookmark),label};
  await a.transaction(s=>{s.backups=(s.backups||[]).filter(x=>Date.now()-x.created_at<6*DAY).slice(-13);s.backups.push(item);});return item;
}
export async function executeOperations(a) {
  const op=await a.transaction(async s=>{
    s.operations ||= [];
    const running=s.operations.find(x=>x.status==='running');
    if(running){if(Date.now()-running.started_at<120000)return null;running.status='blocked';running.error_code=running.restore_attempted_at?'restore_outcome_unknown':'operation_outcome_unknown';return null;}
    const o=s.operations.find(x=>x.status==='pending');if(!o)return null;
    const role=['backup.create','resources.inspect'].includes(o.action)?'operator':'governor';
    const valid=new Set(o.approvals.filter(v=>v.policy_version===s.version && hasRole(s,v.key_id,[role],Date.now())).map(v=>v.key_id));
    if(o.policy_version!==s.version || valid.size<(role==='operator'?1:threshold(s,role,Date.now()))){o.status='blocked';o.error_code='operation_authority_changed';return null;}
    o.status='running';o.started_at=Date.now();return structuredClone(o);
  });
  if(!op)return;
  try {
    let result;
    if(op.action==='backup.create') {
      const item=await snapshot(a,'operator-request');result={backup_id:item.id,digest:item.digest,created_at:item.created_at,kind:'provider_time_travel_checkpoint'};
    } else if(op.action==='backup.restore') {
      const s=await a.state(),backup=s.backups.find(x=>x.id===op.target);
      check(backup && backup.digest===op.value && Date.now()-backup.created_at<6*DAY,'restore_snapshot_expired',409);
      const before=await snapshot(a,'before-restore');
      await a.transaction(s=>{const o=s.operations.find(x=>x.id===op.id);o.restore_attempted_at=Date.now();o.before_restore_backup_id=before.id;});
      await provider(a,`/d1/database/${DB}/time_travel/restore?bookmark=${encodeURIComponent(backup.bookmark)}`,{method:'POST',headers:{'Content-Type':'application/json'}});
      result={restored_backup_id:backup.id,undo_backup_id:before.id};
    } else if(op.action==='resources.inspect') {
      const names=['workers','database','billing_read'],paths=['/workers/account-settings',`/d1/database/${DB}`,'/subscriptions'];
      const values=await Promise.allSettled(paths.map(path=>provider(a,path)));
      result=Object.fromEntries(values.map((v,i)=>[names[i],v.status==='fulfilled'?{accessible:true}:{accessible:false,error_code:v.reason.code||'provider_unavailable'}]));
      result.spending_limit=0;result.automatic_paid_purchase=false;
    } else if(op.action==='repo.configure') {
      const credential=await githubCredential(a);
      const url=`https://api.github.com/repos/${REPOSITORY}/actions/permissions/workflow`,headers={Authorization:'Bearer '+credential,'User-Agent':'AI-Commons-Control','Content-Type':'application/json'};
      const response=await fetch(url,{method:'PUT',headers,body:JSON.stringify(op.value),redirect:'manual',signal:AbortSignal.timeout(8000)});check(response.status===204,'github_policy_write_'+response.status,502);
      const actual=await a.externalJson(url,{headers});check(actual.default_workflow_permissions===op.value.default_workflow_permissions && actual.can_approve_pull_request_reviews===op.value.can_approve_pull_request_reviews,'github_policy_readback_mismatch',502);
      result={repository:REPOSITORY,actions_policy:op.value};
    }
    await a.transaction(async s=>{const o=s.operations.find(x=>x.id===op.id);o.status='completed';o.completed_at=Date.now();o.result=result;await a.emit(s,'operation_completed',{operation:op.id,action:op.action,result});});
  } catch(error) {
    await a.transaction(async s=>{const o=s.operations.find(x=>x.id===op.id);o.status='blocked';o.error_code=o.restore_attempted_at?'restore_outcome_unknown':error.code||'provider_unavailable';await a.emit(s,'operation_blocked',{operation:op.id,action:op.action,error:o.error_code});});
  }
}
export async function scheduledOperations(a) {
  const s=await a.state(),now=Date.now();
  if(!hasRole(s,s.resident.key_id,['operator'],now))return;
  const failed=(s.operations||[]).filter(o=>o.action==='backup.create').at(-1);
  if(failed?.status==='blocked' && ['upstream_cloudflare_401','upstream_cloudflare_403'].includes(failed.error_code) && failed.policy_version===s.version && !failed.restore_attempted_at && (!s.backup_retry_checked || now-s.backup_retry_checked>=3600000)){
    await a.transaction(s=>{s.backup_retry_checked=now;});
    await a.residentCommand('operation.retry',failed.id,null,'Retry a denied checkpoint read after possible provider permission repair; never replay database restoration.',s.version);
  }
  if(!s.backup_checked || now-s.backup_checked>=policy(s).backup_interval_hours*3600000){
    await a.transaction(s=>{s.backup_checked=now;});
    await a.residentCommand('backup.create','forum',null,'Create a provider recovery checkpoint within the delegated no-spending envelope.',s.version);
  }
  if(!s.resources_checked || now-s.resources_checked>=DAY){
    await a.transaction(s=>{s.resources_checked=now;});
    await a.residentCommand('resources.inspect','forum',null,'Check actual worker, database and billing-read capabilities; do not purchase resources.',s.version);
  }
}
