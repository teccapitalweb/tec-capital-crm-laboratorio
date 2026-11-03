import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('recetas por API: permisos, simulación sin efectos y ejecución real con plantilla, tarea y aviso',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-recipes-http-')),code=randomUUID(),password='Password-recipes-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),client=await call('/api/auth/register','',{username:'cliente',name:'Cliente',password});

 for(const [file,type] of [['/recipes.js','text/javascript'],['/coordination.js','text/javascript'],['/finance.js','text/javascript'],['/persons.js','text/javascript'],['/certificates.js','text/javascript'],['/content.js','text/javascript'],['/legacy.js','text/javascript'],['/recipes.css','text/css'],['/operations.js','text/javascript'],['/catalogue-import.js','text/javascript'],['/contacts.js','text/javascript'],['/analytics.js','text/javascript'],['/security.js','text/javascript'],['/polish.css','text/css'],['/knowledge.js','text/javascript'],['/simulator.js','text/javascript'],['/payments.js','text/javascript'],['/presentation.js','text/javascript'],['/connectors.js','text/javascript'],['/evaluation.js','text/javascript'],['/analytics.css','text/css']]){const r=await fetch(origin+file);assert.equal(r.status,200,file);assert.match(r.headers.get('content-type'),new RegExp(type));}
 const db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});

 const conversation=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 await call('/api/conversations/'+conversation.id+'/messages',client.cookie,{text:'Hola',clientRef:randomUUID()},'POST',201);
 for(let i=0;i<20;i++){const m=await call('/api/conversations/'+conversation.id+'/messages',client.cookie);if(m.messages.some(x=>x.sender_kind==='automation'))break;await sleep(250);}
 const before=(await call('/api/conversations/'+conversation.id+'/messages',client.cookie)).messages.filter(m=>m.sender_kind==='automation').length;assert.equal(before,1);

 const catalogue=await call('/api/catalogue',admin.cookie),template=catalogue.templates.find(x=>x.brand_id===conversation.brand_id&&x.status==='approved'&&(!x.course_id||x.course_id==='aves')&&(!x.edition_id));
 assert.ok(template,'plantilla aprobada disponible');
 const definition={trigger:{type:'silence',minutes:5},conditions:{courseId:'aves',stages:['nuevo','interesado']},actions:[{type:'template',templateId:template.id},{type:'task',title:'Llamar al interesado',delayMinutes:30},{type:'notify',title:'Receta: sin respuesta'}]};

 await call('/api/automation/recipes',client.cookie,undefined,'GET',403);await call('/api/automation/recipes','',undefined,'GET',401);
 await call('/api/automation/recipes',admin.cookie,{brandId:conversation.brand_id,title:'x',definition:{...definition,trigger:{type:'silence',minutes:1}}},'POST',400);
 const created=(await call('/api/automation/recipes',admin.cookie,{brandId:conversation.brand_id,title:'Seguimiento por silencio',definition},'POST',201)).recipe;
 assert.equal(created.status,'draft');

 const counters=()=>{const d=db();try{return ['messages','tasks','notifications','automation_steps','automation_runs'].map(n=>d.prepare('SELECT count(*) n FROM '+n).get().n).join('-');}finally{d.close();}};
 const snapshot=counters();
 const sim=(await call('/api/automation/recipes/'+created.id+'/simulate',admin.cookie,{conversationId:conversation.id})).simulation;
 assert.equal(sim.matches,true);assert.deepEqual(sim.actions.map(a=>a.type),['template','task','notify']);assert.ok(sim.actions[0].text);
 await call('/api/automation/recipes/'+created.id+'/simulate',admin.cookie,{conversationId:randomUUID()},'POST',404);
 assert.equal(counters(),snapshot);

 await call('/api/automation/recipes/'+created.id+'/publish',admin.cookie,{expectedRevision:99},'POST',409);
 const published=(await call('/api/automation/recipes/'+created.id+'/publish',admin.cookie,{expectedRevision:created.revision})).recipe;assert.equal(published.status,'published');
 // sin habilitar la marca no se programa nada
 await sleep(5600);assert.equal(counters(),snapshot);
 const brand=await call('/api/automation',admin.cookie);
 await call('/api/automation/brands/'+conversation.brand_id,admin.cookie,{enabled:true,expectedRevision:brand.brands.find(b=>b.id===conversation.brand_id).revision},'PATCH');

 // el reloj real no se puede acelerar: se retrocede el mensaje y la fecha de activación en la base de pruebas
 const d=db();d.prepare('UPDATE automation_recipes SET activated_at=0 WHERE id=?').run(created.id);d.prepare("UPDATE messages SET created_at=created_at-600000 WHERE conversation_id=? AND sender_kind='automation'").run(conversation.id);d.close();
 let run;for(let i=0;i<30&&!(run=(await call('/api/automation/recipes/'+created.id+'/runs',admin.cookie)).runs.find(x=>x.state==='completed'));i++)await sleep(500);
 assert.ok(run,'la receta se ejecutó');assert.equal(run.recipe_revision,published.revision);
 const messages=(await call('/api/conversations/'+conversation.id+'/messages',client.cookie)).messages.filter(m=>m.sender_kind==='automation');
 assert.equal(messages.length,2);
 const check=db();try{
  assert.equal(check.prepare("SELECT count(*) n FROM tasks WHERE title='Llamar al interesado'").get().n,1);
  assert.equal(check.prepare("SELECT count(*) n FROM notifications WHERE kind='recipe'").get().n,1);
  assert.deepEqual(check.prepare("SELECT kind FROM automation_events WHERE step_id=? ORDER BY seq").all(run.step_id).map(e=>e.kind),['created','reserved','completed']);
 }finally{check.close();}
 // no se repite aunque pasen más barridos
 await sleep(6500);assert.equal((await call('/api/conversations/'+conversation.id+'/messages',client.cookie)).messages.filter(m=>m.sender_kind==='automation').length,2);
 assert.equal((await call('/api/automation/recipes/'+created.id+'/runs',admin.cookie)).runs.length,1);
 const paused=(await call('/api/automation/recipes/'+created.id+'/pause',admin.cookie,{expectedRevision:published.revision})).recipe;assert.equal(paused.status,'paused');
 assert.equal((await call('/api/automation/recipes/'+created.id+'/history',admin.cookie)).versions.length,3);
});
