// Contenido (pestaña del catálogo): plantillas por evento, funciones de diseño/aprobación, variantes por IA y fichas.
window.createContentUI=function({state,api,esc,icon,showModal,toast,reload}){
  const $=s=>document.querySelector(s),admin=()=>state.user?.role==='admin';
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn=(action,label,id='',extra='',klass='')=>`<button type="button" class="btn ${klass}" data-action="ct-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note=copy=>`<p class="crm-hint">${copy}</p>`;
  let data=null,members=null;
  async function load(){data=await api('/api/content/events?brand='+encodeURIComponent(state.brand));if(admin()){try{members=(await api('/api/content/access')).members;}catch{members=null;}}}
  const access=()=>data?.access||{design:false,approve:false,admin:false};
  function eventsPanel(){
    return data.brands.map(b=>`<section class="crm-panel ct-brand"><div class="ops-card-top"><h2>${esc(b.name)}</h2>${chip(b.mappings.filter(m=>m.templateId&&m.enabled).length+' de '+data.events.length+' eventos con plantilla')}</div><div class="ct-events">${b.mappings.map(m=>{const ev=data.events.find(e=>e.id===m.event);return `<form id="ct-map-${esc(b.id)}-${m.event}" class="ct-event"><input type="hidden" name="brandId" value="${esc(b.id)}"><input type="hidden" name="event" value="${m.event}"><input type="hidden" name="expectedRevision" value="${m.revision}"><div><strong>${esc(ev.title)}</strong><small>${esc(ev.when)}</small><small>Variables: ${ev.vars.map(v=>'{{'+v+'}}').join(' ')}</small></div><div class="ct-event-pick"><select name="templateId" ${access().approve?'':'disabled'}><option value="">Sin plantilla (texto fijo${m.event==='recording_available'?': no se avisa':''})</option>${m.candidates.map(c=>`<option value="${esc(c.id)}" ${c.id===m.templateId?'selected':''}>${esc(c.title)}</option>`).join('')}</select><label class="checkbox-field"><input type="checkbox" name="enabled" ${m.enabled?'checked':''} ${access().approve?'':'disabled'}> Activa</label>${access().approve?'<button class="btn" type="submit">Guardar</button>':''}</div><div>${m.templateId?chip(m.enabled?'Con plantilla':'Pausada',m.enabled?'good':''):chip('Texto fijo')}${m.templateId&&m.templateStatus!=='approved'?chip('La plantilla ya no está aprobada','urgent'):''}</div></form>`;}).join('')}</div></section>`).join('');
  }
  function accessPanel(){
    if(!admin()||!members)return '';
    return `<details class="crm-panel co-details ct-access"><summary>Funciones de contenido · diseño sube, aprobación aprueba, venta usa</summary>${note('Por omisión sólo administración crea y aprueba flyers y plantillas. «Diseño» permite crear y editar borradores y subir archivos; «Aprobación» además aprueba, archiva y mapea plantillas a eventos. El resto del equipo usa lo aprobado desde el chat.')}<div class="co-list">${members.filter(m=>m.role!=='admin').map(m=>`<div class="co-row"><div><strong>${esc(m.name)}</strong><small>@${esc(m.username)}${m.disabled?' · suspendida':''}</small></div><div>${m.approve?chip('Aprobación','good'):m.design?chip('Diseño','good'):chip('Sólo usa')}</div><div class="actions">${btn('access',m.design?'Quitar diseño':'Dar diseño',m.id,`data-design="${m.design?0:1}" data-approve="${m.approve&&m.design?1:0}"`)}${btn('access',m.approve?'Quitar aprobación':'Dar aprobación',m.id,`data-design="${m.approve?(m.design?1:0):1}" data-approve="${m.approve?0:1}"`)}</div></div>`).join('')||note('No hay asesores en el equipo.')}</div></details>`;
  }
  function render(){
    if(!data)return '<div class="loading-message">Cargando…</div>';
    return `<div class="ev-head"><p class="crm-hint">Cada marca elige qué plantilla <strong>aprobada</strong> se envía en cada hecho del curso. Las plantillas se crean en la pestaña Plantillas con el escenario del evento y sus variables; sin plantilla mapeada se conserva el texto fijo del laboratorio (y la grabación disponible no se avisa). Desde la tarjeta de cada plantilla se piden <strong>variantes</strong> al adaptador de IA (${esc(data.access.admin||data.access.design?'puedes pedirlas':'las pide quien tiene función de diseño')}) y desde Ediciones se genera la <strong>ficha</strong> SVG.</p></div>${accessPanel()}${eventsPanel()}`;
  }
  // ---- variantes (desde la tarjeta de una plantilla)
  async function variants(templateId,title){
    const r=await api('/api/content/templates/'+templateId+'/variants');
    showModal('Variantes · '+esc(title),`<div class="ct-variants">${note('El adaptador de IA (simulado sin clave) propone redacciones en otro tono conservando las variables; ninguna se usa hasta que una persona la acepta como borrador y después se aprueba como cualquier plantilla.')}${access().design?`<form id="ct-variants-form" class="co-inline"><input type="hidden" name="templateId" value="${esc(templateId)}">${Object.entries(r.tones).map(([k,v])=>`<label class="checkbox-field"><input type="checkbox" name="tone" value="${k}" checked> ${esc(v)}</label>`).join('')}<button class="btn" type="submit">${icon('sparkles')} Pedir variantes</button></form>`:''}<div class="co-list" id="ct-variant-list">${r.variants.map(variantRow).join('')||note('Todavía no hay variantes para esta plantilla.')}</div></div>`);
  }
  const variantRow=v=>`<div class="co-row ct-variant"><div><strong>${esc(v.toneLabel)}</strong><small>${esc(v.provider)} · ${esc(v.model)} · ${stamp(v.created_at)}${v.created_by_name?' · '+esc(v.created_by_name):''}</small><pre class="cat-preview-copy">${esc(v.body)}</pre></div><div>${chip({draft:'Por decidir',accepted:'Aceptada (borrador creado)',rejected:'Rechazada'}[v.status],v.status==='accepted'?'good':v.status==='rejected'?'':'high')}</div><div class="actions">${v.status==='draft'&&access().design?btn('variant-accept','Aceptar como borrador',v.id,'','primary')+btn('variant-reject','Rechazar',v.id):''}</div></div>`;
  async function sheet(editionId,name){
    showModal('Ficha generada · '+esc(name),`<div class="ct-sheet">${note('Generada desde el catálogo (curso, edición, fecha, precio y promoción vigentes) con código QR al anuncio aprobado. Se guarda en caché por versión: cambia el precio y se regenera.')}<div class="ct-sheet-wrap"><img src="/api/content/sheets/${esc(editionId)}.svg?t=${Date.now()}" alt="Ficha del curso"></div><div class="actions"><a class="btn" href="/api/content/sheets/${esc(editionId)}.svg" target="_blank" rel="noopener">${icon('download')} Abrir SVG</a>${access().design?btn('sheet-flyer','Guardar como flyer en borrador',editionId):''}</div></div>`);
  }
  async function action(name,el){
    const id=el.dataset.id;
    try{
      if(name==='ct-variants'){await variants(id,el.dataset.title||'plantilla');return true;}
      if(name==='ct-variant-accept'||name==='ct-variant-reject'){const r=await api('/api/content/variants/'+id+'/'+(name==='ct-variant-accept'?'accept':'reject'),{method:'POST',body:{}});toast(name==='ct-variant-accept'?'Variante aceptada: ya está como borrador en Plantillas.':'Variante rechazada.');await reload();await variants(r.variant.template_id,'plantilla');return true;}
      if(name==='ct-sheet'){await sheet(id,el.dataset.name||'edición');return true;}
      if(name==='ct-sheet-flyer'){const r=await api('/api/content/sheets/'+id+'/flyer',{method:'POST',body:{}});toast('Flyer en borrador creado desde la ficha. Apruébalo en Flyers.');await reload();$('#modal').close();void r;return true;}
      if(name==='ct-access'){await api('/api/content/access',{method:'PUT',body:{userId:id,design:el.dataset.design==='1',approve:el.dataset.approve==='1'}});toast('Funciones de contenido actualizadas.');await reload();return true;}
    }catch(e){toast(e.message);}
    return true;
  }
  async function submit(form,input){
    const id=form.getAttribute('id');
    try{
      if(id?.startsWith('ct-map-')){await api('/api/content/events/'+input.brandId+'/'+input.event,{method:'PUT',body:{templateId:input.templateId||null,enabled:new FormData(form).has('enabled'),expectedRevision:Number(input.expectedRevision)}});toast('Plantilla del evento guardada.');await reload();return true;}
      if(id==='ct-variants-form'){const tones=new FormData(form).getAll('tone');const r=await api('/api/content/templates/'+input.templateId+'/variants',{method:'POST',body:{tones}});toast(r.variants.length+' variante(s) propuestas'+(r.rejected.length?' · '+r.rejected.length+' descartadas por las reglas':'')+'.');await variants(input.templateId,'plantilla');return true;}
    }catch(e){toast(e.message);}
    return true;
  }
  return {load,render,action,submit,access};
};
