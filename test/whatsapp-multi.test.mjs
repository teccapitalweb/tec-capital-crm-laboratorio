import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {hmacHex} from '../server/connectors.mjs';
import {matchCourse,byNumber} from '../server/course-match.mjs';

// Un número de WhatsApp para toda la consultora (docs/PLAN_NUMERO_POR_CONSULTORA.md): el curso lo decide el anuncio, lo que la persona escribe o la
// lista que el asistente le ofrece; y se puede cambiar de curso en el mismo chat.
const TOKEN='EAAprueba0000000000000000000000token',SECRET='app-secret-prueba',NUMBER='109000000000001',OTHER='109000000000002';

test('reconocer el curso: sólo deciden las palabras propias de un curso; a media conversación hace falta además una señal',()=>{
  const list=[{id:'c',title:'Nutrición clínica canina y felina'},{id:'n',title:'Nutrición en perros y gatos'},{id:'a',title:'Plan sanitario para aves'}];
  assert.equal(matchCourse(list,'Hola, quiero información del curso de aves')?.id,'a');assert.equal(matchCourse(list,'aves')?.id,'a');
  assert.equal(matchCourse(list,'el de perros')?.id,'n');assert.equal(matchCourse(list,'nutrición canina')?.id,'c');
  assert.equal(matchCourse(list,'el de nutrición'),null,'«nutrición» está en dos cursos: no decide');assert.equal(matchCourse(list,'hola buenas tardes'),null);assert.equal(matchCourse(list,''),null);
  assert.equal(matchCourse(list,'quiero un curso'),null,'las palabras genéricas no deciden');
  // a media conversación
  assert.equal(matchCourse(list,'tengo 200 aves ponedoras, ¿me sirve?',{strict:true}),null);assert.equal(matchCourse(list,'¿y el de aves cuánto cuesta?',{strict:true})?.id,'a');
  assert.equal(matchCourse(list,'también me interesa aves',{strict:true})?.id,'a');assert.equal(matchCourse(list,'plan sanitario aves',{strict:true})?.id,'a','dos palabras propias bastan');
  assert.equal(byNumber(list,'2')?.id,'n');assert.equal(byNumber(list,' 3. ')?.id,'a');assert.equal(byNumber(list,'9'),null);assert.equal(byNumber(list,'2 personas'),null);assert.equal(byNumber(list,'0'),null);
});

test('un número para toda la marca: pregunta el curso, lo reconoce por anuncio o por texto, y cambia de curso en el mismo chat',async t=>{
  const sent=[];let n=0;
  const stub=createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const u=new URL(req.url,'http://x'),send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};let x;
    if((x=u.pathname.match(/^\/v25\.0\/(\d+)\/messages$/))&&req.method==='POST'){const body=JSON.parse(Buffer.concat(chunks).toString());sent.push({from:x[1],to:body.to,text:body.text?.body||body.interactive?.body?.text||body.image?.caption||''});return send(200,{messages:[{id:'wamid.out'+(++n)}]});}
    if(u.pathname.endsWith('/media'))return send(200,{id:'media-'+(++n)});
    send(404,{error:{code:100,message:'ruta desconocida'}});});});
  await new Promise(r=>stub.listen(0,'127.0.0.1',r));
  // Anthropic de mentira: guarda lo que recibe y cita una entrada del conocimiento recibido
  const prompts=[];
  const ai=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{prompts.push(raw);const body=JSON.parse(raw),id=(String(body.system).match(/\[([0-9a-f-]{36})\] P:/)||[])[1];
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'msg_'+prompts.length,type:'message',role:'assistant',model:'claude-sonnet-5-5',content:[{type:'text',text:JSON.stringify({answer:'Sí: el curso es en línea, así que puedes tomarlo desde cualquier lugar.',used_ids:[id],confidence:0.9})}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:300,output_tokens:60}}));});});
  await new Promise(r=>ai.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>ai.close(r)));
  const dir=await mkdtemp(join(tmpdir(),'crm-wa-multi-')),code=randomUUID(),password='Password-multi-2026!';let logs='',db=null;
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',AI_PROVIDER:'claude',ANTHROPIC_API_KEY:'sk-ant-prueba-local',ANTHROPIC_AUTH_TOKEN:'',ANTHROPIC_BASE_URL:'http://127.0.0.1:'+ai.address().port,AI_MONTHLY_CALL_LIMIT:'50',AI_MONTHLY_TOKEN_LIMIT:'',CHANNEL_CONNECTOR:'meta',META_ACCESS_TOKEN:TOKEN,META_APP_SECRET:SECRET,META_VERIFY_TOKEN:'verifica-123',META_PHONE_NUMBER_ID:NUMBER,META_GRAPH_URL:'http://127.0.0.1:'+stub.address().port,META_GRAPH_VERSION:''},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{try{db?.close();}catch{}if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await new Promise(r=>stub.close(r));await rm(dir,{recursive:true,force:true});});
  async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
  db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});assert.equal(db.prepare('PRAGMA user_version').get().user_version,41);
  const courses=db.prepare("SELECT id,title FROM courses WHERE brand_id='globalvet' AND active=1 ORDER BY title").all();assert.ok(courses.length>=2,'la marca de prueba tiene varios cursos');
  const aves=courses.find(k=>k.id==='aves'),otro=courses.find(k=>k.id!=='aves'),pos=k=>courses.indexOf(k)+1;
  // una persona escribe por WhatsApp (webhook firmado, como lo manda Meta); devuelve la decisión del asistente, su respuesta y la conversación
  let wid=0;
  const say=async(wa,text,{referral,to=NUMBER}={})=>{const id='wamid.in'+(++wid),raw=JSON.stringify({object:'whatsapp_business_account',entry:[{id:'waba',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:to},contacts:[{wa_id:wa,profile:{name:'Persona '+wa.slice(-2)}}],messages:[{id,from:wa,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:text},...(referral?{referral}:{})}]}}]}]});
    const r=await fetch(origin+'/api/webhooks/channel/meta',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+hmacHex(SECRET,raw)},body:raw});assert.equal(r.status,200,await r.text());
    for(let i=0;i<80;i++){await sleep(120);const m=db.prepare('SELECT id,conversation_id FROM messages WHERE client_ref=?').get('meta:'+id),log=m&&db.prepare('SELECT * FROM reply_log WHERE trigger_message_id=?').get(m.id);
      if(log){const reply=log.reply_message_id?db.prepare('SELECT text FROM messages WHERE id=?').get(log.reply_message_id).text:'';return {log,text:reply,conv:{...db.prepare('SELECT id,course_id,course_pending,bot_enabled,status,referral FROM conversations WHERE id=?').get(m.conversation_id)}};}}
    assert.fail('sin respuesta a «'+text+'»\n'+logs);};
  const interests=conv=>db.prepare("SELECT o.course_id,o.stage FROM opportunities o JOIN contacts k ON k.id=o.contact_id JOIN conversations c ON c.customer_id=k.source_user_id AND c.brand_id=k.brand_id WHERE c.id=? AND o.stage NOT IN ('ganada','perdida') ORDER BY o.created_at").all(conv).map(o=>o.course_id);

  // 0) apagado por omisión: el número asignado como siempre recibe en su curso y NO pregunta
  let num=(await call('/api/whatsapp/numbers/'+NUMBER,admin.cookie,{brandId:'globalvet',courseId:'aves',expectedRevision:0},'PUT')).number;assert.equal(num.multi,false);
  const classic=await say('5215511110000','Hola');assert.equal(classic.log.intent,'greeting');assert.equal(classic.conv.course_id,'aves');assert.equal(classic.conv.course_pending,0);
  // 1) encendido: quien escribe sin anuncio recibe la lista de cursos de la marca (sólo de esa marca)
  num=(await call('/api/whatsapp/numbers/'+NUMBER,admin.cookie,{brandId:'globalvet',courseId:'aves',multi:true,expectedRevision:num.revision},'PUT')).number;assert.equal(num.multi,true);
  const a=await say('5215511110001','Hola');assert.equal(a.log.intent,'choose_course');assert.equal(a.log.action,'replied');assert.equal(a.conv.course_pending,1);
  assert.match(a.text,/Soy el asistente de GlobalVet\. ¿Sobre qué curso te gustaría información\?/);for(const k of courses)assert.ok(a.text.includes(pos(k)+'. '+k.title),k.title);
  for(const k of db.prepare("SELECT title FROM courses WHERE brand_id!='globalvet'").all())assert.ok(!a.text.includes(k.title),'no ofrece cursos de otra marca');
  for(let i=0;i<50&&!sent.some(x=>x.text===a.text);i++)await sleep(100);assert.ok(sent.some(x=>x.text===a.text&&x.to==='5215511110001'),'la pregunta salió por la API de Meta');assert.doesNotMatch(a.text,/\$|Inicio:/,'sin precios ni fechas hasta saber el curso');
  // una pregunta de precio sin curso: vuelve a preguntar (no inventa de qué curso)
  const a2=await say('5215511110001','¿cuánto cuesta?');assert.equal(a2.log.intent,'choose_course');assert.match(a2.text,/necesito saber qué curso te interesa/);assert.doesNotMatch(a2.text,/\$/);
  // elige por número: la conversación pasa a ese curso, recibe su ficha y el interés de relleno se vuelve el del curso elegido (uno solo)
  const a3=await say('5215511110001',String(pos(otro)));assert.equal(a3.conv.course_id,otro.id);assert.equal(a3.conv.course_pending,0);assert.match(a3.log.reason,/^Eligió el curso «/);assert.ok(a3.text.includes(otro.title));assert.match(a3.text,/• Inicio: /);
  assert.deepEqual(interests(a3.conv.id),[otro.id]);
  const a4=await say('5215511110001','¿cuánto cuesta?');assert.equal(a4.log.intent,'price');assert.ok(a4.text.includes(otro.title));
  // 2) cambia de curso en el mismo chat: «¿y el de aves cuánto cuesta?» contesta de aves y la conversación pasa a aves; el interés anterior se conserva
  const a5=await say('5215511110001','¿y el de aves cuánto cuesta?');assert.equal(a5.log.intent,'price');assert.ok(a5.text.includes(aves.title));assert.equal(a5.conv.course_id,'aves');assert.match(a5.log.reason,/^Cambió al curso «Plan sanitario para aves»/);
  assert.deepEqual(interests(a5.conv.id).sort(),[otro.id,'aves'].sort());assert.equal(a5.conv.id,a3.conv.id,'es la misma conversación');
  // una palabra del otro curso sin señal de «quiero ese curso» no cambia nada
  const word=db.prepare('SELECT title FROM courses WHERE id=?').get(otro.id).title.split(' ').find(w=>w.length>=5&&!/^nutrici/i.test(w))||'';
  const a6=await say('5215511110001','Tengo varios '+word+' en casa, ¿me sirve?');assert.equal(a6.conv.course_id,'aves','«'+word+'» suelto no cambia de curso');
  // «¿qué otros cursos tienen?» da la lista numerada y un número cambia
  const a7=await say('5215511110001','¿qué otros cursos tienen?');assert.equal(a7.log.intent,'courses');assert.match(a7.text,/Ahora estamos viendo Plan sanitario para aves/);
  const a8=await say('5215511110001',String(pos(otro)));assert.equal(a8.conv.course_id,otro.id);assert.match(a8.text,/• Inicio: /);
  // un número fuera de contexto no cambia nada
  await say('5215511110001','temario');const a9=await say('5215511110001',String(pos(aves)));assert.equal(a9.conv.course_id,otro.id,'un número suelto, sin lista antes, no elige curso');
  // 3) con un pedido vigente no se cambia solo
  const ps=(await call('/api/payments/settings',admin.cookie)).settings.find(x=>x.brand_id==='globalvet');await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:ps.revision},'PATCH');
  const order=await say('5215511110001','Quiero inscribirme');assert.equal(order.log.intent,'enroll');assert.match(order.text,/Pedido TC-/);
  const blocked=await say('5215511110001','mejor el curso de aves');assert.equal(blocked.conv.course_id,otro.id);assert.match(blocked.text,/Tienes un pedido pendiente de .* escribe «asesor»/);
  // un número después de ese aviso no elige nada (no se le mostró ninguna lista)
  const stray=await say('5215511110001',String(pos(aves)));assert.equal(stray.conv.course_id,otro.id);
  // avisar de un pago nombrando otro curso sigue pasando a una persona, como siempre
  const paid=await say('5215511110001','ya pagué, el de aves');assert.equal(paid.log.intent,'payment');assert.equal(paid.log.action,'escalated');assert.equal(paid.conv.course_id,otro.id);

  // 4) llega por un anuncio que nombra el curso: empieza en ese curso, sin preguntar
  const adAves={source_type:'ad',source_id:'120210000000777',source_url:'https://fb.me/x',headline:'Curso de aves de corral',body:'Aprende bioseguridad desde cero'};
  const b=await say('5215511110002','Hola, quiero información',{referral:adAves});assert.equal(b.conv.course_id,'aves');assert.equal(b.conv.course_pending,0);assert.equal(b.log.intent,'greeting');assert.ok(b.text.includes(aves.title));assert.equal(JSON.parse(b.conv.referral).adId,'120210000000777');
  // un anuncio que no nombra ningún curso: pregunta; administración lo liga a su curso y el siguiente ya entra directo
  const adX={source_type:'ad',source_id:'120210000000888',headline:'Inscripciones abiertas',body:'Cupo limitado'};
  const c=await say('5215511110003','Hola',{referral:adX});assert.equal(c.log.intent,'choose_course');assert.equal(c.conv.course_pending,1);
  let st=await call('/api/whatsapp',admin.cookie);assert.equal(st.numbers[0].multi,true);assert.deepEqual(st.ads.map(x=>[x.adId,x.hits,x.courseId]).sort(),[['120210000000777',1,null],['120210000000888',1,null]]);assert.ok(st.ads.every(x=>x.brandId==='globalvet'));
  const row=st.ads.find(x=>x.adId==='120210000000888'),foreign=db.prepare("SELECT id FROM courses WHERE brand_id!='globalvet' AND active=1").get().id;
  await call('/api/whatsapp/ads',admin.cookie,{brandId:'globalvet',adId:row.adId,courseId:foreign,expectedRevision:row.revision},'PUT',400);
  await call('/api/whatsapp/ads',admin.cookie,{brandId:'globalvet',adId:'no-existe',courseId:otro.id,expectedRevision:1},'PUT',404);
  await call('/api/whatsapp/ads',admin.cookie,{brandId:'globalvet',adId:row.adId,courseId:otro.id,expectedRevision:row.revision+5},'PUT',409);
  await call('/api/whatsapp/ads',admin.cookie,{brandId:'globalvet',adId:row.adId,courseId:otro.id,expectedRevision:row.revision},'PUT');
  const d=await say('5215511110004','Hola',{referral:adX});assert.equal(d.conv.course_id,otro.id);assert.equal(d.conv.course_pending,0);assert.ok(d.text.includes(otro.title));
  // quien seguía sin elegir toca después el anuncio de aves: su conversación pasa a aves
  const c2=await say('5215511110003','Hola de nuevo',{referral:adAves});assert.equal(c2.conv.id,c.conv.id);assert.equal(c2.conv.course_id,'aves');assert.equal(c2.conv.course_pending,0);assert.deepEqual(interests(c2.conv.id),['aves']);
  st=await call('/api/whatsapp',admin.cookie);assert.equal(st.ads.find(x=>x.adId==='120210000000777').hits,2);
  // 5) sin curso todavía: pedir una persona sigue su camino; dos intentos fallidos y a la tercera pasa a una persona
  const e=await say('5215511110005','quiero hablar con un asesor');assert.equal(e.log.intent,'human');assert.equal(e.log.action,'escalated');
  const f=await say('5215511110006','Hola');assert.equal(f.log.intent,'choose_course');const f2=await say('5215511110006','el que sea');assert.equal(f2.log.action,'replied');assert.match(f2.text,/escribe «asesor»/);
  const f3=await say('5215511110006','no sé cuál');assert.equal(f3.log.action,'escalated');assert.deepEqual([f3.conv.bot_enabled,f3.conv.status],[0,'waiting']);
  // elegir por nombre en el primer mensaje
  const g=await say('5215511110007','Hola, me interesa el curso de aves');assert.equal(g.conv.course_id,'aves');assert.equal(g.conv.course_pending,0);assert.match(g.text,/• Inicio: /);
  // un interés anterior y real en el curso de relleno no se toca: la persona del paso 0 (su chat de aves, ya cerrado) vuelve, queda por elegir y elige otro curso
  const earlier=classic.conv.id;db.prepare("UPDATE conversations SET status='resolved' WHERE id=?").run(earlier);
  const back=await say('5215511110000','Hola otra vez');assert.notEqual(back.conv.id,earlier);assert.equal(back.conv.course_pending,1);
  const back2=await say('5215511110000',String(pos(otro)));assert.equal(back2.conv.course_id,otro.id);assert.deepEqual(interests(back2.conv.id).sort(),[otro.id,'aves'].sort(),'el interés anterior en aves sigue vivo');
  assert.equal(db.prepare("SELECT o.course_id FROM conversation_opportunities x JOIN opportunities o ON o.id=x.opportunity_id WHERE x.conversation_id=?").get(earlier).course_id,'aves','la conversación anterior sigue ligada a su interés de aves');
  // con IA: una pregunta que elige curso y necesita a la IA le manda el curso ELEGIDO, no el de relleno
  const rs=(await call('/api/replies/settings',admin.cookie)).settings.find(x=>x.brand_id==='globalvet');await call('/api/replies/brands/globalvet',admin.cookie,{mode:'autonomous',providerEnabled:true,expectedRevision:rs.revision},'PATCH');
  const h=await say('5215511110009','Vivo en Colombia, ¿puedo tomar el curso de '+word+' desde allá?');assert.equal(h.conv.course_id,otro.id);assert.match(h.log.reason,/Proveedor de IA:/);assert.match(h.text,/^Sí: el curso es en línea/);
  const asked=prompts.filter(x=>x.includes('Colombia'));assert.equal(asked.length,1,'una sola consulta por esa pregunta (los resúmenes de chats largos van aparte)');assert.ok(asked[0].includes(otro.title),'la IA recibe el curso elegido');assert.ok(!asked[0].includes(aves.title),'y no el curso de relleno: …'+asked[0].slice(Math.max(0,asked[0].indexOf(aves.title)-260),asked[0].indexOf(aves.title)+60));
  await call('/api/replies/brands/globalvet',admin.cookie,{mode:'templates',providerEnabled:false,expectedRevision:rs.revision+1},'PATCH');
  // 6) una marca con un número de un solo curso y los perfiles del laboratorio no cambian
  await call('/api/whatsapp/numbers/'+OTHER,admin.cookie,{brandId:'odonteck',expectedRevision:0},'PUT');
  const o=await say('5215511110008','Hola',{to:OTHER});assert.equal(o.log.intent,'greeting');assert.equal(o.conv.course_pending,0);
  const lab=await call('/api/auth/register','',{username:'perfil1',name:'Ana Pérez',password}),conv=(await call('/api/conversations',lab.cookie,{courseId:'aves',channel:'whatsapp'})).conversation.id;
  const m=await call('/api/conversations/'+conv+'/messages',lab.cookie,{text:'¿y el curso de '+(word||'otro')+'?',clientRef:randomUUID()},'POST',201);
  for(let i=0;i<60&&!db.prepare('SELECT 1 FROM reply_log WHERE trigger_message_id=?').get(m.id);i++)await sleep(120);
  assert.equal(db.prepare('SELECT course_id FROM conversations WHERE id=?').get(conv).course_id,'aves','una conversación del laboratorio no cambia de curso');
});
