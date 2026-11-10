import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';

async function start(t,extra={}){
 const dir=await mkdtemp(join(tmpdir(),'crm-aistatus-')),code=randomUUID();let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',AI_PROVIDER:'',ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:'',AI_MONTHLY_CALL_LIMIT:'',AI_MONTHLY_TOKEN_LIMIT:'',...extra},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();const result=JSON.parse(text);assert.equal(r.status,expected,path+': '+text);return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0],raw:text};}
 const password='Password-aistatus-2026!';
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const colega=await (async()=>{const u=await call('/api/auth/register','',{username:'colega',name:'Colega',password});const inv=await call('/api/team/invites',admin.cookie,{username:'colega',brandIds:['globalvet']},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});return u;})();
 const ana=await call('/api/auth/register','',{username:'ana',name:'Ana',password});
 return {call,admin,colega,ana,dir};
}

test('estado de la IA con el motor simulado: sólo administración, sin gasto, y bloqueado por marca hasta tener clave y proveedor',async t=>{
 const {call,admin,colega,ana}=await start(t);
 await call('/api/ai/status','',undefined,'GET',401);await call('/api/ai/status',ana.cookie,undefined,'GET',403);await call('/api/ai/status',colega.cookie,undefined,'GET',403);await call('/api/ai/status',admin.cookie,{},'POST',405);
 const s=await call('/api/ai/status',admin.cookie);
 assert.equal(s.provider.name,'simulated');assert.equal(s.provider.real,false);assert.equal(s.provider.hasKey,false);assert.equal(s.provider.usage,null);assert.equal(s.provider.summaryModel,null);
 assert.deepEqual(s.steps.map(x=>[x.id,x.done]),[['key',false],['provider',false],['cap',false]]);assert.match(s.steps[0].detail,/ANTHROPIC_API_KEY/);
 assert.ok(s.brands.length>=3&&s.brands.every(b=>b.verdict==='blocked'&&/clave y el proveedor/.test(b.next)),'sin clave ni proveedor nada está listo');
 assert.deepEqual(s.thresholds,{minKnowledge:10,minEvalScore:0.85,suggestedCallLimit:200});
});

test('estado de la IA con Claude: nunca expone la clave, cuenta el gasto contra el tope y da el veredicto por marca',async t=>{
 const SECRET='sk-ant-api03-ESTE-VALOR-NO-DEBE-SALIR-NUNCA';
 const {call,admin,dir}=await start(t,{AI_PROVIDER:'claude',ANTHROPIC_API_KEY:SECRET,AI_MODEL:'claude-sonnet-5-5',AI_MONTHLY_CALL_LIMIT:'10',AI_MONTHLY_TOKEN_LIMIT:'5000'});
 const db=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),T=Date.now();
 const s0=await call('/api/ai/status',admin.cookie);
 assert.ok(!s0.raw.includes(SECRET)&&!s0.raw.includes('ESTE-VALOR')&&!/sk-ant/.test(s0.raw),'la clave no sale en ninguna parte');
 assert.equal(s0.provider.name,'claude');assert.equal(s0.provider.real,true);assert.equal(s0.provider.hasKey,true);assert.equal(s0.provider.model,'claude-sonnet-5-5');assert.equal(s0.provider.summaryModel,'claude-haiku-5-5');
 assert.deepEqual(s0.steps.map(x=>[x.id,x.done]),[['key',true],['provider',true],['cap',true]]);
 assert.equal(s0.provider.usage.calls,0);assert.equal(s0.provider.usage.callLimit,10);assert.equal(s0.provider.usage.tokenLimit,5000);assert.equal(s0.provider.usage.callsPct,0);assert.equal(s0.provider.usage.blocked,false);

 // el gasto sale de las llamadas reales registradas; las simuladas no cuentan
 const ai=(kind,i,o)=>db.prepare('INSERT INTO audit(user_id,action,entity_id,created_at) VALUES(NULL,?,?,?)').run('ai.call',JSON.stringify({kind,model:'claude-sonnet-5-5',in:i,out:o}),T);
 for(let i=0;i<8;i++)ai(i<6?'reply':'summary',300,100);
 const s1=await call('/api/ai/status',admin.cookie);assert.equal(s1.provider.usage.calls,8);assert.equal(s1.provider.usage.tokens,3200);assert.equal(s1.provider.usage.callsPct,80);assert.equal(s1.provider.usage.tokensPct,64);assert.deepEqual(s1.provider.usage.byKind,{reply:6,summary:2});assert.equal(s1.provider.usage.blocked,false);
 ai('reply',500,500);ai('reply',500,500);
 const s2=await call('/api/ai/status',admin.cookie);assert.equal(s2.provider.usage.calls,10);assert.equal(s2.provider.usage.callsPct,100);assert.equal(s2.provider.usage.blocked,true,'al llegar al tope se dice que dejó de llamar');

 // veredicto por marca: conocimiento → autorización → evaluación con IA real
 const brand=id=>call('/api/ai/status',admin.cookie).then(r=>r.brands.find(b=>b.id===id));
 const approvedBefore=(await brand('globalvet')).knowledge.approved;
 const add=n=>{for(let i=0;i<n;i++)db.prepare("INSERT INTO knowledge_entries(id,brand_id,topic,question,answer,status,created_at,updated_at) VALUES(?,?,?,?,?,'approved',?,?)").run(randomUUID(),'globalvet','prueba','¿Pregunta de prueba número '+randomUUID()+'?','Respuesta de prueba aprobada.',T,T);};
 let b=await brand('globalvet');assert.equal(b.verdict,'blocked');
 add(Math.max(0,9-approvedBefore));b=await brand('globalvet');assert.equal(b.verdict,'blocked');assert.match(b.next,/al menos 10 respuestas/);assert.equal(b.checks.find(c=>c.id==='knowledge').done,false);
 add(1);b=await brand('globalvet');assert.equal(b.knowledge.approved,Math.max(10,approvedBefore+Math.max(0,9-approvedBefore)+1));assert.equal(b.checks.find(c=>c.id==='knowledge').done,true);
 assert.equal(b.verdict,'blocked');assert.match(b.next,/Autoriza la IA/,'con conocimiento falta autorizar a la marca');
 db.prepare("INSERT OR REPLACE INTO reply_settings(brand_id,mode,provider_enabled,max_unknown,revision,updated_at) VALUES('globalvet','templates',1,2,1,?)").run(T);
 b=await brand('globalvet');assert.equal(b.verdict,'ready_suggest');assert.match(b.next,/modo en «Sugerir»/);assert.equal(b.checks.find(c=>c.id==='mode').done,false);assert.equal(b.providerEnabled,true);
 db.prepare("UPDATE reply_settings SET mode='suggest' WHERE brand_id='globalvet'").run();
 b=await brand('globalvet');assert.equal(b.verdict,'ready_suggest');assert.match(b.next,/revisa los borradores/);assert.equal(b.checks.find(c=>c.id==='mode').done,true);
 // una evaluación con el motor simulado no alcanza; con IA real y buena nota sí
 // eval_runs.score se guarda en PORCENTAJE (0–100), igual que en producción; `ai` = cuántos casos sí consultaron a la IA
 const run=(provider,pct,at,ai=provider==='claude'?3:0)=>db.prepare('INSERT INTO eval_runs(id,brand_id,mode,provider,total,passed,score,results,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),'globalvet','suggest',provider,20,Math.round(20*pct/100),pct,JSON.stringify(Array.from({length:20},(_,i)=>({pass:true,got:{providerUsed:i<ai,providerCalled:i<ai}}))),1000,at);
 run('simulated',100,T);b=await brand('globalvet');assert.equal(b.verdict,'ready_suggest');assert.equal(b.lastEval.provider,'simulated');assert.equal(b.realEval,null);assert.match(b.checks.find(c=>c.id==='eval').detail,/motor simulado/);
 run('claude',5.9,T+500);b=await brand('globalvet');assert.equal(b.verdict,'ready_suggest','5,9 % no es 590 %: no pasa a responder');assert.equal(Math.round(b.realEval.score*1000)/10,5.9);
 run('claude',70,T+1000);b=await brand('globalvet');assert.equal(b.verdict,'ready_suggest');assert.equal(Math.round(b.realEval.score*100),70);
 // una evaluación «con Claude» donde ningún caso llegó a consultar a la IA no cuenta como prueba con IA real
 run('claude',100,T+1500,0);b=await brand('globalvet');assert.equal(b.verdict,'ready_suggest');assert.equal(Math.round(b.realEval.score*100),70);assert.match(b.checks.find(c=>c.id==='eval').detail,/70 %/);
 run('claude',90,T+2000);b=await brand('globalvet');assert.equal(b.verdict,'ready_respond');assert.match(b.next,/pasar de «Sugerir» a «Autónomo»/);assert.equal(b.checks.find(c=>c.id==='eval').done,true);
 // otras marcas no se contagian
 assert.equal((await brand('odonteck')).verdict,'blocked');
 // sin el conocimiento o sin la autorización, una buena evaluación no basta
 db.prepare("UPDATE reply_settings SET provider_enabled=0 WHERE brand_id='globalvet'").run();assert.equal((await brand('globalvet')).verdict,'blocked');
 db.close();
});

test('probar conexión con Claude: una llamada real mínima, sólo administración, cuenta contra el tope y explica por qué falla sin exponer la clave',async t=>{
 // Anthropic de mentira: el SDK respeta ANTHROPIC_BASE_URL, así la prueba recorre el camino real sin red ni gasto
 const SECRET='sk-ant-api03-ESTE-VALOR-NO-DEBE-SALIR-NUNCA';let mode='ok';const seen=[];
 const stub=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{seen.push({url:req.url,beta:req.headers['anthropic-beta']||'',body:raw?JSON.parse(raw):null});
  const send=(status,obj)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(obj));},err=(status,type,message)=>send(status,{type:'error',error:{type,message}});
  if(mode==='ok')return send(200,{id:'msg_prueba',type:'message',role:'assistant',model:'claude-sonnet-5-5',content:[{type:'text',text:'LISTO'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:12,output_tokens:3}});
  if(mode==='401')return err(401,'authentication_error','invalid x-api-key '+SECRET);
  if(mode==='saldo')return err(400,'invalid_request_error','Your credit balance is too low to access the Anthropic API.');
  if(mode==='404')return err(404,'not_found_error','model: claude-sonnet-5-5');
  return err(400,'invalid_request_error','fallbacks: Extra inputs are not permitted');});});
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>stub.close(r)));
 const {call,admin,colega,ana}=await start(t,{AI_PROVIDER:'claude',ANTHROPIC_API_KEY:SECRET,ANTHROPIC_BASE_URL:'http://127.0.0.1:'+stub.address().port,AI_MODEL:'claude-sonnet-5-5',AI_MONTHLY_CALL_LIMIT:'3',AI_PING_COOLDOWN_MS:'250'});
 const wait=()=>new Promise(r=>setTimeout(r,300)),ping=(expected=200)=>call('/api/ai/ping',admin.cookie,{},'POST',expected);
 // permisos y método
 await call('/api/ai/ping','',{},'POST',401);await call('/api/ai/ping',ana.cookie,{},'POST',403);await call('/api/ai/ping',colega.cookie,{},'POST',403);await call('/api/ai/ping',admin.cookie,undefined,'GET',405);assert.equal(seen.length,0,'sin permiso no sale ninguna llamada');
 // funciona: misma forma de petición que las respuestas reales, y cuenta contra el tope
 const ok=await ping();assert.equal(ok.result.ok,true);assert.equal(ok.result.called,true);assert.equal(ok.result.model,'claude-sonnet-5-5');assert.equal(ok.result.inputTokens,12);assert.equal(ok.result.outputTokens,3);assert.equal(ok.provider.usage.calls,1);assert.deepEqual(ok.provider.usage.byKind,{ping:1});
 assert.equal(seen.length,1);assert.match(seen[0].url,/\/v1\/messages/);assert.equal(seen[0].body.model,'claude-sonnet-5-5');assert.equal(seen[0].body.fallbacks,'default');assert.equal(seen[0].body.output_config.effort,'low');assert.match(seen[0].beta,/server-side-fallback-2026-07-01/);
 // no se puede martillar el botón
 await ping(429);assert.equal(seen.length,1);await wait();
 // fallos: motivo legible, sin contar llamada y sin que la clave salga aunque el proveedor la repita
 mode='401';const bad=await ping();assert.equal(bad.result.ok,false);assert.equal(bad.result.called,false);assert.match(bad.result.reason,/clave de API no es válida/);assert.ok(!bad.raw.includes(SECRET)&&!/sk-ant/.test(bad.raw));assert.equal(bad.provider.usage.calls,1);await wait();
 mode='saldo';assert.match((await ping()).result.reason,/no tiene saldo/);await wait();
 mode='404';assert.match((await ping()).result.reason,/modelo «claude-sonnet-5-5» no existe o no está disponible/);await wait();
 mode='400';const rej=await ping();assert.match(rej.result.reason,/rechazó la petición \(400\)/);assert.match(rej.result.reason,/fallbacks/);await wait();
 // el tope también frena la prueba: al llegar a 3 ya no sale ninguna llamada
 mode='ok';await ping();await wait();const third=await ping();assert.equal(third.provider.usage.calls,3);await wait();const before=seen.length;
 const capped=await ping();assert.equal(capped.result.ok,false);assert.match(capped.result.reason,/tope mensual/);assert.equal(seen.length,before,'con el tope alcanzado no se llama');
});

test('probar conexión con el motor simulado: no llama a nadie y lo dice',async t=>{
 const {call,admin}=await start(t,{AI_PING_COOLDOWN_MS:'0'});
 const r=await call('/api/ai/ping',admin.cookie,{},'POST');assert.equal(r.result.ok,false);assert.equal(r.result.called,false);assert.match(r.result.reason,/simulado/);assert.equal(r.provider.usage,null);
});
