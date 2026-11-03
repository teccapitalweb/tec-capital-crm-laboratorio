import {createHmac,timingSafeEqual} from 'node:crypto';
import {EVENT_TYPES} from './events.mjs';

// Núcleo compartido (Fase 2 · bloque 2.7, ruta 1): el CRM sigue en SQLite y envía cada hecho de negocio al núcleo en
// Postgres/Supabase mediante un sobre firmado (HMAC) con el evento y una proyección de los registros implicados en la
// forma del esquema del núcleo (nucleo/esquema-v1.sql). El transporte es el mismo índice de eventos de dominio (2.1):
// el suscriptor `core.outbox` recibe todos los tipos, con reintento, espera creciente y fallo permanente ante 4xx; la
// reproducción crea entregas para el historial previo. Sin CORE_SINK_URL el destino es simulado: no sale nada del
// servidor y los últimos sobres quedan en memoria para verlos en Operación → Conectores. Contrato: docs/NUCLEO.md.
const fail=(status,message)=>Object.assign(new Error(message),{status});
export const CORE_VERSION='1';
export const SUBSCRIBER='core.outbox';
export const UPSERT_ORDER=['consultoras','personas','cursos','ediciones','sesiones','pagos','inscripciones','certificados'];
export function signCore(secret,timestamp,raw){return createHmac('sha256',String(secret)).update(String(timestamp)+'.'+raw).digest('hex');}
// Verificación del lado receptor (la misma que debe implementar el servicio del núcleo): firma válida y marca de tiempo reciente.
export function verifyCore(secret,headers,raw,{now=Date.now,toleranceMs=5*60000}={}){
  const ts=String(headers['x-nucleo-timestamp']||''),sig=String(headers['x-nucleo-signature']||'');
  if(!secret||!/^\d{10,16}$/.test(ts)||Math.abs(now()-Number(ts))>toleranceMs)return false;
  const a=Buffer.from(sig,'utf8'),b=Buffer.from(signCore(secret,ts,raw),'utf8');return a.length===b.length&&timingSafeEqual(a,b);
}
const maskUrl=u=>{try{const x=new URL(u);return x.host+(x.pathname==='/'?'':x.pathname);}catch{return 'URL no válida';}};

export function createCore({db,crm,events,body,json,audit,now=Date.now,env=process.env,fetchImpl=globalThis.fetch,log=console}){
  const sink=()=>({url:String(env.CORE_SINK_URL||'').trim(),secret:String(env.CORE_SINK_SECRET||'')});
  const mode=()=>sink().url?'http':'simulated';
  const origin=()=>(env.APP_ORIGIN||'').replace(/\/$/,'');
  const recent=[];const remember=x=>{recent.unshift(x);if(recent.length>50)recent.length=50;};
  const ms=t=>t===null||t===undefined?null:new Date(t).toISOString();

  // ---- proyección: registros del CRM en la forma del núcleo (ids del origen; el receptor resuelve sus uuid por origen+origen_id)
  const consultora=id=>{const b=db.prepare('SELECT * FROM brands WHERE id=?').get(id);return b?{origen:'crm',origen_id:b.id,clave:b.id,nombre:b.name}:null;};
  const personaRef=contactId=>{const c=db.prepare('SELECT id,persona_id FROM contacts WHERE id=?').get(contactId);return c?(c.persona_id||'contacto:'+c.id):null;};
  function personaFromPerson(p){
    if(!p)return null;const ids=db.prepare("SELECT kind,value FROM person_identities WHERE person_id=? AND kind IN ('phone','email')").all(p.id);
    return {origen:'crm',origen_id:p.id,nombre:p.name,telefono:p.phone||null,correo:p.email||null,consentimiento:p.consent_status||'unknown',identidades:ids.map(i=>({tipo:i.kind==='phone'?'telefono':'correo',valor:i.value})),contactos:db.prepare('SELECT id,brand_id FROM contacts WHERE persona_id=?').all(p.id).map(c=>({consultora:c.brand_id,contacto_id:c.id}))};
  }
  function personaFromContact(contactId){
    const c=db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);if(!c)return null;
    if(c.persona_id){const p=db.prepare('SELECT * FROM persons WHERE id=?').get(c.persona_id);if(p)return personaFromPerson(p);}
    return {origen:'crm',origen_id:'contacto:'+c.id,nombre:c.name,telefono:c.phone||null,correo:c.email||null,consentimiento:'unknown',identidades:[],contactos:[{consultora:c.brand_id,contacto_id:c.id}]};
  }
  const curso=id=>{const c=db.prepare('SELECT * FROM courses WHERE id=?').get(id);return c?{origen:'crm',origen_id:c.id,consultora:c.brand_id,titulo:c.title,activo:Boolean(c.active)}:null;};
  const edicion=id=>{const e=db.prepare('SELECT * FROM editions WHERE id=?').get(id);return e?{origen:'crm',origen_id:e.id,curso:e.course_id,consultora:e.brand_id,nombre:e.name,inicia_en:ms(e.starts_at),termina_en:ms(e.ends_at),zona_horaria:e.timezone,modalidad:e.modality,precio_centavos:e.price_cents,precio_sesion_centavos:e.session_price_cents??null,moneda:e.currency,estado_catalogo:e.status,estado_apertura:e.run_status,minimo_alumnos:e.min_students}:null;};
  const sesion=id=>{const s=db.prepare('SELECT * FROM edition_sessions WHERE id=?').get(id);return s?{origen:'crm',origen_id:s.id,edicion:s.edition_id,numero:s.number,titulo:s.title,inicia_en:ms(s.starts_at),duracion_min:s.duration_min,estado:s.status,enlace:s.meet_url||null}:null;};
  const pagoRow=id=>db.prepare('SELECT o.*,op.owner_id FROM orders o LEFT JOIN opportunities op ON op.id=o.opportunity_id WHERE o.id=?').get(id);
  const pago=o=>o?{origen:'crm',origen_id:o.id,referencia:o.reference,consultora:o.brand_id,persona:personaRef(o.contact_id),curso:o.course_id,edicion:o.edition_id,sesion:o.session_id||null,tipo:o.kind||'course',plan:o.plan||'full',importe_centavos:o.amount_cents,moneda:o.currency,metodo:o.method||null,estado:o.status,proveedor_ref:o.provider_ref||null,vendedor_ref:o.owner_id||o.created_by||null,creado_en:ms(o.created_at),pagado_en:ms(o.paid_at)}:null;
  const inscripcionRow=id=>db.prepare('SELECT * FROM enrollments WHERE id=?').get(id);
  const inscripcion=en=>en?{origen:'crm',origen_id:en.id,persona:personaRef(en.contact_id),consultora:en.brand_id,curso:en.course_id,edicion:en.edition_id,pago:en.order_id,estado:en.status,plan:en.payment_plan||'full',creada_en:ms(en.created_at),cancelada_en:ms(en.cancelled_at),motivo_baja:en.cancel_reason||null}:null;
  const certificadoRow=id=>db.prepare('SELECT * FROM certificates WHERE id=?').get(id);
  const certificado=c=>c?{origen:'crm',origen_id:c.id,folio:c.folio,inscripcion:c.enrollment_id,persona:c.person_id||personaRef(c.contact_id),consultora:c.brand_id,curso:c.course_id,edicion:c.edition_id,titular:c.holder_name,estado:c.status,asistencia_pct:c.attendance_pct,horas:c.hours??null,emitido_en:ms(c.issued_at),revocado_en:ms(c.revoked_at),verificacion_url:origin()?origin()+'/verificar/'+c.folio:null}:null;

  // Qué registros acompañan a cada evento (siempre la consultora; después, lo que la entidad implica).
  function project(ev){
    const r={consultoras:[],personas:[],cursos:[],ediciones:[],sesiones:[],pagos:[],inscripciones:[],certificados:[]};
    const add=(k,v)=>{if(v&&!r[k].some(x=>x.origen_id===v.origen_id))r[k].push(v);};
    add('consultoras',consultora(ev.brand_id));const p=ev.payload||{};
    const withEdition=id=>{const e=edicion(id);if(e){add('cursos',curso(e.curso));add('ediciones',e);}};
    const withOrder=o=>{if(!o)return;add('personas',personaFromContact(o.contact_id));withEdition(o.edition_id);if(o.session_id)add('sesiones',sesion(o.session_id));add('pagos',pago(o));};
    const withEnrollment=en=>{if(!en)return;add('personas',personaFromContact(en.contact_id));withEdition(en.edition_id);const o=pagoRow(en.order_id);if(o)add('pagos',pago(o));add('inscripciones',inscripcion(en));};
    switch(ev.entity_kind){
      case 'order':{const o=pagoRow(ev.entity_id);withOrder(o);if(p.enrollmentId)withEnrollment(inscripcionRow(p.enrollmentId));break;}
      case 'enrollment':withEnrollment(inscripcionRow(ev.entity_id));break;
      case 'certificate':{const c=certificadoRow(ev.entity_id);if(c){withEnrollment(inscripcionRow(c.enrollment_id));add('certificados',certificado(c));}break;}
      case 'edition':withEdition(ev.entity_id);break;
      case 'session':{const s=sesion(ev.entity_id);if(s){withEdition(s.edicion);add('sesiones',s);}break;}
      case 'person':add('personas',personaFromPerson(db.prepare('SELECT * FROM persons WHERE id=?').get(ev.entity_id)));break;
      case 'contact':add('personas',personaFromContact(ev.entity_id));break;
      case 'opportunity':{const op=db.prepare('SELECT contact_id,course_id FROM opportunities WHERE id=?').get(ev.entity_id);if(op){add('personas',personaFromContact(op.contact_id));add('cursos',curso(op.course_id));}break;}
      case 'conversation':{if(p.courseId)add('cursos',curso(p.courseId));if(p.editionId)withEdition(p.editionId);break;}
      case 'resource':if(p.editionId)withEdition(p.editionId);break;
      default:break;   // message, payout, survey: sólo el hecho y la consultora (nunca texto de mensajes, comentarios ni adjuntos)
    }
    return r;
  }
  const envelope=ev=>({version:CORE_VERSION,id:ev.id,origen:'crm',origen_seq:ev.seq,tipo:ev.type,consultora:ev.brand_id,entidad:{tipo:ev.entity_kind,id:ev.entity_id},ocurrido_en:ms(ev.created_at),fuente:ev.source,actor_ref:ev.actor_id||null,carga:ev.payload||{},registros:project(ev),enviado_en:ms(now())});

  // ---- envío (fuera de transacción: lo llama el reloj de eventos). 4xx = fallo permanente salvo 408/429; 5xx y red = reintento.
  async function post(payload){
    const {url,secret}=sink(),raw=JSON.stringify(payload),ts=String(now()),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const r=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json','X-Nucleo-Version':CORE_VERSION,'X-Nucleo-Timestamp':ts,'X-Nucleo-Signature':secret?signCore(secret,ts,raw):'','X-Nucleo-Event':String(payload.id||'')},body:raw,signal:controller.signal});
      if(!r.ok){const e=new Error('El núcleo respondió HTTP '+r.status);if(r.status>=400&&r.status<500&&![408,429].includes(r.status))e.status=r.status;throw e;}
      return r.status;
    }catch(e){if(e?.name==='AbortError')throw new Error('El núcleo no respondió en 10 s.');throw e;}
    finally{clearTimeout(timer);}
  }
  async function deliver(ev){
    const sobre=envelope(ev);
    if(mode()==='simulated'){remember({modo:'simulado',id:sobre.id,seq:sobre.origen_seq,tipo:sobre.tipo,consultora:sobre.consultora,ocurrido_en:sobre.ocurrido_en,enviado_en:sobre.enviado_en,registros:Object.fromEntries(Object.entries(sobre.registros).map(([k,v])=>[k,v.length])),sobre});return;}
    const status=await post(sobre);
    remember({modo:'http',id:sobre.id,seq:sobre.origen_seq,tipo:sobre.tipo,consultora:sobre.consultora,ocurrido_en:sobre.ocurrido_en,enviado_en:sobre.enviado_en,registros:Object.fromEntries(Object.entries(sobre.registros).map(([k,v])=>[k,v.length])),estado:status});
  }
  for(const type of Object.keys(EVENT_TYPES))events.subscribe(type,SUBSCRIBER,deliver);

  // ---- administración
  const requireAdmin=user=>{const u=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);if(!u||u.disabled||u.role!=='admin')throw fail(403,'El núcleo compartido lo administra administración.');};
  function status(){
    const {url,secret}=sink();
    return {version:CORE_VERSION,subscriber:SUBSCRIBER,mode:mode(),sinkHost:url?maskUrl(url):null,secretSet:Boolean(secret),schema:'nucleo/esquema-v1.sql',contract:'docs/NUCLEO.md',upsertOrder:UPSERT_ORDER,stats:events.subscriberStats(SUBSCRIBER),recent:recent.map(({sobre,...x})=>x),types:Object.keys(EVENT_TYPES).length};
  }
  async function ping(user){
    requireAdmin(user);if(mode()!=='http')throw fail(409,'Define CORE_SINK_URL (y CORE_SINK_SECRET) en el entorno para probar el envío real.');
    const sobre={version:CORE_VERSION,id:'ping-'+now(),origen:'crm',origen_seq:0,tipo:'nucleo.ping',consultora:null,entidad:{tipo:'nucleo',id:'ping'},ocurrido_en:ms(now()),fuente:'core.ping',actor_ref:user.id,carga:{},registros:{},enviado_en:ms(now())};
    try{const st=await post(sobre);audit(user,'core.ping','ok:'+st);return {ok:true,status:st};}
    catch(e){audit(user,'core.ping','error');return {ok:false,error:String(e.message||e).slice(0,200)};}
  }
  async function handle(req,res,path,user){
    if(!path.startsWith('/api/core'))return false;requireAdmin(user);
    if(path==='/api/core'&&req.method==='GET'){json(res,200,status());return true;}
    if(path==='/api/core/recent'&&req.method==='GET'){json(res,200,{recent:recent.slice(0,20)});return true;}
    if(path==='/api/core/replay'&&req.method==='POST'){const input=await body(req),n=events.replay(SUBSCRIBER,{fromSeq:input.fromSeq,actor:user});json(res,200,{queued:n,stats:events.subscriberStats(SUBSCRIBER)});return true;}
    if(path==='/api/core/retry'&&req.method==='POST'){const n=events.retryFailed(SUBSCRIBER,user);json(res,200,{queued:n,stats:events.subscriberStats(SUBSCRIBER)});return true;}
    if(path==='/api/core/ping'&&req.method==='POST'){json(res,200,await ping(user));return true;}
    throw fail(404,'Ruta del núcleo no encontrada.');
  }
  return {handle,status,envelope,project,deliver,mode};
}
