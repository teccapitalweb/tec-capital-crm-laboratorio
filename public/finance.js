// Finanzas (pestaña de Operación): libro de ventas por eventos, cifras por periodo/marca/curso/vendedor/método,
// comisiones con regla configurable y liquidación, reembolsos, conciliación, acceso de contadora, CSV y vista imprimible.
window.createFinanceUI = function ({ state, api, esc, icon, showModal, toast }) {
  const $ = s => document.querySelector(s),
    admin = () => state.user?.role === 'admin';
  const stamp = t =>
    t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(t) : '—';
  const day = t => (t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(t) : '—');
  const chip = (label, kind = '') => `<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn = (action, label, id = '', extra = '') =>
    `<button type="button" class="btn" data-action="fin-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note = copy => `<p class="crm-hint">${copy}</p>`;
  const pct = bp => (bp / 100).toLocaleString('es-MX', { maximumFractionDigits: 2 }) + ' %';
  const ymd = d => d.toISOString().slice(0, 10);
  const today = new Date(),
    firstOfMonth = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1));
  let access = null,
    filter = { from: ymd(firstOfMonth), to: ymd(today), group: 'day' },
    data = null,
    ledger = null,
    commissions = null,
    section = 'summary',
    members = null;
  const qs = extra =>
    new URLSearchParams({ brand: state.brand, from: filter.from, to: filter.to, group: filter.group, ...extra });
  async function probe() {
    if (access === null) {
      try {
        access = await api('/api/finance/me');
      } catch {
        access = { allowed: false };
      }
    }
    return access.allowed;
  }
  async function load() {
    data = await api('/api/finance?' + qs());
    if (section === 'ledger') ledger = (await api('/api/finance/ledger?' + qs())).entries;
    if (section === 'commissions')
      commissions = await api(
        '/api/finance/commissions?' + new URLSearchParams({ brand: state.brand, status: commStatus }),
      );
    if (section === 'access' && admin()) members = (await api('/api/finance/access')).members;
  }
  let commStatus = 'accrued';
  const kpi = (label, value, sub = '') =>
    `<div class="an-kpi"><span>${label}</span><strong>${esc(value)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  const table = (cols, rows, empty) =>
    rows.length
      ? `<div class="fin-table-wrap"><table class="fin-table"><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td data-label="${cols[i]}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : note(empty);
  const bucketRows = list =>
    list.map(b => [
      esc(b.label),
      b.sales,
      esc(b.salesLabel),
      b.refunds ? esc(b.refundsLabel) : '—',
      `<strong>${esc(b.netLabel)}</strong>`,
    ]);
  const periodLabel = k => (filter.group === 'month' ? k : filter.group === 'week' ? 'Semana del ' + k : k);
  function controls() {
    return `<form id="fin-filter" class="an-controls"><label>Desde<input type="date" name="from" value="${esc(filter.from)}" required></label><label>Hasta<input type="date" name="to" value="${esc(filter.to)}" required></label><label>Agrupar<select name="group">${[
      ['day', 'Por día'],
      ['week', 'Por semana'],
      ['month', 'Por mes'],
    ]
      .map(([v, l]) => `<option value="${v}" ${filter.group === v ? 'selected' : ''}>${l}</option>`)
      .join('')}</select></label><button class="btn" type="submit">Aplicar</button>${[
      ['summary', 'Resumen'],
      ['ledger', 'Libro'],
      ['commissions', 'Comisiones'],
      ...(admin()
        ? [
            ['rules', 'Reglas'],
            ['access', 'Acceso'],
          ]
        : []),
    ]
      .map(
        ([id, l]) =>
          `<button type="button" class="btn ${section === id ? 'primary' : ''}" data-action="fin-section" data-id="${id}">${l}</button>`,
      )
      .join(
        '',
      )}<button type="button" class="btn" data-action="fin-print">${icon('printer')} Imprimir / PDF</button></form>`;
  }
  function summaryHtml() {
    const t = data.totals,
      c = data.commissions,
      r = data.reconciliation;
    return `<div class="an-kpis">${kpi('Ventas', t.salesLabel, t.sales + ' pagos')}${kpi('Reembolsos', t.refundsLabel, t.refunds + ' registrados')}${kpi('Neto', t.netLabel, 'ticket medio ' + t.avgTicketLabel)}${kpi('Comisiones devengadas', esc(c.consultora.accruedLabel), 'consultoras · vendedores ' + c.vendedor.accruedLabel)}</div>
      ${data.legacy && (data.legacy.sales || data.legacy.undated) ? `<section class="crm-panel fin-print-block"><div class="ops-card-top"><h2>Históricos IPCIL</h2>${chip('Fuera del libro · sin comisiones')}</div><p class="crm-hint">${data.legacy.sales} pagos históricos en el periodo por ${esc(new Intl.NumberFormat('es-MX', { style: 'currency', currency: data.currency || 'MXN' }).format(data.legacy.salesCents / 100))}${data.legacy.undated ? ' · ' + data.legacy.undated + ' sin fecha (no entran en ningún periodo)' : ''}${data.legacy.byBrand.length ? ' · ' + data.legacy.byBrand.map(b => esc(b.name) + ' ' + esc(new Intl.NumberFormat('es-MX', { style: 'currency', currency: data.currency || 'MXN' }).format(b.salesCents / 100))).join(' · ') : ''}. Importados desde el panel IPCIL (Operación → Históricos); no se concilian con pedidos.</p></section>` : ''}
      <section class="crm-panel fin-print-block"><div class="ops-card-top"><h2>Ingresos ${filter.group === 'month' ? 'por mes' : filter.group === 'week' ? 'por semana' : 'por día'}</h2>${r.ok ? chip('Conciliado con pedidos', 'good') : chip(r.mismatches.length + ' diferencias', 'urgent')}<small>${esc(data.period.fromDay)} a ${esc(data.period.toDay)} · ${esc(data.period.timezone)}</small></div>${table(['Periodo', 'Pagos', 'Ventas', 'Reembolsos', 'Neto'], bucketRows(data.byPeriod.map(b => ({ ...b, label: periodLabel(b.key) }))), 'Sin movimientos en el periodo.')}</section>
      <div class="an-grid"><section class="crm-panel fin-print-block"><h2>Por consultora (marca)</h2>${table(['Marca', 'Pagos', 'Ventas', 'Reembolsos', 'Neto'], bucketRows(data.byBrand), 'Sin ventas.')}</section><section class="crm-panel fin-print-block"><h2>Por vendedor</h2>${table(['Vendedor', 'Pagos', 'Ventas', 'Reembolsos', 'Neto'], bucketRows(data.bySeller), 'Sin ventas.')}</section></div>
      <div class="an-grid"><section class="crm-panel fin-print-block"><h2>Por curso</h2>${table(['Curso', 'Pagos', 'Ventas', 'Reembolsos', 'Neto'], bucketRows(data.byCourse), 'Sin ventas.')}</section><section class="crm-panel fin-print-block"><h2>Por método de pago</h2>${table(['Método', 'Pagos', 'Ventas', 'Reembolsos', 'Neto'], bucketRows(data.byMethod), 'Sin ventas.')}</section></div>
      <section class="crm-panel fin-print-block"><h2>Comisiones del periodo</h2>${table(
        ['Rol', 'Devengadas (sin pagar)', 'Pagadas', 'Pendientes en total'],
        Object.entries(data.roles).map(([role, label]) => [
          esc(label),
          esc(c[role].accruedLabel),
          esc(c[role].paidLabel),
          esc(
            new Intl.NumberFormat('es-MX', { style: 'currency', currency: data.currency }).format(
              (data.pendingCommissions[role] || 0) / 100,
            ),
          ),
        ]),
        '',
      )}${note('Devengadas y pagadas según la fecha de la venta del periodo; «pendientes en total» incluye todas las fechas.')}</section>
      <section class="crm-panel"><div class="ops-card-top"><h2>Conciliación</h2>${r.ok ? chip('Correcta', 'good') : chip('Revisar', 'urgent')}</div><p class="crm-hint">${r.paidOrders} pedidos pagados por ${esc(new Intl.NumberFormat('es-MX', { style: 'currency', currency: data.currency }).format(r.paidOrdersCents / 100))} frente a ${r.ledgerSales} líneas de venta por ${esc(data.totals.salesLabel)}.</p>${r.mismatches.length ? `<ul class="cn-list">${r.mismatches.map(m => `<li>${esc(m.kind)}: ${esc(m.reference || m.orderId)} · pedido ${(m.amountCents / 100).toFixed(2)} · libro ${(m.bookedCents / 100).toFixed(2)}</li>`).join('')}</ul>` : ''}</section>
      ${note(data.notes.map(esc).join(' '))}`;
  }
  function ledgerHtml() {
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Libro de ventas</h2><a class="btn" href="/api/finance/ledger.csv?${esc(qs().toString())}" download>${icon('download')} CSV</a>${admin() ? btn('refund', icon('undo-2') + ' Registrar reembolso') : ''}</div>${table(
      ['Fecha', 'Tipo', 'Marca · curso', 'Cliente · pedido', 'Vendedor', 'Método', 'Importe', 'Comisiones'],
      (ledger || []).map(e => [
        stamp(e.occurred_at),
        chip(e.kindLabel, e.kind === 'refund' ? 'urgent' : 'good'),
        esc(e.brand_name) +
          ' · ' +
          esc(e.course_title || '') +
          (e.edition_name ? ' <small>' + esc(e.edition_name) + '</small>' : ''),
        esc(e.contact_name || '') + ' <small>' + esc(e.reference || '') + '</small>',
        esc(e.seller_name || '—'),
        esc(e.methodLabel || '—'),
        `<strong>${esc(e.amountLabel)}</strong>`,
        e.commissions
          .map(
            c =>
              esc((c.role === 'consultora' ? 'Consultora ' : 'Vendedor ') + c.amountLabel) +
              (c.status === 'paid' ? ' ✓' : ''),
          )
          .join('<br>') || '—',
      ]),
      'Sin movimientos en el periodo.',
    )}${(ledger || []).some(e => e.note) ? note('Las notas de reembolso aparecen en el CSV.') : ''}</section>`;
  }
  function commissionsHtml() {
    const d = commissions;
    if (!d) return '';
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Comisiones</h2>${[
      ['accrued', 'Devengadas'],
      ['paid', 'Pagadas'],
    ]
      .map(
        ([v, l]) =>
          `<button type="button" class="btn ${commStatus === v ? 'primary' : ''}" data-action="fin-comm-status" data-id="${v}">${l}</button>`,
      )
      .join(
        '',
      )}<a class="btn" href="/api/finance/commissions.csv?${esc(new URLSearchParams({ brand: state.brand, status: commStatus }).toString())}" download>${icon('download')} CSV</a>${admin() ? btn('recompute', 'Devengar pendientes') : ''}</div>
      ${
        d.groups.length
          ? `<div class="co-list">${d.groups
              .map(
                g =>
                  `<div class="co-row"><div><strong>${esc(g.roleLabel)} · ${esc(g.user_name || g.brand_name)}</strong><small>${esc(g.brand_name)} · ${g.entries} ${g.entries === 1 ? 'línea' : 'líneas'}</small></div><div><strong>${esc(g.totalLabel)}</strong><small>${g.items
                    .slice(0, 3)
                    .map(i => esc((i.reference || '') + ' ' + i.amountLabel))
                    .join(
                      ' · ',
                    )}${g.items.length > 3 ? ' · …' : ''}</small></div><div class="actions">${btn('comm-detail', 'Detalle', g.key)}${commStatus === 'accrued' && data.access.canMarkPaid && g.totalCents > 0 ? btn('payout', 'Marcar pagadas', g.key) : ''}</div></div>`,
              )
              .join('')}</div>`
          : note(
              commStatus === 'accrued'
                ? 'No hay comisiones devengadas. Fija una regla en «Reglas» y pulsa «Devengar pendientes» para las ventas ya registradas.'
                : 'Todavía no se ha liquidado ninguna comisión.',
            )
      }
      ${
        d.payouts.length
          ? `<h3>Liquidaciones</h3>${table(
              ['Fecha', 'Rol', 'Beneficiario', 'Líneas', 'Total', 'Pagó', 'Nota'],
              d.payouts.map(p => [
                stamp(p.paid_at),
                esc(p.roleLabel),
                esc(p.user_name || p.brand_name),
                p.entries,
                `<strong>${esc(p.totalLabel)}</strong>`,
                esc(p.paid_by_name || ''),
                esc(p.note || ''),
              ]),
              '',
            )}`
          : ''
      }</section>`;
  }
  function rulesHtml() {
    const rules = data.rules,
      brands = [{ id: '', name: 'Regla de la empresa (por omisión)' }, ...state.brands];
    const current = (b, role) => rules.find(r => (r.brand_id || '') === b && r.role === role);
    return `<section class="crm-panel"><h2>Reglas de comisión</h2>${note('Una regla por rol: porcentaje sobre el importe pagado más una cuota fija por venta. La regla de la marca manda sobre la de la empresa. Cambiar una regla no toca las comisiones ya devengadas; «Devengar pendientes» aplica la regla vigente a las ventas sin comisión. Es una regla por omisión documentada hasta que dirección confirme la definitiva.')}${brands
      .map(
        b =>
          `<h3>${esc(b.name)}</h3><div class="fin-rules">${Object.entries(data.roles)
            .map(([role, label]) => {
              const r = current(b.id, role);
              return `<form id="fin-rule-${esc(b.id || 'empresa')}-${role}" class="co-inline fin-rule"><input type="hidden" name="brandId" value="${esc(b.id)}"><input type="hidden" name="role" value="${role}"><input type="hidden" name="expectedRevision" value="${r?.revision || 0}"><strong>${esc(label)}</strong><label class="field">Porcentaje<input name="percent" type="number" min="0" max="100" step="0.01" value="${r ? r.percent_bp / 100 : ''}" placeholder="${b.id ? 'hereda' : '0'}"></label><label class="field">Cuota fija (${esc(data.currency)})<input name="fixed" type="number" min="0" step="0.01" value="${r ? r.fixed_cents / 100 : ''}" placeholder="0"></label><button class="btn" type="submit">Guardar</button>${r ? `<small>v${r.revision} · ${esc(r.updated_by_name || '')} · ${stamp(r.updated_at)}</small>` : '<small>Sin regla</small>'}</form>`;
            })
            .join('')}</div>`,
      )
      .join('')}</section>`;
  }
  function accessHtml() {
    return `<section class="crm-panel"><h2>Función de contadora</h2>${note('Administración siempre ve Finanzas. Aquí se concede a personas del equipo la lectura de todas las marcas (libro, comisiones, CSV) y, si se marca, el permiso de registrar comisiones como pagadas. Es una función de empresa, distinta del acceso por marca.')}<div class="co-list">${(members || []).map(m => `<div class="co-row"><div><strong>${esc(m.name)}</strong><small>@${esc(m.username)} · ${m.role === 'admin' ? 'administración' : 'asesoría'}${m.disabled ? ' · suspendida' : ''}</small></div><div>${m.finance ? chip(m.role === 'admin' ? 'Acceso completo' : 'Contadora', 'good') : chip('Sin acceso')}${m.finance && m.role !== 'admin' ? (m.can_mark_paid ? chip('Marca pagadas') : chip('Sólo lectura')) : ''}${m.granted_at ? `<small>${esc(m.granted_by_name || '')} · ${stamp(m.granted_at)}</small>` : ''}</div><div class="actions">${m.role === 'admin' ? '' : `${btn('access', m.finance ? 'Quitar acceso' : 'Dar lectura', m.id, `data-enabled="${m.finance ? 0 : 1}" data-paid="0"`)}${m.finance ? btn('access', m.can_mark_paid ? 'Quitar marcar pagadas' : 'Permitir marcar pagadas', m.id, `data-enabled="1" data-paid="${m.can_mark_paid ? 0 : 1}"`) : ''}`}</div></div>`).join('')}</div></section>`;
  }
  function html() {
    if (!data) return '<div class="loading-message">Cargando…</div>';
    const body =
      section === 'ledger'
        ? ledgerHtml()
        : section === 'commissions'
          ? commissionsHtml()
          : section === 'rules' && admin()
            ? rulesHtml()
            : section === 'access' && admin()
              ? accessHtml()
              : summaryHtml();
    return `<div class="fin-page"><div class="crm-toolbar"><p>Libro de ventas alimentado por eventos del laboratorio: cada pago confirmado entra una vez; los reembolsos los registra administración. Comisiones a consultoras y vendedores con una regla configurable, liquidación y exportación.</p></div>${controls()}<div class="fin-print-head"><h2>TEC Capital · Finanzas del laboratorio</h2><p>${esc(data.period.fromDay)} a ${esc(data.period.toDay)} · ${esc(data.scope.brand ? data.scope.brands[0].name : 'Todas las marcas')} · generado ${stamp(Date.now())}</p></div>${body}</div>`;
  }
  async function action(name, el) {
    const id = el.dataset.id;
    try {
      if (name === 'fin-section') {
        section = id;
        return 'reload';
      }
      if (name === 'fin-comm-status') {
        commStatus = id;
        return 'reload';
      }
      if (name === 'fin-print') {
        window.print();
        return true;
      }
      if (name === 'fin-recompute') {
        const r = await api('/api/finance/commissions/recompute', { method: 'POST', body: {} });
        toast(r.accrued ? r.accrued + ' comisiones devengadas.' : 'No había comisiones pendientes de devengar.');
        return 'reload';
      }
      if (name === 'fin-access') {
        await api('/api/finance/access', {
          method: 'PUT',
          body: { userId: id, enabled: el.dataset.enabled === '1', canMarkPaid: el.dataset.paid === '1' },
        });
        toast('Acceso a Finanzas actualizado.');
        return 'reload';
      }
      if (name === 'fin-comm-detail') {
        const g = commissions.groups.find(x => x.key === id);
        showModal(
          'Comisiones · ' + esc(g.roleLabel) + ' · ' + esc(g.user_name || g.brand_name),
          table(
            ['Venta', 'Pedido', 'Curso', 'Base', 'Regla', 'Comisión'],
            g.items.map(i => [
              day(i.occurred_at),
              esc(i.reference || ''),
              esc(i.course_title || ''),
              (i.base_cents / 100).toFixed(2),
              pct(i.percent_bp) + (i.fixed_cents ? ' + ' + (i.fixed_cents / 100).toFixed(2) : ''),
              `<strong>${esc(i.amountLabel)}</strong>`,
            ]),
            '',
          ),
        );
        return true;
      }
      if (name === 'fin-payout') {
        const g = commissions.groups.find(x => x.key === id);
        showModal(
          'Marcar comisiones pagadas',
          `<form id="fin-payout-form" class="form-grid"><input type="hidden" name="role" value="${g.role}"><input type="hidden" name="brandId" value="${esc(g.brand_id)}"><input type="hidden" name="userId" value="${esc(g.user_id || '')}"><p>${esc(g.roleLabel)} · ${esc(g.user_name || g.brand_name)} · ${g.entries} líneas · <strong>${esc(g.totalLabel)}</strong></p>${note('Registra que la comisión se pagó fuera del sistema (transferencia, nómina). Las líneas quedan marcadas y salen de «devengadas». No se mueve dinero.')}<label class="field">Nota (referencia del pago)<input name="note" maxlength="300" placeholder="Transferencia 12345"></label><div class="actions"><button class="btn primary" type="submit">Marcar como pagadas</button></div><div class="ops-feedback" role="status"></div></form>`,
        );
        return true;
      }
      if (name === 'fin-refund') {
        showModal(
          'Registrar reembolso',
          `<form id="fin-refund-form" class="form-grid">${note('Sólo registra el reembolso en el libro y ajusta las comisiones; el dinero se devuelve fuera del sistema y la inscripción se da de baja desde Coordinación si corresponde.')}<label class="field">Pedido (referencia TC-…)<input name="orderId" required maxlength="60" placeholder="TC-A1B2C3"></label><label class="field">Importe a reembolsar (${esc(data.currency)})<input name="amount" type="number" min="0.01" step="0.01" required></label><label class="field">Motivo<textarea name="reason" required minlength="5" maxlength="500" rows="2"></textarea></label><div class="actions"><button class="btn primary" type="submit">Registrar reembolso</button></div><div class="ops-feedback" role="status"></div></form>`,
        );
        return true;
      }
    } catch (e) {
      toast(e.message);
      return true;
    }
    return false;
  }
  async function submit(form, input) {
    const id = form.getAttribute('id'),
      feedback = msg => {
        const f = form.querySelector('.ops-feedback');
        if (f) f.textContent = msg;
      };
    try {
      if (id === 'fin-filter') {
        filter = { from: input.from, to: input.to, group: input.group };
        return 'reload';
      }
      if (id?.startsWith('fin-rule-')) {
        const percentBp = input.percent === '' ? 0 : Math.round(Number(input.percent) * 100),
          fixedCents = input.fixed === '' ? 0 : Math.round(Number(input.fixed) * 100);
        await api('/api/finance/rules', {
          method: 'PUT',
          body: {
            brandId: input.brandId || null,
            role: input.role,
            percentBp,
            fixedCents,
            expectedRevision: Number(input.expectedRevision),
          },
        });
        toast('Regla guardada. Usa «Devengar pendientes» en Comisiones para aplicarla a ventas anteriores.');
        return 'reload';
      }
      if (id === 'fin-payout-form') {
        const r = await api('/api/finance/payouts', {
          method: 'POST',
          body: { role: input.role, brandId: input.brandId, userId: input.userId || null, note: input.note },
        });
        $('#modal').close();
        toast('Liquidación registrada: ' + r.payout.totalLabel + '.');
        return 'reload';
      }
      if (id === 'fin-refund-form') {
        await api('/api/finance/refunds', {
          method: 'POST',
          body: { orderId: input.orderId, amountCents: Math.round(Number(input.amount) * 100), reason: input.reason },
        });
        $('#modal').close();
        toast('Reembolso registrado en el libro.');
        section = 'ledger';
        return 'reload';
      }
    } catch (e) {
      feedback(e.message);
      toast(e.message);
      return true;
    }
    return false;
  }
  return { probe, load, html, action, submit };
};
