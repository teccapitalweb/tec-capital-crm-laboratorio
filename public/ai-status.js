// Estado de la IA (docs/ACTIVAR_IA_PRODUCCION.md): Operación → Sistema → «Inteligencia artificial», sólo administración. Muestra qué proveedor está activo, si hay clave
// (sí o no; su valor nunca llega al navegador), cuánto se lleva del tope del mes y, por marca, una lista de lo que falta para encender la IA con seguridad.
// Es de sólo lectura: los botones llevan a la pantalla donde se hace cada cosa. Las acciones llevan el prefijo «ais-» (lo reclama operations.js).
window.createAiStatusUI = function ({ state, api, esc, icon }) {
  let data = null,
    ping = null;
  const chip = (label, kind = '') => `<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const num = n => new Intl.NumberFormat('es-MX').format(n);
  const stamp = t =>
    t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(t) : '—';
  const VERDICT = {
    blocked: ['No lista', 'urgent'],
    ready_suggest: ['Lista para sugerir', 'good'],
    ready_respond: ['Lista para responder', 'ok'],
  };
  async function load() {
    data = await api('/api/ai/status');
  }
  // Una llamada mínima real a Claude: dice si la conexión funciona o por qué no (clave, saldo, modelo, red). Cuenta contra el tope.
  async function test(el) {
    if (el) el.disabled = true;
    try {
      const r = await api('/api/ai/ping', { method: 'POST', body: {} });
      ping = { ...r.result, at: Date.now() };
    } catch (e) {
      ping = { ok: false, reason: e.message, at: Date.now() };
    }
  }
  const pingLine = () =>
    !ping
      ? ''
      : `<p class="ais-ping ${ping.ok ? 'ok' : 'bad'}" role="status">${icon(ping.ok ? 'check-circle' : 'alert-triangle')}<span>${ping.ok ? `<strong>Claude respondió.</strong> Modelo ${esc(ping.model || '')}, ${num(ping.ms || 0)} ms, ${num((ping.inputTokens || 0) + (ping.outputTokens || 0))} tokens. La conexión funciona.` : `<strong>Claude no respondió.</strong> ${esc(ping.reason || '')}`} <small>${esc(stamp(ping.at))}</small></span></p>`;
  const mark = done =>
    `<span class="ais-mark ${done ? 'ok' : ''}" aria-hidden="true">${icon(done ? 'check' : 'circle')}</span><span class="sr-only">${done ? 'Listo' : 'Pendiente'}</span>`;
  const row = c =>
    `<li class="ais-check ${c.done ? 'done' : ''}">${mark(c.done)}<div><strong>${esc(c.title)}</strong><small>${esc(c.detail)}</small>${!c.done && c.go ? `<button type="button" class="btn" data-action="ais-go" ${c.go.tab ? `data-tab="${esc(c.go.tab)}"` : `data-view="${esc(c.go.view)}"`}>${esc(c.go.label)}</button>` : ''}</div></li>`;
  const bar = (label, value, limit, pct) =>
    `<div class="ais-meter"><div class="ais-meter-top"><span>${esc(label)}</span><strong>${num(value)}${limit > 0 ? ' de ' + num(limit) : ' · sin tope'}</strong></div>${limit > 0 ? `<div class="ais-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Number(pct) || 0}" aria-label="${esc(label)}"><span class="${pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : ''}" style="width:${Number(pct) || 0}%"></span></div>` : ''}</div>`;
  function html() {
    if (!data) return '<div class="loading-message">Cargando…</div>';
    const p = data.provider,
      u = p.usage;
    return `<section class="crm-panel ais-head"><div class="ops-card-top"><h2>Inteligencia artificial</h2>${p.real ? chip('Claude · ' + p.model, p.hasKey ? 'ok' : 'warn') : chip('Motor simulado', 'warn')}<button type="button" class="btn" data-action="ais-reload">${icon('refresh-cw')} Actualizar</button>${p.real ? `<button type="button" class="btn primary" data-action="ais-ping">${icon('zap')} Probar conexión con Claude</button>` : ''}</div>${pingLine()}
      <p class="crm-hint">Qué falta para que el CRM use la IA de Claude con seguridad. La IA <strong>sólo responde con conocimiento aprobado</strong> y con los precios, fechas y cupos del catálogo; no inventa ni confirma pagos. Aquí <strong>no se enciende nada</strong>: se ve el estado y cada botón lleva a donde se hace. Guía completa: <code>docs/ACTIVAR_IA_PRODUCCION.md</code>.</p>
      ${u ? `<div class="ais-usage"><strong>Uso de ${esc(u.month)}</strong>${bar('Llamadas', u.calls, u.callLimit, u.callsPct)}${bar('Tokens', u.tokens, u.tokenLimit, u.tokensPct)}${u.blocked ? '<p class="ais-warn">Se alcanzó un tope: la IA dejó de llamar y las conversaciones pasan a una persona.</p>' : ''}${p.summaryModel ? `<small>Resúmenes con ${esc(p.summaryModel)}. El costo real se ve en la consola de Anthropic: aquí se cuentan llamadas y tokens, no dinero.</small>` : ''}</div>` : `<div class="ais-usage"><strong>Uso del mes</strong><small>Con el motor simulado no hay llamadas a la IA ni gasto. El contador aparece cuando el proveedor es Claude.</small></div>`}
      <h3>En el entorno (Railway)</h3><ul class="ais-checks">${data.steps.map(row).join('')}</ul></section>
      ${
        data.brands
          .map(b => {
            const [l, k] = VERDICT[b.verdict] || ['', ''];
            return `<section class="crm-panel ais-brand"><div class="ops-card-top"><h2>${esc(b.name)}</h2>${chip(l, k)}${chip(b.knowledge.approved + ' respuesta' + (b.knowledge.approved === 1 ? '' : 's') + ' aprobada' + (b.knowledge.approved === 1 ? '' : 's'))}${b.gaps30 ? chip(b.gaps30 + ' pregunta' + (b.gaps30 === 1 ? '' : 's') + ' sin respuesta (30 días)', 'warn') : ''}</div>
        <p class="ais-next"><strong>Siguiente paso:</strong> ${esc(b.next)}</p><ul class="ais-checks">${b.checks.map(row).join('')}</ul>${b.lastEval ? `<small>Última evaluación: ${b.lastEval.passed} de ${b.lastEval.total} (${Math.round(b.lastEval.score * 100)} %) con ${b.lastEval.provider === 'claude' ? 'IA real (' + (b.lastEval.aiCalls || 0) + ' consulta' + ((b.lastEval.aiCalls || 0) === 1 ? '' : 's') + ')' : 'el motor simulado'} · ${esc(stamp(b.lastEval.at))}</small>` : ''}</section>`;
          })
          .join('') || '<div class="crm-empty"><h3>Sin marcas</h3></div>'
      }`;
  }
  return { load, html, test };
};
