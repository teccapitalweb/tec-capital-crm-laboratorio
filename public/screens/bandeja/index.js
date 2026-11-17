/**
 * Bandeja: vistas, contadores, filtros y búsqueda de conversaciones (docs/PLAN_BANDEJA_VISTAS.md).
 *
 * Por qué existe: la lista de «Conversaciones» de siempre recibe todo de una vez y filtra en el navegador; con
 * conversaciones reales de WhatsApp el equipo necesita ordenarse por vistas («Mías», «Sin respuesta», «No
 * leídas»…), con su contador, y guardar las suyas. Aquí todo lo decide el servidor (módulo `inbox`): la lista va
 * de cuarenta en cuarenta, los contadores salen de consultas por índice y la búsqueda nunca sale de las marcas de
 * quien busca.
 *
 * Qué NO hace: no pinta el hilo ni el compositor. Abrir una fila lleva a la conversación en «Conversaciones»
 * (ctx.openConversation), donde se responde como siempre.
 *
 * En vivo: el servidor avisa `inbox.changed` (mensajes y acciones del equipo), `inbox.upsert` (cambios de estado)
 * e `inbox.views` (vistas compartidas). Aquí se vuelven a pedir los contadores y, si sólo se ve la primera
 * página, la lista; si ya se cargaron más, se ofrece «Actualizar». Además los contadores se refrescan cada minuto.
 * Lo que debe sobrevivir a un remontaje (vista, filtro, orden, búsqueda) vive en ctx.keep.
 */
import { attrs, html, render, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { createStore } from '../../kit/state.js';
import { isAbort, isStale, newClientRef } from '../../kit/api.js';
import { confirm, dialog } from '../../kit/components/dialog.js';
import { field } from '../../kit/components/form.js';
import {
  conditionProblems,
  conditionsBuilder,
  describeConditions,
  emptyConditions,
} from '../../kit/components/conditions.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';

// ---------------------------------------------------------------------------------------------------
// Definiciones (las mismas claves que el servidor)
// ---------------------------------------------------------------------------------------------------

const ESTADOS = [
  { value: 'open', label: 'Abierta' },
  { value: 'pending', label: 'Pendiente' },
  { value: 'solved', label: 'Resuelta' },
  { value: 'expired', label: 'Expirada' },
  { value: 'awaiting', label: 'Esperando primera respuesta' },
  { value: 'blocked', label: 'Bloqueada' },
];
const TONO_ESTADO = { open: 'k-chip--accent', pending: 'k-chip--warn', solved: 'k-chip--ok', expired: 'k-chip--bad' };
const QUIEN = [
  { value: 'assistant', label: 'El asistente' },
  { value: 'person', label: 'Una persona del equipo' },
  { value: 'queue', label: 'Nadie (en espera)' },
];
const CANALES = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
];
const ORIGENES = [
  { value: 'inbound', label: 'Escribió la persona' },
  { value: 'ad', label: 'Anuncio' },
  { value: 'broadcast', label: 'Difusión' },
  { value: 'outbound', label: 'Iniciada por el equipo' },
  { value: 'api', label: 'API' },
  { value: 'import', label: 'Importación' },
  { value: 'lab', label: 'Laboratorio' },
];
const ETAPAS = [
  { value: 'nuevo', label: 'Nuevo' },
  { value: 'interesado', label: 'Interesado' },
  { value: 'inscripcion', label: 'Inscripción' },
  { value: 'ganada', label: 'Ganada' },
  { value: 'perdida', label: 'Perdida' },
];
const PRIORIDADES = [
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'Alta' },
  { value: 'urgent', label: 'Urgente' },
];
const ORDENES = [
  { value: 'recent', label: 'Más recientes' },
  { value: 'oldest', label: 'Más antiguas' },
  { value: 'waiting', label: 'Espera más larga', only: 'unreplied' },
];
const DIAS = [
  { op: 'in_last_days', valueType: 'number', label: 'en los últimos (días)' },
  { op: 'not_in_last_days', valueType: 'number', label: 'no en los últimos (días)' },
  { op: 'after', valueType: 'date' },
  { op: 'before', valueType: 'date' },
];
const COINCIDE = { contact: 'Persona', course: 'Curso', message: 'Mensaje' };

const rotulo = (lista, valor) => lista.find(item => item.value === valor)?.label ?? valor;
const NUMERO = new Intl.NumberFormat('es-MX');
const HORA = new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit' });
const DIA = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' });
function cuando(instante) {
  if (!instante) return '';
  const fecha = new Date(instante);
  const hoy = new Date();
  return fecha.toDateString() === hoy.toDateString() ? HORA.format(fecha) : DIA.format(fecha);
}
const cuenta = c => (!c ? '' : c.capped ? `${NUMERO.format(c.n)}+` : NUMERO.format(c.n));
const iniciales = nombre =>
  String(nombre ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(parte => parte[0].toUpperCase())
    .join('') || '?';

/** Campos del constructor de filtros: los mismos que registra el servidor (ámbito «conversation»). */
function camposFiltro(opciones, conMarca) {
  const lista = (items, valor, texto) => items.map(item => ({ value: item[valor], label: item[texto] }));
  const campos = [
    { name: 'state', label: 'Estado', ops: ['in', 'not_in'], options: ESTADOS },
    { name: 'handler', label: 'Quién atiende', ops: ['eq', 'neq'], options: QUIEN },
    {
      name: 'assignee',
      label: 'Responsable',
      ops: ['in', 'not_in', { op: 'empty', label: 'no tiene', valueType: 'none' }],
      options: [{ value: 'me', label: 'Yo' }, ...lista(opciones.assignees, 'id', 'name')],
    },
    { name: 'channel', label: 'Canal', ops: ['in', 'not_in'], options: CANALES },
    { name: 'origin', label: 'Origen', ops: ['in', 'not_in'], options: ORIGENES },
    { name: 'stage', label: 'Etapa comercial', ops: ['any', 'none'], options: ETAPAS },
    { name: 'priority', label: 'Prioridad', ops: ['in'], options: PRIORIDADES },
    { name: 'unread', label: 'Sin leer', ops: [{ op: 'is', valueType: 'boolean' }] },
    { name: 'waiting', label: 'Espera respuesta del equipo', ops: [{ op: 'is', valueType: 'boolean' }] },
    { name: 'activity', label: 'Última actividad', ops: DIAS },
  ];
  if (opciones.courses.length)
    campos.push({
      name: 'course',
      label: 'Curso',
      ops: ['in', 'not_in'],
      options: lista(opciones.courses, 'id', 'title'),
    });
  if (opciones.tags.length)
    campos.push({
      name: 'tag',
      label: 'Etiqueta del contacto',
      ops: ['any', 'all', 'none'],
      options: lista(opciones.tags, 'id', 'name'),
    });
  if (opciones.numbers.length)
    campos.push({
      name: 'number',
      label: 'Número de WhatsApp',
      ops: ['in'],
      options: lista(opciones.numbers, 'id', 'label'),
    });
  if (conMarca && opciones.brands.length > 1)
    campos.push({
      name: 'brand',
      label: 'Marca',
      ops: ['in', 'not_in'],
      options: lista(opciones.brands, 'id', 'name'),
    });
  return campos;
}

const vacio = filtro => !filtro?.groups?.length;
const igual = (a, b) => JSON.stringify(a ?? emptyConditions()) === JSON.stringify(b ?? emptyConditions());

// ---------------------------------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------------------------------

/** Distintivo de canal: punto de su color y el nombre (el color nunca es lo único que lo dice). */
const canal = valor => html`<span class="${['bj-canal', `bj-canal--${valor}`]}">${rotulo(CANALES, valor)}</span>`;

function quienAtiende(c) {
  if (c.handler === 'assistant') return 'Asistente';
  if (c.assignee) return c.assignee.name;
  return 'Sin asignar';
}

function fila(c, { marcas, coincide }) {
  const nombre = c.customer.name;
  const detalle = coincide ? `${COINCIDE[coincide.kind] ?? ''}: ${coincide.text}` : c.preview || 'Sin mensajes todavía';
  return html`<li class="bj-item" data-key="${c.id}">
    <button type="button" class="bj-fila" data-do="abrir" data-id="${c.id}" aria-label="${`Abrir la conversación con ${nombre}`}">
      <span class="bj-avatar" aria-hidden="true">${iniciales(nombre)}</span>
      <span class="bj-texto">
        <span class="bj-linea">
          <strong class="bj-nombre">${nombre}</strong>
          <span class="bj-hora">${cuando(c.activityAt)}</span>
        </span>
        <span class="bj-linea bj-linea--meta">
          ${canal(c.channel)}
          <span class="bj-curso">${marcas ? `${c.brandName} · ` : ''}${c.course.title}</span>
        </span>
        <span class="bj-vista-previa">${detalle}</span>
        <span class="bj-linea bj-linea--chips">
          <span class="${['k-chip', TONO_ESTADO[c.state] ?? '']}">${rotulo(ESTADOS, c.state)}</span>
          <span class="bj-quien">${quienAtiende(c)}</span>
          ${when(c.service.waitingSince, () => html`<span class="k-chip k-chip--warn">Sin respuesta</span>`)}
          ${c.tags.slice(0, 2).map(tag => html`<span class="k-chip">${tag.name}</span>`)}
          ${when(
            c.unread > 0,
            () =>
              html`<span class="bj-no-leidos" aria-label="${`${c.unread} sin leer`}">${c.unread > 99 ? '99+' : String(c.unread)}</span>`,
          )}
        </span>
      </span>
    </button>
  </li>`;
}

/** Lista de vistas con su contador (columna en computadora; ventana en celular). */
function listaVistas(estado) {
  const boton = (clave, nombre, extra = html``) => {
    const activa = estado.vista === clave;
    return html`<li data-key="${clave}">
      <button type="button" class="bj-vista" data-do="vista" data-id="${clave}" ${attrs({ 'aria-current': activa ? 'true' : null })}>
        <span class="bj-vista__nombre">${nombre}</span>${extra}
        <span class="bj-vista__cuenta">${cuenta(estado.cuentas[clave])}</span>
      </button>
    </li>`;
  };
  const guardadas = estado.vistas?.saved ?? [];
  return html`<h2 class="bj-subtitulo">Vistas</h2>
    <ul class="bj-vistas__lista" role="list">
      ${(estado.vistas?.system ?? []).map(vista => boton(vista.key, vista.name))}
    </ul>
    <h2 class="bj-subtitulo">Guardadas</h2>
    ${when(
      guardadas.length,
      () =>
        html`<ul class="bj-vistas__lista" role="list">
          ${guardadas.map(vista =>
            boton(
              'saved:' + vista.id,
              vista.name,
              when(vista.visibility !== 'me', () => html`<span class="bj-compartida">Equipo</span>`),
            ),
          )}
        </ul>`,
      () => html`<p class="k-hint bj-sin-guardadas">Filtra la lista y pulsa «Guardar vista».</p>`,
    )}`;
}

// ---------------------------------------------------------------------------------------------------
// Ventana para guardar o editar una vista
// ---------------------------------------------------------------------------------------------------

function ventanaVista({ ctx, actual, marca, compartibles, cuerpoVista }) {
  return dialog({
    title: actual ? 'Editar vista' : 'Guardar vista',
    mount(cuerpo, cerrar) {
      const clientRef = newClientRef();
      let error = '';
      const valores = {
        name: actual?.name ?? '',
        share: actual ? actual.visibility !== 'me' : false,
        brandId: actual?.brandId ?? (marca !== 'all' ? marca : (compartibles[0] ?? '')),
      };
      const puedeCompartir = compartibles.length > 0;
      const pintar = () =>
        render(
          cuerpo,
          html`<form class="k-stack" novalidate data-do="guardar">
            ${field({ name: 'name', label: 'Nombre', required: true, maxlength: 60, autocomplete: 'off' }, { id: ctx.uid('vista-nombre'), value: valores.name })}
            ${when(puedeCompartir, () =>
              field(
                { name: 'share', label: 'Compartir con todo el equipo de la marca', type: 'checkbox' },
                { id: ctx.uid('vista-compartir'), value: valores.share },
              ),
            )}
            ${when(puedeCompartir && compartibles.length > 1, () =>
              field(
                {
                  name: 'brandId',
                  label: 'Marca con la que se comparte',
                  type: 'select',
                  options: compartibles.map(id => ({ value: id.value, label: id.label })),
                },
                { id: ctx.uid('vista-marca'), value: valores.brandId },
              ),
            )}
            <p class="k-hint">${cuerpoVista}</p>
            <p class="k-error" role="alert">${error}</p>
            <div class="k-actions">
              <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
              <button type="submit" class="k-btn k-btn--primary">${actual ? 'Guardar cambios' : 'Guardar vista'}</button>
            </div>
          </form>`,
        );
      pintar();
      return listen(cuerpo, {
        click: { cancelar: () => cerrar(null) },
        submit: {
          async guardar(_evento, formulario) {
            const datos = formValues(formulario);
            valores.name = String(datos.name ?? '').trim();
            valores.share = datos.share === true;
            if (datos.brandId) valores.brandId = String(datos.brandId);
            if (!valores.name) {
              error = 'Escribe un nombre para la vista.';
              pintar();
              return;
            }
            cerrar({ ...valores, clientRef });
          },
        },
      });
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------------------------------

/** Lo vivo de cada montaje, para que onEvent() llegue a la pantalla. Se quita al salir. */
const enVivo = new WeakMap();

export default {
  mount(root, ctx) {
    const { api } = ctx;
    const marca = ctx.brand ?? 'all';
    const supervisa = ctx.user?.role === 'admin';
    const guardado = ctx.keep.get('estado') ?? {};
    const store = createStore({
      vista: guardado.vista ?? (supervisa ? 'active' : 'mine'),
      filtro: guardado.filtro ?? emptyConditions(),
      completo: guardado.completo ?? true,
      orden: guardado.orden ?? null,
      q: guardado.q ?? '',
      vistas: null,
      cuentas: {},
      campos: null,
      marcas: [],
    });
    let filas = [];
    let siguiente = null;
    let paginas = 0;
    let pedido = 0;
    let filtros = null;
    let espera = 0;
    let esperaVivo = 0;
    let reloj = 0;

    render(
      root,
      html`<section class="k-page bj-page">
        <header class="k-head bj-cabeza">
          <div>
            <p class="k-eyebrow">Atención</p>
            <h1>Bandeja</h1>
          </div>
          <div class="bj-buscar">
            <label class="k-sr" for="${ctx.uid('buscar')}">Buscar en la bandeja</label>
            <input
              type="search"
              class="k-input"
              id="${ctx.uid('buscar')}"
              data-do="buscar"
              placeholder="Buscar persona, teléfono, curso o mensaje"
              autocomplete="off"
              value="${guardado.q ?? ''}"
            />
          </div>
        </header>
        <div class="bj-cuerpo">
          <nav class="bj-vistas k-card" aria-label="Vistas de la bandeja" data-slot="vistas"></nav>
          <div class="bj-principal">
            <div class="bj-barra">
              <button type="button" class="k-btn bj-abrir-vistas" data-do="abrir-vistas" aria-haspopup="dialog" data-slot="boton-vistas"></button>
              <div class="bj-titulo">
                <h2 data-slot="titulo"></h2>
                <p class="k-muted" data-slot="total" aria-live="polite"></p>
              </div>
              <div class="bj-controles">
                <label class="k-sr" for="${ctx.uid('orden')}">Orden</label>
                <select class="k-input bj-orden" id="${ctx.uid('orden')}" data-do="orden" data-slot="orden"></select>
                <details class="bj-filtros" data-do="filtros" ${attrs({ open: Boolean(ctx.keep.get('filtros-abiertos')) })}>
                  <summary class="k-btn">Filtros</summary>
                </details>
              </div>
            </div>
            <div class="k-card bj-panel-filtros" data-slot="condiciones" hidden></div>
            <p class="k-hint bj-resumen" data-slot="resumen"></p>
            <div class="k-row bj-acciones" data-slot="acciones"></div>
            <div data-slot="aviso"></div>
            <div class="k-card bj-lista" data-slot="filas"></div>
            <div class="bj-mas" data-slot="mas"></div>
          </div>
        </div>
      </section>`,
    );
    const ranura = nombre => root.querySelector(`[data-slot="${nombre}"]`);
    const detalles = root.querySelector('.bj-filtros');
    const panelFiltros = ranura('condiciones');
    const sincronizarFiltros = () => {
      panelFiltros.hidden = !detalles.open;
      ctx.keep.set('filtros-abiertos', detalles.open);
    };
    sincronizarFiltros();

    // ---- Lo que identifica lo que se mira
    const guardadaActiva = estado =>
      estado.vista.startsWith('saved:')
        ? ((estado.vistas?.saved ?? []).find(vista => 'saved:' + vista.id === estado.vista) ?? null)
        : null;
    const sistemaActiva = estado => (estado.vistas?.system ?? []).find(vista => vista.key === estado.vista) ?? null;
    const base = estado => guardadaActiva(estado)?.base ?? (estado.vista.startsWith('saved:') ? 'all' : estado.vista);
    const nombreVista = estado =>
      guardadaActiva(estado)?.name ??
      sistemaActiva(estado)?.name ??
      (estado.vista.startsWith('saved:') ? 'Vista guardada' : 'Bandeja');
    const ordenDe = estado => {
      const natural = guardadaActiva(estado)?.sort ?? sistemaActiva(estado)?.sort ?? 'recent';
      const elegido = estado.orden ?? natural;
      return elegido === 'waiting' && base(estado) !== 'unreplied' ? 'recent' : elegido;
    };
    const sinGuardar = estado => {
      const guardada = guardadaActiva(estado);
      return guardada ? !igual(estado.filtro, guardada.filter) : !vacio(estado.filtro);
    };
    function consulta(estado) {
      const guardada = guardadaActiva(estado);
      const sort = ordenDe(estado);
      if (guardada && !sinGuardar(estado)) return { brand: guardada.brandId ?? marca, view: estado.vista, sort };
      return {
        brand: guardada?.brandId ?? marca,
        view: base(estado),
        sort,
        filter: vacio(estado.filtro) ? null : estado.filtro,
      };
    }

    // ---- Pintar
    function pintarVistas(estado) {
      render(ranura('vistas'), listaVistas(estado));
      render(
        ranura('boton-vistas'),
        html`<span>Vistas</span><span class="bj-vista__cuenta">${nombreVista(estado)} · ${cuenta(estado.cuentas[estado.vista]) || '…'}</span>`,
      );
      render(ranura('titulo'), html`${nombreVista(estado)}`);
      const b = base(estado);
      render(
        ranura('orden'),
        html`${ORDENES.filter(o => !o.only || o.only === b).map(
          o => html`<option value="${o.value}" ${attrs({ selected: ordenDe(estado) === o.value })}>${o.label}</option>`,
        )}`,
      );
    }
    function pintarResumen(estado) {
      const frase = estado.campos && !vacio(estado.filtro) ? describeConditions(estado.filtro, estado.campos) : '';
      render(
        ranura('resumen'),
        html`${frase ? `Filtro: ${frase}.` : ''}${when(!estado.completo, () => ' Falta completar una condición.')}`,
      );
      const guardada = guardadaActiva(estado);
      const cambios = sinGuardar(estado);
      render(
        ranura('acciones'),
        html`${when(
          cambios && estado.completo && (!guardada || guardada.editable),
          () =>
            html`<button type="button" class="k-btn k-btn--primary" data-do="${guardada ? 'guardar-cambios' : 'guardar-vista'}">
              ${guardada ? 'Guardar cambios en la vista' : 'Guardar vista'}
            </button>`,
        )}
        ${when(
          cambios && guardada,
          () => html`<button type="button" class="k-btn" data-do="descartar">Descartar cambios</button>`,
        )}
        ${when(
          guardada?.editable && !cambios,
          () => html`<button type="button" class="k-btn" data-do="editar-vista">Editar vista</button>
            <button type="button" class="k-btn k-btn--danger" data-do="borrar-vista">Borrar vista</button>`,
        )}
        ${when(
          guardada && !guardada.editable,
          () => html`<span class="k-muted">Vista compartida por ${guardada.ownerName}.</span>`,
        )}`,
      );
    }
    function pintarTotal(total) {
      render(
        ranura('total'),
        html`${
          total === null
            ? 'Buscando conversaciones…'
            : total === undefined
              ? ''
              : total.capped
                ? `Más de ${NUMERO.format(total.n)} conversaciones`
                : `${NUMERO.format(total.n)} ${total.n === 1 ? 'conversación' : 'conversaciones'}`
        }${marca === 'all' ? ' en tus marcas' : ''}`,
      );
    }
    function pintarFilas({ coincidencias = null } = {}) {
      const caja = ranura('filas');
      if (!filas.length) {
        render(
          caja,
          coincidencias
            ? empty({
                title: 'Nada coincide con la búsqueda',
                text: 'Prueba con otro nombre, teléfono, curso o palabra.',
              })
            : empty({ title: 'No hay conversaciones en esta vista', text: 'Cuando lleguen aparecerán aquí.' }),
        );
        return;
      }
      render(
        caja,
        html`<ul class="bj-filas" role="list">
          ${filas.map(c => fila(c, { marcas: marca === 'all', coincide: coincidencias?.get(c.id) }))}
        </ul>`,
      );
    }
    function pintarMas() {
      render(
        ranura('mas'),
        when(
          siguiente,
          () => html`<button type="button" class="k-btn" data-do="mas">Cargar más conversaciones</button>`,
          () => html``,
        ),
      );
    }
    function pintarAviso(hay) {
      render(
        ranura('aviso'),
        when(
          hay,
          () => html`<div class="k-notice bj-aviso" role="status">
            <span>Hay conversaciones nuevas o con cambios.</span>
            <button type="button" class="k-btn" data-do="recargar">Actualizar la lista</button>
          </div>`,
          () => html``,
        ),
      );
    }

    // ---- Datos
    async function cargarCuentas() {
      try {
        const { counts } = await api.get('/api/inbox/counts', { brand: marca });
        store.set({ cuentas: counts });
      } catch (error) {
        if (!isAbort(error)) ctx.toast?.('No se pudieron actualizar los contadores.');
      }
    }
    async function cargarVistas() {
      try {
        const vistas = await api.get('/api/inbox/views', { brand: marca });
        const estado = store.get();
        // Una vista guardada que ya no existe (o dejó de compartirse) lleva a la vista por omisión.
        if (estado.vista.startsWith('saved:') && !vistas.saved.some(v => 'saved:' + v.id === estado.vista))
          store.set({ vistas, vista: supervisa ? 'active' : 'mine', filtro: emptyConditions(), orden: null });
        else store.set({ vistas });
      } catch (error) {
        if (!isAbort(error))
          render(
            ranura('vistas'),
            failure({ title: 'No se pudieron cargar las vistas', error, retry: 'reintentar-vistas' }),
          );
      }
    }
    async function cargarLista({ mas = false, silencioso = false } = {}) {
      const estado = store.get();
      if (!estado.vistas || !estado.completo) return;
      const yo = ++pedido;
      if (estado.q.length >= 2) return buscar(estado.q, yo);
      if (!mas && !silencioso) {
        render(ranura('filas'), loading('Cargando conversaciones…'));
        pintarTotal(null);
      }
      try {
        const respuesta = await api.get('/api/inbox/conversations', {
          ...consulta(estado),
          ...(mas && siguiente ? { cursor: siguiente } : {}),
        });
        if (yo !== pedido) return;
        filas = mas ? [...filas, ...respuesta.conversations] : respuesta.conversations;
        paginas = mas ? paginas + 1 : 1;
        siguiente = respuesta.nextCursor;
        if (!mas) pintarTotal(respuesta.total);
        pintarFilas();
        pintarMas();
        pintarAviso(false);
      } catch (error) {
        if (isAbort(error) || yo !== pedido) return;
        render(ranura('filas'), failure({ title: 'No se pudo cargar la lista', error, retry: 'recargar' }));
        pintarTotal(undefined);
      }
    }
    async function buscar(q, yo) {
      render(ranura('filas'), loading('Buscando…'));
      render(ranura('mas'), html``);
      try {
        const { results, partial } = await api.get('/api/inbox/search', { brand: marca, q });
        if (yo !== pedido) return;
        filas = results.map(r => r.conversation);
        siguiente = null;
        paginas = 1;
        render(
          ranura('total'),
          html`${results.length === 1 ? '1 resultado' : `${NUMERO.format(results.length)} resultados`}${partial ? ' (en los mensajes más recientes)' : ''}`,
        );
        pintarFilas({ coincidencias: new Map(results.map(r => [r.conversation.id, r.match])) });
      } catch (error) {
        if (isAbort(error) || yo !== pedido) return;
        render(ranura('filas'), failure({ title: 'No se pudo buscar', error, retry: 'recargar' }));
      }
    }
    async function cargarOpciones() {
      render(panelFiltros, loading('Cargando los filtros…'));
      try {
        const opciones = await api.get('/api/inbox/filters', { brand: marca });
        const campos = camposFiltro(opciones, marca === 'all');
        filtros?.destroy();
        filtros = conditionsBuilder(panelFiltros, {
          fields: campos,
          value: store.get().filtro,
          label: 'Filtros de la bandeja',
          onChange: (definicion, { complete }) => store.set({ filtro: definicion, completo: complete }),
        });
        store.set({
          campos,
          marcas: opciones.brands,
          completo: conditionProblems(store.get().filtro, campos).length === 0,
        });
      } catch (error) {
        if (!isAbort(error))
          render(panelFiltros, failure({ title: 'No se pudieron cargar los filtros', error, retry: 'opciones' }));
      }
    }
    // El constructor muestra el filtro de la vista elegida (una guardada trae el suyo; una del sistema, ninguno).
    function ponerFiltro(definicion) {
      store.set({ filtro: definicion, completo: true });
      const campos = store.get().campos;
      if (campos) {
        filtros?.destroy();
        filtros = conditionsBuilder(panelFiltros, {
          fields: campos,
          value: definicion,
          label: 'Filtros de la bandeja',
          onChange: (d, { complete }) => store.set({ filtro: d, completo: complete }),
        });
      }
    }

    const desuscribir = store.subscribe((estado, antes) => {
      ctx.keep.set('estado', {
        vista: estado.vista,
        filtro: estado.filtro,
        completo: estado.completo,
        orden: estado.orden,
        q: estado.q,
      });
      pintarVistas(estado);
      pintarResumen(estado);
      const cambio =
        estado.vista !== antes.vista ||
        estado.filtro !== antes.filtro ||
        estado.orden !== antes.orden ||
        estado.q !== antes.q ||
        (estado.vistas && !antes.vistas);
      if (cambio && estado.completo) cargarLista();
    });
    ctx.onUnmount(desuscribir);
    ctx.onUnmount(store.destroy);
    pintarVistas(store.get());
    pintarResumen(store.get());
    render(ranura('filas'), loading('Cargando conversaciones…'));

    cargarVistas();
    cargarCuentas();
    cargarOpciones();
    reloj = setInterval(cargarCuentas, 60_000);
    ctx.onUnmount(() => clearInterval(reloj));

    // ---- Vistas: elegir, guardar, editar, borrar
    function elegirVista(clave) {
      const estado = store.get();
      const guardada = (estado.vistas?.saved ?? []).find(v => 'saved:' + v.id === clave);
      store.set({ vista: clave, orden: null });
      ponerFiltro(guardada ? guardada.filter : emptyConditions());
    }
    function compartibles(estado) {
      const nombres = new Map((estado.marcas ?? []).map(m => [m.id, m.name]));
      return (estado.vistas?.shareBrands ?? []).map(id => ({ value: id, label: nombres.get(id) ?? id }));
    }
    async function guardarVista() {
      const estado = store.get();
      const datos = await ventanaVista({
        ctx,
        actual: null,
        marca,
        compartibles: compartibles(estado),
        cuerpoVista: `Parte de «${nombreVista(estado)}» con el filtro y el orden de ahora.`,
      });
      if (!datos) return;
      const brandId = datos.share ? datos.brandId || null : marca !== 'all' ? marca : null;
      const { view } = await api.post('/api/inbox/views', {
        name: datos.name,
        base: base(estado),
        filter: estado.filtro,
        sort: ordenDe(estado),
        visibility: datos.share ? 'all' : 'me',
        brandId,
        clientRef: datos.clientRef,
      });
      ctx.toast?.(`Se guardó la vista «${view.name}».`);
      await cargarVistas();
      store.set({ vista: 'saved:' + view.id, orden: null });
      ponerFiltro(view.filter);
      cargarCuentas();
    }
    async function cambiarVista(cambios) {
      const guardada = guardadaActiva(store.get());
      if (!guardada) return;
      try {
        await api.patch(`/api/inbox/views/${guardada.id}`, {
          ...cambios,
          expectedRevision: guardada.revision,
          clientRef: newClientRef(),
        });
      } catch (error) {
        if (isStale(error)) {
          ctx.toast?.('Otra persona cambió esta vista. Se cargó la versión actual.');
          await cargarVistas();
          ponerFiltro(guardadaActiva(store.get())?.filter ?? emptyConditions());
          return;
        }
        throw error;
      }
      await cargarVistas();
      ponerFiltro(guardadaActiva(store.get())?.filter ?? emptyConditions());
      cargarCuentas();
    }
    async function editarVista() {
      const estado = store.get();
      const guardada = guardadaActiva(estado);
      if (!guardada) return;
      const datos = await ventanaVista({
        ctx,
        actual: guardada,
        marca,
        compartibles: compartibles(estado),
        cuerpoVista: 'Para cambiar el filtro, edítalo en «Filtros» y pulsa «Guardar cambios en la vista».',
      });
      if (!datos) return;
      await cambiarVista({
        name: datos.name,
        visibility: datos.share ? 'all' : 'me',
        brandId: datos.share ? datos.brandId || guardada.brandId : guardada.brandId,
      });
      ctx.toast?.('Se guardó la vista.');
    }
    async function borrarVista() {
      const guardada = guardadaActiva(store.get());
      if (!guardada) return;
      const ok = await confirm({
        title: 'Borrar vista',
        message: `¿Borrar «${guardada.name}»? ${guardada.visibility !== 'me' ? 'Dejará de verla todo el equipo.' : ''}`,
        confirmLabel: 'Borrar',
        danger: true,
      });
      if (!ok) return;
      await api.delete(`/api/inbox/views/${guardada.id}`, { expectedRevision: guardada.revision });
      ctx.toast?.('Se borró la vista.');
      store.set({ vista: supervisa ? 'active' : 'mine', orden: null });
      ponerFiltro(emptyConditions());
      await cargarVistas();
      cargarCuentas();
    }
    function abrirVistas() {
      return dialog({
        title: 'Vistas',
        actions: [{ id: 'cerrar', label: 'Cerrar' }],
        mount(cuerpo, cerrar) {
          render(
            cuerpo,
            html`<nav class="bj-vistas bj-vistas--hoja" aria-label="Vistas de la bandeja">${listaVistas(store.get())}</nav>`,
          );
          return listen(cuerpo, {
            click: {
              vista: (_evento, boton) => {
                elegirVista(boton.getAttribute('data-id'));
                cerrar(null);
              },
            },
          });
        },
      });
    }

    // ---- Avisos en vivo: contadores siempre; la lista si sólo se ve la primera página
    enVivo.set(ctx, {
      aviso(evento) {
        if (marca !== 'all' && evento.brandId && evento.brandId !== marca) return;
        clearTimeout(esperaVivo);
        esperaVivo = setTimeout(() => {
          cargarCuentas();
          if (evento.type === 'inbox.views') {
            cargarVistas();
            return;
          }
          if (store.get().q.length >= 2) return;
          if (paginas <= 1) cargarLista({ silencioso: true });
          else pintarAviso(true);
        }, 600);
      },
    });
    ctx.onUnmount(() => {
      enVivo.delete(ctx);
      clearTimeout(esperaVivo);
      clearTimeout(espera);
      filtros?.destroy();
    });

    ctx.onUnmount(
      listen(
        root,
        {
          input: {
            buscar: (_evento, campo) => {
              const valor = campo.value.trim();
              ctx.keep.set('estado', { ...ctx.keep.get('estado'), q: valor });
              clearTimeout(espera);
              espera = setTimeout(() => store.set({ q: valor.length >= 2 ? valor : '' }), 300);
            },
          },
          toggle: { filtros: sincronizarFiltros },
          change: {
            orden: (_evento, campo) => store.set({ orden: campo.value }),
          },
          click: {
            vista: (_evento, boton) => elegirVista(boton.getAttribute('data-id')),
            'abrir-vistas': abrirVistas,
            abrir: (_evento, boton) => {
              const id = boton.getAttribute('data-id');
              if (ctx.openConversation) ctx.openConversation(id);
              else ctx.go('inbox');
            },
            mas: () => cargarLista({ mas: true }),
            recargar: () => cargarLista(),
            'reintentar-vistas': cargarVistas,
            opciones: cargarOpciones,
            'guardar-vista': guardarVista,
            'guardar-cambios': () => {
              const estado = store.get();
              return cambiarVista({ filter: estado.filtro, sort: ordenDe(estado) }).then(() =>
                ctx.toast?.('Se guardaron los cambios de la vista.'),
              );
            },
            descartar: () => ponerFiltro(guardadaActiva(store.get())?.filter ?? emptyConditions()),
            'editar-vista': editarVista,
            'borrar-vista': borrarVista,
          },
        },
        { onError: error => ctx.toast?.(error.message) },
      ),
    );
  },

  /** Avisos en vivo de la bandeja: piden contadores y, si conviene, la primera página otra vez. */
  onEvent(evento, ctx) {
    if (!['inbox.changed', 'inbox.upsert', 'inbox.views'].includes(evento?.type)) return;
    enVivo.get(ctx)?.aviso(evento);
  },
};
