window.createAnalyticsUI = function ({ state, api, esc, icon, icons, toast }) {
  const $ = s => document.querySelector(s);
  let days = 30,
    data = null,
    version = 0;
  const CHANNEL = { whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook' };
  const STATE = {
    pending: 'Programadas',
    reserved: 'En curso',
    completed: 'Completadas',
    cancelled: 'Canceladas',
    failed: 'Fallidas',
  };
  const pct = v => (v === null || v === undefined ? '—' : String(v).replace('.', ',') + ' %');
  const num = n => new Intl.NumberFormat('es-MX').format(n);
  function dur(ms) {
    if (ms === null || ms === undefined) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + ' s';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60),
      r = m % 60;
    if (h < 48) return h + ' h' + (r ? ' ' + r + ' min' : '');
    return Math.round(h / 24) + ' d';
  }
  const nav = () =>
    `<button data-view="analytics" class="${state.view === 'analytics' ? 'active' : ''}" aria-label="Analítica">${icon('chart-spline')}<span class="nav-label-text">Analítica</span></button>`;

  function kpi(label, value, hint = '') {
    return `<div class="an-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
  }
  function funnel(f) {
    const steps = [
      ['Creadas', f.created],
      ['Con conversación', f.interesado],
      ['Inscripción solicitada', f.inscripcion],
      ['Ganadas · prueba', f.ganada],
    ];
    return `<div class="an-funnel">${steps.map(([label, n]) => `<div class="an-funnel-row"><span>${label}</span><div class="an-bar"><i style="width:${f.created ? Math.max(n ? 2 : 0, Math.round((n / f.created) * 100)) : 0}%"></i></div><b>${num(n)}</b><small>${f.created ? pct(Math.round((n / f.created) * 1000) / 10) : '—'}</small></div>`).join('')}</div><p class="crm-hint">${num(f.perdida)} no continuaron · ${num(f.abiertas)} siguen abiertas. Conversión: ${pct(f.conversion)}.</p>`;
  }
  function trend(days) {
    let rows = data.trend;
    if (rows.length > 90) {
      const out = [];
      for (let i = 0; i < rows.length; i += 7) {
        const part = rows.slice(i, i + 7);
        out.push({
          date: part[0].date,
          conversations: part.reduce((n, r) => n + r.conversations, 0),
          opportunities: part.reduce((n, r) => n + r.opportunities, 0),
          won: part.reduce((n, r) => n + r.won, 0),
        });
      }
      rows = out;
    }
    const max = Math.max(1, ...rows.map(r => Math.max(r.conversations, r.opportunities))),
      w = 100 / rows.length;
    const total = rows.reduce((n, r) => n + r.conversations + r.opportunities, 0);
    if (!total) return '<p class="crm-hint">Todavía no hay actividad en este periodo.</p>';
    const bars = rows
      .map((r, i) => {
        const h1 = (r.conversations / max) * 100,
          h2 = (r.opportunities / max) * 100,
          x = i * w;
        return `<g><title>${esc(r.date)}: ${r.conversations} conversaciones, ${r.opportunities} oportunidades, ${r.won} ganadas</title><rect x="${x + w * 0.1}" y="${100 - h1}" width="${w * 0.38}" height="${h1}" class="c"/><rect x="${x + w * 0.52}" y="${100 - h2}" width="${w * 0.38}" height="${h2}" class="o"/></g>`;
      })
      .join('');
    return `<svg class="an-trend" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Conversaciones y oportunidades por día">${bars}</svg><div class="an-legend"><span><i class="c"></i>Conversaciones</span><span><i class="o"></i>Oportunidades</span><small>${esc(rows[0].date)} → ${esc(rows[rows.length - 1].date)}</small></div>`;
  }
  function table(head, rows, empty) {
    return rows.length
      ? `<div class="crm-table-wrap an-table"><table class="crm-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<p class="crm-hint">${empty}</p>`;
  }
  const funnelRows = list =>
    list.map(x => [
      esc(x.name || x.title) + (x.brand ? `<small class="an-sub">${esc(x.brand)}</small>` : ''),
      num(x.created),
      num(x.interesado),
      num(x.inscripcion),
      num(x.ganada),
      pct(x.conversion),
    ]);

  function view() {
    const d = data,
      f = d.funnel,
      r = d.response;
    return `<div class="content-page an-page"><div class="page-heading"><div><span class="eyebrow">Resultados · por marca</span><h1>Analítica comercial</h1><p>${esc(d.scope.brand ? d.scope.brands[0].name : 'Todas tus marcas')} · últimos ${d.period.days} días. Las ventas son de práctica.</p></div></div>
      <div class="an-controls"><label>Periodo<select id="an-days">${[7, 30, 90, 365].map(n => `<option value="${n}" ${n === days ? 'selected' : ''}>${n === 365 ? 'Último año' : 'Últimos ' + n + ' días'}</option>`).join('')}</select></label><button type="button" class="btn" data-action="an-reload">${icon('refresh-cw')} Actualizar</button></div>
      <div class="an-kpis">${kpi('Conversaciones nuevas', num(d.totals.conversations))}${kpi('Oportunidades nuevas', num(d.totals.opportunities))}${kpi('Ventas de práctica', num(d.totals.won), 'cerradas en el periodo')}${kpi('Conversión', pct(f.conversion), 'de las creadas en el periodo')}</div>
      <div class="an-grid">
        <section class="crm-panel"><h2>Embudo</h2>${funnel(f)}</section>
        <section class="crm-panel"><h2>Actividad por día</h2>${trend()}</section>
        <section class="crm-panel"><h2>Atención humana</h2><div class="an-kpis small">${kpi('1.ª respuesta (mediana)', dur(r.first.medianMs), num(r.first.count) + ' respuestas')}${kpi('1.ª respuesta (p90)', dur(r.first.p90Ms))}${kpi('Siguientes (mediana)', dur(r.next.medianMs), num(r.next.count) + ' respuestas')}${kpi('Dentro del objetivo', pct(r.target.rate), r.target.measured ? num(r.target.within) + ' de ' + num(r.target.measured) : 'sin objetivos activos')}</div><p class="crm-hint">Tiempos de reloj: no descuentan el horario laboral.</p></section>
        <section class="crm-panel"><h2>Tareas</h2><div class="an-kpis small">${kpi('Abiertas', num(d.tasks.open))}${kpi('Vencidas', num(d.tasks.overdue))}${kpi('Completadas', num(d.tasks.doneInPeriod), 'en el periodo')}</div></section>
      </div>
      ${d.byBrand.length > 1 ? `<section class="crm-panel"><h2>Por marca</h2>${table(['Marca', 'Creadas', 'Conversación', 'Inscripción', 'Ganadas', 'Conversión'], funnelRows(d.byBrand), '')}</section>` : ''}
      <section class="crm-panel"><h2>Por curso</h2>${table(['Curso', 'Creadas', 'Conversación', 'Inscripción', 'Ganadas', 'Conversión'], funnelRows(d.byCourse), 'Aún no hay oportunidades creadas en este periodo.')}</section>
      <div class="an-grid">
        <section class="crm-panel"><h2>Canales</h2>${table(
          ['Canal', 'Conversaciones', 'Ganadas'],
          d.channels.map(c => [CHANNEL[c.channel], num(c.conversations), num(c.won)]),
          '',
        )}</section>
        <section class="crm-panel"><h2>Motivos de no continuar</h2>${table(
          ['Motivo', 'Casos'],
          d.lossReasons.map(x => [esc(x.reason), num(x.count)]),
          'No hay oportunidades perdidas en este periodo.',
        )}</section>
      </div>
      <section class="crm-panel"><h2>${d.agentsScope === 'todos' ? 'Equipo' : 'Tu desempeño'}</h2>${table(
        [
          'Persona',
          'Intereses abiertos',
          'Creados',
          'Ganados',
          '1.ª+ respuestas',
          'Respuesta (mediana)',
          'En objetivo',
          'Tareas vencidas',
          'Tareas hechas',
        ],
        d.agents.map(a => [
          esc(a.name) + (a.disabled ? ' <small class="an-sub">suspendido</small>' : ''),
          num(a.openOpportunities),
          num(a.created),
          num(a.won),
          num(a.responses),
          dur(a.medianResponseMs),
          pct(a.withinTargetRate),
          num(a.tasksOverdue),
          num(a.tasksDone),
        ]),
        'Sin actividad en este periodo.',
      )}${d.agentsScope === 'todos' ? '' : '<p class="crm-hint">Cada persona ve sólo su propio detalle; el equipo completo lo ve administración.</p>'}</section>
      ${
        Object.keys(d.automation).length
          ? `<section class="crm-panel"><h2>Seguimientos automáticos</h2><div class="an-kpis small">${Object.entries(
              d.automation,
            )
              .map(([k, n]) => kpi(STATE[k] || k, num(n)))
              .join('')}</div></section>`
          : ''
      }
      <p class="crm-hint an-notes">${d.notes.map(esc).join(' ')}</p></div>`;
  }

  async function render() {
    const mine = ++version;
    if (!$('.an-page'))
      $('#page').innerHTML =
        '<div class="content-page"><div class="loading-message">Calculando resultados…</div></div>';
    try {
      const params = new URLSearchParams({ days });
      if (state.brand && state.brand !== 'all') params.set('brand', state.brand);
      const result = await api('/api/analytics?' + params);
      if (mine !== version || state.view !== 'analytics') return;
      data = result;
      $('#page').innerHTML = view();
      icons();
    } catch (e) {
      if (state.view === 'analytics') {
        $('#page').innerHTML =
          `<div class="content-page"><div class="crm-empty">${icon('chart-spline')}<h3>No pudimos calcular la analítica</h3><p>${esc(e.message)}</p><button class="btn" data-action="an-reload">Volver a intentar</button></div></div>`;
        icons();
      }
      toast(e.message);
    }
  }
  async function action(name) {
    if (name === 'an-reload') {
      await render();
      return true;
    }
    return false;
  }
  async function change(el) {
    if (el.id === 'an-days') {
      days = Number(el.value);
      await render();
      return true;
    }
    return false;
  }
  return { nav, render, action, change };
};
