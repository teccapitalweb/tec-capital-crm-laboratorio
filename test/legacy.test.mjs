import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {when,cents,parseDocument,normalize,KINDS,EXAMPLE} from '../server/legacy.mjs';

test('históricos: fechas del panel, importes y normalización de registros',()=>{
  assert.equal(when('2025-02-20'),Date.UTC(2025,1,20,12));assert.equal(when('20/02/2025'),Date.UTC(2025,1,20,12));assert.equal(when({seconds:1740052800}),1740052800000);assert.equal(when(1740052800),1740052800000);assert.equal(when(1740052800000),1740052800000);assert.equal(when('x'),null);assert.equal(when(''),null);
  assert.equal(cents(4500),450000);assert.equal(cents('$4,500.50'),450050);assert.equal(cents('2250'),225000);assert.equal(cents(-1),null);assert.equal(cents(''),null);
  const {records,errors}=normalize(parseDocument(JSON.stringify(EXAMPLE),'json',null));
  assert.equal(records.curso.length,1);assert.equal(records.apertura.length,1);assert.equal(records.alumno.length,1);assert.equal(records.venta.length,2);assert.equal(records.certificado.length,1);assert.equal(errors.length,0);
  assert.equal(records.alumno[0].person.phone,'+525512345678');assert.equal(records.venta[0].alumnoExt,'a1');assert.equal(records.venta[1].amount_cents,225000);assert.equal(records.certificado[0].folio,'IPCI-2025-00042');
  const bad=normalize(parseDocument(JSON.stringify({alumnos:[{nombre:'Sin datos'},{nombre:'Ok',telefono:'5511112222',pagos:[{monto:0}]}],certificados:[{alumnoId:'a9'}]}),'json',null));
  assert.equal(bad.errors.length,3);assert.equal(bad.records.alumno.length,1);assert.equal(bad.records.venta.length,0);
  const csv=normalize(parseDocument('nombre,telefono,email,cursoId,fecha,pagos\n"Luis Ruiz",5522223333,,c1,2025-03-01,"[{""fecha"":""2025-03-01"",""monto"":1500}]"\n','csv','alumno'));
  assert.equal(csv.records.alumno.length,1);assert.equal(csv.records.venta.length,1);assert.equal(csv.records.venta[0].amount_cents,150000);
  assert.throws(()=>parseDocument('{',' json'.trim(),null),/JSON/);assert.throws(()=>parseDocument('[]','json',null),/tipo/);assert.deepEqual(Object.keys(KINDS),['curso','apertura','alumno','venta','certificado']);
});

test('históricos por API: vista previa con errores, importación idempotente ligada a personas, ficha de persona, Finanzas, secuencia de folios, CSV, lotes y permisos',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-legacy-')),code=randomUUID(),password='Password-legacy-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),count=(sql,...a)=>{const d=db();try{return d.prepare(sql).get(...a).n;}finally{d.close();}};
 assert.equal((await fetch(origin+'/legacy.js')).status,200);
 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const agent=await call('/api/auth/register','',{username:'asesor',name:'Asesora',password});
 const inv=await call('/api/team/invites',admin.cookie,{username:'asesor',brandIds:['globalvet']},'POST',201);await call('/api/team/accept',agent.cookie,{token:inv.token});
 // una clienta ya existe en el CRM con teléfono: el histórico debe ligarse a su misma persona
 const client=await call('/api/auth/register','',{username:'ana',name:'Ana Pérez',password});
 const conv=(await call('/api/conversations',client.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const anaPerson=(await call('/api/persons?brand=globalvet&q=Ana',admin.cookie)).persons.find(p=>p.name==='Ana Pérez');
 await call('/api/persons/'+anaPerson.id,admin.cookie,{phone:'+52 55 1234 5678',expectedRevision:(await call('/api/persons/'+anaPerson.id,admin.cookie)).person.revision},'PATCH');
 const personsBefore=count('SELECT count(*) n FROM persons');

 // permisos y formato
 await call('/api/legacy',agent.cookie,undefined,'GET',403);await call('/api/legacy/format',client.cookie,undefined,'GET',403);
 const fmt=await call('/api/legacy/format',admin.cookie);assert.ok(fmt.example.alumnos.length);assert.ok(fmt.fields.alumno.required.includes('nombre'));
 const doc={origen:'ipcil',cursos:[{id:'c1',nombre:'Plan sanitario histórico',precio:4500,creditos:2}],aperturas:[{id:'g1',cursoId:'c1',nombre:'Grupo 3',fechaInicio:'2025-03-01',estado:'iniciado',sesiones:8}],
   alumnos:[{id:'a1',nombre:'Ana Pérez',telefono:'55 1234 5678',cursoId:'c1',aperturaId:'g1',estado:'activo',fecha:'2025-02-20',vendedor:'Laura',saldo:0,pagos:[{fecha:'2025-02-20',monto:2250,metodo:'transferencia'},{fecha:'2025-03-05',monto:2250,metodo:'tarjeta'}]},
     {id:'a2',nombre:'Beto Historico',email:'BETO@Ejemplo.test',cursoId:'c1',estado:'cancelado',fecha:{seconds:1735732800},pagos:[{fecha:'02/01/2025',monto:'$1,000.00'}]},
     {id:'a3',nombre:'Sin Contacto'}],
   ventas:[{id:'v9',alumnoId:'a2',monto:500,fecha:'2025-04-01',metodo:'oxxo'},{alumnoId:'zz',monto:100}],
   certificados:[{id:'ce1',folio:'ipci-2026-00042',alumnoId:'a1',cursoId:'c1',fecha:'2025-05-01'},{id:'ce2',alumnoId:'a2'}]};
 await call('/api/legacy/preview',admin.cookie,{brandId:'nope',format:'json',content:JSON.stringify(doc)},'POST',404);
 await call('/api/legacy/preview',admin.cookie,{brandId:'globalvet',format:'json',content:'{'},'POST',400);
 const pv=await call('/api/legacy/preview',admin.cookie,{brandId:'globalvet',format:'json',content:JSON.stringify(doc)});
 assert.equal(pv.counts.alumno.new,2);assert.equal(pv.counts.alumno.invalid,1);assert.equal(pv.counts.venta.new,5);assert.equal(pv.counts.certificado.new,1);assert.equal(pv.counts.certificado.invalid,1);assert.equal(pv.errorCount,2);assert.ok(pv.errors.some(e=>/teléfono/.test(e.message)));assert.ok(pv.errors.some(e=>/folio/.test(e.message)));
 assert.equal(count('SELECT count(*) n FROM legacy_records'),0,'la vista previa no escribe');

 // importación
 const ap=await call('/api/legacy/apply',admin.cookie,{brandId:'globalvet',format:'json',content:JSON.stringify(doc),filename:'ipcil.json',note:'Prueba'},'POST',201);
 assert.deepEqual([ap.counts.curso,ap.counts.apertura,ap.counts.alumno,ap.counts.venta,ap.counts.certificado],[1,1,2,5,1]);assert.equal(ap.counts.personsLinked,1,'Ana ya existía');assert.equal(ap.counts.personsCreated,1);assert.equal(ap.counts.unlinked,1,'la venta de zz no tiene alumno');assert.equal(ap.counts.foliosAdvanced,1);assert.equal(ap.batch.records,10);
 assert.equal(count('SELECT count(*) n FROM persons'),personsBefore+1);
 const d=db();try{assert.equal(d.prepare('SELECT last FROM certificate_sequences WHERE year=2026').get().last,42);assert.equal(d.prepare("SELECT count(*) n FROM contacts WHERE source='ipcil'").get().n,1);assert.equal(d.prepare("SELECT folio FROM legacy_records WHERE kind='certificado'").get().folio,'IPCI-2026-00042');}finally{d.close();}
 // idempotente
 const again=await call('/api/legacy/apply',admin.cookie,{brandId:'globalvet',format:'json',content:JSON.stringify(doc)},'POST',201);
 assert.equal(again.counts.alumno+again.counts.venta+again.counts.certificado+again.counts.curso+again.counts.apertura,0);assert.equal(again.counts.repeated,10);assert.equal(count('SELECT count(*) n FROM legacy_records'),10);assert.equal(count('SELECT count(*) n FROM persons'),personsBefore+1);
 // ficha de persona de Ana: históricos visibles (alumno, 2 pagos, certificado)
 const anaId=(await call('/api/persons?brand=globalvet&q=Ana',admin.cookie)).persons.find(p=>p.name==='Ana Pérez').id;
 const ana=await call('/api/persons/'+anaId,admin.cookie);assert.equal(ana.legacy.length,4);assert.deepEqual(ana.legacy.map(r=>r.kind).sort(),['alumno','certificado','venta','venta']);assert.equal(ana.legacy.find(r=>r.kind==='certificado').folio,'IPCI-2026-00042');assert.equal(ana.legacy.find(r=>r.kind==='alumno').data.vendedor,'Laura');
 assert.equal((await call('/api/persons/'+anaId,agent.cookie)).legacy.length,4,'la asesora de la marca también los ve');
 const betoId=(await call('/api/persons?brand=globalvet&q=Beto',admin.cookie)).persons[0].id;const beto=await call('/api/persons/'+betoId,admin.cookie);assert.equal(beto.person.email,'beto@ejemplo.test');assert.equal(beto.legacy.filter(r=>r.kind==='venta').length,2);
 // Finanzas: históricos fuera del libro
 assert.equal(count("SELECT count(*) n FROM ledger_entries"),0);
 const fin=await call('/api/finance?brand=globalvet&from=2025-01-01&to=2025-12-31',admin.cookie);assert.equal(fin.legacy.sales,4);assert.equal(fin.legacy.salesCents,600000);assert.equal(fin.legacy.byBrand[0].id,'globalvet');assert.equal(fin.legacy.undated,1);assert.equal(fin.totals.sales,0);
 // registros, bitácora, CSV de alumnos
 const recs=await call('/api/legacy/records?brand=globalvet&kind=venta&q=Ana',admin.cookie);assert.equal(recs.records.length,2);assert.equal(recs.records[0].person_name,'Ana Pérez');
 assert.equal((await call('/api/events?brand=globalvet&type=historico.importado',admin.cookie)).events.length,2);
 const csv='nombre,telefono,email,cursoId,fecha,pagos\n"Luis Ruiz",5522223333,,c1,2025-03-01,"[{""fecha"":""2025-03-01"",""monto"":1500}]"\n';
 const csvApply=await call('/api/legacy/apply',admin.cookie,{brandId:'globalvet',format:'csv',kind:'alumno',content:csv},'POST',201);assert.equal(csvApply.counts.alumno,1);assert.equal(csvApply.counts.venta,1);
 await call('/api/legacy/apply',admin.cookie,{brandId:'globalvet',format:'csv',content:csv},'POST',400);
 const ov=await call('/api/legacy?brand=globalvet',admin.cookie);assert.equal(ov.batches.length,3);assert.equal(ov.totals.venta.n,6);assert.equal(ov.totals.alumno.persons,3);
 // quitar el lote del CSV: se van sus registros, la persona se queda
 const removed=await call('/api/legacy/batches/'+csvApply.batch.id,admin.cookie,undefined,'DELETE');assert.equal(removed.removed,2);assert.equal(count('SELECT count(*) n FROM legacy_records'),10);assert.equal(count("SELECT count(*) n FROM persons WHERE name='Luis Ruiz'"),1);
 await call('/api/legacy/batches/'+csvApply.batch.id,admin.cookie,undefined,'DELETE',404);
 await call('/api/legacy/apply',agent.cookie,{brandId:'globalvet',format:'json',content:JSON.stringify(doc)},'POST',403);
 const x=db();try{assert.equal(x.prepare('PRAGMA user_version').get().user_version,35);}finally{x.close();}
});
