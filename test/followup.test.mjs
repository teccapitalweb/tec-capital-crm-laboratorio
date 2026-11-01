import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,transaction} from '../server/database.mjs';
import {migrateCRM} from '../server/crm.mjs';

test('seguimiento v0.3: etapas, tareas, histórico y búsqueda con permisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-followup-')),code=randomUUID(),password='Prueba-segura-2026!';
 let server,origin,logs='';
 const start=async()=>{server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.stderr.on('data',b=>logs+=b);server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});};
 const stop=async()=>{if(server?.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});};
 t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
 await start();
 async function request(path,cookie='',body,method=body===undefined?'GET':'POST'){
   const res=await fetch(origin+path,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:res.status,...await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
 }
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await request(path,cookie,body,method);assert.equal(r.status,expected,JSON.stringify(r));return r;}
 const register=(username,inviteCode)=>call('/api/auth/register','',{username,name:'Prueba '+username,password,inviteCode});
 const admin=await register('admin',code),customer=await register('cliente'),agent=await register('asesor'),outsider=await register('externo');
 const invitation=await call('/api/team/invites',admin.cookie,{username:'asesor',brandIds:['globalvet']},'POST',201);
 await call('/api/team/accept',agent.cookie,{token:invitation.token});
 const chat=(await call('/api/conversations',customer.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const otherChat=(await call('/api/conversations',customer.cookie,{courseId:'piel',channel:'instagram'})).conversation;
 const snapshot=()=>call('/api/crm',admin.cookie);
 let opp=(await snapshot()).opportunities.find(o=>o.conversation_id===chat.id);
 const getOpp=async()=>((await snapshot()).opportunities.find(o=>o.id===opp.id));
 const patch=async changes=>call('/api/crm/opportunities/'+opp.id,admin.cookie,{stage:'inscripcion',ownerId:admin.user.id,...changes},'PATCH');

 await t.test('R1: todas las vistas leen la misma etapa y cerrar chat es independiente',async()=>{
   await patch({expectedRevision:opp.revision});
   for(const user of [admin,customer]){const boot=await call('/api/bootstrap',user.cookie);assert.equal(boot.conversations.find(c=>c.id===chat.id).stage,'inscripcion');}
   const list=await call('/api/conversations',agent.cookie);assert.equal(list.conversations.find(c=>c.id===chat.id).stage,'inscripcion');
   await call('/api/conversations/'+chat.id+'/action',admin.cookie,{action:'resolve'});
   const detail=await call('/api/conversations/'+chat.id,admin.cookie);assert.equal(detail.conversation.stage,'inscripcion');assert.equal(detail.conversation.status,'resolved');
   const next=(await call('/api/conversations',customer.cookie,{courseId:'aves',channel:'facebook'})).conversation;
   assert.equal(next.stage,'inscripcion');assert.equal(next.opportunity_id,opp.id);
 });
 await t.test('R2: preguntar precio no retrocede inscripción y las reglas no reabren cierres',async()=>{
   const c=(await call('/api/conversations',customer.cookie,{courseId:'aves',channel:'facebook'})).conversation;
   await call('/api/conversations/'+c.id+'/action',admin.cookie,{action:'automate'});
   await call('/api/conversations/'+c.id+'/messages',customer.cookie,{text:'¿Cuál es el precio?',clientRef:randomUUID()},'POST',201);
   await new Promise(r=>setTimeout(r,1200));assert.equal((await getOpp()).stage,'inscripcion');
   const replies=await call('/api/conversations/'+c.id+'/messages',customer.cookie);assert.ok(replies.messages.some(m=>m.sender_kind==='automation'&&m.text.includes('precio')));
   await patch({stage:'perdida',lostReason:'Otro horario'});
   await call('/api/conversations/'+c.id+'/messages',customer.cookie,{text:'Quiero inscribirme',clientRef:randomUUID()},'POST',201);
   await new Promise(r=>setTimeout(r,1200));assert.equal((await getOpp()).stage,'perdida');
   assert.equal((await call('/api/conversations/'+chat.id,admin.cookie)).conversation.stage,'perdida');
 });
 await t.test('R3: reapertura conflictiva devuelve 409 con acceso al interés vigente, sin perder históricos',async()=>{
   const active=await call('/api/crm/opportunities',admin.cookie,{contactId:opp.contact_id,courseId:'aves',ownerId:admin.user.id,nextAction:'Nuevo seguimiento',dueAt:Date.now()+86400000},'POST',201);
   const before=await call('/api/crm/opportunities/'+opp.id+'/history',admin.cookie);
   const conflict=await call('/api/crm/opportunities/'+opp.id,admin.cookie,{stage:'interesado',ownerId:admin.user.id},'PATCH',409);
   assert.equal(conflict.code,'ACTIVE_INTEREST');assert.equal(conflict.activeOpportunityId,active.id);assert.equal((await getOpp()).stage,'perdida');
   const throughChat=await call('/api/conversations/'+chat.id+'/action',admin.cookie,{action:'stage',stage:'interesado'},'POST',409);assert.equal(throughChat.activeOpportunityId,active.id);
   assert.deepEqual((await call('/api/crm/opportunities/'+opp.id+'/history',admin.cookie)).events,before.events);
   await call('/api/crm/opportunities/'+active.id,admin.cookie,{stage:'ganada',ownerId:admin.user.id},'PATCH');
   await patch({stage:'interesado'});assert.equal((await getOpp()).stage,'interesado');
 });
 await t.test('ediciones simultáneas detectan la versión antigua',async()=>{
   const o=await getOpp();const responses=await Promise.all(['inscripcion','nuevo'].map(stage=>request('/api/crm/opportunities/'+o.id,admin.cookie,{stage,ownerId:admin.user.id,expectedRevision:o.revision},'PATCH')));
   assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(responses.find(r=>r.status===409).code,'STALE_RECORD');
 });
 let task;
 await t.test('tareas: editar, posponer, reasignar, cancelar, reabrir y completar deja trazabilidad',async()=>{
   const created=await call('/api/crm/tasks',admin.cookie,{opportunityId:opp.id,title:'Llamar mañana',dueAt:Date.now()+86400000},'POST',201);
   task=(await snapshot()).tasks.find(t=>t.id===created.id);const future=Date.now()+7*86400000;
   await call('/api/crm/tasks/'+task.id,admin.cookie,{title:'Enviar temario revisado',dueAt:future,ownerId:agent.user.id,expectedRevision:task.revision,reason:'El cliente pidió otra fecha'},'PATCH');
   let current=(await snapshot()).tasks.find(t=>t.id===task.id);assert.equal(current.due_at,future);assert.equal(current.title,'Enviar temario revisado');assert.equal(current.owner_id,agent.user.id);
   await call('/api/crm/tasks/'+task.id,admin.cookie,{status:'done',expectedRevision:task.revision},'PATCH',409);
   await call('/api/crm/tasks/'+task.id,agent.cookie,{status:'cancelled',expectedRevision:current.revision},'PATCH');
   await call('/api/crm/tasks/'+task.id,agent.cookie,{status:'open'},'PATCH');
   await call('/api/crm/tasks/'+task.id,agent.cookie,{status:'done'},'PATCH');
   const history=await call('/api/crm/opportunities/'+opp.id+'/history',agent.cookie);
   const event=history.events.find(e=>e.details.reason==='El cliente pidió otra fecha');assert.equal(event.actor_id,admin.user.id);assert.equal(event.details.previous.title,'Llamar mañana');assert.equal(event.details.next.dueAt,future);
   assert.ok(history.events.some(e=>e.actor_id===agent.user.id&&e.details.next?.status==='cancelled'));
 });
 await t.test('tareas: validación, propietario, marca y cierre de oportunidad',async()=>{
   await call('/api/crm/tasks/'+task.id,agent.cookie,{title:''},'PATCH',400);
   await call('/api/crm/tasks/'+task.id,agent.cookie,{dueAt:Date.now()-86400000},'PATCH',400);
   await call('/api/crm/tasks/'+task.id,agent.cookie,{ownerId:customer.user.id},'PATCH',400);
   await call('/api/crm/tasks/'+task.id,customer.cookie,{status:'open'},'PATCH',403);
   await call('/api/crm/tasks/'+task.id,agent.cookie,{ownerId:admin.user.id},'PATCH');
   await call('/api/crm/tasks/'+task.id,agent.cookie,{status:'open'},'PATCH',403);
   await call('/api/crm/tasks/'+task.id,admin.cookie,{status:'open'},'PATCH');
   await patch({stage:'ganada'});
   assert.equal((await snapshot()).tasks.find(t=>t.id===task.id).status,'cancelled');
   await call('/api/crm/tasks/'+task.id,admin.cookie,{status:'open'},'PATCH',400);
   const denied=(await snapshot()).opportunities.find(o=>o.conversation_id===otherChat.id);
   await call('/api/crm/opportunities/'+denied.id+'/history',agent.cookie,undefined,'GET',404);
   await call('/api/crm/opportunities/'+opp.id+'/history',customer.cookie,undefined,'GET',403);
 });
 let oldId;
 await t.test('búsqueda encuentra texto antiguo fuera de las últimas 300 conversaciones y pagina sin duplicados',async()=>{
   const db=openDatabase(dir);transaction(db,()=>{
     for(let i=0;i<325;i++){
       const id=randomUUID(),brand=i%2?'odonteck':'globalvet',course=i%2?'odontologia':'aves';if(i===0)oldId=id;
       db.prepare("INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,status,created_at,updated_at) VALUES(?,?,?,?,?,'resolved',?,?)").run(id,customer.user.id,brand,course,'whatsapp',1000+i,1000+i);
       if(i===0){for(let n=0;n<170;n++)db.prepare("INSERT INTO messages(id,conversation_id,sender_id,sender_kind,text,client_ref,created_at) VALUES(?,?,?,'customer',?,?,?)").run(randomUUID(),id,customer.user.id,n<55?'Beca Única historial-raro '+n:'Texto reciente '+n,randomUUID(),1000+n);}
     }
   });db.close();await stop();await start();
   const boot=await call('/api/bootstrap',admin.cookie);assert.equal(boot.conversations.length,300);assert.ok(!boot.conversations.some(c=>c.id===oldId));
   const search=await call('/api/conversations?q=beca%20unica',agent.cookie);assert.equal(search.conversations.length,1);assert.equal(search.conversations[0].id,oldId);assert.match(search.conversations[0].match_text,/historial-raro/);
   const direct=await call('/api/conversations/'+oldId,agent.cookie);assert.equal(direct.conversation.id,oldId);
   const all=[];let cursor='';do{const page=await call('/api/conversations?brand=globalvet&filter=resolved'+(cursor?'&cursor='+encodeURIComponent(cursor):''),agent.cookie);all.push(...page.conversations);cursor=page.nextCursor;}while(cursor);
   assert.ok(all.length>150);assert.equal(new Set(all.map(c=>c.id)).size,all.length);assert.ok(all.every(c=>c.brand_id==='globalvet'&&c.status==='resolved'));
   const no=await call('/api/conversations?q=historial-raro',outsider.cookie);assert.equal(no.conversations.length,0);
   await call('/api/conversations/'+oldId,outsider.cookie,undefined,'GET',404);
   const denied=await call('/api/conversations?brand=odonteck',agent.cookie);assert.equal(denied.conversations.length,0);
 });
 await t.test('buscar dentro del chat recorre mensajes anteriores y respeta el aislamiento',async()=>{
   const page=await call('/api/conversations/'+oldId+'/messages?q=beca%20unica',agent.cookie);assert.equal(page.messages.length,50);assert.ok(page.nextBefore);
   const next=await call('/api/conversations/'+oldId+'/messages?q=beca%20unica&before='+page.nextBefore,agent.cookie);assert.equal(next.messages.length,5);assert.equal(next.nextBefore,null);
   assert.equal(new Set([...page.messages,...next.messages].map(m=>m.seq)).size,55);
   await call('/api/conversations/'+oldId+'/messages?q=beca',outsider.cookie,undefined,'GET',404);
 });
 await t.test('historial paginado y persistencia no duplican ni descartan cambios',async()=>{
   const db=openDatabase(dir);for(let i=0;i<60;i++)db.prepare("INSERT INTO crm_events(opportunity_id,actor_id,kind,details,created_at) VALUES(?,?,'reason',?,?)").run(opp.id,admin.user.id,JSON.stringify({to:'Registro '+i}),Date.now());db.close();
   const first=await call('/api/crm/opportunities/'+opp.id+'/history',agent.cookie);assert.equal(first.events.length,50);assert.ok(first.nextBefore);
   const second=await call('/api/crm/opportunities/'+opp.id+'/history?before='+first.nextBefore,agent.cookie);assert.ok(second.events.length>10);assert.ok(second.events.every(e=>e.seq<first.nextBefore));
   const before=await snapshot();await stop();await start();const after=await snapshot();assert.deepEqual(after.tasks,before.tasks);
   assert.deepEqual((await call('/api/crm/opportunities/'+opp.id+'/history',agent.cookie)).events,first.events);
 });
});

test('migrar v3 conserva ediciones, importa historial y crea un respaldo restaurable anterior',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-v4-migration-'));let db=openDatabase(dir);migrateCRM(db);
 db.prepare('INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)').run('old-user','old','Anterior','unused','customer',800000,1,1);
 db.prepare('INSERT INTO contacts(id,brand_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('old-contact','globalvet','Contacto editado',1,1);
 db.prepare('INSERT INTO opportunities VALUES(?,?,?,?,?,?,?,?,?)').run('old-opp','old-contact','globalvet','aves','perdida',null,'Motivo preservado',1,2);
 db.prepare('INSERT INTO opportunity_events VALUES(?,?,?,?,?,?)').run('old-event','old-opp',null,'nuevo','perdida',2);db.close();
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:dir,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});let logs='';server.stderr.on('data',b=>logs+=b);
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error(logs)),10000);server.stdout.on('data',b=>{if(String(b).includes('http://')){clearTimeout(timeout);resolve();}});server.once('exit',()=>{clearTimeout(timeout);reject(Error(logs));});});
 db=openDatabase(dir);assert.equal(db.prepare('PRAGMA user_version').get().user_version,15);assert.equal(db.prepare('SELECT lost_reason FROM opportunities').get().lost_reason,'Motivo preservado');assert.equal(db.prepare('SELECT count(*) n FROM crm_events').get().n,1);db.close();
 const files=await readdir(join(dir,'backups'));assert.equal(files.length,1);const backup=new DatabaseSync(join(dir,'backups',files[0]),{readOnly:true});assert.equal(backup.prepare('PRAGMA user_version').get().user_version,3);assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(backup.prepare('SELECT lost_reason FROM opportunities').get().lost_reason,'Motivo preservado');backup.close();
});
