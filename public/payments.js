window.createPaymentsUI=function({state,api,esc,icon,showModal,toast}){
  const $=s=>document.querySelector(s);
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn=(action,label,id='',extra='')=>`<button type="button" class="btn" data-action="pay-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note=copy=>`<p class="crm-hint">${copy}</p>`;
  const hidden=(name,value)=>`<input type="hidden" name="${name}" value="${esc(value)}">`;
  const KIND={pending:'',review:'warn',paid:'ok',cancelled:'',expired:''};
  const EVENT={created:'Pedido creado','link.sent':'Enlace enviado por el equipo','provider.declined':'Pago simulado rechazado',confirmed:'Pago confirmado',expired:'Enlace vencido','receipt.received':'Comprobante recibido','receipt.rejected':'Comprobante rechazado',cancelled:'Pedido cancelado'};
  const admin=()=>state.user?.role==='admin',brandId=()=>state.brand==='all'?'':state.brand;
  let data=null,settings=[],filter='all';
  async function load(){const [o,s]=await Promise.all([api('/api/payments/orders?'+new URLSearchParams({brand:state.brand,...(filter!=='all'?{status:filter}:{})})),api('/api/payments/settings')]);data=o;settings=s.settings;}
  function settingsBox(){
    const rows=settings.filter(s=>!brandId()||s.brand_id===brandId());
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Venta con pago simulado</h2>${chip('Sólo administración')}</div>${note('Por marca y apagado por omisión. Al activarlo, el equipo puede <strong>Cobrar</strong> desde el chat y el motor de respuestas genera un pedido con enlace de pago de prueba cuando el cliente pide inscribirse. El cliente paga con tarjeta u OXXO simulados o envía su comprobante por el chat, que entra a esta cola. Confirmar un pago inscribe, descuenta cupo, cierra la oportunidad como ganada y avisa al equipo. No se cobra nada real.')}<div class="rcp-brands">${rows.map(s=>`<form class="rcp-brand rcp-channel" id="pay-settings-${esc(s.brand_id)}" data-brand="${esc(s.brand_id)}">${hidden('expectedRevision',s.revision)}<div><strong>${esc(s.brand_name)}</strong><small>${s.enabled?'Activa':'Apagada'} · enlace vigente ${s.link_hours} h</small></div><div class="rcp-channel-fields"><label class="checkbox-field"><input type="checkbox" name="enabled" ${s.enabled?'checked':''} ${admin()?'':'disabled'}> Activa</label><label class="field">Vigencia · horas<input name="linkHours" type="number" min="1" max="720" value="${s.link_hours}" ${admin()?'':'disabled'}></label>${admin()?'<button type="submit" class="btn">Guardar</button>':''}</div></form>`).join('')}</div></section>`;
  }
  function row(o){
    return `<article class="ops-row pay-row"><div class="ops-row-person"><span class="avatar">${esc(o.contactName.slice(0,2).toUpperCase())}</span><div><strong>${esc(o.contactName)}</strong><small>${esc(o.courseTitle)} · ${esc(o.editionName)}</small><small>${esc(o.reference)} · ${o.source==='bot'?'Generado por el motor':'Generado por el equipo'}</small></div></div><div class="ops-row-state">${chip(o.statusLabel,KIND[o.status])}<strong>${esc(o.amountLabel)}</strong>${o.promotionName?`<small>${esc(o.promotionName)}</small>`:''}${o.methodLabel?`<small>${esc(o.methodLabel)}</small>`:''}</div><div class="ops-row-goal"><small>${o.status==='paid'?'Pagado '+stamp(o.paid_at):o.status==='pending'?'Vence '+stamp(o.expires_at):'Actualizado '+stamp(o.updated_at)}</small>${o.pendingReceipts?chip(o.pendingReceipts+' comprobante'+(o.pendingReceipts>1?'s':'')+' por revisar','warn'):''}</div><div class="actions">${btn('detail',o.pendingReceipts?'Revisar':'Ver',o.id)}<button type="button" class="btn" data-action="ops-chat" data-id="${o.conversation_id}">Abrir chat</button></div></article>`;
  }
  function html(){
    if(!data)return '<div class="loading-message">Cargando…</div>';
    const s=data.stats,tiles=[['review','Comprobantes por revisar',s.review],['pending','Pendientes de pago',s.pending],['paid','Pagados',s.paid],['all','Cobrado (práctica)',s.paidAmountLabel]];
    return `${settingsBox()}<div class="ops-stats">${tiles.map(([id,t,v])=>`<button data-action="pay-filter" data-id="${id}" class="ops-stat ${filter===id?'active':''}"><strong>${esc(String(v))}</strong><span>${t}</span></button>`).join('')}</div><div class="crm-toolbar"><p>${filter==='all'?'Todos los pedidos':'Filtro: '+({review:'comprobantes por revisar',pending:'pendientes de pago',paid:'pagados'}[filter]||filter)} · cobrado hoy ${esc(s.paidTodayLabel)}</p>${btn('reload',icon('refresh-cw')+' Actualizar')}</div><div class="ops-queue">${data.orders.map(row).join('')||`<div class="crm-empty">${icon('credit-card')}<h3>Sin pedidos</h3><p>Genera uno desde el chat con «Cobrar» o deja que el motor lo haga cuando un cliente pida inscribirse.</p></div>`}</div>${note('Los importes salen del catálogo al crear el pedido y no cambian después. Un comprobante nunca se valida solo: lo acepta o rechaza una persona con acceso a la marca.')}`;
  }
  async function detail(id){
    const d=await api('/api/payments/orders/'+id),o=d.order;
    showModal('Pedido '+o.reference,`<div class="ops-detail"><div class="ops-card-top">${chip(o.statusLabel,KIND[o.status])}${chip(o.amountLabel)}${o.methodLabel?chip(o.methodLabel):''}</div><p>${esc(o.contactName)} · ${esc(o.courseTitle)} · ${esc(o.editionName)}${o.promotionName?' · '+esc(o.promotionName):''}</p><p class="crm-hint">Enlace de pago: <code>${esc(o.link)}</code> · vence ${stamp(o.expires_at)}</p>
      ${d.receipts.length?`<h3>Comprobantes</h3>${d.receipts.map(r=>`<article class="pay-receipt"><div class="ops-card-top">${chip({pending:'Por revisar',accepted:'Aceptado',rejected:'Rechazado'}[r.status],r.status==='pending'?'warn':r.status==='accepted'?'ok':'')}<small>${stamp(r.created_at)}</small></div><a class="btn" href="${esc(r.attachmentUrl)}" target="_blank" rel="noopener">${icon(r.mime==='application/pdf'?'file-text':'image')} ${esc(r.filename)}</a><ul class="ops-action-list">${r.prelecture.checks.map(c=>`<li>${c.ok===true?'✓':c.ok===false?'✕':'·'} ${esc(c.name)}</li>`).join('')}</ul><p class="crm-hint">${esc(r.prelecture.note)}</p>${r.status!=='pending'?`<p class="crm-hint">${esc(r.reviewer_name||'Equipo')}: ${esc(r.review_note||'sin nota')}</p>`:`<form id="pay-accept-form" class="form-grid">${hidden('receiptId',r.id)}<label class="field">Nota (opcional)<input name="note" maxlength="500"></label><button type="submit" class="btn primary">Aceptar comprobante y confirmar pago</button></form><form id="pay-reject-form" class="form-grid">${hidden('receiptId',r.id)}<label class="field">Motivo para el cliente<input name="reason" required minlength="5" maxlength="500" placeholder="Importe distinto, comprobante ilegible…"></label><button type="submit" class="btn">Rechazar comprobante</button></form>`}</article>`).join('')}`:note('Sin comprobantes. El cliente puede pagar desde el enlace o enviar su comprobante por el chat.')}
      ${['pending','review'].includes(o.status)?`<form id="pay-cancel-form" class="form-grid">${hidden('orderId',o.id)}<label class="field">Cancelar pedido · motivo<input name="reason" required minlength="5" maxlength="500"></label><button type="submit" class="btn">Cancelar pedido</button></form>`:''}
      <h3>Historial</h3><div class="ops-notes">${d.events.map(e=>`<article><strong>${esc(EVENT[e.kind]||e.kind)}</strong><small>${esc(e.actor_name||(e.kind==='confirmed'&&e.details.providerRef?'Proveedor simulado':'Sistema'))} · ${stamp(e.created_at)}</small>${e.details.reason||e.details.note?`<p>${esc(e.details.reason||e.details.note)}</p>`:''}</article>`).join('')}</div><div class="actions"><button type="button" class="btn" data-action="ops-chat" data-id="${o.conversation_id}">Abrir chat</button></div><div class="ops-feedback" role="status"></div></div>`);
  }
  async function action(name,el){
    const id=el.dataset.id;
    if(name==='pay-reload')return 'reload';
    if(name==='pay-filter'){filter=id;return 'reload';}
    if(name==='pay-detail'){await detail(id);return true;}
    return false;
  }
  async function submit(form,input){
    const id=form.getAttribute('id');
    if(id?.startsWith('pay-settings-')){const fd=new FormData(form);await api('/api/payments/brands/'+form.dataset.brand,{method:'PATCH',body:{enabled:fd.has('enabled'),linkHours:Number(input.linkHours),expectedRevision:Number(input.expectedRevision)}});toast('Venta con pago actualizada');return 'reload';}
    if(id==='pay-accept-form'){await api('/api/payments/receipts/'+input.receiptId+'/accept',{method:'POST',body:{note:input.note}});$('#modal').close();toast('Pago confirmado: inscripción registrada y cliente avisado.');return 'reload';}
    if(id==='pay-reject-form'){await api('/api/payments/receipts/'+input.receiptId+'/reject',{method:'POST',body:{reason:input.reason}});$('#modal').close();toast('Comprobante rechazado; el cliente recibió el motivo.');return 'reload';}
    if(id==='pay-cancel-form'){await api('/api/payments/orders/'+input.orderId+'/cancel',{method:'POST',body:{reason:input.reason}});$('#modal').close();toast('Pedido cancelado.');return 'reload';}
    return false;
  }
  return {load,html,action,submit};
};
