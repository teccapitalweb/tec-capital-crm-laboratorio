// Portal por roles: «Mis resultados» (docs/PLAN_PORTAL_ROLES.md). Vista de sólo lectura: ventas y comisiones, cartera y aperturas
// que coordina la persona, con avisos de atención. Administración puede elegir a otra persona del equipo.
window.createPortalUI=function({state,api,esc,icon,icons,toast}){
  const $=s=>document.querySelector(s);
  const num=n=>new Intl.NumberFormat('es-MX').format(n);
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const day=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium'}).format(t):'Sin fecha';
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const kpi=(label,value,hint='')=>`<div class="an-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong>${hint?`<small>${esc(hint)}</small>`:''}</div>`;
  const STAGE={nuevo:'Nuevo interés',interesado:'Interesado',inscripcion:'Inscripción solicitada'};
  const RUN={planned:['Planeada',''],open:['Abierta','good'],running:['En curso','good'],closed:['Cerrada','ok'],cancelled:['Cancelada','warn']};
  const METHOD={card:'Tarjeta',oxxo:'OXXO',transfer:'Transferencia'};
  const dur=ms=>{if(ms===null||ms===undefined)return '—';const s=Math.round(ms/1000);if(s<60)return s+' s';const m=Math.round(s/60);if(m<60)return m+' min';const h=Math.floor(m/60),r=m%60;if(h<48)return h+' h'+(r?' '+r+' min':'');return Math.round(h/24)+' d';};
  const pct=v=>v===null||v===undefined?'—':String(v).replace('.',',')+' %';
  let days=30,person='',data=null,team=null,version=0;
  const nav=()=>`<button data-view="results" class="${state.view==='results'?'active':''}" aria-label="Mis resultados">${icon('trending-up')}<span class="nav-label-text">Mis resultados</span></button>`;

  function alertsPanel(d){
    if(!d.alerts.length)return '';
    return `<section class="crm-panel pt-alerts"><div class="panel-title"><h2>Requiere atención</h2>${chip(d.alerts.length+(d.alerts.length===1?' aviso':' avisos'),d.alerts.some(a=>a.level==='urgent')?'urgent':'high')}</div>
      <ul class="pt-list">${d.alerts.map(a=>`<li>${chip(a.level==='urgent'?'Urgente':'Revisar',a.level==='urgent'?'urgent':'high')}<span><strong>${esc(a.course)}</strong> · ${esc(a.edition)}<br>${esc(a.text)}</span></li>`).join('')}</ul></section>`;
  }
  function salesPanel(d){
    const s=d.sales,c=d.commissions,max=Math.max(1,...s.byCourse.map(x=>Math.abs(x.netCents)));
    return `<section class="crm-panel"><div class="panel-title"><h2>Ventas y comisiones</h2>${chip(d.period.days+' días')}</div>
      <div class="an-kpis">${kpi('Ventas netas',s.netLabel,s.count+(s.count===1?' venta':' ventas')+(s.refunds?' · '+s.refunds+(s.refunds===1?' reembolso':' reembolsos'):''))}${kpi('Ticket promedio',s.avgTicketLabel,'sobre '+s.count+(s.count===1?' venta':' ventas'))}${kpi('Comisión del periodo',c.accruedLabel,'pagada: '+c.paidLabel)}${kpi('Pendiente de pago',c.pendingLabel,c.pendingCount+(c.pendingCount===1?' comisión devengada':' comisiones devengadas'))}</div>
      ${c.rule?`<p class="crm-hint">Regla de comisión de vendedor vigente: ${String(c.rule.percent).replace('.',',')} %${c.rule.fixedLabel&&c.rule.fixedLabel!=='$0.00'?' + '+esc(c.rule.fixedLabel)+' por venta':''}. Cada comisión guarda la regla con la que se calculó.</p>`:''}
      <div class="an-grid"><div><h3 class="rcp-subtitle">Por curso</h3>${s.byCourse.length?`<div class="an-funnel">${s.byCourse.map(x=>`<div class="an-funnel-row"><span>${esc(x.label)}</span><div class="an-bar"><i style="width:${Math.max(4,Math.round(Math.abs(x.netCents)/max*100))}%"></i></div><b>${x.sales}</b><small>${esc(x.netLabel)}</small></div>`).join('')}</div>`:'<p class="crm-hint">Sin ventas en el periodo.</p>'}</div>
      <div><h3 class="rcp-subtitle">Últimas liquidaciones</h3>${c.payouts.length?`<ul class="pt-list">${c.payouts.map(p=>`<li><span><strong>${esc(p.totalLabel)}</strong> · ${p.entries} ${p.entries===1?'comisión':'comisiones'}<br><small>${stamp(p.paid_at)}${p.note?' · '+esc(p.note):''}</small></span></li>`).join('')}</ul>`:'<p class="crm-hint">Todavía no hay liquidaciones.</p>'}</div></div>
      ${s.recent.length?`<h3 class="rcp-subtitle">Últimas ventas</h3><div class="fin-table-wrap"><table class="leg-table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Curso</th><th>Cliente</th><th>Importe</th></tr></thead><tbody>${s.recent.map(r=>`<tr><td>${day(r.at)}</td><td>${r.kind==='refund'?chip('Reembolso','warn'):chip('Venta','ok')}${r.method?'<br><small>'+esc(METHOD[r.method]||r.method)+'</small>':''}</td><td>${esc(r.course||'—')}${r.edition?'<br><small>'+esc(r.edition)+'</small>':''}</td><td>${esc(r.contact||'—')}</td><td>${esc(r.amountLabel)}</td></tr>`).join('')}</tbody></table></div>`:''}</section>`;
  }
  function pipelinePanel(d){
    const p=d.pipeline;
    return `<section class="crm-panel"><div class="panel-title"><h2>Mi cartera</h2></div>
      <div class="an-kpis">${kpi('Oportunidades abiertas',num(p.openTotal),Object.entries(STAGE).map(([k,l])=>l+': '+(p.open[k]||0)).join(' · '))}${kpi('Ganadas / perdidas',p.won+' / '+p.lost,p.winRate===null?'sin cierres en el periodo':'cierre: '+String(p.winRate).replace('.',',')+' %')}${kpi('Tareas abiertas',num(p.tasksOpen),p.tasksOverdue?p.tasksOverdue+(p.tasksOverdue===1?' vencida':' vencidas'):'ninguna vencida')}${kpi('Chats a mi cargo',num(p.chats),p.waiting?p.waiting+' esperando respuesta':'ninguno esperando')}</div></section>`;
  }
  function editionCard(e){
    const [label,kind]=RUN[e.runStatus]||[e.runStatus,''],pct=e.minStudents?Math.min(100,Math.round(e.enrolled/e.minStudents*100)):null;
    return `<article class="crm-panel rcp-card pt-edition"><div class="ops-card-top"><strong>${esc(e.course)}</strong>${chip(label,kind)}</div><small>${esc(e.brand)} · ${esc(e.name)} · ${e.startsAt?'empieza '+day(e.startsAt):'sin fecha de inicio'}</small>
      <div class="pt-line"><span><strong>${e.enrolled}</strong> inscritos${e.minStudents?' de '+e.minStudents+' del mínimo':''}</span>${pct!==null?`<div class="co-progress ${pct>=100?'done':''}" aria-hidden="true"><span style="width:${pct}%"></span></div>`:''}</div>
      <div class="cmp-mini"><span><strong>${e.sessionsDone}/${e.sessionsTotal}</strong> sesiones</span><span><strong>${e.certificates}</strong> certificados</span>${e.survey?`<span><strong>${String(e.survey.instructor).replace('.',',')}</strong> docente (${e.survey.responses} resp.)</span>`:''}</div>
      <small>${e.nextSession?'Próxima: sesión '+e.nextSession.number+' · '+stamp(e.nextSession.startsAt)+(e.nextSession.hasLink?'':' · sin enlace'):'Sin sesiones próximas'}</small></article>`;
  }
  function coordinationPanel(d){
    return `<section class="crm-panel"><div class="panel-title"><h2>Mis aperturas</h2></div>${d.coordination.editions.length?`<div class="rcp-grid">${d.coordination.editions.map(editionCard).join('')}</div>`:'<p class="crm-hint">No coordinas ninguna apertura activa. Administración te designa como responsable desde Operación → Coordinación.</p>'}</section>`;
  }
  // Rendimiento del equipo (sólo administración): una fila por persona, con las mismas definiciones que su portal personal.
  function teamPanel(){
    if(!team)return '';
    const t=team.totals;
    return `<section class="crm-panel"><div class="panel-title"><h2>Rendimiento del equipo</h2>${chip(team.period.days+' días')}</div>
      <div class="an-kpis">${kpi('Personas',num(t.people))}${kpi('Ventas netas',t.netLabel,t.sales+(t.sales===1?' venta':' ventas'))}${kpi('Tareas vencidas',num(t.tasksOverdue),'en todo el equipo')}${kpi('Avisos de aperturas',num(t.alerts),'por revisar')}</div>
      <div class="fin-table-wrap"><table class="leg-table pt-team"><thead><tr><th>Persona</th><th>Ventas netas</th><th>Cierre</th><th>Abiertas</th><th>Tareas vencidas</th><th>1.ª respuesta</th><th>En objetivo</th><th>Aperturas</th><th></th></tr></thead><tbody>${team.rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong><br><small>${esc(r.role==='admin'?'Administración':'Asesor')} · ${esc(r.brands.join(', '))}</small></td><td>${esc(r.sales.netLabel)}<br><small>${r.sales.count} ${r.sales.count===1?'venta':'ventas'}</small></td><td>${pct(r.pipeline.winRate)}<br><small>${r.pipeline.won} gan. / ${r.pipeline.lost} perd.</small></td><td>${r.pipeline.openTotal}</td><td>${r.pipeline.tasksOverdue?chip(String(r.pipeline.tasksOverdue),'urgent'):'0'}</td><td>${dur(r.service.medianMs)}<br><small>${r.service.responses} ${r.service.responses===1?'respuesta':'respuestas'}</small></td><td>${pct(r.service.withinTargetPct)}</td><td>${r.coordination.editions}${r.coordination.alerts?'<br>'+chip(r.coordination.alerts+(r.coordination.alerts===1?' aviso':' avisos'),r.coordination.urgent?'urgent':'high'):''}</td><td><button type="button" class="btn" data-action="pt-view" data-id="${esc(r.id)}">Ver</button></td></tr>`).join('')||'<tr><td colspan="9">Sin personas con acceso a las marcas elegidas.</td></tr>'}</tbody></table></div>
      <p class="crm-hint">${team.notes.map(esc).join(' ')}</p></section>`;
  }
  function view(){
    const d=data,who=d.person.self?'Mis resultados':'Resultados de '+d.person.name;
    return `<div class="content-page an-page pt-page"><div class="page-heading"><div><span class="eyebrow">Tu trabajo · ${esc(d.scope.brands.map(b=>b.name).join(', ')||'sin marcas')}</span><h1>${esc(who)}</h1><p>Ventas, comisiones, cartera y aperturas en un solo lugar. Cifras del laboratorio.</p></div></div>
      <div class="an-controls"><label>Periodo<select id="pt-days">${[7,30,90,365].map(n=>`<option value="${n}" ${days===n?'selected':''}>${n===365?'Último año':'Últimos '+n+' días'}</option>`).join('')}</select></label>
        ${d.people.length?`<label>Ver a<select id="pt-person"><option value="">Yo (${esc(state.user.name)})</option>${d.people.filter(p=>p.id!==state.user.id).map(p=>`<option value="${esc(p.id)}" ${person===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label>`:''}
        <button class="btn" data-action="pt-reload">${icon('refresh-cw')} Actualizar</button></div>
      ${alertsPanel(d)}${salesPanel(d)}${pipelinePanel(d)}${coordinationPanel(d)}${teamPanel()}<p class="crm-hint an-notes">${d.notes.map(esc).join(' ')}</p></div>`;
  }
  async function render(){
    const mine=++version;
    if(!$('.pt-page'))$('#page').innerHTML='<div class="content-page"><div class="loading-message">Calculando tus resultados…</div></div>';
    try{
      const params=new URLSearchParams({days});if(state.brand&&state.brand!=='all')params.set('brand',state.brand);if(person)params.set('person',person);
      const teamParams=new URLSearchParams({days});if(state.brand&&state.brand!=='all')teamParams.set('brand',state.brand);
      const [result,teamResult]=await Promise.all([api('/api/portal/me?'+params),state.user.role==='admin'?api('/api/portal/team?'+teamParams):null]);if(mine!==version||state.view!=='results')return;
      data=result;team=teamResult;const scrolled=$('#page .content-page')?.scrollTop||0;$('#page').innerHTML=view();icons();const box=$('#page .content-page');if(box)box.scrollTop=scrolled;
    }catch(e){if(state.view==='results'){$('#page').innerHTML=`<div class="content-page"><div class="crm-empty">${icon('trending-up')}<h3>No pudimos calcular tus resultados</h3><p>${esc(e.message)}</p><button class="btn" data-action="pt-reload">Volver a intentar</button></div></div>`;icons();}toast(e.message);}
  }
  async function action(name,el){if(name==='pt-reload'){await render();return true;}if(name==='pt-view'){person=el.dataset.id===state.user.id?'':el.dataset.id;await render();$('#page .content-page')?.scrollTo({top:0});return true;}return false;}
  async function change(el){
    if(el.id==='pt-days'){days=Number(el.value);await render();return true;}
    if(el.id==='pt-person'){person=el.value;await render();return true;}
    return false;
  }
  return {nav,render,action,change};
};
