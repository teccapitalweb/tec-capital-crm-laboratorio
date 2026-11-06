import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {nextOpening,openingLabel} from '../server/service-hours.mjs';

test('próxima apertura: salta noches, fines de semana y festivos en la zona de la marca',()=>{
 const week=[null,[540,1080],[540,1080],[540,1080],[540,1080],[540,1080],null],policy={timezone:'America/Mexico_City',hours:week,holidays:[]};
 const fridayNight=Date.UTC(2026,10,7,2,0);   // viernes 6 nov, 20:00 en Ciudad de México (UTC-6)
 assert.equal(nextOpening(fridayNight,policy),Date.UTC(2026,10,9,15,0),'el lunes 9:00 local');
 assert.match(openingLabel(fridayNight,policy),/^lunes 9 de noviembre.*9:00/);
 const holiday={...policy,holidays:[{date:'2026-11-09'}]};assert.equal(nextOpening(fridayNight,holiday),Date.UTC(2026,10,10,15,0),'si el lunes es festivo, el martes');
 assert.equal(nextOpening(fridayNight,{...policy,hours:Array(7).fill(null)}),null);assert.equal(openingLabel(fridayNight,{...policy,hours:Array(7).fill(null)}),'el próximo día hábil');
});

test('mensaje de fuera de horario: sólo con plantilla aprobada y mapeada, una vez cada 12 horas, sin pisar la respuesta',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-away-')),code=randomUUID(),password='Password-away-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),msgs=id=>'/api/conversations/'+id+'/messages';
 async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),client=await call('/api/auth/register','',{username:'cliente',name:'Ana Pérez',password});

 // el evento existe en Contenido y el escenario es válido
 assert.ok((await call('/api/content/events',admin.cookie)).events.some(e=>e.id==='away_hours'));

 // la marca está cerrada hoy (festivo), y sin plantilla mapeada no se envía nada
 const cfg=(await call('/api/operations/brands/globalvet',admin.cookie)).settings;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:cfg.timezone}).format(new Date());
 await call('/api/operations/brands/globalvet',admin.cookie,{expectedRevision:cfg.revision,hours:cfg.hours,timezone:cfg.timezone,routingEnabled:false,slaEnabled:false,memberIds:[],firstMinutes:30,nextMinutes:60,holidays:[{date:today,name:'Hoy de prueba'}]},'PATCH');
 const conv=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 await call(msgs(conv.id),client.cookie,{text:'Quiero hablar con un asesor',clientRef:randomUUID()},'POST',201);
 assert.ok(await until(async()=>(await call(msgs(conv.id),client.cookie)).messages.find(m=>m.sender_kind==='automation')),'responde que pasa a una persona');
 await sleep(500);
 assert.equal((await call(msgs(conv.id),client.cookie)).messages.filter(m=>m.sender_kind==='automation').length,1,'sin plantilla mapeada no hay aviso de horario');

 // con plantilla aprobada y mapeada: se envía una sola vez, con la próxima apertura
 const tpl=(await call('/api/catalogue/templates',admin.cookie,{brandId:'globalvet',title:'Fuera de horario',scenario:'away_hours',channel:'all',text:'Hola {{nombre}}, ya cerramos en {{marca}}. Te respondemos {{apertura}}.'},'POST',201)).item;
 await call('/api/catalogue/templates/'+tpl.id+'/approve',admin.cookie,{expectedRevision:tpl.revision});
 await call('/api/content/events/globalvet/away_hours',admin.cookie,{templateId:tpl.id,expectedRevision:0},'PUT');
 const client2=await call('/api/auth/register','',{username:'cliente2',name:'Ana Pérez',password});
 const conv2=(await call('/api/conversations',client2.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 await call(msgs(conv2.id),client2.cookie,{text:'Quiero hablar con un asesor',clientRef:randomUUID()},'POST',201);
 const away=await until(async()=>(await call(msgs(conv2.id),client2.cookie)).messages.find(m=>m.sender_kind==='automation'&&/ya cerramos/.test(m.text)));
 assert.ok(away,'llega el aviso');assert.match(away.text,/^Hola Ana, ya cerramos en GlobalVet\. Te respondemos .+\d.*\.$/);assert.doesNotMatch(away.text,/\{\{/);
 const all=(await call(msgs(conv2.id),client2.cookie)).messages.filter(m=>m.sender_kind==='automation');
 assert.equal(all.length,2,'la respuesta de escalamiento y el aviso de horario');assert.ok(/asesor|equipo/i.test(all[0].text),'primero la respuesta, luego el aviso');

 // un segundo mensaje dentro de las 12 horas no repite el aviso
 await call(msgs(conv2.id),client2.cookie,{text:'Sigo esperando',clientRef:randomUUID()},'POST',201);await sleep(1200);
 assert.equal((await call(msgs(conv2.id),client2.cookie)).messages.filter(m=>m.sender_kind==='automation'&&/ya cerramos/.test(m.text)).length,1);
});
