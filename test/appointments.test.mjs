import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('agenda de citas: alcance, validación, empalmes, recordatorio al cliente, mover y cancelar, cierre y aviso previo',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-appt-')),code=randomUUID(),password='Password-appt-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),apps=id=>'/api/conversations/'+id+'/appointments';
 async function until(fn,tries=30){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const ana=await call('/api/auth/register','',{username:'ana',name:'Ana Pérez',password});
 const conv=(await call('/api/conversations',ana.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});
 const brand=db.prepare('SELECT brand_id FROM conversations WHERE id=?').get(conv.id).brand_id;
 const team=async(username,name,brandId)=>{const u=await call('/api/auth/register','',{username,name,password});const inv=await call('/api/team/invites',admin.cookie,{username,brandIds:[brandId]},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});return u;};
 const colega=await team('colega','Colega Ventas',brand);
 const outsider=await team('fuera','Asesor de otra marca',brand==='odonteck'?'dermalysse':'odonteck');
 const T=()=>Date.now(),H=3600*1000,MIN=60*1000;
 const make=(cookie,over={},c=conv)=>call(apps(c.id),cookie,{title:'Llamada de asesoría',startsAt:T()+24*H,durationMin:30,kind:'llamada',clientRef:randomUUID(),...over},'POST',over.expect||201);
 const stateOf=id=>db.prepare('SELECT * FROM appointments WHERE id=?').get(id),remOf=id=>db.prepare('SELECT * FROM scheduled_messages WHERE id=?').get(id);

 // alcance
 await call(apps(conv.id),'',undefined,'GET',401);await call(apps(conv.id),ana.cookie,undefined,'GET',403);await call(apps(conv.id),outsider.cookie,undefined,'GET',404);
 await call(apps(conv.id),outsider.cookie,{title:'x',startsAt:T()+H,clientRef:randomUUID()},'POST',404);
 await call('/api/appointments','',undefined,'GET',401);await call('/api/appointments',ana.cookie,undefined,'GET',403);

 // validación
 await make(admin.cookie,{title:'  ',expect:400});await make(admin.cookie,{startsAt:T()-H,expect:400});await make(admin.cookie,{startsAt:T()+10*1000,expect:400});
 await make(admin.cookie,{startsAt:T()+200*86400*1000,expect:400});await make(admin.cookie,{startsAt:'mañana',expect:400});await make(admin.cookie,{durationMin:2,expect:400});
 await make(admin.cookie,{durationMin:600,expect:400});await make(admin.cookie,{kind:'telepatía',expect:400});await make(admin.cookie,{clientRef:'corta',expect:400});

 // crear; reintento con la misma referencia no duplica
 const start=T()+30*H,ref=randomUUID();
 const a=await call(apps(conv.id),admin.cookie,{title:'Llamada de asesoría',startsAt:start,durationMin:45,kind:'videollamada',place:'https://meet.ejemplo.com/abc',notes:'Quiere comparar dos cursos',clientRef:ref},'POST',201);
 assert.equal(a.item.state,'scheduled');assert.equal(a.item.mine,true);assert.equal(a.item.endsAt,start+45*MIN);assert.equal(a.item.reminder,null);assert.equal(a.item.kind,'videollamada');
 const dup=await call(apps(conv.id),admin.cookie,{title:'otra',startsAt:start,clientRef:ref},'POST',200);assert.equal(dup.duplicate,true);assert.equal(dup.item.id,a.item.id);
 const seen=(await call(apps(conv.id),colega.cookie)).items[0];assert.equal(seen.mine,false);assert.equal(seen.ownerName,'Administración');

 // empalmes: la misma persona no tiene dos citas a la vez, salvo que lo confirme; otra persona sí puede
 const over=await make(admin.cookie,{startsAt:start+20*MIN,expect:409});assert.ok(over.error===undefined||true);
 await call(apps(conv.id),admin.cookie,{title:'Pegada',startsAt:start+45*MIN,durationMin:15,clientRef:randomUUID()},'POST',201);   // empieza justo cuando termina la anterior: no se empalma
 await call(apps(conv.id),admin.cookie,{title:'Empalme confirmado',startsAt:start+10*MIN,durationMin:10,allowOverlap:true,clientRef:randomUUID()},'POST',201);

 // recordatorio al cliente: es un mensaje programado normal, una hora antes, que sale aunque el cliente responda; con citas muy próximas se avisa y no se programa
 const withRem=await call(apps(conv.id),admin.cookie,{title:'Cita con recordatorio',startsAt:T()+48*H,durationMin:30,clientRef:randomUUID(),reminder:{text:'Hola Ana, te recuerdo nuestra llamada de hoy a las 4:00 p. m.',minutesBefore:60}},'POST',201);
 const rem=remOf(withRem.item.reminder.id);assert.equal(rem.state,'pending');assert.equal(rem.send_at,withRem.item.startsAt-H);assert.equal(rem.cancel_on_reply,0);assert.equal(rem.text,'Hola Ana, te recuerdo nuestra llamada de hoy a las 4:00 p. m.');assert.equal(rem.author_id,db.prepare("SELECT id FROM users WHERE username='admin'").get().id);
 const soon=await call(apps(conv.id),admin.cookie,{title:'Cita muy próxima',startsAt:T()+10*MIN,durationMin:5,clientRef:randomUUID(),reminder:{text:'Te recuerdo',minutesBefore:60}},'POST',201);
 assert.equal(soon.item.reminder,null);assert.match(soon.warning,/muy pronto/);

 // editar: revisión, permisos; mover la cita retira el recordatorio viejo (diría otra hora) y avisa
 const edited=(await call('/api/appointments/'+a.item.id,admin.cookie,{title:'Llamada con Ana',notes:'Nueva nota',expectedRevision:a.item.revision},'PATCH')).item;assert.equal(edited.title,'Llamada con Ana');assert.equal(edited.revision,a.item.revision+1);
 await call('/api/appointments/'+a.item.id,admin.cookie,{title:'viejo',expectedRevision:a.item.revision},'PATCH',409);
 await call('/api/appointments/'+a.item.id,colega.cookie,{title:'ajeno',expectedRevision:edited.revision},'PATCH',403);
 await call('/api/appointments/'+a.item.id,outsider.cookie,{title:'x',expectedRevision:edited.revision},'PATCH',404);
 await call('/api/appointments/'+a.item.id,admin.cookie,{title:' ',expectedRevision:edited.revision},'PATCH',400);
 const moved=await call('/api/appointments/'+withRem.item.id,admin.cookie,{startsAt:T()+72*H,expectedRevision:withRem.item.revision},'PATCH');
 assert.equal(remOf(withRem.item.reminder.id).state,'cancelled');assert.match(remOf(withRem.item.reminder.id).reason,/cambió/);assert.match(moved.warning,/recordatorio anterior se canceló/);assert.equal(moved.item.reminder,null);
 // mover con recordatorio nuevo lo programa
 const again=await call('/api/appointments/'+withRem.item.id,admin.cookie,{startsAt:T()+96*H,expectedRevision:moved.item.revision,reminder:{text:'Nuevo recordatorio',minutesBefore:120}},'PATCH');
 assert.equal(remOf(again.item.reminder.id).state,'pending');assert.equal(remOf(again.item.reminder.id).send_at,again.item.startsAt-2*H);

 // cerrar: «hecha» o «no asistió» sólo cuando ya empezó; cancelar siempre (y retira el recordatorio)
 await call('/api/appointments/'+a.item.id+'/state',admin.cookie,{state:'done'},'POST',409);
 await call('/api/appointments/'+a.item.id+'/state',admin.cookie,{state:'mal'},'POST',400);
 await call('/api/appointments/'+a.item.id+'/state',colega.cookie,{state:'cancelled'},'POST',403);
 await call('/api/appointments/'+withRem.item.id+'/state',admin.cookie,{state:'cancelled'},'POST');assert.equal(remOf(again.item.reminder.id).state,'cancelled');assert.match(remOf(again.item.reminder.id).reason,/se canceló/);
 await call('/api/appointments/'+withRem.item.id+'/state',admin.cookie,{state:'cancelled'},'POST',409);
 db.prepare('UPDATE appointments SET starts_at=? WHERE id=?').run(T()-2*H,a.item.id);
 const closed=(await call('/api/appointments/'+a.item.id+'/state',admin.cookie,{state:'no_show'},'POST')).item;assert.equal(closed.state,'no_show');
 await call('/api/appointments/'+a.item.id,admin.cookie,{title:'x',expectedRevision:closed.revision},'PATCH',409);

 // aviso poco antes: a quien la lleva, una sola vez por hora de cita, y vuelve a avisar si se mueve a otra hora cercana
 const notes=id=>db.prepare("SELECT * FROM notifications WHERE kind='appointment' AND event_key LIKE ?").all('appointment:'+id+':%');
 const near=await until(()=>notes(soon.item.id).length===1&&notes(soon.item.id));assert.ok(near,'aviso de cita próxima');assert.equal(near[0].user_id,db.prepare("SELECT id FROM users WHERE username='admin'").get().id);assert.match(near[0].title,/Cita en unos minutos · Cita muy próxima · Ana Pérez · llamada/);assert.equal(near[0].conversation_id,conv.id);
 await sleep(2500);assert.equal(notes(soon.item.id).length,1,'no se repite');
 const lejana=notes(withRem.item.id);assert.equal(lejana.length,0,'las citas lejanas no avisan');
 // push: el aviso va al grupo «chats»
 const {groupOf}=await import('../server/push.mjs');assert.equal(groupOf('appointment'),'chats');

 // Mi día: mis citas pendientes, lo más próximo primero; sin canceladas ni cerradas ni de otras personas
 const mineList=(await call('/api/appointments',admin.cookie)).items;
 assert.ok(mineList.length>=3&&mineList.every(i=>i.state==='scheduled'&&i.mine&&i.customerName==='Ana Pérez'&&i.brandName));assert.deepEqual(mineList.map(i=>i.startsAt),[...mineList.map(i=>i.startsAt)].sort((x,y)=>x-y));
 assert.ok(!mineList.some(i=>[a.item.id,withRem.item.id].includes(i.id)));
 assert.equal((await call('/api/appointments',colega.cookie)).items.length,0);assert.equal((await call('/api/appointments',outsider.cookie)).items.length,0);

 // conversación cerrada no admite citas; otra persona atendiendo el chat tampoco; tope de pendientes
 const c2=(await call('/api/conversations',ana.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;await call('/api/conversations/'+c2.id+'/action',admin.cookie,{action:'resolve'},'POST');
 await make(admin.cookie,{expect:409},c2);
 const c3=(await call('/api/conversations',(await call('/api/auth/register','',{username:'bea',name:'Bea',password})).cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 db.prepare('UPDATE conversations SET assigned_to=(SELECT id FROM users WHERE username=?) WHERE id=?').run('admin',c3.id);await make(colega.cookie,{expect:409},c3);   // la atiende administración: Colega no puede agendar ahí
 db.prepare('UPDATE conversations SET assigned_to=NULL WHERE id=?').run(c3.id);
 for(let i=0;i<10;i++)await make(colega.cookie,{startsAt:T()+(200+i)*H},c3);
 await make(colega.cookie,{startsAt:T()+300*H,expect:409},c3);
 assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action LIKE 'appointment.%'").get().n>=10,true,'auditoría');
 // vista semanal: por rango, mías o de todo el equipo, sin canceladas, con alcance por marca
 const rng=(cookie,q,expected=200)=>call('/api/appointments?'+new URLSearchParams(q),cookie,undefined,'GET',expected);
 const from=T()-86400*1000,to=T()+10*86400*1000;
 await rng(admin.cookie,{from},400);await rng(admin.cookie,{from:to,to:from},400);await rng(admin.cookie,{from:T(),to:T()+60*86400*1000},400);await rng(admin.cookie,{from:'x',to:'y'},400);
 await rng('',{from,to},401);await rng(ana.cookie,{from,to},403);await rng(outsider.cookie,{from,to,scope:'team',brand},404);
 const wk=(await rng(admin.cookie,{from,to})).items;
 assert.ok(wk.some(i=>i.id===a.item.id&&i.state==='no_show'),'incluye las cerradas del rango');assert.ok(!wk.some(i=>i.id===withRem.item.id),'sin canceladas');
 assert.ok(wk.every(i=>i.mine&&i.customerName&&i.brandName&&i.startsAt>=from&&i.startsAt<to),'sólo las mías y dentro del rango');
 assert.deepEqual(wk.map(i=>i.startsAt),[...wk.map(i=>i.startsAt)].sort((x,y)=>x-y),'ordenadas por hora');
 assert.equal((await rng(admin.cookie,{from:T()+60*86400*1000,to:T()+70*86400*1000})).items.length,0,'fuera del rango no hay nada');
 assert.equal((await rng(colega.cookie,{from,to})).items.filter(i=>i.ownerName==='Administración').length,0,'«mías» no trae las de otra persona');
 const teamWeek=(await rng(colega.cookie,{from,to,scope:'team'})).items;assert.ok(teamWeek.some(i=>i.id===a.item.id&&i.ownerName==='Administración'&&i.mine===false),'el equipo de la marca ve las de administración');
 assert.equal((await rng(outsider.cookie,{from,to,scope:'team'})).items.length,0,'otra marca no ve nada');
 assert.equal((await rng(admin.cookie,{from,to,scope:'team',brand})).items.length>=wk.length,true);
 assert.equal((await rng(admin.cookie,{from,to,scope:'team',brand:brand==='odonteck'?'dermalysse':'odonteck'})).items.length,0,'el filtro por marca separa');
 db.close();
});
