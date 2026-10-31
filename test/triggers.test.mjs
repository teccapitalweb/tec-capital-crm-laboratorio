import {test} from 'node:test';
import assert from 'node:assert/strict';
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
import {createAutomation} from '../server/automation.mjs';
import {createRecipes} from '../server/recipes.mjs';

const MIN=60_000,HOUR=3_600_000,quiet={error(){}};

async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'crm-triggers-')),db=openDatabase(dir);
  for(const m of [migrateCRM,migrateFollowup,migrateCatalogue,migrateOperations,migrateAutomation,migrateRecipes,migrateContacts,migrateConsent])m(db);
  t.after(async()=>{try{db.close();}catch{}await rm(dir,{recursive:true,force:true});});
  const c={t:Date.now(),now:()=>c.t},t0=c.t;
  for(const [id,role,n] of [['u1','customer',1],['adm','admin',2],['ag','agent',3]])db.prepare('INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)').run(id,id,'P '+id,'x',role,n,t0,t0);
  const course=db.prepare('SELECT id,brand_id FROM courses ORDER BY id LIMIT 1').get(),brand=course.brand_id;
  const conversation=(id,{owner=null,stage='interesado',assigned=null}={})=>{
    db.prepare("INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,assigned_to,created_at,updated_at) VALUES(?,?,?,?,'whatsapp',?,?,?)").run(id,'u1',brand,course.id,assigned,t0,t0);
    db.prepare('INSERT INTO contacts(id,brand_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('ct-'+id,brand,'C '+id,t0,t0);
    db.prepare('INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('op-'+id,'ct-'+id,brand,course.id,stage,owner,t0,t0);
    db.prepare('INSERT INTO conversation_opportunities VALUES(?,?)').run(id,'op-'+id);
  };
  const task=(id,opportunity,dueAt,status='open')=>db.prepare('INSERT INTO tasks(id,opportunity_id,brand_id,title,owner_id,due_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,opportunity,brand,'Tarea '+id,'ag',dueAt,status,t0,t0);
  const waiting=(id,since)=>db.prepare('INSERT INTO service_state(conversation_id,waiting_since) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET waiting_since=excluded.waiting_since').run(id,since);
  const automation=createAutomation({db,now:c.now,log:quiet,baseDelayMs:1000});
  const recipes=createRecipes({db,catalogue:{prepare(){return {text:'x',flyerSnapshot:null};}},automation,insertMessage(){throw Error('no debe enviar mensajes');},broadcast(){},body(){},json(){},audit(){},now:c.now});
  const publish=(trigger,actions)=>{const r=recipes.create({brandId:brand,title:'R',definition:{trigger,conditions:{},actions}},{id:'adm'});return recipes.publish(r.id,{expectedRevision:r.revision},{id:'adm'});};
  const conv=id=>db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  automation.setBrand(brand,true,0,'adm');
  return {db,c,brand,task,waiting,conversation,automation,recipes,publish,conv};
}
const escalate=[{type:'notify',title:'Atender ya'},{type:'task',title:'Escalar',delayMinutes:60}];

test('disparadores nuevos: se validan y no pueden enviar mensajes al cliente',async t=>{
  const {recipes,brand,db}=await setup(t),tpl=db.prepare("SELECT id FROM content_templates WHERE brand_id=? AND status='approved' LIMIT 1").get(brand).id;
  const make=(trigger,actions,conditions={})=>recipes.create({brandId:brand,title:'x',definition:{trigger,conditions,actions}},{id:'adm'});
  assert.throws(()=>make({type:'task_overdue',minutes:30},[{type:'template',templateId:tpl}]),/no envía mensajes/);
  assert.throws(()=>make({type:'waiting_human',minutes:30},[{type:'template',templateId:tpl}]),/escalada interna/);
  assert.throws(()=>make({type:'magia',minutes:30},escalate),/Disparador/);assert.throws(()=>make({type:'task_overdue',minutes:1},escalate),/Minutos/);
  assert.equal(make({type:'waiting_human',minutes:30},escalate,{requireConsent:true}).definition.conditions.requireConsent,undefined);   // sin mensajes no aplica el consentimiento
  assert.equal(make({type:'task_overdue',minutes:30},escalate,{stages:['nuevo']}).definition.trigger.type,'task_overdue');
});

test('tarea vencida: no es retroactiva, escala a quien corresponde y se cancela si la tarea cambia',async t=>{
  const {db,c,recipes,automation,conversation,task,publish}=await setup(t);
  conversation('a',{owner:'ag'});conversation('b',{owner:'ag'});conversation('d',{owner:'ag'});
  task('vieja','op-a',c.t-2*HOUR);                                                      // ya vencida antes de publicar
  const recipe=publish({type:'task_overdue',minutes:30},escalate);
  c.t+=6000;assert.deepEqual(recipes.scan(),[]);
  task('cerrar','op-a',c.t+10*MIN);task('mover','op-b',c.t+10*MIN);task('ok','op-d',c.t+10*MIN);task('hecha','op-d',c.t+10*MIN,'done');
  c.t+=6000;const made=recipes.scan();assert.equal(made.length,3);                       // 'hecha' no cuenta
  assert.deepEqual(recipes.scan(),[]);c.t+=6000;assert.deepEqual(recipes.scan(),[]);     // sin duplicados
  db.prepare("UPDATE tasks SET status='done' WHERE id='cerrar'").run();
  const moved=c.t+3*HOUR;db.prepare('UPDATE tasks SET due_at=? WHERE id=?').run(moved,'mover');
  c.t+=45*MIN;await automation.tick();
  const byTask=Object.fromEntries(made.map(id=>[JSON.parse(db.prepare('SELECT payload FROM automation_steps WHERE id=?').get(id).payload).taskId,automation.get(id)]));
  assert.equal(byTask.cerrar.state,'cancelled');assert.equal(byTask.cerrar.cancel_reason,'task_closed');
  assert.equal(byTask.mover.cancel_reason,'task_rescheduled');
  assert.equal(byTask.ok.state,'completed');
  const res=JSON.parse(db.prepare('SELECT result FROM automation_steps WHERE id=?').get(byTask.ok.id).result);assert.ok(res.taskId);assert.equal(res.notified,2);   // responsable de la oportunidad + administración
  assert.deepEqual(db.prepare("SELECT user_id FROM notifications WHERE kind='recipe' ORDER BY user_id").all().map(r=>r.user_id),['adm','ag']);
  assert.equal(db.prepare('SELECT title FROM tasks WHERE id=?').get(res.taskId).title,'Escalar');
  // la tarea reprogramada vuelve a escalar con su nueva fecha
  c.t=moved+31*MIN;c.t+=6000;const again=recipes.scan();assert.equal(again.length,1);
  assert.equal(db.prepare('SELECT count(*) n FROM automation_runs WHERE recipe_id=?').get(recipe.id).n,4);
  await automation.tick();assert.equal(automation.get(again[0]).state,'completed');
});

test('chat esperando a una persona: escala si sigue sin atención y se cancela si ya lo atendieron',async t=>{
  const {db,c,recipes,automation,conversation,waiting,publish}=await setup(t);
  conversation('a',{owner:'ag'});conversation('b');conversation('c');
  waiting('a',c.t-3*HOUR);                                                              // espera anterior a la publicación
  publish({type:'waiting_human',minutes:15},[{type:'notify',title:'Chat sin atender'}]);
  c.t+=6000;assert.deepEqual(recipes.scan(),[]);
  waiting('b',c.t);waiting('c',c.t);c.t+=6000;const made=recipes.scan();assert.equal(made.length,2);
  waiting('b',null);                                                                    // lo atendió una persona
  c.t+=16*MIN;await automation.tick();
  const state=Object.fromEntries(made.map(id=>[automation.get(id).conversation_id,automation.get(id)]));
  assert.equal(state.b.cancel_reason,'attended');assert.equal(state.c.state,'completed');
  assert.equal(db.prepare("SELECT count(*) n FROM notifications WHERE kind='recipe'").get().n,1);                        // c no tiene responsable: sólo administración
  // una espera nueva en la misma conversación genera su propia escalada
  waiting('b',c.t);c.t+=6000;assert.equal(recipes.scan().length,1);
  db.prepare("UPDATE conversations SET status='resolved' WHERE id='b'").run();c.t+=16*MIN;await automation.tick();
  assert.equal(db.prepare("SELECT cancel_reason r FROM automation_steps WHERE conversation_id='b' AND state='cancelled' ORDER BY updated_at DESC").all().map(r=>r.r).includes('conversation_closed'),true);
});

test('simulación de disparadores nuevos: hora prevista y motivo sin escribir nada',async t=>{
  const {db,c,recipes,conversation,task,waiting,publish,conv}=await setup(t);
  conversation('a',{owner:'ag'});task('t1','op-a',c.t-2*HOUR);waiting('a',c.t-20*MIN);
  const count=()=>['tasks','notifications','automation_steps','automation_runs','automation_events'].map(n=>db.prepare('SELECT count(*) n FROM '+n).get().n).join('-');
  const overdue=publish({type:'task_overdue',minutes:30},escalate),wait=publish({type:'waiting_human',minutes:15},escalate);
  const before=count();
  const s1=recipes.simulate(recipes.get(overdue.id),null,conv('a'));assert.equal(s1.matches,true);assert.equal(s1.trigger,'task_overdue');assert.equal(s1.runAt,c.t-2*HOUR+30*MIN);assert.ok(s1.checks.some(x=>x.check==='task_open'&&x.ok));
  const s2=recipes.simulate(recipes.get(wait.id),null,conv('a'));assert.equal(s2.matches,true);assert.equal(s2.runAt,c.t-20*MIN+15*MIN);assert.ok(s2.checks.some(x=>x.check==='waiting_human'&&x.ok));
  waiting('a',null);db.prepare("UPDATE tasks SET status='done'").run();
  const n1=recipes.simulate(recipes.get(overdue.id),null,conv('a')),n2=recipes.simulate(recipes.get(wait.id),null,conv('a'));
  assert.deepEqual([n1.matches,n1.reason,n2.matches,n2.reason],[false,'task_closed',false,'attended']);
  db.prepare("UPDATE tasks SET status='open'").run();
  assert.equal(count(),before);assert.equal(db.prepare('SELECT count(*) n FROM notifications').get().n,0);
});
