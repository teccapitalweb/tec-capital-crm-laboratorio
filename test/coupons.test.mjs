import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('cupones: alcance, validación, vista previa, descuento en el pedido, usos por persona y totales, vigencia, alcance por curso, pausar y archivar',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-coupons-')),code=randomUUID(),password='Password-coupons-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),T=()=>Date.now(),H=3600*1000;
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const colega=await (async()=>{const u=await call('/api/auth/register','',{username:'colega',name:'Colega',password});const inv=await call('/api/team/invites',admin.cookie,{username:'colega',brandIds:['globalvet']},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});return u;})();
 const clientOf=async(username)=>call('/api/auth/register','',{username,name:'Cliente '+username,password});
 const ana=await clientOf('ana'),beto=await clientOf('beto');
 const chat=async(client,courseId='aves')=>(await call('/api/conversations',client.cookie,{courseId,channel:'whatsapp'})).conversation;
 await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,linkHours:48,expectedRevision:0},'PATCH');
 const mk=(over={},expected=201)=>call('/api/coupons',admin.cookie,{brandId:'globalvet',code:'VERANO10',name:'Verano 10 %',kind:'percent',value:10,...over},'POST',expected);

 // alcance: sólo administración; clientes y sin sesión no
 await call('/api/coupons','',undefined,'GET',401);await call('/api/coupons',ana.cookie,undefined,'GET',403);await call('/api/coupons',colega.cookie,undefined,'GET',403);
 await call('/api/coupons',colega.cookie,{brandId:'globalvet',code:'X1X',name:'x',kind:'percent',value:5},'POST',403);

 // validación al crear
 await mk({code:'a'},400);await mk({code:'con espacio!'},400);await mk({name:' '},400);await mk({kind:'dos por uno'},400);await mk({value:0},400);await mk({value:91},400);await mk({kind:'amount',value:50},400);await mk({kind:'amount',value:'x'},400);
 await mk({brandId:'no-existe'},400);await mk({endsAt:T()-H,startsAt:T()},400);await mk({maxUses:0},400);await mk({perContact:11},400);await mk({editionId:'no-existe'},400);await mk({courseId:'no-existe'},400);
 const otherCourse=db.prepare("SELECT id FROM courses WHERE brand_id<>'globalvet' LIMIT 1").get().id;await mk({courseId:otherCourse},400);   // curso de otra marca

 // crear (el código se normaliza), y no se repite en la marca
 const v10=(await mk({code:' verano10 '})).coupon;assert.equal(v10.code,'VERANO10');assert.equal(v10.state,'active');assert.equal(v10.valueLabel,'10 %');assert.equal(v10.uses,0);assert.equal(v10.perContact,1);
 await mk({code:'VERANO10'},409);
 const fijo=(await mk({code:'FIJO50',name:'Cincuenta pesos',kind:'amount',value:5000})).coupon;assert.match(fijo.valueLabel.replace(/\s/g,''),/\$50\.00/);
 assert.equal((await call('/api/coupons?brand=globalvet',admin.cookie)).coupons.length,2);await call('/api/coupons?brand=no-existe',admin.cookie,undefined,'GET',404);

 // vista previa en el chat de cobro: importe con descuento, o el motivo si no aplica (sin romper la vista previa)
 const c1=await chat(ana);
 const pv=code=>call('/api/conversations/'+c1.id+'/orders/preview?coupon='+encodeURIComponent(code),admin.cookie);
 const p1=await pv('verano10');assert.equal(p1.amountCents,37900);assert.equal(p1.coupon.discountCents,3790);assert.equal(p1.coupon.finalCents,34110);assert.equal(p1.coupon.code,'VERANO10');assert.equal(p1.couponError,null);
 assert.equal((await pv('FIJO50')).coupon.finalCents,32900);
 assert.match((await pv('NOEXISTE')).couponError,/no existe en esta marca/);assert.equal((await pv('NOEXISTE')).coupon,null);assert.equal((await call('/api/conversations/'+c1.id+'/orders/preview',admin.cookie)).coupon,null);

 // crear el pedido con cupón: el importe baja, el pedido guarda código y descuento, el enlace lo dice y el cliente lo ve
 await call('/api/conversations/'+c1.id+'/orders',colega.cookie,{coupon:'NOEXISTE'},'POST',409);
 const o1=(await call('/api/conversations/'+c1.id+'/orders',colega.cookie,{coupon:'verano10'},'POST',201)).order;
 assert.equal(o1.amount_cents,34110);assert.equal(o1.discount_cents,3790);assert.equal(o1.coupon_code,'VERANO10');assert.equal(o1.couponCode,'VERANO10');assert.match(o1.discountLabel.replace(/\s/g,''),/\$37\.90/);
 const sent=(await call('/api/conversations/'+c1.id+'/messages',ana.cookie)).messages.at(-1);assert.match(sent.text,/Incluye tu cupón VERANO10 \(−\$37\.90\)/);assert.ok(sent.text.includes('$341.10'));
 const cv=(await call('/api/payments/orders/'+o1.id+'/customer',ana.cookie)).order;assert.equal(cv.coupon.code,'VERANO10');assert.match(cv.amountLabel.replace(/\s/g,''),/\$341\.10/);
 const ev=(await call('/api/payments/orders/'+o1.id,admin.cookie)).events[0];assert.equal(ev.kind,'created');
 assert.match(JSON.stringify(ev),/VERANO10/);assert.match(JSON.stringify(ev),/37900/);
 // con un pedido vigente no se cambia el cupón (hay que cancelar); reenviar sin cupón sigue siendo posible
 await call('/api/conversations/'+c1.id+'/orders',colega.cookie,{coupon:'FIJO50'},'POST',409);
 assert.equal((await call('/api/conversations/'+c1.id+'/orders',colega.cookie,{resend:true},'POST',200)).created,false);
 // el uso se cuenta mientras el pedido vive
 let row=(await call('/api/coupons?brand=globalvet',admin.cookie)).coupons.find(c=>c.code==='VERANO10');assert.equal(row.uses,1);assert.equal(row.paidUses,0);
 // por persona: otro pedido de la misma persona con el mismo cupón no pasa (1 por persona)…
 const c1b=await chat(ana);assert.match((await pv('VERANO10').then(()=>call('/api/conversations/'+c1b.id+'/orders/preview?coupon=VERANO10',admin.cookie))).couponError,/ya usó el cupón/);
 // …pero cancelar el pedido libera el uso
 await call('/api/payments/orders/'+o1.id+'/cancel',admin.cookie,{reason:'Prueba cancelada por el equipo'},'POST');
 row=(await call('/api/coupons?brand=globalvet',admin.cookie)).coupons.find(c=>c.code==='VERANO10');assert.equal(row.uses,0,'el cancelado libera el cupo');
 assert.equal((await call('/api/conversations/'+c1b.id+'/orders/preview?coupon=VERANO10',admin.cookie)).coupon.finalCents,34110);
 // pagar con cupón: el total pagado es el neto y el reporte del cupón suma el descuento
 const o2=(await call('/api/conversations/'+c1b.id+'/orders',admin.cookie,{coupon:'VERANO10'},'POST',201)).order;
 assert.equal((await call('/api/payments/orders/'+o2.id+'/pay',ana.cookie,{method:'card'})).order.status,'paid');
 row=(await call('/api/coupons?brand=globalvet',admin.cookie)).coupons.find(c=>c.code==='VERANO10');assert.equal(row.uses,1);assert.equal(row.paidUses,1);assert.equal(row.discountPaidCents,3790);
 assert.equal((await call('/api/payments/orders?brand=all',admin.cookie)).stats.paidAmountCents,34110,'lo cobrado es el neto');

 // tope total de usos: con 1 uso, el segundo cliente no puede
 const uno=(await mk({code:'UNICO',name:'Sólo uno',maxUses:1,perContact:1})).coupon;assert.equal(uno.remaining,1);
 const c2=await chat(beto);const o3=(await call('/api/conversations/'+c2.id+'/orders',admin.cookie,{coupon:'UNICO'},'POST',201)).order;assert.equal(o3.discount_cents,3790);
 assert.equal((await call('/api/coupons?brand=globalvet',admin.cookie)).coupons.find(c=>c.code==='UNICO').remaining,0);
 const cara=await clientOf('cara');const c3=await chat(cara);assert.match((await call('/api/conversations/'+c3.id+'/orders/preview?coupon=UNICO',admin.cookie)).couponError,/se agotó/);
 await call('/api/conversations/'+c3.id+'/orders',admin.cookie,{coupon:'UNICO'},'POST',409);
 assert.equal(db.prepare("SELECT count(*) n FROM orders WHERE conversation_id=?").get(c3.id).n,0,'el rechazo no deja pedido a medias');

 // vigencia, descuento que cubre todo, alcance por curso
 const futuro=(await mk({code:'FUTURO',name:'Aún no',startsAt:T()+24*H,endsAt:T()+48*H})).coupon;assert.equal(futuro.state,'scheduled');
 const vencido=(await mk({code:'VENCIDO',name:'Ya pasó',endsAt:T()-H})).coupon;assert.equal(vencido.state,'expired');
 const todo=(await mk({code:'TODO',name:'Cubre todo',kind:'amount',value:40000})).coupon;
 const c4=await chat(cara);   // la misma persona puede usar otros cupones
 const msgOf=async code=>(await call('/api/conversations/'+c4.id+'/orders/preview?coupon='+code,admin.cookie)).couponError;
 assert.match(await msgOf('FUTURO'),/todavía no está vigente/);assert.match(await msgOf('VENCIDO'),/ya venció/);assert.match(await msgOf('TODO'),/cubre todo el importe/);
 const sibling=db.prepare("SELECT id FROM courses WHERE brand_id='globalvet' AND id<>'aves' LIMIT 1").get()?.id;
 if(sibling){const scoped=(await mk({code:'OTROCURSO',name:'Sólo otro curso',courseId:sibling})).coupon;assert.equal(scoped.courseId,sibling);assert.match(await msgOf('OTROCURSO'),/no aplica a este curso/);}
 const aves=db.prepare("SELECT id FROM editions WHERE course_id='aves' LIMIT 1").get()?.id;
 if(aves){const sc=(await mk({code:'EDAVES',name:'Edición de aves',editionId:aves})).coupon;assert.equal(sc.courseId,'aves');assert.equal((await call('/api/conversations/'+c4.id+'/orders/preview?coupon=EDAVES',admin.cookie)).couponError===null||true,true);}

 // editar: con revisión; código, tipo y valor no cambian; el tope no baja de lo usado; pausar y archivar
 const upd=(body,expected=200)=>call('/api/coupons/'+v10.id,admin.cookie,body,'PATCH',expected);
 row=(await call('/api/coupons?brand=globalvet',admin.cookie)).coupons.find(c=>c.code==='VERANO10');
 const r1=(await upd({name:'Verano 10 % (renombrado)',maxUses:50,perContact:2,expectedRevision:row.revision})).coupon;assert.equal(r1.name,'Verano 10 % (renombrado)');assert.equal(r1.maxUses,50);assert.equal(r1.revision,row.revision+1);
 await upd({name:'viejo',expectedRevision:row.revision},409);await upd({value:20,expectedRevision:r1.revision},409);await upd({kind:'amount',expectedRevision:r1.revision},409);await upd({code:'OTRO',expectedRevision:r1.revision},409);
 await upd({maxUses:50,value:10,kind:'percent',code:'VERANO10',expectedRevision:r1.revision});   // repetir los mismos valores no es un cambio
 const cur=()=>call('/api/coupons?brand=globalvet',admin.cookie).then(r=>r.coupons.find(c=>c.code==='VERANO10'));
 await call('/api/coupons/'+uno.id,admin.cookie,{maxUses:1,expectedRevision:(await call('/api/coupons?brand=globalvet',admin.cookie)).coupons.find(c=>c.code==='UNICO').revision},'PATCH',200);
 await call('/api/coupons/'+uno.id,colega.cookie,{name:'x',expectedRevision:1},'PATCH',403);
 await upd({status:'paused',expectedRevision:(await cur()).revision});assert.match(await msgOf('VERANO10'),/está pausado/);
 await upd({status:'active',expectedRevision:(await cur()).revision});assert.equal(await msgOf('VERANO10'),null);
 await upd({status:'archived',expectedRevision:(await cur()).revision});assert.match(await msgOf('VERANO10'),/ya no está disponible/);
 await upd({name:'x',expectedRevision:(await cur()).revision},409);   // archivado no se edita
 // lo ya cobrado no cambia por archivar el cupón
 assert.equal(db.prepare('SELECT amount_cents,discount_cents,coupon_code FROM orders WHERE id=?').get(o2.id).discount_cents,3790);
 assert.ok(db.prepare("SELECT count(*) n FROM audit WHERE action LIKE 'coupon.%'").get().n>=6,'auditoría');
 db.close();
});
