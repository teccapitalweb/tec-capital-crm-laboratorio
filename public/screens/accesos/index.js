/**
 * «Accesos del curso» (server/modules/course-access).
 *
 * Por apertura, administración escribe el mensaje con los accesos (enlace de las clases, material…) y lo enciende:
 * cuando el pago de una persona queda confirmado, ese mensaje le llega solo a su conversación. Aquí se escribe el
 * texto con su vista previa y lo que falta antes de encender, se ve quién lo recibió y se reenvía. Todo lo valida y
 * lo impone el servidor (/api/course-access); el resto del equipo de la marca sólo ve.
 */
import { attrs, html, render, when } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { isAbort, isStale, mutation, newClientRef } from '../../kit/api.js';
import { field } from '../../kit/components/form.js';
import { confirm } from '../../kit/components/dialog.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';

let enVivo = null;

const ESTADOS = {
  ready: { texto: 'Se envía solo', clase: 'k-chip--ok' },
  off: { texto: 'Escrito, apagado', clase: 'k-chip--draft' },
  empty: { texto: 'Sin accesos', clase: 'k-chip--warn' },
};

// Fecha de inicio de una apertura en su zona horaria (si la zona no es válida, en la del navegador).
function fechaInicio(t, zona) {
  if (!t) return 'Sin fecha';
  const opciones = { day: 'numeric', month: 'long', year: 'numeric' };
  try {
    return new Intl.DateTimeFormat('es-MX', { ...opciones, timeZone: zona || undefined }).format(t);
  } catch {
    return new Intl.DateTimeFormat('es-MX', opciones).format(t);
  }
}
const momento = t =>
  t
    ? new Intl.DateTimeFormat('es-MX', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(t)
    : '';
const personas = n => `${n} ${n === 1 ? 'persona' : 'personas'}`;

const borradorDe = e => ({
  editionId: e.editionId,
  body: e.access.body ?? '',
  enabled: e.access.enabled === true,
  onTestPayment: e.access.onTestPayment === true,
  revision: e.access.revision ?? 0,
});

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let marcas = null; // [{id, name}] sólo cuando la barra lateral dice «todas las marcas»
    let marca = ctx.brand && ctx.brand !== 'all' ? ctx.brand : (ctx.keep.get('marca') ?? null);
    let datos = null;
    let borrador = ctx.keep.get('borrador') ?? null;
    let previa = { text: '', problems: [], error: '', cargando: Boolean(borrador) };
    let aviso = null; // conflicto con otra persona: 'stale' o 'recargado'
    let errorEncender = '';
    let vivo = true;
    let espera = 0;
    let turno = 0;
    let pendiente = null; // la vista previa en vuelo, para cancelarla si llega otra

    const guardar = mutation((clientRef, editionId, cuerpo) =>
      api.put(`/api/course-access/editions/${encodeURIComponent(editionId)}`, { ...cuerpo, clientRef }),
    );
    const apertura = id => datos?.editions.find(e => e.editionId === id) ?? null;
    const recordar = () => {
      if (borrador) ctx.keep.set('borrador', borrador);
      else ctx.keep.delete('borrador');
    };

    // ---- Lista -------------------------------------------------------------------------------------------------

    function cabeceraLista() {
      return html`<header class="k-head">
        <div>
          <span class="k-eyebrow">Ventas</span>
          <h1>Accesos del curso</h1>
          <p class="k-lead">Lo que recibe la persona, sola, cuando su pago queda confirmado.</p>
        </div>
      </header>`;
    }

    function selectorMarca() {
      return when(
        marcas && marcas.length > 1,
        () => html`<form class="k-filterbar" novalidate data-do="marca">
          ${field(
            {
              name: 'marca',
              label: 'Marca',
              type: 'select',
              options: marcas.map(b => ({ value: b.id, label: b.name })),
              emptyLabel: 'Elige una marca',
            },
            { id: ctx.uid('marca'), value: marca ?? '' },
          )}
        </form>`,
      );
    }

    function cifras() {
      const ed = datos.editions;
      const listas = ed.filter(e => e.access.state === 'ready').length;
      const sin = ed.length - listas;
      const inscritos = ed.reduce((s, e) => s + (e.enrolled ?? 0), 0);
      const entregados = ed.reduce((s, e) => s + (e.delivered ?? 0), 0);
      return html`<div class="k-figures">
        <div class="k-figure" data-tone="lime">
          <span class="k-figure__label">Aperturas listas</span>
          <span class="k-figure__value">${listas}</span>
        </div>
        <div class="k-figure" data-tone="butter">
          <span class="k-figure__label">Aperturas sin accesos</span>
          <span class="k-figure__value">${sin}</span>
        </div>
        <div class="k-figure" data-tone="sky">
          <span class="k-figure__label">Con sus accesos</span>
          <span class="k-figure__value">${entregados}</span>
          <span class="k-figure__sub">de ${inscritos} inscritos con sus accesos</span>
        </div>
      </div>`;
    }

    function tarjeta(e) {
      const estado = ESTADOS[e.access.state] ?? ESTADOS.empty;
      const faltan = Math.max(0, (e.enrolled ?? 0) - (e.delivered ?? 0));
      const enviable = datos.canManage && e.access.state !== 'empty' && !e.access.problems.length && faltan > 0;
      const etiqueta = e.access.state === 'empty' ? 'Escribir accesos' : datos.canManage ? 'Editar' : 'Ver';
      return html`<li class="k-item acc-apertura" data-key="${e.editionId}" data-id="${e.editionId}">
        <div class="k-item__head">
          <div class="acc-apertura__nombre">
            <h2 class="k-item__title">${e.courseTitle}</h2>
            <p class="acc-apertura__dato">${e.editionName} · ${fechaInicio(e.startsAt, e.timezone)}</p>
          </div>
          <span class="${['k-chip', 'k-chip--lg', estado.clase]}">${estado.texto}</span>
        </div>
        <p class="acc-apertura__dato">${e.delivered ?? 0} de ${e.enrolled ?? 0} inscritos lo recibieron</p>
        <div class="k-actions">
          <button type="button" class="k-btn" data-do="editar" data-id="${e.editionId}">
            ${etiqueta}
          </button>
          ${when(
            enviable,
            () =>
              html`<button type="button" class="k-btn" data-do="faltan" data-id="${e.editionId}">Enviar a quienes faltan (${faltan})</button>`,
          )}
        </div>
      </li>`;
    }

    function entregas() {
      const lista = datos.deliveries ?? [];
      return html`<section class="k-card k-stack acc-entregas" aria-labelledby="${ctx.uid('entregas')}">
        <h2 class="k-card__title" id="${ctx.uid('entregas')}">Últimas entregas</h2>
        ${
          lista.length
            ? html`<ul class="acc-entregas__lista">
                ${lista.map(d => {
                  const conTexto = apertura(d.editionId)?.access.state !== 'empty';
                  return html`<li class="acc-entrega" data-key="${d.id}">
                    <div class="acc-entrega__datos">
                      <strong class="acc-entrega__nombre">${d.contactName}</strong>
                      <span>${d.courseTitle} · ${d.editionName}</span>
                      <span class="acc-entrega__meta">
                        ${momento(d.at)} · ${d.kind === 'auto' ? 'Automática' : `La envió ${d.sentByName ?? 'alguien del equipo'}`}
                      </span>
                      ${when(d.status !== 'sent' && d.reasonLabel, () => html`<span class="acc-entrega__meta">${d.reasonLabel}</span>`)}
                    </div>
                    <span class="${['k-chip', d.status === 'sent' ? 'k-chip--ok' : 'k-chip--warn']}">
                      ${d.status === 'sent' ? 'Enviado' : 'No se envió'}
                    </span>
                    <div class="k-actions acc-entrega__acciones">
                      ${when(
                        d.conversationId,
                        () =>
                          html`<button type="button" class="k-btn" data-do="chat" data-id="${d.conversationId}">Abrir chat</button>`,
                      )}
                      ${when(
                        datos.canSend && conTexto && d.enrollmentId,
                        () =>
                          html`<button type="button" class="k-btn" data-do="reenviar" data-id="${d.id}">Reenviar</button>`,
                      )}
                    </div>
                  </li>`;
                })}
              </ul>`
            : empty({ title: 'Todavía no se ha entregado ningún acceso.' })
        }
      </section>`;
    }

    function vistaLista() {
      const ed = datos.editions;
      return html`${cabeceraLista()} ${selectorMarca()} ${cifras()}
        ${
          ed.length
            ? html`<ul class="k-cards">${ed.map(tarjeta)}</ul>`
            : html`<div class="k-card">
                ${empty({
                  title: 'Esta marca todavía no tiene aperturas',
                  text: 'Cuando el catálogo tenga una apertura, aquí se escriben sus accesos.',
                })}
              </div>`
        }
        ${entregas()}`;
    }

    // ---- Editor ------------------------------------------------------------------------------------------------

    function vistaEditor(e) {
      const puede = datos.canManage;
      const max = datos.limits?.max ?? 2000;
      const largo = borrador.body.length;
      const id = ctx.uid('mensaje');
      const ultima = e.access.updatedAt
        ? `Última edición: ${e.access.updatedByName ?? 'alguien del equipo'} · ${momento(e.access.updatedAt)}`
        : '';
      // Otra persona guardó (lo dijo el servidor con un 409 o llegó por el aviso en vivo): se avisa sin tocar el texto.
      const estadoAviso =
        aviso === 'stale' || e.access.revision !== borrador.revision ? 'stale' : aviso === 'recargado' ? aviso : null;
      const avisoHtml = when(
        estadoAviso,
        () => html`<div class="${['k-notice', estadoAviso === 'stale' ? 'k-notice--warn' : 'k-notice--ok']}" role="status">
          <p>
            ${
              estadoAviso === 'stale'
                ? 'Alguien más cambió los accesos de esta apertura mientras escribías. Lo que escribiste sigue aquí.'
                : 'Se cargó lo último que se guardó. Tu texto sigue aquí: si guardas, reemplaza al anterior.'
            }
          </p>
          ${when(estadoAviso === 'stale', () => html`<button type="button" class="k-btn" data-do="recargar">Recargar</button>`)}
        </div>`,
      );
      return html`<header class="k-head acc-cabeza">
          <div class="acc-cabeza__texto">
            <button type="button" class="k-btn k-back" data-do="volver">Accesos</button>
            <span class="k-eyebrow">Accesos del curso</span>
            <h1>${e.courseTitle}</h1>
            <p class="k-lead">${e.editionName} · ${fechaInicio(e.startsAt, e.timezone)}</p>
          </div>
        </header>
        ${avisoHtml}
        <form class="acc-editor" novalidate data-do="editor">
          <div class="k-card k-stack">
            ${when(!puede, () => html`<p class="k-notice">Sólo administración puede escribir los accesos.</p>`)}
            <div class="k-field">
              <label class="k-label" for="${id}">Mensaje con los accesos</label>
              <textarea class="k-input acc-texto" name="body" rows="10" ${attrs({ id, readonly: !puede, 'aria-describedby': `${id}-cuenta` })}>${borrador.body}</textarea>
              <p class="${['k-hint', largo > max && 'acc-pasado']}" id="${id}-cuenta">${largo} de ${max} caracteres</p>
            </div>
            ${when(
              puede && !borrador.body.trim(),
              () =>
                html`<div><button type="button" class="k-btn k-btn--accent" data-do="sugerido">Usar texto sugerido</button></div>`,
            )}
            ${when(
              puede,
              () => html`<div class="k-stack k-stack--tight">
                <p class="k-label">Datos que se llenan solos</p>
                <p class="k-hint">Toca un dato para ponerlo donde está el cursor. Al enviarse cambia por el de cada persona.</p>
                <div class="acc-datos">
                  ${(datos.variables ?? []).map(
                    v =>
                      html`<button type="button" class="k-btn acc-dato" data-do="dato" data-key="${'dato-' + v.key}" data-id="${v.key}">${v.label}</button>`,
                  )}
                </div>
              </div>`,
            )}
            <div class="k-stack k-stack--tight">
              <div class="k-field">
                <label class="k-check">
                  <input type="checkbox" name="enabled" ${attrs({ checked: borrador.enabled, disabled: !puede, 'aria-describedby': errorEncender ? `${id}-encender` : null })} />
                  <span>Enviar solo cuando el pago quede confirmado</span>
                </label>
                ${when(errorEncender, () => html`<p class="k-error" id="${id}-encender">${errorEncender}</p>`)}
                ${when(
                  !errorEncender && puede && borrador.enabled && previa.problems.length,
                  () =>
                    html`<p class="k-hint">Mientras haya algo en «Antes de encender», sólo se puede guardar apagado.</p>`,
                )}
              </div>
              ${when(
                !datos.realMode && !e.realMode,
                () => html`<div class="k-field">
                  <label class="k-check">
                    <input type="checkbox" name="onTestPayment" ${attrs({ checked: borrador.onTestPayment, disabled: !puede, 'aria-describedby': `${id}-prueba` })} />
                    <span>Enviar también con pagos de prueba (tarjeta u OXXO simulados)</span>
                  </label>
                  <p class="k-hint" id="${id}-prueba">Sirve para presentar el recorrido completo. Con clientes reales déjalo apagado.</p>
                </div>`,
              )}
            </div>
            ${when(ultima, () => html`<p class="k-hint">${ultima}</p>`)}
            ${when(
              puede,
              () => html`<div class="k-actions acc-pie">
                <button type="button" class="k-btn" data-do="volver">Cancelar</button>
                <button type="submit" class="k-btn k-btn--primary">Guardar</button>
              </div>`,
            )}
          </div>
          <section class="k-card k-stack acc-previa" aria-labelledby="${ctx.uid('previa')}">
            <h2 class="k-card__title" id="${ctx.uid('previa')}">Vista previa</h2>
            <p class="k-hint">Así le llega, con los datos de esta apertura y un nombre de ejemplo.</p>
            <div class="acc-chat" aria-live="polite">
              ${
                previa.error
                  ? html`<p class="k-error">${previa.error}</p>`
                  : previa.text
                    ? html`<p class="acc-burbuja">${previa.text}</p>`
                    : html`<p class="k-hint">${previa.cargando ? 'Armando la vista previa…' : 'Escribe el mensaje para verlo aquí.'}</p>`
              }
            </div>
            ${when(
              previa.problems.length,
              () => html`<div class="k-notice k-notice--warn acc-faltan">
                <p class="acc-faltan__titulo">Antes de encender</p>
                <ul class="acc-faltan__lista">${previa.problems.map(p => html`<li>${p}</li>`)}</ul>
              </div>`,
            )}
          </section>
        </form>`;
    }

    // ---- Pintar y cargar ---------------------------------------------------------------------------------------

    function pintar(cuerpo) {
      if (!vivo) return;
      let contenido = cuerpo;
      if (!contenido) {
        const e = borrador && datos ? apertura(borrador.editionId) : null;
        contenido = e ? vistaEditor(e) : datos ? vistaLista() : null;
      }
      if (contenido) render(root, html`<section class="k-page acc-pagina">${contenido}</section>`);
    }

    async function pedirPrevia() {
      clearTimeout(espera);
      if (!borrador || !vivo) return;
      pendiente?.abort();
      const control = new AbortController();
      pendiente = control;
      const mio = ++turno;
      previa = { ...previa, cargando: true };
      try {
        const r = await api.post(
          `/api/course-access/editions/${encodeURIComponent(borrador.editionId)}/preview`,
          { body: borrador.body },
          { signal: control.signal },
        );
        if (mio !== turno || !vivo) return;
        previa = { text: r.text ?? '', problems: r.problems ?? [], error: '', cargando: false };
      } catch (error) {
        if (isAbort(error) || mio !== turno || !vivo) return;
        previa = { text: '', problems: [], error: error.message, cargando: false };
      }
      pintar();
    }
    const previaLuego = () => {
      clearTimeout(espera);
      espera = setTimeout(pedirPrevia, 400);
    };

    async function pedirDatos() {
      datos = await api.get('/api/course-access', { brand: marca });
      if (borrador && !apertura(borrador.editionId)) {
        borrador = null;
        recordar();
      }
    }

    async function cargar() {
      render(
        root,
        html`<section class="k-page acc-pagina">${cabeceraLista()} ${loading('Cargando las aperturas…')}</section>`,
      );
      try {
        if (!ctx.brand || ctx.brand === 'all') {
          // Sin una marca elegida en la barra lateral se elige aquí, como en las demás pantallas por marca.
          marcas ??= (await api.get('/api/course-access/brands')).brands ?? [];
          if (!marcas.some(b => b.id === marca)) marca = marcas[0]?.id ?? null;
        }
        if (!marca) {
          pintar(
            html`${cabeceraLista()}
              <div class="k-card">${empty({ title: 'No tienes marcas asignadas', text: 'Pide a administración que te dé acceso a una marca.' })}</div>`,
          );
          return;
        }
        ctx.keep.set('marca', marca);
        await pedirDatos();
      } catch (error) {
        if (vivo && !isAbort(error)) pintar(html`${cabeceraLista()} ${failure({ error, retry: 'reintentar' })}`);
        return;
      }
      if (!vivo) return;
      pintar();
      if (borrador) pedirPrevia();
    }

    async function recargar() {
      await pedirDatos();
      pintar();
    }

    // ---- Acciones ----------------------------------------------------------------------------------------------

    function abrir(editionId) {
      const e = apertura(editionId);
      if (!e) return;
      borrador = borradorDe(e);
      previa = { text: '', problems: [], error: '', cargando: true };
      aviso = null;
      errorEncender = '';
      recordar();
      pintar();
      root.querySelector('textarea[name="body"]')?.focus();
      root.querySelector('.k-page')?.scrollTo?.({ top: 0 });
      pedirPrevia();
    }

    function cerrar() {
      clearTimeout(espera);
      pendiente?.abort();
      borrador = null;
      aviso = null;
      errorEncender = '';
      guardar.reset();
      recordar();
      pintar();
    }

    // Lo que hay en el formulario pasa al borrador (antes de cada repintado y al guardar).
    function leer(form) {
      if (!borrador || !form) return;
      const texto = form.elements.namedItem('body');
      if (texto) borrador.body = texto.value;
      const encendido = form.elements.namedItem('enabled');
      if (encendido) borrador.enabled = encendido.checked;
      const prueba = form.elements.namedItem('onTestPayment');
      if (prueba) borrador.onTestPayment = prueba.checked;
      recordar();
    }

    async function enviarFaltan(editionId) {
      const e = apertura(editionId);
      if (!e) return;
      const faltan = Math.max(0, e.enrolled - e.delivered);
      const seguro = await confirm({
        title: `¿Enviar los accesos a ${personas(faltan)}?`,
        message: `Les llega en su chat el mensaje de accesos de ${e.courseTitle} · ${e.editionName}. A quien ya lo recibió no se le vuelve a enviar.`,
        confirmLabel: 'Enviar',
      });
      if (!seguro) return;
      const r = await api.post(`/api/course-access/editions/${encodeURIComponent(editionId)}/send-pending`, {
        clientRef: newClientRef(),
      });
      ctx.toast(`Se envió a ${personas(r.sent)}.` + (r.left > 0 ? ` Quedan ${r.left}.` : ''));
      await recargar();
    }

    async function reenviar(deliveryId) {
      const d = datos.deliveries.find(x => x.id === deliveryId);
      if (!d) return;
      const seguro = await confirm({
        title: `¿Reenviar los accesos a ${d.contactName}?`,
        message: `Le llega otra vez en su chat el mensaje de accesos de ${d.courseTitle} · ${d.editionName}.`,
        confirmLabel: 'Reenviar',
      });
      if (!seguro) return;
      await api.post(`/api/course-access/enrollments/${encodeURIComponent(d.enrollmentId)}/send`, {
        clientRef: newClientRef(),
      });
      ctx.toast(`Accesos reenviados a ${d.contactName}.`);
      await recargar();
    }

    async function guardarBorrador(form) {
      leer(form);
      const e = apertura(borrador.editionId);
      if (!e) return;
      const cuerpo = { enabled: borrador.enabled, body: borrador.body, expectedRevision: borrador.revision };
      if (!datos.realMode && !e.realMode) cuerpo.onTestPayment = borrador.onTestPayment;
      errorEncender = '';
      try {
        const { edition } = await guardar.run(borrador.editionId, cuerpo);
        const i = datos.editions.findIndex(x => x.editionId === edition.editionId);
        if (i >= 0) datos.editions[i] = edition;
        ctx.toast(
          edition.access.enabled ? 'Accesos guardados. Se envían solos al confirmar el pago.' : 'Accesos guardados.',
        );
        cerrar();
        recargar().catch(() => {});
      } catch (error) {
        if (isAbort(error)) return;
        if (isStale(error)) aviso = 'stale';
        else if (error.code === 'not_ready') {
          errorEncender = error.message;
          if (error.data?.details?.problems) previa = { ...previa, problems: error.data.details.problems };
        } else ctx.toast(error.message);
        pintar();
      }
    }

    // La versión guardada vuelve a cargarse sin tirar lo que la persona escribió: sólo se toma su revisión.
    async function recargarConflicto() {
      await pedirDatos();
      const e = borrador && apertura(borrador.editionId);
      if (e) {
        borrador.revision = e.access.revision;
        aviso = 'recargado';
        guardar.reset();
        recordar();
      }
      pintar();
    }

    function insertarDato(clave) {
      const campo = root.querySelector('textarea[name="body"]');
      if (!campo || !borrador) return;
      const inicio = campo.selectionStart ?? campo.value.length;
      const fin = campo.selectionEnd ?? inicio;
      campo.setRangeText(`{{${clave}}}`, inicio, fin, 'end');
      campo.focus();
      borrador.body = campo.value;
      recordar();
      pintar();
      previaLuego();
    }

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            editar: (_e, b) => abrir(b.getAttribute('data-id')),
            volver: cerrar,
            faltan: (_e, b) => enviarFaltan(b.getAttribute('data-id')),
            reenviar: (_e, b) => reenviar(b.getAttribute('data-id')),
            chat(_e, b) {
              const id = b.getAttribute('data-id');
              if (ctx.openConversation) ctx.openConversation(id);
              else ctx.go('inbox');
            },
            recargar: recargarConflicto,
            dato: (_e, b) => insertarDato(b.getAttribute('data-id')),
            sugerido() {
              if (!borrador) return;
              borrador.body = datos.suggestion ?? '';
              recordar();
              pintar();
              root.querySelector('textarea[name="body"]')?.focus();
              pedirPrevia();
            },
          },
          input: {
            editor(event, form) {
              leer(form);
              pintar();
              if (event.target?.name === 'body') previaLuego();
            },
          },
          change: {
            marca(_e, form) {
              const elegida = form.elements.namedItem('marca').value;
              if (!elegida || elegida === marca) return;
              marca = elegida;
              ctx.keep.set('marca', marca);
              cargar();
            },
            editor(_e, form) {
              leer(form);
              if (_e.target?.name === 'enabled' && !borrador.enabled) errorEncender = '';
              pintar();
            },
          },
          submit: {
            editor: (_e, form) => guardarBorrador(form),
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );

    enVivo = {
      marca: () => marca,
      // Otra persona guardó o se entregó un acceso: se pide todo de nuevo; un borrador abierto no se toca.
      recargar: () =>
        recargar().catch(error => {
          if (!isAbort(error)) console.warn(error);
        }),
    };
    ctx.onUnmount(() => {
      vivo = false;
      enVivo = null;
      clearTimeout(espera);
      pendiente?.abort();
      recordar();
    });
    cargar();
  },

  /** Cambió algo de los accesos de la marca que se está viendo: se vuelve a pedir la lista sin pisar el borrador. */
  onEvent(evento) {
    if (evento?.type === 'course_access.changed' && enVivo && evento.brandId === enVivo.marca()) enVivo.recargar();
  },
};
