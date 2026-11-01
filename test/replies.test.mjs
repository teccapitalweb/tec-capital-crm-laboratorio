import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {similarity,bestMatch,tokens,createAiProvider,validateDraft,linkKeys} from '../server/ai-provider.mjs';
import {DEMO_KNOWLEDGE} from '../server/replies-schema.mjs';

test('parecido léxico: raíces, variantes y umbral',async()=>{
  const kb=DEMO_KNOWLEDGE.map((k,i)=>({...k,id:'k'+i}));
  assert.ok(similarity('¿Entregan constancia al terminar?',kb[0])>=.5);assert.ok(similarity('¿Me dan certificado al terminar?',kb[0])<.5);   // esa frase la resuelve la intención, no el parecido
  assert.ok(similarity('¿Qué formas de pago tienen?',kb[1])>=.5);
  assert.ok(similarity('Si falto a una clase, ¿queda la grabación?',kb[4])>=.5);
  assert.equal(bestMatch('¿cuánto dura y cuántas sesiones son?',kb).entry.topic,'duration');
  assert.equal(bestMatch('hola buenas tardes',kb),null);assert.equal(bestMatch('',kb),null);
  assert.deepEqual(tokens('¿Me dan el certificado?'),['dan','certificado']);
  const sim=createAiProvider({env:{}});assert.equal(sim.name,'simulated');assert.equal(sim.configured,true);
  const d=await sim.draft({question:'¿ustedes entregan constancia o diploma?',knowledge:kb});assert.equal(d.usedIds[0],'k0');assert.match(d.text,/certificado IPCI/);
  const none=await sim.draft({question:'¿venden cafeteras?',knowledge:kb});assert.equal(none.text,null);
  const claude=createAiProvider({env:{AI_PROVIDER:'claude'}});assert.equal(claude.name,'claude');assert.equal(claude.configured,false);assert.equal(claude.model,'claude-opus-5-5');
  const r=await claude.draft({brand:{name:'x'},question:'q',knowledge:kb,history:[]});assert.equal(r.text,null);assert.match(r.reason,/credenciales/);
});

test('el texto del proveedor se valida en código antes de llegar al cliente',()=>{
  const kb=[{id:'k1',question:'¿Cómo pago?',answer:'Pagas desde el enlace oficial https://pagos.ejemplo.mx/curso'},{id:'k2',question:'¿Hay certificado?',answer:'Sí, con QR.'}];
  const ok=validateDraft({text:'Pagas desde el enlace oficial https://pagos.ejemplo.mx/curso y luego te confirmamos por aquí.',usedIds:['k1'],confidence:.8},kb);
  assert.equal(ok.ok,true);assert.deepEqual(ok.usedIds,['k1']);
  const cases=[
    [{text:'Claro, el curso cuesta $1,200 MXN.',usedIds:['k1'],confidence:.9},/precio o importe/],
    [{text:'Son 1200 pesos en total.',usedIds:['k1'],confidence:.9},/precio o importe/],
    [{text:'Listo, tu pago confirmado, ya quedaste inscrita.',usedIds:['k2'],confidence:.9},/no permitido/],
    [{text:'Te hago un descuento si pagas hoy.',usedIds:['k2'],confidence:.9},/no permitido/],
    [{text:'Entra a https://sitio-ajeno.com/pagar para pagar.',usedIds:['k1'],confidence:.9},/enlace|dominio/],
    [{text:'Entra a sitio-ajeno.com/pagar para pagar.',usedIds:['k1'],confidence:.9},/sitio-ajeno\.com/],
    [{text:'Visita www.pagos-rapidos.mx hoy.',usedIds:['k1'],confidence:.9},/pagos-rapidos\.mx/],
    [{text:'Usa el acortador bit.ly/abc123 para pagar.',usedIds:['k1'],confidence:.9},/bit\.ly/],
    [{text:'Paga en PAGOS.EJEMPLO.MX.evil.com/curso ahora.',usedIds:['k1'],confidence:.9},/evil\.com/],
    [{text:'Entra a xn--pgos-hqa.com para pagar.',usedIds:['k1'],confidence:.9},/xn--pgos-hqa\.com/],
    [{text:'Respuesta sin fuente.',usedIds:[],confidence:.9},/ninguna entrada/],
    [{text:'Respuesta con fuente inventada.',usedIds:['zzz'],confidence:.9},/ninguna entrada/],
    [{text:'Respuesta dudosa.',usedIds:['k2'],confidence:.2},/Confianza/],
    [{text:null,usedIds:['k2']},/Sin texto/],
  ];
  for(const [draft,re] of cases){const r=validateDraft(draft,kb);assert.equal(r.ok,false,JSON.stringify(draft));assert.match(r.reason,re);}
  assert.equal(validateDraft({text:'Sí, con QR verificable.',usedIds:['k2']},kb).ok,true);   // sin confianza declarada no se bloquea por ese criterio
  assert.equal(validateDraft({text:'Paga en pagos.ejemplo.mx/curso cuando quieras.',usedIds:['k1'],confidence:.9},kb).ok,true);   // dominio pelón del conocimiento: permitido
  assert.equal(validateDraft({text:'La sesión es a las 10 a.m. y, p. ej., puedes conectarte 5 min antes. Atte. Lic. Gómez.',usedIds:['k2'],confidence:.9},kb).ok,true);   // abreviaturas no cuentan como dominios
  assert.deepEqual(linkKeys('ve a https://www.Pagos.Ejemplo.MX/curso/?x=1 o a bit.ly/z, no a 10 a.m.').map(l=>l.key),['pagos.ejemplo.mx/curso?x=1','bit.ly/z']);
  // misma marca, otra ruta: no basta compartir dominio
  assert.match(validateDraft({text:'Paga en https://pagos.ejemplo.mx/otra-ruta ahora.',usedIds:['k1'],confidence:.9},kb).reason,/no coincide exactamente/);
  // trucos de analizador: usuario@host, barra invertida y escapes porcentuales en el dominio
  for(const evil of ['https://evil.com\\@pagos.ejemplo.mx/curso','https://pagos.ejemplo.mx@evil.com/curso','pagos.ejemplo.mx%40evil.com/curso','https://evil.com\\pagos.ejemplo.mx/curso'])assert.equal(validateDraft({text:'Entra a '+evil+' y paga.',usedIds:['k1'],confidence:.9},kb).ok,false,evil);
});

test('motor de respuestas v2: conocimiento, niveles por marca, bitácora, sugerencias y escalamiento',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'crm-replies-')),code=randomUUID(),password='Password-replies-2026!';let logs='';
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',AI_PROVIDER:'',ANTHROPIC_API_KEY:''},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
  async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const reg=(username,inviteCode)=>call('/api/auth/register','',{username,name:'Prueba '+username,password,inviteCode});
  const admin=await reg('admin',code),agent=await reg('asesor'),other=await reg('asesor.otro');
  for(const [u,name,brandIds] of [[agent,'asesor',['globalvet']],[other,'asesor.otro',['odonteck']]]){const inv=await call('/api/team/invites',admin.cookie,{username:name,brandIds},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});}
  const clients=[];for(let i=1;i<=5;i++)clients.push(await reg('cliente'+i));
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const say=async(client,conv,text)=>{await call('/api/conversations/'+conv.id+'/messages',client.cookie,{text,clientRef:randomUUID()},'POST',201);};
  const waitReply=async(client,conv,count)=>{let msgs;for(let i=0;i<40;i++){await sleep(150);msgs=(await call('/api/conversations/'+conv.id+'/messages',client.cookie)).messages.filter(m=>m.sender_kind==='automation');if(msgs.length>=count)return msgs;}return msgs;};
  const q=(sql,...args)=>{const d=new DatabaseSync(join(dir,'laboratorio.sqlite'),{readOnly:true});try{return d.prepare(sql).get(...args);}finally{d.close();}};

  await t.test('conocimiento sembrado, permisos y validación',async()=>{
    const all=await call('/api/replies/knowledge',admin.cookie);assert.equal(all.entries.length,3*DEMO_KNOWLEDGE.length);assert.ok(all.entries.every(e=>e.status==='approved'));
    const mine=await call('/api/replies/knowledge',agent.cookie);assert.ok(mine.entries.length===DEMO_KNOWLEDGE.length&&mine.entries.every(e=>e.brand_id==='globalvet'));
    await call('/api/replies/knowledge',clients[0].cookie,undefined,'GET',403);
    await call('/api/replies/knowledge',agent.cookie,{brandId:'odonteck',topic:'x',question:'¿Pregunta ajena?',answer:'Respuesta suficientemente larga.'},'POST',404);
    await call('/api/replies/knowledge',agent.cookie,{brandId:'globalvet',topic:'x',question:'¿Cuánto cuesta?',answer:'Cuesta $500 pesos cada módulo.'},'POST',400);   // precios no van en conocimiento
    await call('/api/replies/knowledge',agent.cookie,{brandId:'globalvet',topic:'x',question:'Corta',answer:'Respuesta suficientemente larga.'},'POST',400);
    const draft=(await call('/api/replies/knowledge',agent.cookie,{brandId:'globalvet',topic:'parking',question:'¿Hay estacionamiento en la sede?',variants:'estacionamiento\ndonde me estaciono; parking',answer:'La sede cuenta con estacionamiento gratuito para asistentes, sujeto a disponibilidad.'},'POST',201)).entry;
    assert.equal(draft.status,'draft');assert.deepEqual(draft.variants,['estacionamiento','donde me estaciono','parking']);
    await call('/api/replies/knowledge/'+draft.id+'/approve',agent.cookie,{expectedRevision:draft.revision},'POST',403);
    await call('/api/replies/knowledge/'+draft.id+'/approve',other.cookie,{expectedRevision:draft.revision},'POST',403);
    await call('/api/replies/knowledge/'+draft.id+'/approve',admin.cookie,{expectedRevision:99},'POST',409);
    const approved=(await call('/api/replies/knowledge/'+draft.id+'/approve',admin.cookie,{expectedRevision:draft.revision})).entry;assert.equal(approved.status,'approved');
    const edited=(await call('/api/replies/knowledge/'+draft.id,agent.cookie,{expectedRevision:approved.revision,answer:'La sede cuenta con estacionamiento gratuito para asistentes; llega 15 minutos antes.'},'PATCH')).entry;
    assert.equal(edited.status,'draft');                                                                     // editar vuelve a borrador
    assert.equal((await call('/api/replies/knowledge/'+draft.id+'/history',admin.cookie)).versions.length,3);
    await call('/api/replies/knowledge/'+draft.id+'/approve',admin.cookie,{expectedRevision:edited.revision});
  });

  await t.test('simulación sin efectos y respuestas con fuente',async()=>{
    const before=q('SELECT count(*) n FROM reply_log').n;
    const price=(await call('/api/replies/test',admin.cookie,{brandId:'globalvet',text:'¿Cuánto cuesta el curso?'})).result;
    assert.equal(price.intent,'price');assert.ok(price.sources.some(s=>s.type==='catalogue'&&s.priceCents>0));assert.match(price.reply,/precio de ejemplo/i);
    const cert=(await call('/api/replies/test',admin.cookie,{brandId:'globalvet',text:'¿Me dan un certificado con validez?'})).result;
    assert.equal(cert.intent,'certificate');assert.ok(cert.sources.some(s=>s.type==='knowledge'));assert.match(cert.reply,/IPCI/);
    const parking=(await call('/api/replies/test',admin.cookie,{brandId:'globalvet',text:'¿dónde me estaciono si voy?'})).result;
    assert.equal(parking.intent,'unknown');assert.match(parking.reply,/estacionamiento/);assert.match(parking.reason,/Conocimiento aprobado/);
    const otherBrand=(await call('/api/replies/test',admin.cookie,{brandId:'odonteck',text:'¿dónde me estaciono si voy?'})).result;
    assert.ok(!/estacionamiento/.test(otherBrand.reply));                                                   // el conocimiento no cruza marcas
    const refund=(await call('/api/replies/test',admin.cookie,{brandId:'globalvet',text:'quiero un reembolso, esto es un fraude'})).result;assert.equal(refund.intent,'refund');assert.equal(refund.handoff,true);
    await call('/api/replies/test',agent.cookie,{brandId:'odonteck',text:'hola'},'POST',404);
    assert.equal(q('SELECT count(*) n FROM reply_log').n,before);
    assert.equal(q("SELECT count(*) n FROM messages WHERE conversation_id='simulacion'").n,0);
  });

  await t.test('nivel plantillas: responde, registra fuentes y escala tras el máximo sin reconocer',async()=>{
    const conv=(await call('/api/conversations',clients[0].cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
    await say(clients[0],conv,'Hola, me interesa');await waitReply(clients[0],conv,1);
    await say(clients[0],conv,'¿Si falto a una clase queda grabado?');const r2=await waitReply(clients[0],conv,2);assert.match(r2[1].text,/graba/);
    const log=(await call('/api/conversations/'+conv.id+'/replies',agent.cookie)).log;
    assert.deepEqual(log.map(l=>l.intent).reverse(),['greeting','recording']);assert.ok(log[0].sources.some(s=>s.type==='knowledge'));assert.equal(log[0].action,'replied');assert.ok(log[0].reply_message_id);
    await call('/api/conversations/'+conv.id+'/replies',clients[0].cookie,undefined,'GET',403);await call('/api/conversations/'+conv.id+'/replies',other.cookie,undefined,'GET',404);
    await say(clients[0],conv,'xyzzy plugh');const r3=await waitReply(clients[0],conv,3);assert.match(r3[2].text,/precio, el temario o la fecha/);
    await say(clients[0],conv,'qwerty asdf');const r4=await waitReply(clients[0],conv,4);assert.match(r4[3].text,/persona del equipo/);
    const after=(await call('/api/conversations/'+conv.id,clients[0].cookie)).conversation;assert.equal(after.bot_enabled,0);assert.equal(after.status,'waiting');
    assert.equal((await call('/api/conversations/'+conv.id+'/replies',agent.cookie)).log[0].action,'escalated');
  });

  await t.test('nivel sugerir: no envía, deja la sugerencia y se consume cuando responde una persona',async()=>{
    const s=(await call('/api/replies/settings',admin.cookie)).settings.find(x=>x.brand_id==='globalvet');assert.equal(s.mode,'templates');assert.equal(s.revision,0);
    await call('/api/replies/brands/globalvet',agent.cookie,{mode:'suggest',expectedRevision:0},'PATCH',403);
    await call('/api/replies/brands/globalvet',admin.cookie,{mode:'volador',expectedRevision:0},'PATCH',400);
    const set=(await call('/api/replies/brands/globalvet',admin.cookie,{mode:'suggest',expectedRevision:0},'PATCH')).settings;assert.equal(set.mode,'suggest');assert.equal(set.revision,1);
    await call('/api/replies/brands/globalvet',admin.cookie,{mode:'templates',expectedRevision:0},'PATCH',409);
    const conv=(await call('/api/conversations',clients[1].cookie,{courseId:'aves',channel:'instagram'})).conversation;
    await say(clients[1],conv,'¿Cuál es el precio?');await sleep(1500);
    assert.equal((await call('/api/conversations/'+conv.id+'/messages',clients[1].cookie)).messages.filter(m=>m.sender_kind==='automation').length,0);
    const view=await call('/api/conversations/'+conv.id+'/replies',agent.cookie);assert.equal(view.suggestion.intent,'price');assert.match(view.suggestion.reply_text,/precio/i);
    const c=(await call('/api/conversations/'+conv.id,agent.cookie)).conversation;assert.equal(c.status,'waiting');
    await call('/api/conversations/'+conv.id+'/messages',agent.cookie,{text:'Hola, te comparto el precio…',clientRef:randomUUID()},'POST',201);
    assert.equal((await call('/api/conversations/'+conv.id+'/replies',agent.cookie)).suggestion,null);
    const conv2=(await call('/api/conversations',clients[2].cookie,{courseId:'nutricion',channel:'whatsapp'})).conversation;
    await say(clients[2],conv2,'¿Tienen certificado?');await sleep(1200);assert.ok((await call('/api/conversations/'+conv2.id+'/replies',agent.cookie)).suggestion);
    await call('/api/conversations/'+conv2.id+'/replies/dismiss',agent.cookie,{},'POST');assert.equal((await call('/api/conversations/'+conv2.id+'/replies',agent.cookie)).suggestion,null);
  });

  await t.test('nivel apagado y nivel autónomo con proveedor simulado',async()=>{
    await call('/api/replies/brands/globalvet',admin.cookie,{mode:'off',expectedRevision:1},'PATCH');
    const conv=(await call('/api/conversations',clients[3].cookie,{courseId:'aves',channel:'facebook'})).conversation;
    await say(clients[3],conv,'Hola');await sleep(1200);
    assert.equal((await call('/api/conversations/'+conv.id+'/messages',clients[3].cookie)).messages.filter(m=>m.sender_kind==='automation').length,0);
    const v=await call('/api/conversations/'+conv.id+'/replies',agent.cookie);assert.equal(v.log[0].action,'skipped');assert.equal(v.suggestion,null);
    assert.equal((await call('/api/conversations/'+conv.id,agent.cookie)).conversation.status,'waiting');
    await call('/api/replies/brands/globalvet',admin.cookie,{mode:'autonomous',providerEnabled:true,maxUnknown:3,expectedRevision:2},'PATCH');
    const conv2=(await call('/api/conversations',clients[4].cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
    await say(clients[4],conv2,'Hola');await waitReply(clients[4],conv2,1);
    await say(clients[4],conv2,'¿ustedes entregan constancia o diploma avalado?');const r=await waitReply(clients[4],conv2,2);
    assert.match(r[1].text,/certificado IPCI/);
    const log=(await call('/api/conversations/'+conv2.id+'/replies',admin.cookie)).log[0];assert.equal(log.intent,'certificate');
    await say(clients[4],conv2,'¿puedo ir con mi perro al evento?');const r3=await waitReply(clients[4],conv2,3);
    const last=(await call('/api/conversations/'+conv2.id+'/replies',admin.cookie)).log[0];
    assert.equal(last.intent,'unknown');assert.equal(last.model,'simulado');assert.match(last.reason,/Proveedor/);assert.equal(r3.length,3);
  });

  await t.test('marca nueva recibe conocimiento de demostración',async()=>{
    const b=await call('/api/brands',admin.cookie,{name:'Marca Prueba Conocimiento'},'POST',201);
    const id=b.brand?.id||b.id;assert.ok(id);
    assert.equal(q('SELECT count(*) n FROM knowledge_entries WHERE brand_id=?',id).n,DEMO_KNOWLEDGE.length);
  });
});
