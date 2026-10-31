import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

test('rutas /api/automation: sólo administración, desactivadas por defecto, revisiones y pausa global',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-automation-http-')),code=randomUUID(),password='Password-automation-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),client=await call('/api/auth/register','',{username:'cliente',name:'Cliente',password});
 await call('/api/automation','',undefined,'GET',401);await call('/api/automation',client.cookie,undefined,'GET',403);
 const overview=await call('/api/automation',admin.cookie);assert.equal(overview.global.paused,false);assert.ok(overview.brands.length>=3&&overview.brands.every(b=>b.enabled===false&&b.revision===0));
 await call('/api/automation/brands/globalvet',client.cookie,{enabled:true,expectedRevision:0},'PATCH',403);
 await call('/api/automation/brands/globalvet',admin.cookie,{enabled:true},'PATCH',400);
 await call('/api/automation/brands/inexistente',admin.cookie,{enabled:true,expectedRevision:0},'PATCH',404);
 const on=await call('/api/automation/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:0},'PATCH');assert.equal(on.settings.enabled,1);assert.equal(on.settings.revision,1);
 await call('/api/automation/brands/globalvet',admin.cookie,{enabled:false,expectedRevision:0},'PATCH',409);
 const pause=await call('/api/automation/global',admin.cookie,{paused:true,expectedRevision:1},'PATCH');assert.deepEqual(pause.global,{paused:true,revision:2});
 await call('/api/automation/global',admin.cookie,{paused:false,expectedRevision:1},'PATCH',409);
 assert.deepEqual((await call('/api/automation/steps',admin.cookie)).steps,[]);
 await call('/api/automation/steps/'+randomUUID()+'/retry',admin.cookie,{},'POST',404);
 await call('/api/automation/inexistente',admin.cookie,undefined,'GET',404);
});
