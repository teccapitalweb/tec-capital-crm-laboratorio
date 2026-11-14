/**
 * Campos de formulario con sus mensajes de validación y el controlador de un formulario.
 *
 * Por qué existe: guardar bien tiene más pasos de los que parece y hoy cada pantalla los repite (o los
 * olvida). Este controlador los hace siempre igual:
 * - valida al salir de un campo y al enviar, une cada mensaje a su campo (aria-invalid, aria-describedby)
 *   y lleva el foco al primero que falla;
 * - envía con un clientRef que se reutiliza si se reintenta, y con la revisión esperada del registro;
 * - ante un conflicto (409) conserva el borrador y lo dice; un evento en vivo nunca pisa lo que la
 *   persona está escribiendo;
 * - guarda el borrador en `keep` para que sobreviva a que la pantalla se desmonte y se vuelva a montar.
 */
import { attrs, html, render, when } from '../html.js';
import { listen } from '../events.js';
import { ApiError, isAbort, isStale, mutation } from '../api.js';
import { nextId } from '../ids.js';

/**
 * @typedef {object} FieldSpec
 * @property {string} name Nombre del dato (y del control).
 * @property {string} label
 * @property {'text'|'email'|'tel'|'url'|'number'|'date'|'time'|'datetime-local'|'search'|'password'|'textarea'|'select'|'radio'|'checkbox'} [type]
 * @property {string} [hint] Ayuda que se lee junto con el campo.
 * @property {boolean} [required]
 * @property {boolean} [disabled]
 * @property {number} [maxlength]
 * @property {number} [minlength]
 * @property {number} [min] Sólo `number`.
 * @property {number} [max] Sólo `number`.
 * @property {number|string} [step]
 * @property {number} [rows] Sólo `textarea`.
 * @property {string} [placeholder]
 * @property {string} [autocomplete]
 * @property {string} [inputmode]
 * @property {Array<{value: string, label: string}>} [options] `select` y `radio`.
 * @property {string} [emptyLabel] Texto de la opción vacía de un `select`.
 * @property {(value: any, values: object) => (string | null | undefined)} [validate] Devuelve el mensaje de error.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9][0-9 ()-]{6,19}$/;

const isEmpty = value =>
  value === '' || value === null || value === undefined || value === false || (Array.isArray(value) && !value.length);

/** El valor de un campo con la forma en que viaja: número o null, booleano, o texto. */
export function coerce(spec, raw) {
  if (spec.type === 'checkbox') return raw === true;
  if (spec.type === 'number') {
    if (raw === '' || raw === null || raw === undefined) return null;
    return typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
  }
  return raw === null || raw === undefined ? '' : String(raw);
}

/**
 * Mensaje de error de un campo, o '' si es válido. Los mensajes dicen qué hacer, no sólo qué está mal.
 * @param {FieldSpec} spec
 */
export function fieldError(spec, value, values = {}) {
  if (isEmpty(value)) {
    if (!spec.required) return '';
    return spec.type === 'checkbox' ? 'Marca esta casilla para continuar.' : 'Este dato es obligatorio.';
  }
  if (spec.type === 'number') {
    if (!Number.isFinite(value)) return 'Escribe un número.';
    if (spec.min !== undefined && value < spec.min) return `Debe ser ${spec.min} o más.`;
    if (spec.max !== undefined && value > spec.max) return `Debe ser ${spec.max} o menos.`;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (spec.type === 'email' && !EMAIL.test(text)) return 'Escribe un correo válido, como nombre@ejemplo.com.';
    if (spec.type === 'tel' && !PHONE.test(text)) return 'Escribe un teléfono válido, con clave de país o lada.';
    if (spec.type === 'url' && !/^https:\/\/\S+\.\S+/.test(text))
      return 'Escribe una dirección que empiece por https://.';
    if (spec.minlength !== undefined && text.length < spec.minlength)
      return `Escribe al menos ${spec.minlength} caracteres.`;
    if (spec.maxlength !== undefined && text.length > spec.maxlength)
      return `Máximo ${spec.maxlength} caracteres; llevas ${text.length}.`;
    if (
      (spec.type === 'select' || spec.type === 'radio') &&
      !(spec.options ?? []).some(option => String(option.value) === text)
    ) {
      return 'Elige una opción de la lista.';
    }
  }
  return spec.validate?.(value, values) || '';
}

/**
 * Errores de todos los campos: {nombre: mensaje}. `extra(valores)` puede añadir los que dependen de varios.
 * @param {FieldSpec[]} fields
 */
export function validateFields(fields, values, extra) {
  const errors = {};
  for (const spec of fields) {
    const message = fieldError(spec, values[spec.name], values);
    if (message) errors[spec.name] = message;
  }
  for (const [name, message] of Object.entries(extra?.(values) ?? {})) {
    if (message && !errors[name]) errors[name] = message;
  }
  return errors;
}

const requiredMark = spec => when(spec.required, () => html` <span class="k-req" aria-hidden="true">*</span>`);

/**
 * Marcado de un campo con su etiqueta, su ayuda y su error.
 * @param {FieldSpec} spec
 * @param {{id: string, value?: any, error?: string}} state `id` es el del control: une etiqueta, ayuda y error.
 */
export function field(spec, { id, value, error = '' }) {
  const type = spec.type ?? 'text';
  const described = [spec.hint && `${id}-ayuda`, error && `${id}-error`].filter(Boolean);
  const common = {
    name: spec.name,
    required: spec.required === true,
    disabled: spec.disabled === true,
    'aria-invalid': error ? 'true' : null,
    'aria-describedby': described.length ? described : null,
  };
  const typing = {
    placeholder: spec.placeholder,
    autocomplete: spec.autocomplete,
    inputmode: spec.inputmode,
    maxlength: spec.maxlength,
  };
  const hint = when(spec.hint, () => html`<p class="k-hint" id="${id}-ayuda">${spec.hint}</p>`);
  const problem = when(error, () => html`<p class="k-error" id="${id}-error">${error}</p>`);

  if (type === 'checkbox') {
    return html`<div class="k-field">
      <label class="k-check">
        <input type="checkbox" ${attrs({ id, ...common, checked: value === true })} />
        <span>${spec.label}${requiredMark(spec)}</span>
      </label>
      ${hint} ${problem}
    </div>`;
  }

  if (type === 'radio') {
    const chosen = String(value ?? '');
    return html`<fieldset class="k-fieldset" ${attrs({ id, 'aria-describedby': common['aria-describedby'] })}>
      <legend class="k-label">${spec.label}${requiredMark(spec)}</legend>
      ${(spec.options ?? []).map(
        (option, index) =>
          html`<label class="k-check">
            <input type="radio" value="${option.value}" ${attrs({ id: `${id}-${index}`, ...common, 'aria-describedby': null, checked: String(option.value) === chosen })} />
            <span>${option.label}</span>
          </label>`,
      )}
      ${hint} ${problem}
    </fieldset>`;
  }

  let control;
  if (type === 'select') {
    const chosen = String(value ?? '');
    control = html`<select class="k-input" ${attrs({ id, ...common })}>
      <option value="">${spec.emptyLabel ?? 'Elige una opción'}</option>
      ${(spec.options ?? []).map(option => html`<option value="${option.value}" ${attrs({ selected: String(option.value) === chosen })}>${option.label}</option>`)}
    </select>`;
  } else if (type === 'textarea') {
    control = html`<textarea class="k-input" rows="${spec.rows ?? 3}" ${attrs({ id, ...common, ...typing })}>${value ?? ''}</textarea>`;
  } else {
    const range = type === 'number' ? { min: spec.min, max: spec.max, step: spec.step } : {};
    control = html`<input class="k-input" type="${type}" value="${value ?? ''}" ${attrs({ id, ...common, ...typing, ...range })} />`;
  }

  return html`<div class="k-field">
    <label class="k-label" for="${id}">${spec.label}${requiredMark(spec)}</label>
    ${control} ${hint} ${problem}
  </div>`;
}

/**
 * Monta un formulario en `root` y lo gobierna.
 *
 *   const ficha = form(root.querySelector('[data-slot="ficha"]'), {
 *     id: ctx.uid('contacto'),
 *     fields: [{ name: 'name', label: 'Nombre', required: true, maxlength: 80 }, …],
 *     initial: contacto,
 *     revision: contacto.revision,
 *     submit: (valores, { clientRef, expectedRevision }) =>
 *       ctx.api.patch(`/api/contacts/${id}`, { ...valores, clientRef, expectedRevision }),
 *     reload: async () => {
 *       const { contact } = await ctx.api.get(`/api/contacts/${id}`);
 *       return { values: contact, revision: contact.revision };
 *     },
 *     onDone: guardado => { … },
 *     keep: ctx.keep,
 *     draftKey: `contacto:${id}`,
 *   });
 *
 * @param {HTMLElement} root
 * @param {object} options
 * @param {FieldSpec[]} options.fields
 * @param {(values: object, meta: {clientRef: string, expectedRevision: number | null}) => Promise<any>} options.submit
 * @param {string} [options.id] Prefijo de los id de los campos (ctx.uid('…')).
 * @param {object} [options.initial]
 * @param {number | null} [options.revision] Revisión del registro que se edita; viaja como expectedRevision.
 * @param {(values: object) => Record<string, string>} [options.validate] Errores que dependen de varios campos.
 * @param {() => Promise<{values: object, revision?: number}>} [options.reload] Trae la versión actual tras un conflicto.
 * @param {(result: any, values: object) => void} [options.onDone]
 * @param {(values: object) => void} [options.onChange]
 * @param {() => void} [options.onCancel]
 * @param {string} [options.label] Nombre accesible del formulario.
 * @param {string} [options.submitLabel]
 * @param {string} [options.sendingLabel]
 * @param {string} [options.cancelLabel] Si se da, pinta el botón de cancelar.
 * @param {string} [options.successText] Aviso que queda en el formulario al guardar.
 * @param {Map<string, any>} [options.keep] ctx.keep: donde vive el borrador entre remontajes.
 * @param {string} [options.draftKey]
 */
export function form(root, options) {
  const { fields, submit, reload, keep, draftKey, onDone, onChange, onCancel } = options;
  const id = options.id ?? nextId('form');
  const byName = new Map(fields.map(spec => [spec.name, spec]));

  /** Valores de un registro con la forma de cada campo; lo que falte queda vacío. */
  const shaped = record => Object.fromEntries(fields.map(spec => [spec.name, coerce(spec, record?.[spec.name])]));

  let values = shaped(options.initial);
  let revision = options.revision ?? null;
  let errors = {};
  let dirty = false;
  let sending = false;
  let notice = null;
  let incoming = null; // versión más nueva que llegó mientras había un borrador
  let blurTimer = 0;
  let alive = true;

  const draft = keep && draftKey ? keep.get(draftKey) : null;
  if (draft) {
    values = { ...values, ...draft.values };
    revision = draft.revision ?? revision;
    dirty = true;
  }

  const save = mutation((clientRef, payload) => submit(payload, { clientRef, expectedRevision: revision }));
  const saveDraft = () => keep && draftKey && keep.set(draftKey, { values: { ...values }, revision });
  const dropDraft = () => keep && draftKey && keep.delete(draftKey);

  /** Lo que se envía: los textos, sin espacios sobrantes (una contraseña no se toca). */
  function clean() {
    const out = {};
    for (const spec of fields) {
      const value = values[spec.name];
      out[spec.name] = typeof value === 'string' && spec.type !== 'password' ? value.trim() : value;
    }
    return out;
  }

  function draw() {
    render(
      root,
      html`<form class="k-form" novalidate data-do="k-form" aria-busy="${sending}" ${attrs({ 'aria-label': options.label })}>
        ${when(
          notice,
          () =>
            html`<div class="${['k-notice', `k-notice--${notice.kind}`]}" role="${notice.kind === 'ok' ? 'status' : 'alert'}">
              <p>${notice.text}</p>
              ${when(
                notice.reload,
                () =>
                  html`<button type="button" class="k-btn" data-do="k-form-reload">Descartar mis cambios y cargar la versión actual</button>`,
              )}
            </div>`,
        )}
        ${fields.map(spec => field(spec, { id: `${id}-${spec.name}`, value: values[spec.name], error: errors[spec.name] }))}
        <div class="k-form__actions">
          ${when(options.cancelLabel, () => html`<button type="button" class="k-btn" data-do="k-form-cancel">${options.cancelLabel}</button>`)}
          <button type="submit" class="k-btn k-btn--primary" aria-disabled="${sending}">
            ${sending ? (options.sendingLabel ?? 'Guardando…') : (options.submitLabel ?? 'Guardar')}
          </button>
        </div>
      </form>`,
    );
  }

  /** Lee del formulario entero: una casilla o un botón de opción cambian también a sus hermanos. */
  function readForm(formElement) {
    for (const spec of fields) {
      const controls = Array.from(formElement.elements).filter(
        control => control.name === spec.name && !control.disabled,
      );
      if (!controls.length) continue;
      let raw = controls[0].value;
      if (spec.type === 'checkbox') raw = controls[0].checked;
      else if (spec.type === 'radio') raw = controls.find(control => control.checked)?.value ?? '';
      values[spec.name] = coerce(spec, raw);
    }
  }

  /** Vuelve a validar un campo; devuelve true si su mensaje cambió. */
  function recheck(name) {
    const spec = byName.get(name);
    if (!spec) return false;
    const message = fieldError(spec, values[name], values);
    if ((errors[name] ?? '') === message) return false;
    errors = { ...errors };
    if (message) errors[name] = message;
    else delete errors[name];
    return true;
  }

  function focus(name) {
    const target = root.querySelector(`[id="${id}-${name}"]`);
    (target?.matches('fieldset') ? target.querySelector('input') : target)?.focus();
  }

  /** Carga un registro descartando lo que hubiera en el formulario. */
  function load(record) {
    values = shaped(record.values);
    revision = record.revision ?? revision;
    errors = {};
    dirty = false;
    notice = null;
    incoming = null;
    save.reset();
    dropDraft();
    draw();
    // El repintado respeta lo que la persona tecleó; aquí sí hay que tirarlo.
    root.querySelector('form')?.reset();
  }

  function showFailure(error) {
    sending = false;
    if (error instanceof ApiError) {
      const fromServer = error.data?.fields;
      if (fromServer && typeof fromServer === 'object') {
        errors = Object.fromEntries(
          Object.entries(fromServer).filter(([name, message]) => byName.has(name) && typeof message === 'string'),
        );
      }
      // Un conflicto no tira el borrador: se avisa y, si se puede, se ofrece cargar la versión actual.
      notice = { kind: 'bad', text: error.message, reload: isStale(error) && typeof reload === 'function' };
    } else {
      console.error(error);
      notice = { kind: 'bad', text: 'No se pudo guardar. Vuelve a intentarlo.' };
    }
    if (alive) draw();
  }

  function onEdit(event, formElement) {
    readForm(formElement);
    dirty = true;
    saveDraft();
    const name = event.target.name;
    if (name && errors[name] && recheck(name)) draw(); // el mensaje se quita en cuanto deja de aplicar
    onChange?.(clean());
  }

  function onBlur(event) {
    const name = event.target.name;
    if (!name || sending) return;
    // Se espera un instante: si el foco se fue por un clic en «Guardar», pintar ahora un mensaje movería
    // el botón bajo el cursor y ese clic se perdería.
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (alive && !sending && recheck(name)) draw();
    }, 150);
  }

  async function onSubmit(_event, formElement) {
    if (sending) return;
    clearTimeout(blurTimer);
    readForm(formElement);
    errors = validateFields(fields, values, options.validate);
    const failed = fields.filter(spec => errors[spec.name]);
    if (failed.length) {
      notice = {
        kind: 'bad',
        text: failed.length === 1 ? 'Revisa el campo marcado.' : `Revisa los ${failed.length} campos marcados.`,
      };
      draw();
      focus(failed[0].name);
      return;
    }
    sending = true;
    notice = null;
    draw();
    let result;
    try {
      result = await save.run(clean());
    } catch (error) {
      if (!isAbort(error)) showFailure(error); // abortada: se salió de la pantalla y no hay nada que pintar
      return;
    }
    sending = false;
    dirty = false;
    dropDraft();
    notice = options.successText ? { kind: 'ok', text: options.successText } : null;
    if (alive) draw();
    onDone?.(result, clean());
  }

  const off = listen(
    root,
    {
      input: { 'k-form': onEdit },
      change: { 'k-form': onEdit },
      focusout: { 'k-form': onBlur },
      submit: { 'k-form': onSubmit },
      click: {
        'k-form-cancel': () => {
          dropDraft();
          onCancel?.();
        },
        'k-form-reload': async () => {
          // Lo más fiable es volver a pedirlo; si la pantalla no sabe, vale la versión que llegó en vivo.
          if (reload) load(await reload());
          else if (incoming) load(incoming);
        },
      },
    },
    { contain: false, onError: showFailure },
  );

  draw();

  return {
    /** Los valores actuales, listos para enviar. */
    values: clean,
    /** ¿Hay cambios sin guardar? */
    dirty: () => dirty,
    /**
     * Llega una versión nueva del registro (un evento en vivo). Sin cambios pendientes se carga; con un
     * borrador a medias NO se pisa: se avisa y la persona decide.
     * @param {{values: object, revision?: number}} record
     */
    refresh(record) {
      if (!dirty) {
        load(record);
        return;
      }
      incoming = record;
      notice = {
        kind: 'warn',
        text: 'Este registro cambió mientras lo editabas. Tus cambios siguen aquí.',
        reload: true,
      };
      draw();
    },
    /** Tras guardar, el registro tiene otra revisión: la siguiente edición debe enviar ésa. */
    setRevision(next) {
      revision = next;
    },
    /** Marca errores que vienen de fuera (por ejemplo, de una validación del servidor). */
    setErrors(map) {
      errors = { ...map };
      draw();
    },
    focus,
    /** Quita los oyentes. No toca el DOM: la raíz puede haber desaparecido ya. */
    destroy() {
      alive = false;
      clearTimeout(blurTimer);
      off();
    },
  };
}
