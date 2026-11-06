import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';

// Mensajes programados (docs/PLAN_MENSAJES_PROGRAMADOS.md). Una persona del equipo deja un texto listo en un chat y sale solo a la hora
// elegida, a nombre de ella. Al enviarse es un mensaje normal (misma ruta, mismas reglas del canal: ventana de servicio, etc.).
// Reglas de seguridad de negocio, comprobadas en el momento de enviar y no sólo al programar:
//  · la conversación sigue abierta; · el cliente no ha respondido (si la persona lo pidió: por omisión sí); · la autora sigue teniendo la marca;
//  · nadie más atiende el chat (salvo administración); · no se manda un mensaje viejo: pasadas 6 h de la hora elegida se marca como no enviado.
// El envío es síncrono (SQLite) y usa una referencia determinista, así que un reintento o dos ciclos seguidos no lo duplican.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.replace(/\r\n/g,'\n').trim().slice(0,max):'';
export const LIMITS={maxText:5000,minLeadMs:30*1000,maxLeadMs:90*86400*1000,maxPending:10,staleMs:6*3600*1000};

export function createScheduled({db,crm,insertMessage,takeOver,accessConversation,broadcast,body,json,audit,rate}){
  const now=()=>Date.now();
  const view=(r,user)=>({id:r.id,conversationId:r.conversation_id,text:r.text,sendAt:r.send_at,cancelOnReply:Boolean(r.cancel_on_reply),state:r.state,reason:r.reason||null,
    authorId:r.author_id,authorName:r.author_name||null,mine:Boolean(user)&&r.author_id===user.id,messageId:r.message_id||null,revision:r.revision,createdAt:r.created_at,sentAt:r.sent_at||null});
  const row=id=>db.prepare('SELECT s.*,u.name author_name FROM scheduled_messages s LEFT JOIN users u ON u.id=s.author_id WHERE s.id=?').get(id);
  const done=(id,state,reason,extra={})=>{db.prepare("UPDATE scheduled_messages SET state=?,reason=?,message_id=?,sent_at=?,revision=revision+1,updated_at=? WHERE id=? AND state='pending'").run(state,reason||null,extra.messageId||null,extra.sentAt||null,now(),id);};

  function list(c,user){
    const since=now()-3*86400*1000;
    return db.prepare("SELECT s.*,u.name author_name FROM scheduled_messages s LEFT JOIN users u ON u.id=s.author_id WHERE s.conversation_id=? AND (s.state='pending' OR s.updated_at>=?) ORDER BY s.send_at LIMIT 40").all(c.id,since).map(r=>view(r,user));
  }
  function check(c,user,input,{editing=null}={}){
    const body=text(input.text,LIMITS.maxText),sendAt=Number(input.sendAt),t=now();
    if(!body)throw fail(400,'Escribe el mensaje que quieres programar.');
    if(!Number.isSafeInteger(sendAt))throw fail(400,'Elige la fecha y la hora.');
    if(sendAt<t+LIMITS.minLeadMs)throw fail(400,'La hora tiene que ser futura (al menos en un minuto). Para enviarlo ya, usa Enviar.');
    if(sendAt>t+LIMITS.maxLeadMs)throw fail(400,'Sólo se puede programar hasta 90 días adelante.');
    if(c.status==='resolved')throw fail(409,'La conversación está cerrada.');
    if(c.assigned_to&&c.assigned_to!==user.id&&user.role!=='admin')throw fail(409,'Otro asesor está atendiendo esta conversación.');
    return {body,sendAt};
  }
  function create(c,user,input){
    const clientRef=text(input.clientRef,100);if(!/^[a-zA-Z0-9-]{16,100}$/.test(clientRef))throw fail(400,'Referencia no válida.');
    const again=db.prepare('SELECT id FROM scheduled_messages WHERE author_id=? AND client_ref=?').get(user.id,clientRef);
    if(again){if(row(again.id).conversation_id!==c.id)throw fail(409,'Referencia ya utilizada.');return {item:view(row(again.id),user),duplicate:true};}
    const {body,sendAt}=check(c,user,input);
    const id=randomUUID(),t=now();
    transaction(db,()=>{
      if(db.prepare("SELECT count(*) n FROM scheduled_messages WHERE conversation_id=? AND state='pending'").get(c.id).n>=LIMITS.maxPending)throw fail(409,'Este chat ya tiene '+LIMITS.maxPending+' mensajes programados. Cancela alguno primero.');
      db.prepare('INSERT INTO scheduled_messages(id,conversation_id,brand_id,author_id,text,send_at,cancel_on_reply,client_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,c.id,c.brand_id,user.id,body,sendAt,input.cancelOnReply===false?0:1,clientRef,t,t);
    });
    return {item:view(row(id),user),duplicate:false};
  }
  function mine(user,id){
    const r=row(id);if(!r)throw fail(404,'Mensaje programado no disponible.');
    const c=accessConversation(r.conversation_id,user);   // alcance por marca: otra marca recibe 404
    if(r.author_id!==user.id&&user.role!=='admin')throw fail(403,'Sólo quien lo programó o administración puede cambiarlo.');
    return {r,c};
  }
  function edit(user,id,input){
    const {r,c}=mine(user,id);
    if(r.state!=='pending')throw fail(409,'Este mensaje ya no está pendiente.');
    if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==r.revision)throw fail(409,'Otra persona lo cambió. Vuelve a abrirlo.');
    const {body,sendAt}=check(c,user,{text:input.text??r.text,sendAt:input.sendAt??r.send_at});
    const changed=db.prepare("UPDATE scheduled_messages SET text=?,send_at=?,cancel_on_reply=?,revision=revision+1,updated_at=? WHERE id=? AND state='pending' AND revision=?").run(body,sendAt,input.cancelOnReply===undefined?r.cancel_on_reply:input.cancelOnReply?1:0,now(),id,r.revision).changes;
    if(!changed)throw fail(409,'Este mensaje cambió mientras lo editabas.');
    return view(row(id),user);
  }
  function cancel(user,id){
    const {r}=mine(user,id);
    if(r.state!=='pending')throw fail(409,'Este mensaje ya no está pendiente.');
    done(id,'cancelled','Cancelado por '+(db.prepare('SELECT name FROM users WHERE id=?').get(user.id)?.name||'el equipo')+'.');
    return view(row(id),user);
  }

  // Envío de una fila vencida. Devuelve el estado final. Nunca lanza: cualquier problema deja la fila «no enviado» con el motivo.
  function sendOne(id,{force=false}={}){
    let outcome=null;
    try{
      transaction(db,()=>{
        const r=db.prepare('SELECT * FROM scheduled_messages WHERE id=?').get(id);if(!r||r.state!=='pending')return;
        const c=db.prepare('SELECT * FROM conversations WHERE id=?').get(r.conversation_id);
        if(!c){done(id,'cancelled','La conversación ya no existe.');outcome='cancelled';return;}
        if(!force&&now()-r.send_at>LIMITS.staleMs){done(id,'failed','No salió a tiempo (pasaron más de 6 horas de la hora elegida).');outcome='failed';return;}
        if(c.status==='resolved'){done(id,'cancelled','La conversación se cerró antes de la hora.');outcome='cancelled';return;}
        if(r.cancel_on_reply&&db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='customer' AND created_at>?").get(c.id,r.created_at)){done(id,'cancelled','El cliente respondió antes de la hora, así que no se envió.');outcome='cancelled';return;}
        const author=db.prepare('SELECT id,name,role,disabled FROM users WHERE id=?').get(r.author_id);
        if(!author||!crm.canBrand(author,c.brand_id)){done(id,'failed','Quien lo programó ya no tiene acceso a esta marca.');outcome='failed';return;}
        if(c.assigned_to&&c.assigned_to!==author.id&&author.role!=='admin'){done(id,'failed','Otra persona atiende ahora esta conversación.');outcome='failed';return;}
        const ref='sched:'+r.id,saved=db.prepare('SELECT id FROM messages WHERE client_ref=?').get(ref);
        let messageId=saved?.id;
        if(!messageId){
          try{messageId=insertMessage(c,author,r.text,'agent',ref);}
          catch(error){if(error.status){done(id,'failed',String(error.message).slice(0,300));outcome='failed';return;}throw error;}   // regla del canal (ventana de 24 h…): no sale; error inesperado: se revierte todo
          takeOver(c,author.id);
        }
        done(id,'sent',null,{messageId,sentAt:now()});outcome='sent';
      });
    }catch(error){
      console.error('Scheduled message failed:',error.name);
      try{db.prepare("UPDATE scheduled_messages SET state='failed',reason=?,revision=revision+1,updated_at=? WHERE id=? AND state='pending'").run('Error inesperado al enviar.',now(),id);}catch{}
      outcome='failed';
    }
    const r=db.prepare('SELECT conversation_id FROM scheduled_messages WHERE id=?').get(id);if(r&&outcome)broadcast('conversation',r.conversation_id);
    return outcome;
  }
  function tick(){
    const due=db.prepare("SELECT id FROM scheduled_messages WHERE state='pending' AND send_at<=? ORDER BY send_at LIMIT 20").all(now());
    for(const d of due)sendOne(d.id);
    return due.length;
  }

  async function handle(req,res,path,user){
    let m=path.match(/^\/api\/conversations\/([a-f0-9-]+)\/scheduled$/);
    if(m){
      if(user.role==='customer')throw fail(403,'Los mensajes programados son para el equipo.');
      const c=accessConversation(m[1],user);crm.requireBrand(user,c.brand_id);
      if(req.method==='GET'){json(res,200,{items:list(c,user),limits:{maxPending:LIMITS.maxPending,maxDays:90}});return true;}
      if(req.method==='POST'){rate('sched:'+user.id,90);const out=create(c,user,await body(req));if(!out.duplicate){audit(user,'scheduled.create',out.item.id);broadcast('conversation',c.id);}json(res,out.duplicate?200:201,{item:out.item,duplicate:out.duplicate});return true;}
      throw fail(405,'Método no permitido.');
    }
    m=path.match(/^\/api\/scheduled\/([a-f0-9-]+)(?:\/(cancel|send-now))?$/);
    if(!m)return false;
    if(user.role==='customer')throw fail(403,'Los mensajes programados son para el equipo.');
    rate('sched:'+user.id,120);
    if(!m[2]&&req.method==='PATCH'){const item=edit(user,m[1],await body(req));audit(user,'scheduled.edit',m[1]);broadcast('conversation',item.conversationId);json(res,200,{item});return true;}
    if(m[2]==='cancel'&&req.method==='POST'){const item=cancel(user,m[1]);audit(user,'scheduled.cancel',m[1]);broadcast('conversation',item.conversationId);json(res,200,{item});return true;}
    if(m[2]==='send-now'&&req.method==='POST'){
      const {r}=mine(user,m[1]);if(r.state!=='pending')throw fail(409,'Este mensaje ya no está pendiente.');
      const outcome=sendOne(m[1],{force:true});audit(user,'scheduled.send_now',m[1]);json(res,200,{item:view(row(m[1]),user),outcome});return true;
    }
    throw fail(405,'Método no permitido.');
  }
  return {handle,tick,sendOne,list};
}
