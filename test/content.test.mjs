import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validateVariant,EVENTS} from '../server/content.mjs';
import {createAiProvider} from '../server/ai-provider.mjs';
import {fillTemplate,variables,scenarios} from '../server/catalogue.mjs';

test('contenido: relleno de variables, validación de variantes y variantes del proveedor simulado',async()=>{
  assert.equal(fillTemplate('Hola {{nombre}}, pedido {{pedido}} {{desconocida}}',{nombre:'Ana',pedido:'TC-1'}),'Hola Ana, pedido TC-1 ');
  for(const ev of Object.keys(EVENTS))assert.ok(scenarios.includes(ev),ev+' es un escenario de plantilla');
  for(const ev of Object.values(EVENTS))for(const v of ev.vars)assert.ok(variables.includes(v),v);
  const original='Hola {{nombre}}, tu pedido {{pedido}} por {{importe}}: {{enlace_pago}}';
  assert.equal(validateVariant('Estimado/a {{nombre}}, su pedido {{pedido}} por {{importe}} se paga aquí: {{enlace_pago}}',original),null);
  assert.match(validateVariant('Hola {{nombre}}',original),/omite variables/);
  assert.match(validateVariant(original+' {{secreto}}',original),/no existe/);
  assert.match(validateVariant(original+' visita https://otro-sitio.com/pagar',original),/enlace/);
  assert.match(validateVariant(original+' sólo $999',original),/importe/);
  assert.match(validateVariant('corto',original),/entre 10 y 3000/);
  const sim=createAiProvider({env:{}});
  const r=await sim.rewrite({brand:{name:'GlobalVet'},template:{title:'Pago confirmado',scenario:'payment_confirmed',body:'Hola {{nombre}}. Tu pago {{pedido}} quedó confirmado.\nTe esperamos en {{curso}}.'},tones:['formal','cercano','breve'],variables});
  assert.equal(r.variants.length,3);assert.equal(r.model,'simulado');
  const formal=r.variants.find(v=>v.tone==='formal').body;assert.ok(formal.startsWith('Estimado/a {{nombre}}'));assert.ok(formal.includes('{{pedido}}')&&formal.includes('{{curso}}'));
  assert.ok(r.variants.find(v=>v.tone==='cercano').body.startsWith('¡Hola, {{nombre}}'));
  const breve=r.variants.find(v=>v.tone==='breve').body;assert.ok(breve.includes('{{curso}}'),'la variante breve conserva las variables aunque recorte líneas');
  for(const v of r.variants)assert.equal(validateVariant(v.body,'Hola {{nombre}}. Tu pago {{pedido}} quedó confirmado.\nTe esperamos en {{curso}}.'),null);
});

test('contenido por API: funciones de diseño y aprobación, plantillas por evento en pago, sesión, certificado, grabación y anuncio; variantes; fichas con caché y flyer',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-content-')),code=randomUUID(),password='Password-content-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const raw=(path,cookie='')=>fetch(origin+path,{headers:{Cookie:cookie,Origin:origin}});
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),msgs=id=>'/api/conversations/'+id+'/messages';
 async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 assert.equal((await raw('/content.js')).status,200);
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const designer=await call('/api/auth/register','',{username:'disena',name:'Diseño',password}),approver=await call('/api/auth/register','',{username:'aprueba',name:'Coordinación',password}),seller=await call('/api/auth/register','',{username:'vende',name:'Venta',password});
 for(const u of [designer,approver,seller]){const inv=await call('/api/team/invites',admin.cookie,{username:u.user.username,brandIds:['globalvet']},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});}
 const cl=await call('/api/auth/register','',{username:'alumna',name:'Ana Pérez',password});

 // funciones de contenido: sin ellas, una asesora no crea plantillas; con diseño crea borradores; con aprobación aprueba y mapea
 const tpl={brandId:'globalvet',title:'Pago confirmado · GlobalVet',scenario:'payment_confirmed',channel:'all',text:'¡Gracias, {{nombre}}! Tu pago {{pedido}} por {{importe}} quedó confirmado. Ya estás en {{curso}} · {{edicion}}. Te escribimos por aquí con los accesos.'};
 await call('/api/catalogue/templates',seller.cookie,tpl,'POST',403);
 await call('/api/content/access',designer.cookie,{userId:designer.user.id,design:true},'PUT',403);
 await call('/api/content/access',admin.cookie,{userId:designer.user.id,design:true},'PUT');await call('/api/content/access',admin.cookie,{userId:approver.user.id,approve:true},'PUT');
 const me=await call('/api/content/me',designer.cookie);assert.equal(me.design,true);assert.equal(me.approve,false);
 const created=(await call('/api/catalogue/templates',designer.cookie,tpl,'POST',201)).item;assert.equal(created.status,'draft');
 await call('/api/catalogue/templates/'+created.id+'/approve',designer.cookie,{expectedRevision:created.revision},'POST',403);
 await call('/api/content/events/globalvet/payment_confirmed',approver.cookie,{templateId:created.id,expectedRevision:0},'PUT',409);   // sólo aprobadas
 const approved=(await call('/api/catalogue/templates/'+created.id+'/approve',approver.cookie,{expectedRevision:created.revision})).item;assert.equal(approved.status,'approved');
 await call('/api/content/events/globalvet/payment_confirmed',designer.cookie,{templateId:created.id,expectedRevision:0},'PUT',403);
 await call('/api/content/events/globalvet/no_existe',approver.cookie,{templateId:created.id,expectedRevision:0},'PUT',404);
 const map=(await call('/api/content/events/globalvet/payment_confirmed',approver.cookie,{templateId:created.id,expectedRevision:0},'PUT')).mapping;assert.equal(map.template_id,created.id);assert.equal(map.revision,1);
 const view=await call('/api/content/events?brand=globalvet',seller.cookie);assert.equal(view.events.length,8);const gv=view.brands[0];assert.equal(gv.mappings.find(m=>m.event==='payment_confirmed').templateTitle,'Pago confirmado · GlobalVet');assert.equal(view.access.design,false);
 // escenario equivocado para el evento
 const other=(await call('/api/catalogue/templates',admin.cookie,{...tpl,title:'Info',scenario:'info',text:'Info de {{curso}}'},'POST',201)).item;await call('/api/catalogue/templates/'+other.id+'/approve',admin.cookie,{expectedRevision:other.revision});
 await call('/api/content/events/globalvet/payment_confirmed',admin.cookie,{templateId:other.id,expectedRevision:1},'PUT',400);

 // pago confirmado → el mensaje al cliente sale de la plantilla mapeada; pago pendiente sin plantilla → texto fijo
 await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:0},'PATCH');
 const conv=(await call('/api/conversations',cl.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const o=(await call('/api/conversations/'+conv.id+'/orders',admin.cookie,{},'POST',201)).order;
 const link=(await call(msgs(conv.id),cl.cookie)).messages.at(-1);assert.match(link.text,/^Pedido de práctica/,'sin plantilla de pago pendiente se conserva el texto fijo');
 await call('/api/payments/orders/'+o.id+'/pay',cl.cookie,{method:'card'});
 const paid=(await call(msgs(conv.id),cl.cookie)).messages.at(-1);assert.equal(paid.text,'¡Gracias, Ana! Tu pago '+o.reference+' por $379.00 quedó confirmado. Ya estás en Plan sanitario para aves · Edición general. Te escribimos por aquí con los accesos.');assert.equal(paid.category,'utility');
 // pausar el mapa → vuelve el texto fijo
 await call('/api/content/events/globalvet/payment_confirmed',approver.cookie,{templateId:created.id,enabled:false,expectedRevision:1},'PUT');
 const cl2=await call('/api/auth/register','',{username:'alumno2',name:'Luis Gómez',password});
 const conv2=(await call('/api/conversations',cl2.cookie,{courseId:'aves',channel:'instagram'})).conversation;const o2=(await call('/api/conversations/'+conv2.id+'/orders',admin.cookie,{},'POST',201)).order;await call('/api/payments/orders/'+o2.id+'/pay',cl2.cookie,{method:'oxxo'});
 assert.match((await call(msgs(conv2.id),cl2.cookie)).messages.at(-1).text,/^Pago confirmado \(laboratorio\)/);

 // recordatorio de sesión y certificado por plantilla; grabación sólo con plantilla
 const mk=async(scenario,text)=>{const it=(await call('/api/catalogue/templates',designer.cookie,{brandId:'globalvet',title:'Plantilla '+scenario,scenario,channel:'all',text},'POST',201)).item;await call('/api/catalogue/templates/'+it.id+'/approve',approver.cookie,{expectedRevision:it.revision});return it;};
 const tRem=await mk('session_reminder','Recordatorio {{nombre}}: {{sesion}} el {{fecha_sesion}}. Enlace: {{enlace_sesion}}'),tCert=await mk('certificate_ready','{{nombre}}, tu certificado {{folio}} ({{asistencia}}) está aquí: {{enlace_certificado}}'),tRec=await mk('recording_available','{{nombre}}, ya puedes ver la grabación de {{sesion}}: {{grabacion}}');
 for(const [ev,tp] of [['session_reminder',tRem],['certificate_ready',tCert],['recording_available',tRec]])await call('/api/content/events/globalvet/'+ev,approver.cookie,{templateId:tp.id,expectedRevision:0},'PUT');
 await call('/api/coordination/brands/globalvet',admin.cookie,{enabled:true,autoOpen:true,reminderHours:48,expectedRevision:0},'PATCH');
 const ed=(await call('/api/coordination/editions/edition-aves',admin.cookie)).edition;
 const r1=(await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'open',expectedRevision:ed.run_revision},'POST')).edition;
 const s1=(await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{title:'Bienvenida',startsAt:Date.now()+3600000,durationMin:60},'POST',201)).session;
 const rem=await until(async()=>(await call(msgs(conv.id),cl.cookie)).messages.find(m=>/^Recordatorio Ana: 1\. Bienvenida el/.test(m.text)));assert.ok(rem,'recordatorio con la plantilla mapeada');assert.ok(rem.text.includes('Enlace: '),'variable de enlace resuelta (vacía si no hay enlace)');
 const res=await call('/api/coordination/editions/edition-aves/resources',admin.cookie,{kind:'recording',title:'Grabación 1',url:'https://example.com/grab-1',sessionId:s1.id},'POST',201);
 const rec=await until(async()=>(await call(msgs(conv.id),cl.cookie)).messages.find(m=>/ya puedes ver la grabación de 1\. Bienvenida: https:\/\/example\.com\/grab-1/.test(m.text)));assert.ok(rec,'grabación disponible avisa con la plantilla');
 assert.equal((await call('/api/events?brand=all&type=grabacion.disponible',admin.cookie)).events.length,1);
 // sin plantilla de grabación no se avisa
 await call('/api/content/events/globalvet/recording_available',approver.cookie,{templateId:null,expectedRevision:1},'PUT');
 await call('/api/coordination/editions/edition-aves/resources',admin.cookie,{kind:'recording',title:'Grabación 2',url:'https://example.com/grab-2',sessionId:s1.id},'POST',201);await sleep(2500);
 assert.ok(!(await call(msgs(conv.id),cl.cookie)).messages.some(m=>/grab-2/.test(m.text)),'sin plantilla mapeada la grabación no se anuncia');
 // certificado
 const r2=(await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'running',expectedRevision:r1.run_revision},'POST')).edition;
 const ids=(await call('/api/coordination/editions/edition-aves',admin.cookie)).enrollments.map(r=>r.id);
 await call('/api/coordination/sessions/'+s1.id+'/attendance',admin.cookie,{marks:ids.map(id=>({enrollmentId:id,status:'present'}))},'PUT');await call('/api/coordination/sessions/'+s1.id+'/done',admin.cookie,{});
 const issued=await call('/api/certificates/editions/edition-aves/issue',admin.cookie,{});assert.equal(issued.issued.length,2);
 const cert=(await call(msgs(conv.id),cl.cookie)).messages.at(-1);assert.match(cert.text,/^Ana, tu certificado IPCI-\d{4}-\d{5} \(100 %\) está aquí: \/verificar\//);
 void r2;void res;

 // bienvenida por anuncio: con plantilla mapeada sustituye la bienvenida del curso en la primera respuesta
 const tAd=await mk('ad_welcome','¡Hola, {{nombre}}! Viste nuestro anuncio de {{curso}} ({{marca}}). Precio vigente: {{precio}}.');
 await call('/api/content/events/globalvet/ad_welcome',approver.cookie,{templateId:tAd.id,expectedRevision:0},'PUT');
 const flyer=(await call('/api/catalogue',admin.cookie)).flyers.find(f=>f.brand_id==='globalvet'&&f.status==='approved'),course3=(await call('/api/catalogue',admin.cookie)).courses.find(c=>c.id===flyer.course_id).title;
 const cl3=await call('/api/auth/register','',{username:'alumno3',name:'Paola Flores',password});
 const conv3=(await call('/api/conversations',cl3.cookie,{courseId:flyer.course_id,editionId:flyer.edition_id,channel:'facebook',referral:{ad:'Flyer aves · prueba',campaign:'prueba-contenido',flyerId:flyer.id}})).conversation;assert.ok(conv3.referral,'la conversación registra la llegada por anuncio');
 await call(msgs(conv3.id),cl3.cookie,{text:'Hola, vi el anuncio',clientRef:randomUUID()},'POST',201);
 const welcome=await until(async()=>(await call(msgs(conv3.id),cl3.cookie)).messages.find(m=>m.sender_kind==='automation'));
 assert.ok(welcome);assert.match(welcome.text,/^¡Hola, Paola! Viste nuestro anuncio de .+ \(GlobalVet\)\. Precio vigente: \$/,'bienvenida por anuncio desde la plantilla');assert.ok(welcome.text.includes(course3),'el curso del anuncio');

 // variantes: diseño las pide; se validan; aceptar crea un borrador; rechazar no
 await call('/api/content/templates/'+created.id+'/variants',seller.cookie,{tones:['formal']},'POST',403);
 const vr=await call('/api/content/templates/'+created.id+'/variants',designer.cookie,{tones:['formal','cercano','breve']},'POST',201);
 assert.equal(vr.provider,'simulated');assert.equal(vr.variants.length,3);assert.equal(vr.rejected.length,0);assert.ok(vr.variants.every(v=>v.body.includes('{{pedido}}')&&v.body.includes('{{enlace_pago}}')===false));
 const list=(await call('/api/content/templates/'+created.id+'/variants',seller.cookie)).variants;assert.equal(list.length,3);
 const acc=await call('/api/content/variants/'+vr.variants[0].id+'/accept',designer.cookie,{});assert.equal(acc.variant.status,'accepted');assert.ok(acc.templateId);
 const draft=(await call('/api/catalogue',admin.cookie)).templates.find(t=>t.id===acc.templateId);assert.equal(draft.status,'draft');assert.equal(draft.scenario,'payment_confirmed');assert.match(draft.title,/variante formal/);assert.ok(draft.body.includes('Su pago {{pedido}}')&&draft.body.endsWith('Quedamos atentos a cualquier duda.'),'variante formal conservada');
 await call('/api/content/variants/'+vr.variants[0].id+'/accept',designer.cookie,{},'POST',409);
 assert.equal((await call('/api/content/variants/'+vr.variants[1].id+'/reject',approver.cookie,{})).variant.status,'rejected');
 await call('/api/content/variants/'+vr.variants[2].id+'/reject',seller.cookie,{},'POST',403);

 // fichas: SVG desde el catálogo con caché por versión; guardar como flyer en borrador (diseño)
 const sh1=await raw('/api/content/sheets/edition-aves.svg',seller.cookie);assert.equal(sh1.status,200);assert.match(sh1.headers.get('content-type'),/image\/svg\+xml/);assert.equal(sh1.headers.get('x-sheet-cache'),'miss');const svg=await sh1.text();assert.ok(svg.includes('Plan sanitario')&&svg.includes('379.00')&&svg.includes('<path d="M'),'la ficha trae curso, precio y QR');
 assert.equal((await raw('/api/content/sheets/edition-aves.svg',seller.cookie)).headers.get('x-sheet-cache'),'hit');
 await raw('/api/content/sheets/edition-aves.svg',cl.cookie).then(r=>assert.equal(r.status,403));
 const editions=(await call('/api/catalogue',admin.cookie)).editions,e=editions.find(x=>x.id==='edition-aves');
 await call('/api/catalogue/editions/edition-aves',admin.cookie,{expectedRevision:e.revision,courseId:e.course_id,name:e.name,timezone:e.timezone,modality:e.modality,price:'399.00',currency:e.currency,status:e.status,instructor:'Dra. Ríos'},'PATCH');
 const sh2=await raw('/api/content/sheets/edition-aves.svg',seller.cookie);assert.equal(sh2.headers.get('x-sheet-cache'),'miss','cambió la edición: se regenera');assert.ok((await sh2.text()).includes('399.00'));
 await call('/api/content/sheets/edition-aves/flyer',seller.cookie,{},'POST',403);
 const fl=await call('/api/content/sheets/edition-aves/flyer',designer.cookie,{title:'Ficha aves'},'POST',201);
 const flyers=(await call('/api/catalogue',admin.cookie)).flyers,made=flyers.find(f=>f.id===fl.flyerId);assert.equal(made.status,'draft');assert.equal(made.mime,'image/svg+xml');assert.equal(made.title,'Ficha aves');
 const file=await raw(made.fileUrl,admin.cookie);assert.equal(file.status,200);assert.match(file.headers.get('content-type'),/svg/);
 const apFl=(await call('/api/catalogue/flyers/'+made.id+'/approve',approver.cookie,{expectedRevision:made.revision})).item;assert.equal(apFl.status,'approved','la ficha generada se aprueba como cualquier flyer');

 // administración ve las funciones; revocar diseño
 const members=(await call('/api/content/access',admin.cookie)).members;assert.ok(members.find(m=>m.id===designer.user.id).design);assert.ok(members.find(m=>m.id===approver.user.id).approve);
 await call('/api/content/access',admin.cookie,{userId:designer.user.id},'PUT');await call('/api/catalogue/templates',designer.cookie,tpl,'POST',403);
 const d=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});try{assert.equal(d.prepare('PRAGMA user_version').get().user_version,24);assert.equal(d.prepare("SELECT count(*) n FROM template_variants WHERE status='accepted'").get().n,1);assert.equal(d.prepare('SELECT count(*) n FROM content_sheets').get().n,1);}finally{d.close();}
});
