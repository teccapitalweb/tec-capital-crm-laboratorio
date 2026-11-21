/**
 * Pantalla «Propuestas del asistente» (docs/PLAN_MCP_CLAUDE.md, «Propuestas que aprueba una persona»).
 *
 * El asistente conectado (Claude) deja propuestas de una lista cerrada: publicar o activar un recorrido, encender una
 * secuencia o una regla, publicar una apertura o un texto, activar una promoción, encender la entrega de accesos.
 * Aquí una persona del equipo las aprueba o las rechaza con un botón. Arriba, las pendientes con lo que pasará al
 * aprobar y sus avisos (los recalcula el servidor desde la base); debajo, el historial.
 *
 * La nota del asistente se muestra aparte, rotulada como escrita por él y escapada por la plantilla: es un dato,
 * nunca una instrucción. El título es sólo la acción (texto del servidor); el nombre de la entidad va en su propio
 * elemento rotulado «Nombre», también en la confirmación. «Lo que se enviará a los clientes» (los mensajes de un
 * recorrido, los pasos de una secuencia, lo que hace una regla, el texto o el mensaje de accesos) también se muestra
 * como texto escapado: esos textos pudo escribirlos el asistente. Si la persona no tiene permiso para la acción, no se ofrecen los botones y se dice por qué.
 * Aprobar ejecuta la acción a nombre de quien aprueba (GET/POST /api/mcp-proposals; el servidor lo decide todo).
 *
 * Aprobar por lote: cada tarjeta que la persona puede aprobar tiene una casilla; «Aprobar las seleccionadas» pide UNA
 * confirmación con cada acción y su nombre, y luego llama a la ruta de aprobar de cada una, EN SERIE, en el orden que
 * da el servidor (`batchOrder`: primero se publican las aperturas, después las imágenes). No hay ruta que apruebe
 * varias a la vez: cada aprobación conserva sus garantías y su resultado (aprobada, obsoleta o no se pudo, con el
 * motivo) se muestra al terminar. La imagen de «Aprobar la imagen del curso» es una <img> del mismo origen que sirve el
 * catálogo con sesión y alcance por marca (el servidor sólo manda /api/library/files/<id>).
 */
import { attrs, html, render, when } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { isAbort } from '../../kit/api.js';
import { dialog } from '../../kit/components/dialog.js';
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
// La persona puede aprobarla ahora con un clic (lo mismo que decide si se ofrece el botón «Aprobar»).
const aprobable = p => p.canDecide && p.status === 'pending' && p.problems.length === 0;
const RESULTADO = { aprobada: 'k-chip--ok', obsoleta: 'k-chip--lilac', fallo: 'k-chip--bad' };

function origen(p) {
  const s = p.source;
  return `${s.name || s.kindLabel} · ${s.kindLabel}${s.ownerName ? ` de ${s.ownerName}` : ''}`;
}

// «Lo que se enviará a los clientes»: lo recalcula el servidor desde la base; todo es texto y la plantilla lo escapa.
function envios(s) {
  return html`<section class="pp-bloque pp-envios" aria-label="${s.title}">
    <p class="pp-grupo">${s.title}</p>
    <p class="k-hint pp-envios__aviso">${s.note}</p>
    <dl class="pp-detalles">
      ${s.items.map(
        d => html`<div class="pp-detalle">
          <dt>${d.label}</dt>
          <dd>${d.value}</dd>
        </div>`,
      )}
    </dl>
    ${when(s.more > 0, () => html`<p class="k-hint">y ${s.more} más (ábrelo en su pantalla para verlo completo)</p>`)}
  </section>`;
}

function pendiente(p, elegidas, ocupado) {
  const bloqueada = p.problems.length > 0;
  return html`<li class="k-item pp-tarjeta" data-key="${p.id}">
    <div class="k-item__head">
      <div class="k-item__name">
        <h3 class="k-item__title">${p.title}</h3>
        <span class="k-chip ${CHIP[p.status] || ''}">${p.statusLabel}</span>
      </div>
      ${when(
        aprobable(p),
        () =>
          html`<label class="k-check pp-elegir">
            <input type="checkbox" data-do="elegir" data-id="${p.id}" ${attrs({ checked: elegidas.has(p.id), disabled: ocupado })} />
            Elegir para el lote
          </label>`,
      )}
    </div>
    ${when(
      p.image,
      () =>
        html`<figure class="pp-imagen">
          <img class="pp-imagen__img" src="${p.image?.url}" alt="${p.image?.alt}" loading="lazy" />
          <figcaption class="k-hint">Imagen que se aprobaría, tal como la recibirán los clientes.</figcaption>
        </figure>`,
    )}
    <dl class="pp-datos">
      <div class="k-piece pp-nombre">
        <dt class="k-piece__label">Nombre</dt>
        <dd class="k-piece__value">${p.name || '—'}</dd>
      </div>
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
    ${when(p.sends?.items?.length, () => envios(p.sends))}
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
              html`<button type="button" class="k-btn k-btn--primary" data-do="aprobar" data-id="${p.id}">Aprobar</button>`,
          )}
            <button type="button" class="k-btn" data-do="rechazar" data-id="${p.id}">Rechazar</button>`,
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
    <p class="k-hint pp-historia__nombre"><span class="pp-rotulo">Nombre:</span> ${p.name || '—'}</p>
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
    // Lote: lo elegido, si se está aprobando (y por cuál va) y el resultado del último lote.
    let elegidas = new Set();
    let ocupado = false;
    let avance = '';
    let resultado = null;
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

    function barraLote(pending) {
      const posibles = pending.filter(aprobable);
      if (!posibles.length && !resultado) return html``;
      const n = posibles.filter(p => elegidas.has(p.id)).length;
      const todas = posibles.length > 0 && n === posibles.length;
      return html`<div class="k-card pp-lote" role="group" aria-label="Aprobar por lote">
        <p class="pp-grupo">Aprobar por lote</p>
        <p class="k-hint pp-lote__ayuda">
          Elige varias y apruébalas con una sola confirmación. Se aprueban una por una, a tu nombre, y primero se publican
          las aperturas. Si alguna cambió o ya no se puede, se dice cuál y por qué.
        </p>
        <div class="k-actions pp-acciones">
          ${when(
            posibles.length,
            () =>
              html`<button type="button" class="k-btn" data-do="${todas ? 'ninguna' : 'todas'}" ${attrs({ disabled: ocupado })}>
                ${todas ? 'Quitar la selección' : 'Seleccionar todas las que puedo aprobar'}
              </button>`,
          )}
          <button type="button" class="k-btn k-btn--primary" data-do="lote" ${attrs({ disabled: ocupado || n === 0 })}>
            Aprobar las seleccionadas (${n})
          </button>
        </div>
        ${when(avance, () => html`<p class="k-hint" role="status">${avance}</p>`)}
        ${when(
          resultado,
          () =>
            html`<section class="pp-resultado" aria-label="Resultado del lote">
              <p class="pp-grupo">Resultado del lote</p>
              <ul class="pp-resultado__lista">
                ${(resultado || []).map(
                  r =>
                    html`<li class="pp-resultado__fila" data-estado="${r.estado}">
                      <span class="k-chip ${RESULTADO[r.estado]}">${r.etiqueta}</span>
                      <span class="pp-resultado__que"><strong>${r.title}</strong> · <span class="pp-rotulo">Nombre:</span> ${r.name || '—'}</span>
                      ${when(r.motivo, () => html`<span class="k-hint pp-resultado__motivo">${r.motivo}</span>`)}
                    </li>`,
                )}
              </ul>
            </section>`,
        )}
      </div>`;
    }

    function pintar() {
      const { pending, history } = datos;
      render(
        cuerpo,
        html`<div class="k-stack">
          <section aria-labelledby="${ctx.uid('pendientes')}" class="k-stack">
            <h2 class="pp-subtitulo" id="${ctx.uid('pendientes')}">Pendientes (${pending.length})</h2>
            ${barraLote(pending)}
            ${when(
              pending.length,
              () => html`<ul class="k-cards">${pending.map(p => pendiente(p, elegidas, ocupado))}</ul>`,
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
      if (!montado) return;
      // Lo elegido sólo vale mientras siga pendiente y se pueda aprobar.
      elegidas = new Set(datos.pending.filter(p => aprobable(p) && elegidas.has(p.id)).map(p => p.id));
      pintar();
    }

    // Aprobar por lote: una confirmación con cada acción y su nombre; después, la ruta de aprobar de cada una, en serie.
    async function aprobarLote() {
      if (ocupado || !datos) return;
      const lista = datos.pending
        .filter(p => aprobable(p) && elegidas.has(p.id))
        .sort((a, b) => (a.batchOrder ?? 1) - (b.batchOrder ?? 1));
      if (!lista.length) return;
      const eleccion = await dialog({
        title: `Aprobar ${lista.length} ${lista.length === 1 ? 'propuesta' : 'propuestas'}`,
        content: html`<p>Se harán ahora, a tu nombre, una por una y en este orden:</p>
          <ol class="pp-confirma-lote">
            ${lista.map(
              p =>
                html`<li class="pp-confirma-lote__fila">
                  <span class="pp-confirma__accion">${p.title}</span>
                  <span><span class="pp-rotulo">Nombre:</span> <span class="pp-confirma__nombre">${p.name || '—'}</span></span>
                </li>`,
            )}
          </ol>
          <p class="k-hint">Si alguna cambió desde que se propuso, no se aplica y queda como obsoleta.</p>`,
        actions: [
          { id: 'no', label: 'Cancelar' },
          { id: 'si', label: `Aprobar ${lista.length}`, primary: true, autofocus: true },
        ],
      });
      if (eleccion !== 'si' || !montado) return;
      ocupado = true;
      resultado = [];
      for (const [i, p] of lista.entries()) {
        avance = `Aprobando ${i + 1} de ${lista.length}…`;
        if (montado) pintar();
        const fila = { id: p.id, title: p.title, name: p.name };
        try {
          await api.post(`/api/mcp-proposals/${p.id}/approve`, {});
          resultado.push({ ...fila, estado: 'aprobada', etiqueta: 'Aprobada' });
        } catch (error) {
          if (isAbort(error)) break;
          // Obsoleta al aprobarla, o ya marcada así por el mantenimiento (otra pestaña o el repaso de cada minuto).
          const yaObsoleta = error?.code === 'already_decided' && error?.data?.details?.status === 'stale';
          const obsoleta = error?.code === 'stale_proposal' || yaObsoleta;
          resultado.push({
            ...fila,
            estado: obsoleta ? 'obsoleta' : 'fallo',
            etiqueta: obsoleta ? 'Obsoleta' : 'No se pudo',
            motivo: (yaObsoleta && error.data.details.reason) || error?.message || '',
          });
        }
      }
      ocupado = false;
      avance = '';
      elegidas = new Set();
      if (!montado) return;
      const bien = resultado.filter(r => r.estado === 'aprobada').length;
      ctx.toast(`Lote terminado: ${bien} de ${lista.length} aprobadas.`);
      await cargar();
    }

    async function decidir(boton, aprobar) {
      const p = datos?.pending.find(x => x.id === boton.dataset.id);
      if (!p) return;
      // La acción (texto del servidor) y el nombre (dato de la marca) van en elementos distintos, rotulados.
      const eleccion = await dialog({
        title: aprobar ? 'Aprobar propuesta' : 'Rechazar propuesta',
        content: html`<p class="pp-confirma__accion">${p.title}</p>
          <dl class="pp-confirma">
            <dt>Nombre</dt>
            <dd class="pp-confirma__nombre">${p.name || '—'}</dd>
          </dl>
          <p>
            ${aprobar ? 'Se hará ahora, a tu nombre.' : 'No se hará nada y la propuesta pasa al historial.'}
          </p>`,
        actions: [
          { id: 'no', label: 'Cancelar', autofocus: !aprobar },
          { id: 'si', label: aprobar ? 'Aprobar' : 'Rechazar', primary: aprobar, danger: !aprobar, autofocus: aprobar },
        ],
      });
      if (eleccion !== 'si' || !montado) return;
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
            todas: () => {
              if (ocupado || !datos) return;
              elegidas = new Set(datos.pending.filter(aprobable).map(p => p.id));
              pintar();
            },
            ninguna: () => {
              if (ocupado) return;
              elegidas = new Set();
              pintar();
            },
            lote: () => aprobarLote(),
            abrir: (_evento, boton) => ctx.go(boton.dataset.target),
          },
          change: {
            elegir: (_evento, casilla) => {
              if (ocupado) return;
              if (casilla.checked) elegidas.add(casilla.dataset.id);
              else elegidas.delete(casilla.dataset.id);
              pintar();
            },
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
