import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';
import {normalize,bestMatch,validateDraft,tokens,stem} from './ai-provider.mjs';
import {seedBrandKnowledge} from './replies-schema.mjs';
import {isOpen,openingLabel} from './service-hours.mjs';
import {rankKnowledge} from './retrieval.mjs';
import {customerMemory} from './memory.mjs';
import * as copy from './reply-copy.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
export const MODES=['off','suggest','templates','autonomous'];
export const INTENTS=['opt_out','human','refund','enroll','payment','price','schedule','syllabus','certificate','requirements','modality','recording','duration','greeting','thanks','unknown'];
const TOPIC_INTENTS=['certificate','payment','requirements','modality','recording','duration'];
// «¿Qué pasa si un día no puedo conectarme a la sesión?» menciona palabras de horario pero pregunta por una SITUACIÓN: se contesta con
// el conocimiento aprobado (o la IA), no con la ficha de fechas del catálogo.
const SITUATION=/\b(que pasa si|y si|si no puedo|no puedo|no alcanzo|no me deja|se me|problema)\b/;
const CATALOGUE_INTENTS=['schedule','syllabus','duration'];
// Un primer mensaje con una pregunta concreta merece respuesta, no sólo la bienvenida.
const looksLikeQuestion=raw=>/[?¿]/.test(raw)||normalize(raw).split(' ').filter(Boolean).length>=6;
// Cada regla: [intención, expresión, confianza, condición opcional sobre el texto normalizado]. El orden importa: gana la primera que coincide.
// Una regla demasiado amplia contesta MAL sin costo («¿vale la pena?» no es una pregunta de precio; «¿qué sabré hacer cuando termine?» no es de
// fechas): ante la duda, la pregunta debe caer en «unknown» y resolverse con el conocimiento aprobado o la IA, no con la ficha equivocada.
const words=t=>t.split(' ').filter(Boolean).length;
const PATTERNS=[
  // «persona» y «alguien» sueltos no piden un asesor («¿aplica para alguien que apenas empieza?»): sólo cuando se pide que alguien atienda.
  ['human',/\b(asesor|asesora|humano|atencion|hablar con|persona real|(con|a) (una|alguna) persona|una persona del equipo|con alguien|alguien (que )?(me )?(atienda|ayude|llame|explique|responda|conteste)|alguien me (puede|podria)|llamenme|llamame|llamada|(pueden|podrian|puedes|podria) (llamar|marcar)(me)?)\b/,.9],
  ['refund',/\b(reembolso|devolucion|devolver|queja|molest|pesimo|fraude|engan)/,.9],
  ['enroll',/\b(inscrib|registr|apuntar|apuntarme|apunto|anotarme|quiero el curso|quiero entrar|quiero tomarlo|me anoto|como me inscribo)/,.85],
  // «¿Cuánto hay que pagar?» pregunta el precio, no una forma de pago: va antes que «payment».
  ['price',/\bcuanto (se |hay que |tengo que |debo |es lo que hay que )?(pag(a|ar|o)|cobran)\b/,.85],
  ['payment',/\b(comprobante|pague|pago|pagos|pagar|transferencia|deposito|tarjeta|oxxo|spei|factura|meses sin intereses)\b/,.85],
  // Duración va antes que precio: «¿cuánto dura?» no es una pregunta de precio. «¿Cuánto tiempo tengo para…?» tampoco es de duración.
  ['duration',/\b(duracion|cuanto dura|cuantas (horas|sesiones|clases|semanas)|cuanto tiempo (dura|es|son|tarda|lleva|toma))\b/,.8],
  ['price',/\b(precio|precios|cuesta|costo|costos|inversion|promo|promos|promocion|promociones|descuento|descuentos|oferta|cuanto (cuesta|vale|sale|es|seria|cobran|me queda|queda)|en cuanto|que vale)\b|^cuanto$/,.85],
  ['schedule',/\b(fecha|fechas|horario|horarios|calendario|empieza|empiezan|inicia|inician|comienza|comienzan|arranca|a que hora|que hora|(que|cual|primer|ultimo|proximo) dias?|cuando (es|son|seria|empieza|empiezan|inicia|inician|comienza|comienzan|arranca|abren|hay|toca)|para cuando|quien (da|dara|imparte|ensena)|docente|docentes|profesor|profesora|maestro|maestra|instructor|ponente)\b|^cuando$/,.8],
  ['syllabus',/\b(temario|incluye|temas?|contenido|que voy a aprender|programa)\b/,.8],
  ['certificate',/\b(certificad|constancia|diploma|aval|validez|reconocimiento)/,.85],
  ['requirements',/\b(requisito|conocimientos previos|necesito saber|que necesito)\b/,.8],
  ['modality',/\b(modalidad|en linea|online|presencial|virtual|zoom|meet|plataforma|donde es|donde se imparte|donde me conecto|como me conecto|por donde (es|son|se da))\b/,.8],
  ['recording',/\b(grabaci|grabad|graban?\b|grabar\b|no puedo asistir|repeticion|ver despues)/,.8],
  ['greeting',/\b(hola|buen[oa]s?|informacion|info|flyer|imagen|me interesa|saludos)\b/,.6],
  // Un agradecimiento no es una pregunta: «¿el curso vale la pena?» debe resolverse con conocimiento o IA, no con «¡con gusto!».
  ['thanks',/\b(gracias|perfecto|ok|vale|listo|entendido)\b/,.5,(t,raw)=>!/vale la pena/.test(t)&&(words(t)<=4||!/[?¿]/.test(raw))],
];

// Motor de respuestas v2. Reglas del proyecto que cumple: precios/fechas/cupos sólo del catálogo; nunca confirma pagos ni
// inscripciones; cada decisión queda en reply_log con intención, fuentes y motivo; las llamadas al proveedor de IA van fuera
// de las transacciones (plan() y commit() son síncronos; el proveedor se consulta entre ambos).
export function createReplies({db,catalogue,crm,contacts,operations,insertMessage,provider,payments=null,content=null,now=Date.now,env=process.env}){
  const TOP_K=Math.max(1,Math.min(20,Number(env.AI_KB_TOP_K)||6));   // entradas de conocimiento que recibe la IA por llamada
  const defaults=brandId=>({brand_id:brandId,mode:'templates',provider_enabled:0,max_unknown:2,revision:0,updated_by:null,updated_at:null});
  const settings=brandId=>db.prepare('SELECT * FROM reply_settings WHERE brand_id=?').get(brandId)||defaults(brandId);
  const entry=id=>typeof id==='string'?db.prepare('SELECT * FROM knowledge_entries WHERE id=?').get(id):null;
  const view=e=>e&&{...e,variants:JSON.parse(e.variants)};
  const approved=(brandId,courseId)=>db.prepare("SELECT * FROM knowledge_entries WHERE brand_id=? AND status='approved' AND (course_id IS NULL OR course_id=?) ORDER BY course_id IS NULL,updated_at DESC").all(brandId,courseId).map(view);

  function classify(raw){
    if(contacts.isOptOutText(raw))return {intent:'opt_out',confidence:.95};
    const t=normalize(raw);
    for(const [intent,re,confidence,when] of PATTERNS)if(re.test(t)&&(!when||when(t,String(raw||''))))return {intent,confidence};
    return {intent:'unknown',confidence:0};
  }
  // Todas las intenciones que aparecen en el mensaje, en el orden de las reglas (para contestar varias preguntas a la vez).
  function classifyAll(raw){
    const t=normalize(raw),found=[];
    for(const [intent,re,,when] of PATTERNS)if(!found.includes(intent)&&re.test(t)&&(!when||when(t,String(raw||''))))found.push(intent);
    return found;
  }
  const unknownStreak=conversationId=>{let n=0;for(const r of db.prepare("SELECT intent,action FROM reply_log WHERE conversation_id=? AND action IN ('replied','suggested') ORDER BY created_at DESC LIMIT 5").all(conversationId)){if(r.intent==='unknown')n++;else break;}return n;};

  // Plan síncrono: decide intención, texto, fuentes y si hace falta el proveedor. No escribe nada.
  function plan(c,trigger){
    const s=settings(c.brand_id),user=db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id),first=(user?.name||'').split(' ')[0];
    const ctx=catalogue.info(c.course_id,c.edition_id),course=ctx.course,cls=classify(trigger.text),situational=CATALOGUE_INTENTS.includes(cls.intent)&&SITUATION.test(normalize(trigger.text)),intent=situational?'unknown':cls.intent,confidence=situational?.3:cls.confidence;
    const count=db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND sender_kind='customer'").get(c.id).n;
    // ¿El cliente pregunta algo concreto? (un tema del conocimiento, o una pregunta sin intención reconocida)
    const asks=TOPIC_INTENTS.includes(intent)||(intent==='unknown'&&looksLikeQuestion(trigger.text));
    const out={mode:s.mode,intent,confidence,reply:'',sources:[],stage:null,handoff:false,prepared:null,reason:'',needsProvider:false,knowledge:[],buttons:null,order:false};
    const catalogueSource={type:'catalogue',courseId:course.id,editionId:ctx.edition.id,promotionId:ctx.promotion?.id||null,priceCents:ctx.priceCents,currency:ctx.currency};
    const kb=approved(c.brand_id,c.course_id);
    // Bienvenida con la ficha vigente del curso (o la de anuncio): saludo, primer mensaje sin pregunta y respaldo del primer mensaje.
    const welcome=()=>{out.prepared=catalogue.prepare(c,{kind:'flyer'});const ad=c.referral&&count===1?content?.render('ad_welcome',c.brand_id,{courseId:course.id,editionId:c.edition_id,name:first}):null;out.reply=ad?ad.text:copy.welcome(ctx,user?.name);out.sources.push(catalogueSource,ad?{type:'template',kind:'ad_welcome',id:ad.templateId}:{type:'template',kind:'welcome'});out.buttons=['Precio','Temario','Fechas'];out.reason=count===1?'Primer mensaje: bienvenida con la ficha vigente del curso.':'Saludo o petición de información: ficha vigente del curso.';};
    // Con un tema reconocido (pago, certificado, grabación…) no se usa una respuesta aprobada de OTRO tema reconocido aunque se parezca en palabras:
    // «¿cuánto tiempo tengo para pagar?» no se contesta con «¿cuánto dura el curso?».
    const pool=TOPIC_INTENTS.includes(intent)?kb.filter(k=>k.topic===intent||!TOPIC_INTENTS.includes(k.topic)):kb;
    const fromKnowledge=(threshold=.5)=>{const hit=bestMatch(trigger.text,pool,threshold)||(TOPIC_INTENTS.includes(intent)?{entry:kb.find(k=>k.topic===intent),score:1}:null);if(!hit?.entry)return false;out.reply=hit.entry.answer;out.sources.push({type:'knowledge',id:hit.entry.id,revision:hit.entry.revision,question:hit.entry.question});out.reason='Conocimiento aprobado «'+hit.entry.question+'»'+(hit.score<1?' (parecido '+Math.round(hit.score*100)+'%)':'')+'.';return true;};
    // Varias preguntas en un mensaje («¿qué temas incluye, y tiene certificado?»): antes sólo se contestaba la primera intención reconocida.
    // Se juntan cuando el mensaje une dos o más preguntas informativas (con «y», coma o un segundo signo de pregunta) y cada una tiene
    // respuesta en el catálogo o en el conocimiento aprobado. Pedir un asesor, una queja, inscribirse o avisar de un pago siguen su camino de siempre.
    const INFO=['price','schedule','syllabus','certificate','requirements','modality','recording','duration','payment'];
    const paidClaim=/comprobante|pague|ya pague|transferi|deposite/.test(normalize(trigger.text));
    const several=()=>{
      if(situational||paidClaim||!INFO.includes(intent))return false;
      // señal de que son dos preguntas y no una: un conector («y», «también»…), una coma o dos signos de cierre de pregunta
      if(!/\b(y|e|tambien|ademas|aparte)\b|[,;]|\?.*\S.*\?/.test(normalize(trigger.text)+' '+trigger.text.toLowerCase()))return false;
      const asked=classifyAll(trigger.text).filter(i=>INFO.includes(i)).slice(0,3);if(asked.length<2)return false;
      const parts=[],sources=[];let kind=null;
      for(const it of asked){
        if(it==='price'){parts.push(copy.priceBody(ctx));kind='price';}
        else if(it==='schedule'){parts.push(copy.scheduleBody(ctx));kind=kind==='price'?kind:'schedule';}
        else if(it==='syllabus'){parts.push(copy.syllabusBody(ctx));kind=kind||'syllabus';}
        else{const entry=kb.find(k=>k.topic===it);if(entry){parts.push(entry.answer);sources.push({type:'knowledge',id:entry.id,revision:entry.revision,question:entry.question});}}
      }
      if(parts.length<2)return false;   // sólo una tenía respuesta: se contesta como siempre
      if(kind){out.prepared=catalogue.prepare(c,{kind});out.sources.push(catalogueSource);}
      out.sources.push(...sources);if(asked.includes('price'))out.stage='interesado';
      out.reply=copy.several(parts,{price:asked.includes('price')});
      out.reason='Varias preguntas en un mensaje ('+asked.join(', ')+'): se contestan juntas con el catálogo vigente y el conocimiento aprobado.';
      return true;
    };
    if(intent==='opt_out'){out.reply='Listo: no volveremos a enviarte mensajes de seguimiento. Si más adelante necesitas ayuda, escríbenos cuando quieras.';out.reason='El cliente pidió la baja; se registra y se confirma una sola vez.';}
    else if(intent==='human'||intent==='refund'){out.reply=intent==='refund'?copy.refund(user?.name):copy.human(user?.name);out.handoff=true;out.reason=intent==='refund'?'Queja o reembolso: siempre lo atiende una persona.':'El cliente pidió hablar con una persona.';}
    else if(ctx.reason){out.reply=copy.unavailable(ctx.reason);out.handoff=true;out.reason='La edición no está disponible según el catálogo.';out.sources.push(catalogueSource);}
    else if(several()){/* varias preguntas: respondidas juntas */}
    else if(intent==='enroll'){
      const open=payments?.openOrder(c.id);
      if(open){out.reply=copy.orderReminder(open.reference)+payments.linkMessage(open);out.stage='inscripcion';out.reason='Ya existía un pedido vigente: se recuerda el enlace de pago.';out.sources.push(catalogueSource);}
      else if(payments?.settings(c.brand_id).enabled){out.order=true;out.reply=copy.enrollWithOrder(ctx,user?.name);out.stage='inscripcion';out.reason='Solicitud de inscripción con venta activa: se genera un pedido con enlace de pago simulado; un comprobante siempre lo valida una persona.';out.sources.push(catalogueSource);}
      else{out.reply=copy.enrollWithAdvisor(ctx,user?.name);out.stage='inscripcion';out.handoff=true;out.reason='Solicitud de inscripción: avanza la etapa y pasa a una persona; nunca se confirma sola.';out.sources.push(catalogueSource);}
    }
    else if(intent==='payment'){
      // Quien avisa que YA pagó no pregunta cómo pagar: se le agradece, se le dice el estado de su pedido y pasa a una persona, que es quien valida.
      // Nunca se confirma un pago desde aquí.
      if(/comprobante|pague|ya pague|transferi|deposite/.test(normalize(trigger.text))){
        const open=payments?.openOrder(c.id);
        out.reply='Gracias por avisar. Una persona del equipo revisará tu pago y te confirmará por aquí; no confirmamos pagos de forma automática.'+(open?' Tu pedido '+open.reference+(open.status==='review'?' ya está en revisión.':' todavía aparece sin pago confirmado.'):'')+' Si tienes tu comprobante, puedes enviarlo en este chat.';
        out.handoff=true;out.reason='Menciona un pago realizado: lo valida una persona.';
      }
      else{
        if(!fromKnowledge(.6)){if(payments?.settings(c.brand_id).enabled)out.reply=copy.paymentMethods;else{out.reply=copy.paymentWithAdvisor;out.handoff=true;}}
        out.reason=(out.reason?out.reason+' ':'')+(out.handoff?'Consulta de pago sin respuesta aprobada ni venta activa: la atiende una persona.':'Información general de pago.');
      }
    }
    else if(intent==='price'){out.prepared=catalogue.prepare(c,{kind:'price'});out.reply=copy.price(ctx);out.stage='interesado';out.sources.push(catalogueSource);out.reason='Precio y promoción vigentes consultados en el catálogo al responder.';}
    else if(intent==='syllabus'){out.prepared=catalogue.prepare(c,{kind:'syllabus'});out.reply=copy.syllabus(ctx);out.sources.push(catalogueSource);out.reason='Temario del curso en el catálogo.';}
    else if(intent==='schedule'){out.prepared=catalogue.prepare(c,{kind:'schedule'});out.reply=copy.schedule(ctx);out.sources.push(catalogueSource);out.reason='Fecha, horario y docente de la edición en el catálogo.';}
    else if(intent==='greeting'||(count===1&&!asks))welcome();
    else if(intent==='thanks'){out.reply=copy.thanks(user?.name);out.reason='Agradecimiento o cierre.';}
    else if(fromKnowledge(.5)){/* respondido con conocimiento */}
    else{
      // A la IA sólo se le manda lo relevante (BM25 + sinónimos del negocio), no todo el conocimiento (server/retrieval.mjs)
      const recent=db.prepare("SELECT text FROM messages WHERE conversation_id=? AND sender_kind='customer' AND id!=? ORDER BY seq DESC LIMIT 2").all(c.id,trigger.id||'').map(m=>m.text).join(' ');
      const picked=rankKnowledge(trigger.text,kb,{k:TOP_K,extraQuery:recent});
      out.knowledge=picked.selected.map(x=>({id:x.entry.id,question:x.entry.question,answer:x.entry.answer,score:x.score}));
      out.retrieval={considered:picked.considered,sent:picked.sent,mode:picked.mode,truncated:picked.truncated};
      out.needsProvider=Boolean(s.provider_enabled)&&picked.sent>0;
      if(out.needsProvider&&c.id!=='simulacion')out.memory=customerMemory(db,c,{now}).text;
      out.reply=copy.fallback(ctx);
      out.reason='Sin intención reconocida ni conocimiento parecido.'+(s.provider_enabled&&kb.length?(picked.sent?' Contexto para la IA: '+picked.sent+' de '+picked.considered+' entradas.':' Ninguna entrada del conocimiento se parece a la pregunta: no se consultó a la IA.'):'');
      if(count===1){welcome();if(out.needsProvider){out.prepared=null;out.buttons=null;}out.reason='Primer mensaje sin respuesta en el conocimiento: bienvenida con la ficha vigente del curso.'+(out.needsProvider?' Si el proveedor de IA responde con fuentes aprobadas, se usa su respuesta.':'');}
      if(unknownStreak(c.id)+1>=s.max_unknown){out.handoff=true;out.reply=copy.escalate;out.reason+=' Se alcanzó el máximo de respuestas sin reconocer ('+s.max_unknown+'): se escala.';}
    }
    if(out.mode==='templates'&&out.needsProvider){out.needsProvider=false;out.reason+=' (El proveedor de IA sólo se usa en modo autónomo.)';}
    return out;
  }

  // Aviso de fuera de horario: sólo si la marca mapeó una plantilla aprobada al evento «away_hours», el mensaje debe esperar a una
  // persona y la marca está cerrada ahora; una vez cada 12 horas por conversación. Dentro de la transacción del llamador.
  const AWAY_GAP=12*3600e3;
  function away(c,trigger){
    if(!content)return;const t=now(),policy=operations.settings(c.brand_id);
    if(isOpen(t,policy))return;
    if(db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND client_ref LIKE 'away:%' AND created_at>?").get(c.id,t-AWAY_GAP))return;
    const first=(db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id)?.name||'').split(' ')[0];
    const tpl=content.render('away_hours',c.brand_id,{courseId:c.course_id,editionId:c.edition_id,name:first,extra:{apertura:openingLabel(t,policy)}});
    if(!tpl)return;
    insertMessage(c,null,tpl.text,'automation','away:'+trigger.id,null,null,null,{category:'service'});
  }

  // Aplica el plan dentro de una transacción del llamador. Revalida que nadie respondió ya a este mensaje.
  function commit(c,trigger,p,draft=null){
    const ref='automation:'+trigger.id;if(db.prepare('SELECT id FROM messages WHERE client_ref=?').get(ref))return {action:'skipped',reason:'Ya existía una respuesta para este mensaje.'};
    const t=now(),sources=[...p.sources];let reply=p.reply,model=null,reason=p.reason;
    if(draft){model=draft.model;const v=validateDraft(draft,p.knowledge);if(v.ok){reply=v.text;reason='Proveedor de IA: '+draft.reason+(p.retrieval?' Contexto: '+p.retrieval.sent+' de '+p.retrieval.considered+' entradas del conocimiento.':'')+(p.memory?' Memoria del cliente enviada: «'+p.memory+'»':'');for(const id of v.usedIds)sources.push({type:'knowledge',id});}else reason+=' Proveedor descartado: '+v.reason+(draft.text?'':' ('+draft.reason+')');}
    const log=(action,replyMessageId=null)=>{const id=randomUUID();db.prepare('INSERT INTO reply_log(id,conversation_id,brand_id,trigger_message_id,reply_message_id,intent,confidence,mode,action,reply_text,sources,model,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,c.id,c.brand_id,trigger.id,replyMessageId,p.intent,p.confidence,p.mode,action,reply,JSON.stringify(sources),model,reason,t);return id;};
    if(p.mode==='off'){log('skipped');db.prepare("UPDATE conversations SET bot_enabled=0,status='waiting' WHERE id=?").run(c.id);operations.requestHuman(c,trigger.created_at);away(c,trigger);return {action:'skipped',reason:'Respuestas automáticas apagadas para la marca: pasa a una persona.'};}
    if(p.mode==='suggest'){log('suggested');db.prepare("UPDATE conversations SET bot_enabled=0,status='waiting' WHERE id=?").run(c.id);operations.requestHuman(c,trigger.created_at);away(c,trigger);return {action:'suggested',reply,reason};}
    if(p.order){const made=payments.createOrder(c,{user:null,source:'bot'});reply=reply.replace('{{pedido}}',payments.linkMessage(made.order));}
    const messageId=insertMessage(c,null,reply,'automation',ref,null,p.prepared?.flyerSnapshot?c.course_id:null,p.prepared,{buttons:p.buttons,category:'service'});   // responde a un mensaje entrante: siempre dentro de la ventana de servicio
    log(p.handoff?'escalated':'replied',messageId);
    if(p.stage)crm.setStage(c,p.stage);
    if(p.handoff){db.prepare("UPDATE conversations SET bot_enabled=0,status='waiting' WHERE id=?").run(c.id);operations.requestHuman(c,trigger.created_at);away(c,trigger);}
    return {action:p.handoff?'escalated':'replied',messageId,reply,reason};
  }

  // Reanuda al asistente en una conversación que sólo quedó en espera por el NIVEL de la marca («Apagado» o «Sugerir») cuando la marca ya responde sola
  // («Plantillas» o «Autónomo»). No toca las que alguien tomó, las cerradas, ni las que se escalaron a una persona (lo pidió el cliente, queja, pago
  // reportado), ni aquéllas donde alguien del equipo intervino después de la pausa: ésas siguen esperando a un asesor. Dentro de la transacción del
  // llamador; actualiza también `c`.
  function resumeIfPausedByMode(c){
    if(c.bot_enabled||c.assigned_to||c.status!=='waiting')return false;
    if(!['templates','autonomous'].includes(settings(c.brand_id).mode))return false;
    const last=db.prepare('SELECT action,trigger_message_id,created_at FROM reply_log WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(c.id);
    if(!last||!['suggested','skipped'].includes(last.action)||!last.trigger_message_id)return false;
    // Una persona ya intervino después de la pausa (respondió, tomó, transfirió, devolvió a la cola, anotó): la decisión es suya, no del cliente.
    if(db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='agent' AND created_at>=? LIMIT 1").get(c.id,last.created_at))return false;
    if(db.prepare("SELECT 1 FROM operation_events WHERE conversation_id=? AND created_at>=? AND (actor_id IS NOT NULL OR kind IN ('assignment','response') OR kind LIKE 'transfer.%') LIMIT 1").get(c.id,last.created_at))return false;
    // En «Sugerir»/«Apagado» la bitácora dice «suggested»/«skipped» aunque el mensaje pidiera una persona. Se revisa el mensaje que quedó en pausa y los
    // que el cliente escribió después: si alguno pide asesor, es queja o reembolso, reporta un pago o trae un archivo, sigue esperando a una persona.
    const trig=db.prepare('SELECT seq FROM messages WHERE id=?').get(last.trigger_message_id);if(!trig)return false;
    const pending=db.prepare("SELECT text,attachment_id FROM messages WHERE conversation_id=? AND sender_kind='customer' AND seq>=? ORDER BY seq LIMIT 21").all(c.id,trig.seq);
    if(pending.length>20)return false;   // demasiados mensajes sin atender: que lo vea una persona
    for(const m of pending){
      if(m.attachment_id)return false;
      const intent=classify(m.text).intent;
      if(intent==='human'||intent==='refund')return false;
      if(intent==='payment'&&/comprobante|pague|ya pague|transferi|deposite/.test(normalize(m.text)))return false;
    }
    consumeSuggestions(c.id);
    db.prepare("UPDATE conversations SET bot_enabled=1,status='open',updated_at=? WHERE id=?").run(now(),c.id);
    operations.reset(c,'automation.resumed',null);
    c.bot_enabled=1;c.status='open';return true;
  }

  // Simulación para administración: mismo plan, sin escribir y con la llamada al proveedor incluida.
  async function test(user,input){
    const brandId=input.brandId;if(typeof brandId!=='string'||!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no disponible.');crm.requireBrand(user,brandId);
    // Sin curso indicado se simula con el primer curso activo (por título) que tenga una edición disponible; si ninguno la tiene, con el primero, y el motor dirá por qué escala.
    const course=input.courseId?db.prepare('SELECT * FROM courses WHERE id=? AND brand_id=?').get(input.courseId,brandId):(()=>{const all=db.prepare('SELECT * FROM courses WHERE brand_id=? AND active=1 ORDER BY title').all(brandId);return all.find(k=>{try{return !catalogue.info(k.id).reason;}catch{return false;}})||all[0];})();
    if(!course)throw fail(400,'La marca no tiene cursos activos para simular.');
    const message=text(input.text,2000);if(!message)throw fail(400,'Escribe el mensaje del cliente.');
    const fake={id:'simulacion',customer_id:user.id,brand_id:brandId,course_id:course.id,edition_id:input.editionId||null,channel:['whatsapp','instagram','facebook'].includes(input.channel)?input.channel:'whatsapp',status:'open',bot_enabled:1,assigned_to:null},trigger={id:'simulacion',text:message,created_at:now()};
    const p=plan(fake,trigger);let draft=null;
    if(p.needsProvider||(input.forceProvider&&p.intent==='unknown'&&p.knowledge.length)){const ctx=catalogue.info(course.id,fake.edition_id);draft=await provider.draft({brand:ctx.brand,course:ctx.course,edition:{name:ctx.edition.name,dateLabel:ctx.dateLabel,priceLabel:(ctx.priceCents/100).toFixed(2)+' '+ctx.currency},question:message,knowledge:p.knowledge,history:[]});}
    const v=draft?validateDraft(draft,p.knowledge):null,reply=(v?.ok?v.text:p.reply).replace('{{pedido}}','[aquí iría el pedido con su enlace de pago de prueba]');
    return {context:{retrieval:p.retrieval||null,knowledge:(p.knowledge||[]).map(k=>({id:k.id,question:k.question,score:k.score})),memory:p.memory||null},intent:p.intent,confidence:p.confidence,mode:p.mode,reply,handoff:p.handoff,stage:p.stage,sources:[...p.sources,...(v?.ok?v.usedIds:[]).map(id=>({type:'knowledge',id}))],reason:draft?(v.ok?'Proveedor de IA: '+draft.reason:p.reason+' Proveedor descartado: '+v.reason+(draft.called||provider.name!=='claude'?'':' · NO se consultó a la IA: '+draft.reason)):p.reason,provider:{name:provider.name,model:draft?.model||null,used:Boolean(draft),called:Boolean(draft?.called),accepted:Boolean(v?.ok),error:draft&&!draft.called&&provider.name==='claude'?String(draft.reason||'').slice(0,200):null}};
  }

  // ---- huecos de conocimiento: lo que los clientes preguntaron y el motor no supo responder con conocimiento aprobado
  // (intención desconocida y ninguna fuente de conocimiento en la respuesta). Se agrupan las preguntas parecidas para que quien
  // administra el conocimiento vea primero lo que más se pregunta y pueda convertirlo en una respuesta con un clic.
  function gaps(user,{brand=null,days=30}={}){
    const ids=crm.brandsFor(user).map(b=>b.id).filter(id=>!brand||id===brand);if(!ids.length)return [];
    const since=now()-Math.min(90,Math.max(1,Number(days)||30))*86400000;
    const rows=db.prepare(`SELECT r.brand_id,r.conversation_id,r.created_at,r.sources,m.text FROM reply_log r JOIN messages m ON m.id=r.trigger_message_id WHERE r.intent='unknown' AND r.brand_id IN (${ids.map(()=>'?').join(',')}) AND r.created_at>=? ORDER BY r.created_at DESC LIMIT 600`).all(...ids,since);
    const clusters=[];
    for(const r of rows){
      let sources=[];try{sources=JSON.parse(r.sources);}catch{}
      if(sources.some(s=>s.type==='knowledge'))continue;   // sí se respondió con conocimiento aprobado
      const set=new Set(tokens(r.text).map(stem));if(set.size<2)continue;
      let hit=null,best=0;
      for(const c of clusters){if(c.brandId!==r.brand_id)continue;const inter=[...set].filter(t=>c.terms.has(t)).length,j=inter/(set.size+c.terms.size-inter);if(j>=.45&&j>best){best=j;hit=c;}}
      if(!hit){hit={brandId:r.brand_id,example:r.text.slice(0,200),count:0,conversations:new Set(),lastAt:r.created_at,terms:new Set(set)};clusters.push(hit);}
      hit.count++;hit.conversations.add(r.conversation_id);for(const t of set)hit.terms.add(t);
    }
    return clusters.sort((a,b)=>b.count-a.count||b.lastAt-a.lastAt).slice(0,25).map(c=>({brandId:c.brandId,example:c.example,count:c.count,conversations:c.conversations.size,lastAt:c.lastAt}));
  }

  // ---- conocimiento
  function normalizeEntry(input,brandId){
    const topic=text(input.topic,40).toLowerCase().replace(/[^a-z0-9_-]/g,'')||'general',question=text(input.question,200),answer=text(input.answer,1500);
    if(question.length<8)throw fail(400,'Escribe la pregunta completa, tal como la haría un cliente.');if(answer.length<10)throw fail(400,'Escribe una respuesta completa.');
    const variants=[...new Set((Array.isArray(input.variants)?input.variants:String(input.variants||'').split(/\n|;/)).map(v=>text(v,120)).filter(Boolean))].slice(0,20);
    let courseId=null;if(input.courseId){const k=db.prepare('SELECT brand_id FROM courses WHERE id=?').get(input.courseId);if(!k||k.brand_id!==brandId)throw fail(400,'Curso no válido para la marca.');courseId=input.courseId;}
    if(/\$\s?\d|\d+\s?(pesos|mxn|usd)/i.test(answer))throw fail(400,'No escribas precios en el conocimiento: el precio vigente sale del catálogo.');
    return {topic,question,answer,variants,courseId};
  }
  const snapshot=(id,actor)=>{const e=entry(id);db.prepare('INSERT INTO knowledge_versions(entry_id,revision,snapshot,actor_id,created_at) VALUES(?,?,?,?,?)').run(id,e.revision,JSON.stringify({topic:e.topic,question:e.question,variants:JSON.parse(e.variants),answer:e.answer,status:e.status,course_id:e.course_id}),actor,now());};
  const guard=(e,input)=>{if(!e)throw fail(404,'Entrada no encontrada.');if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==e.revision)throw fail(409,'La entrada cambió. Recárgala.');};
  function createEntry(user,input){
    const brandId=input.brandId;if(typeof brandId!=='string'||!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no disponible.');crm.requireBrand(user,brandId);
    const n=normalizeEntry(input,brandId);
    return transaction(db,()=>{if(db.prepare('SELECT count(*) n FROM knowledge_entries WHERE brand_id=? AND status!=\'archived\'').get(brandId).n>=300)throw fail(409,'La marca alcanzó el máximo de 300 entradas.');const id=randomUUID(),t=now();db.prepare('INSERT INTO knowledge_entries(id,brand_id,course_id,topic,question,variants,answer,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,brandId,n.courseId,n.topic,n.question,JSON.stringify(n.variants),n.answer,user.id,t,t);snapshot(id,user.id);return view(entry(id));});
  }
  function updateEntry(user,id,input){
    return transaction(db,()=>{const e=entry(id);guard(e,input);crm.requireBrand(user,e.brand_id);const n=normalizeEntry({...view(e),courseId:e.course_id,...input},e.brand_id);
      db.prepare("UPDATE knowledge_entries SET topic=?,question=?,variants=?,answer=?,course_id=?,status='draft',approved_by=NULL,approved_at=NULL,revision=revision+1,updated_at=? WHERE id=?").run(n.topic,n.question,JSON.stringify(n.variants),n.answer,n.courseId,now(),id);snapshot(id,user.id);return view(entry(id));});
  }
  function setStatus(user,id,input,status){
    if(user.role!=='admin')throw fail(403,'Aprobar o archivar conocimiento requiere un administrador.');
    return transaction(db,()=>{const e=entry(id);guard(e,input);crm.requireBrand(user,e.brand_id);if(e.status===status)throw fail(409,'La entrada ya está en ese estado.');
      db.prepare('UPDATE knowledge_entries SET status=?,approved_by=?,approved_at=?,revision=revision+1,updated_at=? WHERE id=?').run(status,status==='approved'?user.id:e.approved_by,status==='approved'?now():e.approved_at,now(),id);snapshot(id,user.id);return view(entry(id));});
  }
  function setSettings(user,brandId,input){
    if(user.role!=='admin')throw fail(403,'El nivel de respuesta lo define un administrador.');
    if(!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no disponible.');
    const mode=input.mode===undefined?null:input.mode;if(mode!==null&&!MODES.includes(mode))throw fail(400,'Nivel no válido.');
    const maxUnknown=input.maxUnknown===undefined?null:input.maxUnknown;if(maxUnknown!==null&&(!Number.isInteger(maxUnknown)||maxUnknown<1||maxUnknown>5))throw fail(400,'El máximo de respuestas sin reconocer va de 1 a 5.');
    return transaction(db,()=>{const cur=settings(brandId);if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==cur.revision)throw fail(409,'La configuración cambió. Recárgala.');
      const next={mode:mode??cur.mode,provider_enabled:input.providerEnabled===undefined?cur.provider_enabled:(input.providerEnabled?1:0),max_unknown:maxUnknown??cur.max_unknown};
      if(next.provider_enabled&&!provider.configured)throw fail(400,'El proveedor de IA no está configurado en el servidor.');
      db.prepare('INSERT INTO reply_settings(brand_id,mode,provider_enabled,max_unknown,revision,updated_by,updated_at) VALUES(?,?,?,?,1,?,?) ON CONFLICT(brand_id) DO UPDATE SET mode=excluded.mode,provider_enabled=excluded.provider_enabled,max_unknown=excluded.max_unknown,revision=reply_settings.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(brandId,next.mode,next.provider_enabled,next.max_unknown,user.id,now());return settings(brandId);});
  }
  const suggestion=conversationId=>db.prepare("SELECT id,intent,confidence,reply_text,sources,reason,created_at FROM reply_log WHERE conversation_id=? AND action='suggested' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1").get(conversationId);
  const consumeSuggestions=conversationId=>db.prepare("UPDATE reply_log SET consumed_at=? WHERE conversation_id=? AND action='suggested' AND consumed_at IS NULL").run(now(),conversationId).changes;
  const history=conversationId=>db.prepare('SELECT id,trigger_message_id,reply_message_id,intent,confidence,mode,action,reply_text,sources,model,reason,consumed_at,created_at FROM reply_log WHERE conversation_id=? ORDER BY created_at DESC LIMIT 30').all(conversationId).map(r=>({...r,sources:JSON.parse(r.sources)}));

  async function handle(req,res,path,user,{body,json,audit,accessConversation}){
    let m;
    if((m=path.match(/^\/api\/conversations\/([a-f0-9-]+)\/replies(?:\/(dismiss))?$/))){
      const c=accessConversation(m[1],user);if(user.role==='customer')throw fail(403,'Vista del equipo.');
      if(!m[2]&&req.method==='GET'){const s=suggestion(c.id);json(res,200,{suggestion:s?{...s,sources:JSON.parse(s.sources)}:null,log:history(c.id),settings:settings(c.brand_id)});return true;}
      if(m[2]==='dismiss'&&req.method==='POST'){await body(req);json(res,200,{dismissed:consumeSuggestions(c.id)});return true;}
      throw fail(405,'Método no permitido.');
    }
    if(!path.startsWith('/api/replies'))return false;
    if(user.role==='customer')throw fail(403,'Vista del equipo.');
    if(path==='/api/replies/provider'&&req.method==='GET'){json(res,200,{name:provider.name,model:provider.model,configured:provider.configured,usage:provider.usage?.()||null});return true;}
    if(path==='/api/replies/gaps'&&req.method==='GET'){const q=new URL(req.url,'http://localhost').searchParams;json(res,200,{gaps:gaps(user,{brand:q.get('brand')||null,days:q.get('days')})});return true;}
    if(path==='/api/replies/settings'&&req.method==='GET'){json(res,200,{settings:crm.brandsFor(user).map(b=>({...settings(b.id),brand_name:b.name})),modes:MODES,provider:{name:provider.name,model:provider.model,configured:provider.configured,usage:provider.usage?.()||null}});return true;}
    if((m=path.match(/^\/api\/replies\/brands\/([\w-]{1,64})$/))&&req.method==='PATCH'){const s=setSettings(user,m[1],await body(req));audit(user,'replies.settings',m[1]);json(res,200,{settings:s});return true;}
    if(path==='/api/replies/test'&&req.method==='POST'){json(res,200,{result:await test(user,await body(req))});return true;}
    if(path==='/api/replies/knowledge'){
      if(req.method==='GET'){const q=new URL(req.url,'http://localhost').searchParams,brand=q.get('brand');const ids=crm.brandsFor(user).map(b=>b.id).filter(id=>!brand||id===brand);json(res,200,{entries:ids.length?db.prepare(`SELECT * FROM knowledge_entries WHERE brand_id IN (${ids.map(()=>'?').join(',')}) ORDER BY status='approved' DESC,updated_at DESC LIMIT 500`).all(...ids).map(view):[]});return true;}
      if(req.method==='POST'){const e=createEntry(user,await body(req));audit(user,'knowledge.created',e.id);json(res,201,{entry:e});return true;}
    }
    if((m=path.match(/^\/api\/replies\/knowledge\/([a-f0-9-]{36})(?:\/(approve|archive|history))?$/))){
      if(!m[2]&&req.method==='PATCH'){const e=updateEntry(user,m[1],await body(req));audit(user,'knowledge.updated',e.id);json(res,200,{entry:e});return true;}
      if((m[2]==='approve'||m[2]==='archive')&&req.method==='POST'){const e=setStatus(user,m[1],await body(req),m[2]==='approve'?'approved':'archived');audit(user,'knowledge.'+m[2],e.id);json(res,200,{entry:e});return true;}
      if(m[2]==='history'&&req.method==='GET'){const e=entry(m[1]);if(!e)throw fail(404,'Entrada no encontrada.');crm.requireBrand(user,e.brand_id);json(res,200,{versions:db.prepare('SELECT v.revision,v.snapshot,v.created_at,u.name actor_name FROM knowledge_versions v LEFT JOIN users u ON u.id=v.actor_id WHERE v.entry_id=? ORDER BY v.revision DESC').all(m[1]).map(v=>({...v,snapshot:JSON.parse(v.snapshot)}))});return true;}
    }
    throw fail(404,'Ruta de respuestas no encontrada.');
  }
  return {handle,plan,commit,classify,settings,resumeIfPausedByMode,suggestion,consumeSuggestions,history,test,createEntry,normalizeEntry,seedBrand:brandId=>seedBrandKnowledge(db,brandId,now())};
}
