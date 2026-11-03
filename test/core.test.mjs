import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {signCore,verifyCore,CORE_VERSION,SUBSCRIBER,UPSERT_ORDER} from '../server/core.mjs';

test('firma del núcleo: HMAC sobre «timestamp.cuerpo», comparación constante y tolerancia de 5 minutos',()=>{
  const secret='s3creto',raw='{"a":1}',ts=String(Date.now()),sig=signCore(secret,ts,raw);
  assert.match(sig,/^[a-f0-9]{64}$/);assert.equal(CORE_VERSION,'1');assert.equal(SUBSCRIBER,'core.outbox');assert.equal(UPSERT_ORDER[0],'consultoras');assert.equal(UPSERT_ORDER.at(-1),'certificados');
  assert.equal(verifyCore(secret,{'x-nucleo-timestamp':ts,'x-nucleo-signature':sig},raw),true);
  assert.equal(verifyCore(secret,{'x-nucleo-timestamp':ts,'x-nucleo-signature':sig},raw+' '),false,'otro cuerpo');
  assert.equal(verifyCore('otro',{'x-nucleo-timestamp':ts,'x-nucleo-signature':sig},raw),false,'otro secreto');
  assert.equal(verifyCore('',{'x-nucleo-timestamp':ts,'x-nucleo-signature':sig},raw),false,'sin secreto nunca es válido');
  const old=String(Date.now()-6*60000);assert.equal(verifyCore(secret,{'x-nucleo-timestamp':old,'x-nucleo-signature':signCore(secret,old,raw)},raw),false,'marca de tiempo vieja');
});

test('esquema del núcleo: tablas y orden de upsert documentados',async()=>{
  const sql=await readFile(new URL('../nucleo/esquema-v1.sql',import.meta.url),'utf8');
  for(const t of ['consultoras','personas','identidades','cursos','ediciones','sesiones','pagos','inscripciones','certificados','eventos'])assert.match(sql,new RegExp('create table if not exists nucleo\\.'+t+' '),t);
  assert.match(sql,/unique \(origen, origen_seq\)/);assert.match(sql,/unique \(folio\)/);
});

async function boot(extraEnv){
  const dir=await mkdtemp(join(tmpdir(),'crm-core-')),code=randomUUID();let logs='';
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',CORE_SINK_URL:'',CORE_SINK_SECRET:'',...extraEnv},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  return {dir,code,server,origin,stop:async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});}};
}
const caller=origin=>async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,tries=60){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
const password='Password-core-2026!';

test('outbox hacia el núcleo con receptor local: sobres firmados con registros proyectados, reintento ante 5xx, fallo permanente ante 4xx, reintento masivo, reproducción del historial idempotente, ping y permisos',async t=>{
  // receptor mínimo de referencia: verifica firma, guarda por (origen, origen_seq) y simula fallos a demanda
  const secret='nucleo-secreto-de-prueba',received=new Map(),log=[];let failNext=0,status4xx=0;
  const sink=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    const ok=verifyCore(secret,req.headers,raw);const sobre=JSON.parse(raw||'{}');log.push({ok,tipo:sobre.tipo,seq:sobre.origen_seq,version:req.headers['x-nucleo-version']});
    if(!ok){res.writeHead(401);res.end('firma');return;}
    if(status4xx){status4xx--;res.writeHead(422);res.end('rechazado');return;}
    if(failNext){failNext--;res.writeHead(503);res.end('caído');return;}
    const key=sobre.origen+':'+sobre.origen_seq;if(sobre.tipo!=='nucleo.ping'){if(received.has(key))received.get(key).repeats++;else received.set(key,{sobre,repeats:0});}
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');});});
  await new Promise(r=>sink.listen(0,'127.0.0.1',r));const sinkUrl='http://127.0.0.1:'+sink.address().port+'/nucleo/eventos';
  const app=await boot({CORE_SINK_URL:sinkUrl,CORE_SINK_SECRET:secret});t.after(async()=>{await app.stop();sink.close();});
  const call=caller(app.origin);
  const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:app.code});
  const agent=await call('/api/auth/register','',{username:'asesor',name:'Asesora',password});
  const inv=await call('/api/team/invites',admin.cookie,{username:'asesor',brandIds:['globalvet']},'POST',201);await call('/api/team/accept',agent.cookie,{token:inv.token});
  const client=await call('/api/auth/register','',{username:'alumna',name:'Alumna Prueba',password});

  // permisos y estado
  await call('/api/core',client.cookie,undefined,'GET',403);await call('/api/core',agent.cookie,undefined,'GET',403);
  const st0=await call('/api/core',admin.cookie);assert.equal(st0.mode,'http');assert.equal(st0.secretSet,true);assert.match(st0.sinkHost,/^127\.0\.0\.1:\d+\/nucleo\/eventos$/);assert.equal(st0.subscriber,'core.outbox');
  const ty=await call('/api/events/types',admin.cookie);assert.ok(ty.types.every(x=>x.subscribers.includes('core.outbox')),'el outbox está suscrito a todos los tipos');

  // un pago completo: pedido, pago confirmado, inscripción
  await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:0},'PATCH');
  const conv=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
  const o=(await call('/api/conversations/'+conv.id+'/orders',admin.cookie,{},'POST',201)).order;
  assert.equal((await call('/api/payments/orders/'+o.id+'/pay',client.cookie,{method:'card'})).order.status,'paid');
  const got=await until(async()=>[...received.values()].find(r=>r.sobre.tipo==='pago.confirmado'));
  assert.ok(got,'el pago confirmado llegó al receptor');const s=got.sobre;
  assert.equal(s.version,'1');assert.equal(s.origen,'crm');assert.equal(s.consultora,'globalvet');assert.equal(s.entidad.tipo,'order');assert.equal(s.carga.reference,o.reference);
  assert.equal(s.registros.consultoras[0].clave,'globalvet');assert.equal(s.registros.pagos[0].estado,'paid');assert.equal(s.registros.pagos[0].importe_centavos,o.amount_cents);assert.equal(s.registros.pagos[0].metodo,'card');
  assert.equal(s.registros.personas[0].nombre,'Alumna Prueba');assert.ok(s.registros.personas[0].origen_id.length>10);assert.equal(s.registros.personas[0].contactos[0].consultora,'globalvet');
  assert.equal(s.registros.inscripciones.length,1);assert.equal(s.registros.inscripciones[0].estado,'enrolled');assert.equal(s.registros.inscripciones[0].pago,o.id);
  assert.equal(s.registros.ediciones[0].origen_id,'edition-aves');assert.equal(s.registros.cursos[0].origen_id,'aves');assert.equal(typeof s.registros.ediciones[0].precio_centavos,'number');
  assert.ok(log.every(l=>l.ok&&l.version==='1'),'todas las peticiones llegaron firmadas');
  assert.ok(await until(async()=>(await call('/api/core',admin.cookie)).stats.pending===0),'todo entregado');
  const st1=await call('/api/core',admin.cookie);assert.equal(st1.stats.failed,0);assert.ok(st1.stats.done>=5);assert.equal(st1.stats.missing,0);assert.equal(st1.recent[0].modo,'http');assert.equal(st1.recent[0].estado,200);
  const types=new Set([...received.values()].map(r=>r.sobre.tipo));for(const x of ['conversacion.abierta','pedido.creado','pago.confirmado','inscripcion.activada'])assert.ok(types.has(x),x);
  assert.ok(![...received.values()].some(r=>JSON.stringify(r.sobre).includes('Pedido de práctica')),'no viaja texto de mensajes');

  // reintento ante 5xx: la siguiente entrega falla una vez y se completa sola (espera base de 5 s)
  failNext=1;const before=received.size;
  await call('/api/conversations/'+conv.id+'/messages',client.cookie,{text:'Gracias por todo',clientRef:randomUUID()},'POST',201);
  const conv2=(await call('/api/conversations',client.cookie,{courseId:'nutricion',channel:'instagram'})).conversation;void conv2;
  assert.ok(await until(async()=>received.size>before&&(await call('/api/core',admin.cookie)).stats.pending===0,80),'la entrega rechazada con 503 se reintentó y terminó');
  assert.equal((await call('/api/core',admin.cookie)).stats.failed,0);

  // fallo permanente ante 4xx y reintento masivo
  status4xx=1;const conv3=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'facebook'})).conversation;void conv3;
  assert.ok(await until(async()=>(await call('/api/core',admin.cookie)).stats.failed===1),'un 422 deja la entrega como fallida sin reintentos');
  assert.match((await call('/api/core',admin.cookie)).stats.lastError,/HTTP 422/);
  const retried=await call('/api/core/retry',admin.cookie,{});assert.equal(retried.queued,1);
  assert.ok(await until(async()=>{const x=(await call('/api/core',admin.cookie)).stats;return x.failed===0&&x.pending===0;}),'el reintento masivo entrega lo fallido');

  // reproducción del historial: nada que crear (todo tiene entrega); tras borrar entregas, reproduce e idempotente en el receptor
  assert.equal((await call('/api/core/replay',admin.cookie,{})).queued,0);
  const d=new DatabaseSync(join(app.dir,'laboratorio.sqlite'),{timeout:5000});const total=d.prepare('SELECT count(*) n FROM domain_events').get().n;d.prepare("DELETE FROM domain_deliveries WHERE subscriber='core.outbox'").run();d.close();
  assert.equal((await call('/api/core',admin.cookie)).stats.missing,total);
  const rep=await call('/api/core/replay',admin.cookie,{fromSeq:1});assert.equal(rep.queued,total);
  assert.ok(await until(async()=>(await call('/api/core',admin.cookie)).stats.pending===0,80),'historial reproducido');
  assert.ok([...received.values()].every(r=>r.repeats>=1),'cada evento llegó otra vez con la misma clave (el receptor lo reconoce repetido)');

  // ping
  const ping=await call('/api/core/ping',admin.cookie,{});assert.equal(ping.ok,true);assert.equal(ping.status,200);assert.ok(log.some(l=>l.tipo==='nucleo.ping'));
  await call('/api/core/ping',agent.cookie,{},'POST',403);
});

test('sin CORE_SINK_URL el outbox es simulado: nada sale, los sobres recientes se ven y el ping se rechaza',async t=>{
  const app=await boot({});t.after(()=>app.stop());const call=caller(app.origin);
  const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:app.code});
  const client=await call('/api/auth/register','',{username:'cliente',name:'Cliente Prueba',password});
  await call('/api/conversations',client.cookie,{courseId:'aves',channel:'whatsapp'});
  assert.ok(await until(async()=>(await call('/api/core',admin.cookie)).recent.length>=1));
  const st=await call('/api/core',admin.cookie);assert.equal(st.mode,'simulated');assert.equal(st.sinkHost,null);assert.equal(st.recent[0].modo,'simulado');const opened=st.recent.find(r=>r.tipo==='conversacion.abierta');assert.ok(opened);assert.equal(opened.registros.consultoras,1);assert.equal(opened.registros.cursos,1);assert.equal(st.stats.failed,0);
  await call('/api/core/ping',admin.cookie,{},'POST',409);
  const recent=await call('/api/core/recent',admin.cookie);assert.ok(recent.recent.length>=1);assert.ok(!('sobre' in st.recent[0]),'el estado no vuelca el sobre completo');
});
