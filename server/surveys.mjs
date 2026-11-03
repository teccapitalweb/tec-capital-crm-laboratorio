import {randomUUID,randomBytes} from 'node:crypto';
import {transaction} from './database.mjs';
import {csvCell} from './contacts.mjs';

// Encuestas (Fase 2 · resto del bloque 2.3). Una encuesta por sesión realizada o por apertura: cada inscrito recibe por su
// chat una invitación con token propio y responde sin iniciar sesión en /encuesta/<token> (o desde la app, por la misma
// API). Tres calificaciones de 1 a 5, recomendación de 0 a 10 y comentario. Hacia la bitácora común van sólo las cifras;
// los nombres los ve el equipo con acceso a la marca. Envío automático por marca (al realizar sesión y/o al cerrar),
// apagado por omisión; el envío manual funciona siempre desde la ficha de la apertura.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const QUESTIONS=[{id:'content',label:'Contenido del curso'},{id:'instructor',label:'Docente'},{id:'organization',label:'Organización y plataforma'}];
export const SURVEY_MODES={off:'Sin encuesta automática',session:'Al marcar cada sesión como realizada',close:'Al cerrar la apertura',both:'Por sesión y al cerrar'};
export function npsOf(rows){
  const n=rows.length;if(!n)return {promoters:0,passives:0,detractors:0,score:null};
  let p=0,d=0;for(const r of rows){if(r.nps>=9)p++;else if(r.nps<=6)d++;}
  return {promoters:p,passives:n-p-d,detractors:d,score:Math.round((p-d)/n*100)};
}
async function readForm(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)throw fail(413,'Respuesta demasiado larga.');chunks.push(chunk);}return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));}

export function createSurveys({db,crm,events,insertMessage,content=null,body,json,audit,broadcast,rate,now=Date.now,env=process.env}){
  const origin=()=>(env.APP_ORIGIN||'').replace(/\/$/,'');
  const link=token=>origin()+'/encuesta/'+token;
  const roleOf=user=>db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
  const requireStaff=user=>{const u=roleOf(user);if(!u||u.disabled||!['admin','agent'].includes(u.role))throw fail(403,'Las encuestas son para el equipo de atención.');};
  const edition=id=>{const e=db.prepare('SELECT * FROM editions WHERE id=?').get(id);if(!e)throw fail(404,'Edición no disponible.');return e;};
  const courseOf=e=>db.prepare('SELECT id,title FROM courses WHERE id=?').get(e.course_id)||{id:e.course_id,title:'Curso'};
  const get=id=>db.prepare('SELECT * FROM surveys WHERE id=?').get(id);
  const longDate=t=>new Intl.DateTimeFormat('es-MX',{dateStyle:'long',timeZone:'America/Mexico_City'}).format(t);
  function notify(e,title,key){
    const t=now(),targets=e.coordinator_id?[e.coordinator_id]:db.prepare("SELECT id FROM users WHERE role IN ('admin','agent') AND COALESCE(disabled,0)=0 AND (role='admin' OR id IN (SELECT user_id FROM brand_members WHERE brand_id=?))").all(e.brand_id).map(u=>u.id);
    for(const id of targets)db.prepare('INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,NULL,?,?,?,?)').run(randomUUID(),id,e.brand_id,'coordination',title,key,t);
  }
  // Crea (o reutiliza) la encuesta de una sesión realizada o de la apertura y envía la invitación a cada inscrito que aún
  // no la tiene. Repetirla sólo alcanza a inscritos nuevos. Dentro de la transacción de send().
  function open(e,{kind,sessionId=null},actor,source){
    const c=courseOf(e);let s=null;
    if(kind==='session'){s=db.prepare('SELECT * FROM edition_sessions WHERE id=? AND edition_id=?').get(sessionId,e.id);if(!s)throw fail(404,'La sesión no pertenece a esta apertura.');if(s.status!=='done')throw fail(409,'La encuesta de una sesión se envía cuando está marcada como realizada.');}
    else if(kind==='edition'){sessionId=null;if(!['running','closed'].includes(e.run_status))throw fail(409,'La encuesta de la apertura se envía con el curso en curso o cerrado.');}
    else throw fail(400,'Tipo de encuesta no válido.');
    const t=now();
    let survey=db.prepare("SELECT * FROM surveys WHERE edition_id=? AND COALESCE(session_id,'')=?").get(e.id,sessionId||'');
    if(!survey){const id=randomUUID(),title=kind==='session'?'Sesión '+s.number+': '+s.title:'Cierre · '+c.title+' · '+e.name;db.prepare("INSERT INTO surveys(id,brand_id,edition_id,session_id,kind,title,status,source,created_by,created_at) VALUES(?,?,?,?,?,?,'open',?,?,?)").run(id,e.brand_id,e.id,sessionId,kind,title,source,actor?.id||null,t);survey=get(id);}
    if(survey.status!=='open')throw fail(409,'La encuesta está cerrada.');
    const rows=db.prepare("SELECT en.id enrollment_id,en.contact_id,o.conversation_id,(SELECT status FROM contact_consent k WHERE k.contact_id=en.contact_id) consent FROM enrollments en JOIN orders o ON o.id=en.order_id WHERE en.edition_id=? AND en.status='enrolled' AND en.id NOT IN (SELECT enrollment_id FROM survey_invites WHERE survey_id=?) ORDER BY en.created_at").all(e.id,survey.id);
    let sent=0,skipped=0;const conversations=[];
    for(const r of rows){
      if(r.consent==='opted_out'){skipped++;continue;}   // la baja de mensajes se respeta también aquí
      const conv=db.prepare('SELECT * FROM conversations WHERE id=?').get(r.conversation_id);if(!conv||conv.status==='resolved'){skipped++;continue;}
      const token=randomBytes(16).toString('hex');
      db.prepare('INSERT INTO survey_invites(token,survey_id,brand_id,enrollment_id,contact_id,conversation_id,sent_at) VALUES(?,?,?,?,?,?,?)').run(token,survey.id,e.brand_id,r.enrollment_id,r.contact_id,conv.id,t);
      const first=db.prepare('SELECT name FROM users WHERE id=?').get(conv.customer_id)?.name?.split(' ')[0]||null,what=kind==='session'?'la sesión '+s.number+' («'+s.title+'»)':'el curso';
      const tpl=content?.render('survey_request',e.brand_id,{courseId:e.course_id,editionId:e.id,name:first,extra:{sesion:kind==='session'?s.number+'. '+s.title:'Curso completo',enlace_encuesta:link(token)}});
      const msg=tpl?tpl.text:`¿Cómo te fue en ${what} de ${c.title}? Cuéntanos en dos minutos (tres calificaciones, una recomendación y un comentario): ${link(token)}\nTus respuestas ayudan a mejorar las próximas sesiones. Laboratorio: encuesta de práctica.`;
      try{insertMessage(conv,null,msg,'automation','survey:'+survey.id+':'+r.enrollment_id,null,null,null,{category:'utility'});sent++;conversations.push(conv.id);}
      catch(err){if(err?.status!==409)throw err;db.prepare('DELETE FROM survey_invites WHERE token=?').run(token);skipped++;}
    }
    if(sent)events.publish({type:'encuesta.enviada',brandId:e.brand_id,entityKind:'survey',entityId:survey.id,payload:{editionId:e.id,sessionId,kind,title:survey.title,invited:sent,skipped},actorId:actor?.id||null,source,dedupeKey:'encuesta.enviada:'+survey.id+':'+t});
    if(skipped)notify(e,'Encuesta «'+survey.title+'»: '+skipped+(skipped===1?' inscrito no recibió':' inscritos no recibieron')+' la invitación (baja de mensajes o chat cerrado)','survey:'+survey.id+':skipped:'+t);
    return {survey:get(survey.id),sent,skipped,conversations};
  }
  function send(e,opts,actor,source){
    let r;transaction(db,()=>{r=open(e,opts,actor,source);});
    for(const id of r.conversations)broadcast('conversation',id);broadcast('crm',null,{brandId:e.brand_id});
    if(actor)audit(actor,'survey.send',r.survey.id);return r;
  }
  // ---- respuesta pública por token (sin sesión; límite por IP)
  const invite=token=>/^[a-f0-9]{32}$/.test(token||'')?db.prepare('SELECT i.*,s.title,s.kind,s.status survey_status,s.edition_id,s.session_id FROM survey_invites i JOIN surveys s ON s.id=i.survey_id WHERE i.token=?').get(token):null;
  function publicView(i){
    const e=db.prepare('SELECT e.name edition_name,c.title course_title,b.name brand_name FROM editions e JOIN courses c ON c.id=e.course_id JOIN brands b ON b.id=e.brand_id WHERE e.id=?').get(i.edition_id);
    return {title:i.title,kind:i.kind,course:e?.course_title||'',edition:e?.edition_name||'',brand:e?.brand_name||'',open:i.survey_status==='open',answered:Boolean(i.answered_at),questions:QUESTIONS};
  }
  function answer(i,input){
    if(i.answered_at)throw fail(409,'Esta encuesta ya fue respondida. ¡Gracias!');
    if(i.survey_status!=='open')throw fail(409,'Esta encuesta ya cerró. Gracias de todos modos.');
    const score=(v,lo,hi,label)=>{const n=Number(v);if(v===''||v===undefined||v===null||!Number.isInteger(n)||n<lo||n>hi)throw fail(400,'Califica «'+label+'» de '+lo+' a '+hi+'.');return n;};
    const a={content:score(input.content,1,5,'Contenido del curso'),instructor:score(input.instructor,1,5,'Docente'),organization:score(input.organization,1,5,'Organización y plataforma'),nps:score(input.nps,0,10,'¿Lo recomendarías?'),comment:text(input.comment,1000)};
    const t=now();
    transaction(db,()=>{
      if(!db.prepare('UPDATE survey_invites SET answered_at=? WHERE token=? AND answered_at IS NULL').run(t,i.token).changes)throw fail(409,'Esta encuesta ya fue respondida. ¡Gracias!');
      db.prepare('INSERT INTO survey_answers(token,survey_id,content_score,instructor_score,organization_score,nps,comment,created_at) VALUES(?,?,?,?,?,?,?,?)').run(i.token,i.survey_id,a.content,a.instructor,a.organization,a.nps,a.comment,t);
      // A la bitácora común van las cifras; el comentario y el nombre se quedan en la tabla de la marca.
      events.publish({type:'encuesta.respondida',brandId:i.brand_id,entityKind:'survey',entityId:i.survey_id,payload:{editionId:i.edition_id,sessionId:i.session_id,title:i.title,contentScore:a.content,instructorScore:a.instructor,organizationScore:a.organization,nps:a.nps,comment:Boolean(a.comment)},actorId:null,source:'surveys.public',dedupeKey:'encuesta.respondida:'+i.token});
    });
    broadcast('crm',null,{brandId:i.brand_id});return a;
  }
  // ---- resultados para el equipo (el llamador ya comprobó el acceso a la marca)
  const answersOf=id=>db.prepare('SELECT a.*,c.name contact_name FROM survey_answers a JOIN survey_invites i ON i.token=a.token JOIN contacts c ON c.id=i.contact_id WHERE a.survey_id=? ORDER BY a.created_at').all(id);
  function results(e){
    return db.prepare('SELECT * FROM surveys WHERE edition_id=? ORDER BY created_at').all(e.id).map(s=>{
      const answers=answersOf(s.id),avg=k=>answers.length?Math.round(answers.reduce((n,a)=>n+a[k],0)/answers.length*10)/10:null;
      return {...s,sessionNumber:s.session_id?db.prepare('SELECT number FROM edition_sessions WHERE id=?').get(s.session_id)?.number||null:null,invited:db.prepare('SELECT count(*) n FROM survey_invites WHERE survey_id=?').get(s.id).n,answered:answers.length,
        averages:{content:avg('content_score'),instructor:avg('instructor_score'),organization:avg('organization_score'),overall:answers.length?Math.round(answers.reduce((n,a)=>n+a.content_score+a.instructor_score+a.organization_score,0)/(answers.length*3)*10)/10:null},
        nps:npsOf(answers),comments:answers.filter(a=>a.comment).map(a=>({name:a.contact_name,comment:a.comment,at:a.created_at}))};
    });
  }
  function close(s,user){
    requireStaff(user);crm.requireBrand(user,s.brand_id);if(s.status!=='open')throw fail(409,'La encuesta ya está cerrada.');
    db.prepare("UPDATE surveys SET status='closed',closed_by=?,closed_at=? WHERE id=?").run(user.id,now(),s.id);audit(user,'survey.close',s.id);broadcast('crm',null,{brandId:s.brand_id});return get(s.id);
  }
  const csv=s=>['encuesta,alumno,contenido,docente,organizacion,recomendacion,comentario,fecha',...answersOf(s.id).map(r=>[s.title,r.contact_name,r.content_score,r.instructor_score,r.organization_score,r.nps,r.comment,new Date(r.created_at).toISOString()].map(csvCell).join(','))].join('\n')+'\n';
  // ---- página pública (sin script: formulario clásico; estilos en línea permitidos por la CSP)
  function page(i,token,state){
    const v=i?publicView(i):null;
    const head=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Encuesta · ${esc(v?.title||'no disponible')}</title><meta name="robots" content="noindex"><style>body{margin:0;background:#f1f4f6;color:#242428;font:15px/1.6 Inter,'Segoe UI',Helvetica,Arial,sans-serif}main{max-width:640px;margin:0 auto;padding:40px 16px}.card{background:#fff;border:1px solid #e1e6ea;border-radius:18px;padding:28px}.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#2f6f8f;font-weight:600}h1{font-size:24px;margin:6px 0 4px;font-weight:600}.sub{margin:0 0 18px;color:#636977;font-size:13px}fieldset{border:0;padding:0;margin:0 0 18px}legend{font-size:13px;font-weight:500;margin-bottom:8px}.scale{display:flex;flex-wrap:wrap;gap:6px}.scale label{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:44px;min-height:40px;padding:0 8px;border:1px solid #e2e5eb;border-radius:12px;background:#fafbfc;font-size:13px;cursor:pointer}.scale input{margin:0}.scale label:has(input:checked){border-color:#2f6f8f;background:#e8f0f4;color:#255a75;font-weight:600}label.block{display:block;font-size:13px;font-weight:500;margin:4px 0 18px}textarea{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border:1px solid #d7dbe3;border-radius:12px;font:inherit;font-size:14px}button{display:inline-block;padding:11px 18px;border:1px solid #2f6f8f;border-radius:12px;background:#2f6f8f;color:#fff;font:inherit;font-size:13px;cursor:pointer;min-height:40px}.state{display:inline-block;padding:7px 14px;border-radius:20px;font-size:13px;border:1px solid #cfe6d9;background:#e7f4ed;color:#256b4e}.err{color:#a7433a;font-size:13px;background:#fcecea;border:1px solid #f2d2ce;border-radius:12px;padding:10px 12px}small{display:block;color:#636977;font-size:12px;margin-top:22px}</style></head><body><main><div class="card"><div class="eyebrow">Encuesta de satisfacción</div>`;
    const radios=(name,lo,hi)=>Array.from({length:hi-lo+1},(_,k)=>lo+k).map(n=>`<label><input type="radio" name="${name}" value="${n}" required> ${n}</label>`).join('');
    let main;
    if(!v)main=`<h1>Encuesta no disponible</h1><p>El enlace no corresponde a ninguna encuesta de este laboratorio. Revisa que esté completo.</p>`;
    else if(state?.ok||v.answered)main=`<h1>¡Gracias!</h1><span class="state">Respuesta registrada</span><p>Tus respuestas sobre <strong>${esc(v.title)}</strong> (${esc(v.course)} · ${esc(v.edition)}) quedaron registradas. Las ve sólo el equipo de ${esc(v.brand)}.</p>`;
    else if(!v.open)main=`<h1>Encuesta cerrada</h1><p>La encuesta <strong>${esc(v.title)}</strong> ya no recibe respuestas. Gracias de todos modos.</p>`;
    else main=`<h1>${esc(v.course)}</h1><p class="sub">${esc(v.title)} · ${esc(v.edition)} · ${esc(v.brand)}</p>${state?.error?`<p class="err">${esc(state.error)}</p>`:''}<form method="post" action="/encuesta/${esc(token)}">${QUESTIONS.map(q=>`<fieldset><legend>${esc(q.label)} · 1 = muy mal, 5 = excelente</legend><div class="scale">${radios(q.id,1,5)}</div></fieldset>`).join('')}<fieldset><legend>¿Recomendarías este curso? · 0 = nada, 10 = totalmente</legend><div class="scale">${radios('nps',0,10)}</div></fieldset><label class="block">Comentario (opcional)<textarea name="comment" maxlength="1000" rows="3" placeholder="Qué te gustó, qué mejorarías…"></textarea></label><button type="submit">Enviar respuestas</button></form>`;
    return head+main+`<small>Laboratorio TEC Capital · encuesta de práctica. Consulta del ${esc(longDate(now()))}.</small></div></main></body></html>`;
  }
  async function handlePublic(req,res,path,ip){
    let x;
    if((x=path.match(/^\/encuesta\/([a-f0-9]{32})$/))){
      rate('survey:'+ip,60);const i=invite(x[1]);
      if(req.method==='GET'){res.writeHead(i?200:404,{'Content-Type':'text/html; charset=utf-8'});res.end(page(i,x[1],null));return true;}
      if(req.method==='POST'){
        if(!i){res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'});res.end(page(null,x[1],null));return true;}
        let state;try{answer(i,await readForm(req));state={ok:true};}catch(e){if(!e.status||e.status>=500)throw e;state={error:e.message};}
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(page(invite(x[1]),x[1],state));return true;
      }
      throw fail(405,'Método no permitido.');
    }
    if((x=path.match(/^\/api\/survey\/([a-f0-9]{32})$/))){
      rate('survey:'+ip,60);const i=invite(x[1]);if(!i){json(res,404,{error:'Encuesta no encontrada.'});return true;}
      if(req.method==='GET'){json(res,200,{survey:publicView(i)});return true;}
      if(req.method==='POST'){json(res,200,{ok:true,answer:answer(i,await body(req))});return true;}
      throw fail(405,'Método no permitido.');
    }
    return false;
  }
  async function handle(req,res,path,user){
    if(!path.startsWith('/api/surveys'))return false;let x;
    if((x=path.match(/^\/api\/surveys\/([a-f0-9-]{36})(\.csv|\/close)$/))){
      const s=get(x[1]);if(!s)throw fail(404,'Encuesta no encontrada.');requireStaff(user);crm.requireBrand(user,s.brand_id);
      if(x[2]==='.csv'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="encuesta-'+s.id.slice(0,8)+'.csv"'});res.end('﻿'+csv(s));return true;}
      if(x[2]==='/close'&&req.method==='POST'){json(res,200,{survey:close(s,user)});return true;}
      throw fail(405,'Método no permitido.');
    }
    throw fail(404,'Ruta de encuestas no encontrada.');
  }
  // ---- automática por marca: al realizar una sesión y/o al cerrar la apertura (coordination_settings.survey_mode)
  const modeOf=b=>db.prepare('SELECT survey_mode FROM coordination_settings WHERE brand_id=?').get(b)?.survey_mode||'off';
  function onSessionDone(ev){const s=db.prepare('SELECT * FROM edition_sessions WHERE id=?').get(ev.entity_id);if(!s||s.status!=='done'||!['session','both'].includes(modeOf(s.brand_id)))return;send(edition(s.edition_id),{kind:'session',sessionId:s.id},null,'surveys.auto');}
  function onClosed(ev){const e=db.prepare('SELECT * FROM editions WHERE id=?').get(ev.entity_id);if(!e||e.run_status!=='closed'||!['close','both'].includes(modeOf(e.brand_id)))return;send(e,{kind:'edition'},null,'surveys.auto');}
  events.subscribe('sesion.realizada','surveys.auto',onSessionDone);
  events.subscribe('apertura.cerrada','surveys.auto',onClosed);
  return {handle,handlePublic,send,results,close,answer,invite,publicView};
}
