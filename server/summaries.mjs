import {normalize} from './ai-provider.mjs';

// Resumen de conversación (docs/PLAN_RESUMEN_CONVERSACION.md). Sirve a dos lectores:
//  - la persona que toma un chat ya avanzado (qué quiere, qué preguntó, qué objeciones puso, qué quedó pendiente y cuál es el siguiente paso);
//  - la IA, que sólo ve los últimos mensajes y en un chat largo perdía lo del principio.
// Siempre hay un resumen por REGLAS (gratis, determinista, con los datos verdaderos del CRM: etapa, pedidos, tareas, quién atiende). Si hay
// proveedor de IA y no se alcanzó su tope, además una IA redacta el resumen narrativo; si falla, quedan las reglas. Los datos de contacto y los
// importes que escriba el cliente se enmascaran y el nombre se reduce a una palabra corta de letras: es contenido de un tercero.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const HOUR=3600000;
const TOPIC_LABEL={price:'precio',schedule:'fechas y horario',syllabus:'temario',certificate:'certificado',payment:'pagos',requirements:'requisitos',modality:'modalidad',recording:'grabaciones',duration:'duración',enroll:'inscripción',refund:'reembolso o queja',human:'hablar con una persona'};
const OBJECTIONS=[
  [/\b(caro|costoso|muy elevado|no me alcanza|presupuesto|descuento)\b/,'Le parece caro o pregunta por descuento'],
  [/\b(pensarlo|lo voy a pensar|lo pienso|lo voy a ver|luego te aviso|mas adelante|despues te escribo)\b/,'Quiere pensarlo'],
  [/\b(no tengo tiempo|sin tiempo|ocupad[oa]|no puedo asistir|no me da el horario|se cruza)\b/,'Tiene poco tiempo o problemas de horario'],
  [/\b(otra opcion|otras opciones|otro curso|competencia|comparando|estoy viendo)\b/,'Compara con otras opciones'],
  [/\b(confiable|confianza|es seguro|estafa|tiene validez|es oficial|reconocid)\b/,'Duda de la confiabilidad o la validez'],
];
const mask=s=>String(s??'').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g,'[correo]').replace(/\+?\d[\d\s().-]{7,}\d/g,'[teléfono]').replace(/\$\s?\d[\d,.]*/g,'[importe]').replace(/[<>]/g,' ').replace(/\s+/g,' ').trim();
const quote=(s,max=140)=>{const t=mask(s);return t.length>max?t.slice(0,max-1)+'…':t;};
const firstName=n=>{const w=String(n||'').trim().split(/\s+/)[0]||'';return /^[\p{L}'’-]{1,24}$/u.test(w)?w:null;};
const looksLikeQuestion=t=>/[?¿]/.test(t)||/^\s*(como|cuando|donde|que|cual|cuanto|quien|por que|puedo|hay|tienen|dan|se puede|necesito)\b/.test(normalize(t).trim());

export function createSummaries({db,crm,provider,accessConversation,body,json,audit,rate=()=>{},now=Date.now}){
  const messagesOf=id=>db.prepare('SELECT seq,sender_kind,text,created_at FROM messages WHERE conversation_id=? ORDER BY seq').all(id);
  const names=id=>id?db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name||null:null;
  const span=ms=>{const h=Math.floor(ms/HOUR);return h<1?'menos de una hora':h<48?h+' hora'+(h===1?'':'s'):Math.floor(h/24)+' días';};

  // ---- por reglas
  function byRules(c,msgs){
    const customer=msgs.filter(m=>m.sender_kind==='customer'),staff=msgs.filter(m=>m.sender_kind==='agent'),bot=msgs.filter(m=>m.sender_kind==='automation');
    const course=db.prepare('SELECT title FROM courses WHERE id=?').get(c.course_id)?.title||'el curso',channel={whatsapp:'WhatsApp',instagram:'Instagram',facebook:'Facebook'}[c.channel]||c.channel;
    const opp=db.prepare('SELECT o.id,o.stage FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id=?').get(c.id);
    const stage={nuevo:'nuevo interés',interesado:'interesado',inscripcion:'pidió inscribirse',ganada:'inscrito',perdida:'lo dejó pasar'}[opp?.stage]||null;
    const tasks=opp?db.prepare("SELECT title,due_at FROM tasks WHERE opportunity_id=? AND status='open' ORDER BY due_at LIMIT 3").all(opp.id):[];
    const pendingOrders=db.prepare("SELECT count(*) n FROM orders WHERE conversation_id=? AND status IN ('pending','review')").get(c.id).n;
    const intents=db.prepare("SELECT intent FROM reply_log WHERE conversation_id=? AND intent NOT IN ('unknown','greeting','thanks','opt_out')").all(c.id).map(r=>r.intent);
    const topics=[...new Set(intents)].filter(i=>TOPIC_LABEL[i]).map(i=>TOPIC_LABEL[i]);
    const objections=[...new Set(customer.flatMap(m=>OBJECTIONS.filter(([re])=>re.test(normalize(m.text))).map(([,l])=>l)))];
    const questions=customer.filter(m=>m.text&&looksLikeQuestion(m.text)).slice(-3).map(m=>quote(m.text));
    const last=msgs.at(-1),lastCustomer=customer.at(-1),first=msgs[0];
    const waitingHours=last&&last.sender_kind==='customer'?Math.floor((now()-last.created_at)/HOUR):null;
    const silentHours=last&&last.sender_kind!=='customer'&&lastCustomer?Math.floor((now()-lastCustomer.created_at)/HOUR):null;
    let next='Seguir la conversación.';
    if(last?.sender_kind==='customer'&&(c.status==='waiting'||!c.bot_enabled))next='Responder a su último mensaje: «'+quote(last.text,100)+'».';
    else if(pendingOrders)next='Dar seguimiento al pago pendiente.';
    else if(opp?.stage==='inscripcion')next='Confirmar su inscripción.';
    else if(objections.includes('Quiere pensarlo'))next='Escribirle en unos días para retomar.';
    else if(silentHours!==null&&silentHours>=24)next='Retomar: lleva '+span(silentHours*HOUR)+' sin responder.';
    const name=firstName(db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id)?.name);
    const facts={customer:name,course,channel,stage,status:c.status,assignedTo:names(c.assigned_to),botEnabled:Boolean(c.bot_enabled),messages:{total:msgs.length,customer:customer.length,team:staff.length,automatic:bot.length},
      since:first?.created_at||null,lastAt:last?.created_at||null,waitingHours,topics,objections,questions,openTasks:tasks.map(t=>({title:mask(t.title).slice(0,100),dueAt:t.due_at})),pendingOrders,next};
    const lines=[];
    lines.push(`${name||'La persona'} escribió por ${channel} sobre ${course}. ${msgs.length} mensajes${first&&last?' en '+span(last.created_at-first.created_at):''} (${customer.length} suyos, ${staff.length} del equipo, ${bot.length} automáticos).`);
    lines.push(`${stage?'Etapa: '+stage+'. ':''}${c.status==='resolved'?'Conversación cerrada.':c.assigned_to?'La atiende '+names(c.assigned_to)+'.':c.bot_enabled?'La atiende el asistente automático.':'Espera a una persona del equipo.'}${waitingHours!==null&&waitingHours>=1?' Lleva '+span(waitingHours*HOUR)+' esperando respuesta.':''}`);
    if(topics.length)lines.push('Ha preguntado por: '+topics.join(', ')+'.');
    if(objections.length)lines.push('Objeciones: '+objections.join('; ')+'.');
    if(questions.length)lines.push('Últimas preguntas: '+questions.map(q=>'«'+q+'»').join(' · '));
    if(pendingOrders)lines.push('Tiene un pedido de pago pendiente.');
    if(tasks.length)lines.push('Seguimientos abiertos: '+tasks.map(t=>mask(t.title).slice(0,60)+' ('+new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'short',timeZone:'America/Mexico_City'}).format(t.due_at)+')').join('; ')+'.');
    lines.push('Siguiente paso sugerido: '+next);
    return {lines,facts};
  }

  // ---- narrativa con IA (opcional)
  async function narrative(c,msgs,previous){
    if(typeof provider?.summarize!=='function')return null;
    const course=db.prepare('SELECT title FROM courses WHERE id=?').get(c.course_id)?.title||'curso',brand=db.prepare('SELECT name FROM brands WHERE id=?').get(c.brand_id)?.name||'';
    const recent=msgs.slice(-60).map(m=>({role:m.sender_kind==='customer'?'cliente':'equipo',text:mask(m.text).slice(0,400)}));
    const r=await provider.summarize({brand,course,previous:previous?mask(previous):null,messages:recent});
    if(!r?.summary)return null;
    const clean=s=>mask(s).slice(0,600);
    return {summary:clean(r.summary),pending:(r.pending||[]).map(x=>clean(x).slice(0,160)).slice(0,4),objections:(r.objections||[]).map(x=>clean(x).slice(0,120)).slice(0,3),model:r.model||null};
  }

  const view=(row,msgsCount)=>row&&{text:row.text,data:JSON.parse(row.data||'{}'),source:row.source,model:row.model,updatedAt:row.updated_at,createdAt:row.created_at,uptoSeq:row.upto_seq,messageCount:row.message_count,revision:row.revision,
    newMessages:Math.max(0,(msgsCount??db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get(row.conversation_id).n)-row.message_count)};
  const get=conversationId=>db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id=?').get(conversationId);

  // Genera o actualiza el resumen (fuera de transacciones: puede llamar a la IA) y lo guarda.
  async function refresh(c,user=null){
    const msgs=messagesOf(c.id);if(!msgs.length)throw fail(409,'La conversación todavía no tiene mensajes.');
    const prev=get(c.id),rules=byRules(c,msgs);let ai=null;
    try{ai=await narrative(c,msgs,prev?.source==='ai'?prev.text.split('\n')[0]:null);}catch{ai=null;}
    if(ai)rules.facts.narrative=ai.summary;
    const parts=[];if(ai){parts.push(ai.summary);if(ai.objections.length)rules.facts.objections=[...new Set([...rules.facts.objections,...ai.objections])];if(ai.pending.length)parts.push('Pendiente: '+ai.pending.join('; ')+'.');parts.push(...rules.lines.slice(1));}else parts.push(...rules.lines);
    const text=parts.join('\n'),t=now(),upto=msgs.at(-1).seq;
    db.prepare("INSERT INTO conversation_summaries(conversation_id,upto_seq,message_count,text,data,source,model,requested_by,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(conversation_id) DO UPDATE SET upto_seq=excluded.upto_seq,message_count=excluded.message_count,text=excluded.text,data=excluded.data,source=excluded.source,model=excluded.model,requested_by=excluded.requested_by,revision=conversation_summaries.revision+1,updated_at=excluded.updated_at")
      .run(c.id,upto,msgs.length,text,JSON.stringify(rules.facts),ai?'ai':'rules',ai?.model||null,user?.id||null,t,t);
    if(user)audit(user,'conversation.summary',c.id);
    return view(get(c.id),msgs.length);
  }
  // Versión para la IA que RESPONDE AL CLIENTE: sólo lo que la propia persona dijo o preguntó (el hilo), nunca lo interno del equipo: quién la atiende, etapa
  // comercial, seguimientos, pedidos, siguiente paso sugerido ni conteos del equipo. El resumen del equipo sigue siendo sólo para el equipo.
  function forCustomerAi(row){
    const d=JSON.parse(row.data||'{}'),parts=[];
    parts.push(d.narrative||`La persona escribió por ${d.channel||'el chat'} sobre ${d.course||'un curso'}.`);
    if(d.topics?.length)parts.push('Ha preguntado por: '+d.topics.join(', ')+'.');
    if(d.objections?.length)parts.push('Dudas que expresó: '+d.objections.join('; ')+'.');
    if(d.questions?.length)parts.push('Últimas preguntas: '+d.questions.map(q=>'«'+q+'»').join(' · '));
    return parts.join('\n');
  }
  // Para que la IA que responde no pierda el principio de un chat largo: el resumen vigente, o uno nuevo si hace falta. Nunca falla la respuesta.
  const LONG=12,STALE=8;
  async function ensureFor(c){
    try{
      const n=db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get(c.id).n;if(n<=LONG)return null;
      let row=get(c.id);if(!row||n-row.message_count>STALE)row=(await refresh(c))&&get(c.id);
      return row?forCustomerAi(row):null;   // nunca el texto del equipo
    }catch{return null;}
  }
  // Al pasar un chat a una persona se deja listo el resumen (sin esperar).
  function auto(conversationId){
    setImmediate(async()=>{try{const c=db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);if(!c)return;const n=db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get(c.id).n,row=get(c.id);if(n>=4&&(!row||n-row.message_count>=3))await refresh(c);}catch{}});
  }

  async function handle(req,res,path,user){
    const m=path.match(/^\/api\/conversations\/([a-f0-9-]+)\/summary$/);if(!m)return false;
    if(user.role==='customer')throw fail(403,'El resumen es para el equipo.');
    const c=accessConversation(m[1],user);
    if(req.method==='GET'){json(res,200,{summary:view(get(c.id))});return true;}
    if(req.method==='POST'){rate('summary:'+user.id,12);await body(req).catch(()=>({}));json(res,200,{summary:await refresh(c,user)});return true;}
    throw fail(405,'Método no permitido.');
  }
  return {handle,refresh,ensureFor,auto,byRules,get,forCustomerAi};
}
