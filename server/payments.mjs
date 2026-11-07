import {randomUUID,randomBytes} from 'node:crypto';
import {transaction} from './database.mjs';
import {cancelConversationSteps} from './automation.mjs';
import {publishSeatChange} from './catalogue-events.mjs';

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

export function createPayments({db,crm,catalogue,insertMessage,body,json,audit,broadcast,accessConversation,events=null,content=null,coupons=null,now=Date.now,env=process.env}){
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
  const sessionOf=o=>o.session_id?db.prepare('SELECT * FROM edition_sessions WHERE id=?').get(o.session_id):null;
  const planLabel=o=>o.plan==='per_session'?'Por sesión':'Curso completo';

  // Texto del enlace de pago que recibe el cliente (lo envía el equipo o el motor de respuestas).
  function linkMessage(o){
    const n=names(o),promo=o.coupon_code&&o.discount_cents>0?' Incluye tu cupón '+o.coupon_code+' (−'+money(o.discount_cents,o.currency)+').':'';
    const t=content?.render('payment_pending',o.brand_id,{courseId:o.course_id,editionId:o.edition_id,name:n.contact.split(' ')[0],extra:{pedido:o.reference,importe:money(o.amount_cents,o.currency),enlace_pago:linkFor(o),vigencia_pago:stamp(o.expires_at),plan_pago:planLabel(o)}});if(t)return t.text+promo;
    return `Pedido de práctica ${o.reference}: ${n.course} · ${n.edition} por ${money(o.amount_cents,o.currency)}${o.plan==='per_session'?' (plan por sesión: este pago cubre tu primera sesión; las siguientes se cobran antes de cada clase)':n.promotion?' ('+n.promotion+')':''}.${promo}\nPaga aquí (simulado): ${linkFor(o)}\nVigente hasta ${stamp(o.expires_at)}. También puedes enviar tu comprobante de transferencia por este chat y una persona lo valida.\nLaboratorio: no se realizan cobros reales.`;
  }
  // Enlace de pago de una sesión (plan por sesión): mismo recorrido de cobro, un pedido por sesión e inscripción.
  function sessionLinkMessage(o){
    const n=names(o),s=sessionOf(o);
    const t=content?.render('session_payment',o.brand_id,{courseId:o.course_id,editionId:o.edition_id,name:n.contact.split(' ')[0],extra:{sesion:s.number+'. '+s.title,fecha_sesion:stamp(s.starts_at),importe:money(o.amount_cents,o.currency),enlace_pago:linkFor(o),vigencia_pago:stamp(o.expires_at)}});if(t)return t.text;
    return `Pago de la sesión ${s.number} (${s.title}) · ${n.course} · ${stamp(s.starts_at)}: ${money(o.amount_cents,o.currency)}.\nPedido ${o.reference}. Paga aquí (simulado): ${linkFor(o)}\nVigente hasta ${stamp(o.expires_at)}. También puedes enviar tu comprobante de transferencia por este chat.\nLaboratorio: no se realizan cobros reales.`;
  }
  // Crea el pedido dentro de la transacción del llamador. Si ya hay uno vigente en la conversación, lo devuelve.
  // plan='per_session': el importe es el precio por sesión de la edición y el pago cubre la primera sesión disponible.
  function createOrder(c,{user=null,source,plan='full',coupon=null}){
    const s=settings(c.brand_id);if(!s.enabled)throw fail(409,'La venta con pago simulado está apagada para esta marca. Actívala en Operación → Pagos.');
    if(c.status==='resolved')throw fail(409,'La conversación está cerrada.');
    const existing=openOrder(c.id);if(existing&&coupon)throw fail(409,'Ya hay un pedido vigente ('+existing.reference+'). Cancélalo para cobrar de nuevo con un cupón.');if(existing)return {order:existing,created:false};
    if(coupon&&source!=='agent')throw fail(409,'Los cupones los aplica una persona del equipo.');
    const ctx=catalogue.info(c.course_id,c.edition_id);if(ctx.reason)throw fail(409,ctx.reason+'. Elige otra edición antes de cobrar.');
    const perSession=plan==='per_session';if(perSession&&!(ctx.edition.session_price_cents>0))throw fail(409,'Esta edición no tiene precio por sesión. Defínelo en Catálogo o cobra el curso completo.');
    const amount=perSession?ctx.edition.session_price_cents:ctx.priceCents,promoId=perSession?null:ctx.promotion?.id||null;
    const oppId=crm.syncConversation(c),opp=db.prepare('SELECT * FROM opportunities WHERE id=?').get(oppId);
    if(['ganada','perdida'].includes(opp.stage))throw fail(409,'La oportunidad ya está cerrada ('+opp.stage+'). Abre una nueva conversación para otra venta.');
    // Cupón (sólo curso completo): se valida con las mismas reglas que la vista previa, dentro de esta transacción, y el pedido guarda el descuento.
    let off=0,couponId=null,couponCode=null;
    if(coupon){if(perSession)throw fail(409,'Los cupones aplican al curso completo, no al plan por sesión.');if(!coupons)throw fail(409,'Los cupones no están disponibles.');const q=coupons.validate({brandId:c.brand_id,courseId:c.course_id,editionId:ctx.edition.id,contactId:opp.contact_id,baseCents:amount,code:coupon});off=q.discountCents;couponId=q.coupon.id;couponCode=q.coupon.code;}
    const t=now(),id=randomUUID();let reference;do{reference='TC-'+randomBytes(3).toString('hex').toUpperCase();}while(db.prepare('SELECT 1 FROM orders WHERE reference=?').get(reference));
    db.prepare('INSERT INTO orders(id,reference,brand_id,contact_id,opportunity_id,conversation_id,course_id,edition_id,promotion_id,amount_cents,currency,status,source,created_by,expires_at,created_at,updated_at,plan,coupon_id,coupon_code,discount_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,reference,c.brand_id,opp.contact_id,oppId,c.id,c.course_id,ctx.edition.id,promoId,amount-off,ctx.currency,'pending',source,user?.id||null,t+s.link_hours*3600000,t,t,perSession?'per_session':'full',couponId,couponCode,off);
    event(id,'created',{source,amountCents:amount-off,listAmountCents:amount,couponCode,discountCents:off,currency:ctx.currency,promotionId:promoId,plan:perSession?'per_session':'full',expiresAt:t+s.link_hours*3600000},user?.id||null,t);
    emit('pedido.creado',get(id),{source,promotionId:promoId,couponCode,discountCents:off,kind:'course',plan:perSession?'per_session':'full',expiresAt:t+s.link_hours*3600000},user);
    return {order:get(id),created:true};
  }
  // Confirmación de pago (proveedor simulado o persona). Dentro de la transacción del llamador.
  function confirm(o,{actor=null,method,providerRef=null,note=''}){
    const t=now(),c=db.prepare('SELECT * FROM conversations WHERE id=?').get(o.conversation_id),n=names(o);
    // Guarda de estado dentro de la transacción: dos confirmaciones concurrentes (o una tras cancelar) no pueden pasar las dos.
    if(!db.prepare("UPDATE orders SET status='paid',method=?,provider_ref=COALESCE(?,provider_ref),paid_at=?,confirmed_by=?,note=?,revision=revision+1,updated_at=? WHERE id=? AND status IN ('pending','review')").run(method,providerRef,t,actor?.id||null,text(note,500),t,o.id).changes)throw fail(409,'El pedido cambió de estado mientras se confirmaba. Recárgalo.');
    if(o.kind==='session'){   // pago de una sesión (plan por sesión): no inscribe ni mueve la oportunidad; marca la sesión pagada
      const s=sessionOf(o);
      db.prepare("UPDATE session_payments SET status='paid',order_id=?,paid_at=?,updated_at=? WHERE session_id=? AND enrollment_id=? AND status!='paid'").run(o.id,t,t,o.session_id,o.enrollment_id);
      event(o.id,'confirmed',{method,providerRef,note:text(note,500),sessionId:o.session_id,sessionNumber:s?.number},actor?.id||null,t);
      emit('pago.confirmado',o,{method,providerRef,kind:'session',plan:'per_session',sessionId:o.session_id,sessionNumber:s?.number,enrollmentId:o.enrollment_id,opportunityId:o.opportunity_id,courseTitle:n.course,editionName:n.edition},actor);
      say(c,`Pago de la sesión ${s?.number||''} confirmado (laboratorio) · ${o.reference} · ${money(o.amount_cents,o.currency)}. ¡Nos vemos en clase! No se realizó ningún cobro real.`,'order:'+o.id+':paid');
      notifyStaff(c,'payment','Pago de sesión '+(s?.number||'')+' · '+n.contact+' · '+n.course+' · '+money(o.amount_cents,o.currency),'order:'+o.id+':paid');
      return get(o.id);
    }
    const plan=o.plan==='per_session'?'per_session':'full',covered=plan==='per_session'?db.prepare("SELECT id FROM edition_sessions WHERE edition_id=? AND status='scheduled' AND starts_at+duration_min*60000>? ORDER BY starts_at LIMIT 1").get(o.edition_id,t)?.id||null:null;
    const enrollmentId=randomUUID();db.prepare('INSERT INTO enrollments(id,order_id,brand_id,contact_id,opportunity_id,course_id,edition_id,status,created_at,payment_plan,covered_session_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(enrollmentId,o.id,o.brand_id,o.contact_id,o.opportunity_id,o.course_id,o.edition_id,'enrolled',t,plan,covered);
    const seatsBefore=db.prepare('SELECT available_seats s FROM editions WHERE id=?').get(o.edition_id)?.s;
    db.prepare('UPDATE editions SET available_seats=available_seats-1,updated_at=? WHERE id=? AND available_seats IS NOT NULL AND available_seats>0').run(t,o.edition_id);
    {const ed=db.prepare('SELECT * FROM editions WHERE id=?').get(o.edition_id);publishSeatChange(events,ed,seatsBefore,ed?.available_seats,{reason:'inscripcion',actorId:actor?.id||null,source:'pago',dedupeKey:'enrollment:'+enrollmentId});}
    // La venta la cierra quien confirma; un pago del proveedor simulado queda sin actor (origen «pago»).
    crm.setStage(c,'ganada',actor||{id:null},{});
    event(o.id,'confirmed',{method,providerRef,note:text(note,500)},actor?.id||null,t);
    emit('pago.confirmado',o,{method,providerRef,kind:'course',plan,enrollmentId,opportunityId:o.opportunity_id,courseTitle:n.course,editionName:n.edition},actor);
    events?.publish({type:'inscripcion.activada',brandId:o.brand_id,entityKind:'enrollment',entityId:enrollmentId,payload:{orderId:o.id,reference:o.reference,editionId:o.edition_id,courseId:o.course_id,courseTitle:n.course,editionName:n.edition,contactId:o.contact_id,plan},actorId:actor?.id||null,source:'payments'});
    const tpl=content?.render('payment_confirmed',o.brand_id,{courseId:o.course_id,editionId:o.edition_id,name:n.contact.split(' ')[0],extra:{pedido:o.reference,importe:money(o.amount_cents,o.currency),plan_pago:planLabel(o)}});
    say(c,tpl?tpl.text:`Pago confirmado (laboratorio) · ${o.reference}. Quedaste inscrito en ${n.course} · ${n.edition}${plan==='per_session'?' con plan por sesión: este pago cubre tu primera sesión y el enlace de pago de cada sesión siguiente llegará por aquí antes de la clase':''}. El equipo coordinador te enviará los accesos y recordatorios por aquí. No se realizó ningún cobro real.`,'order:'+o.id+':paid');
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
  function sendLink(c,user,{resend=false,plan='full',coupon=null}={}){
    crm.requireBrand(user,c.brand_id);if(c.status==='resolved')throw fail(409,'La conversación está cerrada.');
    let made;transaction(db,()=>{
      made=createOrder(c,{user,source:'agent',plan,coupon});
      if(made.created||resend){crm.assignConversation(c,user.id);insertMessage(c,user,linkMessage(made.order),'agent','order:'+made.order.id+':link:'+randomUUID().slice(0,8),null,null,null,{category:'utility'});db.prepare("UPDATE conversations SET bot_enabled=0,assigned_to=?,status='open' WHERE id=?").run(user.id,c.id);db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending'").run(c.id);cancelConversationSteps(db,c.id,'human_takeover');event(made.order.id,'link.sent',{by:user.id},user.id,now());}
    });
    audit(user,'payment.order.link',made.order.id);broadcast('conversation',c.id);broadcast('crm',null,{brandId:c.brand_id});return made;
  }
  // ---- pedidos por sesión (plan por sesión). Dentro de la transacción del llamador.
  function createSessionOrder(s,en,{user=null,source}){
    const st=settings(en.brand_id);if(!st.enabled)throw fail(409,'La venta con pago simulado está apagada para esta marca. Actívala en Operación → Pagos.');
    if(en.status!=='enrolled'||en.payment_plan!=='per_session')throw fail(409,'La inscripción no tiene plan por sesión.');
    if(s.status!=='scheduled')throw fail(409,'La sesión ya no está programada.');
    const sp=db.prepare('SELECT * FROM session_payments WHERE session_id=? AND enrollment_id=?').get(s.id,en.id);
    if(!sp||sp.status!=='pending')throw fail(409,sp?.status==='paid'?'Esta sesión ya está pagada.':sp?.status==='waived'?'Esta sesión fue condonada.':'La sesión no tiene cobro pendiente para esta inscripción.');
    const existing=db.prepare("SELECT * FROM orders WHERE session_id=? AND enrollment_id=? AND status IN ('pending','review') LIMIT 1").get(s.id,en.id);if(existing)return {order:existing,created:false};
    let amount=sp.amount_cents;if(!(amount>0)){amount=db.prepare('SELECT session_price_cents FROM editions WHERE id=?').get(en.edition_id)?.session_price_cents||0;if(!(amount>0))throw fail(409,'La sesión no tiene importe: define el precio por sesión de la edición en Catálogo.');db.prepare('UPDATE session_payments SET amount_cents=?,updated_at=? WHERE session_id=? AND enrollment_id=?').run(amount,now(),s.id,en.id);}
    const base=get(en.order_id),c=db.prepare('SELECT * FROM conversations WHERE id=?').get(base.conversation_id);if(!c)throw fail(409,'La conversación de la inscripción no está disponible.');
    const t=now(),id=randomUUID(),expires=Math.max(t+3600000,Math.min(t+st.link_hours*3600000,s.starts_at+s.duration_min*60000));let reference;do{reference='TC-'+randomBytes(3).toString('hex').toUpperCase();}while(db.prepare('SELECT 1 FROM orders WHERE reference=?').get(reference));
    db.prepare("INSERT INTO orders(id,reference,brand_id,contact_id,opportunity_id,conversation_id,course_id,edition_id,promotion_id,amount_cents,currency,status,source,created_by,expires_at,created_at,updated_at,kind,plan,session_id,enrollment_id) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,'pending',?,?,?,?,?,'session','per_session',?,?)").run(id,reference,en.brand_id,en.contact_id,en.opportunity_id,c.id,en.course_id,en.edition_id,amount,sp.currency,source,user?.id||null,expires,t,t,s.id,en.id);
    event(id,'created',{source,amountCents:amount,currency:sp.currency,sessionId:s.id,sessionNumber:s.number,expiresAt:expires},user?.id||null,t);
    emit('pedido.creado',get(id),{source,kind:'session',plan:'per_session',sessionId:s.id,sessionNumber:s.number,enrollmentId:en.id,expiresAt:expires},user);
    return {order:get(id),created:true,conversation:c};
  }
  // Pedido de sesión + mensaje con el enlace por el chat del alumno (equipo o automatización). Si ya había pedido vigente y
  // lo pide la automatización, no repite el aviso.
  function sendSessionLink(s,en,{user=null,source}){
    const made=createSessionOrder(s,en,{user,source});const c=made.conversation||db.prepare('SELECT * FROM conversations WHERE id=?').get(made.order.conversation_id);
    if(!made.created&&!user)return {...made,conversation:c};
    if(c.status==='resolved')throw fail(409,'La conversación está cerrada.');
    insertMessage(c,user,sessionLinkMessage(made.order),user?'agent':'automation','order:'+made.order.id+':link:'+(user?randomUUID().slice(0,8):'auto'),null,null,null,{category:'utility'});
    event(made.order.id,'link.sent',{by:user?.id||null,auto:!user},user?.id||null,now());
    return {...made,conversation:c};
  }
  // Cancela los pedidos de sesión vigentes de una sesión, inscripción o apertura (sesión cancelada, baja, condonación).
  function voidSessionOrders({sessionId=null,enrollmentId=null,editionId=null},reason,actor=null){
    const rows=db.prepare("SELECT * FROM orders WHERE kind='session' AND status IN ('pending','review') AND (?1 IS NULL OR session_id=?1) AND (?2 IS NULL OR enrollment_id=?2) AND (?3 IS NULL OR edition_id=?3)").all(sessionId,enrollmentId,editionId),t=now();
    for(const o of rows){
      db.prepare("UPDATE receipts SET status='rejected',reviewed_by=?,review_note=?,reviewed_at=? WHERE order_id=? AND status='pending'").run(actor?.id||null,'Pedido cancelado: '+reason,t,o.id);
      db.prepare("UPDATE orders SET status='cancelled',note=?,revision=revision+1,updated_at=? WHERE id=?").run(text(reason,500),t,o.id);event(o.id,'cancelled',{reason},actor?.id||null,t);emit('pedido.cancelado',o,{reason},actor);
      const c=db.prepare('SELECT * FROM conversations WHERE id=?').get(o.conversation_id);if(c&&c.status!=='resolved')say(c,`El pedido ${o.reference} se canceló: ${reason}.`,'order:'+o.id+':cancelled');
    }
    return rows.length;
  }
  function preview(c,user,couponCode=''){
    crm.requireBrand(user,c.brand_id);const s=settings(c.brand_id),ctx=catalogue.info(c.course_id,c.edition_id),existing=openOrder(c.id);
    // Si ya no se puede cobrar (conversación o venta cerradas), se avisa antes de abrir la ventana en lugar de fallar al enviarla.
    const stage=db.prepare('SELECT o.stage FROM opportunities o JOIN conversation_opportunities co ON co.opportunity_id=o.id WHERE co.conversation_id=?').get(c.id)?.stage;
    const closed=existing?null:c.status==='resolved'?'La conversación está cerrada':['ganada','perdida'].includes(stage)?'La oportunidad ya está cerrada ('+stage+'). Abre una nueva conversación para otra venta':null;
    // Cupón opcional: se prueba con las mismas reglas que al crear el pedido; si no aplica, se dice por qué (no es un error de la vista previa).
    let coupon=null,couponError=null;if(couponCode&&coupons&&!ctx.reason){try{const q=coupons.validate({brandId:c.brand_id,courseId:c.course_id,editionId:ctx.edition.id,contactId:db.prepare('SELECT o.contact_id FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id=?').get(c.id)?.contact_id||'',baseCents:ctx.priceCents,code:couponCode});coupon={code:q.coupon.code,name:q.coupon.name,discountCents:q.discountCents,discountLabel:money(q.discountCents,ctx.currency),finalCents:q.finalCents,finalLabel:money(q.finalCents,ctx.currency)};}catch(e){if(!e.status)throw e;couponError=e.message;}}
    return {coupon,couponError,enabled:Boolean(s.enabled),reason:ctx.reason||closed||null,course:ctx.course.title,edition:ctx.edition.name,promotion:ctx.promotion?.name||null,amountCents:ctx.priceCents,amountLabel:money(ctx.priceCents,ctx.currency),currency:ctx.currency,linkHours:s.link_hours,sessionPriceCents:ctx.edition.session_price_cents>0?ctx.edition.session_price_cents:null,sessionPriceLabel:ctx.edition.session_price_cents>0?money(ctx.edition.session_price_cents,ctx.currency):null,existing:existing?view(existing):null};
  }

  const view=o=>{const n=names(o),s=sessionOf(o);return {...o,courseTitle:n.course,editionName:n.edition,promotionName:n.promotion,contactName:n.contact,amountLabel:money(o.amount_cents,o.currency),statusLabel:STATUS[o.status],methodLabel:o.method?METHODS[o.method]:null,couponCode:o.coupon_code||null,discountLabel:o.discount_cents>0?money(o.discount_cents,o.currency):null,planLabel:planLabel(o),sessionNumber:s?.number||null,sessionTitle:s?.title||null,link:linkFor(o),pendingReceipts:db.prepare("SELECT count(*) n FROM receipts WHERE order_id=? AND status='pending'").get(o.id).n};};
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
    const fresh=get(o.id),s=sessionOf(o);return {id:o.id,reference:o.reference,status:fresh.status,statusLabel:STATUS[fresh.status],amountLabel:money(o.amount_cents,o.currency),coupon:o.coupon_code&&o.discount_cents>0?{code:o.coupon_code,discountLabel:money(o.discount_cents,o.currency)}:null,course:n.course,edition:n.edition,promotion:n.promotion,brand:brand?.name,kind:o.kind,plan:o.plan,planLabel:planLabel(o),session:s?{number:s.number,title:s.title,startsAt:s.starts_at}:null,expiresAt:o.expires_at,conversationId:o.conversation_id,checkoutUrl:fresh.checkout_url&&!fresh.checkout_url.includes('/?pay=')?fresh.checkout_url:null,methods:Object.entries(METHODS).map(([id,label])=>({id,label}))};
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
      if(x[2]==='preview'&&req.method==='GET'){json(res,200,preview(c,user,coupons?.normalizeCode(url.searchParams.get('coupon')||'')||''));return true;}
      if(!x[2]&&req.method==='POST'){const input=await body(req),made=sendLink(c,user,{resend:Boolean(input.resend),plan:input.plan==='per_session'?'per_session':'full',coupon:coupons?.normalizeCode(input.coupon||'')||null});json(res,made.created?201:200,{order:view(made.order),created:made.created});return true;}
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
  return {handle,settings,createOrder,linkMessage,confirm,attachReceipt,tick,openOrder,view,list,useConnector,providerEvent,createSessionOrder,sendSessionLink,voidSessionOrders};
}
