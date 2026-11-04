import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {hmacHex,metaChannel,stripePayment,simulatedChannel,conektaPayment,REQUIREMENTS,CONTRACT_VERSION} from '../server/connectors.mjs';

test('adaptadores: Meta (firma, verificación y traducción) y Stripe (firma con tolerancia y traducción) sin red',()=>{
  const meta=metaChannel({env:{META_APP_SECRET:'app-secret',META_VERIFY_TOKEN:'verifyme'}});
  assert.equal(meta.configured,false);assert.ok(meta.missing.includes('META_ACCESS_TOKEN'));
  const raw=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{statuses:[{id:'wamid.1',status:'read',timestamp:'1700000000'}],messages:[{id:'wamid.2',from:'5215512345678',text:{body:'Hola'},referral:{headline:'Curso de aves',source_type:'ad',body:'Inscríbete'}}]}}]}]}));
  assert.equal(meta.verifyWebhook({'x-hub-signature-256':'sha256='+hmacHex('app-secret',raw)},raw),true);
  assert.equal(meta.verifyWebhook({'x-hub-signature-256':'sha256='+hmacHex('otro',raw)},raw),false);
  const events=meta.parseWebhook(JSON.parse(raw.toString()));
  assert.deepEqual(events.map(e=>e.type),['message.status','message.inbound']);assert.equal(events[0].data.state,'read');assert.equal(events[0].data.providerRef,'wamid.1');assert.equal(events[0].data.at,1700000000000);
  assert.equal(events[1].data.referral.ad,'Curso de aves');assert.equal(events[1].data.text,'Hola');
  const q=new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':'verifyme','hub.challenge':'12345'});assert.equal(meta.challenge(q),'12345');
  assert.equal(meta.challenge(new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':'mal','hub.challenge':'1'})),null);
  const t=1700000000000,stripe=stripePayment({env:{STRIPE_SECRET_KEY:'sk_test_x',STRIPE_WEBHOOK_SECRET:'whsec_x'},now:()=>t});
  assert.equal(stripe.configured,true);
  const body=JSON.stringify({id:'evt_1',type:'checkout.session.completed',data:{object:{id:'cs_1',amount_total:37900,payment_method_types:['oxxo'],metadata:{orderId:'o1',reference:'TC-AAA111'}}}});
  const ts=Math.floor(t/1000),sig='t='+ts+',v1='+hmacHex('whsec_x',ts+'.'+body);
  assert.equal(stripe.verifyWebhook({'stripe-signature':sig},Buffer.from(body)),true);
  assert.equal(stripePayment({env:{STRIPE_SECRET_KEY:'x',STRIPE_WEBHOOK_SECRET:'whsec_x'},now:()=>t+10*60000}).verifyWebhook({'stripe-signature':sig},Buffer.from(body)),false,'fuera de tolerancia');
  assert.deepEqual(stripe.parseWebhook(JSON.parse(body)),[{id:'evt_1',type:'payment.succeeded',data:{orderId:'o1',reference:'TC-AAA111',providerRef:'cs_1',method:'oxxo',amountCents:37900}}]);
  assert.equal(stripe.parseWebhook({id:'evt_2',type:'customer.created'}).length,0);
  assert.equal(conektaPayment({env:{}}).verifyWebhook({},Buffer.from('{}')),false);
  assert.deepEqual(simulatedChannel({env:{}}).parseWebhook({events:[{id:'a',type:'message.status',data:{providerRef:'x',state:'read'}}]}).map(e=>e.id),['a']);
  assert.ok(REQUIREMENTS.meta.items.length>=5&&REQUIREMENTS.stripe.items.length===2&&CONTRACT_VERSION);
});

async function startServer(env){
  const dir=await mkdtemp(join(tmpdir(),'crm-connectors-')),code=randomUUID();let logs='';
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',...env},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  const call=async(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200)=>{const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const stop=async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});};
  return {dir,code,origin,call,stop,logs:()=>logs};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
const signed=(origin,path,secret,payload,extra={})=>{const raw=JSON.stringify(payload);return fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','x-lab-signature':hmacHex(secret,raw),...extra},body:raw});};

test('contrato de conectores por API: estado, webhooks firmados e idempotentes, estados de mensaje, pagos, prueba desde la interfaz y permisos',async t=>{
 const S=await startServer({CONNECTOR_WEBHOOK_SECRET:'lab-secret-test'});t.after(S.stop);const {origin,call}=S;
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password:'Password-connectors-2026!',inviteCode:S.code}),client=await call('/api/auth/register','',{username:'cliente',name:'Cliente',password:'Password-connectors-2026!'});
 assert.equal((await fetch(origin+'/connectors.js')).status,200);
 const st=await call('/api/connectors',admin.cookie);
 assert.equal(st.channel.effective,'simulated');assert.equal(st.payment.effective,'simulated');assert.equal(st.channel.webhooksEnabled,true);assert.equal(st.env.hasLabSecret,true);assert.ok(st.requirements.meta);
 await call('/api/connectors',client.cookie,undefined,'GET',403);
 // ruta pública: firma obligatoria, proveedor conocido, cuerpo válido
 assert.equal((await fetch(origin+'/api/webhooks/payment/simulated',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await fetch(origin+'/api/webhooks/payment/otro',{method:'POST',body:'{}'})).status,404);
 assert.equal((await fetch(origin+'/api/webhooks/channel/simulated')).status,403);
 assert.equal((await fetch(origin+'/api/webhooks/payment/simulated',{method:'POST',headers:{'x-lab-signature':hmacHex('lab-secret-test','no-json')},body:'no-json'})).status,400);

 // pago confirmado por webhook: pedido pagado, inscripción y etapa ganada; repetir el evento no vuelve a aplicarlo
 await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:0},'PATCH');
 await call('/api/channel/brands/globalvet',admin.cookie,{enabled:true,enforceWindow:false,deliveryDelayMs:200,failureRate:0,expectedRevision:0},'PATCH');
 const conv=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 await call('/api/conversations/'+conv.id+'/messages',client.cookie,{text:'Hola',clientRef:randomUUID()},'POST',201);
 const order=(await call('/api/conversations/'+conv.id+'/orders',admin.cookie,{},'POST',201)).order;
 const bad=await (await signed(origin,'/api/webhooks/payment/simulated','lab-secret-test',{events:[{id:'evt-amount',type:'payment.succeeded',data:{orderId:order.id,providerRef:'pay_x',amountCents:1}}]})).json();
 assert.match(bad.results[0].result,/^rechazado: el importe/);
 const ok=await (await signed(origin,'/api/webhooks/payment/simulated','lab-secret-test',{events:[{id:'evt-1',type:'payment.succeeded',data:{reference:order.reference,providerRef:'pay_123',method:'oxxo',amountCents:order.amount_cents}}]})).json();
 assert.equal(ok.received,1);assert.match(ok.results[0].result,/^aplicado: pedido TC-/);
 const paid=(await call('/api/payments/orders/'+order.id,admin.cookie)).order;assert.equal(paid.status,'paid');assert.equal(paid.method,'oxxo');assert.equal(paid.provider_ref,'pay_123');
 const again=await (await signed(origin,'/api/webhooks/payment/simulated','lab-secret-test',{events:[{id:'evt-1',type:'payment.succeeded',data:{reference:order.reference}}]})).json();
 assert.match(again.results[0].result,/^duplicado/);
 const late=await (await signed(origin,'/api/webhooks/payment/simulated','lab-secret-test',{events:[{id:'evt-2',type:'payment.succeeded',data:{orderId:order.id}}]})).json();
 assert.match(late.results[0].result,/^ignorado: el pedido ya estaba pagado/);
 assert.match((await (await signed(origin,'/api/webhooks/payment/simulated','lab-secret-test',{id:'evt-3',type:'payment.failed',data:{orderId:randomUUID()}})).json()).results[0].result,/^ignorado: pedido no encontrado/);

 // estado de mensaje por webhook: el mensaje entregado por el conector simulado ya tiene referencia del proveedor
 const sent=await call('/api/conversations/'+conv.id+'/messages',admin.cookie,{text:'Mensaje con referencia del proveedor',clientRef:randomUUID(),asAgent:true},'POST',201);
 const delivered=await until(async()=>{const m=(await call('/api/conversations/'+conv.id+'/messages',admin.cookie)).messages.find(x=>x.id===sent.id);return m.delivery_state==='delivered'&&m.provider_ref?m:null;});
 assert.ok(delivered,'entregado por el conector simulado con referencia');assert.match(delivered.provider_ref,/^simch_/);
 const read=await (await signed(origin,'/api/webhooks/channel/simulated','lab-secret-test',{events:[{id:'st-1',type:'message.status',data:{providerRef:delivered.provider_ref,state:'read'}}]})).json();
 assert.equal(read.results[0].result,'aplicado: mensaje read');
 assert.equal((await call('/api/conversations/'+conv.id+'/messages',admin.cookie)).messages.find(x=>x.id===sent.id).delivery_state,'read');
 const back=await (await signed(origin,'/api/webhooks/channel/simulated','lab-secret-test',{events:[{id:'st-2',type:'message.status',data:{providerRef:delivered.provider_ref,state:'delivered'}}]})).json();
 assert.match(back.results[0].result,/sin cambio/);
 assert.match((await (await signed(origin,'/api/webhooks/channel/simulated','lab-secret-test',{events:[{id:'st-3',type:'message.status',data:{providerRef:'nada',state:'read'}}]})).json()).results[0].result,/^ignorado/);
 assert.match((await (await signed(origin,'/api/webhooks/channel/simulated','lab-secret-test',{events:[{id:'in-1',type:'message.inbound',data:{from:'521555',text:'hola'}}]})).json()).results[0].result,/^registrado/);
 assert.match((await (await signed(origin,'/api/webhooks/channel/simulated','lab-secret-test',{events:[{type:'message.status',data:{}}]})).json()).results[0].result,/^rechazado: evento sin id/);

 // prueba firmada desde la interfaz (administración): recorre la ruta pública real
 const t1=await call('/api/connectors/test',admin.cookie,{kind:'channel',state:'failed'});assert.equal(t1.status,200);assert.equal(t1.response.results[0].result,'aplicado: mensaje failed');
 await call('/api/connectors/test',admin.cookie,{kind:'payment',order:'TC-NOPE00'},'POST',404);
 const conv2=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'instagram'})).conversation;
 await call('/api/conversations/'+conv2.id+'/messages',client.cookie,{text:'Hola otra vez',clientRef:randomUUID()},'POST',201);
 const o2=(await call('/api/conversations/'+conv2.id+'/orders',admin.cookie,{},'POST',201)).order;
 const t2=await call('/api/connectors/test',admin.cookie,{kind:'payment',order:o2.reference.toLowerCase(),type:'payment.succeeded',method:'card'});
 assert.match(t2.response.results[0].result,/^aplicado: pedido/);assert.equal((await call('/api/payments/orders/'+o2.id,admin.cookie)).order.status,'paid');
 await call('/api/connectors/test',client.cookie,{kind:'channel'},'POST',403);
 const after=await call('/api/connectors',admin.cookie);assert.ok(after.recentEvents.length>=9);assert.equal(after.recentEvents[0].kind,'payment');
 const d=new DatabaseSync(join(S.dir,'laboratorio.sqlite'),{timeout:5000});try{assert.equal(d.prepare('PRAGMA user_version').get().user_version,28);assert.equal(d.prepare("SELECT count(*) n FROM connector_events WHERE event_id='evt-1'").get().n,1);assert.ok(d.prepare("SELECT provider_ref FROM orders WHERE id=?").get(o2.id).provider_ref);}finally{d.close();}
 assert.equal(S.logs().includes('failed'),false,S.logs());
});

test('proveedor real seleccionado sin accesos: el CRM sigue con el simulado y lo dice; Meta verifica su webhook y traduce estados',async t=>{
 const S=await startServer({CHANNEL_CONNECTOR:'meta',PAYMENT_CONNECTOR:'stripe',META_APP_SECRET:'app-secret',META_VERIFY_TOKEN:'verifyme'});t.after(S.stop);const {origin,call}=S;
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password:'Password-connectors-2026!',inviteCode:S.code});
 const st=await call('/api/connectors',admin.cookie);
 assert.equal(st.channel.selected,'meta');assert.equal(st.channel.effective,'simulated');assert.equal(st.channel.fallback,true);assert.ok(st.channel.missing.includes('META_ACCESS_TOKEN'));
 assert.equal(st.payment.selected,'stripe');assert.equal(st.payment.effective,'simulated');assert.equal(st.payment.webhooksEnabled,false);
 assert.match(S.logs(),/Conector de canal meta sin configurar/);
 // verificación del webhook de Meta y recepción firmada (sin mensaje que coincida: se registra como ignorado)
 const ch=await fetch(origin+'/api/webhooks/channel/meta?hub.mode=subscribe&hub.verify_token=verifyme&hub.challenge=777');assert.equal(ch.status,200);assert.equal(await ch.text(),'777');
 assert.equal((await fetch(origin+'/api/webhooks/channel/meta?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=777')).status,403);
 const raw=JSON.stringify({entry:[{changes:[{field:'messages',value:{statuses:[{id:'wamid.x',status:'delivered',timestamp:'1700000000'}]}}]}]});
 const r=await fetch(origin+'/api/webhooks/channel/meta',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+hmacHex('app-secret',raw)},body:raw});
 const j=await r.json();assert.equal(r.status,200);assert.equal(j.received,1);assert.match(j.results[0].result,/^ignorado: no hay mensaje/);
 assert.equal((await fetch(origin+'/api/webhooks/channel/meta',{method:'POST',headers:{'x-hub-signature-256':'sha256=mal'},body:raw})).status,401);
 // Stripe sin secreto de webhook: desactivado; simulado sin secreto de laboratorio: desactivado
 assert.equal((await fetch(origin+'/api/webhooks/payment/stripe',{method:'POST',body:'{}'})).status,404);
 assert.equal((await fetch(origin+'/api/webhooks/payment/simulated',{method:'POST',body:'{}'})).status,404);
 await call('/api/connectors/test',admin.cookie,{kind:'channel'},'POST',409);
});
