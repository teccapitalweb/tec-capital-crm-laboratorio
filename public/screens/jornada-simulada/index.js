/**
 * Pantalla «Jornada simulada» (docs/PLAN_JORNADA_SIMULADA.md).
 *
 * Un día de trabajo con clientes de mentira que llegan a goteo durante horas: el asistente y el equipo los atienden
 * como siempre y aquí se supervisa en vivo. Arriba, cómo está configurada y cómo va el día (llegadas por bloque de
 * 15 minutos); después las cifras; abajo tres columnas: alertas, conversaciones (con su chat a un lado) y la persona
 * que atiende. Sin jornada en curso, la lista de las anteriores y el botón para empezar una (ventana con el formulario).
 *
 * Todo sale de GET /api/jornada y GET /api/jornada/:id; los cambios llegan en vivo por «jornada.changed» y la pantalla
 * vuelve a pedir la jornada (es una sola petición pequeña). Los textos de los clientes simulados son datos y la
 * plantilla los escapa.
 */
import { attrs, html, render, when } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { isAbort } from '../../kit/api.js';
import { dialog } from '../../kit/components/dialog.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';

const HORA = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' });
const FECHA = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const hora = t => (t ? HORA.format(new Date(t)) : '—');
const fecha = t => (t ? FECHA.format(new Date(t)) : '—');
const usd = cents => '$' + ((Number(cents) || 0) / 100).toFixed(2) + ' USD';
const minutos = ms =>
  ms === null || ms === undefined
    ? 'sin dato'
    : ms < 60_000
      ? `${Math.round(ms / 1000)} s`
      : `${Math.round(ms / 60_000)} min`;
const duracion = ms => {
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
};
const ESTADO = {
  starting: ['Entrando', 'k-chip--draft'],
  assistant: ['Con el asistente', 'k-chip--sky'],
  waiting: ['Espera asesor', 'k-chip--warn'],
  agent: ['Con la persona', 'k-chip--ok'],
  closed: ['Cerrada', 'k-chip--draft'],
};
const TONO_PERSONA = {
  curioso: 'sky',
  precio: 'butter',
  listo: 'mint',
  pagador: 'mint',
  molesto: 'peach',
  baja: 'peach',
  dudas: 'lilac',
  desconocido: 'butter',
  silencio: 'soft',
};
const RUN_CHIP = {
  planned: 'k-chip--sky',
  running: 'k-chip--ok',
  paused: 'k-chip--warn',
  finished: 'k-chip--draft',
  archived: 'k-chip--draft',
};
let enVivo = null;

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let montado = true;
    const st = {
      lista: null, // GET /api/jornada
      run: null, // la jornada abierta
      filtro: 'todas',
      seleccion: null, // id de conversación
      chat: null, // { estado, mensajes?, error? }
      proyectar: false,
      informe: null, // { estado: 'cargando' | 'ok' | 'error', datos?, hechos: Set de claves ya aplicadas }
    };
    const marcaCtx = ctx.brand && ctx.brand !== 'all' ? ctx.brand : '';
    const qs = marcaCtx ? '?brand=' + encodeURIComponent(marcaCtx) : '';

    render(
      root,
      html`<section class="k-page jr-page">
        <header class="k-head jr-head">
          <div class="jr-head__texto">
            <span class="k-eyebrow">Ajustes</span>
            <h1 class="jr-titulo">Jornada simulada <span data-slot="estado"></span></h1>
            <p class="k-lead jr-lead">
              Un día de trabajo con clientes de mentira que llegan a goteo durante horas. El asistente y el equipo los atienden
              como siempre; aquí ves cómo va y qué falla. Ningún número real: todo por los canales simulados.
            </p>
          </div>
          <div class="k-actions jr-acciones" data-slot="acciones"></div>
        </header>
        <div data-slot="cuerpo"></div>
      </section>`,
    );
    const pagina = root.querySelector('.jr-page');
    const slot = n => root.querySelector(`[data-slot="${n}"]`);
    render(slot('cuerpo'), loading('Cargando…'));

    // ---- lista y formulario (sin jornada abierta)
    function pintarLista() {
      const d = st.lista;
      render(slot('estado'), html``);
      render(
        slot('acciones'),
        html`<button type="button" class="k-btn k-btn--accent" data-do="nueva" ${attrs({ disabled: !d.enabled })}>Nueva jornada</button>`,
      );
      const vivas = d.runs.filter(r => ['planned', 'running', 'paused'].includes(r.state));
      render(
        slot('cuerpo'),
        html`<div class="k-stack">
          ${when(
            !d.enabled,
            () =>
              html`<div class="k-notice k-notice--warn" role="note">El simulador de clientes está apagado en este servidor.</div>`,
          )}
          ${when(
            vivas.length,
            () => html`<section class="k-card k-stack">
              <h2 class="k-card__title">En curso</h2>
              <ul class="jr-lista">
                ${vivas.map(r => filaRun(r))}
              </ul>
            </section>`,
          )}
          <section class="k-card k-stack">
            <h2 class="k-card__title">Jornadas anteriores</h2>
            ${when(
              d.runs.filter(r => !vivas.includes(r)).length,
              () => html`<ul class="jr-lista">${d.runs.filter(r => !vivas.includes(r)).map(r => filaRun(r))}</ul>`,
              () =>
                empty({
                  title: 'Todavía no hay jornadas',
                  text: 'Empieza una: eliges la marca, cuántos clientes y en cuánto tiempo, los perfiles y quién atiende. Los clientes son «· demo» y se archivan al terminar.',
                }),
            )}
          </section>
        </div>`,
      );
    }
    const filaRun = r =>
      html`<li class="jr-run" data-key="${r.id}">
        <button type="button" class="jr-run__btn" data-do="abrir" data-id="${r.id}">
          <span class="jr-run__t"><strong>${r.title}</strong><span class="k-chip ${RUN_CHIP[r.state] || ''}">${r.stateLabel}</span></span>
          <span class="k-hint">${r.count} clientes en ${duracion(r.minutes * 60_000)} · ${r.rhythmLabel} · ${r.arrived} llegaron${r.alertsActive ? ` · ${r.alertsActive} alertas` : ''} · ${fecha(r.startsAt)}</span>
        </button>
      </li>`;

    // Lo que la persona dejó en el formulario de «Nueva jornada» (lo guarda la ventana al cerrarse).
    let ultimoFormulario = null;
    async function nueva() {
      const o = st.lista.options;
      const marcaInicial = marcaCtx || o.brands[0]?.id || '';
      const elegidos = new Set(o.personas.map(p => p.id).filter(id => id !== 'baja'));
      const avisos = { ...o.defaultAlerts };
      let ritmo = 'goteo',
        ia = 'guiones';
      const uid = n => ctx.uid('nueva-' + n);
      const eleccion = await dialog({
        title: 'Nueva jornada',
        wide: true,
        mount: cuerpo => {
          const pintar = () =>
            render(
              cuerpo,
              html`<div class="k-form jr-form">
                <div class="k-field">
                  <label class="k-label" for="${uid('marca')}">Marca</label>
                  <select class="k-input" id="${uid('marca')}" name="brandId">
                    ${o.brands.map(b => html`<option value="${b.id}" ${attrs({ selected: b.id === marcaInicial })}>${b.name}</option>`)}
                  </select>
                </div>
                <div class="k-field">
                  <label class="k-label" for="${uid('titulo')}">Nombre (opcional)</label>
                  <input class="k-input" id="${uid('titulo')}" name="title" maxlength="80" placeholder="Jornada de prueba" />
                </div>
                <div class="jr-form__fila">
                  <div class="k-field">
                    <label class="k-label" for="${uid('n')}">Cuántos clientes</label>
                    <input class="k-input" id="${uid('n')}" name="count" type="number" min="1" max="${o.limits.maxCount}" value="20" />
                  </div>
                  <div class="k-field">
                    <label class="k-label" for="${uid('min')}">En cuánto tiempo</label>
                    <select class="k-input" id="${uid('min')}" name="minutes">
                      <option value="15">15 minutos (prueba rápida)</option>
                      <option value="60">1 hora</option>
                      <option value="120">2 horas</option>
                      <option value="300" selected>5 horas</option>
                      <option value="480">Todo el día (8 h)</option>
                    </select>
                  </div>
                </div>
                <div class="k-field">
                  <span class="k-label">Ritmo de llegada</span>
                  <div class="jr-opts" role="group" aria-label="Ritmo">
                    ${o.rhythms.map(
                      r =>
                        html`<button type="button" class="k-filter" data-do="ritmo" data-id="${r.id}" aria-pressed="${ritmo === r.id}" title="${r.hint}">
                          ${r.label}
                        </button>`,
                    )}
                  </div>
                </div>
                <div class="k-field">
                  <span class="k-label">Perfiles de cliente</span>
                  <div class="jr-opts" role="group" aria-label="Perfiles">
                    ${o.personas.map(
                      p =>
                        html`<button type="button" class="k-filter" data-do="perfil" data-id="${p.id}" aria-pressed="${elegidos.has(p.id)}" title="${p.description}">
                          ${p.label}
                        </button>`,
                    )}
                  </div>
                </div>
                <div class="k-field">
                  <span class="k-label">Cómo conversan los clientes</span>
                  <div class="jr-opts" role="group" aria-label="Cómo conversan">
                    <button type="button" class="k-filter" data-do="ia" data-id="guiones" aria-pressed="${ia === 'guiones'}">Guiones por perfil, sin IA (gratis)</button>
                    <button
                      type="button"
                      class="k-filter"
                      data-do="ia"
                      data-id="claude"
                      aria-pressed="${ia === 'claude'}"
                      ${attrs({ disabled: !o.ai?.available })}
                      title="${o.ai?.available ? 'Claude pone las palabras de cada cliente según su perfil y lo que le contestan' : 'La IA de Claude no está activa en este servidor'}"
                    >
                      Claude actúa cada cliente${o.ai?.available ? '' : ' (IA apagada)'}
                    </button>
                  </div>
                  <label class="k-hint jr-espera" for="${uid('tope')}">
                    Tope de gasto por jornada
                    <input class="k-input jr-espera__n" id="${uid('tope')}" name="aiCapUsd" type="number" min="0.5" max="100" step="0.5" value="${o.ai?.defaultCapUsd ?? 3}" />
                    USD · al llegar, los clientes siguen con guiones
                  </label>
                </div>
                <div class="jr-form__fila">
                  <div class="k-field">
                    <label class="k-label" for="${uid('ritmoChat')}">Ritmo de cada cliente</label>
                    <select class="k-input" id="${uid('ritmoChat')}" name="pace">
                      ${o.paces.map(p => html`<option value="${p.id}" ${attrs({ selected: p.id === 'lenta' })}>${p.label}</option>`)}
                    </select>
                  </div>
                  <div class="k-field">
                    <label class="k-label" for="${uid('quien')}">Quién atiende lo que pasa a persona</label>
                    <select class="k-input" id="${uid('quien')}" name="assigneeId">
                      <option value="">La cola del equipo (nadie en particular)</option>
                      ${o.team.map(u => html`<option value="${u.id}">${u.name}</option>`)}
                    </select>
                  </div>
                </div>
                <div class="k-field">
                  <span class="k-label">Avisarme cuando</span>
                  <div class="jr-opts" role="group" aria-label="Avisos">
                    ${o.alertKinds.map(
                      a =>
                        html`<button type="button" class="k-filter" data-do="aviso" data-id="${a.id}" aria-pressed="${Boolean(avisos[a.id])}" title="${a.hint}">
                          ${a.icon} ${a.label}
                        </button>`,
                    )}
                  </div>
                  <label class="k-hint jr-espera" for="${uid('espera')}">
                    Sin respuesta durante
                    <input class="k-input jr-espera__n" id="${uid('espera')}" name="waitMinutes" type="number" min="1" max="120" value="${avisos.waitMinutes}" />
                    minutos
                  </label>
                </div>
                <p class="k-hint">
                  Los clientes son «· demo», escriben por los canales simulados y se archivan al terminar. Nada sale a un número real.
                </p>
              </div>`,
            );
          pintar();
          const off = listen(cuerpo, {
            click: {
              // sin repintar: repintar el formulario borraría lo que la persona ya escribió
              ritmo: (_e, b) => {
                ritmo = b.dataset.id;
                for (const x of cuerpo.querySelectorAll('[data-do="ritmo"]'))
                  x.setAttribute('aria-pressed', String(x.dataset.id === ritmo));
              },
              perfil: (_e, b) => {
                if (elegidos.has(b.dataset.id)) elegidos.delete(b.dataset.id);
                else elegidos.add(b.dataset.id);
                b.setAttribute('aria-pressed', String(elegidos.has(b.dataset.id)));
              },
              aviso: (_e, b) => {
                avisos[b.dataset.id] = !avisos[b.dataset.id];
                b.setAttribute('aria-pressed', String(avisos[b.dataset.id]));
              },
              ia: (_e, b) => {
                ia = b.dataset.id;
                for (const x of cuerpo.querySelectorAll('[data-do="ia"]'))
                  x.setAttribute('aria-pressed', String(x.dataset.id === ia));
              },
            },
          });
          // al cerrar, el kit llama esto ANTES de quitar la ventana: aquí se leen los campos tal como quedaron
          return () => {
            const f = {};
            for (const el of cuerpo.querySelectorAll('[name]')) f[el.name] = el.value;
            ultimoFormulario = f;
            off();
          };
        },
        actions: [
          { id: 'no', label: 'Cancelar' },
          { id: 'si', label: 'Empezar ahora', primary: true, autofocus: true },
        ],
      });
      if (eleccion !== 'si' || !montado) return;
      const v = ultimoFormulario;
      if (!v) return;
      try {
        const d = await api.post('/api/jornada', {
          brandId: v.brandId,
          title: v.title,
          count: Number(v.count),
          minutes: Number(v.minutes),
          rhythm: ritmo,
          pace: v.pace,
          personas: [...elegidos],
          assigneeId: v.assigneeId || null,
          alerts: { ...avisos, waitMinutes: Number(v.waitMinutes) || avisos.waitMinutes },
          ai: ia,
          aiCapUsd: Number(v.aiCapUsd) || undefined,
        });
        if (!montado) return;
        ctx.toast('Jornada en marcha: el primer cliente ya está entrando.');
        st.run = d.run;
        pintarRun();
      } catch (error) {
        if (!isAbort(error)) ctx.toast(error.message);
      }
    }

    // ---- la jornada abierta
    function pintarRun() {
      const r = st.run;
      const viva = ['running', 'paused', 'planned'].includes(r.state);
      render(
        slot('estado'),
        html`<span class="jr-estado jr-estado--${r.state}"><i aria-hidden="true"></i>${r.stateLabel}${viva ? html` · ${duracion(r.elapsedMs)} de ${duracion(r.totalMs)}` : ''}</span>`,
      );
      render(
        slot('acciones'),
        html`<button type="button" class="k-btn k-btn--ghost" data-do="volver">← Todas las jornadas</button>
          ${when(r.state === 'running', () => html`<button type="button" class="k-btn" data-do="pausar">Pausar llegadas</button>`)}
          ${when(r.state === 'paused', () => html`<button type="button" class="k-btn k-btn--primary" data-do="reanudar">Reanudar llegadas</button>`)}
          ${when(viva, () => html`<button type="button" class="k-btn k-btn--danger" data-do="terminar">Terminar jornada</button>`)}
          ${when(r.state === 'finished', () => html`<button type="button" class="k-btn" data-do="archivar">Archivar (cierra los chats demo)</button>`)}
          <button type="button" class="k-btn k-btn--accent" data-do="proyectar" aria-pressed="${st.proyectar}">${st.proyectar ? 'Dejar de proyectar' : 'Proyectar'}</button>`,
      );
      const s = r.stats,
        maxB = Math.max(1, ...r.blocks.map(b => b.planned));
      const convs = r.conversations.filter(c =>
        st.filtro === 'todas' ? true : st.filtro === 'alerta' ? c.alerts > 0 : c.state === st.filtro,
      );
      const activas = r.alerts.filter(a => a.state === 'active'),
        resueltas = r.alerts.filter(a => a.state !== 'active');
      render(
        slot('cuerpo'),
        html`<div class="k-stack">
          <section class="jr-config" aria-label="Cómo está configurada">
            <div><span class="k-eyebrow">Marca</span><b>${nombreMarca(r.brandId)}</b><small>Canales simulados · clientes «· demo»</small></div>
            <div><span class="k-eyebrow">Clientes</span><b>${r.count} en ${duracion(r.totalMs)}</b><small>${r.rhythmLabel} · empezó ${hora(r.startsAt)}</small></div>
            <div><span class="k-eyebrow">Perfiles</span><b>${r.personas.length}</b><small>${r.personas.map(p => p.label).join(', ')}</small></div>
            <div>
              <span class="k-eyebrow">Cómo conversan</span><b>${r.ai?.label || 'Guiones por perfil'}</b>
              <small>${r.ai?.mode === 'claude' ? `${r.paceLabel} · gastados ${usd(r.ai.costCents)} de ${usd(r.ai.capCents)} · ${r.ai.calls} ${r.ai.calls === 1 ? 'llamada' : 'llamadas'}${r.ai.note ? ' · ' + r.ai.note : ''}` : r.paceLabel}</small>
            </div>
            <div><span class="k-eyebrow">Quién atiende</span><b>${r.assigneeName ? 'Asistente + ' + r.assigneeName : 'Asistente + la cola'}</b><small>${r.assigneeName ? 'recibe lo que pasa a persona' : 'lo que pasa a persona espera en la cola'}</small></div>
            <div><span class="k-eyebrow">Avisos</span><b>${Object.entries(r.alertsConfig).filter(([k, v]) => v === true && k !== 'waitMinutes').length} encendidos</b><small>sin respuesta ${r.alertsConfig.waitMinutes} min</small></div>
          </section>

          <section class="k-card jr-dia" aria-label="Cómo va el día">
            <div class="jr-dia__cab"><h2 class="k-card__title">Cómo va el día</h2><span class="k-eyebrow">Llegadas cada 15 min · planeadas contra las que ya llegaron</span></div>
            <div class="jr-barra" role="img" aria-label="${r.stats.arrived} de ${r.planned} llegadas">
              ${r.blocks.map(
                (b, i) =>
                  html`<div class="jr-b ${b.arrived >= b.planned && b.planned ? 'jr-b--ok' : b.arrived ? 'jr-b--parcial' : ''} ${b.current ? 'jr-b--ahora' : ''}" data-h="${Math.max(1, Math.round((b.planned / maxB) * 10))}" title="${hora(b.at)}: ${b.arrived} de ${b.planned}">
                    ${when(i % 4 === 0, () => html`<span class="jr-b__h">${hora(b.at)}</span>`)}
                  </div>`,
              )}
            </div>
          </section>

          <div class="k-figures jr-cifras">
            <div class="k-figure" data-tone="lime"><span class="k-figure__label">Llegaron</span><span class="k-figure__value">${s.arrived}</span><span class="k-figure__sub">de ${r.planned} clientes</span></div>
            <div class="k-figure" data-tone="sky"><span class="k-figure__label">Atendió el asistente solo</span><span class="k-figure__value">${s.assistantOnly}</span><span class="k-figure__sub">${s.arrived ? Math.round((s.assistantOnly / s.arrived) * 100) : 0} % · sin pasar a persona</span></div>
            <div class="k-figure" data-tone="butter"><span class="k-figure__label">Esperan asesor</span><span class="k-figure__value">${s.waiting}</span><span class="k-figure__sub">${s.waiting ? 'la más antigua lleva ' + minutos(s.waitingOldestMs) : 'nadie en espera'}</span></div>
            <div class="k-figure" data-tone="mint"><span class="k-figure__label">Atendió una persona</span><span class="k-figure__value">${s.handled}</span><span class="k-figure__sub">respuesta mediana ${minutos(s.agentMedianMs)}</span></div>
            <div class="k-figure" data-tone="lilac"><span class="k-figure__label">Pagos de práctica</span><span class="k-figure__value">${s.paid}</span><span class="k-figure__sub">pedidos pagados en la jornada</span></div>
            <div class="k-figure" data-tone="peach"><span class="k-figure__label">Alertas</span><span class="k-figure__value">${s.alertsActive}</span><span class="k-figure__sub">${s.alertsActive ? 'por atender' : 'ninguna activa'}</span></div>
          </div>

          <div class="jr-cols">
            <section class="k-card jr-alertas" aria-label="Alertas">
              <h2 class="k-card__title">⚠ Alertas <span class="k-hint">${activas.length} activas</span></h2>
              ${when(!activas.length, () => html`<p class="k-hint">Sin alertas ahora. Aparecen aquí cuando alguien espera, el asistente no supo o pasó a persona sin motivo.</p>`)}
              ${activas.map(
                a => html`<div class="jr-alerta" data-key="${a.id}">
                  <span class="jr-alerta__ic" data-tone="${a.tone}" aria-hidden="true">${a.icon}</span>
                  <div class="jr-alerta__t">
                    <b>${a.text}</b>
                    <small>${a.label} · ${hora(a.createdAt)}${a.detail ? ' · ' + a.detail : ''}</small>
                    <div class="k-actions jr-alerta__acc">
                      ${when(a.conversationId, () => html`<button type="button" class="k-btn jr-mini" data-do="ver" data-id="${a.conversationId}">Ver chat</button>`)}
                      <button type="button" class="k-btn jr-mini" data-do="resolver" data-id="${a.id}">Resuelta</button>
                    </div>
                  </div>
                </div>`,
              )}
              ${when(
                resueltas.length,
                () => html`<details class="jr-resueltas"><summary>Resueltas (${resueltas.length})</summary>
                  ${resueltas.slice(0, 20).map(a => html`<p class="k-hint">${a.icon} ${a.text} · ${hora(a.resolvedAt)}${a.resolvedByName ? ' · ' + a.resolvedByName : ' · sola'}</p>`)}
                </details>`,
              )}
            </section>

            <section class="k-card jr-convs" aria-label="Conversaciones de la jornada">
              <h2 class="k-card__title">Conversaciones <span class="k-hint">${r.conversations.length}</span></h2>
              <div class="k-filterbar jr-filtros">
                ${[
                  ['todas', 'Todas'],
                  ['assistant', 'Con el asistente'],
                  ['waiting', 'Esperan asesor'],
                  ['agent', 'Con la persona'],
                  ['alerta', 'Con alerta'],
                  ['closed', 'Cerradas'],
                ].map(
                  ([k, t]) =>
                    html`<button type="button" class="k-filter" data-do="filtro" data-id="${k}" aria-pressed="${st.filtro === k}">${t}</button>`,
                )}
              </div>
              ${when(!convs.length, () => html`<p class="k-hint">${r.conversations.length ? 'Nada con este filtro.' : 'Los clientes empiezan a llegar en un momento.'}</p>`)}
              <div class="jr-lista-convs">
                ${convs.map(
                  c => html`<button type="button" class="jr-conv" data-do="ver" data-id="${c.id || ''}" data-key="${c.id || c.name}" aria-pressed="${st.seleccion === c.id}" ${attrs({ disabled: !c.id })}>
                    <span class="jr-conv__av" data-tone="${TONO_PERSONA[c.persona] || 'soft'}" aria-hidden="true">${c.name.slice(0, 2).toUpperCase()}</span>
                    <span class="jr-conv__t">
                      <b>${c.name} <span class="k-chip k-chip--draft">${c.personaLabel}</span>${c.alerts ? html` <span class="k-chip k-chip--bad">⚠ ${c.alerts}</span>` : ''}</b>
                      <small>${c.channel}${c.courseTitle ? ' · ' + c.courseTitle : ''}${c.last ? ' · ' + (c.last.kind === 'customer' ? '' : c.last.kind === 'agent' ? (c.assigneeName || 'Equipo') + ': ' : 'Asistente: ') + c.last.text : ''}</small>
                    </span>
                    <span class="jr-conv__r"><span>${hora(c.last?.at || c.arrivedAt)}</span><span class="k-chip ${ESTADO[c.state]?.[1] || ''}">${ESTADO[c.state]?.[0] || c.state}</span></span>
                  </button>`,
                )}
              </div>
            </section>

            <div class="jr-lado" data-slot="lado">
              ${when(
                r.assignee,
                () => html`<section class="k-card jr-vend" aria-label="Persona que atiende">
                  <h2 class="k-card__title">👤 ${r.assignee.name}</h2>
                  <div class="jr-vend__filas">
                    <div class="jr-vend__fila"><span>Chats con esta persona</span><b>${r.assignee.total}</b></div>
                    <div class="jr-vend__fila"><span>Abiertos ahora</span><b>${r.assignee.open}</b></div>
                    <div class="jr-vend__fila"><span>Respuesta mediana</span><b>${minutos(r.assignee.medianMs)}</b></div>
                    <div class="jr-vend__fila ${r.assignee.late ? 'jr-vend__fila--mal' : ''}"><span>Esperando más de ${r.alertsConfig.waitMinutes} min</span><b>${r.assignee.late}</b></div>
                    <div class="jr-vend__fila"><span>Cerró con pago de práctica</span><b>${r.assignee.closedWithOrder} de ${r.assignee.total}</b></div>
                  </div>
                </section>`,
              )}
              <section class="k-card jr-chat" aria-label="Conversación elegida">
                <h2 class="k-card__title" data-slot="chatTitulo">Conversación</h2>
                <div class="jr-chat__cuerpo" data-slot="chat"></div>
              </section>
            </div>
          </div>
          <section class="k-card jr-informe" aria-label="Informe de la jornada" data-slot="informe"></section>
        </div>`,
      );
      pintarChat();
      pintarInforme();
    }
    // ---- informe: al terminar se arma completo; en curso es una vista previa con lo que va
    function pintarInforme() {
      const caja = slot('informe');
      if (!caja) return;
      const r = st.run,
        i = st.informe;
      const viva = ['running', 'paused', 'planned'].includes(r.state);
      if (!i) {
        render(
          caja,
          html`<h2 class="k-card__title">📄 Informe de la jornada <span class="k-hint">${viva ? 'vista previa · se arma al terminar' : 'listo'}</span></h2>
            <div class="k-actions"><button type="button" class="k-btn k-btn--primary" data-do="informe">${viva ? 'Ver lo que va' : 'Ver el informe'}</button></div>`,
        );
        return;
      }
      if (i.estado === 'cargando') return render(caja, loading('Armando el informe…'));
      if (i.estado === 'error')
        return render(caja, failure({ title: 'No se pudo armar el informe', error: i.error, retry: 'informe' }));
      const d = i.datos;
      render(
        caja,
        html`<h2 class="k-card__title">📄 Informe de la jornada <span class="k-hint">${viva ? 'vista previa · se completa al terminar' : 'listo'}</span></h2>
          <p class="k-hint">
            Llegaron ${d.summary.arrived} · atendió el asistente solo ${d.summary.assistantOnly} · atendió una persona ${d.summary.handled}
            (respuesta mediana ${minutos(d.summary.agentMedianMs)}) · pagos de práctica ${d.summary.paid} · ${d.summary.problems}
            ${d.summary.problems === 1 ? 'fallo' : 'fallos'} en ${d.groups.length} ${d.groups.length === 1 ? 'grupo' : 'grupos'}.
          </p>
          ${when(
            !d.groups.length,
            () =>
              html`<p class="k-hint">Sin fallos que agrupar: el asistente supo contestar, nadie esperó de más y nadie se quedó sin respuesta.</p>`,
          )}
          ${when(
            d.groups.length,
            () => html`<div class="jr-informe__grupos">
              ${d.groups.map(
                g => html`<div class="jr-grupo" data-key="${g.kind}-${g.title}">
                  <div class="jr-grupo__cab">
                    <b>${g.title}</b>
                    <span class="k-chip k-chip--warn">${g.count}</span>
                  </div>
                  ${when(g.detail, () => html`<p class="k-hint">${g.detail}</p>`)}
                  <ul class="jr-grupo__ej">
                    ${g.examples.map(
                      e => html`<li>
                        <span class="k-hint">${e.name || 'Cliente'}:</span> «${e.text}»
                        ${when(e.conversationId, () => html`<button type="button" class="k-btn k-btn--ghost jr-mini" data-do="ver" data-id="${e.conversationId}">Ver chat</button>`)}
                      </li>`,
                    )}
                  </ul>
                  <div class="k-actions">
                    ${when(
                      g.action === 'knowledge',
                      () =>
                        html`<button type="button" class="k-btn k-btn--primary" data-do="informe-conocimiento" data-q="${g.payload?.question || ''}" ${attrs({ disabled: i.hechos.has('k:' + g.payload?.question) })}>
                          ${i.hechos.has('k:' + g.payload?.question) ? 'Borrador creado' : 'Crear borrador de conocimiento'}
                        </button>`,
                    )}
                    ${when(
                      g.action === 'evaluation',
                      () =>
                        html`<button type="button" class="k-btn k-btn--primary" data-do="informe-evaluacion" data-kind="${g.kind}" ${attrs({ disabled: i.hechos.has('e:' + g.kind) })}>
                          ${i.hechos.has('e:' + g.kind) ? 'Casos añadidos' : `Añadir al banco de evaluación (${g.payload?.cases?.length || 0})`}
                        </button>`,
                    )}
                    ${when(g.action === 'review', () => html`<span class="k-hint">Revisar a mano: léelo en el chat y decide.</span>`)}
                  </div>
                </div>`,
              )}
            </div>`,
          )}
          ${when(
            d.personas.length,
            () => html`<p class="k-eyebrow jr-informe__sub">Cómo le fue a cada perfil</p>
              <ul class="jr-perfiles">
                ${d.personas.map(p => html`<li><b>${p.label}</b> <span class="k-hint">${p.total} ${p.total === 1 ? 'cliente' : 'clientes'} · ${p.done} terminaron · ${p.waiting} esperando a una persona</span></li>`)}
              </ul>`,
          )}
          <div class="k-actions"><button type="button" class="k-btn" data-do="informe">Volver a armar</button></div>`,
      );
    }
    async function cargarInforme() {
      const hechos = st.informe?.hechos || new Set();
      st.informe = { estado: 'cargando', hechos };
      pintarInforme();
      try {
        const d = await api.get(`/api/jornada/${st.run.id}/report`);
        if (!montado) return;
        st.informe = { estado: 'ok', datos: d.report, hechos };
      } catch (error) {
        if (isAbort(error)) return;
        st.informe = { estado: 'error', error, hechos };
      }
      pintarInforme();
    }
    const nombreMarca = id => st.lista?.options?.brands.find(b => b.id === id)?.name || id;
    function pintarChat() {
      const caja = slot('chat'),
        titulo = slot('chatTitulo');
      if (!caja) return;
      const c = st.run?.conversations.find(x => x.id === st.seleccion);
      if (!c) {
        render(titulo, html`Conversación`);
        render(caja, html`<p class="k-hint jr-vacio">Toca una conversación para leerla.</p>`);
        return;
      }
      render(titulo, html`${c.name} <span class="k-chip ${ESTADO[c.state]?.[1] || ''}">${ESTADO[c.state]?.[0]}</span>`);
      const ch = st.chat;
      if (!ch || ch.estado === 'cargando') return render(caja, loading('Leyendo el chat…'));
      if (ch.estado === 'error')
        return render(caja, failure({ title: 'No se pudo leer el chat', error: ch.error, retry: 'reintentar-chat' }));
      render(
        caja,
        html`<div class="jr-msgs">
            ${ch.mensajes.map(
              m => html`<div class="jr-msg jr-msg--${m.kind} ${m.flag ? 'jr-msg--mal' : ''}" data-key="${m.seq}">
                <span class="jr-msg__t">${m.text}</span>
                <small>${m.who} · ${hora(m.at)}${m.flag === 'no_supo' ? ' · no supo' : m.flag === 'paso_sin_motivo' ? ' · pasó a persona sin motivo' : ''}</small>
              </div>`,
            )}
          </div>
          <div class="k-actions"><button type="button" class="k-btn k-btn--primary" data-do="abrir-chat" data-id="${c.id}">Abrir en Conversaciones</button></div>`,
      );
    }

    // ---- datos
    async function cargarLista() {
      try {
        st.lista = await api.get('/api/jornada' + qs);
        if (!montado) return;
        if (!st.run) {
          const viva = st.lista.runs.find(r => ['running', 'paused', 'planned'].includes(r.state));
          if (viva) return abrir(viva.id);
          pintarLista();
        }
      } catch (error) {
        if (montado && !isAbort(error))
          render(slot('cuerpo'), failure({ title: 'No se pudo cargar', error, retry: 'reintentar' }));
      }
    }
    let pidiendo = null;
    async function recargarRun() {
      if (!st.run || pidiendo) return pidiendo;
      pidiendo = (async () => {
        try {
          const d = await api.get('/api/jornada/' + st.run.id);
          if (!montado || !st.run || st.run.id !== d.run.id) return;
          st.run = d.run;
          pintarRun();
          if (st.seleccion) verChat(st.seleccion, { silencioso: true });
        } catch (error) {
          if (!isAbort(error)) console.error(error);
        } finally {
          pidiendo = null;
        }
      })();
      return pidiendo;
    }
    async function abrir(id) {
      try {
        const d = await api.get('/api/jornada/' + id);
        if (!montado) return;
        st.run = d.run;
        st.seleccion = null;
        st.chat = null;
        st.informe = null;
        pintarRun();
      } catch (error) {
        if (!isAbort(error)) ctx.toast(error.message);
      }
    }
    async function verChat(id, { silencioso = false } = {}) {
      if (!id) return;
      st.seleccion = id;
      if (!silencioso) {
        st.chat = { estado: 'cargando' };
        pintarRun();
      }
      try {
        const d = await api.get(`/api/jornada/${st.run.id}/conversations/${id}`);
        if (!montado || st.seleccion !== id) return;
        st.chat = { estado: 'ok', mensajes: d.messages };
      } catch (error) {
        if (isAbort(error) || st.seleccion !== id) return;
        st.chat = { estado: 'error', error };
      }
      pintarChat();
    }
    async function accion(nombre, confirmar) {
      if (confirmar) {
        const ok = await dialog({
          title: confirmar.titulo,
          content: html`<p>${confirmar.texto}</p>`,
          actions: [
            { id: 'no', label: 'Cancelar', autofocus: true },
            { id: 'si', label: confirmar.boton, danger: true },
          ],
        });
        if (ok !== 'si' || !montado) return;
      }
      try {
        const d = await api.post(`/api/jornada/${st.run.id}/${nombre}`, {});
        if (!montado) return;
        st.run = d.run;
        pintarRun();
      } catch (error) {
        if (!isAbort(error)) ctx.toast(error.message);
      }
    }
    function proyectar(encender) {
      st.proyectar = encender;
      pagina.classList.toggle('jr-proyectar', encender);
      if (encender) pagina.requestFullscreen?.().catch(() => {});
      else if (root.ownerDocument.fullscreenElement === pagina) root.ownerDocument.exitFullscreen?.().catch(() => {});
      if (st.run) pintarRun();
    }
    const alSalir = () => {
      if (st.proyectar && !root.ownerDocument.fullscreenElement) proyectar(false);
    };
    root.addEventListener('fullscreenchange', alSalir);
    ctx.onUnmount(() => root.removeEventListener('fullscreenchange', alSalir));

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargarLista,
            'reintentar-chat': () => verChat(st.seleccion),
            nueva: () => nueva(),
            abrir: (_e, b) => abrir(b.dataset.id),
            volver: () => {
              st.run = null;
              st.seleccion = null;
              st.chat = null;
              render(slot('cuerpo'), loading('Cargando…'));
              cargarLista();
            },
            ver: (_e, b) => verChat(b.dataset.id),
            filtro: (_e, b) => {
              st.filtro = b.dataset.id;
              pintarRun();
            },
            resolver: async (_e, b) => {
              try {
                const d = await api.post(`/api/jornada/${st.run.id}/alerts/${b.dataset.id}/resolve`, {});
                if (!montado) return;
                st.run = d.run;
                pintarRun();
              } catch (error) {
                if (!isAbort(error)) ctx.toast(error.message);
              }
            },
            pausar: () => accion('pause'),
            reanudar: () => accion('resume'),
            terminar: () =>
              accion('finish', {
                titulo: 'Terminar la jornada',
                texto:
                  'Dejan de llegar clientes. Los chats que ya empezaron terminan solos y después puedes archivarlos.',
                boton: 'Terminar',
              }),
            archivar: () =>
              accion('archive', {
                titulo: 'Archivar la jornada',
                texto:
                  'Cierra todos los chats «· demo» de esta jornada como lo haría el equipo (resueltos, sin seguimientos abiertos). No borra el historial.',
                boton: 'Archivar',
              }),
            proyectar: () => proyectar(!st.proyectar),
            informe: () => cargarInforme(),
            'informe-conocimiento': async (_e, b) => {
              try {
                const d = await api.post(`/api/jornada/${st.run.id}/report/knowledge`, { question: b.dataset.q });
                if (!montado) return;
                st.informe.hechos.add('k:' + b.dataset.q);
                ctx.toast(
                  d.created
                    ? 'Borrador de conocimiento creado: apruébalo en Catálogo → Conocimiento.'
                    : 'Ya había una respuesta con esa pregunta.',
                );
                pintarInforme();
              } catch (error) {
                if (!isAbort(error)) ctx.toast(error.message);
              }
            },
            'informe-evaluacion': async (_e, b) => {
              const g = st.informe?.datos?.groups.find(x => x.kind === b.dataset.kind);
              if (!g?.payload?.cases?.length) return;
              try {
                const d = await api.post(`/api/jornada/${st.run.id}/report/evaluation`, { cases: g.payload.cases });
                if (!montado) return;
                st.informe.hechos.add('e:' + g.kind);
                ctx.toast(
                  `${d.cases.length} ${d.cases.length === 1 ? 'caso añadido' : 'casos añadidos'} al banco de evaluación.`,
                );
                pintarInforme();
              } catch (error) {
                if (!isAbort(error)) ctx.toast(error.message);
              }
            },
            'abrir-chat': () => ctx.go('inbox'),
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );
    enVivo = { cambio: () => (st.run ? recargarRun() : cargarLista()) };
    // por si un aviso se pierde: mientras la jornada está viva, un repaso cada 15 s (una petición pequeña)
    const repaso = setInterval(() => {
      if (st.run && ['running', 'paused', 'planned'].includes(st.run.state)) recargarRun();
    }, 15_000);
    ctx.onUnmount(() => clearInterval(repaso));
    ctx.onUnmount(() => {
      montado = false;
      enVivo = null;
      if (root.ownerDocument.fullscreenElement === pagina) root.ownerDocument.exitFullscreen?.().catch(() => {});
    });
    cargarLista();
  },
  /** Llegó alguien, cambió una alerta o el estado: se vuelve a pedir la jornada (una petición pequeña). */
  onEvent(evento) {
    if (!enVivo) return;
    if (evento?.type === 'jornada.changed') enVivo.cambio();
  },
};
