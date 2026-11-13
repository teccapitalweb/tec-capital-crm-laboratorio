window.createPaymentsUI = function ({ state, api, esc, icon, showModal, toast }) {
  const $ = s => document.querySelector(s);
  const stamp = t =>
    t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(t) : '—';
  const chip = (label, kind = '') => `<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn = (action, label, id = '', extra = '') =>
    `<button type="button" class="btn" data-action="pay-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note = copy => `<p class="crm-hint">${copy}</p>`;
  const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
  const KIND = { pending: '', review: 'warn', paid: 'ok', cancelled: '', expired: '' };
  const EVENT = {
    created: 'Pedido creado',
    'link.sent': 'Enlace enviado por el equipo',
    'provider.declined': 'Pago simulado rechazado',
    confirmed: 'Pago confirmado',
    expired: 'Enlace vencido',
    'receipt.received': 'Comprobante recibido',
    'receipt.rejected': 'Comprobante rechazado',
    cancelled: 'Pedido cancelado',
  };
  const admin = () => state.user?.role === 'admin',
    brandId = () => (state.brand === 'all' ? '' : state.brand);
  let data = null,
    settings = [],
    filter = 'all',
    coupons = [];
  async function load() {
    const [o, s] = await Promise.all([
      api(
        '/api/payments/orders?' +
          new URLSearchParams({ brand: state.brand, ...(filter !== 'all' ? { status: filter } : {}) }),
      ),
      api('/api/payments/settings'),
    ]);
    data = o;
    settings = s.settings;
    if (admin()) {
      try {
        coupons = (await api('/api/coupons' + (brandId() ? '?brand=' + encodeURIComponent(brandId()) : ''))).coupons;
      } catch {
        coupons = [];
      }
    } else coupons = [];
  }
  function settingsBox() {
    const rows = settings.filter(s => !brandId() || s.brand_id === brandId());
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Venta con pago simulado</h2>${chip('Sólo administración')}</div>${note('Por marca y apagado por omisión. Al activarlo, el equipo puede <strong>Cobrar</strong> desde el chat y el motor de respuestas genera un pedido con enlace de pago de prueba cuando el cliente pide inscribirse. El cliente paga con tarjeta u OXXO simulados o envía su comprobante por el chat, que entra a esta cola. Confirmar un pago inscribe, descuenta cupo, cierra la oportunidad como ganada y avisa al equipo. No se cobra nada real.')}<div class="rcp-brands">${rows.map(s => `<form class="rcp-brand rcp-channel" id="pay-settings-${esc(s.brand_id)}" data-brand="${esc(s.brand_id)}">${hidden('expectedRevision', s.revision)}<div><strong>${esc(s.brand_name)}</strong><small>${s.enabled ? 'Activa' : 'Apagada'} · enlace vigente ${s.link_hours} h</small></div><div class="rcp-channel-fields"><label class="checkbox-field"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''} ${admin() ? '' : 'disabled'}> Activa</label><label class="field">Vigencia · horas<input name="linkHours" type="number" min="1" max="720" value="${s.link_hours}" ${admin() ? '' : 'disabled'}></label>${admin() ? '<button type="submit" class="btn">Guardar</button>' : ''}</div></form>`).join('')}</div></section>`;
  }
  function row(o) {
    return `<article class="ops-row pay-row"><div class="ops-row-person"><span class="avatar">${esc(o.contactName.slice(0, 2).toUpperCase())}</span><div><strong>${esc(o.contactName)}</strong><small>${esc(o.courseTitle)} · ${esc(o.editionName)}</small><small>${esc(o.reference)} · ${o.source === 'bot' ? 'Generado por el motor' : 'Generado por el equipo'}</small></div></div><div class="ops-row-state">${chip(o.statusLabel, KIND[o.status])}${o.kind === 'session' ? chip('Sesión ' + o.sessionNumber) : o.plan === 'per_session' ? chip('Por sesión') : ''}<strong>${esc(o.amountLabel)}</strong>${o.promotionName ? `<small>${esc(o.promotionName)}</small>` : ''}${o.methodLabel ? `<small>${esc(o.methodLabel)}</small>` : ''}</div><div class="ops-row-goal"><small>${o.status === 'paid' ? 'Pagado ' + stamp(o.paid_at) : o.status === 'pending' ? 'Vence ' + stamp(o.expires_at) : 'Actualizado ' + stamp(o.updated_at)}</small>${o.pendingReceipts ? chip(o.pendingReceipts + ' comprobante' + (o.pendingReceipts > 1 ? 's' : '') + ' por revisar', 'warn') : ''}</div><div class="actions">${btn('detail', o.pendingReceipts ? 'Revisar' : 'Ver', o.id)}<button type="button" class="btn" data-action="ops-chat" data-id="${o.conversation_id}">Abrir chat</button></div></article>`;
  }
  // ---- Cupones (docs/PLAN_CUPONES.md): sólo administración
  const CSTATE = {
    active: ['Activo', 'ok'],
    paused: ['Pausado', 'warn'],
    archived: ['Archivado', ''],
    scheduled: ['Aún no vigente', ''],
    expired: ['Vencido', ''],
    exhausted: ['Agotado', 'warn'],
  };
  const day = t => (t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(t) : '');
  const brandName = id => state.brands.find(b => b.id === id)?.name || id;
  function couponRow(c) {
    const [label, kind] = CSTATE[c.state] || ['', ''],
      when =
        c.startsAt || c.endsAt
          ? (c.startsAt ? 'desde ' + day(c.startsAt) + ' ' : '') + (c.endsAt ? 'hasta ' + day(c.endsAt) : '')
          : 'sin fecha límite';
    const scope = c.editionName ? c.courseTitle + ' · ' + c.editionName : c.courseTitle || 'todos los cursos';
    return `<article class="ops-row pay-row coupon-row"><div class="ops-row-person"><span class="avatar">%</span><div><strong>${esc(c.code)} · ${esc(c.valueLabel)} de descuento</strong><small>${esc(c.name)}${brandId() ? '' : ' · ' + esc(brandName(c.brandId))} · ${esc(scope)}</small><small>${esc(when)} · ${c.uses} uso${c.uses === 1 ? '' : 's'}${c.maxUses ? ' de ' + c.maxUses : ''} · ${c.perContact} por persona${c.customerEntry ? ' · el cliente puede escribirlo' : ''}${c.paidUses ? ' · ' + c.paidUses + ' pagado' + (c.paidUses === 1 ? '' : 's') : ''}</small></div></div><div class="actions">${chip(label, kind)}${c.status === 'archived' ? '' : btn('coupon-edit', icon('pencil') + ' Editar', c.id)}${c.status === 'active' ? btn('coupon-status', 'Pausar', c.id, 'data-status="paused"') : c.status === 'paused' ? btn('coupon-status', 'Activar', c.id, 'data-status="active"') : ''}${c.status === 'archived' ? '' : btn('coupon-status', 'Archivar', c.id, 'data-status="archived"')}</div></article>`;
  }
  function couponsBox() {
    if (!admin()) return '';
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Cupones de descuento</h2>${chip('Sólo administración')}${btn('coupon-new', icon('plus') + ' Nuevo cupón')}</div>${note('Códigos por marca (porcentaje o monto fijo) que el equipo escribe en <strong>Cobrar</strong>. Aplican al curso completo, no al plan por sesión; un pedido cancelado o vencido libera su uso. El código, el tipo y el valor no se cambian después de crearlo: crea uno nuevo y pausa el anterior.')}<div class="ops-queue">${coupons.map(couponRow).join('') || `<div class="crm-empty">${icon('ticket-percent')}<h3>Sin cupones</h3><p>Crea uno para ofrecer un descuento en una campaña o a una persona.</p></div>`}</div></section>`;
  }
  const local = t => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  function couponForm(c = null) {
    const brands = state.brands.filter(b => !brandId() || b.id === brandId()),
      courses = state.courses.filter(k => k.brand_id === (c ? c.brandId : brandId() || brands[0]?.id));
    return `<form id="pay-coupon-form" class="form-grid">${c ? hidden('id', c.id) + hidden('revision', c.revision) + hidden('brandId', c.brandId) : ''}
      ${c ? '' : `<label class="field">Marca<select name="brandId" required>${brands.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></label>`}
      <label class="field">Código<input name="code" maxlength="24" required ${c ? 'disabled' : ''} value="${esc(c?.code || '')}" placeholder="VERANO10" autocomplete="off"></label>
      <label class="field">Nombre (para reconocerlo)<input name="name" maxlength="80" required value="${esc(c?.name || '')}" placeholder="Promoción de verano"></label>
      <div class="coupon-two"><label class="field">Tipo<select name="kind" ${c ? 'disabled' : ''}><option value="percent" ${c?.kind !== 'amount' ? 'selected' : ''}>Porcentaje</option><option value="amount" ${c?.kind === 'amount' ? 'selected' : ''}>Monto fijo (pesos)</option></select></label>
      <label class="field">Valor<input name="value" type="number" min="1" step="1" required ${c ? 'disabled' : ''} value="${c ? (c.kind === 'percent' ? c.value : c.value / 100) : ''}" placeholder="10"></label></div>
      <label class="field">Aplica a<select name="courseId"><option value="">Todos los cursos de la marca</option>${courses.map(k => `<option value="${esc(k.id)}" ${c?.courseId === k.id ? 'selected' : ''}>${esc(k.title)}</option>`).join('')}</select></label>
      <div class="coupon-two"><label class="field">Vigente desde<input name="startsAt" type="datetime-local" value="${esc(local(c?.startsAt))}"></label><label class="field">Hasta<input name="endsAt" type="datetime-local" value="${esc(local(c?.endsAt))}"></label></div>
      <div class="coupon-two"><label class="co-check"><input type="checkbox" name="customerEntry" ${c?.customerEntry ? 'checked' : ''}> El cliente puede escribirlo en su pantalla de pago (si no, sólo lo aplica el equipo en Cobrar)</label>
      <div class="coupon-two"><label class="field">Usos en total (vacío = sin tope)<input name="maxUses" type="number" min="1" step="1" value="${c?.maxUses || ''}"></label><label class="field">Usos por persona<input name="perContact" type="number" min="1" max="10" step="1" required value="${c?.perContact || 1}"></label></div>
      <button class="btn primary" type="submit">${c ? 'Guardar cambios' : 'Crear cupón'}</button></form>`;
  }
  // Al cambiar la marca del formulario, la lista de cursos se rehace con los de esa marca.
  document.addEventListener('change', e => {
    const f = e.target.closest?.('#pay-coupon-form');
    if (!f || e.target.name !== 'brandId') return;
    const sel = f.querySelector('[name="courseId"]');
    if (!sel) return;
    sel.innerHTML =
      '<option value="">Todos los cursos de la marca</option>' +
      state.courses
        .filter(k => k.brand_id === e.target.value)
        .map(k => '<option value="' + esc(k.id) + '">' + esc(k.title) + '</option>')
        .join('');
  });
  function html() {
    if (!data) return '<div class="loading-message">Cargando…</div>';
    const s = data.stats,
      tiles = [
        ['review', 'Comprobantes por revisar', s.review],
        ['pending', 'Pendientes de pago', s.pending],
        ['paid', 'Pagados', s.paid],
        ['all', 'Cobrado (práctica)', s.paidAmountLabel],
      ];
    return `${settingsBox()}${couponsBox()}<div class="ops-stats">${tiles.map(([id, t, v]) => `<button data-action="pay-filter" data-id="${id}" class="ops-stat ${filter === id ? 'active' : ''}"><strong>${esc(String(v))}</strong><span>${t}</span></button>`).join('')}</div><div class="crm-toolbar"><p>${filter === 'all' ? 'Todos los pedidos' : 'Filtro: ' + ({ review: 'comprobantes por revisar', pending: 'pendientes de pago', paid: 'pagados' }[filter] || filter)} · cobrado hoy ${esc(s.paidTodayLabel)}</p>${btn('preview', icon('eye') + ' Ver cómo paga el cliente')}${btn('reload', icon('refresh-cw') + ' Actualizar')}</div><div class="ops-queue">${data.orders.map(row).join('') || `<div class="crm-empty">${icon('credit-card')}<h3>Sin pedidos</h3><p>Genera uno desde el chat con «Cobrar» o deja que el motor lo haga cuando un cliente pida inscribirse.</p></div>`}</div>${note('Los importes salen del catálogo al crear el pedido y no cambian después. Un comprobante nunca se valida solo: lo acepta o rechaza una persona con acceso a la marca.')}`;
  }
  async function detail(id) {
    const d = await api('/api/payments/orders/' + id),
      o = d.order;
    showModal(
      'Pedido ' + o.reference,
      `<div class="ops-detail"><div class="ops-card-top">${chip(o.statusLabel, KIND[o.status])}${chip(o.amountLabel)}${o.couponCode ? chip('Cupón ' + o.couponCode + (o.couponBy === 'cliente' ? ' (lo aplicó el cliente)' : '')) : ''}${o.methodLabel ? chip(o.methodLabel) : ''}${o.kind === 'session' ? chip('Sesión ' + o.sessionNumber + (o.sessionTitle ? ' · ' + o.sessionTitle : '')) : o.plan === 'per_session' ? chip('Plan por sesión') : ''}</div><p>${esc(o.contactName)} · ${esc(o.courseTitle)} · ${esc(o.editionName)}${o.promotionName ? ' · ' + esc(o.promotionName) : ''}</p><p class="crm-hint">Enlace de pago: <code>${esc(o.link)}</code> · vence ${stamp(o.expires_at)}</p>
      ${d.receipts.length ? `<h3>Comprobantes</h3>${d.receipts.map(r => `<article class="pay-receipt"><div class="ops-card-top">${chip({ pending: 'Por revisar', accepted: 'Aceptado', rejected: 'Rechazado' }[r.status], r.status === 'pending' ? 'warn' : r.status === 'accepted' ? 'ok' : '')}<small>${stamp(r.created_at)}</small></div><a class="btn" href="${esc(r.attachmentUrl)}" target="_blank" rel="noopener">${icon(r.mime === 'application/pdf' ? 'file-text' : 'image')} ${esc(r.filename)}</a><ul class="ops-action-list">${r.prelecture.checks.map(c => `<li>${c.ok === true ? '✓' : c.ok === false ? '✕' : '·'} ${esc(c.name)}</li>`).join('')}</ul><p class="crm-hint">${esc(r.prelecture.note)}</p>${r.status !== 'pending' ? `<p class="crm-hint">${esc(r.reviewer_name || 'Equipo')}: ${esc(r.review_note || 'sin nota')}</p>` : `<form id="pay-accept-form" class="form-grid">${hidden('receiptId', r.id)}<label class="field">Nota (opcional)<input name="note" maxlength="500"></label><button type="submit" class="btn primary">Aceptar comprobante y confirmar pago</button></form><form id="pay-reject-form" class="form-grid">${hidden('receiptId', r.id)}<label class="field">Motivo para el cliente<input name="reason" required minlength="5" maxlength="500" placeholder="Importe distinto, comprobante ilegible…"></label><button type="submit" class="btn">Rechazar comprobante</button></form>`}</article>`).join('')}` : note('Sin comprobantes. El cliente puede pagar desde el enlace o enviar su comprobante por el chat.')}
      ${['pending', 'review'].includes(o.status) ? `<form id="pay-cancel-form" class="form-grid">${hidden('orderId', o.id)}<label class="field">Cancelar pedido · motivo<input name="reason" required minlength="5" maxlength="500"></label><button type="submit" class="btn">Cancelar pedido</button></form>` : ''}
      <h3>Historial</h3><div class="ops-notes">${d.events.map(e => `<article><strong>${esc(EVENT[e.kind] || e.kind)}</strong><small>${esc(e.actor_name || (e.kind === 'confirmed' && e.details.providerRef ? 'Proveedor simulado' : 'Sistema'))} · ${stamp(e.created_at)}</small>${e.details.reason || e.details.note ? `<p>${esc(e.details.reason || e.details.note)}</p>` : ''}</article>`).join('')}</div><div class="actions"><button type="button" class="btn" data-action="ops-chat" data-id="${o.conversation_id}">Abrir chat</button></div><div class="ops-feedback" role="status"></div></div>`,
    );
  }
  async function action(name, el) {
    const id = el.dataset.id;
    if (name === 'pay-reload') return 'reload';
    if (name === 'pay-preview') {
      const b = state.brands.find(x => x.id === brandId());
      showModal(
        'Así paga el cliente',
        window.simCheckout.html(
          {
            id: '00000000-0000-4000-8000-000000000000',
            brand: b?.name || 'Tu marca',
            course: 'Nombre del curso',
            edition: 'Edición general',
            amountLabel: '$1,990.00 MXN',
            reference: 'TC-EJEMPLO',
            expiresAt: Date.now() + 48 * 3600e3,
            kind: 'course',
            plan: 'full',
          },
          { esc, icon, preview: true },
        ),
      );
      return true;
    }
    if (name === 'pay-filter') {
      filter = id;
      return 'reload';
    }
    if (name === 'pay-coupon-new') {
      showModal('Nuevo cupón', couponForm());
      return true;
    }
    if (name === 'pay-coupon-edit') {
      const c = coupons.find(x => x.id === id);
      if (c) showModal('Editar cupón ' + c.code, couponForm(c));
      return true;
    }
    if (name === 'pay-coupon-status') {
      const c = coupons.find(x => x.id === id);
      if (!c) return true;
      if (
        el.dataset.status === 'archived' &&
        !confirm('¿Archivar el cupón ' + c.code + '? Ya no se podrá usar ni editar (lo ya cobrado no cambia).')
      )
        return true;
      await api('/api/coupons/' + id, {
        method: 'PATCH',
        body: { status: el.dataset.status, expectedRevision: c.revision },
      });
      toast(
        el.dataset.status === 'paused'
          ? 'Cupón pausado.'
          : el.dataset.status === 'active'
            ? 'Cupón activo.'
            : 'Cupón archivado.',
      );
      return 'reload';
    }
    if (name === 'pay-detail') {
      await detail(id);
      return true;
    }
    return false;
  }
  async function submit(form, input) {
    const id = form.getAttribute('id');
    if (id?.startsWith('pay-settings-')) {
      const fd = new FormData(form);
      await api('/api/payments/brands/' + form.dataset.brand, {
        method: 'PATCH',
        body: {
          enabled: fd.has('enabled'),
          linkHours: Number(input.linkHours),
          expectedRevision: Number(input.expectedRevision),
        },
      });
      toast('Venta con pago actualizada');
      return 'reload';
    }
    if (id === 'pay-coupon-form') {
      const at = v => (v ? new Date(v).getTime() : null),
        edit = Boolean(input.id),
        body = {
          name: input.name,
          courseId: input.courseId || null,
          startsAt: at(input.startsAt),
          endsAt: at(input.endsAt),
          maxUses: input.maxUses ? Number(input.maxUses) : null,
          perContact: Number(input.perContact),
          customerEntry: new FormData(form).has('customerEntry'),
        };
      if (edit) {
        await api('/api/coupons/' + input.id, {
          method: 'PATCH',
          body: { ...body, expectedRevision: Number(input.revision) },
        });
        toast('Cupón actualizado.');
      } else {
        const kind = input.kind,
          v = Number(input.value);
        await api('/api/coupons', {
          method: 'POST',
          body: {
            ...body,
            brandId: input.brandId,
            code: input.code,
            kind,
            value: kind === 'amount' ? Math.round(v * 100) : v,
          },
        });
        toast('Cupón creado.');
      }
      $('#modal').close();
      return 'reload';
    }
    if (id === 'pay-accept-form') {
      await api('/api/payments/receipts/' + input.receiptId + '/accept', {
        method: 'POST',
        body: { note: input.note },
      });
      $('#modal').close();
      toast('Pago confirmado: inscripción registrada y cliente avisado.');
      return 'reload';
    }
    if (id === 'pay-reject-form') {
      await api('/api/payments/receipts/' + input.receiptId + '/reject', {
        method: 'POST',
        body: { reason: input.reason },
      });
      $('#modal').close();
      toast('Comprobante rechazado; el cliente recibió el motivo.');
      return 'reload';
    }
    if (id === 'pay-cancel-form') {
      await api('/api/payments/orders/' + input.orderId + '/cancel', {
        method: 'POST',
        body: { reason: input.reason },
      });
      $('#modal').close();
      toast('Pedido cancelado.');
      return 'reload';
    }
    return false;
  }
  return { load, html, action, submit };
};
