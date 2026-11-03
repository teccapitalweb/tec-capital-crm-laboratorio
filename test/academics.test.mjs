import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {npsOf,SURVEY_MODES,QUESTIONS} from '../server/surveys.mjs';

test('NPS y catálogo de encuesta',()=>{
  assert.deepEqual(npsOf([]),{promoters:0,passives:0,detractors:0,score:null});
  assert.deepEqual(npsOf([{nps:10},{nps:9},{nps:7},{nps:3}]),{promoters:2,passives:1,detractors:1,score:25});
  assert.deepEqual(Object.keys(SURVEY_MODES),['off','session','close','both']);assert.equal(QUESTIONS.length,3);
});

test('pagos por sesión y encuestas por API: precio por sesión en catálogo, inscripción por sesión que cubre la primera sesión, cobro manual y con el recordatorio, pago de sesión sin nueva inscripción, condonación y cancelaciones en cascada, encuesta automática y manual, respuesta pública por token, resultados, CSV y permisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-academics-')),code=randomUUID(),password='Password-academics-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),msgs=id=>'/api/conversations/'+id+'/messages';
 async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 const count=(sql,...args)=>{const d=db();try{return d.prepare(sql).get(...args).n;}finally{d.close();}};
 const eventsOf=async(type,extra='')=>(await call('/api/events?brand=all&type='+type+extra,admin.cookie)).events;
 const texts=async(conv,cookie)=>(await call(msgs(conv.id),cookie)).messages.map(m=>m.text);

 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const agent=await call('/api/auth/register','',{username:'asesor',name:'Asesora',password});
 const inv=await call('/api/team/invites',admin.cookie,{username:'asesor',brandIds:['globalvet']},'POST',201);await call('/api/team/accept',agent.cookie,{token:inv.token});
 const c1=await call('/api/auth/register','',{username:'alumno1',name:'Alumno Uno',password}),c2=await call('/api/auth/register','',{username:'alumno2',name:'Alumno Dos',password});

 // configuración: cobro de sesiones con el recordatorio y encuesta automática por sesión; modo inválido rechazado
 await call('/api/coordination/brands/globalvet',admin.cookie,{enabled:true,surveyMode:'nunca',expectedRevision:0},'PATCH',400);
 const cs=(await call('/api/coordination/brands/globalvet',admin.cookie,{enabled:true,autoOpen:false,reminderHours:48,chargeSessions:true,surveyMode:'session',expectedRevision:0},'PATCH')).settings;
 assert.equal(cs.charge_sessions,1);assert.equal(cs.survey_mode,'session');assert.equal(cs.auto_open,0);
 await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:0},'PATCH');

 // sin precio por sesión no hay plan por sesión
 const conv1=(await call('/api/conversations',c1.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 await call('/api/conversations/'+conv1.id+'/orders',admin.cookie,{plan:'per_session'},'POST',409);
 assert.equal((await call('/api/conversations/'+conv1.id+'/orders/preview',admin.cookie)).sessionPriceCents,null);

 // precio por sesión en el catálogo: no puede superar el regular
 const ed=(await call('/api/catalogue?brand=globalvet',admin.cookie)).editions.find(e=>e.id==='edition-aves');
 const base={name:ed.name,startsAt:ed.starts_at,endsAt:ed.ends_at,timezone:ed.timezone,instructor:ed.instructor,modality:ed.modality,location:ed.location,capacity:ed.capacity,availableSeats:ed.available_seats,infoUrl:ed.info_url,price:ed.price_cents/100,currency:ed.currency,status:ed.status};
 await call('/api/catalogue/editions/edition-aves',admin.cookie,{...base,sessionPrice:ed.price_cents/100+1,expectedRevision:ed.revision},'PATCH',400);
 const ed2=(await call('/api/catalogue/editions/edition-aves',admin.cookie,{...base,sessionPrice:350,expectedRevision:ed.revision},'PATCH')).item;assert.equal(ed2.session_price_cents,35000);
 const pv=await call('/api/conversations/'+conv1.id+'/orders/preview',admin.cookie);assert.equal(pv.sessionPriceCents,35000);assert.match(pv.sessionPriceLabel,/350/);

 // inscripción por sesión (alumno 1) y curso completo (alumno 2)
 const o1=(await call('/api/conversations/'+conv1.id+'/orders',admin.cookie,{plan:'per_session'},'POST',201)).order;
 assert.equal(o1.plan,'per_session');assert.equal(o1.kind,'course');assert.equal(o1.amount_cents,35000);assert.equal(o1.promotion_id,null);assert.equal(o1.planLabel,'Por sesión');
 assert.match((await texts(conv1,c1.cookie)).at(-1),/plan por sesión/);
 const cv1=(await call('/api/payments/orders/'+o1.id+'/customer',c1.cookie)).order;assert.equal(cv1.plan,'per_session');assert.equal(cv1.session,null);
 assert.equal((await call('/api/payments/orders/'+o1.id+'/pay',c1.cookie,{method:'card'})).order.status,'paid');
 assert.match((await texts(conv1,c1.cookie)).at(-1),/cubre tu primera sesión/);
 const conv2=(await call('/api/conversations',c2.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const o2=(await call('/api/conversations/'+conv2.id+'/orders',agent.cookie,{},'POST',201)).order;assert.equal(o2.plan,'full');assert.ok(o2.amount_cents>35000);
 assert.equal((await call('/api/payments/orders/'+o2.id+'/pay',c2.cookie,{method:'oxxo'})).order.status,'paid');
 const en1=count("SELECT count(*) n FROM enrollments WHERE payment_plan='per_session'"),enFull=count("SELECT count(*) n FROM enrollments WHERE payment_plan='full'");assert.equal(en1,1);assert.equal(enFull,1);
 assert.ok(await until(async()=>(await eventsOf('pago.confirmado')).length===2));
 // la apertura se confirma a mano (automatización de apertura apagada): los recordatorios sólo corren con la apertura abierta o en curso
 const run0=(await call('/api/coordination/editions/edition-aves',admin.cookie)).edition;
 await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'open',expectedRevision:run0.run_revision},'POST');

 // sesiones: la primera (en ventana) queda cubierta por la inscripción por sesión; las demás pendientes
 const s1=(await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{title:'Bienvenida',startsAt:Date.now()+7200000,durationMin:60},'POST',201)).session;
 const s2=(await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{title:'Anatomía',startsAt:Date.now()+3*86400000,durationMin:90},'POST',201)).session;
 const s3=(await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{title:'Clínica',startsAt:Date.now()+10*86400000,durationMin:90},'POST',201)).session;
 let d=await call('/api/coordination/editions/edition-aves',admin.cookie);
 const r1=d.enrollments.find(r=>r.contact_name==='Alumno Uno'),r2=d.enrollments.find(r=>r.contact_name==='Alumno Dos');
 assert.equal(r1.payment_plan,'per_session');assert.equal(r1.covered_session_id,s1.id);assert.equal(r1.paidSessions,1);assert.equal(r1.pendingSessions,2);assert.equal(r2.payment_plan,'full');assert.equal(r2.pendingSessions,0);
 assert.equal(d.sessionPayments.length,3);assert.equal(d.sessionPayments.find(p=>p.session_id===s1.id).status,'paid');assert.equal(d.sessionPayments.find(p=>p.session_id===s1.id).order_reference,o1.reference);assert.equal(d.sessionPayments.find(p=>p.session_id===s2.id).amount_cents,35000);assert.equal(d.edition.perSession,1);assert.equal(d.paymentsEnabled,true);
 assert.ok(await until(async()=>(await texts(conv1,c1.cookie)).some(x=>/Recordatorio de clase/.test(x))),'recordatorio de la sesión 1');
 await sleep(1500);assert.ok(!(await texts(conv1,c1.cookie)).some(x=>/Pago de la sesión 1/.test(x)),'la sesión cubierta no se cobra');
 assert.equal((await call('/api/coordination?brand=globalvet',admin.cookie)).stats.sessionDue,2);

 // cobro manual de la sesión 2 (asesora): pedido de sesión + enlace por el chat; reenvío no duplica; validaciones
 await call('/api/coordination/sessions/'+s2.id+'/charge',c1.cookie,{enrollmentId:r1.id},'POST',403);
 await call('/api/coordination/sessions/'+s2.id+'/charge',agent.cookie,{enrollmentId:r2.id},'POST',409);   // plan completo
 await call('/api/coordination/sessions/'+s1.id+'/charge',agent.cookie,{enrollmentId:r1.id},'POST',409);   // ya pagada
 await call('/api/coordination/sessions/'+s2.id+'/charge',agent.cookie,{enrollmentId:randomUUID()},'POST',404);
 const ch=await call('/api/coordination/sessions/'+s2.id+'/charge',agent.cookie,{enrollmentId:r1.id});
 assert.equal(ch.created,true);assert.equal(ch.order.kind,'session');assert.equal(ch.order.amount_cents,35000);assert.equal(ch.order.sessionNumber,2);assert.equal(ch.payment.status,'pending');
 const link=(await texts(conv1,c1.cookie)).at(-1);assert.match(link,/Pago de la sesión 2/);assert.match(link,/\?pay=/);
 const ch2=await call('/api/coordination/sessions/'+s2.id+'/charge',agent.cookie,{enrollmentId:r1.id});assert.equal(ch2.created,false);assert.equal(ch2.order.id,ch.order.id);
 assert.equal(count("SELECT count(*) n FROM orders WHERE kind='session'"),1);
 d=await call('/api/coordination/editions/edition-aves',admin.cookie);assert.equal(d.sessionPayments.find(p=>p.session_id===s2.id).open_reference,ch.order.reference);

 // el alumno paga la sesión: no hay nueva inscripción ni cambio de etapa; la fila queda pagada, el libro de finanzas la registra
 const cvs=(await call('/api/payments/orders/'+ch.order.id+'/customer',c1.cookie)).order;assert.equal(cvs.kind,'session');assert.equal(cvs.session.number,2);assert.equal(cvs.session.title,'Anatomía');
 await call('/api/payments/orders/'+ch.order.id+'/customer',c2.cookie,undefined,'GET',404);
 assert.equal((await call('/api/payments/orders/'+ch.order.id+'/pay',c1.cookie,{method:'card'})).order.status,'paid');
 assert.equal(count('SELECT count(*) n FROM enrollments'),2);
 d=await call('/api/coordination/editions/edition-aves',admin.cookie);const p2=d.sessionPayments.find(p=>p.session_id===s2.id);assert.equal(p2.status,'paid');assert.equal(p2.order_reference,ch.order.reference);assert.equal(d.enrollments.find(r=>r.id===r1.id).paidSessions,2);
 assert.match((await texts(conv1,c1.cookie)).at(-1),/Pago de la sesión 2 confirmado/);
 const paid=await until(async()=>{const ev=(await eventsOf('pago.confirmado')).find(e=>e.payload.kind==='session');return ev||null;});assert.ok(paid);assert.equal(paid.payload.sessionNumber,2);assert.equal(paid.payload.enrollmentId,r1.id);
 assert.ok(await until(async()=>count("SELECT count(*) n FROM notifications WHERE title LIKE 'Pago de sesión 2%'")>=1),'aviso a coordinación');
 assert.ok(await until(async()=>count("SELECT count(*) n FROM ledger_entries WHERE kind='sale'")===3),'tres ventas en el libro: dos inscripciones y una sesión');
 const payList=await call('/api/payments/orders?brand=globalvet',admin.cookie);assert.equal(payList.orders.find(o=>o.id===ch.order.id).sessionNumber,2);assert.equal(payList.stats.paid,3);

 // recordatorio automático con cobro: al mover la sesión 3 dentro de la ventana sale el recordatorio y el enlace de pago
 const s3b=(await call('/api/coordination/sessions/'+s3.id,admin.cookie,{startsAt:Date.now()+3600000,expectedRevision:s3.revision},'PATCH')).session;assert.ok(s3b.reminder_sent_at);
 assert.ok(await until(async()=>(await texts(conv1,c1.cookie)).some(x=>/Pago de la sesión 3/.test(x))),'enlace de pago automático de la sesión 3');
 await sleep(1500);assert.equal(count("SELECT count(*) n FROM orders WHERE kind='session' AND session_id=?",s3.id),1,'un solo pedido automático');
 assert.ok(!(await texts(conv2,c2.cookie)).some(x=>/Pago de la sesión/.test(x)),'el plan completo no recibe cobros por sesión');
 const auto=(await call('/api/payments/orders?brand=globalvet',admin.cookie)).orders.find(o=>o.session_id===s3.id);assert.equal(auto.status,'pending');assert.equal(auto.source,'bot');

 // condonación: sólo administración o responsable; cancela el pedido vigente; evento; no se repite
 await call('/api/coordination/sessions/'+s3.id+'/waive',agent.cookie,{enrollmentId:r1.id,note:'Beca de la marca'},'POST',403);
 await call('/api/coordination/sessions/'+s3.id+'/waive',admin.cookie,{enrollmentId:r1.id,note:'x'},'POST',400);
 const wv=await call('/api/coordination/sessions/'+s3.id+'/waive',admin.cookie,{enrollmentId:r1.id,note:'Beca de la marca'});assert.equal(wv.payment.status,'waived');assert.equal(wv.payment.note,'Beca de la marca');
 await call('/api/coordination/sessions/'+s3.id+'/waive',admin.cookie,{enrollmentId:r1.id,note:'Otra vez'},'POST',409);
 assert.equal((await call('/api/payments/orders/'+auto.id,admin.cookie)).order.status,'cancelled');assert.match((await texts(conv1,c1.cookie)).at(-1),/se canceló: Sesión condonada/);
 assert.equal((await eventsOf('pago.condonado')).length,1);assert.equal((await call('/api/coordination?brand=globalvet',admin.cookie)).stats.sessionDue,0);
 await call('/api/payments/orders/'+auto.id+'/pay',c1.cookie,{method:'card'},'POST',409);

 // cancelar una sesión cancela su cobro pendiente y su pedido
 const s4=(await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{title:'Extra',startsAt:Date.now()+20*86400000},'POST',201)).session;
 const ch4=await call('/api/coordination/sessions/'+s4.id+'/charge',admin.cookie,{enrollmentId:r1.id});assert.equal(ch4.created,true);
 await call('/api/coordination/sessions/'+s4.id+'/cancel',admin.cookie,{reason:'Se junta con la sesión 3'});
 d=await call('/api/coordination/editions/edition-aves',admin.cookie);assert.equal(d.sessionPayments.find(p=>p.session_id===s4.id).status,'waived');assert.equal((await call('/api/payments/orders/'+ch4.order.id,admin.cookie)).order.status,'cancelled');
 await call('/api/coordination/sessions/'+s4.id+'/charge',admin.cookie,{enrollmentId:r1.id},'POST',409);

 // encuestas: antes de realizar la sesión no se envía; al marcarla realizada sale sola (modo por sesión)
 await call('/api/coordination/editions/edition-aves/surveys',admin.cookie,{kind:'session',sessionId:s1.id},'POST',409);
 await call('/api/coordination/editions/edition-aves/surveys',admin.cookie,{kind:'otra'},'POST',400);
 await call('/api/coordination/editions/edition-aves/surveys',c1.cookie,{kind:'session',sessionId:s1.id},'POST',403);
 await call('/api/coordination/sessions/'+s1.id+'/attendance',admin.cookie,{marks:[{enrollmentId:r1.id,status:'present'},{enrollmentId:r2.id,status:'present'}]},'PUT');
 await call('/api/coordination/sessions/'+s1.id+'/done',admin.cookie,{});
 const sv=await until(async()=>{const x=await call('/api/coordination/editions/edition-aves',admin.cookie);return x.surveys.length?x.surveys[0]:null;});
 assert.ok(sv,'encuesta automática de la sesión');assert.equal(sv.kind,'session');assert.equal(sv.sessionNumber,1);assert.equal(sv.invited,2);assert.equal(sv.answered,0);assert.equal(sv.source,'surveys.auto');
 const tok=m=>String(m).match(/\/encuesta\/([a-f0-9]{32})/)?.[1];
 const t1=tok((await texts(conv1,c1.cookie)).find(x=>/encuesta/.test(x))),t2=tok((await texts(conv2,c2.cookie)).find(x=>/encuesta/.test(x)));assert.ok(t1&&t2&&t1!==t2);
 assert.equal((await eventsOf('encuesta.enviada')).length,1);assert.equal((await eventsOf('encuesta.enviada'))[0].payload.invited,2);

 // respuesta pública por token: página sin sesión, API JSON, validación, una sola vez
 const page=await fetch(origin+'/encuesta/'+t1);assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);const html=await page.text();assert.match(html,/Contenido del curso/);assert.match(html,/Bienvenida/);assert.doesNotMatch(html,/<script/);
 assert.equal((await fetch(origin+'/encuesta/'+'f'.repeat(32))).status,404);assert.equal((await fetch(origin+'/api/survey/'+'f'.repeat(32))).status,404);
 const pub=(await call('/api/survey/'+t1)).survey;assert.equal(pub.open,true);assert.equal(pub.answered,false);assert.equal(pub.questions.length,3);assert.ok(pub.course.length>2&&pub.brand.length>2);
 await call('/api/survey/'+t1,'',{content:6,instructor:4,organization:5,nps:9},'POST',400);
 await call('/api/survey/'+t1,'',{content:5,instructor:4,organization:5,nps:11},'POST',400);
 await call('/api/survey/'+t1,'',{content:5,instructor:4,organization:5,nps:9,comment:'Excelente clase, muy clara'});
 await call('/api/survey/'+t1,'',{content:5,instructor:4,organization:5,nps:9},'POST',409);
 assert.equal((await call('/api/survey/'+t1)).survey.answered,true);
 const form=await fetch(origin+'/encuesta/'+t2,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({content:'4',instructor:'3',organization:'4',nps:'3',comment:''})});
 assert.equal(form.status,200);assert.match(await form.text(),/¡Gracias!/);assert.match(await (await fetch(origin+'/encuesta/'+t2)).text(),/Respuesta registrada/);
 const again=await fetch(origin+'/encuesta/'+t2,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({content:'1',instructor:'1',organization:'1',nps:'0'})});assert.match(await again.text(),/Respuesta registrada/);assert.equal(count('SELECT count(*) n FROM survey_answers'),2,'la segunda respuesta no se guarda');
 d=await call('/api/coordination/editions/edition-aves',admin.cookie);const res=d.surveys[0];
 assert.equal(res.answered,2);assert.equal(res.averages.content,4.5);assert.equal(res.averages.instructor,3.5);assert.equal(res.averages.organization,4.5);assert.equal(res.averages.overall,4.2);assert.deepEqual(res.nps,{promoters:1,passives:0,detractors:1,score:0});
 assert.equal(res.comments.length,1);assert.equal(res.comments[0].name,'Alumno Uno');assert.match(res.comments[0].comment,/Excelente/);
 const answered=await eventsOf('encuesta.respondida');assert.equal(answered.length,2);assert.deepEqual(answered.map(e=>e.payload.comment).sort(),[false,true]);assert.equal(typeof answered[0].payload.contentScore,'number');assert.ok(!JSON.stringify(answered).includes('Excelente'),'el comentario no viaja por la bitácora común');
 assert.equal((await call('/api/coordination?brand=globalvet',admin.cookie)).stats.surveyAnswers,2);

 // CSV y cierre (equipo con acceso a la marca); encuesta manual de cierre con el curso en curso; reenviar no duplica
 const csv=await fetch(origin+'/api/surveys/'+res.id+'.csv',{headers:{Cookie:agent.cookie,Origin:origin}});assert.equal(csv.status,200);const body=await csv.text();assert.equal(body.trim().split('\n').length,3);assert.match(body,/Alumno Uno/);assert.match(body,/Excelente clase/);
 assert.equal((await fetch(origin+'/api/surveys/'+res.id+'.csv',{headers:{Cookie:c1.cookie,Origin:origin}})).status,403);
 await call('/api/coordination/editions/edition-aves/surveys',agent.cookie,{kind:'edition'},'POST',409);   // abierta pero no en curso: todavía no
 const cur=(await call('/api/coordination/editions/edition-aves',admin.cookie)).edition;
 await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'running',expectedRevision:cur.run_revision},'POST');
 const es=await call('/api/coordination/editions/edition-aves/surveys',agent.cookie,{kind:'edition'});assert.equal(es.sent,2);assert.equal(es.survey.kind,'edition');
 assert.equal((await call('/api/coordination/editions/edition-aves/surveys',agent.cookie,{kind:'edition'})).sent,0,'reenviar no duplica invitaciones');
 assert.equal(count("SELECT count(*) n FROM messages WHERE client_ref LIKE 'survey:%'"),4);
 const t3=tok((await texts(conv1,c1.cookie)).at(-1));assert.ok(t3);
 assert.equal((await call('/api/surveys/'+es.survey.id+'/close',agent.cookie,{})).survey.status,'closed');
 await call('/api/surveys/'+es.survey.id+'/close',agent.cookie,{},'POST',409);
 await call('/api/survey/'+t3,'',{content:5,instructor:5,organization:5,nps:10},'POST',409);
 assert.match(await (await fetch(origin+'/encuesta/'+t3)).text(),/Encuesta cerrada/);
 await call('/api/surveys/'+randomUUID()+'/close',admin.cookie,{},'POST',404);

 // baja de la inscripción por sesión: sus cobros pendientes quedan condonados
 const s5=(await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{title:'Cierre',startsAt:Date.now()+30*86400000},'POST',201)).session;
 d=await call('/api/coordination/editions/edition-aves',admin.cookie);assert.equal(d.sessionPayments.find(p=>p.session_id===s5.id&&p.enrollment_id===r1.id).status,'pending');
 await call('/api/coordination/enrollments/'+r1.id+'/cancel',admin.cookie,{reason:'Cambió de ciudad'});
 d=await call('/api/coordination/editions/edition-aves',admin.cookie);assert.equal(d.sessionPayments.find(p=>p.session_id===s5.id&&p.enrollment_id===r1.id).status,'waived');assert.equal(d.sessionPayments.filter(p=>p.status==='paid').length,2);

 const pres=await call('/api/presentation?brand=globalvet',admin.cookie);assert.equal(pres.script.length,12);
 const all=await until(async()=>{const r=await call('/api/events?brand=all',admin.cookie);return r.stats.pending===0?r:null;});assert.ok(all);assert.equal(all.stats.failed,0);
 const x=db();try{assert.equal(x.prepare('PRAGMA user_version').get().user_version,25);assert.equal(x.prepare('SELECT count(*) n FROM session_payments').get().n,5);assert.equal(x.prepare('SELECT count(*) n FROM survey_answers').get().n,2);assert.equal(x.prepare("SELECT count(*) n FROM orders WHERE kind='session'").get().n,3);}finally{x.close();}
});
