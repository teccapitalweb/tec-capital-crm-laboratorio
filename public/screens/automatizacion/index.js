/**
 * Pantalla «Automatización» (en vista previa): los recorridos de la marca, su editor y su evaluación
 * (docs/PLAN_RECORRIDOS.md y docs/GUIA_RECORRIDOS.md). Todo lo decide el servidor (/api/chatflows); aquí se pinta.
 *
 * Dos vistas:
 * - la lista de recorridos de la marca, con su estado, cómo empiezan, su versión publicada y cómo les va;
 * - el editor de un recorrido: el lienzo (o el esquema por pasos en celular) con su borrador del servidor, Ajustes,
 *   Revisar, Publicar, Activar o Pausar; la pestaña Rendimiento (cifras por paso, lo más débil primero y
 *   Sugerencias) y la pestaña Versiones.
 *
 * Guardar es explícito («Guardar» o Ctrl+S) y lleva expectedRevision: si alguien más guardó antes, el servidor
 * responde 409, aquí se avisa y no se pisa nada (los cambios siguen en pantalla, sin guardar). Nada de esta pantalla
 * escribe a un cliente: guardar, revisar, probar, ver el rendimiento y pedir sugerencias no envían mensajes.
 *
 * Lo que sobrevive a un remontaje (cambiar de vista y volver) vive en ctx.keep: la vista, la marca, el recorrido
 * abierto y, por recorrido, el estado del editor entero con sus cambios sin guardar y su historial.
 */
import { attrs, html, render, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { isAbort, isStale, newClientRef } from '../../kit/api.js';
import { field } from '../../kit/components/form.js';
import { confirm, dialog } from '../../kit/components/dialog.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';
import { emptyGraph, nodeName, readingOrder } from '../../kit/shared/flow-model.js';
import { mountCanvas } from './lienzo/index.js';
import { createStore } from './lienzo/store.js';
import { saleTemplate } from './plantilla.js';

/** Lo vivo de este montaje, para que onEvent() llegue a la vista abierta. */
let live = null;

const numero = n => new Intl.NumberFormat('es-MX').format(n ?? 0);
const fecha = ms => (ms ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(new Date(ms)) : '—');
const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const segundos = ms =>
  ms === null || ms === undefined
    ? '—'
    : ms < 60000
      ? `${Math.round(ms / 1000)} s`
      : ms < 3600000
        ? `${Math.round(ms / 60000)} min`
        : `${Math.round(ms / 3600000)} h`;

function estado(flow) {
  if (flow.status === 'active') return { text: 'Publicado y activo', tone: 'ok' };
  if (flow.status === 'paused') return { text: 'En pausa', tone: 'warn' };
  if (flow.status === 'archived') return { text: 'Archivado', tone: '' };
  return flow.publishedVersion ? { text: 'Publicado, sin activar', tone: 'sky' } : { text: 'Borrador', tone: '' };
}
const chip = (flow, atencion = null) => {
  const s =
    flow.status === 'active' && atencion && !atencion.ok
      ? { text: 'Activo, pero la marca no está atendiendo', tone: 'warn' }
      : estado(flow);
  return html`<span class="${['k-chip', s.tone && 'k-chip--' + s.tone]}">${s.text}</span>`;
};
const START_FALLBACK = {
  manual: 'Sólo a mano, desde el chat',
  first_message: 'Primer mensaje de la conversación',
  keyword: 'Mensaje con una palabra clave',
  any_message: 'Cualquier mensaje',
};
function comoEmpieza(start, types = START_FALLBACK) {
  const label = types[start?.type] || START_FALLBACK.manual;
  return start?.type === 'keyword' && start.keywords?.length ? `${label}: ${start.keywords.join(', ')}` : label;
}
// La marca no atiende con recorridos (automatización apagada, en pausa o asistente que no responde solo): qué pasa,
// por qué y dónde se enciende. Sin esto, un recorrido «activo» parece roto.
const avisoAtencion = (a, nombre = '') =>
  html`<div class="k-notice k-notice--warn au-aviso au-atencion" role="status">
    <strong>${nombre ? nombre + ' no' : 'La marca no'} está atendiendo con recorridos.</strong> ${a.label} Los recorridos activos no contestarán
    (contesta el asistente de siempre) hasta que se encienda en <strong>${a.where}</strong>.
  </div>`;
// En el editor el mismo aviso va en una tira compacta: lo que pasa en un renglón; el motivo, lo que hacen mientras tanto
// los recorridos y dónde se enciende, al desplegarla. No se pierde nada: todo sigue en la página.
const tiraAtencion = a =>
  html`<details class="au-tira au-tira--warn au-atencion">
    <summary><span class="au-tira__texto"><strong>La marca no está atendiendo con recorridos.</strong></span><span class="au-tira__mas">Por qué y dónde se enciende</span></summary>
    <p>${a.label} Los recorridos activos no contestarán (contesta el asistente de siempre) hasta que se encienda en <strong>${a.where}</strong>.</p>
  </details>`;
// La nota del modo real: su primera frase en el renglón y el texto completo al desplegarla.
const tiraInfo = info => {
  const text = String(info);
  const cut = text.search(/[:.]/);
  const head = cut > 0 ? text.slice(0, cut) : text;
  return html`<details class="au-tira au-tira--info">
    <summary><span class="au-tira__texto">${head}.</span><span class="au-tira__mas">Más</span></summary>
    <p>${text}</p>
  </details>`;
};
// Y cuando sí atiende, también se dice (en la lista): así nadie se pregunta si está encendida.
const avisoAtiende = nombre =>
  html`<p class="k-notice k-notice--ok au-aviso au-atiende" role="status"><strong>${nombre || 'La marca'} está atendiendo con recorridos.</strong></p>`;

function resultado(m) {
  if (!m || !m.sessions) return 'Sin conversaciones todavía';
  const base = m.completed + m.handoff + m.left + m.dropped;
  const parts = [`${numero(m.sessions)} ${m.sessions === 1 ? 'conversación' : 'conversaciones'}`];
  if (base) parts.push(`${pct(m.completed, base)} % terminó`, `${pct(m.handoff, base)} % pasó con una persona`);
  return parts.join(' · ');
}

// El mismo resultado, en el bloque de la tarjeta: la cifra, una barra (terminó · pasó con una persona · el resto) y la
// frase. La barra es decorativa: lo que dice está en el texto.
function bloqueResultado(m) {
  const base = m ? m.completed + m.handoff + m.left + m.dropped : 0;
  if (!m || !m.sessions) return html`<span class="au-dato__valor">Sin conversaciones todavía</span>`;
  if (!base) return html`<span class="au-dato__valor">Ninguna ha terminado todavía</span>`;
  const done = pct(m.completed, base);
  const person = pct(m.handoff, base);
  return html`<span class="au-barra" aria-hidden="true"><span class="au-barra__fin" data-w="${done}"></span><span class="au-barra__persona" data-w="${person}"></span></span>
    <span class="au-dato__valor au-dato__valor--chico">${done} % terminó · ${person} % pasó con una persona</span>`;
}

// Ancho de las barras de resultado: un atributo, no un estilo en línea (CSP y reglas del kit).
function anchos(root) {
  for (const el of root.querySelectorAll('[data-w]'))
    el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w) || 0))}%`;
}

// Con pocas marcas se eligen con píldoras (como en los bocetos); con muchas, con una lista desplegable.
const MARCAS_EN_PILDORAS = 6;

export default {
  mount(root, ctx) {
    const api = ctx.api;
    const keep = ctx.keep;
    let vivo = true;
    let meta = keep.get('meta') ?? null; // {brands, startTypes, unavailable}
    let marca = keep.get('marca') ?? null;
    let limpiar = () => {};
    let alCambiar = () => {};

    render(root, html`<section class="k-page au-page" data-slot="vista"></section>`);
    const vista = root.querySelector('[data-slot="vista"]');
    const marcaActual = () => meta?.brands.find(b => b.id === marca) ?? null;
    const puedeEditar = () => Boolean(marcaActual()?.canManage);
    const atencion = () => marcaActual()?.attending ?? null;
    const fallo = error => {
      if (!isAbort(error)) ctx.toast(error?.message || 'No se pudo completar la acción.');
    };

    function ir(nombre, flowId = null) {
      keep.set('vista', nombre);
      keep.set('flowId', flowId);
      limpiar();
      limpiar = () => {};
      alCambiar = () => {};
      if (!vivo) return;
      if (nombre === 'editor' && flowId) editor(flowId);
      else lista();
    }

    // ------------------------------------------------------------------------------------------------ lista
    // Una tarjeta por recorrido con lo mismo que tenía la tabla (estado, cómo empieza, versión publicada y fecha, en
    // curso y resultado) y las mismas acciones según su estado. La marca se elige con píldoras (o una lista si son
    // muchas); «Ver también los archivados» y «Nuevo recorrido» siguen donde estaban.
    function lista() {
      const archivados = keep.get('archivados') === true;
      let filas = [];
      let pedido = null;
      let cargado = null; // la marca cuyas tarjetas están en pantalla
      render(
        vista,
        html`<header class="k-head au-head au-head--lista">
            <div>
              <span class="k-eyebrow">Automatización</span>
              <h1>Recorridos</h1>
              <p class="k-lead">
                Conversaciones automáticas que dan la información del curso, preguntan y pasan con una persona. Se
                arman aquí, se revisan, se prueban sin enviar nada y sólo atienden cuando se publican y se activan.
              </p>
            </div>
            <div class="k-actions" data-slot="acciones"></div>
          </header>
          <div class="au-filtros" data-slot="filtros"></div>
          <div class="au-avisos" data-slot="avisos"></div>
          <div class="au-tarjetas" data-slot="tabla" aria-live="polite"></div>`,
      );
      const pintarFiltros = () => {
        render(
          vista.querySelector('[data-slot="acciones"]'),
          puedeEditar()
            ? html`<button type="button" class="k-btn k-btn--primary au-cta" data-do="nuevo">Nuevo recorrido</button>`
            : html``,
        );
        const marcas = meta?.brands ?? [];
        render(
          vista.querySelector('[data-slot="filtros"]'),
          html`${when(
            marcas.length > 1 && marcas.length <= MARCAS_EN_PILDORAS,
            () => html`<div class="au-marcas" role="group" aria-labelledby="${ctx.uid('marca-rotulo')}">
              <span class="au-marcas__rotulo" id="${ctx.uid('marca-rotulo')}">Marca</span>
              ${marcas.map(
                b =>
                  html`<button type="button" class="au-marca-pildora" data-do="marca-pildora" data-id="${b.id}" aria-pressed="${b.id === marca ? 'true' : 'false'}">${b.name}</button>`,
              )}
            </div>`,
          )}${when(
            marcas.length > MARCAS_EN_PILDORAS,
            () => html`<form class="au-marca" novalidate data-do="marca">
                ${field(
                  {
                    name: 'marca',
                    label: 'Marca',
                    type: 'select',
                    options: marcas.map(b => ({ value: b.id, label: b.name })),
                  },
                  { id: ctx.uid('marca'), value: marca },
                )}
              </form>`,
          )}
            <label class="k-check au-archivados">
              <input type="checkbox" data-do="archivados" ${attrs({ checked: archivados })} />
              <span>Ver también los archivados</span>
            </label>`,
        );
        render(
          vista.querySelector('[data-slot="avisos"]'),
          html`${when(atencion() && !atencion().ok, () => avisoAtencion(atencion(), marcaActual()?.name))}${when(
            atencion()?.ok,
            () => avisoAtiende(marcaActual()?.name),
          )}${when(
            meta && !puedeEditar(),
            () =>
              html`<p class="k-notice au-aviso" role="status">Puedes ver y probar los recorridos de esta marca, pero no editarlos.</p>`,
          )}`,
        );
      };

      const dato = (rotulo, valor, tono) =>
        html`<div class="au-dato" data-tone="${tono}"><span class="au-dato__rotulo">${rotulo}</span>${valor}</div>`;
      const tarjeta =
        f => html`<article class="au-tarjeta" data-key="fila-${f.id}" aria-labelledby="${ctx.uid('rec-' + f.id)}">
        <div class="au-tarjeta__cabeza">
          <div class="au-tarjeta__nombre">
            <h2 id="${ctx.uid('rec-' + f.id)}">${f.name}</h2>
            ${chip(f, atencion())}
            ${when(keep.get('store:' + f.id)?.isDirty(), () => html`<span class="k-chip k-chip--warn">Cambios sin guardar</span>`)}
          </div>
          <div class="au-fila-acciones">
            <button type="button" class="k-btn k-btn--primary" data-do="abrir" data-id="${f.id}" aria-label="Abrir «${f.name}»">Abrir</button>
            ${when(
              puedeEditar() && f.status !== 'archived',
              () => html`<button type="button" class="k-btn" data-do="duplicar" data-id="${f.id}">Duplicar</button>
                ${
                  f.status === 'active'
                    ? html`<button type="button" class="k-btn" data-do="pausar" data-id="${f.id}">Pausar</button>`
                    : f.publishedVersion
                      ? html`<button type="button" class="k-btn" data-do="activar" data-id="${f.id}">Activar</button>`
                      : ''
                }
                <button type="button" class="k-btn" data-do="archivar" data-id="${f.id}">Archivar</button>`,
            )}
          </div>
        </div>
        ${when(f.description, () => html`<p class="au-tarjeta__descripcion">${f.description}</p>`)}
        <div class="au-datos">
          ${dato('Cómo empieza', html`<span class="au-dato__valor">${comoEmpieza(f.start, meta?.startTypes)}</span>`, 'lilac')}
          ${dato(
            'Publicado',
            html`<span class="au-dato__valor">${f.publishedVersion ? `Versión ${f.publishedVersion} · ${fecha(f.publishedAt)}` : 'Sin publicar'}</span>`,
            'sky',
          )}
          ${dato(
            'En curso',
            html`<span class="au-dato__valor">${numero(f.metrics?.inProgress)} ${f.metrics?.inProgress === 1 ? 'conversación' : 'conversaciones'}</span>`,
            'butter',
          )}
          ${dato(
            f.metrics?.sessions
              ? `Resultado · ${numero(f.metrics.sessions)} ${f.metrics.sessions === 1 ? 'conversación' : 'conversaciones'}`
              : 'Resultado',
            html`<span class="k-sr">${resultado(f.metrics)}. </span><span aria-hidden="true" class="au-dato__pila">${bloqueResultado(f.metrics)}</span>`,
            'soft',
          )}
        </div>
      </article>`;

      const caja = vista.querySelector('[data-slot="tabla"]');
      const pintarFilas = () => {
        render(
          caja,
          filas.length
            ? html`${filas.map(tarjeta)}`
            : html`<div class="k-card au-vacio">${empty({
                title: 'Sin recorridos',
                text: 'Arma el primero con «Nuevo recorrido»: en blanco o desde la plantilla «Venta de curso».',
              })}</div>`,
        );
        anchos(caja);
      };
      async function recargar() {
        pedido?.abort();
        const control = new AbortController();
        pedido = control;
        // Sólo la primera carga (o al cambiar de marca) dice «Cargando…»: una actualización en vivo no hace parpadear las
        // tarjetas (movimiento sólo al navegar).
        if (cargado !== marca) render(caja, loading('Cargando los recorridos…'));
        try {
          const datos = await api.get(
            '/api/chatflows',
            {
              ...(marca ? { brand: marca } : {}),
              ...(archivados || keep.get('archivados') === true ? { archived: '1' } : {}),
            },
            { signal: control.signal },
          );
          if (!vivo || pedido !== control) return;
          meta = { brands: datos.brands, startTypes: datos.startTypes, unavailable: datos.unavailable };
          if (!marca || !datos.brands.some(b => b.id === marca)) {
            marca = datos.brands.find(b => b.id === ctx.brand)?.id ?? datos.brands[0]?.id ?? null;
            keep.set('marca', marca);
          }
          keep.set('meta', meta);
          filas = datos.flows.filter(f => f.brandId === marca);
          cargado = marca;
          pintarFiltros();
          pintarFilas();
        } catch (error) {
          if (isAbort(error) || !vivo || pedido !== control) return;
          render(caja, failure({ title: 'No se pudieron cargar los recorridos', error, retry: 'reintentar-lista' }));
        }
      }
      // Primero la lista de todas las marcas que se ven; luego, sólo la elegida.
      if (meta) pintarFiltros();
      recargar();
      const flowDe = id => filas.find(f => f.id === id) ?? null;
      const elegirMarca = id => {
        marca = id;
        keep.set('marca', marca);
        pintarFiltros();
        recargar();
      };
      const off = listen(
        vista,
        {
          click: {
            nuevo: () => nuevo(),
            abrir: (e, el) => ir('editor', el.dataset.id),
            duplicar: async (e, el) => {
              const r = await api.post(`/api/chatflows/${el.dataset.id}/duplicate`, { clientRef: newClientRef() });
              ctx.toast(`Se creó «${r.flow.name}».`);
              recargar();
            },
            activar: (e, el) => cambiarEstado(el.dataset.id, 'activate', flowDe(el.dataset.id)).then(recargar),
            pausar: (e, el) => cambiarEstado(el.dataset.id, 'pause', flowDe(el.dataset.id)).then(recargar),
            archivar: (e, el) => cambiarEstado(el.dataset.id, 'archive', flowDe(el.dataset.id)).then(recargar),
            'marca-pildora': (e, el) => elegirMarca(el.dataset.id),
            'reintentar-lista': () => recargar(),
          },
          change: {
            marca: (e, el) => elegirMarca(formValues(el).marca),
            archivados: (e, el) => {
              keep.set('archivados', el.checked);
              ir('lista');
            },
          },
        },
        { onError: fallo },
      );
      limpiar = () => {
        off();
        pedido?.abort();
      };
      alCambiar = evento => {
        if (evento.brandId === marca) recargar();
      };
    }

    // Activar, pausar o archivar, con su explicación. Devuelve el recorrido actualizado (o null si no se hizo).
    async function cambiarEstado(id, accion, flow) {
      const actual = flow ?? (await api.get(`/api/chatflows/${id}`)).flow;
      let stopSessions = false;
      if (accion === 'activate') {
        const a = atencion();
        const choice = await dialog({
          title: 'Activar el recorrido',
          content: html`<p>
              «${actual.name}» empezará a atender a quien escriba
              (${comoEmpieza(actual.start, meta?.startTypes).toLowerCase()}) con la versión ${actual.publishedVersion}.
            </p>
            ${when(
              a && !a.ok,
              () => html`<p class="k-notice k-notice--warn" role="alert">
                <strong>Ahora mismo no atenderá a nadie.</strong> ${a.label} Puedes activarlo igual, pero no contestará
                hasta que se encienda en <strong>${a.where}</strong>.
              </p>`,
            )}`,
          actions: [
            { id: 'no', label: 'Cancelar' },
            { id: 'si', label: a && !a.ok ? 'Activar de todos modos' : 'Activar', primary: true, autofocus: true },
          ],
        });
        if (choice !== 'si') return null;
      } else if (accion === 'pause') {
        const choice = await dialog({
          title: 'Pausar el recorrido',
          content: html`<p>Mientras esté en pausa no empieza con nadie. Las conversaciones que ya van en él pueden terminar o detenerse ahora.</p>`,
          actions: [
            { id: 'no', label: 'Cancelar' },
            { id: 'detener', label: 'Pausar y detener las conversaciones' },
            { id: 'pausar', label: 'Pausar', primary: true, autofocus: true },
          ],
        });
        if (!choice || choice === 'no') return null;
        stopSessions = choice === 'detener';
      } else {
        const ok = await confirm({
          title: 'Archivar el recorrido',
          message: `«${actual.name}» deja de atender y las conversaciones que van en él se detienen. Su historial y sus cifras se conservan.`,
          confirmLabel: 'Archivar',
          danger: true,
        });
        if (!ok) return null;
      }
      const r = await api.post(`/api/chatflows/${id}/${accion}`, { expectedRevision: actual.revision, stopSessions });
      ctx.toast(
        accion === 'activate'
          ? 'Recorrido activo.'
          : accion === 'pause'
            ? `Recorrido en pausa${r.stopped ? `; se detuvieron ${r.stopped} conversaciones` : ''}.`
            : 'Recorrido archivado.',
      );
      return r.flow;
    }

    async function nuevo() {
      const ids = { nombre: ctx.uid('nuevo-nombre'), base: ctx.uid('nuevo-base') };
      const ref = newClientRef();
      const creado = await dialog({
        title: 'Nuevo recorrido',
        mount(body, close) {
          render(
            body,
            html`<form class="k-form" novalidate data-do="crear">
              ${field({ name: 'name', label: 'Nombre', required: true, maxlength: 80 }, { id: ids.nombre, value: '' })}
              ${field(
                {
                  name: 'base',
                  label: 'Empezar desde',
                  type: 'radio',
                  options: [
                    {
                      value: 'plantilla',
                      label: 'Plantilla de ejemplo «Venta de curso» (lista para revisar y publicar)',
                    },
                    { value: 'blanco', label: 'En blanco (sólo el Inicio)' },
                  ],
                },
                { id: ids.base, value: 'plantilla' },
              )}
              <p class="k-error" data-slot="error" role="alert"></p>
              <div class="k-form__actions">
                <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
                <button type="submit" class="k-btn k-btn--primary">Crear</button>
              </div>
            </form>`,
          );
          return listen(body, {
            click: { cancelar: () => close(null) },
            submit: {
              crear: async (e, form) => {
                const v = formValues(form);
                const error = body.querySelector('[data-slot="error"]');
                if (!String(v.name || '').trim()) {
                  error.textContent = 'Escribe el nombre del recorrido.';
                  return;
                }
                const base = v.base === 'blanco' ? { graph: emptyGraph(), start: { type: 'manual' } } : saleTemplate();
                try {
                  const r = await api.post('/api/chatflows', {
                    brandId: marca,
                    name: v.name,
                    description: base.description || '',
                    graph: base.graph,
                    settings: base.settings,
                    start: base.start,
                    clientRef: ref,
                  });
                  close(r.flow);
                } catch (err) {
                  if (!isAbort(err)) error.textContent = err.message;
                }
              },
            },
          });
        },
      });
      if (creado) ir('editor', creado.id);
    }

    // ------------------------------------------------------------------------------------------------ editor
    function editor(flowId) {
      let record = null; // el recorrido como lo tiene el servidor (con su revisión)
      let versions = [];
      let lists = null;
      let canvas = null;
      let rendimiento = null; // última respuesta de la analítica
      let sugerencias = null;
      let pidiendo = false;
      let otroGuardo = false;
      // ¿Cómo empieza o los ajustes del borrador son distintos de los de la versión publicada? Entonces lo que se
      // cambió en «Ajustes» todavía no está en servicio: se dice hasta que se publique.
      let ajustesPendientes = false;
      const prefs = keep.get('rend:' + flowId) ?? { days: 30, version: '' };
      const pestana = () => keep.get('pestana:' + flowId) ?? 'editar';
      const offs = [];

      render(vista, loading('Cargando el recorrido…'));
      const cargar = Promise.all([
        api.get(`/api/chatflows/${flowId}`),
        api.get('/api/chatflows', marca ? { brand: marca } : {}),
      ]).then(async ([uno, todos]) => {
        if (!meta || !todos.brands.some(b => b.id === uno.flow.brandId))
          meta = { brands: todos.brands, startTypes: todos.startTypes, unavailable: todos.unavailable };
        keep.set('meta', meta);
        marca = uno.flow.brandId;
        keep.set('marca', marca);
        // Las listas de la marca se piden cada vez que se abre el editor: una plantilla recién adoptada, un material
        // recién aprobado o un curso nuevo deben poder elegirse sin recargar la aplicación.
        lists = (await api.get('/api/chatflows/lists', { brand: marca })).lists;
        return uno;
      });
      cargar.then(
        uno => {
          if (!vivo) return;
          record = uno.flow;
          versions = uno.versions;
          guardarAtencion(uno.attending);
          esqueleto(uno.canManage);
        },
        error => {
          if (isAbort(error) || !vivo) return;
          render(
            vista,
            failure({
              title: 'No se pudo abrir el recorrido',
              error,
              retry: 'reintentar',
            }),
          );
          offs.push(listen(vista, { click: { reintentar: () => ir('editor', flowId) } }));
        },
      );

      function esqueleto(canManage) {
        render(
          vista,
          html`<header class="k-head au-head au-head--editor">
              <div class="au-titulo">
                <div class="au-migas">
                  <button type="button" class="k-btn k-btn--ghost au-volver" data-do="volver">← Recorridos</button>
                  <span class="k-eyebrow">Recorrido</span>
                  <h1 data-slot="nombre"></h1>
                </div>
                <p class="au-meta" data-slot="meta"></p>
              </div>
              <div class="k-actions au-acciones" data-slot="acciones"></div>
            </header>
            <div class="au-avisos-editor" data-slot="avisos"></div>
            <div class="k-tabs au-pestanas" role="tablist" aria-label="Partes del recorrido" data-slot="pestanas"></div>
            <div class="au-panel" data-slot="p-editar" role="tabpanel" aria-label="Editar"><div class="au-editor" data-slot="editor"></div></div>
            <div class="au-panel" data-slot="p-rendimiento" role="tabpanel" aria-label="Rendimiento" hidden></div>
            <div class="au-panel" data-slot="p-versiones" role="tabpanel" aria-label="Versiones" hidden></div>`,
        );
        let store = keep.get('store:' + flowId);
        if (!store) {
          store = createStore({ graph: record.graph });
          keep.set('store:' + flowId, store);
        } else if (!store.isDirty() && keep.get('rev:' + flowId) !== record.revision) {
          // Lo guardado cambió mientras no se veía y aquí no había cambios: se toma lo del servidor.
          store.setGraph(record.graph);
          store.markSaved();
        }
        keep.set('rev:' + flowId, record.revision);
        canvas = mountCanvas(vista.querySelector('[data-slot="editor"]'), {
          store,
          settings: record.settings,
          catalogue: { ...lists, ai: false, serverRules: true, flowId },
          readOnly: !canManage,
          unavailable: meta?.unavailable || {},
          uid: ctx.uid,
          // La vista con que abre: «Pasos», salvo que la persona haya elegido el lienzo (se recuerda mientras la
          // aplicación esté abierta; ctx.keep, nunca el almacenamiento del navegador).
          pane: keep.get('vistaEditor') === 'canvas' ? 'canvas' : 'outline',
          onPane: pane => keep.set('vistaEditor', pane),
          startText: comoEmpieza(record.start, meta?.startTypes),
          onSave: canManage ? guardar : undefined,
          // Las pestañas viven también al principio de la barra del editor (un solo renglón con las herramientas): sus
          // clics no salen de la raíz del lienzo, así que se atienden aquí.
          handlers: { click: { pestana: (e, el) => mostrar(el.dataset.id) }, keydown: { pestana: teclaPestana } },
          // Subir una imagen o un PDF a la biblioteca de la marca desde el paso (Mensaje con archivo, Botones).
          uploadFile: canManage
            ? async file => {
                const r = await api.post('/api/chatflows/files', {
                  brandId: marca,
                  clientRef: newClientRef(),
                  file,
                });
                lists = { ...lists, files: [r.file, ...(lists.files || []).filter(f => f.id !== r.file.id)] };
                return r.file;
              }
            : undefined,
          // Probar usa el servidor: con permiso, el borrador tal como está en pantalla (aunque no esté guardado).
          simulate: body =>
            api.post(
              `/api/chatflows/${flowId}/simulate`,
              canManage ? { ...body, graph: canvas.getGraph(), settings: record.settings } : body,
            ),
          onChange: () => pintarAvisos(),
        });
        pintarCabeza();
        pintarPestanas();
        mostrar(pestana());
        // Cambiar el ancho (o el alto, que suele venir con él) vuelve a medir el alto del editor.
        const win = vista.ownerDocument.defaultView;
        if (typeof win.ResizeObserver === 'function') {
          // En el siguiente cuadro: cambiar el alto dentro del aviso del observador lo volvería a disparar en el mismo.
          const observer = new win.ResizeObserver(() =>
            win.requestAnimationFrame(() => vivo && canvas && ajustarAlto()),
          );
          observer.observe(vista);
          offs.push(() => observer.disconnect());
        }
        cargarRendimiento();
        revisarAjustesPublicados();
        offs.push(
          listen(
            vista,
            {
              click: {
                volver: () => ir('lista'),
                ajustes: () => ajustes(),
                revisar: () => revisar(),
                publicar: () => publicar(),
                activar: () => estadoDesdeEditor('activate'),
                pausar: () => estadoDesdeEditor('pause'),
                pestana: (e, el) => mostrar(el.dataset.id),
                recargar: () => recargarRecord(true),
                'ver-paso': (e, el) => verPaso(el.dataset.node),
                'ver-cifras': () => verPaso(null),
                sugerencias: () => pedirSugerencias(),
                'reintentar-rend': () => cargarRendimiento(),
              },
              change: {
                periodo: (e, el) => {
                  prefs.days = Number(el.value) || 30;
                  keep.set('rend:' + flowId, prefs);
                  cargarRendimiento();
                },
                version: (e, el) => {
                  prefs.version = el.value;
                  keep.set('rend:' + flowId, prefs);
                  cargarRendimiento();
                },
              },
              keydown: { pestana: teclaPestana },
            },
            { onError: fallo },
          ),
        );
      }

      const manage = () => puedeEditar();
      let publicadoStart = null;
      const igual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      // Trae cómo empieza y los ajustes de la versión en servicio (una petición al abrir y al publicar, nunca al teclear).
      async function revisarAjustesPublicados() {
        if (!record?.publishedVersion) {
          ajustesPendientes = false;
          return;
        }
        try {
          const { version } = await api.get(`/api/chatflows/${flowId}/versions/${record.publishedVersion}`);
          if (!vivo || !canvas) return;
          publicadoStart = version.start;
          ajustesPendientes = !igual(version.start, record.start) || !igual(version.settings, record.settings);
          pintarAvisos();
        } catch {
          // Sin la versión no se puede comparar: no se dice nada en lugar de decir algo que quizá no es cierto.
        }
      }
      function guardarAtencion(a) {
        const b = meta?.brands.find(x => x.id === marca);
        if (b && a) b.attending = a;
      }

      function pintarCabeza() {
        canvas?.setStartText(comoEmpieza(record.start, meta?.startTypes));
        render(vista.querySelector('[data-slot="nombre"]'), html`${record.name} ${chip(record, atencion())}`);
        render(
          vista.querySelector('[data-slot="meta"]'),
          html`Empieza: ${comoEmpieza(record.start, meta?.startTypes)} ·
          ${record.publishedVersion ? `Versión ${record.publishedVersion} publicada el ${fecha(record.publishedAt)}` : 'Todavía sin publicar'}`,
        );
        render(
          vista.querySelector('[data-slot="acciones"]'),
          html`${when(manage(), () => html`<button type="button" class="k-btn" data-do="ajustes">Ajustes</button>`)}
            <button type="button" class="k-btn" data-do="revisar">Revisar</button>
            ${when(
              manage() && record.status !== 'archived',
              () => html`<button type="button" class="k-btn k-btn--primary au-cta" data-do="publicar">Publicar</button>
                ${
                  record.status === 'active'
                    ? html`<button type="button" class="k-btn" data-do="pausar">Pausar</button>`
                    : record.publishedVersion
                      ? html`<button type="button" class="k-btn" data-do="activar">Activar</button>`
                      : ''
                }`,
            )}`,
        );
        pintarAvisos();
      }

      function pintarAvisos() {
        const caja = vista.querySelector('[data-slot="avisos"]');
        if (!caja) return;
        render(
          caja,
          html`${when(atencion() && !atencion().ok, () => tiraAtencion(atencion()))}${when(atencion()?.info, () =>
            tiraInfo(atencion().info),
          )}${when(
            !manage(),
            () =>
              html`<p class="k-notice au-aviso" role="status">Puedes ver y probar este recorrido, pero no editarlo ni publicarlo.</p>`,
          )}${when(
            ajustesPendientes && record.publishedVersion,
            () => html`<p class="k-notice k-notice--warn au-aviso au-ajustes-pendientes" role="status">
              <span><strong>Los cambios de «Ajustes» todavía no están en servicio.</strong> La versión ${record.publishedVersion}
              sigue empezando «${comoEmpieza(publicadoStart, meta?.startTypes).toLowerCase()}» con sus tiempos de siempre hasta que
              pulses «Publicar».</span>
            </p>`,
          )}${when(
            otroGuardo,
            () => html`<p class="k-notice k-notice--warn au-aviso" role="status">
              Alguien más guardó cambios en este recorrido. Tus cambios siguen aquí sin guardar; si guardas, se te pedirá
              elegir.
              <button type="button" class="k-link" data-do="recargar">Ver lo que guardó (descarta mis cambios)</button>
            </p>`,
          )}`,
        );
        ajustarAlto();
      }

      function teclaPestana(e, el) {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const orden = ['editar', 'rendimiento', 'versiones'];
        const i = (orden.indexOf(el.dataset.id) + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
        mostrar(orden[i]);
        // Hay dos filas de pestañas (la de la barra del editor y la de las otras partes): va a la que se ve.
        [...vista.querySelectorAll(`[data-do="pestana"][data-id="${orden[i]}"]`)].find(b => b.offsetParent)?.focus();
      }

      // El editor ocupa lo que queda de la ventana (sin bajar de 520 px): así, en una pantalla de computadora, los
      // primeros pasos, el paso elegido y la vista previa se ven sin desplazar la página.
      function ajustarAlto() {
        const caja = vista.querySelector('.au-editor');
        if (!caja) return;
        const win = caja.ownerDocument.defaultView;
        if (win.innerWidth < 900) {
          caja.style.removeProperty('--au-alto');
          return;
        }
        let scroller = caja.parentElement;
        while (scroller && !/(auto|scroll)/.test(win.getComputedStyle(scroller).overflowY))
          scroller = scroller.parentElement;
        // Dónde queda el editor con la página arriba del todo: su posición en la ventana más lo ya desplazado.
        const top = caja.getBoundingClientRect().top + (scroller ? scroller.scrollTop : win.scrollY);
        const alto = `${Math.max(520, Math.floor(win.innerHeight - top - 16))}px`;
        if (caja.style.getPropertyValue('--au-alto') !== alto) caja.style.setProperty('--au-alto', alto);
      }

      function pintarPestanas() {
        const items = [
          ['editar', 'Editar'],
          ['rendimiento', 'Rendimiento'],
          ['versiones', 'Versiones'],
        ];
        const fila = html`${items.map(
          ([id, label]) =>
            html`<button type="button" role="tab" class="k-tab" data-do="pestana" data-id="${id}" aria-selected="${id === pestana()}" tabindex="${id === pestana() ? 0 : -1}">${label}${id === 'versiones' ? html`<span class="k-tab__count">${versions.length}</span>` : ''}</button>`,
        )}`;
        const fuera = vista.querySelector('[data-slot="pestanas"]');
        render(fuera, fila);
        // En «Editar» las pestañas van en la barra del editor, junto a las herramientas; en las otras partes, arriba.
        const enBarra = Boolean(canvas?.barStart) && pestana() === 'editar';
        fuera.hidden = enBarra;
        if (canvas?.barStart)
          render(
            canvas.barStart,
            html`<div class="k-tabs au-pestanas au-pestanas--barra" role="tablist" aria-label="Partes del recorrido">${fila}</div>`,
          );
      }

      function mostrar(id) {
        keep.set('pestana:' + flowId, id);
        for (const nombre of ['editar', 'rendimiento', 'versiones'])
          vista.querySelector(`[data-slot="p-${nombre}"]`).hidden = nombre !== id;
        pintarPestanas();
        if (id === 'versiones') pintarVersiones();
        if (id === 'rendimiento') pintarRendimiento();
        if (id === 'editar') ajustarAlto();
      }

      // ---- guardar (lo llama el lienzo con «Guardar» o Ctrl+S)
      async function guardar(graph) {
        try {
          const r = await api.put(`/api/chatflows/${flowId}/draft`, { expectedRevision: record.revision, graph });
          record = r.flow;
          keep.set('rev:' + flowId, record.revision);
          otroGuardo = false;
          pintarCabeza();
        } catch (error) {
          if (isStale(error)) conflicto();
          throw error;
        }
      }

      async function conflicto() {
        otroGuardo = true;
        pintarAvisos();
        const choice = await dialog({
          title: 'Alguien más guardó este recorrido',
          content: html`<p>
            Mientras lo editabas, otra persona guardó cambios. No se pisó nada: tus cambios siguen en pantalla, sin
            guardar. Puedes ver lo que guardó (y perder tus cambios) o seguir aquí y copiar lo que necesites.
          </p>`,
          actions: [
            { id: 'seguir', label: 'Seguir aquí', autofocus: true },
            { id: 'cargar', label: 'Ver lo que guardó', danger: true },
          ],
        });
        if (choice === 'cargar') await recargarRecord(true);
      }

      async function recargarRecord(descartar = false) {
        const uno = await api.get(`/api/chatflows/${flowId}`);
        if (!vivo || !canvas) return;
        const cambio = uno.flow.revision !== record.revision;
        record = uno.flow;
        versions = uno.versions;
        guardarAtencion(uno.attending);
        if (descartar || (cambio && !canvas.isDirty())) {
          canvas.setGraph(record.graph);
          canvas.markSaved();
          canvas.setSettings(record.settings);
          otroGuardo = false;
        } else if (cambio) otroGuardo = true;
        keep.set('rev:' + flowId, record.revision);
        pintarCabeza();
        pintarPestanas();
        if (pestana() === 'versiones') pintarVersiones();
      }

      // ---- ajustes del recorrido: nombre, cómo empieza y tiempos
      async function ajustes() {
        const ids = {
          name: ctx.uid('aj-nombre'),
          description: ctx.uid('aj-descripcion'),
          type: ctx.uid('aj-inicio'),
          keywords: ctx.uid('aj-palabras'),
          mode: ctx.uid('aj-modo'),
          timeout: ctx.uid('aj-tiempo'),
          misses: ctx.uid('aj-desvios'),
        };
        const tipos = meta?.startTypes || START_FALLBACK;
        const hecho = await dialog({
          title: 'Ajustes del recorrido',
          wide: true,
          mount(body, close) {
            const pintar = tipo =>
              render(
                body,
                html`<form class="k-form" novalidate data-do="guardar-ajustes">
                  ${field({ name: 'name', label: 'Nombre', required: true, maxlength: 80 }, { id: ids.name, value: record.name })}
                  ${field(
                    {
                      name: 'description',
                      label: 'Descripción (sólo para el equipo)',
                      type: 'textarea',
                      rows: 2,
                      maxlength: 300,
                    },
                    { id: ids.description, value: record.description || '' },
                  )}
                  ${field(
                    {
                      name: 'type',
                      label: 'Cómo empieza',
                      type: 'select',
                      hint: 'Con «a mano» sólo lo inicia alguien del equipo desde el chat. Los demás atienden solos cuando el recorrido está publicado y activo.',
                      options: Object.entries(tipos).map(([value, label]) => ({ value, label })),
                    },
                    { id: ids.type, value: tipo },
                  )}
                  ${when(
                    tipo === 'keyword',
                    () => html`${field(
                      {
                        name: 'keywords',
                        label: 'Palabras clave',
                        type: 'textarea',
                        rows: 2,
                        hint: 'Separadas por comas; hasta 30.',
                      },
                      { id: ids.keywords, value: (record.start?.keywords || []).join(', ') },
                    )}
                    ${field(
                      {
                        name: 'mode',
                        label: 'Cómo se comparan',
                        type: 'select',
                        options: [
                          { value: 'contains', label: 'El mensaje contiene la palabra' },
                          { value: 'exact', label: 'El mensaje es exactamente la palabra' },
                          { value: 'fuzzy', label: 'Parecida (tolera errores de dedo)' },
                        ],
                      },
                      { id: ids.mode, value: record.start?.mode || 'contains' },
                    )}`,
                  )}
                  ${field(
                    {
                      name: 'timeoutMinutes',
                      label: 'Minutos sin respuesta para dar la conversación por abandonada',
                      type: 'number',
                      min: 5,
                      max: 1440,
                    },
                    { id: ids.timeout, value: record.settings?.timeoutMinutes ?? 1440 },
                  )}
                  ${field(
                    {
                      name: 'maxMisses',
                      label: 'Mensajes fuera de las opciones antes de dejar al asistente',
                      type: 'select',
                      options: ['1', '2', '3'].map(value => ({ value, label: value })),
                    },
                    { id: ids.misses, value: String(record.settings?.maxMisses ?? 2) },
                  )}
                  <p class="k-error" data-slot="error" role="alert"></p>
                  <div class="k-form__actions">
                    <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
                    <button type="submit" class="k-btn k-btn--primary">Guardar ajustes</button>
                  </div>
                </form>`,
              );
            pintar(record.start?.type || 'manual');
            return listen(body, {
              click: { cancelar: () => close(null) },
              change: {
                'guardar-ajustes': (e, form) => {
                  if (e.target.name === 'type') pintar(formValues(form).type);
                },
              },
              submit: {
                'guardar-ajustes': async (e, form) => {
                  const v = formValues(form);
                  const error = body.querySelector('[data-slot="error"]');
                  const start =
                    v.type === 'keyword'
                      ? {
                          type: 'keyword',
                          keywords: String(v.keywords || '')
                            .split(',')
                            .map(w => w.trim())
                            .filter(Boolean),
                          mode: v.mode,
                        }
                      : { type: v.type };
                  try {
                    const r = await api.put(`/api/chatflows/${flowId}/draft`, {
                      expectedRevision: record.revision,
                      name: v.name,
                      description: v.description || '',
                      start,
                      settings: {
                        ...record.settings,
                        timeoutMinutes: Number(v.timeoutMinutes) || 1440,
                        maxMisses: Number(v.maxMisses) || 2,
                      },
                    });
                    close(r.flow);
                  } catch (err) {
                    if (isAbort(err)) return;
                    error.textContent = isStale(err)
                      ? 'Alguien más guardó este recorrido. Cierra esta ventana y vuelve a abrir el recorrido.'
                      : err.message;
                  }
                },
              },
            });
          },
        });
        if (!hecho) return;
        const antes = record;
        record = hecho;
        keep.set('rev:' + flowId, record.revision);
        canvas.setSettings(record.settings);
        canvas.setStartText(comoEmpieza(record.start, meta?.startTypes));
        pintarCabeza();
        const cambioInicio = !igual(antes.start, record.start) || !igual(antes.settings, record.settings);
        if (record.publishedVersion && cambioInicio) {
          // Lo que atiende es la versión publicada: el cambio no cuenta hasta publicar. Se dice claro, no sólo en un aviso
          // que se va.
          await revisarAjustesPublicados();
          const choice = await dialog({
            title: 'Ajustes guardados, pero todavía no en servicio',
            content: html`<p>
                Se guardaron en el borrador. Quien escriba ahora sigue entrando con la versión ${record.publishedVersion}
                publicada, que empieza «${comoEmpieza(publicadoStart ?? antes.start, meta?.startTypes).toLowerCase()}».
              </p>
              <p>
                El cambio (ahora: «${comoEmpieza(record.start, meta?.startTypes).toLowerCase()}») cuenta cuando pulses
                <strong>Publicar</strong>.
              </p>`,
            actions: [
              { id: 'luego', label: 'Publicar después' },
              { id: 'publicar', label: 'Publicar ahora', primary: true, autofocus: true },
            ],
          });
          if (choice === 'publicar') await publicar();
          return;
        }
        ctx.toast('Ajustes guardados.');
      }

      // ---- revisar: la validación del servidor (con lo que hay en pantalla), en una lista que lleva a cada paso
      async function revisar({ antesDePublicar = false } = {}) {
        const r = await api.post(`/api/chatflows/${flowId}/validate`, {
          graph: canvas.getGraph(),
          settings: record.settings,
          start: record.start,
        });
        if (antesDePublicar && r.ok) return r;
        const graph = canvas.getGraph();
        const orden = readingOrder(graph);
        const nombre = id => {
          const n = graph.nodes.find(x => x.id === id);
          return n ? `paso ${orden.indexOf(id) + 1}, «${nodeName(n, lists)}»` : '';
        };
        const item = (issue, grave) =>
          html`<li class="au-problema" data-level="${grave ? 'error' : 'warn'}">
            <span class="${['k-chip', grave ? 'k-chip--bad' : 'k-chip--warn']}">${grave ? 'Impide publicar' : 'Recomendación'}</span>
            <span class="au-problema__texto">${issue.message}</span>
            ${when(
              issue.nodeId,
              () =>
                html`<button type="button" class="k-btn k-btn--ghost" data-do="ir-paso" data-node="${issue.nodeId}">Ir al ${nombre(issue.nodeId)}</button>`,
            )}
          </li>`;
        const destino = await dialog({
          title: r.ok ? 'Revisión: se puede publicar' : 'Revisión: hay que corregir antes de publicar',
          wide: true,
          mount(body, close) {
            render(
              body,
              html`<div class="au-revision" data-slot="revision">
                <p>
                  ${
                    r.ok
                      ? 'Nada impide publicar este recorrido.'
                      : `${r.issues.errors.length} ${r.issues.errors.length === 1 ? 'problema impide' : 'problemas impiden'} publicarlo.`
                  }
                  ${r.issues.warnings.length ? `Hay ${r.issues.warnings.length} ${r.issues.warnings.length === 1 ? 'recomendación' : 'recomendaciones'}.` : ''}
                  La revisión es de lo que ves en pantalla, aunque no esté guardado.
                </p>
                <ul class="au-problemas">
                  ${r.issues.errors.map(i => item(i, true))}${r.issues.warnings.map(i => item(i, false))}
                </ul>
                <div class="k-form__actions">
                  <button type="button" class="k-btn k-btn--primary" data-do="cerrar">Cerrar</button>
                </div>
              </div>`,
            );
            return listen(body, {
              click: { cerrar: () => close(null), 'ir-paso': (e, el) => close(el.dataset.node) },
            });
          },
        });
        if (destino) {
          mostrar('editar');
          canvas.showStats(false);
          canvas.openIssues(destino);
        }
        return r;
      }

      // ---- publicar: guarda si hace falta, revisa y confirma con lo que pasa con las conversaciones en curso
      async function publicar() {
        if (canvas.isDirty()) {
          try {
            await guardar(canvas.getGraph());
            canvas.markSaved();
          } catch (error) {
            if (!isStale(error)) fallo(error);
            return;
          }
        }
        const r = await revisar({ antesDePublicar: true });
        if (!r.ok) return;
        const siguiente = (versions[0]?.version ?? 0) + 1;
        const nota = ctx.uid('pub-nota');
        // Los avisos no impiden publicar (así lo decide el servidor), pero no se publican en silencio: se nombran uno
        // por uno, cada uno con su paso, y hay que confirmarlo.
        const avisos = r.issues?.warnings || [];
        const grafo = canvas.getGraph();
        const orden = readingOrder(grafo);
        const pasoDe = id => {
          const n = grafo.nodes.find(x => x.id === id);
          return n ? `Paso ${orden.indexOf(id) + 1}, «${nodeName(n, lists)}»` : 'El recorrido';
        };
        const valor = await dialog({
          title: avisos.length
            ? `Publicar la versión ${siguiente} con ${avisos.length} ${avisos.length === 1 ? 'aviso' : 'avisos'}`
            : `Publicar la versión ${siguiente}`,
          wide: avisos.length > 0,
          mount(body, close) {
            render(
              body,
              html`<form class="k-form" novalidate data-do="confirmar">
                ${when(
                  avisos.length,
                  () => html`<div class="k-notice k-notice--warn au-pub-avisos" role="alert">
                    <p><strong>${avisos.length === 1 ? 'Queda un aviso sin resolver' : `Quedan ${avisos.length} avisos sin resolver`}.</strong>
                    No impiden publicar, pero así quedará lo que reciba la persona:</p>
                    <ul class="au-problemas">
                      ${avisos.map(
                        a => html`<li class="au-problema" data-level="warn">
                          <span class="au-problema__texto"><strong>${a.nodeId ? pasoDe(a.nodeId) : 'El recorrido'}:</strong> ${a.message}</span>
                          ${when(a.nodeId, () => html`<button type="button" class="k-btn k-btn--ghost" data-do="pub-ir" data-node="${a.nodeId}">Ir al paso</button>`)}
                        </li>`,
                      )}
                    </ul>
                  </div>`,
                )}
                <p>
                  Lo que está guardado queda como la versión ${siguiente}. Las conversaciones que ya van en un recorrido
                  siguen con la versión con la que empezaron; las nuevas usan ésta
                  ${record.status === 'active' ? 'desde ahora' : 'cuando actives el recorrido'}. No se envía nada al
                  publicar.
                </p>
                ${field(
                  { name: 'note', label: 'Nota de la versión (opcional)', maxlength: 300, placeholder: 'Qué cambió' },
                  { id: nota, value: '' },
                )}
                <div class="k-form__actions">
                  <button type="button" class="k-btn" data-do="cancelar">${avisos.length ? 'Volver a corregir' : 'Cancelar'}</button>
                  <button type="submit" class="k-btn k-btn--primary">${avisos.length ? 'Publicar de todos modos' : 'Publicar'}</button>
                </div>
              </form>`,
            );
            return listen(body, {
              click: {
                cancelar: () => close(null),
                'pub-ir': (e, el) => close({ ir: el.dataset.node }),
              },
              submit: { confirmar: (e, form) => close({ note: formValues(form).note || '' }) },
            });
          },
        });
        if (valor?.ir) {
          mostrar('editar');
          canvas.showStats(false);
          canvas.openIssues(valor.ir);
          return;
        }
        if (!valor) return;
        try {
          const p = await api.post(`/api/chatflows/${flowId}/publish`, {
            expectedRevision: record.revision,
            note: valor.note,
          });
          record = p.flow;
          keep.set('rev:' + flowId, record.revision);
          ctx.toast(
            record.status === 'active'
              ? `Versión ${p.version} publicada: ya atiende.`
              : `Versión ${p.version} publicada. Actívala para que empiece a atender.`,
          );
          ajustesPendientes = false;
          await recargarRecord();
          revisarAjustesPublicados();
        } catch (error) {
          if (isStale(error)) conflicto();
          else fallo(error);
        }
      }

      async function estadoDesdeEditor(accion) {
        const flow = await cambiarEstado(flowId, accion, record);
        if (!flow) return;
        record = flow;
        keep.set('rev:' + flowId, record.revision);
        pintarCabeza();
      }

      // ---- versiones
      function pintarVersiones() {
        render(
          vista.querySelector('[data-slot="p-versiones"]'),
          versions.length
            ? html`<ol class="au-versiones k-card">
                ${versions.map(
                  v => html`<li data-key="${v.version}">
                    <strong>Versión ${v.version}</strong>
                    ${when(v.version === record.publishedVersion, () => html` <span class="k-chip k-chip--ok">En servicio</span>`)}
                    <span class="k-muted">· publicada el ${fecha(v.publishedAt)}</span>
                    ${when(v.note, () => html`<p class="au-nota">${v.note}</p>`)}
                  </li>`,
                )}
              </ol>`
            : html`<p class="k-notice">Todavía no hay versiones publicadas. Al publicar, lo guardado queda como la versión 1.</p>`,
        );
      }

      // ---- rendimiento por paso
      function cargarRendimiento() {
        const query = { days: String(prefs.days), ...(prefs.version ? { version: prefs.version } : {}) };
        api.get(`/api/chatflows/${flowId}/analytics`, query).then(
          r => {
            if (!vivo || !canvas) return;
            rendimiento = r;
            canvas.setStats(r.sessions.started ? { nodes: r.nodes } : null);
            if (pestana() === 'rendimiento') pintarRendimiento();
          },
          error => {
            if (isAbort(error) || !vivo) return;
            rendimiento = { error };
            if (pestana() === 'rendimiento') pintarRendimiento();
          },
        );
      }

      function verPaso(nodeId) {
        mostrar('editar');
        canvas.showStats(true);
        if (nodeId) canvas.focusNode(nodeId);
      }

      function pintarRendimiento() {
        const caja = vista.querySelector('[data-slot="p-rendimiento"]');
        if (!rendimiento) return render(caja, loading('Calculando el rendimiento…'));
        if (rendimiento.error)
          return render(
            caja,
            failure({ title: 'No se pudo calcular', error: rendimiento.error, retry: 'reintentar-rend' }),
          );
        const r = rendimiento;
        const graph = canvas.getGraph();
        const orden = readingOrder(graph).filter(id => graph.nodes.some(n => n.id === id && n.type !== 'note'));
        const nombre = id => {
          const n = graph.nodes.find(x => x.id === id);
          return n ? nodeName(n, lists) : 'un paso que ya no existe';
        };
        const paso = id => (orden.includes(id) ? `paso ${orden.indexOf(id) + 1}, «${nombre(id)}»` : `«${nombre(id)}»`);
        const s = r.sessions;
        const ids = { periodo: ctx.uid('rend-periodo'), version: ctx.uid('rend-version') };
        render(
          caja,
          html`<div class="k-stack au-rend">
            <form class="au-rend-filtros" novalidate>
              <div class="k-field">
                <label class="k-label" for="${ids.periodo}">Periodo</label>
                <select class="k-input" id="${ids.periodo}" data-do="periodo">
                  ${[7, 30, 90].map(d => html`<option value="${d}" ${attrs({ selected: prefs.days === d })}>Últimos ${d} días</option>`)}
                </select>
              </div>
              <div class="k-field">
                <label class="k-label" for="${ids.version}">Versión</label>
                <select class="k-input" id="${ids.version}" data-do="version">
                  <option value="" ${attrs({ selected: !prefs.version })}>${record.publishedVersion ? `La que está en servicio (${record.publishedVersion})` : 'La que está en servicio'}</option>
                  ${r.versions.map(v => html`<option value="${v.version}" ${attrs({ selected: prefs.version === String(v.version) })}>Versión ${v.version}</option>`)}
                  <option value="all" ${attrs({ selected: prefs.version === 'all' })}>Todas las versiones</option>
                </select>
              </div>
            </form>
            ${
              !s.started
                ? html`<p class="k-notice">Sin conversaciones en este periodo${r.version ? ` con la versión ${r.version}` : ''}. Las cifras aparecen cuando el recorrido publicado y activo empieza a atender.</p>`
                : html`<div class="k-tiles au-tiles">
                      ${[
                        ['Empezaron', numero(s.started), ''],
                        ['Terminaron el recorrido', numero(s.completed), `${pct(s.completed, s.started)} %`],
                        ['Pasaron con una persona', numero(s.handoff), `${pct(s.handoff, s.started)} %`],
                        ['Se fueron', numero(s.dropped + s.left), `${pct(s.dropped + s.left, s.started)} %`],
                        ['En curso', numero(s.inProgress), ''],
                      ].map(
                        ([label, value, hint]) => html`<div class="k-tile">
                          <span class="k-tile__label">${label}</span>
                          <span class="k-tile__value">${value}</span>
                          ${when(hint, () => html`<span class="k-tile__hint">${hint} de las que empezaron</span>`)}
                        </div>`,
                      )}
                    </div>
                    <section class="k-card">
                      <h2 class="k-card__title">Dónde se pierde gente</h2>
                      ${
                        r.weakest.length
                          ? html`<ol class="au-debiles">
                              ${r.weakest.map(
                                w => html`<li data-key="${w.nodeId}">
                                  <span>El <strong>${Math.round(w.rate * 100)} %</strong> se va en el ${paso(w.nodeId)}: ${numero(w.lost)} de ${numero(w.entered)}.</span>
                                  <button type="button" class="k-btn k-btn--ghost" data-do="ver-paso" data-node="${w.nodeId}">Ver en el recorrido</button>
                                </li>`,
                              )}
                            </ol>`
                          : html`<p class="k-muted">Nadie se fue a mitad del recorrido en este periodo.</p>`
                      }
                    </section>
                    <section class="k-card">
                      <div class="au-card-head">
                        <h2 class="k-card__title">Paso por paso</h2>
                        <button type="button" class="k-btn" data-do="ver-cifras">Ver las cifras sobre el recorrido</button>
                      </div>
                      <div class="k-data__wrap">
                        <table class="k-data au-tabla">
                          <caption class="k-sr">Cifras de cada paso</caption>
                          <thead>
                            <tr><th scope="col">Paso</th><th scope="col" class="k-num">Llegaron</th><th scope="col" class="k-num">Siguieron</th><th scope="col" class="k-num">Se fueron aquí</th><th scope="col" class="k-num">Tardan en contestar</th></tr>
                          </thead>
                          <tbody>
                            ${orden
                              .filter(id => r.nodes[id])
                              .map(id => {
                                const n = r.nodes[id];
                                return html`<tr data-key="${id}">
                                  <th scope="row">${orden.indexOf(id) + 1}. ${nombre(id)}</th>
                                  <td class="k-num">${numero(n.entered)}</td>
                                  <td class="k-num">${numero(n.completed)}</td>
                                  <td class="k-num">${numero(n.lost)}</td>
                                  <td class="k-num">${n.responses ? `${segundos(n.medianResponseMs)} (mediana)` : '—'}</td>
                                </tr>`;
                              })}
                          </tbody>
                        </table>
                      </div>
                    </section>
                    <section class="k-card">
                      <h2 class="k-card__title">Cómo terminaron</h2>
                      <ul class="au-finales">
                        ${r.endings
                          .filter(e => e.n)
                          .map(
                            e =>
                              html`<li data-key="${e.key}"><span>${e.label}</span><strong>${numero(e.n)}</strong></li>`,
                          )}
                      </ul>
                    </section>`
            }
            <section class="k-card au-sug" data-key="sugerencias">${pintarSugerencias()}</section>
          </div>`,
        );
        return undefined;
      }

      function pintarSugerencias() {
        const s = sugerencias;
        return html`<div class="au-card-head">
            <h2 class="k-card__title">Sugerencias</h2>
            ${when(
              manage(),
              () =>
                html`<button type="button" class="k-btn" data-do="sugerencias" ${attrs({ 'aria-disabled': pidiendo ? 'true' : false })}>${pidiendo ? 'Revisando…' : 'Pedir sugerencias'}</button>`,
            )}
          </div>
          <p class="k-hint">
            Se revisa la estructura del recorrido y sus cifras por paso. Nunca se manda a la IA el nombre, el teléfono ni lo que
            escribió una persona. Las sugerencias no cambian nada: tú decides.
          </p>
          ${when(!manage(), () => html`<p class="k-muted">Pedir sugerencias es de quien puede editar el recorrido.</p>`)}
          ${when(s?.error, () => html`<p class="k-notice k-notice--bad" role="alert">${s.error}</p>`)}
          ${when(
            s && !s.error,
            () => html`${when(
              !s.ai.available,
              () =>
                html`<p class="k-notice k-notice--warn" role="status">Sugerencias con IA no disponibles: ${s.ai.reason}</p>`,
            )}
              ${
                s.suggestions.length
                  ? html`<ul class="au-sugerencias">
                      ${s.suggestions.map(
                        (x, i) => html`<li data-key="${'s' + i}">
                          <span class="k-chip">${x.kindLabel}</span>
                          <span class="au-sugerencia__texto">${x.text}</span>
                          <span class="k-muted">${x.source === 'ai' ? 'Con IA' : 'Revisión automática'}</span>
                          ${when(
                            x.nodeId,
                            () =>
                              html`<button type="button" class="k-btn k-btn--ghost" data-do="ver-paso" data-node="${x.nodeId}">Ver el paso</button>`,
                          )}
                        </li>`,
                      )}
                    </ul>`
                  : html`<p class="k-muted">No hay sugerencias para este recorrido.</p>`
              }`,
          )}`;
      }

      async function pedirSugerencias() {
        if (pidiendo) return;
        pidiendo = true;
        pintarRendimiento();
        try {
          sugerencias = await api.post(`/api/chatflows/${flowId}/suggestions`, { days: prefs.days });
        } catch (error) {
          if (isAbort(error)) return;
          sugerencias = { error: error.message };
        } finally {
          pidiendo = false;
        }
        if (vivo && pestana() === 'rendimiento') pintarRendimiento();
      }

      limpiar = () => {
        for (const off of offs) off();
        canvas?.destroy();
        canvas = null;
      };
      alCambiar = evento => {
        if (evento.data?.flowId !== flowId || !canvas) return;
        recargarRecord().catch(() => {});
        if (evento.data?.kind === 'published' || evento.data?.kind === 'status') cargarRendimiento();
      };
    }

    live = { cambio: evento => alCambiar(evento) };
    ctx.onUnmount(() => {
      vivo = false;
      limpiar();
      if (live && live.root === root) live = null;
    });
    live.root = root;
    ir(keep.get('vista') ?? 'lista', keep.get('flowId') ?? null);
  },

  onEvent(evento) {
    if (evento?.type === 'chatflows.changed') live?.cambio(evento);
  },
};
