import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {transaction} from './database.mjs';
import {cancelConversationSteps} from './automation.mjs';
import {defaultEditionId,ensureDefaultEdition} from './catalogue-schema.mjs';
import {artworkAsset} from './demo-catalog.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const txt=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';
const channels=['all','whatsapp','instagram','facebook'];
// Escenarios: los clásicos de venta y, desde la Fase 2 (bloque 2.6), uno por evento del ciclo (los mapea Contenido).
export const scenarios=['info','syllabus','schedule','price','enroll','followup','after_sale','ad_welcome','payment_pending','payment_confirmed','session_reminder','recording_available','certificate_ready','session_payment','survey_request','away_hours'];
export const variables=['nombre','marca','curso','edicion','fecha','docente','modalidad','precio','precio_regular','promocion','vigencia','temario','enlace','cupo','pedido','importe','enlace_pago','vigencia_pago','sesion','fecha_sesion','enlace_sesion','grupo','grabacion','folio','enlace_certificado','asistencia','plan_pago','enlace_encuesta','apertura'];
// Variables de evento sin valor en una plantilla de venta quedan vacías (no «undefined»).
export const fillTemplate=(bodyText,values)=>String(bodyText).replace(/\{\{\s*([a-z_]+)\s*\}\}/g,(_,key)=>values[key]??'');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money=(cents,currency)=>new Intl.NumberFormat('es-MX',{style:'currency',currency,minimumFractionDigits:2}).format(cents/100)+' '+currency;
const nullableInt=v=>v===''||v==null?null:Number(v);
const date=v=>{const n=nullableInt(v);if(n!==null&&(!Number.isSafeInteger(n)||n<0||n>8640000000000000))throw fail(400,'Fecha no válida.');return n;};
const price=v=>{const n=Number(v);if(v===''||v==null||!Number.isFinite(n)||n<0||n>1000000||Math.abs(n*100-Math.round(n*100))>0.00001)throw fail(400,'El precio debe tener como máximo dos decimales.');return Math.round(n*100);};
const revision=(row,input)=>{if(!row)return;if(Number(input.expectedRevision)!==row.revision)throw fail(409,'El registro cambió. Recarga los datos antes de guardar.');};
const timeText=(value,zone)=>value===null?'Por confirmar':new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(value)+' · '+zone;

// Valores de las variables de una plantilla para un curso/edición (los usa también Contenido para las plantillas por evento).
export function templateValues(ctx,name){
  const {course:c,edition:e,promotion:p,brand}=ctx;
  return {nombre:name||'Hola',marca:brand.name,curso:c.title,edicion:e.name,fecha:ctx.dateLabel,docente:e.instructor||'Por confirmar',
    modalidad:{online:'En línea',in_person:'Presencial',hybrid:'Híbrida'}[e.modality],precio:money(ctx.priceCents,e.currency),precio_regular:money(e.price_cents,e.currency),
    promocion:p?p.name:'Sin promoción vigente',vigencia:p?timeText(p.ends_at,e.timezone):'No aplica',temario:c.syllabus,enlace:e.info_url||'Por confirmar',cupo:e.available_seats===null?'Por confirmar':String(e.available_seats)};
}
export function validateTemplateBody(bodyText){
  const fail=(status,message)=>Object.assign(new Error(message),{status});
  if(!bodyText)throw fail(400,'Escribe el texto de la plantilla.');
  const matches=[...bodyText.matchAll(/\{\{([^{}]+)\}\}/g)];
  if(matches.some(m=>!variables.includes(m[1].trim()))||bodyText.replace(/\{\{[^{}]+\}\}/g,'').includes('{{')||bodyText.replace(/\{\{[^{}]+\}\}/g,'').includes('}}'))throw fail(400,'Usa sólo las variables disponibles y cierra sus llaves.');
}
export function createCatalogue({db,crm,body,json,audit,broadcast,dataDir,root,attachmentData,accessConversation,insertMessage,serveFlyer}){
  function admin(user){const current=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);if(!current||current.disabled||current.role!=='admin')throw fail(403,'Sólo administración puede editar y aprobar el catálogo.');}
  function scoped(table,id,user){const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);if(!row)throw fail(404,'Contenido no disponible.');crm.requireBrand(user,row.brand_id);return row;}
  function record(kind,row,user,action){const snapshot=kind==='promotion'?{...row,currency:edition(row.edition_id).currency}:row;db.prepare('INSERT INTO catalogue_events(brand_id,entity_kind,entity_id,revision,action,actor_id,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)').run(row.brand_id,kind,row.id,row.revision||row.version,action,user?.id||null,JSON.stringify(snapshot),Date.now());audit(user,'catalogue.'+kind+'.'+action,row.id);}
  function changed(brand){broadcast('crm',null,{brandId:brand});broadcast('catalog');}
  function course(id){const c=db.prepare('SELECT * FROM courses WHERE id=?').get(id);if(!c)throw fail(404,'Curso no disponible.');return c;}
  function edition(id){const e=db.prepare('SELECT * FROM editions WHERE id=?').get(id);if(!e)throw fail(404,'Edición no disponible.');return e;}
  function binding(e,p=null){return {course:course(e.course_id).version,edition:e.revision,promotion:p?{id:p.id,revision:p.revision}:null};}
  function editionState(e,now=Date.now()){
    if(!course(e.course_id).active)return 'Curso archivado';
    if(e.status!=='published')return e.status==='archived'?'Edición archivada':'Edición en borrador';
    if(e.starts_at!==null&&now>=e.starts_at)return 'La edición ya comenzó';
    if(e.available_seats===0)return 'Sin cupo disponible';
    return '';
  }
  function promotionState(p,now=Date.now()){
    if(p.status!=='published')return p.status==='archived'?'Archivada':'Borrador';
    if(now>=p.ends_at)return 'Vencida';if(now<p.starts_at)return 'Programada';
    const e=edition(p.edition_id);if(p.price_cents>=e.price_cents)return 'Precio por revisar';
    return editionState(e,now)||'Vigente';
  }
  function activePromotion(e,now=Date.now()){
    return db.prepare("SELECT * FROM promotions WHERE edition_id=? AND status='published' AND starts_at<=? AND ends_at>? AND price_cents<? ORDER BY starts_at DESC LIMIT 1").get(e.id,now,now,e.price_cents)||null;
  }
  function flyerState(f,now=Date.now()){
    if(f.status!=='approved')return f.status==='archived'?'Archivado':'Borrador';
    if(f.expires_at!==null&&now>=f.expires_at)return 'Vencido';
    const e=edition(f.edition_id),p=f.promotion_id?db.prepare('SELECT * FROM promotions WHERE id=?').get(f.promotion_id):null;
    if(JSON.stringify(binding(e,p))!==f.binding)return 'Requiere revisión';
    if(p&&promotionState(p,now)!=='Vigente')return 'Promoción '+promotionState(p,now).toLowerCase();
    // A static base-price flyer is held back during a promotion to avoid conflicting prices.
    if(!p&&activePromotion(e,now))return 'Hay una promoción vigente';
    return editionState(e,now)||'Listo para enviar';
  }
  function info(courseId,editionId=null,now=Date.now()){
    const c=course(courseId),e=edition(editionId||defaultEditionId(c.id));if(e.course_id!==c.id)throw fail(400,'La edición pertenece a otro curso.');
    const p=activePromotion(e,now),brand=db.prepare('SELECT * FROM brands WHERE id=?').get(c.brand_id),reason=editionState(e,now);
    return {course:c,edition:e,promotion:p,brand,priceCents:p?.price_cents??e.price_cents,currency:e.currency,reason,
      dateLabel:e.starts_at===null?(e.legacy?c.date_label:'Por confirmar'):timeText(e.starts_at,e.timezone)};
  }
  function templateText(t,ctx,name){
    const rendered=fillTemplate(t.body,templateValues(ctx,name));
    if(rendered.length>5000)throw fail(400,'La plantilla resuelta supera 5000 caracteres. Reduce el texto o temario.');return rendered;
  }
  function validateTemplate(bodyText){return validateTemplateBody(bodyText);}
  function validateTemplate_(bodyText){
    if(!bodyText)throw fail(400,'Escribe el texto de la plantilla.');
    const matches=[...bodyText.matchAll(/\{\{([^{}]+)\}\}/g)];
    if(matches.some(m=>!variables.includes(m[1].trim()))||bodyText.replace(/\{\{[^{}]+\}\}/g,'').includes('{{')||bodyText.replace(/\{\{[^{}]+\}\}/g,'').includes('}}'))throw fail(400,'Usa sólo las variables disponibles y cierra sus llaves.');
  }
  function prepare(c,input={},name=null){
    const ctx=info(c.course_id,c.edition_id),{course:k,edition:e,promotion:p,brand}=ctx;
    if(ctx.reason)throw fail(409,ctx.reason+'. Consulta al responsable del catálogo.');
    let template=null,flyer=null,text='',kind=input.kind||'flyer';
    if(input.templateId){
      template=db.prepare('SELECT * FROM content_templates WHERE id=?').get(input.templateId);
      if(!template||template.status!=='approved'||template.brand_id!==c.brand_id||(template.course_id&&template.course_id!==c.course_id)||(template.edition_id&&template.edition_id!==e.id)||!['all',c.channel].includes(template.channel))throw fail(409,'La plantilla no está aprobada para este curso, edición y canal.');
      const person=name||db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id)?.name;
      text=templateText(template,ctx,person?.split(' ')[0]);
    }else if(kind==='price')text=`Precio de ejemplo: ${money(ctx.priceCents,e.currency)}. ${e.name}. ${p?p.name+' · Vigente hasta '+timeText(p.ends_at,e.timezone):'Sin promoción vigente.'} Datos de práctica.`;
    else if(kind==='syllabus')text='Temario:\n\n'+k.syllabus;
    else if(kind==='schedule')text=`${k.title} · ${e.name}\nFecha: ${ctx.dateLabel}\nDocente: ${e.instructor||'Por confirmar'}`;
    else text=`Te comparto la información de ${k.title} · ${e.name}.\n${ctx.dateLabel}\nPrecio de ejemplo: ${money(ctx.priceCents,e.currency)}.\nLaboratorio: no constituye una oferta comercial real.`;
    const selected=input.flyerId||template?.flyer_id;
    if(selected){flyer=db.prepare('SELECT * FROM flyers WHERE id=?').get(selected);if(!flyer||flyer.edition_id!==e.id||flyer.brand_id!==c.brand_id||!['all',c.channel].includes(flyer.channel)||flyerState(flyer)!=='Listo para enviar')throw fail(409,'El flyer no está vigente y aprobado para esta edición y canal.');}
    else if(!template&&kind==='flyer')flyer=db.prepare("SELECT * FROM flyers WHERE edition_id=? AND status='approved' AND channel IN ('all',?) ORDER BY updated_at DESC,id").all(e.id,c.channel).find(f=>flyerState(f)==='Listo para enviar')||null;
    const commercial={courseId:k.id,courseTitle:k.title,courseVersion:k.version,editionId:e.id,editionName:e.name,editionRevision:e.revision,startsAt:e.starts_at,timezone:e.timezone,dateLabel:ctx.dateLabel,
      priceCents:ctx.priceCents,regularPriceCents:e.price_cents,currency:e.currency,promotionId:p?.id||null,promotionName:p?.name||null,promotionRevision:p?.revision||null,promotionEndsAt:p?.ends_at||null,
      templateId:template?.id||null,templateRevision:template?.revision||null,flyerId:flyer?.id||null,flyerRevision:flyer?.revision||null};
    const hasFlyer=Boolean(flyer)||(!template&&kind==='flyer');
    const flyerSnapshot=hasFlyer?{course:{...k,price_cents:ctx.priceCents,date_label:ctx.dateLabel,currency:e.currency,edition_name:e.name},brand,artworkId:null,libraryFileId:flyer?.file_id||null,commercial}:null;
    const previewToken=digest({text,commercial,channel:c.channel});
    return {text,commercial,flyerSnapshot,previewToken,flyerUrl:hasFlyer?(flyer?'/api/library/files/'+flyer.file_id:'/api/courses/'+k.id+'/flyer?editionId='+e.id):null};
  }
  async function serveFile(res,id){
    const f=db.prepare('SELECT * FROM library_files WHERE id=?').get(id);if(!f)throw fail(404,'Archivo no disponible.');
    const builtin=f.builtin_id?artworkAsset(f.builtin_id):null;
    const bytes=await readFile(builtin?resolve(root,'public','flyers',builtin.filename):resolve(dataDir,'library',f.storage_name));
    res.writeHead(200,{'Content-Type':f.mime,'Content-Length':bytes.length,'Content-Disposition':`${f.mime==='application/pdf'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`});res.end(bytes);
  }
  function legacyUpdated(c,user){
    const id=ensureDefaultEdition(db,c),e=edition(id);
    if(e.legacy){db.prepare('UPDATE editions SET price_cents=?,revision=revision+1,updated_at=? WHERE id=?').run(c.price_cents,Date.now(),id);record('edition',edition(id),user,'updated');}
    record('course',c,user,'updated');changed(c.brand_id);
  }
  async function handle(req,res,path,user){
    const url=new URL(req.url,'http://localhost');
    const publicEditions=path.match(/^\/api\/courses\/([a-z0-9-]+)\/editions$/);
    if(publicEditions&&req.method==='GET'){
      const c=course(publicEditions[1]);if(user.role!=='customer')crm.requireBrand(user,c.brand_id);
      const items=db.prepare("SELECT * FROM editions WHERE course_id=? AND status='published' ORDER BY starts_at IS NULL,starts_at").all(c.id).filter(e=>!editionState(e));
      return json(res,200,{editions:items.map(e=>({...e,priceCents:info(c.id,e.id).priceCents,dateLabel:info(c.id,e.id).dateLabel}))}),true;
    }
    const file=path.match(/^\/api\/library\/files\/([a-f0-9-]+)$/);
    if(file&&req.method==='GET'){scoped('library_files',file[1],user);await serveFile(res,file[1]);return true;}
    const material=path.match(/^\/api\/conversations\/([a-f0-9-]+)\/materials(?:\/(preview|send))?$/);
    if(material){
      const c=accessConversation(material[1],user);crm.requireBrand(user,c.brand_id);
      if(req.method==='GET'){
        const templates=db.prepare("SELECT * FROM content_templates WHERE brand_id=? AND status='approved' AND (course_id IS NULL OR course_id=?) AND (edition_id IS NULL OR edition_id=?) AND channel IN ('all',?) ORDER BY scenario,title").all(c.brand_id,c.course_id,c.edition_id,c.channel);
        const flyers=db.prepare("SELECT f.*,l.mime FROM flyers f JOIN library_files l ON l.id=f.file_id WHERE f.edition_id=? AND f.channel IN ('all',?) ORDER BY f.updated_at DESC").all(c.edition_id,c.channel).map(f=>({...f,availability:flyerState(f)}));
        json(res,200,{templates,flyers,context:info(c.course_id,c.edition_id)});return true;
      }
      if(req.method==='POST'&&material[2]){
        const input=await body(req);let result;
        transaction(db,()=>{
          const current=accessConversation(c.id,user);crm.requireBrand(user,current.brand_id);
          if(material[2]==='send'){
            const ref=user.id+':'+txt(input.clientRef,100);if(!/^[a-zA-Z0-9-]{16,100}$/.test(input.clientRef||''))throw fail(400,'Referencia de envío no válida.');
            const old=db.prepare('SELECT id,conversation_id FROM messages WHERE client_ref=?').get(ref);if(old){if(old.conversation_id!==c.id)throw fail(409,'Referencia ya utilizada.');result={id:old.id,duplicate:true};return;}
            if(current.status==='resolved')throw fail(409,'La conversación está cerrada.');if(current.assigned_to&&current.assigned_to!==user.id&&user.role!=='admin')throw fail(409,'Otro asesor está atendiendo.');
            const prepared=prepare(current,input);if(input.previewToken!==prepared.previewToken)throw fail(409,'La información cambió o venció. Vuelve a previsualizar antes de enviar.');
            crm.assignConversation(current,user.id);const id=insertMessage(current,user,prepared.text,'agent',ref,null,prepared.flyerSnapshot?current.course_id:null,prepared);
            db.prepare("UPDATE conversations SET bot_enabled=0,assigned_to=?,status='open' WHERE id=?").run(user.id,current.id);db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending'").run(current.id);cancelConversationSteps(db,current.id,'human_takeover');
            result={id,duplicate:false};
          }else result=prepare(current,input);
        });
        if(material[2]==='send')broadcast('conversation',c.id);json(res,200,result);return true;
      }
    }
    if(!path.startsWith('/api/catalogue'))return false;
    if(!['admin','agent'].includes(user.role))throw fail(403,'Catálogo interno del equipo.');
    if(path==='/api/catalogue'&&req.method==='GET'){
      const permitted=items=>items.filter(x=>crm.canBrand(user,x.brand_id));
      json(res,200,{courses:permitted(db.prepare('SELECT * FROM courses ORDER BY title').all()),editions:permitted(db.prepare('SELECT * FROM editions ORDER BY updated_at DESC').all()).map(e=>({...e,availability:editionState(e)||'Disponible',effectivePriceCents:info(e.course_id,e.id).priceCents})),
        promotions:permitted(db.prepare('SELECT * FROM promotions ORDER BY starts_at DESC').all()).map(p=>({...p,availability:promotionState(p)})),
        flyers:permitted(db.prepare('SELECT f.*,l.mime,l.filename FROM flyers f JOIN library_files l ON l.id=f.file_id ORDER BY f.updated_at DESC').all()).map(f=>({...f,availability:flyerState(f),fileUrl:'/api/library/files/'+f.file_id})),
        templates:permitted(db.prepare('SELECT * FROM content_templates ORDER BY title').all()),variables});return true;
    }
    const history=path.match(/^\/api\/catalogue\/(course|edition|promotion|flyer|template)\/([a-z0-9-]+)\/history$/);
    if(history&&req.method==='GET'){
      const tables={course:'courses',edition:'editions',promotion:'promotions',flyer:'flyers',template:'content_templates'};const item=scoped(tables[history[1]],history[2],user),before=Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER;
      const rows=db.prepare('SELECT e.*,u.name actor_name FROM catalogue_events e LEFT JOIN users u ON u.id=e.actor_id WHERE entity_kind=? AND entity_id=? AND seq<? ORDER BY seq DESC LIMIT 51').all(history[1],item.id,before);
      json(res,200,{events:rows.slice(0,50).map(r=>({...r,snapshot:JSON.parse(r.snapshot)})),nextBefore:rows.length>50?rows[49].seq:null});return true;
    }
    if(path==='/api/catalogue/preview'&&req.method==='POST'){
      const input=await body(req),e=scoped('editions',input.editionId,user),t=input.templateId?scoped('content_templates',input.templateId,user):{body:txt(input.text,3000)};validateTemplate(t.body);
      if(t.brand_id&&t.brand_id!==e.brand_id||t.course_id&&t.course_id!==e.course_id||t.edition_id&&t.edition_id!==e.id)throw fail(400,'La plantilla no corresponde a esta edición.');
      json(res,200,{text:templateText(t,info(e.course_id,e.id),txt(input.name,60)||'Cliente de prueba')});return true;
    }
    if(path==='/api/catalogue/files'&&req.method==='POST'){
      const input=await body(req);if(contentGate)contentGate(user,'files','create');else admin(user);crm.requireBrand(user,input.brandId);const f=attachmentData(input.file);if(!f)throw fail(400,'Elige una imagen o PDF.');
      await mkdir(resolve(dataDir,'library'),{recursive:true});const filePath=resolve(dataDir,'library',f.storageName);await writeFile(filePath,f.buffer,{flag:'wx'});
      const id=randomUUID();try{crm.requireBrand(user,input.brandId);db.prepare('INSERT INTO library_files(id,brand_id,filename,mime,size,storage_name,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,input.brandId,f.filename,f.mime,f.buffer.length,f.storageName,user.id,Date.now());}catch(e){await unlink(filePath).catch(()=>{});throw e;}
      json(res,201,{id,filename:f.filename,mime:f.mime});return true;
    }
    const endpoint=path.match(/^\/api\/catalogue\/(courses|editions|promotions|flyers|templates)(?:\/([a-z0-9-]+))?(?:\/(approve|archive))?$/);
    if(!endpoint||!['POST','PATCH'].includes(req.method))throw fail(404,'Acción de catálogo no disponible.');
    const [,type,id,action]=endpoint,input=await body(req);if(['flyers','templates'].includes(type)&&contentGate)contentGate(user,type,action);else admin(user);
    const table={courses:'courses',editions:'editions',promotions:'promotions',flyers:'flyers',templates:'content_templates'}[type],kind={courses:'course',editions:'edition',promotions:'promotion',flyers:'flyer',templates:'template'}[type];
    const saved=transaction(db,()=>{
      const old=id?scoped(table,id,user):null;revision(old&&{revision:old.revision||old.version},input);
      if(action){
        if(!old)throw fail(404,'Registro no disponible.');
        if(action==='approve'){
          if(!['flyers','templates'].includes(type))throw fail(400,'Ese contenido no usa aprobación.');
          if(type==='flyers'){
            const e=edition(old.edition_id),p=old.promotion_id?db.prepare('SELECT * FROM promotions WHERE id=?').get(old.promotion_id):null;
            if(JSON.stringify(binding(e,p))!==old.binding)throw fail(409,'Los datos cambiaron. Revisa la pieza y guarda un borrador actualizado antes de aprobar.');
            if(old.expires_at!==null&&old.expires_at<=Date.now())throw fail(400,'El flyer ya venció.');
          }else validateTemplate(old.body);
          db.prepare(`UPDATE ${table} SET status='approved',approved_by=?,approved_at=?,revision=revision+1,updated_at=? WHERE id=?`).run(user.id,Date.now(),Date.now(),id);
        }else if(type==='courses')db.prepare('UPDATE courses SET active=0,version=version+1,updated_at=? WHERE id=?').run(Date.now(),id);
        else db.prepare(`UPDATE ${table} SET status='archived',revision=revision+1,updated_at=? WHERE id=?`).run(Date.now(),id);
      }else if(type==='courses'){
        const brandId=old?.brand_id||input.brandId;crm.requireBrand(user,brandId);const title=txt(input.title,180),syllabus=txt(input.syllabus,5000),welcome=txt(input.welcome,2000);
        if(title.length<3||!syllabus)throw fail(400,'Completa el título y temario del curso.');
        const courseId=old?.id||randomUUID();if(old)db.prepare('UPDATE courses SET title=?,syllabus=?,welcome=?,active=?,version=version+1,updated_at=? WHERE id=?').run(title,syllabus,welcome||old.welcome,input.active===false?0:1,Date.now(),courseId);
        else db.prepare('INSERT INTO courses(id,brand_id,title,price_cents,date_label,syllabus,welcome,updated_at) VALUES(?,?,?,0,?,?,?,?)').run(courseId,brandId,title,'Por confirmar',syllabus,welcome||'Hola, {{nombre}}. Te comparto la información de {{curso}}.',Date.now());
        const row=course(courseId);if(!old){const defaultId=ensureDefaultEdition(db,row);db.prepare("UPDATE editions SET status='draft',legacy=0 WHERE id=?").run(defaultId);}record(kind,row,user,old?'updated':'created');return row;
      }else if(type==='editions'){
        const c=course(old?.course_id||input.courseId);crm.requireBrand(user,c.brand_id);const starts=date(input.startsAt),ends=date(input.endsAt),zone=txt(input.timezone,80),name=txt(input.name,120),capacity=nullableInt(input.capacity),available=nullableInt(input.availableSeats),cost=price(input.price),sessionCost=input.sessionPrice===''||input.sessionPrice===undefined||input.sessionPrice===null?null:price(input.sessionPrice),currency=txt(input.currency,3).toUpperCase(),status=input.status||'draft',link=txt(input.infoUrl,1000);
        try{new Intl.DateTimeFormat('es-MX',{timeZone:zone});}catch{throw fail(400,'Zona horaria no válida.');}
        if(!name||!['online','in_person','hybrid'].includes(input.modality)||!['MXN','USD','COP','PEN','EUR'].includes(currency)||!['draft','published','archived'].includes(status))throw fail(400,'Revisa nombre, modalidad, moneda y estado.');
        if(ends!==null&&(starts===null||ends<=starts))throw fail(400,'El final debe ser posterior al inicio.');
        if(status==='published'&&(!old?.legacy&&starts===null||starts!==null&&starts<=Date.now()))throw fail(400,'Para publicar, indica una fecha futura.');
        if(capacity!==null&&(!Number.isSafeInteger(capacity)||capacity<1)||available!==null&&(!Number.isSafeInteger(available)||available<0||capacity!==null&&available>capacity))throw fail(400,'Revisa el cupo total y disponible.');
        if(sessionCost!==null&&sessionCost>cost)throw fail(400,'El precio por sesión no puede superar el precio regular.');
        if(link){try{if(!['https:','http:'].includes(new URL(link).protocol))throw Error();}catch{throw fail(400,'El enlace debe comenzar con https:// o http://.');}}
        if(old){const promos=db.prepare("SELECT * FROM promotions WHERE edition_id=? AND status='published' AND ends_at>?").all(old.id,Date.now());if(promos.some(p=>p.price_cents>=cost||starts!==null&&p.ends_at>starts)||promos.length&&currency!==old.currency)throw fail(400,'Ajusta o archiva primero las promociones publicadas que entran en conflicto con el precio, moneda o fecha nuevos.');}
        const row={id:old?.id||randomUUID(),brand_id:c.brand_id,course_id:c.id,name,starts_at:starts,ends_at:ends,timezone:zone,instructor:txt(input.instructor,120),modality:input.modality,location:txt(input.location,250),capacity,available_seats:available,info_url:link,price_cents:cost,session_price_cents:sessionCost,currency,status,legacy:0,revision:(old?.revision||0)+1,created_at:old?.created_at||Date.now(),updated_at:Date.now()};save(table,row,old);record(kind,row,user,old?'updated':'created');return row;
      }else if(type==='promotions'){
        const e=edition(old?.edition_id||input.editionId);crm.requireBrand(user,e.brand_id);const name=txt(input.name,120),cost=price(input.price),starts=date(input.startsAt),ends=date(input.endsAt),status=input.status||'draft';
        if(!name||starts===null||ends===null||ends<=starts||cost>=e.price_cents||!['draft','published','archived'].includes(status))throw fail(400,'La promoción necesita nombre, precio menor al regular y un período válido.');
        if(status==='published'){
          if(e.status!=='published'||ends<=Date.now()||e.starts_at!==null&&ends>e.starts_at)throw fail(400,'Publica la edición y elige una vigencia futura que termine antes de iniciar el curso.');
          const overlap=db.prepare("SELECT id FROM promotions WHERE edition_id=? AND id!=? AND status='published' AND starts_at<? AND ends_at>?").get(e.id,old?.id||'',ends,starts);if(overlap)throw fail(409,'Ya hay una promoción publicada que coincide en fechas para esta edición.');
        }
        const row={id:old?.id||randomUUID(),brand_id:e.brand_id,edition_id:e.id,name,price_cents:cost,starts_at:starts,ends_at:ends,status,revision:(old?.revision||0)+1,created_at:old?.created_at||Date.now(),updated_at:Date.now()};save(table,row,old);record(kind,row,user,old?'updated':'created');return row;
      }else if(type==='flyers'){
        const e=edition(input.editionId||old?.edition_id);crm.requireBrand(user,e.brand_id);const f=scoped('library_files',input.fileId||old?.file_id,user),promotionId=input.promotionId||null,p=promotionId?scoped('promotions',promotionId,user):null,title=txt(input.title,180),expires=date(input.expiresAt);
        if(f.brand_id!==e.brand_id||p&&p.edition_id!==e.id||old&&old.brand_id!==e.brand_id)throw fail(400,'La pieza, archivo y promoción deben pertenecer a la misma marca y edición.');
        if(!title||!channels.includes(input.channel||'all'))throw fail(400,'Indica un título y canal válidos.');
        const row={id:old?.id||randomUUID(),brand_id:e.brand_id,course_id:e.course_id,edition_id:e.id,promotion_id:promotionId,file_id:f.id,title,channel:input.channel||'all',expires_at:expires,status:'draft',binding:JSON.stringify(binding(e,p)),revision:(old?.revision||0)+1,approved_by:null,approved_at:null,created_at:old?.created_at||Date.now(),updated_at:Date.now()};save(table,row,old);record(kind,row,user,old?'updated':'created');return row;
      }else{
        const brandId=old?.brand_id||input.brandId;crm.requireBrand(user,brandId);const courseId=input.courseId||null,editionId=input.editionId||null,flyerId=input.flyerId||null,title=txt(input.title,180),bodyText=txt(input.text,3000);validateTemplate(bodyText);
        if(courseId&&course(courseId).brand_id!==brandId||editionId&&(edition(editionId).brand_id!==brandId||edition(editionId).course_id!==courseId))throw fail(400,'La edición y curso deben pertenecer a la marca elegida.');
        if(flyerId){const f=scoped('flyers',flyerId,user);if(f.brand_id!==brandId||f.edition_id!==editionId)throw fail(400,'Para adjuntar un flyer, selecciona su curso y edición.');}
        if(!title||!scenarios.includes(input.scenario)||!channels.includes(input.channel||'all'))throw fail(400,'Revisa el título, escenario y canal.');
        const row={id:old?.id||randomUUID(),brand_id:brandId,course_id:courseId,edition_id:editionId,flyer_id:flyerId,title,scenario:input.scenario,channel:input.channel||'all',body:bodyText,status:'draft',revision:(old?.revision||0)+1,approved_by:null,approved_at:null,created_at:old?.created_at||Date.now(),updated_at:Date.now()};save(table,row,old);record(kind,row,user,old?'updated':'created');return row;
      }
      const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);record(kind,row,user,action);return row;
    });changed(saved.brand_id);json(res,id?200:201,{item:saved});return true;
  }
  function save(table,row,old){const keys=Object.keys(row);if(old)db.prepare(`UPDATE ${table} SET ${keys.filter(k=>k!=='id').map(k=>k+'=?').join(',')} WHERE id=?`).run(...keys.filter(k=>k!=='id').map(k=>row[k]),row.id);else db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));}
  let contentGate=null;
  return {handle,info,prepare,serveFile,flyerState,legacyUpdated,editionState,setContentGate:fn=>{contentGate=fn;}};
}
