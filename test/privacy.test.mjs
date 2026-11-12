import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privacyPage,PRIVACY_UPDATED} from '../server/privacy.mjs';

test('aviso de privacidad: texto base con empresa y contacto del entorno, sin inyectar HTML',()=>{
  const plain=privacyPage();assert.match(plain,/<title>Aviso de privacidad · TEC Capital<\/title>/);assert.ok(plain.includes(PRIVACY_UPDATED));
  for(const part of ['Qué datos recibimos','Para qué los usamos','inteligencia artificial','Con quién se comparten','Tus derechos','id="eliminar-datos"','«BAJA»','No guardamos los datos de tu tarjeta'])assert.ok(plain.includes(part),part);
  assert.equal(plain.includes('mailto:'),false,'sin correo configurado no inventa uno');assert.ok(plain.includes('por el mismo chat en el que hablas con nosotros'));
  const full=privacyPage({company:'IPCI <script>alert(1)</script> & Asociados',email:'privacidad@ejemplo.mx'});
  assert.equal(full.includes('<script>'),false);assert.ok(full.includes('IPCI scriptalert(1)/script &amp; Asociados'));assert.ok(full.includes('<a href="mailto:privacidad@ejemplo.mx">privacidad@ejemplo.mx</a>'));
  assert.equal(privacyPage({email:'no es un correo"><img src=x>'}).includes('<img'),false,'un correo mal formado se ignora');
});

test('/privacidad es pública: sin sesión, sin cookies, y no rompe las demás rutas',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'crm-priv-'));let logs='';
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:'codigo-de-prueba-privacidad',APP_ORIGIN:'',NODE_ENV:'test',PRIVACY_COMPANY:'Empresa de Prueba',PRIVACY_CONTACT_EMAIL:'privacidad@ejemplo.mx'},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
  const r=await fetch(origin+'/privacidad');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^text\/html/);assert.equal(r.headers.get('set-cookie'),null);
  const html=await r.text();assert.ok(html.includes('Empresa de Prueba'));assert.ok(html.includes('mailto:privacidad@ejemplo.mx'));
  assert.equal((await fetch(origin+'/privacidad/')).status,200);assert.equal((await fetch(origin+'/privacidad',{method:'POST'})).status,405);
  assert.equal((await fetch(origin+'/api/bootstrap')).status,401);assert.equal((await fetch(origin+'/')).status,200);
});
