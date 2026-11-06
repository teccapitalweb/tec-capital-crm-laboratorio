import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('mensajes programados: alcance, validación, idempotencia, edición, y envío a la hora con las reglas de negocio comprobadas al enviar',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-sched-')),code=randomUUID(),password='Password-sched-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),msgs=id=>'/api/conversations/'+id+'/messages',sched=id=>'/api/conversations/'+id+'/scheduled';
 async function until(fn,tries=30){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const ana=await call('/api/auth/register','',{username:'ana',name:'Ana Pérez',password});
 const conv=(await call('/api/conversations',ana.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});
 const brand=db.prepare('SELECT brand_id FROM conversations WHERE id=?').get(conv.id).brand_id;
 const team=async(username,name,brandId)=>{const u=await call('/api/auth/register','',{username,name,password});const inv=await call('/api/team/invites',admin.cookie,{username,brandIds:[brandId]},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});return u;};
 const colega=await team('colega','Colega Ventas',brand);
 const outsider=await team('fuera','Asesor de otra marca',brand==='odonteck'?'dermalysse':'odonteck');
 const T=()=>Date.now(),HOUR=3600*1000;
 const make=(cookie,over={})=>call(sched(conv.id),cookie,{text:'Hola, ¿pudiste revisar la información del curso?',sendAt:T()+2*HOUR,clientRef:randomUUID(),...over},'POST',over.expect||201);
 const due=id=>db.prepare('UPDATE scheduled_messages SET send_at=? WHERE id=?').run(T()-1000,id);
 const stateOf=id=>db.prepare('SELECT state,reason,message_id FROM scheduled_messages WHERE id=?').get(id);

 // alcance: sin sesión, clientes y otras marcas no entran
 await call(sched(conv.id),'',undefined,'GET',401);await call(sched(conv.id),ana.cookie,undefined,'GET',403);await call(sched(conv.id),outsider.cookie,undefined,'GET',404);
 await call(sched(conv.id),outsider.cookie,{text:'x',sendAt:T()+HOUR,clientRef:randomUUID()},'POST',404);

 // validación
 await make(admin.cookie,{text:'   ',expect:400});await make(admin.cookie,{sendAt:T()-1000,expect:400});await make(admin.cookie,{sendAt:T()+5000,expect:400});
 await make(admin.cookie,{sendAt:T()+100*86400*1000,expect:400});await make(admin.cookie,{sendAt:'mañana',expect:400});await make(admin.cookie,{clientRef:'corta',expect:400});

 // crear, y reintentar con la misma referencia no duplica
 const ref=randomUUID();const a=await call(sched(conv.id),admin.cookie,{text:'Primer recordatorio',sendAt:T()+2*HOUR,clientRef:ref},'POST',201);
 assert.equal(a.item.state,'pending');assert.equal(a.item.cancelOnReply,true);assert.equal(a.item.mine,true);
 const dup=await call(sched(conv.id),admin.cookie,{text:'Primer recordatorio',sendAt:T()+2*HOUR,clientRef:ref},'POST',200);assert.equal(dup.duplicate,true);assert.equal(dup.item.id,a.item.id);
 assert.equal((await call(sched(conv.id),admin.cookie)).items.length,1);
 // el equipo de la marca lo ve, y ve de quién es, pero no es suyo
 const seen=(await call(sched(conv.id),colega.cookie)).items[0];assert.equal(seen.mine,false);assert.equal(seen.authorName,'Administración');

 // editar: con revisión; una revisión vieja no pisa; otra persona (no administradora) no puede; un mensaje vacío no pasa
 const edited=(await call('/api/scheduled/'+a.item.id,admin.cookie,{text:'Primer recordatorio, editado',sendAt:T()+3*HOUR,expectedRevision:a.item.revision},'PATCH')).item;assert.equal(edited.revision,a.item.revision+1);assert.equal(edited.text,'Primer recordatorio, editado');
 await call('/api/scheduled/'+a.item.id,admin.cookie,{text:'viejo',expectedRevision:a.item.revision},'PATCH',409);
 await call('/api/scheduled/'+a.item.id,colega.cookie,{text:'ajeno',expectedRevision:edited.revision},'PATCH',403);
 await call('/api/scheduled/'+a.item.id,admin.cookie,{text:'  ',expectedRevision:edited.revision},'PATCH',400);
 await call('/api/scheduled/'+a.item.id,outsider.cookie,{text:'x',expectedRevision:edited.revision},'PATCH',404);
 await call('/api/scheduled/'+a.item.id+'/cancel',colega.cookie,{},'POST',403);

 // cancelar: ya no sale aunque llegue la hora, y no se puede cancelar dos veces
 const toCancel=(await make(admin.cookie)).item;await call('/api/scheduled/'+toCancel.id+'/cancel',admin.cookie,{},'POST');due(toCancel.id);await sleep(2200);
 assert.equal(stateOf(toCancel.id).state,'cancelled');assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE client_ref=?").get('sched:'+toCancel.id).n,0);
 await call('/api/scheduled/'+toCancel.id+'/cancel',admin.cookie,{},'POST',409);

 // a la hora, sale solo, como mensaje normal a nombre de quien lo programó, deja el chat a su cargo y no se duplica
 const before=db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=?").get(conv.id).n;
 due(a.item.id);const sent=await until(()=>stateOf(a.item.id).state==='sent');assert.ok(sent,'se envió a la hora');
 await sleep(2300);
 const m=db.prepare('SELECT * FROM messages WHERE client_ref=?').all('sched:'+a.item.id);assert.equal(m.length,1,'un solo mensaje aunque haya pasado más de un ciclo');
 assert.equal(m[0].text,'Primer recordatorio, editado');assert.equal(m[0].sender_kind,'agent');assert.equal(m[0].sender_id,db.prepare("SELECT id FROM users WHERE username='admin'").get().id);
 assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=?").get(conv.id).n,before+1);
 const c1=db.prepare('SELECT assigned_to,bot_enabled FROM conversations WHERE id=?').get(conv.id);assert.equal(c1.bot_enabled,0);assert.equal(c1.assigned_to,m[0].sender_id);
 assert.equal(stateOf(a.item.id).message_id,m[0].id);
 // lo enviado ya no se edita ni se cancela
 await call('/api/scheduled/'+a.item.id+'/cancel',admin.cookie,{},'POST',409);

 // si el cliente responde antes de la hora, no se manda (por omisión)…
 const r1=(await make(admin.cookie,{text:'Seguimiento por si no respondió'})).item;await sleep(30);
 await call(msgs(conv.id),ana.cookie,{text:'Ya vi la información, gracias',clientRef:randomUUID()},'POST',201);due(r1.id);
 await until(()=>stateOf(r1.id).state!=='pending');assert.equal(stateOf(r1.id).state,'cancelled');assert.match(stateOf(r1.id).reason,/respondió/);assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE client_ref=?').get('sched:'+r1.id).n,0);
 // …salvo que la persona haya pedido que salga de todos modos
 const r2=(await make(admin.cookie,{text:'Aviso que sale aunque responda',cancelOnReply:false})).item;await sleep(30);
 await call(msgs(conv.id),ana.cookie,{text:'Otra duda',clientRef:randomUUID()},'POST',201);due(r2.id);
 await until(()=>stateOf(r2.id).state!=='pending');assert.equal(stateOf(r2.id).state,'sent');

 // un mensaje viejo (el servidor estuvo apagado) no sale, y se dice por qué
 const old=(await make(admin.cookie,{text:'Esto ya no aplica'})).item;db.prepare('UPDATE scheduled_messages SET send_at=? WHERE id=?').run(T()-7*HOUR,old.id);
 await until(()=>stateOf(old.id).state!=='pending');assert.equal(stateOf(old.id).state,'failed');assert.match(stateOf(old.id).reason,/6 horas/);

 // «Enviar ahora» lo manda en el momento por la misma ruta
 const now=(await make(admin.cookie,{text:'Enviar ya'})).item;const out=await call('/api/scheduled/'+now.id+'/send-now',admin.cookie,{},'POST');assert.equal(out.outcome,'sent');assert.equal(out.item.state,'sent');
 await call('/api/scheduled/'+now.id+'/send-now',admin.cookie,{},'POST',409);

 // si otra persona pasa a atender el chat, el mensaje de quien no lo atiende no sale (y se dice por qué)
 const colegaId=db.prepare("SELECT id FROM users WHERE username='colega'").get().id,adminId=db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
 db.prepare('UPDATE conversations SET assigned_to=NULL WHERE id=?').run(conv.id);
 const mine=(await call(sched(conv.id),colega.cookie,{text:'Mensaje de Colega',sendAt:T()+2*HOUR,clientRef:randomUUID()},'POST',201)).item;
 db.prepare('UPDATE conversations SET assigned_to=? WHERE id=?').run(adminId,conv.id);due(mine.id);
 await until(()=>stateOf(mine.id).state!=='pending');assert.equal(stateOf(mine.id).state,'failed');assert.match(stateOf(mine.id).reason,/Otra persona atiende/);
 // y con el chat de otra persona tampoco se puede programar (misma regla que enviar)
 await call(sched(conv.id),colega.cookie,{text:'x',sendAt:T()+2*HOUR,clientRef:randomUUID()},'POST',409);
 db.prepare('UPDATE conversations SET assigned_to=? WHERE id=?').run(colegaId,conv.id);

 // quien perdió el acceso a la marca no envía
 const lost=(await call(sched(conv.id),colega.cookie,{text:'Mensaje tras perder acceso',sendAt:T()+2*HOUR,clientRef:randomUUID()},'POST',201)).item;
 db.prepare('DELETE FROM brand_members WHERE user_id=? AND brand_id=?').run(colegaId,brand);due(lost.id);
 await until(()=>stateOf(lost.id).state!=='pending');assert.equal(stateOf(lost.id).state,'failed');assert.match(stateOf(lost.id).reason,/acceso/);
 db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(colegaId,brand);

 // una conversación cerrada cancela lo pendiente y no admite programar
 const c2=(await call('/api/conversations',ana.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const p2=(await call(sched(c2.id),admin.cookie,{text:'Para el chat que se cierra',sendAt:T()+2*HOUR,clientRef:randomUUID()},'POST',201)).item;
 await call('/api/conversations/'+c2.id+'/action',admin.cookie,{action:'resolve'},'POST');due(p2.id);
 await until(()=>stateOf(p2.id).state!=='pending');assert.equal(stateOf(p2.id).state,'cancelled');assert.match(stateOf(p2.id).reason,/cerró/);
 await call(sched(c2.id),admin.cookie,{text:'x',sendAt:T()+2*HOUR,clientRef:randomUUID()},'POST',409);

 // tope de pendientes por chat
 const c3=(await call('/api/conversations',(await call('/api/auth/register','',{username:'bea',name:'Bea',password})).cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 for(let i=0;i<10;i++)await call(sched(c3.id),admin.cookie,{text:'Pendiente '+i,sendAt:T()+(i+2)*HOUR,clientRef:randomUUID()},'POST',201);
 await call(sched(c3.id),admin.cookie,{text:'Sobra uno',sendAt:T()+20*HOUR,clientRef:randomUUID()},'POST',409);
 assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action LIKE 'scheduled.%'").get().n>=8,true,'quedan registros de auditoría');
 db.close();
});
