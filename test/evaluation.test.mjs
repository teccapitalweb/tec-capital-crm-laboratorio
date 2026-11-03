import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {grade,actionOf} from '../server/evaluation.mjs';
import {DEMO_CASES} from '../server/evaluation-schema.mjs';

test('calificación de un caso: intención, acción, fuente y texto',()=>{
  const r={mode:'templates',intent:'price',handoff:false,sources:[{type:'catalogue'}],reply:'El precio de ejemplo es $379.00 MXN'};
  assert.deepEqual(grade({expect_intent:'price',expect_action:'replied',expect_source:'catalogue',must_include:'$',must_exclude:'gratis'},r),[]);
  const f=grade({expect_intent:'schedule',expect_action:'escalated',expect_source:'knowledge',must_include:'fecha',must_exclude:'$'},r);
  assert.equal(f.length,5);assert.match(f[0],/intención/);assert.match(f[1],/acción/);assert.match(f[2],/fuente/);
  assert.deepEqual(grade({expect_source:'none'},{...r,sources:[]}),[]);assert.equal(grade({expect_source:'none'},r).length,1);
  assert.equal(actionOf({mode:'off'}),'skipped');assert.equal(actionOf({mode:'suggest'}),'suggested');assert.equal(actionOf({mode:'templates',handoff:true}),'escalated');assert.equal(actionOf({mode:'autonomous',handoff:false}),'replied');
  assert.equal(DEMO_CASES.length,17);
});

test('banco de evaluación por API: siembra, casos, ejecución con el nivel vigente, historial, alcance y permisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-evaluation-')),code=randomUUID(),password='Password-evaluation-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),client=await call('/api/auth/register','',{username:'cliente',name:'Cliente',password});
 assert.equal((await fetch(origin+'/evaluation.js')).status,200);

 // siembra: 17 casos por marca inicial; permisos
 const all=await call('/api/evaluation/cases',admin.cookie);
 assert.equal(all.cases.length,17*3);assert.ok(all.intents.includes('price')&&all.actions.length===4&&all.sources.length===4);
 assert.equal((await call('/api/evaluation/cases?brand=globalvet',admin.cookie)).cases.length,17);
 await call('/api/evaluation/cases',client.cookie,undefined,'GET',403);
 await call('/api/evaluation/brands/globalvet/run',client.cookie,{},'POST',403);

 // ejecución con el nivel vigente (plantillas): todos los casos sembrados pasan
 const run=(await call('/api/evaluation/brands/globalvet/run',admin.cookie,{})).run;
 assert.equal(run.total,17);assert.equal(run.passed,17,JSON.stringify(run.results.filter(r=>!r.pass).map(r=>[r.title,r.failures])));assert.equal(run.score,100);assert.equal(run.mode,'templates');assert.equal(run.provider,'simulated');
 const price=run.results.find(r=>r.title==='Pregunta el precio');assert.equal(price.got.intent,'price');assert.ok(price.got.reply.includes('$'));assert.deepEqual(price.got.sources,['catalogue']);
 assert.equal(run.results.find(r=>r.title==='Quiere inscribirse').got.action,'escalated','sin venta activa la inscripción pasa a persona');
 const listed=(await call('/api/evaluation/cases?brand=globalvet',admin.cookie)).cases;assert.ok(listed.every(c=>c.last?.pass===true));

 // caso nuevo que falla a propósito, edición con revisión, archivo y exclusión del siguiente corrido
 await call('/api/evaluation/cases',admin.cookie,{brandId:'globalvet',inputText:'Hola'},'POST',400);
 await call('/api/evaluation/cases',admin.cookie,{brandId:'globalvet',inputText:'Hola',expectIntent:'inventada'},'POST',400);
 await call('/api/evaluation/cases',admin.cookie,{brandId:'no-existe',inputText:'Hola',expectIntent:'price'},'POST',404);
 const bad=(await call('/api/evaluation/cases',admin.cookie,{brandId:'globalvet',title:'Saludo que espera precio',inputText:'Hola buenas',expectIntent:'price',mustInclude:'certificado'},'POST',201)).case;
 assert.equal(bad.status,'active');assert.equal(bad.revision,1);
 const run2=(await call('/api/evaluation/brands/globalvet/run',admin.cookie,{})).run;
 assert.equal(run2.total,18);assert.equal(run2.passed,17);const failed=run2.results.find(r=>r.caseId===bad.id);assert.equal(failed.pass,false);assert.equal(failed.failures.length,2);assert.match(failed.failures[0],/esperaba «price», obtuvo «greeting»/);
 assert.equal((await call('/api/evaluation/cases?brand=globalvet',admin.cookie)).cases.find(c=>c.id===bad.id).last.pass,false);
 await call('/api/evaluation/cases/'+bad.id,admin.cookie,{expectedRevision:5,expectIntent:'greeting'},'PATCH',409);
 const fixed=(await call('/api/evaluation/cases/'+bad.id,admin.cookie,{expectedRevision:1,expectIntent:'greeting',mustInclude:''},'PATCH')).case;assert.equal(fixed.expect_intent,'greeting');assert.equal(fixed.must_include,null);assert.equal(fixed.revision,2);
 const run3=(await call('/api/evaluation/brands/globalvet/run',admin.cookie,{})).run;assert.equal(run3.passed,18);
 await call('/api/evaluation/cases/'+bad.id+'/archive',client.cookie,{},'POST',403);
 assert.equal((await call('/api/evaluation/cases/'+bad.id+'/archive',admin.cookie,{})).case.status,'archived');
 assert.equal((await call('/api/evaluation/brands/globalvet/run',admin.cookie,{})).run.total,17);
 assert.equal((await call('/api/evaluation/cases/'+bad.id+'/restore',admin.cookie,{})).case.status,'active');

 // el banco refleja el nivel de la marca: en «sugerir» la acción esperada «responde» ya no se cumple
 const rs=(await call('/api/replies/settings',admin.cookie)).settings.find(x=>x.brand_id==='odonteck');
 await call('/api/replies/brands/odonteck',admin.cookie,{mode:'suggest',providerEnabled:false,expectedRevision:rs.revision},'PATCH');
 const suggest=(await call('/api/evaluation/brands/odonteck/run',admin.cookie,{})).run;
 assert.equal(suggest.mode,'suggest');assert.ok(suggest.passed<suggest.total);assert.ok(suggest.results.find(r=>r.title==='Pregunta el precio').failures.some(f=>/obtuvo «suggested»/.test(f)));

 // historial y detalle; marca sin acceso y ejecución vacía
 const runs=(await call('/api/evaluation/brands/globalvet/runs',admin.cookie)).runs;assert.equal(runs.length,4);assert.equal(runs[0].total,17);assert.equal(runs[0].actor_name,'Administración');
 assert.equal((await call('/api/evaluation/runs/'+runs[1].id,admin.cookie)).run.results.length,18);assert.equal(runs[3].total,17);
 await call('/api/evaluation/runs/'+randomUUID(),admin.cookie,undefined,'GET',404);
 const brand=(await call('/api/brands',admin.cookie,{name:'Marca Eval',description:'prueba'},'POST',201)).id;
 assert.equal((await call('/api/evaluation/cases?brand='+brand,admin.cookie)).cases.length,17,'una marca nueva recibe la siembra');
 const d=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});try{assert.equal(d.prepare('PRAGMA user_version').get().user_version,25);assert.equal(d.prepare('SELECT count(*) n FROM eval_runs').get().n,5);}finally{d.close();}
 assert.equal(logs.includes('failed'),false,logs);
});
