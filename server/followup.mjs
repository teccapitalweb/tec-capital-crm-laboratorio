import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { cancelConversationSteps } from './automation.mjs';

const fail=(status,message,extra={})=>Object.assign(new Error(message),{status,...extra});
const text=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
const closed=stage=>['ganada','perdida'].includes(stage);
const stages=['nuevo','interesado','inscripcion','ganada','perdida'];
const own=(value,key)=>Object.hasOwn(value,key);
export function migrateFollowup(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=4)return;
  transaction(db,()=>{
    db.exec(`ALTER TABLE opportunities ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE crm_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,opportunity_id TEXT NOT NULL REFERENCES opportunities(id),actor_id TEXT REFERENCES users(id),kind TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX crm_events_opportunity ON crm_events(opportunity_id,seq);
      INSERT INTO crm_events(opportunity_id,actor_id,kind,details,created_at)
        SELECT opportunity_id,actor_id,'stage',json_object('from',from_stage,'to',to_stage,'source','legacy'),created_at FROM opportunity_events ORDER BY created_at,id;
      PRAGMA user_version=4;`);
  });
}

export function createFollowup({db,scoped,validOwner,body,json,sendChange,audit,broadcast,beforeAssign}){
  function record(id,actor,kind,details){
    db.prepare('INSERT INTO crm_events(opportunity_id,actor_id,kind,details,created_at) VALUES(?,?,?,?,?)').run(id,actor?.id||null,kind,JSON.stringify(details),Date.now());
  }
  function stageEvent(id,actor,from,to,reason='',source=actor?'manual':'automation'){
    db.prepare('INSERT INTO opportunity_events VALUES(?,?,?,?,?,?)').run(randomUUID(),id,actor?.id||null,from,to,Date.now());
    record(id,actor,'stage',{from,to,reason,source});
  }
  function checkRevision(row,input){
    if(own(input,'expectedRevision')&&(!Number.isSafeInteger(Number(input.expectedRevision))||Number(input.expectedRevision)!==row.revision))throw fail(409,'Otra persona cambió este registro. Recarga sus datos antes de guardar.',{code:'STALE_RECORD'});
  }
  function checkActive(o,stage){
    if(!closed(stage)){
      const active=db.prepare("SELECT id FROM opportunities WHERE contact_id=? AND course_id=? AND edition_id=? AND id!=? AND stage NOT IN ('ganada','perdida')").get(o.contact_id,o.course_id,o.edition_id,o.id);
      if(active)throw fail(409,'Ya existe otra oportunidad activa para este contacto y curso. Puedes abrirla para continuar.',{code:'ACTIVE_INTEREST',activeOpportunityId:active.id});
    }
  }
  const taskValues=t=>({title:t.title,dueAt:t.due_at,ownerId:t.owner_id,ownerName:t.owner_id?db.prepare('SELECT name FROM users WHERE id=?').get(t.owner_id)?.name:null,status:t.status});
  function taskCreated(id,actor){const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(id);record(t.opportunity_id,actor,'task.created',{taskId:t.id,next:taskValues(t)});}
  function changeTasks(id,actor,{close=false,owner,assign=false}={}){
    for(const t of db.prepare("SELECT * FROM tasks WHERE opportunity_id=? AND status='open'").all(id)){
      const next={...t,status:close?'cancelled':t.status,owner_id:assign?owner:t.owner_id};
      if(next.status===t.status&&next.owner_id===t.owner_id)continue;
      db.prepare('UPDATE tasks SET owner_id=?,status=?,updated_at=?,revision=revision+1 WHERE id=?').run(next.owner_id,next.status,Date.now(),t.id);
      record(id,actor,'task.updated',{taskId:t.id,previous:taskValues(t),next:taskValues(next),reason:close?'Oportunidad cerrada':'Cambio de responsable de la oportunidad'});
    }
  }
  function changeStage(id,to,actor=null,reason=''){
    const o=db.prepare('SELECT * FROM opportunities WHERE id=?').get(id);
    if(!stages.includes(to))throw fail(400,'Etapa no válida.');
    // Rules can advance interest, but cannot undo a milestone or close a sale.
    if(!actor&&(closed(o.stage)||closed(to)||stages.indexOf(to)<=stages.indexOf(o.stage)))return false;
    checkActive(o,to);
    if(o.stage===to)return false;
    db.prepare('UPDATE opportunities SET stage=?,lost_reason=?,updated_at=?,revision=revision+1 WHERE id=?').run(to,to==='perdida'?reason:'',Date.now(),id);
    stageEvent(id,actor,o.stage,to,reason);
    if(closed(to))changeTasks(id,actor,{close:true});
    return true;
  }
  function assign(id,owner,actor=null){
    if(owner)beforeAssign?.(id,owner);
    const o=db.prepare('SELECT * FROM opportunities WHERE id=?').get(id);
    if(o.owner_id!==owner){
      const name=userId=>userId?db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name:null;
      record(id,actor,'owner',{from:name(o.owner_id),to:name(owner)});
      db.prepare('UPDATE opportunities SET owner_id=?,updated_at=?,revision=revision+1 WHERE id=?').run(owner,Date.now(),id);
      changeTasks(id,actor,{assign:true,owner});
    }
  }
  async function handle(req,res,path,user){
    const history=path.match(/^\/api\/crm\/opportunities\/([a-f0-9-]+)\/history$/);
    if(history&&req.method==='GET'){
      const o=scoped('opportunities',history[1],user),url=new URL(req.url,'http://localhost');
      const before=Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER);
      if(!Number.isSafeInteger(before)||before<1)throw fail(400,'Página de historial no válida.');
      const rows=db.prepare('SELECT e.*,u.name actor_name FROM crm_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.opportunity_id=? AND e.seq<? ORDER BY e.seq DESC LIMIT 51').all(o.id,before);
      const events=rows.slice(0,50).map(e=>({...e,details:JSON.parse(e.details)}));
      json(res,200,{events,nextBefore:rows.length>50?events.at(-1).seq:null});return true;
    }
    const opportunity=path.match(/^\/api\/crm\/opportunities\/([a-f0-9-]+)$/);
    if(opportunity&&req.method==='PATCH'){
      const input=await body(req);let brand;
      transaction(db,()=>{
        const o=scoped('opportunities',opportunity[1],user),stage=input.stage,owner=validOwner(input.ownerId||null,o.brand_id),reason=text(input.lostReason,300);brand=o.brand_id;
        checkRevision(o,input);
        if(!stages.includes(stage)||(stage==='perdida'&&!reason))throw fail(400,'Indica una etapa y, si se perdió, el motivo.');
        if(!closed(stage)&&!owner)throw fail(400,'Asigna un responsable para continuar.');
        checkActive(o,stage);
        changeStage(o.id,stage,user,reason);
        if(stage===o.stage&&reason!==o.lost_reason&&stage==='perdida'){
          db.prepare('UPDATE opportunities SET lost_reason=?,updated_at=?,revision=revision+1 WHERE id=?').run(reason,Date.now(),o.id);
          record(o.id,user,'reason',{from:o.lost_reason,to:reason});
        }
        if(owner!==o.owner_id){
          assign(o.id,owner,user);
          db.prepare("UPDATE conversations SET assigned_to=?,bot_enabled=0,updated_at=? WHERE id IN (SELECT conversation_id FROM conversation_opportunities WHERE opportunity_id=?) AND status!='resolved'").run(owner,Date.now(),o.id);
          db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id IN (SELECT conversation_id FROM conversation_opportunities WHERE opportunity_id=?) AND state='pending'").run(o.id);
          for(const link of db.prepare('SELECT conversation_id FROM conversation_opportunities WHERE opportunity_id=?').all(o.id))cancelConversationSteps(db,link.conversation_id,'owner_changed');
        }
      });
      audit(user,'opportunity.updated',opportunity[1]);
      for(const link of db.prepare('SELECT conversation_id FROM conversation_opportunities WHERE opportunity_id=?').all(opportunity[1]))broadcast('conversation',link.conversation_id);
      sendChange(brand);json(res,200,{ok:true});return true;
    }
    const task=path.match(/^\/api\/crm\/tasks\/([a-f0-9-]+)$/);
    if(task&&req.method==='PATCH'){
      const input=await body(req);let brand;
      transaction(db,()=>{
        const t=scoped('tasks',task[1],user);brand=t.brand_id;checkRevision(t,input);
        if(t.owner_id&&t.owner_id!==user.id&&user.role!=='admin')throw fail(403,'Esta tarea pertenece a otro asesor.');
        if(!['title','dueAt','ownerId','status'].some(key=>own(input,key)))throw fail(400,'Indica qué quieres cambiar en la tarea.');
        const next={...t,title:own(input,'title')?text(input.title,180):t.title,due_at:own(input,'dueAt')?Number(input.dueAt):t.due_at,owner_id:own(input,'ownerId')?validOwner(input.ownerId||null,t.brand_id):t.owner_id,status:input.status??t.status};
        if(!next.title||!['open','done','cancelled'].includes(next.status))throw fail(400,'Indica un título y estado válidos.');
        if(own(input,'dueAt')&&next.due_at!==t.due_at&&(!Number.isSafeInteger(next.due_at)||next.due_at<Date.now()-60000||next.due_at>Date.now()+366*86400000))throw fail(400,'Elige una fecha futura dentro del próximo año.');
        if(next.status==='open'&&closed(db.prepare('SELECT stage FROM opportunities WHERE id=?').get(t.opportunity_id).stage))throw fail(400,'Reabre primero la oportunidad.');
        if(['title','due_at','owner_id','status'].some(key=>next[key]!==t[key])){
          db.prepare('UPDATE tasks SET title=?,due_at=?,owner_id=?,status=?,updated_at=?,revision=revision+1 WHERE id=?').run(next.title,next.due_at,next.owner_id,next.status,Date.now(),t.id);
          record(t.opportunity_id,user,'task.updated',{taskId:t.id,previous:taskValues(t),next:taskValues(next),reason:text(input.reason,300)});
        }
      });
      audit(user,'task.updated',task[1]);sendChange(brand);json(res,200,{ok:true});return true;
    }
    return false;
  }
  return {handle,record,stageEvent,taskCreated,changeStage,assign,checkRevision};
}
