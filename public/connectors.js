window.createConnectorsUI=function({state,api,esc,icon,showModal,toast}){
  const $=s=>document.querySelector(s);
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn=(action,label,id='',extra='')=>`<button type="button" class="btn" data-action="cn-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note=copy=>`<p class="crm-hint">${copy}</p>`;
  const PROVIDER={simulated:'Simulado',meta:'Meta',stripe:'Stripe',conekta:'Conekta'};
  const CAP={templates:'plantillas',buttons:'botones',media:'imágenes y PDF',readReceipts:'confirmaciones de lectura',referral:'origen por anuncio',inboundWebhook:'entrantes por webhook',card:'tarjeta',oxxo:'OXXO',spei:'SPEI',transferReceipt:'comprobante de transferencia',refunds:'reembolsos'};
  let data=null,core=null,wa=null,waPing=null,waEdit=null;
  async function load(){data=await api('/api/connectors');try{core=await api('/api/core');}catch{core=null;}try{wa=await api('/api/whatsapp');}catch{wa=null;}}
  // WhatsApp real (Meta · Cloud API): estado, prueba de conexión y números por marca. docs/PLAN_WHATSAPP_REAL.md
  function waPanel(){
    if(!wa)return '';
    const edit=waEdit?wa.numbers.find(n=>n.phoneNumberId===waEdit):null,suggest=!edit&&wa.envNumber&&!wa.envNumberAssigned?wa.envNumber:'';
    const todo=[];
    if(!wa.selected)todo.push('En Railway → Variables, pon <code class="cn-code">CHANNEL_CONNECTOR=meta</code>.');
    if(wa.missing.length)todo.push('Faltan en Railway: '+wa.missing.map(m=>'<code class="cn-code">'+esc(m)+'</code>').join(', ')+'.');
    if(!wa.numbers.length)todo.push('Asigna el número de WhatsApp a una marca en el formulario de abajo.');
    const ping=!waPing?'':'<p class="ais-ping '+(waPing.ok?'ok':'bad')+'" role="status">'+icon(waPing.ok?'check-circle':'alert-triangle')+'<span>'+(waPing.ok?'<strong>Meta respondió.</strong> Número '+esc(waPing.displayPhone||waPing.phoneNumberId)+(waPing.verifiedName?' · «'+esc(waPing.verifiedName)+'»':'')+(waPing.quality?' · calidad '+esc(waPing.quality):'')+'. El token y el número funcionan.':'<strong>Meta no respondió bien.</strong> '+esc(waPing.error||''))+' <small>'+esc(stamp(waPing.at))+'</small></span></p>';
    const rows=wa.numbers.map(n=>'<div class="wa-number"><div class="wa-number-main"><strong>'+esc(n.label||'Número de WhatsApp')+'</strong><code class="cn-code">'+esc(n.phoneNumberId)+'</code><small>'+esc(n.brandName)+' · '+esc(n.courseTitle?'recibe en «'+n.courseTitle+'»':'recibe en el primer curso con fechas disponibles')+' · '+n.people+' persona'+(n.people===1?'':'s')+' · '+n.conversations+' conversaci'+(n.conversations===1?'ón':'ones')+'</small></div>'+chip(n.enabled?'Recibiendo':'En pausa',n.enabled?'ok':'warn')+btn('wa-edit','Editar',n.phoneNumberId)+btn('wa-toggle',n.enabled?'Pausar':'Reanudar',n.phoneNumberId)+'</div>').join('');
    const opt=(v,l,sel)=>'<option value="'+esc(v)+'"'+(sel?' selected':'')+'>'+esc(l)+'</option>';
    const brandName=id=>wa.brands.find(b=>b.id===id)?.name||id;
    return '<section class="crm-panel wa-panel"><div class="ops-card-top"><h2>WhatsApp real · Meta</h2>'+(wa.live?chip('Activo','ok'):wa.selected?chip('Faltan datos','warn'):chip('Apagado'))+(wa.live?btn('wa-ping',icon('zap')+' Probar conexión con Meta'):'')+'</div>'
      +note('Cuando está activo, lo que una persona escribe a un número de WhatsApp de la empresa entra a la Bandeja como una conversación real y el asistente o el equipo le responden por la API de Meta. Los perfiles de prueba del laboratorio siguen simulados. El token y el secreto viven sólo en Railway: aquí nunca se muestran.')
      +ping
      +(todo.length?'<p class="crm-hint">Para activarlo falta:</p><ol class="cn-list">'+todo.map(t=>'<li>'+t+'</li>').join('')+'</ol>':'<p class="crm-hint">'+(wa.live?'Listo: escribe al número desde un teléfono y la conversación aparecerá en la Bandeja con el número de la persona.':'')+'</p>')
      +'<p class="crm-hint">Webhook para Meta (URL de devolución de llamada): <code class="cn-code">'+esc(location.origin+wa.webhookPath)+'</code> · token de verificación: el valor que pusiste en <code class="cn-code">META_VERIFY_TOKEN</code> · campo a suscribir: <code class="cn-code">messages</code>'+(wa.webhookReady?'':' · <strong>todavía no responde: faltan META_APP_SECRET y META_VERIFY_TOKEN</strong>')+'</p>'
      +(rows?'<div class="wa-numbers">'+rows+'</div>':'')
      +'<form id="cn-wa-form" class="form-grid"><h3>'+(edit?'Editar número':'Asignar un número a una marca')+'</h3><div class="cat-form-columns">'
      +'<label class="field">Identificador del número (el que muestra Meta, sólo dígitos)<input name="phoneNumberId" inputmode="numeric" pattern="[0-9]{5,25}" maxlength="25" required value="'+esc(edit?edit.phoneNumberId:suggest)+'"'+(edit?' readonly':'')+' placeholder="Por ejemplo 109000000000001"></label>'
      +'<label class="field">Marca que atiende<select name="brandId" required>'+wa.brands.map(b=>opt(b.id,b.name,edit?edit.brandId===b.id:false)).join('')+'</select></label>'
      +'<label class="field">Curso con el que empieza la conversación<select name="courseId">'+opt('','El primero con fechas disponibles',!edit||!edit.courseId)+wa.courses.map(k=>opt(k.id,brandName(k.brand_id)+' · '+k.title,edit?edit.courseId===k.id:false)).join('')+'</select></label>'
      +'<label class="field">Nombre para reconocerlo<input name="label" maxlength="60" value="'+esc(edit?edit.label:'')+'" placeholder="Número de prueba, Ventas GlobalVet…"></label></div>'
      +'<div class="actions"><button type="submit" class="btn primary">'+icon('save')+' '+(edit?'Guardar cambios':'Asignar número')+'</button>'+(edit?btn('wa-cancel','Cancelar'):'')+'</div></form></section>';
  }
  function corePanel(){
    if(!core)return '';const st=core.stats,sim=core.mode==='simulated';
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Núcleo compartido · Postgres/Supabase</h2>${sim?chip('Simulado · nada sale del servidor'):chip('Conectado a '+core.sinkHost,core.secretSet?'ok':'warn')}${!sim&&!core.secretSet?chip('Sin secreto HMAC','warn'):''}</div>${note('Cada hecho del negocio (eventos de dominio) se envía al núcleo como un sobre firmado con el evento y los registros implicados en la forma del esquema compartido (<code class="cn-code">nucleo/esquema-v1.sql</code>): consultoras, personas, cursos, ediciones, sesiones, pagos, inscripciones y certificados. Nunca viajan textos de mensajes, comentarios de encuestas ni adjuntos. Con reintento y espera creciente; «Reproducir historial» crea las entregas de todos los eventos anteriores a la conexión. Se activa con <code class="cn-code">CORE_SINK_URL</code> y <code class="cn-code">CORE_SINK_SECRET</code> en el entorno (docs/NUCLEO.md).')}
      <div class="ops-stats co-stats"><div class="ops-stat"><strong>${st.events}</strong><span>Eventos en total</span></div><div class="ops-stat"><strong>${st.done}</strong><span>Entregados${sim?' (simulado)':''}</span></div><div class="ops-stat ${st.pending?'active':''}"><strong>${st.pending}</strong><span>Pendientes</span></div><div class="ops-stat ${st.failed?'active':''}"><strong>${st.failed}</strong><span>Fallidos</span></div><div class="ops-stat ${st.missing?'active':''}"><strong>${st.missing}</strong><span>Sin entrega (historial)</span></div></div>
      ${st.lastError?`<p class="crm-hint">Último error: ${esc(st.lastError)}</p>`:''}
      <div class="actions">${btn('core-ping',icon('radio')+' Probar envío','',sim?'disabled':'')}${btn('core-retry','Reintentar fallidos','',st.failed?'':'disabled')}${btn('core-replay','Reproducir historial','',st.missing?'':'disabled')}${btn('reload',icon('refresh-cw')+' Actualizar')}</div>
      <div class="cn-events">${core.recent.slice(0,12).map(e=>`<div class="cn-event">${chip(e.modo==='simulado'?'Simulado':'HTTP '+e.estado,e.modo==='simulado'?'':'ok')}<span>${esc(e.tipo)}</span><span>#${e.seq} · ${Object.entries(e.registros).filter(([,n])=>n).map(([k,n])=>k+' '+n).join(' · ')||'sólo el hecho'}</span><small>${stamp(Date.parse(e.enviado_en))}</small></div>`).join('')||note('Todavía no se ha enviado ningún sobre en este proceso.')}</div></section>`;
  }
  function card(kind,title,d){
    const req=data.requirements[d.selected]||{items:[]},missing=d.missing.map(env=>req.items.find(i=>i.env===env)?.title||env);
    return `<section class="crm-panel"><div class="ops-card-top"><h2>${title}</h2>${chip(PROVIDER[d.selected]||d.selected)}${d.selected==='simulated'?chip('Laboratorio'):d.configured?chip('Configurado','ok'):chip('Sin configurar · usa el simulado','warn')}</div>
      <div class="cn-caps">${Object.entries(d.capabilities).filter(([,v])=>v).map(([k])=>chip(CAP[k]||k)).join('')}${d.channels?d.channels.map(c=>chip({whatsapp:'WhatsApp',instagram:'Instagram',facebook:'Facebook'}[c]||c)).join(''):''}</div>
      ${missing.length?`<p class="crm-hint">Falta entregar:</p><ul class="cn-list">${missing.map(m=>`<li>${esc(m)}</li>`).join('')}</ul>`:''}
      <p class="crm-hint">Webhook: <code class="cn-code">${esc(location.origin+d.webhookPath)}</code> · ${d.webhooksEnabled?'firma activa':'desactivado (falta el secreto)'}</p>
      <p class="crm-hint">Se cambia con <code class="cn-code">${kind==='channel'?'CHANNEL_CONNECTOR':'PAYMENT_CONNECTOR'}</code> en el entorno; mientras el proveedor real no esté completo, el CRM sigue con el simulado sin interrumpir nada.</p></section>`;
  }
  function requirements(){
    return `<section class="crm-panel cn-req"><h2>Qué debe entregar cada consultora</h2>${note('Lista por proveedor. «Quién» indica a quién pedirlo; el nombre técnico es la variable de entorno donde se guarda (nunca en Git). El detalle y la lista de verificación por marca están en docs/CONECTORES.md.')}${Object.entries(data.requirements).map(([id,r])=>`<details ${id===data.channel.selected||id===data.payment.selected?'open':''}><summary><strong>${esc(r.label)}</strong></summary><table><thead><tr><th>Entrega</th><th>Quién</th><th>Variable</th><th>Notas</th></tr></thead><tbody>${r.items.map(i=>`<tr><td>${esc(i.title)}</td><td>${esc(i.who)}</td><td><code>${esc(i.env)}</code></td><td>${esc(i.note)}</td></tr>`).join('')}</tbody></table>${r.notes?.length?`<ul class="cn-list">${r.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>`:''}</details>`).join('')}</section>`;
  }
  function testBox(){
    return `<section class="crm-panel"><h2>Probar un webhook firmado</h2>${note('Construye un evento real del laboratorio, lo firma con CONNECTOR_WEBHOOK_SECRET y lo manda a la ruta pública del proveedor simulado: exactamente el camino que seguirá un proveedor real. '+(data.env.hasLabSecret?'':'Define CONNECTOR_WEBHOOK_SECRET en el entorno para activarlo.'))}<form id="cn-test-form" class="form-grid"><div class="cat-form-columns"><label class="field">Tipo<select name="kind"><option value="channel">Estado de un mensaje (último saliente)</option><option value="payment">Pago de un pedido</option></select></label><label class="field">Resultado<select name="outcome"><option value="read">Leído / pago aprobado</option><option value="delivered">Entregado</option><option value="failed">Fallido / pago rechazado</option></select></label><label class="field">Pedido (referencia TC-… · sólo para pagos)<input name="order" maxlength="60" placeholder="TC-ABC123"></label></div><button type="submit" class="btn primary" ${data.env.hasLabSecret?'':'disabled'}>${icon('webhook')} Enviar evento firmado</button></form></section>`;
  }
  function events(){
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Últimos eventos recibidos</h2>${btn('reload',icon('refresh-cw')+' Actualizar')}</div><div class="cn-events">${data.recentEvents.map(e=>`<div class="cn-event">${chip(e.kind==='channel'?'Canal':'Pago')}${chip(PROVIDER[e.provider]||e.provider)}<span>${esc(e.type)}</span><span>${esc(e.result)}</span><small>${esc(e.event_id)} · ${stamp(e.created_at)}</small></div>`).join('')||note('Todavía no llega ningún evento. Cada evento se aplica una sola vez por proveedor e id.')}</div></section>`;
  }
  function html(){
    if(!data)return '<div class="loading-message">Cargando…</div>';
    return `<div class="crm-toolbar"><p>Contrato de conectores v${esc(data.contractVersion)}: el CRM habla con una interfaz única; hoy la cumplen adaptadores simulados y mañana Meta y la pasarela de pago, sin tocar el resto.</p></div><div class="cn-grid">${card('channel','Canal · WhatsApp, Instagram, Facebook',data.channel)}${card('payment','Pago · tarjeta, OXXO, transferencia',data.payment)}</div>${waPanel()}${corePanel()}${testBox()}${events()}${requirements()}`;
  }
  async function action(name,el){
    if(name==='cn-reload')return 'reload';
    try{
      if(name==='cn-wa-ping'){try{waPing=await api('/api/whatsapp/ping',{method:'POST',body:{}});}catch(e){waPing={ok:false,error:e.message};}waPing.at=Date.now();return 'reload';}
      if(name==='cn-wa-edit'){waEdit=el?.dataset.id||null;return 'reload';}
      if(name==='cn-wa-cancel'){waEdit=null;return 'reload';}
      if(name==='cn-wa-toggle'){const n=wa?.numbers.find(x=>x.phoneNumberId===el?.dataset.id);if(!n)return 'reload';await api('/api/whatsapp/numbers/'+n.phoneNumberId,{method:'PUT',body:{brandId:n.brandId,courseId:n.courseId,label:n.label,enabled:!n.enabled,expectedRevision:n.revision}});toast(n.enabled?'Número en pausa: lo que le escriban no entrará al CRM.':'Número recibiendo de nuevo.');return 'reload';}
      if(name==='cn-core-ping'){const r=await api('/api/core/ping',{method:'POST',body:{}});toast(r.ok?'El núcleo respondió HTTP '+r.status+'.':'Sin respuesta válida del núcleo: '+r.error);return 'reload';}
      if(name==='cn-core-retry'){const r=await api('/api/core/retry',{method:'POST',body:{}});toast(r.queued+' entrega(s) reprogramadas.');return 'reload';}
      if(name==='cn-core-replay'){const r=await api('/api/core/replay',{method:'POST',body:{}});toast(r.queued+' evento(s) del historial encolados hacia el núcleo.');return 'reload';}
    }catch(e){toast(e.message);return true;}
    return false;
  }
  async function submit(form,input){
    if(form.getAttribute('id')==='cn-wa-form'){
      const id=String(input.phoneNumberId||'').trim(),current=wa?.numbers.find(n=>n.phoneNumberId===id);
      if(!/^\d{5,25}$/.test(id)){toast('El identificador son sólo dígitos: cópialo de Meta → WhatsApp → Configuración de la API.');return true;}
      await api('/api/whatsapp/numbers/'+id,{method:'PUT',body:{brandId:input.brandId,courseId:input.courseId||null,label:input.label||'',expectedRevision:current?current.revision:0}});
      waEdit=null;toast(current?'Número actualizado.':'Número asignado. Ya puede recibir mensajes.');return 'reload';
    }
    if(form.getAttribute('id')!=='cn-test-form')return false;
    const payload=input.kind==='payment'?{kind:'payment',type:input.outcome==='failed'?'payment.failed':'payment.succeeded',order:input.order}:{kind:'channel',state:input.outcome};
    const r=await api('/api/connectors/test',{method:'POST',body:payload});
    showModal('Webhook de prueba enviado',`<p class="crm-hint">Respuesta del webhook: HTTP ${r.status}</p><pre class="cat-preview-copy">${esc(JSON.stringify(r.response,null,2))}</pre><h3>Evento enviado</h3><pre class="cat-preview-copy">${esc(JSON.stringify(r.sent,null,2))}</pre>`);
    return 'reload';
  }
  return {load,html,action,submit};
};
