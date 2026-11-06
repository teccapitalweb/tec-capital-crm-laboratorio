import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';
import {buildVerdicts,VERDICTS,dayKey,isKey,keyMs,daysBetween} from './ads-engine.mjs';

// Pauta (docs/PLAN_PAUTA.md): el panel de tráfico de IPCIL dentro del CRM. Quien lleva la pauta captura cada día el acumulado de gasto y
// mensajes de cada lanzamiento (una edición por vender); el CRM, que sabe cuántas personas se inscribieron y cuántas conversaciones
// llegaron, diagnostica si va a abrir (server/ads-engine.mjs), lleva la cola de acciones atendidas y las decisiones del gerente.
// Acceso: administración y las personas con la función de «trafiquer» (lo concede administración), siempre dentro de las marcas que
// ya tienen asignadas. Las cifras de Meta se capturan a mano: no hay conexión con Meta.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const DAY=86400000;
export const DECISION_TYPES={subir_pauta:'Subir pauta',bajar_pauta:'Bajar pauta',pausar_pauta:'Pausar pauta',posponer_apertura:'Actualizar la fecha en la pauta (apertura pospuesta)',cerrar_apertura:'Pausar pauta (apertura cerrada)'};

export function createAds({db,crm,body,json,audit,now=Date.now}){
  const roleOf=user=>db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
  function access(user){
    const u=roleOf(user);if(!u||u.disabled||u.role==='customer')return {allowed:false,admin:false};
    if(u.role==='admin')return {allowed:true,admin:true};
    return {allowed:Boolean(db.prepare('SELECT 1 FROM ad_access WHERE user_id=?').get(user.id)),admin:false};
  }
  const requireAds=user=>{const a=access(user);if(!a.allowed)throw fail(403,'Pauta es para administración y las personas con la función de trafiquer.');return a;};
  const requireAdmin=user=>{if(!access(user).admin)throw fail(403,'Esta acción requiere un administrador.');};
  const names=id=>id?db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name||null:null;
  const brandIds=(user,brand)=>{const ids=crm.brandsFor(user).map(b=>b.id);if(brand&&brand!=='all'){if(!ids.includes(brand))throw fail(404,'Marca no disponible.');return [brand];}return ids;};
  const marks=ids=>ids.map(()=>'?').join(',')||'NULL';
  const today=()=>dayKey(now());

  // ---- datos para el motor
  function dataset(ids){
    const t=today(),editionsRaw=ids.length?db.prepare(`SELECT e.*,c.title course_title,b.name brand_name FROM editions e JOIN courses c ON c.id=e.course_id JOIN brands b ON b.id=e.brand_id WHERE e.brand_id IN (${marks(ids)}) AND e.starts_at IS NOT NULL AND c.active=1 AND e.status IN ('published','archived')`).all(...ids):[];
    const startKey=e=>dayKey(e.starts_at,e.timezone),all=editionsRaw.map(e=>({...e,startKey:startKey(e)}));
    const edIds=all.map(e=>e.id);
    const caps={},addCap=r=>{(caps[r.edition_id]??={})[r.day]={spend:r.spend_cents,messages:r.messages};};
    if(edIds.length)for(const r of db.prepare(`SELECT edition_id,day,spend_cents,messages FROM ad_captures WHERE edition_id IN (${marks(edIds)})`).all(...edIds))addCap(r);
    const launches=Object.fromEntries(edIds.length?db.prepare(`SELECT edition_id,launched_on FROM ad_launches WHERE edition_id IN (${marks(edIds)})`).all(...edIds).map(r=>[r.edition_id,r.launched_on]):[]);
    const enrollments=edIds.length?db.prepare(`SELECT edition_id,course_id,created_at FROM enrollments WHERE status='enrolled' AND edition_id IN (${marks(edIds)}) ORDER BY created_at`).all(...edIds):[];
    const timesOf={};for(const r of enrollments)(timesOf[r.edition_id]??=[]).push(r.created_at);
    const launchKey=e=>{const first=Object.keys(caps[e.id]||{}).sort()[0],k=launches[e.id]||first||dayKey(e.created_at||now(),e.timezone);return k>t?t:k;};

    const active=all.filter(e=>e.status==='published'&&e.startKey>=t).map(e=>({id:e.id,brandId:e.brand_id,brandName:e.brand_name,courseId:e.course_id,course:e.course_title,name:e.name,startKey:e.startKey,min:e.min_students,enrolled:(timesOf[e.id]||[]).length,launchKey:launchKey(e),captures:caps[e.id]||{}}));
    // historial: ediciones ya cerradas (empezaron antes de hoy) con sus inscripciones; sólo cuentan las que llegaron a 3 o más
    const history=new Map(),runs=new Map();
    for(const e of all.filter(e=>e.startKey<t).sort((a,b)=>a.startKey<b.startKey?-1:1)){
      const times=timesOf[e.id]||[],startMs=keyMs(e.startKey),final=times.filter(x=>x<=startMs+DAY).length;
      if(final>=3)(history.get(e.course_id)||history.set(e.course_id,[]).get(e.course_id)).push({startMs,final,times:times.filter(x=>x<=startMs+DAY)});
      if(times.length||Object.keys(caps[e.id]||{}).length)(runs.get(e.course_id)||runs.set(e.course_id,[]).get(e.course_id)).push({key:e.startKey,total:times.length,launchKey:launchKey(e),times,captures:caps[e.id]||{}});
    }
    const hace14=now()-14*DAY,rate14={};for(const r of enrollments)if(r.created_at>=hace14)rate14[r.course_id]=(rate14[r.course_id]||0)+1/14;
    return {today:t,editions:active,history,runs,rate14,all,caps,timesOf,launchKey};
  }

  // ---- veredictos y cola de acciones
  function overview(user,brand){
    requireAds(user);const ids=brandIds(user,brand),d=dataset(ids),verdicts=buildVerdicts(d);
    const done=Object.fromEntries(ids.length?db.prepare(`SELECT a.edition_id,a.note,a.done_at,u.name FROM ad_actions a JOIN editions e ON e.id=a.edition_id LEFT JOIN users u ON u.id=a.done_by WHERE a.day=? AND e.brand_id IN (${marks(ids)})`).all(d.today,...ids).map(r=>[r.edition_id,{note:r.note,doneAt:r.done_at,by:r.name}]):[]);
    const rows=verdicts.map(v=>({...v,done:done[v.editionId]||null}));
    const counts={};for(const r of rows)if(!r.done)counts[r.type]=(counts[r.type]||0)+1;
    const pending=ids.length?db.prepare(`SELECT count(*) n FROM ad_decisions WHERE status='pending' AND brand_id IN (${marks(ids)})`).get(...ids).n:0;
    return {today:d.today,verdicts:rows,counts,pendingDecisions:pending,kinds:Object.fromEntries(Object.entries(VERDICTS).map(([k,v])=>[k,{title:v.title,sub:v.sub,order:v.order}])),brands:crm.brandsFor(user).filter(b=>ids.includes(b.id)).map(b=>({id:b.id,name:b.name}))};
  }

  // ---- captura diaria
  function captureRows(user,brand,day){
    requireAds(user);const ids=brandIds(user,brand),d=dataset(ids),when=isKey(day)?day:d.today;
    return {day:when,today:d.today,rows:d.editions.map(e=>{
      const caps=e.captures,cur=caps[when]||null,prevDay=Object.keys(caps).filter(k=>k<when).sort().pop()||null;
      const crmLeads=db.prepare("SELECT count(*) n FROM conversations WHERE edition_id=?").get(e.id).n,fromAds=db.prepare("SELECT count(*) n FROM conversations WHERE edition_id=? AND referral IS NOT NULL").get(e.id).n;
      return {editionId:e.id,brandId:e.brandId,brandName:e.brandName,course:e.course,edition:e.name,startKey:e.startKey,launchKey:e.launchKey,min:e.min>0?e.min:8,enrolled:e.enrolled,
        spendCents:cur?cur.spend:null,messages:cur?cur.messages:null,prev:prevDay?{day:prevDay,spendCents:caps[prevDay].spend,messages:caps[prevDay].messages}:null,crmConversations:crmLeads,crmFromAds:fromAds};
    })};
  }
  function saveCaptures(user,input){
    requireAds(user);const t=today(),day=text(input.day,10)||t;
    if(!isKey(day))throw fail(400,'La fecha debe verse como 2026-11-20.');
    if(day>t)throw fail(400,'No se puede capturar un día que todavía no llega.');
    if(daysBetween(day,t)>60)throw fail(400,'Sólo se capturan los últimos 60 días.');
    const rows=Array.isArray(input.rows)?input.rows:[];if(!rows.length)throw fail(400,'No hay filas para guardar.');if(rows.length>200)throw fail(400,'Máximo 200 filas por captura.');
    const prepared=rows.map(r=>{
      const e=typeof r.editionId==='string'?db.prepare('SELECT id,brand_id,starts_at FROM editions WHERE id=?').get(r.editionId):null;if(!e)throw fail(404,'Edición no encontrada.');crm.requireBrand(user,e.brand_id);
      const spend=Number(r.spend),messages=Number(r.messages);
      if(!Number.isFinite(spend)||spend<0||spend>100_000_000)throw fail(400,'La pauta debe ser un importe en pesos de 0 en adelante.');
      if(!Number.isInteger(messages)||messages<0||messages>10_000_000)throw fail(400,'Los mensajes deben ser un número entero de 0 en adelante.');
      const launched=r.launchedOn===undefined||r.launchedOn===''?null:text(r.launchedOn,10);if(launched&&(!isKey(launched)||launched>t))throw fail(400,'La fecha de lanzamiento no es válida.');
      return {id:e.id,spend:Math.round(spend*100),messages,launched};
    });
    transaction(db,()=>{
      for(const r of prepared){
        db.prepare('INSERT INTO ad_captures(edition_id,day,spend_cents,messages,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(edition_id,day) DO UPDATE SET spend_cents=excluded.spend_cents,messages=excluded.messages,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(r.id,day,r.spend,r.messages,user.id,now());
        if(r.launched)db.prepare('INSERT INTO ad_launches(edition_id,launched_on,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET launched_on=excluded.launched_on,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(r.id,r.launched,user.id,now());
      }
      audit(user,'ads.capture',day+':'+prepared.length);
    });
    return prepared.length;
  }

  // ---- acciones atendidas (una por edición y día, compartida por quienes llevan la pauta)
  function markDone(user,input){
    requireAds(user);const e=typeof input.editionId==='string'?db.prepare('SELECT id,brand_id FROM editions WHERE id=?').get(input.editionId):null;if(!e)throw fail(404,'Edición no encontrada.');crm.requireBrand(user,e.brand_id);
    const v=overview(user,e.brand_id).verdicts.find(x=>x.editionId===e.id);if(!v)throw fail(409,'Esa edición ya no está en venta.');
    db.prepare('INSERT INTO ad_actions(edition_id,day,verdict,note,done_by,done_at) VALUES(?,?,?,?,?,?) ON CONFLICT(edition_id,day) DO UPDATE SET verdict=excluded.verdict,note=excluded.note,done_by=excluded.done_by,done_at=excluded.done_at').run(e.id,today(),v.type,text(input.note,140),user.id,now());
    return true;
  }
  function unmarkDone(user,editionId){
    requireAds(user);const e=db.prepare('SELECT brand_id FROM editions WHERE id=?').get(editionId);if(!e)throw fail(404,'Edición no encontrada.');crm.requireBrand(user,e.brand_id);
    return db.prepare('DELETE FROM ad_actions WHERE edition_id=? AND day=?').run(editionId,today()).changes>0;
  }

  // ---- decisiones del gerente
  const staffOfAds=brandId=>db.prepare("SELECT u.id FROM users u WHERE COALESCE(u.disabled,0)=0 AND u.role IN ('admin','agent') AND (u.role='admin' OR (u.id IN (SELECT user_id FROM ad_access) AND u.id IN (SELECT user_id FROM brand_members WHERE brand_id=?)))").all(brandId).map(r=>r.id);
  const decisionView=r=>({id:r.id,brandId:r.brand_id,brand:r.brand_name,editionId:r.edition_id,course:r.course_title,edition:r.edition_name,startKey:r.starts_at?dayKey(r.starts_at,r.timezone):null,type:r.type,typeLabel:DECISION_TYPES[r.type],reason:r.reason,budgetCents:r.budget_cents,newDate:r.new_date,status:r.status,kpis:JSON.parse(r.kpis||'{}'),createdBy:names(r.created_by),createdAt:r.created_at,appliedBy:names(r.applied_by),appliedAt:r.applied_at,appliedNote:r.applied_note});
  const DECISION_SQL='SELECT d.*,b.name brand_name,c.title course_title,e.name edition_name,e.starts_at,e.timezone FROM ad_decisions d JOIN brands b ON b.id=d.brand_id JOIN editions e ON e.id=d.edition_id JOIN courses c ON c.id=e.course_id';
  function decisions(user,brand,status){
    requireAds(user);const ids=brandIds(user,brand);if(!ids.length)return [];
    const st=['pending','applied','cancelled'].includes(status)?status:null;
    return db.prepare(`${DECISION_SQL} WHERE d.brand_id IN (${marks(ids)})${st?' AND d.status=?':''} ORDER BY d.created_at DESC LIMIT 100`).all(...ids,...(st?[st]:[])).map(decisionView);
  }
  function createDecision(user,input){
    requireAdmin(user);
    const e=typeof input.editionId==='string'?db.prepare('SELECT * FROM editions WHERE id=?').get(input.editionId):null;if(!e)throw fail(404,'Edición no encontrada.');crm.requireBrand(user,e.brand_id);
    const type=input.type;if(!DECISION_TYPES[type])throw fail(400,'Elige qué se decidió: subir, bajar o pausar la pauta, o la apertura pospuesta o cerrada.');
    let budget=null;if(input.budget!==undefined&&input.budget!==null&&input.budget!==''){const n=Number(input.budget);if(!Number.isFinite(n)||n<0||n>10_000_000)throw fail(400,'El presupuesto por día debe ser un importe en pesos.');budget=Math.round(n*100);}
    let newDate=null;if(type==='posponer_apertura'){newDate=text(input.newDate,10);if(!isKey(newDate))throw fail(400,'Indica la nueva fecha de apertura (por ejemplo 2026-12-04).');if(newDate<=today())throw fail(400,'La nueva fecha debe ser posterior a hoy.');}
    const ref=input.clientRef===undefined?null:text(input.clientRef,80);if(input.clientRef!==undefined&&ref.length<8)throw fail(400,'Referencia de idempotencia no válida.');
    if(ref){const same=db.prepare(`${DECISION_SQL} WHERE d.client_ref=?`).get(ref);if(same)return decisionView(same);}
    const verdict=overview(user,e.brand_id).verdicts.find(x=>x.editionId===e.id),kpis=verdict?{day:verdict.daysSinceLaunch,spendCents:verdict.spendCents,messages:verdict.messages,cplCents:verdict.cplCents,students:verdict.students,min:verdict.min,type:verdict.type}:{};
    const id=randomUUID(),t=now();
    transaction(db,()=>{
      db.prepare('INSERT INTO ad_decisions(id,brand_id,edition_id,type,reason,budget_cents,new_date,kpis,client_ref,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,e.brand_id,e.id,type,text(input.reason,300),budget,newDate,JSON.stringify(kpis),ref,user.id,t);
      const course=db.prepare('SELECT title FROM courses WHERE id=?').get(e.course_id)?.title||'curso';
      for(const uid of staffOfAds(e.brand_id))if(uid!==user.id)db.prepare('INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),uid,e.brand_id,null,'ads','Nueva decisión del gerente: '+DECISION_TYPES[type]+' · '+course+' · '+e.name,'ads:'+id,t);
      audit(user,'ads.decision.created',id);
    });
    return decisionView(db.prepare(`${DECISION_SQL} WHERE d.id=?`).get(id));
  }
  function decide(user,id,action,input){
    requireAds(user);const d=db.prepare('SELECT * FROM ad_decisions WHERE id=?').get(id);if(!d)throw fail(404,'Decisión no encontrada.');crm.requireBrand(user,d.brand_id);
    if(d.status!=='pending')throw fail(409,'Esa decisión ya estaba '+(d.status==='applied'?'aplicada':'cancelada')+'.');
    if(action==='cancel'){requireAdmin(user);db.prepare("UPDATE ad_decisions SET status='cancelled',applied_by=?,applied_at=?,applied_note=? WHERE id=?").run(user.id,now(),text(input.note,140),id);audit(user,'ads.decision.cancelled',id);}
    else{db.prepare("UPDATE ad_decisions SET status='applied',applied_by=?,applied_at=?,applied_note=? WHERE id=?").run(user.id,now(),text(input.note,140),id);audit(user,'ads.decision.applied',id);}
    return decisionView(db.prepare(`${DECISION_SQL} WHERE d.id=?`).get(id));
  }

  // ---- reporte por lanzamiento: cada edición en venta (y las cerradas de los últimos 90 días) con su costo y su llenado
  function report(user,brand){
    requireAds(user);const ids=brandIds(user,brand),d=dataset(ids);
    const rows=d.all.filter(e=>e.startKey>=dayKey(now()-90*DAY)).map(e=>{
      const caps=d.caps[e.id]||{},last=Object.keys(caps).sort().pop(),c=last?caps[last]:null,enrolled=(d.timesOf[e.id]||[]).length,min=e.min_students>0?e.min_students:8;
      return {editionId:e.id,brandId:e.brand_id,brand:e.brand_name,course:e.course_title,edition:e.name,startKey:e.startKey,closed:e.startKey<d.today,min,enrolled,spendCents:c?.spend??0,messages:c?.messages??0,
        cplCents:c&&c.messages?Math.round(c.spend/c.messages):null,cacCents:c&&enrolled?Math.round(c.spend/enrolled):null,lastCaptureDay:last||null};
    }).sort((a,b)=>a.startKey<b.startKey?1:-1);
    const totals=rows.reduce((t,r)=>({spendCents:t.spendCents+r.spendCents,messages:t.messages+r.messages,enrolled:t.enrolled+r.enrolled}),{spendCents:0,messages:0,enrolled:0});
    return {today:d.today,rows,totals};
  }

  // ---- función de trafiquer (administración)
  const accessList=user=>{requireAdmin(user);return db.prepare("SELECT u.id,u.name,u.username,u.role,COALESCE(u.disabled,0) disabled,a.created_at granted_at FROM users u LEFT JOIN ad_access a ON a.user_id=u.id WHERE u.role IN ('agent','admin') ORDER BY u.name").all().map(r=>({...r,enabled:Boolean(r.granted_at)||r.role==='admin',admin:r.role==='admin'}));};
  function setAccess(input,user){
    requireAdmin(user);const id=typeof input.userId==='string'?input.userId:'';const u=db.prepare("SELECT id,role FROM users WHERE id=? AND role IN ('agent','admin')").get(id);if(!u)throw fail(404,'Persona del equipo no encontrada.');
    if(u.role==='admin')throw fail(400,'Administración ya tiene acceso a Pauta.');
    if(input.enabled)db.prepare('INSERT INTO ad_access(user_id,granted_by,created_at) VALUES(?,?,?) ON CONFLICT(user_id) DO NOTHING').run(id,user.id,now());else db.prepare('DELETE FROM ad_access WHERE user_id=?').run(id);
    audit(user,input.enabled?'ads.access.granted':'ads.access.revoked',id);return accessList(user);
  }

  async function handle(req,res,path,user){
    if(!path.startsWith('/api/ads'))return false;
    const p=new URL(req.url,'http://localhost').searchParams;let m;
    if(path==='/api/ads/me'&&req.method==='GET'){json(res,200,access(user));return true;}
    if(path==='/api/ads/overview'&&req.method==='GET'){json(res,200,overview(user,p.get('brand')));return true;}
    if(path==='/api/ads/capture'){
      if(req.method==='GET'){json(res,200,captureRows(user,p.get('brand'),p.get('day')));return true;}
      if(req.method==='PUT'){const input=await body(req),n=saveCaptures(user,input);json(res,200,{saved:n,...captureRows(user,p.get('brand')||'all',input.day)});return true;}
    }
    if(path==='/api/ads/actions'&&req.method==='POST'){markDone(user,await body(req));json(res,200,{ok:true});return true;}
    if((m=path.match(/^\/api\/ads\/actions\/([a-zA-Z0-9-]+)$/))&&req.method==='DELETE'){json(res,200,{removed:unmarkDone(user,m[1])});return true;}
    if(path==='/api/ads/decisions'){
      if(req.method==='GET'){json(res,200,{decisions:decisions(user,p.get('brand'),p.get('status')),types:DECISION_TYPES});return true;}
      if(req.method==='POST'){json(res,201,{decision:createDecision(user,await body(req))});return true;}
    }
    if((m=path.match(/^\/api\/ads\/decisions\/([a-f0-9-]{36})\/(apply|cancel)$/))&&req.method==='POST'){json(res,200,{decision:decide(user,m[1],m[2],await body(req))});return true;}
    if(path==='/api/ads/report'&&req.method==='GET'){json(res,200,report(user,p.get('brand')));return true;}
    if(path==='/api/ads/access'){
      if(req.method==='GET'){json(res,200,{members:accessList(user)});return true;}
      if(req.method==='PUT'){json(res,200,{members:setAccess(await body(req),user)});return true;}
    }
    throw fail(404,'Ruta de Pauta no encontrada.');
  }
  return {handle,access,overview};
}
