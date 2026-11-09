import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';
import {INTENTS} from './replies.mjs';

// Banco de evaluación (Fase 1 · bloque 7). Cada caso describe lo que un cliente escribe y lo que el motor de respuestas
// debería hacer (intención, acción, fuente, texto que debe o no incluir). Ejecutarlo corre la simulación del motor
// (`replies.test`, sin efectos en conversaciones) caso por caso con el nivel vigente de la marca y guarda la ejecución
// para comparar antes y después de cambiar conocimiento, nivel o proveedor de IA. Alcance por marca autorizada.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
export const ACTIONS=['replied','suggested','escalated','skipped'],SOURCES=['catalogue','knowledge','template','none'];
const MAX_CASES=200;
const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
export const actionOf=r=>r.mode==='off'?'skipped':r.mode==='suggest'?'suggested':r.handoff?'escalated':'replied';

// Compara un resultado de simulación con lo esperado; devuelve la lista de diferencias (vacía = pasa).
export function grade(c,r){
  const failures=[],action=actionOf(r),types=new Set((r.sources||[]).map(s=>s.type));
  // En modo «Sugerir» el motor responde igual, pero deja el borrador al asesor en lugar de enviarlo: para el banco, un borrador vale como respuesta (y un caso que espera «suggested» pasa en ese modo).
  const would=r.mode==='suggest'?(r.handoff?'escalated':'replied'):action;
  // Si el curso de la simulación no tiene una edición disponible, el motor escala sin ficha ni precio y casi todos los casos fallan por eso: se dice la causa de frente.
  if(/La edición no está disponible/.test(r.reason||''))failures.push('catálogo: el curso de la simulación no tiene una edición disponible ('+String(r.reply||'').split('.')[0].slice(0,100)+'). Publica una edición con cupo y fecha en Catálogo.');
  if(c.expect_intent&&r.intent!==c.expect_intent)failures.push('intención: esperaba «'+c.expect_intent+'», obtuvo «'+r.intent+'»');
  if(c.expect_action&&action!==c.expect_action&&would!==c.expect_action)failures.push('acción: esperaba «'+c.expect_action+'», obtuvo «'+action+'»');
  if(c.expect_source==='none'?types.size>0:c.expect_source&&!types.has(c.expect_source))failures.push('fuente: esperaba «'+c.expect_source+'», obtuvo «'+([...types].join(', ')||'ninguna')+'»');
  if(c.must_include&&!norm(r.reply).includes(norm(c.must_include)))failures.push('texto: debía incluir «'+c.must_include+'»');
  if(c.must_exclude&&norm(r.reply).includes(norm(c.must_exclude)))failures.push('texto: no debía incluir «'+c.must_exclude+'»');
  return failures;
}

export function createEvaluation({db,crm,replies,provider,body,json,audit,now=Date.now}){
  const get=id=>db.prepare('SELECT * FROM eval_cases WHERE id=?').get(id);
  const requireStaff=user=>{if(user.role==='customer')throw fail(403,'El banco de evaluación es para el equipo de atención.');};
  const requireAdmin=user=>{const u=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);if(!u||u.disabled||u.role!=='admin')throw fail(403,'Esta acción requiere un administrador.');};
  function normalize(input,brandId){
    const inputText=text(input.inputText,500);if(inputText.length<3)throw fail(400,'Escribe el mensaje del cliente (mínimo 3 caracteres).');
    const expectIntent=input.expectIntent?String(input.expectIntent):null;if(expectIntent&&!INTENTS.includes(expectIntent))throw fail(400,'Intención no válida.');
    const expectAction=input.expectAction?String(input.expectAction):null;if(expectAction&&!ACTIONS.includes(expectAction))throw fail(400,'Acción esperada no válida.');
    const expectSource=input.expectSource?String(input.expectSource):null;if(expectSource&&!SOURCES.includes(expectSource))throw fail(400,'Fuente esperada no válida.');
    if(!expectIntent&&!expectAction&&!expectSource&&!text(input.mustInclude,200)&&!text(input.mustExclude,200))throw fail(400,'Indica al menos un resultado esperado (intención, acción, fuente o texto).');
    const courseId=text(input.courseId,60)||null;if(courseId&&!db.prepare('SELECT 1 FROM courses WHERE id=? AND brand_id=?').get(courseId,brandId))throw fail(404,'El curso no pertenece a la marca.');
    return {title:text(input.title,120)||inputText.slice(0,60),inputText,courseId,expectIntent,expectAction,expectSource,mustInclude:text(input.mustInclude,200)||null,mustExclude:text(input.mustExclude,200)||null,tags:text(input.tags,200)};
  }
  function create(input,user){
    requireStaff(user);const brandId=text(input.brandId,60);if(!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no encontrada.');crm.requireBrand(user,brandId);
    if(db.prepare("SELECT count(*) n FROM eval_cases WHERE brand_id=? AND status='active'").get(brandId).n>=MAX_CASES)throw fail(409,'Máximo '+MAX_CASES+' casos activos por marca.');
    const n=normalize(input,brandId),t=now(),id=randomUUID();
    db.prepare('INSERT INTO eval_cases(id,brand_id,course_id,title,input_text,expect_intent,expect_action,expect_source,must_include,must_exclude,tags,status,created_by,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,\'active\',?,1,?,?)').run(id,brandId,n.courseId,n.title,n.inputText,n.expectIntent,n.expectAction,n.expectSource,n.mustInclude,n.mustExclude,n.tags,user.id,t,t);
    audit(user,'evaluation.case.create',id);return view(get(id));
  }
  function update(c,input,user){
    requireStaff(user);crm.requireBrand(user,c.brand_id);
    if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==c.revision)throw fail(409,'El caso cambió. Recárgalo.');
    const n=normalize({...rowToInput(c),...input},c.brand_id);
    db.prepare('UPDATE eval_cases SET course_id=?,title=?,input_text=?,expect_intent=?,expect_action=?,expect_source=?,must_include=?,must_exclude=?,tags=?,revision=revision+1,updated_at=? WHERE id=?').run(n.courseId,n.title,n.inputText,n.expectIntent,n.expectAction,n.expectSource,n.mustInclude,n.mustExclude,n.tags,now(),c.id);
    audit(user,'evaluation.case.update',c.id);return view(get(c.id));
  }
  const rowToInput=c=>({title:c.title,inputText:c.input_text,courseId:c.course_id,expectIntent:c.expect_intent,expectAction:c.expect_action,expectSource:c.expect_source,mustInclude:c.must_include,mustExclude:c.must_exclude,tags:c.tags});
  function setStatus(c,status,user){requireAdmin(user);db.prepare('UPDATE eval_cases SET status=?,revision=revision+1,updated_at=? WHERE id=?').run(status,now(),c.id);audit(user,'evaluation.case.'+status,c.id);return view(get(c.id));}
  const latestRun=brandId=>{const r=db.prepare('SELECT * FROM eval_runs WHERE brand_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(brandId);return r?{...r,results:JSON.parse(r.results)}:null;};
  function view(c,last=null){const res=last?.results?.find(x=>x.caseId===c.id)||null;return {...c,last:res?{pass:res.pass,failures:res.failures,at:last.created_at,intent:res.got.intent,action:res.got.action}:null};}
  function list(user,brand){
    requireStaff(user);const ids=crm.brandsFor(user).map(b=>b.id).filter(id=>!brand||brand==='all'||id===brand);if(!ids.length)return [];
    const runs=new Map(ids.map(id=>[id,latestRun(id)]));
    return db.prepare(`SELECT * FROM eval_cases WHERE brand_id IN (${ids.map(()=>'?').join(',')}) ORDER BY status,created_at`).all(...ids).map(c=>view(c,runs.get(c.brand_id)));
  }
  // Ejecuta los casos activos de la marca con el nivel vigente. Secuencial: el proveedor de IA (si aplica) es una llamada de red.
  async function run(brandId,user){
    requireStaff(user);if(!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no encontrada.');crm.requireBrand(user,brandId);
    const cases=db.prepare("SELECT * FROM eval_cases WHERE brand_id=? AND status='active' ORDER BY created_at").all(brandId);
    if(!cases.length)throw fail(409,'La marca no tiene casos activos.');
    const started=now(),results=[];let mode='templates',providerName=provider?.name||'simulated';
    for(const c of cases){
      let got,failures;
      try{const r=await replies.test(user,{brandId,courseId:c.course_id||undefined,text:c.input_text});mode=r.mode;if(r.provider?.name)providerName=r.provider.name;got={intent:r.intent,confidence:r.confidence,action:actionOf(r),sources:(r.sources||[]).map(s=>s.type),reply:String(r.reply||'').slice(0,600),reason:r.reason,providerUsed:Boolean(r.provider?.used)};failures=grade(c,r);}
      catch(e){got={intent:null,action:null,sources:[],reply:'',reason:'Error: '+String(e?.message||e).slice(0,160)};failures=['error al simular: '+String(e?.message||e).slice(0,120)];}
      results.push({caseId:c.id,title:c.title,input:c.input_text,expected:{intent:c.expect_intent,action:c.expect_action,source:c.expect_source,include:c.must_include,exclude:c.must_exclude},got,pass:failures.length===0,failures});
    }
    const passed=results.filter(r=>r.pass).length,id=randomUUID(),t=now();
    db.prepare('INSERT INTO eval_runs(id,brand_id,mode,provider,total,passed,score,results,duration_ms,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,brandId,mode,providerName,results.length,passed,Math.round(passed/results.length*1000)/10,JSON.stringify(results),t-started,user.id,t);
    audit(user,'evaluation.run',id);
    return runView(db.prepare('SELECT * FROM eval_runs WHERE id=?').get(id));
  }
  const runView=r=>({...r,results:JSON.parse(r.results)});
  const runs=(brandId,user)=>{requireStaff(user);crm.requireBrand(user,brandId);return db.prepare('SELECT r.id,r.brand_id,r.mode,r.provider,r.total,r.passed,r.score,r.duration_ms,r.created_at,u.name actor_name FROM eval_runs r LEFT JOIN users u ON u.id=r.created_by WHERE r.brand_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 20').all(brandId);};

  async function handle(req,res,path,user){
    if(!path.startsWith('/api/evaluation'))return false;
    const url=new URL(req.url,'http://localhost');let x;
    if(path==='/api/evaluation/cases'){
      if(req.method==='GET'){json(res,200,{cases:list(user,url.searchParams.get('brand')),intents:INTENTS,actions:ACTIONS,sources:SOURCES});return true;}
      if(req.method==='POST'){json(res,201,{case:create(await body(req),user)});return true;}
    }
    if((x=path.match(/^\/api\/evaluation\/cases\/([a-f0-9-]{36})(?:\/(archive|restore))?$/))){
      const c=get(x[1]);if(!c)throw fail(404,'Caso no encontrado.');requireStaff(user);crm.requireBrand(user,c.brand_id);
      if(!x[2]&&req.method==='PATCH'){json(res,200,{case:update(c,await body(req),user)});return true;}
      if(x[2]&&req.method==='POST'){json(res,200,{case:setStatus(c,x[2]==='archive'?'archived':'active',user)});return true;}
      throw fail(405,'Método no permitido.');
    }
    if((x=path.match(/^\/api\/evaluation\/brands\/([a-zA-Z0-9-]+)\/(run|runs)$/))){
      if(x[2]==='run'&&req.method==='POST'){json(res,200,{run:await run(x[1],user)});return true;}
      if(x[2]==='runs'&&req.method==='GET'){json(res,200,{runs:runs(x[1],user)});return true;}
      throw fail(405,'Método no permitido.');
    }
    if((x=path.match(/^\/api\/evaluation\/runs\/([a-f0-9-]{36})$/))&&req.method==='GET'){
      const r=db.prepare('SELECT * FROM eval_runs WHERE id=?').get(x[1]);if(!r)throw fail(404,'Ejecución no encontrada.');requireStaff(user);crm.requireBrand(user,r.brand_id);json(res,200,{run:runView(r)});return true;
    }
    throw fail(404,'Ruta de evaluación no encontrada.');
  }
  return {handle,create,update,run,list,grade};
}
