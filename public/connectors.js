window.createConnectorsUI=function({state,api,esc,icon,showModal,toast}){
  const $=s=>document.querySelector(s);
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn=(action,label,id='',extra='')=>`<button type="button" class="btn" data-action="cn-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note=copy=>`<p class="crm-hint">${copy}</p>`;
  const PROVIDER={simulated:'Simulado',meta:'Meta',stripe:'Stripe',conekta:'Conekta'};
  const CAP={templates:'plantillas',buttons:'botones',media:'imágenes y PDF',readReceipts:'confirmaciones de lectura',referral:'origen por anuncio',inboundWebhook:'entrantes por webhook',card:'tarjeta',oxxo:'OXXO',spei:'SPEI',transferReceipt:'comprobante de transferencia',refunds:'reembolsos'};
  let data=null;
  async function load(){data=await api('/api/connectors');}
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
    return `<div class="crm-toolbar"><p>Contrato de conectores v${esc(data.contractVersion)}: el CRM habla con una interfaz única; hoy la cumplen adaptadores simulados y mañana Meta y la pasarela de pago, sin tocar el resto.</p></div><div class="cn-grid">${card('channel','Canal · WhatsApp, Instagram, Facebook',data.channel)}${card('payment','Pago · tarjeta, OXXO, transferencia',data.payment)}</div>${testBox()}${events()}${requirements()}`;
  }
  async function action(name){if(name==='cn-reload')return 'reload';return false;}
  async function submit(form,input){
    if(form.getAttribute('id')!=='cn-test-form')return false;
    const payload=input.kind==='payment'?{kind:'payment',type:input.outcome==='failed'?'payment.failed':'payment.succeeded',order:input.order}:{kind:'channel',state:input.outcome};
    const r=await api('/api/connectors/test',{method:'POST',body:payload});
    showModal('Webhook de prueba enviado',`<p class="crm-hint">Respuesta del webhook: HTTP ${r.status}</p><pre class="cat-preview-copy">${esc(JSON.stringify(r.response,null,2))}</pre><h3>Evento enviado</h3><pre class="cat-preview-copy">${esc(JSON.stringify(r.sent,null,2))}</pre>`);
    return 'reload';
  }
  return {load,html,action,submit};
};
