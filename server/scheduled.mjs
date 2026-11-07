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
const parse=(v,d)=>{try{return JSON.parse(v);}catch{return d;}};
export const LIMITS={maxText:5000,minLeadMs:30*1000,maxLeadMs:90*86400*1000,maxPending:10,staleMs:6*3600*1000};

export const KINDS={syllabus:'Temario',price:'Precio y promoción',schedule:'Fechas y docente',flyer:'Flyer de la edición'};
export function createScheduled({db,crm,catalogue=null,insertMessage,takeOver,accessConversation,broadcast,body,json,audit,rate}){
  const now=()=>Date.now();
  const view=(r,user)=>({id:r.id,conversationId:r.conversation_id,text:r.text,sendAt:r.send_at,cancelOnReply:Boolean(r.cancel_on_reply),state:r.state,reason:r.reason||null,
    material:r.material?{label:r.material_label||'Material'}:null,authorId:r.author_id,authorName:r.author_name||null,mine:Boolean(user)&&r.author_id===user.id,messageId:r.message_id||null,revision:r.revision,createdAt:r.created_at,sentAt:r.sent_at||null});
  const row=id=>db.prepare('SELECT s.*,u.name author_name FROM scheduled_messages s LEFT JOIN users u ON u.id=s.author_id WHERE s.id=?').get(id);
  const done=(id,state,reason,extra={})=>{db.prepare("UPDATE scheduled_messages SET state=?,reason=?,message_id=?,sent_at=?,revision=revision+1,updated_at=? WHERE id=? AND state='pending'").run(state,reason||null,extra.messageId||null,extra.sentAt||null,now(),id);};

  function list(c,user){
    const since=now()-3*86400*1000;
    return db.prepare("SELECT s.*,u.name author_name FROM scheduled_messages s LEFT JOIN users u ON u.id=s.author_id WHERE s.conversation_id=? AND (s.state='pending' OR s.updated_at>=?) ORDER BY s.send_at LIMIT 40").all(c.id,since).map(r=>view(r,user));
  }
  // Material del catálogo (temario, precio, fechas, flyer o plantilla aprobada): se valida con las mismas reglas que un envío manual (catalogue.prepare) y se guarda
  // QUÉ es, no su texto; el texto se arma al enviar con los datos vigentes. La vista previa de hoy sólo sirve para mostrarlo.
  function materialOf(c,input){
    const m=input?.material;if(!m)return null;if(!catalogue)throw fail(409,'Los materiales no están disponibles.');
    const pick=m.templateId?{templateId:String(m.templateId)}:m.flyerId?{flyerId:String(m.flyerId)}:KINDS[m.kind]?{kind:m.kind}:null;
    if(!pick)throw fail(400,'Elige qué material programar (temario, precio, fechas, flyer o una plantilla).');
    const prepared=catalogue.prepare(c,pick);   // lanza 409 con el motivo si la plantilla o el flyer no están aprobados o vigentes para esta conversación
    const label=pick.templateId?db.prepare('SELECT title FROM content_templates WHERE id=?').get(pick.templateId)?.title:pick.flyerId?db.prepare('SELECT title FROM flyers WHERE id=?').get(pick.flyerId)?.title:KINDS[pick.kind];
    return {pick,preview:String(prepared.text||'').slice(0,LIMITS.maxText),label:String(label||'Material').slice(0,120)};
  }
  function check(c,user,input,{material=false}={}){
    const body=material?String(input.text||'').slice(0,LIMITS.maxText):text(input.text,LIMITS.maxText),sendAt=Number(input.sendAt),t=now();
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
    const mat=materialOf(c,input),{body,sendAt}=check(c,user,mat?{...input,text:mat.preview||mat.label}:input,{material:Boolean(mat)});
    const id=randomUUID(),t=now();
    transaction(db,()=>{
      if(db.prepare("SELECT count(*) n FROM scheduled_messages WHERE conversation_id=? AND state='pending'").get(c.id).n>=LIMITS.maxPending)throw fail(409,'Este chat ya tiene '+LIMITS.maxPending+' mensajes programados. Cancela alguno primero.');
      db.prepare('INSERT INTO scheduled_messages(id,conversation_id,brand_id,author_id,text,send_at,cancel_on_reply,client_ref,created_at,updated_at,material,material_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,c.id,c.brand_id,user.id,body,sendAt,input.cancelOnReply===false?0:1,clientRef,t,t,mat?JSON.stringify(mat.pick):null,mat?mat.label:null);
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
    if(r.material&&input.text!==undefined&&input.text!==r.text)throw fail(400,'Un material del catálogo no cambia de texto: se arma al enviarse. Cancélalo y programa otro si quieres algo distinto.');
    const {body,sendAt}=check(c,user,{text:r.material?r.text:input.text??r.text,sendAt:input.sendAt??r.send_at},{material:Boolean(r.material)});
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
  // Aviso a quien lo programó cuando un mensaje NO sale por una causa ajena a ella (cierre, respuesta del cliente, canal, acceso, retraso).
  // Va a «Mis avisos» (y a push, grupo «chats»); una sola vez por mensaje y estado. Si ya no tiene la marca, no se le avisa de algo que no puede ver.
  function end(r,state,reason){
    done(r.id,state,reason);
    if(!crm.canBrand({id:r.author_id},r.brand_id)||!db.prepare('SELECT 1 FROM conversations WHERE id=?').get(r.conversation_id))return;
    const t=('Mensaje programado no enviado · «'+String(r.text).replace(/\s+/g,' ').slice(0,60)+(r.text.length>60?'…':'')+'» · '+reason).slice(0,300);
    db.prepare("INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,?,'scheduled',?,?,?)").run(randomUUID(),r.author_id,r.brand_id,r.conversation_id,t,'scheduled:'+r.id+':'+state,now());
  }
  // Lo programado por la persona que consulta, de todas sus marcas (para Mi día): sólo pendientes, lo más próximo primero.
  function mineList(user){
    return db.prepare("SELECT s.*,u.name author_name,cu.name customer_name,b.name brand_name FROM scheduled_messages s JOIN conversations c ON c.id=s.conversation_id JOIN users cu ON cu.id=c.customer_id JOIN brands b ON b.id=s.brand_id LEFT JOIN users u ON u.id=s.author_id WHERE s.author_id=? AND s.state='pending' ORDER BY s.send_at LIMIT 30").all(user.id)
      .filter(r=>crm.canBrand(user,r.brand_id)).map(r=>({...view(r,user),customerName:r.customer_name,brandName:r.brand_name}));
  }
  function sendOne(id,{force=false}={}){
    let outcome=null;
    try{
      transaction(db,()=>{
        const r=db.prepare('SELECT * FROM scheduled_messages WHERE id=?').get(id);if(!r||r.state!=='pending')return;
        const c=db.prepare('SELECT * FROM conversations WHERE id=?').get(r.conversation_id);
        if(!c){end(r,'cancelled','La conversación ya no existe.');outcome='cancelled';return;}
        if(!force&&now()-r.send_at>LIMITS.staleMs){end(r,'failed','No salió a tiempo (pasaron más de 6 horas de la hora elegida).');outcome='failed';return;}
        if(c.status==='resolved'){end(r,'cancelled','La conversación se cerró antes de la hora.');outcome='cancelled';return;}
        if(r.cancel_on_reply&&db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='customer' AND created_at>?").get(c.id,r.created_at)){end(r,'cancelled','El cliente respondió antes de la hora, así que no se envió.');outcome='cancelled';return;}
        const author=db.prepare('SELECT id,name,role,disabled FROM users WHERE id=?').get(r.author_id);
        if(!author||!crm.canBrand(author,c.brand_id)){end(r,'failed','Quien lo programó ya no tiene acceso a esta marca.');outcome='failed';return;}
        if(c.assigned_to&&c.assigned_to!==author.id&&author.role!=='admin'){end(r,'failed','Otra persona atiende ahora esta conversación.');outcome='failed';return;}
        const ref='sched:'+r.id,saved=db.prepare('SELECT id FROM messages WHERE client_ref=?').get(ref);
        let messageId=saved?.id;
        if(!messageId){
          try{
            if(r.material){const prepared=catalogue.prepare(c,parse(r.material,{}));messageId=insertMessage(c,author,prepared.text,'agent',ref,null,prepared.flyerSnapshot?c.course_id:null,prepared);}   // se arma AHORA con el catálogo vigente
            else messageId=insertMessage(c,author,r.text,'agent',ref);
          }catch(error){if(error.status){end(r,'failed',String(error.message).slice(0,300));outcome='failed';return;}throw error;}   // regla del canal (ventana de 24 h…): no sale; error inesperado: se revierte todo
          takeOver(c,author.id);
        }
        done(id,'sent',null,{messageId,sentAt:now()});outcome='sent';
      });
    }catch(error){
      console.error('Scheduled message failed:',error.name);
      try{const r=db.prepare('SELECT * FROM scheduled_messages WHERE id=?').get(id);if(r)end(r,'failed','Error inesperado al enviar.');}catch{}
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
    if(path==='/api/scheduled'){if(user.role==='customer')throw fail(403,'Los mensajes programados son para el equipo.');if(req.method!=='GET')throw fail(405,'Método no permitido.');json(res,200,{items:mineList(user)});return true;}
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
  // Para otros módulos (citas): programar el recordatorio de un cliente y retirarlo si la cita se cancela o se mueve.
  const cancelSystem=(id,reason)=>{db.prepare("UPDATE scheduled_messages SET state='cancelled',reason=?,revision=revision+1,updated_at=? WHERE id=? AND state='pending'").run(String(reason).slice(0,300),now(),id);};
  return {handle,tick,sendOne,list,mineList,create,cancelSystem};
}
