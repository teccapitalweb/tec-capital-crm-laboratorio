import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {WebSocket} from 'ws';
import {isOpen,serviceDeadline,validateHours} from '../server/service-hours.mjs';

test('horarios: minutos hábiles, fin de semana, límites exactos y cambios de horario',()=>{
 const p={timezone:'America/Mexico_City',hours:[null,[540,1080],[540,1080],[540,1080],[540,1080],[540,1080],null]},t=Date.parse('2026-10-30T23:50:00Z');
 assert.equal(isOpen(t,p),true);assert.equal(isOpen(Date.parse('2026-10-31T00:00:00Z'),p),false);assert.equal(serviceDeadline(t,30,p),Date.parse('2026-11-02T15:20:00Z'));
 assert.equal(serviceDeadline(Date.parse('2026-10-30T23:59:30Z'),1,p),Date.parse('2026-11-02T15:00:30Z'));
 const dst={timezone:'America/New_York',hours:Array(7).fill([60,240])};assert.equal(serviceDeadline(Date.parse('2026-03-08T06:30:00Z'),60,dst),Date.parse('2026-03-08T07:30:00Z'));assert.equal(serviceDeadline(Date.parse('2026-11-01T05:30:00Z'),90,dst),Date.parse('2026-11-01T07:00:00Z'));
 assert.throws(()=>validateHours(Array(7).fill(null),'UTC'));assert.throws(()=>validateHours(Array(7).fill([900,600]),'UTC'));assert.throws(()=>validateHours(Array(7).fill([0,1440]),'Missing/Zone'));
});

test('operación v0.5: reparto, coordinación privada, objetivos y macros atómicas',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-operations-')),code=randomUUID(),password='Password-operations-2026!';let server,origin,logs='';const sockets=[];
 const start=async()=>{server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});};
 const stop=async()=>{for(const ws of sockets)ws.terminate();if(server?.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});};t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});await start();
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const reg=(username,inviteCode)=>call('/api/auth/register','',{username,name:'Prueba '+username,password,inviteCode});
 const admin=await reg('admin',code),a=await reg('asesor.a'),b=await reg('asesor.b'),other=await reg('asesor.otro'),client=await reg('cliente');
 for(const [user,username,brandIds] of [[a,'asesor.a',['globalvet','dermalysse']],[b,'asesor.b',['globalvet']],[other,'asesor.otro',['odonteck']]]){const invite=await call('/api/team/invites',admin.cookie,{username,brandIds},'POST',201);await call('/api/team/accept',user.cookie,{token:invite.token});}
 const connect=async u=>{const ws=new WebSocket(origin.replace('http','ws')+'/realtime',{headers:{Cookie:u.cookie,Origin:origin}});sockets.push(ws);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});return ws;};
 const config=()=>call('/api/operations/brands/globalvet',admin.cookie),queue=()=>call('/api/operations/queue',admin.cookie),detail=id=>call('/api/operations/conversations/'+id,admin.cookie),ref=()=>randomUUID();
 const save=async changes=>{const p=(await config()).settings;return call('/api/operations/brands/globalvet',admin.cookie,{expectedRevision:p.revision,hours:p.hours,timezone:p.timezone,routingEnabled:Boolean(p.routing_enabled),slaEnabled:Boolean(p.sla_enabled),memberIds:p.member_ids,firstMinutes:p.first_minutes,nextMinutes:p.next_minutes,...changes},'PATCH');};
 const setLimit=async(u,n)=>{const member=(await config()).members.find(m=>m.id===u.user.id);return call('/api/operations/members/'+u.user.id+'/limit',admin.cookie,{expectedRevision:member.revision,maxOpen:n},'PATCH');};
 const newChat=async(channel='whatsapp',courseId='aves')=>(await call('/api/conversations',client.cookie,{courseId,channel})).conversation;
 const take=async(c,u=admin)=>call('/api/operations/conversations/'+c.id+'/take',u.cookie,{expectedRevision:(await detail(c.id)).state.revision,clientRef:ref()});
 const release=async c=>call('/api/operations/conversations/'+c.id+'/release',admin.cookie,{expectedRevision:(await detail(c.id)).state.revision,reason:'Reparto de prueba',clientRef:ref()});
 let c1,c2,c3,transferId,macroId;
 await t.test('configuración desactivada inicialmente, revisiones y permisos por marca',async()=>{
  const p=(await config()).settings;assert.equal(p.routing_enabled,0);assert.equal(p.sla_enabled,0);
  await call('/api/operations/queue',client.cookie,undefined,'GET',403);await call('/api/operations/brands/globalvet',other.cookie,undefined,'GET',404);
  await call('/api/operations/brands/missing',admin.cookie,undefined,'GET',404);
  await call('/api/operations/brands/globalvet',a.cookie,{expectedRevision:0},'PATCH',403);
  await call('/api/operations/brands/globalvet',admin.cookie,{expectedRevision:0,hours:Array(7).fill(null),timezone:'UTC'},'PATCH',400);
  await save({hours:Array(7).fill([0,1440]),timezone:'UTC',memberIds:[a.user.id,b.user.id],slaEnabled:true,firstMinutes:1,nextMinutes:2});
  const versions=await call('/api/operations/brands/globalvet/history',admin.cookie);assert.equal(versions.events[0].details.next.first_minutes,1);assert.equal(versions.events[0].actor_id,admin.user.id);
  await call('/api/operations/brands/globalvet',admin.cookie,{expectedRevision:0},'PATCH',409);await save({memberIds:[other.user.id]}).then(()=>assert.fail('Debe rechazar miembro de otra marca'),e=>assert.match(e.message,/400/));
 });
 await t.test('reparto sólo conectado y disponible; límite global, menor carga y cola sin elegibles',async()=>{
  await setLimit(a,1);await setLimit(b,1);await connect(a);await connect(b);
  await call('/api/profile',b.cookie,{name:b.user.name,signature:'',availability:'away'});
  c1=await newChat();c2=await newChat('instagram');c3=await newChat('facebook');
  for(const c of [c1,c2,c3]){await take(c);await release(c);}
  await save({routingEnabled:true});await queue();
  // Three channels share an opportunity: assigning it must respect the total group size.
  assert.equal((await detail(c1.id)).conversation.assigned_to,null);
  await setLimit(a,3);await queue();for(const c of [c1,c2,c3])assert.equal((await detail(c.id)).conversation.assigned_to,a.user.id);
  const x=await newChat('whatsapp','piel');await call('/api/conversations/'+x.id+'/action',a.cookie,{action:'take'},'POST',409);
  // Configuring a lower limit keeps existing conversations replyable.
  await setLimit(a,1);await call('/api/conversations/'+c1.id+'/messages',a.cookie,{asAgent:true,text:'Respuesta humana permitida',clientRef:ref()},'POST',201);
  await save({routingEnabled:false});
 });
 await t.test('transferencias conservan dueño hasta aceptación y trasladan chats/tareas juntos',async()=>{
  await setLimit(b,5);const request={toId:b.user.id,context:'El cliente necesita revisar el temario y el horario.',expectedRevision:(await detail(c1.id)).state.revision,clientRef:ref()};
  transferId=(await call('/api/operations/conversations/'+c1.id+'/transfer',a.cookie,request)).id;assert.equal((await detail(c1.id)).conversation.assigned_to,a.user.id);
  assert.equal((await call('/api/operations/conversations/'+c1.id+'/transfer',a.cookie,request)).id,transferId);
  await call('/api/operations/transfers/'+transferId+'/accept',a.cookie,{clientRef:ref()},'POST',403);
  const accept={clientRef:ref()};await call('/api/operations/transfers/'+transferId+'/accept',b.cookie,accept);assert.equal((await call('/api/operations/transfers/'+transferId+'/accept',b.cookie,accept)).duplicate,true);
  for(const c of [c1,c2,c3])assert.equal((await detail(c.id)).conversation.assigned_to,b.user.id);
  const d=await detail(c1.id);assert.equal(d.opportunity.owner_id,b.user.id);const tasks=(await call('/api/crm',admin.cookie)).tasks.filter(t=>t.opportunity_id===d.opportunity.id&&t.status==='open');assert.ok(tasks.every(t=>t.owner_id===b.user.id));
 });
 await t.test('notas con menciones privadas e idempotentes; aviso leído sólo por destinatario',async()=>{
  const input={text:'Nota privada para revisar la oferta sin enviarla al cliente',mentions:[a.user.id],clientRef:ref()};const n=await call('/api/operations/conversations/'+c1.id+'/notes',b.cookie,input);await call('/api/operations/conversations/'+c1.id+'/notes',b.cookie,input);
  const d=await detail(c1.id);assert.equal(d.notes.filter(x=>x.id===n.id).length,1);const list=await call('/api/operations/notifications',a.cookie),mention=list.items.find(n=>n.kind==='mention');assert.ok(mention);
  await call('/api/operations/notifications/read',b.cookie,{id:mention.id});assert.equal((await call('/api/operations/notifications',a.cookie)).items.find(n=>n.id===mention.id).read_at,null);
  await call('/api/operations/notifications/read',a.cookie,{id:mention.id});assert.ok((await call('/api/operations/notifications',a.cookie)).items.find(n=>n.id===mention.id).read_at);
  await call('/api/operations/conversations/'+c1.id,client.cookie,undefined,'GET',403);await call('/api/operations/conversations/'+c1.id,other.cookie,undefined,'GET',404);
  assert.ok(!(await call('/api/conversations/'+c1.id+'/messages',client.cookie)).messages.some(m=>m.text.includes('Nota privada')));
 });
 await t.test('SLA: lectura y respuestas automáticas no lo satisfacen; alertas deduplicadas',async()=>{
  await call('/api/conversations/'+c1.id+'/messages',client.cookie,{text:'Tengo una duda nueva',clientRef:ref()},'POST',201);let d=await detail(c1.id);assert.ok(d.state.waiting_since);assert.ok(d.state.first_human_at);assert.ok(d.state.due_at>d.state.waiting_since);
  await call('/api/conversations/'+c1.id+'/read',b.cookie,{asAgent:true,upTo:100000});assert.equal((await detail(c1.id)).state.waiting_since,d.state.waiting_since);
  const db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});db.prepare('UPDATE service_state SET due_at=? WHERE conversation_id=?').run(Date.now()-5000,c1.id);db.close();
  await queue();await queue();const alerts=(await call('/api/operations/notifications',b.cookie)).items.filter(n=>n.kind==='sla'&&n.conversation_id===c1.id);assert.equal(alerts.length,1);
  await call('/api/conversations/'+c1.id+'/messages',b.cookie,{asAgent:true,text:'Esta es la respuesta humana',clientRef:ref()},'POST',201);assert.equal((await detail(c1.id)).state.waiting_since,null);
  const events=await call('/api/operations/conversations/'+c1.id+'/history',b.cookie);assert.ok(events.events.some(e=>e.kind==='response'&&e.details.withinTarget===false));
 });
 await t.test('macros: versión, vista previa, mensaje/tarea/nota atómicos e idempotentes',async()=>{
  const template=(await call('/api/catalogue',admin.cookie)).templates.find(t=>t.brand_id==='globalvet'&&t.scenario==='price');
  const a={templateId:template.id,stage:'interesado',taskTitle:'Seguimiento creado por macro',delayMinutes:60,note:'Nota de macro interna'};
  macroId=(await call('/api/operations/macros',admin.cookie,{brandId:'globalvet',title:'Precio y seguimiento',enabled:true,actions:a},'POST',201)).id;
  await call('/api/operations/macros',b.cookie,{brandId:'globalvet'},'POST',403);await call('/api/operations/macros/'+macroId+'/history',other.cookie,undefined,'GET',404);
  const p=await call('/api/operations/conversations/'+c1.id+'/macro-preview',b.cookie,{macroId});assert.ok(p.prepared.text.includes('379.00'));
  const run={macroId,previewToken:p.previewToken,clientRef:ref()},r=await call('/api/operations/conversations/'+c1.id+'/macro-run',b.cookie,run);assert.ok(r.messageId&&r.taskId&&r.noteId);
  const again=await call('/api/operations/conversations/'+c1.id+'/macro-run',b.cookie,run);assert.equal(again.taskId,r.taskId);assert.equal(again.duplicate,true);
  assert.equal((await call('/api/conversations/'+c1.id+'/messages',client.cookie)).messages.filter(m=>m.id===r.messageId).length,1);
  const preview=await call('/api/operations/conversations/'+c1.id+'/macro-preview',b.cookie,{macroId});await call('/api/operations/macros/'+macroId,admin.cookie,{expectedRevision:1,title:'Precio y seguimiento v2',enabled:true,actions:a},'PATCH');
  await call('/api/operations/conversations/'+c1.id+'/macro-run',b.cookie,{macroId,previewToken:preview.previewToken,clientRef:ref()},'POST',409);assert.equal((await call('/api/operations/macros/'+macroId+'/history',admin.cookie)).versions.length,2);
  await call('/api/conversations/'+c1.id+'/action',b.cookie,{action:'stage',stage:'inscripcion'});await call('/api/operations/conversations/'+c1.id+'/macro-preview',b.cookie,{macroId},'POST',409);
 });
 await t.test('fuera de horario no reparte; menor carga y capacidad dejan el excedente en cola',async()=>{
  await call('/api/profile',b.cookie,{name:b.user.name,signature:'',availability:'available'});await setLimit(a,1);await setLimit(b,5);
  const chats=[];for(let i=0;i<4;i++){const p=await reg('balance'+i);const c=(await call('/api/conversations',p.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;await take(c);await release(c);chats.push(c);}
  const hours=Array(7).fill(null);hours[(new Date().getUTCDay()+1)%7]=[540,600];await save({routingEnabled:true,hours});await queue();for(const c of chats)assert.equal((await detail(c.id)).conversation.assigned_to,null);
  await save({hours:Array(7).fill([0,1440])});await queue();const owners=await Promise.all(chats.map(async c=>(await detail(c.id)).conversation.assigned_to));assert.equal(owners.filter(id=>id===a.user.id).length,1);assert.equal(owners.filter(id=>id===b.user.id).length,2);assert.equal(owners.filter(id=>!id).length,1);
  await save({routingEnabled:false});const unassigned=chats[owners.findIndex(id=>!id)];const revision=(await detail(unassigned.id)).state.revision;
  const attempts=await Promise.all([0,1].map(async()=>fetch(origin+'/api/operations/conversations/'+unassigned.id+'/take',{method:'POST',headers:{Cookie:admin.cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:revision,clientRef:ref()})})));assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
 });
 await t.test('avisos con la misma fecha se paginan sin omitir registros',async()=>{
  const db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),time=Date.now(),ids=[];for(let i=0;i<60;i++){const id=randomUUID();ids.push(id);db.prepare('INSERT INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,a.user.id,'globalvet',c1.id,'mention','Aviso de paginación','pagination:'+i,time);}db.close();
  const read=[];let cursor='';do{const r=await call('/api/operations/notifications'+(cursor?'?before='+encodeURIComponent(cursor):''),a.cookie);read.push(...r.items.map(n=>n.id));cursor=r.nextBefore;}while(cursor);assert.equal(new Set(read).size,read.length);assert.equal(ids.filter(id=>read.includes(id)).length,60);
 });
 await t.test('revocar acceso cancela transferencias y oculta menciones; reinicio conserva historial',async()=>{
  const transfer=(await call('/api/operations/conversations/'+c1.id+'/transfer',b.cookie,{expectedRevision:(await detail(c1.id)).state.revision,toId:a.user.id,context:'Transferencia antes de revocar el acceso',clientRef:ref()})).id;
  await call('/api/team/members/'+a.user.id,admin.cookie,{brandIds:['dermalysse'],disabled:false},'PATCH');await queue();assert.equal((await detail(c1.id)).transfers.find(x=>x.id===transfer).status,'cancelled');
  const login=await call('/api/auth/login','',{username:'asesor.a',password});assert.equal((await call('/api/operations/notifications',login.cookie)).items.filter(n=>n.brand_id==='globalvet').length,0);
  const before=(await call('/api/operations/conversations/'+c1.id+'/history',admin.cookie)).events.length;await stop();await start();assert.equal((await call('/api/operations/conversations/'+c1.id+'/history',admin.cookie)).events.length,before);
  assert.equal((await call('/api/operations/macros/'+macroId+'/history',admin.cookie)).versions.length,2);const db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});assert.equal(db.prepare('PRAGMA user_version').get().user_version,40);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();assert.equal((await readdir(dir)).includes('laboratorio.sqlite'),true);
 });
 await t.test('conversaciones anteriores recuperan la primera respuesta humana sin reescribir mensajes',async()=>{
  const db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),first=db.prepare("SELECT MIN(created_at) t FROM messages WHERE conversation_id=? AND sender_kind='agent'").get(c1.id).t;db.prepare('DELETE FROM service_state WHERE conversation_id=?').run(c1.id);db.close();assert.equal((await detail(c1.id)).state.first_human_at,first);
 });
});
