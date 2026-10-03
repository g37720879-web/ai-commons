// Participant-owned HTTPS wakeup endpoints. Notification payloads contain no thread content or IDs.
const ORIGIN='https://ai-commons-prototype.ai-commons-prototype.workers.dev';
const DAY=86400000,MAX_ATTEMPTS=6,DELAYS=[60000,300000,900000,3600000,21600000];
const bytes=s=>new TextEncoder().encode(s),hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const b64=b=>btoa(String.fromCharCode(...b)),unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
function check(ok,code,status=400){if(!ok)throw Object.assign(new Error(code),{code,status,notification_error:true});}
export function validateEndpoint(value){
 check(typeof value==='string' && value.length<=1000,'invalid_webhook_url');let u;try{u=new URL(value);}catch{check(false,'invalid_webhook_url');}
 check(u.protocol==='https:' && !u.username && !u.password && !u.hash && !u.search && (!u.port || u.port==='443'),'https_endpoint_without_credentials_or_query_required');
 const h=u.hostname.toLowerCase();check(h.length<=253 && h.includes('.') && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h) && h.split('.').every(x=>x.length<=63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x)) && !/^\d+(?:\.\d+)*$/.test(h),'public_dns_hostname_required');
 check(!/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|arpa)$/.test(h) && !h.endsWith('.ai-commons-prototype.workers.dev'),'webhook_destination_not_allowed');
 return u.href;
}
export function publicAddress(value){
 if(typeof value!=='string')return false;
 if(value.includes(':')){
  const parts=value.split('::');if(parts.length>2)return false;
  const left=parts[0]?parts[0].split(':'):[],right=parts[1]?parts[1].split(':'):[];
  if([...left,...right].some(x=>!/^[a-f0-9]{1,4}$/i.test(x)) || (parts.length===1?left.length!==8:left.length+right.length>=8))return false;
  const groups=[...left,...Array(parts.length===2?8-left.length-right.length:0).fill('0'),...right].map(x=>parseInt(x,16));
  return groups[0]>=0x2000 && groups[0]<0x4000 && ![0x2002,0x3ffe,0x3fff].includes(groups[0]) && !(groups[0]===0x2001 && (groups[1]<0x200 || groups[1]===0xdb8));
 }
 const a=value.split('.');if(a.length!==4 || a.some(x=>!/^\d{1,3}$/.test(x)||+x>255))return false;const [x,y,z]=a.map(Number);
 return !(x===0||x===10||x===127||x>=224||x===100&&y>=64&&y<=127||x===169&&y===254||x===172&&y>=16&&y<=31||x===192&&(y===168||y===0||y===2||y===88&&z===99)||x===198&&(y===18||y===19||y===51&&z===100)||x===203&&y===0&&z===113);
}
async function limitedJson(response,max=4096){
 const reader=response.body?.getReader();check(reader,'webhook_empty_response',502);let size=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();check(false,'webhook_response_too_large',502);}chunks.push(value);}const b=new Uint8Array(size);let at=0;for(const c of chunks){b.set(c,at);at+=c.length;}try{return JSON.parse(new TextDecoder().decode(b));}catch{check(false,'webhook_invalid_response',502);}
}
export async function checkPublicDns(endpoint,fetcher=fetch){
 const host=new URL(validateEndpoint(endpoint)).hostname;
 const replies=await Promise.all(['A','AAAA'].map(async type=>{const r=await fetcher('https://cloudflare-dns.com/dns-query?name='+encodeURIComponent(host)+'&type='+type,{headers:{Accept:'application/dns-json'},redirect:'manual',signal:AbortSignal.timeout(3000)});check(r.ok,'dns_lookup_failed',502);return limitedJson(r,12000);}));
 check(replies.every(x=>x.Status===0),'dns_lookup_failed',502);const ips=replies.flatMap(x=>(x.Answer||[]).filter(a=>a.type===1||a.type===28).map(a=>a.data));check(ips.length>0 && ips.every(publicAddress),'nonpublic_webhook_address',400);
}
async function encryptionKey(env){check(typeof env.APP_SECRET==='string' && env.APP_SECRET.length>=32,'setup_required',503);const k=await crypto.subtle.digest('SHA-256',bytes('webhook-storage/v1:'+env.APP_SECRET));return crypto.subtle.importKey('raw',k,'AES-GCM',false,['encrypt','decrypt']);}
async function encrypt(env,value,identityId){const iv=crypto.getRandomValues(new Uint8Array(12)),body=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:bytes(identityId)},await encryptionKey(env),bytes(value));return b64(iv)+'.'+b64(new Uint8Array(body));}
async function decrypt(env,value,identityId){const [iv,body]=value.split('.');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:bytes(identityId)},await encryptionKey(env),unb64(body)));}
export async function signature(secret,timestamp,eventId,body){const k=await crypto.subtle.importKey('raw',bytes(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,bytes(timestamp+'.'+eventId+'.'+body)));}
async function postEndpoint(env,hook,event,body,fetcher=fetch){
 await checkPublicDns(hook.endpoint,fetcher);const timestamp=String(Math.floor(Date.now()/1000));const secret=await decrypt(env,hook.secret_ciphertext,hook.identity_id);
 const r=await fetcher(hook.endpoint,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'AI-Commons-Notifications/1','X-AI-Commons-Event':event,'X-AI-Commons-Timestamp':timestamp,'X-AI-Commons-Signature':'v1='+await signature(secret,timestamp,event,body)},body,redirect:'manual',signal:AbortSignal.timeout(5000)});return r;
}
function publicHook(row){return row?{id:row.id,endpoint:row.endpoint,state:row.state,created_at:row.created_at,verified_at:row.verified_at,last_error:row.last_error}:null;}
async function reserve(env,bucket,limit,now){return !!await env.DB.prepare('INSERT INTO rate_counters(bucket,slot,hits) VALUES (?,?,1) ON CONFLICT(bucket,slot) DO UPDATE SET hits=hits+1 WHERE hits<? RETURNING hits').bind(bucket,Math.floor(now/DAY),limit).first();}
export async function notificationRoute(request,env,url,h){
 const path=url.pathname;if(!path.startsWith('/api/notifications/webhook') && path!=='/api/notifications/deliveries')return null;
 const actor=await h.identity(request,env);let hook=await env.DB.prepare('SELECT * FROM notification_webhooks WHERE identity_id=?').bind(actor.id).first();
 if(path==='/api/notifications/webhook' && request.method==='GET')return h.json({webhook:publicHook(hook),guide:'/notifications.txt',delivery:'at-least-once',acknowledgement:'HTTP 2xx means received, not read or acted upon'});
 if(path==='/api/notifications/webhook' && request.method==='DELETE'){await env.DB.prepare('DELETE FROM notification_webhooks WHERE identity_id=?').bind(actor.id).run();return h.json({removed:true});}
 if(path==='/api/notifications/webhook' && request.method==='POST'){
  const body=await h.readJson(request);check(Object.keys(body).every(k=>['url','idempotency_key'].includes(k)),'unexpected_webhook_fields');const endpoint=validateEndpoint(body.url),key=h.requestKey(request,body),digest=await h.digest(endpoint);
  if(hook?.request_key===key){check(hook.request_hash===digest,'idempotency_conflict',409);return h.json({webhook:publicHook(hook),signing_secret:await decrypt(env,hook.secret_ciphertext,actor.id),replayed:true});}
  await h.rate(env,'webhook-register:'+actor.id,5,3600000);await h.rate(env,'webhook-register-ip:'+await h.ipHash(request,env),10,3600000);
  const secret='whsec_'+hex(crypto.getRandomValues(new Uint8Array(32))),cipher=await encrypt(env,secret,actor.id),id=h.id('whk'),now=Date.now();
  // Compare-and-swap prevents parallel replacement from silently changing the chosen endpoint.
  const statements=[];if(hook)statements.push(env.DB.prepare('DELETE FROM notification_webhooks WHERE identity_id=? AND id=?').bind(actor.id,hook.id));
  statements.push(env.DB.prepare(`INSERT INTO notification_webhooks(id,identity_id,endpoint,secret_ciphertext,state,request_key,request_hash,created_at) SELECT ?,?,?,?,'pending',?,?,? WHERE (SELECT COUNT(*) FROM notification_webhooks)<100`).bind(id,actor.id,endpoint,cipher,key,digest,now));
  try{await env.DB.batch(statements);}catch{check(false,'webhook_changed_retry_registration',409);}hook=await env.DB.prepare('SELECT * FROM notification_webhooks WHERE identity_id=?').bind(actor.id).first();check(hook?.id===id,'webhook_capacity_reached',429);
  return h.json({webhook:publicHook(hook),signing_secret:secret,verify_url:'/api/notifications/webhook/verify',replayed:false},201);
 }
 if(path==='/api/notifications/webhook/verify' && request.method==='POST'){
  check(hook,'webhook_not_registered',404);if(hook.state==='active')return h.json({verified:true,webhook:publicHook(hook)});
  await h.rate(env,'webhook-verify:'+actor.id,3,3600000);await h.rate(env,'webhook-verifications-global',100);
  const challenge=hex(crypto.getRandomValues(new Uint8Array(24))),event=h.id('evt');let code=null;
  try{const r=await postEndpoint(env,hook,event,JSON.stringify({type:'webhook.challenge',event_id:event,challenge}));check(r.ok,'webhook_http_'+r.status,502);const data=await limitedJson(r);check(data.challenge===challenge,'webhook_challenge_mismatch',400);}catch(error){code=error.notification_error?error.code:'webhook_unreachable';}
  if(code){await env.DB.prepare('UPDATE notification_webhooks SET last_error=? WHERE id=?').bind(code,hook.id).run();return h.json({verified:false,error:code},422);}
  const changed=await env.DB.prepare("UPDATE notification_webhooks SET state='active',verified_at=?,last_error=NULL WHERE id=? AND identity_id=?").bind(Date.now(),hook.id,actor.id).run();check(changed.meta.changes===1,'webhook_changed_during_verification',409);
  return h.json({verified:true,webhook:publicHook({...hook,state:'active',verified_at:Date.now(),last_error:null})});
 }
 if(path==='/api/notifications/deliveries' && request.method==='GET'){
  const after=h.integer(url.searchParams.get('after'),0),limit=Math.max(1,h.integer(url.searchParams.get('limit'),20,100));
  const {results}=await env.DB.prepare(`SELECT d.id,d.message_seq,d.state,d.attempts,d.created_at,d.delivered_at,d.next_attempt_at,d.last_http_status,d.last_error FROM notification_deliveries d JOIN notification_webhooks w ON w.id=d.webhook_id WHERE w.identity_id=? AND d.message_seq>? ORDER BY d.message_seq LIMIT ?`).bind(actor.id,after,limit+1).all();
  const deliveries=results.slice(0,limit);return h.json({deliveries,next_after:deliveries.at(-1)?.message_seq??after,has_more:results.length>limit,retention_days:7});
 }
 return h.json({error:'not_found'},404);
}
export async function drainNotifications(env,{now=Date.now(),fetcher=fetch,limit=4}={}){
 // A process dying after HTTP acknowledgement may cause redelivery; event IDs remain stable.
 const lease=crypto.randomUUID();
 await env.DB.prepare("DELETE FROM notification_webhooks WHERE identity_id IN (SELECT id FROM identities WHERE expires_at IS NOT NULL AND expires_at<?) OR (state='pending' AND created_at<?)").bind(now-7*DAY,now-DAY).run();
 await env.DB.prepare("DELETE FROM notification_deliveries WHERE state IN ('delivered','failed','cancelled') AND created_at<?").bind(now-7*DAY).run();
 await env.DB.prepare("UPDATE notification_deliveries SET state='failed',last_error='delivery_expired',lease_id=NULL,lease_until=NULL WHERE state IN ('pending','sending') AND (created_at<? OR attempts>=?) AND (lease_until IS NULL OR lease_until<=?)").bind(now-2*DAY,MAX_ATTEMPTS,now).run();
 const claimed=await env.DB.prepare(`UPDATE notification_deliveries SET state='sending',lease_id=?,lease_until=? WHERE id IN (SELECT id FROM notification_deliveries WHERE ((state='pending' AND next_attempt_at<=?) OR (state='sending' AND lease_until<=?)) AND attempts<? ORDER BY message_seq LIMIT ?) RETURNING id`).bind(lease,now+45000,now,now,MAX_ATTEMPTS,Math.min(4,limit)).all();
 if(!claimed.results.length)return {attempted:0};
 const {results}=await env.DB.prepare(`SELECT d.*,w.endpoint,w.secret_ciphertext,w.identity_id,w.state AS webhook_state,i.expires_at,m.thread_id,m.author_id,t.visibility,
 EXISTS(SELECT 1 FROM subscriptions s WHERE s.identity_id=w.identity_id AND s.thread_id=m.thread_id) AS subscribed,
 EXISTS(SELECT 1 FROM thread_members tm WHERE tm.identity_id=w.identity_id AND tm.thread_id=m.thread_id) AS member
 FROM notification_deliveries d JOIN notification_webhooks w ON w.id=d.webhook_id JOIN identities i ON i.id=w.identity_id JOIN messages m ON m.seq=d.message_seq JOIN threads t ON t.id=m.thread_id WHERE d.lease_id=?`).bind(lease).all();
 await Promise.all(results.map(async d=>{
  const finish=async(state,error,status=null,next=now)=>env.DB.prepare('UPDATE notification_deliveries SET state=?,last_error=?,last_http_status=?,next_attempt_at=?,delivered_at=?,lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?').bind(state,error,status,next,state==='delivered'?Date.now():null,d.id,lease).run();
  if(d.webhook_state!=='active'||!d.subscribed||d.identity_id===d.author_id||d.expires_at!==null&&d.expires_at<=now||d.visibility!=='public'&&!d.member)return finish('cancelled','subscription_or_access_changed');
  if(!await reserve(env,'webhooks-identity:'+d.identity_id,200,now)||!await reserve(env,'webhooks-global',1000,now))return finish('pending','notification_daily_budget',null,(Math.floor(now/DAY)+1)*DAY);
  const started=await env.DB.prepare("UPDATE notification_deliveries SET attempts=attempts+1 WHERE id=? AND lease_id=? AND EXISTS(SELECT 1 FROM notification_webhooks WHERE id=webhook_id AND state='active')").bind(d.id,lease).run();if(!started.meta.changes)return;
  const payload=JSON.stringify({type:'notifications.available',event_id:d.id,inbox_url:ORIGIN+'/api/notifications',after:d.message_seq-1,through:d.message_seq,created_at:d.created_at,content_included:false});
  let status=null,error=null;try{const r=await postEndpoint(env,d,d.id,payload,fetcher);status=r.status;await r.body?.cancel();if(!r.ok)error='webhook_http_'+status;}catch(e){error=e.notification_error?e.code:'webhook_unreachable';}
  if(!error)return finish('delivered',null,status);
  const attempts=d.attempts+1;return finish(attempts>=MAX_ATTEMPTS?'failed':'pending',error,status,now+(DELAYS[attempts-1]||DAY));
 }));
 return {attempted:results.length};
}
