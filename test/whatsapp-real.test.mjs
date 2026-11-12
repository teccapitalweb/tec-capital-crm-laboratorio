import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {hmacHex,metaChannel,explainMeta} from '../server/connectors.mjs';

const PNG=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(64,7)]);
const TOKEN='EAAprueba0000000000000000000000token',SECRET='app-secret-prueba',NUMBER='109000000000001',OTHER='109000000000002';

test('adaptador de Meta: explica los errores en español, no acepta un token mal pegado y arma texto, botones y archivos',async()=>{
  assert.match(explainMeta({code:190}),/token de Meta venció/);assert.match(explainMeta({code:131030}),/lista de destinatarios permitidos/);assert.match(explainMeta({code:131047}),/24 horas/);
  assert.match(explainMeta({code:100,error_subcode:33,message:'Object does not exist'}),/META_PHONE_NUMBER_ID/);assert.match(explainMeta({code:999,message:'Algo raro'}),/código 999\): Algo raro/);assert.match(explainMeta(null,401),/token de Meta/);
  const calls=[],ok=id=>({ok:true,status:200,json:async()=>({messages:[{id}]})});
  const env={META_ACCESS_TOKEN:TOKEN,META_APP_SECRET:SECRET,META_VERIFY_TOKEN:'v',META_PHONE_NUMBER_ID:NUMBER,NODE_ENV:'production',META_GRAPH_URL:'http://127.0.0.1:1'};
  const meta=metaChannel({env,fetchImpl:async(url,init)=>{calls.push({url,init});return String(url).endsWith('/media')?{ok:true,status:200,json:async()=>({id:'m1'})}:ok('wamid.'+calls.length);}});
  assert.equal(meta.configured,true);
  const r=await meta.send({to:'+52 1 55 1234 5678',text:'Hola',buttons:['Ver temario','Ver precio','Una opción demasiado larga para un botón','Cuarto']});
  assert.deepEqual(r,{providerRef:'wamid.1',state:'sent',reason:null});
  assert.equal(calls[0].url,'https://graph.facebook.com/v25.0/'+NUMBER+'/messages','en producción el token sólo viaja a graph.facebook.com aunque exista META_GRAPH_URL');
  assert.equal(calls[0].init.headers.Authorization,'Bearer '+TOKEN);
  const sent=JSON.parse(calls[0].init.body);assert.equal(sent.to,'5215512345678');assert.equal(sent.type,'interactive');assert.deepEqual(sent.interactive.action.buttons.map(b=>b.reply.title),['Ver temario','Ver precio','Una opción demasiado']);
  await meta.send({to:'5215512345678',text:'Tu comprobante',media:{buffer:PNG,mime:'image/png',filename:'recibo.png'}});
  assert.ok(calls[1].url.endsWith('/'+NUMBER+'/media'));assert.ok(calls[1].init.body instanceof FormData);const image=JSON.parse(calls[2].init.body);assert.equal(image.type,'image');assert.deepEqual(image.image,{id:'m1',caption:'Tu comprobante'});
  await meta.send({to:'5215512345678',text:'',media:{buffer:Buffer.from('%PDF-1.4'),mime:'application/pdf',filename:'temario.pdf'}});assert.deepEqual(JSON.parse(calls[4].init.body).document,{id:'m1',filename:'temario.pdf'});
  let step=0;const half=metaChannel({env,fetchImpl:async url=>{step++;if(String(url).endsWith('/media'))return {ok:true,status:200,json:async()=>({id:'m9'})};return step===2?ok('wamid.file'):{ok:false,status:400,json:async()=>({error:{code:131009,message:'bad'}})};}});
  const partial=await half.send({to:'5215512345678',text:'x'.repeat(1100),media:{buffer:PNG,mime:'image/png',filename:'a.png'}});
  assert.equal(partial.state,'sent');assert.equal(partial.providerRef,'wamid.file');assert.match(partial.reason,/Sólo salió una parte/);
  await assert.rejects(meta.send({to:'5215512345678',text:''}),/no tiene texto/);await assert.rejects(meta.send({to:'',text:'x'}),/número de WhatsApp de destino/);
  // un token con otra variable pegada (o con espacios) se rechaza antes de salir y el error no lo repite
  const bad=metaChannel({env:{...env,META_ACCESS_TOKEN:TOKEN+' AI_MODEL=otra-cosa'},fetchImpl:async()=>{throw new Error('no debe salir');}});
  await assert.rejects(bad.send({to:'5215512345678',text:'x'}),e=>/no parece un token/.test(e.message)&&!e.message.includes(TOKEN));
  // un fallo de red no filtra nada
  const down=metaChannel({env,fetchImpl:async()=>{throw new TypeError('Headers.append: "Bearer '+TOKEN+'" is an invalid header value');}});
  await assert.rejects(down.send({to:'5215512345678',text:'x'}),e=>/No se pudo conectar con Meta/.test(e.message)&&!e.message.includes(TOKEN));
  // la descarga de archivos sólo acepta direcciones de Meta en producción
  const evil=metaChannel({env,fetchImpl:async url=>String(url).includes('/v25.0/')?{ok:true,status:200,json:async()=>({url:'https://ejemplo.invalid/x',mime_type:'image/png',file_size:10})}:(()=>{throw new Error('no debe pedirse');})()});
  await assert.rejects(evil.fetchMedia('123'),/no es de Meta/);
  // traducción del webhook: nombre del perfil, número que recibe, tipo y archivo
  const events=meta.parseWebhook({entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:NUMBER},contacts:[{wa_id:'5215512345678',profile:{name:'María López'}}],messages:[{id:'wamid.a',from:'5215512345678',timestamp:'1700000000',type:'image',image:{id:'900',mime_type:'image/jpeg',caption:'Mi pago'}},{id:'wamid.b',from:'5215512345678',type:'audio',audio:{id:'901',mime_type:'audio/ogg; codecs=opus'}},{id:'wamid.c',from:'5215512345678',type:'interactive',interactive:{button_reply:{id:'b1',title:'Ver precio'}}}],statuses:[{id:'wamid.z',status:'failed',errors:[{code:131026}]}]}}]}]});
  assert.equal(events[0].data.reason.includes('no tiene WhatsApp'),true);
  assert.deepEqual(events[1].data,{channel:'whatsapp',from:'5215512345678',to:NUMBER,name:'María López',kind:'image',text:'Mi pago',media:{id:'900',mime:'image/jpeg',filename:null},providerRef:'wamid.a',at:1700000000000,referral:null});
  assert.equal(events[2].data.media.mime,'audio/ogg');assert.equal(events[3].data.text,'Ver precio');
});

test('WhatsApp real de punta a punta con un Meta de mentira: entra un mensaje, se crea el cliente y la conversación, el asistente responde y sale por la API',async t=>{
  // ---- Meta de mentira: Graph API mínima (número, mensajes, subir y bajar archivos)
  const sent=[],uploads=[],downloads=[];let n=0;
  const stub=createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const raw=Buffer.concat(chunks),u=new URL(req.url,'http://x'),send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(req.headers.authorization!=='Bearer '+TOKEN)return send(401,{error:{code:190,message:'Invalid OAuth access token'}});
    let x;
    if(u.pathname.startsWith('/download/')){downloads.push(u.pathname);res.writeHead(200,{'content-type':'image/png'});return res.end(PNG);}
    if((x=u.pathname.match(/^\/v25\.0\/(\d+)\/messages$/))&&req.method==='POST'){
      const body=JSON.parse(raw.toString()),text=body.text?.body||body.interactive?.body?.text||body.image?.caption||'';sent.push({from:x[1],...body});
      if(body.to==='5215500000001')return send(400,{error:{code:131030,message:'Recipient phone number not in allowed list'}});
      if(text.includes('FALLA'))return send(400,{error:{code:131047,message:'Re-engagement message'}});
      return send(200,{messaging_product:'whatsapp',contacts:[{input:body.to,wa_id:body.to}],messages:[{id:'wamid.out'+(++n)}]});
    }
    if((x=u.pathname.match(/^\/v25\.0\/(\d+)\/media$/))&&req.method==='POST'){uploads.push({from:x[1],type:req.headers['content-type'],size:raw.length});return send(200,{id:'media-up-'+uploads.length});}
    if((x=u.pathname.match(/^\/v25\.0\/(\d+)$/))&&req.method==='GET'){
      if(x[1]===NUMBER||x[1]===OTHER)return send(200,{display_phone_number:'+1 555 010 0000',verified_name:'Test Number',quality_rating:'GREEN',id:x[1]});
      if(x[1]==='7001')return send(200,{url:'http://127.0.0.1:'+stub.address().port+'/download/7001',mime_type:'image/png',file_size:PNG.length,id:'7001'});
      return send(400,{error:{code:100,error_subcode:33,message:'Unsupported get request. Object with ID does not exist'}});
    }
    send(404,{error:{code:100,message:'ruta desconocida'}});
  });});
  await new Promise(r=>stub.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'crm-wa-')),code=randomUUID(),password='Password-whatsapp-2026!';let logs='',db=null;
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',AI_PROVIDER:'',CHANNEL_CONNECTOR:'meta',META_ACCESS_TOKEN:TOKEN,META_APP_SECRET:SECRET,META_VERIFY_TOKEN:'verifica-123',META_PHONE_NUMBER_ID:NUMBER,META_GRAPH_URL:'http://127.0.0.1:'+stub.address().port,META_GRAPH_VERSION:'',WA_PING_COOLDOWN_MS:'0'},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{try{db?.close();}catch{}if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await new Promise(r=>stub.close(r));await rm(dir,{recursive:true,force:true});});
  async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async(fn,what,ms=8000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)assert.fail('no ocurrió: '+what+'\n'+logs);await sleep(120);}};
  // webhook firmado como lo manda Meta
  let wid=0;
  const hook=async(value,{signature}={})=>{const raw=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'waba',changes:[{field:'messages',value:{messaging_product:'whatsapp',...value}}]}]});
    const r=await fetch(origin+'/api/webhooks/channel/meta',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':signature||'sha256='+hmacHex(SECRET,raw)},body:raw});return {status:r.status,body:await r.json()};};
  const incoming=(from,message,{to=NUMBER,name='María López',id}={})=>hook({metadata:{display_phone_number:'15550100000',phone_number_id:to},contacts:[{profile:{name},wa_id:from}],messages:[{from,id:id||'wamid.in'+(++wid),timestamp:String(Math.floor(Date.now()/1000)),...message}]});
  const textIn=(from,body,o)=>incoming(from,{type:'text',text:{body}},o);

  const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
  db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,39);

  // 1) estado: Meta activo y completo, el número del entorno todavía sin marca; sólo administración
  let st=await call('/api/whatsapp',admin.cookie);
  assert.equal(st.live,true);assert.equal(st.configured,true);assert.equal(st.envNumber,NUMBER);assert.equal(st.envNumberAssigned,false);assert.deepEqual(st.numbers,[]);assert.equal(JSON.stringify(st).includes(TOKEN),false);assert.equal(JSON.stringify(st).includes(SECRET),false);
  const stranger=await call('/api/auth/register','',{username:'curiosa',name:'Persona curiosa',password});await call('/api/whatsapp',stranger.cookie,undefined,'GET',403);
  // 2) probar la conexión: lee el número en Meta sin enviar nada; un identificador equivocado se explica
  const pong=await call('/api/whatsapp/ping',admin.cookie,{});assert.equal(pong.ok,true);assert.equal(pong.displayPhone,'+1 555 010 0000');assert.equal(pong.verifiedName,'Test Number');
  const wrong=await call('/api/whatsapp/ping',admin.cookie,{phoneNumberId:'55555'});assert.equal(wrong.ok,false);assert.match(wrong.error,/META_PHONE_NUMBER_ID/);
  // 3) un mensaje a un número sin marca se ignora y lo dice (no crea nada)
  const lost=await textIn('5215512345678','Hola');assert.equal(lost.status,200);assert.match(lost.body.results[0].result,/no tiene una marca asignada/);assert.equal(db.prepare('SELECT count(*) n FROM wa_identities').get().n,0);
  // 4) asignar el número a GlobalVet (curso por omisión: aves)
  await call('/api/whatsapp/numbers/abc',admin.cookie,{brandId:'globalvet',expectedRevision:0},'PUT',404);
  await call('/api/whatsapp/numbers/'+NUMBER,admin.cookie,{brandId:'no-existe',expectedRevision:0},'PUT',400);
  await call('/api/whatsapp/numbers/'+NUMBER,admin.cookie,{brandId:'globalvet',courseId:'odontologia',expectedRevision:0},'PUT',400);
  const saved=await call('/api/whatsapp/numbers/'+NUMBER,admin.cookie,{brandId:'globalvet',courseId:'aves',label:'Número de prueba',expectedRevision:0},'PUT');assert.equal(saved.number.brandName,'GlobalVet');assert.equal(saved.number.revision,1);
  await call('/api/whatsapp/numbers/'+NUMBER,admin.cookie,{brandId:'globalvet',courseId:'aves',expectedRevision:0},'PUT',409);

  // 5) entra un mensaje real: cliente nuevo, conversación real en la marca del número, contacto con teléfono y respuesta del asistente por la API
  const first=await textIn('5215512345678','Hola, ¿cuánto cuesta el curso?');assert.equal(first.status,200);assert.match(first.body.results[0].result,/^recibido: conversación nueva/);
  const person=db.prepare('SELECT u.* FROM wa_identities i JOIN users u ON u.id=i.user_id WHERE i.wa_id=?').get('5215512345678');
  assert.equal(person.role,'customer');assert.equal(person.name,'María López');assert.match(person.username,/^wa-[a-f0-9]{16}$/);assert.equal(person.username.includes('5512345678'),false,'el usuario no lleva el teléfono');
  const conv=db.prepare('SELECT * FROM conversations WHERE customer_id=?').get(person.id);
  assert.equal(conv.brand_id,'globalvet');assert.equal(conv.course_id,'aves');assert.equal(conv.channel,'whatsapp');assert.equal(conv.wa_number,NUMBER);assert.equal(conv.wa_peer,'5215512345678');
  const waContact=db.prepare('SELECT * FROM contacts WHERE source_user_id=? AND brand_id=?').get(person.id,'globalvet');assert.equal(waContact.phone,'+5215512345678');
  assert.ok(db.prepare("SELECT 1 FROM persons WHERE id=? AND phone!=''").get(waContact.persona_id),'la persona del contacto conoce su teléfono');
  const inMsg=db.prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_kind='customer'").get(conv.id);assert.equal(inMsg.text,'Hola, ¿cuánto cuesta el curso?');assert.equal(inMsg.client_ref,'meta:wamid.in2');
  const reply=await until(()=>db.prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_kind='automation' AND provider_ref IS NOT NULL").get(conv.id),'la respuesta del asistente sale por Meta');
  assert.match(reply.text,/\$\s?379|379/);assert.equal(reply.delivery_state,'sent');assert.match(reply.provider_ref,/^wamid\.out/);
  const out=sent.find(m=>m.to==='5215512345678');assert.equal(out.from,NUMBER);assert.equal(out.messaging_product,'whatsapp');assert.match(out.text?.body||out.interactive?.body?.text||'',/379/);
  // la bitácora de conectores no guarda el texto ni el número completo
  const logged=db.prepare("SELECT payload FROM connector_events WHERE event_id='wamid.in2'").get().payload;assert.equal(logged.includes('cuesta'),false);assert.equal(logged.includes('5215512345678'),false);
  // la persona no puede iniciar sesión: su contraseña no la conoce nadie
  await call('/api/auth/login','',{username:person.username,password:'5215512345678'},'POST',401);

  // 6) estados de Meta: entregado y leído avanzan el mismo mensaje; el equipo ve la conversación marcada como real
  const status=state=>hook({metadata:{phone_number_id:NUMBER},statuses:[{id:reply.provider_ref,status:state,timestamp:String(Math.floor(Date.now()/1000)),recipient_id:'5215512345678'}]});
  assert.match((await status('delivered')).body.results[0].result,/^aplicado: mensaje delivered/);assert.match((await status('read')).body.results[0].result,/^aplicado: mensaje read/);
  assert.equal(db.prepare('SELECT delivery_state FROM messages WHERE id=?').get(reply.id).delivery_state,'read');
  const seen=(await call('/api/conversations/'+conv.id,admin.cookie)).conversation;assert.equal(seen.wa_number,NUMBER);assert.equal(seen.window.real,true);assert.equal(seen.window.enabled,true);assert.equal(seen.window.open,true);

  // 7) el mismo mensaje repetido por Meta no se duplica; una firma falsa se rechaza
  const again=await textIn('5215512345678','Hola, ¿cuánto cuesta el curso?',{id:'wamid.in2'});assert.match(again.body.results[0].result,/^duplicado/);
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND sender_kind='customer'").get(conv.id).n,1);
  assert.equal((await hook({metadata:{phone_number_id:NUMBER},messages:[]},{signature:'sha256=falsa'})).status,401);

  // 8) un audio sin texto: queda la nota para el equipo y el asistente pide que lo escriba, sin gastar una consulta
  const audio=await incoming('5215512345678',{type:'audio',audio:{id:'8001',mime_type:'audio/ogg; codecs=opus',voice:true}});assert.match(audio.body.results[0].result,/^recibido: conversación existente/);
  assert.match(db.prepare("SELECT text FROM messages WHERE conversation_id=? AND sender_kind='customer' ORDER BY seq DESC LIMIT 1").get(conv.id).text,/^\[Audio de WhatsApp/);
  await until(()=>sent.some(m=>/no puedo abrir audios/.test(m.text?.body||'')),'la respuesta al audio sale por Meta');
  assert.equal(db.prepare('SELECT count(*) n FROM jobs WHERE conversation_id=?').get(conv.id).n,1,'el audio no crea un trabajo del asistente');

  // 9) una imagen con texto: se descarga de Meta con el token y queda como adjunto del chat
  const photo=await incoming('5215512345678',{type:'image',image:{id:'7001',mime_type:'image/png',caption:'¿Qué temas incluye?'}});assert.match(photo.body.results[0].result,/con archivo/);
  const att=db.prepare('SELECT a.* FROM attachments a WHERE a.conversation_id=?').get(conv.id);assert.equal(att.mime,'image/png');assert.equal(att.size,PNG.length);assert.ok(existsSync(join(dir,'uploads',att.storage_name)));assert.deepEqual(downloads,['/download/7001']);
  assert.equal((await fetch(origin+'/api/files/'+att.id,{headers:{Cookie:admin.cookie}})).status,200);assert.equal((await fetch(origin+'/api/files/'+att.id,{headers:{Cookie:stranger.cookie}})).status,404,'el archivo sólo lo ve el equipo de la marca');

  // 10) el equipo responde desde el CRM con texto y con un archivo: salen por la API en orden, y un rechazo de Meta queda explicado
  await until(()=>!db.prepare("SELECT 1 FROM jobs WHERE conversation_id=? AND state='pending'").get(conv.id)&&!db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='automation' AND provider_ref IS NULL AND delivery_state='sent'").get(conv.id),'el asistente terminó de responder a la imagen');
  const before=sent.length;
  await call('/api/conversations/'+conv.id+'/messages',admin.cookie,{text:'Hola María, te atiende Administración.',clientRef:randomUUID()},'POST',201);
  await call('/api/conversations/'+conv.id+'/messages',admin.cookie,{text:'Aquí tienes el temario.',clientRef:randomUUID(),attachment:{name:'temario.png',type:'image/png',base64:PNG.toString('base64')}},'POST',201);
  await until(()=>sent.length>=before+2&&db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND sender_kind='agent' AND provider_ref IS NOT NULL").get(conv.id).n===2,'los dos mensajes del equipo salen por Meta');
  assert.equal(sent[before].text.body,'Hola María, te atiende Administración.');assert.equal(sent[before+1].type,'image');assert.equal(sent[before+1].image.caption,'Aquí tienes el temario.');assert.equal(uploads.length,1);assert.match(uploads[0].type,/^multipart\/form-data/);
  const failing=await call('/api/conversations/'+conv.id+'/messages',admin.cookie,{text:'FALLA a propósito',clientRef:randomUUID()},'POST',201);
  const failed=await until(()=>{const m=db.prepare('SELECT * FROM messages WHERE id=?').get(failing.id);return m.delivery_state==='failed'?m:null;},'el rechazo de Meta marca el mensaje como no entregado');
  assert.match(failed.failed_reason,/24 horas/);assert.equal(failed.provider_ref,null);
  // reintentar lo vuelve a mandar (y vuelve a fallar con el mismo motivo, sin duplicar el mensaje)
  const tries=sent.filter(m=>m.text?.body==='FALLA a propósito').length;await call('/api/messages/'+failing.id+'/retry',admin.cookie,{});
  await until(()=>sent.filter(m=>m.text?.body==='FALLA a propósito').length===tries+1&&db.prepare('SELECT delivery_state FROM messages WHERE id=?').get(failing.id).delivery_state==='failed','el reintento vuelve a salir');

  // 11) ventana de 24 h: si la persona no ha escrito en un día, el CRM no deja escribirle (Meta lo rechazaría)
  db.prepare("UPDATE messages SET created_at=created_at-25*3600000 WHERE conversation_id=? AND sender_kind='customer'").run(conv.id);
  const closed=await call('/api/conversations/'+conv.id+'/messages',admin.cookie,{text:'¿Sigues interesada?',clientRef:randomUUID()},'POST',409);assert.match(closed.error,/24 horas/);
  assert.equal((await call('/api/conversations/'+conv.id,admin.cookie)).conversation.window.open,false);
  // cuando vuelve a escribir, se abre otra vez y continúa en la misma conversación
  await textIn('5215512345678','Sí, sigo interesada');assert.equal(db.prepare('SELECT count(*) n FROM conversations WHERE customer_id=?').get(person.id).n,1);
  await call('/api/conversations/'+conv.id+'/messages',admin.cookie,{text:'¡Qué gusto!',clientRef:randomUUID()},'POST',201);

  // 12) México: Meta entrega 521… pero la lista del número de prueba tiene 52…; se reintenta una vez sin el 1
  await textIn('5215500000001','¿Cuánto cuesta?',{name:'Luis'});
  await until(()=>sent.some(m=>m.to==='525500000001'),'el reintento sin el 1 sale');assert.ok(sent.some(m=>m.to==='5215500000001'));
  const luis=db.prepare("SELECT c.id FROM conversations c WHERE c.wa_peer='5215500000001'").get();
  await until(()=>db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='automation' AND provider_ref IS NOT NULL AND delivery_state='sent'").get(luis.id),'la respuesta a Luis queda enviada');

  // 12b) venta por WhatsApp de punta a punta: pide inscribirse, recibe su enlace y paga SIN iniciar sesión (no tiene perfil); la confirmación sale por Meta
  const ps=(await call('/api/payments/settings',admin.cookie)).settings.find(x=>x.brand_id==='globalvet');
  await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:ps.revision},'PATCH');
  await textIn('5215500000001','Quiero inscribirme',{name:'Luis'});
  const linkOut=await until(()=>sent.find(m=>m.to==='525500000001'&&/\?pay=[a-f0-9-]{36}/.test(m.text?.body||'')),'el enlace de pago sale por Meta'),orderId=linkOut.text.body.match(/\?pay=([a-f0-9-]{36})/)[1];
  const anon=async(path,body)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  const shown=await anon('/api/pay/'+orderId+'/customer');assert.equal(shown.status,200);assert.equal(shown.body.order.status,'pending');assert.equal(shown.body.order.brand,'GlobalVet');assert.match(shown.body.order.reference,/^TC-/);
  assert.equal(JSON.stringify(shown.body).includes('5500000001'),false,'la vista pública no lleva el teléfono');assert.equal(shown.body.order.conversationId,undefined);assert.equal(shown.body.order.contact_id,undefined);
  assert.equal((await anon('/api/payments/orders/'+orderId+'/customer')).status,401,'la ruta con sesión sigue pidiendo sesión');
  assert.equal((await anon('/api/pay/'+randomUUID()+'/customer')).status,404);
  const paid=await anon('/api/pay/'+orderId+'/pay',{method:'card',outcome:'approved'});assert.equal(paid.status,200);assert.equal(paid.body.order.status,'paid');
  assert.equal((await anon('/api/pay/'+orderId+'/pay',{method:'card',outcome:'approved'})).status,409,'un pedido pagado no se paga dos veces');
  await until(()=>sent.some(m=>m.to==='525500000001'&&/pago/i.test(m.text?.body||'')&&/confirm|registr|recib/i.test(m.text?.body||'')&&!/\?pay=/.test(m.text?.body||'')),'la confirmación del pago sale por Meta');
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(orderId).status,'paid');
  // 12c) pagar cuando ya pasaron las 24 h: el pago NUNCA falla por la ventana; la confirmación se guarda y queda «no entregada» con el motivo, sin pedírselo a Meta
  await textIn('5215500000002','Quiero inscribirme',{name:'Rosa'});
  const rosaLink=await until(()=>sent.find(m=>m.to==='5215500000002'&&/\?pay=[a-f0-9-]{36}/.test(m.text?.body||'')),'el enlace de Rosa sale por Meta'),rosaOrder=rosaLink.text.body.match(/\?pay=([a-f0-9-]{36})/)[1],rosa=db.prepare("SELECT id FROM conversations WHERE wa_peer='5215500000002'").get();
  await until(()=>!db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='automation' AND provider_ref IS NULL AND delivery_state='sent'").get(rosa.id),'todo lo de Rosa salió');
  db.prepare("UPDATE messages SET created_at=created_at-25*3600000 WHERE conversation_id=? AND sender_kind='customer'").run(rosa.id);const toRosa=sent.filter(m=>m.to==='5215500000002').length;
  assert.equal((await anon('/api/pay/'+rosaOrder+'/pay',{method:'card',outcome:'approved'})).body.order.status,'paid');
  const unsent=await until(()=>db.prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_kind='automation' AND delivery_state='failed'").get(rosa.id),'la confirmación queda como no entregada');
  assert.match(unsent.failed_reason,/más de 24 horas/);assert.equal(unsent.provider_ref,null);assert.equal(sent.filter(m=>m.to==='5215500000002').length,toRosa,'no se le pide a Meta un envío que va a rechazar');
  // reintentarlo no lo manda a Meta: sin plantilla de aviso vuelve a quedar como no entregado, con el motivo
  await call('/api/messages/'+unsent.id+'/retry',admin.cookie,{});await until(()=>db.prepare('SELECT delivery_state FROM messages WHERE id=?').get(unsent.id).delivery_state==='failed','el reintento sin plantilla vuelve a fallar');assert.equal(sent.filter(m=>m.to==='5215500000002').length,toRosa);

  // 13) el laboratorio sigue simulado aunque Meta esté activo: el perfil de prueba conversa sin que nada salga a Meta
  const total=sent.length,lab=(await call('/api/conversations',stranger.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;assert.equal(lab.wa_number,null);
  await call('/api/conversations/'+lab.id+'/messages',stranger.cookie,{text:'¿Cuánto cuesta?',clientRef:randomUUID()},'POST',201);
  await until(()=>db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='automation'").get(lab.id),'el asistente responde en el laboratorio');await sleep(1300);
  assert.equal(sent.length,total,'ningún mensaje del laboratorio viaja a Meta');assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND provider_ref IS NOT NULL").get(lab.id).n,0);
  // y su pedido NO se abre sin sesión: la página pública es sólo para conversaciones reales
  await call('/api/conversations/'+lab.id+'/messages',stranger.cookie,{text:'Quiero inscribirme',clientRef:randomUUID()},'POST',201);
  const labOrder=await until(()=>db.prepare('SELECT id FROM orders WHERE conversation_id=?').get(lab.id),'el pedido del laboratorio');
  assert.equal((await anon('/api/pay/'+labOrder.id+'/customer')).status,404);assert.equal((await anon('/api/pay/'+labOrder.id+'/pay',{method:'card'})).status,404);
  assert.equal((await call('/api/payments/orders/'+labOrder.id+'/customer',stranger.cookie)).order.status,'pending');

  // 14) un segundo número para otra marca: la misma persona es el mismo cliente, con su conversación y su contacto en esa marca
  const mine=(await call('/api/whatsapp',admin.cookie)).numbers.find(x=>x.phoneNumberId===NUMBER);
  assert.match((await call('/api/whatsapp/numbers/'+NUMBER,admin.cookie,{brandId:'odonteck',courseId:null,expectedRevision:mine.revision},'PUT',409)).error,/conversaciones abiertas en GlobalVet/);
  await call('/api/whatsapp/numbers/'+OTHER,admin.cookie,{brandId:'odonteck',expectedRevision:0},'PUT');
  await textIn('5215512345678','Hola, me interesa',{to:OTHER});
  const convs=db.prepare('SELECT brand_id,wa_number FROM conversations WHERE customer_id=? ORDER BY created_at').all(person.id);assert.deepEqual(convs.map(c=>c.brand_id),['globalvet','odonteck']);assert.equal(convs[1].wa_number,OTHER);
  assert.equal(db.prepare('SELECT count(*) n FROM wa_identities').get().n,3,'María, Luis y Rosa: escribir a otra marca no crea otra persona');assert.equal(db.prepare("SELECT count(*) n FROM contacts WHERE source_user_id=?").get(person.id).n,2);
  await until(()=>sent.some(m=>m.from===OTHER&&m.to==='5215512345678'),'la respuesta de la segunda marca sale desde su propio número');
  // 15) número en pausa: se ignora; un número con conversaciones no se puede quitar
  const cur=(await call('/api/whatsapp',admin.cookie)).numbers.find(x=>x.phoneNumberId===OTHER);assert.equal(cur.conversations,1);assert.equal(cur.people,1);
  await call('/api/whatsapp/numbers/'+OTHER,admin.cookie,{brandId:'odonteck',enabled:false,expectedRevision:cur.revision},'PUT');
  assert.match((await textIn('5215512345678','¿Hola?',{to:OTHER})).body.results[0].result,/en pausa/);
  await call('/api/whatsapp/numbers/'+OTHER,admin.cookie,undefined,'DELETE',409);
  assert.equal(logs.includes(TOKEN),false,'el token no aparece en los registros');
});

test('WhatsApp real apagado por omisión: sin CHANNEL_CONNECTOR=meta el webhook sólo registra y nada sale',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'crm-wa-off-')),code=randomUUID();let logs='';
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',CHANNEL_CONNECTOR:'',META_ACCESS_TOKEN:TOKEN,META_APP_SECRET:SECRET,META_VERIFY_TOKEN:'v',META_PHONE_NUMBER_ID:NUMBER,META_GRAPH_URL:'http://127.0.0.1:1',WA_PING_COOLDOWN_MS:'0'},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
  const post=async(path,cookie,body,method='POST')=>{const r=await fetch(origin+path,{method,headers:{Cookie:cookie||'',Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const admin=await post('/api/auth/register','',{username:'admin',name:'Administración',password:'Password-whatsapp-2026!',inviteCode:code});
  const st=await post('/api/whatsapp',admin.cookie,undefined,'GET');assert.equal(st.body.live,false);assert.equal(st.body.selected,false);
  await post('/api/whatsapp/numbers/'+NUMBER,admin.cookie,{brandId:'globalvet',expectedRevision:0},'PUT');
  const ping=await post('/api/whatsapp/ping',admin.cookie,{});assert.equal(ping.body.ok,false);assert.match(ping.body.error,/CHANNEL_CONNECTOR=meta/);
  const raw=JSON.stringify({entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:NUMBER},contacts:[{wa_id:'5215512345678',profile:{name:'María'}}],messages:[{id:'wamid.x1',from:'5215512345678',type:'text',text:{body:'Hola'}}]}}]}]});
  const r=await fetch(origin+'/api/webhooks/channel/meta',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+hmacHex(SECRET,raw)},body:raw});
  assert.equal(r.status,200);assert.match((await r.json()).results[0].result,/^registrado: WhatsApp real está apagado/);
  const db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});try{const p=db.prepare("SELECT payload FROM connector_events WHERE event_id='wamid.x1'").get().payload;assert.equal(p.includes('Hola'),false);assert.equal(p.includes('5215512345678'),false);assert.equal(db.prepare('SELECT count(*) n FROM wa_identities').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n,0);}finally{db.close();}
});
