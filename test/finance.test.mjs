import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../server/database.mjs';
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
import {migrateFinance,periodDay} from '../server/finance-schema.mjs';
import {commissionAmount,periodKey,dayStart} from '../server/finance.mjs';

const upTo19=db=>{migrateCRM(db);migrateFollowup(db);migrateCatalogue(db);migrateOperations(db);migrateAutomation(db);migrateRecipes(db);migrateContacts(db);migrateConsent(db);migrateHolidays(db);migrateMfa(db);migrateReplies(db);migrateSimulator(db);migrateChannel(db);migratePayments(db);migrateConnectors(db);migrateEvaluation(db);migrateCoordination(db);};

test('finanzas: cálculo de comisión, claves de periodo y relleno del libro al migrar a v20 (idempotente)',async t=>{
  assert.equal(commissionAmount(37900,{percent_bp:2000,fixed_cents:500},'sale'),8080);
  assert.equal(commissionAmount(-10000,{percent_bp:2000,fixed_cents:500},'refund'),-2000,'el reembolso devuelve sólo el porcentaje');
  assert.equal(commissionAmount(37900,{percent_bp:0,fixed_cents:0},'sale'),0);
  assert.equal(periodKey('2026-11-04','day'),'2026-11-04');assert.equal(periodKey('2026-11-04','week'),'2026-11-02');assert.equal(periodKey('2026-11-04','month'),'2026-11');
  assert.equal(periodKey('2026-11-02','week'),'2026-11-02','el lunes es su propia semana');assert.equal(periodKey('2026-11-01','week'),'2026-10-26');
  assert.equal(dayStart('no-es-fecha'),null);const start=dayStart('2026-11-04');assert.equal(periodDay(start),'2026-11-04');assert.equal(periodDay(start-1),'2026-11-03');
  const dir=await mkdtemp(join(tmpdir(),'crm-finance-')),db=openDatabase(dir);upTo19(db);
  t.after(async()=>{try{db.close();}catch{}await rm(dir,{recursive:true,force:true});});
  const t0=Date.now();
  db.prepare("INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u-agent','asesora','Asesora','x','agent',1,?,?),('u-cliente','cliente','Cliente','x','customer',2,?,?)").run(t0,t0,t0,t0);
  db.prepare("INSERT INTO contacts(id,brand_id,source_user_id,name,source,created_at,updated_at) VALUES('ct-1','globalvet','u-cliente','Cliente','laboratorio',?,?)").run(t0,t0);
  db.prepare("INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,owner_id,lost_reason,created_at,updated_at,edition_id) VALUES('op-1','ct-1','globalvet','aves','ganada','u-agent','',?,?,'edition-aves')").run(t0,t0);
  db.prepare("INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at,edition_id) VALUES('cv-1','u-cliente','globalvet','aves','whatsapp',?,?,'edition-aves')").run(t0,t0);
  const order=(id,ref,status,paid)=>db.prepare("INSERT INTO orders(id,reference,brand_id,contact_id,opportunity_id,conversation_id,course_id,edition_id,amount_cents,currency,status,method,source,expires_at,paid_at,created_at,updated_at) VALUES(?,?,'globalvet','ct-1','op-1','cv-1','aves','edition-aves',37900,'MXN',?,?,'agent',?,?,?,?)").run(id,ref,status,status==='paid'?'card':null,t0+86400000,paid,t0,t0);
  order('o-paid','TC-AAAAAA','paid',t0-3600000);order('o-pending','TC-BBBBBB','pending',null);order('o-paid-2','TC-CCCCCC','paid',t0-7200000);
  db.prepare("INSERT INTO enrollments(id,order_id,brand_id,contact_id,opportunity_id,course_id,edition_id,status,created_at) VALUES('en-1','o-paid','globalvet','ct-1','op-1','aves','edition-aves','enrolled',?)").run(t0);
  migrateFinance(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,20);
  const rows=db.prepare('SELECT * FROM ledger_entries ORDER BY occurred_at').all();
  assert.equal(rows.length,2,'sólo los pedidos pagados entran al libro');assert.deepEqual(rows.map(r=>r.order_id),['o-paid-2','o-paid']);
  const sale=rows.find(r=>r.order_id==='o-paid');assert.equal(sale.kind,'sale');assert.equal(sale.amount_cents,37900);assert.equal(sale.seller_id,'u-agent');assert.equal(sale.enrollment_id,'en-1');assert.equal(sale.occurred_at,t0-3600000);assert.equal(sale.period_day,periodDay(t0-3600000));assert.equal(sale.dedupe_key,'sale:o-paid');
  assert.equal(db.prepare('SELECT count(*) n FROM commission_entries').get().n,0,'sin reglas no hay comisiones');
  db.close();const again=openDatabase(dir);upTo19(again);migrateFinance(again);assert.equal(again.prepare('SELECT count(*) n FROM ledger_entries').get().n,2,'reinicio sin duplicar');again.close();
});

test('finanzas por API: libro por eventos, reglas, comisiones, recálculo, liquidación, reembolso, función contadora, CSV, conciliación y cruce con Presentación',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-finance-api-')),code=randomUUID(),password='Password-finance-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),msgs=id=>'/api/conversations/'+id+'/messages';
 async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 const ledgerOf=async(cookie,extra='')=>(await call('/api/finance/ledger?brand=all&days=30'+extra,cookie)).entries;
 assert.equal((await fetch(origin+'/finance.js')).status,200);

 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const agent=await call('/api/auth/register','',{username:'asesor',name:'Asesora',password}),conta=await call('/api/auth/register','',{username:'conta',name:'Contadora',password});
 for(const [u,b] of [[agent,'globalvet'],[conta,'odonteck']]){const inv=await call('/api/team/invites',admin.cookie,{username:u.user.username,brandIds:[b]},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});}
 const c1=await call('/api/auth/register','',{username:'alumno1',name:'Alumno Uno',password}),c2=await call('/api/auth/register','',{username:'alumno2',name:'Alumno Dos',password});

 // acceso: administración sí; asesoría y clientes no
 await call('/api/finance',c1.cookie,undefined,'GET',403);await call('/api/finance',agent.cookie,undefined,'GET',403);await call('/api/finance/me',agent.cookie).then(r=>assert.equal(r.allowed,false));
 const empty=await call('/api/finance?brand=all&days=30',admin.cookie);assert.equal(empty.totals.sales,0);assert.equal(empty.reconciliation.ok,true);assert.equal(empty.access.canMarkPaid,true);assert.deepEqual(empty.rules,[]);
 await call('/api/finance?brand=all&days=0',admin.cookie,undefined,'GET',400);await call('/api/finance?brand=all&from=2000-01-01&to=2100-01-01',admin.cookie,undefined,'GET',400);await call('/api/finance?brand=nada',admin.cookie,undefined,'GET',404);

 // regla de la empresa para consultoras (20 %); la de vendedores se fija después para probar el recálculo
 await call('/api/finance/rules',agent.cookie,{role:'consultora',percentBp:2000,expectedRevision:0},'PUT',403);
 await call('/api/finance/rules',admin.cookie,{role:'consultora',percentBp:20000,expectedRevision:0},'PUT',400);
 await call('/api/finance/rules',admin.cookie,{role:'socio',percentBp:2000,expectedRevision:0},'PUT',400);
 const rules=(await call('/api/finance/rules',admin.cookie,{role:'consultora',percentBp:2000,fixedCents:0,expectedRevision:0},'PUT')).rules;assert.equal(rules.length,1);assert.equal(rules[0].brand_id,null);
 await call('/api/finance/rules',admin.cookie,{role:'consultora',percentBp:2500,expectedRevision:0},'PUT',409);
 await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:0},'PATCH');

 // venta 1: la asesora cobra desde el chat (queda como vendedora) y el cliente paga → línea de venta por evento
 const conv1=(await call('/api/conversations',c1.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const o1=(await call('/api/conversations/'+conv1.id+'/orders',agent.cookie,{},'POST',201)).order;
 assert.equal((await call('/api/payments/orders/'+o1.id+'/pay',c1.cookie,{method:'card'})).order.status,'paid');
 const l1=await until(async()=>{const l=await ledgerOf(admin.cookie);return l.length===1?l[0]:null;});
 assert.ok(l1,'el pago confirmado entra al libro por el suscriptor de eventos');assert.equal(l1.kind,'sale');assert.equal(l1.amount_cents,37900);assert.equal(l1.seller_name,'Asesora');assert.equal(l1.reference,o1.reference);assert.equal(l1.contact_name,'Alumno Uno');
 assert.deepEqual(l1.commissions.map(c=>[c.role,c.amount_cents,c.status]),[['consultora',7580,'accrued']],'sin regla de vendedor todavía');
 // regla de vendedores (10 %) para la marca y recálculo de lo pendiente
 await call('/api/finance/rules',admin.cookie,{brandId:'globalvet',role:'vendedor',percentBp:1000,expectedRevision:0},'PUT');
 await call('/api/finance/commissions/recompute',agent.cookie,{},'POST',403);
 assert.equal((await call('/api/finance/commissions/recompute',admin.cookie,{})).accrued,1);
 assert.equal((await call('/api/finance/commissions/recompute',admin.cookie,{})).accrued,0,'idempotente');
 assert.deepEqual((await ledgerOf(admin.cookie))[0].commissions.map(c=>[c.role,c.amount_cents]),[['consultora',7580],['vendedor',3790]]);

 // venta 2: la genera el motor (sin vendedor) → sólo comisión de consultora
 const conv2=(await call('/api/conversations',c2.cookie,{courseId:'aves',channel:'instagram'})).conversation;
 await call(msgs(conv2.id),c2.cookie,{text:'Hola',clientRef:randomUUID()},'POST',201);
 assert.ok(await until(async()=>(await call(msgs(conv2.id),c2.cookie)).messages.find(m=>m.sender_kind==='automation')));
 await call(msgs(conv2.id),c2.cookie,{text:'Quiero inscribirme al curso',clientRef:randomUUID()},'POST',201);
 const o2=await until(async()=>(await call('/api/payments/orders?brand=globalvet&status=pending',admin.cookie)).orders.find(o=>o.conversation_id===conv2.id));
 assert.equal((await call('/api/payments/orders/'+o2.id+'/pay',c2.cookie,{method:'oxxo'})).order.status,'paid');
 const l2=await until(async()=>{const l=await ledgerOf(admin.cookie);return l.length===2?l:null;});
 const bot=l2.find(e=>e.order_id===o2.id);assert.equal(bot.seller_name,null);assert.deepEqual(bot.commissions.map(c=>c.role),['consultora']);

 // resumen, agrupaciones, conciliación y cruce con Presentación
 const s=await call('/api/finance?brand=all&days=30&group=month',admin.cookie);
 assert.equal(s.totals.sales,2);assert.equal(s.totals.salesCents,75800);assert.equal(s.totals.netCents,75800);assert.equal(s.totals.avgTicketCents,37900);
 assert.equal(s.byPeriod.length,1);assert.match(s.byPeriod[0].key,/^\d{4}-\d{2}$/);assert.equal(s.byBrand[0].key,'globalvet');assert.equal(s.byBrand[0].netCents,75800);
 assert.deepEqual(s.bySeller.map(b=>[b.key==='none'?'none':b.label,b.salesCents]).sort(),[['Asesora',37900],['none',37900]].sort());assert.deepEqual(s.byMethod.map(b=>b.key).sort(),['card','oxxo']);
 assert.equal(s.commissions.consultora.accruedCents,15160);assert.equal(s.commissions.vendedor.accruedCents,3790);assert.equal(s.pendingCommissions.consultora,15160);
 assert.equal(s.reconciliation.ok,true);assert.equal(s.reconciliation.paidOrders,2);assert.equal(s.reconciliation.ledgerSalesCents,s.reconciliation.paidOrdersCents);
 const pres=await call('/api/presentation?brand=globalvet&days=30',admin.cookie);assert.equal(pres.sales.amountCents,s.totals.salesCents,'Presentación y Finanzas dicen lo mismo');
 const today=new Date(),from=new Date(today.getTime()-2*86400000).toISOString().slice(0,10),to=new Date(today.getTime()+86400000).toISOString().slice(0,10);
 assert.equal((await call('/api/finance?brand=globalvet&from='+from+'&to='+to+'&group=week',admin.cookie)).totals.sales,2);
 assert.equal((await call('/api/finance?brand=odonteck&days=30',admin.cookie)).totals.sales,0);
 assert.equal((await ledgerOf(admin.cookie,'&q='+o1.reference)).length,1);assert.equal((await ledgerOf(admin.cookie,'&kind=refund')).length,0);
 const csv=await fetch(origin+'/api/finance/ledger.csv?brand=all&days=30',{headers:{Cookie:admin.cookie,Origin:origin}});assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);const csvText=await csv.text();assert.equal(csvText.trim().split('\r\n').length,3);assert.match(csvText,/Venta,GlobalVet,Plan sanitario para aves/);assert.match(csvText,/379\.00,MXN,75\.80,37\.90/);

 // función contadora: lectura de todas las marcas; marcar pagadas sólo con permiso; nunca reglas ni reembolsos
 const members=(await call('/api/finance/access',admin.cookie)).members;assert.ok(members.find(m=>m.id===conta.user.id&&!m.finance));
 await call('/api/finance/access',conta.cookie,{userId:conta.user.id,enabled:true},'PUT',403);
 await call('/api/finance/access',admin.cookie,{userId:c1.user.id,enabled:true},'PUT',404);
 await call('/api/finance/access',admin.cookie,{userId:admin.user.id,enabled:true},'PUT',409);
 await call('/api/finance/access',admin.cookie,{userId:conta.user.id,enabled:true,canMarkPaid:false},'PUT');
 const cs=await call('/api/finance?brand=all&days=30',conta.cookie);assert.equal(cs.totals.sales,2,'la contadora ve todas las marcas aunque su acceso de marca sea otro');assert.equal(cs.access.canMarkPaid,false);
 await call('/api/finance/payouts',conta.cookie,{role:'consultora',brandId:'globalvet'},'POST',403);
 await call('/api/finance/rules',conta.cookie,{role:'consultora',percentBp:1,expectedRevision:1},'PUT',403);
 await call('/api/finance/refunds',conta.cookie,{orderId:o1.reference,amountCents:100,reason:'No procede'},'POST',403);
 await call('/api/finance/access',admin.cookie,{userId:conta.user.id,enabled:true,canMarkPaid:true},'PUT');
 const acc=(await call('/api/finance/commissions?brand=all&status=accrued',conta.cookie)).groups;assert.equal(acc.length,2);assert.equal(acc[0].role,'consultora');assert.equal(acc[0].totalCents,15160);assert.equal(acc[0].entries,2);
 await call('/api/finance/payouts',conta.cookie,{role:'vendedor',brandId:'globalvet'},'POST',400);
 await call('/api/finance/payouts',conta.cookie,{role:'consultora',brandId:'odonteck'},'POST',409);
 const pay=(await call('/api/finance/payouts',conta.cookie,{role:'consultora',brandId:'globalvet',note:'Transferencia 777'},'POST',201)).payout;assert.equal(pay.totalCents,15160);assert.equal(pay.entries,2);
 await call('/api/finance/payouts',conta.cookie,{role:'consultora',brandId:'globalvet'},'POST',409);
 const afterPay=await call('/api/finance/commissions?brand=all&status=accrued',conta.cookie);assert.deepEqual(afterPay.groups.map(g=>g.role),['vendedor']);assert.equal(afterPay.payouts.length,1);assert.equal(afterPay.payouts[0].paid_by_name,'Contadora');
 assert.equal((await call('/api/finance/commissions?brand=all&status=paid',admin.cookie)).groups[0].items.every(i=>i.payout_id===pay.id),true);
 const ccsv=await (await fetch(origin+'/api/finance/commissions.csv?brand=all&status=paid',{headers:{Cookie:conta.cookie,Origin:origin}})).text();assert.equal(ccsv.trim().split('\r\n').length,3);assert.match(ccsv,/20\.00%/);
 assert.equal((await call('/api/finance?brand=all&days=30',admin.cookie)).commissions.consultora.paidCents,15160);

 // reembolso parcial: línea negativa, comisiones negativas con la misma regla, conciliación intacta
 await call('/api/finance/refunds',admin.cookie,{orderId:o1.reference,amountCents:50000,reason:'Excede lo cobrado'},'POST',400);
 await call('/api/finance/refunds',admin.cookie,{orderId:o1.reference,amountCents:10000,reason:'x'},'POST',400);
 await call('/api/finance/refunds',admin.cookie,{orderId:'TC-ZZZZZZ',amountCents:100,reason:'No existe'},'POST',404);
 const rf=(await call('/api/finance/refunds',admin.cookie,{orderId:o1.reference,amountCents:10000,reason:'Devolución parcial por cambio de edición'},'POST',201)).entry;
 assert.equal(rf.kind,'refund');assert.equal(rf.amount_cents,-10000);assert.equal(rf.seller_name,'Asesora');assert.deepEqual(rf.commissions.map(c=>[c.role,c.amount_cents,c.status]),[['consultora',-2000,'accrued'],['vendedor',-1000,'accrued']]);
 await call('/api/finance/refunds',admin.cookie,{orderId:o1.reference,amountCents:28000,reason:'Supera el saldo'},'POST',400);
 const s2=await call('/api/finance?brand=all&days=30',admin.cookie);assert.equal(s2.totals.refunds,1);assert.equal(s2.totals.refundsCents,10000);assert.equal(s2.totals.netCents,65800);assert.equal(s2.totals.salesCents,75800);assert.equal(s2.reconciliation.ok,true);
 assert.equal(s2.pendingCommissions.consultora,-2000);assert.equal(s2.pendingCommissions.vendedor,2790);
 await call('/api/finance/payouts',admin.cookie,{role:'consultora',brandId:'globalvet'},'POST',409);   // saldo negativo: nada que pagar
 assert.equal((await ledgerOf(admin.cookie,'&kind=refund')).length,1);
 assert.equal((await call('/api/events?brand=all&type=reembolso.registrado',admin.cookie)).events.length,1);assert.equal((await call('/api/events?brand=all&type=comision.pagada',admin.cookie)).events[0].payload.totalCents,15160);

 // revocar la función de contadora
 await call('/api/finance/access',admin.cookie,{userId:conta.user.id,enabled:false},'PUT');await call('/api/finance',conta.cookie,undefined,'GET',403);
 const d=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});try{assert.equal(d.prepare('PRAGMA user_version').get().user_version,30);assert.equal(d.prepare('SELECT count(*) n FROM ledger_entries').get().n,3);assert.equal(d.prepare("SELECT count(*) n FROM commission_entries WHERE status='paid'").get().n,2);}finally{d.close();}
});
