const fail=(status,message)=>Object.assign(new Error(message),{status});
const DAY=86400000,RANK={nuevo:0,interesado:1,inscripcion:2,ganada:3};
const percentile=(sorted,p)=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]:null;
const rate=(a,b)=>b?Math.round(a/b*1000)/10:null;
const dist=values=>{const s=[...values].sort((a,b)=>a-b);return {count:s.length,medianMs:percentile(s,.5),p90Ms:percentile(s,.9)};};

// Métricas comerciales agregadas. Todo se calcula sobre las marcas autorizadas del usuario; el detalle por asesor sólo lo ve
// administración (un asesor ve únicamente su propia fila). Los tiempos son de reloj, no de horario laboral.
export function createAnalytics({db,crm,json,now=Date.now}){
  const ph=ids=>ids.map(()=>'?').join(',')||'NULL';

  function period(params){
    const to=now();let days=Number(params.get('days')||30);if(!Number.isInteger(days)||days<1||days>366)throw fail(400,'Elige un periodo de 1 a 366 días.');
    const tz=params.get('tz')||'America/Mexico_City';try{new Intl.DateTimeFormat('es-MX',{timeZone:tz});}catch{throw fail(400,'Zona horaria no válida.');}
    return {from:to-days*DAY,to,days,tz};
  }
  function scope(user,brand){
    const allowed=crm.brandsFor(user).map(b=>b.id);
    if(brand){if(!allowed.includes(brand))throw fail(404,'Marca no disponible.');return [brand];}
    return allowed;
  }

  function funnel(opps,events){
    const reached=new Map();
    for(const o of opps)reached.set(o.id,RANK[o.stage]??0);
    for(const e of events){const r=RANK[e.to];if(r!==undefined&&reached.has(e.opportunity_id))reached.set(e.opportunity_id,Math.max(reached.get(e.opportunity_id),r));}
    const count=min=>[...reached.values()].filter(r=>r>=min).length,created=opps.length,won=count(3);
    return {created,interesado:count(1),inscripcion:count(2),ganada:won,perdida:opps.filter(o=>o.stage==='perdida').length,abiertas:opps.filter(o=>!['ganada','perdida'].includes(o.stage)).length,conversion:rate(won,created)};
  }

  function build(user,params){
    const p=period(params),brand=params.get('brand')||null,ids=scope(user,brand),isAdmin=user.role==='admin',q=ph(ids);
    const brandName=Object.fromEntries(db.prepare('SELECT id,name FROM brands').all().map(b=>[b.id,b.name]));
    const opps=db.prepare(`SELECT o.id,o.brand_id,o.course_id,o.stage,o.owner_id,o.lost_reason,k.title course_title FROM opportunities o JOIN courses k ON k.id=o.course_id WHERE o.brand_id IN (${q}) AND o.created_at>=? AND o.created_at<?`).all(...ids,p.from,p.to);
    const events=db.prepare(`SELECT e.opportunity_id,json_extract(e.details,'$.to') "to" FROM crm_events e JOIN opportunities o ON o.id=e.opportunity_id WHERE e.kind='stage' AND o.brand_id IN (${q}) AND o.created_at>=? AND o.created_at<?`).all(...ids,p.from,p.to);
    const group=(key)=>{const map=new Map();for(const o of opps){const k=key(o);(map.get(k)||map.set(k,[]).get(k)).push(o);}return map;};
    const eventsOf=list=>{const set=new Set(list.map(o=>o.id));return events.filter(e=>set.has(e.opportunity_id));};
    const byBrand=[...group(o=>o.brand_id)].map(([id,list])=>({id,name:brandName[id],...funnel(list,eventsOf(list))})).sort((a,b)=>b.created-a.created);
    const byCourse=[...group(o=>o.course_id)].map(([id,list])=>({id,title:list[0].course_title,brand:brandName[list[0].brand_id],...funnel(list,eventsOf(list))})).sort((a,b)=>b.created-a.created).slice(0,15);
    const lost=new Map();for(const o of opps)if(o.stage==='perdida')lost.set(o.lost_reason||'Sin motivo',(lost.get(o.lost_reason||'Sin motivo')||0)+1);

    const outcome=to=>db.prepare(`SELECT count(DISTINCT e.opportunity_id) n FROM crm_events e JOIN opportunities o ON o.id=e.opportunity_id WHERE e.kind='stage' AND json_extract(e.details,'$.to')=? AND e.created_at>=? AND e.created_at<? AND o.brand_id IN (${q})`).get(to,p.from,p.to,...ids).n;
    const conversations=db.prepare(`SELECT c.id,c.channel,c.created_at,(SELECT o.stage FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id=c.id) stage FROM conversations c WHERE c.brand_id IN (${q}) AND c.created_at>=? AND c.created_at<?`).all(...ids,p.from,p.to);
    const channels=['whatsapp','instagram','facebook'].map(channel=>{const list=conversations.filter(c=>c.channel===channel);return {channel,conversations:list.length,won:list.filter(c=>c.stage==='ganada').length};});

    const day=new Intl.DateTimeFormat('en-CA',{timeZone:p.tz,year:'numeric',month:'2-digit',day:'2-digit'}),key=t=>day.format(t),trendMap=new Map();
    for(let t=p.from;t<=p.to;t+=DAY)trendMap.set(key(t),{date:key(t),conversations:0,opportunities:0,won:0});
    const bump=(t,field)=>{const row=trendMap.get(key(t));if(row)row[field]++;};
    for(const c of conversations)bump(c.created_at,'conversations');
    for(const o of db.prepare(`SELECT created_at FROM opportunities WHERE brand_id IN (${q}) AND created_at>=? AND created_at<?`).all(...ids,p.from,p.to))bump(o.created_at,'opportunities');
    for(const e of db.prepare(`SELECT e.created_at FROM crm_events e JOIN opportunities o ON o.id=e.opportunity_id WHERE e.kind='stage' AND json_extract(e.details,'$.to')='ganada' AND e.created_at>=? AND e.created_at<? AND o.brand_id IN (${q})`).all(p.from,p.to,...ids))bump(e.created_at,'won');

    const responses=db.prepare(`SELECT e.actor_id,e.details FROM operation_events e WHERE e.kind='response' AND e.brand_id IN (${q}) AND e.created_at>=? AND e.created_at<?`).all(...ids,p.from,p.to).map(r=>({actor:r.actor_id,...JSON.parse(r.details)})).filter(r=>Number.isFinite(r.respondedAt)&&Number.isFinite(r.waitingSince));
    const waits=list=>list.map(r=>Math.max(0,r.respondedAt-r.waitingSince)),target=list=>{const t=list.filter(r=>r.withinTarget!==null&&r.withinTarget!==undefined);return {measured:t.length,within:t.filter(r=>r.withinTarget).length,rate:rate(t.filter(r=>r.withinTarget).length,t.length)};};
    const response={first:{...dist(waits(responses.filter(r=>r.kind==='first')))},next:{...dist(waits(responses.filter(r=>r.kind==='next')))},target:target(responses)};

    const taskRows=db.prepare(`SELECT t.owner_id,t.status,t.due_at,t.updated_at FROM tasks t WHERE t.brand_id IN (${q})`).all(...ids),t0=now();
    const tasks={open:taskRows.filter(t=>t.status==='open').length,overdue:taskRows.filter(t=>t.status==='open'&&t.due_at<t0).length,doneInPeriod:taskRows.filter(t=>t.status==='done'&&t.updated_at>=p.from&&t.updated_at<p.to).length};
    const openOpps=db.prepare(`SELECT owner_id,count(*) n FROM opportunities WHERE brand_id IN (${q}) AND stage NOT IN ('ganada','perdida') GROUP BY owner_id`).all(...ids);

    const people=db.prepare("SELECT id,name,role,disabled FROM users WHERE role IN ('agent','admin')").all().filter(u=>isAdmin||u.id===user.id);
    const agents=people.map(u=>{
      const mine=responses.filter(r=>r.actor===u.id),owned=opps.filter(o=>o.owner_id===u.id),tk=taskRows.filter(t=>t.owner_id===u.id);
      return {id:u.id,name:u.name,role:u.role,disabled:Boolean(u.disabled),openOpportunities:openOpps.find(o=>o.owner_id===u.id)?.n||0,created:owned.length,won:owned.filter(o=>RANK[o.stage]===3).length,lost:owned.filter(o=>o.stage==='perdida').length,
        tasksOpen:tk.filter(t=>t.status==='open').length,tasksOverdue:tk.filter(t=>t.status==='open'&&t.due_at<t0).length,tasksDone:tk.filter(t=>t.status==='done'&&t.updated_at>=p.from&&t.updated_at<p.to).length,
        responses:mine.length,medianResponseMs:dist(waits(mine)).medianMs,withinTargetRate:target(mine).rate};
    }).filter(a=>!isAdmin||a.created||a.openOpportunities||a.tasksOpen||a.tasksDone||a.responses).sort((a,b)=>b.created+b.responses-(a.created+a.responses));

    const runs=db.prepare(`SELECT s.state,count(*) n FROM automation_runs r JOIN automation_steps s ON s.id=r.step_id WHERE r.brand_id IN (${q}) AND r.created_at>=? AND r.created_at<? GROUP BY s.state`).all(...ids,p.from,p.to);

    return {period:{from:p.from,to:p.to,days:p.days,tz:p.tz},scope:{brand,brands:ids.map(id=>({id,name:brandName[id]}))},
      totals:{conversations:conversations.length,opportunities:opps.length,won:outcome('ganada'),lost:outcome('perdida')},
      funnel:funnel(opps,events),byBrand,byCourse,lossReasons:[...lost].map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count),channels,trend:[...trendMap.values()],
      response,tasks,agents,agentsScope:isAdmin?'todos':'propio',automation:Object.fromEntries(runs.map(r=>[r.state,r.n])),notes:['Ventas y pérdidas son de práctica: no confirman dinero ni matrícula.','Los tiempos de respuesta son de reloj (no descuentan horario laboral).']};
  }

  async function handle(req,res,path,user){
    if(path!=='/api/analytics')return false;
    if(req.method!=='GET')throw fail(405,'Método no permitido.');
    const current=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if(!current||current.disabled||!['admin','agent'].includes(current.role))throw fail(403,'La analítica es para el equipo de atención.');
    json(res,200,build({...user,role:current.role},new URL(req.url,'http://localhost').searchParams));return true;
  }
  return {handle,build};
}
