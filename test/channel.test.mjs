import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('canal simulado: apagado por omisión, ventana de 24/72 h, estados de entrega, reintento, botones, anuncio y permisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-channel-')),code=randomUUID(),password='Password-channel-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'));
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),client=await call('/api/auth/register','',{username:'cliente',name:'Cliente',password});
 const msgs=id=>'/api/conversations/'+id+'/messages';
 async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}

 // apagado por omisión; sólo administración lo configura
 const s0=await call('/api/channel/settings',admin.cookie);assert.equal(s0.settings.find(x=>x.brand_id==='globalvet').enabled,0);
 await call('/api/channel/settings',client.cookie,undefined,'GET',403);
 await call('/api/channel/brands/globalvet',client.cookie,{enabled:true,expectedRevision:0},'PATCH',403);
 const on=(await call('/api/channel/brands/globalvet',admin.cookie,{enabled:true,enforceWindow:true,deliveryDelayMs:200,failureRate:0,expectedRevision:0},'PATCH')).settings;
 assert.equal(on.enabled,1);assert.equal(on.revision,1);assert.equal(on.delivery_delay_ms,200);
 await call('/api/channel/brands/globalvet',admin.cookie,{failureRate:101,expectedRevision:1},'PATCH',400);
 await call('/api/channel/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:0},'PATCH',409);

 // el cliente llega por anuncio: la ventana sólo abre cuando escribe (72 h por punto de entrada)
 const conv=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'whatsapp',referral:{ad:'Flyer aves octubre',campaign:'meta-test'}})).conversation;
 assert.equal(conv.referral.ad,'Flyer aves octubre');assert.equal(conv.referral.source,'ad');assert.equal(conv.window.enabled,true);assert.equal(conv.window.open,false);
 await call(msgs(conv.id),client.cookie,{text:'Hola, me interesa',clientRef:randomUUID()},'POST',201);
 const bot=await until(async()=>{const m=(await call(msgs(conv.id),client.cookie)).messages.find(x=>x.sender_kind==='automation');return m&&m.delivery_state==='delivered'?m:null;});
 assert.ok(bot,'la bienvenida quedó entregada');assert.deepEqual(bot.buttons,['Precio','Temario','Fechas']);assert.equal(bot.category,'service');assert.ok(bot.delivered_at>=bot.created_at+200);
 const d1=(await call('/api/conversations/'+conv.id,client.cookie)).conversation;
 assert.equal(d1.window.open,true);assert.equal(d1.window.source,'referral');assert.ok(d1.window.until>Date.now()+71*3600000,'72 h por anuncio');
 await call('/api/conversations/'+conv.id+'/read',client.cookie,{upTo:bot.seq});
 assert.equal((await call(msgs(conv.id),admin.cookie)).messages.find(x=>x.id===bot.id).delivery_state,'read');

 // el equipo escribe libre dentro de la ventana
 const a1=await call(msgs(conv.id),admin.cookie,{text:'Hola, soy del equipo. ¿Te ayudo con la inscripción?',clientRef:randomUUID(),asAgent:true},'POST',201);
 const a1m=await until(async()=>{const m=(await call(msgs(conv.id),admin.cookie)).messages.find(x=>x.id===a1.id);return m.delivery_state==='delivered'?m:null;});
 assert.equal(a1m.category,'service');assert.equal(a1m.buttons,null);

 // ventana cerrada: se retrocede 80 h el reloj del cliente en la base de pruebas
 {const d=db();d.prepare("UPDATE messages SET created_at=created_at-80*3600000 WHERE conversation_id=? AND sender_kind='customer'").run(conv.id);d.close();}
 const d2=(await call('/api/conversations/'+conv.id,admin.cookie)).conversation;assert.equal(d2.window.open,false);
 await call(msgs(conv.id),admin.cookie,{text:'¿Sigues ahí?',clientRef:randomUUID(),asAgent:true},'POST',409);
 await call('/api/conversations/'+conv.id+'/template',admin.cookie,{kind:'syllabus',clientRef:randomUUID()});
 assert.equal((await call(msgs(conv.id),admin.cookie)).messages.at(-1).category,'utility');
 await call('/api/conversations/'+conv.id+'/template',admin.cookie,{kind:'flyer',clientRef:randomUUID()});
 assert.equal((await call(msgs(conv.id),admin.cookie)).messages.at(-1).category,'marketing');
 // sin exigir la ventana vuelve a pasar el texto libre
 await call('/api/channel/brands/globalvet',admin.cookie,{enforceWindow:false,expectedRevision:1},'PATCH');
 await call(msgs(conv.id),admin.cookie,{text:'Ahora sí puedo escribir libre.',clientRef:randomUUID(),asAgent:true},'POST',201);

 // fallos de entrega y reintento con bitácora
 await call('/api/channel/brands/globalvet',admin.cookie,{failureRate:100,expectedRevision:2},'PATCH');
 const f1=await call(msgs(conv.id),admin.cookie,{text:'Este mensaje fallará en el canal simulado.',clientRef:randomUUID(),asAgent:true},'POST',201);
 const failed=await until(async()=>{const m=(await call(msgs(conv.id),admin.cookie)).messages.find(x=>x.id===f1.id);return m.delivery_state==='failed'?m:null;});
 assert.ok(failed,'el mensaje falló');assert.ok(failed.failed_reason);
 await call('/api/messages/'+f1.id+'/retry',client.cookie,{},'POST',403);
 await call('/api/channel/brands/globalvet',admin.cookie,{failureRate:0,expectedRevision:3},'PATCH');
 assert.equal((await call('/api/messages/'+f1.id+'/retry',admin.cookie,{})).message.delivery_state,'sent');
 const redelivered=await until(async()=>{const m=(await call(msgs(conv.id),admin.cookie)).messages.find(x=>x.id===f1.id);return m.delivery_state==='delivered'?m:null;});
 assert.ok(redelivered,'reentregado');assert.equal(redelivered.failed_reason,null);
 assert.deepEqual((await call('/api/messages/'+f1.id+'/events',admin.cookie)).events.map(e=>e.state),['failed','retry','delivered']);
 await call('/api/messages/'+f1.id+'/retry',admin.cookie,{},'POST',409);
 await call('/api/messages/'+f1.id+'/events','',undefined,'GET',401);
 await call('/api/ads/'+randomUUID(),client.cookie,undefined,'GET',404);

 // marca sin canal: comportamiento de siempre (sin botones, sin estados simulados)
 const c2=(await call('/api/conversations',client.cookie,{courseId:'odontologia',channel:'instagram'})).conversation;assert.equal(c2.window.enabled,false);assert.equal(c2.referral,null);
 await call(msgs(c2.id),client.cookie,{text:'Hola',clientRef:randomUUID()},'POST',201);
 const bot2=await until(async()=>(await call(msgs(c2.id),client.cookie)).messages.find(x=>x.sender_kind==='automation'));
 assert.ok(bot2);assert.equal(bot2.buttons,null);assert.equal(bot2.delivery_state,'sent');
 const d=db();try{assert.equal(d.prepare('PRAGMA user_version').get().user_version,18);assert.equal(d.prepare("SELECT count(*) n FROM channel_events WHERE message_id=?").get(f1.id).n,3);}finally{d.close();}
});
