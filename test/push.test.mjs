import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH,createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {encryptPayload,decryptPayload,endpointAllowed,groupOf,GROUPS} from '../server/push.mjs';

const b64u=b=>Buffer.from(b).toString('base64url');
const receiverKeys=()=>{const ecdh=createECDH('prime256v1');ecdh.generateKeys();return {ecdh,auth:b64u(randomBytes(16)),p256dh:b64u(ecdh.getPublicKey())};};

test('push: cifrado aes128gcm de ida y vuelta, formato del registro, destinos permitidos y grupos de avisos',()=>{
  const r=receiverKeys(),message=encryptPayload(JSON.stringify({title:'Hola',body:'Cuerpo con acentos: canción, año, ñ'}),{p256dh:r.p256dh,auth:r.auth});
  assert.equal(message.readUInt32BE(16),4096);assert.equal(message[20],65);assert.equal(message[21],4);   // salt(16) + tamaño de registro + longitud de clave + clave pública del servidor
  assert.deepEqual(JSON.parse(decryptPayload(message,r).toString('utf8')),{title:'Hola',body:'Cuerpo con acentos: canción, año, ñ'});
  assert.notDeepEqual(encryptPayload('x',{p256dh:r.p256dh,auth:r.auth}),encryptPayload('x',{p256dh:r.p256dh,auth:r.auth}),'cada mensaje usa sal y clave efímera nuevas');
  assert.throws(()=>decryptPayload(message,{ecdh:receiverKeys().ecdh,auth:r.auth}),'otra clave no puede leerlo');
  assert.throws(()=>encryptPayload('x',{p256dh:b64u(Buffer.alloc(65,1)),auth:r.auth}),/Clave pública/);assert.throws(()=>encryptPayload('x',{p256dh:r.p256dh,auth:b64u(Buffer.alloc(8))}),/Secreto/);
  assert.throws(()=>encryptPayload('x'.repeat(4000),{p256dh:r.p256dh,auth:r.auth}),/demasiado largo/);
  for(const ok of ['https://fcm.googleapis.com/fcm/send/abc','https://updates.push.services.mozilla.com/wpush/v2/x','https://web.push.apple.com/Qx','https://wns2-par02p.notify.windows.com/w/?token=1'])assert.equal(endpointAllowed(ok,{}),true,ok);
  for(const bad of ['http://fcm.googleapis.com/x','https://evil.example/x','https://fcm.googleapis.com.evil.example/x','https://169.254.169.254/latest','http://127.0.0.1:9/x','https://fcm.googleapis.com:8443/x','not a url'])assert.equal(endpointAllowed(bad,{}),false,bad);
  assert.equal(endpointAllowed('http://127.0.0.1:9/x',{NODE_ENV:'test'}),true);assert.equal(endpointAllowed('http://localhost:9/x',{NODE_ENV:'test'}),false);
  assert.equal(groupOf('assignment'),'chats');assert.equal(groupOf('mention'),'chats');assert.equal(groupOf('sla'),'sla');assert.equal(groupOf('payment'),'sales');assert.equal(groupOf('recipe'),'ops');assert.equal(groupOf('desconocido'),'ops');
  assert.deepEqual(Object.keys(GROUPS),['chats','sla','sales','ops']);
  // Vector de prueba oficial del RFC 8291 (apéndice A): mismo cuerpo, byte a byte, que producen los navegadores y las librerías de referencia.
  const vec={plaintext:'When I grow up, I want to be a watermelon',asPrivate:'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',uaPrivate:'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',uaPublic:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',auth:'BTBZMqHH6r4Tts7J_aSIgg',salt:'DGv6ra1nlYgDCS1FRnbzlw',
    body:'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'};
  const as=createECDH('prime256v1');as.setPrivateKey(Buffer.from(vec.asPrivate,'base64url'));const ua=createECDH('prime256v1');ua.setPrivateKey(Buffer.from(vec.uaPrivate,'base64url'));
  assert.equal(ua.getPublicKey().toString('base64url'),vec.uaPublic);
  assert.equal(encryptPayload(vec.plaintext,{p256dh:vec.uaPublic,auth:vec.auth},{ephemeral:as,salt:Buffer.from(vec.salt,'base64url')}).toString('base64url'),vec.body,'el cifrado coincide con el vector del RFC 8291');
  assert.equal(decryptPayload(Buffer.from(vec.body,'base64url'),{ecdh:ua,auth:vec.auth}).toString('utf8'),vec.plaintext);
});

test('push por API: permisos, claves VAPID firmadas, suscripción validada, envío cifrado e idempotente, grupos, lectura previa, prueba, limpieza de dispositivos caídos y sin reenvío del historial',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'crm-push-')),code=randomUUID(),password='Password-push-2026!';let logs='';
  const received=[],receiver=createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{received.push({url:req.url,headers:req.headers,body:Buffer.concat(chunks)});res.statusCode=req.url.includes('/gone')?410:req.url.includes('/redirect')?302:201;if(res.statusCode===302)res.setHeader('Location','/push/landed');res.end();});});
  await new Promise(r=>receiver.listen(0,'127.0.0.1',r));const sink='http://127.0.0.1:'+receiver.address().port;
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',PUSH_DELAY_MS:'0'},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await new Promise(r=>receiver.close(r));await rm(dir,{recursive:true,force:true});});
  async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=r.headers.get('content-type')?.includes('json')?await r.json():{};assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const sleep=ms=>new Promise(r=>setTimeout(r,ms)),db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),one=(sql,...a)=>{const d=db();try{return d.prepare(sql).get(...a);}finally{d.close();}},run=(sql,...a)=>{const d=db();try{d.prepare(sql).run(...a);}finally{d.close();}};
  const waitFor=async(fn,ms=14000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await sleep(250);}return false;};

  // archivos de la app instalable
  for(const [path,type] of [['/sw.js','javascript'],['/push.js','javascript'],['/manifest.webmanifest','manifest+json'],['/icon-192.png','image/png'],['/icon-512.png','image/png']]){const r=await fetch(origin+path);assert.equal(r.status,200,path);assert.ok(r.headers.get('content-type').includes(type),path+' '+r.headers.get('content-type'));}
  const manifest=await (await fetch(origin+'/manifest.webmanifest')).json();assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/crm');assert.ok(manifest.icons.some(i=>i.sizes==='192x192')&&manifest.icons.some(i=>i.sizes==='512x512'));
  assert.match(await (await fetch(origin+'/sw.js')).text(),/addEventListener\('push'/);

  const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
  const agent=await call('/api/auth/register','',{username:'asesor',name:'Asesora',password});const inv=await call('/api/team/invites',admin.cookie,{username:'asesor',brandIds:['globalvet']},'POST',201);await call('/api/team/accept',agent.cookie,{token:inv.token});
  const ana=await call('/api/auth/register','',{username:'ana',name:'Ana Pérez',password});
  const adminId=one('SELECT id FROM users WHERE username=?','admin').id,agentId=one('SELECT id FROM users WHERE username=?','asesor').id;

  // permisos
  await call('/api/push/config','',undefined,'GET',401);await call('/api/push/config',ana.cookie,undefined,'GET',403);await call('/api/push/test',ana.cookie,{},'POST',403);
  const config=await call('/api/push/config',admin.cookie);assert.equal(config.enabled,true);assert.deepEqual(config.devices,[]);assert.deepEqual(config.groups,Object.keys(GROUPS));
  const vapidKey=Buffer.from(config.publicKey,'base64url');assert.equal(vapidKey.length,65);assert.equal(vapidKey[0],4);
  assert.equal((await call('/api/push/config',admin.cookie)).publicKey,config.publicKey,'las claves se generan una sola vez');
  assert.equal(JSON.stringify(config).includes('private'),false,'la clave privada nunca sale por la API');
  await call('/api/push/test',admin.cookie,{},'POST',409);   // sin dispositivos

  // suscripción validada
  const adminDevice=receiverKeys(),sub=(path,keys)=>({subscription:{endpoint:sink+path,keys:{p256dh:keys.p256dh,auth:keys.auth}},userAgent:'Prueba'});
  await call('/api/push/subscribe',admin.cookie,{subscription:{endpoint:'https://evil.example/x',keys:{p256dh:adminDevice.p256dh,auth:adminDevice.auth}}},'POST',400);
  await call('/api/push/subscribe',admin.cookie,{subscription:{endpoint:sink+'/push/admin',keys:{p256dh:b64u(Buffer.alloc(65,1)),auth:adminDevice.auth}}},'POST',400);
  await call('/api/push/subscribe',admin.cookie,{subscription:{endpoint:sink+'/push/admin',keys:{p256dh:adminDevice.p256dh,auth:b64u(Buffer.alloc(4))}}},'POST',400);
  await call('/api/push/subscribe',ana.cookie,sub('/push/ana',adminDevice),'POST',403);
  // un aviso anterior a activar no se reenvía
  const notify=(id,user,kind,title,{read=null,at=Date.now()-1000}={})=>run("INSERT INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,read_at,created_at) VALUES(?,?,'globalvet',NULL,?,?,?,?,?)",id,user,kind,title,'k-'+id,read,at);
  notify('N0',adminId,'assignment','Aviso anterior a activar');
  await call('/api/push/subscribe',admin.cookie,sub('/push/admin',adminDevice));
  assert.equal(one("SELECT pushed_at FROM notifications WHERE id='N0'").pushed_at!==null,true);
  const cfg2=await call('/api/push/config',admin.cookie);assert.equal(cfg2.devices.length,1);assert.equal(cfg2.devices[0].host,'127.0.0.1');
  await call('/api/push/subscribe',admin.cookie,sub('/push/admin',adminDevice));assert.equal((await call('/api/push/config',admin.cookie)).devices.length,1,'la misma suscripción no se duplica');

  // un aviso nuevo llega cifrado y firmado
  notify('N1',adminId,'assignment','Chat asignado · Ana Pérez · Nutrición en perros y gatos');
  assert.equal(await waitFor(()=>received.length>=1),true,'el barrido envió el aviso');
  const first=received[0];assert.equal(first.url,'/push/admin');assert.equal(first.headers['content-encoding'],'aes128gcm');assert.ok(Number(first.headers.ttl)>0);
  const [scheme,params]=[first.headers.authorization.slice(0,5),first.headers.authorization.slice(6)],tokenPart=params.match(/t=([^,]+)/)[1],keyPart=params.match(/k=(.+)$/)[1];
  assert.equal(scheme,'vapid');assert.equal(keyPart,config.publicKey);
  const [h,p,s]=tokenPart.split('.'),claims=JSON.parse(Buffer.from(p,'base64url'));assert.equal(JSON.parse(Buffer.from(h,'base64url')).alg,'ES256');assert.equal(claims.aud,sink);assert.ok(claims.exp>Date.now()/1000&&claims.exp<=Date.now()/1000+24*3600);assert.match(claims.sub,/^(mailto:|https:)/);
  const pub=createPublicKey({key:{kty:'EC',crv:'P-256',x:b64u(vapidKey.subarray(1,33)),y:b64u(vapidKey.subarray(33,65))},format:'jwk'});
  assert.equal(verify('sha256',Buffer.from(h+'.'+p),{key:pub,dsaEncoding:'ieee-p1363'},Buffer.from(s,'base64url')),true,'la firma VAPID es válida con la clave pública publicada');
  const shown=JSON.parse(decryptPayload(first.body,adminDevice).toString('utf8'));assert.equal(shown.title,'TEC Capital · GlobalVet');assert.equal(shown.body,'Chat asignado · Ana Pérez · Nutrición en perros y gatos');assert.equal(shown.url,'/crm');assert.equal(shown.kind,'assignment');
  assert.equal(first.body.includes(Buffer.from('Ana')),false,'el contenido viaja cifrado');

  // preferencias por grupo, avisos ya leídos, historial al activar un segundo dispositivo y envío único
  await call('/api/push/prefs',admin.cookie,{groups:['inexistente']},'PUT',400);await call('/api/push/prefs',admin.cookie,{groups:['sla']},'PUT');assert.deepEqual((await call('/api/push/config',admin.cookie)).groups,['sla']);
  const before=received.length;
  notify('N2',adminId,'assignment','Silenciado por preferencias');notify('N3',adminId,'sla','Objetivo de respuesta por vencer');notify('N4',adminId,'sla','Ya leído',{read:Date.now()});
  notify('H1',agentId,'assignment','Aviso anterior del asesor');
  const agentDevice=receiverKeys();await call('/api/push/subscribe',agent.cookie,sub('/push/agent',agentDevice));
  assert.equal(await waitFor(()=>received.length>=before+1),true);await sleep(6500);
  const later=received.slice(before);assert.equal(later.length,1,'sólo el aviso del grupo activo y sin leer; el historial del asesor no se reenvió');assert.equal(later[0].url,'/push/admin');assert.equal(JSON.parse(decryptPayload(later[0].body,adminDevice)).body,'Objetivo de respuesta por vencer');
  assert.equal(received.some(r=>r.url==='/push/agent'),false);
  assert.equal(one("SELECT count(*) n FROM notifications WHERE pushed_at IS NULL").n,0,'todo quedó marcado: no hay reenvíos');

  // prueba manual, límite de frecuencia y dispositivo caído
  const t0=received.length,probe=await call('/api/push/test',admin.cookie,{});assert.equal(probe.results.length,1);assert.equal(probe.results[0].ok,true);
  assert.equal(JSON.parse(decryptPayload(received[t0].body,adminDevice)).body,'Notificación de prueba: todo funciona.');await call('/api/push/test',admin.cookie,{},'POST',429);
  const gone=receiverKeys();await call('/api/push/subscribe',admin.cookie,sub('/push/gone',gone));assert.equal((await call('/api/push/config',admin.cookie)).devices.length,2);
  await sleep(5200);const t1=await call('/api/push/test',admin.cookie,{});assert.equal(t1.results.length,2);assert.equal(t1.results.find(r=>r.status===410).ok,false);
  const afterGone=await call('/api/push/config',admin.cookie);assert.deepEqual(afterGone.devices.map(d=>d.endpoint),[sink+'/push/admin'],'el dispositivo que responde 410 se elimina solo');

  // una redirección del servicio de push no se sigue: es un fallo y nada llega al destino al que apunta
  const redirectDevice=receiverKeys();await call('/api/push/subscribe',admin.cookie,sub('/push/redirect',redirectDevice));await sleep(5200);
  const rd=await call('/api/push/test',admin.cookie,{});const redirected=rd.results.find(r=>r.status===302);assert.ok(redirected,'el 302 se informó');assert.equal(redirected.ok,false);
  assert.equal(received.some(r=>r.url==='/push/landed'),false,'el servidor no siguió la redirección');
  assert.equal((await call('/api/push/unsubscribe',admin.cookie,{endpoint:sink+'/push/redirect'})).removed,1);
  // cada persona sólo ve y quita lo suyo
  assert.equal((await call('/api/push/config',agent.cookie)).devices.length,1);assert.equal((await call('/api/push/unsubscribe',agent.cookie,{endpoint:sink+'/push/admin'})).removed,0);
  assert.equal((await call('/api/push/unsubscribe',admin.cookie,{endpoint:sink+'/push/admin'})).removed,1);assert.deepEqual((await call('/api/push/config',admin.cookie)).devices,[]);
  // revocación al enviar: sin acceso a la marca no se manda (el dispositivo se conserva) y una cuenta deshabilitada pierde sus dispositivos
  const base=received.length;run('DELETE FROM brand_members WHERE user_id=?',agentId);notify('R1',agentId,'assignment','Sin acceso a la marca');await sleep(6500);
  assert.equal(received.length,base,'no se envía un aviso de una marca a la que ya no tiene acceso');assert.equal(one('SELECT count(*) n FROM push_subscriptions WHERE user_id=?',agentId).n,1);
  run('UPDATE users SET disabled=1 WHERE id=?',agentId);await sleep(5500);
  assert.equal(one('SELECT count(*) n FROM push_subscriptions WHERE user_id=?',agentId).n,0,'una cuenta deshabilitada pierde sus dispositivos');
  assert.equal(one('PRAGMA user_version').user_version,35);
  assert.ok(one("SELECT count(*) n FROM audit WHERE action IN ('push.subscribe','push.unsubscribe')").n>=3);
});
