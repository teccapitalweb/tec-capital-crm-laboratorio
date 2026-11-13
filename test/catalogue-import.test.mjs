import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {parseCsv,zonedToUtc,TEMPLATE_CSV,COLUMNS} from '../server/catalogue-import.mjs';

test('CSV: comillas, saltos de línea dentro de celdas, punto y coma, BOM y líneas reales',()=>{
  const rows=parseCsv('\uFEFFmarca;curso;temario\r\nOdonTeck;"Curso ""A""";"uno\ndos"\r\n\r\nGlobalVet;B;x\r\n');
  assert.deepEqual(rows.map(r=>r.cells),[['marca','curso','temario'],['OdonTeck','Curso "A"','uno\ndos'],['GlobalVet','B','x']]);
  assert.deepEqual(rows.map(r=>r.line),[1,2,5]);
  assert.deepEqual(parseCsv('a,b\n1,"2,5"\n')[1].cells,['1','2,5']);
  assert.equal(parseCsv(TEMPLATE_CSV)[0].cells.join(','),COLUMNS.join(','));
});

test('fechas locales se interpretan en la zona indicada, no en la del dispositivo',()=>{
  assert.equal(zonedToUtc('2027-03-20 18:00','America/Mexico_City'),Date.UTC(2027,2,21,0,0));
  assert.equal(zonedToUtc('2027-07-01 12:00','America/New_York'),Date.UTC(2027,6,1,16,0));
  assert.equal(zonedToUtc('2027-01-15 12:00','America/New_York'),Date.UTC(2027,0,15,17,0));
  assert.equal(zonedToUtc('2027-02-30','UTC'),null);assert.equal(zonedToUtc('mañana','UTC'),null);assert.equal(zonedToUtc('2027-01-01 25:00','UTC'),null);
  assert.equal(zonedToUtc('2027-05-05','UTC'),Date.UTC(2027,4,5));
});

test('importación de catálogo: vista previa sin escribir, aplicación idempotente y errores por fila',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'crm-import-')),code=randomUUID(),password='Password-import-2026!';let logs='';
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
  async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code}),agent=await call('/api/auth/register','',{username:'asesor',name:'Asesor',password});
  const invite=await call('/api/team/invites',admin.cookie,{username:'asesor',brandIds:['globalvet']},'POST',201);await call('/api/team/accept',agent.cookie,{token:invite.token});
  const db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000});
  const counts=()=>{const d=db();try{return ['courses','editions','promotions','catalogue_events'].map(n=>d.prepare('SELECT count(*) n FROM '+n).get().n).join('-');}finally{d.close();}};

  const header=COLUMNS.join(',');
  const csv=[header,
   'GlobalVet,Bioseguridad avanzada,"Higiene\nProtocolos",Edición marzo,2027-03-20 18:00,2027-03-20 20:00,America/Mexico_City,Dra. Ruiz,online,,https://ejemplo.com/a,50,50,"1,200.50",MXN,borrador,Preventa,999,2027-01-01 00:00,2027-03-01 23:59,borrador',
   'OdonTeck,Resinas modernas,Adhesión y color,Edición abril,2027-04-10 09:00,2027-04-10 14:00,America/Mexico_City,,presencial,CDMX,,30,,799,MXN,publicada,,,,,',
   'GlobalVet,Plan sanitario para aves,,Edición mayo,2027-05-15 10:00,,America/Mexico_City,,híbrida,,,,,400,MXN,borrador,,,,,',
   'MarcaInexistente,Curso X,Temario,Ed,2027-01-01 10:00,,America/Mexico_City,,online,,,,,100,MXN,borrador,,,,,',
   'GlobalVet,Curso sin precio,Temario,Ed,2027-01-01 10:00,,America/Mexico_City,,online,,,,,abc,MXN,borrador,,,,,',
   'GlobalVet,Curso sin temario,,Ed,2027-01-01 10:00,,America/Mexico_City,,online,,,,,100,MXN,borrador,,,,,',
   'GlobalVet,Fecha mala,Temario,Ed,20/01/2027,,America/Mexico_City,,online,,,,,100,MXN,borrador,,,,,',
   'GlobalVet,Promo cara,Temario,Ed,2027-06-01 10:00,,America/Mexico_City,,online,,,,,100,MXN,borrador,Cara,150,2027-01-01 00:00,2027-02-01 00:00,borrador',
   'GlobalVet,Bioseguridad avanzada,Otro,Edición marzo,2027-03-20 18:00,,America/Mexico_City,,online,,,,,100,MXN,borrador,,,,,',
   'GlobalVet,Curso con tope,Temario,Ed,2027-06-01 10:00,,America/Mexico_City,,online,,,10,50,100,MXN,borrador,,,,,'].join('\n');

  await call('/api/catalogue/import/preview',agent.cookie,{csv},'POST',403);await call('/api/catalogue/import/preview','',{csv},'POST',401);
  await call('/api/catalogue/import/preview',admin.cookie,{csv:''},'POST',400);await call('/api/catalogue/import/preview',admin.cookie,{csv:'curso\nx'},'POST',400);
  const template=await call('/api/catalogue/import/template',admin.cookie);assert.ok(template.csv.startsWith('marca,curso'));

  const before=counts(),preview=await call('/api/catalogue/import/preview',admin.cookie,{csv});
  assert.equal(counts(),before);                                                  // la vista previa no escribe
  const byLine=Object.fromEntries(preview.rows.map(r=>[r.line,r]));
  assert.deepEqual(preview.summary,{rows:10,valid:4,withErrors:6,coursesToCreate:3,editionsToCreate:4,promotionsToCreate:1,existing:0});
  assert.equal(byLine[2].errors.length,0);assert.equal(byLine[5].actions.course,'existente');assert.equal(byLine[5].actions.edition,'crear');
  assert.match(byLine[6].errors[0],/no existe/);assert.match(byLine[7].errors.join(),/precio/);assert.match(byLine[8].errors.join(),/temario/);
  assert.match(byLine[9].errors.join(),/2026-11-20 18:00|2027/);assert.match(byLine[10].errors.join(),/menos que el precio/);assert.match(byLine[11].errors.join(),/Repite/);
  assert.equal(byLine[12].errors.length,0);                                       // el tope inválido lo rechaza la validación real al aplicar

  await call('/api/catalogue/import/apply',admin.cookie,{csv,fileHash:'otro'},'POST',409);
  const applied=await call('/api/catalogue/import/apply',admin.cookie,{csv,fileHash:preview.fileHash});
  assert.equal(applied.applied,3);assert.equal(applied.failed,7);
  const ok=applied.results.filter(r=>!r.error),bad=applied.results.filter(r=>r.error);
  assert.deepEqual(ok.map(r=>r.line),[2,4,5]);assert.match(bad.find(r=>r.line===12).error,/cupo/i);
  assert.equal(ok[0].course.action,'creado');assert.equal(ok[0].edition.action,'creada');assert.equal(ok[0].promotion.action,'creada');
  assert.equal(ok[2].course.action,'existente');assert.equal(ok[2].edition.action,'creada');

  const d=db();try{
    const course=d.prepare("SELECT * FROM courses WHERE title='Bioseguridad avanzada'").get();assert.ok(course);assert.equal(course.syllabus,'Higiene\nProtocolos');
    const editions=d.prepare('SELECT * FROM editions WHERE course_id=?').all(course.id);assert.equal(editions.length,1);                    // reutiliza la edición inicial en vez de dejar una vacía
    const e=editions[0];assert.equal(e.name,'Edición marzo');assert.equal(e.price_cents,120050);assert.equal(e.starts_at,Date.UTC(2027,2,21,0,0));assert.equal(e.status,'draft');assert.equal(e.capacity,50);
    const promo=d.prepare('SELECT * FROM promotions WHERE edition_id=?').get(e.id);assert.equal(promo.price_cents,99900);assert.equal(promo.name,'Preventa');
    const odon=d.prepare("SELECT e.* FROM editions e JOIN courses c ON c.id=e.course_id WHERE c.title='Resinas modernas'").get();assert.equal(odon.status,'published');assert.equal(odon.modality,'in_person');
    const aves=d.prepare("SELECT e.name,e.modality FROM editions e JOIN courses c ON c.id=e.course_id WHERE c.id='aves' AND e.name='Edición mayo'").get();assert.equal(aves.modality,'hybrid');
    assert.equal(d.prepare("SELECT count(*) n FROM courses WHERE title='Curso con tope'").get().n,1);                                           // el curso se creó aunque su edición falló: se informa por fila
  }finally{d.close();}

  // Repetir el mismo archivo no duplica nada
  const afterFirst=counts();
  const again=await call('/api/catalogue/import/preview',admin.cookie,{csv});assert.equal(again.summary.valid,4);assert.equal(again.summary.coursesToCreate,0);assert.equal(again.summary.editionsToCreate,1);assert.equal(again.summary.promotionsToCreate,0);assert.equal(again.summary.existing,3);
  const second=await call('/api/catalogue/import/apply',admin.cookie,{csv,fileHash:again.fileHash});
  assert.ok(second.results.filter(r=>!r.error).every(r=>r.course.action==='existente'&&r.edition.action==='existente'));assert.equal(second.failed,7);
  assert.equal(counts(),afterFirst);
});
