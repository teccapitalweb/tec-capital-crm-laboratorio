import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

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
 const run=(provider,pct,at,ai=provider==='claude'?3:0)=>db.prepare('INSERT INTO eval_runs(id,brand_id,mode,provider,total,passed,score,results,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),'globalvet','suggest',provider,20,Math.round(20*pct/100),pct,JSON.stringify(Array.from({length:20},(_,i)=>({pass:true,got:{providerUsed:i<ai}}))),1000,at);
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
