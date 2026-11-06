import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

test('Preparar marca: sólo lectura para administración, refleja lo que se enciende y respeta permisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-readiness-')),code=randomUUID(),password='Password-readiness-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),client=await call('/api/auth/register','',{username:'cliente',name:'Cliente Uno',password});

 // permisos: sin sesión no hay lectura; un cliente no puede verla; sólo se acepta GET
 await call('/api/readiness','',undefined,'GET',401);
 await call('/api/readiness',client.cookie,undefined,'GET',403);
 await call('/api/readiness',admin.cookie,{},'POST',405);

 // base recién creada: una lista por marca, con pasos esenciales y extras, todo con dónde arreglarlo
 const first=await call('/api/readiness',admin.cookie);
 assert.ok(first.brands.length>=1);
 const b=first.brands.find(x=>x.id==='globalvet');assert.ok(b);
 const ids=b.steps.map(s=>s.id);
 for(const id of ["course","edition","knowledge","team","away","automation","payments","campaigns"])assert.ok(ids.includes(id),id);
 for(const s of b.steps){assert.ok(s.title&&s.detail&&s.view&&s.label,s.id);assert.equal(typeof s.done,'boolean');assert.equal(typeof s.required,'boolean');}
 assert.equal(b.essentials.total,b.steps.filter(s=>s.required).length);
 assert.equal(b.steps.find(s=>s.id==='automation').done,false);   // todo nace apagado
 assert.equal(b.steps.find(s=>s.id==='payments').done,false);
 assert.equal(b.steps.find(s=>s.id==='course').done,true);        // el catálogo de demostración trae cursos activos
 assert.equal(b.ready,false);
 assert.ok(b.nextStepId&&b.steps.find(s=>s.id===b.nextStepId).required,'el siguiente paso es un esencial pendiente');

 // encender pagos cambia el paso, y la lectura no modificó la configuración (la revisión sigue en 1 tras el primer PATCH)
 const on=(await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,linkHours:48,expectedRevision:0},'PATCH')).settings;assert.equal(on.revision,1);
 const second=(await call('/api/readiness',admin.cookie)).brands.find(x=>x.id==='globalvet');
 assert.equal(second.steps.find(s=>s.id==='payments').done,true);
 assert.equal(second.extras.done,first.brands.find(x=>x.id==='globalvet').extras.done+1);
 assert.equal((await call('/api/payments/settings',admin.cookie)).settings.find(s=>s.brand_id==='globalvet').revision,1);
});
