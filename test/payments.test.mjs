import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const PNG=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137]).toString('base64');

test('venta con pago simulado: apagada por omisión, cobro desde el chat, pago simulado, pedido del motor, comprobantes en cola, cancelación, vencimiento y permisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-payments-')),code=randomUUID(),password='Password-payments-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),msgs=id=>'/api/conversations/'+id+'/messages';
 async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 const stageOf=cid=>{const d=db();try{return d.prepare('SELECT o.stage FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id=?').get(cid)?.stage;}finally{d.close();}};
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),client=await call('/api/auth/register','',{username:'cliente',name:'Cliente Uno',password}),other=await call('/api/auth/register','',{username:'otro',name:'Cliente Dos',password});

 // apagada por omisión: el equipo no puede cobrar y el motor sigue pasando la inscripción a una persona
 const conv=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 await call(msgs(conv.id),client.cookie,{text:'Hola',clientRef:randomUUID()},'POST',201);
 assert.ok(await until(async()=>(await call(msgs(conv.id),client.cookie)).messages.find(m=>m.sender_kind==='automation')));
 assert.equal((await call('/api/conversations/'+conv.id+'/orders/preview',admin.cookie)).enabled,false);
 await call('/api/conversations/'+conv.id+'/orders',admin.cookie,{},'POST',409);
 await call('/api/payments/settings',client.cookie,undefined,'GET',403);
 await call('/api/payments/orders',client.cookie,undefined,'GET',403);
 await call('/api/payments/brands/globalvet',client.cookie,{enabled:true,expectedRevision:0},'PATCH',403);
 const on=(await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,linkHours:48,expectedRevision:0},'PATCH')).settings;assert.equal(on.enabled,1);assert.equal(on.revision,1);
 await call('/api/payments/brands/globalvet',admin.cookie,{linkHours:0,expectedRevision:1},'PATCH',400);

 // cobro desde el chat: pedido con precio del catálogo, enlace al cliente, idempotente por conversación
 const made=await call('/api/conversations/'+conv.id+'/orders',admin.cookie,{},'POST',201);
 assert.equal(made.created,true);assert.equal(made.order.status,'pending');assert.match(made.order.reference,/^TC-[0-9A-F]{6}$/);assert.equal(made.order.amount_cents,37900);assert.equal(made.order.source,'agent');
 const sent=(await call(msgs(conv.id),client.cookie)).messages.at(-1);assert.equal(sent.sender_kind,'agent');assert.ok(sent.text.includes(made.order.reference)&&sent.text.includes('/?pay='+made.order.id));assert.equal(sent.category,'utility');
 const again=await call('/api/conversations/'+conv.id+'/orders',admin.cookie,{resend:true},'POST',200);assert.equal(again.created,false);assert.equal(again.order.id,made.order.id);
 assert.equal((await call('/api/conversations/'+conv.id+'/orders/preview',admin.cookie)).existing.id,made.order.id);

 // el cliente ve su pedido; otro cliente no; pago rechazado y luego aprobado por el proveedor simulado
 const cv=(await call('/api/payments/orders/'+made.order.id+'/customer',client.cookie)).order;assert.equal(cv.status,'pending');assert.equal(cv.amountLabel.replace(/\s/g,''),'$379.00');
 await call('/api/payments/orders/'+made.order.id+'/customer',other.cookie,undefined,'GET',404);
 await call('/api/payments/orders/'+made.order.id+'/pay',other.cookie,{method:'card'},'POST',404);
 await call('/api/payments/orders/'+made.order.id+'/pay',client.cookie,{method:'bitcoin'},'POST',400);
 const declined=(await call('/api/payments/orders/'+made.order.id+'/pay',client.cookie,{method:'card',outcome:'declined'})).order;assert.equal(declined.status,'pending');
 assert.match((await call(msgs(conv.id),client.cookie)).messages.at(-1).text,/no se completó/);
 const paid=(await call('/api/payments/orders/'+made.order.id+'/pay',client.cookie,{method:'oxxo'})).order;
 assert.equal(paid.status,'paid');assert.equal(paid.method,'oxxo');assert.match(paid.provider_ref,/^sim_/);assert.equal(paid.confirmed_by,null);
 assert.match((await call(msgs(conv.id),client.cookie)).messages.at(-1).text,/Pago confirmado \(laboratorio\)/);
 assert.equal(stageOf(conv.id),'ganada');
 {const d=db();try{assert.equal(d.prepare('SELECT count(*) n FROM enrollments WHERE order_id=?').get(made.order.id).n,1);assert.equal(d.prepare("SELECT count(*) n FROM notifications WHERE kind='payment' AND event_key=?").get('order:'+made.order.id+':paid').n,1);}finally{d.close();}}
 await call('/api/payments/orders/'+made.order.id+'/pay',client.cookie,{method:'card'},'POST',409);
 await call('/api/conversations/'+conv.id+'/orders',admin.cookie,{},'POST',409);   // la oportunidad ya está ganada
 const list=await call('/api/payments/orders?brand=all',admin.cookie);assert.equal(list.stats.paid,1);assert.equal(list.stats.paidAmountCents,37900);assert.equal(list.orders[0].statusLabel,'Pagado');
 assert.deepEqual((await call('/api/payments/orders/'+made.order.id,admin.cookie)).events.map(e=>e.kind),['created','link.sent','link.sent','provider.declined','confirmed']);

 // con la venta activa, el motor genera el pedido al detectar la inscripción (sin pasar a persona) y un adjunto entra a la cola como comprobante
 const conv2=(await call('/api/conversations',other.cookie,{courseId:'aves',channel:'instagram'})).conversation;
 await call(msgs(conv2.id),other.cookie,{text:'Hola',clientRef:randomUUID()},'POST',201);
 assert.ok(await until(async()=>(await call(msgs(conv2.id),other.cookie)).messages.find(m=>m.sender_kind==='automation')));
 await call(msgs(conv2.id),other.cookie,{text:'Quiero inscribirme al curso',clientRef:randomUUID()},'POST',201);
 const offer=await until(async()=>(await call(msgs(conv2.id),other.cookie)).messages.find(m=>m.sender_kind==='automation'&&/Pedido de práctica TC-/.test(m.text)));
 assert.ok(offer,'el motor envió el pedido');assert.equal(offer.text.includes('{{pedido}}'),false);
 const o2=(await call('/api/payments/orders?brand=globalvet&status=pending',admin.cookie)).orders.find(o=>o.conversation_id===conv2.id);assert.equal(o2.source,'bot');
 assert.equal((await call('/api/conversations/'+conv2.id,admin.cookie)).conversation.status,'open');assert.equal(stageOf(conv2.id),'inscripcion');
 await call(msgs(conv2.id),other.cookie,{text:'Quiero inscribirme',clientRef:randomUUID()},'POST',201);
 assert.ok(await until(async()=>(await call(msgs(conv2.id),other.cookie)).messages.find(m=>m.sender_kind==='automation'&&/Ya tienes el pedido/.test(m.text))),'recuerda el pedido vigente sin crear otro');
 const before=(await call(msgs(conv2.id),other.cookie)).messages.length;
 const up=await call(msgs(conv2.id),other.cookie,{text:'',clientRef:randomUUID(),attachment:{name:'comprobante.png',type:'image/png',base64:PNG}},'POST',201);
 await sleep(1500);
 const after=(await call(msgs(conv2.id),admin.cookie)).messages;
 assert.equal(after.length,before+2,'adjunto + acuse del comprobante, sin respuesta del bot');assert.match(after.at(-1).text,/Recibimos tu comprobante/);assert.equal(after.find(m=>m.id===up.id).receipt_status,'pending');
 const inReview=(await call('/api/payments/orders/'+o2.id,admin.cookie));assert.equal(inReview.order.status,'review');assert.equal(inReview.receipts.length,1);assert.equal(inReview.receipts[0].prelecture.status,'simulada');assert.ok(inReview.receipts[0].attachmentUrl.startsWith('/api/files/'));
 assert.equal((await call('/api/payments/orders?brand=all&status=review',admin.cookie)).orders.length,1);
 const r1=inReview.receipts[0].id;
 await call('/api/payments/receipts/'+r1+'/accept',other.cookie,{},'POST',403);
 await call('/api/payments/receipts/'+r1+'/reject',admin.cookie,{reason:'x'},'POST',400);
 const rejected=(await call('/api/payments/receipts/'+r1+'/reject',admin.cookie,{reason:'El importe no coincide con el pedido.'})).order;assert.equal(rejected.status,'pending');
 assert.match((await call(msgs(conv2.id),other.cookie)).messages.at(-1).text,/No pudimos validar/);
 await call('/api/payments/receipts/'+r1+'/reject',admin.cookie,{reason:'Otra vez'},'POST',409);
 const up2=await call(msgs(conv2.id),other.cookie,{text:'Aquí va el correcto',clientRef:randomUUID(),attachment:{name:'comprobante2.png',type:'image/png',base64:PNG}},'POST',201);
 const r2=(await call('/api/payments/orders/'+o2.id,admin.cookie)).receipts.find(r=>r.message_id===up2.id);assert.equal(r2.status,'pending');
 const accepted=(await call('/api/payments/receipts/'+r2.id+'/accept',admin.cookie,{note:'Transferencia verificada'})).order;
 assert.equal(accepted.status,'paid');assert.equal(accepted.method,'transfer');assert.equal(accepted.confirmed_by,admin.user.id);assert.equal(stageOf(conv2.id),'ganada');
 assert.equal((await call(msgs(conv2.id),admin.cookie)).messages.find(m=>m.id===up2.id).receipt_status,'accepted');
 {const d=db();try{assert.equal(d.prepare('SELECT count(*) n FROM enrollments').get().n,2);assert.equal(d.prepare("SELECT count(*) n FROM notifications WHERE kind='receipt'").get().n,2);}finally{d.close();}}

 // cancelación y vencimiento en otra marca
 await call('/api/payments/brands/odonteck',admin.cookie,{enabled:true,expectedRevision:0},'PATCH');
 const conv3=(await call('/api/conversations',client.cookie,{courseId:'odontologia',channel:'facebook'})).conversation;
 const o3=(await call('/api/conversations/'+conv3.id+'/orders',admin.cookie,{},'POST',201)).order;
 await call('/api/payments/orders/'+o3.id+'/cancel',admin.cookie,{reason:'x'},'POST',400);
 assert.equal((await call('/api/payments/orders/'+o3.id+'/cancel',admin.cookie,{reason:'Prueba cancelada por el equipo'})).order.status,'cancelled');
 await call('/api/payments/orders/'+o3.id+'/cancel',admin.cookie,{reason:'Otra vez'},'POST',409);
 await call('/api/payments/orders/'+o3.id+'/pay',client.cookie,{method:'card'},'POST',409);
 assert.equal((await call('/api/payments/orders/'+o3.id+'/customer',client.cookie)).order.status,'cancelled');
 const conv4=(await call('/api/conversations',other.cookie,{courseId:'odontologia',channel:'whatsapp'})).conversation;
 const o4=(await call('/api/conversations/'+conv4.id+'/orders',admin.cookie,{},'POST',201)).order;
 {const d=db();try{d.prepare('UPDATE orders SET expires_at=? WHERE id=?').run(Date.now()-1000,o4.id);}finally{d.close();}}
 assert.equal((await call('/api/payments/orders/'+o4.id+'/customer',other.cookie)).order.status,'expired');
 await call('/api/payments/orders/'+o4.id+'/pay',other.cookie,{method:'card'},'POST',409);
 await call('/api/payments/orders/'+randomUUID(),admin.cookie,undefined,'GET',404);
 const d=db();try{assert.equal(d.prepare('PRAGMA user_version').get().user_version,26);assert.equal(d.prepare("SELECT count(*) n FROM payment_events WHERE kind='expired'").get().n,1);}finally{d.close();}
});
