import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../server/database.mjs';
import {migrateCRM} from '../server/crm.mjs';
import {migrateFollowup} from '../server/followup.mjs';
import {migrateCatalogue} from '../server/catalogue-schema.mjs';

test('catálogo v0.4: ediciones, vigencia, biblioteca aprobada y mensajes inmutables',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-catalogue-')),code=randomUUID(),password='Password-catalogue-2026!';let server,origin,logs='';
 const start=async()=>{server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});};
 const stop=async()=>{if(server?.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});};
 t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});await start();
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const reg=(username,inviteCode)=>call('/api/auth/register','',{username,name:'Prueba '+username,password,inviteCode});
 const admin=await reg('admin',code),agent=await reg('asesor'),client=await reg('cliente'),outsider=await reg('externo');
 const invite=await call('/api/team/invites',admin.cookie,{username:'asesor',brandIds:['globalvet']},'POST',201);await call('/api/team/accept',agent.cookie,{token:invite.token});
 const cat=()=>call('/api/catalogue',admin.cookie),day=86400000,baseEdition={courseId:'aves',name:'Edición de diciembre',startsAt:Date.now()+30*day,endsAt:Date.now()+30*day+7200000,timezone:'America/Mexico_City',instructor:'Docente de prueba',modality:'online',location:'Aula de práctica',capacity:40,availableSeats:12,infoUrl:'https://example.com/curso',price:599.5,currency:'MXN',status:'published'};
 let edition,promotion,flyer,template,conversation,fileId,sent;
 const item=(type,id)=>cat().then(c=>c[type].find(x=>x.id===id));
 await t.test('migración conserva seis flyers y añade ediciones y packs por marca',async()=>{
   const c=await cat();assert.equal(c.editions.length,6);assert.equal(c.flyers.length,6);assert.equal(c.templates.length,18);assert.ok(c.editions.every(e=>e.starts_at===null&&e.status==='published'));assert.ok(c.flyers.every(f=>f.availability==='Listo para enviar'));
   const allowed=await call('/api/catalogue',agent.cookie);assert.equal(allowed.flyers.length,2);assert.equal(allowed.templates.length,6);assert.ok(allowed.courses.every(c=>c.brand_id==='globalvet'));
   await call('/api/catalogue',client.cookie,undefined,'GET',403);await call('/api/catalogue/editions',agent.cookie,baseEdition,'POST',403);
 });
 await t.test('nuevas marcas reciben seis plantillas sin conceder acceso a otros asesores',async()=>{
   const brand=await call('/api/brands',admin.cookie,{name:'Marca nueva de prueba'},'POST',201);
   const templates=(await cat()).templates.filter(t=>t.brand_id===brand.id);assert.equal(templates.length,6);assert.ok(templates.every(t=>t.status==='approved'));
   assert.equal((await call('/api/catalogue',agent.cookie)).templates.filter(t=>t.brand_id===brand.id).length,0);
 });
 await t.test('ediciones validan fechas, zona, cupos, moneda y revisiones',async()=>{
   for(const invalid of [{endsAt:Date.now()},{timezone:'Zona/Inexistente'},{availableSeats:50},{price:1.001},{infoUrl:'javascript:alert(1)'},{status:'published',startsAt:null}])await call('/api/catalogue/editions',admin.cookie,{...baseEdition,...invalid},'POST',400);
   edition=(await call('/api/catalogue/editions',admin.cookie,baseEdition,'POST',201)).item;
   await call('/api/catalogue/editions/'+edition.id,admin.cookie,{...baseEdition,expectedRevision:0},'PATCH',409);
   const publicEditions=await call('/api/courses/aves/editions',client.cookie);assert.ok(publicEditions.editions.some(e=>e.id===edition.id));
   const draft=(await call('/api/catalogue/editions',admin.cookie,{...baseEdition,name:'Borrador oculto',status:'draft'},'POST',201)).item;
   await call('/api/conversations',client.cookie,{courseId:'aves',editionId:draft.id,channel:'whatsapp'},'POST',409);
   await call('/api/conversations',client.cookie,{courseId:'piel',editionId:edition.id,channel:'whatsapp'},'POST',400);
 });
 await t.test('promociones exclusivas por edición y fechas; precio con centavos',async()=>{
   const body={editionId:edition.id,name:'Acceso anticipado',price:449.75,startsAt:Date.now()-1000,endsAt:Date.now()+day,status:'published'};
   promotion=(await call('/api/catalogue/promotions',admin.cookie,body,'POST',201)).item;
   await call('/api/catalogue/promotions',admin.cookie,body,'POST',409);
   await call('/api/catalogue/promotions',admin.cookie,{...body,price:700},'POST',400);
   await call('/api/catalogue/promotions',admin.cookie,{...body,endsAt:edition.starts_at+day},'POST',400);
   await call('/api/catalogue/editions/'+edition.id,admin.cookie,{...baseEdition,price:200,expectedRevision:edition.revision},'PATCH',400);
   assert.equal((await item('editions',edition.id)).effectivePriceCents,44975);
 });
 await t.test('dos ediciones tienen conversaciones e intereses independientes',async()=>{
   conversation=(await call('/api/conversations',client.cookie,{courseId:'aves',editionId:edition.id,channel:'whatsapp'})).conversation;
   const other=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
   assert.notEqual(other.id,conversation.id);assert.notEqual(other.opportunity_id,conversation.opportunity_id);assert.equal(conversation.edition_name,edition.name);
 });
 await t.test('archivos y borradores: sólo administración aprueba, alcance por marca',async()=>{
   const png=await readFile('public/flyers/globalvet-aves-v1.png');
   await call('/api/catalogue/files',admin.cookie,{brandId:'globalvet',file:{name:'incorrecto.png',type:'image/png',base64:'bm8='}},'POST',400);
   fileId=(await call('/api/catalogue/files',admin.cookie,{brandId:'globalvet',file:{name:'flyer-ensayo.png',type:'image/png',base64:png.toString('base64')}},'POST',201)).id;
   flyer=(await call('/api/catalogue/flyers',admin.cookie,{editionId:edition.id,promotionId:promotion.id,fileId,title:'Flyer aprobado de prueba',channel:'whatsapp',expiresAt:Date.now()+2*day},'POST',201)).item;
   await call('/api/catalogue/flyers/'+flyer.id+'/approve',agent.cookie,{expectedRevision:flyer.revision},'POST',403);
   await call('/api/conversations/'+conversation.id+'/materials/preview',agent.cookie,{flyerId:flyer.id,kind:'flyer'},'POST',409);
   flyer=(await call('/api/catalogue/flyers/'+flyer.id+'/approve',admin.cookie,{expectedRevision:flyer.revision})).item;
   assert.equal((await item('flyers',flyer.id)).availability,'Listo para enviar');
   assert.equal((await fetch(origin+'/api/library/files/'+fileId,{headers:{Cookie:client.cookie}})).status,404);
   const other=(await cat()).flyers.find(f=>f.brand_id==='odonteck');assert.equal((await fetch(origin+other.fileUrl,{headers:{Cookie:agent.cookie}})).status,404);
   await call('/api/catalogue/flyers/'+flyer.id,admin.cookie,{editionId:'edition-piel',fileId,title:'Cruce de marca',expectedRevision:flyer.revision},'PATCH',400);
 });
 await t.test('plantillas resuelven variables, rechazan desconocidas y exigen aprobación',async()=>{
   const body={brandId:'globalvet',courseId:'aves',editionId:edition.id,flyerId:flyer.id,title:'Pack de información',scenario:'price',channel:'whatsapp',text:'Hola {{nombre}}. {{curso}} · {{edicion}}\n{{fecha}}\n{{precio}} · {{promocion}}\n{{docente}}\n{{vigencia}}'};
   await call('/api/catalogue/templates',admin.cookie,{...body,text:'{{secreto}}'},'POST',400);
   template=(await call('/api/catalogue/templates',admin.cookie,body,'POST',201)).item;
   const preview=await call('/api/catalogue/preview',agent.cookie,{templateId:template.id,editionId:edition.id,name:'Lucía'});assert.match(preview.text,/Lucía/);assert.match(preview.text,/449\.75/);assert.match(preview.text,/America\/Mexico_City/);assert.ok(!preview.text.includes('{{'));
   await call('/api/conversations/'+conversation.id+'/materials/preview',agent.cookie,{templateId:template.id},'POST',409);
   template=(await call('/api/catalogue/templates/'+template.id+'/approve',admin.cookie,{expectedRevision:template.revision})).item;
   const wrong=(await call('/api/conversations',client.cookie,{courseId:'aves',editionId:edition.id,channel:'instagram'})).conversation;
   await call('/api/conversations/'+wrong.id+'/materials/preview',agent.cookie,{templateId:template.id},'POST',409);
 });
 await t.test('envío previsualizado es idempotente y conserva precio, edición, texto y archivo',async()=>{
   const preview=await call('/api/conversations/'+conversation.id+'/materials/preview',agent.cookie,{templateId:template.id}),clientRef=randomUUID();
   const payload={templateId:template.id,previewToken:preview.previewToken,clientRef};
   const results=await Promise.all([call('/api/conversations/'+conversation.id+'/materials/send',agent.cookie,payload),call('/api/conversations/'+conversation.id+'/materials/send',agent.cookie,payload)]);assert.equal(results[0].id,results[1].id);
   sent=(await call('/api/conversations/'+conversation.id+'/messages',client.cookie)).messages.find(m=>m.id===results[0].id);assert.equal(sent.commercial_snapshot.priceCents,44975);assert.equal(sent.commercial_snapshot.editionId,edition.id);
   const asset=await fetch(origin+sent.attachmentUrl,{headers:{Cookie:client.cookie}});assert.equal(asset.status,200);assert.equal(asset.headers.get('content-type'),'image/png');
   assert.equal((await fetch(origin+sent.attachmentUrl,{headers:{Cookie:outsider.cookie}})).status,404);
   const snapshot=await call('/api/crm',admin.cookie),o=snapshot.opportunities.find(o=>o.id===conversation.opportunity_id);assert.equal(JSON.parse(o.offer_snapshot).priceCents,44975);
   const history=await call('/api/crm/opportunities/'+o.id+'/history',agent.cookie);assert.ok(history.events.some(e=>e.kind==='offer'&&e.details.priceCents===44975));
 });
 await t.test('cambio comercial bloquea flyer y vista previa antiguos, sin alterar lo enviado',async()=>{
   const preview=await call('/api/conversations/'+conversation.id+'/materials/preview',agent.cookie,{kind:'price'});
   edition=(await call('/api/catalogue/editions/'+edition.id,admin.cookie,{...baseEdition,price:649.5,expectedRevision:edition.revision},'PATCH')).item;
   assert.equal((await item('flyers',flyer.id)).availability,'Requiere revisión');
   await call('/api/conversations/'+conversation.id+'/materials/send',agent.cookie,{kind:'price',previewToken:preview.previewToken,clientRef:randomUUID()},'POST',409);
   await call('/api/catalogue/flyers/'+flyer.id+'/approve',admin.cookie,{expectedRevision:flyer.revision},'POST',409);
   const after=(await call('/api/conversations/'+conversation.id+'/messages',client.cookie)).messages.find(m=>m.id===sent.id);assert.deepEqual(after.commercial_snapshot,sent.commercial_snapshot);assert.equal(after.text,sent.text);
   assert.equal((await fetch(origin+sent.attachmentUrl,{headers:{Cookie:client.cookie}})).status,200);
   const draft=await call('/api/catalogue/templates/'+template.id,admin.cookie,{...template,courseId:template.course_id,editionId:template.edition_id,brandId:template.brand_id,flyerId:template.flyer_id,text:template.body+'\nTexto nuevo',expectedRevision:template.revision},'PATCH');assert.equal(draft.item.status,'draft');
 });
 await t.test('vencimientos y material programado no se envían; el bot consulta el precio reciente',async()=>{
   const db=openDatabase(dir);db.prepare('UPDATE promotions SET ends_at=? WHERE id=?').run(Date.now()-1,promotion.id);db.close();
   const preview=await call('/api/conversations/'+conversation.id+'/materials/preview',agent.cookie,{kind:'price'});assert.equal(preview.commercial.priceCents,64950);assert.equal(preview.commercial.promotionId,null);
   await call('/api/conversations/'+conversation.id+'/materials/preview',agent.cookie,{kind:'flyer',flyerId:flyer.id},'POST',409);
   await call('/api/conversations/'+conversation.id+'/action',agent.cookie,{action:'automate'});
   await call('/api/conversations/'+conversation.id+'/messages',client.cookie,{text:'Precio actual',clientRef:randomUUID()},'POST',201);
   let messages;for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));messages=await call('/api/conversations/'+conversation.id+'/messages',client.cookie);if(messages.messages.some(m=>m.sender_kind==='automation'&&m.text.includes('649.50')))break;}
   assert.ok(messages.messages.some(m=>m.sender_kind==='automation'&&m.text.includes('649.50')));
   const future=(await call('/api/catalogue/promotions',admin.cookie,{editionId:edition.id,name:'Futura',price:399,startsAt:Date.now()+day,endsAt:Date.now()+2*day,status:'published'},'POST',201)).item;
   assert.equal((await item('promotions',future.id)).availability,'Programada');assert.equal((await item('editions',edition.id)).effectivePriceCents,64950);
 });
 await t.test('reemplazar el archivo crea otra versión y conserva los bytes enviados',async()=>{
   const original=Buffer.from(await (await fetch(origin+sent.attachmentUrl,{headers:{Cookie:client.cookie}})).arrayBuffer());
   const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRbcAAAAASUVORK5CYII=';
   const uploaded=await call('/api/catalogue/files',admin.cookie,{brandId:'globalvet',file:{name:'nuevo.png',type:'image/png',base64:png}},'POST',201);
   const current=await item('flyers',flyer.id);const draft=(await call('/api/catalogue/flyers/'+flyer.id,admin.cookie,{title:'Versión nueva',editionId:edition.id,fileId:uploaded.id,promotionId:null,channel:'all',expectedRevision:current.revision},'PATCH')).item;
   assert.equal(draft.status,'draft');await call('/api/catalogue/flyers/'+flyer.id+'/approve',admin.cookie,{expectedRevision:draft.revision});
   const oldAgain=Buffer.from(await (await fetch(origin+sent.attachmentUrl,{headers:{Cookie:client.cookie}})).arrayBuffer());assert.deepEqual(oldAgain,original);
   const history=await call('/api/catalogue/flyer/'+flyer.id+'/history',agent.cookie);assert.ok(history.events.some(e=>e.snapshot.file_id===fileId));assert.ok(history.events.some(e=>e.snapshot.file_id===uploaded.id));
 });
 await t.test('PDF histórico y edición archivada: consulta conservada y nuevos envíos bloqueados',async()=>{
   const pdf=Buffer.from('%PDF-1.4\n% archivo de prueba\n%%EOF');const file=(await call('/api/catalogue/files',admin.cookie,{brandId:'globalvet',file:{name:'temario.pdf',type:'application/pdf',base64:pdf.toString('base64')}},'POST',201)).id;
   let f=(await call('/api/catalogue/flyers',admin.cookie,{editionId:edition.id,fileId:file,title:'Programa PDF',channel:'all'},'POST',201)).item;f=(await call('/api/catalogue/flyers/'+f.id+'/approve',admin.cookie,{expectedRevision:f.revision})).item;
   const preview=await call('/api/conversations/'+conversation.id+'/materials/preview',agent.cookie,{kind:'flyer',flyerId:f.id});const sentPdf=await call('/api/conversations/'+conversation.id+'/materials/send',agent.cookie,{kind:'flyer',flyerId:f.id,previewToken:preview.previewToken,clientRef:randomUUID()});
   const m=(await call('/api/conversations/'+conversation.id+'/messages',client.cookie)).messages.find(m=>m.id===sentPdf.id);assert.equal(m.mime,'application/pdf');assert.equal(m.filename,'temario.pdf');
   await call('/api/catalogue/editions/'+edition.id+'/archive',admin.cookie,{expectedRevision:edition.revision});
   await call('/api/conversations/'+conversation.id+'/materials/preview',agent.cookie,{kind:'price'},'POST',409);assert.equal((await fetch(origin+m.attachmentUrl,{headers:{Cookie:client.cookie}})).status,200);
 });
 await t.test('versiones y archivos sobreviven al reinicio y a la migración repetida',async()=>{
   const before=await call('/api/catalogue/edition/'+edition.id+'/history',admin.cookie);assert.ok(before.events.length>=3);await call('/api/catalogue/edition/'+edition.id+'/history',client.cookie,undefined,'GET',403);
   const catBefore=await cat();await stop();await start();const after=await cat();for(const key of ['editions','promotions','flyers','templates'])assert.equal(after[key].length,catBefore[key].length);
   assert.deepEqual((await call('/api/catalogue/edition/'+edition.id+'/history',admin.cookie)).events,before.events);assert.equal((await fetch(origin+sent.attachmentUrl,{headers:{Cookie:client.cookie}})).status,200);
 });
 await t.test('cursos nuevos, archivo, cupos agotados y revisiones sin sobrescritura',async()=>{
   let c=(await call('/api/catalogue/courses',admin.cookie,{brandId:'globalvet',title:'Curso nuevo de prueba',syllabus:'Temario inicial'},'POST',201)).item;
   const e=(await cat()).editions.find(e=>e.course_id===c.id);assert.equal(e.status,'draft');assert.equal((await call('/api/courses/'+c.id+'/editions',client.cookie)).editions.length,0);
   c=(await call('/api/catalogue/courses/'+c.id,admin.cookie,{title:c.title,syllabus:'Temario nuevo',expectedRevision:c.version},'PATCH')).item;
   await call('/api/catalogue/courses/'+c.id,admin.cookie,{title:c.title,syllabus:'No sobrescribir',expectedRevision:c.version-1},'PATCH',409);
   const full=(await call('/api/catalogue/editions',admin.cookie,{...baseEdition,courseId:c.id,availableSeats:0},'POST',201)).item;
   await call('/api/conversations',client.cookie,{courseId:c.id,editionId:full.id,channel:'whatsapp'},'POST',409);
   await call('/api/catalogue/courses/'+c.id+'/archive',admin.cookie,{expectedRevision:c.version});assert.equal((await cat()).courses.find(x=>x.id===c.id).active,0);
   const history=await call('/api/catalogue/course/'+c.id+'/history',agent.cookie);assert.equal(history.events.length,3);
 });
});

test('migración v4→v5 no cambia mensajes ni ofertas comerciales anteriores',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-catalogue-migrate-'));const db=openDatabase(dir);
 try{
   migrateCRM(db);migrateFollowup(db);db.prepare("UPDATE courses SET price_cents=77750,version=3 WHERE id='aves'").run();
   migrateCatalogue(db);assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);assert.equal(db.prepare("SELECT price_cents FROM editions WHERE course_id='aves'").get().price_cents,77750);assert.equal(db.prepare("SELECT count(*) n FROM flyers WHERE course_id='aves'").get().n,0);
   const n=db.prepare('SELECT count(*) n FROM content_templates').get().n;migrateCatalogue(db);assert.equal(db.prepare('SELECT count(*) n FROM content_templates').get().n,n);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
