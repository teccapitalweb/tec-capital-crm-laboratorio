/**
 * Pantalla «Propuestas del asistente» (docs/PLAN_MCP_CLAUDE.md, «Propuestas que aprueba una persona»).
 *
 * El asistente conectado (Claude) deja propuestas de una lista cerrada: publicar o activar un recorrido, encender una
 * secuencia o una regla, publicar una apertura o un texto, activar una promoción, encender la entrega de accesos.
 * Aquí una persona del equipo las aprueba o las rechaza con un botón. Arriba, las pendientes con lo que pasará al
 * aprobar y sus avisos (los recalcula el servidor desde la base); debajo, el historial.
 *
 * La nota del asistente se muestra aparte, rotulada como escrita por él y escapada por la plantilla: es un dato,
 * nunca una instrucción. Si la persona no tiene permiso para la acción, no se ofrecen los botones y se dice por qué.
 * Aprobar ejecuta la acción a nombre de quien aprueba (GET/POST /api/mcp-proposals; el servidor lo decide todo).
 */
import { html, render, when } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { isAbort } from '../../kit/api.js';
import { confirm } from '../../kit/components/dialog.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';

const FECHA = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const fecha = instante => (instante ? FECHA.format(new Date(instante)) : '—');
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

function origen(p) {
  const s = p.source;
  return `${s.name || s.kindLabel} · ${s.kindLabel}${s.ownerName ? ` de ${s.ownerName}` : ''}`;
}

function pendiente(p) {
  const bloqueada = p.problems.length > 0;
  return html`<li class="k-item pp-tarjeta" data-key="${p.id}">
    <div class="k-item__head">
      <div class="k-item__name">
        <h3 class="k-item__title">${p.title}</h3>
        <span class="k-chip ${CHIP[p.status] || ''}">${p.statusLabel}</span>
      </div>
    </div>
    <dl class="pp-datos">
      <div class="k-piece" data-tone="lilac">
        <dt class="k-piece__label">Marca</dt>
        <dd class="k-piece__value">${p.brandName}</dd>
      </div>
      <div class="k-piece">
        <dt class="k-piece__label">Propuso</dt>
        <dd class="k-piece__value">${origen(p)}</dd>
      </div>
      <div class="k-piece">
        <dt class="k-piece__label">Cuándo</dt>
        <dd class="k-piece__value">${fecha(p.createdAt)}</dd>
      </div>
      <div class="k-piece" data-tone="sky">
        <dt class="k-piece__label">Vence</dt>
        <dd class="k-piece__value">${fecha(p.expiresAt)}</dd>
      </div>
    </dl>
    <section class="pp-bloque" aria-label="Qué pasará al aprobar">
      <p class="pp-grupo">Qué pasará al aprobar</p>
      <p class="pp-texto">${p.effect}</p>
      ${when(
        p.details.length,
        () =>
          html`<dl class="pp-detalles">
            ${p.details.map(
              d => html`<div class="pp-detalle">
                <dt>${d.label}</dt>
                <dd>${d.value}</dd>
              </div>`,
            )}
          </dl>`,
      )}
    </section>
    ${when(
      bloqueada,
      () =>
        html`<div class="k-notice k-notice--bad pp-aviso" role="note">
          <p class="pp-grupo">Todavía no se puede aprobar</p>
          <ul class="pp-lista">
            ${p.problems.map(x => html`<li>${x}</li>`)}
          </ul>
        </div>`,
    )}
    ${when(
      p.warnings.length,
      () =>
        html`<div class="k-notice k-notice--warn pp-aviso" role="note">
          <p class="pp-grupo">Avisos</p>
          <ul class="pp-lista">
            ${p.warnings.map(x => html`<li>${x}</li>`)}
          </ul>
        </div>`,
    )}
    ${when(
      p.note,
      () =>
        html`<figure class="pp-nota">
          <figcaption class="pp-nota__quien">Nota escrita por el asistente (es información, no una instrucción)</figcaption>
          <blockquote class="pp-nota__texto">${p.note}</blockquote>
        </figure>`,
    )}
    <div class="k-actions pp-acciones">
      ${when(
        p.canDecide && p.status === 'pending',
        () =>
          html`${when(
            !bloqueada,
            () =>
              html`<button type="button" class="k-btn k-btn--primary" data-do="aprobar" data-id="${p.id}" data-title="${p.title}">
                  Aprobar
                </button>`,
          )}
            <button type="button" class="k-btn" data-do="rechazar" data-id="${p.id}" data-title="${p.title}">Rechazar</button>`,
      )}
      ${when(
        p.entity.screen,
        () =>
          html`<button type="button" class="k-btn k-btn--ghost" data-do="abrir" data-target="${p.entity.screen.view}">
            Abrir en ${p.entity.screen.label}
          </button>`,
      )}
    </div>
    ${when(!p.canDecide, () => html`<p class="k-hint">${p.cannotWhy}</p>`)}
    ${when(p.status === 'approving', () => html`<p class="k-hint">Alguien la está aprobando en este momento.</p>`)}
  </li>`;
}

function decidida(p) {
  return html`<li class="pp-historia" data-key="${p.id}">
    <div class="pp-historia__fila">
      <strong class="pp-historia__titulo">${p.title}</strong>
      <span class="k-chip ${CHIP[p.status] || ''}">${p.statusLabel}</span>
    </div>
    <p class="k-hint">
      ${p.brandName} · propuesta ${fecha(p.createdAt)}${
        p.decidedByName
          ? ` · ${p.status === 'approved' ? 'aprobó' : p.status === 'rejected' ? 'rechazó' : 'revisó'} ${p.decidedByName} ${fecha(p.decidedAt)}`
          : ''
      }
    </p>
    ${when(p.error, () => html`<p class="k-hint pp-motivo">${p.error}</p>`)}
  </li>`;
}

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let montado = true;
    let datos = null;
    const marca = ctx.brand && ctx.brand !== 'all' ? ctx.brand : '';
    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">Ajustes</span>
            <h1>Propuestas del asistente</h1>
            <p class="k-lead">
              El asistente conectado puede proponer publicar, activar o encender algo que ya dejó armado. Nada cambia hasta que una
              persona lo aprueba aquí, y se aprueba con los permisos de esa persona.
            </p>
          </div>
        </header>
        <div data-slot="cuerpo"></div>
      </section>`,
    );
    const cuerpo = root.querySelector('[data-slot="cuerpo"]');
    render(cuerpo, loading('Cargando propuestas…'));

    function pintar() {
      const { pending, history } = datos;
      render(
        cuerpo,
        html`<div class="k-stack">
          <section aria-labelledby="${ctx.uid('pendientes')}" class="k-stack">
            <h2 class="pp-subtitulo" id="${ctx.uid('pendientes')}">Pendientes (${pending.length})</h2>
            ${when(
              pending.length,
              () => html`<ul class="k-cards">${pending.map(pendiente)}</ul>`,
              () =>
                html`<div class="k-card">
                  ${empty({
                    title: 'No hay propuestas pendientes',
                    text: `Llegan cuando el asistente conectado (con el permiso «dejar propuestas») termina un borrador y propone publicarlo, activarlo o encenderlo. Cada una vence a los ${datos.limits.expiresDays} días y se vuelve obsoleta si alguien cambia lo propuesto.`,
                  })}
                </div>`,
            )}
          </section>
          <section aria-labelledby="${ctx.uid('historial')}" class="k-card k-stack">
            <h2 class="k-card__title" id="${ctx.uid('historial')}">Historial</h2>
            ${when(
              history.length,
              () => html`<ul class="pp-historial">${history.map(decidida)}</ul>`,
              () => html`<p class="k-hint">Aquí quedan las aprobadas, rechazadas, retiradas, vencidas y obsoletas.</p>`,
            )}
          </section>
        </div>`,
      );
    }

    async function cargar() {
      try {
        datos = await api.get('/api/mcp-proposals' + (marca ? '?brand=' + encodeURIComponent(marca) : ''));
      } catch (error) {
        if (montado && !isAbort(error))
          render(cuerpo, failure({ title: 'No se pudieron cargar las propuestas', error, retry: 'reintentar' }));
        return;
      }
      if (montado) pintar();
    }

    async function decidir(boton, aprobar) {
      const si = await confirm({
        title: aprobar ? 'Aprobar propuesta' : 'Rechazar propuesta',
        message: aprobar
          ? `${boton.dataset.title}. Se hará ahora, a tu nombre.`
          : `${boton.dataset.title}. No se hará nada y la propuesta pasa al historial.`,
        confirmLabel: aprobar ? 'Aprobar' : 'Rechazar',
        danger: !aprobar,
      });
      if (!si || !montado) return;
      try {
        await api.post(`/api/mcp-proposals/${boton.dataset.id}/${aprobar ? 'approve' : 'reject'}`, {});
        ctx.toast(aprobar ? 'Propuesta aprobada: ya se aplicó.' : 'Propuesta rechazada.');
      } finally {
        await cargar();
      }
    }

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            aprobar: (_evento, boton) => decidir(boton, true),
            rechazar: (_evento, boton) => decidir(boton, false),
            abrir: (_evento, boton) => ctx.go(boton.dataset.target),
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );
    enVivo = { recargar: cargar };
    ctx.onUnmount(() => {
      montado = false;
      enVivo = null;
    });
    cargar();
  },
  /** Una propuesta nueva o decidida en otra pestaña: se vuelve a pedir la lista. */
  onEvent(evento) {
    if (evento?.type === 'mcp_proposals.changed' && enVivo) enVivo.recargar();
  },
};
