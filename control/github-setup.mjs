import {ORIGIN,REPOSITORY,bytes,b64,hash,requireThat as check} from './protocol.mjs';
const owner=REPOSITORY.split('/')[0];
const html=(text,status=200)=>new Response(text,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'"}});
const escape=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const page=body=>html('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AI Commons GitHub connection</title><main>'+body+'</main>');
function der(tag,body){const size=body.length,length=size<128?[size]:size<256?[129,size]:size<65536?[130,size>>8,size&255]:[131,size>>16,(size>>8)&255,size&255];return new Uint8Array([tag,...length,...body]);}
export function privateKeyDer(pem){
 check(typeof pem==='string' && /-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem),'invalid_app_private_key',502);
 const value=Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,'')),x=>x.charCodeAt(0));
 if(pem.includes('BEGIN PRIVATE KEY'))return value;
 const algorithm=[48,13,6,9,42,134,72,134,247,13,1,1,1,5,0];
 return der(48,new Uint8Array([2,1,0,...algorithm,...der(4,value)]));
}
export async function appJwt(credentials,now=Date.now()){
 const key=await crypto.subtle.importKey('pkcs8',privateKeyDer(credentials.pem),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const time=Math.floor(now/1000),input=b64(bytes(JSON.stringify({alg:'RS256',typ:'JWT'})))+'.'+b64(bytes(JSON.stringify({iat:time-30,exp:time+540,iss:String(credentials.id)})));
 return input+'.'+b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,bytes(input))));
}
export async function appInstallationToken(a){
 const stored=await a.ctx.storage.get('github_app_credentials');
 const c=stored?.installation_id?stored:{id:a.env.GH_APP_ID,installation_id:a.env.GH_INSTALLATION_ID,pem:a.env.GH_APP_PRIVATE_KEY};
 check(c.id && c.installation_id && c.pem,'github_maintenance_identity_missing',503);
 const jwt=await appJwt(c),j=await a.externalJson(`https://api.github.com/app/installations/${c.installation_id}/access_tokens`,{method:'POST',headers:{Authorization:'Bearer '+jwt,'User-Agent':'AI-Commons-Control','Content-Type':'application/json'},body:JSON.stringify({repositories:['ai-commons']})});
 check(typeof j.token==='string','github_installation_token_missing',502);return j.token;
}
export async function reconcileGithubInstallation(a){
 const existing=await a.ctx.storage.get('github_app_credentials');
 if(!existing?.id || !existing.pem || existing.installation_id)return !!existing?.installation_id;
 const jwt=await appJwt(existing),headers={Authorization:'Bearer '+jwt,'User-Agent':'AI-Commons-Control','Accept':'application/vnd.github+json'};
 const installations=await a.externalJson('https://api.github.com/app/installations?per_page=100',{headers});
 check(Array.isArray(installations),'invalid_installation_list',502);
 const eligible=installations.filter(x=>x.account?.login===owner && x.app_id===existing.id && x.repository_selection==='selected' && !x.suspended_at);
 if(!eligible.length)return false;
 check(eligible.length===1 && Number.isSafeInteger(eligible[0].id),'ambiguous_installation',409);
 const installation=eligible[0];
 check(['administration','contents','workflows','actions','issues','pull_requests'].every(p=>installation.permissions?.[p]==='write'),'installation_permissions_incomplete',403);
 const tokenResponse=await a.externalJson('https://api.github.com/app/installations/'+installation.id+'/access_tokens',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({repositories:['ai-commons']})});
 check(typeof tokenResponse.token==='string','github_installation_token_missing',502);
 const repoHeaders={Authorization:'Bearer '+tokenResponse.token,'User-Agent':'AI-Commons-Control'};
 const repos=await a.externalJson('https://api.github.com/installation/repositories',{headers:repoHeaders});
 check(repos.total_count===1 && repos.repositories?.[0]?.full_name===REPOSITORY,'unexpected_installation_repositories',403);
 const settings=await a.externalJson('https://api.github.com/repos/'+REPOSITORY+'/actions/permissions/workflow',{headers:repoHeaders});
 check(['read','write'].includes(settings.default_workflow_permissions) && typeof settings.can_approve_pull_request_reviews==='boolean','invalid_repository_settings',502);
 await a.transaction(async(s,tx)=>{const current=await tx.get('github_app_credentials');check(current?.id===existing.id,'app_changed_during_verification',409);if(current.installation_id){check(current.installation_id===installation.id,'installation_changed',409);return;}await tx.put('github_app_credentials',{...current,installation_id:installation.id,verified_at:Date.now()});await a.emit(s,'github_maintenance_identity_connected',{app_id:existing.id,installation_id:installation.id,repository:REPOSITORY,verified_repository_admin_read:true,private_key_public:false});});
 return true;
}
export async function scheduledGithubReconciliation(a){
 const app=await a.ctx.storage.get('github_app_credentials');if(!app?.id || app.installation_id)return;
 const now=Date.now(),reserved=await a.transaction(s=>{if(s.github_installation_checked && now-s.github_installation_checked<900000)return false;s.github_installation_checked=now;return true;});if(!reserved)return;
 try{await reconcileGithubInstallation(a);}catch(error){await a.transaction(s=>a.emit(s,'github_installation_check_failed',{error:error.code||'github_unavailable'}));}
}
export async function githubSetup(a,request){
 const u=new URL(request.url),path=u.pathname;if(!path.startsWith('/v1/setup/github'))return null;
 check(request.method==='GET','method_not_allowed',405);
 const existing=await a.ctx.storage.get('github_app_credentials');
 if(existing?.installation_id)return page('<h1>GitHub 已接通</h1><p>安装身份会自动续签短期令牌，限定 ai-commons 仓库。无需再次创建应用。</p>');
 if(path==='/v1/setup/github'){
  check(a.env.GH_SETUP_TOKEN && u.searchParams.get('key')===a.env.GH_SETUP_TOKEN,'setup_ticket_required',403);
  if(existing && await reconcileGithubInstallation(a))return page('<h1>GitHub 自治身份已接通</h1><p>已直接向 GitHub 核实安装和仓库权限，无需重新安装。</p>');
  const nonce=b64(crypto.getRandomValues(new Uint8Array(32))),until=Date.now()+1800000;
  await a.ctx.blockConcurrencyWhile(async()=>{const sessions=(await a.ctx.storage.get('github_setup_sessions')||[]).filter(x=>x.until>Date.now()).slice(-4);sessions.push({hash:await hash(nonce),until});await a.ctx.storage.put('github_setup_sessions',sessions);});
  const manifest={name:'AI Commons '+Date.now(),url:ORIGIN,public:false,redirect_url:ORIGIN+'/v1/setup/github/callback',setup_url:ORIGIN+'/v1/setup/github/installed',default_permissions:{administration:'write',contents:'write',workflows:'write',actions:'write',issues:'write',pull_requests:'write'},default_events:[]};
  const result=existing? page('<h1>继续安装自治应用</h1><p>选择 Only select repositories，仅安装到 ai-commons。</p><a href="'+escape(existing.html_url+'/installations/new')+'">继续安装</a>'):page('<h1>连接 GitHub 自治身份</h1><p>请用 '+escape(owner)+' 账户创建应用，并仅安装到 ai-commons 仓库。此身份用于仓库设置、代码与自动化维护；私钥保存在独立治理服务，界面不会显示。</p><form method="post" action="https://github.com/settings/apps/new?state='+nonce+'"><input type="hidden" name="manifest" value="'+escape(JSON.stringify(manifest))+'"><button type="submit">在 GitHub 创建自治应用</button></form>');
  result.headers.set('Set-Cookie','ai_commons_setup='+nonce+'; HttpOnly; Secure; SameSite=Lax; Path=/v1/setup/github; Max-Age=1800');return result;
 }
 const nonce=request.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('ai_commons_setup='))?.split('=').slice(1).join('=');
 const sessions=await a.ctx.storage.get('github_setup_sessions')||[],legacy=await a.ctx.storage.get('github_setup_session');if(legacy)sessions.push(legacy);const digest=nonce?await hash(nonce):null;check(nonce && sessions.some(s=>s.until>Date.now() && s.hash===digest),'setup_session_expired',403);
 if(path==='/v1/setup/github/callback'){
  check(u.searchParams.get('state')===nonce && /^[A-Za-z0-9_\-]+$/.test(u.searchParams.get('code')||''),'invalid_manifest_callback',403);
  check(!existing,'application_already_created',409);
  const value=await a.externalJson('https://api.github.com/app-manifests/'+u.searchParams.get('code')+'/conversions',{method:'POST',headers:{'User-Agent':'AI-Commons-Control','Accept':'application/vnd.github+json'}});
  check(value.owner?.login===owner && Number.isSafeInteger(value.id) && typeof value.pem==='string' && /^https:\/\/github\.com\/apps\/[a-z0-9-]+$/.test(value.html_url),'unexpected_app_owner',403);
  await appJwt(value);const credentials={id:value.id,pem:value.pem,html_url:value.html_url,created_at:Date.now()};await a.ctx.storage.put('github_app_credentials',credentials);
  return page('<h1>应用已创建</h1><p>下一步请选择“Only select repositories”，只勾选 ai-commons，再点击 Install。</p><p><a href="'+escape(value.html_url+'/installations/new')+'">安装到 ai-commons</a></p>');
 }
 if(path==='/v1/setup/github/installed'){
  const id=u.searchParams.get('installation_id');check(existing && /^[0-9]+$/.test(id||''),'invalid_installation',400);
  const jwt=await appJwt(existing),headers={Authorization:'Bearer '+jwt,'User-Agent':'AI-Commons-Control','Accept':'application/vnd.github+json'};
  const installation=await a.externalJson('https://api.github.com/app/installations/'+id,{headers});check(installation.account?.login===owner && installation.app_id===existing.id && installation.repository_selection==='selected','installation_scope_must_be_selected',403);
  const candidate={...existing,installation_id:Number(id)};
  const tokenResponse=await a.externalJson('https://api.github.com/app/installations/'+id+'/access_tokens',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({repositories:['ai-commons']})});
  const repos=await a.externalJson('https://api.github.com/installation/repositories',{headers:{Authorization:'Bearer '+tokenResponse.token,'User-Agent':'AI-Commons-Control'}});
  check(repos.total_count===1 && repos.repositories?.[0]?.full_name===REPOSITORY,'unexpected_installation_repositories',403);
  await a.transaction(async(s,tx)=>{await tx.put('github_app_credentials',candidate);await a.emit(s,'github_maintenance_identity_connected',{app_id:existing.id,installation_id:Number(id),repository:REPOSITORY,private_key_public:false});});
  return page('<h1>GitHub 自治身份已接通</h1><p>治理服务可以自动获取短期令牌。密钥不会交给参与者或模型；各项操作仍按当前 AI 授权执行。</p>');
 }
 return html('Not found',404);
}
