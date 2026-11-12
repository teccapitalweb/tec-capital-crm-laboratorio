import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {hmacHex,metaChannel} from '../server/connectors.mjs';

const TOKEN='EAAprueba0000000000000000000000token',SECRET='app-secret-prueba',NUMBER='109000000000001',WABA='209000000000001';

test('adaptador de Meta: una plantilla viaja con nombre, idioma y datos sin saltos de línea; listar y crear necesitan META_WABA_ID',async()=>{
  const calls=[],env={META_ACCESS_TOKEN:TOKEN,META_APP_SECRET:SECRET,META_VERIFY_TOKEN:'v',META_PHONE_NUMBER_ID:NUMBER,META_WABA_ID:WABA,NODE_ENV:'production'};
  const meta=metaChannel({env,fetchImpl:async(url,init)=>{calls.push({url:String(url),init});
    if(String(url).includes('/message_templates')&&(!init.method||init.method==='GET'))return {ok:true,status:200,json:async()=>({data:[{id:'1',name:'hello_world',language:'en_US',status:'APPROVED',category:'UTILITY',components:[{type:'HEADER',format:'TEXT',text:'Hello World'},{type:'BODY',text:'Welcome and congratulations!'}]},{id:'2',name:'con_imagen',language:'es_MX',status:'APPROVED',category:'MARKETING',components:[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:'Hola {{1}}'}]},{id:'3',name:'rechazada',language:'es_MX',status:'REJECTED',category:'UTILITY',rejected_reason:'INVALID_FORMAT',components:[{type:'BODY',text:'Hola {{1}}, gracias.'}]}]})};
    if(String(url).includes('/message_templates'))return {ok:true,status:200,json:async()=>({id:'99',status:'PENDING',category:'UTILITY'})};
    return {ok:true,status:200,json:async()=>({messages:[{id:'wamid.t1'}]})};}});
  const r=await meta.send({to:'5215512345678',text:'ignorado',template:{name:'aviso_novedad',language:'es_MX',params:['María','Plan  sanitario\npara aves','']}});
  assert.deepEqual(r,{providerRef:'wamid.t1',state:'sent',reason:null});
  const sent=JSON.parse(calls[0].init.body);assert.equal(sent.type,'template');assert.deepEqual(sent.template,{name:'aviso_novedad',language:{code:'es_MX'},components:[{type:'body',parameters:[{type:'text',text:'María'},{type:'text',text:'Plan sanitario para aves'},{type:'text',text:'—'}]}]});
  await meta.send({to:'5215512345678',template:{name:'hello_world',language:'en_US',params:[]}});assert.deepEqual(JSON.parse(calls[1].init.body).template,{name:'hello_world',language:{code:'en_US'}});
  const list=await meta.listTemplates();assert.ok(calls[2].url.startsWith('https://graph.facebook.com/v25.0/'+WABA+'/message_templates?'));
  assert.deepEqual(list.map(t=>[t.name,t.status,t.category,t.complex,t.reason]),[['hello_world','approved','utility',false,''],['con_imagen','approved','marketing',true,''],['rechazada','rejected','utility',false,'INVALID_FORMAT']]);
  const made=await meta.createTemplate({name:'aviso_novedad',language:'es_MX',category:'utility',body:'Hola {{1}}, hay novedades de {{2}}. Responde para verlas.',examples:['María','Plan sanitario para aves']});assert.deepEqual(made,{metaId:'99',status:'pending',category:'utility'});
  assert.deepEqual(JSON.parse(calls[3].init.body),{name:'aviso_novedad',language:'es_MX',category:'UTILITY',components:[{type:'BODY',text:'Hola {{1}}, hay novedades de {{2}}. Responde para verlas.',example:{body_text:[['María','Plan sanitario para aves']]}}]});
  const noWaba=metaChannel({env:{...env,META_WABA_ID:''},fetchImpl:async()=>{throw new Error('no debe salir');}});await assert.rejects(noWaba.listTemplates(),/META_WABA_ID/);await assert.rejects(noWaba.createTemplate({name:'x',language:'es_MX',category:'utility',body:'x'}),/META_WABA_ID/);
});

test('plantillas de WhatsApp de punta a punta: crear, aprobar, enviar desde el chat con la ventana cerrada, y avisos del negocio en espera hasta que la persona responde',async t=>{
  // ---- Meta de mentira: mensajes y plantillas de la cuenta
  const sent=[],created=[];let n=0,rejectTemplate='';
  const remoteTemplates=[{id:'t-hello',name:'hello_world',language:'en_US',status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:'Welcome and congratulations! This message demonstrates your ability to send a WhatsApp message.'}]},{id:'t-img',name:'promo_con_imagen',language:'es_MX',status:'APPROVED',category:'MARKETING',components:[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:'Hola {{1}}, mira esto.'}]}];
  const stub=createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const raw=Buffer.concat(chunks),u=new URL(req.url,'http://x'),send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(req.headers.authorization!=='Bearer '+TOKEN)return send(401,{error:{code:190,message:'Invalid OAuth access token'}});
    let x;
    if((x=u.pathname.match(/^\/v25\.0\/(\d+)\/messages$/))&&req.method==='POST'){const body=JSON.parse(raw.toString());sent.push({from:x[1],...body});
      if(body.type==='template'&&body.template.name===rejectTemplate)return send(400,{error:{code:132001,message:'Template name does not exist in the translation'}});
      return send(200,{messages:[{id:'wamid.out'+(++n)}]});}
    if(u.pathname==='/v25.0/'+WABA+'/message_templates'&&req.method==='GET')return send(200,{data:remoteTemplates});
    if(u.pathname==='/v25.0/'+WABA+'/message_templates'&&req.method==='POST'){const body=JSON.parse(raw.toString());created.push(body);remoteTemplates.push({id:'t-'+created.length,name:body.name,language:body.language,status:'PENDING',category:body.category,components:body.components});return send(200,{id:'t-'+created.length,status:'PENDING',category:body.category});}
    send(404,{error:{code:100,message:'ruta desconocida'}});
  });});
  await new Promise(r=>stub.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'crm-wa-tpl-')),code=randomUUID(),password='Password-plantillas-2026!';let logs='',db=null;
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',AI_PROVIDER:'',CHANNEL_CONNECTOR:'meta',META_ACCESS_TOKEN:TOKEN,META_APP_SECRET:SECRET,META_VERIFY_TOKEN:'verifica-123',META_PHONE_NUMBER_ID:NUMBER,META_WABA_ID:WABA,META_GRAPH_URL:'http://127.0.0.1:'+stub.address().port,META_GRAPH_VERSION:'',WA_HOLD_SWEEP_MS:'300'},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{try{db?.close();}catch{}if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await new Promise(r=>stub.close(r));await rm(dir,{recursive:true,force:true});});
  async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async(fn,what,ms=8000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)assert.fail('no ocurrió: '+what+'\n'+logs);await sleep(120);}};
  let wid=0;
  const textIn=async(from,body,name)=>{const raw=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:NUMBER},contacts:[{profile:{name},wa_id:from}],messages:[{from,id:'wamid.in'+(++wid),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body}}]}}]}]});
    const r=await fetch(origin+'/api/webhooks/channel/meta',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+hmacHex(SECRET,raw)},body:raw});assert.equal(r.status,200);return r.json();};
  const anon=async(path,body)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  const convOf=peer=>db.prepare('SELECT * FROM conversations WHERE wa_peer=?').get(peer);
  const settled=id=>until(()=>!db.prepare("SELECT 1 FROM jobs WHERE conversation_id=? AND state='pending'").get(id)&&!db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='automation' AND provider_ref IS NULL AND delivery_state='sent' AND wa_hold IS NULL").get(id),'el asistente terminó');
  const closeWindow=id=>db.prepare("UPDATE messages SET created_at=created_at-25*3600000 WHERE conversation_id=? AND sender_kind='customer'").run(id);
  const tplSends=name=>sent.filter(m=>m.type==='template'&&m.template.name===name);

  const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
  db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});assert.equal(db.prepare('PRAGMA user_version').get().user_version,39);
  await call('/api/whatsapp/numbers/'+NUMBER,admin.cookie,{brandId:'globalvet',courseId:'aves',expectedRevision:0},'PUT');
  const stranger=await call('/api/auth/register','',{username:'curiosa',name:'Persona curiosa',password});

  // 1) administración: validaciones al escribir una plantilla y borrador con los datos por su nombre
  let st=await call('/api/whatsapp/templates',admin.cookie);assert.equal(st.wabaSet,true);assert.equal(st.live,true);assert.deepEqual(st.templates,[]);assert.deepEqual(Object.keys(st.keys),['nombre','curso','edicion','marca']);
  await call('/api/whatsapp/templates',stranger.cookie,undefined,'GET',403);
  const BODY='Hola {{nombre}}, tenemos una novedad sobre tu inscripción en {{curso}}. Responde a este mensaje para verla.';
  const bad=async(over,pattern)=>assert.match((await call('/api/whatsapp/templates',admin.cookie,{brandId:'globalvet',name:'aviso_novedad',category:'utility',purpose:'notice',body:BODY,...over},'POST',400)).error,pattern);
  await bad({name:'Aviso Novedad'},/minúsculas/);await bad({body:'Hola {{1}}, tenemos una novedad para ti hoy.'},/por su nombre/);await bad({body:'{{nombre}}, tenemos una novedad sobre tu inscripción.'},/empiece o termine/);
  await bad({body:'Hola {{telefono}}, tenemos una novedad sobre tu inscripción.'},/no es un dato disponible/);await bad({body:'Hola {{nombre}} {{curso}} {{marca}}.'},/demasiados datos/);await bad({brandId:'no-existe'},/Elige la marca/);
  const draft=(await call('/api/whatsapp/templates',admin.cookie,{brandId:'globalvet',name:'aviso_novedad',category:'utility',purpose:'notice',body:BODY},'POST',201)).template;
  assert.equal(draft.status,'draft');assert.equal(draft.body,'Hola {{1}}, tenemos una novedad sobre tu inscripción en {{2}}. Responde a este mensaje para verla.');assert.deepEqual(draft.variables,['nombre','curso']);assert.match(draft.preview,/^Hola María, .* en Plan sanitario para aves\./);
  await call('/api/whatsapp/templates',admin.cookie,{brandId:'odonteck',name:'aviso_novedad',category:'utility',body:BODY},'POST',409);

  // 2) enviar a aprobación: viaja a Meta con ejemplos; después de aprobarla Meta, la sincronización la deja lista
  const pending=(await call('/api/whatsapp/templates/'+draft.id+'/submit',admin.cookie,{})).template;assert.equal(pending.status,'pending');
  assert.deepEqual(created[0],{name:'aviso_novedad',language:'es_MX',category:'UTILITY',components:[{type:'BODY',text:draft.body,example:{body_text:[['María','Plan sanitario para aves']]}}]});
  await call('/api/whatsapp/templates/'+draft.id+'/submit',admin.cookie,{},'POST',409);
  remoteTemplates.find(x=>x.name==='aviso_novedad').status='APPROVED';
  const sync=await call('/api/whatsapp/templates/sync',admin.cookie,{});assert.equal(sync.found,3);assert.equal(sync.updated,1);
  st=await call('/api/whatsapp/templates',admin.cookie);assert.equal(st.templates[0].status,'approved');
  assert.deepEqual(st.remote.map(r=>[r.name,r.complex,r.variables]),[['hello_world',false,0],['promo_con_imagen',true,1]]);
  // 3) usar una plantilla que ya existe en Meta (la de ejemplo del número de prueba); las que llevan imagen no
  await call('/api/whatsapp/templates/adopt',admin.cookie,{name:'promo_con_imagen',language:'es_MX',brandId:'globalvet',variables:['nombre']},'POST',400);
  await call('/api/whatsapp/templates/adopt',admin.cookie,{name:'hello_world',language:'en_US',brandId:'globalvet',variables:['nombre']},'POST',400);
  const hello=(await call('/api/whatsapp/templates/adopt',admin.cookie,{name:'hello_world',language:'en_US',brandId:'globalvet',variables:[]},'POST',201)).template;assert.equal(hello.status,'approved');assert.equal(hello.purpose,'manual');

  // 4) desde el chat: con la ventana abierta no hace falta; cerrada, el texto libre se rechaza y la plantilla sale por Meta
  await textIn('5215512345678','Hola, ¿cuánto cuesta?','María López');const maria=convOf('5215512345678');await settled(maria.id);
  closeWindow(maria.id);
  const list=(await call('/api/conversations/'+maria.id+'/wa-templates',admin.cookie)).templates;
  assert.deepEqual(list.map(x=>x.name),['hello_world','aviso_novedad']);assert.equal(list[1].text,'Hola María, tenemos una novedad sobre tu inscripción en Plan sanitario para aves. Responde a este mensaje para verla.');
  await call('/api/conversations/'+maria.id+'/wa-templates',stranger.cookie,undefined,'GET',403);
  assert.match((await call('/api/conversations/'+maria.id+'/messages',admin.cookie,{text:'¿Sigues interesada?',clientRef:randomUUID()},'POST',409)).error,/plantilla aprobada/);
  const ref=randomUUID(),made=await call('/api/conversations/'+maria.id+'/wa-templates',admin.cookie,{templateId:list[1].id,clientRef:ref},'POST',201);
  assert.equal((await call('/api/conversations/'+maria.id+'/wa-templates',admin.cookie,{templateId:list[1].id,clientRef:ref})).duplicate,true,'un reintento no duplica');
  await call('/api/conversations/'+maria.id+'/wa-templates',admin.cookie,{templateId:randomUUID(),clientRef:randomUUID()},'POST',404);
  const out=await until(()=>{const m=db.prepare('SELECT * FROM messages WHERE id=?').get(made.id);return m.provider_ref?m:null;},'la plantilla sale por Meta');
  assert.equal(out.sender_kind,'agent');assert.equal(out.category,'utility');assert.match(out.text,/^Hola María, tenemos una novedad/);assert.equal(JSON.parse(out.wa_template).name,'aviso_novedad');
  assert.deepEqual(tplSends('aviso_novedad').at(-1).template,{name:'aviso_novedad',language:{code:'es_MX'},components:[{type:'body',parameters:[{type:'text',text:'María'},{type:'text',text:'Plan sanitario para aves'}]}]});
  assert.equal(tplSends('aviso_novedad').length,1);assert.equal(db.prepare('SELECT assigned_to,bot_enabled FROM conversations WHERE id=?').get(maria.id).assigned_to,admin.user.id,'quien envía la plantilla queda a cargo');
  // cuando responde, se puede escribir libremente otra vez
  await textIn('5215512345678','Sí, sigo interesada','María López');await call('/api/conversations/'+maria.id+'/messages',admin.cookie,{text:'¡Qué gusto!',clientRef:randomUUID()},'POST',201);

  // 5) aviso del negocio con la ventana cerrada: sale la plantilla de aviso UNA vez y el mensaje queda en espera; al responder la persona, sale
  const ps=(await call('/api/payments/settings',admin.cookie)).settings.find(x=>x.brand_id==='globalvet');await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:ps.revision},'PATCH');
  await textIn('5215500000002','Quiero inscribirme','Rosa');
  const link=await until(()=>sent.find(m=>m.to==='5215500000002'&&/\?pay=[a-f0-9-]{36}/.test(m.text?.body||'')),'el enlace de Rosa'),order=link.text.body.match(/\?pay=([a-f0-9-]{36})/)[1],rosa=convOf('5215500000002');
  await settled(rosa.id);closeWindow(rosa.id);const before=sent.filter(m=>m.to==='5215500000002').length;
  assert.equal((await anon('/api/pay/'+order+'/pay',{method:'card',outcome:'approved'})).body.order.status,'paid','el pago no falla por la ventana');
  const held=await until(()=>db.prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_kind='automation' AND wa_hold IS NOT NULL").get(rosa.id),'la confirmación queda en espera');
  assert.equal(held.delivery_state,'sent');assert.equal(held.provider_ref,null);assert.match(held.text,/Pago confirmado/);
  const notice=await until(()=>db.prepare("SELECT * FROM messages WHERE conversation_id=? AND wa_template IS NOT NULL AND provider_ref IS NOT NULL").get(rosa.id),'el aviso sale por Meta');
  assert.match(notice.text,/^Hola Rosa, tenemos una novedad sobre tu inscripción en Plan sanitario para aves/);assert.equal(notice.sender_kind,'automation');
  await sleep(1500);
  const after=sent.filter(m=>m.to==='5215500000002').slice(before);assert.equal(after.length,1,'sólo viaja el aviso; la confirmación espera');assert.equal(after[0].type,'template');assert.deepEqual(after[0].template.components[0].parameters.map(p=>p.text),['Rosa','Plan sanitario para aves']);
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND wa_template IS NOT NULL").get(rosa.id).n,1,'un solo aviso por periodo cerrado');
  assert.equal((await call('/api/conversations/'+rosa.id+'/messages',admin.cookie)).messages.find(m=>m.id===held.id).wa_hold>0,true,'el chat sabe que está en espera');
  // responde: la confirmación en espera sale ANTES que la respuesta del asistente a su mensaje
  await textIn('5215500000002','Hola, ¿qué novedad?','Rosa');
  await until(()=>db.prepare('SELECT provider_ref FROM messages WHERE id=?').get(held.id).provider_ref,'la confirmación sale al responder');await settled(rosa.id);
  const tail=sent.filter(m=>m.to==='5215500000002').slice(before+1);assert.match(tail[0].text.body,/Pago confirmado/);assert.equal(db.prepare('SELECT wa_hold FROM messages WHERE id=?').get(held.id).wa_hold,null);

  // 6) si Meta rechaza la plantilla, el mensaje queda como no entregado con el motivo y se puede reintentar aunque la ventana siga cerrada
  closeWindow(maria.id);rejectTemplate='hello_world';
  const failing=await call('/api/conversations/'+maria.id+'/wa-templates',admin.cookie,{templateId:hello.id,clientRef:randomUUID()},'POST',201);
  const failed=await until(()=>{const m=db.prepare('SELECT * FROM messages WHERE id=?').get(failing.id);return m.delivery_state==='failed'?m:null;},'el rechazo de la plantilla');assert.match(failed.failed_reason,/no tiene esa plantilla aprobada/);
  rejectTemplate='';await call('/api/messages/'+failing.id+'/retry',admin.cookie,{});
  await until(()=>db.prepare('SELECT provider_ref FROM messages WHERE id=?').get(failing.id).provider_ref,'el reintento de la plantilla sale');assert.deepEqual(tplSends('hello_world').at(-1).template,{name:'hello_world',language:{code:'en_US'}});

  // 7) sin plantilla de aviso, el aviso del negocio no sale y lo dice; un mensaje en espera que nadie libera caduca
  await textIn('5215500000003','Quiero inscribirme','Ana');
  const link2=await until(()=>sent.find(m=>m.to==='5215500000003'&&/\?pay=/.test(m.text?.body||'')),'el enlace de Ana'),order2=link2.text.body.match(/\?pay=([a-f0-9-]{36})/)[1],ana=convOf('5215500000003');await settled(ana.id);closeWindow(ana.id);
  const cur=(await call('/api/whatsapp/templates',admin.cookie)).templates.find(x=>x.name==='aviso_novedad');
  assert.equal((await call('/api/whatsapp/templates/'+cur.id,admin.cookie,{purpose:'manual',expectedRevision:cur.revision},'PATCH')).template.purpose,'manual');
  await call('/api/whatsapp/templates/'+cur.id,admin.cookie,{purpose:'notice',expectedRevision:cur.revision},'PATCH',409);
  await anon('/api/pay/'+order2+'/pay',{method:'card',outcome:'approved'});
  const unsent=await until(()=>db.prepare("SELECT * FROM messages WHERE conversation_id=? AND delivery_state='failed'").get(ana.id),'sin plantilla de aviso no sale');assert.match(unsent.failed_reason,/plantilla de aviso aprobada/);assert.equal(tplSends('aviso_novedad').filter(m=>m.to==='5215500000003').length,0);
  // caducidad: se vuelve a dejar como aviso, otra persona paga tarde y nunca responde
  await call('/api/whatsapp/templates/'+cur.id,admin.cookie,{purpose:'notice',expectedRevision:cur.revision+1},'PATCH');
  await textIn('5215500000004','Quiero inscribirme','Paco');
  const link3=await until(()=>sent.find(m=>m.to==='5215500000004'&&/\?pay=/.test(m.text?.body||'')),'el enlace de Paco'),order3=link3.text.body.match(/\?pay=([a-f0-9-]{36})/)[1],paco=convOf('5215500000004');await settled(paco.id);closeWindow(paco.id);
  await anon('/api/pay/'+order3+'/pay',{method:'card',outcome:'approved'});
  const waiting=await until(()=>db.prepare("SELECT * FROM messages WHERE conversation_id=? AND wa_hold IS NOT NULL").get(paco.id),'la confirmación de Paco en espera');
  db.prepare('UPDATE messages SET created_at=created_at-8*86400000 WHERE id=?').run(waiting.id);
  const expired=await until(()=>{const m=db.prepare('SELECT * FROM messages WHERE id=?').get(waiting.id);return m.delivery_state==='failed'?m:null;},'el mensaje en espera caduca');assert.match(expired.failed_reason,/caducó/);assert.equal(expired.wa_hold,null);

  // 8) quitar una plantilla sólo la quita del CRM; los mensajes ya enviados conservan su texto
  await call('/api/whatsapp/templates/'+hello.id,admin.cookie,undefined,'DELETE');assert.equal((await call('/api/conversations/'+maria.id+'/wa-templates',admin.cookie)).templates.some(x=>x.name==='hello_world'),false);
  assert.match(db.prepare('SELECT text FROM messages WHERE id=?').get(failing.id).text,/^Welcome and congratulations/);
  assert.equal(logs.includes(TOKEN),false);
});
