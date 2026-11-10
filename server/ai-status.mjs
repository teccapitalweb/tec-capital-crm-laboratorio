// Estado de la IA para administración (docs/ACTIVAR_IA_PRODUCCION.md). Una sola respuesta que dice, SIN revelar secretos: qué proveedor está activo, si hay clave
// (sí o no, nunca su valor), cuánto se lleva gastado del tope del mes y, por marca, qué falta para encender la IA con seguridad: conocimiento aprobado, la marca
// autorizada para usar la IA, el modo, y una evaluación con IA real. El veredicto por marca es de sólo lectura: encender cosas sigue siendo una acción explícita
// en Seguimientos y en las variables de entorno.
const fail=(status,message)=>Object.assign(new Error(message),{status});
export const THRESHOLDS={minKnowledge:10,minEvalScore:0.85,suggestedCallLimit:200};

export function createAiStatus({db,crm,provider,env=process.env,json,now=Date.now}){
  const hasKey=Boolean(env.ANTHROPIC_API_KEY||env.ANTHROPIC_AUTH_TOKEN);
  const requireAdmin=user=>{const u=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);if(!u||u.disabled||u.role!=='admin')throw fail(403,'El estado de la IA es para administración.');};
  const pct=(n,limit)=>limit>0?Math.min(100,Math.round(n/limit*100)):null;

  function providerInfo(){
    const usage=provider.usage?.()||null,real=provider.name==='claude';
    return {name:provider.name,model:provider.model,summaryModel:real?(env.AI_SUMMARY_MODEL||'claude-haiku-5-5'):null,hasKey,configured:Boolean(provider.configured),real,
      usage:usage&&{...usage,callsPct:pct(usage.calls,usage.callLimit),tokensPct:pct(usage.tokens,usage.tokenLimit)}};
  }
  function globalSteps(p){
    return [
      {id:'key',title:'La clave de API está en el entorno',done:p.hasKey,detail:p.hasKey?'Hay una clave configurada (no se muestra su valor).':'Falta ANTHROPIC_API_KEY en las variables de Railway. La clave nunca se escribe en el chat ni en el repositorio.'},
      {id:'provider',title:'El proveedor es Claude (AI_PROVIDER=claude)',done:p.real,detail:p.real?'Activo con el modelo '+p.model+'.':'Hoy el motor es el simulado: responde sólo por coincidencia con el conocimiento aprobado y no llama a ninguna IA.'},
      {id:'cap',title:'Hay un tope mensual de llamadas',done:p.usage?p.usage.callLimit>0:false,detail:p.usage?(p.usage.callLimit>0?'Tope de '+p.usage.callLimit+' llamadas al mes.':'Sin tope de llamadas: define AI_MONTHLY_CALL_LIMIT (se sugiere '+THRESHOLDS.suggestedCallLimit+' para empezar).'):'Se define con AI_MONTHLY_CALL_LIMIT cuando el proveedor sea Claude (se sugiere '+THRESHOLDS.suggestedCallLimit+' para empezar).'},
    ];
  }
  function brandStatus(b,p,steps){
    const s=db.prepare('SELECT mode,provider_enabled FROM reply_settings WHERE brand_id=?').get(b.id)||{mode:'templates',provider_enabled:0};
    const k=db.prepare("SELECT sum(status='approved') approved,sum(status='draft') draft FROM knowledge_entries WHERE brand_id=?").get(b.id),approved=k.approved||0,draft=k.draft||0;
    const gaps=db.prepare("SELECT count(*) n FROM reply_log WHERE brand_id=? AND intent='unknown' AND created_at>=?").get(b.id,now()-30*86400000).n;
    // `eval_runs.score` está en PORCENTAJE (0–100); aquí se normaliza a fracción. Una evaluación sólo cuenta como «con IA real» si el proveedor era Claude Y al menos un caso llegó a consultarlo.
    const evalOf=r=>{if(!r)return null;let ai=0,err=null;try{const rs=JSON.parse(r.results);ai=rs.filter(x=>x.got?.providerCalled).length;err=rs.map(x=>x.got?.providerError).find(Boolean)||null;}catch{}return {provider:r.provider,total:r.total,passed:r.passed,score:r.score/100,created_at:r.created_at,aiCalls:ai,aiError:err};};
    const lastEval=evalOf(db.prepare('SELECT provider,total,passed,score,results,created_at FROM eval_runs WHERE brand_id=? ORDER BY created_at DESC LIMIT 1').get(b.id));
    const realRow=db.prepare("SELECT provider,total,passed,score,results,created_at FROM eval_runs WHERE brand_id=? AND provider='claude' ORDER BY created_at DESC LIMIT 20").all(b.id).map(evalOf).find(x=>x.aiCalls>0)||null;
    const claudeNoAi=!realRow&&lastEval?.provider==='claude'&&lastEval.aiCalls===0;
    const realEval=realRow;
    const checks=[
      {id:'knowledge',title:'Al menos '+THRESHOLDS.minKnowledge+' respuestas aprobadas',done:approved>=THRESHOLDS.minKnowledge,detail:approved+' aprobada'+(approved===1?'':'s')+(draft?' y '+draft+' en borrador (sólo cuentan las aprobadas)':'')+'.',go:{view:'courses',label:'Ir a Catálogo → Conocimiento'}},
      {id:'enabled',title:'La marca puede usar la IA para redactar',done:Boolean(s.provider_enabled),detail:s.provider_enabled?'Autorizada en Seguimientos → Respuestas automáticas.':'Está apagado para esta marca: se enciende en Seguimientos → Respuestas automáticas.',go:{tab:'recipes',label:'Ir a Seguimientos'}},
      {id:'mode',title:'El modo es «Sugerir» o «Autónomo»',done:['suggest','autonomous'].includes(s.mode),detail:'Modo actual: '+({off:'apagado',suggest:'sugerir',templates:'responder con plantillas',autonomous:'autónomo'}[s.mode]||s.mode)+'. Se empieza en «Sugerir»: la IA propone y el equipo decide.',go:{tab:'recipes',label:'Ir a Seguimientos'}},
      {id:'eval',title:'Evaluación con IA real con al menos '+Math.round(THRESHOLDS.minEvalScore*100)+' %',done:Boolean(realEval&&realEval.score>=THRESHOLDS.minEvalScore),detail:realEval?'Última con IA real: '+realEval.passed+' de '+realEval.total+' ('+Math.round(realEval.score*100)+' %), con '+realEval.aiCalls+' consulta'+(realEval.aiCalls===1?'':'s')+' a la IA.':claudeNoAi?'La última evaluación ('+Math.round(lastEval.score*100)+' %) no llegó a consultar a la IA.'+(lastEval.aiError?' Motivo: '+lastEval.aiError:' Ningún caso la necesitó: agrega casos con preguntas que sólo responda el conocimiento aprobado (por ejemplo «¿Sirve si apenas empiezo?») y vuelve a ejecutar.'):lastEval?'Sólo hay evaluaciones con el motor simulado (último: '+Math.round(lastEval.score*100)+' %). Se corre con la IA real desde Catálogo → Evaluación.':'Todavía no se ha corrido ninguna evaluación. Catálogo → Evaluación.',go:{view:'courses',label:'Ir a Catálogo → Evaluación'}},
    ];
    const keyOk=steps.find(x=>x.id==='key').done&&steps.find(x=>x.id==='provider').done;
    let verdict,next;
    if(!keyOk){verdict='blocked';next='Primero se configura la clave y el proveedor en Railway (pasos de arriba).';}
    else if(approved<THRESHOLDS.minKnowledge){verdict='blocked';next='Carga y aprueba al menos '+THRESHOLDS.minKnowledge+' respuestas de esta marca (Catálogo → Conocimiento → Importar CSV).';}
    else if(!s.provider_enabled){verdict='blocked';next='Autoriza la IA para esta marca en Seguimientos → Respuestas automáticas.';}
    else if(realEval&&realEval.score>=THRESHOLDS.minEvalScore){verdict='ready_respond';next='Pasó la evaluación con IA real: puede pasar de «Sugerir» a «Autónomo» cuando el equipo esté cómodo con los borradores.';}
    else{verdict='ready_suggest';next=['suggest','autonomous'].includes(s.mode)?'En «Sugerir»: revisa los borradores un tiempo y corre la evaluación con IA real antes de pasar a «Autónomo».':'Pon el modo en «Sugerir» y corre la evaluación con IA real.';}
    return {id:b.id,name:b.name,mode:s.mode,providerEnabled:Boolean(s.provider_enabled),knowledge:{approved,draft},gaps30:gaps,lastEval:lastEval&&{provider:lastEval.provider,total:lastEval.total,passed:lastEval.passed,score:lastEval.score,aiCalls:lastEval.aiCalls,at:lastEval.created_at},realEval:realEval&&{score:realEval.score,at:realEval.created_at},checks,verdict,next};
  }
  function status(user){
    const p=providerInfo(),steps=globalSteps(p);
    return {provider:p,steps,thresholds:THRESHOLDS,brands:crm.brandsFor(user).map(b=>brandStatus(b,p,steps))};
  }
  // Prueba de conexión: una llamada mínima real a Claude (cuenta contra el tope). Sólo administración; con pausa entre pruebas para no gastar por accidente.
  let lastPing=0;const cooldown=Number.isFinite(Number(env.AI_PING_COOLDOWN_MS))&&env.AI_PING_COOLDOWN_MS!==undefined&&env.AI_PING_COOLDOWN_MS!==''?Math.max(0,Number(env.AI_PING_COOLDOWN_MS)):5000;
  async function ping(user){
    requireAdmin(user);
    if(now()-lastPing<cooldown)throw fail(429,'Espera unos segundos antes de probar otra vez.');
    lastPing=now();
    let r;try{r=await provider.ping();}finally{lastPing=now();}   // la pausa cuenta desde que termina la prueba anterior
    return {result:{ok:Boolean(r.ok),called:Boolean(r.called),reason:String(r.reason||'').slice(0,300),model:r.model||null,ms:r.ms??null,inputTokens:r.inputTokens??null,outputTokens:r.outputTokens??null},provider:providerInfo()};
  }
  async function handle(req,res,path,user){
    if(path==='/api/ai/ping'){if(user.role==='customer')throw fail(403,'El estado de la IA es para administración.');if(req.method!=='POST')throw fail(405,'Método no permitido.');json(res,200,await ping(user));return true;}
    if(path!=='/api/ai/status')return false;
    if(user.role==='customer')throw fail(403,'El estado de la IA es para administración.');requireAdmin(user);
    if(req.method!=='GET')throw fail(405,'Método no permitido.');
    json(res,200,status(user));return true;
  }
  return {handle,status,ping};
}
