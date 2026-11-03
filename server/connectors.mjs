import {createHmac,timingSafeEqual,randomBytes,randomUUID} from 'node:crypto';

// Contrato de conectores (Fase 1 · bloque 6). Define la interfaz que tendrán los proveedores reales de canal (Meta:
// WhatsApp Cloud API, Instagram, Messenger) y de pago (Stripe, Conekta), y la cumple hoy con adaptadores simulados.
// El CRM sólo habla con esta interfaz: cuando una consultora entregue sus accesos se cambia el proveedor por entorno
// (CHANNEL_CONNECTOR / PAYMENT_CONNECTOR) sin tocar el resto del código. Los webhooks entran por rutas públicas,
// se verifica su firma con el secreto del proveedor, se traducen a eventos normalizados y se aplican una sola vez.
//
// Eventos normalizados (lo que el resto del CRM entiende):
//   {id, type:'message.status',  data:{providerRef, state:'sent'|'delivered'|'read'|'failed', reason?, at?}}
//   {id, type:'message.inbound', data:{channel, from, text, providerRef, referral?}}   (se registra; el laboratorio no mapea identidades)
//   {id, type:'payment.succeeded', data:{orderId?|reference?, providerRef, method?, amountCents?}}
//   {id, type:'payment.failed',    data:{orderId?|reference?, providerRef, reason?}}
export const CONTRACT_VERSION='1.0';
const fail=(status,message)=>Object.assign(new Error(message),{status});
const hex=n=>randomBytes(n).toString('hex');
export const FAILURES=['El número no está disponible en el canal simulado','El proveedor simulado rechazó el mensaje por límite de velocidad','Tiempo de espera agotado en el proveedor simulado'];
export function hmacHex(secret,raw){return createHmac('sha256',String(secret)).update(raw).digest('hex');}
function safeEqual(a,b){const x=Buffer.from(String(a||''),'utf8'),y=Buffer.from(String(b||''),'utf8');return x.length>0&&x.length===y.length&&timingSafeEqual(x,y);}
const missingOf=(env,names)=>names.filter(n=>!String(env[n]||'').trim());

// Qué debe entregar cada consultora (o el equipo técnico) para encender un proveedor real. Es la fuente de docs/CONECTORES.md.
export const REQUIREMENTS={
  meta:{label:'Meta · WhatsApp Cloud API, Instagram y Messenger',kind:'channel',items:[
    {env:'META_ACCESS_TOKEN',title:'Token permanente de usuario de sistema',who:'Consultora (administrador del Business Manager)',note:'Con permisos whatsapp_business_messaging, whatsapp_business_management, pages_messaging e instagram_manage_messages, asignado a la WABA, la página y la cuenta de Instagram.'},
    {env:'META_APP_SECRET',title:'Secreto de la app de Meta',who:'Equipo técnico',note:'Con él se verifica la firma X-Hub-Signature-256 de cada webhook.'},
    {env:'META_VERIFY_TOKEN',title:'Token de verificación del webhook',who:'Equipo técnico',note:'Cadena que elegimos nosotros; Meta la repite al registrar la URL del webhook.'},
    {env:'META_PHONE_NUMBER_ID',title:'ID del número de WhatsApp',who:'Consultora',note:'Número dedicado (no puede seguir en la app WhatsApp Business del celular), con nombre para mostrar aprobado.'},
    {env:'META_WABA_ID',title:'ID de la cuenta de WhatsApp Business (WABA)',who:'Consultora',note:'Empresa verificada en Business Manager; plantillas de utilidad y marketing enviadas a aprobación.'},
    {env:'META_PAGE_ID',title:'ID de la página de Facebook',who:'Consultora',note:'Página conectada a la app, con la pestaña de mensajes habilitada.'},
    {env:'META_IG_ACCOUNT_ID',title:'ID de la cuenta profesional de Instagram',who:'Consultora',note:'Cuenta profesional vinculada a la página; «Permitir acceso a mensajes» activado en la app de Instagram.'},
  ],notes:['La ventana de servicio de 24 h y las categorías de plantilla ya se simulan igual que en Meta: el equipo no notará el cambio de reglas.','Cada marca puede tener su propio número/página; el CRM guarda alcance por marca.','Meta cobra por mensaje según categoría; el costo estimado del modo presentación usa tarifas orientativas.']},
  stripe:{label:'Stripe · tarjeta, OXXO y SPEI',kind:'payment',items:[
    {env:'STRIPE_SECRET_KEY',title:'Clave secreta (modo prueba primero)',who:'Consultora o administración',note:'Cuenta Stripe de la razón social que factura; sk_test_… para ensayar, sk_live_… para cobrar.'},
    {env:'STRIPE_WEBHOOK_SECRET',title:'Secreto del endpoint de webhook',who:'Equipo técnico',note:'whsec_… del endpoint registrado para checkout.session.completed y pagos fallidos.'},
  ],notes:['Los métodos OXXO y SPEI se habilitan en el panel de Stripe (México).','El CRM crea la sesión de pago con la referencia del pedido en metadata y confirma sólo con el webhook firmado, nunca con el regreso del navegador.']},
  conekta:{label:'Conekta · tarjeta, OXXO Pay y SPEI',kind:'payment',items:[
    {env:'CONEKTA_PRIVATE_KEY',title:'Llave privada (sandbox primero)',who:'Consultora o administración',note:'Cuenta Conekta de la razón social que factura.'},
    {env:'CONEKTA_WEBHOOK_SECRET',title:'Secreto del webhook',who:'Equipo técnico',note:'La verificación de firma de Conekta se confirma con su documentación vigente al activar.'},
  ],notes:['Alternativa mexicana a Stripe; se decide por comisiones y facturación de cada consultora.']},
  simulated:{label:'Simulado (laboratorio)',kind:'ambos',items:[
    {env:'CONNECTOR_WEBHOOK_SECRET',title:'Secreto para firmar webhooks de prueba',who:'Equipo técnico',note:'Opcional. Con él se pueden enviar eventos firmados a /api/webhooks/*/simulated (y el botón «Probar webhook» funciona); sin él esas rutas responden 404.'},
  ],notes:['Nada sale a internet: entregas, lecturas y pagos se simulan dentro del servidor.']},
};

// ---- Adaptadores de canal
export function simulatedChannel({env}){
  return {provider:'simulated',kind:'channel',channels:['whatsapp','instagram','facebook'],capabilities:{templates:true,buttons:true,media:true,readReceipts:true,referral:true,inboundWebhook:true},
    configured:true,missing:[],webhooksEnabled:()=>Boolean(env.CONNECTOR_WEBHOOK_SECRET),
    async send(m){const failed=Math.random()*100<(m.failureRate||0);return {providerRef:'simch_'+hex(6),state:failed?'failed':'delivered',reason:failed?FAILURES[Math.floor(Math.random()*FAILURES.length)]:null};},
    verifyWebhook:(headers,raw)=>Boolean(env.CONNECTOR_WEBHOOK_SECRET)&&safeEqual(headers['x-lab-signature'],hmacHex(env.CONNECTOR_WEBHOOK_SECRET,raw)),
    parseWebhook(body){const list=Array.isArray(body?.events)?body.events:body?.type?[body]:[];return list.map(e=>({id:String(e.id||''),type:String(e.type||''),data:e.data&&typeof e.data==='object'?e.data:{}}));},
    challenge:()=>null};
}
export function metaChannel({env}){
  const missing=missingOf(env,['META_ACCESS_TOKEN','META_APP_SECRET','META_VERIFY_TOKEN','META_PHONE_NUMBER_ID','META_WABA_ID']);
  const STATE={sent:'sent',delivered:'delivered',read:'read',failed:'failed'};
  return {provider:'meta',kind:'channel',channels:['whatsapp','instagram','facebook'],capabilities:{templates:true,buttons:true,media:true,readReceipts:true,referral:true,inboundWebhook:true},
    configured:missing.length===0,missing,webhooksEnabled:()=>Boolean(env.META_APP_SECRET),
    async send(){if(missing.length)throw fail(503,'Conector de Meta sin configurar: faltan '+missing.join(', ')+'.');throw fail(501,'El envío real por la Cloud API se habilita con los accesos de la consultora; mientras tanto se usa el simulado.');},
    verifyWebhook:(headers,raw)=>Boolean(env.META_APP_SECRET)&&safeEqual(headers['x-hub-signature-256'],'sha256='+hmacHex(env.META_APP_SECRET,raw)),
    // Traduce el formato de Meta (entry[].changes[].value.statuses[] / messages[]) a eventos normalizados.
    parseWebhook(body){
      const out=[];
      for(const entry of body?.entry||[])for(const change of entry.changes||[]){const v=change.value||{};
        for(const s of v.statuses||[])out.push({id:s.id+':'+s.status,type:'message.status',data:{providerRef:s.id,state:STATE[s.status]||'sent',reason:s.errors?.[0]?.title||s.errors?.[0]?.message||null,at:s.timestamp?Number(s.timestamp)*1000:null}});
        for(const m of v.messages||[])out.push({id:m.id,type:'message.inbound',data:{channel:change.field==='messages'?'whatsapp':(change.field||'whatsapp'),from:m.from,text:m.text?.body||m.button?.text||m.interactive?.button_reply?.title||'',providerRef:m.id,referral:m.referral?{source:'ad',ad:m.referral.headline||m.referral.source_id||'anuncio',campaign:m.referral.source_type||null,headline:m.referral.body||null}:null}});
      }
      return out;
    },
    challenge(params){return params.get('hub.mode')==='subscribe'&&env.META_VERIFY_TOKEN&&safeEqual(params.get('hub.verify_token'),env.META_VERIFY_TOKEN)?params.get('hub.challenge'):null;}};
}
// ---- Adaptadores de pago
export function simulatedPayment({env}){
  return {provider:'simulated',kind:'payment',capabilities:{card:true,oxxo:true,spei:false,transferReceipt:true,refunds:false},
    configured:true,missing:[],webhooksEnabled:()=>Boolean(env.CONNECTOR_WEBHOOK_SECRET),
    async prepareCheckout(order){return {providerRef:'simpay_'+hex(6),url:(env.APP_ORIGIN||'').replace(/\/$/,'')+'/?pay='+order.id};},
    verifyWebhook:(headers,raw)=>Boolean(env.CONNECTOR_WEBHOOK_SECRET)&&safeEqual(headers['x-lab-signature'],hmacHex(env.CONNECTOR_WEBHOOK_SECRET,raw)),
    parseWebhook(body){const list=Array.isArray(body?.events)?body.events:body?.type?[body]:[];return list.map(e=>({id:String(e.id||''),type:String(e.type||''),data:e.data&&typeof e.data==='object'?e.data:{}}));},
    challenge:()=>null};
}
export function stripePayment({env,now=Date.now,toleranceMs=5*60000}){
  const missing=missingOf(env,['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET']);
  return {provider:'stripe',kind:'payment',capabilities:{card:true,oxxo:true,spei:true,transferReceipt:true,refunds:true},
    configured:missing.length===0,missing,webhooksEnabled:()=>Boolean(env.STRIPE_WEBHOOK_SECRET),
    async prepareCheckout(){if(missing.length)throw fail(503,'Conector de Stripe sin configurar: faltan '+missing.join(', ')+'.');throw fail(501,'La sesión de pago real se crea con la clave de la consultora; mientras tanto se usa el simulado.');},
    // Stripe-Signature: t=<unix>,v1=<hmac(secret, `${t}.${raw}`)>
    verifyWebhook(headers,raw){const parts=Object.fromEntries(String(headers['stripe-signature']||'').split(',').map(p=>p.split('=')));if(!env.STRIPE_WEBHOOK_SECRET||!parts.t||!parts.v1)return false;if(Math.abs(now()-Number(parts.t)*1000)>toleranceMs)return false;return safeEqual(parts.v1,hmacHex(env.STRIPE_WEBHOOK_SECRET,Buffer.concat([Buffer.from(parts.t+'.'),Buffer.isBuffer(raw)?raw:Buffer.from(String(raw))])));},
    parseWebhook(body){
      const o=body?.data?.object||{},meta=o.metadata||{},base={orderId:meta.orderId||null,reference:meta.reference||null,providerRef:o.id||body?.id||null};
      if(body?.type==='checkout.session.completed'||body?.type==='checkout.session.async_payment_succeeded')return [{id:body.id,type:'payment.succeeded',data:{...base,method:(o.payment_method_types||[])[0]==='oxxo'?'oxxo':'card',amountCents:o.amount_total??null}}];
      if(body?.type==='checkout.session.async_payment_failed'||body?.type==='payment_intent.payment_failed')return [{id:body.id,type:'payment.failed',data:{...base,reason:o.last_payment_error?.message||'Pago no completado'}}];
      return [];
    },
    challenge:()=>null};
}
export function conektaPayment({env}){
  const missing=missingOf(env,['CONEKTA_PRIVATE_KEY','CONEKTA_WEBHOOK_SECRET']);
  return {provider:'conekta',kind:'payment',capabilities:{card:true,oxxo:true,spei:true,transferReceipt:true,refunds:true},
    configured:missing.length===0,missing,webhooksEnabled:()=>false,
    async prepareCheckout(){throw fail(missing.length?503:501,missing.length?'Conector de Conekta sin configurar: faltan '+missing.join(', ')+'.':'La orden real se crea con la llave de la consultora; mientras tanto se usa el simulado.');},
    verifyWebhook:()=>false,   // la verificación de firma de Conekta se implementa al activar, con su documentación vigente
    parseWebhook(body){const o=body?.data?.object||{},meta=o.metadata||{};if(body?.type==='order.paid')return [{id:body.id,type:'payment.succeeded',data:{orderId:meta.orderId||null,reference:meta.reference||null,providerRef:o.id||null,method:o.charges?.data?.[0]?.payment_method?.type==='oxxo'?'oxxo':'card',amountCents:o.amount??null}}];if(body?.type==='order.expired'||body?.type==='charge.declined')return [{id:body.id,type:'payment.failed',data:{orderId:meta.orderId||null,reference:meta.reference||null,providerRef:o.id||null,reason:'Pago no completado'}}];return [];},
    challenge:()=>null};
}

export function createConnectors({db,env=process.env,channel,payments,body,json,audit,rate,selfOrigin,now=Date.now,log=console}){
  const channelProvider=['simulated','meta'].includes(env.CHANNEL_CONNECTOR)?env.CHANNEL_CONNECTOR:'simulated';
  const paymentProvider=['simulated','stripe','conekta'].includes(env.PAYMENT_CONNECTOR)?env.PAYMENT_CONNECTOR:'simulated';
  const adapters={channel:{simulated:simulatedChannel({env}),meta:metaChannel({env})},payment:{simulated:simulatedPayment({env}),stripe:stripePayment({env,now}),conekta:conektaPayment({env})}};
  const selected={channel:adapters.channel[channelProvider],payment:adapters.payment[paymentProvider]};
  // Un proveedor real sin configurar no rompe el laboratorio: el envío cae al simulado y el estado lo dice claramente.
  const effective=kind=>selected[kind].configured?selected[kind]:adapters[kind].simulated;
  if(selected.channel.provider!=='simulated'&&!selected.channel.configured)log.warn('Conector de canal',selected.channel.provider,'sin configurar: faltan',selected.channel.missing.join(', '),'· se usa el simulado');
  if(selected.payment.provider!=='simulated'&&!selected.payment.configured)log.warn('Conector de pago',selected.payment.provider,'sin configurar: faltan',selected.payment.missing.join(', '),'· se usa el simulado');
  channel.useConnector(()=>effective('channel'));payments.useConnector(()=>effective('payment'));
  const requireAdmin=user=>{const u=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);if(!u||u.disabled||u.role!=='admin')throw fail(403,'Los conectores los administra un administrador.');};
  const describe=kind=>{const s=selected[kind],e=effective(kind);return {selected:s.provider,effective:e.provider,configured:s.configured,missing:s.missing,fallback:s.provider!==e.provider,capabilities:s.capabilities,channels:s.channels||null,webhooksEnabled:s.webhooksEnabled(),webhookPath:'/api/webhooks/'+kind+'/'+s.provider};};
  function status(){
    return {contractVersion:CONTRACT_VERSION,channel:describe('channel'),payment:describe('payment'),requirements:REQUIREMENTS,
      env:{CHANNEL_CONNECTOR:channelProvider,PAYMENT_CONNECTOR:paymentProvider,hasLabSecret:Boolean(env.CONNECTOR_WEBHOOK_SECRET)},
      recentEvents:db.prepare('SELECT kind,provider,event_id,type,result,created_at FROM connector_events ORDER BY seq DESC LIMIT 20').all()};
  }
  // Aplica un evento normalizado una sola vez por (proveedor, id). Devuelve texto legible del resultado.
  function apply(kind,provider,ev){
    if(!ev.id||!ev.type)return {result:'rechazado: evento sin id o tipo'};
    if(db.prepare('SELECT 1 FROM connector_events WHERE provider=? AND event_id=?').get(provider,ev.id))return {result:'duplicado: ya se había procesado',duplicate:true};
    let result;
    try{
      if(kind==='channel'&&ev.type==='message.status'){const r=channel.applyStatus(ev.data);result=r?'aplicado: mensaje '+r:'ignorado: no hay mensaje con esa referencia del proveedor';}
      else if(kind==='channel'&&ev.type==='message.inbound')result='registrado: entrante recibido; el laboratorio no mapea identidades de clientes reales';
      else if(kind==='payment'&&(ev.type==='payment.succeeded'||ev.type==='payment.failed'))result=payments.providerEvent(ev,provider);
      else result='ignorado: tipo de evento no contemplado para este conector';
    }catch(e){result='error: '+String(e?.message||e).slice(0,160);}
    db.prepare('INSERT OR IGNORE INTO connector_events(kind,provider,event_id,type,payload,result,created_at) VALUES(?,?,?,?,?,?,?)').run(kind,provider,String(ev.id).slice(0,200),String(ev.type).slice(0,80),JSON.stringify(ev).slice(0,4000),result,now());
    return {result};
  }
  async function rawBody(req){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>1_000_000)throw fail(413,'Webhook demasiado grande.');chunks.push(c);}return Buffer.concat(chunks);}
  // Rutas públicas (sin sesión ni comprobación de origen): verificación GET y recepción POST firmada.
  async function handlePublic(req,res,path,url,ip){
    const x=path.match(/^\/api\/webhooks\/(channel|payment)\/([a-z]+)$/);if(!x)return false;
    const kind=x[1],adapter=adapters[kind][x[2]];if(!adapter)throw fail(404,'Proveedor no reconocido.');
    rate('webhook:'+ip,600,60000);
    if(req.method==='GET'){const ch=adapter.challenge(url.searchParams);if(ch===null||ch===undefined)throw fail(403,'Verificación rechazada.');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end(String(ch));return true;}
    if(req.method!=='POST')throw fail(405,'Método no permitido.');
    if(!adapter.webhooksEnabled())throw fail(404,'Webhooks desactivados para este proveedor: falta su secreto en el entorno.');
    const raw=await rawBody(req);
    if(!adapter.verifyWebhook(req.headers,raw))throw fail(401,'Firma del webhook no válida.');
    let parsed;try{parsed=JSON.parse(raw.toString('utf8')||'{}');}catch{throw fail(400,'Cuerpo del webhook no válido.');}
    const events=adapter.parseWebhook(parsed),results=events.map(ev=>({id:ev.id,type:ev.type,...apply(kind,x[2],ev)}));
    json(res,200,{received:events.length,results});return true;
  }
  // Prueba firmada desde la interfaz: construye un evento real del laboratorio y lo manda al propio webhook simulado.
  async function test(input,user){
    if(!env.CONNECTOR_WEBHOOK_SECRET)throw fail(409,'Define CONNECTOR_WEBHOOK_SECRET en el entorno para probar webhooks firmados.');
    let kind,ev;
    if(input.kind==='payment'){
      const o=db.prepare('SELECT * FROM orders WHERE id=? OR reference=? ORDER BY created_at DESC LIMIT 1').get(String(input.order||''),String(input.order||'').toUpperCase());if(!o)throw fail(404,'Pedido no encontrado: indica su referencia TC-… o su id.');
      kind='payment';ev={id:'test_'+randomUUID(),type:input.type==='payment.failed'?'payment.failed':'payment.succeeded',data:{orderId:o.id,reference:o.reference,providerRef:'simpay_'+hex(6),method:['card','oxxo'].includes(input.method)?input.method:'card',reason:'Rechazo de prueba'}};
    }else{
      const m=input.message?db.prepare('SELECT id,provider_ref FROM messages WHERE id=? OR provider_ref=?').get(String(input.message),String(input.message)):db.prepare("SELECT id,provider_ref FROM messages WHERE sender_kind IN ('agent','automation') ORDER BY seq DESC LIMIT 1").get();
      if(!m)throw fail(404,'No hay mensajes salientes para probar.');
      const ref=m.provider_ref||('simch_'+hex(6));if(!m.provider_ref)db.prepare('UPDATE messages SET provider_ref=? WHERE id=?').run(ref,m.id);
      kind='channel';ev={id:'test_'+randomUUID(),type:'message.status',data:{providerRef:ref,state:['delivered','read','failed'].includes(input.state)?input.state:'read',reason:input.state==='failed'?'Fallo de prueba':null,at:now()}};
    }
    const raw=JSON.stringify({events:[ev]}),r=await fetch(selfOrigin()+'/api/webhooks/'+kind+'/simulated',{method:'POST',headers:{'Content-Type':'application/json','x-lab-signature':hmacHex(env.CONNECTOR_WEBHOOK_SECRET,raw)},body:raw,signal:AbortSignal.timeout(10000)});
    const data=await r.json().catch(()=>({}));audit(user,'connectors.test',ev.id);
    return {status:r.status,sent:ev,response:data};
  }
  async function handle(req,res,path,user){
    if(!path.startsWith('/api/connectors'))return false;requireAdmin(user);
    if(path==='/api/connectors'&&req.method==='GET'){json(res,200,status());return true;}
    if(path==='/api/connectors/test'&&req.method==='POST'){json(res,200,await test(await body(req),user));return true;}
    throw fail(404,'Ruta de conectores no encontrada.');
  }
  return {status,handle,handlePublic,apply,effective,selected,adapters};
}
