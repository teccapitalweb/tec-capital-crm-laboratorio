// API y webhooks (docs/PLAN_API_PUBLICA.md): Operación → Sistema → «API y webhooks», sólo administración. Llaves de la API de lectura por marca con permisos,
// y destinos de webhooks (HTTPS) con el filtro de eventos, estado, entregas y secreto de firma. El valor de una llave y el secreto de un destino se muestran
// UNA sola vez, al crearlos o rotarlos. Las acciones llevan el prefijo «int-» (lo reclama operations.js).
window.createIntegrationsUI=function({state,api,esc,icon,showModal,toast}){
  const $=s=>document.querySelector(s);
  let sub='keys',data=null;
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const brandId=()=>state.brand==='all'?'':state.brand;
  const btn=(action,label,id='',extra='')=>`<button type="button" class="btn" data-action="int-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const base=()=>location.origin+'/api/v1';
  const WSTATE={active:['Activo','ok'],paused:['Pausado','warn'],disabled:['Desactivado','urgent']};

  async function load(){data=await api('/api/integrations'+(brandId()?'?brand='+encodeURIComponent(brandId()):''));}
  const note=copy=>`<p class="crm-hint">${copy}</p>`;

  function keyRow(k){
    return `<article class="ops-row int-row"><div class="ops-row-person"><span class="avatar">${icon('key-round')}</span><div><strong>${esc(k.name)}</strong><small><code>${esc(k.prefix)}…</code> · ${esc(k.brandName)} · ${k.scopes.map(s=>esc(data.scopes[s]||s)).join(', ')}</small><small>Creada ${esc(stamp(k.createdAt))} · ${k.lastUsedAt?'último uso '+esc(stamp(k.lastUsedAt)):'sin usos todavía'}${k.revokedAt?' · revocada '+esc(stamp(k.revokedAt)):''}</small></div></div><div class="actions">${chip(k.status==='active'?'Activa':'Revocada',k.status==='active'?'ok':'')}${k.status==='active'?btn('key-revoke','Revocar',k.id):''}</div></article>`;
  }
  function keysHtml(){
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Llaves de la API</h2>${chip('Sólo administración')}${btn('key-new',icon('plus')+' Nueva llave')}</div>
      ${note('Una llave da acceso a los datos de <strong>una marca</strong>, sólo con los permisos que elijas. Se manda como <code>Authorization: Bearer tcw_…</code> a <code>'+esc(base())+'</code> (otros sistemas, sólo lectura) o al conector de Claude, <code>'+esc(location.origin+'/mcp')+'</code>. Sólo guardamos su huella: el valor completo se muestra <strong>una sola vez</strong> al crearla.')}
      ${note('Los permisos que empiezan con «Claude:» son para conectar el CRM con Claude. El de <strong>MODIFICAR</strong> deja cambiar cursos y aperturas a nombre de quien crea la llave: dalo sólo cuando haga falta y revoca la llave al terminar.')}
      <div class="ops-queue">${data.keys.map(keyRow).join('')||`<div class="crm-empty">${icon('key-round')}<h3>Sin llaves</h3><p>Crea una para que otro sistema consulte tus datos.</p></div>`}</div></section>`;
  }
  function hookRow(w){
    const [label,kind]=WSTATE[w.status]||['',''],ev=w.events.includes('*')?'todos los eventos':w.events.length+' tipo'+(w.events.length===1?'':'s')+' de evento';
    return `<article class="ops-row int-row"><div class="ops-row-person"><span class="avatar">${icon('webhook')}</span><div><strong>${esc(w.url)}</strong><small>${esc(w.description||'Sin descripción')} · ${esc(w.brandName)} · ${esc(ev)}</small>
      <small>${w.stats.done} entregada${w.stats.done===1?'':'s'} · ${w.stats.pending} pendiente${w.stats.pending===1?'':'s'} · ${w.stats.failed} fallida${w.stats.failed===1?'':'s'}${w.stats.last?' · última actividad '+esc(stamp(w.stats.last)):''} · secreto <code>${esc(w.secretHint)}</code></small>
      ${w.disabledReason?`<small class="int-warn">${esc(w.disabledReason)}</small>`:''}</div></div>
      <div class="actions">${chip(label,kind)}${btn('hook-test',icon('send')+' Probar',w.id)}${btn('hook-deliveries','Entregas',w.id)}${btn('hook-edit',icon('pencil')+' Editar',w.id)}${w.status==='active'?btn('hook-status','Pausar',w.id,'data-status="paused"'):btn('hook-status','Activar',w.id,'data-status="active"')}${btn('hook-rotate','Rotar secreto',w.id)}${btn('hook-delete','Eliminar',w.id)}</div></article>`;
  }
  function hooksHtml(){
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Webhooks salientes</h2>${chip('Sólo administración')}${btn('hook-new',icon('plus')+' Nuevo destino')}</div>
      ${note('Cuando pasa algo en una marca (pago confirmado, pedido creado, inscripción…), avisamos por <strong>HTTPS</strong> a tu dirección con un JSON <strong>firmado</strong> (<code>TC-Signature</code>, HMAC-SHA-256). Si tu sistema no responde 2xx reintentamos con espera creciente (hasta 6 veces) y, tras 15 entregas fallidas seguidas, el destino se desactiva. No se aceptan direcciones internas o privadas.')}
      <div class="ops-queue">${data.endpoints.map(hookRow).join('')||`<div class="crm-empty">${icon('webhook')}<h3>Sin destinos</h3><p>Registra la dirección de tu sistema para recibir los eventos.</p></div>`}</div></section>`;
  }
  function html(){
    if(!data)return '<div class="loading-message">Cargando…</div>';
    const tabs=[['keys','Llaves de la API'],['webhooks','Webhooks']];
    return `<div class="ads-tabs" role="tablist">${tabs.map(([id,t])=>`<button type="button" role="tab" aria-selected="${sub===id}" data-action="int-sub" data-id="${id}" class="${sub===id?'active':''}">${esc(t)}</button>`).join('')}</div>${sub==='keys'?keysHtml():hooksHtml()}`;
  }

  // ---- ventanas
  const brandSelect=sel=>`<label class="field">Marca<select name="brandId" required>${state.brands.filter(b=>!brandId()||b.id===brandId()).map(b=>`<option value="${esc(b.id)}" ${sel===b.id?'selected':''}>${esc(b.name)}</option>`).join('')}</select></label>`;
  function keyForm(){
    showModal('Nueva llave de la API',`<form id="int-key-form" class="form-grid">${brandSelect()}
      <label class="field">Nombre (para quién o para qué es)<input name="name" maxlength="60" required placeholder="Panel de finanzas"></label>
      <fieldset class="survey-form"><legend>Permisos</legend><div class="int-scopes">${Object.entries(data.scopes).map(([k,l])=>`<label><input type="checkbox" name="scope-${esc(k)}" ${k==='events'?'checked':''}> ${esc(l)}</label>`).join('')}</div></fieldset>
      <button class="btn primary" type="submit">Crear llave</button></form>`);
  }
  function secretBox(label,value,extra=''){
    return `<div class="info-box"><strong>${esc(label)}</strong><div class="int-secret"><code id="int-secret">${esc(value)}</code><button type="button" class="btn" data-action="int-copy">Copiar</button></div><small>Guárdala ahora: <strong>no se vuelve a mostrar</strong>. Si la pierdes, ${extra}.</small></div>`;
  }
  function keyCreated(r){
    showModal('Llave creada',`${secretBox('Llave de la API',r.token,'revócala y crea otra')}
      <p class="crm-hint">Prueba que funciona (reemplaza la llave):</p><pre class="int-code">curl ${esc(base())}/me \\\n  -H "Authorization: Bearer ${esc(r.token)}"</pre>
      <p class="crm-hint">Rutas de lectura: <code>/me</code>, <code>/events?after=&limit=</code>, <code>/orders?after=&status=</code>, <code>/contacts?after=</code>, <code>/editions</code>. Guía completa en <code>docs/PLAN_API_PUBLICA.md</code>.</p>`);
  }
  function hookForm(w=null){
    const all=!w||w.events.includes('*'),chosen=new Set(w?.events||[]);
    showModal(w?'Editar destino':'Nuevo destino de webhook',`<form id="int-hook-form" class="form-grid">${w?`<input type="hidden" name="id" value="${esc(w.id)}"><input type="hidden" name="revision" value="${w.revision}">`:brandSelect()}
      <label class="field">Dirección HTTPS<input name="url" type="url" required maxlength="500" placeholder="https://tu-sistema.com/webhooks/tec" value="${esc(w?.url||'')}"></label>
      <label class="field">Descripción<input name="description" maxlength="120" placeholder="Sistema de facturación" value="${esc(w?.description||'')}"></label>
      <fieldset class="survey-form"><legend>Eventos</legend><label class="int-all"><input type="checkbox" name="all" ${all?'checked':''}> Todos los eventos de la marca</label>
      <div class="int-events">${data.eventTypes.map(t=>`<label><input type="checkbox" name="ev" value="${esc(t.type)}" ${chosen.has(t.type)?'checked':''}> <span>${esc(t.title)}</span><small>${esc(t.type)}</small></label>`).join('')}</div></fieldset>
      <button class="btn primary" type="submit">${w?'Guardar cambios':'Crear destino'}</button></form>`);
  }
  function hookCreated(r){
    showModal('Destino creado',`${secretBox('Secreto de firma',r.secret,'rótalo desde la lista y actualiza tu sistema')}
      <p class="crm-hint">Cada envío trae <code>TC-Signature: t=&lt;unix&gt;,v1=&lt;firma&gt;</code>. La firma es <code>HMAC-SHA-256(secreto, t + "." + cuerpo)</code> en hexadecimal; rechaza las marcas de tiempo con más de 5 minutos de diferencia. Responde <strong>2xx</strong> para confirmar; <code>TC-Delivery</code> es el mismo en los reintentos (úsalo para no procesar dos veces).</p>
      <p class="crm-hint">Usa <strong>Probar</strong> en la lista para enviar un evento de prueba (<code>webhook.test</code>).</p>`);
  }
  async function deliveries(id){
    const w=data.endpoints.find(x=>x.id===id),r=await api('/api/integrations/webhooks/'+id+'/deliveries');
    const KIND={pending:['Pendiente','warn'],done:['Entregada','ok'],failed:['Fallida','urgent']};
    showModal('Entregas · '+(w?.url||''),`<div class="int-deliveries">${r.deliveries.map(d=>{const [l,k]=KIND[d.state]||['',''];return `<article class="ops-row int-row"><div class="ops-row-person"><div><strong>${esc(d.type)}</strong><small>evt_${d.seq} · ${d.attempts} intento${d.attempts===1?'':'s'}${d.lastStatus?' · respuesta '+d.lastStatus:''} · ${esc(stamp(d.updatedAt))}</small>${d.error?`<small class="int-warn">${esc(d.error)}</small>`:''}</div></div><div class="actions">${chip(l,k)}${d.state==='failed'?btn('delivery-retry','Reintentar',d.id):''}</div></article>`;}).join('')||'<div class="crm-empty"><h3>Sin entregas todavía</h3><p>Aparecen cuando ocurre un evento que coincide con el filtro.</p></div>'}</div>`);
  }

  async function action(name,el){
    const id=el.dataset.id;
    if(name==='int-sub'){sub=id;return 'draw';}
    if(name==='int-key-new'){keyForm();return true;}
    if(name==='int-key-revoke'){if(!confirm('¿Revocar esta llave? Los sistemas que la usan dejarán de funcionar al instante.'))return true;await api('/api/integrations/keys/'+id+'/revoke',{method:'POST',body:{}});toast('Llave revocada.');return 'reload';}
    if(name==='int-hook-new'){hookForm();return true;}
    if(name==='int-hook-edit'){const w=data.endpoints.find(x=>x.id===id);if(w)hookForm(w);return true;}
    if(name==='int-hook-status'){const w=data.endpoints.find(x=>x.id===id);if(!w)return true;await api('/api/integrations/webhooks/'+id,{method:'PATCH',body:{status:el.dataset.status,expectedRevision:w.revision}});toast(el.dataset.status==='paused'?'Destino pausado.':'Destino activo.');return 'reload';}
    if(name==='int-hook-test'){const r=await api('/api/integrations/webhooks/'+id+'/test',{method:'POST',body:{}});toast(r.ok?'El destino respondió '+r.status+' en '+r.ms+' ms.':'No respondió bien: '+(r.error||'sin respuesta')+'.');return true;}
    if(name==='int-hook-deliveries'){await deliveries(id);return true;}
    if(name==='int-hook-rotate'){if(!confirm('¿Rotar el secreto? El anterior deja de servir y tendrás que actualizar tu sistema.'))return true;const r=await api('/api/integrations/webhooks/'+id+'/rotate',{method:'POST',body:{}});hookCreated(r);return 'reload-keep';}
    if(name==='int-hook-delete'){if(!confirm('¿Eliminar este destino y su historial de entregas?'))return true;await api('/api/integrations/webhooks/'+id,{method:'DELETE'});toast('Destino eliminado.');return 'reload';}
    if(name==='int-delivery-retry'){await api('/api/integrations/deliveries/'+id+'/retry',{method:'POST',body:{}});toast('Se reintentará en unos segundos.');$('#modal')?.close();return 'reload';}
    if(name==='int-copy'){const v=$('#int-secret')?.textContent||'';try{await navigator.clipboard.writeText(v);toast('Copiado.');}catch{toast('No se pudo copiar; selecciónalo y cópialo a mano.');}return true;}
    return false;
  }
  async function submit(form,input){
    const id=form.getAttribute('id'),fd=new FormData(form);
    if(id==='int-key-form'){
      const scopes=Object.keys(data.scopes).filter(k=>fd.has('scope-'+k));
      const r=await api('/api/integrations/keys',{method:'POST',body:{brandId:input.brandId,name:input.name,scopes}});keyCreated(r);return 'reload-keep';
    }
    if(id==='int-hook-form'){
      const events=fd.has('all')?['*']:fd.getAll('ev');if(!events.length)throw new Error('Elige al menos un evento o «Todos».');
      const body={url:input.url,description:input.description,events};
      if(input.id){await api('/api/integrations/webhooks/'+input.id,{method:'PATCH',body:{...body,expectedRevision:Number(input.revision)}});$('#modal').close();toast('Destino actualizado.');return 'reload';}
      const r=await api('/api/integrations/webhooks',{method:'POST',body:{...body,brandId:input.brandId}});hookCreated(r);return 'reload-keep';
    }
    return false;
  }
  return {load,html,action,submit};
};
