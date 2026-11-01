import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';
import {normalize,bestMatch} from './ai-provider.mjs';
import {seedBrandKnowledge} from './replies-schema.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
export const MODES=['off','suggest','templates','autonomous'];
export const INTENTS=['opt_out','human','refund','enroll','payment','price','schedule','syllabus','certificate','requirements','modality','recording','duration','greeting','thanks','unknown'];
const TOPIC_INTENTS=['certificate','payment','requirements','modality','recording','duration'];
const PATTERNS=[
  ['human',/\b(asesor|humano|persona|alguien|atencion|hablar con)\b/,.9],
  ['refund',/\b(reembolso|devolucion|devolver|queja|molest|pesimo|fraude|engan)/,.9],
  ['enroll',/\b(inscrib|registr|apuntar|quiero el curso|me anoto|como me inscribo)/,.85],
  ['payment',/\b(comprobante|pague|pago|transferencia|deposito|tarjeta|oxxo|spei|factura|meses sin intereses)\b/,.85],
  ['price',/\b(precio|cuesta|costo|cuanto|promocion|descuento|oferta|vale)\b/,.85],
  ['schedule',/\b(fecha|horario|cuando|dia|empieza|inicia|calendario)\b/,.8],
  ['syllabus',/\b(temario|incluye|temas?|contenido|que voy a aprender|programa)\b/,.8],
  ['certificate',/\b(certificad|constancia|diploma|aval|validez|reconocimiento)/,.85],
  ['requirements',/\b(requisito|conocimientos previos|necesito saber|que necesito)\b/,.8],
  ['modality',/\b(modalidad|en linea|online|presencial|virtual|zoom|meet|donde es|donde se imparte)\b/,.8],
  ['recording',/\b(grabaci|grabad|no puedo asistir|repeticion|ver despues)/,.8],
  ['duration',/\b(duracion|cuanto dura|cuantas (horas|sesiones|clases)|cuanto tiempo)\b/,.8],
  ['greeting',/\b(hola|buen[oa]s?|informacion|info|flyer|imagen|me interesa|saludos)\b/,.6],
  ['thanks',/\b(gracias|perfecto|ok|vale|listo|entendido)\b/,.5],
];

// Motor de respuestas v2. Reglas del proyecto que cumple: precios/fechas/cupos sólo del catálogo; nunca confirma pagos ni
// inscripciones; cada decisión queda en reply_log con intención, fuentes y motivo; las llamadas al proveedor de IA van fuera
// de las transacciones (plan() y commit() son síncronos; el proveedor se consulta entre ambos).
export function createReplies({db,catalogue,crm,contacts,operations,insertMessage,provider,now=Date.now}){
  const defaults=brandId=>({brand_id:brandId,mode:'templates',provider_enabled:0,max_unknown:2,revision:0,updated_by:null,updated_at:null});
  const settings=brandId=>db.prepare('SELECT * FROM reply_settings WHERE brand_id=?').get(brandId)||defaults(brandId);
  const entry=id=>typeof id==='string'?db.prepare('SELECT * FROM knowledge_entries WHERE id=?').get(id):null;
  const view=e=>e&&{...e,variants:JSON.parse(e.variants)};
  const approved=(brandId,courseId)=>db.prepare("SELECT * FROM knowledge_entries WHERE brand_id=? AND status='approved' AND (course_id IS NULL OR course_id=?) ORDER BY course_id IS NULL,updated_at DESC").all(brandId,courseId).map(view);

  function classify(raw){
    if(contacts.isOptOutText(raw))return {intent:'opt_out',confidence:.95};
    const t=normalize(raw);
    for(const [intent,re,confidence] of PATTERNS)if(re.test(t))return {intent,confidence};
    return {intent:'unknown',confidence:0};
  }
  const unknownStreak=conversationId=>{let n=0;for(const r of db.prepare("SELECT intent,action FROM reply_log WHERE conversation_id=? AND action IN ('replied','suggested') ORDER BY created_at DESC LIMIT 5").all(conversationId)){if(r.intent==='unknown')n++;else break;}return n;};

  // Plan síncrono: decide intención, texto, fuentes y si hace falta el proveedor. No escribe nada.
  function plan(c,trigger){
    const s=settings(c.brand_id),user=db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id),first=(user?.name||'').split(' ')[0];
    const ctx=catalogue.info(c.course_id,c.edition_id),course=ctx.course,{intent,confidence}=classify(trigger.text);
    const count=db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND sender_kind='customer'").get(c.id).n;
    const out={mode:s.mode,intent,confidence,reply:'',sources:[],stage:null,handoff:false,prepared:null,reason:'',needsProvider:false,knowledge:[]};
    const catalogueSource={type:'catalogue',courseId:course.id,editionId:ctx.edition.id,promotionId:ctx.promotion?.id||null,priceCents:ctx.priceCents,currency:ctx.currency};
    const kb=approved(c.brand_id,c.course_id);
    const fromKnowledge=(threshold=.5)=>{const hit=bestMatch(trigger.text,kb,threshold)||(TOPIC_INTENTS.includes(intent)?{entry:kb.find(k=>k.topic===intent),score:1}:null);if(!hit?.entry)return false;out.reply=hit.entry.answer;out.sources.push({type:'knowledge',id:hit.entry.id,revision:hit.entry.revision,question:hit.entry.question});out.reason='Conocimiento aprobado «'+hit.entry.question+'»'+(hit.score<1?' (parecido '+Math.round(hit.score*100)+'%)':'')+'.';return true;};
    if(intent==='opt_out'){out.reply='Listo: no volveremos a enviarte mensajes de seguimiento. Si más adelante necesitas ayuda, escríbenos cuando quieras.';out.reason='El cliente pidió la baja; se registra y se confirma una sola vez.';}
    else if(intent==='human'||intent==='refund'){out.reply=intent==='refund'?'Lamento la molestia. Una persona del equipo revisará tu caso y te responderá por aquí.':'Ya avisé al equipo. Un asesor puede tomar esta conversación para continuar contigo.';out.handoff=true;out.reason=intent==='refund'?'Queja o reembolso: siempre lo atiende una persona.':'El cliente pidió hablar con una persona.';}
    else if(ctx.reason){out.reply=ctx.reason+'. Un asesor puede ayudarte a revisar otra edición disponible.';out.handoff=true;out.reason='La edición no está disponible según el catálogo.';out.sources.push(catalogueSource);}
    else if(intent==='enroll'){out.reply='Anoté tu interés en '+course.title+' · '+ctx.edition.name+'. Un asesor continuará con tu inscripción de práctica. En este laboratorio no se realizan cobros ni inscripciones reales.';out.stage='inscripcion';out.handoff=true;out.reason='Solicitud de inscripción: avanza la etapa y pasa a una persona; nunca se confirma sola.';out.sources.push(catalogueSource);}
    else if(intent==='payment'){if(!fromKnowledge(.6))out.reply='Gracias. El equipo revisará tu consulta de pago. No confirmamos pagos automáticamente y aquí no se realizan cobros reales.';out.handoff=/comprobante|pague|ya pague|transferi|deposite/.test(normalize(trigger.text));out.reason=(out.reason?out.reason+' ':'')+(out.handoff?'Menciona un pago realizado: lo valida una persona.':'Información general de pago.');}
    else if(intent==='price'){out.prepared=catalogue.prepare(c,{kind:'price'});out.reply=out.prepared.text.replace(/^Precio de ejemplo:/,'El precio de ejemplo de '+course.title+' es');out.stage='interesado';out.sources.push(catalogueSource);out.reason='Precio y promoción vigentes consultados en el catálogo al responder.';}
    else if(intent==='syllabus'){out.prepared=catalogue.prepare(c,{kind:'syllabus'});out.reply=out.prepared.text;out.sources.push(catalogueSource);out.reason='Temario del curso en el catálogo.';}
    else if(intent==='schedule'){out.prepared=catalogue.prepare(c,{kind:'schedule'});out.reply=out.prepared.text;out.sources.push(catalogueSource);out.reason='Fecha, horario y docente de la edición en el catálogo.';}
    else if(intent==='greeting'||count===1){out.prepared=catalogue.prepare(c,{kind:'flyer'});out.reply=course.welcome.replaceAll('{{nombre}}',first).replaceAll('{{curso}}',course.title)+'\n\n'+out.prepared.text;out.sources.push(catalogueSource,{type:'template',kind:'welcome'});out.reason=count===1?'Primer mensaje: bienvenida con la ficha vigente del curso.':'Saludo o petición de información: ficha vigente del curso.';}
    else if(intent==='thanks'){out.reply='¡Con gusto! Si quieres, puedo ayudarte con el precio, las fechas o la inscripción de práctica.';out.reason='Agradecimiento o cierre.';}
    else if(fromKnowledge(.5)){/* respondido con conocimiento */}
    else{
      out.knowledge=kb.map(k=>({id:k.id,question:k.question,answer:k.answer}));
      out.needsProvider=Boolean(s.provider_enabled)&&kb.length>0;
      out.reply='Puedo ayudarte con el precio, el temario o la fecha de este curso. Si prefieres, escribe “asesor” y el equipo continuará contigo.';
      out.reason='Sin intención reconocida ni conocimiento parecido.';
      if(unknownStreak(c.id)+1>=s.max_unknown){out.handoff=true;out.reply='No quiero hacerte perder tiempo: le paso tu pregunta a una persona del equipo para que te responda con precisión.';out.reason+=' Se alcanzó el máximo de respuestas sin reconocer ('+s.max_unknown+'): se escala.';}
    }
    if(out.mode==='templates'&&out.needsProvider){out.needsProvider=false;out.reason+=' (El proveedor de IA sólo se usa en modo autónomo.)';}
    return out;
  }

  // Aplica el plan dentro de una transacción del llamador. Revalida que nadie respondió ya a este mensaje.
  function commit(c,trigger,p,draft=null){
    const ref='automation:'+trigger.id;if(db.prepare('SELECT id FROM messages WHERE client_ref=?').get(ref))return {action:'skipped',reason:'Ya existía una respuesta para este mensaje.'};
    const t=now(),sources=[...p.sources];let reply=p.reply,model=null,reason=p.reason;
    if(draft){model=draft.model;if(draft.text){reply=draft.text;reason='Proveedor de IA: '+draft.reason;for(const id of draft.usedIds)sources.push({type:'knowledge',id});}else reason+=' Proveedor: '+draft.reason;}
    const log=(action,replyMessageId=null)=>{const id=randomUUID();db.prepare('INSERT INTO reply_log(id,conversation_id,brand_id,trigger_message_id,reply_message_id,intent,confidence,mode,action,reply_text,sources,model,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,c.id,c.brand_id,trigger.id,replyMessageId,p.intent,p.confidence,p.mode,action,reply,JSON.stringify(sources),model,reason,t);return id;};
    if(p.mode==='off'){log('skipped');db.prepare("UPDATE conversations SET bot_enabled=0,status='waiting' WHERE id=?").run(c.id);operations.requestHuman(c,trigger.created_at);return {action:'skipped',reason:'Respuestas automáticas apagadas para la marca: pasa a una persona.'};}
    if(p.mode==='suggest'){log('suggested');db.prepare("UPDATE conversations SET bot_enabled=0,status='waiting' WHERE id=?").run(c.id);operations.requestHuman(c,trigger.created_at);return {action:'suggested',reply,reason};}
    const messageId=insertMessage(c,null,reply,'automation',ref,null,p.prepared?.flyerSnapshot?c.course_id:null,p.prepared);
    log(p.handoff?'escalated':'replied',messageId);
    if(p.stage)crm.setStage(c,p.stage);
    if(p.handoff){db.prepare("UPDATE conversations SET bot_enabled=0,status='waiting' WHERE id=?").run(c.id);operations.requestHuman(c,trigger.created_at);}
    return {action:p.handoff?'escalated':'replied',messageId,reply,reason};
  }

  // Simulación para administración: mismo plan, sin escribir y con la llamada al proveedor incluida.
  async function test(user,input){
    const brandId=input.brandId;if(typeof brandId!=='string'||!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no disponible.');crm.requireBrand(user,brandId);
    const course=input.courseId?db.prepare('SELECT * FROM courses WHERE id=? AND brand_id=?').get(input.courseId,brandId):db.prepare('SELECT * FROM courses WHERE brand_id=? AND active=1 ORDER BY title LIMIT 1').get(brandId);
    if(!course)throw fail(400,'La marca no tiene cursos activos para simular.');
    const message=text(input.text,2000);if(!message)throw fail(400,'Escribe el mensaje del cliente.');
    const fake={id:'simulacion',customer_id:user.id,brand_id:brandId,course_id:course.id,edition_id:input.editionId||null,status:'open',bot_enabled:1,assigned_to:null},trigger={id:'simulacion',text:message,created_at:now()};
    const p=plan(fake,trigger);let draft=null;
    if(p.needsProvider||(input.forceProvider&&p.intent==='unknown'&&p.knowledge.length)){const ctx=catalogue.info(course.id,fake.edition_id);draft=await provider.draft({brand:ctx.brand,course:ctx.course,edition:{name:ctx.edition.name,dateLabel:ctx.dateLabel,priceLabel:(ctx.priceCents/100).toFixed(2)+' '+ctx.currency},question:message,knowledge:p.knowledge,history:[]});}
    const reply=draft?.text||p.reply;
    return {intent:p.intent,confidence:p.confidence,mode:p.mode,reply,handoff:p.handoff,stage:p.stage,sources:[...p.sources,...(draft?.usedIds||[]).map(id=>({type:'knowledge',id}))],reason:draft?(draft.text?'Proveedor de IA: '+draft.reason:p.reason+' Proveedor: '+draft.reason):p.reason,provider:{name:provider.name,model:draft?.model||null,used:Boolean(draft)}};
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
    if(path==='/api/replies/provider'&&req.method==='GET'){json(res,200,{name:provider.name,model:provider.model,configured:provider.configured});return true;}
    if(path==='/api/replies/settings'&&req.method==='GET'){json(res,200,{settings:crm.brandsFor(user).map(b=>({...settings(b.id),brand_name:b.name})),modes:MODES,provider:{name:provider.name,model:provider.model,configured:provider.configured}});return true;}
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
  return {handle,plan,commit,classify,settings,suggestion,consumeSuggestions,history,test,seedBrand:brandId=>seedBrandKnowledge(db,brandId,now())};
}
