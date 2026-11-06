import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {phone10} from '../server/allies.mjs';

async function boot(t,extraEnv={}){
 const dir=await mkdtemp(join(tmpdir(),'crm-allies-')),code=randomUUID(),password='Password-allies-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test',...extraEnv},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const reg=(username,inviteCode)=>call('/api/auth/register','',{username,name:'Prueba '+username,password,inviteCode});
 return {origin,dir,call,reg,code};
}
const good=(o={})=>({academy:'Academia Norte',contactName:'Laura Gómez',email:'laura@ejemplo.com',whatsapp:'55 1234 5678',city:'Monterrey',state:'Nuevo León',sector:'Salud',years:'5',studentsMonth:'20 a 50',issuesCertificates:'si',web:'https://norte.example.com',heardFrom:'Instagram',message:'Queremos certificar a nuestros alumnos.',...o});

test('teléfonos de 10 dígitos',()=>{
 assert.equal(phone10('55 1234 5678'),'5512345678');assert.equal(phone10('+52 (55) 1234-5678'),'5512345678');assert.equal(phone10('525512345678'),'5512345678');
 assert.equal(phone10('12345'),null);assert.equal(phone10(''),null);assert.equal(phone10(null),null);
});

test('Aliados por API: acceso por función, postulaciones con su recorrido y plazo de 24 horas, solicitudes de WhatsApp y permisos',async t=>{
 const {dir,call,reg,code}=await boot(t);
 const admin=await reg('admin',code),rh=await reg('recursos'),other=await reg('otro'),client=await reg('cliente');
 for(const [u,name,brands] of [[rh,'recursos',['globalvet']],[other,'otro',['odonteck']]]){const inv=await call('/api/team/invites',admin.cookie,{username:name,brandIds:brands},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});}

 // acceso: administración siempre; el equipo sólo con la función; los clientes nunca; todo cierra sin sesión
 await call('/api/allies','',undefined,'GET',401);await call('/api/allies',client.cookie,undefined,'GET',403);await call('/api/allies',rh.cookie,undefined,'GET',403);
 assert.equal((await call('/api/allies/me',rh.cookie)).allowed,false);assert.equal((await call('/api/allies/me',admin.cookie)).admin,true);
 await call('/api/allies/access',rh.cookie,{userId:'x',enabled:true},'PUT',403);
 const members=(await call('/api/allies/access',admin.cookie)).members,rhId=members.find(m=>m.username==='recursos').id;
 await call('/api/allies/access',admin.cookie,{userId:members.find(m=>m.role==='admin').id,enabled:true},'PUT',400);
 assert.equal((await call('/api/allies/access',admin.cookie,{userId:rhId,enabled:true},'PUT')).members.find(m=>m.id===rhId).enabled,true);
 assert.equal((await call('/api/allies/me',rh.cookie)).allowed,true);

 // validaciones al capturar una postulación
 const post=(b,cookie=rh.cookie,expected=201)=>call('/api/allies',cookie,b,'POST',expected);
 await post(good({academy:'A'}),rh.cookie,400);await post(good({contactName:''}),rh.cookie,400);await post(good({email:'no-es-correo'}),rh.cookie,400);
 await post(good({whatsapp:'12345'}),rh.cookie,400);await post(good({issuesCertificates:'quizá'}),rh.cookie,400);await post(good(),other.cookie,403);await post(good(),client.cookie,403);
 const ref=randomUUID(),a1=(await post(good({clientRef:ref}))).application;
 assert.deepEqual([a1.status,a1.whatsapp,a1.email,a1.overdue,a1.issuesLabel],['new','5512345678','laura@ejemplo.com',false,'Sí emite certificados']);
 assert.equal((await post(good({clientRef:ref}),rh.cookie,201)).application.id,a1.id,'reintento idempotente');
 assert.equal((await post(good({email:'LAURA@ejemplo.com'}))).application.id,a1.id,'la misma academia y correo en la semana no se repite');
 const a2=(await post(good({academy:'Instituto Sur',email:'sur@ejemplo.com',contactName:'Pedro Ruiz',city:'Mérida',issuesCertificates:''}))).application;
 const a3=(await post(good({academy:'Centro Oeste',email:'oeste@ejemplo.com'}))).application;

 // aviso a quienes llevan RH y plazo de 24 horas (se envejece una postulación en la base)
 const nRh=(await call('/api/operations/notifications',rh.cookie)).items.filter(n=>n.kind==='allies');assert.equal(nRh.length,3);assert.match(nRh[0].title,/Nueva postulación de aliado/);
 assert.equal((await call('/api/operations/notifications',other.cookie)).items.some(n=>n.kind==='allies'),false);
 const d=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});d.prepare('UPDATE ally_applications SET created_at=? WHERE id=?').run(Date.now()-30*3600000,a2.id);d.close();
 const all=await call('/api/allies',rh.cookie);
 assert.deepEqual([all.counts.total,all.counts.new,all.counts.overdue],[3,3,1]);assert.equal(all.rows[0].id,a2.id,'las nuevas van de la más antigua a la más reciente');assert.equal(all.rows[0].overdue,true);assert.ok(all.rows[0].hoursWaiting>=30);
 assert.deepEqual((await call('/api/allies?q=mérida',rh.cookie)).rows.map(r=>r.id),[a2.id]);assert.equal((await call('/api/allies?status=approved',rh.cookie)).rows.length,0);

 // recorrido: contactada → aprobada → invitación; o rechazada con motivo
 const mv=(id,op,b={},cookie=rh.cookie,expected=200)=>call('/api/allies/'+id+'/'+op,cookie,b,'POST',expected);
 await mv(a1.id,'contacted',{},other.cookie,403);
 const c1=(await mv(a1.id,'contacted',{note:'Hablamos por WhatsApp'})).application;assert.deepEqual([c1.status,c1.contactNote],['contacted','Hablamos por WhatsApp']);assert.match(c1.contactedBy,/recursos/);
 await mv(a1.id,'contacted',{},rh.cookie,409);await mv(a1.id,'invited',{},rh.cookie,409);
 const ap=(await mv(a1.id,'approve',{note:'Cumple el perfil'})).application;assert.equal(ap.status,'approved');assert.match(ap.decidedBy,/recursos/);
 await mv(a1.id,'reject',{note:'ya no'},rh.cookie,409);
 const txt=await call('/api/allies/'+a1.id+'/invite-text',rh.cookie);assert.match(txt.text,/^Hola Laura, gracias por postular a Academia Norte/);assert.equal(txt.whatsapp,'5512345678');
 const inv=(await mv(a1.id,'invited',{note:'Enviada por WhatsApp'})).application;assert.deepEqual([inv.status,typeof inv.invitedAt,inv.inviteNote],['approved','number','Enviada por WhatsApp']);
 await mv(a2.id,'reject',{},rh.cookie,400);const rj=(await mv(a2.id,'reject',{note:'No emite certificados ni planea hacerlo'})).application;assert.equal(rj.status,'rejected');
 await mv(randomUUID(),'contacted',{},rh.cookie,404);
 assert.deepEqual((await call('/api/allies',rh.cookie)).counts,{total:3,new:1,contacted:0,approved:1,rejected:1,overdue:0});

 // solicitudes de vinculación de WhatsApp: cualquier persona del equipo de la marca la registra; RH la atiende
 const rq=(b,cookie=rh.cookie,expected=201)=>call('/api/channel-requests',cookie,b,'POST',expected);
 const base={brandId:'globalvet',name:'Dra. Elena',role:'Dirección',phone:'55 9876 5432',schedule:'Lunes a viernes de 10 a 2',note:'Ya tenemos la cuenta de Meta'};
 await rq(base,client.cookie,403);await rq({...base,brandId:'odonteck'},rh.cookie,404);await rq({...base,phone:'123'},rh.cookie,400);await rq({...base,name:''},rh.cookie,400);await rq({...base,email:'mal'},rh.cookie,400);
 const rref=randomUUID(),r1=(await rq({...base,clientRef:rref})).request;assert.deepEqual([r1.status,r1.phone,r1.brand],['pending','5598765432','GlobalVet']);
 assert.equal((await rq({...base,clientRef:rref})).request.id,r1.id,'idempotente');await rq({...base,name:'Otra persona'},rh.cookie,409);
 await call('/api/channel-requests',other.cookie,undefined,'GET',403);
 const list=await call('/api/channel-requests',rh.cookie);assert.equal(list.pending,1);
 await call('/api/channel-requests/'+r1.id+'/contacted',other.cookie,{},'POST',403);
 assert.equal((await call('/api/channel-requests/'+r1.id+'/contacted',rh.cookie,{note:'Quedamos el jueves'},'POST')).request.status,'contacted');
 await call('/api/channel-requests/'+r1.id+'/contacted',rh.cookie,{},'POST',409);assert.equal((await call('/api/channel-requests',rh.cookie)).pending,0);

 // quitar la función corta el acceso de inmediato
 await call('/api/allies/access',admin.cookie,{userId:rhId,enabled:false},'PUT');await call('/api/allies',rh.cookie,undefined,'GET',403);
});

test('formulario público de aliados: apagado por omisión; encendido valida, escapa, atrapa robots y limita por IP',async t=>{
 const off=await boot(t);
 assert.equal((await fetch(off.origin+'/aliados')).status,404);assert.equal((await fetch(off.origin+'/aliados',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:off.origin},body:'academy=x'})).status,404);
 const on=await boot(t,{ALLY_FORM_ENABLED:'1'}),admin=await on.reg('admin',on.code);
 const form=(o)=>new URLSearchParams(o).toString();
 const send=(o,ip)=>fetch(on.origin+'/aliados',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:on.origin},body:form(o)});
 const page=await fetch(on.origin+'/aliados');assert.equal(page.status,200);const html=await page.text();
 assert.match(html,/<form method="post" action="\/aliados">/);assert.doesNotMatch(html,/<script/i,'la página no lleva scripts');assert.match(html,/revisión legal/);
 const ok={academy:'Academia <Pública>',contactName:'Ana Torres',email:'ana@ejemplo.com',whatsapp:'5511223344',issuesCertificates:'a_veces',consent:'1',message:'<img src=x onerror=alert(1)>'};
 // sin aceptar el uso de datos, o con datos mal puestos, se explica y se conservan los campos escritos (escapados)
 let r=await send({...ok,consent:''});assert.equal(r.status,400);let h=await r.text();assert.match(h,/aceptar el uso de tus datos/);assert.match(h,/Academia &lt;Pública&gt;/);assert.doesNotMatch(h,/<Pública>/);
 r=await send({...ok,email:'mal',consent:'1'});assert.equal(r.status,400);assert.match(await r.text(),/correo no parece válido/);
 // trampa para robots: responde como si funcionara y no guarda nada
 r=await send({...ok,website:'http://spam.example'});assert.equal(r.status,200);assert.match(await r.text(),/Gracias por postular/);
 assert.equal((await on.call('/api/allies',admin.cookie)).rows.length,0);
 // postulación válida: queda en la bandeja con su origen y su texto íntegro (se escapa al mostrarlo)
 r=await send(ok);assert.equal(r.status,200);assert.match(await r.text(),/Gracias por postular/);
 const rows=(await on.call('/api/allies',admin.cookie)).rows;assert.equal(rows.length,1);assert.deepEqual([rows[0].source,rows[0].academy,rows[0].whatsapp],['public','Academia <Pública>','5511223344']);
 assert.equal((await on.call('/api/allies',admin.cookie)).formEnabled,true);
 // límite por IP: cinco por hora
 for(let i=0;i<3;i++)await send(ok);
 r=await send(ok);assert.equal(r.status,429);
});
