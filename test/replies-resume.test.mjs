import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('un chat que sólo esperaba por el nivel «Sugerir» vuelve a contestarse solo cuando la marca pasa a responder; los escalados y los tomados por una persona no',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-resume-')),code=randomUUID(),password='Password-resume-2026!';let logs='',db=null;
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',AI_PROVIDER:'',ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:''},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{try{db?.close();}catch{}if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const customer=async name=>call('/api/auth/register','',{username:name,name:'Cliente '+name,password});
 const mode=async m=>{const rs=(await call('/api/replies/settings',admin.cookie)).settings.find(x=>x.brand_id==='globalvet');await call('/api/replies/brands/globalvet',admin.cookie,{mode:m,providerEnabled:false,expectedRevision:rs.revision},'PATCH');};
 const conv=id=>({...db.prepare('SELECT status,bot_enabled,assigned_to FROM conversations WHERE id=?').get(id)});
 const bot=id=>db.prepare("SELECT text FROM messages WHERE conversation_id=? AND sender_kind='automation' ORDER BY seq").all(id).map(m=>m.text);
 // escribe como cliente y espera a que el motor termine de decidir (queda una fila nueva en reply_log, o nada si nadie debía contestar)
 const say=async (u,id,text,expectLog=true)=>{const before=db.prepare('SELECT count(*) n FROM reply_log WHERE conversation_id=?').get(id).n;await call('/api/conversations/'+id+'/messages',u.cookie,{text,clientRef:randomUUID()},'POST',201);
  for(let i=0;i<(expectLog?30:12);i++){await sleep(150);if(db.prepare('SELECT count(*) n FROM reply_log WHERE conversation_id=?').get(id).n>before)return true;}assert.equal(expectLog,false,'el motor no registró decisión para «'+text+'»');return false;};
 const open=async u=>(await call('/api/conversations',u.cookie,{courseId:'aves',channel:'whatsapp'})).conversation.id;

 // 1) en «Sugerir» el primer mensaje deja borrador y el chat queda esperando a una persona; el siguiente mensaje no genera nada
 await mode('suggest');
 const ana=await customer('ana'),a=await open(ana);
 await say(ana,a,'Hola, me interesa el curso');assert.deepEqual(conv(a),{status:'waiting',bot_enabled:0,assigned_to:null});assert.equal(bot(a).length,0,'en sugerir no se envía nada al cliente');
 await say(ana,a,'¿Cuánto cuesta?',false);assert.equal(bot(a).length,0,'esperando a un asesor: el motor no vuelve a actuar');
 assert.ok((await call('/api/conversations/'+a+'/replies',admin.cookie)).suggestion,'hay un borrador pendiente para el equipo');

 // 2) la marca pasa a responder sola: el MISMO chat se reanuda con el siguiente mensaje del cliente
 await mode('autonomous');
 await say(ana,a,'¿Cuánto cuesta?');assert.deepEqual(conv(a),{status:'open',bot_enabled:1,assigned_to:null});
 assert.equal(bot(a).length,1);assert.match(bot(a)[0],/\$\d/,'responde el precio del catálogo');
 assert.equal((await call('/api/conversations/'+a+'/replies',admin.cookie)).suggestion,null,'el borrador viejo ya no queda pendiente');
 assert.equal(db.prepare('SELECT waiting_since FROM service_state WHERE conversation_id=?').get(a).waiting_since,null,'deja de contar como espera de una persona');
 await say(ana,a,'¿Qué temas incluye?');assert.equal(bot(a).length,2,'y sigue contestando sola');

 // 3) lo que se escaló a una persona NO se reanuda: el cliente pidió un asesor
 await say(ana,a,'Quiero hablar con un asesor');assert.equal(conv(a).bot_enabled,0);assert.equal(conv(a).status,'waiting');const n=bot(a).length;
 await say(ana,a,'¿Cuánto cuesta?',false);assert.equal(bot(a).length,n,'tras pedir una persona, el asistente no se mete');assert.equal(conv(a).bot_enabled,0);

 // 4) un chat que una persona tomó tampoco se reanuda
 await mode('suggest');const beto=await customer('beto'),b=await open(beto);await say(beto,b,'Hola, me interesa el curso');
 await call('/api/conversations/'+b+'/action',admin.cookie,{action:'take'});await mode('autonomous');
 await say(beto,b,'¿Cuánto cuesta?',false);assert.equal(bot(b).length,0);assert.equal(conv(b).bot_enabled,0);assert.equal(conv(b).assigned_to!==null,true);

 // 5) y si la marca sigue en «Sugerir», nada cambia
 await mode('suggest');const caro=await customer('caro'),c=await open(caro);await say(caro,c,'Hola, me interesa el curso');
 await say(caro,c,'¿Cuánto cuesta?',false);assert.deepEqual(conv(c),{status:'waiting',bot_enabled:0,assigned_to:null});assert.equal(bot(c).length,0);
});
