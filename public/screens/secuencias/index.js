/**
 * «Secuencias de seguimiento» (docs/PLAN_SECUENCIAS.md y docs/GUIA_SECUENCIAS.md).
 *
 * Lista de las secuencias de la marca con su interruptor, un editor de pasos en lista vertical (sin lienzo), la vista
 * previa («quién entraría y quién recibiría su paso ahora», sin enviar nada) y los resultados por paso. Administración
 * edita; el resto del equipo de la marca sólo ve. Todo lo valida y lo impone el servidor (/api/sequences).
 */
import { attrs, html, render, when } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { isAbort, newClientRef } from '../../kit/api.js';
import { field } from '../../kit/components/form.js';
import { confirm, dialog } from '../../kit/components/dialog.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';

let enVivo = null;

const UNIDADES = [
  { value: 'minutes', label: 'minutos' },
  { value: 'hours', label: 'horas' },
  { value: 'days', label: 'días' },
];
const nuevoPaso = () => ({
  timing: { base: 'enrolled', amount: 1, unit: 'days' },
  send: { kind: 'text', text: '' },
  whenClosed: 'skip',
  fallbackTemplateId: null,
  condition: null,
});
const opciones = mapa => Object.entries(mapa ?? {}).map(([value, label]) => ({ value, label }));
const lineas = texto =>
  String(texto ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
const fecha = t =>
  t
    ? new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(t)
    : '';

function borradorDe(s) {
  return {
    id: s?.id ?? null,
    revision: s?.revision ?? null,
    title: s?.title ?? '',
    description: s?.description ?? '',
    courseId: s?.courseId ?? '',
    settings: s?.settings ?? {
      trigger: 'manual',
      onReply: 'pause',
      onTakeover: 'pause',
      sendHours: 'business',
      stopPhrases: ['no, por el momento', 'no por ahora', 'no me interesa', 'ya no me interesa', 'no gracias'],
      yesPhrases: ['sí, deseo inscribirme', 'deseo inscribirme', 'quiero inscribirme', 'me interesa'],
      monthlyCap: 500,
      requireConsent: true,
      resumeAfterHours: 24,
      conversionDays: 7,
    },
    steps: (s?.steps ?? [nuevoPaso()]).map(p => ({
      timing: { ...p.timing },
      send: { ...p.send },
      whenClosed: p.whenClosed ?? 'skip',
      fallbackTemplateId: p.fallbackTemplateId ?? null,
      condition: p.condition ?? null,
    })),
  };
}

function pasoHtml(p, i, total, listas, uid) {
  const id = nombre => uid(`p${i}-${nombre}`);
  const plantillas = (listas.waTemplates ?? []).map(t => ({
    value: t.id,
    label: t.name + (t.status === 'approved' ? '' : ' (no aprobada)'),
  }));
  const materiales = (listas.materials ?? []).map(m => ({ value: m.id, label: m.title }));
  const relativo = p.timing.base === 'edition_start';
  return html`<li class="k-card sq-paso" data-key="${'paso-' + i}" data-index="${i}">
    <div class="sq-paso__head">
      <h3 class="sq-paso__titulo">Paso ${i + 1}</h3>
      <span class="sq-paso__acciones">
        <button type="button" class="k-btn" data-do="subir" data-index="${i}" aria-label="${'Subir el paso ' + (i + 1)}" ${attrs({ disabled: i === 0 })}>↑</button>
        <button type="button" class="k-btn" data-do="bajar" data-index="${i}" aria-label="${'Bajar el paso ' + (i + 1)}" ${attrs({ disabled: i === total - 1 })}>↓</button>
        <button type="button" class="k-btn" data-do="quitar" data-index="${i}" ${attrs({ disabled: total === 1 })}>Quitar</button>
      </span>
    </div>
    <div class="sq-fila">
      ${field(
        {
          name: `base-${i}`,
          label: 'Cuándo',
          type: 'select',
          options: [
            { value: 'enrolled', label: 'Después de inscribirse en la secuencia' },
            { value: 'edition_start', label: 'Antes del inicio del curso (fecha del catálogo)' },
          ],
          emptyLabel: 'Elige cuándo',
        },
        { id: id('base'), value: p.timing.base },
      )}
      ${
        relativo
          ? html`${field(
              { name: `daysBefore-${i}`, label: 'Días antes (0 = el mismo día)', type: 'number', min: 0, max: 60 },
              { id: id('dias'), value: p.timing.daysBefore ?? 0 },
            )}
            ${field({ name: `at-${i}`, label: 'Hora', type: 'time' }, { id: id('hora'), value: p.timing.at ?? '10:00' })}`
          : html`${field(
              { name: `amount-${i}`, label: 'Esperar', type: 'number', min: 0 },
              { id: id('cantidad'), value: p.timing.amount ?? 1 },
            )}
            ${field(
              { name: `unit-${i}`, label: 'Unidad', type: 'select', options: UNIDADES, emptyLabel: 'Unidad' },
              { id: id('unidad'), value: p.timing.unit ?? 'days' },
            )}`
      }
    </div>
    ${field(
      {
        name: `kind-${i}`,
        label: 'Qué envía',
        type: 'select',
        options: [
          { value: 'text', label: 'Texto (sólo con la ventana de 24 horas abierta)' },
          { value: 'template', label: 'Plantilla de WhatsApp aprobada (sale aunque la ventana esté cerrada)' },
          { value: 'material', label: 'Material del catálogo (ficha, temario, precio…)' },
        ],
        emptyLabel: 'Elige el contenido',
      },
      { id: id('tipo'), value: p.send.kind },
    )}
    ${
      p.send.kind === 'template'
        ? field(
            {
              name: `templateId-${i}`,
              label: 'Plantilla',
              type: 'select',
              options: plantillas,
              emptyLabel: plantillas.length ? 'Elige la plantilla' : 'La marca no tiene plantillas de WhatsApp',
            },
            { id: id('plantilla'), value: p.send.templateId ?? '' },
          )
        : p.send.kind === 'material'
          ? field(
              {
                name: `materialId-${i}`,
                label: 'Material',
                type: 'select',
                options: materiales,
                emptyLabel: materiales.length ? 'Elige el material' : 'La marca no tiene materiales aprobados',
              },
              { id: id('material'), value: p.send.materialId ?? '' },
            )
          : field(
              {
                name: `text-${i}`,
                label: 'Mensaje',
                type: 'textarea',
                rows: 3,
                maxlength: 1000,
                hint: 'Puedes escribir {{nombre}}. Precios y fechas: mejor un material del catálogo.',
              },
              { id: id('texto'), value: p.send.text ?? '' },
            )
    }
    ${when(
      p.send.kind !== 'template',
      () => html`${field(
        {
          name: `whenClosed-${i}`,
          label: 'Si la ventana de 24 horas está cerrada',
          type: 'select',
          options: [
            { value: 'skip', label: 'Omitir este paso' },
            { value: 'template', label: 'Enviar una plantilla aprobada en su lugar' },
            { value: 'stop', label: 'Detener la secuencia' },
          ],
          emptyLabel: 'Elige qué hacer',
        },
        { id: id('cerrada'), value: p.whenClosed ?? 'skip' },
      )}
      ${when(p.whenClosed === 'template', () =>
        field(
          {
            name: `fallbackTemplateId-${i}`,
            label: 'Plantilla de respaldo',
            type: 'select',
            options: plantillas,
            emptyLabel: plantillas.length ? 'Elige la plantilla' : 'La marca no tiene plantillas de WhatsApp',
          },
          { id: id('respaldo'), value: p.fallbackTemplateId ?? '' },
        ),
      )}`,
    )}
    ${when(p.condition, () => html`<p class="k-hint">Este paso tiene una condición guardada; se conserva al guardar.</p>`)}
  </li>`;
}

function editorHtml(b, datos, listas, uid, problemas) {
  const s = b.settings;
  const labels = datos.labels;
  return html`<form class="k-stack" novalidate data-do="editor">
    <div class="k-card k-stack">
      <h2 class="sq-titulo">${b.id ? 'Editar secuencia' : 'Nueva secuencia'}</h2>
      ${when(
        problemas.length,
        () => html`<div class="k-notice k-notice--bad" role="alert">
          <ul class="sq-problemas">${problemas.map(p => html`<li>${p}</li>`)}</ul>
        </div>`,
      )}
      ${field({ name: 'title', label: 'Nombre', required: true, maxlength: 80 }, { id: uid('titulo'), value: b.title })}
      ${field(
        { name: 'description', label: 'Descripción (opcional)', type: 'textarea', rows: 2, maxlength: 300 },
        { id: uid('descripcion'), value: b.description },
      )}
      ${field(
        {
          name: 'courseId',
          label: 'Curso',
          type: 'select',
          options: (listas.courses ?? []).map(c => ({ value: c.id, label: c.title })),
          emptyLabel: 'Cualquier curso de la marca',
          hint: 'Con un curso, sólo entran conversaciones de ese curso.',
        },
        { id: uid('curso'), value: b.courseId ?? '' },
      )}
      ${field(
        {
          name: 'trigger',
          label: 'Quién entra',
          type: 'select',
          options: opciones(labels.triggers),
          emptyLabel: 'Elige',
        },
        { id: uid('entrada'), value: s.trigger },
      )}
    </div>
    <div class="k-stack">
      <h2 class="sq-titulo">Pasos</h2>
      <ol class="sq-pasos">${b.steps.map((p, i) => pasoHtml(p, i, b.steps.length, listas, uid))}</ol>
      <div>
        <button type="button" class="k-btn" data-do="agregar" ${attrs({ disabled: b.steps.length >= datos.limits.steps })}>
          Agregar paso
        </button>
      </div>
    </div>
    <div class="k-card k-stack">
      <h2 class="sq-titulo">Cuándo para y protecciones</h2>
      <div class="sq-fila">
        ${field(
          {
            name: 'onReply',
            label: 'Si la persona responde',
            type: 'select',
            options: opciones(labels.onReply),
            emptyLabel: 'Elige',
          },
          { id: uid('responde'), value: s.onReply },
        )}
        ${field(
          {
            name: 'onTakeover',
            label: 'Si alguien del equipo toma el chat',
            type: 'select',
            options: opciones(labels.onReply),
            emptyLabel: 'Elige',
          },
          { id: uid('toma'), value: s.onTakeover },
        )}
      </div>
      ${field(
        {
          name: 'sendHours',
          label: 'Horario de envío',
          type: 'select',
          options: opciones(labels.sendHours),
          emptyLabel: 'Elige',
        },
        { id: uid('horario'), value: s.sendHours },
      )}
      <div class="sq-fila">
        ${field(
          {
            name: 'stopPhrases',
            label: 'Frases de alto (una por renglón)',
            type: 'textarea',
            rows: 4,
            hint: 'Si la persona escribe una de estas frases, la secuencia se detiene.',
          },
          { id: uid('alto'), value: (s.stopPhrases ?? []).join('\n') },
        )}
        ${field(
          {
            name: 'yesPhrases',
            label: 'Frases de sí (una por renglón)',
            type: 'textarea',
            rows: 4,
            hint: 'Se cuentan como «dijo que sí» en los resultados.',
          },
          { id: uid('si'), value: (s.yesPhrases ?? []).join('\n') },
        )}
      </div>
      <div class="sq-fila">
        ${field(
          { name: 'monthlyCap', label: 'Tope de mensajes al mes', type: 'number', min: 1 },
          { id: uid('tope'), value: s.monthlyCap },
        )}
        ${field(
          {
            name: 'resumeAfterHours',
            label: 'Reanudar sola tras horas sin escribir (0 = sólo a mano)',
            type: 'number',
            min: 0,
            max: 168,
          },
          { id: uid('reanudar'), value: s.resumeAfterHours },
        )}
        ${field(
          { name: 'conversionDays', label: 'Días para contar una inscripción', type: 'number', min: 1, max: 60 },
          { id: uid('conversion'), value: s.conversionDays },
        )}
      </div>
      ${field(
        {
          name: 'requireConsent',
          label: 'Plantillas promocionales sólo a quien aceptó recibir mensajes',
          type: 'checkbox',
        },
        { id: uid('consentimiento'), value: s.requireConsent !== false },
      )}
    </div>
    <div class="k-actions sq-pie">
      <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
      <button type="submit" class="k-btn k-btn--primary">Guardar</button>
    </div>
  </form>`;
}

/** Lee el formulario del editor y pone al día el borrador (antes de cada repintado y al guardar). */
function leer(form, b) {
  const v = name => form.elements.namedItem(name);
  const val = name => v(name)?.value ?? '';
  const num = (name, fallback) => {
    const x = Number(val(name));
    return Number.isFinite(x) && val(name) !== '' ? Math.trunc(x) : fallback;
  };
  b.title = val('title');
  b.description = val('description');
  b.courseId = val('courseId');
  b.settings = {
    ...b.settings,
    trigger: val('trigger') || 'manual',
    onReply: val('onReply') || 'pause',
    onTakeover: val('onTakeover') || 'pause',
    sendHours: val('sendHours') || 'business',
    stopPhrases: lineas(val('stopPhrases')),
    yesPhrases: lineas(val('yesPhrases')),
    monthlyCap: num('monthlyCap', 500),
    resumeAfterHours: num('resumeAfterHours', 24),
    conversionDays: num('conversionDays', 7),
    requireConsent: v('requireConsent')?.checked !== false,
  };
  b.steps = b.steps.map((p, i) => {
    const base = val(`base-${i}`) || p.timing.base;
    const timing =
      base === 'edition_start'
        ? {
            base,
            daysBefore: num(`daysBefore-${i}`, p.timing.daysBefore ?? 0),
            at: val(`at-${i}`) || p.timing.at || '10:00',
          }
        : { base, amount: num(`amount-${i}`, p.timing.amount ?? 1), unit: val(`unit-${i}`) || p.timing.unit || 'days' };
    const kind = val(`kind-${i}`) || p.send.kind;
    const send =
      kind === 'template'
        ? { kind, templateId: val(`templateId-${i}`) || (p.send.templateId ?? '') }
        : kind === 'material'
          ? { kind, materialId: val(`materialId-${i}`) || (p.send.materialId ?? '') }
          : { kind: 'text', text: v(`text-${i}`) ? val(`text-${i}`) : (p.send.text ?? '') };
    const whenClosed = val(`whenClosed-${i}`) || p.whenClosed || 'skip';
    return {
      timing,
      send,
      whenClosed,
      fallbackTemplateId: whenClosed === 'template' ? val(`fallbackTemplateId-${i}`) || p.fallbackTemplateId : null,
      condition: p.condition,
    };
  });
  return b;
}

function cuerpoDe(b) {
  return {
    title: b.title,
    description: b.description,
    courseId: b.courseId || null,
    steps: b.steps.map(p => ({ ...p, fallbackTemplateId: p.fallbackTemplateId || undefined })),
    settings: b.settings,
  };
}

function vistaPrevia(datos, p) {
  const r = datos.labels.reasons;
  const resultado = {
    send: 'Recibiría su paso',
    wait: 'Esperaría',
    skip: 'Se omitiría el paso',
    stop: 'Se detendría',
    pause: 'Se pausaría',
    complete: 'Terminaría',
  };
  const excluidos = Object.entries(p.enter.excluded);
  return html`<div class="k-stack">
    <p class="k-hint">Nada de esto se envía ni se guarda: es lo que pasaría ahora mismo.</p>
    <h3 class="sq-titulo">Quién entraría</h3>
    <p>
      ${p.enter.count} ${p.enter.count === 1 ? 'conversación' : 'conversaciones'} de los últimos ${p.sinceDays} días
      ${p.trigger === 'enroll_interest' ? 'preguntaron cómo inscribirse' : 'recibieron la ficha del curso'}.
    </p>
    ${when(p.enter.sample.length, () => html`<ul class="sq-lista">${p.enter.sample.map(x => html`<li>${x.name}</li>`)}</ul>`)}
    ${when(
      excluidos.length,
      () => html`<p class="k-hint">No entrarían: ${excluidos.map(([k, n]) => `${r[k] ?? k} (${n})`).join(' · ')}</p>`,
    )}
    <h3 class="sq-titulo">Quién recibiría su paso ahora</h3>
    ${
      p.due.length
        ? html`<ul class="sq-lista">
            ${p.due.map(
              d =>
                html`<li>
                  <strong>${d.name}</strong> · paso ${d.step + 1}: ${resultado[d.outcome] ?? d.outcome}${
                    d.reason ? ' — ' + (r[d.reason] ?? d.reason) : ''
                  }${d.at ? ' (' + fecha(d.at) + ')' : ''}
                </li>`,
            )}
          </ul>`
        : html`<p class="k-hint">Nadie tiene un paso pendiente en este momento.</p>`
    }
  </div>`;
}

function resultados(r) {
  const tile = (label, value) =>
    html`<div class="k-tile"><span class="k-tile__label">${label}</span><span class="k-tile__value">${value}</span></div>`;
  return html`<div class="k-stack">
    <div class="k-tiles">
      ${tile('Inscritas', r.enrolled)} ${tile('Enviados', r.sent)} ${tile('Respondieron', r.replied)}
      ${tile('Dijeron sí', r.saidYes)} ${tile('Dijeron no', r.saidNo)}
    </div>
    <div class="k-data__wrap">
      <table class="k-data">
        <caption class="k-sr">Resultados por paso</caption>
        <thead>
          <tr>
            <th scope="col">Paso</th>
            <th scope="col">Cuándo</th>
            <th scope="col" class="k-num">Enviados</th>
            <th scope="col" class="k-num">Respondieron</th>
            <th scope="col" class="k-num">Sí</th>
            <th scope="col" class="k-num">No</th>
            <th scope="col" class="k-num">Se inscribieron en ${r.conversionDays} días</th>
            <th scope="col">Omitidos</th>
          </tr>
        </thead>
        <tbody>
          ${r.steps.map(
            s => html`<tr>
              <th scope="row">${s.index + 1}</th>
              <td>${s.when}</td>
              <td class="k-num">${s.sent}</td>
              <td class="k-num">${s.replied}</td>
              <td class="k-num">${s.saidYes}</td>
              <td class="k-num">${s.saidNo}</td>
              <td class="k-num">${s.converted}</td>
              <td>${
                Object.values(s.skipped)
                  .map(x => `${x.label} (${x.n})`)
                  .join(' · ') || '—'
              }</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
    <h3 class="sq-titulo">Por qué se detuvieron o pausaron</h3>
    ${
      r.stopped.length
        ? html`<ul class="sq-lista">${r.stopped.map(x => html`<li>${x.label} — ${x.n}${x.state === 'paused' ? ' (en pausa)' : ''}</li>`)}</ul>`
        : html`<p class="k-hint">Ninguna todavía.</p>`
    }
  </div>`;
}

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let datos = null;
    let listas = null;
    let marca = ctx.keep.get('marca') ?? null;
    let borrador = ctx.keep.get('borrador') ?? null;
    let problemas = [];
    let guardando = false;
    let vivo = true;
    const guardarRef = { ref: null, clave: '' };

    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">WhatsApp</span>
            <h1>Secuencias de seguimiento</h1>
            <p class="k-lead">
              Mensajes que salen solos en los días siguientes a que alguien pide información, hasta que se inscribe,
              dice que no o alguien del equipo toma la conversación.
            </p>
          </div>
          <div class="k-actions" data-slot="acciones"></div>
        </header>
        <div class="k-stack" data-slot="cuerpo"></div>
      </section>`,
    );
    const acciones = root.querySelector('[data-slot="acciones"]');
    const cuerpo = root.querySelector('[data-slot="cuerpo"]');
    const marcaActual = () => datos?.brands.find(b => b.id === marca) ?? null;
    const puede = () => Boolean(marcaActual()?.canManage);

    function pintar() {
      if (!datos) return;
      const m = marcaActual();
      render(
        acciones,
        when(
          puede() && !borrador,
          () => html`<button type="button" class="k-btn k-btn--primary" data-do="nueva">Nueva secuencia</button>`,
        ),
      );
      const selector = when(
        datos.brands.length > 1 && !borrador,
        () => html`<form class="k-card" novalidate data-do="marca">
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
      );
      const aviso = when(
        m && !m.attending.speaks,
        () => html`<div class="k-notice k-notice--warn" role="status">
          Las secuencias de ${m.name} no envían nada: la automatización de la marca está apagada o su asistente no
          responde solo (debe estar en «Plantillas» o «Autónomo»).
        </div>`,
      );
      if (borrador) {
        render(cuerpo, html`${aviso}${editorHtml(borrador, datos, listas ?? {}, ctx.uid, problemas)}`);
        return;
      }
      const lista = datos.sequences.filter(s => s.brandId === marca);
      render(
        cuerpo,
        html`${selector}${aviso}
          ${
            lista.length
              ? html`<ul class="sq-tarjetas">
                  ${lista.map(
                    s => html`<li class="k-card sq-tarjeta" data-key="${s.id}">
                      <div class="sq-tarjeta__head">
                        <h2 class="sq-titulo">${s.title}</h2>
                        <span class="${['k-chip', s.enabled ? 'k-chip--ok' : '']}">
                          ${s.archived ? 'Archivada' : s.enabled ? 'Encendida' : 'Apagada'}
                        </span>
                      </div>
                      <p class="k-hint">
                        ${s.steps.length} ${s.steps.length === 1 ? 'paso' : 'pasos'} ·
                        ${datos.labels.triggers[s.settings.trigger] ?? ''}${s.courseTitle ? ' · ' + s.courseTitle : ''}
                      </p>
                      <ol class="sq-resumen">${s.steps.map(p => html`<li>${p.when}</li>`)}</ol>
                      <div class="k-actions sq-tarjeta__acciones">
                        ${when(
                          puede() && !s.archived,
                          () => html`<button type="button" class="k-btn" data-do="editar" data-id="${s.id}">Editar</button>
                            <button type="button" class="k-btn" data-do="${s.enabled ? 'apagar' : 'encender'}" data-id="${s.id}">
                              ${s.enabled ? 'Apagar' : 'Encender'}
                            </button>`,
                        )}
                        <button type="button" class="k-btn" data-do="previa" data-id="${s.id}">Vista previa</button>
                        <button type="button" class="k-btn" data-do="resultados" data-id="${s.id}">Resultados</button>
                        ${when(
                          puede() && !s.archived,
                          () =>
                            html`<button type="button" class="k-btn" data-do="archivar" data-id="${s.id}">Archivar</button>`,
                        )}
                      </div>
                    </li>`,
                  )}
                </ul>`
              : empty({
                  title: 'Esta marca todavía no tiene secuencias',
                  text: puede()
                    ? 'Crea la primera con «Nueva secuencia»: por ejemplo, un mensaje al día siguiente y otro dos días antes del curso.'
                    : 'Administración las crea; aquí verás sus resultados.',
                })
          }`,
      );
    }

    async function cargarListas() {
      listas = null;
      try {
        listas = (await api.get('/api/sequences/lists', { brand: marca })).lists;
      } catch (error) {
        if (!isAbort(error)) ctx.toast(error.message);
        listas = {};
      }
    }

    async function cargar() {
      render(cuerpo, loading('Cargando las secuencias…'));
      try {
        datos = await api.get('/api/sequences');
      } catch (error) {
        if (vivo && !isAbort(error)) render(cuerpo, failure({ error, retry: 'reintentar' }));
        return;
      }
      if (!vivo) return;
      if (!datos.brands.some(b => b.id === marca))
        marca = datos.brands.some(b => b.id === ctx.brand) ? ctx.brand : (datos.brands[0]?.id ?? null);
      if (borrador) await cargarListas();
      pintar();
    }
    const recargar = async () => {
      datos = await api.get('/api/sequences');
      if (vivo) pintar();
    };
    const buscar = id => datos?.sequences.find(s => s.id === id) ?? null;
    const sincronizar = () => {
      const form = cuerpo.querySelector('form[data-do="editor"]');
      if (form && borrador) leer(form, borrador);
      ctx.keep.set('borrador', borrador);
    };
    async function abrirEditor(s) {
      borrador = borradorDe(s);
      problemas = [];
      ctx.keep.set('borrador', borrador);
      await cargarListas();
      pintar();
      cuerpo.querySelector('[name="title"]')?.focus();
    }
    function cerrarEditor() {
      borrador = null;
      problemas = [];
      ctx.keep.delete('borrador');
      pintar();
    }
    async function cambiarEstado(s, accion, texto) {
      const r = await api.post(`/api/sequences/${s.id}/${accion}`, { expectedRevision: s.revision });
      ctx.toast(texto + (r.stopped ? ` Se detuvieron ${r.stopped} inscripciones en curso.` : ''));
      await recargar();
    }

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            nueva: () => abrirEditor(null),
            editar: (_e, b) => abrirEditor(buscar(b.getAttribute('data-id'))),
            cancelar: cerrarEditor,
            agregar() {
              sincronizar();
              borrador.steps.push(nuevoPaso());
              pintar();
            },
            quitar(_e, b) {
              sincronizar();
              borrador.steps.splice(Number(b.getAttribute('data-index')), 1);
              pintar();
            },
            subir(_e, b) {
              sincronizar();
              const i = Number(b.getAttribute('data-index'));
              if (i > 0) [borrador.steps[i - 1], borrador.steps[i]] = [borrador.steps[i], borrador.steps[i - 1]];
              pintar();
            },
            bajar(_e, b) {
              sincronizar();
              const i = Number(b.getAttribute('data-index'));
              if (i < borrador.steps.length - 1)
                [borrador.steps[i + 1], borrador.steps[i]] = [borrador.steps[i], borrador.steps[i + 1]];
              pintar();
            },
            async encender(_e, b) {
              await cambiarEstado(buscar(b.getAttribute('data-id')), 'enable', 'Secuencia encendida.');
            },
            async apagar(_e, b) {
              const s = buscar(b.getAttribute('data-id'));
              const seguro = await confirm({
                title: `¿Apagar «${s.title}»?`,
                message: 'Las personas que van a la mitad dejan de recibir mensajes y su inscripción queda detenida.',
                confirmLabel: 'Apagar',
                danger: true,
              });
              if (seguro) await cambiarEstado(s, 'disable', 'Secuencia apagada.');
            },
            async archivar(_e, b) {
              const s = buscar(b.getAttribute('data-id'));
              const seguro = await confirm({
                title: `¿Archivar «${s.title}»?`,
                message: 'Se apaga, deja de aparecer en la lista y sus resultados se conservan.',
                confirmLabel: 'Archivar',
                danger: true,
              });
              if (seguro) await cambiarEstado(s, 'archive', 'Secuencia archivada.');
            },
            async previa(_e, b) {
              const s = buscar(b.getAttribute('data-id'));
              const { preview } = await api.post(`/api/sequences/${s.id}/preview`, {});
              await dialog({
                title: `Vista previa: ${s.title}`,
                content: vistaPrevia(datos, preview),
                actions: [{ id: 'ok', label: 'Cerrar', primary: true }],
                wide: true,
              });
            },
            async resultados(_e, b) {
              const s = buscar(b.getAttribute('data-id'));
              const { results } = await api.get(`/api/sequences/${s.id}/results`);
              await dialog({
                title: `Resultados: ${s.title}`,
                content: resultados(results),
                actions: [{ id: 'ok', label: 'Cerrar', primary: true }],
                wide: true,
              });
            },
          },
          change: {
            marca(_e, form) {
              marca = form.elements.namedItem('marca').value;
              ctx.keep.set('marca', marca);
              pintar();
            },
            // Cambiar «cuándo», «qué envía» o «ventana cerrada» cambia los campos del paso: se repinta.
            editor(event) {
              if (/^(base|kind|whenClosed)-\d+$/.test(event.target?.name ?? '')) {
                sincronizar();
                pintar();
              } else sincronizar();
            },
          },
          submit: {
            async editor(event, form) {
              event.preventDefault();
              if (guardando) return;
              leer(form, borrador);
              const cuerpoPeticion = cuerpoDe(borrador);
              const clave = JSON.stringify(cuerpoPeticion);
              if (guardarRef.clave !== clave) Object.assign(guardarRef, { ref: newClientRef(), clave });
              guardando = true;
              try {
                if (borrador.id)
                  await api.put(`/api/sequences/${borrador.id}`, {
                    ...cuerpoPeticion,
                    expectedRevision: borrador.revision,
                  });
                else await api.post('/api/sequences', { ...cuerpoPeticion, brandId: marca, clientRef: guardarRef.ref });
                guardarRef.clave = '';
                ctx.toast('Secuencia guardada. Nace apagada: enciéndela cuando esté lista.');
                cerrarEditor();
                await recargar();
              } catch (error) {
                if (isAbort(error)) return;
                problemas =
                  error.status === 409
                    ? ['Alguien más guardó esta secuencia. Cancela y vuelve a abrirla para ver sus cambios.']
                    : (error.data?.details?.problems ?? [error.message]);
                pintar();
                cuerpo.querySelector('[role="alert"]')?.scrollIntoView?.({ block: 'nearest' });
              } finally {
                guardando = false;
              }
            },
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );

    enVivo = { marca: () => marca, recargar: () => !borrador && recargar().catch(() => {}) };
    ctx.onUnmount(() => {
      vivo = false;
      enVivo = null;
      if (borrador) sincronizar();
    });
    cargar();
  },

  /** Otra persona cambió una secuencia de la marca que se está viendo: se vuelve a pedir la lista (no con el editor abierto). */
  onEvent(evento) {
    if (evento?.type === 'sequences.changed' && evento.brandId === enVivo?.marca()) enVivo.recargar();
  },
};
