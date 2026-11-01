import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PERSONAS,PACES,DEMO_BRANDS,OUTCOMES} from '../server/simulator-personas.mjs';

test('guiones del simulador: perfiles completos, textos acotados y catálogo demo coherente',()=>{
  for(const [id,p] of Object.entries(PERSONAS)){
    assert.ok(p.steps.length>=2&&p.label&&p.description&&OUTCOMES[p.outcome],id);
    for(const s of p.steps){
      if(s.say){assert.ok(s.say.length>=1,id);for(const t of s.say)assert.ok(t.length>5&&t.length<300,t);}else assert.equal(s.wait,'reply',id+': un paso sin texto sólo puede esperar');
      if(s.onHuman)assert.equal(s.wait,'human',id);
      assert.ok(!s.wait||['reply','human'].includes(s.wait),id);
    }
  }
  assert.equal(DEMO_BRANDS.length,15);assert.equal(new Set(DEMO_BRANDS.map(b=>b.name.toLowerCase())).size,15);
  for(const b of DEMO_BRANDS){assert.equal(b.courses.length,8,b.name);assert.equal(new Set(b.courses.map(c=>c.toLowerCase())).size,8,b.name);assert.ok(b.base>=900&&b.base<=5000,b.name);}
  assert.deepEqual(Object.keys(PACES),['rapida','normal','lenta']);
});

test('simulador por API: permisos, catálogo demo, demo rápida con ocho perfiles, atención humana y archivo',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-simulator-')),code=randomUUID(),password='Password-simulator-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'));
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),client=await call('/api/auth/register','',{username:'cliente',name:'Cliente',password});

 // permisos: sólo administración; sin sesión, 401
 await call('/api/simulator',client.cookie,undefined,'GET',403);await call('/api/simulator/runs','',undefined,'GET',401);
 const meta=await call('/api/simulator',admin.cookie);assert.equal(meta.personas.length,8);assert.equal(meta.demo.brands,15);

 // catálogo de demostración: 4 marcas × 2 cursos → una marca nueva, ocho cursos con edición publicada; repetir no duplica
 const cat=await call('/api/simulator/catalogue',admin.cookie,{brands:4,courses:2});
 // tres de los ocho cursos ya existen en la base inicial (aves, odontología, piel): se reutilizan y sólo reciben su edición nueva
 assert.equal(cat.failed,0,JSON.stringify(cat.errors));assert.equal(cat.brandsCreated,1);assert.equal(cat.coursesCreated,5);assert.equal(cat.editionsCreated,8);assert.ok(cat.promotionsCreated>=2,'preventas');
 const again=await call('/api/simulator/catalogue',admin.cookie,{brands:4,courses:2});assert.equal(again.brandsCreated,0);assert.equal(again.coursesCreated,0);assert.equal(again.existing,8);
 const boot=await call('/api/bootstrap',admin.cookie);assert.equal(boot.brands.length,4);assert.ok(boot.editions.filter(e=>e.status==='published').length>=8);

 // validaciones de inicio
 await call('/api/simulator/runs',admin.cookie,{count:0,pace:'rapida'},'POST',400);
 await call('/api/simulator/runs',admin.cookie,{count:2,pace:'lentisima'},'POST',400);
 await call('/api/simulator/runs',admin.cookie,{count:2,pace:'rapida',personas:['x']},'POST',400);
 await call('/api/simulator/runs',admin.cookie,{count:2,pace:'rapida',brandIds:['no-existe']},'POST',404);

 // demo rápida: un cliente por perfil, repartidos entre cursos y canales
 const run=(await call('/api/simulator/runs',admin.cookie,{count:8,pace:'rapida',brandIds:'all'},'POST',201)).run;
 assert.equal(run.actors.length,8);assert.equal(new Set(run.actors.map(a=>a.persona)).size,8);assert.ok(run.actors.every(a=>a.name.endsWith('· demo')));assert.equal(new Set(run.actors.map(a=>a.channel)).size,3);
 let r;for(let i=0;i<240;i++){r=(await call('/api/simulator/runs/'+run.id,admin.cookie)).run;if(r.stats.byState.active===0)break;await sleep(500);}
 assert.equal(r.stats.byState.active,0,JSON.stringify(r.stats));assert.equal(r.stats.byState.failed,0,JSON.stringify(r.actors.filter(a=>a.error)));
 const by=p=>r.actors.find(a=>a.persona===p);
 for(const p of ['listo','molesto','desconocido'])assert.equal(by(p).state,'waiting',p+' espera a una persona');
 for(const p of ['curioso','precio','baja','dudas','silencio'])assert.equal(by(p).state,'done',p+' termina solo');
 assert.equal(by('silencio').outcome,'silencio');assert.equal(by('baja').outcome,'baja');assert.ok(by('curioso').gotBot>=3,'el curioso recibió respuestas automáticas');
 assert.ok(r.stats.messages.customer>=16,'mensajes de clientes');assert.ok(r.stats.messages.automation>=8,'respuestas automáticas');assert.equal(r.stats.messages.agent,0);
 assert.ok(r.stats.firstReplyMs!==null&&r.stats.firstReplyMs<10000,'primera respuesta automática medida');
 assert.equal(r.stats.optOuts,1,'la baja quedó registrada en consentimiento');
 assert.ok((r.stats.stages.inscripcion||0)>=1,'el cliente listo avanzó a inscripción: '+JSON.stringify(r.stats.stages));
 assert.equal(r.stats.waitingHuman,3);assert.equal(r.stats.finished,5);assert.equal(r.stats.withoutHuman,5);
 const d=db();try{
  // el curioso lee las respuestas que espera; la contestación a su despedida puede quedar sin leer, como haría una persona
  assert.ok(d.prepare("SELECT count(*) n FROM messages WHERE sender_kind='automation' AND read_at IS NOT NULL AND conversation_id=?").get(by('curioso').conversationId).n>=3,'los clientes demo marcan como leídas las respuestas');
  assert.equal(d.prepare("SELECT count(*) n FROM users WHERE username LIKE 'demo.%' AND role='customer'").get().n,8);
  assert.equal(d.prepare("SELECT count(*) n FROM messages m JOIN users u ON u.id=m.sender_id WHERE u.username LIKE 'demo.%' AND m.client_ref NOT LIKE u.id||':%'").get().n,0,'los mensajes entraron por la API con clientRef del propio cliente');
 }finally{d.close();}

 // una persona responde al cliente listo: agradece, termina y queda contado como atención humana
 const listo=by('listo');
 await call('/api/conversations/'+listo.conversationId+'/messages',admin.cookie,{text:'Recibimos tu comprobante; en breve te confirmamos por aquí.',clientRef:randomUUID(),asAgent:true},'POST',201);
 let a;for(let i=0;i<60;i++){a=(await call('/api/simulator/runs/'+run.id,admin.cookie)).run.actors.find(x=>x.persona==='listo');if(a.state==='done')break;await sleep(500);}
 assert.equal(a.state,'done');assert.equal(a.gotHuman,1);assert.equal(a.outcome,'inscripcion_en_validacion');
 const msgs=(await call('/api/conversations/'+listo.conversationId+'/messages',admin.cookie)).messages;assert.equal(msgs.at(-1).sender_kind,'customer');assert.match(msgs.at(-1).text,/gracias/i);

 // detener y archivar: chats resueltos, trabajos cancelados y oportunidades cerradas con motivo
 const stopped=(await call('/api/simulator/runs/'+run.id+'/stop',admin.cookie,{})).run;assert.equal(stopped.state,'stopped');assert.equal(stopped.stats.byState.waiting,0);assert.equal(stopped.stats.byState.stopped,2);
 await call('/api/simulator/runs/'+run.id+'/stop',admin.cookie,{},'POST',409);
 const archived=(await call('/api/simulator/runs/'+run.id+'/archive',admin.cookie,{})).run;assert.equal(archived.state,'archived');assert.equal(archived.stats.resolved,8);
 const check=db();try{
  const ids=archived.actors.map(x=>x.conversationId),ph=ids.map(()=>'?').join(',');
  assert.equal(check.prepare(`SELECT count(*) n FROM conversations WHERE id IN (${ph}) AND (status!='resolved' OR bot_enabled=1)`).get(...ids).n,0);
  assert.equal(check.prepare(`SELECT count(*) n FROM jobs WHERE state='pending' AND conversation_id IN (${ph})`).get(...ids).n,0);
  assert.equal(check.prepare(`SELECT count(*) n FROM automation_steps WHERE state IN ('pending','reserved') AND conversation_id IN (${ph})`).get(...ids).n,0);
  assert.equal(check.prepare(`SELECT count(*) n FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id IN (${ph}) AND o.stage NOT IN ('ganada','perdida')`).get(...ids).n,0);
  assert.equal(check.prepare("SELECT count(*) n FROM opportunities WHERE lost_reason='Demo archivada'").get().n,8);
  assert.equal(check.prepare("SELECT count(*) n FROM tasks WHERE status='open'").get().n,0);
 }finally{check.close();}
 await call('/api/simulator/runs/'+run.id+'/archive',admin.cookie,{},'POST',409);

 // otra demo después de archivar: queda listada y se puede detener
 const second=(await call('/api/simulator/runs',admin.cookie,{count:1,pace:'rapida',personas:['curioso'],brandIds:[run.actors[0].brandId]},'POST',201)).run;
 assert.equal(second.actors.length,1);assert.equal((await call('/api/simulator/runs',admin.cookie)).runs.length,2);
 await call('/api/simulator/runs/'+second.id+'/stop',admin.cookie,{});
 assert.equal(logs.includes('Simulator actor failed'),false,logs);
});
