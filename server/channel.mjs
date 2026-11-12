import {transaction} from './database.mjs';

// Canal simulado realista (Fase 1 · bloque 3). Imita lo que un proveedor oficial haría con los mensajes salientes, sin
// conectar nada: estados enviado → entregado → leído (o fallido, con reintento), ventana de servicio de 24 h (72 h si el
// cliente llegó por anuncio) fuera de la cual sólo pasan plantillas, categoría por mensaje, botones de respuesta rápida y
// llegada por anuncio. Todo por marca y APAGADO por omisión: con el canal apagado el comportamiento es el de siempre.
// Las comprobaciones corren dentro de la transacción del llamador (sin red); el tick de entrega es periódico.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const DAY=24*3600000,FREE_ENTRY=72*3600000;
export const FAILURES=['El número no está disponible en el canal simulado','El proveedor simulado rechazó el mensaje por límite de velocidad','Tiempo de espera agotado en el proveedor simulado'];
export const CATEGORIES={service:'Servicio (dentro de la ventana)',utility:'Plantilla de utilidad',marketing:'Plantilla de marketing'};
const parseReferral=v=>{if(!v)return null;try{const r=JSON.parse(v);return r&&typeof r==='object'?r:null;}catch{return null;}};

export function createChannel({db,crm,body,json,audit,broadcast,accessConversation,domainEvents=null,now=Date.now}){
  const defaults=b=>({brand_id:b,enabled:0,enforce_window:1,delivery_delay_ms:1500,failure_rate:0,revision:0,updated_by:null,updated_at:null});
  const settings=b=>db.prepare('SELECT * FROM channel_settings WHERE brand_id=?').get(b)||defaults(b);
  let connectorOf=null;const useConnector=fn=>{connectorOf=fn;};   // lo fija connectors.mjs; sin él se simula aquí mismo
  let outboundOf=null;const useOutbound=fn=>{outboundOf=fn;};   // lo fija whatsapp.mjs: arma lo que viaja a un número real (texto, botones, archivo)
  const WA_CLOSED='Pasaron más de 24 horas desde el último mensaje de esta persona: WhatsApp sólo deja enviarle una plantilla aprobada (botón «Enviar plantilla») hasta que vuelva a escribir.';
  const HOLD_MS=Math.max(1,Number(process.env.WA_HOLD_DAYS)||7)*DAY,SWEEP_MS=Math.max(200,Number(process.env.WA_HOLD_SWEEP_MS)||60000);let sweptAt=0;
  const requireAdmin=user=>{const u=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);if(!u||u.disabled||u.role!=='admin')throw fail(403,'El canal simulado lo configura un administrador.');};

  // Ventana de servicio: 24 h desde el último mensaje del cliente; si llegó por anuncio, además 72 h desde su primer mensaje.
  function windowOf(c,{lastCustomerAt,firstCustomerAt}={},cache=null){
    if(lastCustomerAt===undefined){const r=db.prepare("SELECT MIN(created_at) f,MAX(created_at) l FROM messages WHERE conversation_id=? AND sender_kind='customer'").get(c.id);lastCustomerAt=r.l;firstCustomerAt=r.f;}
    const referral=typeof c.referral==='string'?parseReferral(c.referral):c.referral||null;
    const real=Boolean(c.wa_number),byCustomer=lastCustomerAt?lastCustomerAt+DAY:0,byReferral=!real&&referral&&firstCustomerAt?firstCustomerAt+FREE_ENTRY:0,until=Math.max(byCustomer,byReferral)||null;
    const s=cache?.get(c.brand_id)||settings(c.brand_id);if(cache)cache.set(c.brand_id,s);
    return {enabled:real||Boolean(s.enabled),enforced:real||Boolean(s.enabled&&s.enforce_window),real,until,open:until!==null&&until>now(),source:until?(byReferral>=byCustomer?'referral':'customer'):null};
  }
  const decorate=rows=>{const cache=new Map();return rows.map(c=>({...c,referral:parseReferral(c.referral),window:windowOf(c,{lastCustomerAt:c.last_customer_at,firstCustomerAt:c.first_customer_at},cache)}));};
  const categoryOf=(kind,prepared,flyer)=>kind==='customer'||kind==='system'?null:(prepared?.flyerSnapshot||flyer)?'marketing':prepared?'utility':'service';

  // Antes de insertar un mensaje saliente. Devuelve lo que debe guardarse; lanza 409 si la ventana está cerrada y el mensaje es libre.
  function before(c,kind,{category,buttons,template}){
    const s=settings(c.brand_id),real=Boolean(c.wa_number);
    // Conversación real de WhatsApp: la regla de 24 h es de Meta y no depende del canal simulado de la marca. Con la ventana cerrada se rechaza
    // aquí lo que escribe una persona del equipo y los textos libres. Los avisos del negocio (confirmación de pago, certificado, recordatorio,
    // campaña) SÍ se guardan —un pago nunca debe fallar por esto— y quedan «no entregados» con el motivo al intentar salir (ver tick).
    if(real&&category&&!template&&(kind==='agent'||category==='service')&&!windowOf(c).open)throw fail(409,WA_CLOSED);
    if((!s.enabled&&!real)||!category)return {category,buttons:null};
    if(!real&&s.enforce_window&&category==='service'&&!windowOf(c).open)throw fail(409,'La ventana de servicio de 24 h está cerrada en el canal simulado: envía una plantilla aprobada (temario, precio, fechas o flyer) o espera a que el cliente escriba.');
    const list=Array.isArray(buttons)?buttons.map(b=>text(b,20)).filter(Boolean).slice(0,3):[];
    return {category,buttons:list.length?JSON.stringify(list):null};
  }
  const event=(m,state,reason,actor,t)=>db.prepare('INSERT INTO channel_events(message_id,conversation_id,brand_id,state,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)').run(m.id,m.conversation_id,m.brand_id,state,reason||null,actor||null,t);
  // Índice común: sólo entregado y fallido (los estados intermedios quedan en channel_events).
  const emit=(m,state,reason,providerRef)=>{if(!domainEvents||!['delivered','failed'].includes(state))return;domainEvents.publish({type:state==='failed'?'mensaje.fallido':'mensaje.entregado',brandId:m.brand_id,entityKind:'message',entityId:m.id,payload:{conversationId:m.conversation_id,category:m.category||null,reason:reason||undefined,providerRef:providerRef||undefined},source:'channel',dedupeKey:(state==='failed'?'mensaje.fallido':'mensaje.entregado')+':'+m.id+':'+(providerRef||'')});};

  // Entrega: cada saliente se manda a su conector fuera de transacción y el resultado se aplica después en una sola transacción.
  //  · Laboratorio (canal simulado encendido en la marca): pasado el retraso, queda entregado o fallido según la tasa configurada.
  //  · Conversación REAL (wa_number): sale por Meta sin esperar ni depender del canal simulado. Meta devuelve su referencia y el mensaje
  //    sigue «enviado» hasta que el webhook diga entregado o leído; provider_ref IS NULL es lo que marca «todavía no ha salido».
  // Un mensaje o una conversación real en vuelo no se vuelve a tomar: así no hay envíos dobles ni mensajes fuera de orden.
  const flying=new Set(),busy=new Set();
  async function tick(){
    const t=now();
    // Un mensaje en espera que nadie liberó en WA_HOLD_DAYS (7) días ya no tiene sentido: queda como no entregado.
    if(t-sweptAt>SWEEP_MS){sweptAt=t;db.prepare("UPDATE messages SET delivery_state='failed',failed_reason='No se entregó: la persona no respondió al aviso y el mensaje caducó.',wa_hold=NULL WHERE wa_hold IS NOT NULL AND provider_ref IS NULL AND delivery_state='sent' AND created_at<?").run(t-HOLD_MS);}
    const rows=db.prepare("SELECT m.id,m.conversation_id,c.brand_id,c.channel,m.category,COALESCE(s.failure_rate,0) failure_rate,c.wa_number,c.wa_peer FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN channel_settings s ON s.brand_id=c.brand_id WHERE m.delivery_state='sent' AND m.sender_kind IN ('agent','automation') AND ((c.wa_number IS NOT NULL AND m.provider_ref IS NULL AND (m.wa_hold IS NULL OR EXISTS(SELECT 1 FROM messages x WHERE x.conversation_id=m.conversation_id AND x.sender_kind='customer' AND x.created_at>m.wa_hold))) OR (c.wa_number IS NULL AND s.enabled=1 AND m.created_at<=?-s.delivery_delay_ms)) ORDER BY m.seq LIMIT 100").all(t).filter(m=>!flying.has(m.id)&&!(m.wa_number&&busy.has(m.conversation_id)));
    if(!rows.length)return [];
    const one=async m=>{
      try{
        if(!m.wa_number){const connector=connectorOf?connectorOf(null):null;return {m,r:connector?await connector.send({id:m.id,conversationId:m.conversation_id,brandId:m.brand_id,channel:m.channel,category:m.category,failureRate:m.failure_rate}):simulate(m)};}
        if(!connectorOf||!outboundOf)throw fail(503,'WhatsApp real no está disponible en este servidor.');
        // Ventana cerrada: whatsapp.mjs decide. Una plantilla sale; un aviso del negocio queda EN ESPERA (se manda la plantilla de aviso de la marca
        // y el mensaje sale cuando la persona responda); sin plantilla de aviso, falla con el motivo. Nunca se le pide a Meta lo que va a rechazar.
        const out=await outboundOf(m,{closed:!windowOf({id:m.conversation_id,brand_id:m.brand_id,wa_number:m.wa_number}).open});
        if(out.hold){db.prepare("UPDATE messages SET wa_hold=? WHERE id=? AND delivery_state='sent' AND provider_ref IS NULL").run(now(),m.id);return {m,r:{state:'held',reason:null}};}
        const r=await connectorOf(out).send(out);
        // la referencia de Meta se guarda en cuanto llega: su aviso de «entregado» puede venir antes de que termine el resto del lote
        if(r.state!=='failed'&&r.providerRef)db.prepare("UPDATE messages SET provider_ref=?,wa_hold=NULL WHERE id=? AND delivery_state='sent' AND provider_ref IS NULL").run(r.providerRef,m.id);
        return {m,r};
      }catch(e){return {m,r:{providerRef:null,state:'failed',reason:String(e?.message||e).slice(0,200)}};}
    };
    const lab=rows.filter(m=>!m.wa_number),real=new Map();for(const m of rows)if(m.wa_number){if(!real.has(m.conversation_id))real.set(m.conversation_id,[]);real.get(m.conversation_id).push(m);}
    for(const m of rows)flying.add(m.id);for(const id of real.keys())busy.add(id);
    let results=[];
    try{results=(await Promise.all([...lab.map(one),...[...real.values()].map(async list=>{const done=[];for(const m of list)done.push(await one(m));return done;})])).flat();}
    finally{for(const m of rows)flying.delete(m.id);for(const id of real.keys())busy.delete(id);}
    const touched=new Set(),at=now();
    transaction(db,()=>{for(const {m,r} of results){
      if(m.wa_number){
        if(r.state==='held'){event(m,'held',null,null,at);touched.add(m.conversation_id);continue;}
        if(r.state==='failed'){if(!db.prepare("UPDATE messages SET delivery_state='failed',failed_reason=?,wa_hold=NULL WHERE id=? AND delivery_state='sent' AND provider_ref IS NULL").run(r.reason||'Meta no aceptó el mensaje',m.id).changes)continue;event(m,'failed',r.reason||null,null,at);emit(m,'failed',r.reason,null);}
        else{db.prepare('UPDATE messages SET failed_reason=NULL WHERE id=? AND provider_ref=?').run(m.id,r.providerRef);event(m,'sent',r.reason||null,null,at);}   // una nota de envío parcial queda en el historial de entrega
        touched.add(m.conversation_id);continue;
      }
      const state=r.state==='failed'?'failed':'delivered';if(!db.prepare("UPDATE messages SET delivery_state=?,delivered_at=?,failed_reason=?,provider_ref=COALESCE(?,provider_ref) WHERE id=? AND delivery_state='sent'").run(state,state==='delivered'?at:null,r.reason||null,r.providerRef||null,m.id).changes)continue;event(m,state,r.reason||null,null,at);emit(m,state,r.reason,r.providerRef);touched.add(m.conversation_id);}});
    for(const id of touched)broadcast('conversation',id);
    return [...touched];
  }
  const simulate=m=>{const failed=Math.random()*100<m.failure_rate;return {providerRef:'simch_'+Math.random().toString(16).slice(2,14),state:failed?'failed':'delivered',reason:failed?FAILURES[Math.floor(Math.random()*FAILURES.length)]:null};};
  // Estado reportado por el proveedor (webhook ya verificado): se localiza el mensaje por su referencia y se avanza sin retroceder.
  function applyStatus({providerRef,state,reason=null,at=null}){
    const m=providerRef?db.prepare('SELECT m.id,m.conversation_id,m.delivery_state,c.brand_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.provider_ref=?').get(String(providerRef)):null;if(!m)return null;
    const order={sent:0,delivered:1,read:2,failed:3};if(order[state]===undefined)return null;
    const t=at&&Number.isFinite(Number(at))?Number(at):now();
    if(state==='failed')db.prepare("UPDATE messages SET delivery_state='failed',failed_reason=? WHERE id=?").run(reason||'Fallo reportado por el proveedor',m.id);
    else if(order[state]>order[m.delivery_state]||m.delivery_state==='failed')db.prepare("UPDATE messages SET delivery_state=?,delivered_at=COALESCE(delivered_at,?),failed_reason=NULL WHERE id=?").run(state,state==='sent'?null:t,m.id);
    else return m.delivery_state+' (sin cambio)';
    event(m,state,reason||null,null,now());emit(m,state,reason,providerRef);broadcast('conversation',m.conversation_id);return state;
  }
  // Lectura del cliente: los salientes hasta ese punto pasan a «leído» (si ya estaban entregados o enviados).
  function markRead(conversationId,upTo){db.prepare("UPDATE messages SET delivery_state='read' WHERE conversation_id=? AND seq<=? AND sender_kind IN ('agent','automation') AND delivery_state IN ('sent','delivered')").run(conversationId,upTo);}

  function retry(messageId,user){
    const m=db.prepare('SELECT m.*,c.brand_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?').get(messageId);
    if(!m)throw fail(404,'Mensaje no disponible.');const c=accessConversation(m.conversation_id,user);crm.requireBrand(user,c.brand_id);
    if(m.delivery_state!=='failed')throw fail(409,'Sólo se reintenta un mensaje que falló.');
    if(c.wa_number&&!m.wa_template&&!windowOf(c).open)throw fail(409,WA_CLOSED);
    const t=now();transaction(db,()=>{db.prepare("UPDATE messages SET delivery_state='sent',failed_reason=NULL,delivered_at=NULL,provider_ref=CASE WHEN ? THEN NULL ELSE provider_ref END WHERE id=? AND delivery_state='failed'").run(c.wa_number?1:0,m.id);event(m,'retry',null,user.id,t);});
    audit(user,'message.retry',m.id);broadcast('conversation',m.conversation_id);
    return db.prepare('SELECT id,delivery_state,failed_reason FROM messages WHERE id=?').get(m.id);
  }
  const events=messageId=>db.prepare('SELECT e.state,e.reason,e.created_at,u.name actor_name FROM channel_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.message_id=? ORDER BY e.seq').all(messageId);

  function setSettings(brandId,input,user){
    requireAdmin(user);if(!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no encontrada.');
    const current=settings(brandId);
    if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==current.revision)throw fail(409,'La configuración del canal cambió. Recárgala.');
    const delay=input.deliveryDelayMs===undefined?current.delivery_delay_ms:Number(input.deliveryDelayMs),rate=input.failureRate===undefined?current.failure_rate:Number(input.failureRate);
    if(!Number.isInteger(delay)||delay<0||delay>60000)throw fail(400,'El retraso de entrega va de 0 a 60 000 ms.');
    if(!Number.isInteger(rate)||rate<0||rate>100)throw fail(400,'La tasa de fallo va de 0 a 100 %.');
    const enabled=input.enabled===undefined?current.enabled:input.enabled?1:0,enforce=input.enforceWindow===undefined?current.enforce_window:input.enforceWindow?1:0,t=now();
    db.prepare('INSERT INTO channel_settings(brand_id,enabled,enforce_window,delivery_delay_ms,failure_rate,revision,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(brand_id) DO UPDATE SET enabled=excluded.enabled,enforce_window=excluded.enforce_window,delivery_delay_ms=excluded.delivery_delay_ms,failure_rate=excluded.failure_rate,revision=channel_settings.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(brandId,enabled,enforce,delay,rate,1,user.id,t);
    audit(user,'channel.settings',brandId);broadcast('crm',null,{brandId});
    return settings(brandId);
  }
  // Llegada por anuncio: datos que el cliente trae al abrir la conversación (sólo informativos; nada se conecta a Meta).
  function referralInput(input){
    const r=input?.referral;if(!r||typeof r!=='object')return null;const ad=text(r.ad,120);if(!ad)return null;
    return JSON.stringify({source:'ad',ad,campaign:text(r.campaign,120)||null,flyerId:text(r.flyerId,80)||null,headline:text(r.headline,200)||null,at:now()});
  }

  async function handle(req,res,path,user){
    let x;
    if(path==='/api/channel/settings'&&req.method==='GET'){if(user.role==='customer')throw fail(403,'Esta información es para el equipo de atención.');json(res,200,{settings:crm.brandsFor(user).map(b=>({...settings(b.id),brand_name:b.name})),categories:CATEGORIES});return true;}
    if((x=path.match(/^\/api\/channel\/brands\/([a-zA-Z0-9-]+)$/))&&req.method==='PATCH'){json(res,200,{settings:setSettings(x[1],await body(req),user)});return true;}
    if((x=path.match(/^\/api\/messages\/([a-f0-9-]+)\/retry$/))&&req.method==='POST'){if(user.role==='customer')throw fail(403,'Esta acción es para el equipo de atención.');json(res,200,{message:retry(x[1],user)});return true;}
    if((x=path.match(/^\/api\/messages\/([a-f0-9-]+)\/events$/))&&req.method==='GET'){const m=db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(x[1]);if(!m)throw fail(404,'Mensaje no disponible.');accessConversation(m.conversation_id,user);json(res,200,{events:events(x[1])});return true;}
    if((x=path.match(/^\/api\/ads\/([a-f0-9-]+)$/))&&req.method==='GET'){
      const f=db.prepare("SELECT f.*,k.title course_title,b.name brand_name FROM flyers f JOIN courses k ON k.id=f.course_id JOIN brands b ON b.id=f.brand_id WHERE f.id=? AND f.status='approved' AND (f.expires_at IS NULL OR f.expires_at>?)").get(x[1],now());
      if(!f)throw fail(404,'Este anuncio ya no está disponible.');
      json(res,200,{flyerId:f.id,courseId:f.course_id,editionId:f.edition_id,brandId:f.brand_id,ad:f.title,headline:f.brand_name+' · '+f.course_title});return true;
    }
    return false;
  }
  return {settings,windowOf,decorate,categoryOf,before,tick,markRead,retry,events,setSettings,referralInput,handle,useConnector,useOutbound,applyStatus};
}
