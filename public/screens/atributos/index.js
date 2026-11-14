/**
 * «Datos de contacto»: administración de los atributos de contacto de cada marca (docs/PLAN_ATRIBUTOS_CONTACTO.md).
 *
 * Lista las definiciones de la marca elegida (etiqueta, clave, tipo, cuántos contactos lo tienen, estado), crea y
 * edita en una ventana con validación, y archiva o restaura. Los datos de sistema se muestran aparte, de sólo
 * lectura. Toda la validación real la hace el servidor (/api/attributes); aquí sólo se adelantan los mensajes.
 */
import { html, render, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { isAbort } from '../../kit/api.js';
import { pagedTable } from '../../kit/components/table.js';
import { field, form } from '../../kit/components/form.js';
import { confirm, dialog } from '../../kit/components/dialog.js';
import { failure, loading } from '../../kit/components/feedback.js';

const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const TONO = { active: 'k-chip--ok', archived: '' };
const ESTADO = { active: 'Activo', archived: 'Archivado' };

/** Lo vivo de este montaje, para que onEvent() llegue a la tabla. Lo que sobrevive a un remontaje va en ctx.keep. */
let enVivo = null;

/** Sugerencia de clave a partir de la etiqueta: «Curso de interés» → «curso_de_interes». */
const claveDe = texto =>
  String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);

/** Campos de la ventana. Al editar, la clave y el tipo no cambian (el servidor tampoco lo permite). */
function campos(tipos, { nuevo, tipo }) {
  const lista = [
    {
      name: 'label',
      label: 'Nombre',
      required: true,
      maxlength: 60,
      autocomplete: 'off',
      hint: 'Así lo verá tu equipo.',
    },
  ];
  if (nuevo)
    lista.push(
      {
        name: 'key',
        label: 'Clave',
        maxlength: 40,
        autocomplete: 'off',
        hint: 'Minúsculas, números y guion bajo. Se usa en los mensajes como {{contacto.clave}} y no cambia después. Si la dejas vacía se toma del nombre.',
        validate: valor =>
          valor && !KEY.test(valor) ? 'Usa minúsculas, números y guion bajo; empieza con una letra.' : null,
      },
      { name: 'type', label: 'Tipo', type: 'select', required: true, options: tipos, emptyLabel: 'Elige un tipo' },
    );
  if (nuevo || tipo === 'select')
    lista.push({
      name: 'options',
      label: 'Opciones',
      type: 'textarea',
      rows: 4,
      maxlength: 3100,
      hint: 'Sólo para listas: una opción por renglón.',
      validate: (valor, valores) =>
        (valores.type ?? tipo) === 'select' && !String(valor ?? '').trim()
          ? 'Una lista necesita al menos una opción.'
          : null,
    });
  lista.push(
    { name: 'description', label: 'Descripción', type: 'textarea', rows: 2, maxlength: 200 },
    { name: 'personal', label: 'Es un dato personal (no viaja en avisos ni entra en la búsqueda)', type: 'checkbox' },
    { name: 'showInChat', label: 'Mostrarlo en el chat', type: 'checkbox' },
  );
  return lista;
}

const renglones = texto =>
  String(texto ?? '')
    .split('\n')
    .map(linea => linea.trim())
    .filter(Boolean);

/** Ventana para crear o editar una definición. Devuelve la definición guardada o null. */
function ventana({ api, ctx, tipos, marca, definicion }) {
  const nuevo = !definicion;
  return dialog({
    title: nuevo ? 'Nuevo dato de contacto' : `Editar «${definicion.label}»`,
    mount(cuerpo, cerrar) {
      const ficha = form(cuerpo, {
        id: ctx.uid(nuevo ? 'alta' : `edicion-${definicion.id}`),
        label: nuevo ? 'Nuevo dato de contacto' : `Editar ${definicion.label}`,
        fields: campos(tipos, { nuevo, tipo: definicion?.type }),
        initial: nuevo
          ? { showInChat: true }
          : { ...definicion, options: definicion.options.map(opcion => opcion.label).join('\n') },
        revision: definicion?.revision ?? null,
        submitLabel: nuevo ? 'Crear dato' : 'Guardar cambios',
        sendingLabel: 'Guardando…',
        cancelLabel: 'Cancelar',
        onCancel: () => cerrar(null),
        submit(valores, { clientRef, expectedRevision }) {
          const comunes = {
            label: valores.label,
            description: valores.description,
            personal: valores.personal === true,
            showInChat: valores.showInChat === true,
          };
          const tipo = nuevo ? valores.type : definicion.type;
          const opciones = tipo === 'select' ? { options: renglones(valores.options) } : {};
          if (nuevo)
            return api.post('/api/attributes', {
              brandId: marca,
              key: valores.key || claveDe(valores.label),
              type: valores.type,
              ...comunes,
              ...opciones,
              clientRef,
            });
          return api.patch(`/api/attributes/${definicion.id}`, { ...comunes, ...opciones, expectedRevision });
        },
        async reload() {
          const { definition } = await api.get(`/api/attributes/${definicion.id}`);
          return {
            values: { ...definition, options: definition.options.map(opcion => opcion.label).join('\n') },
            revision: definition.revision,
          };
        },
        onDone: ({ definition }) => cerrar(definition),
        keep: ctx.keep,
        draftKey: nuevo ? `alta:${marca}` : `edicion:${definicion.id}`,
      });
      return ficha.destroy;
    },
  });
}

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let datos = null; // {brands, system, types, limits}
    let marca = ctx.keep.get('marca') ?? null;
    let tabla = null;
    let vivo = true;

    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">Contactos</span>
            <h1>Datos de contacto</h1>
            <p class="k-lead">
              Los campos propios de cada marca sobre sus contactos: ciudad, curso de interés, estado de seguimiento… Se
              usan en los mensajes como {{contacto.clave}} y en los filtros.
            </p>
          </div>
          <div class="k-actions">
            <button type="button" class="k-btn k-btn--primary" data-do="nuevo">Nuevo dato</button>
          </div>
        </header>
        <div class="k-stack" data-slot="cuerpo"></div>
      </section>`,
    );
    const cuerpo = root.querySelector('[data-slot="cuerpo"]');
    const actual = () => datos?.brands.find(item => item.brandId === marca) ?? null;

    function pintar() {
      const elegida = actual();
      render(
        cuerpo,
        html`${when(
          datos.brands.length > 1,
          () =>
            html`<form class="k-card atr-marca" novalidate data-do="marca">
                ${field(
                  {
                    name: 'marca',
                    label: 'Marca',
                    type: 'select',
                    options: datos.brands.map(item => ({ value: item.brandId, label: item.brandName })),
                  },
                  { id: ctx.uid('marca'), value: marca },
                )}
              </form>`,
        )}
          <div class="k-card" data-slot="tabla"></div>
          <div class="k-card">
            <h2 class="atr-titulo">Datos del sistema</h2>
            <p class="k-hint">Se leen de la ficha, del consentimiento, de las etiquetas y del interés comercial. Son de sólo lectura.</p>
            <ul class="atr-sistema">
              ${datos.system.map(item => html`<li class="k-chip">${item.label} · {{contacto.${item.key}}}</li>`)}
            </ul>
          </div>
          <p class="k-hint" role="status">
            ${elegida ? `${elegida.active} de ${datos.limits.definitions} datos activos en ${elegida.brandName}.` : ''}
          </p>`,
      );
      if (!tabla) {
        tabla = pagedTable(cuerpo.querySelector('[data-slot="tabla"]'), {
          label: 'Datos de contacto',
          rowKey: fila => fila.id,
          rowLabel: fila => fila.label,
          cards: true,
          chooser: false,
          columns: [
            { id: 'label', label: 'Nombre', fixed: true, cell: fila => fila.label },
            { id: 'key', label: 'Clave', cell: fila => fila.key },
            { id: 'type', label: 'Tipo', cell: fila => fila.typeLabel },
            { id: 'usage', label: 'Contactos', numeric: true, cell: fila => fila.usage.contacts },
            {
              id: 'status',
              label: 'Estado',
              cell: fila =>
                html`<span class="${['k-chip', TONO[fila.status]]}">${ESTADO[fila.status] ?? fila.status}</span>`,
            },
            {
              id: 'actions',
              label: 'Acciones',
              cell: fila =>
                actual()?.canManage
                  ? html`<span class="atr-acciones">
                      <button type="button" class="k-btn" data-do="editar" data-id="${fila.id}">Editar</button>
                      ${
                        fila.status === 'active'
                          ? html`<button type="button" class="k-btn" data-do="archivar" data-id="${fila.id}">Archivar</button>`
                          : html`<button type="button" class="k-btn" data-do="restaurar" data-id="${fila.id}">Restaurar</button>`
                      }
                    </span>`
                  : '—',
            },
          ],
          // Una marca tiene como mucho sesenta datos activos: llegan en una sola página.
          async load({ signal }) {
            const respuesta = await api.get('/api/attributes', { brand: marca, archived: '1' }, { signal });
            const brand = respuesta.brands[0];
            const i = datos.brands.findIndex(item => item.brandId === brand.brandId);
            if (i >= 0) datos.brands[i] = brand;
            // El conteo de datos activos de abajo cambia con cada alta o archivo.
            if (tabla && vivo) pintar();
            return { rows: brand.definitions, next: null };
          },
          empty: {
            title: 'Esta marca todavía no tiene datos propios',
            text: 'Crea el primero con «Nuevo dato»: por ejemplo «Ciudad» o «Estado de seguimiento».',
          },
        });
      }
    }

    async function cargar() {
      render(cuerpo, loading('Cargando los datos de contacto…'));
      tabla?.destroy();
      tabla = null;
      try {
        datos = await api.get('/api/attributes', { archived: '1' });
      } catch (error) {
        if (vivo && !isAbort(error)) render(cuerpo, failure({ error, retry: 'reintentar' }));
        return;
      }
      if (!vivo) return;
      if (!datos.brands.some(item => item.brandId === marca))
        marca = datos.brands.some(item => item.brandId === ctx.brand) ? ctx.brand : (datos.brands[0]?.brandId ?? null);
      pintar();
    }

    const buscar = id => actual()?.definitions.find(item => item.id === id) ?? null;
    const recargar = () => {
      tabla?.reload();
    };

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            async nuevo() {
              if (!marca || !datos) return;
              const creado = await ventana({ api, ctx, tipos: datos.types, marca });
              if (!creado) return;
              ctx.toast(`Se creó «${creado.label}».`);
              recargar();
            },
            async editar(_evento, boton) {
              const definicion = buscar(boton.getAttribute('data-id'));
              if (!definicion) return;
              const guardado = await ventana({ api, ctx, tipos: datos.types, marca, definicion });
              if (!guardado) return;
              ctx.toast(`Se guardó «${guardado.label}».`);
              recargar();
            },
            async archivar(_evento, boton) {
              const definicion = buscar(boton.getAttribute('data-id'));
              if (!definicion) return;
              const seguro = await confirm({
                title: `¿Archivar «${definicion.label}»?`,
                message:
                  'Deja de poderse escribir y de ofrecerse en filtros y mensajes. Los valores guardados se conservan y puedes restaurarlo.',
                confirmLabel: 'Archivar',
                danger: true,
              });
              if (!seguro) return;
              await api.post(`/api/attributes/${definicion.id}/archive`, { expectedRevision: definicion.revision });
              ctx.toast(`Se archivó «${definicion.label}».`);
              recargar();
            },
            async restaurar(_evento, boton) {
              const definicion = buscar(boton.getAttribute('data-id'));
              if (!definicion) return;
              await api.post(`/api/attributes/${definicion.id}/restore`, { expectedRevision: definicion.revision });
              ctx.toast(`Se restauró «${definicion.label}».`);
              recargar();
            },
          },
          change: {
            marca(_evento, formulario) {
              marca = formValues(formulario).marca;
              ctx.keep.set('marca', marca);
              pintar();
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

  /** Otra persona cambió una definición de la marca que se está viendo: se vuelve a pedir la lista. */
  onEvent(evento) {
    if (
      evento?.type === 'attributes.changed' &&
      evento.data?.kind === 'definitions' &&
      evento.brandId === enVivo?.marca()
    )
      enVivo.recargar();
  },
};
