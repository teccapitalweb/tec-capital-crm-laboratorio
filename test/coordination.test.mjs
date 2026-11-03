import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {RUN_STATUS,TRANSITIONS,simulatedCalendar} from '../server/coordination.mjs';

test('transiciones de apertura y calendario simulado',async()=>{
  assert.deepEqual(Object.keys(RUN_STATUS),['planned','open','running','closed','cancelled']);
  assert.deepEqual(TRANSITIONS.closed,[]);assert.ok(TRANSITIONS.planned.includes('open'));assert.ok(!TRANSITIONS.planned.includes('closed'));
  const r=await simulatedCalendar.createEvent({title:'x',startsAt:Date.now(),durationMin:60});assert.match(r.url,/^https:\/\/meet\.simulado\.tec-capital\.test\/[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{3}$/);assert.match(r.providerRef,/^simcal_/);
});

test('coordinación académica por API: la venta confirmada entra sola a la apertura, mínimo alcanzado abre, sesiones con enlace simulado, recordatorio a inscritos, asistencia, cierre, bajas, recursos, bitácora de eventos y permisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-coordination-')),code=randomUUID(),password='Password-coordination-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite')),msgs=id=>'/api/conversations/'+id+'/messages';
 async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 const count=(sql,...args)=>{const d=db();try{return d.prepare(sql).get(...args).n;}finally{d.close();}};
 const eventsOf=async(type,extra='')=>(await call('/api/events?brand=all&type='+type+extra,admin.cookie)).events;
 assert.equal((await fetch(origin+'/coordination.js')).status,200);

 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const agent=await call('/api/auth/register','',{username:'asesor',name:'Asesora',password});
 const inv=await call('/api/team/invites',admin.cookie,{username:'asesor',brandIds:['globalvet']},'POST',201);await call('/api/team/accept',agent.cookie,{token:inv.token});
 const clients=[];for(let i=1;i<=5;i++)clients.push(await call('/api/auth/register','',{username:'alumno'+i,name:'Alumno '+i,password}));

 // apagado por omisión y permisos
 await call('/api/coordination',clients[0].cookie,undefined,'GET',403);
 await call('/api/events',clients[0].cookie,undefined,'GET',403);
 await call('/api/events',agent.cookie,undefined,'GET',403);
 await call('/api/coordination/brands/globalvet',agent.cookie,{enabled:true,expectedRevision:0},'PATCH',403);
 const ov0=await call('/api/coordination?brand=globalvet',admin.cookie);
 const aves=ov0.editions.find(e=>e.id==='edition-aves');assert.equal(aves.run_status,'planned');assert.equal(aves.enrolled,0);assert.equal(aves.min_students,0);assert.equal(ov0.settings[0].enabled,0);
 assert.deepEqual((await call('/api/coordination?brand=odonteck',agent.cookie)).editions,[],'sin acceso a la marca no se ven aperturas');
 const cs=(await call('/api/coordination/brands/globalvet',admin.cookie,{enabled:true,autoOpen:true,reminderHours:48,expectedRevision:0},'PATCH')).settings;assert.equal(cs.enabled,1);assert.equal(cs.reminder_hours,48);
 await call('/api/coordination/brands/globalvet',admin.cookie,{reminderHours:0,expectedRevision:1},'PATCH',400);
 await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:0},'PATCH');

 // apertura: mínimo 5, responsable, grupo
 await call('/api/coordination/editions/edition-aves',admin.cookie,{minStudents:5,expectedRevision:7},'PATCH',409);
 await call('/api/coordination/editions/edition-aves',admin.cookie,{groupUrl:'ftp://x',expectedRevision:1},'PATCH',400);
 await call('/api/coordination/editions/edition-aves',admin.cookie,{coordinatorId:clients[0].user.id,expectedRevision:1},'PATCH',400);
 await call('/api/coordination/editions/edition-aves',agent.cookie,{coordinatorId:agent.user.id,expectedRevision:1},'PATCH',403);   // una asesora no se nombra responsable a sí misma
 assert.equal((await call('/api/coordination/editions/edition-aves',agent.cookie,{minStudents:3,expectedRevision:1},'PATCH')).edition.min_students,3,'sí puede ajustar mínimo, grupo y notas');
 const run=(await call('/api/coordination/editions/edition-aves',admin.cookie,{minStudents:5,coordinatorId:admin.user.id,groupUrl:'https://chat.whatsapp.com/prueba',note:'Grupo de prueba',expectedRevision:2},'PATCH')).edition;
 assert.equal(run.min_students,5);assert.equal(run.coordinatorName,'Administración');assert.equal(run.run_revision,3);assert.equal(run.progress,0);
 await call('/api/coordination/editions/edition-aves',agent.cookie,{coordinatorId:null,expectedRevision:3},'PATCH',403);   // ni quitar a la responsable
 await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'closed',expectedRevision:3},'POST',409);   // de planeada no se cierra
 await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'running',expectedRevision:3},'POST',409);

 // cinco ventas confirmadas: cada una entra sola a la apertura; al llegar al mínimo la apertura se abre
 const convs=[];
 for(const [i,cl] of clients.entries()){
   const conv=(await call('/api/conversations',cl.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;convs.push(conv);
   const o=(await call('/api/conversations/'+conv.id+'/orders',admin.cookie,{},'POST',201)).order;
   assert.equal((await call('/api/payments/orders/'+o.id+'/pay',cl.cookie,{method:'card'})).order.status,'paid');
   if(i<4){await sleep(300);assert.equal((await call('/api/coordination?brand=globalvet',admin.cookie)).editions.find(e=>e.id==='edition-aves').run_status,'planned');}
 }
 const opened=await until(async()=>{const e=(await call('/api/coordination?brand=globalvet',admin.cookie)).editions.find(e=>e.id==='edition-aves');return e.run_status==='open'?e:null;});
 assert.ok(opened,'la apertura se abre sola al llegar al mínimo');assert.equal(opened.enrolled,5);assert.equal(opened.progress,100);assert.equal(opened.missing,0);
 const auto=(await eventsOf('apertura.abierta'));assert.equal(auto.length,1);assert.equal(auto[0].payload.auto,true);assert.equal(auto[0].payload.enrolled,5);assert.equal(auto[0].source,'coordination.auto');
 assert.equal((await eventsOf('pago.confirmado')).length,5);assert.equal((await eventsOf('inscripcion.activada')).length,5);assert.equal((await eventsOf('pedido.creado')).length,5);assert.equal((await eventsOf('conversacion.abierta')).length,5);
 const stages=await eventsOf('oportunidad.etapa');assert.ok(stages.length>=5);assert.ok(stages.every(e=>e.payload.to==='ganada'||e.payload.from===null||e.payload.to));
 const sale=await until(async()=>{const r=await call('/api/events/'+(await eventsOf('pago.confirmado'))[0].seq,admin.cookie);return r.deliveries.find(d=>d.subscriber==='coordination.sale')?.state==='done'?r:null;});
 assert.ok(sale,'la venta confirmada se entregó al suscriptor de coordinación');assert.equal(sale.event.payload.enrollmentId.length,36);
 assert.ok(count("SELECT count(*) n FROM notifications WHERE kind='coordination' AND user_id=?",admin.user.id)>=6,'aviso por inscripción y por apertura al responsable');
 assert.equal(count("SELECT count(*) n FROM notifications WHERE kind='coordination' AND user_id=?",agent.user.id),0,'con responsable asignado, los avisos van sólo a esa persona');

 // ficha: inscritos con contacto, pago y chat
 const d1=await call('/api/coordination/editions/edition-aves',admin.cookie);
 assert.equal(d1.enrollments.length,5);assert.ok(d1.enrollments.every(r=>r.status==='enrolled'&&/^TC-/.test(r.reference)&&r.paid_at&&r.conversation_id));assert.equal(d1.enrollments[0].contact_name,'Alumno 1');assert.equal(d1.canClose,true);
 assert.equal((await call('/api/coordination/editions/edition-aves',agent.cookie)).canClose,false,'la asesora no es responsable');
 assert.ok(d1.events.some(e=>e.type==='apertura.abierta'),'la bitácora de la apertura muestra sus eventos');

 // el cuarto alumno pide la baja de mensajes: sigue inscrito, pero no recibe recordatorios
 await call(msgs(convs[3].id),clients[3].cookie,{text:'BAJA',clientRef:randomUUID()},'POST',201);
 assert.ok(await until(async()=>count("SELECT count(*) n FROM contact_consent WHERE status='opted_out'")===1),'baja registrada');
 assert.equal((await eventsOf('baja.registrada')).length,1);

 // sesiones: validación, enlace simulado, recordatorio inmediato a los inscritos (dentro de la ventana de 48 h), salvo quien pidió la baja
 await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{title:'Sin fecha'},'POST',400);
 await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{startsAt:Date.now()+7200000,durationMin:5},'POST',400);
 const soon=Date.now()+7200000,s1=(await call('/api/coordination/editions/edition-aves/sessions',agent.cookie,{title:'Bienvenida',startsAt:soon,durationMin:60,createMeet:true},'POST',201)).session;
 assert.equal(s1.number,1);assert.match(s1.meet_url,/^https:\/\/meet\.simulado\.tec-capital\.test\//);assert.equal(s1.meet_provider,'simulated');assert.equal(s1.status,'scheduled');assert.ok(s1.reminder_sent_at,'la sesión ya cae en la ventana: recordatorio publicado al programarla');
 const later=Date.now()+10*86400000,s2=(await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{startsAt:later,meetUrl:'https://meet.google.com/abc-defg-hij'},'POST',201)).session;
 assert.equal(s2.number,2);assert.equal(s2.title,'Sesión 2');assert.equal(s2.meet_provider,'manual');assert.equal(s2.reminder_sent_at,null,'fuera de la ventana todavía no se recuerda');
 assert.equal((await eventsOf('sesion.programada')).length,2);assert.equal((await eventsOf('sesion.proxima')).length,1);
 const reminded=await until(async()=>{const m=(await call(msgs(convs[4].id),clients[4].cookie)).messages.at(-1);return /Recordatorio de clase/.test(m.text)?m:null;});
 assert.ok(reminded,'cada inscrito recibe el recordatorio por su chat');assert.match(reminded.text,/Bienvenida/);assert.match(reminded.text,/meet\.simulado/);assert.match(reminded.text,/chat\.whatsapp\.com\/prueba/);assert.equal(reminded.category,'utility');assert.equal(reminded.sender_kind,'automation');
 await sleep(2500);assert.equal(count("SELECT count(*) n FROM messages WHERE client_ref LIKE 'session:%:reminder:%'"),4,'un recordatorio por inscrito que acepta mensajes, sin duplicados');
 assert.ok(!(await call(msgs(convs[3].id),clients[3].cookie)).messages.some(m=>/Recordatorio de clase/.test(m.text)),'quien pidió la baja no recibe el recordatorio');
 assert.equal(count("SELECT count(*) n FROM notifications WHERE event_key LIKE 'session:%:reminder-skipped'"),1,'la responsable sabe a quién avisar por otro medio');
 const s2b=(await call('/api/coordination/sessions/'+s2.id,admin.cookie,{startsAt:Date.now()+3600000,expectedRevision:s2.revision},'PATCH')).session;
 assert.ok(s2b.reminder_sent_at,'al mover la sesión dentro de la ventana se recuerda');assert.equal((await eventsOf('sesion.proxima')).length,2);
 await call('/api/coordination/sessions/'+s2.id,admin.cookie,{title:'x',expectedRevision:s2.revision},'PATCH',409);
 const meet2=(await call('/api/coordination/sessions/'+s2.id+'/meet',admin.cookie,{})).session;assert.equal(meet2.meet_provider,'simulated');
 const pres=await call('/api/presentation?brand=globalvet',admin.cookie);assert.equal(pres.script.length,11);const step=pres.script.find(s=>s.id==='coordinacion');assert.equal(step.ready,true);assert.match(step.detail,/1 aperturas abiertas/);assert.equal(pres.coordination.upcoming,2);

 // asistencia y sesión realizada
 const ids=d1.enrollments.map(r=>r.id);
 await call('/api/coordination/sessions/'+s1.id+'/attendance',admin.cookie,{marks:[{enrollmentId:ids[0],status:'durmiendo'}]},'PUT',400);
 await call('/api/coordination/sessions/'+s1.id+'/attendance',admin.cookie,{marks:[{enrollmentId:randomUUID(),status:'present'}]},'PUT',400);
 const att=(await call('/api/coordination/sessions/'+s1.id+'/attendance',agent.cookie,{marks:ids.map((id,i)=>({enrollmentId:id,status:i<3?'present':i===3?'absent':'late',note:i===3?'Avisó':''}))},'PUT')).session;
 assert.deepEqual([att.attendance.present,att.attendance.absent,att.attendance.late,att.attendance.excused],[3,1,1,0]);assert.equal(att.attendance.marks[ids[3]].note,'Avisó');
 const att2=(await call('/api/coordination/sessions/'+s1.id+'/attendance',admin.cookie,{marks:[{enrollmentId:ids[3],status:'excused'}]},'PUT')).session;assert.equal(att2.attendance.absent,0);assert.equal(att2.attendance.excused,1);
 assert.equal((await eventsOf('asistencia.registrada')).length,2);
 const done=(await call('/api/coordination/sessions/'+s1.id+'/done',admin.cookie,{})).session;assert.equal(done.status,'done');
 await call('/api/coordination/sessions/'+s1.id+'/done',admin.cookie,{},'POST',409);
 await call('/api/coordination/sessions/'+s1.id,admin.cookie,{startsAt:Date.now(),expectedRevision:done.revision},'PATCH',409);
 const held=(await eventsOf('sesion.realizada'));assert.equal(held.length,1);assert.equal(held[0].payload.present,4);assert.equal(held[0].payload.absent,0);
 assert.equal((await call('/api/coordination/editions/edition-aves',admin.cookie)).enrollments[0].attended,1);
 await call('/api/coordination/sessions/'+s2.id+'/cancel',admin.cookie,{reason:'x'},'POST',400);
 assert.equal((await call('/api/coordination/sessions/'+s2.id+'/cancel',admin.cookie,{reason:'Se reprograma la semana próxima'})).session.status,'cancelled');
 await call('/api/coordination/sessions/'+s2.id+'/attendance',admin.cookie,{marks:[{enrollmentId:ids[0],status:'present'}]},'PUT',409);

 // recursos
 await call('/api/coordination/editions/edition-aves/resources',admin.cookie,{kind:'video',title:'x'},'POST',400);
 await call('/api/coordination/editions/edition-aves/resources',admin.cookie,{kind:'material',title:'Guía'},'POST',400);
 const res=await call('/api/coordination/editions/edition-aves/resources',agent.cookie,{kind:'recording',title:'Grabación 1',url:'https://example.com/grabacion-1',sessionId:s1.id},'POST',201);
 const d2=await call('/api/coordination/editions/edition-aves',admin.cookie);assert.equal(d2.resources.length,1);assert.equal(d2.resources[0].kindLabel,'Grabación');assert.equal(d2.sessions.find(s=>s.id===s1.id).recording_url,'https://example.com/grabacion-1');
 await call('/api/coordination/resources/'+res.id,admin.cookie,undefined,'DELETE');await call('/api/coordination/resources/'+res.id,admin.cookie,undefined,'DELETE',404);

 // estados: en curso → cerrada; sólo administración o responsable cierra; revisión obsoleta
 const cur=(await call('/api/coordination/editions/edition-aves',admin.cookie)).edition;
 await call('/api/coordination/editions/edition-aves/status',agent.cookie,{to:'cancelled',reason:'No procede',expectedRevision:cur.run_revision},'POST',403);
 const running=(await call('/api/coordination/editions/edition-aves/status',agent.cookie,{to:'running',expectedRevision:cur.run_revision},'POST')).edition;assert.equal(running.run_status,'running');
 await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'closed',expectedRevision:cur.run_revision},'POST',409);
 await call('/api/coordination/editions/edition-aves/status',agent.cookie,{to:'closed',expectedRevision:running.run_revision},'POST',403);
 const closed=(await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'closed',expectedRevision:running.run_revision},'POST')).edition;assert.equal(closed.run_status,'closed');assert.deepEqual(closed.transitions,[]);
 await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'open',expectedRevision:closed.run_revision},'POST',409);
 await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{startsAt:Date.now()+86400000},'POST',409);
 assert.equal((await eventsOf('apertura.en_curso')).length,1);assert.equal((await eventsOf('apertura.cerrada')).length,1);

 // baja de inscripción: libera cupo, evento, sólo responsable/administración
 await call('/api/coordination/enrollments/'+ids[0]+'/cancel',agent.cookie,{reason:'Pidió la baja'},'POST',403);
 await call('/api/coordination/enrollments/'+ids[0]+'/cancel',admin.cookie,{reason:'x'},'POST',400);
 const after=(await call('/api/coordination/enrollments/'+ids[0]+'/cancel',admin.cookie,{reason:'Pidió la baja por trabajo'})).edition;assert.equal(after.enrolled,4);
 await call('/api/coordination/enrollments/'+ids[0]+'/cancel',admin.cookie,{reason:'Otra vez la baja'},'POST',409);
 assert.equal((await eventsOf('inscripcion.cancelada')).length,1);assert.equal(count("SELECT count(*) n FROM enrollments WHERE status='cancelled'"),1);

 // bitácora: alcance, filtros, detalle, CSV, catálogo de tipos
 const all=await until(async()=>{const r=await call('/api/events?brand=all',admin.cookie);return r.stats.pending===0?r:null;});   // el reloj de entregas corre cada segundo: se espera a que no quede nada pendiente
 assert.ok(all,'todas las entregas a suscriptores terminaron');assert.ok(all.stats.total>=30);assert.equal(all.stats.failed,0);assert.equal(all.events[0].seq,all.stats.total);
 assert.equal((await call('/api/events?brand=odonteck',admin.cookie)).stats.total,0);
 await call('/api/events?brand=inexistente',admin.cookie,undefined,'GET',404);
 const ref=d1.enrollments[1].reference;const byRef=(await call('/api/events?brand=all&entityId='+ref,admin.cookie)).events;assert.ok(byRef.length>=2);assert.ok(byRef.every(e=>JSON.stringify(e.payload).includes(ref)));
 assert.equal((await call('/api/events?brand=all&entity=session',admin.cookie)).events.every(e=>e.entity_kind==='session'),true);
 const page=(await call('/api/events?brand=all&limit=3',admin.cookie));assert.equal(page.events.length,3);assert.equal(page.nextBefore,page.events[2].seq);assert.ok((await call('/api/events?brand=all&limit=3&before='+page.nextBefore,admin.cookie)).events.every(e=>e.seq<page.nextBefore));
 const ty=await call('/api/events/types',admin.cookie);assert.ok(ty.types.find(x=>x.type==='pago.confirmado').subscribers.includes('coordination.sale'));assert.equal(ty.entities.edition,'Apertura');
 const csv=await fetch(origin+'/api/events.csv?brand=globalvet&type=pago.confirmado',{headers:{Cookie:admin.cookie,Origin:origin}});assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);const body=await csv.text();assert.equal(body.split('\n').length,6);assert.match(body,/pago\.confirmado/);
 await call('/api/events/999999',admin.cookie,undefined,'GET',404);await call('/api/events/1/retry',admin.cookie,{subscriber:'nadie'},'POST',404);
 assert.equal((await fetch(origin+'/api/events.csv',{headers:{Cookie:clients[0].cookie,Origin:origin}})).status,403);

 const d=db();try{assert.equal(d.prepare('PRAGMA user_version').get().user_version,20);assert.equal(d.prepare('SELECT count(*) n FROM domain_deliveries WHERE state!=\'done\'').get().n,0);assert.equal(d.prepare("SELECT count(*) n FROM edition_sessions WHERE edition_id='edition-aves'").get().n,2);}finally{d.close();}
});
