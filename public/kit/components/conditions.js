/**
 * Constructor de condiciones: el mismo para filtros de listas, segmentos, reglas y reparto.
 *
 * Por qué existe: tres diseños trajeron tres sintaxis de filtro. La conciliación dejó una sola forma, la
 * que valida y compila el servidor en server/lib/conditions.mjs, y este constructor produce exactamente
 * esa forma:
 *
 *   {"version": 1, "match": "any", "groups": [
 *     {"match": "all", "rules": [{"field": "tag", "op": "any", "value": ["…"]},
 *                                {"field": "attr", "key": "ciudad", "op": "eq", "value": "Puebla"}]}]}
 *
 * Dos niveles y no más: las condiciones de un grupo se unen con «y» y los grupos entre sí con «o» (lo que
 * la gente ya conoce y lo que cabe en un celular). Los campos y sus operadores no se escriben aquí: los
 * declara quien usa el constructor, con la misma lista que el servidor tiene registrada.
 *
 * La parte de arriba del archivo es pura (sin DOM) y se prueba en Node.
 */
import { attrs, html, render, when } from '../html.js';
import { listen } from '../events.js';
import { nextId } from '../ids.js';
import { glyph } from '../glyphs.js';

/** Los mismos topes que valida el servidor. */
export const LIMITS = Object.freeze({ groups: 5, rules: 8, values: 50 });

/** Cómo se lee cada operador. Un campo puede dar su propio rótulo con {op, label}. */
const OP_LABELS = {
  is: 'es',
  eq: 'es igual a',
  neq: 'es distinto de',
  in: 'es cualquiera de',
  not_in: 'no es ninguno de',
  any: 'tiene alguna de',
  all: 'tiene todas',
  none: 'no tiene ninguna de',
  contains: 'contiene',
  not_contains: 'no contiene',
  starts_with: 'empieza por',
  has: 'tiene dato',
  not_has: 'no tiene dato',
  gt: 'es mayor que',
  gte: 'es al menos',
  lt: 'es menor que',
  lte: 'es como mucho',
  between: 'está entre',
  before: 'es anterior al',
  after: 'es posterior al',
  in_last_days: 'en los últimos días',
  not_in_last_days: 'no en los últimos días',
  between_days: 'entre hace tantos días',
  never: 'nunca',
  exists: 'existe',
  not_exists: 'no existe',
};
const NO_VALUE = new Set(['has', 'not_has', 'never', 'exists', 'not_exists']);
const LIST_OPS = new Set(['in', 'not_in', 'any', 'all', 'none']);
const RANGE_OPS = new Set(['between', 'between_days']);

/**
 * @typedef {'none'|'text'|'number'|'date'|'select'|'multi'|'boolean'|'range'} ValueType
 *
 * @typedef {object} ConditionField
 * @property {string} name Nombre del campo en el servidor ('tag', 'consent', 'attr'…).
 * @property {string} [key] Sólo para 'attr': la clave del atributo.
 * @property {string} label
 * @property {Array<string | {op: string, label?: string, valueType?: ValueType}>} ops
 * @property {ValueType} [valueType] Tipo del valor cuando el operador no dice otra cosa.
 * @property {Array<{value: string, label: string}>} [options] Para elegir de una lista.
 */

/** Identidad de un campo en el constructor: los atributos se distinguen por su clave. */
const fieldId = field => (field.key ? `${field.name}:${field.key}` : field.name);
const fieldOf = (rule, fields) =>
  fields.find(field => field.name === rule.field && (field.key ?? null) === (rule.key ?? null));

/** Operadores de un campo, con su rótulo y el tipo de valor que piden. */
export function operatorsOf(field) {
  return field.ops.map(entry => {
    const item = typeof entry === 'string' ? { op: entry } : entry;
    let valueType = item.valueType;
    if (!valueType) {
      if (NO_VALUE.has(item.op)) valueType = 'none';
      else if (RANGE_OPS.has(item.op)) valueType = 'range';
      else if (LIST_OPS.has(item.op) && field.options) valueType = 'multi';
      else valueType = field.valueType ?? (field.options ? 'select' : 'text');
    }
    return { op: item.op, label: item.label ?? OP_LABELS[item.op] ?? item.op, valueType };
  });
}

function emptyValue(valueType) {
  if (valueType === 'multi') return [];
  if (valueType === 'number') return null;
  if (valueType === 'boolean') return true;
  if (valueType === 'range') return { from: null, to: null };
  return '';
}

/** Definición vacía: sin condiciones, todo pasa. */
export const emptyConditions = (match = 'any') => ({ version: 1, match, groups: [] });

/** La primera condición que se ofrece al elegir un campo. */
export function defaultRule(field) {
  const [first] = operatorsOf(field);
  const rule = { field: field.name, op: first.op };
  if (field.key) rule.key = field.key;
  if (first.valueType !== 'none') rule.value = emptyValue(first.valueType);
  return rule;
}

/** Por qué una condición todavía no se puede aplicar, o '' si está completa. */
export function ruleProblem(rule, fields) {
  const field = fieldOf(rule, fields);
  if (!field) return ''; // condición que este constructor no edita: se conserva y la juzga el servidor
  const operator = operatorsOf(field).find(item => item.op === rule.op);
  if (!operator) return 'Elige una condición.';
  const value = rule.value;
  switch (operator.valueType) {
    case 'none':
    case 'boolean':
      return '';
    case 'multi':
      if (!Array.isArray(value) || !value.length) return 'Elige al menos una opción.';
      return value.length > LIMITS.values ? `Como mucho ${LIMITS.values} opciones.` : '';
    case 'number':
      return Number.isFinite(value) ? '' : 'Escribe un número.';
    case 'range':
      if (!Number.isFinite(value?.from) || !Number.isFinite(value?.to)) return 'Escribe los dos valores.';
      return value.from > value.to ? 'El primer valor debe ser el menor.' : '';
    case 'select':
      return value === '' || value === null || value === undefined ? 'Elige una opción.' : '';
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? '' : 'Elige una fecha.';
    default:
      return String(value ?? '').trim() ? '' : 'Escribe un valor.';
  }
}

/** Todas las condiciones incompletas: [{group, rule, message}] con sus posiciones. */
export function conditionProblems(definition, fields) {
  const problems = [];
  (definition?.groups ?? []).forEach((group, g) =>
    (group.rules ?? []).forEach((rule, r) => {
      const message = ruleProblem(rule, fields);
      if (message) problems.push({ group: g, rule: r, message });
    }),
  );
  return problems;
}

/**
 * Deja una definición en la forma canónica: versión 1, sin grupos vacíos y dentro de los topes. No valida
 * campos ni valores (eso es del servidor); sólo garantiza la forma.
 */
export function normalizeConditions(definition, limits = LIMITS) {
  const groups = [];
  for (const group of Array.isArray(definition?.groups) ? definition.groups : []) {
    const rules = (Array.isArray(group?.rules) ? group.rules : [])
      .filter(rule => rule && typeof rule.field === 'string' && typeof rule.op === 'string')
      .slice(0, limits.rules)
      .map(rule => ({ ...rule, ...(Array.isArray(rule.value) ? { value: rule.value.slice(0, limits.values) } : {}) }));
    if (rules.length) groups.push({ match: group.match === 'any' ? 'any' : 'all', rules });
    if (groups.length === limits.groups) break;
  }
  return { version: 1, match: definition?.match === 'all' ? 'all' : 'any', groups };
}

const listText = items =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} o ${items[items.length - 1]}`;

function valueText(rule, field, operator) {
  const labelOf = value =>
    field.options?.find(option => String(option.value) === String(value))?.label ?? String(value);
  switch (operator.valueType) {
    case 'none':
      return '';
    case 'multi':
      return listText((rule.value ?? []).map(labelOf));
    case 'boolean':
      return rule.value ? 'sí' : 'no';
    case 'range':
      return `${rule.value?.from ?? '…'} y ${rule.value?.to ?? '…'}`;
    case 'select':
      return labelOf(rule.value);
    default:
      return String(rule.value ?? '');
  }
}

/**
 * La definición en una frase, para mostrarla como resumen o como ficha de filtro activo:
 * «Etiqueta tiene alguna de VIP o Alumno y Consentimiento es Aceptó; o Origen es Anuncio».
 */
export function describeConditions(definition, fields) {
  const groups = (definition?.groups ?? []).map(group =>
    (group.rules ?? [])
      .map(rule => {
        const field = fieldOf(rule, fields);
        if (!field) return `condición avanzada (${rule.field})`;
        const operator = operatorsOf(field).find(item => item.op === rule.op) ?? { label: rule.op, valueType: 'text' };
        return `${field.label} ${operator.label} ${valueText(rule, field, operator)}`.trim();
      })
      .join(group.match === 'any' ? ' o ' : ' y '),
  );
  return groups.filter(Boolean).join(definition?.match === 'all' ? '; y además ' : '; o ');
}

// ---------------------------------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------------------------------

/**
 * @param {HTMLElement} root
 * @param {object} options
 * @param {ConditionField[]} options.fields
 * @param {object} [options.value] Definición inicial (forma canónica).
 * @param {(definition: object, state: {complete: boolean}) => void} [options.onChange]
 *   Tras cada cambio. `complete` es false mientras quede una condición a medias: no conviene filtrar todavía.
 * @param {boolean} [options.chooseMatch] Deja elegir «todas / cualquiera» en cada nivel. Sin esto: «y» dentro, «o» entre grupos.
 * @param {string} [options.label] Nombre del constructor para lectores de pantalla.
 * @param {{groups: number, rules: number, values: number}} [options.limits]
 */
export function conditionsBuilder(
  root,
  { fields, value, onChange, chooseMatch = false, label = 'Condiciones', limits = LIMITS },
) {
  const id = nextId('condiciones');
  let serial = 0;
  const uid = () => `${++serial}`;

  const initial = normalizeConditions(value, limits);
  let match = initial.match;
  let groups = initial.groups.map(group => ({
    uid: uid(),
    match: group.match,
    rules: group.rules.map(rule => ({ uid: uid(), rule })),
  }));
  let touched = new Set(); // condiciones cuyo aviso ya se puede mostrar

  const definition = () => ({
    version: 1,
    match,
    groups: groups.map(group => ({ match: group.match, rules: group.rules.map(entry => entry.rule) })),
  });
  const find = (groupUid, ruleUid) => {
    const group = groups.find(item => item.uid === groupUid);
    return { group, entry: group?.rules.find(item => item.uid === ruleUid) };
  };

  function valueControl(entry, field, operator) {
    const { rule } = entry;
    const common = { 'data-do': 'k-cond-value', 'data-r': entry.uid };
    switch (operator.valueType) {
      case 'none':
        return html``;
      case 'number':
        return html`<input class="k-input" type="number" inputmode="decimal" aria-label="Valor" value="${rule.value ?? ''}" ${attrs(common)} />`;
      case 'date':
        return html`<input class="k-input" type="date" aria-label="Fecha" value="${rule.value ?? ''}" ${attrs(common)} />`;
      case 'boolean':
        return html`<select class="k-input" aria-label="Valor" ${attrs(common)}>
          <option value="true" ${attrs({ selected: rule.value !== false })}>Sí</option>
          <option value="false" ${attrs({ selected: rule.value === false })}>No</option>
        </select>`;
      case 'select':
        return html`<select class="k-input" aria-label="Valor" ${attrs(common)}>
          <option value="">Elige…</option>
          ${(field.options ?? []).map(option => html`<option value="${option.value}" ${attrs({ selected: String(option.value) === String(rule.value ?? '') })}>${option.label}</option>`)}
        </select>`;
      case 'range':
        return html`<div class="k-cond__range">
          <input class="k-input" type="number" inputmode="decimal" aria-label="Desde" value="${rule.value?.from ?? ''}" data-part="from" ${attrs(common)} />
          <input class="k-input" type="number" inputmode="decimal" aria-label="Hasta" value="${rule.value?.to ?? ''}" data-part="to" ${attrs(common)} />
        </div>`;
      case 'multi': {
        const chosen = Array.isArray(rule.value) ? rule.value.map(String) : [];
        const rest = (field.options ?? []).filter(option => !chosen.includes(String(option.value)));
        return html`${when(
          chosen.length,
          () =>
            html`<div class="k-cond__chips">
                ${chosen.map(item => {
                  const text = field.options?.find(option => String(option.value) === item)?.label ?? item;
                  return html`<span class="k-chip k-chip--accent" data-key="${`v-${item}`}">
                    ${text}
                    <button type="button" class="k-chip__remove" data-do="k-cond-rm-value" data-r="${entry.uid}" data-value="${item}" aria-label="${`Quitar ${text}`}">
                      ${glyph('x')}
                    </button>
                  </span>`;
                })}
              </div>`,
        )}
          <select class="k-input" aria-label="Añadir valor" data-do="k-cond-add-value" data-r="${entry.uid}" ${attrs({ disabled: !rest.length || chosen.length >= limits.values })}>
            <option value="">${rest.length ? 'Añadir…' : 'No hay más opciones'}</option>
            ${rest.map(option => html`<option value="${option.value}">${option.label}</option>`)}
          </select>`;
      }
      default:
        return html`<input class="k-input" type="text" aria-label="Valor" maxlength="200" value="${rule.value ?? ''}" ${attrs(common)} />`;
    }
  }

  function ruleMarkup(group, entry, position) {
    const { rule } = entry;
    const field = fieldOf(rule, fields);
    const name = `Condición ${position + 1}`;
    const remove = html`<button
      type="button"
      class="k-btn k-btn--ghost k-btn--icon k-cond__rm"
      data-do="k-cond-rm-rule"
      data-g="${group.uid}"
      data-r="${entry.uid}"
      aria-label="${`Quitar la condición ${position + 1}`}"
    >
      ${glyph('x')}
    </button>`;
    if (!field) {
      // Una condición que este constructor no sabe editar se muestra y se conserva: nunca se pierde en silencio.
      return html`<div class="k-cond__rule" role="group" aria-label="${name}" data-key="${`r-${entry.uid}`}">
        <p class="k-hint k-cond__op">Condición avanzada sobre «${rule.field}». Se conserva tal cual.</p>
        ${remove}
      </div>`;
    }
    const operators = operatorsOf(field);
    const operator = operators.find(item => item.op === rule.op) ?? operators[0];
    const problem = touched.has(entry.uid) ? ruleProblem(rule, fields) : '';
    return html`<div class="k-cond__rule" role="group" aria-label="${name}" data-key="${`r-${entry.uid}`}">
      <select class="k-input k-cond__field" aria-label="Campo" id="${`${id}-campo-${entry.uid}`}" data-do="k-cond-field" data-g="${group.uid}" data-r="${entry.uid}">
        ${fields.map(item => html`<option value="${fieldId(item)}" ${attrs({ selected: item === field })}>${item.label}</option>`)}
      </select>
      <select class="k-input k-cond__op" aria-label="Condición" data-do="k-cond-op" data-g="${group.uid}" data-r="${entry.uid}">
        ${operators.map(item => html`<option value="${item.op}" ${attrs({ selected: item === operator })}>${item.label}</option>`)}
      </select>
      <div class="k-cond__value">${valueControl(entry, field, operator)} ${when(problem, () => html`<p class="k-error" role="status">${problem}</p>`)}</div>
      ${remove}
    </div>`;
  }

  function matchChooser(current, verb, groupUid, name) {
    return html`<select class="k-input" aria-label="${name}" data-do="${verb}" ${attrs({ 'data-g': groupUid })}>
      <option value="all" ${attrs({ selected: current === 'all' })}>Cumple todas</option>
      <option value="any" ${attrs({ selected: current === 'any' })}>Cumple cualquiera</option>
    </select>`;
  }

  function draw() {
    const canAddGroup = groups.length < limits.groups && fields.length > 0;
    render(
      root,
      html`<div class="k-cond" role="group" aria-label="${label}">
        ${when(!groups.length, () => html`<p class="k-hint">Sin condiciones: entra todo.</p>`)}
        ${when(chooseMatch && groups.length > 1, () => html`<div class="k-row">${matchChooser(match, 'k-cond-match-top', null, 'Cómo se combinan los grupos')}</div>`)}
        ${groups.map(
          (group, g) =>
            html`${when(g > 0, () => html`<p class="k-cond__join" data-key="${`o-${group.uid}`}">${match === 'all' ? 'y además' : 'o bien'}</p>`)}
              <section class="k-cond__group" aria-label="${`Grupo ${g + 1}`}" data-key="${`g-${group.uid}`}">
                <div class="k-cond__head">
                  <span class="k-cond__title">Grupo ${g + 1}</span>
                  ${when(chooseMatch && group.rules.length > 1, () => matchChooser(group.match, 'k-cond-match', group.uid, `Cómo se combinan las condiciones del grupo ${g + 1}`))}
                  <button type="button" class="k-btn k-btn--ghost" data-do="k-cond-rm-group" data-g="${group.uid}" aria-label="${`Quitar el grupo ${g + 1}`}">Quitar grupo</button>
                </div>
                ${group.rules.map(
                  (entry, r) =>
                    html`${when(r > 0, () => html`<p class="k-cond__join" data-key="${`y-${entry.uid}`}">${group.match === 'any' ? 'o' : 'y'}</p>`)}
                    ${ruleMarkup(group, entry, r)}`,
                )}
                <div class="k-cond__foot">
                  <button
                    type="button"
                    class="k-btn k-btn--ghost"
                    id="${`${id}-mas-${group.uid}`}"
                    data-do="k-cond-add-rule"
                    data-g="${group.uid}"
                    ${attrs({ disabled: group.rules.length >= limits.rules })}
                  >
                    ${glyph('plus')} Agregar condición
                  </button>
                  ${when(group.rules.length >= limits.rules, () => html`<span class="k-hint">Un grupo admite hasta ${limits.rules} condiciones.</span>`)}
                </div>
              </section>`,
        )}
        <div class="k-cond__foot">
          <button type="button" class="k-btn" id="${`${id}-grupo`}" data-do="k-cond-add-group" ${attrs({ disabled: !canAddGroup })}>
            ${glyph('plus')} ${groups.length ? 'Agregar grupo' : 'Agregar condición'}
          </button>
          ${when(groups.length >= limits.groups, () => html`<span class="k-hint">Hasta ${limits.groups} grupos.</span>`)}
        </div>
      </div>`,
    );
  }

  function changed({ focus } = {}) {
    draw();
    if (focus) root.querySelector(`[id="${id}-${focus}"]`)?.focus();
    const current = definition();
    onChange?.(current, { complete: conditionProblems(current, fields).length === 0 });
  }

  function readValue(control, entry) {
    const field = fieldOf(entry.rule, fields);
    const operator = operatorsOf(field).find(item => item.op === entry.rule.op);
    const text = control.value;
    const number = text === '' ? null : Number(text);
    switch (operator.valueType) {
      case 'number':
        return number;
      case 'boolean':
        return text === 'true';
      case 'range':
        return { ...(entry.rule.value ?? { from: null, to: null }), [control.getAttribute('data-part')]: number };
      default:
        return text;
    }
  }

  const ruleOf = control => find(control.getAttribute('data-g'), control.getAttribute('data-r'));
  const entryOf = control =>
    groups.flatMap(group => group.rules).find(item => item.uid === control.getAttribute('data-r'));

  const onValue = (_event, control) => {
    const entry = entryOf(control);
    if (!entry) return;
    entry.rule = { ...entry.rule, value: readValue(control, entry) };
    changed();
  };

  const off = listen(
    root,
    {
      click: {
        'k-cond-add-group': () => {
          const entry = { uid: uid(), rule: defaultRule(fields[0]) };
          groups = [...groups, { uid: uid(), match: 'all', rules: [entry] }];
          changed({ focus: `campo-${entry.uid}` });
        },
        'k-cond-rm-group': (_event, button) => {
          groups = groups.filter(group => group.uid !== button.getAttribute('data-g'));
          changed({ focus: 'grupo' });
        },
        'k-cond-add-rule': (_event, button) => {
          const { group } = find(button.getAttribute('data-g'));
          if (!group || group.rules.length >= limits.rules) return;
          const entry = { uid: uid(), rule: defaultRule(fields[0]) };
          group.rules = [...group.rules, entry];
          changed({ focus: `campo-${entry.uid}` });
        },
        'k-cond-rm-rule': (_event, button) => {
          const { group, entry } = ruleOf(button);
          if (!group || !entry) return;
          group.rules = group.rules.filter(item => item !== entry);
          // Un grupo sin condiciones no significa nada: se va con su última condición.
          if (!group.rules.length) groups = groups.filter(item => item !== group);
          changed({ focus: group.rules.length ? `mas-${group.uid}` : 'grupo' });
        },
        'k-cond-rm-value': (_event, button) => {
          const entry = entryOf(button);
          if (!entry) return;
          entry.rule = {
            ...entry.rule,
            value: (entry.rule.value ?? []).filter(item => String(item) !== button.getAttribute('data-value')),
          };
          changed();
        },
      },
      change: {
        'k-cond-field': (_event, select) => {
          const { entry } = ruleOf(select);
          const field = fields.find(item => fieldId(item) === select.value);
          if (!entry || !field) return;
          entry.rule = defaultRule(field);
          touched.delete(entry.uid);
          changed();
        },
        'k-cond-op': (_event, select) => {
          const { entry } = ruleOf(select);
          if (!entry) return;
          const operators = operatorsOf(fieldOf(entry.rule, fields));
          const before = operators.find(item => item.op === entry.rule.op);
          const after = operators.find(item => item.op === select.value);
          if (!after) return;
          const { value: kept, ...rest } = entry.rule;
          entry.rule = { ...rest, op: after.op };
          // El valor se conserva si el operador nuevo lo pide del mismo tipo; si no, se empieza de cero.
          if (after.valueType !== 'none')
            entry.rule.value = before?.valueType === after.valueType ? kept : emptyValue(after.valueType);
          touched.delete(entry.uid);
          changed();
        },
        'k-cond-value': (event, control) => {
          touched.add(control.getAttribute('data-r'));
          onValue(event, control);
        },
        'k-cond-add-value': (_event, select) => {
          const entry = entryOf(select);
          if (!entry || !select.value) return;
          const list = Array.isArray(entry.rule.value) ? entry.rule.value : [];
          if (list.length < limits.values && !list.map(String).includes(select.value))
            entry.rule = { ...entry.rule, value: [...list, select.value] };
          touched.add(entry.uid);
          changed();
        },
        'k-cond-match': (_event, select) => {
          const { group } = find(select.getAttribute('data-g'));
          if (!group) return;
          group.match = select.value === 'any' ? 'any' : 'all';
          changed();
        },
        'k-cond-match-top': (_event, select) => {
          match = select.value === 'all' ? 'all' : 'any';
          changed();
        },
      },
      input: { 'k-cond-value': onValue },
    },
    { contain: false },
  );

  draw();

  return {
    /** La definición actual en la forma canónica. */
    value: definition,
    /** ¿Están completas todas las condiciones? Si no, las marca para que se vea cuál falta. */
    validate() {
      touched = new Set(groups.flatMap(group => group.rules.map(entry => entry.uid)));
      draw();
      return conditionProblems(definition(), fields).length === 0;
    },
    /** Sustituye la definición (por ejemplo, al abrir una vista guardada). No avisa por onChange. */
    set(next) {
      const fresh = normalizeConditions(next, limits);
      match = fresh.match;
      groups = fresh.groups.map(group => ({
        uid: uid(),
        match: group.match,
        rules: group.rules.map(rule => ({ uid: uid(), rule })),
      }));
      touched = new Set();
      draw();
    },
    destroy: off,
  };
}
