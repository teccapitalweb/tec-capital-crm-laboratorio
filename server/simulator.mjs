import {randomUUID,randomBytes} from 'node:crypto';
import {transaction} from './database.mjs';
import {cancelConversationSteps} from './automation.mjs';
import {seedBrandTemplates} from './catalogue-schema.mjs';
import {seedBrandKnowledge} from './replies-schema.mjs';
import {PERSONAS,OUTCOMES,PACES,FIRST_NAMES,LAST_NAMES,INSTRUCTORS,DEMO_BRANDS} from './simulator-personas.mjs';

// Simulador de clientes (Fase 1 · bloque 2). Crea clientes ficticios claramente identificados («· demo») que escriben por la
// MISMA API pública que un cliente real (crear conversación, enviar mensaje, marcar leído), con guiones por perfil y un
// ritmo ajustable. El servidor responde como siempre (motor de respuestas, recetas, cola humana). Reglas: sólo administración;
// cada demo se puede detener y archivar (cierra chats, cancela trabajos y cierra oportunidades); no hay red dentro de las
// transacciones; los usuarios demo no pueden iniciar sesión (su contraseña es un hash sin contraseña conocida).
const fail=(status,message)=>Object.assign(new Error(message),{status});
const CHANNELS=['whatsapp','instagram','facebook'];
export const LIMITS={maxActors:60,maxActive:120};
const rnd=(a,b)=>a+Math.random()*(b-a);
const pick=list=>list[Math.floor(Math.random()*list.length)];
const slug=name=>name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const csvCell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
const MONTHS=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const dateText=(ms,hhmm)=>{const d=new Date(ms);return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0')+' '+hhmm;};

export function createSimulator({db,catalogue,crm,operations,catalogueImport,body,json,audit,broadcast,issueSession,selfOrigin,enabled=true,now=Date.now,log=console}){
  const tokens=new Map(),inFlight=new Set();
  const requireAdmin=user=>{const u=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);if(!u||u.disabled||u.role!=='admin')throw fail(403,'El simulador lo maneja un administrador.');};
  const getRun=id=>db.prepare('SELECT * FROM simulator_runs WHERE id=?').get(id);
  const actorsOf=runId=>db.prepare('SELECT a.*,u.name FROM simulator_actors a JOIN users u ON u.id=a.user_id WHERE a.run_id=? ORDER BY a.created_at').all(runId);
  const lastSeq=cid=>db.prepare('SELECT COALESCE(MAX(seq),0) s FROM messages WHERE conversation_id=?').get(cid).s;

  // Cursos con una edición publicada y vigente, en el orden del catálogo; cada cliente simulado toma uno por turnos.
  function eligibleCourses(brandIds){
    const out=[];
    for(const c of db.prepare(`SELECT * FROM courses WHERE active=1 AND brand_id IN (${brandIds.map(()=>'?').join(',')}) ORDER BY brand_id,title`).all(...brandIds)){
      const e=db.prepare("SELECT * FROM editions WHERE course_id=? AND status='published' ORDER BY starts_at").all(c.id).find(e=>!catalogue.editionState(e)&&!catalogue.info(c.id,e.id).reason);
      if(e)out.push({...c,editionId:e.id});
    }
    return out;
  }

  function start(input,user){
    const count=Number(input.count);if(!Number.isInteger(count)||count<1||count>LIMITS.maxActors)throw fail(400,'Indica de 1 a '+LIMITS.maxActors+' clientes simulados.');
    const pace=PACES[input.pace]?input.pace:null;if(!pace)throw fail(400,'Elige un ritmo válido.');
    const personas=Array.isArray(input.personas)&&input.personas.length?[...new Set(input.personas)]:Object.keys(PERSONAS);
    if(personas.some(p=>!PERSONAS[p]))throw fail(400,'Perfil de cliente no válido.');
    const all=db.prepare('SELECT id,name FROM brands').all();
    const wanted=input.brandIds==='all'||input.brandIds===undefined||input.brandIds===''?all.map(b=>b.id):(Array.isArray(input.brandIds)?input.brandIds:[input.brandIds]);
    const brandIds=all.filter(b=>wanted.includes(b.id)).map(b=>b.id);if(!brandIds.length)throw fail(404,'Marca no encontrada.');
    const active=db.prepare("SELECT count(*) n FROM simulator_actors a JOIN simulator_runs r ON r.id=a.run_id WHERE r.state='running' AND a.state IN ('active','waiting')").get().n;
    if(active+count>LIMITS.maxActive)throw fail(409,'Hay '+active+' clientes simulados en curso. Detén o archiva una demo antes de iniciar otra de este tamaño.');
    const targets=eligibleCourses(brandIds);
    if(!targets.length)throw fail(409,'Esas marcas no tienen cursos con una edición publicada y vigente. Genera el catálogo de demostración o publica una edición.');
    const t=now(),id=randomUUID(),short=id.slice(0,6),base=PACES[pace].base,title=typeof input.title==='string'&&input.title.trim()?input.title.trim().slice(0,80):'Demo '+new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Mexico_City'}).format(t);
    transaction(db,()=>{
      db.prepare('INSERT INTO simulator_runs(id,title,brand_ids,personas,pace,count,state,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,title,JSON.stringify(brandIds),JSON.stringify(personas),pace,count,'running',user.id,t);
      for(let i=0;i<count;i++){
        const persona=personas[i%personas.length],target=targets[(i*7+Math.floor(i/personas.length))%targets.length],channel=CHANNELS[i%CHANNELS.length];
        const uid=randomUUID(),number=db.prepare('SELECT COALESCE(MAX(test_number),100000)+1 n FROM users').get().n;
        db.prepare('INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)').run(uid,'demo.'+short+'.'+String(i+1).padStart(2,'0'),pick(FIRST_NAMES)+' '+pick(LAST_NAMES)+' · demo','demo:'+randomBytes(64).toString('hex'),'customer',number,t,t);
        db.prepare('INSERT INTO simulator_actors(id,run_id,user_id,persona,brand_id,course_id,edition_id,channel,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,uid,persona,target.brand_id,target.id,target.editionId,channel,t+Math.round(i*base*0.5*rnd(.6,1.4)),t,t);
      }
    });
    audit(user,'simulator.start',id);
    return view(getRun(id));
  }

  // Llamada a la propia API con la sesión del cliente simulado: mismas validaciones, límites y efectos que un cliente real.
  async function call(a,method,path,payload){
    let token=tokens.get(a.user_id);if(!token){token=issueSession(a.user_id);tokens.set(a.user_id,token);}
    const origin=selfOrigin();
    const r=await fetch(origin+path,{method,headers:{Cookie:'tc_session='+token,Origin:process.env.APP_ORIGIN?process.env.APP_ORIGIN.replace(/\/$/,''):origin,'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
    const data=await r.json().catch(()=>({}));
    if(r.status===401)tokens.delete(a.user_id);
    if(!r.ok)throw Object.assign(new Error(data.error||'HTTP '+r.status),{status:r.status});
    return data;
  }
  async function say(a,text){
    const course=db.prepare('SELECT title FROM courses WHERE id=?').get(a.course_id),first=String(a.name||'').split(' ')[0];
    const line=text.replaceAll('{{curso}}',course?.title||'el curso').replaceAll('{{nombre}}',first);
    await call(a,'POST','/api/conversations/'+a.conversation_id+'/messages',{text:line,clientRef:randomUUID()});
    db.prepare('UPDATE simulator_actors SET sent=sent+1,updated_at=? WHERE id=?').run(now(),a.id);
  }
  function finish(a,state,outcome){
    const t=now();db.prepare('UPDATE simulator_actors SET state=?,outcome=?,next_at=?,updated_at=? WHERE id=?').run(state,outcome||null,t,t,a.id);
    if(!db.prepare("SELECT 1 FROM simulator_actors WHERE run_id=? AND state IN ('active','waiting') LIMIT 1").get(a.run_id))db.prepare("UPDATE simulator_runs SET state='finished',stopped_at=? WHERE id=? AND state='running'").run(t,a.run_id);
    broadcast('crm',null,{brandId:a.brand_id});
  }
  function advance(a,base){
    const persona=PERSONAS[a.persona],next=a.step+1,t=now();
    if(next>=persona.steps.length)return finish(a,'done',a.persona==='silencio'&&a.step>1?persona.reactivated:persona.outcome);
    db.prepare("UPDATE simulator_actors SET step=?,phase='send',state='active',waiting_since=NULL,next_at=?,updated_at=? WHERE id=?").run(next,t+Math.round(base*rnd(.7,1.6)),t,a.id);
  }
  async function step(a){
    const persona=PERSONAS[a.persona],s=persona.steps[a.step],run=getRun(a.run_id),base=PACES[run.pace].base,poll=Math.min(2000,base),t=now();
    if(!s)return finish(a,'done',persona.outcome);
    if(!a.conversation_id){
      const r=await call(a,'POST','/api/conversations',{courseId:a.course_id,editionId:a.edition_id,channel:a.channel});
      a.conversation_id=r.conversation.id;db.prepare('UPDATE simulator_actors SET conversation_id=?,updated_at=? WHERE id=?').run(a.conversation_id,t,a.id);
    }
    const c=db.prepare('SELECT status FROM conversations WHERE id=?').get(a.conversation_id);
    if(!c||c.status==='resolved')return finish(a,'done','cerrada_por_equipo');
    if(a.phase==='send'){
      if(s.say)await say(a,pick(s.say));
      if(!s.wait)return advance(a,base);
      db.prepare("UPDATE simulator_actors SET phase='wait',waiting_since=?,last_seq=?,next_at=?,updated_at=? WHERE id=?").run(now(),lastSeq(a.conversation_id),now()+poll,now(),a.id);return;
    }
    const replies=db.prepare("SELECT seq,sender_kind FROM messages WHERE conversation_id=? AND seq>? AND sender_kind IN ('agent','automation') ORDER BY seq").all(a.conversation_id,a.last_seq);
    const bots=replies.filter(m=>m.sender_kind==='automation').length,humans=replies.length-bots,human=humans>0;
    if(s.wait==='human'?human:replies.length>0){
      const upTo=replies.at(-1).seq;
      await call(a,'POST','/api/conversations/'+a.conversation_id+'/read',{upTo});
      db.prepare('UPDATE simulator_actors SET got_bot=got_bot+?,got_human=got_human+?,last_seq=?,updated_at=? WHERE id=?').run(bots,humans,upTo,now(),a.id);
      if(human&&s.onHuman){await say(a,pick(s.onHuman));return finish(a,'done',persona.outcome);}
      return advance(a,base);
    }
    if(t-a.waiting_since>(s.patience??(s.wait==='human'?6:8))*base){
      if(s.onTimeout==='finish')return finish(a,'done',persona.outcome);
      if(s.wait==='human'){db.prepare("UPDATE simulator_actors SET state='waiting',next_at=?,updated_at=? WHERE id=?").run(t+poll*2,t,a.id);return;}
      return advance(a,base);   // nadie respondió: el cliente insiste con su siguiente línea
    }
    db.prepare('UPDATE simulator_actors SET next_at=? WHERE id=?').run(t+poll,a.id);
  }
  async function act(a){
    inFlight.add(a.id);
    try{await step(a);}
    catch(e){
      if(e?.status===409&&/cerr/i.test(String(e.message)))return finish(a,'done','cerrada_por_equipo');
      const n=a.errors+1,message=String(e?.message||e).slice(0,200);log.error('Simulator actor failed:',e?.status||e?.name||'Error',message);
      db.prepare("UPDATE simulator_actors SET errors=?,error=?,state=CASE WHEN ?>=3 THEN 'failed' ELSE state END,next_at=?,updated_at=? WHERE id=?").run(n,message,n,now()+5000,now(),a.id);
    }finally{inFlight.delete(a.id);}
  }
  async function tick(){
    if(!enabled||!db.prepare("SELECT 1 FROM simulator_runs WHERE state='running' LIMIT 1").get())return;
    const due=db.prepare("SELECT a.*,u.name FROM simulator_actors a JOIN simulator_runs r ON r.id=a.run_id JOIN users u ON u.id=a.user_id WHERE r.state='running' AND a.state IN ('active','waiting') AND a.next_at<=? ORDER BY a.next_at LIMIT 10").all(now());
    await Promise.all(due.filter(a=>!inFlight.has(a.id)).map(act));
  }

  function stop(r,user){
    const t=now();transaction(db,()=>{db.prepare("UPDATE simulator_actors SET state='stopped',updated_at=? WHERE run_id=? AND state IN ('active','waiting')").run(t,r.id);db.prepare("UPDATE simulator_runs SET state='stopped',stopped_at=COALESCE(stopped_at,?) WHERE id=? AND state IN ('running','finished')").run(t,r.id);});
    audit(user,'simulator.stop',r.id);return view(getRun(r.id));
  }
  // Archivar: cierra cada chat de la demo como lo haría el equipo (resuelto, trabajos y pasos cancelados, oportunidad perdida
  // con motivo), para que no queden seguimientos ni objetivos abiertos. No borra el historial.
  function archive(r,user){
    const t=now(),touched=[];
    transaction(db,()=>{
      for(const a of actorsOf(r.id)){
        if(!a.conversation_id)continue;const c=db.prepare('SELECT * FROM conversations WHERE id=?').get(a.conversation_id);if(!c)continue;
        db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending'").run(c.id);cancelConversationSteps(db,c.id,'conversation_action',t);
        if(c.status!=='resolved'){db.prepare("UPDATE conversations SET bot_enabled=0,status='resolved',updated_at=? WHERE id=?").run(t,c.id);operations.reset(c,'resolved',user);}
        const link=db.prepare('SELECT opportunity_id FROM conversation_opportunities WHERE conversation_id=?').get(c.id);
        if(link){const o=db.prepare('SELECT * FROM opportunities WHERE id=?').get(link.opportunity_id);if(o&&!['ganada','perdida'].includes(o.stage))crm.setStage(c,'perdida',user,{lostReason:'Demo archivada',expectedRevision:o.revision});}
        touched.push(c);
      }
      db.prepare("UPDATE simulator_actors SET state='stopped',updated_at=? WHERE run_id=? AND state IN ('active','waiting')").run(t,r.id);
      db.prepare("UPDATE simulator_runs SET state='archived',stopped_at=COALESCE(stopped_at,?),archived_at=? WHERE id=?").run(t,t,r.id);
    });
    for(const c of touched)broadcast('conversation',c.id);
    for(const b of new Set(touched.map(c=>c.brand_id)))broadcast('crm',null,{brandId:b});
    audit(user,'simulator.archive',r.id);return view(getRun(r.id));
  }

  function view(r){
    const actors=actorsOf(r.id),ids=actors.map(a=>a.conversation_id).filter(Boolean),ph=ids.map(()=>'?').join(',');
    const count=sql=>ids.length?db.prepare(sql.replaceAll('{ids}',ph)).get(...ids).n:0;
    const byState=Object.fromEntries(['active','waiting','done','stopped','failed'].map(s=>[s,actors.filter(a=>a.state===s).length]));
    const byPersona=Object.fromEntries(JSON.parse(r.personas).map(p=>[p,{total:actors.filter(a=>a.persona===p).length,done:actors.filter(a=>a.persona===p&&a.state==='done').length,waiting:actors.filter(a=>a.persona===p&&a.state==='waiting').length}]));
    const messages={customer:count("SELECT count(*) n FROM messages WHERE conversation_id IN ({ids}) AND sender_kind='customer'"),automation:count("SELECT count(*) n FROM messages WHERE conversation_id IN ({ids}) AND sender_kind='automation'"),agent:count("SELECT count(*) n FROM messages WHERE conversation_id IN ({ids}) AND sender_kind='agent'")};
    const stages=ids.length?Object.fromEntries(db.prepare(`SELECT o.stage,count(*) n FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id IN (${ph}) GROUP BY o.stage`).all(...ids).map(x=>[x.stage,x.n])):{};
    const firstReplyMs=ids.length?db.prepare(`SELECT AVG(b.t-c.t) ms FROM (SELECT conversation_id,MIN(created_at) t FROM messages WHERE conversation_id IN (${ph}) AND sender_kind='customer' GROUP BY conversation_id) c JOIN (SELECT conversation_id,MIN(created_at) t FROM messages WHERE conversation_id IN (${ph}) AND sender_kind='automation' GROUP BY conversation_id) b ON b.conversation_id=c.conversation_id`).get(...ids,...ids).ms:null;
    const optOuts=actors.length?db.prepare(`SELECT count(*) n FROM contact_consent cc JOIN contacts k ON k.id=cc.contact_id WHERE cc.status='opted_out' AND k.source_user_id IN (${actors.map(()=>'?').join(',')})`).get(...actors.map(a=>a.user_id)).n:0;
    const finished=actors.filter(a=>a.state==='done'),withoutHuman=finished.filter(a=>a.got_human===0&&!['inscripcion_en_validacion','queja_atendida','escalado_a_persona'].includes(a.outcome)).length;
    return {id:r.id,title:r.title,state:r.state,pace:r.pace,count:r.count,brandIds:JSON.parse(r.brand_ids),personas:JSON.parse(r.personas),createdAt:r.created_at,stoppedAt:r.stopped_at,archivedAt:r.archived_at,
      actors:actors.map(a=>({id:a.id,name:a.name,persona:a.persona,state:a.state,outcome:a.outcome,step:a.step,sent:a.sent,gotBot:a.got_bot,gotHuman:a.got_human,conversationId:a.conversation_id,channel:a.channel,courseId:a.course_id,brandId:a.brand_id,error:a.error})),
      stats:{byState,byPersona,messages,stages,firstReplyMs:firstReplyMs===null?null:Math.round(firstReplyMs),optOuts,waitingHuman:count("SELECT count(*) n FROM conversations WHERE id IN ({ids}) AND status='waiting'"),resolved:count("SELECT count(*) n FROM conversations WHERE id IN ({ids}) AND status='resolved'"),humanTouched:count("SELECT count(DISTINCT conversation_id) n FROM messages WHERE conversation_id IN ({ids}) AND sender_kind='agent'"),finished:finished.length,withoutHuman}};
  }

  // Catálogo de demostración: crea las marcas que falten y pasa el resto por la importación CSV (mismas validaciones,
  // historial y revisiones que una importación hecha a mano). Repetirlo no duplica nada.
  async function generateCatalogue(input,user){
    const clamp=(v,d,max)=>{const n=Number(v);return Number.isInteger(n)&&n>=1&&n<=max?n:d;};
    const nb=clamp(input.brands,DEMO_BRANDS.length,DEMO_BRANDS.length),nc=clamp(input.courses,8,8),t=now(),created=[];
    transaction(db,()=>{for(const b of DEMO_BRANDS.slice(0,nb)){if(db.prepare('SELECT 1 FROM brands WHERE lower(name)=lower(?)').get(b.name))continue;let id=slug(b.name);if(db.prepare('SELECT 1 FROM brands WHERE id=?').get(id))id=id+'-'+randomUUID().slice(0,6);db.prepare('INSERT INTO brands VALUES(?,?,?,?)').run(id,b.name,b.description,t);seedBrandTemplates(db,id);seedBrandKnowledge(db,id);created.push(id);}});
    const rows=['marca,curso,temario,edicion,inicio,fin,zona_horaria,docente,modalidad,lugar,enlace,cupo,cupo_disponible,precio,moneda,estado,promo_nombre,promo_precio,promo_inicio,promo_fin,promo_estado'];
    const day=86400000,today=Math.floor(t/day)*day;let k=0;
    for(const b of DEMO_BRANDS.slice(0,nb))for(const title of b.courses.slice(0,nc)){
      const starts=today+(12+(k*5)%48)*day,price=b.base+(k%4)*200,promo=k%3===0,i=k++;
      const syllabus=`Panorama actual y conceptos clave\nCasos prácticos de ${title.toLowerCase()}\nProtocolos, errores frecuentes y buenas prácticas\nSesión de preguntas con el docente`;
      rows.push([b.name,title,syllabus,'Generación '+MONTHS[new Date(starts).getUTCMonth()]+' '+new Date(starts).getUTCFullYear(),dateText(starts,'18:00'),dateText(starts,'20:00'),'America/Mexico_City',INSTRUCTORS[i%INSTRUCTORS.length],'online','','',40,25+(i%16),price,'MXN','publicada',promo?'Preventa':'',promo?price-400:'',promo?dateText(today-day,'00:00'):'',promo?dateText(starts-2*day,'23:59'):'',promo?'publicada':''].map(csvCell).join(','));
    }
    const analysis=catalogueImport.analyse(rows.join('\n')+'\n',user),results=await catalogueImport.apply(user,analysis);
    const n=(key,value)=>results.filter(r=>r[key]?.action===value).length;
    audit(user,'simulator.catalogue',nb+'x'+nc);broadcast('catalog');
    return {brands:nb,coursesPerBrand:nc,brandsCreated:created.length,coursesCreated:n('course','creado'),editionsCreated:n('edition','creada'),promotionsCreated:n('promotion','creada'),existing:results.filter(r=>!r.error&&r.edition?.action==='existente').length,failed:results.filter(r=>r.error).length,errors:results.filter(r=>r.error).slice(0,5).map(r=>'Fila '+r.line+': '+r.error)};
  }

  async function handle(req,res,path,user){
    if(!path.startsWith('/api/simulator'))return false;
    requireAdmin(user);
    if(!enabled)throw fail(404,'El simulador está desactivado en este entorno (SIMULATOR_DISABLED).');
    let x;
    if(path==='/api/simulator'&&req.method==='GET'){json(res,200,{enabled,personas:Object.entries(PERSONAS).map(([id,p])=>({id,label:p.label,description:p.description,outcome:p.outcome,steps:p.steps.length})),outcomes:OUTCOMES,paces:Object.entries(PACES).map(([id,p])=>({id,label:p.label,base:p.base})),limits:LIMITS,demo:{brands:DEMO_BRANDS.length,coursesPerBrand:8,brandNames:DEMO_BRANDS.map(b=>b.name)}});return true;}
    if(path==='/api/simulator/runs'){
      if(req.method==='GET'){json(res,200,{runs:db.prepare('SELECT * FROM simulator_runs ORDER BY created_at DESC LIMIT 30').all().map(view)});return true;}
      if(req.method==='POST'){json(res,201,{run:start(await body(req),user)});return true;}
    }
    if(path==='/api/simulator/catalogue'&&req.method==='POST'){json(res,200,await generateCatalogue(await body(req),user));return true;}
    if(!(x=path.match(/^\/api\/simulator\/runs\/([a-f0-9-]{36})(?:\/(stop|archive))?$/)))throw fail(404,'Ruta del simulador no encontrada.');
    const r=getRun(x[1]);if(!r)throw fail(404,'Demo no encontrada.');
    if(!x[2]&&req.method==='GET'){json(res,200,{run:view(r)});return true;}
    if(x[2]==='stop'&&req.method==='POST'){if(!['running','finished'].includes(r.state))throw fail(409,'La demo ya estaba detenida.');json(res,200,{run:stop(r,user)});return true;}
    if(x[2]==='archive'&&req.method==='POST'){if(r.state==='archived')throw fail(409,'La demo ya estaba archivada.');json(res,200,{run:archive(r,user)});return true;}
    throw fail(405,'Método no permitido.');
  }
  return {handle,tick,start,stop,archive,view:id=>view(getRun(id)),generateCatalogue,eligibleCourses};
}
