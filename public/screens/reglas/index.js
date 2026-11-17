/**
 * «Reglas por mensaje» (docs/PLAN_REGLAS.md): respuestas ligeras sin dibujar un recorrido entero.
 *
 * Una regla dice «cuando un mensaje tiene estas palabras (y, si se quiere, estas condiciones), haz estas acciones».
 * La pantalla muestra, por marca:
 *   - el ORDEN DE ATENCIÓN: quién contesta primero cuando varias cosas aplican (persona → recorrido en curso → reglas
 *     → recorrido que arranca → asistente), con el estado real de la marca;
 *   - la LISTA de reglas en su orden, con subir y bajar (cada movimiento guarda con el candado del orden), encender,
 *     pausar, editar, bitácora y archivar;
 *   - «PROBAR con un mensaje»: qué pasaría con un texto de ejemplo, sin enviar nada;
 *   - el tope de respuestas seguidas de reglas por conversación.
 * El editor va en una ventana. Toda la validación real la hace el servidor (/api/rules); aquí sólo se arma la forma.
 */
import { attrs, html, render, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { isAbort, isStale, newClientRef } from '../../kit/api.js';
import { field } from '../../kit/components/form.js';
import { confirm, dialog } from '../../kit/components/dialog.js';
import { failure, loading } from '../../kit/components/feedback.js';
import { glyph } from '../../kit/glyphs.js';

const ESTADO = { draft: 'Borrador', active: 'Encendida', paused: 'En pausa', archived: 'Archivada' };
const TONO = { draft: '', active: 'k-chip--ok', paused: 'k-chip--warn', archived: '' };
const RESULTADO = {
  executed: 'Hizo todo',
  partial: 'Hizo una parte',
  skipped: 'No hizo nada',
  failed: 'Falló',
};
const QUIEN = {
  person: 'Una persona del equipo',
  assistant: 'El asistente de la marca',
  flow_in_progress: 'El recorrido en curso',
  rule: 'Una regla',
  flow_start: 'Un recorrido que arranca',
};
const PASO = { answers: 'Atiende', pass: 'Sigue', skip: 'No aplica' };

/** Lo vivo de este montaje, para que onEvent() llegue a la pantalla. */
let enVivo = null;

const fecha = ms =>
  ms ? new Date(ms).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : 'Todavía no';
const renglones = texto =>
  String(texto ?? '')
    .split(/[\n,]/)
    .map(x => x.trim())
    .filter(Boolean);

// ---- del formulario del editor a la definición y de vuelta

const vacia = () => ({
  title: '',
  triggerType: 'keyword',
  mode: 'contains',
  words: '',
  threshold: 80,
  channels: [],
  courses: [],
  hours: '',
  tags: [],
  firstMessage: false,
  extra: [],
  actions: [{ type: 'send_text', text: '' }],
  stop: false,
  limit: 'always',
  cooldownMinutes: 60,
});

/** Lee una definición guardada. Las condiciones que la pantalla no sabe pintar se conservan tal cual (`extra`). */
function desdeDefinicion(regla) {
  const d = regla.definition;
  const b = { ...vacia(), title: regla.title };
  b.triggerType = d.trigger.type;
  if (d.trigger.type === 'keyword') {
    b.mode = d.trigger.mode;
    b.words = d.trigger.words.join('\n');
    b.threshold = d.trigger.threshold ?? 80;
  }
  const reglas = d.conditions?.match === 'all' && d.conditions.groups.length === 1 ? d.conditions.groups[0] : null;
  if (d.conditions && (!reglas || reglas.match !== 'all')) b.extra = [d.conditions];
  for (const r of reglas?.rules ?? []) {
    if (r.field === 'channel' && r.op === 'in') b.channels = r.value;
    else if (r.field === 'course' && r.op === 'in') b.courses = r.value;
    else if (r.field === 'hours') b.hours = r.value;
    else if (r.field === 'tags' && r.op === 'any') b.tags = r.value;
    else if (r.field === 'first_message' && r.value === true) b.firstMessage = true;
    else b.extra.push(r);
  }
  b.actions = d.actions.map(a => ({ ...a }));
  b.stop = d.options.stop;
  b.limit = d.options.limit;
  b.cooldownMinutes = d.options.cooldownMinutes ?? 60;
  return b;
}

function aDefinicion(b) {
  const trigger =
    b.triggerType === 'any_message'
      ? { type: 'any_message' }
      : {
          type: 'keyword',
          mode: b.mode,
          words: renglones(b.words),
          ...(b.mode === 'fuzzy' ? { threshold: Number(b.threshold) } : {}),
        };
  const rules = [];
  if (b.channels.length) rules.push({ field: 'channel', op: 'in', value: b.channels });
  if (b.courses.length) rules.push({ field: 'course', op: 'in', value: b.courses });
  if (b.hours) rules.push({ field: 'hours', op: 'eq', value: b.hours });
  if (b.tags.length) rules.push({ field: 'tags', op: 'any', value: b.tags });
  if (b.firstMessage) rules.push({ field: 'first_message', op: 'is', value: true });
  const sueltas = b.extra.filter(x => x.field);
  const grupos = b.extra.filter(x => x.groups);
  let conditions = null;
  if (grupos.length) conditions = grupos[0];
  else if (rules.length || sueltas.length)
    conditions = { version: 1, match: 'all', groups: [{ match: 'all', rules: [...rules, ...sueltas] }] };
  const options = { stop: b.stop, limit: b.limit };
  if (b.limit === 'cooldown') options.cooldownMinutes = Number(b.cooldownMinutes);
  return { v: 1, trigger, conditions, actions: b.actions, options };
}

/** Pasa lo escrito en el formulario al borrador (las acciones van como a0_type, a0_text…). Las casillas se leen
 * del formulario: con una sola casilla de un nombre, formValues() devuelve sí o no y no su valor. */
function leer(b, valores, formulario) {
  const lista = nombre => Array.from(formulario.querySelectorAll(`input[name="${nombre}"]:checked`), x => x.value);
  const n = b.actions.length;
  const actions = [];
  for (let i = 0; i < n; i++) {
    const type = valores[`a${i}_type`] || b.actions[i].type;
    const a = { type };
    if (type === 'send_text') a.text = valores[`a${i}_text`] ?? '';
    if (type === 'send_material') a.materialId = valores[`a${i}_material`] ?? '';
    if (type === 'start_flow') a.flowId = valores[`a${i}_flow`] ?? '';
    if (type === 'add_tag' || type === 'remove_tag') a.tagId = valores[`a${i}_tag`] ?? '';
    if (type === 'handoff') {
      a.to = valores[`a${i}_to`] === 'user' ? 'user' : 'queue';
      if (a.to === 'user') a.userId = valores[`a${i}_user`] ?? '';
      const aviso = valores[`a${i}_text`] ?? '';
      if (aviso.trim()) a.text = aviso;
    }
    if (type === 'set_status') a.status = valores[`a${i}_status`] || 'pending';
    actions.push(a);
  }
  return {
    ...b,
    title: valores.title ?? b.title,
    triggerType: valores.triggerType || b.triggerType,
    mode: valores.mode || b.mode,
    words: valores.words ?? b.words,
    threshold: valores.threshold ?? b.threshold,
    channels: lista('channels'),
    courses: lista('courses'),
    hours: valores.hours ?? '',
    tags: lista('tags'),
    firstMessage: valores.firstMessage === true,
    actions,
    stop: valores.stop === true,
    limit: valores.limit || 'always',
    cooldownMinutes: valores.cooldownMinutes ?? b.cooldownMinutes,
  };
}

// ---- piezas del editor

const opciones = (items, valor, vacio) => html`${when(vacio, () => html`<option value="">${vacio}</option>`)}
  ${items.map(x => html`<option value="${x.value}" ${attrs({ selected: String(x.value) === String(valor ?? '') })}>${x.label}</option>`)}`;

function casillas(nombre, items, marcadas, id) {
  return html`<div class="rg-casillas">
    ${items.map(
      (x, i) =>
        html`<label class="k-check rg-casilla" for="${id + '-' + i}">
          <input type="checkbox" id="${id + '-' + i}" name="${nombre}" value="${x.value}" ${attrs({ checked: marcadas.includes(x.value) })} />
          <span>${x.label}</span>
        </label>`,
    )}
  </div>`;
}

function accion(a, i, listas, uid) {
  const id = uid(`a${i}`);
  const tipos = listas.actions.map(x => ({ value: x.type, label: x.label }));
  let detalle = html``;
  if (a.type === 'send_text')
    detalle = html`<label class="k-label" for="${id + '-texto'}">Texto</label>
      <textarea class="k-input" id="${id + '-texto'}" name="${`a${i}_text`}" rows="3" maxlength="4096">${a.text ?? ''}</textarea>
      <p class="k-hint">Puedes usar {{nombre}}, {{curso}}, {{precio}}, {{fecha}}… El precio siempre sale del catálogo.</p>`;
  else if (a.type === 'send_material')
    detalle = html`<label class="k-label" for="${id + '-material'}">Material aprobado</label>
      <select class="k-input" id="${id + '-material'}" name="${`a${i}_material`}">
        ${opciones(
          listas.materials.map(m => ({ value: m.id, label: m.name })),
          a.materialId,
          listas.materials.length ? 'Elige un material' : 'No hay materiales aprobados',
        )}
      </select>`;
  else if (a.type === 'start_flow')
    detalle = html`<label class="k-label" for="${id + '-flujo'}">Recorrido publicado</label>
      <select class="k-input" id="${id + '-flujo'}" name="${`a${i}_flow`}">
        ${opciones(
          listas.flows.map(f => ({ value: f.id, label: f.active ? f.name : f.name + ' (sin activar)' })),
          a.flowId,
          listas.flows.length ? 'Elige un recorrido' : 'No hay recorridos publicados',
        )}
      </select>`;
  else if (a.type === 'add_tag' || a.type === 'remove_tag')
    detalle = html`<label class="k-label" for="${id + '-etiqueta'}">Etiqueta</label>
      <select class="k-input" id="${id + '-etiqueta'}" name="${`a${i}_tag`}">
        ${opciones(
          listas.tags.map(t => ({ value: t.id, label: t.name })),
          a.tagId,
          listas.tags.length ? 'Elige una etiqueta' : 'La marca no tiene etiquetas',
        )}
      </select>`;
  else if (a.type === 'handoff')
    detalle = html`<label class="k-label" for="${id + '-a'}">A quién</label>
      <select class="k-input" id="${id + '-a'}" name="${`a${i}_to`}">
        ${opciones(
          [
            { value: 'queue', label: 'A la cola del equipo' },
            { value: 'user', label: 'A una persona' },
          ],
          a.to ?? 'queue',
        )}
      </select>
      ${when(
        a.to === 'user',
        () => html`<label class="k-label" for="${id + '-persona'}">Persona</label>
          <select class="k-input" id="${id + '-persona'}" name="${`a${i}_user`}">
            ${opciones(
              listas.users.filter(u => u.active).map(u => ({ value: u.id, label: u.name })),
              a.userId,
              'Elige a alguien',
            )}
          </select>`,
      )}
      <label class="k-label" for="${id + '-aviso'}">Aviso a la persona (opcional)</label>
      <textarea class="k-input" id="${id + '-aviso'}" name="${`a${i}_text`}" rows="2" maxlength="4096">${a.text ?? ''}</textarea>`;
  else if (a.type === 'set_status')
    detalle = html`<label class="k-label" for="${id + '-estado'}">Estado</label>
      <select class="k-input" id="${id + '-estado'}" name="${`a${i}_status`}">
        ${opciones(
          Object.entries(listas.statuses).map(([value, label]) => ({ value, label })),
          a.status ?? 'pending',
        )}
      </select>
      <p class="k-hint">«Pendiente» espera algo de la persona; «Resuelta» cierra la atención. No se envía nada.</p>`;
  return html`<li class="rg-accion" data-key="${'accion-' + i}">
    <div class="rg-accion__cabeza">
      <label class="k-label" for="${id + '-tipo'}">Acción ${i + 1}</label>
      <select class="k-input" id="${id + '-tipo'}" name="${`a${i}_type`}">${opciones(tipos, a.type)}</select>
      <button type="button" class="k-btn k-btn--ghost k-btn--icon" data-do="quitar-accion" data-i="${i}" aria-label="${'Quitar la acción ' + (i + 1)}">
        ${glyph('x')}
      </button>
    </div>
    <div class="rg-accion__detalle">${detalle}</div>
  </li>`;
}

function editor(b, listas, uid, problemas, prueba) {
  const modos = Object.entries(listas.modes).map(([value, label]) => ({ value, label }));
  return html`<form class="rg-editor" data-do="guardar" novalidate>
    ${field({ name: 'title', label: 'Nombre de la regla', required: true, maxlength: 80 }, { id: uid('nombre'), value: b.title })}
    <fieldset class="k-fieldset rg-bloque">
      <legend class="k-label">Cuándo</legend>
      <label class="k-label" for="${uid('disparador')}">Se activa con</label>
      <select class="k-input" id="${uid('disparador')}" name="triggerType">
        ${opciones(
          Object.entries(listas.triggers).map(([value, label]) => ({ value, label })),
          b.triggerType,
        )}
      </select>
      ${when(
        b.triggerType === 'keyword',
        () => html`<label class="k-label" for="${uid('modo')}">Cómo se compara</label>
          <select class="k-input" id="${uid('modo')}" name="mode">${opciones(modos, b.mode)}</select>
          <label class="k-label" for="${uid('palabras')}">Palabras clave</label>
          <textarea class="k-input" id="${uid('palabras')}" name="words" rows="3" maxlength="2000">${b.words}</textarea>
          <p class="k-hint">Una por renglón o separadas por comas. No importan mayúsculas, acentos ni signos.</p>
          ${when(b.mode === 'fuzzy', () =>
            field(
              { name: 'threshold', label: 'Parecido mínimo (60 a 95)', type: 'number', min: 60, max: 95, step: 1 },
              { id: uid('parecido'), value: b.threshold },
            ),
          )}`,
        () => html`<p class="k-hint">Con «Cualquier mensaje» conviene añadir condiciones: si no, responde a todo.</p>`,
      )}
    </fieldset>
    <fieldset class="k-fieldset rg-bloque">
      <legend class="k-label">Sólo si (opcional)</legend>
      <p class="k-hint">Canal</p>
      ${casillas(
        'channels',
        Object.entries(listas.channels).map(([value, label]) => ({ value, label })),
        b.channels,
        uid('canal'),
      )}
      ${when(
        listas.courses.length,
        () => html`<p class="k-hint">Curso de la conversación</p>
          ${casillas(
            'courses',
            listas.courses.map(k => ({ value: k.id, label: k.name })),
            b.courses,
            uid('curso'),
          )}`,
      )}
      <label class="k-label" for="${uid('horario')}">Horario de atención</label>
      <select class="k-input" id="${uid('horario')}" name="hours">
        ${opciones(
          [
            { value: 'open', label: 'Sólo en horario' },
            { value: 'closed', label: 'Sólo fuera de horario' },
          ],
          b.hours,
          'A cualquier hora',
        )}
      </select>
      ${when(
        listas.tags.length,
        () => html`<p class="k-hint">El contacto tiene alguna de estas etiquetas</p>
          ${casillas(
            'tags',
            listas.tags.map(t => ({ value: t.id, label: t.name })),
            b.tags,
            uid('etiqueta'),
          )}`,
      )}
      ${field(
        { name: 'firstMessage', label: 'Sólo con el primer mensaje de la conversación', type: 'checkbox' },
        { id: uid('primero'), value: b.firstMessage },
      )}
      ${when(b.extra.length, () => html`<p class="k-hint">Esta regla tiene además condiciones avanzadas; se conservan al guardar.</p>`)}
    </fieldset>
    <fieldset class="k-fieldset rg-bloque">
      <legend class="k-label">Entonces</legend>
      <p class="k-hint">Primero corren las silenciosas (etiquetas), luego los mensajes y al final pasar o cambiar el estado.</p>
      <ol class="rg-acciones">
        ${b.actions.map((a, i) => accion(a, i, listas, uid))}
      </ol>
      <button type="button" class="k-btn" data-do="agregar-accion" ${attrs({ disabled: b.actions.length >= listas.limits.actions })}>
        ${glyph('plus')} Agregar acción
      </button>
    </fieldset>
    <fieldset class="k-fieldset rg-bloque">
      <legend class="k-label">Frecuencia</legend>
      <label class="k-label" for="${uid('limite')}">¿Cuántas veces en una conversación?</label>
      <select class="k-input" id="${uid('limite')}" name="limit">
        ${opciones(
          Object.entries(listas.limitKinds).map(([value, label]) => ({ value, label })),
          b.limit,
        )}
      </select>
      ${when(b.limit === 'cooldown', () =>
        field(
          { name: 'cooldownMinutes', label: 'Descanso en minutos', type: 'number', min: 1, max: 10080, step: 1 },
          { id: uid('descanso'), value: b.cooldownMinutes },
        ),
      )}
      ${field(
        { name: 'stop', label: 'Si coincide, no revisar las reglas de abajo', type: 'checkbox' },
        { id: uid('parar'), value: b.stop },
      )}
    </fieldset>
    ${when(
      problemas.length,
      () => html`<div class="k-notice k-notice--bad" role="alert">
        <p>No se pudo guardar:</p>
        <ul>${problemas.map(p => html`<li>${p}</li>`)}</ul>
      </div>`,
    )}
    <div class="rg-probar-editor">
      <label class="k-label" for="${uid('ensayo')}">Probar esta regla con un mensaje</label>
      <div class="rg-fila">
        <input class="k-input" id="${uid('ensayo')}" name="ensayo" maxlength="300" autocomplete="off" />
        <button type="button" class="k-btn" data-do="ensayar">Probar</button>
      </div>
      <p class="k-hint" role="status" data-ensayo>${prueba}</p>
    </div>
    <div class="k-form__actions">
      <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
      <button type="submit" class="k-btn k-btn--primary">Guardar</button>
    </div>
  </form>`;
}

/** Ventana del editor. Devuelve la regla guardada o null. */
function ventana({ api, ctx, marca, listas, regla }) {
  const nueva = !regla;
  let b = nueva ? vacia() : desdeDefinicion(regla);
  let problemas = [];
  let prueba = '';
  const clientRef = newClientRef();
  const uid = nombre => ctx.uid('ed-' + nombre);
  return dialog({
    title: nueva ? 'Nueva regla' : `Editar «${regla.title}»`,
    wide: true,
    mount(cuerpo, cerrar) {
      const pintar = () => render(cuerpo, editor(b, listas, uid, problemas, prueba));
      const formulario = () => cuerpo.querySelector('form');
      const actualizar = () => {
        b = leer(b, formValues(formulario()), formulario());
      };
      pintar();
      return listen(
        cuerpo,
        {
          change: {
            guardar() {
              actualizar();
              pintar();
            },
          },
          input: { guardar: actualizar },
          click: {
            cancelar: () => cerrar(null),
            'agregar-accion'() {
              actualizar();
              b.actions.push({ type: 'send_text', text: '' });
              pintar();
            },
            'quitar-accion'(_e, boton) {
              actualizar();
              b.actions.splice(Number(boton.getAttribute('data-i')), 1);
              pintar();
            },
            async ensayar() {
              actualizar();
              const texto = formValues(formulario()).ensayo;
              if (!String(texto ?? '').trim()) return;
              try {
                const r = await api.post('/api/rules/test', {
                  brandId: marca,
                  text: texto,
                  courseId: b.courses[0] || listas.courses[0]?.id || undefined,
                  channel: b.channels[0] || 'whatsapp',
                  firstMessage: b.firstMessage,
                  hours: b.hours || undefined,
                  tags: b.tags,
                  draft: { ruleId: regla?.id, title: b.title, definition: aDefinicion(b) },
                });
                const mia = r.rules.find(x => x.draft);
                prueba = !mia?.matched
                  ? `No coincide: ${mia?.reason ?? 'la regla no se revisó.'} Contestaría: ${QUIEN[r.answeredBy] ?? r.answeredBy}.`
                  : mia.voice
                    ? `Coincide y responde. ${mia.actions.find(a => a.preview)?.preview ?? ''}`.trim()
                    : `Coincide; sus acciones: ${mia.actions.map(a => a.label + (a.would ? '' : ' (no: ' + a.reason + ')')).join(', ')}. Contestaría: ${QUIEN[r.answeredBy] ?? r.answeredBy}.`;
                problemas = [];
              } catch (error) {
                prueba = '';
                problemas = error.data?.details?.problems ?? [error.message];
              }
              pintar();
            },
          },
          submit: {
            async guardar(_e, f, valores) {
              b = leer(b, valores, f);
              const cuerpoPeticion = { title: b.title, definition: aDefinicion(b) };
              try {
                const r = nueva
                  ? await api.post('/api/rules', { brandId: marca, ...cuerpoPeticion, clientRef })
                  : await api.patch('/api/rules/' + regla.id, { ...cuerpoPeticion, expectedRevision: regla.revision });
                cerrar(r.rule);
              } catch (error) {
                if (isStale(error)) {
                  ctx.toast('Alguien más cambió esta regla. Ciérrala y vuelve a abrirla para ver sus cambios.');
                  return;
                }
                problemas = error.data?.details?.problems ?? error.data?.details?.issues ?? [error.message];
                pintar();
              }
            },
          },
        },
        { onError: error => ctx.toast(error.message) },
      );
    },
  });
}

// ---- pantalla

function orden(datos) {
  const a = datos.attention;
  return html`<section class="k-card rg-orden">
    <h2 class="k-card__title">Orden de atención</h2>
    <p class="k-hint">Cuando llega un mensaje, contesta el primero de esta lista que aplique.</p>
    ${when(a.status.why, () => html`<div class="k-notice k-notice--warn"><p>${a.status.why}</p></div>`)}
    <ol class="rg-pasos">
      ${a.steps.map(
        (p, i) => html`<li class="rg-paso" data-key="${p.key}">
          <span class="rg-paso__num" aria-hidden="true">${i + 1}</span>
          <div class="rg-paso__texto">
            <strong>${p.label}</strong>
            <span class="${['k-chip', p.on ? 'k-chip--ok' : '']}">${p.on ? 'En uso' : 'Sin efecto ahora'}</span>
            <p class="k-hint">${p.detail}</p>
            ${when(
              p.items?.length,
              () => html`<ul class="rg-paso__items">
                ${p.items.map(x => html`<li>${x.title}${x.start ? ' · ' + x.start : ''}</li>`)}
              </ul>`,
            )}
          </div>
        </li>`,
      )}
    </ol>
  </section>`;
}

function fila(r, i, total, puede) {
  return html`<li class="rg-regla" data-key="${r.id}">
    <div class="rg-regla__orden">
      <span class="rg-regla__num">${i + 1}</span>
      ${when(
        puede,
        () => html`<button type="button" class="k-btn k-btn--ghost k-btn--icon" data-do="subir" data-id="${r.id}" aria-label="${'Subir «' + r.title + '»'}" ${attrs({ disabled: i === 0 })}>${glyph('up')}</button>
          <button type="button" class="k-btn k-btn--ghost k-btn--icon" data-do="bajar" data-id="${r.id}" aria-label="${'Bajar «' + r.title + '»'}" ${attrs({ disabled: i === total - 1 })}>${glyph('down')}</button>`,
      )}
    </div>
    <div class="rg-regla__cuerpo">
      <div class="rg-regla__titulo">
        <strong>${r.title}</strong>
        <span class="${['k-chip', TONO[r.status]]}">${ESTADO[r.status] ?? r.status}</span>
        ${when(!r.speaks, () => html`<span class="k-chip">Silenciosa</span>`)}
      </div>
      <p class="rg-regla__resumen">${r.summary.when} → ${r.summary.what}</p>
      <p class="k-hint">Hizo algo ${r.executions} ${r.executions === 1 ? 'vez' : 'veces'} · Última: ${fecha(r.lastRunAt)}</p>
      ${when(r.lastError, () => html`<p class="k-error">Último fallo: ${r.lastError}</p>`)}
      ${when(r.issues.length, () => html`<p class="k-error">${r.issues[0]}</p>`)}
      <div class="rg-regla__acciones">
        ${when(
          puede,
          () => html`<button type="button" class="k-btn" data-do="editar" data-id="${r.id}">Editar</button>
            ${
              r.status === 'active'
                ? html`<button type="button" class="k-btn" data-do="pausar" data-id="${r.id}">Pausar</button>`
                : html`<button type="button" class="k-btn" data-do="encender" data-id="${r.id}">Encender</button>`
            }`,
        )}
        <button type="button" class="k-btn" data-do="bitacora" data-id="${r.id}">Bitácora</button>
        ${when(
          puede,
          () =>
            html`<button type="button" class="k-btn k-btn--ghost" data-do="archivar" data-id="${r.id}">Archivar</button>`,
        )}
      </div>
    </div>
  </li>`;
}

function probar(datos, listas, uid, resultado) {
  return html`<section class="k-card rg-probar">
    <h2 class="k-card__title">Probar con un mensaje</h2>
    <p class="k-hint">Dice quién contestaría y qué haría cada regla. No envía ni guarda nada.</p>
    <form class="rg-probar__form" data-do="probar" novalidate>
      ${field({ name: 'text', label: 'Mensaje de ejemplo', required: true, maxlength: 300 }, { id: uid('texto'), value: '' })}
      <div class="rg-probar__opciones">
        ${field(
          {
            name: 'channel',
            label: 'Canal',
            type: 'select',
            emptyLabel: 'WhatsApp',
            options: Object.entries(listas.channels)
              .filter(([v]) => v !== 'whatsapp')
              .map(([value, label]) => ({ value, label })),
          },
          { id: uid('canal') },
        )}
        ${field(
          {
            name: 'courseId',
            label: 'Curso',
            type: 'select',
            emptyLabel: 'Sin curso',
            options: listas.courses.map(k => ({ value: k.id, label: k.name })),
          },
          { id: uid('curso'), value: listas.courses[0]?.id },
        )}
        ${field(
          {
            name: 'hours',
            label: 'Horario',
            type: 'select',
            emptyLabel: 'El de ahora',
            options: [
              { value: 'open', label: 'En horario' },
              { value: 'closed', label: 'Fuera de horario' },
            ],
          },
          { id: uid('horario') },
        )}
      </div>
      ${field({ name: 'firstMessage', label: 'Es su primer mensaje', type: 'checkbox' }, { id: uid('primero'), value: false })}
      <div class="k-form__actions"><button type="submit" class="k-btn k-btn--primary">Probar</button></div>
    </form>
    <div class="rg-resultado" aria-live="polite">
      ${when(
        resultado,
        () => html`<p class="rg-veredicto"><strong>Contestaría: ${QUIEN[resultado.answeredBy] ?? resultado.answeredBy}</strong></p>
          <ol class="rg-traza">
            ${resultado.pipeline.map(
              p =>
                html`<li><span class="${['k-chip', p.result === 'answers' ? 'k-chip--accent' : '']}">${PASO[p.result] ?? p.result}</span> ${p.label}: ${p.detail}</li>`,
            )}
          </ol>
          ${when(
            resultado.rules.length,
            () => html`<ul class="rg-veredictos">
              ${resultado.rules.map(
                r => html`<li>
                  <strong>${r.title}</strong> · ${r.matched ? (r.voice ? 'Coincide y responde' : 'Coincide') : 'No coincide'} · ${r.reason}
                  ${when(
                    r.actions.length,
                    () => html`<ul>
                      ${r.actions.map(
                        a =>
                          html`<li>${a.label}${a.would ? '' : ' — no: ' + a.reason}${when(a.preview, () => html`<q class="rg-vista">${a.preview}</q>`)}</li>`,
                      )}
                    </ul>`,
                  )}
                </li>`,
              )}
            </ul>`,
          )}`,
      )}
    </div>
  </section>`;
}

function ajustes(datos, uid) {
  const puede = datos.brand.canManage;
  return html`<section class="k-card rg-ajustes">
    <h2 class="k-card__title">Tope de respuestas seguidas</h2>
    <form class="rg-fila" data-do="ajustes" novalidate>
      ${field(
        {
          name: 'maxConsecutive',
          label: 'Respuestas seguidas de reglas en una conversación',
          type: 'number',
          min: 1,
          max: datos.limits.maxConsecutive,
          step: 1,
          disabled: !puede,
          hint: 'Al llegar al tope contesta el asistente: evita una conversación sin fin con otro sistema automático.',
        },
        { id: uid('tope'), value: datos.settings.maxConsecutive },
      )}
      ${when(puede, () => html`<button type="submit" class="k-btn">Guardar</button>`)}
    </form>
  </section>`;
}

async function bitacora(api, regla) {
  const { runs } = await api.get('/api/rules/' + regla.id + '/runs');
  await dialog({
    title: `Bitácora de «${regla.title}»`,
    wide: true,
    content: runs.length
      ? html`<ol class="rg-bitacora">
          ${runs.map(
            x => html`<li>
              <strong>${fecha(x.createdAt)}</strong> · ${RESULTADO[x.outcome] ?? x.outcome}${x.voice ? ' · respondió' : ''}
              ${when(x.reason, () => html`<p class="k-error">${x.reason}</p>`)}
              <ul>
                ${x.actions.map(a => html`<li>${a.label}: ${a.outcome === 'done' ? 'hecho' : 'omitido'}${a.why ? ' — ' + a.why : ''}</li>`)}
              </ul>
            </li>`,
          )}
        </ol>`
      : html`<p>Esta regla todavía no ha atendido ningún mensaje.</p>`,
    actions: [{ id: 'cerrar', label: 'Cerrar', primary: true }],
  });
}

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let marca = ctx.keep.get('marca') ?? null;
    let datos = null;
    let listas = null;
    let resultado = null;
    let vivo = true;
    const uid = nombre => ctx.uid(nombre);

    render(
      root,
      html`<section class="k-page rg-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">WhatsApp</span>
            <h1>Reglas por mensaje</h1>
            <p class="k-lead">
              Respuestas ligeras: «cuando un mensaje dice esto, haz aquello», sin dibujar un recorrido. Nacen en borrador
              y sólo atienden con la automatización de la marca encendida.
            </p>
          </div>
          <div class="k-actions" data-slot="acciones"></div>
        </header>
        <div class="k-stack" data-slot="cuerpo"></div>
      </section>`,
    );
    const cuerpo = root.querySelector('[data-slot="cuerpo"]');
    const accionesCabeza = root.querySelector('[data-slot="acciones"]');

    function pintar() {
      const puede = datos.brand.canManage;
      render(
        accionesCabeza,
        html`${when(puede, () => html`<button type="button" class="k-btn k-btn--primary" data-do="nueva">${glyph('plus')} Nueva regla</button>`)}`,
      );
      render(
        cuerpo,
        html`${when(
          datos.brands.length > 1,
          () => html`<form class="k-card rg-marca" novalidate data-do="marca">
              ${field(
                {
                  name: 'marca',
                  label: 'Marca',
                  type: 'select',
                  options: datos.brands.map(x => ({ value: x.id, label: x.name })),
                },
                { id: uid('marca'), value: marca },
              )}
            </form>`,
        )}
          <div class="rg-rejilla">
            <div class="k-stack">
              <section class="k-card">
                <h2 class="k-card__title">Reglas de ${datos.brand.name}</h2>
                <p class="k-hint">Se revisan de arriba hacia abajo. La primera que coincide y responde gana.</p>
                ${when(
                  datos.rules.length,
                  () => html`<ol class="rg-lista">
                    ${datos.rules.map((r, i) => fila(r, i, datos.rules.length, puede))}
                  </ol>`,
                  () => html`<div class="k-state">
                    <p class="k-state__title">Esta marca todavía no tiene reglas</p>
                    <p>Crea la primera con «Nueva regla»: por ejemplo, responder «precio» con el precio vigente del catálogo.</p>
                  </div>`,
                )}
              </section>
              ${probar(datos, listas, uid, resultado)}
            </div>
            <div class="k-stack">${orden(datos)} ${ajustes(datos, uid)}</div>
          </div>`,
      );
    }

    async function cargar() {
      render(cuerpo, loading('Cargando las reglas…'));
      try {
        if (!marca) {
          const { brands } = await api.get('/api/rules');
          marca = brands.some(x => x.id === ctx.brand) ? ctx.brand : (brands[0]?.id ?? null);
        }
        if (!marca) {
          render(cuerpo, html`<div class="k-state"><p class="k-state__title">No tienes marcas asignadas.</p></div>`);
          return;
        }
        [datos, { lists: listas }] = await Promise.all([
          api.get('/api/rules', { brand: marca }),
          api.get('/api/rules/lists', { brand: marca }),
        ]);
      } catch (error) {
        if (vivo && !isAbort(error)) render(cuerpo, failure({ error, retry: 'reintentar' }));
        return;
      }
      if (vivo) pintar();
    }
    const recargar = async () => {
      try {
        datos = await api.get('/api/rules', { brand: marca });
        if (vivo) pintar();
      } catch (error) {
        if (!isAbort(error)) ctx.toast(error.message);
      }
    };
    const buscar = id => datos?.rules.find(r => r.id === id) ?? null;

    async function mover(id, paso) {
      const ids = datos.rules.map(r => r.id);
      const i = ids.indexOf(id);
      const j = i + paso;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      try {
        await api.put('/api/rules/order', {
          brandId: marca,
          ids,
          expectedOrderRevision: datos.settings.orderRevision,
        });
      } catch (error) {
        ctx.toast(isStale(error) ? 'Alguien más cambió la lista. Se recargó.' : error.message);
      }
      await recargar();
      root.querySelector(`[data-key="${id}"] [data-do="${paso < 0 ? 'subir' : 'bajar'}"]:not([disabled])`)?.focus();
    }
    async function estado(id, verbo, aviso) {
      const r = buscar(id);
      if (!r) return;
      try {
        await api.post('/api/rules/' + id + '/' + verbo, { expectedRevision: r.revision });
        ctx.toast(aviso.replace('{}', r.title));
      } catch (error) {
        const pendientes = error.data?.details?.issues;
        ctx.toast(pendientes?.length ? 'No se puede encender: ' + pendientes[0] : error.message);
      }
      await recargar();
    }

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            async nueva() {
              const guardada = await ventana({ api, ctx, marca, listas });
              if (!guardada) return;
              ctx.toast(`Se creó «${guardada.title}» en borrador. Enciéndela cuando esté lista.`);
              await recargar();
            },
            async editar(_e, boton) {
              const regla = buscar(boton.getAttribute('data-id'));
              if (!regla) return;
              const guardada = await ventana({ api, ctx, marca, listas, regla });
              if (!guardada) return;
              ctx.toast(`Se guardó «${guardada.title}».`);
              await recargar();
            },
            subir: (_e, boton) => mover(boton.getAttribute('data-id'), -1),
            bajar: (_e, boton) => mover(boton.getAttribute('data-id'), 1),
            encender: (_e, boton) => estado(boton.getAttribute('data-id'), 'activate', 'Se encendió «{}».'),
            pausar: (_e, boton) => estado(boton.getAttribute('data-id'), 'pause', 'Se pausó «{}».'),
            async archivar(_e, boton) {
              const regla = buscar(boton.getAttribute('data-id'));
              if (!regla) return;
              const seguro = await confirm({
                title: `¿Archivar «${regla.title}»?`,
                message: 'Deja de atender mensajes y sale de la lista. Su bitácora se conserva.',
                confirmLabel: 'Archivar',
                danger: true,
              });
              if (seguro) await estado(regla.id, 'archive', 'Se archivó «{}».');
            },
            async bitacora(_e, boton) {
              const regla = buscar(boton.getAttribute('data-id'));
              if (regla) await bitacora(api, regla);
            },
          },
          submit: {
            async probar(_e, _f, valores) {
              if (!String(valores.text ?? '').trim()) return;
              resultado = await api.post('/api/rules/test', {
                brandId: marca,
                text: valores.text,
                channel: valores.channel || 'whatsapp',
                courseId: valores.courseId || undefined,
                hours: valores.hours || undefined,
                firstMessage: valores.firstMessage === true,
              });
              pintar();
            },
            async ajustes(_e, _f, valores) {
              try {
                await api.patch('/api/rules/settings/' + marca, {
                  maxConsecutive: Number(valores.maxConsecutive),
                  expectedRevision: datos.settings.revision,
                });
                ctx.toast('Tope guardado.');
              } catch (error) {
                ctx.toast(isStale(error) ? 'Alguien más cambió el tope. Se recargó.' : error.message);
              }
              await recargar();
            },
          },
          change: {
            marca(_e, formulario) {
              marca = formValues(formulario).marca;
              ctx.keep.set('marca', marca);
              resultado = null;
              cargar();
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
    });
    cargar();
  },

  /** Otra persona cambió una regla o el orden de la marca que se está viendo: se vuelve a pedir la lista. */
  onEvent(evento) {
    if (evento?.type === 'rules.changed' && evento.brandId === enVivo?.marca()) enVivo.recargar();
  },
};
