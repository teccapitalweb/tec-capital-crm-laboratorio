import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function eventually(fn){let error;for(let i=0;i<60;i++){try{return await fn();}catch(e){error=e;await pause(100);}}throw error;}

test('laboratorio: siete clientes, tiempo real, permisos, automatización y persistencia',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'crm-lab-test-'));
  const adminCode=randomUUID(),agentCode=randomUUID();let processHandle,origin,port,logs='';const sockets=[];
  async function start(){
    processHandle=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,PORT:String(port||0),HOST:'127.0.0.1',NODE_ENV:'test',DATA_DIR:directory,ADMIN_INVITE_CODE:adminCode,STAFF_INVITE_CODE:agentCode,APP_ORIGIN:''},stdio:['ignore','pipe','pipe']});
    origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timed out: '+logs)),10000);processHandle.stdout.on('data',d=>{logs+=d;const m=d.toString().match(/http:\/\/127.0.0.1:(\d+)/);if(m){port=Number(m[1]);clearTimeout(timer);resolve(m[0]);}});processHandle.stderr.on('data',d=>{logs+=d;});processHandle.on('error',reject);processHandle.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+': '+logs));});});
  }
  async function stop(){if(!processHandle||processHandle.exitCode!==null)return;await new Promise(r=>{processHandle.once('exit',r);processHandle.kill();});}
  t.after(async()=>{for(const socket of sockets)socket.terminate();await stop();await rm(directory,{recursive:true,force:true});});
  await start();
  async function call(path,{cookie='',method='GET',body,expected=200,originHeader=origin}={}){
    const res=await fetch(origin+path,{method,headers:{Origin:originHeader,Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await res.json();assert.equal(res.status,expected,JSON.stringify(data));return {data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  const post=(path,cookie,body,expected=200)=>call(path,{method:'POST',cookie,body,expected});
  async function register(username,inviteCode){return post('/api/auth/register','',{username,name:'Prueba '+username,password:'Password-de-prueba-2026!',inviteCode});}
  const admin=await register('admin',adminCode),agent=await register('asesor',agentCode),agent2=await register('asesor2',agentCode);
  const clients=await Promise.all(Array.from({length:7},(_,i)=>register('cliente'+i)));
  assert.equal(new Set(clients.map(c=>c.data.user.testNumber)).size,7);
  assert.ok(clients.every(c=>c.data.user.role==='customer'));
  const adminSocket=new WebSocket(origin.replace('http','ws')+'/realtime',{headers:{Cookie:admin.cookie,Origin:origin}});sockets.push(adminSocket);
  const events=[];adminSocket.on('message',d=>events.push(JSON.parse(d)));
  await new Promise((resolve,reject)=>{adminSocket.once('open',resolve);adminSocket.once('error',reject);});
  const customerSockets=await Promise.all(clients.map(async c=>{const ws=new WebSocket(origin.replace('http','ws')+'/realtime',{headers:{Cookie:c.cookie,Origin:origin}});sockets.push(ws);c.events=[];ws.on('message',d=>c.events.push(JSON.parse(d)));await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});return ws;}));
  const convs=await Promise.all(clients.map((c,i)=>post('/api/conversations',c.cookie,{courseId:'aves',channel:['whatsapp','instagram','facebook'][i%3]}).then(r=>r.data.conversation)));
  const first=convs[0],cookie=clients[0].cookie;
  const messages=(id,session=cookie)=>call(`/api/conversations/${id}/messages`,{cookie:session}).then(r=>r.data.messages);
  const send=(id,session,text,extra={})=>post(`/api/conversations/${id}/messages`,session,{text,clientRef:randomUUID(),...extra},201);

  await t.test('catálogo con dos flyers fotográficos distintos por marca',async()=>{
    const bootstrap=await call('/api/bootstrap',{cookie});const courses=bootstrap.data.courses;
    assert.equal(courses.length,6);const signatures=new Set();
    for(const brand of bootstrap.data.brands)assert.equal(courses.filter(c=>c.brand_id===brand.id).length,2);
    for(const course of courses){
      assert.equal(course.hasArtwork,true);
      const response=await fetch(origin+`/api/courses/${course.id}/flyer`,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
      const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length>50000);assert.equal(bytes.subarray(1,4).toString(),'PNG');signatures.add(bytes.subarray(-2048).toString('base64'));
    }
    assert.equal(signatures.size,6);
    assert.equal((await fetch(origin+'/api/courses/aves/flyer')).status,401);
  });

  await t.test('mensajes simultáneos llegan a siete clientes y al equipo sin recargar',async()=>{
    await Promise.all(convs.map((c,i)=>send(c.id,clients[i].cookie,'Hola, quiero información')));
    await eventually(async()=>{for(const c of convs){assert.ok(events.some(e=>e.type==='conversation'&&e.conversationId===c.id));const m=await messages(c.id,admin.cookie);assert.equal(m.length,2);assert.equal(m[1].sender_kind,'automation');assert.equal(m[1].flyer_course_id,'aves');}});
    for(let i=0;i<7;i++){assert.ok(clients[i].events.some(e=>e.conversationId===convs[i].id));assert.ok(!clients[i].events.some(e=>e.conversationId&&e.conversationId!==convs[i].id));}
    customerSockets[0].send(JSON.stringify({type:'typing',conversationId:first.id}));await eventually(()=>assert.ok(events.some(e=>e.type==='typing'&&e.conversationId===first.id)));
  });
  await t.test('clientes aislados; roles y origen se validan en el servidor',async()=>{
    const own=await call('/api/conversations',{cookie});assert.equal(own.data.conversations.length,1);
    await call(`/api/conversations/${first.id}/messages`,{cookie:clients[1].cookie,expected:404});
    await post(`/api/conversations/${first.id}/messages`,cookie,{text:'Intento de asesor',clientRef:randomUUID(),asAgent:true},403);
    await post(`/api/conversations/${first.id}/read`,cookie,{upTo:999,asAgent:true},403);
    await post('/api/brands',cookie,{name:'Inválida'},403);
    await call('/api/metrics',{cookie,expected:403});
    await call('/api/conversations',{method:'POST',cookie,body:{courseId:'aves',channel:'whatsapp'},originHeader:'https://otro.example',expected:403});
    await call('/api/bootstrap',{expected:401});
    await post('/api/auth/register','',{username:'sinpermiso',name:'No admin',password:'Password-de-prueba!',inviteCode:'incorrecto'},400);
  });
  await t.test('los datos recientes actualizan respuestas y mantienen flyers históricos',async()=>{
    const old=(await messages(first.id)).find(m=>m.flyer_course_id);const original=await fetch(origin+old.attachmentUrl,{headers:{Cookie:cookie}});assert.equal(original.headers.get('content-type'),'image/png');const oldArtwork=Buffer.from(await original.arrayBuffer());
    const b=await call('/api/bootstrap',{cookie:admin.cookie});const course=b.data.courses.find(c=>c.id==='aves');
    await post('/api/catalog',admin.cookie,{id:course.id,brandId:course.brand_id,title:course.title,price:421,dateLabel:'Noviembre de prueba',syllabus:'Temario actualizado',welcome:'Hola {{nombre}}, este es {{curso}}.'});
    await send(first.id,cookie,'Precio');await eventually(async()=>assert.ok((await messages(first.id)).some(m=>m.sender_kind==='automation'&&m.text.includes('421.00'))));
    const oldAgain=Buffer.from(await fetch(origin+old.attachmentUrl,{headers:{Cookie:cookie}}).then(r=>r.arrayBuffer()));assert.deepEqual(oldAgain,oldArtwork);
    const current=await fetch(origin+'/api/courses/aves/flyer',{headers:{Cookie:cookie}}).then(r=>r.text());assert.match(current,/>\$421 MXN</);
    const unauthorized=await fetch(origin+old.attachmentUrl,{headers:{Cookie:clients[1].cookie}});assert.equal(unauthorized.status,404);
  });
  await t.test('adjuntos, idempotencia concurrente y confirmación de lectura',async()=>{
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRbcAAAAASUVORK5CYII=';
    const payload={text:'Imagen de prueba',clientRef:randomUUID(),attachment:{name:'prueba.png',type:'image/png',base64:png}};
    const responses=await Promise.all([0,1].map(()=>fetch(origin+`/api/conversations/${first.id}/messages`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(payload)})));
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
    const m=(await messages(first.id)).filter(m=>m.text==='Imagen de prueba');assert.equal(m.length,1);
    const file=await fetch(origin+m[0].attachmentUrl,{headers:{Cookie:cookie}});assert.equal(file.status,200);assert.equal(file.headers.get('content-type'),'image/png');
    assert.equal((await fetch(origin+m[0].attachmentUrl,{headers:{Cookie:clients[1].cookie}})).status,404);
    await post(`/api/conversations/${first.id}/read`,agent.cookie,{upTo:m[0].seq,asAgent:true});assert.ok((await messages(first.id)).find(x=>x.id===m[0].id).read_at);
    await post(`/api/conversations/${first.id}/messages`,cookie,{...payload,clientRef:randomUUID(),attachment:{name:'bad.png',type:'image/png',base64:'bm90LWEtcG5n'}},400);
  });
  await t.test('traspaso humano cancela el bot y evita dos asesores simultáneos',async()=>{
    await send(first.id,cookie,'Asesor por favor');await eventually(async()=>{const r=await call('/api/conversations',{cookie});assert.equal(r.data.conversations[0].status,'waiting');});
    await post(`/api/conversations/${first.id}/action`,agent.cookie,{action:'take'});
    await post(`/api/conversations/${first.id}/action`,agent2.cookie,{action:'take'},409);
    const before=(await messages(first.id)).filter(m=>m.sender_kind==='automation').length;
    await send(first.id,cookie,'Precio por favor');await pause(1200);assert.equal((await messages(first.id)).filter(m=>m.sender_kind==='automation').length,before);
    await send(first.id,agent.cookie,'Hola, soy tu asesor',{asAgent:true});
    await post(`/api/conversations/${first.id}/template`,agent.cookie,{kind:'flyer',clientRef:randomUUID()});
    const m=await messages(first.id);assert.equal(m.at(-1).sender_kind,'agent');assert.equal(m.at(-1).flyer_course_id,'aves');
    await post(`/api/conversations/${first.id}/read`,cookie,{upTo:m.at(-1).seq});assert.ok((await messages(first.id)).at(-1).read_at);
    await post(`/api/conversations/${first.id}/action`,agent.cookie,{action:'resolve'});
    await post(`/api/conversations/${first.id}/messages`,cookie,{text:'cerrado',clientRef:randomUUID()},409);
  });
  await t.test('sesiones, mensajes y perfiles sobreviven al reinicio',async()=>{
    const before=await messages(first.id);for(const ws of sockets)ws.terminate();await stop();await start();
    const after=await messages(first.id);assert.deepEqual(after,before);
    const state=await call('/api/bootstrap',{cookie});assert.equal(state.data.user.testNumber,clients[0].data.user.testNumber);
    await post('/api/auth/logout',cookie,{});await call('/api/bootstrap',{cookie,expected:401});
    const login=await post('/api/auth/login','',{username:'cliente0',password:'Password-de-prueba-2026!'});assert.equal(login.data.user.id,clients[0].data.user.id);
  });
});
