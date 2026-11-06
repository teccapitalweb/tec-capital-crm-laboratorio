import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {encodeQR,qrSvg} from '../server/qr.mjs';
import {FOLIO} from '../server/certificates.mjs';

test('QR: versión según el largo, tamaño de la matriz, patrones fijos, SVG y límite',()=>{
  const short=encodeQR('Hola');assert.equal(short.version,1);assert.equal(short.size,21);assert.equal(short.modules.length,21);
  const url=encodeQR('https://crm-laboratorio-production.up.railway.app/verificar/IPCI-2026-00001');assert.equal(url.version,5);assert.equal(url.size,37);assert.ok(url.mask>=0&&url.mask<=7);
  // patrón de búsqueda arriba a la izquierda: borde oscuro, anillo claro, centro oscuro; módulo oscuro fijo junto al tercer patrón
  for(const q of [short,url]){const m=q.modules;assert.equal(m[0][0],true);assert.equal(m[1][1],false);assert.equal(m[3][3],true);assert.equal(m[0][6],true);assert.equal(m[q.size-8][8],true);assert.equal(m[6][9],false,'la fila de sincronía alterna');assert.equal(m[6][8],true);}
  const big=encodeQR('x'.repeat(200));assert.equal(big.version,10);assert.equal(big.size,57);
  assert.throws(()=>encodeQR('x'.repeat(400)),/demasiado largo/);assert.throws(()=>encodeQR('x','Z'),/no válido/);
  const svg=qrSvg('IPCI-2026-00001',{scale:3});assert.match(svg,/^<svg /);assert.ok(svg.includes('<path d="M'));
  assert.ok(FOLIO.test('IPCI-2026-00042'));assert.ok(!FOLIO.test('IPCI-26-1'));
});

test('certificación por API: emisión al cerrar con asistencia mínima, folio secuencial, verificación pública, SVG con QR, revocación, créditos, aviso al alumno y permisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-certificates-')),code=randomUUID(),password='Password-certificates-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const raw=(path,cookie='')=>fetch(origin+path,{headers:{Cookie:cookie,Origin:origin}});
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),msgs=id=>'/api/conversations/'+id+'/messages';
 async function until(fn,tries=40){let v;for(let i=0;i<tries;i++){v=await fn();if(v)return v;await sleep(250);}return v;}
 assert.equal((await raw('/certificates.js')).status,200);

 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const agent=await call('/api/auth/register','',{username:'asesor',name:'Asesora',password});
 const inv=await call('/api/team/invites',admin.cookie,{username:'asesor',brandIds:['globalvet']},'POST',201);await call('/api/team/accept',agent.cookie,{token:inv.token});
 const c1=await call('/api/auth/register','',{username:'alumno1',name:'Ana Pérez',password}),c2=await call('/api/auth/register','',{username:'alumno2',name:'Luis Gómez',password});

 // permisos y ajustes
 await call('/api/certificates',c1.cookie,undefined,'GET',403);
 await call('/api/certificates/brands/globalvet',agent.cookie,{autoIssue:true,expectedRevision:0},'PATCH',403);
 await call('/api/certificates/brands/globalvet',admin.cookie,{minAttendancePct:150,expectedRevision:0},'PATCH',400);
 await call('/api/certificates/brands/globalvet',admin.cookie,{accent:'rojo',expectedRevision:0},'PATCH',400);
 const st=(await call('/api/certificates/brands/globalvet',admin.cookie,{autoIssue:true,minAttendancePct:60,issuerName:'IPCI · Laboratorio',signerName:'Dirección Académica',signerTitle:'Coordinación',accent:'#2a7a5e',expectedRevision:0},'PATCH')).settings;
 assert.equal(st.auto_issue,1);assert.equal(st.min_attendance_pct,60);assert.equal(st.revision,1);
 const empty=await call('/api/certificates?brand=all',admin.cookie);assert.equal(empty.stats.issued,0);assert.equal(empty.stats.lastFolio,0);
 await call('/api/payments/brands/globalvet',admin.cookie,{enabled:true,expectedRevision:0},'PATCH');
 const run=(await call('/api/coordination/editions/edition-aves',admin.cookie,{minStudents:0,coordinatorId:admin.user.id,expectedRevision:1},'PATCH')).edition;

 // dos ventas → dos inscritos; una sesión realizada con Ana presente y Luis ausente
 const convs=[];for(const cl of [c1,c2]){const conv=(await call('/api/conversations',cl.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;convs.push(conv);const o=(await call('/api/conversations/'+conv.id+'/orders',admin.cookie,{},'POST',201)).order;await call('/api/payments/orders/'+o.id+'/pay',cl.cookie,{method:'card'});}
 await sleep(1200);
 const d0=await call('/api/coordination/editions/edition-aves',admin.cookie);assert.equal(d0.enrollments.length,2);const ids=Object.fromEntries(d0.enrollments.map(r=>[r.contact_name,r.id]));
 const ev0=await call('/api/certificates/editions/edition-aves',admin.cookie);assert.equal(ev0.eligible,0);assert.match(ev0.enrollments[0].reason,/todavía no está en curso/);
 const r1=(await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'open',expectedRevision:run.run_revision},'POST')).edition;
 const r2=(await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'running',expectedRevision:r1.run_revision},'POST')).edition;
 const s1=(await call('/api/coordination/editions/edition-aves/sessions',admin.cookie,{title:'Única sesión',startsAt:Date.now()-3600000,durationMin:120},'POST',201)).session;
 const ev1=await call('/api/certificates/editions/edition-aves',admin.cookie);assert.match(ev1.enrollments[0].reason,/Sin sesiones realizadas/);
 await call('/api/coordination/sessions/'+s1.id+'/attendance',admin.cookie,{marks:[{enrollmentId:ids['Ana Pérez'],status:'present'},{enrollmentId:ids['Luis Gómez'],status:'absent'}]},'PUT');
 await call('/api/coordination/sessions/'+s1.id+'/done',admin.cookie,{});
 const ev2=await call('/api/certificates/editions/edition-aves',admin.cookie);
 const ana=ev2.enrollments.find(r=>r.contactName==='Ana Pérez'),luis=ev2.enrollments.find(r=>r.contactName==='Luis Gómez');
 assert.equal(ana.eligible,true);assert.equal(ana.pct,100);assert.equal(luis.eligible,false);assert.match(luis.reason,/Asistencia 0 %/);assert.equal(ev2.canIssue,true);
 assert.equal((await call('/api/certificates/editions/edition-aves',agent.cookie)).canIssue,false,'la asesora no es responsable');
 await call('/api/certificates/editions/edition-aves/issue',agent.cookie,{},'POST',403);
 await call('/api/certificates/editions/edition-aves/issue',admin.cookie,{enrollmentIds:[ids['Luis Gómez']]},'POST',409);   // sin asistencia

 // cierre de la apertura → emisión automática (sólo Ana); folio del año en curso
 const closed=(await call('/api/coordination/editions/edition-aves/status',admin.cookie,{to:'closed',expectedRevision:r2.run_revision},'POST')).edition;assert.equal(closed.run_status,'closed');
 const issued=await until(async()=>{const l=await call('/api/certificates?brand=all',admin.cookie);return l.stats.issued===1?l:null;});
 assert.ok(issued,'el cierre emitió el certificado de la alumna con asistencia');
 const cert=issued.certificates[0];const year=new Date().getFullYear();
 assert.match(cert.folio,FOLIO);assert.ok(cert.folio.startsWith('IPCI-'+year+'-00001'));assert.equal(cert.holder_name,'Ana Pérez');assert.equal(cert.source,'auto');assert.equal(cert.attendance_pct,100);assert.equal(cert.hours,2);assert.equal(cert.snapshot.issuer,'IPCI · Laboratorio');
 const notice=await until(async()=>(await call(msgs(convs[0].id),c1.cookie)).messages.find(m=>/Tu certificado/.test(m.text)));
 assert.ok(notice,'la alumna recibe el aviso por su chat');assert.ok(notice.text.includes(cert.folio));assert.ok(notice.text.includes('/verificar/'+cert.folio));assert.equal(notice.category,'utility');
 assert.ok(!(await call(msgs(convs[1].id),c2.cookie)).messages.some(m=>/Tu certificado/.test(m.text)),'el ausente no recibe certificado');
 assert.equal((await call('/api/events?brand=all&type=certificado.emitido',admin.cookie)).events.length,1);

 // verificación pública sin sesión: página, JSON y SVG; folio inexistente; límite de peticiones
 const vcode=cert.verifyUrl.split('/').pop();assert.match(vcode,/^[a-f0-9]{10}$/);assert.ok(notice.text.includes('/verificar/'+cert.folio+'/'+vcode),'el enlace del alumno lleva el código');
 const page=await fetch(origin+'/verificar/'+cert.folio.toLowerCase());assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);const html=await page.text();
 assert.ok(html.includes('Certificado vigente')&&html.includes('Ana P.')&&!html.includes('Ana Pérez')&&html.includes('Plan sanitario para aves')&&html.includes(cert.folio),'por folio solo: nombre abreviado');assert.ok(!html.includes('<script'));
 const fullHtml=await (await fetch(origin+'/verificar/'+cert.folio+'/'+vcode)).text();assert.ok(fullHtml.includes('Ana Pérez')&&fullHtml.includes('Ver el certificado'),'con el código del QR: nombre completo y descarga');
 const vj=await (await fetch(origin+'/api/verify/'+cert.folio)).json();assert.equal(vj.valid,true);assert.equal(vj.certificate.holder,'Ana P.');assert.equal(vj.certificate.full,false);assert.equal(vj.certificate.brand,'GlobalVet');
 assert.equal((await (await fetch(origin+'/api/verify/'+cert.folio+'?code='+vcode)).json()).certificate.holder,'Ana Pérez');
 assert.equal((await fetch(origin+'/verificar/'+cert.folio+'.svg')).status,404,'el SVG con el nombre completo exige el código');
 const svgRes=await fetch(origin+'/verificar/'+cert.folio+'/'+vcode+'.svg');assert.equal(svgRes.status,200);assert.match(svgRes.headers.get('content-type'),/image\/svg\+xml/);const svg=await svgRes.text();
 assert.ok(svg.includes('Ana Pérez')&&svg.includes(cert.folio)&&svg.includes('<path d="M')&&svg.includes('Dirección Académica')&&svg.includes('#2a7a5e')&&!svg.includes('REVOCADO'));
 const missing=await fetch(origin+'/verificar/IPCI-2026-99999');assert.equal(missing.status,404);assert.ok((await missing.text()).includes('Folio no encontrado'));
 assert.equal((await fetch(origin+'/api/verify/nada')).status,404);
 assert.equal((await call('/api/certificates?brand=all',admin.cookie)).stats.verifications,5);
 const staffSvg=await raw('/api/certificates/'+cert.id+'.svg',admin.cookie);assert.equal(staffSvg.status,200);await raw('/api/certificates/'+cert.id+'.svg',c1.cookie).then(r=>assert.equal(r.status,403));

 // emisión manual tras bajar la asistencia mínima; folio consecutivo; una inscripción no se certifica dos veces
 await call('/api/certificates/brands/globalvet',admin.cookie,{minAttendancePct:0,expectedRevision:1},'PATCH');
 const manual=await call('/api/certificates/editions/edition-aves/issue',admin.cookie,{enrollmentIds:[ids['Luis Gómez']]});
 assert.equal(manual.issued.length,1);assert.equal(manual.issued[0].folio,'IPCI-'+year+'-00002');assert.equal(manual.issued[0].source,'manual');
 const again=await call('/api/certificates/editions/edition-aves/issue',admin.cookie,{});assert.equal(again.issued.length,0);assert.equal(again.skipped.length,2);assert.match(again.skipped[0].reason,/Ya tiene certificado/);
 await call('/api/certificates/editions/edition-aves/issue',admin.cookie,{enrollmentIds:[randomUUID()]},'POST',404);

 // revocación: sólo responsable/administración, con motivo; la página pública lo dice
 await call('/api/certificates/'+cert.id+'/revoke',agent.cookie,{reason:'No procede la emisión'},'POST',403);
 await call('/api/certificates/'+cert.id+'/revoke',admin.cookie,{reason:'x'},'POST',400);
 const rv=(await call('/api/certificates/'+cert.id+'/revoke',admin.cookie,{reason:'Emitido por error de asistencia'})).certificate;assert.equal(rv.status,'revoked');
 await call('/api/certificates/'+cert.id+'/revoke',admin.cookie,{reason:'Otra vez'},'POST',409);
 const rpage=await (await fetch(origin+'/verificar/'+cert.folio)).text();assert.ok(rpage.includes('Certificado revocado'));
 assert.ok((await (await fetch(origin+'/verificar/'+cert.folio+'/'+vcode+'.svg')).text()).includes('REVOCADO'));
 assert.equal((await (await fetch(origin+'/api/verify/'+cert.folio)).json()).valid,false);
 // tras revocar, la inscripción puede certificarse de nuevo con folio nuevo
 const re=await call('/api/certificates/editions/edition-aves/issue',admin.cookie,{enrollmentIds:[ids['Ana Pérez']]});assert.equal(re.issued[0].folio,'IPCI-'+year+'-00003');
 assert.equal((await call('/api/events?brand=all&type=certificado.revocado',admin.cookie)).events.length,1);

 // créditos por consultora: activados sin saldo bloquean; con saldo se descuentan
 const conv3=(await call('/api/conversations',c1.cookie,{courseId:'nutricion',channel:'instagram'})).conversation;   // otro curso de GlobalVet
 const o3=(await call('/api/conversations/'+conv3.id+'/orders',admin.cookie,{},'POST',201)).order;await call('/api/payments/orders/'+o3.id+'/pay',c1.cookie,{method:'card'});await sleep(800);
 const e3=(await call('/api/coordination/editions/edition-nutricion',admin.cookie)).edition;
 const a1=(await call('/api/coordination/editions/edition-nutricion/status',admin.cookie,{to:'open',expectedRevision:e3.run_revision},'POST')).edition;
 const a2=(await call('/api/coordination/editions/edition-nutricion/status',admin.cookie,{to:'running',expectedRevision:a1.run_revision},'POST')).edition;
 const s3=(await call('/api/coordination/editions/edition-nutricion/sessions',admin.cookie,{startsAt:Date.now()-60000,durationMin:60},'POST',201)).session;
 const en3=(await call('/api/coordination/editions/edition-nutricion',admin.cookie)).enrollments[0].id;
 await call('/api/coordination/sessions/'+s3.id+'/attendance',admin.cookie,{marks:[{enrollmentId:en3,status:'present'}]},'PUT');await call('/api/coordination/sessions/'+s3.id+'/done',admin.cookie,{});
 await call('/api/certificates/brands/globalvet',admin.cookie,{creditsEnabled:true,expectedRevision:2},'PATCH');
 const blocked=await call('/api/certificates/editions/edition-nutricion',admin.cookie);assert.equal(blocked.enrollments[0].eligible,false);assert.match(blocked.enrollments[0].reason,/créditos/);
 await call('/api/certificates/brands/globalvet/credits',agent.cookie,{credits:5,reason:'Compra'},'POST',403);
 await call('/api/certificates/brands/globalvet/credits',admin.cookie,{credits:0,reason:'Nada'},'POST',400);
 assert.equal((await call('/api/certificates/brands/globalvet/credits',admin.cookie,{credits:1,reason:'Compra de prueba'})).balance,1);
 const closed3=(await call('/api/coordination/editions/edition-nutricion/status',admin.cookie,{to:'closed',expectedRevision:a2.run_revision},'POST')).edition;assert.equal(closed3.run_status,'closed');
 const cr=await until(async()=>{const r=await call('/api/certificates/brands/globalvet/credits',admin.cookie);return r.balance===0?r:null;});
 assert.ok(cr,'la emisión automática descontó el crédito');assert.ok(cr.history.some(h=>h.delta===-1&&/Emisión IPCI-/.test(h.reason)));
 const all=await call('/api/certificates?brand=all&q=IPCI',admin.cookie);assert.equal(all.stats.issued,3);assert.equal(all.stats.revoked,1);assert.equal(all.stats.lastFolio,4);
 assert.equal((await call('/api/certificates?brand=all&status=revoked',admin.cookie)).certificates.length,1);
 const pres=await call('/api/presentation?brand=globalvet',admin.cookie);assert.equal(pres.script.length,13);assert.equal(pres.script.find(s=>s.id==='certificado').ready,true);assert.equal(pres.certificates.issued,3);
 // límite de peticiones públicas por IP
 let limited=0;for(let i=0;i<70;i++){if((await fetch(origin+'/api/verify/IPCI-2026-00009')).status===429)limited++;}assert.ok(limited>0,'la verificación pública tiene límite de peticiones');
 const d=new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});try{assert.equal(d.prepare('PRAGMA user_version').get().user_version,29);assert.equal(d.prepare('SELECT count(*) n FROM certificates').get().n,4);assert.equal(d.prepare('SELECT count(DISTINCT folio) n FROM certificates').get().n,4);assert.equal(d.prepare("SELECT count(*) n FROM certificates WHERE status='issued' AND enrollment_id=?").get(ids['Ana Pérez']).n,1);}finally{d.close();}
});
