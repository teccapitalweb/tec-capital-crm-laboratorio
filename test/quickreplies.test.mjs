import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validateBody,fill,VARIABLES,STARTER} from '../server/quickreplies.mjs';

test('respuestas rápidas: variables permitidas y sustitución',()=>{
  assert.deepEqual(Object.keys(VARIABLES),['nombre','nombre_completo','curso','edicion','marca','asesor']);
  assert.doesNotThrow(()=>validateBody('Hola {{nombre}}, soy {{asesor}} de {{marca}}. {{ curso }}'));
  for(const bad of ['Cuesta {{precio}}','Hola {{nombre','Hola nombre}}','{{}}','{{nombre}} {{fecha}}'])assert.throws(()=>validateBody(bad),/variables disponibles/,bad);
  assert.equal(fill('Hola {{nombre}} de {{marca}}{{edicion}}.',{nombre:'Ana',marca:'GlobalVet',edicion:''}),'Hola Ana de GlobalVet.');
});

test('respuestas rápidas por API: permisos, validación, personales y de marca, visibilidad, sustitución de variables, conflictos de revisión, archivado y reutilización del atajo',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'crm-quick-')),code=randomUUID(),password='Password-quick-2026!';let logs='';
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
  async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),one=(sql,...a)=>{const d=db();try{return d.prepare(sql).get(...a);}finally{d.close();}};
  assert.equal((await fetch(origin+'/quickreplies.js')).status,200);

  const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
  async function member(username,name,brandIds){const u=await call('/api/auth/register','',{username,name,password});const inv=await call('/api/team/invites',admin.cookie,{username,brandIds},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});return u;}
  const vende=await member('vende','Vera Vendedora',['globalvet']),otra=await member('otra','Omar Otro',['odonteck']);
  const ana=await call('/api/auth/register','',{username:'ana',name:'Ana Pérez',password}),beto=await call('/api/auth/register','',{username:'beto',name:'Beto Ruiz',password});
  const convAna=(await call('/api/conversations',ana.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
  const odonCourse=one("SELECT id FROM courses WHERE brand_id='odonteck' LIMIT 1").id,convBeto=(await call('/api/conversations',beto.cookie,{courseId:odonCourse,channel:'whatsapp'})).conversation;
  const courseTitle=one('SELECT title FROM courses WHERE id=?','aves').title;

  // permisos y estado inicial
  await call('/api/quick-replies','',undefined,'GET',401);await call('/api/quick-replies',ana.cookie,undefined,'GET',403);await call('/api/quick-replies',ana.cookie,{shortcut:'hola',title:'x',body:'x'},'POST',403);
  const empty=await call('/api/quick-replies',vende.cookie);assert.deepEqual(empty.quickReplies,[]);assert.equal(empty.canShare,false);assert.equal((await call('/api/quick-replies',admin.cookie)).canShare,true);assert.deepEqual(Object.keys(empty.variables),Object.keys(VARIABLES));

  // validación
  const base={shortcut:'gracias',title:'Agradecer',body:'Hola {{nombre}}, soy {{asesor}} de {{marca}}. Sobre {{curso}} ({{edicion}}).'};
  for(const bad of [{shortcut:'a'},{shortcut:'con espacio'},{shortcut:'x'.repeat(21)},{shortcut:'ca$h'},{title:''},{body:''},{body:'Cuesta {{precio}}'},{body:'Hola {{nombre'},{body:'x'.repeat(1501)}])await call('/api/quick-replies',vende.cookie,{...base,...bad},'POST',400);
  const created=(await call('/api/quick-replies',vende.cookie,{...base,shortcut:'/Gracias',clientRef:'respuesta-prueba-1'},'POST',201)).quickReply;
  assert.equal(created.shortcut,'gracias','se quita la barra y se pasa a minúsculas');assert.equal(created.scope,'personal');assert.equal(created.editable,true);assert.equal(created.uses,0);
  assert.equal((await call('/api/quick-replies',vende.cookie,{...base,clientRef:'respuesta-prueba-1'},'POST',201)).quickReply.id,created.id,'la misma referencia no duplica');
  await call('/api/quick-replies',otra.cookie,{...base,shortcut:'otro',clientRef:'respuesta-prueba-1'},'POST',409);
  await call('/api/quick-replies',vende.cookie,{...base,title:'Duplicada'},'POST',409);   // mismo atajo para la misma persona
  assert.equal((await call('/api/quick-replies',otra.cookie,{...base,title:'De Omar'},'POST',201)).quickReply.shortcut,'gracias','otra persona sí puede usar el mismo atajo');

  // compartidas por marca: sólo administración
  await call('/api/quick-replies',vende.cookie,{...base,scope:'brand',brandId:'globalvet',shortcut:'bienvenida'},'POST',403);
  await call('/api/quick-replies',admin.cookie,{...base,scope:'brand',brandId:'no-existe',shortcut:'bienvenida'},'POST',404);
  const shared=(await call('/api/quick-replies',admin.cookie,{scope:'brand',brandId:'globalvet',shortcut:'bienvenida',title:'Bienvenida',body:'Bienvenido a {{marca}}, {{nombre}}. Te atiende {{asesor}}.'},'POST',201)).quickReply;
  assert.equal(shared.scope,'brand');assert.equal(shared.brandName,'GlobalVet');
  await call('/api/quick-replies',admin.cookie,{scope:'brand',brandId:'globalvet',shortcut:'bienvenida',title:'Otra',body:'x'},'POST',409);

  // visibilidad por persona y marca
  const veraList=(await call('/api/quick-replies',vende.cookie)).quickReplies,omarList=(await call('/api/quick-replies',otra.cookie)).quickReplies,adminList=(await call('/api/quick-replies',admin.cookie)).quickReplies;
  assert.deepEqual(veraList.map(r=>r.shortcut).sort(),['bienvenida','gracias']);assert.equal(veraList.find(r=>r.shortcut==='bienvenida').editable,false,'la compartida no es editable para una asesora');
  assert.deepEqual(omarList.map(r=>r.shortcut),['gracias'],'Omar no ve lo personal de Vera ni lo de otra marca');assert.equal(omarList[0].title,'De Omar');
  assert.ok(adminList.some(r=>r.id===shared.id&&r.editable));assert.equal(adminList.some(r=>r.id===created.id),false,'administración no ve las respuestas personales de otras personas');

  // sustitución de variables y alcance de la conversación
  await call('/api/quick-replies/'+created.id+'/render',vende.cookie,{},'POST',400);await call('/api/quick-replies/'+created.id+'/render',vende.cookie,{conversationId:randomUUID()},'POST',404);
  const out=await call('/api/quick-replies/'+created.id+'/render',vende.cookie,{conversationId:convAna.id});
  assert.ok(out.text.startsWith('Hola Ana, soy Vera Vendedora de GlobalVet. Sobre '+courseTitle+' ('),out.text);assert.ok(!out.text.includes('{{'));
  assert.equal((await call('/api/quick-replies',vende.cookie)).quickReplies.find(r=>r.id===created.id).uses,1,'insertar cuenta un uso');
  assert.equal((await call('/api/quick-replies/'+shared.id+'/render',vende.cookie,{conversationId:convAna.id})).text,'Bienvenido a GlobalVet, Ana. Te atiende Vera Vendedora.');
  await call('/api/quick-replies/'+created.id+'/render',vende.cookie,{conversationId:convBeto.id},'POST',404);   // Vera no ve conversaciones de otra marca
  await call('/api/quick-replies/'+created.id+'/render',otra.cookie,{conversationId:convBeto.id},'POST',404);   // lo personal de Vera es sólo de Vera
  await call('/api/quick-replies/'+shared.id+'/render',admin.cookie,{conversationId:convBeto.id},'POST',409);   // una respuesta de GlobalVet no se usa en una conversación de OdonTeck
  assert.match((await call('/api/quick-replies/'+shared.id+'/render',admin.cookie,{conversationId:convAna.id})).text,/Te atiende Administración/);

  // edición con control de revisión
  await call('/api/quick-replies/'+created.id,vende.cookie,{expectedRevision:9,body:'Hola'},'PATCH',409);
  const edited=(await call('/api/quick-replies/'+created.id,vende.cookie,{expectedRevision:created.revision,body:'Gracias por escribir, {{nombre}}.',title:'Agradecer breve'},'PATCH')).quickReply;assert.equal(edited.revision,2);assert.equal(edited.body,'Gracias por escribir, {{nombre}}.');
  await call('/api/quick-replies/'+created.id,otra.cookie,{expectedRevision:2,body:'x'},'PATCH',404);   // no es suya
  await call('/api/quick-replies/'+shared.id,vende.cookie,{expectedRevision:1,body:'x'},'PATCH',403);
  const second=(await call('/api/quick-replies',vende.cookie,{shortcut:'precio-aprox',title:'Otra',body:'x {{nombre}}'},'POST',201)).quickReply;
  await call('/api/quick-replies/'+second.id,vende.cookie,{expectedRevision:1,shortcut:'gracias'},'PATCH',409);   // choca con otra suya
  assert.equal((await call('/api/quick-replies/'+shared.id,admin.cookie,{expectedRevision:1,title:'Bienvenida cálida'},'PATCH')).quickReply.title,'Bienvenida cálida');

  // archivar y reutilizar el atajo
  await call('/api/quick-replies/'+created.id,otra.cookie,undefined,'DELETE',404);await call('/api/quick-replies/'+shared.id,vende.cookie,undefined,'DELETE',403);
  assert.equal((await call('/api/quick-replies/'+created.id,vende.cookie,undefined,'DELETE')).archived,true);
  assert.equal((await call('/api/quick-replies',vende.cookie)).quickReplies.some(r=>r.id===created.id),false);
  await call('/api/quick-replies/'+created.id+'/render',vende.cookie,{conversationId:convAna.id},'POST',404);
  assert.equal((await call('/api/quick-replies',vende.cookie,{...base},'POST',201)).quickReply.shortcut,'gracias','el atajo archivado queda libre');
  assert.equal(one('PRAGMA user_version').user_version,28);assert.ok(one("SELECT count(*) n FROM audit WHERE action LIKE 'quickreply.%'").n>=6);
});

test('biblioteca de ejemplos: todos son válidos, con atajos únicos, sin precios ni fechas, y la API los entrega',async t=>{
 assert.ok(STARTER.length>=10);
 const shortcuts=new Set();
 for(const s of STARTER){
  assert.match(s.shortcut,/^[a-z0-9áéíóúüñ_-]{2,20}$/,s.shortcut);assert.ok(!shortcuts.has(s.shortcut),'atajo repetido '+s.shortcut);shortcuts.add(s.shortcut);
  assert.ok(s.title.length>0&&s.title.length<=60,s.title);assert.ok(s.body.length>=10&&s.body.length<=1500,s.shortcut);
  validateBody(s.body);                                              // sólo variables de conversación
  assert.doesNotMatch(s.body,/\$|\d|pesos|mxn|usd/i,s.shortcut+': los ejemplos no llevan precios, fechas ni números');
  assert.ok(['Saludar','Informar','Seguimiento','Pagos','Cerrar'].includes(s.group),s.group);
 }
 const dir=await mkdtemp(join(tmpdir(),'crm-qr-starter-')),code=randomUUID(),password='Password-starter-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const list=await call('/api/quick-replies',admin.cookie);assert.deepEqual(list.starter.map(s=>s.shortcut),STARTER.map(s=>s.shortcut));
 // agregar toda la biblioteca como respuestas personales: todas se aceptan; repetir un atajo da conflicto (la pantalla lo cuenta como «ya existía»)
 for(const s of STARTER)await call('/api/quick-replies',admin.cookie,{shortcut:s.shortcut,title:s.title,body:s.body,scope:'personal',clientRef:randomUUID()},'POST',201);
 await call('/api/quick-replies',admin.cookie,{shortcut:STARTER[0].shortcut,title:'Otra',body:'Hola {{nombre}}, ¿cómo estás?',scope:'personal',clientRef:randomUUID()},'POST',409);
 assert.equal((await call('/api/quick-replies',admin.cookie)).quickReplies.length,STARTER.length);
});
