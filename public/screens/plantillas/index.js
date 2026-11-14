/**
 * «Plantillas de WhatsApp» (docs/PLAN_PLANTILLAS_COMPLETAS.md): administrar las plantillas que Meta aprueba para
 * escribir con la ventana de 24 horas cerrada.
 *
 * Lista con estado, categoría, calidad e idioma (por páginas, filtrada en el servidor); editor con vista previa en
 * forma de mensaje (encabezado de texto, imagen o documento; cuerpo con datos y sus muestras; pie; botones);
 * enviar a aprobación; sincronizar con Meta y adoptar por lote las plantillas que ya existen en la cuenta; duplicar,
 * dar de baja y restaurar. Toda la validación real la hace el servidor (/api/whatsapp/templates); aquí sólo se
 * adelanta la vista previa.
 */
import { attrs, html, render, url, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { isAbort, newClientRef } from '../../kit/api.js';
import { pagedTable } from '../../kit/components/table.js';
import { field } from '../../kit/components/form.js';
import { confirm, dialog } from '../../kit/components/dialog.js';
import { failure } from '../../kit/components/feedback.js';

const CATEGORIA = { utility: 'Utilidad', marketing: 'Marketing' };
const USO = { manual: 'Manual (desde el chat)', notice: 'Aviso automático' };
const TONO = {
  approved: 'k-chip--ok',
  flagged: 'k-chip--warn',
  pending: 'k-chip--accent',
  in_appeal: 'k-chip--accent',
  rejected: 'k-chip--bad',
  paused: 'k-chip--bad',
  disabled: 'k-chip--bad',
  deleted: 'k-chip--bad',
  missing: 'k-chip--warn',
};
const ESTADOS = [
  ['draft', 'Borrador'],
  ['pending', 'En revisión'],
  ['approved', 'Aprobada'],
  ['rejected', 'Rechazada'],
  ['paused', 'Pausada'],
].map(([value, label]) => ({ value, label }));
const CALIDAD = { green: 'Alta', yellow: 'Media', red: 'Baja', unknown: 'Sin dato' };
const ENCABEZADO = { none: 'Sin encabezado', text: 'Texto', image: 'Imagen', document: 'Documento PDF' };
const BOTON = { quick_reply: 'Respuesta rápida', url: 'Enlace', phone: 'Teléfono' };
const MUESTRA = { nombre: 'María', curso: 'Plan sanitario para aves', edicion: 'Edición general', marca: 'GlobalVet' };
const DATO = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;
const fecha = ms =>
  ms
    ? new Date(ms).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

/** Lo vivo de este montaje, para que onEvent() llegue a la tabla. Lo que sobrevive a un remontaje va en ctx.keep. */
let enVivo = null;

/** Datos de un texto en el orden en que aparecen, sin repetir: lo que pide muestra. */
function datosDe(...textos) {
  const vistos = [];
  for (const texto of textos)
    for (const m of String(texto ?? '').matchAll(DATO)) {
      const clave = m[1].trim().toLowerCase();
      if (!vistos.includes(clave)) vistos.push(clave);
    }
  return vistos;
}
const llenar = (texto, muestras) =>
  String(texto ?? '').replace(DATO, (todo, clave, respaldo) => {
    const k = clave.trim().toLowerCase();
    return muestras[k] || MUESTRA[k] || respaldo || todo;
  });

/** El mensaje como lo vería la persona: una burbuja neutra con el estilo de la casa. */
function burbuja(mensaje) {
  const cabeza = mensaje.header;
  const imagen = cabeza?.type === 'image' && cabeza.fileId ? url(`/api/wa-templates/files/${cabeza.fileId}`) : '';
  return html`<figure class="pla-vista" aria-label="Vista previa del mensaje">
    <div class="pla-burbuja">
      ${when(cabeza?.type === 'text', () => html`<p class="pla-encabezado">${cabeza.text}</p>`)}
      ${when(cabeza?.type === 'image', () =>
        imagen
          ? html`<img class="pla-imagen" src="${imagen}" alt="Imagen del encabezado" />`
          : html`<p class="pla-archivo">Imagen del encabezado (elige el archivo de muestra)</p>`,
      )}
      ${when(
        cabeza?.type === 'document',
        () => html`<p class="pla-archivo">Documento PDF · ${cabeza.filename || 'elige el archivo de muestra'}</p>`,
      )}
      <p class="pla-cuerpo">${mensaje.body || 'Escribe el texto del mensaje.'}</p>
      ${when(mensaje.footer, () => html`<p class="pla-pie">${mensaje.footer}</p>`)}
    </div>
    ${when(
      mensaje.buttons?.length,
      () =>
        html`<div class="pla-botones">${mensaje.buttons.map(b => html`<span class="pla-boton">${b.text || 'Botón'}</span>`)}</div>`,
    )}
    <figcaption class="k-hint">Vista previa con datos de muestra. WhatsApp la dibuja a su manera.</figcaption>
  </figure>`;
}

/** Estado del editor a partir de una plantilla (o vacío para una nueva). */
function estadoDe(plantilla, marca) {
  if (!plantilla)
    return {
      brandId: marca,
      name: '',
      language: 'es_MX',
      category: 'utility',
      purpose: 'manual',
      header: { type: 'none', text: '', fileId: null, filename: '' },
      body: '',
      footer: '',
      buttons: [],
      samples: {},
    };
  const e = plantilla.editor;
  return {
    brandId: plantilla.brandId,
    name: plantilla.name,
    language: plantilla.language,
    category: plantilla.category,
    purpose: plantilla.purpose,
    header: { text: '', ...e.header, filename: plantilla.components.header?.filename ?? '' },
    body: e.body,
    footer: e.footer,
    buttons: e.buttons.map(b => ({ text: '', url: '', phone: '', ...b })),
    samples: { ...e.samples },
  };
}

/** Lo que viaja al servidor desde el estado del editor. */
const cuerpoDe = s => ({
  category: s.category,
  purpose: s.purpose,
  header:
    s.header.type === 'text'
      ? { type: 'text', text: s.header.text }
      : s.header.type === 'none'
        ? { type: 'none' }
        : { type: s.header.type, fileId: s.header.fileId },
  body: s.body,
  footer: s.footer,
  buttons: s.buttons.map(b =>
    b.type === 'url'
      ? { type: 'url', text: b.text, url: b.url }
      : b.type === 'phone'
        ? { type: 'phone', text: b.text, phone: b.phone }
        : { type: 'quick_reply', text: b.text },
  ),
  samples: Object.fromEntries(Object.entries(s.samples).filter(([, v]) => v)),
});

const base64De = async archivo => {
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  let texto = '';
  for (let i = 0; i < bytes.length; i += 0x8000) texto += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(texto);
};

/** Editor de una plantilla nueva o de un borrador/rechazada. Devuelve la plantilla guardada o null. */
function editor({ api, ctx, datos, plantilla, marca }) {
  const nueva = !plantilla;
  const clave = nueva ? `nueva:${marca}` : `edicion:${plantilla.id}`;
  const s = ctx.keep.get(clave) ?? estadoDe(plantilla, marca);
  const clientRef = newClientRef();
  let error = '';
  let enviando = false;
  return dialog({
    title: nueva ? 'Nueva plantilla' : `Editar «${plantilla.name}»`,
    wide: true,
    mount(cuerpo, cerrar) {
      const uid = nombre => ctx.uid(`${clave}-${nombre}`);
      const pintar = () => {
        const datosUsados = datosDe(
          s.header.type === 'text' ? s.header.text : '',
          s.body,
          ...s.buttons.map(b => b.url),
        );
        const mensaje = {
          header:
            s.header.type === 'text'
              ? { type: 'text', text: llenar(s.header.text, s.samples) }
              : s.header.type === 'none'
                ? null
                : { type: s.header.type, fileId: s.header.fileId, filename: s.header.filename },
          body: llenar(s.body, s.samples),
          footer: s.footer,
          buttons: s.buttons,
        };
        render(
          cuerpo,
          html`<form class="pla-editor" novalidate data-do="editor">
            <div class="pla-campos k-stack">
              ${when(
                nueva,
                () => html`<div class="k-grid">
                  ${field(
                    {
                      name: 'brandId',
                      label: 'Marca',
                      type: 'select',
                      required: true,
                      options: datos.brands.map(b => ({ value: b.id, label: b.name })),
                    },
                    { id: uid('marca'), value: s.brandId },
                  )}
                  ${field(
                    {
                      name: 'name',
                      label: 'Nombre en Meta',
                      required: true,
                      maxlength: 128,
                      autocomplete: 'off',
                      hint: 'Minúsculas, números y guion bajo. No cambia después de enviarla.',
                    },
                    { id: uid('nombre'), value: s.name },
                  )}
                  ${field(
                    {
                      name: 'language',
                      label: 'Idioma',
                      type: 'select',
                      required: true,
                      options: datos.languages.map(l => ({ value: l, label: l })),
                    },
                    { id: uid('idioma'), value: s.language },
                  )}
                </div>`,
              )}
              <div class="k-grid">
                ${field(
                  {
                    name: 'category',
                    label: 'Categoría',
                    type: 'select',
                    required: true,
                    options: Object.entries(CATEGORIA).map(([value, label]) => ({ value, label })),
                    hint: 'Utilidad: avisos de algo que la persona pidió. Marketing: promociones (Meta la cobra más cara).',
                  },
                  { id: uid('categoria'), value: s.category },
                )}
                ${field(
                  {
                    name: 'purpose',
                    label: 'Uso',
                    type: 'select',
                    required: true,
                    options: Object.entries(USO).map(([value, label]) => ({ value, label })),
                  },
                  { id: uid('uso'), value: s.purpose },
                )}
              </div>
              <fieldset class="k-fieldset">
                <legend class="k-label">Encabezado</legend>
                ${field(
                  {
                    name: 'headerType',
                    label: 'Tipo de encabezado',
                    type: 'select',
                    options: Object.entries(ENCABEZADO).map(([value, label]) => ({ value, label })),
                    emptyLabel: 'Sin encabezado',
                  },
                  { id: uid('enc-tipo'), value: s.header.type === 'none' ? '' : s.header.type },
                )}
                ${when(s.header.type === 'text', () =>
                  field(
                    {
                      name: 'headerText',
                      label: 'Texto del encabezado',
                      maxlength: 60,
                      hint: 'Hasta 60 caracteres y un dato como mucho.',
                    },
                    { id: uid('enc-texto'), value: s.header.text },
                  ),
                )}
                ${when(
                  s.header.type === 'image' || s.header.type === 'document',
                  () => html`<div class="k-field">
                    <label class="k-label" for="${uid('archivo')}">Archivo de muestra</label>
                    <input
                      class="k-input"
                      type="file"
                      id="${uid('archivo')}"
                      data-do="archivo"
                      accept="${s.header.type === 'image' ? 'image/png,image/jpeg' : 'application/pdf'}"
                    />
                    <p class="k-hint">
                      ${s.header.fileId ? `Elegido: ${s.header.filename || 'archivo'}. ` : ''}${s.header.type === 'image' ? 'JPG o PNG' : 'PDF'} de hasta 4 MB.
                      Meta lo usa para revisarla y se envía con cada mensaje.
                    </p>
                  </div>`,
                )}
              </fieldset>
              ${field(
                {
                  name: 'body',
                  label: 'Texto del mensaje',
                  type: 'textarea',
                  rows: 5,
                  required: true,
                  maxlength: 1024,
                  hint: 'Datos por su nombre: {{nombre}}, {{curso}}, {{edicion}}, {{marca}}; valores fijos {{fijo.vigencia}}. Respaldo: {{nombre|Hola}}. Formato: *negrita*, _cursiva_.',
                },
                { id: uid('cuerpo'), value: s.body },
              )}
              ${when(
                datosUsados.length,
                () => html`<fieldset class="k-fieldset">
                  <legend class="k-label">Muestras para Meta</legend>
                  <div class="k-grid">
                    ${datosUsados.map(k =>
                      field(
                        {
                          name: `s:${k}`,
                          label: `{{${k}}}`,
                          maxlength: 200,
                          placeholder: MUESTRA[k] ?? 'Escribe una muestra',
                        },
                        { id: uid(`muestra-${k.replace(/[^a-z0-9]/g, '-')}`), value: s.samples[k] ?? '' },
                      ),
                    )}
                  </div>
                </fieldset>`,
              )}
              ${field({ name: 'footer', label: 'Pie (opcional)', maxlength: 60, hint: 'Hasta 60 caracteres, sin datos.' }, { id: uid('pie'), value: s.footer })}
              <fieldset class="k-fieldset">
                <legend class="k-label">Botones</legend>
                ${s.buttons.map(
                  (b, i) => html`<div class="pla-boton-fila" data-key="${`b${i}`}">
                    ${field(
                      {
                        name: `b${i}:type`,
                        label: `Botón ${i + 1}`,
                        type: 'select',
                        options: Object.entries(BOTON).map(([value, label]) => ({ value, label })),
                      },
                      { id: uid(`b${i}-tipo`), value: b.type },
                    )}
                    ${field({ name: `b${i}:text`, label: 'Texto', maxlength: 25 }, { id: uid(`b${i}-texto`), value: b.text })}
                    ${when(b.type === 'url', () =>
                      field(
                        { name: `b${i}:url`, label: 'Enlace (https://)', maxlength: 2000 },
                        { id: uid(`b${i}-url`), value: b.url },
                      ),
                    )}
                    ${when(b.type === 'phone', () =>
                      field(
                        { name: `b${i}:phone`, label: 'Teléfono (+52…)', maxlength: 16 },
                        { id: uid(`b${i}-tel`), value: b.phone },
                      ),
                    )}
                    <button type="button" class="k-btn" data-do="quitar" data-i="${String(i)}">Quitar</button>
                  </div>`,
                )}
                ${when(
                  s.buttons.length < 10,
                  () => html`<button type="button" class="k-btn" data-do="agregar">Añadir botón</button>`,
                )}
                <p class="k-hint">Hasta 10. Los de respuesta rápida van juntos; WhatsApp muestra tres y el resto tras «Ver todas las opciones».</p>
              </fieldset>
            </div>
            <div class="pla-lado">${burbuja(mensaje)}</div>
            <div class="pla-pie-editor">
              ${when(error, () => html`<p class="k-notice k-notice--bad" role="alert">${error}</p>`)}
              <div class="k-actions">
                <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
                <button type="submit" class="k-btn k-btn--primary" ${attrs({ disabled: enviando })}>
                  ${enviando ? 'Guardando…' : nueva ? 'Crear borrador' : 'Guardar cambios'}
                </button>
              </div>
            </div>
          </form>`,
        );
      };
      const leer = formulario => {
        const v = formValues(formulario);
        if (nueva)
          Object.assign(s, { brandId: v.brandId, name: String(v.name ?? '').toLowerCase(), language: v.language });
        Object.assign(s, { category: v.category, purpose: v.purpose, body: v.body ?? '', footer: v.footer ?? '' });
        const tipo = v.headerType || 'none';
        if (tipo !== s.header.type) s.header = { type: tipo, text: '', fileId: null, filename: '' };
        else if (tipo === 'text') s.header.text = v.headerText ?? '';
        s.buttons = s.buttons.map((b, i) => ({
          type: v[`b${i}:type`] || b.type,
          text: v[`b${i}:text`] ?? b.text,
          url: v[`b${i}:url`] ?? b.url,
          phone: v[`b${i}:phone`] ?? b.phone,
        }));
        for (const [k, valor] of Object.entries(v)) if (k.startsWith('s:')) s.samples[k.slice(2)] = valor;
        if (nueva) ctx.keep.set(clave, s);
      };
      const formulario = () => cuerpo.querySelector('form');
      pintar();
      const quitar = listen(
        cuerpo,
        {
          input: { editor: (_e, f) => (leer(f), pintar()) },
          change: {
            editor: (_e, f) => (leer(f), pintar()),
            async archivo(evento) {
              const elegido = evento.target.files?.[0];
              if (!elegido) return;
              leer(formulario());
              const { file } = await api.post('/api/wa-templates/files', {
                brandId: s.brandId,
                file: { name: elegido.name, type: elegido.type, base64: await base64De(elegido) },
                clientRef: newClientRef(),
              });
              s.header.fileId = file.id;
              s.header.filename = file.filename;
              error = '';
              pintar();
            },
          },
          click: {
            agregar() {
              leer(formulario());
              s.buttons.push({ type: 'quick_reply', text: '', url: '', phone: '' });
              pintar();
            },
            quitar(_e, boton) {
              leer(formulario());
              s.buttons.splice(Number(boton.getAttribute('data-i')), 1);
              pintar();
            },
            cancelar: () => cerrar(null),
          },
          submit: {
            async editor(_e, f) {
              if (enviando) return;
              leer(f);
              enviando = true;
              error = '';
              pintar();
              try {
                const respuesta = nueva
                  ? await api.post('/api/whatsapp/templates', {
                      brandId: s.brandId,
                      name: s.name,
                      language: s.language,
                      ...cuerpoDe(s),
                      clientRef,
                    })
                  : await api.patch(`/api/whatsapp/templates/${plantilla.id}`, {
                      ...cuerpoDe(s),
                      expectedRevision: plantilla.revision,
                    });
                ctx.keep.delete(clave);
                if (respuesta.warnings?.length) ctx.toast(respuesta.warnings.map(w => w.label).join(' '));
                cerrar(respuesta.template);
              } catch (fallo) {
                if (isAbort(fallo)) return;
                error = fallo.message;
                enviando = false;
                pintar();
              }
            },
          },
        },
        {
          onError: fallo => {
            error = fallo.message;
            pintar();
          },
        },
      );
      return quitar;
    },
  });
}

/** Ficha de una plantilla que ya está en Meta: vista previa, uso y, si es adoptada, qué dato llena cada variable. */
function ficha({ api, ctx, plantilla }) {
  const opciones = Object.entries({ nombre: 'Nombre', curso: 'Curso', edicion: 'Edición', marca: 'Marca' }).map(
    ([value, label]) => ({ value, label }),
  );
  const variables = plantilla.components.body.vars;
  return dialog({
    title: `«${plantilla.name}»`,
    wide: true,
    mount(cuerpo, cerrar) {
      render(
        cuerpo,
        html`<form class="pla-editor" novalidate data-do="ficha">
          <div class="pla-campos k-stack">
            <p class="k-lead">
              ${plantilla.statusLabel}${plantilla.rejectText ? ` · ${plantilla.rejectText}` : ''}. El contenido de una
              plantilla enviada a Meta no se cambia: duplícala para escribir otra.
            </p>
            ${when(
              plantilla.prevCategory && !plantilla.categoryAckAt,
              () => html`<p class="k-notice k-notice--warn">
                Meta la cambió de ${CATEGORIA[plantilla.prevCategory] ?? plantilla.prevCategory} a
                ${CATEGORIA[plantilla.category] ?? plantilla.category}: se cobra como tal.
                <button type="button" class="k-btn" data-do="enterado">Enterado</button>
              </p>`,
            )}
            ${field(
              {
                name: 'purpose',
                label: 'Uso',
                type: 'select',
                required: true,
                options: Object.entries(USO).map(([value, label]) => ({ value, label })),
              },
              { id: ctx.uid(`ficha-${plantilla.id}-uso`), value: plantilla.purpose },
            )}
            ${when(
              variables.length,
              () => html`<fieldset class="k-fieldset">
                <legend class="k-label">Qué dato llena cada variable del texto</legend>
                ${variables.map((v, i) =>
                  field(
                    {
                      name: `v${i}`,
                      label: `{{${i + 1}}}${v.sample ? ` (muestra: ${v.sample})` : ''}`,
                      type: 'select',
                      options: opciones,
                      emptyLabel: 'Sin indicar',
                    },
                    { id: ctx.uid(`ficha-${plantilla.id}-v${i}`), value: v.key ?? '' },
                  ),
                )}
              </fieldset>`,
            )}
          </div>
          <div class="pla-lado">${burbuja(plantilla.message)}</div>
          <div class="pla-pie-editor k-actions">
            <button type="button" class="k-btn" data-do="cancelar">Cerrar</button>
            <button type="submit" class="k-btn k-btn--primary">Guardar</button>
          </div>
        </form>`,
      );
      return listen(
        cuerpo,
        {
          click: {
            cancelar: () => cerrar(null),
            async enterado() {
              const { template } = await api.post(`/api/whatsapp/templates/${plantilla.id}/ack`, {});
              cerrar(template);
            },
          },
          submit: {
            async ficha(_e, f) {
              const v = formValues(f);
              const { template } = await api.patch(`/api/whatsapp/templates/${plantilla.id}`, {
                purpose: v.purpose,
                ...(variables.length ? { variables: variables.map((_x, i) => v[`v${i}`] || null) } : {}),
                expectedRevision: plantilla.revision,
              });
              cerrar(template);
            },
          },
        },
        { onError: fallo => ctx.toast(fallo.message) },
      );
    },
  });
}

/** Adoptar por lote las plantillas que ya existen en la cuenta de Meta y el CRM no usa. */
function adoptar({ api, ctx, datos, marca }) {
  return dialog({
    title: 'Adoptar plantillas de Meta',
    wide: true,
    mount(cuerpo, cerrar) {
      let elegidas = [];
      let destino = marca;
      render(
        cuerpo,
        html`<div class="k-stack">
          <p class="k-lead">
            Las plantillas que ya existen en la cuenta de WhatsApp Business y el CRM todavía no usa. Elige las de una
            marca y adóptalas: quedan con su estado de Meta. Si tienen datos, indica después cuál llena cada uno.
          </p>
          <form class="pla-filtros" novalidate data-do="destino">
            ${field(
              {
                name: 'brand',
                label: 'Marca a la que se asignan',
                type: 'select',
                required: true,
                options: datos.brands.map(b => ({ value: b.id, label: b.name })),
              },
              { id: ctx.uid('adoptar-marca'), value: destino },
            )}
          </form>
          <div data-slot="remotas"></div>
          <div class="k-actions">
            <button type="button" class="k-btn" data-do="cerrar">Cerrar</button>
            <button type="button" class="k-btn k-btn--primary" data-do="adoptar">Adoptar las elegidas</button>
          </div>
        </div>`,
      );
      const tabla = pagedTable(cuerpo.querySelector('[data-slot="remotas"]'), {
        label: 'Plantillas de Meta sin adoptar',
        rowKey: r => `${r.name}|${r.language}`,
        rowLabel: r => r.name,
        selectable: true,
        cards: true,
        chooser: false,
        onSelect: claves => (elegidas = claves),
        columns: [
          { id: 'name', label: 'Nombre', fixed: true, cell: r => r.name },
          { id: 'language', label: 'Idioma', cell: r => r.language },
          { id: 'category', label: 'Categoría', cell: r => CATEGORIA[r.category] ?? r.category },
          { id: 'status', label: 'Estado', cell: r => r.status },
          { id: 'header', label: 'Encabezado', cell: r => ENCABEZADO[r.header] ?? r.header },
          { id: 'usable', label: 'Se puede usar', wrap: true, cell: r => (r.supported ? 'Sí' : r.unsupported) },
        ],
        async load({ cursor, limit, signal }) {
          const r = await api.get(
            '/api/whatsapp/templates/remote',
            { offset: cursor ?? '0', limit: String(limit) },
            { signal },
          );
          return { rows: r.remote, next: r.next };
        },
        empty: {
          title: 'No hay plantillas por adoptar',
          text: 'Pulsa «Sincronizar con Meta» para traer las de la cuenta.',
        },
      });
      const quitar = listen(
        cuerpo,
        {
          change: { destino: (_e, f) => (destino = formValues(f).brand) },
          click: {
            cerrar: () => cerrar(true),
            async adoptar() {
              if (!elegidas.length) return ctx.toast('Elige al menos una plantilla.');
              const items = elegidas.slice(0, 100).map(k => {
                const [name, language] = k.split('|');
                return { name, language };
              });
              const r = await api.post('/api/whatsapp/templates/adopt', { brandId: destino, items });
              ctx.toast(
                `Se adoptaron ${r.templates.length}.` +
                  (r.existing.length ? ` ${r.existing.length} ya estaban.` : '') +
                  (r.skipped.length ? ` ${r.skipped.length} no se pueden usar.` : ''),
              );
              elegidas = [];
              tabla.reload();
            },
          },
        },
        { onError: fallo => ctx.toast(fallo.message) },
      );
      return () => {
        quitar();
        tabla.destroy();
      };
    },
  });
}

/** Pide el nombre de la copia (y la marca). Devuelve {name, brandId} o null. */
function pedirCopia({ ctx, datos, plantilla }) {
  return dialog({
    title: `Duplicar «${plantilla.name}»`,
    mount(cuerpo, cerrar) {
      render(
        cuerpo,
        html`<form class="k-stack" novalidate data-do="copia">
          ${field(
            {
              name: 'name',
              label: 'Nombre de la copia',
              required: true,
              maxlength: 128,
              hint: 'Minúsculas, números y guion bajo.',
            },
            { id: ctx.uid(`copia-${plantilla.id}`), value: `${plantilla.name}_v2`.slice(0, 128) },
          )}
          ${field(
            {
              name: 'brandId',
              label: 'Marca',
              type: 'select',
              required: true,
              options: datos.brands.map(b => ({ value: b.id, label: b.name })),
            },
            { id: ctx.uid(`copia-${plantilla.id}-marca`), value: plantilla.brandId },
          )}
          <div class="k-actions">
            <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
            <button type="submit" class="k-btn k-btn--primary">Duplicar</button>
          </div>
        </form>`,
      );
      return listen(cuerpo, {
        click: { cancelar: () => cerrar(null) },
        submit: { copia: (_e, f) => cerrar(formValues(f)) },
      });
    },
  });
}

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let datos = null; // lo último que dijo el servidor: cuenta, marcas, límites, idiomas
    let filtros = ctx.keep.get('filtros') ?? { brand: '', status: '', q: '' };
    let tabla = null;
    let vivo = true;
    const filas = new Map();

    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">WhatsApp</span>
            <h1>Plantillas</h1>
            <p class="k-lead">
              Los mensajes que Meta aprueba para escribir cuando pasaron más de 24 horas desde el último mensaje de la
              persona: con imagen o documento, datos de la conversación y botones.
            </p>
          </div>
          <div class="k-actions">
            <button type="button" class="k-btn" data-do="sincronizar">Sincronizar con Meta</button>
            <button type="button" class="k-btn" data-do="adoptar">Adoptar de Meta</button>
            <button type="button" class="k-btn k-btn--primary" data-do="nueva">Nueva plantilla</button>
          </div>
        </header>
        <div class="k-stack" data-slot="cuerpo"></div>
      </section>`,
    );
    const cuerpo = root.querySelector('[data-slot="cuerpo"]');

    function camposFiltro() {
      return html`${field(
        {
          name: 'brand',
          label: 'Marca',
          type: 'select',
          options: (datos?.brands ?? []).map(b => ({ value: b.id, label: b.name })),
          emptyLabel: 'Todas',
        },
        { id: ctx.uid('f-marca'), value: filtros.brand },
      )}
        ${field(
          { name: 'status', label: 'Estado', type: 'select', emptyLabel: 'Todos', options: ESTADOS },
          { id: ctx.uid('f-estado'), value: filtros.status },
        )}
        ${field(
          { name: 'q', label: 'Buscar', type: 'search', maxlength: 80, placeholder: 'Nombre o texto' },
          { id: ctx.uid('f-buscar'), value: filtros.q },
        )}`;
    }

    function estado() {
      if (!datos) return html``;
      const l = datos.limits;
      return html`${when(
        !datos.wabaSet,
        () => html`<p class="k-notice k-notice--warn">
            Sin cuenta de WhatsApp Business (META_WABA_ID): puedes escribir borradores; enviarlos a aprobación y
            sincronizar necesita la cuenta.
          </p>`,
      )}
        <p class="k-hint" role="status">
          ${l.count} de ${l.limit} plantillas en la cuenta · ${datos.remoteTotal} en Meta sin adoptar ·
          ${datos.syncedAt ? `sincronizado ${fecha(datos.syncedAt)}` : 'sin sincronizar'} ·
          ${datos.lastWebhookAt ? `último aviso de Meta ${fecha(datos.lastWebhookAt)}` : 'Meta todavía no ha avisado de ningún cambio: usa «Sincronizar con Meta»'}
        </p>`;
    }

    function pintar() {
      render(
        cuerpo,
        html`<div data-slot="estado"></div>
          <form class="k-card pla-filtros" novalidate data-do="filtros">${camposFiltro()}</form>
          <div class="k-card" data-slot="tabla"></div>`,
      );
      render(cuerpo.querySelector('[data-slot="estado"]'), estado());
      tabla = pagedTable(cuerpo.querySelector('[data-slot="tabla"]'), {
        label: 'Plantillas de WhatsApp',
        rowKey: f => f.id,
        rowLabel: f => f.name,
        cards: true,
        chooser: false,
        columns: [
          {
            id: 'name',
            label: 'Plantilla',
            fixed: true,
            cell: f => html`<span class="pla-nombre">${f.name}</span><span class="k-muted"> · ${f.brandName}</span>`,
          },
          {
            id: 'status',
            label: 'Estado',
            cell: f =>
              html`<span class="${['k-chip', TONO[f.status]]}">${f.statusLabel}</span>${when(
                f.archivedAt,
                () => html` <span class="k-chip">De baja</span>`,
              )}${when(f.needsMapping, () => html` <span class="k-chip k-chip--warn">Falta indicar sus datos</span>`)}`,
          },
          { id: 'category', label: 'Categoría', cell: f => CATEGORIA[f.category] ?? f.category },
          { id: 'quality', label: 'Calidad', cell: f => (f.quality ? (CALIDAD[f.quality] ?? f.quality) : '—') },
          { id: 'language', label: 'Idioma', cell: f => f.language },
          { id: 'purpose', label: 'Uso', cell: f => (f.purpose === 'notice' ? 'Aviso' : 'Manual') },
          {
            id: 'actions',
            label: 'Acciones',
            cell: f => html`<span class="pla-acciones">
              <button type="button" class="k-btn" data-do="abrir" data-id="${f.id}">${f.editable ? 'Editar' : 'Ver'}</button>
              ${when(
                f.editable,
                () =>
                  html`<button type="button" class="k-btn" data-do="enviar" data-id="${f.id}">Enviar a aprobación</button>`,
              )}
              <button type="button" class="k-btn" data-do="duplicar" data-id="${f.id}">Duplicar</button>
              ${
                f.archivedAt
                  ? html`<button type="button" class="k-btn" data-do="restaurar" data-id="${f.id}">Restaurar</button>`
                  : html`<button type="button" class="k-btn" data-do="baja" data-id="${f.id}">Dar de baja</button>`
              }
            </span>`,
          },
        ],
        async load({ cursor, limit, signal }) {
          const r = await api.get(
            '/api/whatsapp/templates',
            {
              brand: filtros.brand || 'all',
              status: filtros.status,
              q: filtros.q,
              limit: String(limit),
              offset: cursor ?? '0',
              archived: '1',
            },
            { signal },
          );
          const brands = datos?.brands;
          datos = r;
          if (!cursor) filas.clear();
          for (const f of r.templates) filas.set(f.id, f);
          if (vivo) {
            render(cuerpo.querySelector('[data-slot="estado"]'), estado());
            // la primera vez llegan las marcas: el filtro las necesita
            if (!brands) queueMicrotask(() => vivo && repintarFiltros());
          }
          return { rows: r.templates, next: r.next };
        },
        empty: {
          title: 'Todavía no hay plantillas',
          text: 'Escribe una con «Nueva plantilla» o adopta las que ya existen en Meta.',
        },
      });
    }
    function repintarFiltros() {
      const caja = cuerpo.querySelector('[data-do="filtros"]');
      if (caja) render(caja, camposFiltro());
    }

    const recargar = () => tabla?.reload();
    const fila = boton => filas.get(boton.getAttribute('data-id')) ?? null;
    const marcaElegida = () => filtros.brand || datos?.brands[0]?.id || ctx.brand;
    let espera = null;

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: () => recargar(),
            async nueva() {
              if (!datos) return;
              const hecha = await editor({ api, ctx, datos, marca: marcaElegida() });
              if (!hecha) return;
              ctx.toast(`Se guardó el borrador «${hecha.name}».`);
              recargar();
            },
            async abrir(_e, boton) {
              const f = fila(boton);
              if (!f) return;
              const hecha = f.editable
                ? await editor({ api, ctx, datos, plantilla: f })
                : await ficha({ api, ctx, plantilla: f });
              if (hecha && hecha !== true) {
                ctx.toast(`Se guardó «${hecha.name}».`);
                recargar();
              }
            },
            async enviar(_e, boton) {
              const f = fila(boton);
              if (!f) return;
              const seguro = await confirm({
                title: `¿Enviar «${f.name}» a aprobación?`,
                message:
                  'Meta la revisa (a veces en minutos, a veces en un día). Mientras tanto no se puede cambiar su contenido.',
                confirmLabel: 'Enviar a aprobación',
              });
              if (!seguro) return;
              const { template } = await api.post(`/api/whatsapp/templates/${f.id}/submit`, {});
              ctx.toast(`«${template.name}»: ${template.statusLabel}.`);
              recargar();
            },
            async duplicar(_e, boton) {
              const f = fila(boton);
              if (!f) return;
              const pedido = await pedirCopia({ ctx, datos, plantilla: f });
              if (!pedido) return;
              const { template } = await api.post(`/api/whatsapp/templates/${f.id}/duplicate`, {
                ...pedido,
                clientRef: newClientRef(),
              });
              ctx.toast(`Se creó el borrador «${template.name}».`);
              recargar();
            },
            async baja(_e, boton) {
              const f = fila(boton);
              if (!f) return;
              const seguro = await confirm({
                title: `¿Dar de baja «${f.name}»?`,
                message:
                  f.status === 'draft'
                    ? 'Es un borrador que nunca se envió: se borra.'
                    : 'Deja de ofrecerse en el chat y en los avisos. Sigue existiendo en Meta y puedes restaurarla.',
                confirmLabel: 'Dar de baja',
                danger: true,
              });
              if (!seguro) return;
              await api.delete(`/api/whatsapp/templates/${f.id}`);
              ctx.toast(`«${f.name}» quedó de baja.`);
              recargar();
            },
            async restaurar(_e, boton) {
              const f = fila(boton);
              if (!f) return;
              await api.post(`/api/whatsapp/templates/${f.id}/restore`, { expectedRevision: f.revision });
              ctx.toast(`Se restauró «${f.name}».`);
              recargar();
            },
            async sincronizar() {
              const r = await api.post('/api/whatsapp/templates/sync', {});
              ctx.toast(`Meta tiene ${r.found}; se actualizaron ${r.updated}; ${r.remote} sin adoptar.`);
              recargar();
            },
            async adoptar() {
              if (!datos) return;
              await adoptar({ api, ctx, datos, marca: marcaElegida() });
              recargar();
            },
          },
          input: {
            filtros(_e, f) {
              clearTimeout(espera);
              espera = setTimeout(() => {
                filtros = { ...filtros, ...formValues(f) };
                ctx.keep.set('filtros', filtros);
                recargar();
              }, 300);
            },
          },
          change: {
            filtros(_e, f) {
              filtros = { ...filtros, ...formValues(f) };
              ctx.keep.set('filtros', filtros);
              recargar();
            },
          },
        },
        { onError: fallo => ctx.toast(fallo.message) },
      ),
    );

    enVivo = { recargar };
    ctx.onUnmount(() => {
      vivo = false;
      enVivo = null;
      clearTimeout(espera);
      tabla?.destroy();
    });
    try {
      pintar();
    } catch (fallo) {
      render(cuerpo, failure({ error: fallo, retry: 'reintentar' }));
    }
  },

  /** Meta avisó de un cambio, o alguien más editó una plantilla: se vuelve a pedir la lista. */
  onEvent(evento) {
    if (evento?.type === 'templates.changed') enVivo?.recargar();
  },
};
