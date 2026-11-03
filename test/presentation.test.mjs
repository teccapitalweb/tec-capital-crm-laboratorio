import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseRates,DEFAULT_RATES} from '../server/presentation.mjs';

test('tarifas estimadas por mensaje: valores por omisión y lectura tolerante de MESSAGE_RATES',()=>{
  assert.deepEqual(parseRates(undefined),DEFAULT_RATES);
  assert.deepEqual(parseRates('marketing=1.5, utility=0.2'),{marketing:1.5,utility:0.2,service:0});
  assert.deepEqual(parseRates('marketing=abc,servicio=3,service=-1,utility=0'),{...DEFAULT_RATES,utility:0});
});

test('modo presentación por API: cifras del laboratorio, guion con comprobaciones, alcance por marca y permisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-presentation-')),code=randomUUID(),password='Password-presentation-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',MESSAGE_RATES:'marketing=1,utility=0.5,service=0'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),msgs=id=>'/api/conversations/'+id+'/messages';
 async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),client=await call('/api/auth/register','',{username:'cliente',name:'Cliente',password});
 for(const f of ['/presentation.js']){const r=await fetch(origin+f);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/javascript/);}

 // vacío: sin conversaciones, guion con pasos siempre listos y pasos por preparar
 const empty=await call('/api/presentation',admin.cookie);
 assert.equal(empty.totals.conversations,0);assert.equal(empty.totals.autoRate,null);assert.equal(empty.script.length,12);assert.equal(empty.script.find(s=>s.id==='certificado').ready,false);assert.equal(empty.script.find(s=>s.id==='coordinacion').ready,false);
 assert.equal(empty.script.find(s=>s.id==='cliente').ready,true);assert.equal(empty.script.find(s=>s.id==='conocimiento').ready,true);assert.equal(empty.script.find(s=>s.id==='venta').ready,false);assert.equal(empty.script.find(s=>s.id==='pagos').ready,false);
 await call('/api/presentation',client.cookie,undefined,'GET',403);await call('/api/presentation','',undefined,'GET',401);
 await call('/api/presentation?days=0',admin.cookie,undefined,'GET',400);await call('/api/presentation?brand=no-existe',admin.cookie,undefined,'GET',404);

 // una conversación atendida por el bot, otra con venta cerrada por el equipo
 const c1=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 await call(msgs(c1.id),client.cookie,{text:'Hola, ¿cuánto cuesta?',clientRef:randomUUID()},'POST',201);
 assert.ok(await until(async()=>(await call(msgs(c1.id),client.cookie)).messages.find(m=>m.sender_kind==='automation')));
 await call('/api/payments/brands/odonteck',admin.cookie,{enabled:true,expectedRevision:0},'PATCH');
 const c2=(await call('/api/conversations',client.cookie,{courseId:'odontologia',channel:'instagram'})).conversation;
 await call(msgs(c2.id),client.cookie,{text:'Hola',clientRef:randomUUID()},'POST',201);
 assert.ok(await until(async()=>(await call(msgs(c2.id),client.cookie)).messages.find(m=>m.sender_kind==='automation')));
 const order=(await call('/api/conversations/'+c2.id+'/orders',admin.cookie,{},'POST',201)).order;
 await call('/api/payments/orders/'+order.id+'/pay',client.cookie,{method:'card'});

 const d=await call('/api/presentation?days=7',admin.cookie);
 assert.equal(d.totals.conversations,2);assert.equal(d.totals.withOutbound,2);assert.equal(d.totals.autoHandled,1);assert.equal(d.totals.humanHandled,1);assert.equal(d.totals.autoRate,50);
 assert.ok(d.response.bot.count>=2&&d.response.bot.medianMs>0&&d.response.bot.medianMs<10000);
 assert.equal(d.sales.paid,1);assert.equal(d.sales.amountCents,49900);assert.equal(d.sales.byMethod.card,1);assert.equal(d.sales.bySource.agent,1);assert.equal(d.sales.enrollments,1);assert.equal(d.sales.conversion,50);
 const utility=d.messages.byCategory.find(c=>c.category==='utility'),service=d.messages.byCategory.find(c=>c.category==='service');
 assert.equal(service.messages,2,'las dos respuestas automáticas a entrantes son servicio');assert.equal(utility.messages,2,'enlace de pago y confirmación de pago son utilidad');assert.equal(utility.rate,0.5);assert.equal(d.messages.costEstimate,1);assert.equal(d.messages.rates.marketing,1);
 assert.equal(d.replies.byAction.replied>=2,true);assert.ok(d.replies.topIntents.some(i=>i.intent==='price'));assert.equal(d.replies.knowledgeApproved,18);
 assert.deepEqual(d.byBrand.map(b=>b.id),['odonteck','globalvet']);assert.equal(d.byBrand[0].paid,1);assert.equal(d.byBrand[1].autoRate,100);
 const step=id=>d.script.find(s=>s.id===id);
 assert.equal(step('bienvenida').ready,true);assert.equal(step('venta').ready,true);assert.equal(step('pagos').ready,true);assert.equal(step('demo').ready,false);assert.equal(step('canal').ready,false);assert.equal(step('recetas').ready,false);
 assert.equal(d.readySteps,7);
 // alcance por marca
 const g=await call('/api/presentation?brand=globalvet',admin.cookie);assert.equal(g.totals.conversations,1);assert.equal(g.sales.paid,0);assert.equal(g.script.find(s=>s.id==='venta').ready,false);
 assert.equal(logs.includes('failed'),false,logs);
});
