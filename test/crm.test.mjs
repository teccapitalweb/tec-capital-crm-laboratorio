import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { openDatabase } from '../server/database.mjs';

test('CRM: invitaciones, alcance por marca, oportunidades y recuperación',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-team-')),adminCode=randomUUID(),password='Prueba-segura-2026!';
 let server,origin,logs='';const sockets=[];
 const start=async()=>{server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:dir,ADMIN_INVITE_CODE:adminCode,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stdout.on('data',b=>{logs+=b;const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.stderr.on('data',b=>logs+=b);server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});};
 const stop=async()=>{if(server?.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});};
 t.after(async()=>{sockets.forEach(s=>s.terminate());await stop();await rm(dir,{recursive:true,force:true});});
 await start();
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',status=200){const r=await fetch(origin+path,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return {...data,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const reg=(username,inviteCode)=>call('/api/auth/register','',{username,name:'Prueba '+username,password,inviteCode});
 const admin=await reg('admin',adminCode),agent=await reg('asesor'),customer=await reg('cliente'),stranger=await reg('otro');
 let invitation,globalConversation,otherConversation,crm,opportunity;
 await t.test('una invitación de un uso incorpora la cuenta existente sin perder su perfil',async()=>{
   const oldId=agent.user.id;invitation=await call('/api/team/invites',admin.cookie,{username:'asesor',brandIds:['globalvet']},'POST',201);
   await call('/api/team/accept',stranger.cookie,{token:invitation.token},'POST',400);
   await call('/api/team/accept',agent.cookie,{token:invitation.token});
   await call('/api/team/accept',agent.cookie,{token:invitation.token},'POST',400);
   const boot=await call('/api/bootstrap',agent.cookie);assert.equal(boot.user.id,oldId);assert.equal(boot.user.role,'agent');assert.deepEqual(boot.brands.map(b=>b.id),['globalvet']);
   await reg('secondadmin',adminCode).then(()=>assert.fail('No debe reutilizarse el secreto inicial'),e=>assert.match(e.message,/400/));
   await call('/api/team',agent.cookie,undefined,'GET',403);
   const exposed=await call('/api/team',admin.cookie);assert.ok(exposed.invites.every(i=>!i.token_hash&&!i.token));
 });
 await t.test('marca denegada por HTTP, archivos, catálogo, métricas y eventos en vivo',async()=>{
   const ws=new WebSocket(origin.replace('http','ws')+'/realtime',{headers:{Cookie:agent.cookie,Origin:origin}});sockets.push(ws);const events=[];ws.on('message',b=>events.push(JSON.parse(b)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
   globalConversation=(await call('/api/conversations',customer.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
   otherConversation=(await call('/api/conversations',customer.cookie,{courseId:'piel',channel:'instagram'})).conversation;
   const sent=await call('/api/conversations/'+otherConversation.id+'/messages',customer.cookie,{text:'Archivo privado',clientRef:randomUUID(),attachment:{name:'nota.pdf',type:'application/pdf',base64:Buffer.from('%PDF-1.4 prueba').toString('base64')}},'POST',201);
   const history=await call('/api/conversations/'+otherConversation.id+'/messages',customer.cookie),file=history.messages.find(m=>m.id===sent.id).attachmentUrl;
   await call('/api/conversations/'+otherConversation.id+'/messages',agent.cookie,undefined,'GET',404);
   await call(file,agent.cookie,undefined,'GET',404);
   await call('/api/courses/piel/flyer',agent.cookie,undefined,'GET',404);
   const inbox=await call('/api/conversations',agent.cookie);assert.equal(inbox.conversations.length,1);assert.equal(inbox.conversations[0].id,globalConversation.id);
   const metrics=await call('/api/metrics',agent.cookie);assert.equal(metrics.conversations,1);
   await new Promise(r=>setTimeout(r,1100));assert.ok(!events.some(e=>e.conversationId===otherConversation.id));assert.ok(!events.some(e=>e.type==='crm'&&e.brandId==='dermalysse'));
   crm=await call('/api/crm',agent.cookie);assert.equal(crm.contacts.length,1);opportunity=crm.opportunities[0];assert.equal(opportunity.course_id,'aves');
   const all=await call('/api/crm',admin.cookie),hidden=all.contacts.find(c=>c.brand_id==='dermalysse');await call('/api/crm/contacts/'+hidden.id,agent.cookie,undefined,'GET',404);
 });
 await t.test('una persona puede tener dos intereses con responsable y próxima tarea',async()=>{
   const id=opportunity.contact_id;
   await call('/api/crm/opportunities',agent.cookie,{contactId:id,courseId:'nutricion',ownerId:agent.user.id,nextAction:'Revisar horarios',dueAt:Date.now()+3600000},'POST',201);
   await call('/api/crm/opportunities',agent.cookie,{contactId:id,courseId:'piel',nextAction:'No autorizado',dueAt:Date.now()+3600000},'POST',400);
   const result=await call('/api/crm',agent.cookie);assert.equal(result.contacts.length,1);assert.equal(result.opportunities.length,2);assert.ok(result.opportunities.some(o=>o.next_due&&o.owner_id===agent.user.id));
   await call('/api/crm/contacts/'+id+'/notes',agent.cookie,{text:'Nota interna que no debe salir al chat'},'POST',201);
   const detail=await call('/api/crm/contacts/'+id,agent.cookie);assert.equal(detail.notes.length,1);
   await call('/api/crm/contacts/'+id,customer.cookie,undefined,'GET',403);
   const history=await call('/api/conversations/'+globalConversation.id+'/messages',customer.cookie);assert.ok(!history.messages.some(m=>m.text.includes('Nota interna')));
   const manual=await call('/api/crm/contacts',agent.cookie,{name:'Contacto independiente',brandId:'globalvet',phone:'prueba'},'POST',201);assert.ok(manual.id);
 });
 await t.test('cerrar una oportunidad cancela tareas; reabrir la tarea exige abrir oportunidad',async()=>{
   let result=await call('/api/crm',agent.cookie),o=result.opportunities.find(o=>o.course_id==='nutricion'),task=result.tasks.find(t=>t.opportunity_id===o.id);
   await call('/api/crm/tasks/'+task.id,agent.cookie,{status:'done'},'PATCH');
   await call('/api/crm/tasks/'+task.id,agent.cookie,{status:'open'},'PATCH');
   await call('/api/crm/opportunities/'+o.id,agent.cookie,{stage:'perdida',ownerId:agent.user.id},'PATCH',400);
   await call('/api/crm/opportunities/'+o.id,agent.cookie,{stage:'perdida',ownerId:agent.user.id,lostReason:'Horario incompatible'},'PATCH');
   result=await call('/api/crm',agent.cookie);assert.equal(result.tasks.find(t=>t.id===task.id).status,'cancelled');
   await call('/api/crm/tasks/'+task.id,agent.cookie,{status:'open'},'PATCH',400);
 });
 await t.test('retirar una marca revoca sesiones, corta sockets y libera pendientes',async()=>{
   await call('/api/conversations/'+globalConversation.id+'/action',agent.cookie,{action:'take'});
   await call('/api/team/members/'+agent.user.id,admin.cookie,{brandIds:[],disabled:false},'PATCH');
   await call('/api/crm',agent.cookie,undefined,'GET',401);
   const login=await call('/api/auth/login','',{username:'asesor',password});agent.cookie=login.cookie;
   const result=await call('/api/crm',agent.cookie);assert.equal(result.contacts.length,0);assert.equal(result.tasks.length,0);
   await call('/api/conversations/'+globalConversation.id+'/messages',agent.cookie,undefined,'GET',404);
   const all=await call('/api/crm',admin.cookie);assert.equal(all.opportunities.find(o=>o.id===opportunity.id).owner_id,null);
   await new Promise(r=>setTimeout(r,100));assert.equal(sockets[0].readyState,WebSocket.CLOSED);
 });
 await t.test('recuperación individual invalida sesiones y no se puede repetir',async()=>{
   const token=await call('/api/team/recovery',admin.cookie,{username:'cliente'},'POST',201);
   await call('/api/auth/recover','',{username:'otro',token:token.token,password:'Otra-segura-2026!'},'POST',400);
   await call('/api/auth/recover','',{username:'cliente',token:token.token,password:'Otra-segura-2026!'});
   await call('/api/auth/recover','',{username:'cliente',token:token.token,password:'Otra-segura-2026!'},'POST',400);
   await call('/api/bootstrap',customer.cookie,undefined,'GET',401);
   const login=await call('/api/auth/login','',{username:'cliente',password:'Otra-segura-2026!'});assert.equal(login.user.id,customer.user.id);
 });
 await t.test('reiniciar mantiene notas, tareas y oportunidades sin duplicarlas',async()=>{
   const before=await call('/api/crm',admin.cookie);await stop();await start();const after=await call('/api/crm',admin.cookie);
   for(const key of ['contacts','opportunities','tasks'])assert.equal(after[key].length,before[key].length);
   const detail=await call('/api/crm/contacts/'+opportunity.contact_id,admin.cookie);assert.equal(detail.notes.length,1);
 });
});

test('migración del laboratorio conserva usuarios y toma copia previa de SQLite',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-v3-migration-'));const db=openDatabase(dir);
 db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run('old-agent','old-agent','Asesor anterior','invalid-hash','agent',111111,1,1);
 db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run('old-customer','old-customer','Cliente anterior','invalid-hash','customer',111112,1,1);
 db.prepare('INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('old-chat','old-customer','globalvet','aves','whatsapp',1,1);db.close();
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',NODE_ENV:'test',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let error='';server.stderr.on('data',b=>error+=b);
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 await new Promise((r,j)=>{const timer=setTimeout(()=>j(Error(error)),10000);server.stdout.on('data',b=>{if(String(b).includes('http://')){clearTimeout(timer);r();}});server.once('exit',()=>{clearTimeout(timer);j(Error(error));});});
 const check=openDatabase(dir);assert.equal(check.prepare('PRAGMA user_version').get().user_version,8);assert.equal(check.prepare('SELECT COUNT(*) n FROM brand_members').get().n,3);assert.equal(check.prepare('SELECT COUNT(*) n FROM opportunities').get().n,1);assert.equal(check.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);check.close();assert.equal((await readdir(join(dir,'backups'))).length,1);
});
