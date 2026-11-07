import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('portal por roles por API: cada persona ve lo suyo, administración ve a otras, alcance por marca, cifras contra el libro, cartera, aperturas y avisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-portal-')),code=randomUUID(),password='Password-portal-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),one=(sql,...a)=>{const d=db();try{return d.prepare(sql).get(...a);}finally{d.close();}},run=(sql,...a)=>{const d=db();try{d.prepare(sql).run(...a);}finally{d.close();}};
 assert.equal((await fetch(origin+'/portal.js')).status,200);

 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 async function member(username,name,brandIds){const u=await call('/api/auth/register','',{username,name,password});const inv=await call('/api/team/invites',admin.cookie,{username,brandIds},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});return u;}
 const vende=await member('vende','Vera Vendedora',['globalvet']),otra=await member('otra','Omar Otro',['odonteck']);
 const ana=await call('/api/auth/register','',{username:'ana',name:'Ana Pérez',password});
 const conv=(await call('/api/conversations',ana.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const contactId=one('SELECT c.id FROM contacts c JOIN users x ON x.id=c.source_user_id WHERE x.username=?','ana').id,vendeId=one('SELECT id FROM users WHERE username=?','vende').id,otraId=one('SELECT id FROM users WHERE username=?','otra').id;
 const odonCourse=one("SELECT id FROM courses WHERE brand_id='odonteck' LIMIT 1").id,t0=Date.now(),DAY=86400000;

 // libro: ventas, reembolso, otra marca y una venta antigua; comisiones y liquidación
 const ledger=(id,kind,brand,course,seller,cents,at)=>run("INSERT INTO ledger_entries(id,kind,brand_id,contact_id,course_id,seller_id,amount_cents,currency,method,occurred_at,period_day,note,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?,'MXN','card',?,?,'',?,?)",id,kind,brand,contactId,course,seller,cents,at,new Date(at).toISOString().slice(0,10),'t:'+id,at);
 ledger('L1','sale','globalvet','aves',vendeId,100000,t0-DAY);ledger('L2','sale','globalvet','aves',vendeId,150000,t0-2*DAY);ledger('L3','refund','globalvet','aves',vendeId,-50000,t0-DAY);
 ledger('L4','sale','odonteck',odonCourse,vendeId,90000,t0-DAY);ledger('L5','sale','globalvet','aves',vendeId,70000,t0-60*DAY);ledger('L6','sale','odonteck',odonCourse,otraId,80000,t0-DAY);
 run("INSERT INTO commission_payouts(id,role,brand_id,user_id,total_cents,currency,entries,paid_at,created_at) VALUES('P1','vendedor','globalvet',?,3000,'MXN',1,?,?)",vendeId,t0,t0);
 run("INSERT INTO commission_entries(id,ledger_id,brand_id,role,user_id,base_cents,percent_bp,fixed_cents,amount_cents,currency,status,payout_id,created_at) VALUES('C1','L1','globalvet','vendedor',?,100000,500,0,5000,'MXN','accrued',NULL,?)",vendeId,t0);
 run("INSERT INTO commission_entries(id,ledger_id,brand_id,role,user_id,base_cents,percent_bp,fixed_cents,amount_cents,currency,status,payout_id,created_at) VALUES('C2','L2','globalvet','vendedor',?,150000,200,0,3000,'MXN','paid','P1',?)",vendeId,t0);
 // cartera: una oportunidad abierta y un chat a cargo de Vera
 run('UPDATE opportunities SET owner_id=? WHERE contact_id=?',vendeId,contactId);run('UPDATE conversations SET assigned_to=? WHERE id=?',vendeId,conv.id);

 // acceso
 await call('/api/portal/me','',undefined,'GET',401);await call('/api/portal/me',ana.cookie,undefined,'GET',403);
 await call('/api/portal/me?days=0',vende.cookie,undefined,'GET',400);await call('/api/portal/me?days=999',vende.cookie,undefined,'GET',400);
 await call('/api/portal/me?person='+otraId,vende.cookie,undefined,'GET',403);   // una asesora no mira a otra persona
 await call('/api/portal/me?brand=odonteck',vende.cookie,undefined,'GET',404);   // marca sin acceso

 // Vera ve sólo lo suyo y de sus marcas
 const mine=await call('/api/portal/me',vende.cookie);
 assert.equal(mine.person.self,true);assert.equal(mine.person.id,vendeId);assert.deepEqual(mine.scope.brands.map(b=>b.id),['globalvet']);assert.deepEqual(mine.people,[]);
 assert.equal(mine.sales.count,2);assert.equal(mine.sales.grossCents,250000);assert.equal(mine.sales.refunds,1);assert.equal(mine.sales.refundsCents,50000);assert.equal(mine.sales.netCents,200000);assert.equal(mine.sales.avgTicketCents,125000);
 assert.equal(mine.sales.byBrand.length,1);assert.equal(mine.sales.byBrand[0].netCents,200000);assert.equal(mine.sales.recent.length,3);assert.ok(mine.sales.recent.every(r=>r.brand==='GlobalVet'));assert.match(mine.sales.netLabel,/2,000\.00/);
 assert.equal(mine.commissions.accruedCents,5000);assert.equal(mine.commissions.paidCents,3000);assert.equal(mine.commissions.pendingCents,5000);assert.equal(mine.commissions.pendingCount,1);assert.equal(mine.commissions.payouts.length,1);assert.equal(mine.commissions.payouts[0].total_cents,3000);
 assert.equal(mine.pipeline.openTotal,1);assert.equal(mine.pipeline.chats,1);assert.equal(mine.pipeline.waiting===0||mine.pipeline.waiting===1,true);assert.equal(mine.pipeline.winRate,null);assert.equal(mine.coordination.editions.length,0);assert.deepEqual(mine.alerts,[]);
 const long=await call('/api/portal/me?days=90',vende.cookie);assert.equal(long.sales.count,3);assert.equal(long.sales.grossCents,320000);

 // Omar, de otra marca, no ve nada de Vera
 const other=await call('/api/portal/me',otra.cookie);assert.deepEqual(other.scope.brands.map(b=>b.id),['odonteck']);assert.equal(other.sales.count,1);assert.equal(other.sales.grossCents,80000);assert.equal(other.commissions.pendingCents,0);assert.equal(other.pipeline.openTotal,0);

 // administración mira a cualquier persona del equipo (sólo lectura)
 const asAdmin=await call('/api/portal/me?person='+vendeId,admin.cookie);assert.equal(asAdmin.person.self,false);assert.equal(asAdmin.person.name,'Vera Vendedora');assert.equal(asAdmin.sales.netCents,200000);
 assert.deepEqual(asAdmin.scope.brands.map(b=>b.id),['globalvet']);assert.ok(asAdmin.people.some(p=>p.id===vendeId)&&asAdmin.people.some(p=>p.id===otraId));assert.ok(asAdmin.people.every(p=>p.role!=='customer'));
 await call('/api/portal/me?person='+randomUUID(),admin.cookie,undefined,'GET',404);
 await call('/api/portal/me?person='+one('SELECT id FROM users WHERE username=?','ana').id,admin.cookie,undefined,'GET',404);   // un cliente no es parte del equipo
 const adminSelf=await call('/api/portal/me',admin.cookie);assert.equal(adminSelf.person.self,true);assert.ok(adminSelf.scope.brands.length>=3);assert.equal(adminSelf.sales.count,0);

 // aperturas que Vera coordina y sus avisos
 const edition=one("SELECT run_revision FROM editions WHERE id='edition-aves'");
 await call('/api/coordination/editions/edition-aves',admin.cookie,{coordinatorId:vendeId,minStudents:5,expectedRevision:edition.run_revision},'PATCH');
 run("UPDATE editions SET run_status='open',starts_at=? WHERE id='edition-aves'",t0+2*DAY);
 let c1=await call('/api/portal/me',vende.cookie);
 assert.equal(c1.coordination.editions.length,1);const e1=c1.coordination.editions[0];assert.equal(e1.id,'edition-aves');assert.equal(e1.runStatus,'open');assert.equal(e1.enrolled,0);assert.equal(e1.minStudents,5);assert.equal(e1.nextSession,null);assert.equal(e1.survey,null);
 assert.ok(c1.alerts.some(a=>a.level==='urgent'&&/Faltan 5 inscritos/.test(a.text)));assert.ok(c1.alerts.some(a=>/sin sesiones programadas/i.test(a.text)));assert.equal(c1.alerts[0].level,'urgent');
 await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{title:'Bienvenida',startsAt:t0+30*3600000,durationMin:60},'POST',201);
 const c2=await call('/api/portal/me',vende.cookie);assert.equal(c2.coordination.editions[0].nextSession.hasLink,false);assert.equal(c2.coordination.editions[0].sessionsTotal,1);
 assert.ok(c2.alerts.some(a=>a.level==='urgent'&&/no tiene enlace/.test(a.text)));assert.ok(!c2.alerts.some(a=>/sin sesiones programadas/i.test(a.text)));
 // quien no coordina no ve la apertura; y una cerrada hace más de 60 días ya no aparece
 assert.equal((await call('/api/portal/me',otra.cookie)).coordination.editions.length,0);
 run("UPDATE editions SET run_status='closed',run_updated_at=? WHERE id='edition-aves'",t0-90*DAY);assert.equal((await call('/api/portal/me',vende.cookie)).coordination.editions.length,0);
 run("UPDATE editions SET run_updated_at=? WHERE id='edition-aves'",t0-5*DAY);assert.equal((await call('/api/portal/me',vende.cookie)).coordination.editions.length,1);

 // rendimiento del equipo (sólo administración): mismas definiciones que el portal personal
 run("INSERT INTO operation_events(brand_id,conversation_id,actor_id,kind,details,created_at) VALUES('globalvet',?,?,'response',?,?)",conv.id,vendeId,JSON.stringify({kind:'first',waitingSince:t0-600000,respondedAt:t0,withinTarget:true}),t0-1000);
 run("INSERT INTO operation_events(brand_id,conversation_id,actor_id,kind,details,created_at) VALUES('globalvet',?,?,'response',?,?)",conv.id,vendeId,JSON.stringify({kind:'next',waitingSince:t0-300000,respondedAt:t0,withinTarget:false}),t0-500);
 await call('/api/portal/team','',undefined,'GET',401);await call('/api/portal/team',vende.cookie,undefined,'GET',403);await call('/api/portal/team',ana.cookie,undefined,'GET',403);
 const tm=await call('/api/portal/team',admin.cookie);
 assert.deepEqual(tm.rows.map(r=>r.name),['Vera Vendedora','Omar Otro','Administración'],'ordenado por ventas netas');
 const vr=tm.rows[0];assert.equal(vr.sales.netCents,200000);assert.equal(vr.service.responses,2);assert.equal(vr.service.medianMs,600000);assert.equal(vr.service.withinTargetPct,50);assert.equal(vr.pipeline.openTotal,1);assert.equal(vr.coordination.editions,1);assert.deepEqual(vr.brands,['GlobalVet']);
 assert.equal(tm.totals.people,3);assert.equal(tm.totals.netCents,280000);assert.equal(tm.totals.sales,3);
 assert.deepEqual((await call('/api/portal/team?brand=odonteck',admin.cookie)).rows.map(r=>r.name),['Omar Otro','Administración'],'Vera no tiene acceso a esa marca');
 await call('/api/portal/team?brand=nope',admin.cookie,undefined,'GET',404);await call('/api/portal/team?days=0',admin.cookie,undefined,'GET',400);await call('/api/portal/team',admin.cookie,{},'POST',405);
 // sólo lectura y sin esquema nuevo
 await call('/api/portal/me',vende.cookie,{},'POST',405);
 assert.equal(one('PRAGMA user_version').user_version,33);
});
