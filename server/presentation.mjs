// Modo presentación (Fase 1 · bloque 5). Un tablero para contar el proyecto con cifras reales del laboratorio y un guion
// guiado con comprobaciones en vivo de lo que hace falta tener listo antes de mostrar cada paso. Sólo lee la base; las
// tarifas por mensaje son una ESTIMACIÓN editable por entorno (MESSAGE_RATES), nunca una factura.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const DAY=86400000;
const percentile=(sorted,p)=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]:null;
const dist=values=>{const s=[...values].sort((a,b)=>a-b);return {count:s.length,medianMs:percentile(s,.5),p90Ms:percentile(s,.9)};};
const rate=(a,b)=>b?Math.round(a/b*1000)/10:null;
// MXN por mensaje entregado, orientativo: el proveedor oficial cobra por categoría y el servicio dentro de la ventana no se cobra.
export const DEFAULT_RATES={marketing:0.80,utility:0.16,service:0};
export function parseRates(text){
  const out={...DEFAULT_RATES};
  for(const part of String(text||'').split(',')){const [k,v]=part.split('=').map(x=>x&&x.trim());if(k in out&&v!==undefined&&Number.isFinite(Number(v))&&Number(v)>=0)out[k]=Number(v);}
  return out;
}
const money=(n,currency='MXN')=>new Intl.NumberFormat('es-MX',{style:'currency',currency}).format(n);

export function createPresentation({db,crm,json,now=Date.now,env=process.env}){
  const ph=ids=>ids.map(()=>'?').join(',')||'NULL';
  function period(params){const days=Number(params.get('days')||30);if(!Number.isInteger(days)||days<1||days>366)throw fail(400,'Elige un periodo de 1 a 366 días.');return {from:now()-days*DAY,to:now(),days};}
  function scope(user,brand){const allowed=crm.brandsFor(user).map(b=>b.id);if(brand&&brand!=='all'){if(!allowed.includes(brand))throw fail(404,'Marca no disponible.');return [brand];}return allowed;}

  function build(user,params){
    const p=period(params),brand=params.get('brand')||null,ids=scope(user,brand),q=ph(ids),rates=parseRates(env.MESSAGE_RATES),t0=now();
    const brandName=Object.fromEntries(db.prepare('SELECT id,name FROM brands').all().map(b=>[b.id,b.name]));
    const convs=db.prepare(`SELECT c.id,c.brand_id,c.channel,c.status,c.created_at,c.referral,
      (SELECT MIN(created_at) FROM messages m WHERE m.conversation_id=c.id AND m.sender_kind='customer') first_customer,
      (SELECT MIN(created_at) FROM messages m WHERE m.conversation_id=c.id AND m.sender_kind='automation') first_bot,
      (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_kind='automation') bot_n,
      (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_kind='agent') human_n,
      (SELECT o.stage FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id=c.id) stage
      FROM conversations c WHERE c.brand_id IN (${q}) AND c.created_at>=? AND c.created_at<?`).all(...ids,p.from,p.to);
    const withOutbound=convs.filter(c=>c.bot_n||c.human_n),auto=withOutbound.filter(c=>c.bot_n&&!c.human_n),human=withOutbound.filter(c=>c.human_n);
    const botTimes=convs.filter(c=>c.first_customer&&c.first_bot&&c.first_bot>=c.first_customer).map(c=>c.first_bot-c.first_customer);
    const humanResponses=db.prepare(`SELECT details FROM operation_events WHERE kind='response' AND brand_id IN (${q}) AND created_at>=? AND created_at<?`).all(...ids,p.from,p.to).map(r=>JSON.parse(r.details)).filter(r=>r.kind==='first'&&r.respondedAt&&r.waitingSince);
    const humanTimes=humanResponses.map(r=>Math.max(0,r.respondedAt-r.waitingSince));

    const paid=db.prepare(`SELECT brand_id,amount_cents,currency,paid_at,source,method FROM orders WHERE status='paid' AND brand_id IN (${q}) AND paid_at>=? AND paid_at<?`).all(...ids,p.from,p.to);
    const open=db.prepare(`SELECT status,count(*) n FROM orders WHERE brand_id IN (${q}) AND status IN ('pending','review') GROUP BY status`).all(...ids);
    const amount=paid.reduce((n,o)=>n+o.amount_cents,0),currency=paid[0]?.currency||'MXN';
    const sales={paid:paid.length,amountCents:amount,amountLabel:money(amount/100,currency),pending:open.find(o=>o.status==='pending')?.n||0,review:open.find(o=>o.status==='review')?.n||0,
      byMethod:Object.fromEntries(['card','oxxo','transfer'].map(m=>[m,paid.filter(o=>o.method===m).length])),bySource:{bot:paid.filter(o=>o.source==='bot').length,agent:paid.filter(o=>o.source==='agent').length},
      enrollments:db.prepare(`SELECT count(*) n FROM enrollments WHERE brand_id IN (${q}) AND created_at>=? AND created_at<?`).get(...ids,p.from,p.to).n,conversion:rate(paid.length,convs.length)};

    const outbound=db.prepare(`SELECT m.category,m.delivery_state,count(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.brand_id IN (${q}) AND m.sender_kind IN ('agent','automation') AND m.created_at>=? AND m.created_at<? GROUP BY m.category,m.delivery_state`).all(...ids,p.from,p.to);
    const byCategory=['service','utility','marketing'].map(cat=>{const rows=outbound.filter(r=>(r.category||'service')===cat),n=rows.reduce((s,r)=>s+r.n,0),billable=rows.filter(r=>r.delivery_state!=='failed').reduce((s,r)=>s+r.n,0);return {category:cat,messages:n,billable,rate:rates[cat],costEstimate:Math.round(billable*rates[cat]*100)/100};});
    const inbound=db.prepare(`SELECT count(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.brand_id IN (${q}) AND m.sender_kind='customer' AND m.created_at>=? AND m.created_at<?`).get(...ids,p.from,p.to).n;
    const delivery=Object.fromEntries(['sent','delivered','read','failed'].map(s=>[s,outbound.filter(r=>r.delivery_state===s).reduce((n,r)=>n+r.n,0)]));
    const cost=Math.round(byCategory.reduce((n,c)=>n+c.costEstimate,0)*100)/100;
    const messages={inbound,outbound:outbound.reduce((n,r)=>n+r.n,0),byCategory,costEstimate:cost,costLabel:money(cost),rates,delivery,channelEnabled:db.prepare(`SELECT count(*) n FROM channel_settings WHERE enabled=1 AND brand_id IN (${q})`).get(...ids).n};

    const replyRows=db.prepare(`SELECT action,intent,count(*) n FROM reply_log WHERE brand_id IN (${q}) AND created_at>=? AND created_at<? GROUP BY action,intent`).all(...ids,p.from,p.to);
    const intents={};for(const r of replyRows)intents[r.intent]=(intents[r.intent]||0)+r.n;
    const replies={byAction:Object.fromEntries(['replied','suggested','escalated','skipped'].map(a=>[a,replyRows.filter(r=>r.action===a).reduce((n,r)=>n+r.n,0)])),topIntents:Object.entries(intents).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([intent,n])=>({intent,n})),
      knowledgeApproved:db.prepare(`SELECT count(*) n FROM knowledge_entries WHERE status='approved' AND brand_id IN (${q})`).get(...ids).n,modes:Object.fromEntries(db.prepare(`SELECT mode,count(*) n FROM reply_settings WHERE brand_id IN (${q}) GROUP BY mode`).all(...ids).map(r=>[r.mode,r.n]))};

    const byBrand=ids.map(id=>{const list=convs.filter(c=>c.brand_id===id),wo=list.filter(c=>c.bot_n||c.human_n),a=wo.filter(c=>c.bot_n&&!c.human_n),sold=paid.filter(o=>o.brand_id===id);return {id,name:brandName[id],conversations:list.length,autoRate:rate(a.length,wo.length),waiting:list.filter(c=>c.status==='waiting').length,won:list.filter(c=>c.stage==='ganada').length,paid:sold.length,amountCents:sold.reduce((n,o)=>n+o.amount_cents,0)};}).filter(b=>b.conversations||b.paid).sort((a,b)=>b.amountCents-a.amountCents||b.conversations-a.conversations);

    const demo={runs:db.prepare('SELECT count(*) n FROM simulator_runs WHERE created_at>=? AND created_at<?').get(p.from,p.to).n,actors:db.prepare('SELECT count(*) n FROM simulator_actors a JOIN simulator_runs r ON r.id=a.run_id WHERE r.created_at>=? AND r.created_at<?').get(p.from,p.to).n,running:db.prepare("SELECT count(*) n FROM simulator_runs WHERE state='running'").get().n};
    const catalogue={brands:db.prepare('SELECT count(*) n FROM brands').get().n,courses:db.prepare('SELECT count(*) n FROM courses WHERE active=1').get().n,editions:db.prepare("SELECT count(*) n FROM editions WHERE status='published' AND (starts_at IS NULL OR starts_at>?)").get(t0).n};
    const count=sql=>db.prepare(sql.replaceAll('{q}',q)).get(...ids).n;
    const certificates={issued:count("SELECT count(*) n FROM certificates WHERE status='issued' AND brand_id IN ({q})"),revoked:count("SELECT count(*) n FROM certificates WHERE status='revoked' AND brand_id IN ({q})"),verifications:count("SELECT COALESCE(sum(verifications),0) n FROM certificates WHERE brand_id IN ({q})"),autoBrands:count("SELECT count(*) n FROM certificate_settings WHERE auto_issue=1 AND brand_id IN ({q})")};
    const coordination={active:count("SELECT count(*) n FROM editions WHERE run_status IN ('open','running') AND brand_id IN ({q})"),withMinimum:count("SELECT count(*) n FROM editions WHERE min_students>0 AND status!='archived' AND brand_id IN ({q})"),upcoming:db.prepare(`SELECT count(*) n FROM edition_sessions WHERE status='scheduled' AND starts_at>=? AND brand_id IN (${q})`).get(t0,...ids).n,held:db.prepare(`SELECT count(*) n FROM edition_sessions WHERE status='done' AND brand_id IN (${q})`).get(...ids).n,events:db.prepare(`SELECT count(*) n FROM domain_events WHERE brand_id IN (${q}) AND created_at>=? AND created_at<?`).get(...ids,p.from,p.to).n};

    const steps=[
      {id:'cliente',title:'La experiencia del cliente',show:{view:'inbox',mode:'customer'},say:'Un interesado escribe por WhatsApp, Instagram o Facebook (simulados) desde el anuncio o el flyer; elige curso y edición vigentes del catálogo.',ready:catalogue.editions>0,detail:catalogue.editions+' ediciones publicadas · '+catalogue.courses+' cursos · '+catalogue.brands+' marcas'},
      {id:'bienvenida',title:'Respuesta inmediata con datos vigentes',show:{view:'inbox'},say:'La bienvenida llega en menos de dos segundos con precio, fecha y flyer tomados del catálogo; con el canal activo trae botones de respuesta rápida.',ready:botTimes.length>0,detail:botTimes.length?'Primera respuesta automática: mediana '+Math.round((dist(botTimes).medianMs||0)/100)/10+' s':'Todavía no hay respuestas automáticas en el periodo'},
      {id:'conocimiento',title:'Conocimiento aprobado, no inventado',show:{view:'courses',tab:'knowledge'},say:'Certificado, pagos, requisitos, grabaciones: responde sólo con entradas que administración aprobó; lo que no sabe lo escala a una persona.',ready:replies.knowledgeApproved>0,detail:replies.knowledgeApproved+' entradas aprobadas · escaladas en el periodo: '+replies.byAction.escalated},
      {id:'persona',title:'Cuando hace falta una persona',show:{view:'operations',tab:'queue'},say:'Quejas, pagos reportados y preguntas fuera de guion entran a la cola con prioridad, objetivo de respuesta y reparto por capacidad.',ready:true,detail:convs.filter(c=>c.status==='waiting').length+' chats esperando ahora · '+human.length+' atendidos por personas en el periodo'},
      {id:'demo',title:'Volumen real con el simulador',show:{view:'operations',tab:'demo'},say:'Clientes ficticios con nueve guiones escriben por la misma API: se ve la bandeja llenarse y las cifras moverse en vivo.',ready:demo.runs>0,detail:demo.runs+' demos en el periodo · '+demo.actors+' clientes simulados · '+demo.running+' en curso'},
      {id:'canal',title:'Así se comportará el canal oficial',show:{view:'operations',tab:'recipes'},say:'Estados enviado/entregado/leído, fallos con reintento, ventana de 24 h fuera de la cual sólo pasan plantillas, y costo estimado por categoría.',ready:messages.channelEnabled>0,detail:messages.channelEnabled+' marcas con canal simulado · '+delivery.failed+' mensajes fallidos en el periodo'},
      {id:'venta',title:'Cobrar sin salir del chat',show:{view:'operations',tab:'payments'},say:'El equipo o el motor generan el pedido con el precio vigente; el cliente paga con tarjeta u OXXO simulados o manda su comprobante, que una persona valida.',ready:count("SELECT count(*) n FROM payment_settings WHERE enabled=1 AND brand_id IN ({q})")>0,detail:sales.pending+' pedidos pendientes · '+sales.review+' comprobantes por revisar'},
      {id:'pagos',title:'Pago confirmado → inscripción',show:{view:'operations',tab:'payments'},say:'Al confirmar: inscripción, cupo descontado, oportunidad ganada, aviso al coordinador y mensaje al cliente. Todo con bitácora.',ready:sales.paid>0,detail:sales.paid+' pagos en el periodo · '+sales.amountLabel+' · '+sales.enrollments+' inscripciones'},
      {id:'coordinacion',title:'Apertura, sesiones y asistencia',show:{view:'operations',tab:'coordination'},say:'La inscripción entra sola a la apertura de la edición; al llegar al mínimo se abre, se programan sesiones con enlace de videollamada, se recuerda a los inscritos y se registra asistencia. Cada paso deja su evento en la bitácora común.',ready:coordination.active>0||coordination.upcoming>0,detail:coordination.active+' aperturas abiertas o en curso · '+coordination.upcoming+' sesiones programadas · '+coordination.held+' realizadas · '+coordination.events+' eventos en el periodo'},
      {id:'certificado',title:'Certificado verificable',show:{view:'operations',tab:'certificates'},say:'Al cerrar la apertura, cada inscrito con la asistencia mínima recibe su certificado con folio IPCI secuencial y código QR; cualquiera lo verifica en público sin iniciar sesión, y el alumno lo recibe por su chat.',ready:certificates.issued>0,detail:certificates.issued+' certificados vigentes · '+certificates.revoked+' revocados · '+certificates.verifications+' verificaciones públicas · '+certificates.autoBrands+' marcas con emisión automática'},
      {id:'recetas',title:'Seguimiento automático y editable',show:{view:'operations',tab:'recipes'},say:'Si el cliente calla, una receta publicada le escribe con plantilla aprobada, crea tarea y avisa; se simula antes de publicar y respeta consentimiento y tope de frecuencia.',ready:count("SELECT count(*) n FROM automation_recipes WHERE status='published' AND brand_id IN ({q})")>0,detail:count("SELECT count(*) n FROM automation_recipes WHERE brand_id IN ({q})")+' recetas en total'},
      {id:'tablero',title:'Resultados y lo que falta',show:{view:'analytics'},say:'Cierra con este tablero: % resuelto sin intervención, tiempos máquina vs humano, ventas por marca y costo estimado; y el plan: Meta, pasarela real, IA con clave, IPCIL nuevo.',ready:true,detail:'Analítica comercial y modo presentación'},
    ];
    return {period:{from:p.from,to:p.to,days:p.days},scope:{brand:brand&&brand!=='all'?brand:null,brands:ids.map(id=>({id,name:brandName[id]}))},
      totals:{conversations:convs.length,withOutbound:withOutbound.length,autoHandled:auto.length,humanHandled:human.length,autoRate:rate(auto.length,withOutbound.length),waiting:convs.filter(c=>c.status==='waiting').length,resolved:convs.filter(c=>c.status==='resolved').length,fromAds:convs.filter(c=>c.referral).length,
        byChannel:['whatsapp','instagram','facebook'].map(ch=>({channel:ch,n:convs.filter(c=>c.channel===ch).length}))},
      response:{bot:dist(botTimes),human:dist(humanTimes)},sales,messages,replies,byBrand,demo,catalogue,coordination,certificates,script:steps,readySteps:steps.filter(s=>s.ready).length,
      notes:['Cifras del laboratorio: ventas, inscripciones y costos son de práctica.','El costo por mensaje es una estimación con tarifas orientativas (MESSAGE_RATES); el proveedor real cobrará según su tarifario vigente.','«Sin intervención humana» = conversaciones con respuestas automáticas y ningún mensaje de una persona en el periodo.']};
  }
  async function handle(req,res,path,user){
    if(path!=='/api/presentation')return false;
    if(req.method!=='GET')throw fail(405,'Método no permitido.');
    const current=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if(!current||current.disabled||!['admin','agent'].includes(current.role))throw fail(403,'El modo presentación es para el equipo de atención.');
    json(res,200,build({...user,role:current.role},new URL(req.url,'http://localhost').searchParams));return true;
  }
  return {handle,build};
}
