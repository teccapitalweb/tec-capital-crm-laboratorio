import {randomUUID,randomBytes} from 'node:crypto';
import {transaction} from './database.mjs';
import {cancelConversationSteps} from './automation.mjs';

// Venta con pago simulado (Fase 1 · bloque 4). Un pedido nace de una conversación (lo crea el equipo con «Cobrar» o el
// motor de respuestas al detectar una inscripción, si la marca lo tiene activo), con importe tomado del catálogo en ese
// momento, referencia y enlace de pago de prueba. El cliente «paga» con tarjeta u OXXO simulados (un evento de proveedor
// interno, el mismo punto por el que entraría un webhook real) o manda su comprobante de transferencia por el chat, que
// entra solo a una cola de validación humana. Confirmar un pago inscribe, descuenta cupo, cierra la oportunidad como
// ganada, avisa al equipo y lo dice al cliente. Nunca se cobra de verdad. Apagado por marca por omisión.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
export const STATUS={pending:'Pendiente de pago',review:'Comprobante en revisión',paid:'Pagado',cancelled:'Cancelado',expired:'Vencido'};
export const METHODS={card:'Tarjeta (simulada)',oxxo:'OXXO (simulado)',transfer:'Transferencia con comprobante'};
const money=(cents,currency)=>new Intl.NumberFormat('es-MX',{style:'currency',currency:currency||'MXN'}).format(cents/100);
const stamp=t=>new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Mexico_City'}).format(t);

export function createPayments({db,crm,catalogue,insertMessage,body,json,audit,broadcast,accessConversation,events=null,content=null,now=Date.now,env=process.env}){
  const defaults=b=>({brand_id:b,enabled:0,link_hours:48,revision:0,updated_by:null,updated_at:null});
  const settings=b=>db.prepare('SELECT * FROM payment_settings WHERE brand_id=?').get(b)||defaults(b);
  const requireAdmin=user=>{const u=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);if(!u||u.disabled||u.role!=='admin')throw fail(403,'La venta con pago la configura un administrador.');};
  const requireStaff=user=>{if(user.role==='customer')throw fail(403,'Esta acción es para el equipo de atención.');};
  const get=id=>db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const linkFor=o=>(env.APP_ORIGIN||'').replace(/\/$/,'')+'/?pay='+o.id;   // enlace propio y estable; si hay pasarela real, la página /?pay= lleva a su URL de cobro
  let connectorOf=null;const useConnector=fn=>{connectorOf=fn;};
  const event=(orderId,kind,details,actor,t)=>db.prepare('INSERT INTO payment_events(order_id,kind,details,actor_id,created_at) VALUES(?,?,?,?,?)').run(orderId,kind,JSON.stringify(details||{}),actor||null,t);
  // Evento de dominio (índice común): referencia al pedido, nunca copia del detalle; dentro de la transacción del llamador.
  const emit=(type,o,payload,actor,dedupeKey)=>events?.publish({type,brandId:o.brand_id,entityKind:'order',entityId:o.id,payload:{reference:o.reference,amountCents:o.amount_cents,currency:o.currency,conversationId:o.conversation_id,contactId:o.contact_id,courseId:o.course_id,editionId:o.edition_id,...payload},actorId:actor?.id||null,source:'payments',dedupeKey});
  const staffOf=brandId=>db.prepare("SELECT id FROM users WHERE role IN ('admin','agent') AND COALESCE(disabled,0)=0 AND (role='admin' OR id IN (SELECT user_id FROM brand_members WHERE brand_id=?))").all(brandId).map(u=>u.id);
  function notifyStaff(c,kind,title,key){const t=now();for(const id of staffOf(c.brand_id))db.prepare('INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),id,c.brand_id,c.id,kind,title,key,t);}
  const openOrder=cid=>db.prepare("SELECT * FROM orders WHERE conversation_id=? AND status IN ('pending','review') ORDER BY created_at DESC LIMIT 1").get(cid);
  const names=o=>({course:db.prepare('SELECT title FROM courses WHERE id=?').get(o.course_id)?.title||'curso',edition:db.prepare('SELECT name FROM editions WHERE id=?').get(o.edition_id)?.name||'',promotion:o.promotion_id?db.prepare('SELECT name FROM promotions WHERE id=?').get(o.promotion_id)?.name:null,contact:db.prepare('SELECT name FROM contacts WHERE id=?').get(o.contact_id)?.name||'Cliente'});
  const say=(c,textOut,ref,category='utility')=>insertMessage(c,null,textOut,'automation',ref,null,null,null,{category});

  // Texto del enlace de pago que recibe el cliente (lo envía el equipo o el motor de respuestas).
  function linkMessage(o){
    const n=names(o);
    const t=content?.render('payment_pending',o.brand_id,{courseId:o.course_id,editionId:o.edition_id,name:n.contact.split(' ')[0],extra:{pedido:o.reference,importe:money(o.amount_cents,o.currency),enlace_pago:linkFor(o),vigencia_pago:stamp(o.expires_at)}});if(t)return t.text;
    return `Pedido de práctica ${o.reference}: ${n.course} · ${n.edition} por ${money(o.amount_cents,o.currency)}${n.promotion?' ('+n.promotion+')':''}.\nPaga aquí (simulado): ${linkFor(o)}\nVigente hasta ${stamp(o.expires_at)}. También puedes enviar tu comprobante de transferencia por este chat y una persona lo valida.\nLaboratorio: no se realizan cobros reales.`;
  }
  // Crea el pedido dentro de la transacción del llamador. Si ya hay uno vigente en la conversación, lo devuelve.
  function createOrder(c,{user=null,source}){
    const s=settings(c.brand_id);if(!s.enabled)throw fail(409,'La venta con pago simulado está apagada para esta marca. Actívala en Operación → Pagos.');
    if(c.status==='resolved')throw fail(409,'La conversación está cerrada.');
    const existing=openOrder(c.id);if(existing)return {order:existing,created:false};
    const ctx=catalogue.info(c.course_id,c.edition_id);if(ctx.reason)throw fail(409,ctx.reason+'. Elige otra edición antes de cobrar.');
    const oppId=crm.syncConversation(c),opp=db.prepare('SELECT * FROM opportunities WHERE id=?').get(oppId);
    if(['ganada','perdida'].includes(opp.stage))throw fail(409,'La oportunidad ya está cerrada ('+opp.stage+'). Abre una nueva conversación para otra venta.');
    const t=now(),id=randomUUID();let reference;do{reference='TC-'+randomBytes(3).toString('hex').toUpperCase();}while(db.prepare('SELECT 1 FROM orders WHERE reference=?').get(reference));
    db.prepare('INSERT INTO orders(id,reference,brand_id,contact_id,opportunity_id,conversation_id,course_id,edition_id,promotion_id,amount_cents,currency,status,source,created_by,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,reference,c.brand_id,opp.contact_id,oppId,c.id,c.course_id,ctx.edition.id,ctx.promotion?.id||null,ctx.priceCents,ctx.currency,'pending',source,user?.id||null,t+s.link_hours*3600000,t,t);
    event(id,'created',{source,amountCents:ctx.priceCents,currency:ctx.currency,promotionId:ctx.promotion?.id||null,expiresAt:t+s.link_hours*3600000},user?.id||null,t);
    emit('pedido.creado',get(id),{source,promotionId:ctx.promotion?.id||null,expiresAt:t+s.link_hours*3600000},user);
    return {order:get(id),created:true};
  }
  // Confirmación de pago (proveedor simulado o persona). Dentro de la transacción del llamador.
  function confirm(o,{actor=null,method,providerRef=null,note=''}){
    const t=now(),c=db.prepare('SELECT * FROM conversations WHERE id=?').get(o.conversation_id),n=names(o);
    // Guarda de estado dentro de la transacción: dos confirmaciones concurrentes (o una tras cancelar) no pueden pasar las dos.
    if(!db.prepare("UPDATE orders SET status='paid',method=?,provider_ref=COALESCE(?,provider_ref),paid_at=?,confirmed_by=?,note=?,revision=revision+1,updated_at=? WHERE id=? AND status IN ('pending','review')").run(method,providerRef,t,actor?.id||null,text(note,500),t,o.id).changes)throw fail(409,'El pedido cambió de estado mientras se confirmaba. Recárgalo.');
    const enrollmentId=randomUUID();db.prepare('INSERT INTO enrollments(id,order_id,brand_id,contact_id,opportunity_id,course_id,edition_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(enrollmentId,o.id,o.brand_id,o.contact_id,o.opportunity_id,o.course_id,o.edition_id,'enrolled',t);
    db.prepare('UPDATE editions SET available_seats=available_seats-1,updated_at=? WHERE id=? AND available_seats IS NOT NULL AND available_seats>0').run(t,o.edition_id);
    // La venta la cierra quien confirma; un pago del proveedor simulado queda sin actor (origen «pago»).
    crm.setStage(c,'ganada',actor||{id:null},{});
    event(o.id,'confirmed',{method,providerRef,note:text(note,500)},actor?.id||null,t);
    emit('pago.confirmado',o,{method,providerRef,enrollmentId,opportunityId:o.opportunity_id,courseTitle:n.course,editionName:n.edition},actor);
    events?.publish({type:'inscripcion.activada',brandId:o.brand_id,entityKind:'enrollment',entityId:enrollmentId,payload:{orderId:o.id,reference:o.reference,editionId:o.edition_id,courseId:o.course_id,courseTitle:n.course,editionName:n.edition,contactId:o.contact_id},actorId:actor?.id||null,source:'payments'});
    const tpl=content?.render('payment_confirmed',o.brand_id,{courseId:o.course_id,editionId:o.edition_id,name:n.contact.split(' ')[0],extra:{pedido:o.reference,importe:money(o.amount_cents,o.currency)}});
    say(c,tpl?tpl.text:`Pago confirmado (laboratorio) · ${o.reference}. Quedaste inscrito en ${n.course} · ${n.edition}. El equipo coordinador te enviará los accesos y recordatorios por aquí. No se realizó ningún cobro real.`,'order:'+o.id+':paid');
    notifyStaff(c,'payment','Pago confirmado · '+n.contact+' · '+n.course+' · '+money(o.amount_cents,o.currency),'order:'+o.id+':paid');
    return get(o.id);
  }
  function expire(o){const t=now();if(db.prepare("UPDATE orders SET status='expired',revision=revision+1,updated_at=? WHERE id=? AND status='pending'").run(t,o.id).changes){event(o.id,'expired',{},null,t);emit('pedido.vencido',o,{},null);}}
  // Proveedor simulado: el cliente paga desde el enlace. Un webhook real de Stripe/Conekta llamaría a confirm() tras verificar la firma.
  function pay(o,user,input){
    const c=db.prepare('SELECT * FROM conversations WHERE id=?').get(o.conversation_id);if(!c||c.customer_id!==user.id)throw fail(404,'Pedido no disponible.');
    if(o.status==='pending'&&o.expires_at<=now()){transaction(db,()=>expire(o));throw fail(409,'El enlace de pago venció. Pide uno nuevo por el chat.');}
    if(o.status!=='pending')throw fail(409,'Este pedido ya no admite pago: '+STATUS[o.status].toLowerCase()+'.');
    const method=['card','oxxo'].includes(input.method)?input.method:null;if(!method)throw fail(400,'Elige tarjeta u OXXO (simulados).');
    const approved=input.outcome!=='declined',providerRef='sim_'+randomBytes(6).toString('hex');
    const out=transaction(db,()=>{
      const fresh=get(o.id);if(fresh.status!=='pending')throw fail(409,'Este pedido ya no admite pago: '+STATUS[fresh.status].toLowerCase()+'.');
      if(approved)return confirm(fresh,{actor:null,method,providerRef});
      event(o.id,'provider.declined',{method,providerRef},null,now());emit('pago.rechazado',o,{method,providerRef,provider:'simulated'},null,'pago.rechazado:'+o.id+':'+providerRef);
      say(c,`El pago simulado con ${method==='card'?'tarjeta':'OXXO'} no se completó (${o.reference}). Puedes intentarlo de nuevo desde el enlace o enviar tu comprobante por aquí.`,'order:'+o.id+':declined:'+providerRef);
      return get(o.id);
    });
    broadcast('conversation',c.id);broadcast('crm',null,{brandId:c.brand_id});return out;
  }
  // Un adjunto del cliente en una conversación con pedido vigente es un comprobante: entra a la cola. Dentro de la transacción del llamador.
  function attachReceipt(c,messageId,attachmentId){
    const o=openOrder(c.id);if(!o)return null;
    const a=db.prepare('SELECT * FROM attachments WHERE id=?').get(attachmentId),t=now(),id=randomUUID(),n=names(o);
    const prelecture={status:'simulada',checks:[{name:'Formato admitido (imagen o PDF)',ok:true},{name:'Tamaño razonable',ok:a.size<4*1024*1024},{name:'Pedido vigente al recibirlo',ok:o.expires_at>t},{name:'Importe esperado '+money(o.amount_cents,o.currency),ok:null}],note:'La lectura automática del importe, la fecha y la cuenta llegará con el proveedor de IA; por ahora lo valida una persona.'};
    db.prepare('INSERT INTO receipts(id,order_id,conversation_id,message_id,attachment_id,status,prelecture,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,o.id,c.id,messageId,attachmentId,'pending',JSON.stringify(prelecture),t);
    db.prepare("UPDATE orders SET status='review',revision=revision+1,updated_at=? WHERE id=?").run(t,o.id);
    event(o.id,'receipt.received',{receiptId:id,filename:a.filename,mime:a.mime,size:a.size},null,t);emit('comprobante.recibido',o,{receiptId:id,filename:a.filename},null,'comprobante.recibido:'+id);
    say(c,`Recibimos tu comprobante del pedido ${o.reference}. Una persona del equipo lo revisa y te confirmamos por aquí. (Laboratorio: no se realizan cobros reales.)`,'order:'+o.id+':receipt:'+id,'service');
    notifyStaff(c,'receipt','Comprobante por revisar · '+n.contact+' · '+o.reference+' · '+money(o.amount_cents,o.currency),'receipt:'+id);
    return id;
  }
  const receipt=id=>db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
  function accept(r,user,input){
    const o=get(r.order_id),c=accessConversation(o.conversation_id,user);crm.requireBrand(user,c.brand_id);
    if(r.status!=='pending')throw fail(409,'Este comprobante ya fue revisado.');if(o.status!=='review')throw fail(409,'El pedido ya no está en revisión: '+STATUS[o.status].toLowerCase()+'.');
    const t=now(),out=transaction(db,()=>{
      if(!db.prepare("UPDATE receipts SET status='accepted',reviewed_by=?,review_note=?,reviewed_at=? WHERE id=? AND status='pending'").run(user.id,text(input.note,500),t,r.id).changes)throw fail(409,'Este comprobante ya fue revisado.');
      const fresh=get(o.id);if(fresh.status!=='review')throw fail(409,'El pedido ya no está en revisión: '+STATUS[fresh.status].toLowerCase()+'.');
      return confirm(fresh,{actor:user,method:'transfer',note:text(input.note,500)});});
    audit(user,'payment.receipt.accept',r.id);broadcast('conversation',c.id);broadcast('crm',null,{brandId:c.brand_id});return out;
  }
  function reject(r,user,input){
    const o=get(r.order_id),c=accessConversation(o.conversation_id,user);crm.requireBrand(user,c.brand_id);const reason=text(input.reason,500);
    if(r.status!=='pending')throw fail(409,'Este comprobante ya fue revisado.');if(reason.length<5)throw fail(400,'Explica al cliente por qué no se valida (mínimo 5 caracteres).');
    const t=now(),out=transaction(db,()=>{
      if(!db.prepare("UPDATE receipts SET status='rejected',reviewed_by=?,review_note=?,reviewed_at=? WHERE id=? AND status='pending'").run(user.id,reason,t,r.id).changes)throw fail(409,'Este comprobante ya fue revisado.');
      if(!db.prepare("SELECT 1 FROM receipts WHERE order_id=? AND status='pending'").get(o.id))db.prepare("UPDATE orders SET status=CASE WHEN expires_at>? THEN 'pending' ELSE 'expired' END,revision=revision+1,updated_at=? WHERE id=? AND status='review'").run(t,t,o.id);
      event(o.id,'receipt.rejected',{receiptId:r.id,reason},user.id,t);
      say(c,`No pudimos validar tu comprobante del pedido ${o.reference}: ${reason}. Puedes enviar otro por aquí o pagar desde el enlace.`,'order:'+o.id+':rejected:'+r.id);
      return get(o.id);
    });
    audit(user,'payment.receipt.reject',r.id);broadcast('conversation',c.id);broadcast('crm',null,{brandId:c.brand_id});return out;
  }
  function cancel(o,user,input){
    const c=accessConversation(o.conversation_id,user);crm.requireBrand(user,c.brand_id);const reason=text(input.reason,500);
    if(!['pending','review'].includes(o.status))throw fail(409,'Sólo se cancela un pedido pendiente o en revisión.');if(reason.length<5)throw fail(400,'Indica el motivo (mínimo 5 caracteres).');
    const t=now(),out=transaction(db,()=>{
      db.prepare("UPDATE receipts SET status='rejected',reviewed_by=?,review_note=?,reviewed_at=? WHERE order_id=? AND status='pending'").run(user.id,'Pedido cancelado: '+reason,t,o.id);
      if(!db.prepare("UPDATE orders SET status='cancelled',note=?,revision=revision+1,updated_at=? WHERE id=? AND status IN ('pending','review')").run(reason,t,o.id).changes)throw fail(409,'El pedido cambió de estado. Recárgalo.');event(o.id,'cancelled',{reason},user.id,t);emit('pedido.cancelado',o,{reason},user);
      say(c,`El pedido ${o.reference} se canceló: ${reason}. Si quieres continuar, el equipo puede generarte uno nuevo.`,'order:'+o.id+':cancelled');
      return get(o.id);
    });
    audit(user,'payment.order.cancel',o.id);broadcast('conversation',c.id);broadcast('crm',null,{brandId:c.brand_id});return out;
  }
  async function tick(){
    const expired=db.prepare("SELECT * FROM orders WHERE status='pending' AND expires_at<=? LIMIT 100").all(now());
    if(expired.length){transaction(db,()=>{for(const o of expired)expire(o);});for(const b of new Set(expired.map(o=>o.brand_id)))broadcast('crm',null,{brandId:b});}
    // Sesión de pago del proveedor (fuera de transacción): el simulado devuelve nuestro propio enlace; uno real devolvería su URL de cobro.
    const connector=connectorOf?connectorOf():null;if(!connector?.prepareCheckout)return;
    for(const o of db.prepare("SELECT * FROM orders WHERE status='pending' AND provider_ref IS NULL ORDER BY created_at LIMIT 20").all()){
      try{const r=await connector.prepareCheckout(o);db.prepare("UPDATE orders SET provider_ref=?,checkout_url=?,updated_at=? WHERE id=? AND provider_ref IS NULL").run(r.providerRef||null,r.url||null,now(),o.id);}
      catch(e){console.error('Checkout preparation failed:',String(e?.message||e).slice(0,120));break;}
    }
  }
  // Evento de pago del proveedor (webhook ya verificado y normalizado por connectors.mjs). Devuelve un resultado legible.
  function providerEvent(ev,provider='simulated'){
    const d=ev.data||{},o=d.orderId?get(String(d.orderId)):d.reference?db.prepare('SELECT * FROM orders WHERE reference=?').get(String(d.reference).toUpperCase()):null;
    if(!o)return 'ignorado: pedido no encontrado ('+(d.orderId||d.reference||'sin referencia')+')';
    if(d.amountCents!==undefined&&d.amountCents!==null&&Number(d.amountCents)!==o.amount_cents)return 'rechazado: el importe del proveedor ('+d.amountCents+') no coincide con el pedido ('+o.amount_cents+')';
    const c=db.prepare('SELECT * FROM conversations WHERE id=?').get(o.conversation_id);
    if(ev.type==='payment.succeeded'){
      if(!['pending','review'].includes(o.status))return 'ignorado: el pedido ya estaba '+STATUS[o.status].toLowerCase();
      transaction(db,()=>confirm(o,{actor:null,method:['card','oxxo','transfer'].includes(d.method)?d.method:'card',providerRef:d.providerRef?String(d.providerRef).slice(0,120):null,note:'Confirmado por webhook de '+provider}));
      broadcast('conversation',c.id);broadcast('crm',null,{brandId:c.brand_id});return 'aplicado: pedido '+o.reference+' pagado e inscripción registrada';
    }
    if(o.status!=='pending')return 'ignorado: el pedido ya estaba '+STATUS[o.status].toLowerCase();
    transaction(db,()=>{event(o.id,'provider.declined',{providerRef:d.providerRef||null,reason:d.reason||null,provider},null,now());emit('pago.rechazado',o,{method:d.method||null,providerRef:d.providerRef||null,reason:d.reason||null,provider},null,'pago.rechazado:'+o.id+':'+(d.providerRef||ev.id||randomUUID()));say(c,`El pago del pedido ${o.reference} no se completó${d.reason?' ('+text(String(d.reason),120)+')':''}. Puedes intentarlo de nuevo desde el enlace o enviar tu comprobante por aquí.`,'order:'+o.id+':declined:'+String(d.providerRef||randomUUID()).slice(0,60));});
    broadcast('conversation',c.id);return 'aplicado: pago rechazado registrado para '+o.reference;
  }
  // Cobro desde el chat por el equipo: pedido (nuevo o vigente) + mensaje con el enlace; el equipo toma la conversación como con una plantilla.
  function sendLink(c,user,{resend=false}={}){
    crm.requireBrand(user,c.brand_id);if(c.status==='resolved')throw fail(409,'La conversación está cerrada.');
    let made;transaction(db,()=>{
      made=createOrder(c,{user,source:'agent'});
      if(made.created||resend){crm.assignConversation(c,user.id);insertMessage(c,user,linkMessage(made.order),'agent','order:'+made.order.id+':link:'+randomUUID().slice(0,8),null,null,null,{category:'utility'});db.prepare("UPDATE conversations SET bot_enabled=0,assigned_to=?,status='open' WHERE id=?").run(user.id,c.id);db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending'").run(c.id);cancelConversationSteps(db,c.id,'human_takeover');event(made.order.id,'link.sent',{by:user.id},user.id,now());}
    });
    audit(user,'payment.order.link',made.order.id);broadcast('conversation',c.id);broadcast('crm',null,{brandId:c.brand_id});return made;
  }
  function preview(c,user){
    crm.requireBrand(user,c.brand_id);const s=settings(c.brand_id),ctx=catalogue.info(c.course_id,c.edition_id),existing=openOrder(c.id);
    return {enabled:Boolean(s.enabled),reason:ctx.reason||null,course:ctx.course.title,edition:ctx.edition.name,promotion:ctx.promotion?.name||null,amountCents:ctx.priceCents,amountLabel:money(ctx.priceCents,ctx.currency),currency:ctx.currency,linkHours:s.link_hours,existing:existing?view(existing):null};
  }

  const view=o=>{const n=names(o);return {...o,courseTitle:n.course,editionName:n.edition,promotionName:n.promotion,contactName:n.contact,amountLabel:money(o.amount_cents,o.currency),statusLabel:STATUS[o.status],methodLabel:o.method?METHODS[o.method]:null,link:linkFor(o),pendingReceipts:db.prepare("SELECT count(*) n FROM receipts WHERE order_id=? AND status='pending'").get(o.id).n};};
  function list(user,{brand,status}){
    const ids=crm.brandsFor(user).map(b=>b.id).filter(id=>!brand||brand==='all'||id===brand);if(!ids.length)return {orders:[],stats:emptyStats()};
    const ph=ids.map(()=>'?').join(',');
    const rows=db.prepare(`SELECT * FROM orders WHERE brand_id IN (${ph})${status&&STATUS[status]?' AND status=?':''} ORDER BY CASE status WHEN 'review' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,updated_at DESC LIMIT 200`).all(...ids,...(status&&STATUS[status]?[status]:[]));
    const day=new Date();day.setHours(0,0,0,0);
    const stats={pending:0,review:0,paid:0,cancelled:0,expired:0,paidAmountCents:0,paidTodayCents:0,currency:'MXN'};
    for(const o of db.prepare(`SELECT status,amount_cents,currency,paid_at FROM orders WHERE brand_id IN (${ph})`).all(...ids)){stats[o.status]++;if(o.status==='paid'){stats.paidAmountCents+=o.amount_cents;stats.currency=o.currency;if(o.paid_at>=day.getTime())stats.paidTodayCents+=o.amount_cents;}}
    return {orders:rows.map(view),stats:{...stats,paidAmountLabel:money(stats.paidAmountCents,stats.currency),paidTodayLabel:money(stats.paidTodayCents,stats.currency)}};
  }
  const emptyStats=()=>({pending:0,review:0,paid:0,cancelled:0,expired:0,paidAmountCents:0,paidTodayCents:0,currency:'MXN',paidAmountLabel:money(0,'MXN'),paidTodayLabel:money(0,'MXN')});
  function detail(o,user){
    accessConversation(o.conversation_id,user);crm.requireBrand(user,o.brand_id);
    return {order:view(o),events:db.prepare('SELECT e.kind,e.details,e.created_at,u.name actor_name FROM payment_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.order_id=? ORDER BY e.seq').all(o.id).map(e=>({...e,details:JSON.parse(e.details)})),
      receipts:db.prepare('SELECT r.*,a.filename,a.mime,a.size,u.name reviewer_name FROM receipts r JOIN attachments a ON a.id=r.attachment_id LEFT JOIN users u ON u.id=r.reviewed_by WHERE r.order_id=? ORDER BY r.created_at').all(o.id).map(r=>({...r,prelecture:JSON.parse(r.prelecture),attachmentUrl:'/api/files/'+r.attachment_id}))};
  }
  function customerView(o,user){
    const c=db.prepare('SELECT * FROM conversations WHERE id=?').get(o.conversation_id);if(!c||c.customer_id!==user.id)throw fail(404,'Pedido no disponible.');
    const n=names(o),brand=db.prepare('SELECT name FROM brands WHERE id=?').get(o.brand_id);
    if(o.status==='pending'&&o.expires_at<=now())transaction(db,()=>expire(o));
    const fresh=get(o.id);return {id:o.id,reference:o.reference,status:fresh.status,statusLabel:STATUS[fresh.status],amountLabel:money(o.amount_cents,o.currency),course:n.course,edition:n.edition,promotion:n.promotion,brand:brand?.name,expiresAt:o.expires_at,conversationId:o.conversation_id,checkoutUrl:fresh.checkout_url&&!fresh.checkout_url.includes('/?pay=')?fresh.checkout_url:null,methods:Object.entries(METHODS).map(([id,label])=>({id,label}))};
  }
  function setSettings(brandId,input,user){
    requireAdmin(user);if(!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no encontrada.');
    const current=settings(brandId);if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==current.revision)throw fail(409,'La configuración de pagos cambió. Recárgala.');
    const hours=input.linkHours===undefined?current.link_hours:Number(input.linkHours);if(!Number.isInteger(hours)||hours<1||hours>720)throw fail(400,'La vigencia del enlace va de 1 a 720 horas.');
    const enabled=input.enabled===undefined?current.enabled:input.enabled?1:0,t=now();
    db.prepare('INSERT INTO payment_settings(brand_id,enabled,link_hours,revision,updated_by,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT(brand_id) DO UPDATE SET enabled=excluded.enabled,link_hours=excluded.link_hours,revision=payment_settings.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(brandId,enabled,hours,user.id,t);
    audit(user,'payment.settings',brandId);broadcast('crm',null,{brandId});return settings(brandId);
  }

  async function handle(req,res,path,user){
    let x;const url=new URL(req.url,'http://localhost');
    if((x=path.match(/^\/api\/conversations\/([a-f0-9-]+)\/orders(?:\/(preview))?$/))){
      requireStaff(user);const c=accessConversation(x[1],user);
      if(x[2]==='preview'&&req.method==='GET'){json(res,200,preview(c,user));return true;}
      if(!x[2]&&req.method==='POST'){const input=await body(req),made=sendLink(c,user,{resend:Boolean(input.resend)});json(res,made.created?201:200,{order:view(made.order),created:made.created});return true;}
      throw fail(405,'Método no permitido.');
    }
    if(!path.startsWith('/api/payments'))return false;
    if(path==='/api/payments/settings'&&req.method==='GET'){requireStaff(user);json(res,200,{settings:crm.brandsFor(user).map(b=>({...settings(b.id),brand_name:b.name}))});return true;}
    if((x=path.match(/^\/api\/payments\/brands\/([a-zA-Z0-9-]+)$/))&&req.method==='PATCH'){json(res,200,{settings:setSettings(x[1],await body(req),user)});return true;}
    if(path==='/api/payments/orders'&&req.method==='GET'){requireStaff(user);json(res,200,list(user,{brand:url.searchParams.get('brand'),status:url.searchParams.get('status')}));return true;}
    if((x=path.match(/^\/api\/payments\/orders\/([a-f0-9-]{36})(?:\/(customer|pay|cancel))?$/))){
      const o=get(x[1]);if(!o)throw fail(404,'Pedido no disponible.');
      if(x[2]==='customer'&&req.method==='GET'){json(res,200,{order:customerView(o,user)});return true;}
      if(x[2]==='pay'&&req.method==='POST'){json(res,200,{order:view(pay(o,user,await body(req)))});return true;}
      requireStaff(user);
      if(!x[2]&&req.method==='GET'){json(res,200,detail(o,user));return true;}
      if(x[2]==='cancel'&&req.method==='POST'){json(res,200,{order:view(cancel(o,user,await body(req)))});return true;}
      throw fail(405,'Método no permitido.');
    }
    if((x=path.match(/^\/api\/payments\/receipts\/([a-f0-9-]{36})\/(accept|reject)$/))&&req.method==='POST'){
      requireStaff(user);const r=receipt(x[1]);if(!r)throw fail(404,'Comprobante no disponible.');
      json(res,200,{order:view(x[2]==='accept'?accept(r,user,await body(req)):reject(r,user,await body(req)))});return true;
    }
    throw fail(404,'Ruta de pagos no encontrada.');
  }
  return {handle,settings,createOrder,linkMessage,confirm,attachReceipt,tick,openOrder,view,list,useConnector,providerEvent};
}
