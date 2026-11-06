import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {parseCsv} from '../server/catalogue-import.mjs';
import {TEMPLATE_CSV,TEMPLATE_ROWS,COLUMNS} from '../server/knowledge-import.mjs';
import {createAiBudget} from '../server/ai-budget.mjs';
import {createAiProvider} from '../server/ai-provider.mjs';

test('la plantilla de conocimiento se lee bien y cada respuesta es una guía por completar',()=>{
 const t=parseCsv(TEMPLATE_CSV);assert.deepEqual(t[0].cells,COLUMNS);assert.equal(t.length-1,TEMPLATE_ROWS.length);assert.ok(TEMPLATE_ROWS.length>=12);
 for(const r of t.slice(1)){assert.equal(r.cells.length,COLUMNS.length);assert.match(r.cells[2],/^COMPLETAR: /);assert.doesNotMatch(r.cells[2],/\$|\d/,'la guía no sugiere precios ni números');assert.ok(r.cells[1].length>=8);}
});

test('tope de gasto de la IA: cuenta sólo llamadas reales del mes, respeta los topes y se reinicia cada mes',async()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL)');
 let clock=Date.UTC(2026,10,15,12);const now=()=>clock;
 const b=createAiBudget({db,env:{AI_MONTHLY_CALL_LIMIT:'3'},now});
 assert.equal(b.check(),null);assert.equal(b.usage().calls,0);assert.equal(b.usage().callLimit,3);
 b.record({kind:'reply',model:'m',input:100,output:20});b.record({kind:'variants',model:'m',input:50,output:10});
 db.prepare("INSERT INTO audit(user_id,action,entity_id,created_at) VALUES(NULL,'otra.cosa','x',?)").run(clock);
 assert.deepEqual([b.usage().calls,b.usage().tokens,b.usage().byKind],[2,180,{reply:1,variants:1}]);assert.equal(b.check(),null);
 b.record({kind:'reply',model:'m',input:1,output:1});assert.match(b.check(),/tope mensual de llamadas/);assert.equal(b.usage().blocked,true);
 clock=Date.UTC(2026,11,1,0,5);assert.equal(b.check(),null,'otro mes: vuelve a empezar');assert.equal(b.usage().calls,0);assert.equal(b.usage().month,'2026-12');
 const t=createAiBudget({db,env:{AI_MONTHLY_CALL_LIMIT:'0',AI_MONTHLY_TOKEN_LIMIT:'100'},now});t.record({kind:'reply',model:'m',input:90,output:20});assert.match(t.check(),/tope mensual de tokens/);
 assert.equal(createAiBudget({db,env:{AI_MONTHLY_CALL_LIMIT:'abc'},now}).usage().callLimit,1000,'un valor inválido usa el predeterminado');
 // el proveedor real no sale a la red cuando el tope está alcanzado (con credenciales de mentira ni siquiera carga el SDK)
 const p=createAiProvider({env:{AI_PROVIDER:'claude',ANTHROPIC_API_KEY:'no-es-real'}});p.useBudget({check:()=>'Tope de prueba alcanzado',record(){throw Error('no debe registrar');}});
 const r=await p.draft({brand:{name:'x'},question:'q',knowledge:[],history:[]});assert.equal(r.text,null);assert.equal(r.reason,'Tope de prueba alcanzado');assert.equal(r.budget,true);
 const v=await p.rewrite({brand:{name:'x'},template:{scenario:'info',body:'Hola {{nombre}}'},tones:['formal'],variables:['nombre']});assert.deepEqual(v.variants,[]);assert.equal(v.reason,'Tope de prueba alcanzado');
 assert.equal(createAiProvider({env:{}}).usage(),null,'el simulado no reporta uso');
});

test('importar conocimiento por lote: vista previa sin escribir, borradores, sin duplicar y sólo administración',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-kimport-')),code=randomUUID(),password='Password-kimport-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),client=await call('/api/auth/register','',{username:'cliente',name:'Cliente Uno',password});
 const entries=async()=>(await call('/api/replies/knowledge?brand=globalvet',admin.cookie)).entries;
 const before=await entries();

 // permisos y plantilla
 await call('/api/knowledge-import/template','',undefined,'GET',401);await call('/api/knowledge-import/template',client.cookie,undefined,'GET',403);
 assert.equal((await call('/api/knowledge-import/template',admin.cookie)).csv,TEMPLATE_CSV);

 // la plantilla tal cual no se puede importar: todas las respuestas son guías por completar
 const raw=await call('/api/knowledge-import/preview',admin.cookie,{csv:TEMPLATE_CSV},'POST');
 assert.equal(raw.summary.valid,0);assert.ok(raw.rows.every(r=>r.errors.some(e=>/COMPLETAR/.test(e))));
 await call('/api/knowledge-import/apply',admin.cookie,{csv:TEMPLATE_CSV,fileHash:raw.fileHash},'POST',400);

 // un archivo con filas buenas y malas, en formato de Excel en español (punto y coma y BOM)
 const course=(await call('/api/catalogue',admin.cookie)).courses.find(c=>c.brand_id==='globalvet');
 const rows=[
  ['marca','pregunta','respuesta','tema','curso','variantes'],
  ['GlobalVet','¿Dan factura de la inscripción?','Sí, pide tu factura al equipo con tus datos fiscales y te la mandan por correo.','pagos','','factura;recibo fiscal'],
  ['globalvet','¿Hay clases de reposición si falto?','Si faltas a una sesión puedes ver la grabación o pedir una reposición al equipo.','general',course.title,''],
  ['GlobalVet','¿Dan factura de la inscripción?','Texto repetido en el mismo archivo para la misma pregunta.','pagos','',''],
  ['GlobalVet','¿Cuánto cuesta el curso completo?','Cuesta $4,500 pesos con descuento de preventa.','pagos','',''],
  ['GlobalVet','¿Cómo?','Muy bueno y práctico para todos.','general','',''],
  ['Marca Fantasma','¿Existe esta marca en el sistema?','No debería importarse porque la marca no existe.','general','',''],
  ['GlobalVet','¿Con qué tema se clasifica esto?','Tema inventado que el sistema no reconoce para clasificar.','astrologia','',''],
  ['GlobalVet','¿Aplica a un curso que no existe?','El curso indicado no existe en la marca y debe rechazarse.','general','Curso Inventado',''],
  ['GlobalVet','¿Qué dicen los alumnos del curso?','COMPLETAR: resume lo que opinan los alumnos.','general','',''],
 ];
 const csv='﻿'+rows.map(r=>r.map(c=>/[;"\n]/.test(c)?'"'+c.replace(/"/g,'""')+'"':c).join(';')).join('\r\n')+'\r\n';
 const preview=await call('/api/knowledge-import/preview',admin.cookie,{csv},'POST');
 assert.deepEqual(preview.summary,{rows:9,valid:2,withErrors:7,toCreate:2,existing:0});
 const byLine=Object.fromEntries(preview.rows.map(r=>[r.line,r]));
 assert.equal(byLine[2].action,'crear');assert.equal(byLine[3].action,'crear');assert.equal(byLine[3].course,course.title);
 assert.match(byLine[4].errors[0],/Repite la pregunta de la fila 2/);assert.match(byLine[5].errors[0],/precios/i);assert.ok(byLine[6].errors.length);
 assert.match(byLine[7].errors[0],/marca «Marca Fantasma» no existe/);assert.match(byLine[8].errors[0],/Tema «astrologia»/);assert.match(byLine[9].errors[0],/curso «Curso Inventado»/);assert.match(byLine[10].errors[0],/COMPLETAR/);
 assert.equal((await entries()).length,before.length,'la vista previa no escribe nada');

 // aplicar: sólo las filas buenas, siempre como borrador y con los datos normalizados
 await call('/api/knowledge-import/apply',admin.cookie,{csv,fileHash:'no-coincide'},'POST',409);
 const done=await call('/api/knowledge-import/apply',admin.cookie,{csv,fileHash:preview.fileHash},'POST');
 assert.deepEqual([done.created,done.existing,done.failed],[2,0,7]);
 const after=await entries(),made=after.filter(e=>!before.some(b=>b.id===e.id));
 assert.equal(made.length,2);assert.ok(made.every(e=>e.status==='draft'&&!e.approved_at),'todo entra como borrador, nada aprobado');
 const factura=made.find(e=>/factura/.test(e.question));assert.equal(factura.topic,'payment');assert.deepEqual(factura.variants,['factura','recibo fiscal']);
 assert.equal(made.find(e=>/reposición/.test(e.question)).course_id,course.id);

 // repetir el mismo archivo no duplica: las dos ya existen
 const again=await call('/api/knowledge-import/preview',admin.cookie,{csv},'POST');assert.deepEqual([again.summary.toCreate,again.summary.existing],[0,2]);
 await call('/api/knowledge-import/apply',admin.cookie,{csv,fileHash:again.fileHash},'POST',400);
 assert.equal((await entries()).length,after.length);
});
