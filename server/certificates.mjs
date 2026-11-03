import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {transaction} from './database.mjs';
import {qrSvgPath,encodeQR} from './qr.mjs';
import {artworkAsset} from './demo-catalog.mjs';

// Certificación (Fase 2 · bloque 2.5). Un solo emisor: al cerrar una apertura (o a mano desde Coordinación) cada
// inscripción con la asistencia mínima recibe un certificado con folio secuencial IPCI-AAAA-NNNNN, snapshot de lo
// certificado, SVG con código QR y verificación pública sin sesión: por folio solo (/verificar/<folio>) se confirma el estado
// con el nombre abreviado; con el código que lleva el QR (/verificar/<folio>/<código>) se ve el nombre completo y el SVG.
// Así un folio secuencial no permite recorrer nombres. JSON en /api/verify/<folio>[?code=]. Límite de peticiones por IP. Se avisa al alumno por su conversación con el enlace. Revocar deja el folio visible como
// revocado. Créditos por consultora opcionales (se descuentan al emitir). Sin firma digital avanzada ni folios históricos.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const TZ='America/Mexico_City';
const yearOf=t=>Number(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric'}).format(t));
const longDate=t=>new Intl.DateTimeFormat('es-MX',{dateStyle:'long',timeZone:TZ}).format(t);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const FOLIO=/^IPCI-\d{4}-\d{5}$/;

export function createCertificates({db,crm,events,insertMessage,body,json,audit,broadcast,rate,dataDir,root,content=null,now=Date.now,env=process.env}){
  const defaults=b=>({brand_id:b,auto_issue:0,min_attendance_pct:80,issuer_name:'IPCI · TEC Capital',signer_name:'',signer_title:'',logo_file_id:null,accent:'#30343c',credits_enabled:0,revision:0,updated_by:null,updated_at:null});
  const settings=b=>db.prepare('SELECT * FROM certificate_settings WHERE brand_id=?').get(b)||defaults(b);
  const roleOf=user=>db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
  const requireStaff=user=>{const u=roleOf(user);if(!u||u.disabled||!['admin','agent'].includes(u.role))throw fail(403,'Los certificados son para el equipo de atención.');return u;};
  const requireAdmin=user=>{const u=roleOf(user);if(!u||u.disabled||u.role!=='admin')throw fail(403,'Esta acción requiere un administrador.');};
  // Emitir y revocar: administración o la persona responsable de la apertura (misma regla que cerrarla).
  const requireIssuer=(user,e)=>{const u=requireStaff(user);crm.requireBrand(user,e.brand_id);if(u.role!=='admin'&&e.coordinator_id!==user.id)throw fail(403,'Sólo administración o la persona responsable de la apertura emite o revoca certificados.');};
  const get=id=>db.prepare('SELECT * FROM certificates WHERE id=?').get(id);
  const byFolio=f=>db.prepare('SELECT * FROM certificates WHERE folio=?').get(f);
  const edition=id=>{const e=db.prepare('SELECT * FROM editions WHERE id=?').get(id);if(!e)throw fail(404,'Edición no disponible.');return e;};
  const origin=()=>(env.APP_ORIGIN||'').replace(/\/$/,'');
  const verifyUrl=(folio,code)=>origin()+'/verificar/'+folio+(code?'/'+code:'');
  // Nombre abreviado para la consulta pública por folio: primer nombre e iniciales.
  const maskName=n=>{const p=String(n||'').split('·')[0].trim().split(/\s+/).filter(w=>/\p{L}/u.test(w));return p.length>1?p[0]+' '+p.slice(1).map(w=>w[0]+'.').join(' '):p[0]||'Titular';};   // ignora sufijos como «· demo»
  const balance=b=>db.prepare('SELECT COALESCE(sum(delta),0) n FROM certificate_credits WHERE brand_id=?').get(b).n;
  const staffOf=brandId=>db.prepare("SELECT id FROM users WHERE role IN ('admin','agent') AND COALESCE(disabled,0)=0 AND (role='admin' OR id IN (SELECT user_id FROM brand_members WHERE brand_id=?))").all(brandId).map(u=>u.id);
  function notify(e,title,key){const t=now(),targets=e.coordinator_id?[e.coordinator_id]:staffOf(e.brand_id);for(const id of targets)db.prepare('INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,NULL,?,?,?,?)').run(randomUUID(),id,e.brand_id,'certificate',title,key,t);}

  // ---- elegibilidad por inscripción (asistencia sobre sesiones realizadas)
  function attendanceOf(en){
    const held=db.prepare("SELECT count(*) n FROM edition_sessions WHERE edition_id=? AND status='done'").get(en.edition_id).n;
    const attended=db.prepare("SELECT count(*) n FROM attendance a JOIN edition_sessions s ON s.id=a.session_id WHERE a.enrollment_id=? AND s.status='done' AND a.status IN ('present','late')").get(en.id).n;
    return {held,attended,pct:held?Math.round(attended/held*100):0};
  }
  function eligibility(en,e,s){
    const a=attendanceOf(en),cert=db.prepare("SELECT * FROM certificates WHERE enrollment_id=? AND status='issued'").get(en.id);
    let reason=null;
    if(cert)reason='Ya tiene certificado '+cert.folio;
    else if(en.status!=='enrolled')reason='Inscripción dada de baja';
    else if(!['running','closed'].includes(e.run_status))reason='La apertura todavía no está en curso ni cerrada';
    else if(!a.held)reason='Sin sesiones realizadas todavía';
    else if(a.pct<s.min_attendance_pct)reason='Asistencia '+a.pct+' % por debajo del mínimo ('+s.min_attendance_pct+' %)';
    else if(s.credits_enabled&&balance(e.brand_id)<1)reason='La marca no tiene créditos de certificado';
    return {...a,eligible:!reason,reason,certificate:cert||null};
  }
  // ---- emisión (dentro de la transacción del llamador)
  function nextFolio(t){
    const year=yearOf(t);db.prepare('INSERT INTO certificate_sequences(year,last) VALUES(?,0) ON CONFLICT(year) DO NOTHING').run(year);
    const n=db.prepare('UPDATE certificate_sequences SET last=last+1 WHERE year=? RETURNING last').get(year).last;
    return 'IPCI-'+year+'-'+String(n).padStart(5,'0');
  }
  function issueOne(en,e,s,actor,source){
    const el=eligibility(en,e,s);if(!el.eligible)throw fail(409,el.reason);
    const t=now(),id=randomUUID(),folio=nextFolio(t),code=randomBytes(5).toString('hex'),course=db.prepare('SELECT title FROM courses WHERE id=?').get(en.course_id),brand=db.prepare('SELECT name FROM brands WHERE id=?').get(en.brand_id),contact=db.prepare('SELECT * FROM contacts WHERE id=?').get(en.contact_id);
    const person=contact?.persona_id?db.prepare('SELECT id,name FROM persons WHERE id=?').get(contact.persona_id):null,holder=(person?.name||contact?.name||'Alumno').trim();
    const hours=db.prepare("SELECT COALESCE(sum(duration_min),0) m FROM edition_sessions WHERE edition_id=? AND status='done'").get(e.id).m;
    const snapshot={issuer:s.issuer_name,signer:s.signer_name,signerTitle:s.signer_title,accent:s.accent,logoFileId:s.logo_file_id,minAttendance:s.min_attendance_pct,editionStarts:e.starts_at,editionEnds:e.ends_at,instructor:e.instructor,modality:e.modality};
    db.prepare("INSERT INTO certificates(id,folio,verify_code,brand_id,enrollment_id,person_id,contact_id,course_id,edition_id,holder_name,course_title,edition_name,brand_name,sessions_held,sessions_attended,attendance_pct,hours,issued_at,issued_by,source,status,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'issued',?,?)")
      .run(id,folio,code,en.brand_id,en.id,person?.id||null,en.contact_id,en.course_id,en.edition_id,holder,course?.title||'Curso',e.name,brand?.name||en.brand_id,el.held,el.attended,el.pct,Math.round(hours/60)||null,t,actor?.id||null,source,JSON.stringify(snapshot),t);
    if(s.credits_enabled)db.prepare('INSERT INTO certificate_credits(id,brand_id,delta,reason,certificate_id,actor_id,created_at) VALUES(?,?,-1,?,?,?,?)').run(randomUUID(),en.brand_id,'Emisión '+folio,id,actor?.id||null,t);
    events.publish({type:'certificado.emitido',brandId:en.brand_id,entityKind:'certificate',entityId:id,payload:{folio,enrollmentId:en.id,personId:person?.id||null,contactId:en.contact_id,courseId:en.course_id,editionId:en.edition_id,holder,attendancePct:el.pct,source},actorId:actor?.id||null,source:'certificates'});
    // Aviso al alumno por su conversación (plantilla de utilidad); idempotente por folio.
    const conv=db.prepare('SELECT c.* FROM conversations c JOIN orders o ON o.conversation_id=c.id WHERE o.id=(SELECT order_id FROM enrollments WHERE id=?)').get(en.id);
    if(conv&&conv.status!=='resolved'){const tpl=content?.render('certificate_ready',en.brand_id,{courseId:en.course_id,editionId:en.edition_id,name:holder.split(' ')[0],extra:{folio,enlace_certificado:verifyUrl(folio,code),asistencia:el.pct+' %'}});
      try{insertMessage(conv,null,tpl?tpl.text:`¡Felicidades, ${holder}! Tu certificado de ${course?.title||'el curso'} (${e.name}) ya está emitido.\nFolio: ${folio}\nVerifícalo y descárgalo aquí: ${verifyUrl(folio,code)}\nLaboratorio: certificado de práctica.`,'automation','certificate:'+folio,null,null,null,{category:'utility'});}catch(err){if(err?.status!==409)throw err;}}
    return get(id);
  }
  function issue(e,input,user,source='manual'){
    requireIssuer(user,e);const s=settings(e.brand_id),ids=Array.isArray(input.enrollmentIds)?input.enrollmentIds.map(x=>text(x,60)).filter(Boolean).slice(0,500):null;
    const out=transaction(db,()=>{
      const rows=db.prepare("SELECT * FROM enrollments WHERE edition_id=? AND status='enrolled' ORDER BY created_at").all(e.id).filter(en=>!ids||ids.includes(en.id));
      if(ids&&rows.length!==ids.length)throw fail(404,'Alguna inscripción no pertenece a esta apertura o está dada de baja.');
      const issued=[],skipped=[];
      for(const en of rows){const el=eligibility(en,e,s);if(!el.eligible){skipped.push({enrollmentId:en.id,reason:el.reason});continue;}issued.push(view(issueOne(en,e,s,user,source)));}
      if(ids&&!issued.length&&skipped.length)throw fail(409,skipped[0].reason);
      if(issued.length)notify(e,issued.length+(issued.length===1?' certificado emitido':' certificados emitidos')+' · '+issued[0].course_title+' · '+e.name,'certificates:'+e.id+':'+now());
      return {issued,skipped};
    });
    audit(user,'certificate.issue',e.id+':'+out.issued.length);broadcast('crm',null,{brandId:e.brand_id});for(const c of out.issued){const conv=db.prepare('SELECT conversation_id FROM orders WHERE id=(SELECT order_id FROM enrollments WHERE id=?)').get(c.enrollment_id);if(conv)broadcast('conversation',conv.conversation_id);}
    return out;
  }
  // Emisión automática al cerrar la apertura (suscriptor de apertura.cerrada), sólo con el ajuste activo en la marca.
  function onClosed(ev){
    const e=db.prepare('SELECT * FROM editions WHERE id=?').get(ev.entity_id);if(!e)return;const s=settings(e.brand_id);if(!s.auto_issue)return;
    const out=transaction(db,()=>{const issued=[],skipped=[];for(const en of db.prepare("SELECT * FROM enrollments WHERE edition_id=? AND status='enrolled' ORDER BY created_at").all(e.id)){const el=eligibility(en,e,s);if(!el.eligible){skipped.push({enrollmentId:en.id,reason:el.reason});continue;}issued.push(issueOne(en,e,s,null,'auto'));}
      if(issued.length||skipped.length)notify(e,'Cierre de apertura: '+issued.length+' certificado(s) emitido(s)'+(skipped.length?', '+skipped.length+' sin emitir (asistencia o créditos)':'')+' · '+e.name,'certificates:'+e.id+':auto');return {issued,skipped};});
    broadcast('crm',null,{brandId:e.brand_id});return out;
  }
  function revoke(c,input,user){
    const e=edition(c.edition_id);requireIssuer(user,e);const reason=text(input.reason,500);if(reason.length<5)throw fail(400,'Indica el motivo de la revocación (mínimo 5 caracteres).');
    const t=now();transaction(db,()=>{
      if(!db.prepare("UPDATE certificates SET status='revoked',revoked_at=?,revoked_by=?,revoke_reason=? WHERE id=? AND status='issued'").run(t,user.id,reason,c.id).changes)throw fail(409,'El certificado ya estaba revocado.');
      events.publish({type:'certificado.revocado',brandId:c.brand_id,entityKind:'certificate',entityId:c.id,payload:{folio:c.folio,reason,holder:c.holder_name},actorId:user.id,source:'certificates'});
    });
    audit(user,'certificate.revoke',c.id);broadcast('crm',null,{brandId:c.brand_id});return view(get(c.id));
  }
  // ---- vistas
  const view=c=>({...c,snapshot:JSON.parse(c.snapshot||'{}'),statusLabel:c.status==='issued'?'Vigente':'Revocado',issuedLabel:longDate(c.issued_at),verifyUrl:verifyUrl(c.folio,c.verify_code),publicUrl:verifyUrl(c.folio),svgUrl:'/api/certificates/'+c.id+'.svg',issued_by_name:c.issued_by?db.prepare('SELECT name FROM users WHERE id=?').get(c.issued_by)?.name||null:null});
  function editionView(e,user){
    requireStaff(user);crm.requireBrand(user,e.brand_id);const s=settings(e.brand_id);
    const rows=db.prepare('SELECT en.*,c.name contact_name FROM enrollments en JOIN contacts c ON c.id=en.contact_id WHERE en.edition_id=? ORDER BY en.status,en.created_at').all(e.id).map(en=>{const el=eligibility(en,e,s);return {enrollmentId:en.id,status:en.status,contactName:en.contact_name,held:el.held,attended:el.attended,pct:el.pct,eligible:el.eligible,reason:el.reason,certificate:el.certificate?view(el.certificate):null};});
    return {settings:{...s,balance:balance(e.brand_id)},enrollments:rows,eligible:rows.filter(r=>r.eligible).length,issued:rows.filter(r=>r.certificate).length,canIssue:(()=>{try{requireIssuer(user,e);return true;}catch{return false;}})(),certificates:db.prepare('SELECT * FROM certificates WHERE edition_id=? ORDER BY issued_at DESC').all(e.id).map(view)};
  }
  function list(user,params){
    requireStaff(user);const ids=crm.brandsFor(user).map(b=>b.id).filter(id=>!params.get('brand')||params.get('brand')==='all'||id===params.get('brand'));if(!ids.length)return {certificates:[],stats:{}};
    const ph=ids.map(()=>'?').join(','),q=text(params.get('q')||'',80),status=['issued','revoked'].includes(params.get('status'))?params.get('status'):null;
    const rows=db.prepare(`SELECT * FROM certificates WHERE brand_id IN (${ph})${status?' AND status=?':''}${q?' AND (folio LIKE ? OR holder_name LIKE ? OR course_title LIKE ?)':''} ORDER BY issued_at DESC LIMIT 300`).all(...ids,...(status?[status]:[]),...(q?['%'+q+'%','%'+q+'%','%'+q+'%']:[])).map(view);
    const stats={issued:db.prepare(`SELECT count(*) n FROM certificates WHERE brand_id IN (${ph}) AND status='issued'`).get(...ids).n,revoked:db.prepare(`SELECT count(*) n FROM certificates WHERE brand_id IN (${ph}) AND status='revoked'`).get(...ids).n,verifications:db.prepare(`SELECT COALESCE(sum(verifications),0) n FROM certificates WHERE brand_id IN (${ph})`).get(...ids).n,year:yearOf(now()),lastFolio:db.prepare('SELECT last FROM certificate_sequences WHERE year=?').get(yearOf(now()))?.last||0};
    return {certificates:rows,stats,settings:ids.map(id=>({...settings(id),balance:balance(id),brand_name:db.prepare('SELECT name FROM brands WHERE id=?').get(id)?.name}))};
  }
  function setSettings(brandId,input,user){
    requireAdmin(user);if(!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no encontrada.');
    const cur=settings(brandId);if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==cur.revision)throw fail(409,'La configuración de certificados cambió. Recárgala.');
    const pct=input.minAttendancePct===undefined?cur.min_attendance_pct:Number(input.minAttendancePct);if(!Number.isInteger(pct)||pct<0||pct>100)throw fail(400,'La asistencia mínima va de 0 a 100 %.');
    const issuer=input.issuerName===undefined?cur.issuer_name:text(input.issuerName,120);if(issuer.length<2)throw fail(400,'Escribe el nombre del emisor.');
    const accent=input.accent===undefined?cur.accent:text(input.accent,7);if(!/^#[0-9a-fA-F]{6}$/.test(accent))throw fail(400,'El color debe ser hexadecimal (#rrggbb).');
    const logo=input.logoFileId===undefined?cur.logo_file_id:(text(input.logoFileId,60)||null);if(logo){const f=db.prepare('SELECT mime FROM library_files WHERE id=? AND brand_id=?').get(logo,brandId);if(!f||!/^image\/(png|jpeg|svg\+xml|webp)$/.test(f.mime))throw fail(400,'El logotipo debe ser una imagen de la biblioteca de la marca.');}
    const t=now();
    db.prepare('INSERT INTO certificate_settings(brand_id,auto_issue,min_attendance_pct,issuer_name,signer_name,signer_title,logo_file_id,accent,credits_enabled,revision,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(brand_id) DO UPDATE SET auto_issue=excluded.auto_issue,min_attendance_pct=excluded.min_attendance_pct,issuer_name=excluded.issuer_name,signer_name=excluded.signer_name,signer_title=excluded.signer_title,logo_file_id=excluded.logo_file_id,accent=excluded.accent,credits_enabled=excluded.credits_enabled,revision=certificate_settings.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at')
      .run(brandId,input.autoIssue===undefined?cur.auto_issue:input.autoIssue?1:0,pct,issuer,input.signerName===undefined?cur.signer_name:text(input.signerName,120),input.signerTitle===undefined?cur.signer_title:text(input.signerTitle,120),logo,accent,input.creditsEnabled===undefined?cur.credits_enabled:input.creditsEnabled?1:0,user.id,t);
    audit(user,'certificate.settings',brandId);broadcast('crm',null,{brandId});return {...settings(brandId),balance:balance(brandId)};
  }
  function addCredits(brandId,input,user){
    requireAdmin(user);if(!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no encontrada.');const n=Number(input.credits),reason=text(input.reason,200);
    if(!Number.isInteger(n)||n===0||Math.abs(n)>10000)throw fail(400,'Indica un número de créditos distinto de cero.');if(reason.length<3)throw fail(400,'Indica el motivo (compra, ajuste…).');
    db.prepare('INSERT INTO certificate_credits(id,brand_id,delta,reason,certificate_id,actor_id,created_at) VALUES(?,?,?,?,NULL,?,?)').run(randomUUID(),brandId,n,reason,user.id,now());
    audit(user,'certificate.credits',brandId+':'+n);return {balance:balance(brandId),history:db.prepare('SELECT k.delta,k.reason,k.created_at,u.name actor_name FROM certificate_credits k LEFT JOIN users u ON u.id=k.actor_id WHERE k.brand_id=? ORDER BY k.created_at DESC LIMIT 50').all(brandId)};
  }
  // ---- SVG del certificado (A4 apaisado) con QR de verificación; el logotipo se incrusta si es pequeño.
  async function logoData(fileId){
    if(!fileId)return null;const f=db.prepare('SELECT * FROM library_files WHERE id=?').get(fileId);if(!f)return null;
    try{const builtin=f.builtin_id?artworkAsset(f.builtin_id):null,bytes=await readFile(builtin?resolve(root,'public','flyers',builtin.filename):resolve(dataDir,'library',f.storage_name));if(bytes.length>400*1024)return null;return 'data:'+f.mime+';base64,'+bytes.toString('base64');}catch{return null;}
  }
  async function svg(c){
    const s=c.snapshot||{},accent=/^#[0-9a-fA-F]{6}$/.test(s.accent||'')?s.accent:'#30343c',qr=encodeQR(verifyUrl(c.folio,c.verify_code)),{path,side}=qrSvgPath(qr,3,2),logo=await logoData(s.logoFileId);
    const W=1123,H=794,revoked=c.status==='revoked';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, 'Segoe UI', Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="#ffffff"/><rect x="28" y="28" width="${W-56}" height="${H-56}" fill="none" stroke="${accent}" stroke-width="2"/><rect x="40" y="40" width="${W-80}" height="${H-80}" fill="none" stroke="#e3e6ec" stroke-width="1"/>
${logo?`<image href="${logo}" x="80" y="78" width="120" height="120" preserveAspectRatio="xMidYMid meet"/>`:''}
<text x="${logo?224:80}" y="118" font-size="20" fill="#5b6472" letter-spacing="3">${esc(String(s.issuer||'IPCI').toUpperCase())}</text>
<text x="${logo?224:80}" y="150" font-size="15" fill="#8a919c">${esc(c.brand_name)}</text>
<text x="80" y="268" font-size="48" fill="${accent}" font-weight="600">Certificado</text>
<text x="80" y="306" font-size="16" fill="#5b6472">se otorga a</text>
<text x="80" y="366" font-size="40" fill="#1f242c" font-weight="500">${esc(c.holder_name)}</text>
<text x="80" y="420" font-size="16" fill="#5b6472">por acreditar el curso</text>
<text x="80" y="462" font-size="28" fill="#1f242c" font-weight="500">${esc(c.course_title)}</text>
<text x="80" y="498" font-size="15" fill="#5b6472">${esc(c.edition_name)}${s.instructor?' · '+esc(s.instructor):''}${c.hours?' · '+c.hours+' h':''} · asistencia ${c.attendance_pct} % (${c.sessions_attended} de ${c.sessions_held} sesiones)</text>
<text x="80" y="600" font-size="14" fill="#5b6472">Emitido el ${esc(longDate(c.issued_at))}</text>
<text x="80" y="628" font-size="14" fill="#1f242c" font-weight="500">Folio ${esc(c.folio)}</text>
<text x="80" y="652" font-size="12" fill="#8a919c">${esc(verifyUrl(c.folio))} · código ${esc(c.verify_code)}</text>
${s.signer?`<line x1="${W-440}" y1="610" x2="${W-200}" y2="610" stroke="#b9bfc9"/><text x="${W-320}" y="634" font-size="14" fill="#1f242c" text-anchor="middle">${esc(s.signer)}</text><text x="${W-320}" y="654" font-size="12" fill="#8a919c" text-anchor="middle">${esc(s.signerTitle||'')}</text>`:''}
<g transform="translate(${W-80-side},78)"><rect width="${side}" height="${side}" fill="#fff"/><path d="${path}" fill="#000" shape-rendering="crispEdges"/></g>
<text x="${W-80-side/2}" y="${78+side+18}" font-size="11" fill="#8a919c" text-anchor="middle">Escanea para verificar</text>
${revoked?`<g transform="rotate(-18 ${W/2} ${H/2})"><rect x="${W/2-260}" y="${H/2-50}" width="520" height="100" fill="none" stroke="#ac3d30" stroke-width="6" rx="12"/><text x="${W/2}" y="${H/2+18}" font-size="56" fill="#ac3d30" text-anchor="middle" font-weight="700">REVOCADO</text></g>`:''}
<text x="${W/2}" y="${H-52}" font-size="11" fill="#b0b6bf" text-anchor="middle">Laboratorio TEC Capital · certificado de práctica, sin validez oficial</text>
</svg>`;
  }
  // ---- verificación pública (sin sesión; con límite por IP)
  const publicView=(c,full)=>({folio:c.folio,status:c.status,statusLabel:c.status==='issued'?'Vigente':'Revocado',holder:full?c.holder_name:maskName(c.holder_name),full:Boolean(full),course:c.course_title,edition:c.edition_name,brand:c.brand_name,issuer:(JSON.parse(c.snapshot||'{}').issuer)||'IPCI',issuedAt:c.issued_at,issuedLabel:longDate(c.issued_at),attendancePct:c.attendance_pct,hours:c.hours,revokedAt:c.revoked_at,verifiedAt:now()});
  function verifyPage(c,folio,full){
    const v=c?publicView(c,full):null,ok=v&&v.status==='issued';
    const head=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verificación de certificado · ${esc(folio)}</title><meta name="robots" content="noindex"><style>body{margin:0;background:#fbfbfd;color:#1f242c;font:15px/1.6 Inter,'Segoe UI',Helvetica,Arial,sans-serif}main{max-width:720px;margin:0 auto;padding:40px 16px}.card{background:#fff;border:1px solid #e6e8ee;border-radius:18px;padding:28px}.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#67717d}h1{font-size:26px;margin:6px 0 18px;font-weight:600}.state{display:inline-block;padding:7px 14px;border-radius:20px;font-size:13px;border:1px solid #e2e5eb;background:#fafbfc;color:#67717d}.ok{background:#eff9f5;color:#258163;border-color:#cfe9dd}.bad{background:#fff2ef;color:#ac3d30;border-color:#f4d7d0}dl{display:grid;grid-template-columns:max-content 1fr;gap:8px 18px;margin:22px 0;font-size:14px}dt{color:#67717d}dd{margin:0}a.btn{display:inline-block;margin-top:8px;padding:11px 16px;border:1px solid #d7dbe3;border-radius:12px;color:#1f242c;text-decoration:none;font-size:13px}small{display:block;color:#8a919c;font-size:12px;margin-top:22px}@media(max-width:480px){dl{grid-template-columns:1fr;gap:2px}dt{margin-top:8px}}</style></head><body><main><div class="card"><div class="eyebrow">Verificación de certificado</div>`;
    const body=!v?`<h1>Folio no encontrado</h1><span class="state bad">No existe</span><p>El folio <strong>${esc(folio)}</strong> no corresponde a ningún certificado emitido por este laboratorio. Revisa que esté bien escrito.</p>`
      :`<h1>${esc(v.holder)}</h1><span class="state ${ok?'ok':'bad'}">${ok?'Certificado vigente':'Certificado revocado'}</span><dl><dt>Folio</dt><dd><strong>${esc(v.folio)}</strong></dd><dt>Curso</dt><dd>${esc(v.course)}</dd><dt>Edición</dt><dd>${esc(v.edition)}</dd><dt>Marca</dt><dd>${esc(v.brand)}</dd><dt>Emisor</dt><dd>${esc(v.issuer)}</dd><dt>Fecha de emisión</dt><dd>${esc(v.issuedLabel)}</dd><dt>Asistencia</dt><dd>${v.attendancePct} %${v.hours?' · '+v.hours+' h':''}</dd>${v.revokedAt?`<dt>Revocado</dt><dd>${esc(longDate(v.revokedAt))}</dd>`:''}</dl>${full?`<a class="btn" href="/verificar/${esc(v.folio)}/${esc(c.verify_code)}.svg">Ver el certificado</a>`:`<p>Nombre abreviado por privacidad. Para ver el nombre completo y el certificado, abre el enlace del código QR impreso en él (incluye su código de verificación).</p>`}`;
    return head+body+`<small>Laboratorio TEC Capital · certificado de práctica, sin validez oficial. Consulta realizada el ${esc(longDate(now()))}.</small></div></main></body></html>`;
  }
  function bump(c){db.prepare('UPDATE certificates SET verifications=verifications+1,last_verified_at=? WHERE id=?').run(now(),c.id);}
  async function handlePublic(req,res,path,ip){
    let x;
    if((x=path.match(/^\/verificar\/([A-Za-z0-9-]{1,20})(?:\/([a-f0-9]{10}))?(\.svg)?$/))){
      if(req.method!=='GET')throw fail(405,'Método no permitido.');rate('verify:'+ip,60);
      const folio=x[1].toUpperCase(),c=FOLIO.test(folio)?byFolio(folio):null,full=Boolean(c&&x[2]&&x[2]===c.verify_code);
      if(x[3]){if(!c)throw fail(404,'Certificado no encontrado.');if(!full)throw fail(404,'El certificado se descarga con el enlace del código QR.');bump(c);res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Content-Disposition':'inline; filename="'+folio+'.svg"'});res.end(await svg(view(c)));return true;}
      if(c)bump(c);res.writeHead(c?200:404,{'Content-Type':'text/html; charset=utf-8'});res.end(verifyPage(c,folio,full));return true;
    }
    if((x=path.match(/^\/api\/verify\/([A-Za-z0-9-]{1,20})$/))){
      if(req.method!=='GET')throw fail(405,'Método no permitido.');rate('verify:'+ip,60);
      const folio=x[1].toUpperCase(),c=FOLIO.test(folio)?byFolio(folio):null;if(!c){json(res,404,{valid:false,folio,error:'Folio no encontrado.'});return true;}
      const code=new URL(req.url,'http://localhost').searchParams.get('code')||'';bump(c);json(res,200,{valid:c.status==='issued',certificate:publicView(c,code===c.verify_code)});return true;
    }
    return false;
  }
  async function handle(req,res,path,user){
    if(!path.startsWith('/api/certificates'))return false;
    const p=new URL(req.url,'http://localhost').searchParams;let x;
    if(path==='/api/certificates'&&req.method==='GET'){json(res,200,list(user,p));return true;}
    if((x=path.match(/^\/api\/certificates\/brands\/([a-zA-Z0-9-]+)(?:\/(credits))?$/))){
      if(!x[2]&&req.method==='PATCH'){json(res,200,{settings:setSettings(x[1],await body(req),user)});return true;}
      if(x[2]==='credits'&&req.method==='POST'){json(res,200,addCredits(x[1],await body(req),user));return true;}
      if(x[2]==='credits'&&req.method==='GET'){requireStaff(user);crm.requireBrand(user,x[1]);json(res,200,{balance:balance(x[1]),history:db.prepare('SELECT k.delta,k.reason,k.created_at,u.name actor_name FROM certificate_credits k LEFT JOIN users u ON u.id=k.actor_id WHERE k.brand_id=? ORDER BY k.created_at DESC LIMIT 50').all(x[1])});return true;}
      throw fail(405,'Método no permitido.');
    }
    if((x=path.match(/^\/api\/certificates\/editions\/([a-zA-Z0-9-]+)(?:\/(issue))?$/))){
      const e=edition(x[1]);
      if(!x[2]&&req.method==='GET'){json(res,200,editionView(e,user));return true;}
      if(x[2]==='issue'&&req.method==='POST'){json(res,200,issue(e,await body(req),user));return true;}
      throw fail(405,'Método no permitido.');
    }
    if((x=path.match(/^\/api\/certificates\/([a-f0-9-]{36})(?:\.(svg)|\/(revoke))?$/))){
      const c=get(x[1]);if(!c)throw fail(404,'Certificado no encontrado.');requireStaff(user);crm.requireBrand(user,c.brand_id);
      if(x[2]==='svg'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Content-Disposition':'inline; filename="'+c.folio+'.svg"'});res.end(await svg(view(c)));return true;}
      if(x[3]==='revoke'&&req.method==='POST'){json(res,200,{certificate:revoke(c,await body(req),user)});return true;}
      if(!x[2]&&!x[3]&&req.method==='GET'){json(res,200,{certificate:view(c)});return true;}
      throw fail(405,'Método no permitido.');
    }
    throw fail(404,'Ruta de certificados no encontrada.');
  }
  events.subscribe('apertura.cerrada','certificates.auto',onClosed);
  return {handle,handlePublic,settings,eligibility,issue,revoke,editionView,list,svg,onClosed,verifyUrl};
}
