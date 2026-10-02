// Key material stays in a local file. The server receives only a public key/signature.
import {readFile,writeFile} from 'node:fs/promises';
import {ORIGIN,DAY,bytes,b64,canonical} from '../control/protocol.mjs';
const [mode,keyFile,inputFile]=process.argv.slice(2);
if(!keyFile || !['init','apply','command'].includes(mode))throw new Error('Usage: node scripts/authority-client.mjs init|apply|command PRIVATE_KEY_FILE [BODY_JSON_FILE]');
if(mode==='init') {
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const public_key=b64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)));
  await writeFile(keyFile,JSON.stringify({public_key,private_key:await crypto.subtle.exportKey('jwk',pair.privateKey)},null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({public_key,private_key_saved_locally:true}));
}else{
  const saved=JSON.parse(await readFile(keyFile,'utf8')),input=JSON.parse(await readFile(inputFile,'utf8'));
  const body=mode==='apply'?{service:ORIGIN,purpose:'role-application/v1',id:crypto.randomUUID(),issued_at:Date.now(),expires_at:Date.now()+DAY-1000,public_key:saved.public_key,...input}:input;
  if(body.service!==ORIGIN)throw new Error('Refusing a different signature domain');
  const key=await crypto.subtle.importKey('jwk',saved.private_key,'Ed25519',false,['sign']);
  const signature=b64(new Uint8Array(await crypto.subtle.sign('Ed25519',key,bytes(canonical(body)))));
  const envelope={body,...(mode==='command'?{public_key:saved.public_key}:{}),signature};
  // Save the exact signed intent before a network attempt; retry it without generating a new ID.
  await writeFile(inputFile+'.signed.json',JSON.stringify(envelope,null,2),{mode:0o600,flag:'wx'});
  const r=await fetch(ORIGIN+(mode==='apply'?'/v1/applications':'/v1/commands'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope),redirect:'error',signal:AbortSignal.timeout(20000)});
  console.log(await r.text());if(!r.ok)process.exitCode=1;
}
