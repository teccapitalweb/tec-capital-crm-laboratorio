import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

async function start(t,extra={}){
 const dir=await mkdtemp(join(tmpdir(),'crm-app-')),code=randomUUID(),password='Password-app-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',...extra},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 const sentOrigin=extra.APP_ORIGIN||origin;   // con APP_ORIGIN fijado, el servidor sólo acepta peticiones de ese origen
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:sentOrigin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 return {origin,call,admin,password};
}

test('app de prueba del cliente: la portada instala el chat (no el CRM) y el equipo obtiene enlace y QR de invitación sólo de sus marcas',async t=>{
 const {origin,call,admin,password}=await start(t);
 // la portada del cliente y el CRM del equipo anuncian apps distintas
 const home=await (await fetch(origin+'/')).text(),crm=await (await fetch(origin+'/crm')).text();
 assert.match(home,/href="\/manifest-cliente\.webmanifest"/);assert.match(home,/apple-mobile-web-app-title" content="Chat de prueba"/);assert.doesNotMatch(home,/href="\/manifest\.webmanifest"/);
 assert.match(crm,/href="\/manifest\.webmanifest"/);assert.doesNotMatch(crm,/manifest-cliente/);
 const mr=await fetch(origin+'/manifest-cliente.webmanifest');assert.equal(mr.status,200);assert.match(mr.headers.get('content-type'),/manifest\+json/);const m=await mr.json();
 assert.equal(m.start_url,'/');assert.equal(m.display,'standalone');assert.equal(m.short_name,'Chat de prueba');assert.match(m.description,/No es WhatsApp/);assert.ok(m.icons.length>=2);
 const team=await (await fetch(origin+'/manifest.webmanifest')).json();assert.equal(team.start_url,'/crm');assert.notEqual(m.id,team.id||team.start_url,'son dos apps distintas para el navegador');

 // invitación: sólo equipo, curso activo y marca a su alcance
 const ana=await call('/api/auth/register','',{username:'ana',name:'Ana',password});
 await call('/api/presentation/invite?course=aves','',undefined,'GET',401);await call('/api/presentation/invite?course=aves',ana.cookie,undefined,'GET',403);
 await call('/api/presentation/invite?course=aves',admin.cookie,{},'POST',405);await call('/api/presentation/invite?course=no-existe',admin.cookie,undefined,'GET',404);
 const inv=await call('/api/presentation/invite?course=aves&channel=instagram',admin.cookie);
 assert.equal(inv.url,origin+'/?curso=aves&canal=instagram');assert.equal(inv.courseId,'aves');assert.equal(inv.channel,'instagram');assert.match(inv.svg,/^<svg /);assert.doesNotMatch(inv.svg,/<script|onload|href=/i,'el QR es sólo un dibujo');
 assert.equal((await call('/api/presentation/invite?course=aves&channel=telegram',admin.cookie)).channel,'whatsapp','un canal desconocido cae en el de omisión');
 const otro=await call('/api/auth/register','',{username:'otro',name:'Otro',password});const i2=await call('/api/team/invites',admin.cookie,{username:'otro',brandIds:['odonteck']},'POST',201);await call('/api/team/accept',otro.cookie,{token:i2.token});
 await call('/api/presentation/invite?course=aves',otro.cookie,undefined,'GET',404);   // GlobalVet no es su marca
 assert.match((await call('/api/presentation/invite?course=odontologia',otro.cookie)).url,/curso=odontologia&canal=whatsapp$/);

 // el enlace no crea nada por sí solo: quien lo abre recibe la portada y crea su propio perfil
 const landing=await fetch(inv.url);assert.equal(landing.status,200);assert.match(await landing.text(),/manifest-cliente/);
});

test('invitación a probar: con APP_ORIGIN el enlace usa el dominio público, no la cabecera Host',async t=>{
 const {call,admin}=await start(t,{APP_ORIGIN:'https://laboratorio.ejemplo.test'});
 const inv=await call('/api/presentation/invite?course=aves',admin.cookie);
 assert.equal(inv.url,'https://laboratorio.ejemplo.test/?curso=aves&canal=whatsapp','el enlace sale del origen configurado, sin depender de Host');
});
