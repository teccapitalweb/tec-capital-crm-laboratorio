window.createSimulatorUI=function({state,api,esc,icon,showModal,toast}){
  const $=s=>document.querySelector(s);
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const brandName=id=>state.brands.find(b=>b.id===id)?.name||'';
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn=(action,label,id='',extra='')=>`<button type="button" class="btn" data-action="sim-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note=copy=>`<p class="crm-hint">${copy}</p>`;
  const STATE={running:['En curso','ok'],finished:['Terminada',''],stopped:['Detenida','warn'],archived:['Archivada','']};
  const ACTOR={active:'Escribiendo',waiting:'Espera a una persona',done:'Terminó',stopped:'Detenido',failed:'Con error'};
  const CHANNEL={whatsapp:'WhatsApp',instagram:'Instagram',facebook:'Facebook'};
  const STAGE={nuevo:'nuevo',interesado:'interesado',inscripcion:'inscripción',ganada:'ganada',perdida:'perdida'};
  let meta=null,runs=[];
  async function load(){const [m,r]=await Promise.all([api('/api/simulator'),api('/api/simulator/runs')]);meta=m;runs=r.runs;}
  const seconds=ms=>ms===null||ms===undefined?'—':ms<1000?ms+' ms':(ms/1000).toFixed(1)+' s';
  const personaLabel=id=>meta.personas.find(x=>x.id===id)?.label||id;
  function form(){
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Simulador de clientes</h2>${chip('Sólo administración')}</div>${note('Crea clientes ficticios (su nombre termina en «· demo») que escriben por la misma API que un cliente real. El CRM responde como siempre: motor de respuestas, recetas y cola de atención. Sirve para presentar el producto o probar cambios; al terminar, archiva la demo.')}
    <form id="sim-form" class="form-grid"><div class="cat-form-columns"><label class="field">Marca<select name="brandId"><option value="all">Todas las marcas</option>${state.brands.map(b=>`<option value="${esc(b.id)}" ${state.brand===b.id?'selected':''}>${esc(b.name)}</option>`).join('')}</select></label><label class="field">Clientes simulados<input name="count" type="number" min="1" max="${meta.limits.maxActors}" value="8" required></label><label class="field">Ritmo<select name="pace">${meta.paces.map(p=>`<option value="${p.id}" ${p.id==='normal'?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label></div>
    <fieldset class="sim-personas-box"><legend>Perfiles de cliente</legend><div class="sim-personas">${meta.personas.map(p=>`<label class="sim-persona"><input type="checkbox" name="personas" value="${p.id}" checked><span><strong>${esc(p.label)}</strong><small>${esc(p.description)}</small></span></label>`).join('')}</div></fieldset>
    <div class="actions"><button type="submit" class="btn primary">${icon('play')} Iniciar demo</button></div>${note('Los perfiles se reparten por turnos entre los clientes, los cursos con edición vigente de la marca y los tres canales. Un cliente que espera a una persona aparece en la cola de atención hasta que alguien del equipo le responde.')}</form></section>`;
  }
  function runCard(r){
    const [label,kind]=STATE[r.state]||[r.state,''],s=r.stats,total=r.actors.length||1;
    const tiles=[['Escribiendo',s.byState.active],['Esperan a una persona',s.byState.waiting],['Terminaron',s.byState.done],['Sin intervención humana',s.finished?Math.round(s.withoutHuman*100/s.finished)+'%':'—']];
    return `<article class="crm-panel sim-run"><div class="ops-card-top"><strong>${esc(r.title)}</strong>${chip(label,kind)}</div><div class="sim-meta"><span>${r.brandIds.length>=state.brands.length?'Todas las marcas':esc(r.brandIds.map(brandName).filter(Boolean).join(', '))}</span><span>${r.count} clientes</span><span>${esc(meta.paces.find(p=>p.id===r.pace)?.label||r.pace)}</span><span>${stamp(r.createdAt)}</span></div>
    <div class="sim-progress" aria-hidden="true"><span style="width:${Math.round((s.byState.done+s.byState.stopped+s.byState.failed)*100/total)}%"></span></div>
    <div class="ops-stats sim-stats">${tiles.map(([t,v])=>`<div class="ops-stat"><strong>${v}</strong><span>${t}</span></div>`).join('')}</div>
    <div class="sim-meta"><span>Mensajes de clientes <strong>${s.messages.customer}</strong></span><span>Respuestas automáticas <strong>${s.messages.automation}</strong></span><span>Respuestas humanas <strong>${s.messages.agent}</strong></span><span>Primera respuesta automática <strong>${seconds(s.firstReplyMs)}</strong></span><span>Bajas registradas <strong>${s.optOuts}</strong></span><span>Etapas: ${Object.entries(s.stages).map(([k,n])=>`${STAGE[k]||esc(k)} ${n}`).join(' · ')||'—'}</span></div>
    <div class="sim-personas-row">${Object.entries(s.byPersona).filter(([,v])=>v.total).map(([p,v])=>chip(personaLabel(p)+' '+v.done+'/'+v.total+(v.waiting?' · '+v.waiting+' en espera':''))).join('')}</div>
    <details class="sim-actors" data-run="${r.id}" ${openLists.has(r.id)?'open':''}><summary>Clientes de la demo (${r.actors.length})</summary><div class="sim-actor-list">${r.actors.map(a=>`<div class="sim-actor"><span class="avatar">${esc(a.name.slice(0,2).toUpperCase())}</span><div><strong>${esc(a.name)}</strong><small>${esc(personaLabel(a.persona))} · ${CHANNEL[a.channel]} · ${esc(state.courses.find(c=>c.id===a.courseId)?.title||'')}</small><small>${esc(ACTOR[a.state]||a.state)}${a.outcome?' · '+esc(meta.outcomes[a.outcome]||a.outcome):''} · ${a.sent} enviados · ${a.gotBot} automáticas · ${a.gotHuman} humanas${a.error?' · '+esc(a.error):''}</small></div>${a.conversationId?`<button type="button" class="btn" data-action="ops-chat" data-id="${a.conversationId}">Abrir chat</button>`:''}</div>`).join('')}</div></details>
    <div class="actions">${['running','finished'].includes(r.state)?btn('stop','Detener',r.id):''}${r.state!=='archived'?btn('archive','Archivar',r.id):''}<button type="button" class="btn" data-action="ops-tab" data-id="queue">Ver cola de atención</button></div></article>`;
  }
  function catalogueBox(){
    return `<section class="crm-panel"><h2>Catálogo de demostración</h2>${note('Crea hasta '+meta.demo.brands+' marcas con '+meta.demo.coursesPerBrand+' cursos cada una (edición publicada, docente, cupo y algunas preventas) pasando por la importación CSV del catálogo. Repetirlo no duplica: lo existente se conserva. Los nombres son ficticios, salvo las tres marcas iniciales; puedes renombrarlos en el catálogo.')}<form id="sim-catalogue-form" class="form-grid"><div class="cat-form-columns"><label class="field">Marcas<input name="brands" type="number" min="1" max="${meta.demo.brands}" value="${meta.demo.brands}" required></label><label class="field">Cursos por marca<input name="courses" type="number" min="1" max="${meta.demo.coursesPerBrand}" value="${meta.demo.coursesPerBrand}" required></label></div><div class="actions"><button type="submit" class="btn">Generar catálogo de demostración</button></div></form></section>`;
  }
  let openLists=new Set();
  function html(){
    if(!meta)return '<div class="loading-message">Cargando…</div>';
    openLists=new Set([...document.querySelectorAll('.sim-actors[open]')].map(d=>d.dataset.run));   // las listas abiertas sobreviven a la actualización en vivo
    return `${form()}<div class="crm-toolbar"><p>Demos recientes. Las cifras se actualizan con la actividad de la aplicación.</p>${btn('reload',icon('refresh-cw')+' Actualizar')}</div><div class="sim-runs">${runs.map(runCard).join('')||`<div class="crm-empty">${icon('bot')}<h3>Sin demos</h3><p>Inicia una demo para ver clientes simulados escribiendo en la bandeja.</p></div>`}</div>${catalogueBox()}`;
  }
  async function action(name,el){
    const id=el.dataset.id;
    if(name==='sim-reload')return 'reload';
    if(name==='sim-stop'){await api('/api/simulator/runs/'+id+'/stop',{method:'POST',body:{}});toast('Demo detenida. Los clientes simulados dejan de escribir.');return 'reload';}
    if(name==='sim-archive'){showModal('Archivar demo',`<form id="sim-archive-form" class="form-grid"><input type="hidden" name="id" value="${esc(id)}"><p>Se cierran los chats de la demo, se cancelan sus trabajos y seguimientos pendientes y sus oportunidades se marcan como perdidas con el motivo «Demo archivada». El historial se conserva.</p><button type="submit" class="btn primary">Archivar</button></form>`);return;}
    return false;
  }
  async function submit(form,input){
    const id=form.getAttribute('id');
    if(id==='sim-form'){const personas=new FormData(form).getAll('personas');if(!personas.length)throw new Error('Elige al menos un perfil.');const r=await api('/api/simulator/runs',{method:'POST',body:{brandIds:input.brandId==='all'?'all':[input.brandId],count:Number(input.count),pace:input.pace,personas}});toast('Demo iniciada: '+r.run.actors.length+' clientes simulados.');return 'reload';}
    if(id==='sim-catalogue-form'){const r=await api('/api/simulator/catalogue',{method:'POST',body:{brands:Number(input.brands),courses:Number(input.courses)}});showModal('Catálogo de demostración',`<dl class="summary-grid"><div><dt>Marcas creadas</dt><dd>${r.brandsCreated}</dd></div><div><dt>Cursos creados</dt><dd>${r.coursesCreated}</dd></div><div><dt>Ediciones publicadas</dt><dd>${r.editionsCreated}</dd></div><div><dt>Preventas</dt><dd>${r.promotionsCreated}</dd></div><div><dt>Ya existían</dt><dd>${r.existing}</dd></div><div><dt>Con error</dt><dd>${r.failed}</dd></div></dl>${r.errors.length?`<ul class="ops-action-list">${r.errors.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`:''}${note('Las marcas y cursos nuevos aparecen en los selectores en cuanto la aplicación se actualiza.')}`);return 'reload';}
    if(id==='sim-archive-form'){await api('/api/simulator/runs/'+input.id+'/archive',{method:'POST',body:{}});$('#modal').close();toast('Demo archivada.');return 'reload';}
    return false;
  }
  return {load,html,action,submit};
};
