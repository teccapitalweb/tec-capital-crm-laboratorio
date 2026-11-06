// Motor de veredictos de Pauta (docs/PLAN_PAUTA.md). Es el mismo criterio del panel de tráfico de IPCIL, llevado a datos del CRM:
// para cada edición que se está vendiendo responde lo único que importa, «¿va a abrir? y, si no, ¿le subo o ya no va?».
//  · Proyección de alumnos: cuántos solía llevar ese curso a estos días de abrir (historial de las ediciones ya cerradas).
//  · Relanzamiento: si la corrida anterior de ese curso cerró sin llegar al mínimo, se avisa que sin cambios repetirá el resultado.
//  · Diagnóstico: cruza la pauta y los mensajes capturados con la corrida anterior a los mismos días (o con las demás campañas de la
//    marca si no hay historial) → falta pauta / Ads no trae mensajes / ventas no cierra.
//  · Cuánto más invertir: (alumnos que faltan) × (costo por alumno de la corrida anterior o de la marca).
// Es una función pura (sin base de datos): recibe datos ya preparados y devuelve los veredictos, para poder probarla con casos.
const DAY=86400000;
export const COMPANY_TZ='America/Mexico_City';
const fmtDay=new Map();
export function dayKey(ms,tz=COMPANY_TZ){let f=fmtDay.get(tz);if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});fmtDay.set(tz,f);}return f.format(ms);}
export const keyMs=k=>Date.parse(k+'T00:00:00Z');
export const daysBetween=(a,b)=>Math.round((keyMs(b)-keyMs(a))/DAY);
export const isKey=k=>typeof k==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(k)&&Number.isFinite(keyMs(k));
const money=cents=>new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN',maximumFractionDigits:0}).format((cents||0)/100);
const pctDe=(a,b)=>b>0?Math.round(a/b*100):0;
const shortDay=k=>new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'short',timeZone:'UTC'}).format(keyMs(k));

export const VERDICTS={
  escalar:{order:0,title:'Van muy bien · súbeles y gana más',sub:'Aquí es donde se gana: ya rebasan el mínimo con días por delante; cada peso extra rinde'},
  nova:{order:1,title:'No van a llegar',sub:'Baja o detén la pauta y avisa a coordinación para posponer; meterle más no lo salva'},
  subir:{order:2,title:'Pueden llegar si les subes',sub:'Hay tiempo: mete presupuesto ahora, no la semana que entra'},
  hoy:{order:3,title:'Abren hoy sin llenar',sub:'Última decisión con coordinación: abre corta o se pospone (si se pospone, captura el acumulado final)'},
  ok:{order:4,title:'Van a abrir',sub:'Mantén la pauta como va'},
  espera:{order:5,title:'Recién lanzadas',sub:'Todavía no hay señal; se juzgan a partir del día 3'},
};

// Qué fracción del total solía haber a «dias» días de abrir (promedio de las últimas 6 corridas cerradas).
function fraccionA(runs,dias){
  if(!runs.length)return null;let sum=0,n=0;
  for(const r of runs.slice(-6)){const cut=r.startMs-dias*DAY;sum+=r.times.filter(t=>t<=cut).length/r.final;n++;}
  return n?sum/n:null;
}
// Alumnos esperados al abrir: con el historial del curso (o el de toda la marca si el del curso es corto); sin historial, el ritmo de 14 días.
export function estimate({history,courseId,current,daysLeft,rate14}){
  const own=history.get(courseId)||[];
  let p=fraccionA(own,daysLeft);
  if(p===null||p<0.08){const all=[...history.values()].flat();const pool=fraccionA(all,daysLeft);p=pool!==null&&pool>=0.08?pool:null;}
  let proy;
  if(p!==null){
    proy=Math.round(current/p);
    const finals=(own.length?own:[...history.values()].flat()).map(r=>r.final);
    if(finals.length)proy=Math.min(proy,Math.round(Math.max(...finals)*1.3));
  }else proy=Math.round(current+(rate14[courseId]||0)*daysLeft);
  return Math.max(proy,current);
}

// ctx = {today:'YYYY-MM-DD', editions:[…], history:Map(courseId→[{startMs,final,times}]), runs:Map(courseId→[corridas cerradas]), rate14:{courseId:n}}
//  edición: {id,brandId,brandName,courseId,course,name,startKey,min,enrolled,launchKey,captures:{day:{spend,messages}}}
//  corrida: {key,total,launchKey,times:[ms],captures:{day:{spend,messages}}}
export function buildVerdicts(ctx){
  const {today,editions}=ctx;
  const lastCapture=(caps,upTo=null)=>{const k=Object.keys(caps||{}).filter(x=>isKey(x)&&(!upTo||x<=upTo)).sort().pop();return k?{day:k,spend:caps[k].spend,messages:caps[k].messages}:null;};
  const sum=(arr,f)=>arr.reduce((n,a)=>n+f(a),0);
  const out=[];
  // referencia de cada marca ahora mismo: las campañas con captura
  const benchOf=new Map();
  for(const brandId of new Set(editions.map(e=>e.brandId))){
    const withCap=editions.filter(e=>e.brandId===brandId).map(e=>({...e,foto:lastCapture(e.captures)})).filter(e=>e.foto&&e.foto.messages>0);
    benchOf.set(brandId,withCap.length?{n:withCap.length,conv:sum(withCap,a=>a.enrolled)/sum(withCap,a=>a.foto.messages),cpl:sum(withCap,a=>a.foto.spend)/sum(withCap,a=>a.foto.messages),cac:sum(withCap,a=>a.enrolled)?sum(withCap,a=>a.foto.spend)/sum(withCap,a=>a.enrolled):null,spendAvg:sum(withCap,a=>a.foto.spend)/withCap.length}:null);
  }
  for(const ed of editions){
    const bench=benchOf.get(ed.brandId),min=ed.min>0?ed.min:8;
    const daysLeft=Math.max(0,daysBetween(today,ed.startKey)),D=Math.max(0,daysBetween(ed.launchKey,today)),window=Math.max(1,daysBetween(ed.launchKey,ed.startKey));
    const students=ed.enrolled,foto=lastCapture(ed.captures),fotoDia=ed.captures?.[today]?{day:today,spend:ed.captures[today].spend,messages:ed.captures[today].messages}:null;
    const history=ctx.history instanceof Map?ctx.history:new Map();
    let proy=students;try{proy=Math.max(students,estimate({history,courseId:ed.courseId,current:students,daysLeft,rate14:ctx.rate14||{}}));}catch{}
    const spend=foto?foto.spend:0,leads=foto?foto.messages:0,conv=leads?students/leads:null,cpl=leads?spend/leads:null;

    // corridas anteriores de este curso (sólo cerradas: una futura del mismo curso no cuenta)
    const prevs=(ctx.runs?.get(ed.courseId)||[]).filter(r=>r.key<ed.startKey&&r.key<=today).sort((a,b)=>a.key<b.key?-1:1);
    const prev=prevs[prevs.length-1]||null;
    let failed=0;for(let i=prevs.length-1;i>=0&&prevs[i].total<min;i--)failed++;
    const relaunch=prev&&prev.total<min?{key:prev.key,total:prev.total,failed}:null;
    let cmpPrev=null,cacPrev=null;
    if(prev){
      const atDay=lastCapture(prev.captures,(()=>{const t=new Date(keyMs(prev.launchKey)+Math.floor(D)*DAY).toISOString().slice(0,10);return t;})());
      const total=lastCapture(prev.captures),prevLaunchMs=keyMs(prev.launchKey);
      const studentsAtD=prev.times.filter(t=>t-prevLaunchMs<=D*DAY).length;
      if(atDay)cmpPrev={spend:atDay.spend,leads:atDay.messages,students:studentsAtD,total:prev.total,conv:total&&total.messages?prev.total/total.messages:null};
      if(total&&prev.total>0)cacPrev=total.spend/prev.total;
    }
    const cac=cacPrev??bench?.cac??(students&&spend?spend/students:null);

    // diagnóstico (sólo si hay captura)
    const notes=[];
    if(foto){
      if(cmpPrev){
        const rP=cmpPrev.spend?spend/cmpPrev.spend:null,rL=cmpPrev.leads?leads/cmpPrev.leads:null,rA=cmpPrev.students?students/cmpPrev.students:null;
        notes.push({kind:'info',text:`A estos mismos días la vez pasada: ${money(cmpPrev.spend)} de pauta, ${cmpPrev.leads} mensajes e iba al ${pctDe(cmpPrev.students,min)}% del mínimo (cerró al ${pctDe(cmpPrev.total,min)}%). Hoy: ${money(spend)}, ${leads} mensajes, ${pctDe(students,min)}%.`});
        if(rP!==null&&rP<0.6)notes.push({kind:'pauta',text:`Vas bajo en pauta: llevas el ${Math.round(rP*100)}% de lo que llevabas la corrida pasada.`});
        if(rP!==null&&rP>=0.6&&rL!==null&&rL<0.6)notes.push({kind:'ads',text:`Ads no está trayendo mensajes: misma inversión, ${leads} mensajes contra ${cmpPrev.leads}. Cambia anuncio o segmentación, no es presupuesto.`});
        if(rL!==null&&rL>=0.8&&rA!==null&&rA<0.6)notes.push({kind:'ventas',text:`Llegan mensajes como la vez pasada y no se convierten (${conv!==null?(conv*100).toFixed(1):'0'}% vs ${cmpPrev.conv!==null?(cmpPrev.conv*100).toFixed(1):'—'}%). El problema está en ventas, no en Ads.`});
      }else if(bench&&bench.n>=2&&leads>=5){
        if(spend<bench.spendAvg*0.5)notes.push({kind:'pauta',text:`Lleva la mitad o menos de pauta que las demás campañas de la marca (${money(bench.spendAvg)} promedio).`});
        if(cpl!==null&&cpl>bench.cpl*1.8)notes.push({kind:'ads',text:`CPL ${money(cpl)} contra ${money(bench.cpl)} en las demás: el anuncio no jala.`});
        if(conv!==null&&bench.conv>0&&conv<bench.conv*0.5&&leads>=10)notes.push({kind:'ventas',text:`Conversión ${(conv*100).toFixed(1)}% contra ${(bench.conv*100).toFixed(1)}% de las demás con los mismos vendedores: es ventas, no Ads.`});
      }
    }
    const salesFail=notes.some(n=>n.kind==='ventas')||(leads>=10&&students===0&&D>=3);

    // veredicto
    let type,action;
    const missing=Math.max(0,min-Math.round(proy)),pct=pctDe(students,min),pctProy=pctDe(proy,min),missingPct=Math.max(0,100-pctProy);
    const invest=missing>0&&cac?` ≈ ${money(missing*cac)} más de pauta${cacPrev?' (calculado con tu costo real de la corrida pasada)':bench?.cac?' (calculado con el promedio de la marca)':''}`:'';
    const cplOk=cpl===null||!bench||bench.n<2||cpl<=bench.cpl*1.3;
    if(daysLeft===0){type=students>=min?'ok':'hoy';action=students>=min?`Abre hoy al ${pct}% del mínimo. Captura el acumulado final.`:`Abre hoy al ${pct}% del mínimo. Coordinación decide si abre corta o se pospone; captura el acumulado final de la campaña.`;}
    else if(D<3&&students<2){type='espera';action=`Lanzada hace ${Math.max(1,Math.ceil(D))} día${Math.ceil(D)===1?'':'s'}. Sin ventas todavía es normal; se juzga al día 3.${!foto?' Ve capturando la pauta.':''}`;}
    else if(daysLeft>=3&&pctProy>=130&&cplOk){type='escalar';action=`Ya va al ${pct}% del mínimo y proyecta ${pctProy}% con ${daysLeft} días por delante${cpl!==null?` y CPL de ${money(cpl)}`:''}. Aquí es donde se gana: sube la pauta 30–50 % hoy y vigila que el CPL no se dispare; si se mantiene, sigue subiendo.`;}
    else if(proy>=min){type='ok';action=`Va a abrir: ${pct}% del mínimo y proyección de ${pctProy}%. Mantén la pauta.`;}
    else if(students===0&&D>=4){type='nova';action=salesFail?`${Math.floor(D)} días, ${leads} mensajes y ninguna venta: antes de bajar la pauta, ventas tiene que revisar esos chats. Si ventas confirma que no cierran, detén.`:`${Math.floor(D)} días sin ventas${foto?` con ${money(spend)} gastados y ${leads} mensajes`:''}: no va a llegar. Baja o detén la pauta y avisa a coordinación para posponer.`;}
    else if(proy>=min*0.75||(daysLeft>=5&&students>=2&&proy>=min*0.5)){type='subir';action=salesFail?`Falta ~${missingPct}% para el mínimo y hay mensajes que no se cierran: primero ventas, luego pauta.`:`Falta ~${missingPct}% para el mínimo y quedan ${daysLeft} días: súbele ahora${invest}.`;}
    else{type='nova';action=`Al ritmo actual cierra al ${pctProy}% del mínimo y quedan ${daysLeft} días: no va a llegar. Baja o detén la pauta y avisa a coordinación para posponer.`;}
    let relaunchText=null;
    if(relaunch&&type!=='ok'&&type!=='escalar')relaunchText=`Relanzamiento: la corrida del ${shortDay(relaunch.key)} cerró al ${pctDe(relaunch.total,min)}% del mínimo${relaunch.failed>=2?` · van ${relaunch.failed} corridas seguidas sin abrir`:''}. Sin cambios en anuncio, segmentación u oferta va a repetir el resultado; avisa antes de meterle más.`;
    else if(relaunch)relaunchText=`Relanzamiento que sí está funcionando (la del ${shortDay(relaunch.key)} cerró al ${pctDe(relaunch.total,min)}%).`;

    out.push({editionId:ed.id,brandId:ed.brandId,brandName:ed.brandName,courseId:ed.courseId,course:ed.course,edition:ed.name,startKey:ed.startKey,launchKey:ed.launchKey,
      type,title:VERDICTS[type].title,sub:VERDICTS[type].sub,action,notes,relaunchText,salesFail,
      min,students,projected:Math.round(proy),daysSinceLaunch:Math.floor(D),daysLeft,window,spendCents:spend,messages:leads,cplCents:cpl===null?null:Math.round(cpl),
      lastCaptureDay:foto?.day||null,capturedToday:Boolean(fotoDia),investCents:missing>0&&cac?Math.round(missing*cac):null});
  }
  return out.sort((a,b)=>VERDICTS[a.type].order-VERDICTS[b.type].order||(a.startKey<b.startKey?-1:1));
}
