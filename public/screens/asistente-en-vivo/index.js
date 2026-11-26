/**
 * Pantalla «Asistente en vivo» (docs/PLAN_ASISTENTE_EN_VIVO.md).
 *
 * Lo que hace el asistente conectado por el conector, al instante y ordenado por sesiones de trabajo: qué leyó, qué dejó
 * en borrador, qué propuso y qué le rechazó el CRM. Al tocar una acción, la tarjeta de la derecha (abajo, en celular)
 * muestra lo que dejó, leído de la base por GET /api/mcp-live/entity (nunca lo que el asistente escribió en su
 * conversación: la actividad no lo guarda), y, si es una propuesta, los botones Aprobar y Rechazar de siempre
 * (POST /api/mcp-proposals/:id/approve|reject, a nombre de quien aprueba y con los avisos que vio).
 *
 * En vivo: cada herramienta que ejecuta el conector llega como «mcp_activity.recorded»; la pantalla pide sólo lo más
 * nuevo (`after`) y lo pone arriba. «Pausar» retiene las nuevas (se cuentan) hasta reanudar. «Proyectar» pone la
 * pantalla en tinta, a pantalla completa y sin cifras ni filtros, para enseñarla en una demo.
 *
 * Todo lo que viene del servidor es texto y la plantilla lo escapa: los textos de un recorrido, una respuesta o una
 * nota pudo escribirlos el asistente, y son datos, nunca instrucciones.
 */
import { html, render, when } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { isAbort } from '../../kit/api.js';
import { dialog } from '../../kit/components/dialog.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';
import { countKinds, groupSessions, kindOf } from '../../kit/shared/live-sessions.js';

const HORA = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' });
const DIA = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
const hora = t => (t ? HORA.format(new Date(t)) : '—');
const MISMO_DIA = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const dia = t => {
  const ahora = Date.now();
  if (MISMO_DIA(t, ahora)) return 'Hoy';
  if (MISMO_DIA(t, ahora - 86_400_000)) return 'Ayer';
  return DIA.format(new Date(t));
};
// Clase de acción → cómo se ve (ícono, nombre y tono). Los tonos son los pasteles de Tinta.
const CLASE = {
  read: { icono: '👁', nombre: 'Leyó', tono: 'sky' },
  create: { icono: '✎', nombre: 'Creó', tono: 'mint' },
  write: { icono: '✎', nombre: 'Guardó', tono: 'lilac' },
  propose: { icono: '✋', nombre: 'Propuso', tono: 'butter' },
  deny: { icono: '⊘', nombre: 'Rechazada', tono: 'peach' },
};
const CHIP = {
  pending: 'k-chip--warn',
  approving: 'k-chip--sky',
  approved: 'k-chip--ok',
  rejected: 'k-chip--draft',
  withdrawn: 'k-chip--draft',
  expired: 'k-chip--draft',
  stale: 'k-chip--lilac',
  failed: 'k-chip--bad',
};
let enVivo = null;

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let montado = true;
    // Estado de la pantalla. `items` va de la más nueva a la más antigua (id descendente), sin repetidos.
    const st = {
      cargado: false,
      allowed: true,
      items: [],
      brands: [],
      sources: [],
      last24h: null,
      propuestas: { pending: [], history: [] },
      filtros: { marca: '', clases: new Set(['read', 'create', 'write', 'propose', 'deny']) },
      seleccion: null, // id de la fila elegida
      fila: null, // la fila (o una fila armada desde «Creado») de la que se muestra la tarjeta
      detalle: null, // { estado: 'cargando' | 'ok' | 'error' | 'nada', entidad?, error? }
      creado: [], // lo que dejó el asistente y sigue existiendo (GET /api/mcp-live/created)
      creadoAbierto: globalThis.matchMedia?.('(min-width: 901px)').matches ?? true,
      diagramaPrevio: null, // { clave, ids } para animar los pasos nuevos de un recorrido que se está armando
      nuevas: new Set(), // ids que llegaron en vivo (para la entrada animada)
      pausado: false,
      retenidas: 0,
      presentacion: false,
      panelAbierto: false,
    };
    const marcaCtx = ctx.brand && ctx.brand !== 'all' ? ctx.brand : '';
    const qs = extra => {
      const p = new URLSearchParams();
      if (marcaCtx) p.set('brand', marcaCtx);
      for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
      const s = p.toString();
      return s ? '?' + s : '';
    };
    const cache = new Map(); // «tipo:id» → entidad leída (se vacía al llegar un cambio de propuestas)

    render(
      root,
      html`<section class="k-page av-page">
        <header class="k-head av-head">
          <div class="av-head__texto">
            <span class="k-eyebrow">Ajustes</span>
            <h1 class="av-titulo">
              Asistente en vivo
              <span class="av-vivo" data-slot="vivo"><i aria-hidden="true"></i> En vivo</span>
            </h1>
            <p class="k-lead av-lead">
              Lo que hace el asistente conectado, al momento y por sesiones de trabajo. Toca una acción para ver lo que
              dejó; las propuestas se aprueban aquí mismo, a tu nombre.
            </p>
          </div>
          <div class="k-actions av-acciones">
            <button type="button" class="k-btn av-pausa" data-do="pausar" aria-pressed="false">Pausar</button>
            <button type="button" class="k-btn k-btn--accent" data-do="presentar" aria-pressed="false">
              Proyectar
            </button>
          </div>
        </header>
        <div data-slot="cifras"></div>
        <div data-slot="filtros"></div>
        <div class="av-cols">
          <div class="av-linea" data-slot="linea"></div>
          <div class="av-lado">
            <section class="av-creado" data-slot="creado" aria-label="Creado por el asistente"></section>
            <aside class="av-panel" data-slot="panel" aria-label="Lo que dejó esta acción"></aside>
          </div>
        </div>
      </section>`,
    );
    const pagina = root.querySelector('.av-page');
    const slot = n => root.querySelector(`[data-slot="${n}"]`);
    render(slot('linea'), loading('Cargando la actividad del asistente…'));

    // ---- propuestas: por id y por entidad propuesta (para ligar «creó X» con «propuso publicar X»)
    const porId = () => new Map([...st.propuestas.pending, ...st.propuestas.history].map(p => [p.id, p]));
    const pendientePara = entidad =>
      entidad && st.propuestas.pending.find(p => p.entity?.id === entidad.id && p.entity?.type !== 'proposal');

    // ---- cifras (últimas 24 h) y filtros
    function pintarCifras() {
      const c = st.last24h;
      if (!c) return render(slot('cifras'), html``);
      render(
        slot('cifras'),
        html`<div class="k-figures av-cifras" aria-label="Últimas 24 horas">
          <div class="k-figure" data-tone="lime">
            <span class="k-figure__label">Últimas 24 horas</span>
            <span class="k-figure__value">${c.actions}</span>
            <span class="k-figure__sub">acciones del asistente</span>
          </div>
          <div class="k-figure" data-tone="sky">
            <span class="k-figure__label">Consultas</span>
            <span class="k-figure__value">${c.reads}</span>
            <span class="k-figure__sub">cursos, pedidos, conversaciones y cifras leídos</span>
          </div>
          <div class="k-figure" data-tone="mint">
            <span class="k-figure__label">Creado</span>
            <span class="k-figure__value">${c.creates}</span>
            <span class="k-figure__sub">borradores y cambios para revisar</span>
          </div>
          <div class="k-figure" data-tone="butter">
            <span class="k-figure__label">Esperan tu decisión</span>
            <span class="k-figure__value">${st.propuestas.pending.length}</span>
            <span class="k-figure__sub">propuestas pendientes</span>
          </div>
        </div>`,
      );
    }
    function pintarFiltros() {
      const f = st.filtros;
      render(
        slot('filtros'),
        html`<div class="k-filterbar av-filtros" role="group" aria-label="Filtros">
          ${when(
            st.brands.length > 1 && !marcaCtx,
            () =>
              html`<span class="av-filtros__grupo">
                <button type="button" class="k-filter" data-do="marca" data-id="" aria-pressed="${f.marca === ''}">
                  Todas las marcas
                </button>
                ${st.brands.map(
                  b =>
                    html`<button type="button" class="k-filter" data-do="marca" data-id="${b.id}" aria-pressed="${f.marca === b.id}">
                      ${b.name}
                    </button>`,
                )}
              </span>`,
          )}
          <span class="av-filtros__grupo av-filtros__clases">
            ${[
              ['read', 'Lee'],
              ['create', 'Crea'],
              ['propose', 'Propone'],
              ['deny', 'Rechazadas'],
            ].map(
              ([k, t]) =>
                html`<button type="button" class="k-filter av-clase" data-do="clase" data-id="${k}" aria-pressed="${f.clases.has(k)}">
                  <i class="av-punto" data-tone="${CLASE[k].tono}" aria-hidden="true"></i>${t}
                </button>`,
            )}
          </span>
        </div>`,
      );
    }

    // ---- línea de tiempo
    const visibles = () =>
      st.items.filter(r => {
        if (st.filtros.marca && r.brandId !== st.filtros.marca) return false;
        const k = kindOf(r);
        return st.filtros.clases.has(k === 'write' ? 'create' : k);
      });
    function fila(r) {
      const k = kindOf(r);
      const c = CLASE[k];
      const p = r.entity?.type === 'proposal' ? porId().get(r.entity.id) : null;
      return html`<button
        type="button"
        class="av-ev ${st.nuevas.has(r.id) ? 'av-ev--nueva' : ''}"
        data-do="ver"
        data-id="${r.id}"
        data-key="${r.id}"
        aria-pressed="${st.seleccion === r.id}"
      >
        <span class="av-ic" data-tone="${c.tono}" aria-hidden="true">${c.icono}</span>
        <span class="av-ev__texto">
          <strong class="av-ev__que">${r.text}</strong>
          <span class="av-ev__como">
            ${r.tool ? html`<code class="av-tool">${r.tool}</code>` : ''}${
              r.entity ? html` · ${r.entity.label}` : ''
            }${r.detail ? html` · ${r.detail}` : ''}
          </span>
        </span>
        <span class="av-ev__hora">
          <span class="k-sr">${c.nombre} a las </span>${hora(r.at)}
          ${when(p, () => html`<span class="k-chip ${CHIP[p.status] || ''} av-estado">${p.statusLabel}</span>`)}
        </span>
      </button>`;
    }
    function sesion(s) {
      const c = s.counts;
      const partes = [
        c.read ? `${c.read} ${c.read === 1 ? 'consulta' : 'consultas'}` : '',
        c.create + c.write ? `${c.create + c.write} ${c.create + c.write === 1 ? 'cambio' : 'cambios'}` : '',
        c.propose ? `${c.propose} ${c.propose === 1 ? 'propuesta' : 'propuestas'}` : '',
        c.deny ? `${c.deny} ${c.deny === 1 ? 'rechazada' : 'rechazadas'}` : '',
      ].filter(Boolean);
      const activa = Date.now() - s.endedAt < 15 * 60_000;
      return html`<section class="k-card av-sesion" data-key="${s.key}" aria-label="Sesión ${dia(s.startedAt)} ${hora(s.startedAt)}">
        <header class="av-sesion__cab">
          <h2 class="av-sesion__titulo">${dia(s.startedAt)} · ${hora(s.startedAt)}</h2>
          <span class="k-hint av-sesion__meta">
            ${s.brandName} · ${partes.join(' · ') || 'sin acciones'}${activa ? ' · sigue activa' : ''}
          </span>
          <span class="av-quien">
            <span class="av-quien__av" aria-hidden="true">${(s.source?.name || 'A').slice(0, 1).toUpperCase()}</span>
            <span>${s.source?.name || 'Asistente'}${s.userName ? ` · ${s.userName}` : ''}</span>
          </span>
        </header>
        <div class="av-sesion__filas">${s.items.map(fila)}</div>
      </section>`;
    }
    function pintarLinea() {
      if (!st.allowed) {
        render(
          slot('linea'),
          html`<div class="k-card">
            ${empty({
              title: 'No administras las llaves de ninguna marca',
              text: 'Ver lo que hace el asistente pide poder administrar las llaves y los asistentes conectados de esa marca.',
            })}
          </div>`,
        );
        return;
      }
      const lista = visibles();
      const sesiones = groupSessions(lista);
      render(
        slot('linea'),
        html`${when(
          st.retenidas > 0,
          () =>
            html`<button type="button" class="k-btn k-btn--primary av-retenidas" data-do="reanudar">
              ${st.retenidas} ${st.retenidas === 1 ? 'acción nueva retenida' : 'acciones nuevas retenidas'} · Reanudar
            </button>`,
        )}
        ${when(
          sesiones.length,
          () => html`<div class="k-stack av-sesiones">${sesiones.map(sesion)}</div>`,
          () =>
            html`<div class="k-card">
              ${empty({
                title: st.items.length ? 'Nada con estos filtros' : 'Todavía no hay actividad',
                text: st.items.length
                  ? 'Enciende más clases de acción o cambia de marca.'
                  : 'Cuando un asistente conectado use el conector, sus acciones aparecerán aquí al momento.',
              })}
            </div>`,
        )}`,
      );
    }

    // ---- tarjeta de lo que dejó
    const valor = v =>
      String(v ?? '').length > 400
        ? html`<details class="av-largo"><summary>Ver completo (${String(v).length} caracteres)</summary><span>${v}</span></details>`
        : html`${v}`;
    const lineas = items =>
      html`<dl class="av-lineas">
        ${items.map(d => html`<div class="av-linea-dato"><dt>${d.label}</dt><dd>${valor(d.value)}</dd></div>`)}
      </dl>`;
    const envios = s =>
      html`<section class="av-bloque" aria-label="${s.title}">
        <p class="k-eyebrow av-bloque__titulo">${s.title}</p>
        <ol class="av-pasos">
          ${s.items.map(d => html`<li class="av-paso"><strong>${d.label}</strong><span>${valor(d.value)}</span></li>`)}
        </ol>
        ${when(s.more > 0, () => html`<p class="k-hint">y ${s.more} más (ábrelo en su pantalla para verlo completo)</p>`)}
        <p class="k-hint">${s.note}</p>
      </section>`;
    function tarjetaPropuesta(p) {
      const bloqueada = p.problems.length > 0;
      return html`<div class="av-tarjeta" data-key="prop-${p.id}">
        <div class="av-tarjeta__cab">
          <span class="av-ic av-ic--grande" data-tone="butter" aria-hidden="true">✋</span>
          <div>
            <span class="k-eyebrow">Propuesta · ${hora(p.createdAt)}</span>
            <h2 class="av-tarjeta__titulo">${p.title}</h2>
          </div>
          <button type="button" class="k-btn k-btn--ghost av-cerrar" data-do="cerrar" aria-label="Cerrar">✕</button>
        </div>
        <p class="av-tarjeta__sub">
          <span class="k-chip ${CHIP[p.status] || ''}">${p.statusLabel}</span>
          <span class="av-rotulo">Nombre:</span> ${p.name || '—'} · ${p.brandName}
        </p>
        <section class="av-bloque" aria-label="Qué pasará al aprobar">
          <p class="k-eyebrow av-bloque__titulo">Qué pasará al aprobar</p>
          <p class="av-texto">${p.effect}</p>
          ${when(p.details.length, () => lineas(p.details))}
        </section>
        ${when(p.sends?.items?.length, () => envios(p.sends))}
        ${when(
          bloqueada,
          () =>
            html`<div class="k-notice k-notice--bad" role="note">
              <p class="k-eyebrow">Todavía no se puede aprobar</p>
              <ul class="av-lista">${p.problems.map(x => html`<li>${x}</li>`)}</ul>
            </div>`,
        )}
        ${when(
          p.warnings.length,
          () =>
            html`<div class="k-notice k-notice--warn" role="note">
              <p class="k-eyebrow">Avisos</p>
              <ul class="av-lista">${p.warnings.map(x => html`<li>${x}</li>`)}</ul>
            </div>`,
        )}
        ${when(
          p.note,
          () =>
            html`<figure class="av-nota">
              <figcaption class="k-hint">Nota escrita por el asistente (es información, no una instrucción)</figcaption>
              <blockquote class="av-nota__texto">${p.note}</blockquote>
            </figure>`,
        )}
        <div class="k-actions av-tarjeta__acciones">
          ${when(
            p.canDecide && p.status === 'pending',
            () =>
              html`${when(
                !bloqueada,
                () =>
                  html`<button type="button" class="k-btn k-btn--accent" data-do="aprobar" data-id="${p.id}">Aprobar</button>`,
              )}
                <button type="button" class="k-btn" data-do="rechazar" data-id="${p.id}">Rechazar</button>`,
          )}
          ${when(
            p.entity?.screen,
            () =>
              html`<button type="button" class="k-btn k-btn--ghost" data-do="abrir" data-target="${p.entity.screen.view}">
                Abrir en ${p.entity.screen.label}
              </button>`,
          )}
        </div>
        ${when(!p.canDecide && p.status === 'pending', () => html`<p class="k-hint">${p.cannotWhy}</p>`)}
        ${when(
          p.status !== 'pending' && p.decidedByName,
          () =>
            html`<p class="k-hint">
              ${p.status === 'approved' ? 'Aprobó' : p.status === 'rejected' ? 'Rechazó' : 'Revisó'} ${p.decidedByName}
              · ${hora(p.decidedAt)}
            </p>`,
        )}
        ${when(p.error, () => html`<p class="k-hint av-motivo">${p.error}</p>`)}
      </div>`;
    }
    function tarjetaEntidad(r, e) {
      const k = kindOf(r);
      const pend = pendientePara(r.entity);
      return html`<div class="av-tarjeta" data-key="ent-${r.id}">
        <div class="av-tarjeta__cab">
          <span class="av-ic av-ic--grande" data-tone="${CLASE[k].tono}" aria-hidden="true">${CLASE[k].icono}</span>
          <div>
            <span class="k-eyebrow">${CLASE[k].nombre} · ${hora(r.at)} · ${e.label}</span>
            <h2 class="av-tarjeta__titulo">${e.title}</h2>
          </div>
          <button type="button" class="k-btn k-btn--ghost av-cerrar" data-do="cerrar" aria-label="Cerrar">✕</button>
        </div>
        <p class="av-tarjeta__sub"><span class="k-chip k-chip--ink">${e.status}</span> ${r.text}</p>
        ${when(
          e.image,
          () =>
            html`<figure class="av-imagen">
              <img class="av-imagen__img" src="${e.image}" alt="Imagen de ${e.title}" loading="lazy" />
            </figure>`,
        )}
        ${when(e.diagram?.nodes?.length, () => diagrama(e.diagram, `${r.brandId}:${e.type}:${r.entity.id}`))}
        ${when(e.lines.length, () => html`<section class="av-bloque"><p class="k-eyebrow av-bloque__titulo">Tal como quedó</p>${lineas(e.lines)}</section>`)}
        ${when(e.sends?.items?.length, () => envios(e.sends))}
        ${when(
          pend,
          () =>
            html`<div class="k-notice k-notice--warn" role="note">
              <p>Hay una propuesta pendiente sobre esto: <strong>${pend.title}</strong>.</p>
              <button type="button" class="k-btn" data-do="ver-propuesta" data-id="${pend.id}">Ver la propuesta</button>
            </div>`,
        )}
        <div class="k-actions av-tarjeta__acciones">
          ${when(
            e.screen,
            () =>
              html`<button type="button" class="k-btn k-btn--primary" data-do="abrir" data-target="${e.screen.view}">
                Abrir en ${e.screen.label}
              </button>`,
          )}
        </div>
      </div>`;
    }
    function tarjetaSimple(r, texto) {
      const k = kindOf(r);
      return html`<div class="av-tarjeta" data-key="simple-${r.id}">
        <div class="av-tarjeta__cab">
          <span class="av-ic av-ic--grande" data-tone="${CLASE[k].tono}" aria-hidden="true">${CLASE[k].icono}</span>
          <div>
            <span class="k-eyebrow">${CLASE[k].nombre} · ${hora(r.at)}</span>
            <h2 class="av-tarjeta__titulo">${r.text}</h2>
          </div>
          <button type="button" class="k-btn k-btn--ghost av-cerrar" data-do="cerrar" aria-label="Cerrar">✕</button>
        </div>
        ${when(r.detail, () => html`<p class="av-tarjeta__sub">${r.detail}</p>`)}
        <section class="av-bloque">
          <p class="k-eyebrow av-bloque__titulo">${k === 'deny' ? 'Por qué' : 'Qué pasó'}</p>
          <p class="av-texto">${texto}</p>
        </section>
        <p class="k-hint">
          ${r.source?.name || 'Asistente'} (${r.source?.kind === 'oauth' ? 'asistente conectado' : 'llave de la API'})${
            r.userName ? ` de ${r.userName}` : ''
          }
          · ${r.brandName}
        </p>
      </div>`;
    }
    // ---- lo ya creado, a un lado: una entrada por entidad, agrupadas por tipo
    const ESTADO_CHIP = estado =>
      /pendiente|borrador|apagad/i.test(estado)
        ? 'k-chip--draft'
        : /activ|publicad|encendid|aprobad/i.test(estado)
          ? 'k-chip--ok'
          : 'k-chip--lilac';
    function pintarCreado() {
      const lista = st.creado.filter(x => !st.filtros.marca || x.brandId === st.filtros.marca);
      const grupos = new Map();
      for (const x of lista) {
        if (!grupos.has(x.label)) grupos.set(x.label, []);
        grupos.get(x.label).push(x);
      }
      const sel = st.fila?.entity;
      render(
        slot('creado'),
        html`<button type="button" class="av-creado__cab" data-do="plegar-creado" aria-expanded="${st.creadoAbierto}">
            <span class="k-eyebrow">Creado por el asistente</span>
            <strong class="av-creado__n">${lista.length}</strong>
            <span class="av-creado__flecha" aria-hidden="true">${st.creadoAbierto ? '▾' : '▸'}</span>
          </button>
          ${when(
            st.creadoAbierto,
            () =>
              html`<div class="av-creado__cuerpo">
                ${when(
                  !lista.length,
                  () => html`<p class="k-hint">Cuando el asistente deje un borrador, aparecerá aquí.</p>`,
                )}
                ${[...grupos.entries()].map(
                  ([label, items]) =>
                    html`<div class="av-creado__grupo">
                      <span class="av-creado__tipo">${label}${items.length > 1 ? ` · ${items.length}` : ''}</span>
                      ${items.map(
                        x =>
                          html`<button
                            type="button"
                            class="av-creado__item"
                            data-do="ver-creado"
                            data-type="${x.type}"
                            data-id="${x.id}"
                            data-brand="${x.brandId}"
                            data-key="${x.brandId}:${x.type}:${x.id}"
                            aria-pressed="${Boolean(sel && sel.type === x.type && sel.id === x.id)}"
                          >
                            <span class="av-creado__titulo">${x.title}</span>
                            <span class="av-creado__meta">
                              <span class="k-chip ${ESTADO_CHIP(x.status)}">${x.status}</span>
                              ${when(x.proposalId, () => html`<span class="k-chip k-chip--warn">Propuesta pendiente</span>`)}
                              <span class="k-hint">${dia(x.lastAt)} ${hora(x.lastAt)}</span>
                            </span>
                          </button>`,
                      )}
                    </div>`,
                )}
              </div>`,
          )}`,
      );
    }

    // ---- el recorrido como diagrama: columnas por profundidad, flechas en SVG dibujadas tras pintar
    const TONO_PASO = {
      start: 'ink',
      message: 'sky',
      buttons: 'sky',
      list: 'sky',
      question: 'sky',
      course_card: 'mint',
      price: 'mint',
      syllabus: 'mint',
      schedule: 'mint',
      enroll: 'lime',
      choose_course: 'mint',
      handoff: 'peach',
      end: 'soft',
      sequence: 'butter',
      template: 'butter',
      file: 'butter',
      assistant: 'lilac',
      goto_flow: 'lilac',
      delay: 'soft',
    };
    function diagrama(d, clave) {
      const previos = st.diagramaPrevio?.clave === clave ? st.diagramaPrevio.ids : null;
      st.diagramaPrevio = { clave, ids: new Set(d.nodes.map(n => n.id)) };
      const columnas = new Map();
      for (const n of d.nodes) {
        if (!columnas.has(n.depth)) columnas.set(n.depth, []);
        columnas.get(n.depth).push(n);
      }
      return html`<section class="av-bloque av-bloque--diag" aria-label="Diagrama del recorrido">
        <p class="k-eyebrow av-bloque__titulo">Cómo va el recorrido · ${d.nodes.length} ${d.nodes.length === 1 ? 'paso' : 'pasos'}</p>
        <div class="av-diag" data-edges="${JSON.stringify(d.edges)}">
          <svg class="av-diag__svg" aria-hidden="true"></svg>
          ${[...columnas.keys()]
            .sort((a, b) => a - b)
            .map(
              k =>
                html`<div class="av-diag__col">
                  ${columnas.get(k).map(
                    n =>
                      html`<div
                        class="av-nodo ${previos && !previos.has(n.id) ? 'av-nodo--nuevo' : ''}"
                        data-id="${n.id}"
                        data-tone="${TONO_PASO[n.type] || 'soft'}"
                      >
                        <span class="av-nodo__tipo">${n.label}</span>
                        ${when(n.title, () => html`<strong class="av-nodo__titulo">${n.title}</strong>`)}
                        ${when(n.text, () => html`<span class="av-nodo__texto">${n.text}</span>`)}
                      </div>`,
                  )}
                </div>`,
            )}
        </div>
        ${when(d.truncated, () => html`<p class="k-hint">Se muestran los primeros pasos; ábrelo en Automatización para verlo completo.</p>`)}
        <div class="k-actions">
          <button type="button" class="k-btn" data-do="ampliar-diagrama">Ver grande</button>
        </div>
      </section>`;
    }
    function dibujarFlechas() {
      for (const caja of root.querySelectorAll('.av-diag')) dibujarFlechasEn(caja);
    }
    function dibujarFlechasEn(caja) {
      const svg = caja?.querySelector('.av-diag__svg');
      if (!caja || !svg) return;
      let edges = [];
      try {
        edges = JSON.parse(caja.dataset.edges || '[]');
      } catch {
        edges = [];
      }
      const origen = caja.getBoundingClientRect();
      const rect = id => {
        const el = caja.querySelector(`.av-nodo[data-id="${CSS.escape(id)}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.left - origen.left + caja.scrollLeft,
          y: r.top - origen.top + caja.scrollTop,
          w: r.width,
          h: r.height,
        };
      };
      svg.setAttribute('width', caja.scrollWidth);
      svg.setAttribute('height', caja.scrollHeight);
      svg.setAttribute('viewBox', `0 0 ${caja.scrollWidth} ${caja.scrollHeight}`);
      const ns = 'http://www.w3.org/2000/svg';
      svg.replaceChildren();
      for (const e of edges) {
        const a = rect(e.from);
        const b = rect(e.to);
        if (!a || !b) continue;
        const x1 = a.x + a.w;
        const y1 = a.y + a.h / 2;
        const x2 = b.x;
        const y2 = b.y + b.h / 2;
        const dx = Math.max(24, (x2 - x1) / 2);
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
        path.setAttribute('class', 'av-flecha');
        svg.appendChild(path);
        if (e.label) {
          const t = document.createElementNS(ns, 'text');
          t.setAttribute('x', (x1 + x2) / 2);
          t.setAttribute('y', (y1 + y2) / 2 - 6);
          t.setAttribute('class', 'av-flecha__texto');
          t.setAttribute('text-anchor', 'middle');
          t.textContent = e.label;
          svg.appendChild(t);
        }
      }
    }
    // con un temporizador y no con requestAnimationFrame: éste no corre en una pestaña en segundo plano
    const redibujar = () => setTimeout(dibujarFlechas, 0);
    // al cambiar el ancho (la columna o la ventana) las flechas se vuelven a trazar
    const observador = typeof ResizeObserver === 'function' ? new ResizeObserver(redibujar) : null;
    observador?.observe(root);
    ctx.onUnmount(() => observador?.disconnect());

    function pintarPanel() {
      const panel = slot('panel');
      panel.classList.toggle('av-panel--abierto', st.panelAbierto);
      const r = st.fila;
      if (!r) {
        render(panel, html`<p class="av-vacio">Toca una acción para ver lo que dejó.</p>`);
        return;
      }
      const d = st.detalle;
      if (!d || d.estado === 'cargando') return render(panel, loading('Leyendo lo que dejó…'));
      if (d.estado === 'propuesta') return render(panel, tarjetaPropuesta(d.propuesta));
      if (d.estado === 'ok') {
        render(panel, tarjetaEntidad(r, d.entidad));
        if (d.entidad.diagram) redibujar();
        return;
      }
      if (d.estado === 'error')
        return render(
          panel,
          html`<div class="av-tarjeta">${failure({ title: 'No se pudo leer lo que dejó', error: d.error, retry: 'reintentar' })}</div>`,
        );
      // sin entidad: una consulta, una acción rechazada o una escritura que no dejó nada que mostrar
      const k = kindOf(r);
      const texto =
        k === 'deny'
          ? 'El CRM la rechazó antes de hacer nada y quedó registrada. ' + (r.text || '')
          : k === 'read'
            ? 'Sólo lectura: nada cambió. El asistente consulta el CRM para no inventar datos.'
            : d.estado === 'nada'
              ? 'Lo que dejó ya no existe en esta marca o no se puede mostrar.'
              : 'Una acción sin nada que mostrar.';
      render(panel, tarjetaSimple(r, texto));
    }
    function pintar() {
      pintarCifras();
      pintarFiltros();
      pintarLinea();
      pintarCreado();
      pintarPanel();
    }

    // ---- datos
    async function cargar() {
      try {
        const d = await api.get('/api/mcp-live' + qs());
        if (!montado) return;
        st.cargado = true;
        st.allowed = d.allowed;
        st.items = d.items;
        st.brands = d.brands;
        st.sources = d.sources;
        st.last24h = d.last24h;
        st.propuestas = d.proposals;
        st.nuevas = new Set();
        cache.clear();
        pintar();
      } catch (error) {
        if (montado && !isAbort(error))
          render(slot('linea'), failure({ title: 'No se pudo cargar la actividad', error, retry: 'reintentar' }));
        return;
      }
      cargarCreado();
    }
    async function cargarCreado() {
      try {
        const d = await api.get('/api/mcp-live/created' + qs());
        if (!montado) return;
        st.creado = d.items;
        pintarCreado();
      } catch (error) {
        if (!isAbort(error)) console.error(error);
      }
    }
    // Sólo lo más nuevo que lo que ya se tiene: va arriba, con su entrada animada, y suma a las cifras.
    let pidiendo = null;
    async function alDia() {
      if (pidiendo) return pidiendo;
      pidiendo = (async () => {
        try {
          const maxId = st.items.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
          const d = await api.get('/api/mcp-live' + qs({ after: String(maxId) }));
          if (!montado) return;
          const vistos = new Set(st.items.map(r => r.id));
          const frescos = (d.items || []).filter(r => !vistos.has(r.id));
          if (!frescos.length) return;
          for (const r of frescos) st.nuevas.add(r.id);
          st.items = [...frescos, ...st.items].sort((a, b) => Number(b.id) - Number(a.id));
          if (st.last24h) {
            const c = countKinds(frescos);
            st.last24h = {
              ...st.last24h,
              actions: st.last24h.actions + c.total,
              reads: st.last24h.reads + c.read,
              creates: st.last24h.creates + c.create,
              proposes: st.last24h.proposes + c.propose,
              denied: st.last24h.denied + c.deny,
            };
          }
          pintar();
          const escrituras = frescos.filter(r => r.kind === 'write' && r.outcome === 'ok' && r.entity);
          if (escrituras.length) {
            cargarCreado();
            const e = st.fila?.entity;
            if (e && escrituras.some(r => r.entity.type === e.type && r.entity.id === e.id)) {
              cache.delete(`${st.fila.brandId}:${e.type}:${e.id}`);
              refrescarTarjeta();
            }
          }
        } catch (error) {
          if (!isAbort(error)) console.error(error);
        } finally {
          pidiendo = null;
        }
      })();
      return pidiendo;
    }
    async function recargarPropuestas() {
      try {
        const d = await api.get('/api/mcp-live/proposals' + qs());
        if (!montado) return;
        st.propuestas = d;
        cache.clear();
        cargarCreado();
        if (st.detalle?.estado === 'propuesta') {
          const p = porId().get(st.detalle.propuesta.id);
          st.detalle = p ? { estado: 'propuesta', propuesta: p } : st.detalle;
        }
        pintar();
      } catch (error) {
        if (!isAbort(error)) console.error(error);
      }
    }
    async function ver(elegido) {
      // los ids llegan como número del servidor y como texto del data-id
      const r = st.items.find(x => String(x.id) === String(elegido));
      if (!r) return;
      const id = r.id;
      st.seleccion = id;
      st.fila = r;
      st.panelAbierto = true;
      st.nuevas.delete(id);
      if (r.entity?.type === 'proposal') {
        const p = porId().get(r.entity.id);
        st.detalle = p ? { estado: 'propuesta', propuesta: p } : { estado: 'nada' };
        return pintar();
      }
      if (!r.entity || r.outcome !== 'ok') {
        st.detalle = { estado: 'simple' };
        return pintar();
      }
      const clave = `${r.brandId}:${r.entity.type}:${r.entity.id}`;
      if (cache.has(clave)) {
        st.detalle = cache.get(clave);
        return pintar();
      }
      st.detalle = { estado: 'cargando' };
      pintar();
      await leerEntidad(r, clave);
    }
    async function leerEntidad(r, clave) {
      try {
        const d = await api.get(
          `/api/mcp-live/entity/${encodeURIComponent(r.entity.type)}/${encodeURIComponent(r.entity.id)}?brand=${encodeURIComponent(r.brandId)}`,
        );
        if (!montado || st.fila !== r) return;
        st.detalle = { estado: 'ok', entidad: d.entity };
        cache.set(clave, st.detalle);
      } catch (error) {
        if (isAbort(error) || !montado || st.fila !== r) return;
        st.detalle = error?.status === 404 ? { estado: 'nada' } : { estado: 'error', error };
      }
      pintar();
    }
    // Una entrada de «Creado»: se muestra como si fuera la fila que la dejó.
    function verCreado(x) {
      const fila = {
        id: `creado:${x.brandId}:${x.type}:${x.id}`,
        at: x.lastAt,
        brandId: x.brandId,
        brandName: st.brands.find(b => b.id === x.brandId)?.name ?? x.brandId,
        kind: 'write',
        outcome: 'ok',
        text: `Lo dejó el asistente (${x.touches} ${x.touches === 1 ? 'vez' : 'veces'})`,
        entity: { type: x.type, id: x.id, label: x.label },
      };
      st.seleccion = null;
      st.fila = fila;
      st.panelAbierto = true;
      const clave = `${x.brandId}:${x.type}:${x.id}`;
      if (cache.has(clave)) {
        st.detalle = cache.get(clave);
        return pintar();
      }
      st.detalle = { estado: 'cargando' };
      pintar();
      leerEntidad(fila, clave);
    }
    // Vuelve a leer la tarjeta abierta sin cambiar la selección (un recorrido que se está armando cambia en vivo).
    function refrescarTarjeta() {
      const r = st.fila;
      if (!r?.entity || r.entity.type === 'proposal') return;
      leerEntidad(r, `${r.brandId}:${r.entity.type}:${r.entity.id}`);
    }
    async function decidir(id, aprobar) {
      const p = porId().get(id);
      if (!p) return;
      const eleccion = await dialog({
        title: aprobar ? 'Aprobar propuesta' : 'Rechazar propuesta',
        content: html`<p class="av-confirma__accion">${p.title}</p>
          <dl class="av-confirma">
            <dt>Nombre</dt>
            <dd class="av-confirma__nombre">${p.name || '—'}</dd>
          </dl>
          <p>${aprobar ? 'Se hará ahora, a tu nombre.' : 'No se hará nada y la propuesta pasa al historial.'}</p>`,
        actions: [
          { id: 'no', label: 'Cancelar', autofocus: !aprobar },
          { id: 'si', label: aprobar ? 'Aprobar' : 'Rechazar', primary: aprobar, danger: !aprobar, autofocus: aprobar },
        ],
      });
      if (eleccion !== 'si' || !montado) return;
      try {
        await api.post(
          `/api/mcp-proposals/${id}/${aprobar ? 'approve' : 'reject'}`,
          aprobar ? { warningsSeen: p.warnings } : {},
        );
        ctx.toast(aprobar ? 'Propuesta aprobada: ya se aplicó.' : 'Propuesta rechazada.');
      } finally {
        await recargarPropuestas();
      }
    }
    function presentar(encender) {
      st.presentacion = encender;
      pagina.classList.toggle('av-present', encender);
      root.querySelector('[data-do="presentar"]').setAttribute('aria-pressed', String(encender));
      root.querySelector('[data-do="presentar"]').textContent = encender ? 'Dejar de proyectar' : 'Proyectar';
      if (encender) pagina.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement === pagina) document.exitFullscreen?.().catch(() => {});
    }
    const alSalirPantallaCompleta = () => {
      if (st.presentacion && !document.fullscreenElement) presentar(false);
    };
    // el evento sube desde la página hasta la raíz: no hace falta escuchar en document
    root.addEventListener('fullscreenchange', alSalirPantallaCompleta);
    ctx.onUnmount(() => root.removeEventListener('fullscreenchange', alSalirPantallaCompleta));

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: () => (st.seleccion && st.detalle?.estado === 'error' ? ver(st.seleccion) : cargar()),
            ver: (_e, b) => ver(b.dataset.id),
            'ver-propuesta': (_e, b) => {
              const fila = st.items.find(r => r.entity?.type === 'proposal' && r.entity.id === b.dataset.id);
              if (fila) return ver(fila.id);
              const p = porId().get(b.dataset.id);
              if (p) {
                st.detalle = { estado: 'propuesta', propuesta: p };
                pintar();
              }
            },
            cerrar: () => {
              st.panelAbierto = false;
              st.seleccion = null;
              st.fila = null;
              st.detalle = null;
              pintar();
            },
            'ver-creado': (_e, b) => {
              const x = st.creado.find(
                y => y.type === b.dataset.type && y.id === b.dataset.id && y.brandId === b.dataset.brand,
              );
              if (x) verCreado(x);
            },
            'ampliar-diagrama': () => {
              const e = st.detalle?.entidad;
              if (!e?.diagram) return;
              const previo = st.diagramaPrevio;
              // la ventana vive fuera de la raíz: se pinta con mount() y sus flechas se trazan ahí dentro
              dialog({
                title: `Recorrido «${e.title}»`,
                wide: true,
                mount: cuerpo => {
                  render(cuerpo, html`<div class="av-diag-grande">${diagrama(e.diagram, 'grande:' + e.title)}</div>`);
                  st.diagramaPrevio = previo; // la ventana no cuenta para animar lo nuevo de la tarjeta
                  setTimeout(() => dibujarFlechasEn(cuerpo.querySelector('.av-diag')), 0);
                },
                actions: [{ id: 'ok', label: 'Cerrar', primary: true, autofocus: true }],
              }).then(() => redibujar());
            },
            'plegar-creado': () => {
              st.creadoAbierto = !st.creadoAbierto;
              pintarCreado();
            },
            marca: (_e, b) => {
              st.filtros.marca = b.dataset.id;
              pintar();
            },
            clase: (_e, b) => {
              const k = b.dataset.id;
              if (st.filtros.clases.has(k)) st.filtros.clases.delete(k);
              else st.filtros.clases.add(k);
              if (k === 'create')
                st.filtros.clases.has('create') ? st.filtros.clases.add('write') : st.filtros.clases.delete('write');
              pintar();
            },
            pausar: (_e, b) => {
              st.pausado = !st.pausado;
              b.setAttribute('aria-pressed', String(st.pausado));
              b.textContent = st.pausado ? 'Reanudar' : 'Pausar';
              slot('vivo').classList.toggle('av-vivo--pausa', st.pausado);
              if (!st.pausado) {
                st.retenidas = 0;
                alDia();
              }
            },
            reanudar: () => {
              st.pausado = false;
              st.retenidas = 0;
              const b = root.querySelector('[data-do="pausar"]');
              b.setAttribute('aria-pressed', 'false');
              b.textContent = 'Pausar';
              slot('vivo').classList.remove('av-vivo--pausa');
              alDia();
            },
            presentar: () => presentar(!st.presentacion),
            aprobar: (_e, b) => decidir(b.dataset.id, true),
            rechazar: (_e, b) => decidir(b.dataset.id, false),
            abrir: (_e, b) => ctx.go(b.dataset.target),
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );
    enVivo = {
      actividad() {
        if (!st.cargado || !st.allowed) return;
        if (st.pausado) {
          st.retenidas += 1;
          pintarLinea();
          return;
        }
        alDia();
      },
      propuestas: () => st.cargado && recargarPropuestas(),
    };
    ctx.onUnmount(() => {
      montado = false;
      enVivo = null;
      if (document.fullscreenElement === pagina) document.exitFullscreen?.().catch(() => {});
    });
    cargar();
  },
  /** Una herramienta ejecutada o una propuesta nueva o decidida: se pide sólo lo que cambió. */
  onEvent(evento) {
    if (!enVivo) return;
    if (evento?.type === 'mcp_activity.recorded') enVivo.actividad();
    if (evento?.type === 'mcp_proposals.changed') enVivo.propuestas();
  },
};
