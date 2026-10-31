import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../server/database.mjs';
import {migrateCRM} from '../server/crm.mjs';
import {migrateFollowup} from '../server/followup.mjs';
import {migrateCatalogue} from '../server/catalogue-schema.mjs';
import {migrateOperations} from '../server/operations-schema.mjs';
import {migrateAutomation,migrateRecipes} from '../server/automation-schema.mjs';
import {migrateContacts,migrateConsent} from '../server/contacts-schema.mjs';
import {createAutomation,cancelConversationSteps} from '../server/automation.mjs';
import {createRecipes} from '../server/recipes.mjs';

const MIN=60_000;
const quiet={error(){}};

async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'crm-recipes-')),db=openDatabase(dir);
  for(const m of [migrateCRM,migrateFollowup,migrateCatalogue,migrateOperations,migrateAutomation,migrateRecipes,migrateContacts,migrateConsent])m(db);
  t.after(async()=>{try{db.close();}catch{}await rm(dir,{recursive:true,force:true});});
  const c={t:Date.now(),now:()=>c.t},t0=c.t;
  db.prepare("INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u1','cliente','Cliente','x','customer',1,?,?),('adm','admin','Admin','x','admin',2,?,?),('ag','asesor','Asesor','x','agent',3,?,?)").run(t0,t0,t0,t0,t0,t0);
  const course=db.prepare('SELECT id,brand_id FROM courses ORDER BY id LIMIT 1').get(),brand=course.brand_id;
  const mkConversation=(id,{stage='interesado'}={})=>{
    db.prepare("INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES(?,?,?,?,'whatsapp',?,?)").run(id,'u1',brand,course.id,t0,t0);
    db.prepare('INSERT INTO contacts(id,brand_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('ct-'+id,brand,'Cliente '+id,t0,t0);
    db.prepare('INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('op-'+id,'ct-'+id,brand,course.id,stage,t0,t0);
    db.prepare('INSERT INTO conversation_opportunities VALUES(?,?)').run(id,'op-'+id);
  };
  const msg=(conversation,kind,at=c.t)=>{const id=randomUUID();db.prepare('INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at) VALUES(?,?,?,?,?,?)').run(id,conversation,kind,'texto',randomUUID(),at);return id;};
  const stub={unavailable:false,prepare(){if(stub.unavailable)throw Object.assign(Error('Plantilla no disponible'),{status:409});return {text:'Seguimos disponibles para ayudarte.',flyerSnapshot:null};}};
  const insertMessage=(conv,user,text,kind,ref)=>{const id=randomUUID();db.prepare('INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at) VALUES(?,?,?,?,?,?)').run(id,conv.id,kind,text,ref,c.t);return id;};
  const automation=createAutomation({db,now:c.now,log:quiet,baseDelayMs:1000});
  const recipes=createRecipes({db,catalogue:stub,automation,insertMessage,broadcast(){},body(){},json(){},audit(){},now:c.now});
  const template=db.prepare("SELECT id FROM content_templates WHERE brand_id=? AND status='approved' LIMIT 1").get(brand).id;
  const definition=(over={})=>({trigger:{type:'silence',minutes:30},conditions:{},actions:[{type:'template',templateId:template},{type:'task',title:'Llamar al interesado',delayMinutes:60},{type:'notify',title:'Sin respuesta tras el seguimiento'}],...over});
  const counts=()=>Object.fromEntries(['messages','tasks','notifications','automation_steps','automation_runs','crm_events','automation_events'].map(n=>[n,db.prepare('SELECT count(*) n FROM '+n).get().n]));
  const publish=(def=definition(),user={id:'adm'})=>{const r=recipes.create({brandId:brand,title:'Seguimiento',definition:def},user);return recipes.publish(r.id,{expectedRevision:r.revision},user);};
  const conv=id=>db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  return {db,c,conv,brand,course,template,automation,recipes,stub,mkConversation,msg,definition,counts,publish};
}

test('migración v8 aditiva y repetible; las recetas validan alcance y acciones',async t=>{
  const {db,recipes,brand,template,definition}=await setup(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,10);migrateRecipes(db);assert.equal(db.prepare('PRAGMA user_version').get().user_version,10);
  const bad=(over,re)=>assert.throws(()=>recipes.create({brandId:brand,title:'x',definition:definition(over)},{id:'adm'}),re);
  bad({trigger:{type:'silence',minutes:1}},/Minutos/);bad({trigger:{type:'otro',minutes:30}},/Disparador/);bad({actions:[]},/acciones/);
  bad({actions:[{type:'task',title:'a',delayMinutes:5},{type:'task',title:'b',delayMinutes:5}]},/repetida/);bad({actions:[{type:'template',templateId:'inexistente'}]},/Plantilla/);
  bad({conditions:{courseId:'otra-marca'}},/Curso/);bad({conditions:{stages:['ganada']}},/Etapas/);bad({actions:[{type:'enviar_todo'}]},/no disponible/);
  const r=recipes.create({brandId:brand,title:'Ok',definition:definition()},{id:'adm'});
  assert.equal(r.status,'draft');assert.equal(r.revision,1);assert.equal(db.prepare('SELECT count(*) n FROM automation_recipe_versions').get().n,1);
  db.prepare("UPDATE content_templates SET status='draft' WHERE id=?").run(template);
  assert.throws(()=>recipes.publish(r.id,{expectedRevision:1},{id:'adm'}),/Aprueba la plantilla/);
  assert.throws(()=>recipes.update(r.id,{expectedRevision:99,title:'z'},{id:'adm'}),/cambió/);
});

test('simulación: explica condiciones y propone acciones sin escribir nada',async t=>{
  const {recipes,brand,mkConversation,msg,counts,definition,c,stub,conv}=await setup(t);
  mkConversation('c1');msg('c1','customer',c.t-90*MIN);const last=msg('c1','agent',c.t-40*MIN);
  const r=recipes.create({brandId:brand,title:'Sim',definition:definition()},{id:'adm'}),before=counts();
  const sim=recipes.simulate(r,null,conv('c1'));
  assert.equal(sim.matches,true);assert.equal(sim.sourceMessageId,last);assert.equal(sim.runAt,c.t-10*MIN);
  assert.deepEqual(sim.actions.map(a=>a.type),['template','task','notify']);assert.match(sim.actions[0].text,/Seguimos/);
  assert.deepEqual(counts(),before);
  stub.unavailable=true;const off=recipes.simulate(r,null,conv('c1'));
  assert.equal(off.matches,false);assert.equal(off.reason,'material_unavailable');assert.ok(off.checks.some(x=>x.check==='material_available'&&!x.ok));
  stub.unavailable=false;
  const other=recipes.simulate(r,definition({conditions:{stages:['inscripcion']}}),conv('c1'));assert.equal(other.matches,false);assert.equal(other.reason,'stage_changed');
  assert.deepEqual(counts(),before);
});

test('no es retroactiva: sólo cuenta mensajes posteriores a la publicación y requiere marca habilitada',async t=>{
  const {recipes,automation,brand,mkConversation,msg,counts,publish,c,db}=await setup(t);
  mkConversation('c1');msg('c1','agent',c.t-5*MIN);
  publish();assert.deepEqual(recipes.scan(),[]);
  automation.setBrand(brand,true,0,'adm');c.t+=6000;assert.deepEqual(recipes.scan(),[]);
  assert.equal(counts().automation_steps,0);
  c.t+=1000;mkConversation('c2');msg('c2','automation',c.t);c.t+=6000;
  assert.equal(recipes.scan().length,1);assert.equal(db.prepare('SELECT count(*) n FROM automation_runs').get().n,1);
});

test('una ejecución por mensaje de origen; efectos atómicos e idempotentes; trazabilidad',async t=>{
  const {recipes,automation,brand,mkConversation,msg,publish,c,db}=await setup(t);
  automation.setBrand(brand,true,0,'adm');mkConversation('c1');
  const recipe=publish();c.t+=1000;const source=msg('c1','agent',c.t);
  c.t+=6000;const made=recipes.scan();assert.equal(made.length,1);c.t+=6000;assert.deepEqual(recipes.scan(),[]);
  await automation.tick();assert.equal(automation.get(made[0]).state,'pending');
  c.t+=31*MIN;await automation.tick();
  const step=automation.get(made[0]);assert.equal(step.state,'completed');
  const res=JSON.parse(db.prepare('SELECT result FROM automation_steps WHERE id=?').get(step.id).result);
  assert.ok(res.messageId&&res.taskId&&res.notified===1);
  assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE client_ref=?').get('recipe:'+step.id).n,1);
  const task=db.prepare('SELECT * FROM tasks WHERE id=?').get(res.taskId);assert.equal(task.title,'Llamar al interesado');assert.equal(task.status,'open');assert.equal(task.due_at,c.t+60*MIN);
  assert.equal(db.prepare("SELECT count(*) n FROM crm_events WHERE kind='task.created' AND opportunity_id='op-c1'").get().n,1);
  assert.equal(db.prepare("SELECT user_id FROM notifications WHERE kind='recipe'").get().user_id,'adm');
  c.t+=60*MIN;recipes.scan();await automation.tick();assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM automation_runs').get().n,1);   // el mensaje de la receta no la reactiva
  msg('c1','customer',c.t+1);msg('c1','agent',c.t+2);c.t+=6000;assert.equal(recipes.scan().length,1);   // tras una respuesta del cliente puede volver a aplicar
  const run=db.prepare('SELECT * FROM automation_runs').get();assert.equal(run.recipe_id,recipe.id);assert.equal(run.source_key,source);assert.equal(run.recipe_revision,recipe.revision);
});

test('cancela si el cliente responde, una persona toma el control, cierra o cambia la etapa',async t=>{
  const {recipes,automation,brand,mkConversation,msg,publish,c,db,definition}=await setup(t);
  const ids=['reply','human','closed','stage','opp'];
  automation.setBrand(brand,true,0,'adm');for(const id of ids)mkConversation(id);
  publish(definition({conditions:{stages:['interesado']}}));c.t+=1000;
  for(const id of ids)msg(id,'agent',c.t);
  c.t+=6000;assert.equal(recipes.scan().length,5);
  msg('reply','customer',c.t+1);
  db.prepare("UPDATE conversations SET assigned_to='ag',bot_enabled=0 WHERE id='human'").run();
  db.prepare("UPDATE conversations SET status='resolved' WHERE id='closed'").run();
  db.prepare("UPDATE opportunities SET stage='inscripcion' WHERE id='op-stage'").run();
  db.prepare("UPDATE opportunities SET stage='perdida' WHERE id='op-opp'").run();
  c.t+=31*MIN;await automation.tick();
  const reason=id=>db.prepare('SELECT s.cancel_reason r FROM automation_steps s WHERE s.conversation_id=?').get(id).r;
  assert.deepEqual(ids.map(reason),['customer_replied','human_takeover','conversation_closed','stage_changed','opportunity_closed']);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,0);assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE sender_kind='automation'").get().n,0);
});

test('si el material deja de estar disponible, no se envía nada ni se crea la tarea',async t=>{
  const {recipes,automation,brand,mkConversation,msg,publish,c,db,stub}=await setup(t);
  automation.setBrand(brand,true,0,'adm');mkConversation('c1');publish();c.t+=1000;msg('c1','agent',c.t);c.t+=6000;recipes.scan();
  stub.unavailable=true;c.t+=31*MIN;await automation.tick();
  assert.equal(db.prepare('SELECT cancel_reason r FROM automation_steps').get().r,'material_unavailable');assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});

test('editar o pausar detiene pasos pendientes; las versiones quedan registradas y las revisiones se exigen',async t=>{
  const {recipes,automation,brand,mkConversation,msg,publish,c,db,definition}=await setup(t);
  automation.setBrand(brand,true,0,'adm');mkConversation('c1');mkConversation('c2');
  let r=publish();c.t+=1000;msg('c1','agent',c.t);msg('c2','agent',c.t);c.t+=6000;assert.equal(recipes.scan().length,2);
  r=recipes.pause(r.id,{expectedRevision:r.revision},{id:'adm'});assert.equal(r.status,'paused');
  assert.deepEqual(db.prepare('SELECT DISTINCT state,cancel_reason r FROM automation_steps').all().map(x=>({...x})),[{state:'cancelled',r:'recipe_paused'}]);
  assert.throws(()=>recipes.pause(r.id,{expectedRevision:r.revision},{id:'adm'}),/publicada/);
  c.t+=6000;assert.deepEqual(recipes.scan(),[]);
  r=recipes.update(r.id,{expectedRevision:r.revision,title:'Nuevo nombre',definition:definition({trigger:{type:'silence',minutes:45}})},{id:'adm'});
  assert.equal(r.status,'draft');assert.equal(r.definition.trigger.minutes,45);
  assert.throws(()=>recipes.update(r.id,{expectedRevision:r.revision-1,title:'x'},{id:'adm'}),/cambió/);
  r=recipes.publish(r.id,{expectedRevision:r.revision},{id:'adm'});
  const history=db.prepare('SELECT revision,snapshot FROM automation_recipe_versions WHERE recipe_id=? ORDER BY revision').all(r.id).map(v=>({revision:v.revision,...JSON.parse(v.snapshot)}));
  assert.deepEqual(history.map(h=>[h.revision,h.status]),[[1,'draft'],[2,'published'],[3,'paused'],[4,'draft'],[5,'published']]);
  assert.equal(history[0].definition.trigger.minutes,30);assert.equal(history[3].definition.trigger.minutes,45);
});

test('una ejecución ya programada conserva la versión con la que nació',async t=>{
  const {recipes,automation,brand,mkConversation,msg,publish,c,db}=await setup(t);
  automation.setBrand(brand,true,0,'adm');mkConversation('c1');
  const r=publish();c.t+=1000;msg('c1','agent',c.t);c.t+=6000;const [stepId]=recipes.scan();
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM automation_steps WHERE id=?').get(stepId).payload).def.trigger.minutes,30);
  assert.equal(db.prepare('SELECT recipe_revision r FROM automation_runs').get().r,r.revision);
});

test('cancelConversationSteps también detiene los pasos de recetas (toma humana)',async t=>{
  const {recipes,automation,brand,mkConversation,msg,publish,c,db}=await setup(t);
  automation.setBrand(brand,true,0,'adm');mkConversation('c1');publish();c.t+=1000;msg('c1','agent',c.t);c.t+=6000;recipes.scan();
  assert.equal(cancelConversationSteps(db,'c1','human_takeover',c.t),1);c.t+=31*MIN;await automation.tick();
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});
