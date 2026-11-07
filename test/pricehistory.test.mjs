import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {lowSeatsThreshold,publishSeatChange,publishPriceChange} from '../server/catalogue-events.mjs';

test('umbral de «quedan pocos» y reglas de los eventos de cupo y precio (sin servidor)',()=>{
 assert.equal(lowSeatsThreshold(10),2);assert.equal(lowSeatsThreshold(2),1);assert.equal(lowSeatsThreshold(40),8);assert.equal(lowSeatsThreshold(null),0);
 const sent=[],events={publish:e=>{sent.push(e);return {seq:sent.length};}},ed={id:'e1',brand_id:'b',course_id:'c',name:'Edición',capacity:10,currency:'MXN'};
 const seat=(a,b)=>{sent.length=0;publishSeatChange(events,ed,a,b,{reason:'inscripcion',source:'t',dedupeKey:'k'+a+b});return sent.map(e=>e.type);};
 assert.deepEqual(seat(5,5),[],'sin cambio no se publica nada');assert.deepEqual(seat(null,5),[],'sin cupo informado antes no se publica nada');
 assert.deepEqual(seat(4,3),['edicion.cupo_cambiado'],'3 de 10 todavía no es «pocos»');
 assert.deepEqual(seat(3,2),['edicion.cupo_cambiado','edicion.cupo_bajo'],'cruzar el 20 % avisa una sola vez');
 assert.deepEqual(seat(2,1),['edicion.cupo_cambiado'],'ya estaba bajo: no se repite el aviso');
 assert.deepEqual(seat(1,0),['edicion.cupo_cambiado','edicion.cupo_agotado']);
 assert.deepEqual(seat(0,1),['edicion.cupo_cambiado','edicion.cupo_liberado']);
 const price=(a,b)=>{sent.length=0;publishPriceChange(events,{...ed,price_cents:a,session_price_cents:null},{...ed,price_cents:b,session_price_cents:null},{source:'t',dedupeKey:'p'+a+b});return sent;};
 assert.equal(price(1000,1000).length,0);
 const up=price(100000,110000)[0];assert.equal(up.type,'catalogo.precio_cambiado');assert.equal(up.payload.direction,'subio');assert.equal(up.payload.deltaPct,10);assert.equal(up.payload.deltaCents,10000);
 assert.equal(price(100000,90000)[0].payload.direction,'bajo');
});

test('historial de precio y cupo: eventos al cambiar el precio, al inscribir y dar de baja, línea de tiempo y avisos al equipo',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-pricehist-')),code=randomUUID(),password='Password-pricehist-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const evs=type=>call('/api/events?brand=all&entity=edition&type='+type,admin.cookie).then(r=>r.events);

 // una edición nueva con 3 lugares: crearla no es un cambio de precio ni de cupo
 const day=86400000,base={courseId:'aves',name:'Edición con historial',startsAt:Date.now()+30*day,endsAt:Date.now()+30*day+7200000,timezone:'America/Mexico_City',instructor:'Docente',modality:'online',location:'Aula',capacity:3,availableSeats:3,infoUrl:'https://example.com/curso',price:1000,currency:'MXN',status:'published'};
 let ed=(await call('/api/catalogue/editions',admin.cookie,base,'POST',201)).item;
 assert.equal((await evs('catalogo.precio_cambiado')).length,0);

 // el precio sube, luego baja; guardar sin tocar el precio no publica nada
 ed=(await call('/api/catalogue/editions/'+ed.id,admin.cookie,{...base,price:1100,expectedRevision:ed.revision},'PATCH')).item;
 ed=(await call('/api/catalogue/editions/'+ed.id,admin.cookie,{...base,price:1100,instructor:'Otro docente',expectedRevision:ed.revision},'PATCH')).item;
 ed=(await call('/api/catalogue/editions/'+ed.id,admin.cookie,{...base,price:900,expectedRevision:ed.revision},'PATCH')).item;
 const prices=(await evs('catalogo.precio_cambiado')).sort((a,b)=>a.seq-b.seq);
 assert.equal(prices.length,2,'sólo los dos cambios reales de precio');
 assert.deepEqual([prices[0].payload.direction,prices[0].payload.from,prices[0].payload.to,prices[0].payload.deltaPct],['subio',100000,110000,10]);
 assert.deepEqual([prices[1].payload.direction,prices[1].payload.from,prices[1].payload.to],['bajo',110000,90000]);

 // línea de tiempo: precio y estado salen de las versiones guardadas, en orden de más reciente a más antiguo
 const tl=await call('/api/catalogue/edition/'+ed.id+'/timeline',admin.cookie);
 assert.equal(tl.edition.priceCents,90000);assert.equal(tl.edition.availableSeats,3);
 assert.deepEqual(tl.timeline.map(x=>x.kind).filter(k=>k.startsWith('precio')||k==='creada'),['precio_bajo','precio_subio','creada']);
 await call('/api/catalogue/edition/'+ed.id+'/timeline','',undefined,'GET',401);
 const cust=await call('/api/auth/register','',{username:'cliente0',name:'Cliente Cero',password});await call('/api/catalogue/edition/'+ed.id+'/timeline',cust.cookie,undefined,'GET',403);

 // inscripciones con pago simulado: 3 → 2 → 1 (quedan pocos: 20 % de 3 es 1) → 0 (se agotó)
 await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,linkHours:48,expectedRevision:0},'PATCH');
 async function enroll(n){
  const u=await call('/api/auth/register','',{username:'alumno'+n,name:'Alumno '+n,password});
  const conv=(await call('/api/conversations',u.cookie,{courseId:'aves',editionId:ed.id,channel:'whatsapp'})).conversation;
  const made=await call('/api/conversations/'+conv.id+'/orders',admin.cookie,{},'POST',201);
  await call('/api/payments/orders/'+made.order.id+'/pay',u.cookie,{method:'card'});return made.order;
 }
 await enroll(1);await enroll(2);
 let seats=(await evs('edicion.cupo_cambiado')).sort((a,b)=>a.seq-b.seq);
 assert.deepEqual(seats.map(e=>[e.payload.from,e.payload.to,e.payload.reason]),[[3,2,'inscripcion'],[2,1,'inscripcion']]);
 assert.equal((await evs('edicion.cupo_bajo')).length,1,'«quedan pocos» al cruzar el 20 %: 2 de 3 todavía no, 1 de 3 sí');
 assert.equal((await evs('edicion.cupo_agotado')).length,0);
 await enroll(3);
 assert.equal((await evs('edicion.cupo_agotado')).length,1);
 assert.equal((await call('/api/catalogue/edition/'+ed.id+'/timeline',admin.cookie)).edition.availableSeats,0);

 // la baja de una inscripción libera un lugar
 const detail=await call('/api/coordination/editions/'+ed.id,admin.cookie);
 await call('/api/coordination/enrollments/'+detail.enrollments[0].id+'/cancel',admin.cookie,{reason:'Cambió de ciudad'});
 const freed=await evs('edicion.cupo_liberado');assert.equal(freed.length,1);assert.deepEqual([freed[0].payload.available,freed[0].payload.reason],[1,'baja']);
 const kinds=(await call('/api/catalogue/edition/'+ed.id+'/timeline',admin.cookie)).timeline.map(x=>x.kind);
 for(const k of ['cupo','cupo_bajo','cupo_agotado','cupo_liberado'])assert.ok(kinds.includes(k),'la línea de tiempo trae '+k);

 // avisos al equipo en «Mis avisos» (los entrega el índice de eventos fuera de la transacción)
 const notes=await until(async()=>{const r=await call('/api/operations/notifications',admin.cookie);return r.items.filter(n=>n.kind==='catalogue').length>=5?r.items:null;});
 assert.ok(notes,'llegan los avisos de catálogo');
 const titles=notes.filter(n=>n.kind==='catalogue').map(n=>n.title).join('\n');
 assert.match(titles,/El precio subió/);assert.match(titles,/El precio bajó/);assert.match(titles,/Quedan pocos lugares/);assert.match(titles,/Se agotó el cupo/);assert.match(titles,/Se liberó un lugar/);
 assert.ok(notes.every(n=>n.conversation_id===null||n.kind!=='catalogue'),'los avisos de catálogo no cuelgan de una conversación');
});
