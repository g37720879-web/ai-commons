const ORIGIN='https://ai-commons-control.ai-commons-prototype.workers.dev';
const API='https://api.cloudflare.com/client/v4/accounts/3d7a0cc99335d3eb0734a7ea65b698b3/workers/scripts/ai-commons-control/deployments';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export class Watchdog {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async cf(options={}) {
    const r=await fetch(API,{...options,headers:{...options.headers,Authorization:'Bearer '+this.env.CF_DEPLOY_TOKEN},redirect:'manual',signal:AbortSignal.timeout(8000)});
    if(!r.ok)throw new Error('provider_'+r.status);const j=await r.json();if(!j.success)throw new Error('provider_rejected');return j.result;
  }
  async current(){const j=await this.cf();const v=j.deployments?.[0]?.versions;if(v?.length!==1||v[0].percentage!==100)throw new Error('split_deployment');return v[0].version_id;}
  async tick() {
    let w=await this.ctx.storage.get('window');if(!w||!['armed','checking','rollback_pending'].includes(w.status))return;
    try {
      const current=await this.current();
      if(current===w.previous_version && !w.seen_new){if(Date.now()>w.deadline)w.status='expired_without_activation';await this.ctx.storage.put('window',w);return;}
      if(current===w.previous_version && w.seen_new){w.status='rolled_back';await this.ctx.storage.put('window',w);return;}
      if(![w.previous_version,w.target_version].includes(current)){w.status='blocked';w.error='unrelated_deployment';await this.ctx.storage.put('window',w);return;}
      if(w.status!=='rollback_pending'){
        w.seen_new=true;w.status='checking';
        try {
          const r=await fetch(ORIGIN+'/v1/status',{redirect:'manual',signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('controller_unavailable');
          const s=await r.json();if(s.control_release_id!==w.release_id||s.ledger_head?.sequence<w.checkpoint.sequence)throw new Error('checkpoint_missing');
          const response=await fetch(ORIGIN+'/v1/events?after='+w.checkpoint.sequence,{redirect:'manual',signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error('ledger_unavailable');const events=await response.json();
          if(s.ledger_head.sequence===w.checkpoint.sequence?s.ledger_head.hash!==w.checkpoint.hash:events.events?.[0]?.previous_hash!==w.checkpoint.hash)throw new Error('ledger_changed');
          w.health_passes++;w.failures=0;if(w.health_passes>=2)w.status='healthy';
        }catch {w.failures++;if(w.failures>=2||Date.now()>w.deadline)w.status='rollback_pending';}
      }
      if(w.status==='rollback_pending'){
        if(current===w.target_version)await this.cf({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({strategy:'percentage',versions:[{version_id:w.previous_version,percentage:100}]})});
        w.status='rolled_back';w.rolled_back_at=Date.now();
      }
      await this.ctx.storage.put('window',w);
    }catch(error){w.last_provider_error=error.message;await this.ctx.storage.put('window',w);}
  }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/v1/status' && request.method==='GET'){
      const w=await this.ctx.storage.get('window');return json({name:'AI Commons independent control watchdog',credential_configured:!!this.env.CF_DEPLOY_TOKEN,watchdog_status:w?.status||'idle',release_id:w?.release_id,previous_version:w?.previous_version,target_version:w?.target_version,last_provider_error:w?.last_provider_error,database_restored:false,authority_storage_restored:false});
    }
    if(path==='/internal/tick'){await this.ctx.blockConcurrencyWhile(()=>this.tick());return json({processed:true});}
    if(path==='/internal/watch' && request.method==='POST'){
      if(!this.env.WATCHDOG_TOKEN || request.headers.get('Authorization')!=='Bearer '+this.env.WATCHDOG_TOKEN)return json({error:'unauthorized'},403);
      const text=await request.text();if(text.length>3000)return json({error:'too_large'},413);let b;try{b=JSON.parse(text);}catch{return json({error:'invalid_json'},400);}if(!b || typeof b!=='object')return json({error:'invalid_window'},400);
      if(!/^[a-f0-9]{64}$/.test(b.release_id)||![b.previous_version,b.target_version].every(x=>/^[a-f0-9-]{36}$/.test(x))||b.previous_version===b.target_version||!Number.isSafeInteger(b.checkpoint?.sequence)||b.checkpoint.sequence<0||!Number.isSafeInteger(b.deadline)||b.deadline<=Date.now()||b.deadline>Date.now()+1200000||!/^[a-f0-9]{64}$/.test(b.checkpoint?.hash||''))return json({error:'invalid_window'},400);
      return this.ctx.blockConcurrencyWhile(async()=>{const old=await this.ctx.storage.get('window');if(old && ['armed','checking','rollback_pending'].includes(old.status)){if(old.release_id===b.release_id && old.target_version===b.target_version && old.previous_version===b.previous_version)return json({armed:true,replayed:true});return json({error:'another_upgrade_in_progress'},409);}await this.ctx.storage.put('window',{...b,status:'armed',health_passes:0,failures:0});return json({armed:true});});
    }
    return json({error:'not_found'},404);
  }
}
export default {
  fetch(request,env){const path=new URL(request.url).pathname;if(path!=='/v1/status' && path!=='/internal/watch')return json({error:'not_found'},404);return env.WATCHDOG.get(env.WATCHDOG.idFromName('control-recovery')).fetch(request);},
  scheduled(event,env,ctx){ctx.waitUntil(env.WATCHDOG.get(env.WATCHDOG.idFromName('control-recovery')).fetch(new Request('https://watchdog.internal/internal/tick')));}
};
