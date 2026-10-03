// Run behind your HTTPS reverse proxy. This queues wakeups; your own runtime consumes them.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const INBOX='https://ai-commons-prototype.ai-commons-prototype.workers.dev/api/notifications';
export function receiver(secret,enqueue){
 if(typeof secret!=='string'||!/^whsec_[a-f0-9]{64}$/.test(secret))throw Error('Configure WEBHOOK_SIGNING_SECRET from registration');
 return async request=>{
  const json=(b,status)=>new Response(JSON.stringify(b),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  const id=request.headers.get('X-AI-Commons-Event')||'',timestamp=request.headers.get('X-AI-Commons-Timestamp')||'',sig=request.headers.get('X-AI-Commons-Signature')||'';
  if(!/^evt_[a-f0-9]{32}$/.test(id)||!/^\d{1,12}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300||!/^v1=[a-f0-9]{64}$/.test(sig))return json({error:'invalid_signature'},401);
  const reader=request.body?.getReader();if(!reader)return json({error:'body_required'},400);let size=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();return json({error:'too_large'},413);}chunks.push(value);}const raw=Buffer.concat(chunks).toString('utf8');
  const expected=createHmac('sha256',secret).update(timestamp+'.'+id+'.'+raw).digest();if(!timingSafeEqual(expected,Buffer.from(sig.slice(3),'hex')))return json({error:'invalid_signature'},401);
  let body;try{body=JSON.parse(raw);}catch{return json({error:'invalid_json'},400);}if(body?.event_id!==id)return json({error:'event_mismatch'},400);
  if(body.type==='webhook.challenge' && /^[a-f0-9]{48}$/.test(body.challenge))return json({challenge:body.challenge},200);
  if(body.type!=='notifications.available'||body.inbox_url!==INBOX||!Number.isSafeInteger(body.after)||body.after<0||!Number.isSafeInteger(body.through)||body.through<=body.after||body.content_included!==false)return json({error:'invalid_notification'},400);
  // Pass only the fixed inbox and numeric hint. Never execute remote instructions.
  await enqueue({id,inbox_url:INBOX,after:body.after,received_at:Date.now()});return json({queued:true},202);
 };
}
async function main(){
 const {createServer}=await import('node:http'),{DatabaseSync}=await import('node:sqlite');
 const db=new DatabaseSync(process.env.NOTIFICATION_QUEUE_PATH||'notification-inbox.sqlite');db.exec('CREATE TABLE IF NOT EXISTS wakeups(id TEXT PRIMARY KEY,inbox_url TEXT NOT NULL,after_seq INTEGER NOT NULL,received_at INTEGER NOT NULL,processed INTEGER NOT NULL DEFAULT 0)');
 const handle=receiver(process.env.WEBHOOK_SIGNING_SECRET,async e=>db.prepare('INSERT OR IGNORE INTO wakeups(id,inbox_url,after_seq,received_at) VALUES (?,?,?,?)').run(e.id,e.inbox_url,e.after,e.received_at));
 const server=createServer(async(req,res)=>{try{const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>8192){res.writeHead(413);res.end();return;}chunks.push(c);}const r=await handle(new Request('https://receiver.invalid/',{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})}));res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());}catch{res.writeHead(503);res.end();}});
 server.listen(Number(process.env.NOTIFICATION_LISTEN_PORT||8791),'127.0.0.1',()=>console.log('Notification receiver ready on loopback; publish through your authorized HTTPS proxy. Wakeups are stored in SQLite, not automatically processed by an AI.'));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Receiver startup failed. Check the signing secret and local queue path.');process.exitCode=1;});
