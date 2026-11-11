import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

// Banco de frases realistas (docs/PLAN_MOTOR_PRECISO.md). Una regla demasiado amplia contesta MAL y gratis; estas frases fijan la ruta correcta.
// ruta: cat = catálogo por reglas · kb = conocimiento aprobado · per = pasa a una persona · ia = llega a la IA · gen = respuesta genérica (nada parecido en el conocimiento)
const BANK=[
 // lo de siempre sigue igual
 ['Hola, me interesa el curso','greeting','cat'],['¿Cuánto cuesta?','price','cat'],['cuanto sale el curso','price','cat'],['en cuanto me queda','price','cat'],
 ['¿Cuándo empieza?','schedule','cat'],['que dia inicia','schedule','cat'],['¿Qué temas incluye?','syllabus','cat'],['Quiero inscribirme','enroll','cat'],
 ['Quiero hablar con un asesor','human','per'],['Quiero un reembolso','refund','per'],['Ya pagué, les mando el comprobante','payment','per'],
 ['¿Entregan certificado?','certificate','kb'],['¿Se graba la clase?','recording','kb'],['¿Cuánto dura el curso?','duration','kb'],['¿Aceptan tarjeta?','payment','kb'],
 ['Gracias, lo voy a pensar y les aviso.','thanks','cat'],['Ok, gracias. Lo platico en casa y les escribo.','thanks','cat'],['ok perfecto','thanks','cat'],
 // precisión nueva: antes caían en la ficha equivocada
 ['¿Qué voy a saber hacer cuando termine?','unknown',null],        // «cuando» no es una pregunta de fechas
 ['cuando me mandan el link de la clase','unknown',null],
 ['el curso vale la pena?','unknown',null],                       // «vale» no es precio ni agradecimiento
 ['cuanto tiempo tengo para pagar','payment','kb'],               // no es la duración del curso
 ['¿Quién da el curso?','schedule','cat'],                        // docente: ficha de la edición, no «¿para quién es el curso?»
 ['a que hora son las clases','schedule','cat'],
 ['tienen alguna promo','price','cat'],['¿cuánto hay que pagar?','price','cat'],
 ['como me apunto','enroll','cat'],['ya quiero entrar al curso','enroll','cat'],
 ['me pueden llamar','human','per'],
 ['donde me conecto','modality','kb'],
 ['¿dan apuntes de las clases?','unknown',null],                  // «apuntes» no es «apuntarme»: no debe crear un pedido
 ['quiero saber si aplica para alguien que apenas va empezando','unknown',null],   // «alguien» suelto no pide un asesor
 ['¿es para una persona sin experiencia?','unknown',null],
 ['quiero hablar con una persona','human','per'],['¿alguien me puede ayudar?','human','per'],['necesito que alguien me atienda','human','per'],
];

test('reglas de intención: cada frase del banco va a la ruta correcta y las respuestas de la IA se distinguen en el chat',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-intents-')),code=randomUUID(),password='Password-intents-2026!';let logs='',db=null;
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',AI_PROVIDER:'',ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:''},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{try{db?.close();}catch{}if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const csv=await readFile('docs/ejemplos/conocimiento-globalvet-prueba.csv','utf8');
 const pre=await call('/api/knowledge-import/preview',admin.cookie,{csv});await call('/api/knowledge-import/apply',admin.cookie,{csv,fileHash:pre.fileHash});
 db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});db.prepare("UPDATE knowledge_entries SET status='approved' WHERE brand_id='globalvet'").run();
 const rs=(await call('/api/replies/settings',admin.cookie)).settings.find(x=>x.brand_id==='globalvet');
 await call('/api/replies/brands/globalvet',admin.cookie,{mode:'autonomous',providerEnabled:true,expectedRevision:rs.revision},'PATCH');
 const sim=async text=>(await call('/api/replies/test',admin.cookie,{brandId:'globalvet',text})).result;
 const route=r=>{const types=[...new Set(r.sources.map(s=>s.type))];return r.handoff&&['human','refund','payment'].includes(r.intent)?'per':r.provider.used?'ia':types.includes('knowledge')?'kb':types.includes('catalogue')||['thanks','opt_out'].includes(r.intent)?'cat':'gen';};
 const wrong=[];
 for(const [text,intent,want] of BANK){const r=await sim(text),got=route(r);
  if(r.intent!==intent)wrong.push(text+' → intención «'+r.intent+'», esperaba «'+intent+'»');
  else if(want&&got!==want)wrong.push(text+' → ruta «'+got+'», esperaba «'+want+'» ('+r.reason.slice(0,60)+')');
  else if(!want&&!['ia','gen','kb'].includes(got))wrong.push(text+' → ruta «'+got+'»: una pregunta sin intención clara no debe contestarse con la ficha del catálogo');}
 assert.deepEqual(wrong,[]);
 // dos respuestas que antes eran falsas, vistas completas
 const pay=await sim('cuanto tiempo tengo para pagar');assert.doesNotMatch(pay.reason,/Cuánto dura/,'no se contesta con la duración del curso');
 const who=await sim('¿Quién da el curso?');assert.doesNotMatch(who.reason,/Para quién es el curso/);
 const notes=await sim('¿dan apuntes de las clases?');assert.equal(notes.stage,null,'«apuntes» no avanza a inscripción');

 // en el chat: lo que redactó la IA se marca aparte de lo que salió por reglas
 const ana=await call('/api/auth/register','',{username:'ana',name:'Ana Pérez',password});
 const course=db.prepare("SELECT c.id FROM courses c JOIN editions e ON e.course_id=c.id WHERE c.brand_id='globalvet' AND c.active=1 AND e.status='published' ORDER BY c.title LIMIT 1").get().id;
 const conv=(await call('/api/conversations',ana.cookie,{courseId:course,channel:'whatsapp'})).conversation.id;
 const say=async text=>{const n=db.prepare('SELECT count(*) n FROM reply_log WHERE conversation_id=?').get(conv).n;await call('/api/conversations/'+conv+'/messages',ana.cookie,{text,clientRef:randomUUID()},'POST',201);for(let i=0;i<40;i++){await sleep(150);if(db.prepare('SELECT count(*) n FROM reply_log WHERE conversation_id=?').get(conv).n>n)return;}assert.fail('sin decisión del motor para «'+text+'»');};
 await say('¿Cuánto cuesta?');await say('¿Qué temas incluye?');
 // la segunda respuesta la «redactó la IA»: así queda en la bitácora cuando el motor acepta un borrador del proveedor
 {const last=db.prepare("SELECT id FROM reply_log WHERE conversation_id=? AND reply_message_id IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1").get(conv);db.prepare("UPDATE reply_log SET model='claude-sonnet-5-5',reason='Proveedor de IA: Redactado por el proveedor con 1 fuente(s); confianza 90%.' WHERE id=?").run(last.id);}
 const seen=u=>call('/api/conversations/'+conv+'/messages',u.cookie).then(r=>r.messages.filter(m=>m.sender_kind==='automation').map(m=>m.ai_drafted));
 assert.deepEqual(await seen(admin),[0,1],'el equipo ve cuál respuesta redactó la IA');assert.deepEqual(await seen(ana),[0,1],'y el cliente también');
});
