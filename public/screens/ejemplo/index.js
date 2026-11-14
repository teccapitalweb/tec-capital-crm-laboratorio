/**
 * Pantalla de ejemplo: usa todas las piezas del kit con datos de mentira.
 *
 * Es la plantilla para copiar. Una pantalla es una carpeta public/screens/<id>/ con:
 *   screen.json   quién es y dónde sale en el menú (lo lee el servidor; no se edita ningún otro archivo)
 *   index.js      este módulo: exporta por omisión {mount(root, ctx), onEvent(evento, ctx)}
 *   screen.css    opcional; sólo variables de public/tokens.css
 *
 * Qué mirar aquí:
 * - mount() pinta el esqueleto UNA vez, con ranuras (data-slot) donde viven los componentes.
 * - Todo evento va por data-do y listen(); nada escucha en `document` ni usa ids para repartir.
 * - Lo que hay que deshacer al salir se registra con ctx.onUnmount().
 * - Lo que debe sobrevivir a un remontaje (pestaña, búsqueda, borradores) vive en ctx.keep.
 * - Los datos llegan por la API, de cincuenta en cincuenta; aquí la API es de mentira (datos.js).
 *
 * Guía completa: docs/GUIA_PANTALLAS.md.
 */
import { html, render, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { createStore } from '../../kit/state.js';
import { createApi, isAbort, mutation } from '../../kit/api.js';
import { tabs } from '../../kit/components/tabs.js';
import { pagedTable } from '../../kit/components/table.js';
import { field, fieldError, form } from '../../kit/components/form.js';
import { confirm, dialog } from '../../kit/components/dialog.js';
import { detailPanel } from '../../kit/components/panel.js';
import {
  conditionProblems,
  conditionsBuilder,
  describeConditions,
  emptyConditions,
} from '../../kit/components/conditions.js';
import { wizard } from '../../kit/components/wizard.js';
import { failure, loading } from '../../kit/components/feedback.js';
import {
  bars,
  bind,
  columns,
  figure,
  funnel,
  heat,
  line,
  meter,
  responsive,
  segments,
  tile,
} from '../../kit/charts.js';
import { CONSENTIMIENTOS, ETIQUETAS, fakeFetch, touchElsewhere } from './datos.js';

// ---------------------------------------------------------------------------------------------------
// Definiciones (lo que en una pantalla real describe sus datos)
// ---------------------------------------------------------------------------------------------------

const TONO_CONSENTIMIENTO = { opted_in: 'k-chip--ok', unknown: '', opted_out: 'k-chip--bad' };
/** Número de color (1 a 6 de la paleta de gráficas) de cada resultado de un envío. */
const COLOR_RESULTADO = { read: 3, delivered: 1, failed: 2 };
const rotulo = (lista, valor) => lista.find(item => item.value === valor)?.label ?? valor;
const FECHA = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
const fecha = instante => FECHA.format(new Date(instante));

/** Campos de la ficha de un contacto. La validación de cada uno la hace el kit. */
const CAMPOS_CONTACTO = [
  { name: 'name', label: 'Nombre', required: true, maxlength: 80, autocomplete: 'off' },
  {
    name: 'phone',
    label: 'Teléfono',
    type: 'tel',
    required: true,
    hint: 'Con clave de país: +52 55 1234 5678.',
    inputmode: 'tel',
    autocomplete: 'off',
  },
  { name: 'email', label: 'Correo', type: 'email', maxlength: 120, autocomplete: 'off' },
  { name: 'consent', label: 'Consentimiento', type: 'select', required: true, options: CONSENTIMIENTOS },
  { name: 'notes', label: 'Notas', type: 'textarea', maxlength: 500, rows: 3 },
  { name: 'quiet', label: 'No molestar fuera de horario', type: 'checkbox' },
];

/** Campos por los que se puede filtrar: la misma lista que el servidor tendría registrada. */
const CAMPOS_FILTRO = [
  { name: 'name', label: 'Nombre', ops: ['contains', 'not_contains'] },
  { name: 'consent', label: 'Consentimiento', ops: ['is'], options: CONSENTIMIENTOS },
  { name: 'tag', label: 'Etiqueta', ops: ['any', 'all', 'none'], options: ETIQUETAS },
  { name: 'activity', label: 'Última actividad', ops: ['in_last_days', 'not_in_last_days'], valueType: 'number' },
  { name: 'email', label: 'Correo', ops: ['has', 'not_has'] },
  { name: 'quiet', label: 'No molestar', ops: [{ op: 'is', valueType: 'boolean' }] },
];

/**
 * Lo vivo de este montaje, para que onEvent() llegue a la tabla y a la ficha abierta. Se pone al montar
 * la pestaña y se quita al salir. Lo que deba SOBREVIVIR a un remontaje no va aquí, va en ctx.keep.
 */
let enVivo = null;

// ---------------------------------------------------------------------------------------------------
// Pestaña «Resumen»: tarjetas de cifra y gráficas
// ---------------------------------------------------------------------------------------------------

function resumen(panel, { api }) {
  const limpiezas = [];
  let montado = true;

  async function cargar() {
    render(panel, loading('Cargando el resumen…'));
    let datos;
    try {
      datos = await api.get('/api/ejemplo/stats');
    } catch (error) {
      if (montado && !isAbort(error)) render(panel, failure({ error, retry: 'reintentar' }));
      return;
    }
    if (!montado) return;

    const total = lista => lista.reduce((suma, valor) => suma + valor, 0);
    const cambio = (ahora, antes) => (antes > 0 ? (ahora - antes) / antes : null);
    const recibidos = total(datos.received);
    const anteriores = total(datos.previous);
    const tarjetas = [
      tile({
        label: 'Mensajes recibidos',
        value: recibidos,
        delta: cambio(recibidos, anteriores),
        period: 'los 14 días anteriores',
        spark: datos.received,
      }),
      tile({
        label: 'Mensajes enviados',
        value: total(datos.sent),
        delta: cambio(total(datos.sent), datos.sentPrevious),
        period: 'los 14 días anteriores',
        spark: datos.sent,
      }),
      // Subir aquí es malo: goodWhenUp en false pone el tono de alerta, siempre con flecha y frase.
      tile({
        label: 'Envíos fallidos',
        value: datos.failed,
        delta: datos.failedChange,
        goodWhenUp: false,
        period: 'los 14 días anteriores',
      }),
      tile({ label: 'Primera respuesta', value: datos.firstReply, hint: 'Mediana en horario de atención' }),
    ];
    const gratis = meter({
      label: 'Respuestas gratis del mes',
      value: datos.freeUsed,
      limit: datos.freeLimit,
      width: 280,
    });

    // El esqueleto se pinta una vez; cada gráfica vive en su ranura y se repinta sola al cambiar el ancho.
    render(
      panel,
      html`<div class="k-stack">
        <div class="k-tiles">${tarjetas.map(tarjeta => tarjeta.html)}</div>
        <div class="k-card ej-medidor">${gratis.html}</div>
        <div class="k-grid k-grid--wide">
          ${['g-linea', 'g-columnas', 'g-barras', 'g-embudo', 'g-partes', 'g-calor'].map(ranura => html`<div class="k-card"><div data-slot="${ranura}"></div></div>`)}
        </div>
      </div>`,
    );

    // Un SVG del kit no se escala (la letra bajaría de 11 px): se vuelve a pintar al ancho de su caja.
    const grafica = (ranura, pintar) => {
      const caja = panel.querySelector(`[data-slot="${ranura}"]`);
      limpiezas.push(responsive(caja, ancho => render(caja, html`${pintar(ancho)}`)));
    };

    grafica('g-linea', ancho =>
      figure({
        title: 'Mensajes por día',
        subtitle: 'Últimos 14 días, con el periodo anterior en gris',
        definition:
          'Se cuenta cada mensaje una vez, en el día en que se recibió o se envió, en la zona horaria de la marca.',
        chart: line({
          label: 'Mensajes por día',
          labels: datos.days,
          previous: datos.previous,
          series: [
            { name: 'Recibidos', values: datos.received, color: 1 },
            { name: 'Enviados', values: datos.sent, color: 2 },
          ],
          width: ancho,
        }),
      }),
    );
    grafica('g-columnas', ancho =>
      figure({
        title: 'Mensajes enviados por categoría',
        chart: columns({
          label: 'Mensajes enviados por categoría',
          labels: datos.days,
          stacked: true,
          series: [
            { name: 'Servicio', values: datos.byCategory.service, color: 1 },
            { name: 'Marketing', values: datos.byCategory.marketing, color: 2 },
            { name: 'Utilidad', values: datos.byCategory.utility, color: 3 },
          ],
          width: ancho,
        }),
      }),
    );
    grafica('g-barras', ancho =>
      figure({
        title: 'Fallos por motivo',
        chart: bars({ label: 'Fallos por motivo', head: ['Motivo', 'Envíos'], rows: datos.failures, width: ancho }),
      }),
    );
    grafica('g-embudo', ancho =>
      figure({
        title: 'Embudo de una difusión',
        chart: funnel({ label: 'Embudo de una difusión', steps: datos.funnel, width: ancho }),
      }),
    );
    grafica('g-partes', ancho =>
      figure({
        title: 'Cómo terminaron los envíos',
        chart: segments({
          label: 'Cómo terminaron los envíos',
          tall: true,
          // El color sigue a la entidad: «leídos» es siempre el mismo aunque cambie el orden o falte una parte.
          parts: datos.outcomes.map(parte => ({ ...parte, color: COLOR_RESULTADO[parte.key] })),
          width: ancho,
        }),
      }),
    );
    // En celular las 24 horas no caben con celdas tocables: se agrupan de tres en tres.
    grafica('g-calor', ancho =>
      figure({
        title: 'Cuándo escriben',
        subtitle: 'Mensajes recibidos por día y hora',
        chart: heat({
          label: 'Mensajes recibidos por día y hora',
          rows: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'],
          cols: Array.from({ length: 24 }, (_, hora) => `${hora} h`),
          values: datos.hours,
          group: ancho < 420 ? 3 : 1,
          width: ancho,
        }),
      }),
    );
  }

  const off = listen(panel, { click: { reintentar: cargar } }, { contain: false });
  cargar();

  return () => {
    montado = false;
    off();
    for (const limpiar of limpiezas) limpiar();
  };
}

// ---------------------------------------------------------------------------------------------------
// Pestaña «Contactos»: búsqueda, filtros, tabla por páginas, acciones en lote y panel de detalle
// ---------------------------------------------------------------------------------------------------

function contactos(panel, { api, ctx }) {
  const guardado = ctx.keep.get('contactos') ?? {};
  const filtroInicial = guardado.filtro ?? emptyConditions();
  // El estado de la pestaña. Cambiarlo con set() avisa una sola vez por tanda a quien pinta.
  const store = createStore({
    q: guardado.q ?? '',
    filtro: filtroInicial,
    // Con una condición a medias (se puede haber salido de la pantalla dejándola así) todavía no se filtra.
    completo: conditionProblems(filtroInicial, CAMPOS_FILTRO).length === 0,
  });
  let abierto = null; // {id, ficha}: el contacto que está en el panel
  let espera = 0;

  render(
    panel,
    html`<div class="k-stack">
      <div class="k-card ej-busqueda">
        <div class="k-field">
          <label class="k-label" for="${ctx.uid('buscar')}">Buscar</label>
          <input
            class="k-input"
            type="search"
            id="${ctx.uid('buscar')}"
            data-do="buscar"
            value="${store.get().q}"
            placeholder="Nombre, teléfono o correo"
            maxlength="100"
            autocomplete="off"
          />
          <p class="k-hint">Escribe «error» para ver cómo se muestra un fallo del servidor.</p>
        </div>
        <details class="ej-filtros">
          <summary class="k-btn">Filtros</summary>
          <div data-slot="condiciones"></div>
        </details>
        <p class="k-hint ej-resumen" data-slot="resumen" role="status"></p>
      </div>
      <div class="k-split">
        <div class="k-card" data-slot="tabla"></div>
        <div data-slot="detalle"></div>
      </div>
    </div>`,
  );
  const ranura = nombre => panel.querySelector(`[data-slot="${nombre}"]`);

  const tabla = pagedTable(ranura('tabla'), {
    label: 'Contactos',
    rowKey: contacto => contacto.id,
    rowLabel: contacto => contacto.name,
    selectable: true,
    cards: true,
    sort: { by: 'activity', dir: 'desc' },
    visible: ctx.keep.get('columnas'),
    onColumns: columnas => ctx.keep.set('columnas', columnas),
    columns: [
      { id: 'name', label: 'Nombre', fixed: true, sortable: true, cell: contacto => contacto.name },
      { id: 'phone', label: 'Teléfono', cell: contacto => contacto.phone },
      {
        id: 'tags',
        label: 'Etiquetas',
        cell: contacto =>
          html`<span class="k-row">${contacto.tags.map(etiqueta => html`<span class="k-chip">${rotulo(ETIQUETAS, etiqueta)}</span>`)}</span>`,
      },
      {
        id: 'consent',
        label: 'Consentimiento',
        // El estado se dice con texto además de con color.
        cell: contacto =>
          html`<span class="${['k-chip', TONO_CONSENTIMIENTO[contacto.consent]]}">${rotulo(CONSENTIMIENTOS, contacto.consent)}</span>`,
      },
      { id: 'activity', label: 'Última actividad', sortable: 'desc', cell: contacto => fecha(contacto.activityAt) },
      { id: 'email', label: 'Correo', hidden: true, cell: contacto => contacto.email || '—' },
      { id: 'created', label: 'Creado', hidden: true, sortable: 'desc', cell: contacto => fecha(contacto.createdAt) },
    ],
    // El orden, la búsqueda y los filtros los aplica el servidor: la tabla sólo pide la página siguiente.
    async load({ cursor, sort, limit, signal }) {
      const { q, filtro, completo } = store.get();
      const pagina = await api.get(
        '/api/ejemplo/contacts',
        {
          cursor,
          limit,
          q,
          sort: sort ? `${sort.by}:${sort.dir}` : null,
          filter: completo && filtro.groups.length ? filtro : null,
        },
        { signal },
      );
      return { rows: pagina.contacts, next: pagina.nextCursor };
    },
    // Los botones de las acciones en lote los pone la pantalla y los atiende su listen().
    actions: claves =>
      html`<button type="button" class="k-btn k-btn--danger" data-do="archivar">Archivar ${claves.length}</button>`,
    onOpen: abrir,
    empty: { title: 'Ningún contacto coincide', text: 'Prueba con otra búsqueda o quita algún filtro.' },
  });

  const detalle = detailPanel(ranura('detalle'));

  function abrir(contacto, quienAbre) {
    detalle.open({
      title: contacto.name,
      opener: quienAbre,
      mount(cuerpo) {
        render(
          cuerpo,
          html`<div data-slot="ficha"></div>
            <button type="button" class="k-btn k-btn--ghost" data-do="otro-equipo" data-id="${contacto.id}">Simular un cambio desde otro equipo</button>`,
        );
        const ficha = form(cuerpo.querySelector('[data-slot="ficha"]'), {
          id: ctx.uid(`ficha-${contacto.id}`),
          label: `Datos de ${contacto.name}`,
          fields: CAMPOS_CONTACTO,
          initial: contacto,
          revision: contacto.revision,
          // clientRef evita repetir el cambio si se reintenta; expectedRevision evita pisar el de otra persona.
          submit: (valores, { clientRef, expectedRevision }) =>
            api.patch(`/api/ejemplo/contacts/${contacto.id}`, { ...valores, clientRef, expectedRevision }),
          async reload() {
            const actual = await api.get(`/api/ejemplo/contacts/${contacto.id}`);
            return { values: actual.contact, revision: actual.contact.revision };
          },
          onDone({ contact }) {
            tabla.upsert(contact);
            ctx.toast(`Se guardó ${contact.name}.`);
            // La ficha sigue abierta: la siguiente edición parte de la revisión recién guardada.
            ficha.setRevision(contact.revision);
          },
          successText: 'Cambios guardados.',
          keep: ctx.keep,
          draftKey: `ficha:${contacto.id}`,
        });
        abierto = { id: contacto.id, ficha };
        return () => {
          ficha.destroy();
          abierto = null;
        };
      },
    });
  }

  /** Llega un contacto cambiado (un evento en vivo): se pone al día su fila y, si está abierta, su ficha. */
  function alCambiar(contacto) {
    tabla.upsert(contacto);
    // refresh() no pisa un borrador a medias: avisa y deja decidir a la persona.
    if (abierto?.id === contacto.id) abierto.ficha.refresh({ values: contacto, revision: contacto.revision });
  }

  const filtros = conditionsBuilder(ranura('condiciones'), {
    fields: CAMPOS_FILTRO,
    value: store.get().filtro,
    label: 'Filtros de contactos',
    onChange: (definicion, { complete }) => store.set({ filtro: definicion, completo: complete }),
  });

  const archivar = mutation((clientRef, ids) => api.post('/api/ejemplo/contacts/archive', { ids, clientRef }));

  const pintarResumen = estado => {
    const frase = describeConditions(estado.filtro, CAMPOS_FILTRO);
    render(
      ranura('resumen'),
      html`${frase ? `Filtro: ${frase}.` : 'Sin filtros: se muestran todos.'}${when(!estado.completo, () => ' Falta completar una condición.')}`,
    );
  };
  const desuscribir = store.subscribe((estado, antes) => {
    ctx.keep.set('contactos', { q: estado.q, filtro: estado.filtro });
    pintarResumen(estado);
    // Con una condición a medias todavía no se filtra.
    if (estado.completo && (estado.q !== antes.q || estado.filtro !== antes.filtro)) tabla.reload();
  });
  pintarResumen(store.get());

  const off = listen(
    panel,
    {
      input: {
        buscar: (_evento, campo) => {
          // Se espera a que la persona deje de teclear para no pedir una página por letra.
          clearTimeout(espera);
          espera = setTimeout(() => store.set({ q: campo.value.trim() }), 250);
        },
      },
      click: {
        archivar: async () => {
          const ids = tabla.selection();
          const seguro = await confirm({
            title: ids.length === 1 ? '¿Archivar este contacto?' : `¿Archivar ${ids.length} contactos?`,
            message: 'Dejan de aparecer en las listas. En este ejemplo no se pueden recuperar.',
            confirmLabel: 'Archivar',
            danger: true,
          });
          if (!seguro) return;
          const { archived } = await archivar.run(ids);
          if (abierto && ids.includes(abierto.id)) detalle.close();
          tabla.clearSelection();
          tabla.reload();
          ctx.toast(archived === 1 ? 'Se archivó 1 contacto.' : `Se archivaron ${archived} contactos.`);
        },
        'otro-equipo': (_evento, boton) => {
          const contacto = touchElsewhere(boton.getAttribute('data-id'));
          if (contacto) alCambiar(contacto);
        },
      },
    },
    { contain: false, onError: error => ctx.toast(error.message) },
  );

  enVivo = { tabla, alCambiar };
  return () => {
    enVivo = null;
    clearTimeout(espera);
    off();
    desuscribir();
    store.destroy();
    filtros.destroy();
    detalle.destroy();
    tabla.destroy();
  };
}

// ---------------------------------------------------------------------------------------------------
// Pestaña «Importar»: asistente por pasos
// ---------------------------------------------------------------------------------------------------

const ORIGENES = [
  { value: 'feria', label: 'Feria o evento' },
  { value: 'formulario', label: 'Formulario del sitio' },
  { value: 'otro', label: 'Otro CRM' },
];
const CAMPOS_LISTA = [
  { name: 'nombre', label: 'Nombre de la lista', required: true, maxlength: 60, hint: 'Así la verá tu equipo.' },
  { name: 'origen', label: 'De dónde viene', type: 'select', required: true, options: ORIGENES },
];
const CAMPOS_OPCIONES = [
  { name: 'actualizar', label: 'Actualizar los contactos que ya existen', type: 'checkbox' },
  { name: 'etiquetar', label: 'Poner la etiqueta «Importado»', type: 'checkbox' },
];

function importar(panel, { ctx }) {
  // El paso y lo escrito viven en ctx.keep: si la pantalla se desmonta y vuelve, el asistente sigue donde iba.
  const guardado = ctx.keep.get('importar') ?? {
    paso: 'lista',
    valores: { nombre: '', origen: '', actualizar: true, etiquetar: false },
  };
  const valores = { ...guardado.valores };
  let errores = {};
  const recordar = paso => ctx.keep.set('importar', { paso, valores: { ...valores } });

  const pintarLista = cuerpo =>
    render(
      cuerpo,
      html`<form class="k-form" novalidate data-do="paso-lista">
        ${CAMPOS_LISTA.map(campo => field(campo, { id: ctx.uid(`importar-${campo.name}`), value: valores[campo.name], error: errores[campo.name] }))}
      </form>`,
    );

  // El asistente va dentro de un panel blanco, como el resto del contenido de una página.
  render(panel, html`<div class="k-card"><div data-slot="asistente"></div></div>`);

  const asistente = wizard(panel.querySelector('[data-slot="asistente"]'), {
    label: 'Pasos para importar contactos',
    current: guardado.paso,
    finishLabel: 'Importar',
    steps: [
      { id: 'lista', title: 'Lista', hint: 'En una pantalla real aquí se sube el archivo.' },
      { id: 'opciones', title: 'Opciones' },
      { id: 'revisar', title: 'Revisar', hint: 'Nada se importa hasta que confirmes.' },
    ],
    onStep: recordar,
    onEnter(paso, cuerpo) {
      if (paso.id === 'lista') pintarLista(cuerpo);
      if (paso.id === 'opciones') {
        render(
          cuerpo,
          html`<form class="k-form" novalidate data-do="paso-opciones">
            ${CAMPOS_OPCIONES.map(campo => field(campo, { id: ctx.uid(`importar-${campo.name}`), value: valores[campo.name] }))}
          </form>`,
        );
      }
      // El resumen se repinta cada vez que se entra: puede haber cambiado lo de los pasos anteriores.
      if (paso.id === 'revisar') {
        render(
          cuerpo,
          html`<ul class="ej-revision">
            <li><span class="k-muted">Lista</span> ${valores.nombre}</li>
            <li><span class="k-muted">Origen</span> ${rotulo(ORIGENES, valores.origen)}</li>
            <li><span class="k-muted">Existentes</span> ${valores.actualizar ? 'Se actualizan' : 'Se dejan como están'}</li>
            <li><span class="k-muted">Etiqueta</span> ${valores.etiquetar ? '«Importado»' : 'Ninguna'}</li>
          </ul>`,
        );
      }
    },
    // No se avanza con el paso a medias: se marcan los campos y el asistente dice por qué no sigue.
    validate(paso) {
      if (paso.id !== 'lista') return true;
      errores = Object.fromEntries(
        CAMPOS_LISTA.map(campo => [campo.name, fieldError(campo, valores[campo.name])]).filter(
          ([, mensaje]) => mensaje,
        ),
      );
      pintarLista(asistente.body('lista'));
      return Object.keys(errores).length ? 'Completa los datos de la lista para continuar.' : true;
    },
    onFinish() {
      ctx.keep.delete('importar');
      ctx.toast(`La lista «${valores.nombre}» quedaría importada. Es un ejemplo: no se guardó nada.`);
    },
  });

  // Los formularios de los pasos no se envían: sólo se lee lo que la persona va escribiendo.
  const leer = (_evento, formulario) => {
    Object.assign(valores, formValues(formulario));
    recordar(asistente.current());
  };
  const off = listen(
    panel,
    { input: { 'paso-lista': leer, 'paso-opciones': leer }, change: { 'paso-lista': leer, 'paso-opciones': leer } },
    { contain: false },
  );

  return () => {
    off();
    asistente.destroy();
  };
}

// ---------------------------------------------------------------------------------------------------
// «Nuevo contacto»: una ventana con un formulario
// ---------------------------------------------------------------------------------------------------

async function nuevoContacto({ api, ctx }) {
  const creado = await dialog({
    title: 'Nuevo contacto',
    // mount() pinta contenido vivo dentro de la ventana y devuelve su limpieza.
    mount(cuerpo, cerrar) {
      const alta = form(cuerpo, {
        id: ctx.uid('alta'),
        label: 'Nuevo contacto',
        fields: CAMPOS_CONTACTO.filter(campo => campo.name !== 'notes'),
        initial: { consent: 'unknown' },
        submitLabel: 'Crear contacto',
        sendingLabel: 'Creando…',
        cancelLabel: 'Cancelar',
        onCancel: () => cerrar(null),
        submit: (valores, { clientRef }) => api.post('/api/ejemplo/contacts', { ...valores, clientRef }),
        onDone: ({ contact }) => cerrar(contact),
        // Si se cierra la ventana a medias, lo escrito sigue ahí al volver a abrirla.
        keep: ctx.keep,
        draftKey: 'alta',
      });
      return alta.destroy;
    },
  });
  if (!creado) return;
  ctx.toast(`${creado.name} ya está en tus contactos.`);
  enVivo?.alCambiar(creado);
}

// ---------------------------------------------------------------------------------------------------
// El contrato de la pantalla
// ---------------------------------------------------------------------------------------------------

export default {
  /**
   * Se llama cada vez que se entra a la pantalla, con un `root` recién creado. Devuelve (o registra con
   * ctx.onUnmount) todo lo que hay que deshacer al salir.
   */
  mount(root, ctx) {
    // En una pantalla real: `const api = ctx.api;` (ya se cancela solo al salir).
    const api = createApi({ fetch: fakeFetch });
    ctx.onUnmount(api.abort);

    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">Kit de pantallas</span>
            <h1>Ejemplo</h1>
            <p class="k-lead">Todas las piezas del kit con datos de mentira. Copia esta carpeta para empezar una pantalla nueva.</p>
          </div>
          <div class="k-actions">
            <button type="button" class="k-btn k-btn--primary" data-do="nuevo">Nuevo contacto</button>
          </div>
        </header>
        <div data-slot="secciones"></div>
      </section>`,
    );

    const secciones = tabs(root.querySelector('[data-slot="secciones"]'), {
      label: 'Secciones del ejemplo',
      selected: ctx.keep.get('seccion'),
      onSelect: seccion => ctx.keep.set('seccion', seccion),
      items: [
        { id: 'resumen', label: 'Resumen', mount: panel => resumen(panel, { api }) },
        { id: 'contactos', label: 'Contactos', mount: panel => contactos(panel, { api, ctx }) },
        { id: 'importar', label: 'Importar', mount: panel => importar(panel, { ctx }) },
      ],
    });
    ctx.onUnmount(secciones.destroy);

    // Un solo listen() en la raíz: lo que pasa dentro de la pantalla no llega a los oyentes de la aplicación.
    ctx.onUnmount(
      listen(
        root,
        { click: { nuevo: () => nuevoContacto({ api, ctx }) } },
        { onError: error => ctx.toast(error.message) },
      ),
    );
    // Un solo globo de datos para todas las gráficas de la pantalla.
    ctx.onUnmount(bind(root));
  },

  /**
   * Evento en vivo de la aplicación. Se pide o se aplica SÓLO lo que cambió; nunca se recarga todo.
   * El sobre es el del tiempo real de la aplicación: {type, data}.
   */
  onEvent(evento) {
    if (evento?.type === 'contact.updated' && evento.data?.contact) enVivo?.alCambiar(evento.data.contact);
  },
};
