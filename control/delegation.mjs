import {CONTROL_SCHEMA,policy,canonical,hash,activeRoles,hasRole,threshold,addApproval,requireThat as check} from './protocol.mjs';

export function releaseAuthorized(state,release,now) {
  const enough=(votes,role)=>new Set((votes||[]).filter(v=>v.policy_version===state.version && hasRole(state,v.key_id,[role],now)).map(v=>v.key_id)).size>=threshold(state,role,now);
  return enough(release.approvals,'reviewer') && (release.schema!==CONTROL_SCHEMA || enough(release.governor_approvals,'governor'));
}
export function publicOperation(o) {
  const {id,action,target,value,reason,status,created_at,policy_version,approvals,error_code,completed_at,result}=o;
  return {id,action,target,value,reason,status,created_at,policy_version,approvals,error_code,completed_at,result};
}
export async function delegationCommand(state,{body:b,keyId},now,emit) {
  state.delegation_votes ||= {};state.operations ||= [];state.backups ||= [];
  if(b.action==='policy.set') {
    const bounds={review_attempts_per_day:[1,12],message_ceiling:[0,1000],max_term_days:[1,365],backup_interval_hours:[6,168]};
    check(b.target==='allow_permanent_roles'?typeof b.value==='boolean':bounds[b.target] && Number.isSafeInteger(b.value) && b.value>=bounds[b.target][0] && b.value<=bounds[b.target][1],'invalid_delegated_policy');
    const id=await hash(canonical({version:state.version,target:b.target,value:b.value}));const vote=state.delegation_votes[id] ||= {approvals:[]};
    if(addApproval(vote,state,keyId,'governor',now)){state.policy={...policy(state),[b.target]:b.value};state.version++;await emit(state,'policy_changed',{target:b.target,value:b.value,key_id:keyId,reason:b.reason},now);}
  } else if(b.action==='bootstrap.retire') {
    check(b.target===state.resident.key_id && b.value===null,'invalid_bootstrap_retirement');
    const roles=activeRoles(state,now).filter(r=>r.key_id!==state.resident.key_id);
    check(['governor','reviewer','operator'].every(role=>roles.some(r=>r.role===role && r.consent_hash)),'consenting_successors_required',409);
    const vote=state.delegation_votes['retire:'+state.version] ||= {approvals:[]};
    if(addApproval(vote,state,keyId,'governor',now)){
      for(const role of state.roles)if(role.key_id===state.resident.key_id && !role.revoked_at)role.revoked_at=now;
      state.bootstrap_retired_at=now;state.version++;await emit(state,'bootstrap_retired',{key_id:keyId,reason:b.reason,successor_key_ids:[...new Set(roles.map(r=>r.key_id))]},now);
    }
  } else if(['backup.create','backup.restore','resources.inspect','repo.configure'].includes(b.action)) {
    if(['backup.create','resources.inspect'].includes(b.action))check(b.target==='forum' && b.value===null,'invalid_operation_target');
    if(b.action==='backup.restore')check(state.backups.some(x=>x.id===b.target && x.digest===b.value && now-x.created_at<6*86400000),'restore_snapshot_not_available',409);
    if(b.action==='repo.configure'){
      check(b.target==='actions_policy' && b.value && Object.keys(b.value).length===2 && ['read','write'].includes(b.value.default_workflow_permissions) && typeof b.value.can_approve_pull_request_reviews==='boolean','invalid_repository_policy');
    }
    const id=await hash(canonical({version:state.version,action:b.action,target:b.target,value:b.value,...(['backup.create','resources.inspect'].includes(b.action)?{request:b.id}:{})}));
    let op=state.operations.find(x=>x.id===id);
    if(!op){check(state.operations.filter(x=>['pending','voting','running'].includes(x.status)).length<12,'operation_queue_full',409);op={id,action:b.action,target:b.target,value:b.value,reason:b.reason,status:'voting',created_at:now,policy_version:state.version,approvals:[]};state.operations=state.operations.filter(x=>['pending','voting','running'].includes(x.status)).concat(state.operations.filter(x=>x.status==='blocked').slice(-12),state.operations.filter(x=>x.status==='completed').slice(-8),op);}
    if(op.status==='completed')return true;
    const role=['backup.create','resources.inspect'].includes(b.action)?'operator':'governor';
    if(role==='operator'){op.approvals=[{key_id:keyId,policy_version:state.version}];op.status='pending';}
    else if(addApproval(op,state,keyId,role,now))op.status='pending';
    await emit(state,'operation_authorized',{operation:id,action:b.action,status:op.status,key_id:keyId},now);
  } else if(b.action==='operation.retry') {
    const op=state.operations.find(x=>x.id===b.target);check(op && op.status==='blocked' && b.value===null,'operation_not_retryable',409);
    check(!op.restore_attempted_at,'restore_outcome_requires_reconciliation',409);
    check(op.policy_version===state.version,'operation_requires_new_authorization',409);op.status='pending';delete op.error_code;await emit(state,'operation_retry_requested',{operation:op.id,key_id:keyId},now);
  } else return false;
  return true;
}
