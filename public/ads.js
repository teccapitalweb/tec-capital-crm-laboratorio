// Pauta (docs/PLAN_PAUTA.md): el panel de tráfico de IPCIL dentro del CRM. Cuatro vistas: Campañas (el diagnóstico de cada lanzamiento y
// la cola de acciones atendidas), Captura diaria (acumulado de pauta y mensajes de Meta), Decisiones del gerente y Reporte; y, para
// administración, el acceso de las personas con la función de trafiquer. Todo se calcula en el servidor; aquí sólo se muestra.
window.createAdsUI = function ({ state, api, esc, icon, showModal, toast }) {
  const $ = s => document.querySelector(s),
    admin = () => state.user?.role === 'admin';
  const TABS = [
    ['campaigns', 'Campañas'],
    ['capture', 'Captura diaria'],
    ['decisions', 'Decisiones del gerente'],
    ['report', 'Reporte'],
  ];
  let allowed = null,
    sub = 'campaigns',
    filter = 'all',
    data = {},
    day = '';
  const money = c =>
    c === null || c === undefined
      ? '—'
      : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(
          c / 100,
        );
  const short = k =>
    k
      ? new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
          Date.parse(k + 'T00:00:00Z'),
        )
      : '—';
  const chip = (label, kind = '') => `<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const brandParam = () => (state.brand === 'all' ? '' : '?brand=' + encodeURIComponent(state.brand));
  const KIND = { escalar: 'good', ok: 'good', subir: 'high', hoy: 'urgent', nova: 'urgent', espera: '' };
  const NOTE = { pauta: 'Pauta', ads: 'Anuncio', ventas: 'Ventas', info: 'Comparación' };

  async function probe() {
    if (allowed === null) {
      try {
        allowed = (await api('/api/ads/me')).allowed;
      } catch {
        allowed = false;
      }
    }
    return allowed;
  }
  async function load() {
    const q = brandParam();
    if (sub === 'campaigns') data.overview = await api('/api/ads/overview' + q);
    if (sub === 'capture')
      data.capture = await api('/api/ads/capture' + (q ? q + '&' : '?') + 'day=' + encodeURIComponent(day || ''));
    if (sub === 'decisions') {
      data.decisions = await api('/api/ads/decisions' + q);
    }
    if (sub === 'report') data.report = await api('/api/ads/report' + q);
    if (sub === 'access' && admin()) data.access = await api('/api/ads/access');
  }

  // ---- Campañas
  function verdictCard(v) {
    const left =
      v.daysLeft === 0
        ? 'abre hoy'
        : `abre el ${short(v.startKey)} · faltan ${v.daysLeft} día${v.daysLeft === 1 ? '' : 's'}`;
    return `<article class="ads-card ${v.done ? 'done' : ''}"><div class="ops-card-top">${chip(v.title, KIND[v.type])}${v.done ? chip('Atendida', 'good') : ''}</div>
      <h3>${esc(v.course)} · ${esc(v.edition)}</h3><small>${esc(v.brandName)} · ${esc(left)} · lanzada el ${esc(short(v.launchKey))}</small>
      <div class="ads-kpis"><span><b>${v.students}</b> de ${v.min} alumnos${v.projected > v.students ? ` · proyecta ${v.projected}` : ''}</span><span>Pauta <b>${money(v.spendCents)}</b></span><span>Mensajes <b>${v.messages}</b></span><span>CPL <b>${money(v.cplCents)}</b></span><span class="${v.capturedToday ? 'ok' : v.lastCaptureDay ? '' : 'bad'}">${v.capturedToday ? 'Capturada hoy ✓' : v.lastCaptureDay ? 'Última captura ' + esc(short(v.lastCaptureDay)) : 'Sin captura'}</span></div>
      <p class="ads-action">${esc(v.action)}</p>
      ${v.notes
        .filter(n => n.kind !== 'info')
        .map(n => `<p class="ads-note ${esc(n.kind)}"><b>${esc(NOTE[n.kind] || '')}:</b> ${esc(n.text)}</p>`)
        .join('')}
      ${v.notes
        .filter(n => n.kind === 'info')
        .map(n => `<p class="ads-note info">${esc(n.text)}</p>`)
        .join('')}
      ${v.relaunchText ? `<p class="ads-note relaunch">${esc(v.relaunchText)}</p>` : ''}
      ${v.done ? `<p class="ads-done">${icon('check')} ${esc(v.done.by || 'Alguien')} lo atendió${v.done.note ? ': «' + esc(v.done.note) + '»' : ''}</p>` : ''}
      <div class="actions">${v.done ? `<button type="button" class="btn" data-action="ads-undone" data-id="${esc(v.editionId)}">Desmarcar</button>` : `<button type="button" class="btn primary" data-action="ads-done" data-id="${esc(v.editionId)}" data-title="${esc(v.course + ' · ' + v.edition)}">${icon('check')} Marcar atendida</button>`}${admin() ? `<button type="button" class="btn" data-action="ads-decision-new" data-id="${esc(v.editionId)}">Registrar decisión</button>` : ''}</div></article>`;
  }
  function campaignsHtml() {
    const o = data.overview;
    if (!o) return '<div class="loading-message">Cargando…</div>';
    const types = Object.entries(o.kinds).sort((a, b) => a[1].order - b[1].order);
    const rows = o.verdicts.filter(v => filter === 'all' || v.type === filter);
    return `<div class="ads-chips" role="group" aria-label="Filtrar por veredicto"><button type="button" data-action="ads-filter" data-id="all" class="${filter === 'all' ? 'active' : ''}">Todas <span>${o.verdicts.length}</span></button>${types.map(([k, t]) => `<button type="button" data-action="ads-filter" data-id="${k}" class="${filter === k ? 'active' : ''}">${esc(t.title)} <span>${o.verdicts.filter(v => v.type === k).length}</span></button>`).join('')}</div>
      ${rows.length ? `<div class="ads-grid">${rows.map(verdictCard).join('')}</div>` : `<div class="crm-empty">${icon('megaphone')}<h3>${o.verdicts.length ? 'Nada con ese filtro' : 'Sin lanzamientos en venta'}</h3><p>${o.verdicts.length ? 'Prueba con otro veredicto.' : 'Aquí aparecen las ediciones publicadas que todavía no empiezan, con su diagnóstico.'}</p></div>`}`;
  }

  // ---- Captura diaria
  function captureHtml() {
    const c = data.capture;
    if (!c) return '<div class="loading-message">Cargando…</div>';
    return `<div class="info-box">Copia de Meta el <strong>total acumulado</strong> de pauta y mensajes de cada campaña, no lo del día. Lo que ya está guardado de ese día se puede corregir. <label class="ads-day">Día <input type="date" id="ads-day" value="${esc(c.day)}" max="${esc(c.today)}"></label></div>
      ${
        c.rows.length
          ? `<div class="ads-sheet-wrap"><table class="ads-sheet"><thead><tr><th>Curso · edición</th><th>Abre</th><th>Lanzada</th><th>Alumnos</th><th>Conversaciones</th><th class="num">Pauta total ($)</th><th class="num">Mensajes</th><th class="num">CPL</th><th>Captura anterior</th></tr></thead><tbody>${c.rows
              .map(
                r => `<tr data-ads-row="${esc(r.editionId)}">
        <td><strong>${esc(r.course)}</strong><small>${esc(r.edition)} · ${esc(r.brandName)}</small></td><td>${esc(short(r.startKey))}</td>
        <td><input type="date" data-ads-field="launched" value="${esc(r.launchKey)}" max="${esc(c.today)}" aria-label="Fecha de lanzamiento"></td>
        <td>${r.enrolled}/${r.min}</td><td title="Conversaciones del CRM de esta edición (las que llegaron por anuncio)">${r.crmConversations}${r.crmFromAds ? ` (${r.crmFromAds})` : ''}</td>
        <td class="num"><input type="number" min="0" step="1" inputmode="numeric" data-ads-field="spend" placeholder="${r.prev ? Math.round(r.prev.spendCents / 100) : 0}" value="${r.spendCents === null ? '' : r.spendCents / 100}" aria-label="Pauta total en pesos"></td>
        <td class="num"><input type="number" min="0" step="1" inputmode="numeric" data-ads-field="messages" placeholder="${r.prev ? r.prev.messages : 0}" value="${r.messages === null ? '' : r.messages}" aria-label="Mensajes totales"></td>
        <td class="num" data-ads-cpl>${r.spendCents !== null && r.messages ? money(Math.round(r.spendCents / r.messages)) : '—'}</td>
        <td data-ads-prev="${esc(JSON.stringify(r.prev || null))}">${r.prev ? `${esc(short(r.prev.day))}: <b>${money(r.prev.spendCents)}</b> · ${r.prev.messages} msj` : '<span class="muted">primera captura</span>'}<span class="ads-warn" hidden>↓ menor que antes: ¿seguro?</span></td></tr>`,
              )
              .join('')}</tbody></table></div>
        <div class="actions"><button type="button" class="btn primary" data-action="ads-save">${icon('save')} Guardar captura</button></div>`
          : `<div class="crm-empty">${icon('megaphone')}<h3>Sin lanzamientos en venta</h3><p>No hay ediciones publicadas por empezar en tus marcas.</p></div>`
      }`;
  }
  async function save() {
    const rows = [...document.querySelectorAll('[data-ads-row]')]
      .map(tr => {
        const g = f => tr.querySelector(`[data-ads-field=${f}]`)?.value;
        const spend = g('spend'),
          messages = g('messages');
        if (spend === '' && messages === '') return null;
        return {
          editionId: tr.dataset.adsRow,
          spend: spend === '' ? 0 : Number(spend),
          messages: messages === '' ? 0 : Number(messages),
          launchedOn: g('launched') || undefined,
        };
      })
      .filter(Boolean);
    if (!rows.length) {
      toast('Escribe la pauta y los mensajes de al menos una campaña.');
      return;
    }
    const r = await api('/api/ads/capture' + brandParam(), {
      method: 'PUT',
      body: { day: $('#ads-day')?.value || day, rows },
    });
    data.capture = { day: r.day, today: r.today, rows: r.rows };
    toast(r.saved + (r.saved === 1 ? ' campaña guardada.' : ' campañas guardadas.'));
    return 'draw';
  }
  document.addEventListener('input', e => {
    const f = e.target.dataset?.adsField;
    if (!f || f === 'launched') return;
    const tr = e.target.closest('[data-ads-row]');
    if (!tr) return;
    const spend = tr.querySelector('[data-ads-field=spend]').value,
      msg = tr.querySelector('[data-ads-field=messages]').value;
    tr.querySelector('[data-ads-cpl]').textContent =
      spend !== '' && Number(msg) > 0 ? money(Math.round((Number(spend) * 100) / Number(msg))) : '—';
    let prev = null;
    try {
      prev = JSON.parse(tr.querySelector('[data-ads-prev]').dataset.adsPrev);
    } catch {}
    const warn = tr.querySelector('.ads-warn');
    if (warn)
      warn.hidden = !(
        prev &&
        ((spend !== '' && Number(spend) * 100 < prev.spendCents) || (msg !== '' && Number(msg) < prev.messages))
      );
  });
  // ---- Decisiones del gerente
  function decisionCard(d) {
    const k = d.kpis || {};
    const detail = [
      d.budgetCents !== null ? `Nuevo presupuesto: <b>${esc(money(d.budgetCents))}/día</b>` : '',
      d.newDate ? `Nueva fecha: <b>${esc(short(d.newDate))}</b> (actualiza la fecha en la pauta)` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `<article class="ads-card ${d.status === 'applied' ? 'done' : ''}"><div class="ops-card-top">${chip(d.status === 'pending' ? 'Pendiente' : d.status === 'applied' ? 'Aplicada' : 'Cancelada', d.status === 'pending' ? 'high' : d.status === 'applied' ? 'good' : '')}<strong>${esc(d.typeLabel)}</strong></div>
      <h3>${esc(d.course)} · ${esc(d.edition)}</h3><small>${esc(d.brand)}${d.startKey ? ' · abre el ' + esc(short(d.startKey)) : ''} · pedida por ${esc(d.createdBy || 'gerente')} el ${esc(new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(d.createdAt))}</small>
      ${detail ? `<p class="ads-action">${detail}</p>` : ''}${k.spendCents !== undefined ? `<div class="ads-kpis"><span>Al momento: día <b>${k.day ?? '—'}</b></span><span>pauta <b>${money(k.spendCents)}</b></span><span>mensajes <b>${k.messages ?? 0}</b></span><span>CPL <b>${money(k.cplCents)}</b></span><span><b>${k.students ?? 0}</b> de ${k.min ?? '—'} alumnos</span></div>` : ''}
      ${d.reason ? `<p class="ads-note info">«${esc(d.reason)}»</p>` : ''}
      ${d.status === 'applied' ? `<p class="ads-done">${icon('check')} ${esc(d.appliedBy || 'Alguien')} la aplicó${d.appliedNote ? ': «' + esc(d.appliedNote) + '»' : ''}</p>` : ''}
      ${d.status === 'pending' ? `<div class="actions"><button type="button" class="btn primary" data-action="ads-apply" data-id="${esc(d.id)}">${icon('check')} Marcar aplicada</button>${admin() ? `<button type="button" class="btn" data-action="ads-cancel" data-id="${esc(d.id)}">Cancelar</button>` : ''}</div>` : ''}</article>`;
  }
  function decisionsHtml() {
    const d = data.decisions;
    if (!d) return '<div class="loading-message">Cargando…</div>';
    const pending = d.decisions.filter(x => x.status === 'pending'),
      rest = d.decisions.filter(x => x.status !== 'pending').slice(0, 10);
    return `<div class="crm-toolbar"><p>Lo que el gerente decidió y quien lleva la pauta debe aplicar en Meta. ${pending.length ? '<strong>' + pending.length + ' pendiente' + (pending.length === 1 ? '' : 's') + '.</strong>' : 'Sin pendientes.'}</p>${admin() ? `<button type="button" class="btn primary" data-action="ads-decision-new">${icon('plus')} Nueva decisión</button>` : ''}</div>
      ${pending.length ? `<div class="ads-grid">${pending.map(decisionCard).join('')}</div>` : `<div class="crm-empty">${icon('check')}<h3>Sin pendientes</h3><p>Cuando el gerente tome una decisión, aparece aquí y llega un aviso.</p></div>`}
      ${rest.length ? `<h3 class="rcp-subtitle">Últimas</h3><div class="ads-grid">${rest.map(decisionCard).join('')}</div>` : ''}`;
  }
  async function decisionForm(editionId = '') {
    const ov = data.overview || (await api('/api/ads/overview' + brandParam()));
    data.overview = ov;
    const types = (await api('/api/ads/decisions' + brandParam())).types;
    showModal(
      'Registrar decisión del gerente',
      `<form id="ads-decision-form" class="form-grid">
      <label class="field">Lanzamiento<select name="editionId" required>${ov.verdicts.map(v => `<option value="${esc(v.editionId)}" ${v.editionId === editionId ? 'selected' : ''}>${esc(v.course + ' · ' + v.edition + ' · ' + v.brandName)}</option>`).join('')}</select></label>
      <label class="field">Decisión<select name="type" required>${Object.entries(types)
        .map(([k, t]) => `<option value="${esc(k)}">${esc(t)}</option>`)
        .join('')}</select></label>
      <label class="field">Presupuesto por día (opcional, en pesos)<input name="budget" type="number" min="0" step="1" inputmode="numeric" placeholder="800"></label>
      <label class="field">Nueva fecha de apertura (sólo si se pospone)<input name="newDate" type="date"></label>
      <label class="field">Motivo<textarea name="reason" rows="3" maxlength="300" placeholder="Por qué se decide"></textarea></label>
      <div class="actions"><button class="btn primary" type="submit">Enviar a quien lleva la pauta</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
  }
  function noteForm(id, formId, title, label, hint, extra = '') {
    showModal(
      title,
      `<form id="${formId}" class="form-grid"><input type="hidden" name="id" value="${esc(id)}">${extra}<label class="field">${label}<input name="note" maxlength="140" placeholder="${esc(hint)}"></label><div class="actions"><button class="btn primary" type="submit">Guardar</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
  }

  // ---- Reporte
  function reportHtml() {
    const r = data.report;
    if (!r) return '<div class="loading-message">Cargando…</div>';
    const byBrand = [...new Set(r.rows.map(x => x.brand))];
    return `<div class="ads-chips">${chip(money(r.totals.spendCents) + ' de pauta')}${chip(r.totals.messages + ' mensajes')}${chip(r.totals.enrolled + ' alumnos')}${r.totals.messages ? chip('CPL ' + money(Math.round(r.totals.spendCents / r.totals.messages))) : ''}${r.totals.enrolled && r.totals.spendCents ? chip('Costo por alumno ' + money(Math.round(r.totals.spendCents / r.totals.enrolled))) : ''}</div>
      ${
        byBrand
          .map(
            b =>
              `<section class="crm-panel"><h2>${esc(b)}</h2><div class="ads-sheet-wrap"><table class="ads-sheet"><thead><tr><th>Curso · edición</th><th>Abre</th><th>Estado</th><th class="num">Pauta</th><th class="num">Mensajes</th><th class="num">CPL</th><th>Llenado</th><th class="num">Por alumno</th><th>Última captura</th></tr></thead><tbody>${r.rows
                .filter(x => x.brand === b)
                .map(
                  x =>
                    `<tr><td><strong>${esc(x.course)}</strong><small>${esc(x.edition)}</small></td><td>${esc(short(x.startKey))}</td><td>${chip(x.closed ? 'Cerrada' : 'En venta', x.closed ? '' : 'good')}</td><td class="num">${money(x.spendCents)}</td><td class="num">${x.messages}</td><td class="num"><b>${money(x.cplCents)}</b></td><td>${x.enrolled}/${x.min}${!x.enrolled && x.spendCents ? ' <span class="bad">sin ventas</span>' : ''}</td><td class="num">${money(x.cacCents)}</td><td>${esc(short(x.lastCaptureDay))}</td></tr>`,
                )
                .join('')}</tbody></table></div></section>`,
          )
          .join('') ||
        `<div class="crm-empty">${icon('megaphone')}<h3>Sin datos</h3><p>Todavía no hay lanzamientos con captura.</p></div>`
      }`;
  }

  // ---- Acceso (administración)
  function accessHtml() {
    const a = data.access;
    if (!a) return '<div class="loading-message">Cargando…</div>';
    return `<section class="crm-panel"><h2>Quién lleva la pauta</h2><p class="crm-hint">Administración siempre tiene acceso. Las personas del equipo con esta función ven y capturan la pauta de las marcas que ya tienen asignadas.</p><div class="ads-access">${a.members.map(m => `<div class="ads-access-row"><div><strong>${esc(m.name)}</strong><small>@${esc(m.username)} · ${m.admin ? 'Administración' : 'Equipo'}${m.disabled ? ' · desactivado' : ''}</small></div>${m.admin ? chip('Siempre') : `<button type="button" class="btn ${m.enabled ? '' : 'primary'}" data-action="ads-access" data-id="${esc(m.id)}" data-on="${m.enabled ? '0' : '1'}">${m.enabled ? 'Quitar función' : 'Dar función de trafiquer'}</button>`}</div>`).join('')}</div></section>`;
  }

  function html() {
    const tabs = [...TABS, ...(admin() ? [['access', 'Quién lleva la pauta']] : [])];
    const body =
      sub === 'campaigns'
        ? campaignsHtml()
        : sub === 'capture'
          ? captureHtml()
          : sub === 'decisions'
            ? decisionsHtml()
            : sub === 'report'
              ? reportHtml()
              : accessHtml();
    const pend = data.overview?.pendingDecisions || 0;
    return `<div class="ads-tabs" role="tablist">${tabs.map(([id, t]) => `<button type="button" role="tab" aria-selected="${sub === id}" data-action="ads-sub" data-id="${id}" class="${sub === id ? 'active' : ''}">${esc(t)}${id === 'decisions' && pend ? ` <span class="ops-counter">${pend}</span>` : ''}</button>`).join('')}</div>${body}`;
  }
  async function action(name, el) {
    if (name === 'ads-sub') {
      sub = el.dataset.id;
      filter = 'all';
      return 'reload';
    }
    if (name === 'ads-filter') {
      filter = el.dataset.id;
      return 'draw';
    }
    if (name === 'ads-save') {
      return await save();
    }
    if (name === 'ads-done') {
      noteForm(
        el.dataset.id,
        'ads-done-form',
        'Marcar como atendida',
        '¿Qué hiciste? (opcional)',
        'Ej: subí el presupuesto a $500 por día',
      );
      return true;
    }
    if (name === 'ads-undone') {
      await api('/api/ads/actions/' + el.dataset.id, { method: 'DELETE' });
      toast('Desmarcada.');
      return 'reload';
    }
    if (name === 'ads-decision-new') {
      await decisionForm(el.dataset.id || '');
      return true;
    }
    if (name === 'ads-apply') {
      noteForm(
        el.dataset.id,
        'ads-apply-form',
        'Marcar decisión aplicada',
        '¿Qué hiciste? (opcional)',
        'Ej: presupuesto a $800/día en Meta',
      );
      return true;
    }
    if (name === 'ads-cancel') {
      noteForm(el.dataset.id, 'ads-cancel-form', 'Cancelar decisión', 'Motivo (opcional)', 'Ej: ya se resolvió');
      return true;
    }
    if (name === 'ads-access') {
      await api('/api/ads/access', { method: 'PUT', body: { userId: el.dataset.id, enabled: el.dataset.on === '1' } });
      toast(el.dataset.on === '1' ? 'Función concedida.' : 'Función retirada.');
      return 'reload';
    }
    return false;
  }
  async function submit(form) {
    const id = form.getAttribute('id'),
      f = new FormData(form),
      feedback = m => {
        const x = form.querySelector('.ops-feedback');
        if (x) x.textContent = m;
      };
    try {
      if (id === 'ads-done-form')
        await api('/api/ads/actions', { method: 'POST', body: { editionId: f.get('id'), note: f.get('note') } });
      else if (id === 'ads-apply-form')
        await api('/api/ads/decisions/' + f.get('id') + '/apply', { method: 'POST', body: { note: f.get('note') } });
      else if (id === 'ads-cancel-form')
        await api('/api/ads/decisions/' + f.get('id') + '/cancel', { method: 'POST', body: { note: f.get('note') } });
      else if (id === 'ads-decision-form')
        await api('/api/ads/decisions', {
          method: 'POST',
          body: {
            editionId: f.get('editionId'),
            type: f.get('type'),
            budget: f.get('budget') || undefined,
            newDate: f.get('newDate') || undefined,
            reason: f.get('reason'),
            clientRef: crypto.randomUUID(),
          },
        });
      else return false;
      $('#modal')?.close();
      toast('Listo.');
      return 'reload';
    } catch (e) {
      feedback(e.message);
      toast(e.message);
      return true;
    }
  }
  return {
    probe,
    load,
    html,
    action,
    submit,
    setDay: v => {
      day = v;
    },
  };
};
