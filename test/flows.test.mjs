import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {cleanSteps,render,norm,DEFAULT_STEPS,ACTIONS} from '../server/flows.mjs';
import {metaChannel} from '../server/connectors.mjs';

test('flujo de bienvenida: validación de los pasos, datos por su nombre y comparación de botones',()=>{
  assert.deepEqual(cleanSteps(DEFAULT_STEPS),DEFAULT_STEPS,'el flujo sugerido es válido tal cual');
  const step=(over={})=>({id:'a',text:'Hola',buttons:[],...over});
  assert.throws(()=>cleanSteps([]),/al menos un paso/);assert.throws(()=>cleanSteps(Array.from({length:11},(_,i)=>step({id:'p'+i}))),/hasta 10 pasos/);
  assert.throws(()=>cleanSteps([step({text:'  '})]),/Escribe el mensaje del paso 1/);assert.throws(()=>cleanSteps([step({id:'Paso 1'})]),/identificador/);assert.throws(()=>cleanSteps([step(),step()]),/identificador/);
  assert.throws(()=>cleanSteps([step({text:'Hola {{telefono}}'})]),/dato que no existe/);
  assert.throws(()=>cleanSteps([step({buttons:[{label:'Uno',go:'action:price'},{label:'Dos',go:'action:price'},{label:'Tres',go:'action:price'},{label:'Cuatro',go:'action:price'}]})]),/hasta 3 botones/);
  assert.throws(()=>cleanSteps([step({buttons:[{label:'Un botón con demasiado texto',go:'action:price'}]})]),/demasiado largo/);
  assert.throws(()=>cleanSteps([step({buttons:[{label:'Precio',go:'action:price'},{label:'PRECIO',go:'action:syllabus'}]})]),/mismo texto/);
  assert.throws(()=>cleanSteps([step({buttons:[{label:'Ir',go:'step:nadie'}]})]),/a dónde lleva/);assert.throws(()=>cleanSteps([step({buttons:[{label:'Ir',go:'action:borrar'}]})]),/a dónde lleva/);assert.throws(()=>cleanSteps([step({buttons:[{label:'¿?',go:'action:price'}]})]),/letra o un número/);
  assert.equal(render('¡Hola, {{nombre}}! Soy de {{marca}}: {{curso}} ({{edición}}).',{name:'Ana',course:'Aves',edition:'Enero',brand:'GlobalVet'}),'¡Hola, Ana! Soy de GlobalVet: Aves (Enero).');
  assert.equal(render('¡Hola, {{nombre}}! ¿Qué te gustaría saber?',{}),'¡Hola! ¿Qué te gustaría saber?','sin nombre no queda una coma suelta');
  assert.equal(norm('  ¡Más OPCIONES! '),'mas opciones');assert.equal(norm('Fechas y horario'),norm('fechas   y  horario.'));
  assert.deepEqual(Object.keys(ACTIONS),['price','syllabus','schedule','enroll','human']);
});

test('WhatsApp real: un saludo con ficha y botones sale como imagen y, aparte, el mensaje con sus botones',async()=>{
  const calls=[],meta=metaChannel({env:{META_ACCESS_TOKEN:'EAAprueba0000000000000000000000token',META_APP_SECRET:'s',META_VERIFY_TOKEN:'v',META_PHONE_NUMBER_ID:'109000000000001'},fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return {ok:true,status:200,json:async()=>String(url).endsWith('/media')?{id:'m1'}:{messages:[{id:'wamid.'+calls.length}]}};}});
  await meta.send({to:'5215512345678',text:'¡Hola, María! ¿Qué te gustaría saber?',buttons:['Precio','Temario','Más opciones'],media:{buffer:Buffer.from([137,80,78,71]),mime:'image/png',filename:'ficha.png'}});
  const parts=calls.slice(1).map(c=>JSON.parse(c.init.body));assert.deepEqual(parts.map(p=>p.type),['image','interactive']);assert.deepEqual(parts[0].image,{id:'m1'});
  assert.equal(parts[1].interactive.body.text,'¡Hola, María! ¿Qué te gustaría saber?');assert.deepEqual(parts[1].interactive.action.buttons.map(b=>b.reply.title),['Precio','Temario','Más opciones']);
});

test('flujo de bienvenida de punta a punta: saludo con menú, botones que navegan o responden, texto libre al asistente de siempre, y apagado por omisión',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'crm-flows-')),code=randomUUID(),password='Password-flujos-2026!';let logs='',db=null;
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',AI_PROVIDER:'',CHANNEL_CONNECTOR:''},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{try{db?.close();}catch{}if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
  async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
  db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});assert.equal(db.prepare('PRAGMA user_version').get().user_version,40);
  // cada persona: perfil nuevo, conversación del curso de aves; say() manda un mensaje y devuelve la respuesta del asistente a ESE mensaje
  let n=0;const person=async name=>{const u=await call('/api/auth/register','',{username:'persona'+(++n),name,password}),conv=(await call('/api/conversations',u.cookie,{courseId:'aves',channel:'whatsapp'})).conversation.id;
    const say=async text=>{const sent=await call('/api/conversations/'+conv+'/messages',u.cookie,{text,clientRef:randomUUID()},'POST',201);
      for(let i=0;i<60;i++){await sleep(120);const log=db.prepare('SELECT * FROM reply_log WHERE trigger_message_id=?').get(sent.id);if(log){const m=log.reply_message_id?db.prepare('SELECT * FROM messages WHERE id=?').get(log.reply_message_id):null;return {log,text:m?.text||'',buttons:m?.buttons?JSON.parse(m.buttons):null,flyer:Boolean(m?.flyer_course_id)};}}
      assert.fail('sin respuesta a «'+text+'»\n'+logs);};
    return {conv,cookie:u.cookie,say};};
  const run=conv=>db.prepare('SELECT step_id FROM flow_runs WHERE conversation_id=?').get(conv)?.step_id||null;

  // 1) apagado por omisión: el saludo es el de siempre (sin botones guardados, porque la marca no simula el canal)
  let view=(await call('/api/flows',admin.cookie)).flows.find(f=>f.brandId==='globalvet');assert.equal(view.enabled,false);assert.equal(view.isDefault,true);assert.equal(view.revision,0);assert.deepEqual(view.steps,DEFAULT_STEPS);
  const before=await person('Ana Pérez'),classic=await before.say('Hola');assert.equal(classic.buttons,null);assert.equal(run(before.conv),null);assert.doesNotMatch(classic.text,/Soy el asistente de GlobalVet/);
  // 2) sólo administración lo cambia; los clientes ni lo ven; errores en palabras de quien lo arma
  await call('/api/flows',before.cookie,undefined,'GET',403);await call('/api/flows/globalvet',before.cookie,{enabled:true,steps:DEFAULT_STEPS,expectedRevision:0},'PUT',403);
  assert.match((await call('/api/flows/globalvet',admin.cookie,{enabled:true,steps:[{id:'inicio',text:'Hola',buttons:[{label:'Un botón con demasiado texto',go:'action:price'}]}],expectedRevision:0},'PUT',400)).error,/demasiado largo/);
  await call('/api/flows/no-existe',admin.cookie,{enabled:true,steps:DEFAULT_STEPS,expectedRevision:0},'PUT',404);
  const saved=(await call('/api/flows/globalvet',admin.cookie,{enabled:true,withFlyer:true,steps:DEFAULT_STEPS,expectedRevision:0},'PUT')).flow;assert.equal(saved.enabled,true);assert.equal(saved.revision,1);assert.equal(saved.isDefault,false);
  await call('/api/flows/globalvet',admin.cookie,{enabled:true,steps:DEFAULT_STEPS,expectedRevision:0},'PUT',409);

  // 3) encendido: el saludo es el paso 1 con su nombre, la ficha del curso y los botones (guardados aunque la marca no simule el canal)
  const maria=await person('María López'),hello=await maria.say('Hola, buenas tardes');
  assert.equal(hello.text,'¡Hola, María! Soy el asistente de GlobalVet. ¿Qué te gustaría saber de Plan sanitario para aves?');assert.deepEqual(hello.buttons,['Precio','Temario','Más opciones']);assert.equal(hello.flyer,true);assert.equal(run(maria.conv),'inicio');
  assert.ok(JSON.parse(hello.log.sources).some(s=>s.type==='flow'&&s.step==='inicio'));
  // un botón de acción responde por el camino de siempre (precio del catálogo) y deja el menú a la vista
  const price=await maria.say('Precio');assert.match(price.text,/379/);assert.deepEqual(price.buttons,['Precio','Temario','Más opciones']);assert.equal(price.log.intent,'price');assert.match(price.log.reason,/Opción «Precio» del flujo/);assert.equal(run(maria.conv),'inicio');
  // un botón que lleva a otro paso: sin importar mayúsculas ni acentos
  const more=await maria.say('mas opciones');assert.equal(more.text,'Claro. ¿Con qué te ayudo?');assert.deepEqual(more.buttons,['Fechas y horario','Inscribirme','Hablar con asesor']);assert.equal(more.log.intent,'flow');assert.equal(run(maria.conv),'mas');
  const dates=await maria.say('Fechas y horario');assert.equal(dates.log.intent,'schedule');assert.deepEqual(dates.buttons,['Fechas y horario','Inscribirme','Hablar con asesor']);
  // texto libre: contesta el asistente de siempre y el flujo no estorba (ni pone botones ni pierde el paso)
  const free=await maria.say('¿Entregan certificado?');assert.equal(free.log.intent,'certificate');assert.equal(free.buttons,null);assert.equal(run(maria.conv),'mas');
  // tras escribir otra cosa el menú sigue valiendo: «Inscribirme» termina el recorrido (sin venta activa pasa a una persona) y la respuesta ya no ofrece el menú
  const enroll=await maria.say('Inscribirme');assert.equal(enroll.log.intent,'enroll');assert.equal(enroll.log.action,'escalated');assert.equal(enroll.buttons,null);assert.equal(run(maria.conv),null);
  // dos mensajes seguidos que no son un botón terminan el recorrido: un «sí» suelto ya no se confunde con un botón
  const ines=await person('Inés');await ines.say('Hola');assert.equal(run(ines.conv),'inicio');
  const one=await ines.say('¿Entregan certificado?');assert.equal(one.buttons,null);assert.equal(run(ines.conv),'inicio');
  const two=await ines.say('¿Y las clases quedan grabadas?');assert.equal(two.log.intent,'recording');assert.equal(run(ines.conv),null);
  const stale=await ines.say('Más opciones');assert.notEqual(stale.log.intent,'flow','el menú ya no está activo');

  // 4) si lo primero que escribe es una pregunta concreta, se contesta y se le ofrece el menú
  const luis=await person('Luis'),first=await luis.say('¿Cuánto cuesta el curso?');assert.equal(first.log.intent,'price');assert.match(first.text,/379/);assert.deepEqual(first.buttons,['Precio','Temario','Más opciones']);assert.equal(run(luis.conv),'inicio');
  const human=await luis.say('Más opciones').then(()=>luis.say('Hablar con asesor'));assert.equal(human.log.intent,'human');assert.equal(human.log.action,'escalated');assert.equal(run(luis.conv),null);
  // si lo primero que escribe no se entiende y la marca propone una persona a la primera: la propuesta lleva sus dos botones (no el menú) y no
  // mueve el recorrido; si tampoco se entiende lo siguiente, pasa a una persona SIN menú
  const rs=(await call('/api/replies/settings',admin.cookie)).settings.find(x=>x.brand_id==='globalvet');await call('/api/replies/brands/globalvet',admin.cookie,{maxUnknown:1,expectedRevision:rs.revision},'PATCH');
  const lost=await person('Teo'),odd=await lost.say('Necesito que me expliquen lo del convenio con mi cooperativa');assert.equal(odd.log.action,'replied');assert.deepEqual(odd.buttons,['Sí, con un asesor','Ver opciones']);assert.match(odd.text,/persona del equipo/);assert.equal(run(lost.conv),null);
  const odd2=await lost.say('Es que la cooperativa tiene un convenio distinto con ustedes');assert.equal(odd2.log.action,'escalated');assert.equal(odd2.buttons,null);assert.equal(run(lost.conv),null);
  await call('/api/replies/brands/globalvet',admin.cookie,{maxUnknown:2,expectedRevision:rs.revision+1},'PATCH');
  // un cuerpo vacío no rompe el servidor
  await call('/api/flows/globalvet',admin.cookie,null,'PUT',400);
  // quien pide la baja en su primer mensaje no recibe un menú
  const out=await person('Sara'),bye=await out.say('Ya no quiero recibir mensajes');assert.equal(bye.log.intent,'opt_out');assert.equal(bye.buttons,null);assert.equal(run(out.conv),null);

  // 5) un flujo propio: sin ficha, con un paso sin botones; guardar reinicia a quien iba a medias
  const rosa=await person('Rosa');await rosa.say('Hola');assert.equal(run(rosa.conv),'inicio');
  const own=[{id:'inicio',text:'Hola {{nombre}}, gracias por escribir a {{marca}}.',buttons:[{label:'Quiero precios',go:'action:price'},{label:'Ver más',go:'step:fin'}]},{id:'fin',text:'Escríbeme tu duda de {{curso}} y te respondo.',buttons:[]}];
  const again=(await call('/api/flows/globalvet',admin.cookie,{enabled:true,withFlyer:false,steps:own,expectedRevision:1},'PUT')).flow;assert.equal(again.revision,2);assert.equal(again.withFlyer,false);assert.equal(run(rosa.conv),null,'guardar reinicia los recorridos a medias');
  const paco=await person('Paco'),hi=await paco.say('Buenas');assert.equal(hi.text,'Hola Paco, gracias por escribir a GlobalVet.');assert.equal(hi.flyer,false);assert.deepEqual(hi.buttons,['Quiero precios','Ver más']);
  const end=await paco.say('Ver más');assert.equal(end.text,'Escríbeme tu duda de Plan sanitario para aves y te respondo.');assert.equal(end.buttons,null);assert.equal(run(paco.conv),'fin');
  // 6) apagarlo devuelve el saludo de siempre; otra marca nunca lo tuvo
  await call('/api/flows/globalvet',admin.cookie,{enabled:false,steps:own,expectedRevision:2},'PUT');
  const late=await person('Zoe'),old=await late.say('Hola');assert.equal(old.buttons,null);assert.doesNotMatch(old.text,/gracias por escribir a GlobalVet/);
  assert.equal((await call('/api/flows',admin.cookie)).flows.find(f=>f.brandId==='odonteck').enabled,false);
});
