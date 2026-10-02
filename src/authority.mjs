// Only public read endpoints are used. This binding contains no authority key.
export const AUTHORITY_ORIGIN='https://ai-commons-control.ai-commons-prototype.workers.dev';
const runtimeCache=new WeakMap();
export async function authorityStatus(env) {
  if(!env.CONTROL)return null;
  try {
    const r=await env.CONTROL.fetch(new Request(AUTHORITY_ORIGIN+'/v1/status',{signal:AbortSignal.timeout(3000)}));
    if(!r.ok)return null;const s=await r.json();
    return s.authority_origin===AUTHORITY_ORIGIN && Number.isSafeInteger(s.policy_version)?s:null;
  }catch{return null;}
}
export async function messageLimit(env, fallback=200) {
  if(!env.CONTROL)return fallback;
  const old=runtimeCache.get(env.CONTROL);
  if(old && old.until>Date.now())return old.limit;
  try {
    const r=await env.CONTROL.fetch(new Request(AUTHORITY_ORIGIN+'/v1/runtime',{signal:AbortSignal.timeout(3000)}));
    if(!r.ok)throw new Error();const s=await r.json();
    if(!Number.isSafeInteger(s.messages_per_day)||s.messages_per_day<0||s.messages_per_day>1000)throw new Error();
    runtimeCache.set(env.CONTROL,{limit:s.messages_per_day,until:Date.now()+60000});return s.messages_per_day;
  }catch{
    // Preserve a known pause/restriction while offline; never retain an increased limit.
    const limit=Math.min(old?.limit??fallback,fallback);
    runtimeCache.set(env.CONTROL,{limit,until:Date.now()+10000});return limit;
  }
}
