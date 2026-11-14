/**
 * «Importar contactos»: cargar un CSV (por ejemplo, la exportación del proveedor anterior) en una marca
 * (docs/PLAN_IMPORTAR_CONTACTOS.md).
 *
 * Asistente de cuatro pasos: archivo → columnas y permiso → vista previa → importar. La vista previa y la importación
 * corren en el servidor por trozos (/api/contact-import); aquí se sigue su avance en vivo (aviso `job.progress` y,
 * por si el aviso no llega, una consulta cada pocos segundos) y se enseña el resultado por fila. Toda la validación
 * real la hace el servidor.
 */
import { html, render, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { isAbort, newClientRef } from '../../kit/api.js';
import { pagedTable } from '../../kit/components/table.js';
import { field } from '../../kit/components/form.js';
import { failure, loading } from '../../kit/components/feedback.js';
import { wizard } from '../../kit/components/wizard.js';
import { meter, tile } from '../../kit/charts.js';

const PASOS = [
  { id: 'archivo', title: 'Archivo', hint: 'Un CSV con encabezados en la primera fila.' },
  { id: 'columnas', title: 'Columnas y permiso', hint: 'Elige a dónde va cada columna.' },
  { id: 'vista', title: 'Vista previa', hint: 'Lo que pasaría con cada fila. Todavía no se escribe nada.' },
  { id: 'importar', title: 'Importar' },
];
const ACCION = {
  created: ['Nuevo', 'k-chip--ok'],
  updated: ['Actualizado', 'k-chip--accent'],
  unchanged: ['Sin cambios', ''],
  skipped: ['Omitido', 'k-chip--warn'],
  error: ['Con error', 'k-chip--bad'],
};
const ESTADO = {
  uploaded: 'Sin revisar',
  validating: 'Revisando',
  validated: 'Revisado',
  applying: 'Importando',
  done: 'Terminado',
  failed: 'Falló',
  cancelled: 'Cancelado',
};
const EN_CURSO = new Set(['validating', 'applying']);
const RESULTADO = new Set(['applying', 'done', 'failed', 'cancelled']);
const FILTROS = [
  { value: 'errors', label: 'Con error' },
  { value: 'skipped', label: 'Omitidas' },
  { value: 'all', label: 'Todas' },
];
const numero = n => Number(n ?? 0).toLocaleString('es-MX');
const fecha = ms => (ms ? new Date(ms).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' }) : '');

/** Lo vivo de este montaje, para que onEvent() llegue a la pantalla. */
let enVivo = null;

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let vivo = true;
    let marcas = [];
    let marca = ctx.keep.get('marca') ?? null;
    let importacion = null; // el detalle que devuelve el servidor
    let recientes = [];
    let limites = null;
    let archivo = null; // {file, clientRef}
    let destinos = [];
    let opciones = null;
    let confirmado = false;
    let asistente = null;
    let tabla = null;
    let filtro = 'errors';
    let espera = null;

    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">Contactos</span>
            <h1>Importar contactos</h1>
            <p class="k-lead">
              Carga una lista de contactos desde un CSV. Se reconoce a cada persona por su teléfono (o su correo), así que
              repetir un archivo no duplica a nadie.
            </p>
          </div>
        </header>
        <div class="k-stack" data-slot="cuerpo"></div>
      </section>`,
    );
    const cuerpo = root.querySelector('[data-slot="cuerpo"]');

    const guardar = () => {
      ctx.keep.set('marca', marca);
      ctx.keep.set('importacion', importacion?.id ?? null);
    };
    const aplicarImportacion = datos => {
      importacion = datos;
      destinos = [...(datos.mapping?.targets ?? datos.suggested?.targets ?? [])];
      opciones = structuredClone(datos.options);
      guardar();
    };

    // ---- seguir el avance

    function seguir() {
      clearTimeout(espera);
      if (!vivo || !importacion || !EN_CURSO.has(importacion.state)) return;
      espera = setTimeout(refrescar, 2000);
    }
    async function refrescar() {
      if (!vivo || !importacion) return;
      try {
        const { import: datos } = await api.get(`/api/contact-import/${importacion.id}`);
        if (!vivo) return;
        const antes = importacion.state;
        importacion = { ...datos, mapping: importacion.mapping };
        if (antes !== datos.state) aplicarImportacion(datos);
        pintar();
      } catch (error) {
        if (!isAbort(error)) ctx.toast(error.message);
      }
      seguir();
    }

    // ---- pasos

    function pasoArchivo(caja) {
      const elegida = marcas.find(item => item.id === marca);
      render(
        caja,
        html`<div class="k-stack">
          ${when(
            marcas.length > 1,
            () =>
              html`<form class="imp-campo" novalidate data-do="marca">
                ${field(
                  {
                    name: 'marca',
                    label: 'Marca',
                    type: 'select',
                    options: marcas.map(m => ({ value: m.id, label: m.name })),
                  },
                  { id: ctx.uid('marca'), value: marca },
                )}
              </form>`,
          )}
          <form class="imp-campo" novalidate data-do="archivo">
            <div class="k-field">
              <label class="k-label" for="${ctx.uid('archivo')}">Archivo CSV</label>
              <input class="k-input" type="file" name="archivo" accept=".csv,text/csv,text/plain" id="${ctx.uid('archivo')}" />
              <p class="k-hint">
                ${
                  limites
                    ? `Hasta ${numero(limites.rows)} filas, ${numero(limites.columns)} columnas y ${Math.round(limites.bytes / 1048576)} MB. Separado por comas, punto y coma o tabulador.`
                    : ''
                }
              </p>
            </div>
          </form>
          ${when(
            archivo || importacion,
            () =>
              html`<p class="k-notice" role="status">
                ${archivo ? `Listo para subir: ${archivo.file.name}.` : `Archivo cargado: ${importacion.filename} (${numero(importacion.rows)} filas).`}
              </p>`,
          )}
          ${when(
            recientes.length,
            () =>
              html`<div class="k-stack k-stack--tight">
                <h3 class="imp-sub">Importaciones recientes${elegida ? ` en ${elegida.name}` : ''}</h3>
                <ul class="imp-lista">
                  ${recientes.map(
                    item =>
                      html`<li class="imp-reciente" data-key="${item.id}">
                        <span class="imp-reciente__nombre">${item.filename}</span>
                        <span class="k-chip">${ESTADO[item.state] ?? item.state}</span>
                        <span class="k-muted">${fecha(item.createdAt)} · ${numero(item.rows)} filas</span>
                        <button type="button" class="k-btn" data-do="abrir" data-id="${item.id}">Abrir</button>
                      </li>`,
                  )}
                </ul>
              </div>`,
          )}
        </div>`,
      );
    }

    function pasoColumnas(caja) {
      if (!importacion) return render(caja, html`<p class="k-hint">Primero elige el archivo.</p>`);
      const ejemplo = importacion.sample?.[0] ?? [];
      const plantilla = importacion.templates?.find(item => item.detected);
      const declarada = opciones.consent?.mode === 'declared';
      render(
        caja,
        html`<form class="k-stack" novalidate data-do="columnas">
          ${when(
            importacion.previous,
            () =>
              html`<p class="k-notice k-notice--warn" role="status">
                Este mismo archivo ya se importó el ${fecha(importacion.previous.finished_at)}. Repetirlo no duplica
                contactos: lo que ya esté igual queda sin cambios.
              </p>`,
          )}
          <div class="k-row imp-plantilla">
            <p class="k-hint">
              ${plantilla ? `Parece la ${plantilla.label.toLowerCase()}: ${plantilla.hint}` : 'Revisa la sugerencia de cada columna.'}
            </p>
            <button type="button" class="k-btn" data-do="sugerencia">Usar la sugerencia</button>
          </div>
          <div class="k-grid imp-columnas">
            ${importacion.header.map((titulo, i) =>
              field(
                {
                  name: `col-${i}`,
                  label: titulo || `Columna ${i + 1}`,
                  type: 'select',
                  options: importacion.targets,
                  emptyLabel: 'Ignorar',
                  hint: ejemplo[i] ? `Ejemplo: ${String(ejemplo[i]).slice(0, 60)}` : 'Sin ejemplo en la primera fila.',
                },
                { id: ctx.uid(`col-${i}`), value: destinos[i] === 'ignore' ? '' : destinos[i] },
              ),
            )}
          </div>
          <fieldset class="k-fieldset imp-grupo">
            <legend class="k-label">Contactos que ya existen</legend>
            ${field(
              {
                name: 'onExisting',
                label: 'Si la persona ya está en la marca',
                type: 'radio',
                options: [
                  {
                    value: 'update',
                    label: 'Actualizarla con lo que traiga el archivo (una celda vacía no borra nada)',
                  },
                  { value: 'skip', label: 'Dejarla como está' },
                ],
              },
              { id: ctx.uid('existentes'), value: opciones.onExisting },
            )}
            ${field(
              { name: 'nameFromPhone', label: 'Si falta el nombre, usar el teléfono como nombre', type: 'checkbox' },
              { id: ctx.uid('sin-nombre'), value: opciones.nameFallback !== 'error' },
            )}
          </fieldset>
          <fieldset class="k-fieldset imp-grupo">
            <legend class="k-label">Permiso para enviar promociones</legend>
            <p class="k-hint">
              Una columna de consentimiento con FALSE registra la baja siempre. Con TRUE, la persona queda como «acepta» sólo
              si declaras de dónde viene su permiso; si no, queda sin registro y no recibe promociones. Una baja nunca se
              levanta.
            </p>
            ${field(
              {
                name: 'consentMode',
                label: 'Las filas con TRUE',
                type: 'radio',
                options: [
                  { value: 'none', label: 'Quedan sin registro (no reciben promociones)' },
                  { value: 'declared', label: 'Aceptan promociones: declaro el origen del permiso' },
                ],
              },
              { id: ctx.uid('permiso'), value: declarada ? 'declared' : 'none' },
            )}
            ${when(declarada, () =>
              field(
                {
                  name: 'origin',
                  label: 'Origen del permiso',
                  type: 'textarea',
                  rows: 2,
                  maxlength: limites?.originMax ?? 200,
                  hint: 'Por ejemplo: «Aceptaron promociones al inscribirse en el formulario del curso». Queda en el registro de cada persona.',
                },
                { id: ctx.uid('origen'), value: opciones.consent?.origin ?? '' },
              ),
            )}
          </fieldset>
          ${when(Array.isArray(importacion.lists), () => {
            const lista = opciones.list ?? null;
            return html`<fieldset class="k-fieldset imp-grupo">
              <legend class="k-label">Añadir a una lista</legend>
              <p class="k-hint">
                Los contactos del archivo (nuevos, actualizados o sin cambios) quedan en la lista para usarla en una
                difusión. Repetir la importación no los duplica.
              </p>
              ${field(
                {
                  name: 'listId',
                  label: 'Lista existente',
                  type: 'select',
                  options: importacion.lists.map(item => ({ value: item.id, label: item.name })),
                  emptyLabel: 'Ninguna',
                },
                { id: ctx.uid('lista'), value: lista?.audienceId ?? '' },
              )}
              ${field(
                {
                  name: 'listName',
                  label: 'O crear una lista nueva con el nombre',
                  maxlength: 80,
                  autocomplete: 'off',
                },
                { id: ctx.uid('lista-nueva'), value: lista && !lista.audienceId ? lista.name : '' },
              )}
            </fieldset>`;
          })}
        </form>`,
      );
    }

    function resumen(reporte) {
      const t = reporte?.totals ?? {};
      const c = reporte?.consent ?? {};
      return html`<div class="k-tiles">
          ${[
            tile({ label: 'Nuevos', value: t.created ?? 0 }),
            tile({ label: 'Actualizados', value: t.updated ?? 0 }),
            tile({ label: 'Sin cambios', value: t.unchanged ?? 0 }),
            tile({ label: 'Omitidos', value: t.skipped ?? 0, hint: 'Repetidos en el archivo o ya existentes' }),
            tile({ label: 'Con error', value: t.errors ?? 0 }),
          ].map(item => item.html)}
        </div>
        <p class="k-hint">
          Permiso: ${numero(c.optedIn)} aceptan promociones, ${numero(c.optedOut)} no desean mensajes,
          ${numero(c.keptOptOut)} conservan su baja y ${numero(c.notRecorded)} quedan sin registro.
        </p>
        ${when(
          reporte?.list,
          () =>
            html`<p class="k-hint">La lista «${reporte.list.name}» tiene ahora ${numero(reporte.list.memberCount)} contactos.</p>`,
        )}`;
    }

    function avance(texto) {
      const trabajo = importacion?.job;
      return html`<div class="k-card" role="status">
        ${meter({ label: texto, value: trabajo?.done ?? 0, limit: trabajo?.total || importacion?.rows || 1, width: 260 }).html}
      </div>`;
    }

    function filas(caja, fase) {
      const enlace = `/api/contact-import/${importacion.id}/errors.csv?phase=${fase}`;
      render(
        caja,
        html`<div class="k-stack">
          <div class="k-row imp-filtro">
            <form class="imp-campo" novalidate data-do="filtro">
              ${field(
                { name: 'filtro', label: 'Filas', type: 'select', options: FILTROS, emptyLabel: 'Elige qué filas ver' },
                { id: ctx.uid(`filtro-${fase}`), value: filtro },
              )}
            </form>
            <a class="k-btn" href="${enlace}" download="filas-con-problema.csv">Descargar filas con problema (CSV)</a>
          </div>
          <div data-slot="filas"></div>
        </div>`,
      );
      tabla?.destroy();
      tabla = pagedTable(caja.querySelector('[data-slot="filas"]'), {
        label: 'Resultado por fila',
        rowKey: fila => fila.row,
        rowLabel: fila => `Fila ${fila.line}`,
        cards: true,
        chooser: false,
        columns: [
          { id: 'line', label: 'Línea', fixed: true, numeric: true, cell: fila => fila.line },
          {
            id: 'action',
            label: 'Resultado',
            cell: fila => {
              const [texto, tono] = ACCION[fila.action] ?? [fila.action, ''];
              return html`<span class="${['k-chip', tono]}">${texto}</span>`;
            },
          },
          { id: 'column', label: 'Columna', cell: fila => fila.column ?? '—' },
          { id: 'message', label: 'Qué pasó', wrap: true, cell: fila => fila.message ?? '—' },
          { id: 'value', label: 'Valor', cell: fila => fila.value ?? '—' },
        ],
        async load({ cursor, signal }) {
          const datos = await api.get(
            `/api/contact-import/${importacion.id}/rows`,
            { phase: fase, filter: filtro, after: cursor },
            { signal },
          );
          return { rows: datos.rows, next: datos.next === null ? null : String(datos.next) };
        },
        empty: { title: 'No hay filas en esta lista', text: 'Prueba con otro filtro.' },
      });
    }

    function pasoVista(caja) {
      if (!importacion) return render(caja, html`<p class="k-hint">Primero elige el archivo.</p>`);
      if (importacion.state === 'validating') {
        tabla?.destroy();
        tabla = null;
        return render(caja, avance('Revisando filas'));
      }
      if (importacion.state !== 'validated')
        return render(caja, html`<p class="k-hint">Guarda las columnas para ver la vista previa.</p>`);
      render(
        caja,
        html`<div class="k-stack">
          ${resumen(importacion.report)}
          <div data-slot="detalle"></div>
        </div>`,
      );
      filas(caja.querySelector('[data-slot="detalle"]'), 'preview');
    }

    function pasoImportar(caja) {
      if (!importacion || importacion.state !== 'validated')
        return render(caja, html`<p class="k-hint">Primero revisa la vista previa.</p>`);
      const t = importacion.report?.totals ?? {};
      const declarada = importacion.options?.consent?.mode === 'declared';
      render(
        caja,
        html`<form class="k-stack" novalidate data-do="confirmar">
          <p>
            Se crearán ${numero(t.created)} contactos y se actualizarán ${numero(t.updated)} en
            ${marcas.find(m => m.id === importacion.brandId)?.name ?? 'la marca'}. ${numero(t.errors)} filas con error y
            ${numero(t.skipped)} omitidas no se importan.
          </p>
          ${when(
            declarada,
            () =>
              html`<div class="k-notice k-notice--warn">
                <p>Origen del permiso declarado: «${importacion.options.consent.origin}».</p>
                ${field(
                  {
                    name: 'confirmo',
                    label:
                      'Confirmo que estas personas aceptaron recibir mensajes de esta marca como se declara arriba.',
                    type: 'checkbox',
                  },
                  { id: ctx.uid('confirmo'), value: confirmado },
                )}
              </div>`,
          )}
        </form>`,
      );
    }

    const PINTORES = { archivo: pasoArchivo, columnas: pasoColumnas, vista: pasoVista, importar: pasoImportar };

    // ---- lo que hace «Siguiente» en cada paso

    async function subir() {
      const { import: datos } = await api('/api/contact-import/uploads', {
        method: 'POST',
        body: archivo.file,
        query: { brand: marca, name: archivo.file.name, clientRef: archivo.clientRef },
        headers: { 'Content-Type': 'text/csv' },
      });
      archivo = null;
      aplicarImportacion(datos);
    }

    function leerColumnas() {
      const formulario = cuerpo.querySelector('form[data-do="columnas"]');
      if (!formulario) return;
      const valores = formValues(formulario);
      destinos = importacion.header.map((_, i) => valores[`col-${i}`] || 'ignore');
      opciones = {
        onExisting: valores.onExisting === 'skip' ? 'skip' : 'update',
        nameFallback: valores.nameFromPhone === false ? 'error' : 'phone',
        consent:
          valores.consentMode === 'declared'
            ? { mode: 'declared', origin: valores.origin ?? opciones.consent?.origin ?? '' }
            : { mode: 'none' },
      };
      // La lista destino: una nueva por nombre o una existente. Sin la sección (sin permiso), se conserva la que haya.
      const nueva = String(valores.listName ?? '').trim();
      if (Array.isArray(importacion.lists))
        opciones.list = nueva ? { name: nueva } : valores.listId ? { audienceId: valores.listId } : null;
      else if (importacion.options.list) opciones.list = importacion.options.list;
    }

    const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const claveLista = lista => (lista ? (lista.audienceId ?? 'nueva:' + lista.name) : '');
    async function revisar() {
      leerColumnas();
      const sinCambios =
        igual(destinos, importacion.mapping?.targets) &&
        claveLista(opciones.list) === claveLista(importacion.options.list) &&
        igual(
          { onExisting: opciones.onExisting, nameFallback: opciones.nameFallback, consent: opciones.consent },
          {
            onExisting: importacion.options.onExisting,
            nameFallback: importacion.options.nameFallback,
            consent: importacion.options.consent,
          },
        );
      if (sinCambios && ['validated', 'validating'].includes(importacion.state)) return;
      let actual = importacion;
      if (!sinCambios || actual.state !== 'uploaded') {
        actual = (
          await api.put(`/api/contact-import/${importacion.id}/mapping`, {
            expectedRevision: importacion.revision,
            targets: destinos,
            options: opciones,
          })
        ).import;
        aplicarImportacion(actual);
      }
      const { import: datos } = await api.post(`/api/contact-import/${actual.id}/validate`, {
        expectedRevision: actual.revision,
        clientRef: newClientRef(),
      });
      aplicarImportacion(datos);
      seguir();
    }

    async function validar(paso) {
      if (paso.id === 'archivo') {
        if (!marca) return 'Elige una marca.';
        if (archivo) await subir();
        return importacion ? true : 'Elige el archivo CSV que vas a importar.';
      }
      if (paso.id === 'columnas') {
        await revisar();
        return true;
      }
      if (paso.id === 'importar' && importacion?.options?.consent?.mode === 'declared' && !confirmado)
        return 'Marca la casilla de confirmación del origen del permiso.';
      if (paso.id === 'vista')
        return importacion?.state === 'validated' ? true : 'Espera a que termine la vista previa.';
      return true;
    }

    async function importar() {
      const declarada = importacion.options?.consent?.mode === 'declared';
      const { import: datos } = await api.post(`/api/contact-import/${importacion.id}/apply`, {
        expectedRevision: importacion.revision,
        clientRef: newClientRef(),
        confirmConsent: declarada ? confirmado : undefined,
      });
      aplicarImportacion(datos);
      pintar();
      seguir();
    }

    // ---- resultado de la importación

    function resultado(caja) {
      const terminado = importacion.state !== 'applying';
      const titulo = {
        applying: 'Importando…',
        done: 'Importación terminada',
        cancelled: 'Importación cancelada (lo ya importado se queda)',
        failed: 'La importación se detuvo por un error',
      }[importacion.state];
      render(
        caja,
        html`<div class="k-stack">
          <div class="k-card k-stack">
            <h2 class="imp-sub">${titulo}</h2>
            <p class="k-muted">${importacion.filename} · ${numero(importacion.rows)} filas</p>
            ${when(!terminado, () => avance('Filas importadas'))}
            ${when(terminado, () => resumen(importacion.report))}
            <div class="k-row">
              ${
                terminado
                  ? html`<button type="button" class="k-btn k-btn--primary" data-do="nueva">Nueva importación</button>`
                  : html`<button type="button" class="k-btn" data-do="cancelar">Detener</button>`
              }
            </div>
          </div>
          ${when(terminado, () => html`<div class="k-card" data-slot="final"></div>`)}
        </div>`,
      );
      const final = caja.querySelector('[data-slot="final"]');
      if (final) filas(final, 'apply');
    }

    // ---- pintar

    function pintar() {
      if (!vivo) return;
      if (importacion && RESULTADO.has(importacion.state)) {
        asistente?.destroy();
        asistente = null;
        render(cuerpo, html`<div data-slot="resultado"></div>`);
        resultado(cuerpo.querySelector('[data-slot="resultado"]'));
        return;
      }
      if (!asistente) {
        render(cuerpo, html`<div class="k-card" data-slot="asistente"></div>`);
        const inicial = !importacion
          ? 'archivo'
          : importacion.state === 'uploaded'
            ? 'columnas'
            : importacion.state === 'validating' || importacion.state === 'validated'
              ? 'vista'
              : 'archivo';
        asistente = wizard(cuerpo.querySelector('[data-slot="asistente"]'), {
          steps: PASOS,
          label: 'Pasos para importar',
          current: inicial,
          finishLabel: 'Importar',
          onEnter: (paso, caja) => {
            if (paso.id !== 'vista' && paso.id !== 'importar') {
              tabla?.destroy();
              tabla = null;
            }
            PINTORES[paso.id](caja);
          },
          validate: validar,
          onFinish: importar,
        });
        return;
      }
      const paso = asistente.current();
      const caja = asistente.body(paso);
      // Un aviso en vivo no pisa lo que se está eligiendo en las columnas.
      if (paso === 'vista' || paso === 'archivo') PINTORES[paso](caja);
    }

    async function abrir(id) {
      const { import: datos } = await api.get(`/api/contact-import/${id}`);
      if (!vivo) return;
      archivo = null;
      confirmado = false;
      asistente?.destroy();
      asistente = null;
      aplicarImportacion(datos);
      pintar();
      seguir();
    }

    async function cargarMarca() {
      const datos = await api.get('/api/contact-import', { brand: marca });
      if (!vivo) return;
      recientes = datos.imports.slice(0, 5);
      limites = datos.limits;
    }

    async function cargar() {
      render(cuerpo, loading('Cargando…'));
      asistente = null;
      try {
        marcas = (await api.get('/api/contact-import')).brands;
        if (!marcas.some(item => item.id === marca))
          marca = marcas.some(item => item.id === ctx.brand) ? ctx.brand : (marcas[0]?.id ?? null);
        if (!marca) {
          render(cuerpo, html`<p class="k-hint">Tu acceso no incluye importar contactos en ninguna marca.</p>`);
          return;
        }
        await cargarMarca();
        const pendiente = ctx.keep.get('importacion');
        if (pendiente) {
          try {
            const { import: datos } = await api.get(`/api/contact-import/${pendiente}`);
            if (datos.brandId === marca) aplicarImportacion(datos);
          } catch (error) {
            if (isAbort(error)) return;
            ctx.keep.delete('importacion');
          }
        }
      } catch (error) {
        if (vivo && !isAbort(error)) render(cuerpo, failure({ error, retry: 'reintentar' }));
        return;
      }
      guardar();
      pintar();
      seguir();
    }

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            abrir: (_evento, boton) => abrir(boton.getAttribute('data-id')),
            sugerencia() {
              destinos = [...importacion.suggested.targets];
              pasoColumnas(asistente.body('columnas'));
            },
            async cancelar() {
              const { import: datos } = await api.post(`/api/contact-import/${importacion.id}/cancel`, {});
              importacion = { ...importacion, ...datos };
              ctx.toast('Se pidió detener la importación.');
              seguir();
            },
            async nueva() {
              importacion = null;
              archivo = null;
              confirmado = false;
              tabla?.destroy();
              tabla = null;
              guardar();
              await cargarMarca();
              pintar();
            },
          },
          change: {
            async marca(_evento, formulario) {
              marca = formValues(formulario).marca;
              importacion = null;
              archivo = null;
              guardar();
              await cargarMarca();
              pasoArchivo(asistente.body('archivo'));
            },
            archivo(evento) {
              const elegido = evento.target.files?.[0] ?? null;
              archivo = elegido ? { file: elegido, clientRef: newClientRef() } : null;
              if (elegido) {
                importacion = null;
                guardar();
              }
              pasoArchivo(asistente.body('archivo'));
            },
            columnas(evento) {
              // Cambiar el permiso muestra u oculta el campo del origen.
              if (evento.target.name === 'consentMode') {
                leerColumnas();
                pasoColumnas(asistente.body('columnas'));
              }
            },
            confirmar(_evento, formulario) {
              confirmado = formValues(formulario).confirmo === true;
            },
            filtro(_evento, formulario) {
              filtro = formValues(formulario).filtro || 'errors';
              tabla?.reload();
            },
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );

    enVivo = {
      importacion: () => importacion?.id ?? null,
      refrescar,
    };
    ctx.onUnmount(() => {
      vivo = false;
      enVivo = null;
      clearTimeout(espera);
      tabla?.destroy();
      asistente?.destroy();
    });
    cargar();
  },

  /** Avance de la vista previa o de la importación que se está viendo: se vuelve a pedir su estado. */
  onEvent(evento) {
    if (evento?.type === 'job.progress' && evento.data?.refId && evento.data.refId === enVivo?.importacion())
      enVivo.refrescar();
  },
};
