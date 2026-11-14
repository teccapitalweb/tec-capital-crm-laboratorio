/**
 * «Audiencias»: a quién se le envía una difusión (docs/PLAN_AUDIENCIAS.md).
 *
 * Lista las listas (conjuntos fijos de contactos) y los segmentos (filtros vivos) de la marca con su conteo. Crea
 * segmentos con el constructor de condiciones del kit y enseña en vivo cuántos entran y cuántos quedan fuera y por
 * qué; crea listas (también de exclusión); abre una audiencia para ver a sus miembros por páginas con su motivo, y
 * archiva o restaura. Todo lo decide el servidor (/api/audiences); aquí sólo se pinta.
 */
import { html, render, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { isAbort, newClientRef } from '../../kit/api.js';
import { pagedTable } from '../../kit/components/table.js';
import { field } from '../../kit/components/form.js';
import { confirm, dialog } from '../../kit/components/dialog.js';
import { failure, loading } from '../../kit/components/feedback.js';
import { conditionProblems, conditionsBuilder, describeConditions } from '../../kit/components/conditions.js';

const ESPERA_MS = 400;

/** Lo vivo de este montaje, para que onEvent() llegue a la tabla. */
let enVivo = null;

const numero = n => new Intl.NumberFormat('es-MX').format(n ?? 0);
const tipoDe = a => (a.kind === 'list' ? (a.role === 'suppression' ? 'Lista de exclusión' : 'Lista') : 'Segmento');

/** Resumen de una vista previa: cuántos entran y cuántos quedan fuera por cada motivo. */
function resumen(datos) {
  if (!datos) return html``;
  return html`<div class="aud-resumen" role="status">
    <p class="aud-cifra"><strong>${numero(datos.eligible)}</strong> de ${numero(datos.total)} pueden recibir una promoción</p>
    ${when(
      datos.excluded.length,
      () => html`<ul class="aud-motivos">
        ${datos.excluded.map(e => html`<li class="k-chip" data-key="${e.reason}">${e.label}: ${numero(e.count)}</li>`)}
      </ul>`,
      () => html`<p class="k-hint">Nadie queda fuera.</p>`,
    )}
  </div>`;
}

/** Ventana para crear un segmento: nombre, constructor de condiciones y conteo en vivo. */
function ventanaSegmento({ api, ctx, marca, campos }) {
  return dialog({
    title: 'Nuevo segmento',
    wide: true,
    mount(cuerpo, cerrar) {
      const clientRef = newClientRef();
      let definicion = { version: 1, match: 'any', groups: [] };
      let completo = true;
      let vista = null;
      let error = '';
      let temporizador = null;
      let control = null;
      render(
        cuerpo,
        html`<form class="k-stack" novalidate data-do="segmento">
          ${field({ name: 'name', label: 'Nombre', required: true, maxlength: 80, autocomplete: 'off' }, { id: ctx.uid('seg-nombre') })}
          <div data-slot="condiciones"></div>
          <div class="k-card aud-vista" data-slot="vista"></div>
          <p class="k-error" data-slot="error"></p>
          <div class="k-actions">
            <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
            <button type="submit" class="k-btn k-btn--primary">Crear segmento</button>
          </div>
        </form>`,
      );
      const ranura = nombre => cuerpo.querySelector(`[data-slot="${nombre}"]`);
      const pintarVista = () => {
        render(
          ranura('vista'),
          vista
            ? html`<p class="k-hint">${describeConditions(definicion, campos) || 'Sin condiciones: entran todos los contactos de la marca.'}</p>
                ${resumen(vista)}`
            : html`<p class="k-hint">${completo ? 'Calculando…' : 'Completa la condición para ver cuántos entran.'}</p>`,
        );
        render(ranura('error'), html`${error}`);
      };
      let pedido = null;
      async function contar() {
        pedido?.abort();
        pedido = new AbortController();
        try {
          vista = await api.post(
            '/api/audiences/preview',
            { brandId: marca, definition: definicion },
            { signal: pedido.signal },
          );
          error = '';
        } catch (e) {
          if (isAbort(e)) return;
          vista = null;
          error = e.message;
        }
        pintarVista();
      }
      const programar = () => {
        clearTimeout(temporizador);
        if (completo) temporizador = setTimeout(contar, ESPERA_MS);
        else {
          vista = null;
          pintarVista();
        }
      };
      control = conditionsBuilder(ranura('condiciones'), {
        fields: campos,
        value: definicion,
        label: 'Condiciones del segmento',
        onChange(nueva, estado) {
          definicion = nueva;
          completo = estado.complete;
          programar();
        },
      });
      completo = conditionProblems(definicion, campos).length === 0;
      pintarVista();
      contar();
      const quitar = listen(cuerpo, {
        click: { cancelar: () => cerrar(null) },
        submit: {
          async segmento(_evento, formulario) {
            const nombre = String(formValues(formulario).name ?? '').trim();
            if (!nombre) {
              error = 'Escribe el nombre del segmento.';
              return pintarVista();
            }
            if (!completo) {
              error = 'Completa o quita la condición a medias.';
              return pintarVista();
            }
            try {
              const { audience } = await api.post('/api/audiences', {
                brandId: marca,
                kind: 'segment',
                name: nombre,
                definition: definicion,
                clientRef,
              });
              cerrar(audience);
            } catch (e) {
              error = e.message;
              pintarVista();
            }
          },
        },
      });
      return () => {
        clearTimeout(temporizador);
        pedido?.abort();
        control?.destroy();
        quitar();
      };
    },
  });
}

/** Ventana para crear una lista (vacía; se llena importando o desde Contactos). */
function ventanaLista({ api, ctx, marca }) {
  return dialog({
    title: 'Nueva lista',
    mount(cuerpo, cerrar) {
      const clientRef = newClientRef();
      let error = '';
      const pintar = () =>
        render(
          cuerpo,
          html`<form class="k-stack" novalidate data-do="lista">
            ${field({ name: 'name', label: 'Nombre', required: true, maxlength: 80, autocomplete: 'off' }, { id: ctx.uid('lista-nombre') })}
            ${field(
              {
                name: 'suppression',
                label: 'Es una lista de exclusión (sus contactos nunca reciben difusiones de la marca)',
                type: 'checkbox',
              },
              { id: ctx.uid('lista-exclusion') },
            )}
            <p class="k-hint">Para llenarla, importa un archivo en «Importar contactos» y elige esta lista.</p>
            <p class="k-error">${error}</p>
            <div class="k-actions">
              <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
              <button type="submit" class="k-btn k-btn--primary">Crear lista</button>
            </div>
          </form>`,
        );
      pintar();
      return listen(cuerpo, {
        click: { cancelar: () => cerrar(null) },
        submit: {
          async lista(_evento, formulario) {
            const valores = formValues(formulario);
            try {
              const { audience } = await api.post('/api/audiences', {
                brandId: marca,
                kind: 'list',
                role: valores.suppression === true ? 'suppression' : 'audience',
                name: String(valores.name ?? '').trim(),
                clientRef,
              });
              cerrar(audience);
            } catch (e) {
              error = e.message;
              pintar();
            }
          },
        },
      });
    },
  });
}

/** Ventana con los miembros de una audiencia, por páginas, con su motivo de exclusión. */
function ventanaMiembros({ api, audiencia }) {
  return dialog({
    title: audiencia.name,
    wide: true,
    actions: [{ id: 'cerrar', label: 'Cerrar' }],
    mount(cuerpo) {
      render(
        cuerpo,
        html`<div class="k-stack">
          <p class="k-hint">${tipoDe(audiencia)}${audiencia.description ? ` · ${audiencia.description}` : ''}</p>
          <div data-slot="resumen">${loading('Contando…')}</div>
          <div data-slot="miembros"></div>
        </div>`,
      );
      const tabla = pagedTable(cuerpo.querySelector('[data-slot="miembros"]'), {
        label: `Contactos de ${audiencia.name}`,
        rowKey: fila => fila.contactId,
        rowLabel: fila => fila.name,
        cards: true,
        chooser: false,
        columns: [
          { id: 'name', label: 'Nombre', fixed: true, cell: fila => fila.name },
          { id: 'phone', label: 'Teléfono', cell: fila => fila.phone || '—' },
          {
            id: 'reason',
            label: 'Estado',
            cell: fila =>
              fila.reason
                ? html`<span class="k-chip">${fila.reasonLabel}</span>`
                : html`<span class="k-chip k-chip--ok">Puede recibir</span>`,
          },
        ],
        async load({ cursor, signal }) {
          const datos = await api.get(
            `/api/audiences/${audiencia.id}/members`,
            { limit: '50', ...(cursor ? { cursor } : {}) },
            { signal },
          );
          if (datos.summary) render(cuerpo.querySelector('[data-slot="resumen"]'), resumen(datos.summary));
          return { rows: datos.members, next: datos.next };
        },
        empty: { title: 'Sin contactos', text: 'Esta audiencia todavía no tiene a nadie.' },
      });
      return tabla.destroy;
    },
  });
}

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let datos = null; // {brands, brandId, canEdit, audiences, reasons, limits, active}
    let marca = ctx.keep.get('marca') ?? null;
    let tabla = null;
    let campos = null;
    let vivo = true;

    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">Difusiones</span>
            <h1>Audiencias</h1>
            <p class="k-lead">
              A quién se le envía una difusión. Una lista es un grupo fijo de contactos; un segmento se recalcula solo con
              sus condiciones. Quien pidió la baja, no tiene teléfono o está en una lista de exclusión nunca recibe.
            </p>
          </div>
          <div class="k-actions" data-slot="acciones"></div>
        </header>
        <div class="k-stack" data-slot="cuerpo"></div>
      </section>`,
    );
    const cuerpo = root.querySelector('[data-slot="cuerpo"]');
    const acciones = root.querySelector('[data-slot="acciones"]');

    function pintar() {
      render(
        acciones,
        when(
          datos?.canEdit,
          () => html`<button type="button" class="k-btn" data-do="nueva-lista">Nueva lista</button>
            <button type="button" class="k-btn k-btn--primary" data-do="nuevo-segmento">Nuevo segmento</button>`,
          () => html``,
        ),
      );
      render(
        cuerpo,
        html`${when(
          datos.brands.length > 1,
          () => html`<form class="k-card aud-marca" novalidate data-do="marca">
              ${field(
                {
                  name: 'marca',
                  label: 'Marca',
                  type: 'select',
                  options: datos.brands.map(b => ({ value: b.id, label: b.name })),
                },
                { id: ctx.uid('marca'), value: marca },
              )}
            </form>`,
        )}
          <div class="k-card" data-slot="tabla"></div>
          <p class="k-hint" role="status">
            ${`${datos.active.lists} de ${datos.limits.lists} listas y ${datos.active.segments} de ${datos.limits.segments} segmentos propios.`}
          </p>`,
      );
      if (tabla) return;
      tabla = pagedTable(cuerpo.querySelector('[data-slot="tabla"]'), {
        label: 'Audiencias',
        rowKey: fila => fila.id,
        rowLabel: fila => fila.name,
        cards: true,
        chooser: false,
        columns: [
          {
            id: 'name',
            label: 'Nombre',
            fixed: true,
            cell: fila => html`<span class="aud-nombre">${fila.name}</span>
              ${when(fila.preset, () => html`<span class="k-chip">Prediseñado</span>`)}
              ${when(fila.archived, () => html`<span class="k-chip">Archivado</span>`)}`,
          },
          { id: 'kind', label: 'Tipo', cell: fila => tipoDe(fila) },
          { id: 'count', label: 'Contactos', numeric: true, cell: fila => numero(fila.memberCount) },
          {
            id: 'actions',
            label: 'Acciones',
            cell: fila => html`<span class="aud-acciones">
              <button type="button" class="k-btn" data-do="ver" data-id="${fila.id}">Ver</button>
              ${when(datos.canEdit, () =>
                fila.archived
                  ? html`<button type="button" class="k-btn" data-do="restaurar" data-id="${fila.id}">Restaurar</button>`
                  : html`<button type="button" class="k-btn" data-do="archivar" data-id="${fila.id}">Archivar</button>`,
              )}
            </span>`,
          },
        ],
        // Una marca tiene como mucho 200 listas y 50 segmentos propios: llegan en una sola página.
        async load({ signal }) {
          datos = await api.get('/api/audiences', { brand: marca, archived: '1' }, { signal });
          if (tabla && vivo) pintar();
          return { rows: datos.audiences, next: null };
        },
        empty: { title: 'Sin audiencias', text: 'Crea una lista o un segmento para empezar.' },
      });
    }

    async function cargar() {
      render(cuerpo, loading('Cargando las audiencias…'));
      tabla?.destroy();
      tabla = null;
      campos = null;
      try {
        datos = await api.get('/api/audiences', marca ? { brand: marca, archived: '1' } : { archived: '1' });
        // La primera vez se abre en la marca elegida en la aplicación, si es una de las que puede ver.
        if (!marca && datos.brands.some(b => b.id === ctx.brand) && datos.brandId !== ctx.brand)
          datos = await api.get('/api/audiences', { brand: ctx.brand, archived: '1' });
      } catch (error) {
        if (vivo && !isAbort(error)) render(cuerpo, failure({ error, retry: 'reintentar' }));
        return;
      }
      if (!vivo) return;
      marca = datos.brandId;
      ctx.keep.set('marca', marca);
      pintar();
    }

    const buscar = id => datos?.audiences.find(a => a.id === id) ?? null;
    const recargar = () => tabla?.reload();
    async function camposDeMarca() {
      campos ??= (await api.get('/api/audiences/fields', { brand: marca })).fields;
      return campos;
    }

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            async 'nuevo-segmento'() {
              if (!marca) return;
              const creado = await ventanaSegmento({ api, ctx, marca, campos: await camposDeMarca() });
              if (!creado) return;
              ctx.toast(`Se creó «${creado.name}» con ${numero(creado.memberCount)} contactos.`);
              recargar();
            },
            async 'nueva-lista'() {
              if (!marca) return;
              const creada = await ventanaLista({ api, ctx, marca });
              if (!creada) return;
              ctx.toast(`Se creó la lista «${creada.name}».`);
              recargar();
            },
            async ver(_evento, boton) {
              const audiencia = buscar(boton.getAttribute('data-id'));
              if (audiencia) await ventanaMiembros({ api, audiencia });
            },
            async archivar(_evento, boton) {
              const audiencia = buscar(boton.getAttribute('data-id'));
              if (!audiencia) return;
              const seguro = await confirm({
                title: `¿Archivar «${audiencia.name}»?`,
                message: 'Deja de ofrecerse para nuevas difusiones. Sus contactos se conservan y puedes restaurarla.',
                confirmLabel: 'Archivar',
                danger: true,
              });
              if (!seguro) return;
              await api.post(`/api/audiences/${audiencia.id}/archive`, { expectedRevision: audiencia.revision });
              ctx.toast(`Se archivó «${audiencia.name}».`);
              recargar();
            },
            async restaurar(_evento, boton) {
              const audiencia = buscar(boton.getAttribute('data-id'));
              if (!audiencia) return;
              await api.post(`/api/audiences/${audiencia.id}/restore`, { expectedRevision: audiencia.revision });
              ctx.toast(`Se restauró «${audiencia.name}».`);
              recargar();
            },
          },
          change: {
            marca(_evento, formulario) {
              marca = formValues(formulario).marca;
              ctx.keep.set('marca', marca);
              campos = null;
              recargar();
            },
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );

    enVivo = { marca: () => marca, recargar };
    ctx.onUnmount(() => {
      vivo = false;
      enVivo = null;
      tabla?.destroy();
    });
    cargar();
  },

  /** Otra persona cambió una audiencia de la marca que se está viendo: se vuelve a pedir la lista. */
  onEvent(evento) {
    if (evento?.type === 'audiences.changed' && evento.brandId === enVivo?.marca()) enVivo.recargar();
  },
};
