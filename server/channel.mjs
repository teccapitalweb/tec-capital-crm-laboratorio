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

export function createChannel({db,crm,body,json,audit,broadcast,accessConversation,now=Date.now}){
  const defaults=b=>({brand_id:b,enabled:0,enforce_window:1,delivery_delay_ms:1500,failure_rate:0,revision:0,updated_by:null,updated_at:null});
  const settings=b=>db.prepare('SELECT * FROM channel_settings WHERE brand_id=?').get(b)||defaults(b);
  let connectorOf=null;const useConnector=fn=>{connectorOf=fn;};   // lo fija connectors.mjs; sin él se simula aquí mismo
  const requireAdmin=user=>{const u=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);if(!u||u.disabled||u.role!=='admin')throw fail(403,'El canal simulado lo configura un administrador.');};

  // Ventana de servicio: 24 h desde el último mensaje del cliente; si llegó por anuncio, además 72 h desde su primer mensaje.
  function windowOf(c,{lastCustomerAt,firstCustomerAt}={},cache=null){
    if(lastCustomerAt===undefined){const r=db.prepare("SELECT MIN(created_at) f,MAX(created_at) l FROM messages WHERE conversation_id=? AND sender_kind='customer'").get(c.id);lastCustomerAt=r.l;firstCustomerAt=r.f;}
    const referral=typeof c.referral==='string'?parseReferral(c.referral):c.referral||null;
    const byCustomer=lastCustomerAt?lastCustomerAt+DAY:0,byReferral=referral&&firstCustomerAt?firstCustomerAt+FREE_ENTRY:0,until=Math.max(byCustomer,byReferral)||null;
    const s=cache?.get(c.brand_id)||settings(c.brand_id);if(cache)cache.set(c.brand_id,s);
    return {enabled:Boolean(s.enabled),enforced:Boolean(s.enabled&&s.enforce_window),until,open:until!==null&&until>now(),source:until?(byReferral>=byCustomer?'referral':'customer'):null};
  }
  const decorate=rows=>{const cache=new Map();return rows.map(c=>({...c,referral:parseReferral(c.referral),window:windowOf(c,{lastCustomerAt:c.last_customer_at,firstCustomerAt:c.first_customer_at},cache)}));};
  const categoryOf=(kind,prepared,flyer)=>kind==='customer'||kind==='system'?null:(prepared?.flyerSnapshot||flyer)?'marketing':prepared?'utility':'service';

  // Antes de insertar un mensaje saliente. Devuelve lo que debe guardarse; lanza 409 si la ventana está cerrada y el mensaje es libre.
  function before(c,kind,{category,buttons}){
    const s=settings(c.brand_id);
    if(!s.enabled||!category)return {category,buttons:null};
    if(s.enforce_window&&category==='service'&&!windowOf(c).open)throw fail(409,'La ventana de servicio de 24 h está cerrada en el canal simulado: envía una plantilla aprobada (temario, precio, fechas o flyer) o espera a que el cliente escriba.');
    const list=Array.isArray(buttons)?buttons.map(b=>text(b,20)).filter(Boolean).slice(0,3):[];
    return {category,buttons:list.length?JSON.stringify(list):null};
  }
  const event=(m,state,reason,actor,t)=>db.prepare('INSERT INTO channel_events(message_id,conversation_id,brand_id,state,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)').run(m.id,m.conversation_id,m.brand_id,state,reason||null,actor||null,t);

  // Entrega simulada: pasado el retraso de la marca, cada mensaje saliente queda entregado o, según la tasa configurada, fallido.
  // Entrega: pasado el retraso de la marca, cada saliente se manda al conector (fuera de transacción); el resultado
  // (entregado o fallido, con referencia del proveedor) se aplica después en una sola transacción.
  async function tick(){
    const t=now();
    const rows=db.prepare("SELECT m.id,m.conversation_id,c.brand_id,c.channel,m.category,s.failure_rate FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN channel_settings s ON s.brand_id=c.brand_id WHERE s.enabled=1 AND m.delivery_state='sent' AND m.sender_kind IN ('agent','automation') AND m.created_at<=?-s.delivery_delay_ms ORDER BY m.seq LIMIT 100").all(t);
    if(!rows.length)return [];
    const connector=connectorOf?connectorOf():null;
    const results=await Promise.all(rows.map(async m=>{try{return {m,r:connector?await connector.send({id:m.id,conversationId:m.conversation_id,brandId:m.brand_id,channel:m.channel,category:m.category,failureRate:m.failure_rate}):simulate(m)};}catch(e){return {m,r:{providerRef:null,state:'failed',reason:String(e?.message||e).slice(0,160)}};}}));
    const touched=new Set(),at=now();
    transaction(db,()=>{for(const {m,r} of results){const state=r.state==='failed'?'failed':'delivered';if(!db.prepare("UPDATE messages SET delivery_state=?,delivered_at=?,failed_reason=?,provider_ref=COALESCE(?,provider_ref) WHERE id=? AND delivery_state='sent'").run(state,state==='delivered'?at:null,r.reason||null,r.providerRef||null,m.id).changes)continue;event(m,state,r.reason||null,null,at);touched.add(m.conversation_id);}});
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
    event(m,state,reason||null,null,now());broadcast('conversation',m.conversation_id);return state;
  }
  // Lectura del cliente: los salientes hasta ese punto pasan a «leído» (si ya estaban entregados o enviados).
  function markRead(conversationId,upTo){db.prepare("UPDATE messages SET delivery_state='read' WHERE conversation_id=? AND seq<=? AND sender_kind IN ('agent','automation') AND delivery_state IN ('sent','delivered')").run(conversationId,upTo);}

  function retry(messageId,user){
    const m=db.prepare('SELECT m.*,c.brand_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?').get(messageId);
    if(!m)throw fail(404,'Mensaje no disponible.');const c=accessConversation(m.conversation_id,user);crm.requireBrand(user,c.brand_id);
    if(m.delivery_state!=='failed')throw fail(409,'Sólo se reintenta un mensaje que falló.');
    const t=now();transaction(db,()=>{db.prepare("UPDATE messages SET delivery_state='sent',failed_reason=NULL,delivered_at=NULL WHERE id=? AND delivery_state='failed'").run(m.id);event(m,'retry',null,user.id,t);});
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
  return {settings,windowOf,decorate,categoryOf,before,tick,markRead,retry,events,setSettings,referralInput,handle,useConnector,applyStatus};
}
