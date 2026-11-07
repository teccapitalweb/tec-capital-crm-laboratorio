import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('cupón escrito por el cliente: sólo cupones permitidos, mismo mensaje ante cualquier negativa, el servidor recalcula, quitar sólo el propio, límites de intentos y de uso',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-couponcli-')),code=randomUUID(),password='Password-couponcli-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(()=>{if(process.env.DEBUG_LOGS)console.error('SERVERLOG',logs);});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),T=()=>Date.now(),H=3600*1000;
 const GENERIC='Ese cupón no es válido o no está disponible para este pedido.';
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const reg=(u)=>call('/api/auth/register','',{username:u,name:'Cliente '+u,password});
 const ana=await reg('ana'),beto=await reg('beto'),cara=await reg('cara'),dani=await reg('dani');
 await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,linkHours:48,expectedRevision:0},'PATCH');
 const mk=over=>call('/api/coupons',admin.cookie,{brandId:'globalvet',code:'X',name:'Cupón',kind:'percent',value:10,...over},'POST',201);
 const chat=async c=>(await call('/api/conversations',c.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const orderFor=async(client,coupon)=>{const conv=await chat(client);const o=(await call('/api/conversations/'+conv.id+'/orders',admin.cookie,coupon?{coupon}:{},'POST',201)).order;return {conv,o};};
 const view=(client,id)=>call('/api/payments/orders/'+id+'/customer',client.cookie).then(r=>r.order);
 const apply=(client,id,code,expected=200)=>call('/api/payments/orders/'+id+'/coupon',client.cookie,{code},'POST',expected);

 // sin cupones para el cliente no se ofrece nada
 const a1=await orderFor(ana);assert.equal((await view(ana,a1.o.id)).couponEntry,false,'sin cupones permitidos no se muestra el campo');
 // administración permite o no que el cliente lo escriba (por omisión no)
 const staffOnly=(await mk({code:'SOLOEQUIPO',value:15})).coupon;assert.equal(staffOnly.customerEntry,false);assert.equal((await view(ana,a1.o.id)).couponEntry,false,'un cupón sólo del equipo no abre el campo');
 const web=(await mk({code:'WEB10',value:10,customerEntry:true,maxUses:3,perContact:1})).coupon;assert.equal(web.customerEntry,true);assert.equal(web.valueLabel,'10 %');
 const flip=(await call('/api/coupons/'+staffOnly.id,admin.cookie,{customerEntry:false,name:'Sólo equipo',expectedRevision:staffOnly.revision},'PATCH')).coupon;assert.equal(flip.customerEntry,false);
 assert.equal((await view(ana,a1.o.id)).couponEntry,true,'hay un cupón que el cliente puede escribir');

 // permisos de la ruta: sin sesión, otra persona, el equipo (no es el cliente del chat)
 await call('/api/payments/orders/'+a1.o.id+'/coupon','',{code:'WEB10'},'POST',401);await apply(beto,a1.o.id,'WEB10',404);await apply(admin,a1.o.id,'WEB10',404);
 await call('/api/payments/orders/'+a1.o.id+'/coupon',beto.cookie,undefined,'DELETE',404);
 await apply(ana,a1.o.id,'   ',400);

 // el cliente no se entera de por qué: mismo mensaje con un cupón que no existe, uno sólo del equipo, uno de otra marca, uno pausado y uno vencido
 const paused=(await mk({code:'PAUSADO',customerEntry:true})).coupon;await call('/api/coupons/'+paused.id,admin.cookie,{status:'paused',expectedRevision:paused.revision},'PATCH');
 await mk({code:'VENCIDO',customerEntry:true,endsAt:T()-H});await call('/api/coupons',admin.cookie,{brandId:'odonteck',code:'OTRAMARCA',name:'Otra marca',kind:'percent',value:10,customerEntry:true},'POST',201);
 const msgs=new Set();for(const c of ['NOEXISTE','SOLOEQUIPO','PAUSADO','VENCIDO','OTRAMARCA']){const r=await fetch(origin+'/api/payments/orders/'+a1.o.id+'/coupon',{method:'POST',headers:{Cookie:ana.cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:c})});assert.equal(r.status,409);msgs.add((await r.json()).error);}
 assert.deepEqual([...msgs],[GENERIC],'todas las negativas dicen lo mismo');
 assert.equal(db.prepare('SELECT amount_cents FROM orders WHERE id=?').get(a1.o.id).amount_cents,37900,'ninguna negativa cambia el pedido');

 // aplicar: el servidor recalcula (aunque el cliente mande un precio), avisa en el chat, deja evento y dice quién lo aplicó
 const applied=(await call('/api/payments/orders/'+a1.o.id+'/coupon',ana.cookie,{code:' web10 ',amountCents:1,priceCents:1,discountCents:99999},'POST')).order;
 assert.equal(applied.amountLabel.replace(/\s/g,''),'$341.10');assert.equal(applied.coupon.code,'WEB10');assert.equal(applied.coupon.removable,true);assert.equal(applied.couponEntry,false);
 const row=db.prepare('SELECT * FROM orders WHERE id=?').get(a1.o.id);assert.equal(row.amount_cents,34110);assert.equal(row.discount_cents,3790);assert.equal(row.coupon_code,'WEB10');assert.equal(row.coupon_source,'customer');
 assert.match((await call('/api/conversations/'+a1.conv.id+'/messages',ana.cookie)).messages.at(-1).text,/Aplicaste el cupón WEB10 al pedido TC-[0-9A-F]{6} \(−\$37\.90\)\. Nuevo total: \$341\.10\./);
 const ev=db.prepare("SELECT * FROM domain_events WHERE type='pedido.cupon_aplicado' AND entity_id=?").get(a1.o.id);assert.ok(ev);assert.equal(JSON.parse(ev.payload).by,'customer');assert.equal(JSON.parse(ev.payload).couponCode,'WEB10');
 assert.ok(db.prepare("SELECT 1 FROM payment_events WHERE order_id=? AND kind='coupon.applied'").get(a1.o.id));
 const staffSees=(await call('/api/payments/orders/'+a1.o.id,admin.cookie)).order;assert.equal(staffSees.couponCode,'WEB10');assert.equal(staffSees.couponBy,'cliente');
 await apply(ana,a1.o.id,'WEB10',409);   // ya tiene un cupón
 // quitar un cupón propio devuelve el precio y libera el uso; volver a aplicarlo sirve
 const removed=(await call('/api/payments/orders/'+a1.o.id+'/coupon',ana.cookie,undefined,'DELETE')).order;assert.equal(removed.coupon,null);assert.equal(removed.couponEntry,true);
 assert.equal(db.prepare('SELECT amount_cents,discount_cents,coupon_code,coupon_source FROM orders WHERE id=?').get(a1.o.id).amount_cents,37900);assert.equal(db.prepare('SELECT coupon_code FROM orders WHERE id=?').get(a1.o.id).coupon_code,null);
 await call('/api/payments/orders/'+a1.o.id+'/coupon',ana.cookie,undefined,'DELETE',409);   // ya no hay cupón que quitar
 await apply(ana,a1.o.id,'WEB10');
 // pagar cobra el importe con descuento (el servidor lo toma del pedido)
 assert.equal((await call('/api/payments/orders/'+a1.o.id+'/pay',ana.cookie,{method:'card'})).order.status,'paid');
 assert.equal(db.prepare("SELECT amount_cents FROM orders WHERE id=? AND status='paid'").get(a1.o.id).amount_cents,34110);
 await apply(ana,a1.o.id,'WEB10',409);   // ya pagado: no admite cambios
 await call('/api/payments/orders/'+a1.o.id+'/coupon',ana.cookie,undefined,'DELETE',409);

 // un cupón que aplicó el equipo no lo quita el cliente
 await mk({code:'EQUIPO20',value:20});const b1=await orderFor(beto,'EQUIPO20');const bv=await view(beto,b1.o.id);assert.equal(bv.coupon.code,'EQUIPO20');assert.equal(bv.coupon.removable,false);assert.equal(bv.couponEntry,false);
 await call('/api/payments/orders/'+b1.o.id+'/coupon',beto.cookie,undefined,'DELETE',409);assert.equal(db.prepare('SELECT coupon_code FROM orders WHERE id=?').get(b1.o.id).coupon_code,'EQUIPO20');
 await apply(beto,b1.o.id,'WEB10',409);

 // por persona (1) y total (3): la misma persona no repite, y se agota
 const c1=await orderFor(cara);await apply(cara,c1.o.id,'WEB10');
 const d1=await orderFor(dani);await apply(dani,d1.o.id,'WEB10');   // tercer uso vivo (Ana pagado, Cara y Dani)
 const e=await reg('eli');const e1=await orderFor(e);await apply(e,e1.o.id,'WEB10',409);   // agotado
 assert.equal((await call('/api/coupons?brand=globalvet',admin.cookie)).coupons.find(c=>c.code==='WEB10').uses,3);
 // un pedido cancelado libera el cupo
 await call('/api/payments/orders/'+d1.o.id+'/cancel',admin.cookie,{reason:'Prueba cancelada por el equipo'},'POST');
 await apply(e,e1.o.id,'WEB10');

 // el plan por sesión no admite cupón
 db.prepare("UPDATE orders SET plan='per_session' WHERE id=?").run(c1.o.id);db.prepare("UPDATE orders SET coupon_id=NULL,coupon_code=NULL,discount_cents=0,coupon_source=NULL,amount_cents=37900 WHERE id=?").run(c1.o.id);
 await apply(cara,c1.o.id,'WEB10',409);assert.equal((await view(cara,c1.o.id)).couponEntry,false);

 // límite de intentos: ráfagas de códigos inventados se frenan
 const f=await reg('fer');const f1=await orderFor(f);let last=0;for(let i=0;i<20;i++){const r=await fetch(origin+'/api/payments/orders/'+f1.o.id+'/coupon',{method:'POST',headers:{Cookie:f.cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:'INVENTADO'+i})});last=r.status;if(r.status===429)break;}
 assert.equal(last,429,'se frenan las adivinanzas');
 assert.ok(db.prepare("SELECT count(*) n FROM payment_events WHERE kind IN ('coupon.applied','coupon.removed')").get().n>=5,'queda historial de los cambios');
 db.close();
});
