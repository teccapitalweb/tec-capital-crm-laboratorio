/**
 * Contactos: la lista de contactos a escala (docs/PLAN_CONTACTOS_A_ESCALA.md).
 *
 * Por qué existe: la vista «Contactos» de siempre recibe todos los contactos en /api/crm y filtra en el
 * navegador; con miles de filas eso no se sostiene. Esta pantalla pide de cincuenta en cincuenta a
 * GET /api/contacts (módulo `directory`), que busca, filtra, ordena y cuenta en el servidor.
 *
 * Qué hace: búsqueda con espera (nombre, correo o teléfono en cualquier formato), filtros rápidos en chips,
 * constructor de filtros con la gramática común, tabla con columnas elegibles y «Cargar más», y panel con
 * el detalle del contacto (con su bloque «WhatsApp» de GET /api/identity/contacts/:id). Crear y editar siguen en
 * la vista actual («Editar en Contactos»); desde aquí sólo se añade la selección a una lista de Audiencias.
 *
 * En vivo: el servidor avisa `contacts.changed` con los ids que cambiaron; aquí se vuelven a pedir sólo
 * esas filas (con la misma búsqueda y filtros, así que una fila que dejó de cumplir sale de la lista).
 * Lo que debe sobrevivir a un remontaje (búsqueda, filtros, orden, columnas, contacto abierto y posición)
 * vive en ctx.keep.
 */
import { html, render, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { createStore } from '../../kit/state.js';
import { isAbort, newClientRef } from '../../kit/api.js';
import { pagedTable } from '../../kit/components/table.js';
import { detailPanel } from '../../kit/components/panel.js';
import { dialog } from '../../kit/components/dialog.js';
import { field } from '../../kit/components/form.js';
import {
  conditionProblems,
  conditionsBuilder,
  describeConditions,
  emptyConditions,
} from '../../kit/components/conditions.js';
import { failure, loading } from '../../kit/components/feedback.js';

// ---------------------------------------------------------------------------------------------------
// Definiciones
// ---------------------------------------------------------------------------------------------------

const ETAPAS = [
  { value: 'nuevo', label: 'Nuevo' },
  { value: 'interesado', label: 'Interesado' },
  { value: 'inscripcion', label: 'Inscripción' },
  { value: 'ganada', label: 'Ganada' },
  { value: 'perdida', label: 'Perdida' },
];
const CONSENTIMIENTOS = [
  { value: 'unknown', label: 'Sin respuesta' },
  { value: 'opted_in', label: 'Aceptó mensajes' },
  { value: 'opted_out', label: 'No quiere mensajes' },
];
// Colores de estado comunes a las pantallas (docs/GUIA_PANTALLAS.md): bien menta, mal durazno, en curso lima,
// información cielo, sin decidir gris.
const TONO_CONSENTIMIENTO = { opted_in: 'k-chip--ok', unknown: 'k-chip--draft', opted_out: 'k-chip--bad' };
const TONO_ETAPA = {
  nuevo: 'k-chip--draft',
  interesado: 'k-chip--sky',
  inscripcion: 'k-chip--accent',
  ganada: 'k-chip--ok',
  perdida: 'k-chip--bad',
};
const CANALES = { whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook' };
const ESTADOS = { open: 'Abierta', waiting: 'En espera', resolved: 'Cerrada' };
const ORIGENES = { manual: 'Alta manual', whatsapp: 'WhatsApp', ipcil: 'Históricos', import: 'Importación' };

/** Filtros rápidos: los mismos que acepta el servidor en `quick`. */
const RAPIDOS = [
  { id: 'with_phone', label: 'Con teléfono' },
  { id: 'no_phone', label: 'Sin teléfono' },
  { id: 'opted_in', label: 'Aceptó mensajes' },
  { id: 'active', label: 'Con interés abierto' },
  { id: 'recent', label: 'Alta en 30 días' },
  { id: 'mine', label: 'Mis intereses' },
];

const rotulo = (lista, valor) => lista.find(item => item.value === valor)?.label ?? valor;
const FECHA = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
const FECHA_HORA = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const NUMERO = new Intl.NumberFormat('es-MX');
const fecha = instante => (instante ? FECHA.format(new Date(instante)) : '—');
const fechaHora = instante => (instante ? FECHA_HORA.format(new Date(instante)) : '—');

const DIAS = [
  { op: 'in_last_days', valueType: 'number', label: 'en los últimos (días)' },
  { op: 'not_in_last_days', valueType: 'number', label: 'no en los últimos (días)' },
  { op: 'after', valueType: 'date' },
  { op: 'before', valueType: 'date' },
];

/** Campos del constructor de filtros: los mismos que registra el servidor (ámbito «contact»). */
function camposFiltro(opciones) {
  const campos = [
    { name: 'name', label: 'Nombre', ops: ['contains', 'not_contains', 'starts_with'] },
    {
      name: 'email',
      label: 'Correo',
      ops: [
        'contains',
        { op: 'not_empty', label: 'tiene correo', valueType: 'none' },
        { op: 'empty', label: 'no tiene correo', valueType: 'none' },
      ],
    },
    { name: 'has_phone', label: 'Tiene teléfono', ops: [{ op: 'is', valueType: 'boolean' }] },
    { name: 'consent', label: 'Consentimiento', ops: ['eq', 'in'], options: CONSENTIMIENTOS },
    { name: 'active_interest', label: 'Interés abierto', ops: [{ op: 'is', valueType: 'boolean' }] },
    { name: 'stage', label: 'Etapa de un interés', ops: ['any', 'none'], options: ETAPAS },
    { name: 'created', label: 'Fecha de alta', ops: DIAS },
    { name: 'activity', label: 'Última actividad', ops: DIAS },
  ];
  const lista = (items, valor, texto) => items.map(item => ({ value: item[valor], label: item[texto] }));
  if (opciones.tags.length)
    campos.push({
      name: 'tag',
      label: 'Etiqueta',
      ops: ['any', 'all', 'none'],
      options: lista(opciones.tags, 'id', 'name'),
    });
  if (opciones.courses.length)
    campos.push({
      name: 'course',
      label: 'Curso de un interés',
      ops: ['any', 'none'],
      options: lista(opciones.courses, 'id', 'title'),
    });
  if (opciones.owners.length)
    campos.push({
      name: 'owner',
      label: 'Responsable de un interés',
      ops: ['any', 'none'],
      options: lista(opciones.owners, 'id', 'name'),
    });
  if (opciones.brands.length > 1)
    campos.push({
      name: 'brand',
      label: 'Marca',
      ops: ['in', 'not_in'],
      options: lista(opciones.brands, 'id', 'name'),
    });
  if (opciones.sources.length > 1)
    campos.push({
      name: 'source',
      label: 'Origen',
      ops: ['in', 'not_in'],
      options: opciones.sources.map(valor => ({ value: valor, label: ORIGENES[valor] ?? valor })),
    });
  return campos;
}

const chip = (texto, tono = '') => html`<span class="${['k-chip', tono]}">${texto}</span>`;

function etiquetas(lista, tope = 3) {
  if (!lista.length) return html`<span class="k-muted">—</span>`;
  const resto = lista.length - tope;
  return html`<span class="k-row ct-chips">
    ${lista.slice(0, tope).map(etiqueta => chip(etiqueta.name))}${when(resto > 0, () => html`<span class="k-muted">+${resto}</span>`)}
  </span>`;
}

/** Quien conversa por WhatsApp real sin teléfono visible lleva el distintivo «sin número» (nunca su identificador). */
const sinNumero = () => html`<span class="k-chip k-chip--wa ct-sin-numero">Sin número</span>`;
const telefono = contacto =>
  contacto.phone ||
  (contacto.noNumber
    ? sinNumero()
    : contacto.labNumber
      ? html`<span class="k-muted">${contacto.labNumber} (prueba)</span>`
      : '—');

/** Tope de contactos por llamada al añadir a una lista (el mismo del servidor). */
const TOPE_LISTA = 500;

/** Columnas de la tabla. La de marca sólo empieza visible cuando se miran todas las marcas. */
function columnas(todas) {
  return [
    { id: 'name', label: 'Nombre', fixed: true, sortable: true, cell: c => c.name },
    { id: 'phone', label: 'Teléfono', cell: telefono },
    { id: 'email', label: 'Correo', hidden: true, cell: c => c.email || '—' },
    { id: 'brand', label: 'Marca', hidden: !todas, cell: c => c.brandName },
    { id: 'tags', label: 'Etiquetas', cell: c => etiquetas(c.tags) },
    {
      id: 'consent',
      label: 'Consentimiento',
      cell: c => chip(rotulo(CONSENTIMIENTOS, c.consent), TONO_CONSENTIMIENTO[c.consent]),
    },
    {
      id: 'interest',
      label: 'Interés',
      cell: c =>
        c.latest
          ? html`<span class="k-row ct-chips">${chip(rotulo(ETAPAS, c.latest.stage), TONO_ETAPA[c.latest.stage])}
              <span>${c.latest.course}</span></span>`
          : html`<span class="k-muted">—</span>`,
    },
    { id: 'owner', label: 'Responsable', hidden: true, cell: c => c.latest?.owner ?? '—' },
    { id: 'activity', label: 'Última actividad', sortable: 'desc', cell: c => fecha(c.activityAt) },
    { id: 'created', label: 'Alta', hidden: true, sortable: 'desc', cell: c => fecha(c.createdAt) },
    { id: 'source', label: 'Origen', hidden: true, cell: c => ORIGENES[c.source] ?? c.source },
  ];
}

/** Lo vivo de cada montaje, para que onEvent() llegue a la lista. Se quita al salir. */
const enVivo = new WeakMap();

// ---------------------------------------------------------------------------------------------------
// Panel del contacto
// ---------------------------------------------------------------------------------------------------

/** Bloque «WhatsApp» del panel: sólo si hay algo que decir. El identificador va abreviado (sus cuatro últimos). */
function bloqueWhatsApp(wa, dato) {
  if (!wa || !(wa.real || wa.username || wa.bsuidHint || wa.phoneSeenAt)) return html``;
  return html`<section class="ct-seccion" data-key="ct-whatsapp">
    <h3 class="ct-subtitulo">WhatsApp</h3>
    <dl class="ct-datos">
      ${dato('Teléfono', wa.phone || (wa.hasPhone ? '—' : sinNumero()))}
      ${when(wa.username, () => dato('Usuario', `@${wa.username}`))}
      ${when(wa.bsuidHint, () => dato('Identificador', `··${wa.bsuidHint}`))}
      ${dato('Número real', wa.real ? 'Sí, conversa por WhatsApp real' : 'No')}
      ${when(wa.phoneSeenAt, () => dato('Teléfono conocido desde', fecha(wa.phoneSeenAt)))}
    </dl>
    ${when(wa.bsuidHint, () => html`<p class="k-hint">El identificador se muestra abreviado.</p>`)}
  </section>`;
}

function fichaContacto(d, wa = null) {
  const c = d.contact;
  const dato = (titulo, valor) => html`<div class="ct-dato"><dt>${titulo}</dt><dd>${valor}</dd></div>`;
  return html`<div class="k-stack ct-ficha">
    <section class="ct-seccion" aria-label="Datos">
      <dl class="ct-datos">
        ${dato('Teléfono', telefono(c))} ${dato('Correo', c.email || '—')} ${dato('Marca', c.brandName)}
        ${dato('Origen', ORIGENES[c.source] ?? c.source)} ${dato('Alta', fecha(c.createdAt))}
        ${dato('Última actividad', fechaHora(c.activityAt))}
      </dl>
      ${when(c.phoneMasked, () => html`<p class="k-hint">Tu acceso muestra el teléfono y el correo enmascarados.</p>`)}
    </section>

    ${bloqueWhatsApp(wa, dato)}

    <section class="ct-seccion">
      <h3 class="ct-subtitulo">Etiquetas</h3>
      ${c.tags.length ? html`<div class="k-row ct-chips">${c.tags.map(etiqueta => chip(etiqueta.name))}</div>` : html`<p class="k-muted">Sin etiquetas.</p>`}
    </section>

    <section class="ct-seccion">
      <h3 class="ct-subtitulo">Consentimiento</h3>
      <p>${chip(rotulo(CONSENTIMIENTOS, d.consent.status), TONO_CONSENTIMIENTO[d.consent.status])}</p>
      ${when(
        d.consent.history.length,
        () => html`<ul class="ct-lista">
          ${d.consent.history.map(
            cambio => html`<li>
              <span>${rotulo(CONSENTIMIENTOS, cambio.status)}</span>
              <span class="k-muted">${fechaHora(cambio.at)}${cambio.actor ? ` · ${cambio.actor}` : ''}</span>
            </li>`,
          )}
        </ul>`,
        () => html`<p class="k-muted">Sin cambios registrados.</p>`,
      )}
    </section>

    <section class="ct-seccion">
      <h3 class="ct-subtitulo">Intereses (${d.opportunities.length})</h3>
      ${when(
        d.opportunities.length,
        () => html`<ul class="ct-lista">
          ${d.opportunities.map(
            o => html`<li data-key="${`op-${o.id}`}">
              <span class="k-row ct-chips">${chip(rotulo(ETAPAS, o.stage), TONO_ETAPA[o.stage])}<strong>${o.course}</strong></span>
              <span class="k-muted">${[o.edition, o.owner ?? 'Sin responsable', o.nextDue ? `Tarea: ${fecha(o.nextDue)}` : ''].filter(Boolean).join(' · ')}</span>
            </li>`,
          )}
        </ul>`,
        () => html`<p class="k-muted">Todavía no tiene intereses.</p>`,
      )}
    </section>

    <section class="ct-seccion">
      <h3 class="ct-subtitulo">Última conversación</h3>
      ${
        d.conversation
          ? html`<p>
              <strong>${CANALES[d.conversation.channel] ?? d.conversation.channel}</strong> ·
              ${ESTADOS[d.conversation.status] ?? d.conversation.status} · ${d.conversation.course}
            </p>
            <p class="k-muted">
              ${fechaHora(d.conversation.updatedAt)}${d.conversation.assigned ? ` · ${d.conversation.assigned}` : ''}
              ${d.conversations > 1 ? ` · ${d.conversations} conversaciones en total` : ''}
            </p>`
          : html`<p class="k-muted">Sin conversaciones.</p>`
      }
    </section>

    <div class="k-actions">
      <button type="button" class="k-btn" data-do="ir-contactos">Editar en Contactos</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------------
// Añadir a una lista
// ---------------------------------------------------------------------------------------------------

/**
 * Ventana para añadir los contactos elegidos a una lista existente de su marca o a una nueva. Una lista es de
 * una sola marca: si la selección mezcla marcas, se pide elegir de una. Repetir no duplica (el servidor ignora a
 * quien ya está y la lista nueva lleva su clientRef).
 */
function ventanaLista({ api, ctx, elegidos, marca }) {
  return dialog({
    title: 'Añadir a una lista',
    mount(cuerpo, cerrar) {
      const clientRef = newClientRef();
      const ids = elegidos.map(c => c.id);
      let listas = [];
      let destino = '';
      let error = '';
      let ocupado = false;
      const aviso = texto =>
        render(
          cuerpo,
          html`<div class="k-stack">
            <p>${texto}</p>
            <div class="k-actions"><button type="button" class="k-btn" data-do="cancelar">Cerrar</button></div>
          </div>`,
        );
      const opcion = l => ({
        value: l.id,
        label: `${l.name}${l.role === 'suppression' ? ' (exclusión)' : ''} · ${NUMERO.format(l.memberCount)}`,
      });
      const pintar = () =>
        render(
          cuerpo,
          html`<form class="k-stack" novalidate data-do="lista">
            <p class="k-hint">${ids.length === 1 ? '1 contacto elegido.' : `${NUMERO.format(ids.length)} contactos elegidos.`}</p>
            ${field(
              {
                name: 'destino',
                label: 'Lista',
                type: 'select',
                options: [{ value: '', label: 'Nueva lista…' }, ...listas.map(opcion)],
              },
              { id: ctx.uid('lista-destino'), value: destino },
            )}
            ${when(destino === '', () =>
              field(
                { name: 'name', label: 'Nombre de la lista nueva', required: true, maxlength: 80, autocomplete: 'off' },
                { id: ctx.uid('lista-nombre') },
              ),
            )}
            <p class="k-error" role="alert">${error}</p>
            <div class="k-actions">
              <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
              <button type="submit" class="k-btn k-btn--primary">Añadir</button>
            </div>
          </form>`,
        );
      async function cargar() {
        if (!marca) return aviso('Elige contactos de una sola marca: cada lista pertenece a una marca.');
        if (ids.length > TOPE_LISTA)
          return aviso(`Se pueden añadir hasta ${NUMERO.format(TOPE_LISTA)} contactos a la vez. Elige menos.`);
        render(cuerpo, loading('Cargando las listas…'));
        try {
          const datos = await api.get('/api/audiences', { brand: marca });
          if (!datos.canEdit) return aviso('Tu acceso no permite cambiar las listas de esta marca.');
          listas = datos.audiences.filter(a => a.kind === 'list' && !a.archived);
        } catch (e) {
          if (isAbort(e)) return;
          const sinPermiso = e?.status === 403 || e?.status === 404;
          return aviso(
            sinPermiso ? 'Tu acceso no permite usar las listas de esta marca.' : 'No se pudieron cargar las listas.',
          );
        }
        pintar();
      }
      cargar();
      return listen(cuerpo, {
        click: { cancelar: () => cerrar(null) },
        change: {
          lista(_evento, formulario) {
            const elegido = String(formValues(formulario).destino ?? '');
            if (elegido === destino) return;
            destino = elegido;
            error = '';
            pintar();
          },
        },
        submit: {
          async lista(_evento, formulario) {
            if (ocupado) return;
            const valores = formValues(formulario);
            if (!destino && !String(valores.name ?? '').trim()) {
              error = 'Escribe el nombre de la lista nueva.';
              return pintar();
            }
            ocupado = true;
            try {
              if (!destino) {
                const { audience } = await api.post('/api/audiences', {
                  brandId: marca,
                  kind: 'list',
                  name: String(valores.name).trim(),
                  contactIds: ids,
                  clientRef,
                });
                return cerrar({ name: audience.name, added: audience.memberCount, already: 0 });
              }
              const respuesta = await api.post(`/api/audiences/${encodeURIComponent(destino)}/members`, {
                add: ids,
                clientRef,
              });
              cerrar({ name: respuesta.audience.name, added: respuesta.added, already: ids.length - respuesta.added });
            } catch (e) {
              error = e.message;
              pintar();
            } finally {
              ocupado = false;
            }
          },
        },
      });
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// La pantalla
// ---------------------------------------------------------------------------------------------------

export default {
  mount(root, ctx) {
    const { api } = ctx;
    const marca = ctx.brand || 'all';
    const guardado = ctx.keep.get('estado') ?? {};
    const store = createStore({
      q: guardado.q ?? '',
      quick: guardado.quick ?? [],
      filtro: guardado.filtro ?? emptyConditions(),
      // Con una condición a medias (pudo quedar así al salir) todavía no se filtra.
      completo: guardado.completo ?? true,
      total: null,
      campos: null, // campos del constructor, cuando lleguen las opciones del servidor
    });
    let espera = 0;
    let abierto = null; // { id, recargar } del contacto que está en el panel
    let filtros = null;
    const pendientes = new Set(); // ids avisados en vivo que todavía no se han pedido
    let esperaVivo = 0;

    render(
      root,
      html`<section class="k-page ct-page" data-do="pagina">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">Atención</span>
            <h1>Contactos</h1>
            <p class="k-lead">Las personas de tus marcas: búscalas, fíltralas, ábrelas y añádelas a una lista.</p>
          </div>
          <p class="k-figure ct-total" data-tone="lime" data-slot="total" role="status"></p>
        </header>
        <div class="ct-herramientas">
          <div class="k-filterbar ct-buscar">
            <div class="k-field">
              <label class="k-label" for="${ctx.uid('buscar')}">Buscar</label>
              <input
                class="k-input"
                type="search"
                id="${ctx.uid('buscar')}"
                data-do="buscar"
                value="${store.get().q}"
                placeholder="Nombre, correo o teléfono"
                maxlength="100"
                autocomplete="off"
              />
            </div>
          </div>
          <div class="k-row ct-rapidos" role="group" aria-label="Filtros rápidos" data-slot="rapidos"></div>
          <details class="ct-filtros" data-key="ct-filtros">
            <summary class="k-filter">Más filtros</summary>
            <div class="k-card ct-condiciones" data-slot="condiciones"></div>
          </details>
          <p class="k-hint" data-slot="resumen" role="status"></p>
        </div>
        <div data-slot="aviso"></div>
        <div class="k-split">
          <div class="k-card ct-tabla" data-slot="tabla"></div>
          <div data-slot="detalle"></div>
        </div>
      </section>`,
    );
    const ranura = nombre => root.querySelector(`[data-slot="${nombre}"]`);
    const pagina = root.querySelector('.ct-page');

    // Lo que se manda al servidor: la misma búsqueda para la lista, el total y las filas en vivo.
    function consulta() {
      const { q, quick, filtro, completo } = store.get();
      return {
        brand: marca,
        q,
        quick: quick.length ? quick : null,
        filter: completo && filtro.groups.length ? filtro : null,
      };
    }

    const tabla = pagedTable(ranura('tabla'), {
      label: 'Contactos',
      rowKey: c => c.id,
      rowLabel: c => c.name,
      cards: true,
      selectable: true,
      actions: () => html`<button type="button" class="k-btn" data-do="anadir-lista">Añadir a una lista</button>`,
      columns: columnas(marca === 'all'),
      sort: ctx.keep.get('orden') ?? { by: 'activity', dir: 'desc' },
      onSort: orden => ctx.keep.set('orden', orden),
      visible: ctx.keep.get('columnas'),
      onColumns: lista => ctx.keep.set('columnas', lista),
      // Buscar, filtrar, ordenar y contar es trabajo del servidor: aquí sólo se pide la página siguiente.
      async load({ cursor, sort, limit, signal }) {
        try {
          const respuesta = await api.get(
            '/api/contacts',
            { ...consulta(), sort: sort?.by, dir: sort?.dir, cursor, limit },
            { signal },
          );
          if (!cursor) store.set({ total: respuesta.total ?? null });
          return { rows: respuesta.contacts, next: respuesta.nextCursor };
        } catch (error) {
          // Un cursor que caducó (el servidor se reinició): se vuelve a empezar la lista.
          if (cursor && error?.code === 'invalid_cursor') {
            setTimeout(() => tabla.reload(), 0);
            return { rows: [], next: null };
          }
          throw error;
        }
      },
      onOpen: (contacto, quien) => abrir(contacto.id, contacto.name, quien),
      empty: {
        title: 'Ningún contacto coincide',
        text: 'Prueba con otra búsqueda o quita algún filtro.',
        action: html`<button type="button" class="k-btn" data-do="limpiar">Quitar búsqueda y filtros</button>`,
      },
    });
    ctx.onUnmount(tabla.destroy);

    const detalle = detailPanel(ranura('detalle'), {
      onClose: () => {
        abierto = null;
        ctx.keep.delete('abierto');
      },
    });
    ctx.onUnmount(detalle.destroy);

    function abrir(id, nombre, quien) {
      ctx.keep.set('abierto', { id, nombre });
      detalle.open({
        title: nombre,
        opener: quien,
        mount(cuerpo) {
          let vivo = true;
          async function recargar() {
            try {
              const ruta = encodeURIComponent(id);
              // El bloque «WhatsApp» es un extra: si no llega, la ficha se pinta igual.
              const [datos, wa] = await Promise.all([
                api.get(`/api/contacts/${ruta}`),
                api.get(`/api/identity/contacts/${ruta}`).catch(error => {
                  if (isAbort(error)) throw error;
                  return null;
                }),
              ]);
              if (vivo) render(cuerpo, fichaContacto(datos, wa?.whatsapp ?? null));
            } catch (error) {
              if (!vivo || isAbort(error)) return;
              render(cuerpo, failure({ title: 'No se pudo abrir el contacto', error, retry: 'ficha-reintentar' }));
            }
          }
          render(cuerpo, loading('Abriendo el contacto…'));
          const off = listen(
            cuerpo,
            { click: { 'ficha-reintentar': recargar, 'ir-contactos': () => ctx.go('contacts') } },
            { contain: false },
          );
          abierto = { id, recargar };
          recargar();
          return () => {
            vivo = false;
            off();
            abierto = null;
          };
        },
      });
    }

    // ---- Filtros rápidos, resumen y total
    function pintarRapidos(estado) {
      render(
        ranura('rapidos'),
        html`${RAPIDOS.map(
          rapido =>
            html`<button type="button" class="k-filter ct-rapido" data-do="rapido" data-id="${rapido.id}" aria-pressed="${estado.quick.includes(rapido.id)}">
              ${rapido.label}
            </button>`,
        )}`,
      );
    }
    function pintarResumen(estado) {
      const frase = estado.campos ? describeConditions(estado.filtro, estado.campos) : '';
      render(
        ranura('resumen'),
        html`${frase ? `Filtro: ${frase}.` : ''}${when(!estado.completo, () => ' Falta completar una condición.')}`,
      );
      // El total es la cifra de la vista: grande a la vista y, para quien escucha, la frase completa («1 contacto»).
      const total = estado.total;
      const donde = marca === 'all' ? ' en tus marcas' : '';
      const texto =
        total === null
          ? 'Buscando contactos…'
          : total.capped
            ? `Más de ${NUMERO.format(total.n)} contactos`
            : `${NUMERO.format(total.n)} ${total.n === 1 ? 'contacto' : 'contactos'}`;
      render(
        ranura('total'),
        total === null
          ? html`<span class="k-figure__sub">${texto}</span>`
          : html`<span class="k-figure__value" aria-hidden="true">${total.capped ? '+' : ''}${NUMERO.format(total.n)}</span>
              <span class="k-figure__sub"><span class="k-sr">${texto}</span><span aria-hidden="true">${total.n === 1 && !total.capped ? 'contacto' : 'contactos'}</span>${donde}</span>`,
      );
    }

    const desuscribir = store.subscribe((estado, antes) => {
      ctx.keep.set('estado', { q: estado.q, quick: estado.quick, filtro: estado.filtro, completo: estado.completo });
      pintarRapidos(estado);
      pintarResumen(estado);
      const cambio = estado.q !== antes.q || estado.quick !== antes.quick || estado.filtro !== antes.filtro;
      if (estado.completo && cambio) tabla.reload();
    });
    ctx.onUnmount(desuscribir);
    ctx.onUnmount(store.destroy);
    pintarRapidos(store.get());
    pintarResumen(store.get());

    // ---- El constructor necesita las opciones de la marca (etiquetas, cursos, responsables)
    async function cargarOpciones() {
      render(ranura('condiciones'), loading('Cargando los filtros…'));
      let opciones;
      try {
        opciones = await api.get('/api/contacts/filters', { brand: marca });
      } catch (error) {
        if (!isAbort(error))
          render(
            ranura('condiciones'),
            failure({ title: 'No se pudieron cargar los filtros', error, retry: 'opciones' }),
          );
        return;
      }
      const campos = camposFiltro(opciones);
      filtros?.destroy();
      filtros = conditionsBuilder(ranura('condiciones'), {
        fields: campos,
        value: store.get().filtro,
        label: 'Filtros de contactos',
        onChange: (definicion, { complete }) => store.set({ filtro: definicion, completo: complete }),
      });
      store.set({ campos, completo: conditionProblems(store.get().filtro, campos).length === 0 });
    }
    ctx.onUnmount(() => filtros?.destroy());
    cargarOpciones();

    // ---- Avisos en vivo: se piden sólo las filas que cambiaron y que ya están a la vista
    function pintarAviso(otros) {
      render(
        ranura('aviso'),
        when(
          otros,
          () => html`<div class="k-notice ct-aviso" role="status">
            <span>Hay cambios en contactos que no están a la vista.</span>
            <button type="button" class="k-btn" data-do="recargar">Actualizar la lista</button>
          </div>`,
          () => html``,
        ),
      );
    }
    async function aplicarCambios() {
      const ids = [...pendientes];
      pendientes.clear();
      const vistas = new Set(tabla.rows().map(c => c.id));
      const cargadas = ids.filter(id => vistas.has(id));
      if (ids.some(id => !vistas.has(id))) pintarAviso(true);
      if (abierto && ids.includes(abierto.id)) abierto.recargar();
      for (let desde = 0; desde < cargadas.length; desde += 50) {
        const lote = cargadas.slice(desde, desde + 50);
        try {
          const { contacts } = await api.get('/api/contacts', { ...consulta(), ids: lote.join(',') });
          const llegaron = new Set(contacts.map(c => c.id));
          for (const contacto of contacts) tabla.upsert(contacto);
          // Lo que no volvió ya no cumple la búsqueda o los filtros (o se unió a otro contacto).
          for (const id of lote) if (!llegaron.has(id)) tabla.remove(id);
        } catch (error) {
          if (!isAbort(error)) pintarAviso(true);
          return;
        }
      }
    }
    enVivo.set(ctx, {
      cambiaron(ids, brandId) {
        if (marca !== 'all' && brandId !== marca) return;
        for (const id of ids) pendientes.add(id);
        // Varios avisos seguidos se juntan en una sola petición.
        clearTimeout(esperaVivo);
        esperaVivo = setTimeout(aplicarCambios, 400);
      },
    });
    ctx.onUnmount(() => {
      enVivo.delete(ctx);
      clearTimeout(esperaVivo);
      clearTimeout(espera);
    });

    // ---- Añadir la selección a una lista (de Audiencias). Los permisos los decide el servidor (audiences.edit).
    async function anadirALista() {
      const claves = new Set(tabla.selection());
      const elegidos = tabla.rows().filter(c => claves.has(c.id));
      if (!elegidos.length) return;
      const marcas = [...new Set(elegidos.map(c => c.brandId))];
      const hecho = await ventanaLista({ api, ctx, elegidos, marca: marcas.length === 1 ? marcas[0] : null });
      if (!hecho) return;
      const cuantos =
        hecho.added === 1 ? 'Se añadió 1 contacto' : `Se añadieron ${NUMERO.format(hecho.added)} contactos`;
      const ya = hecho.already ? ` (${NUMERO.format(hecho.already)} ya estaban)` : '';
      ctx.toast(`${cuantos} a «${hecho.name}»${ya}.`);
      tabla.clearSelection();
    }

    // ---- Eventos de la pantalla
    ctx.onUnmount(
      listen(
        root,
        {
          input: {
            buscar: (_evento, campo) => {
              const valor = campo.value.trim();
              // Lo escrito se guarda en el acto (un remontaje no lo pierde); la búsqueda espera a que se deje de teclear.
              ctx.keep.set('estado', { ...ctx.keep.get('estado'), q: valor });
              clearTimeout(espera);
              espera = setTimeout(() => store.set({ q: valor }), 300);
            },
          },
          click: {
            rapido: (_evento, boton) => {
              const id = boton.getAttribute('data-id');
              const { quick } = store.get();
              store.set({ quick: quick.includes(id) ? quick.filter(item => item !== id) : [...quick, id] });
            },
            limpiar: () => {
              const campo = root.querySelector('[data-do="buscar"]');
              if (campo) campo.value = '';
              clearTimeout(espera);
              store.set({ q: '', quick: [], filtro: emptyConditions(), completo: true });
              if (store.get().campos) cargarOpciones();
            },
            recargar: () => {
              pintarAviso(false);
              tabla.reload();
            },
            opciones: cargarOpciones,
            'anadir-lista': anadirALista,
          },
          scroll: {
            // La posición de la lista sobrevive a un remontaje.
            pagina: () => ctx.keep.set('posicion', pagina.scrollTop),
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );

    // ---- Al volver: el contacto que estaba abierto y la posición de la lista
    const antes = ctx.keep.get('abierto');
    if (antes) abrir(antes.id, antes.nombre);
    const posicion = ctx.keep.get('posicion');
    if (posicion) {
      // Se espera a que llegue la primera página (como mucho unos segundos) y se vuelve al mismo punto.
      let intentos = 0;
      let tope = 0;
      const volver = () => {
        if (!pagina.isConnected) return;
        if (tabla.rows().length) pagina.scrollTop = posicion;
        else if (++intentos < 20) tope = setTimeout(volver, 150);
      };
      tope = setTimeout(volver, 150);
      ctx.onUnmount(() => clearTimeout(tope));
    }
  },

  /** Aviso en vivo: sólo `contacts.changed` interesa aquí, y sólo pide las filas que cambiaron. */
  onEvent(evento, ctx) {
    if (evento?.type !== 'contacts.changed' || !Array.isArray(evento.data?.ids)) return;
    enVivo.get(ctx)?.cambiaron(evento.data.ids, evento.brandId);
  },
};
