import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,transaction} from '../server/database.mjs';
import {migrateCRM} from '../server/crm.mjs';
import {migrateFollowup} from '../server/followup.mjs';
import {migrateCatalogue} from '../server/catalogue-schema.mjs';
import {migrateOperations,migrateHolidays} from '../server/operations-schema.mjs';
import {migrateAutomation,migrateRecipes} from '../server/automation-schema.mjs';
import {migrateContacts,migrateConsent} from '../server/contacts-schema.mjs';
import {migrateMfa} from '../server/mfa-schema.mjs';
import {migrateReplies} from '../server/replies-schema.mjs';
import {migrateSimulator} from '../server/simulator-schema.mjs';
import {migrateChannel} from '../server/channel-schema.mjs';
import {migratePayments} from '../server/payments-schema.mjs';
import {migrateConnectors} from '../server/connectors-schema.mjs';
import {migrateEvaluation} from '../server/evaluation-schema.mjs';
import {migrateCoordination} from '../server/coordination-schema.mjs';
import {migrateFinance} from '../server/finance-schema.mjs';
import {migratePersons} from '../server/persons-schema.mjs';
import {migrateCertificates} from '../server/certificates-schema.mjs';
import {migrateContent} from '../server/content-schema.mjs';
import {migrateAcademics} from '../server/academics-schema.mjs';
import {migrateLegacy} from '../server/legacy-schema.mjs';
import {createEvents,EVENT_TYPES,ENTITY_KINDS} from '../server/events.mjs';

const migrate=db=>{migrateCRM(db);migrateFollowup(db);migrateCatalogue(db);migrateOperations(db);migrateAutomation(db);migrateRecipes(db);migrateContacts(db);migrateConsent(db);migrateHolidays(db);migrateMfa(db);migrateReplies(db);migrateSimulator(db);migrateChannel(db);migratePayments(db);migrateConnectors(db);migrateEvaluation(db);migrateCoordination(db);migrateFinance(db);migratePersons(db);migrateCertificates(db);migrateContent(db);migrateAcademics(db);migrateLegacy(db);};
async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'crm-events-')),db=openDatabase(dir);migrate(db);
  t.after(async()=>{try{db.close();}catch{}await rm(dir,{recursive:true,force:true});});
  return {dir,db};
}
const clock=(start=1_700_000_000_000)=>{const c={t:start,now:()=>c.t};return c;};
const quiet={error(){}};

test('migración v19: tablas de eventos y coordinación, columnas de apertura, reinicio idempotente',async t=>{
  const {dir,db}=await setup(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,25);
  for(const table of ['domain_events','domain_deliveries','coordination_settings','edition_sessions','attendance','edition_resources'])assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),table);
  const cols=db.prepare('PRAGMA table_info(editions)').all().map(c=>c.name);for(const c of ['min_students','run_status','coordinator_id','group_url','run_note','run_revision'])assert.ok(cols.includes(c),c);
  assert.equal(db.prepare("SELECT count(*) n FROM editions WHERE run_status='planned'").get().n,db.prepare('SELECT count(*) n FROM editions').get().n);
  db.close();const again=openDatabase(dir);migrate(again);assert.equal(again.prepare('PRAGMA user_version').get().user_version,25);again.close();
  assert.ok(Object.keys(EVENT_TYPES).length>=24);for(const [,v] of Object.entries(EVENT_TYPES))assert.ok(ENTITY_KINDS[v.entity],v.entity);
});

test('eventos de dominio: publicación idempotente dentro de la transacción, suscriptores con reintento, fallo permanente, reintento manual, consulta con alcance y CSV',async t=>{
  const {db}=await setup(t),c=clock(),log=[];
  const events=createEvents({db,now:c.now,log:quiet,baseDelayMs:1000,capDelayMs:8000,maxAttempts:3});
  const brand=db.prepare('SELECT id FROM brands ORDER BY created_at LIMIT 1').get().id,other=db.prepare('SELECT id FROM brands ORDER BY created_at LIMIT 1 OFFSET 1').get().id;
  assert.throws(()=>events.publish({type:'no.existe',brandId:brand,entityId:'x',source:'test'}),/no registrado/);
  assert.throws(()=>events.subscribe('no.existe','s',()=>{}),/no registrado/);
  let flaky=0;
  events.subscribe('pago.confirmado','ok',e=>{log.push(['ok',e.entity_id,e.payload.reference]);});
  events.subscribe('pago.confirmado','flaky',()=>{flaky++;if(flaky<3)throw Error('red caída');});
  events.subscribe('pago.confirmado','permanent',()=>{throw Object.assign(Error('rechazado'),{status:400});});
  assert.throws(()=>events.subscribe('pago.confirmado','ok',()=>{}),/repetido/);

  // la publicación vive dentro de la transacción del llamador: si se revierte, no hay evento
  assert.throws(()=>transaction(db,()=>{events.publish({type:'pago.confirmado',brandId:brand,entityId:'o-rollback',payload:{reference:'TC-000000'},source:'test'});throw Error('revertir');}),/revertir/);
  assert.equal(db.prepare('SELECT count(*) n FROM domain_events').get().n,0);
  const first=transaction(db,()=>events.publish({type:'pago.confirmado',brandId:brand,entityId:'o-1',payload:{reference:'TC-111111',amountCents:37900},actorId:null,source:'test'}));
  assert.equal(first.duplicate,false);assert.equal(first.seq,1);
  const dup=events.publish({type:'pago.confirmado',brandId:brand,entityId:'o-1',payload:{reference:'otra'},source:'test'});
  assert.equal(dup.duplicate,true);assert.equal(dup.seq,1);
  assert.equal(db.prepare('SELECT count(*) n FROM domain_events').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM domain_deliveries').get().n,3);
  // evento sin suscriptores: queda como registro, sin entregas
  events.publish({type:'conversacion.abierta',brandId:other,entityId:'c-1',payload:{channel:'whatsapp'},source:'test'});
  assert.equal(db.prepare("SELECT count(*) n FROM domain_deliveries WHERE event_seq=2").get().n,0);

  // primera entrega: ok pasa, flaky falla (reintento programado), permanent falla sin reintento
  assert.equal(await events.tick(),1);
  assert.deepEqual(log,[['ok','o-1','TC-111111']]);
  let d=Object.fromEntries(events.deliveriesOf(1).map(x=>[x.subscriber,x]));
  assert.equal(d.ok.state,'done');assert.equal(d.flaky.state,'pending');assert.equal(d.flaky.attempts,1);assert.equal(d.flaky.next_attempt_at,c.t+1000);assert.match(d.flaky.error,/red caída/);
  assert.equal(d.permanent.state,'failed');assert.equal(d.permanent.attempts,1);
  assert.equal(await events.tick(),0,'antes del siguiente intento no se entrega nada');
  c.t+=1000;assert.equal(await events.tick(),0);d=Object.fromEntries(events.deliveriesOf(1).map(x=>[x.subscriber,x]));assert.equal(d.flaky.attempts,2);assert.equal(d.flaky.next_attempt_at,c.t+2000,'espera creciente');
  c.t+=2000;assert.equal(await events.tick(),1);d=Object.fromEntries(events.deliveriesOf(1).map(x=>[x.subscriber,x]));assert.equal(d.flaky.state,'done');assert.equal(d.flaky.attempts,3);
  assert.equal(log.length,1,'el suscriptor que ya cumplió no se vuelve a llamar');
  // reintento manual sólo de fallidas
  assert.throws(()=>events.retry(1,'ok',{id:null}),/fallida/);
  assert.throws(()=>events.retry(99,'ok',{id:null}),/no encontrada/);
  events.retry(1,'permanent',{id:null});d=Object.fromEntries(events.deliveriesOf(1).map(x=>[x.subscriber,x]));assert.equal(d.permanent.state,'pending');assert.equal(d.permanent.attempts,0);
  await events.tick();assert.equal(Object.fromEntries(events.deliveriesOf(1).map(x=>[x.subscriber,x])).permanent.state,'failed');
  // agotar intentos: un suscriptor que siempre falla termina en fallida tras maxAttempts
  events.subscribe('pedido.creado','siempre',()=>{throw Error('tempor­al');});
  events.publish({type:'pedido.creado',brandId:brand,entityId:'o-2',payload:{reference:'TC-222222'},source:'test'});
  for(let i=0;i<3;i++){await events.tick();c.t+=10000;}
  const s=events.deliveriesOf(3)[0];assert.equal(s.state,'failed');assert.equal(s.attempts,3);

  // consulta con alcance por marca, filtros, paginación y CSV
  assert.equal(events.list([brand]).length,2);assert.equal(events.list([other]).length,1);assert.equal(events.list([]).length,0);
  assert.equal(events.list([brand,other],{type:'conversacion.abierta'}).length,1);assert.equal(events.list([brand],{entityId:'TC-222222'}).length,1);assert.equal(events.list([brand],{q:'37900'}).length,1);
  assert.equal(events.list([brand,other],{before:3}).length,2);assert.equal(events.list([brand,other],{limit:1}).length,1);
  const rows=events.list([brand,other]);assert.equal(rows[0].seq,3);assert.equal(rows[0].failed,1);assert.equal(rows[2].pending,0);
  const st=events.stats([brand,other]);assert.equal(st.total,3);assert.equal(st.failed,2);assert.equal(st.byType[0].n,1);
  const csv=events.csv(rows);assert.match(csv,/^\uFEFFseq,fecha,tipo/);assert.equal(csv.split('\n').length,4);assert.match(csv,/"{""reference"":""TC-222222""}"/);
  assert.match(events.csv([{...rows[0],actor_name:'=HYPERLINK("x")',payload:{}}]),/,"'=HYPERLINK\(""x""\)"/,'una celda que empieza con = se neutraliza');
  assert.equal(events.get(1).payload.reference,'TC-111111');assert.equal(events.get(42),null);
  assert.throws(()=>events.publish({type:'pedido.creado',brandId:brand,entityId:'o-3',payload:{big:'x'.repeat(5000)},source:'test'}),/demasiado grande/);
});
