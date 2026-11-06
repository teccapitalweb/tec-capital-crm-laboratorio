// «Preparar marca» (docs/PLAN_PREPARAR_MARCA.md): para cada marca, una lista con lo que ya está listo y lo que falta, y un botón
// por paso que lleva a la pantalla donde se arregla. Sólo lee (GET /api/readiness); no cambia ninguna configuración.
window.createReadinessUI=function({state,api,esc,icon,toast,go}){
  let data=null;
  async function load(){data=await api('/api/readiness');}
  const plural=(n,one,many)=>n===1?one:many;
  function step(s,isNext){
    return `<li class="rdy-step ${s.done?'done':''} ${isNext?'next':''}">
      <span class="rdy-mark" aria-hidden="true">${s.done?icon('check'):''}</span>
      <div class="rdy-copy"><strong>${esc(s.title)}</strong><small>${esc(s.detail)}</small></div>
      <button type="button" class="btn ${isNext?'primary':''}" data-action="rdy-go" data-view="${esc(s.view)}" data-tab="${esc(s.tab||'')}" aria-label="${esc(s.label+' · '+s.title)}">${esc(s.done?'Revisar':s.label)}</button>
    </li>`;
  }
  function group(name,steps,nextId){
    return `<div class="rdy-group"><h3>${esc(name)}</h3><ol class="rdy-list">${steps.map(s=>step(s,s.id===nextId)).join('')}</ol></div>`;
  }
  function card(b){
    const pct=b.essentials.total?Math.round(b.essentials.done/b.essentials.total*100):0;
    const missing=b.essentials.total-b.essentials.done;
    const groups=[...new Set(b.steps.map(s=>s.group))];
    const nextStep=b.steps.find(s=>s.id===b.nextStepId);
    return `<section class="crm-panel rdy-card" aria-label="${esc(b.name)}">
      <div class="ops-card-top"><h2>${esc(b.name)}</h2><span class="ops-chip ${b.ready?'good':'high'}">${b.ready?'Lista para atender y vender':`Faltan ${missing} ${plural(missing,'paso esencial','pasos esenciales')}`}</span></div>
      <div class="rdy-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Pasos esenciales de ${esc(b.name)}"><span style="width:${pct}%"></span></div>
      <p class="crm-hint">${b.essentials.done} de ${b.essentials.total} esenciales · ${b.extras.done} de ${b.extras.total} extras encendidos${nextStep?` · Siguiente: <strong>${esc(nextStep.title)}</strong>`:''}</p>
      ${groups.map(g=>group(g,b.steps.filter(s=>s.group===g),b.nextStepId)).join('')}
    </section>`;
  }
  function html(){
    if(!data)return '<div class="loading-message">Cargando…</div>';
    const brands=data.brands.filter(b=>state.brand==='all'||b.id===state.brand);
    if(!brands.length)return `<div class="crm-empty">${icon('inbox')}<h3>Sin marcas</h3><p>Crea primero una marca para poder prepararla.</p></div>`;
    return `<div class="crm-toolbar"><p>Qué tiene cada marca y qué le falta para atender y vender. Es sólo una revisión: aquí no se cambia nada; cada botón te lleva a la pantalla donde se arregla.</p><button type="button" class="btn" data-action="rdy-reload">${icon('refresh-cw')} Volver a revisar</button></div>${brands.map(card).join('')}`;
  }
  async function action(name,el){
    if(name==='rdy-reload'){await load();return 'draw';}
    if(name==='rdy-go'){await go(el.dataset.view,el.dataset.tab);return true;}
    return false;
  }
  return {load,html,action};
};
