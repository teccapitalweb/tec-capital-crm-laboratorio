// Panel lateral: los ajustes del paso seleccionado o, sin selección, los problemas y las variables del recorrido.
//
// El formulario de cada tipo de paso no está escrito aquí: se genera del registro de tipos del modelo compartido
// (`fields`), así un tipo nuevo aparece en el panel sin tocar este archivo.
//
// Lo delicado es no estorbar a quien escribe. Teclear en un campo cambia el grafo en cada letra, y volver a pintar el
// formulario le quitaría el cursor; por eso mientras se teclea sólo se actualizan en su sitio los avisos, los
// contadores y las salidas. El formulario se vuelve a pintar entero cuando cambia su forma (una lista, una opción que
// muestra u oculta campos, deshacer), y entonces el foco vuelve al mismo control.

import {
  LIMITS,
  REF_SOURCES,
  SYSTEM_ATTRIBUTES,
  TOKENS,
  VARIABLE_TYPES,
  definedVariables,
  nodeName,
  portsOf,
  typeOf,
} from '../../../kit/shared/flow-model.js';
import { flag, html, render } from './dom.js';
import { icon } from './icons.js';
import { targetOptions } from './outline.js';

const getIn = (value, path) =>
  String(path)
    .split('.')
    .reduce((at, key) => (at === null || at === undefined ? undefined : at[key]), value);

const holds = (cond, scope) => {
  const value = getIn(scope, cond.key);
  return cond.filled !== undefined ? Boolean(value) === cond.filled : cond.is.includes(value);
};
const visible = (field, scope) =>
  (!field.when || holds(field.when, scope)) &&
  (!field.unless || !holds(field.unless, scope)) &&
  (!field.all || field.all.every(cond => holds(cond, scope)));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Qué pasa con una salida opcional si se deja sin conectar: tiene un comportamiento definido y conviene decirlo.
const UNLINKED = {
  default: 'Sin conectar: al agotar los mensajes fuera de las opciones, el recorrido termina y sigue el asistente.',
  timeout: 'Sin conectar: si la persona no responde, el recorrido termina.',
  unavailable: 'Sin conectar: hace lo mismo que el asistente (lo dice y pasa con una persona).',
};

const SHORTCUTS = [
  ['Tab', 'Recorre los pasos en orden'],
  ['Flechas', 'Va al paso vecino; en el lienzo vacío, lo mueve'],
  ['Entrar', 'Abre los ajustes del paso'],
  ['C', 'Conecta: lleva a las salidas del paso'],
  ['Alt + flechas', 'Mueve los pasos seleccionados'],
  ['Espacio', 'Agrega o quita de la selección'],
  ['Supr', 'Elimina lo seleccionado'],
  ['Ctrl + Z', 'Deshace; con Mayús, rehace'],
  ['Ctrl + C, X, V, D', 'Copia, corta, pega y duplica'],
  ['+ y −', 'Acerca y aleja; 0 ajusta, 1 vuelve al 100 %'],
  ['Ctrl + rueda', 'Acerca y aleja con el ratón'],
  ['Mayús + arrastrar', 'Marca varios pasos'],
];

// `options`: {uid, catalogue(), onConnect(id, salida, valor), onGo(id), onClose(), report(resultado, texto)}.
export function createPanel(container, store, options) {
  const doc = container.ownerDocument;
  const uid = options.uid;
  let fieldByPath = new Map();
  let lists = { variables: '', slots: '' };
  let muted = false;
  let shown = null;

  const current = () => (store.selection.nodes.length === 1 ? store.node(store.selection.nodes[0]) : null);
  const quiet = change => {
    muted = true;
    try {
      return change();
    } finally {
      muted = false;
    }
  };

  // ---- Listas de la marca ----------------------------------------------------------------------------------------------

  // Elementos de una lista de la marca para un campo, o null si el lienzo no la recibió (entonces se escribe el id).
  function sourceItems(source) {
    const catalogue = options.catalogue();
    if (source === 'attributes' || source === 'attributesAndVariables') {
      const writing = source === 'attributes';
      const custom = (catalogue.attributes || [])
        .filter(a => a.status !== 'archived' && (!writing || a.writable !== false))
        .map(a => ({ id: a.key, name: a.label || a.key, group: 'Datos de la marca' }));
      const system = Object.entries(SYSTEM_ATTRIBUTES)
        .filter(([, a]) => !writing || a.write !== 'never')
        .map(([key, a]) => ({ id: key, name: a.label, group: 'Datos del sistema' }));
      const variables = writing
        ? []
        : [...definedVariables(store.graph).values()].map(v => ({
            id: 'var.' + v.name,
            name: v.label || v.name,
            group: 'Variables del recorrido',
          }));
      return [...custom, ...system, ...variables];
    }
    const meta = REF_SOURCES[source];
    const list = catalogue[source];
    if (!meta || !Array.isArray(list)) return null;
    return list.map(item => {
      const ready = !meta.ready || meta.ready(item);
      return {
        id: item[meta.id],
        name: String(item[meta.name] ?? item[meta.id]) + (ready ? '' : ` (${meta.notReady})`),
        group: '',
      };
    });
  }

  function optionsOf(items, value, empty) {
    const groups = [...new Set(items.map(item => item.group))];
    const one = item => html`<option value="${item.id}" ${flag('selected', item.id === value)}>${item.name}</option>`;
    const missing = value && !items.some(item => item.id === value);
    return html`<option value="" ${flag('selected', !value)}>${empty || 'Elige…'}</option>
      ${missing ? html`<option value="${value}" selected>(ya no existe en esta marca)</option>` : ''}
      ${groups.length > 1 || groups[0] ? groups.map(group => html`<optgroup label="${group}">${items.filter(item => item.group === group).map(one)}</optgroup>`) : items.map(one)}`;
  }

  function tokenOptions() {
    const groups = [...new Set(TOKENS.map(t => t.group))];
    const attributes = (options.catalogue().attributes || []).filter(a => a.status !== 'archived');
    const variables = [...definedVariables(store.graph).values()];
    return html`<option value="">Insertar un dato…</option>
      ${groups.map(group => html`<optgroup label="${group}">${TOKENS.filter(t => t.group === group).map(t => html`<option value="{{${t.name}}}">${t.label}</option>`)}</optgroup>`)}
      ${attributes.length ? html`<optgroup label="Datos del contacto">${attributes.map(a => html`<option value="{{contacto.${a.key}}}">${a.label || a.key}</option>`)}</optgroup>` : ''}
      ${variables.length ? html`<optgroup label="Variables del recorrido">${variables.map(v => html`<option value="{{var.${v.name}}}">${v.label || v.name}</option>`)}</optgroup>` : ''}`;
  }

  // ---- Campos ----------------------------------------------------------------------------------------------------------

  const errorSlot = path => html`<p class="lz-err" data-e="${path}" hidden></p>`;
  const helpOf = field => (field.help ? html`<p class="lz-hint">${field.help}</p>` : '');

  function checks(field, path, value, items) {
    const picked = Array.isArray(value) ? value : [];
    const gone = picked.filter(id => !items.some(item => item.id === id));
    return html`<fieldset class="lz-group">
      <legend>${field.label}</legend>
      ${items.length || gone.length ? '' : html`<p class="lz-hint">No hay nada que elegir todavía.</p>`}
      ${items.map(item => html`<label class="lz-check"><input type="checkbox" data-k="varios" data-f="${path}" value="${item.id}" ${flag('checked', picked.includes(item.id))} /><span>${item.name}</span></label>`)}
      ${gone.map(id => html`<label class="lz-check"><input type="checkbox" data-k="varios" data-f="${path}" value="${id}" checked /><span>(ya no existe en esta marca)</span></label>`)}
      ${helpOf(field)}${errorSlot(path)}
    </fieldset>`;
  }

  function fieldHtml(field, scope, base) {
    if (field.kind === 'info') return html`<p class="lz-hint">${field.text}</p>`;
    const path = base ? `${base}.${field.key}` : field.key;
    const value = getIn(scope, field.key);
    const id = uid(path);
    fieldByPath.set(path, field);
    const label = html`<label for="${id}">${field.label}</label>`;
    const count = field.max
      ? html`<span class="lz-count" data-c="${path}">${String(value ?? '').length}/${field.max}</span>`
      : '';

    switch (field.kind) {
      case 'area':
        // El salto de línea tras la etiqueta de apertura es a propósito: el analizador de HTML descarta el primero, y
        // sin él se perdería un texto que empiece con una línea en blanco.
        return html`<div class="lz-field">
          ${label}
          <textarea id="${id}" class="${field.mono ? 'lz-mono' : ''}" rows="${field.rows || 3}" maxlength="${field.max}" data-k="campo" data-f="${path}">
${value ?? ''}</textarea>
          <div class="lz-under">
            ${field.tokens ? html`<select class="lz-token" data-k="dato" data-for="${id}" aria-label="Insertar un dato en ${field.label}">${tokenOptions()}</select>` : html`<span></span>`}
            ${count}
          </div>
          ${helpOf(field)}${errorSlot(path)}
        </div>`;
      case 'number':
        return html`<div class="lz-field">
          ${label}
          <input id="${id}" type="number" inputmode="numeric" step="1" ${field.min !== undefined ? html`min="${field.min}"` : ''} ${field.max !== undefined ? html`max="${field.max}"` : ''} data-k="campo" data-f="${path}" value="${value ?? ''}" />
          ${helpOf(field)}${errorSlot(path)}
        </div>`;
      case 'choice':
        return html`<div class="lz-field">
          ${label}
          <select id="${id}" data-k="opcion" data-f="${path}">
            ${field.options.map(([optionValue, text]) => html`<option value="${optionValue}" ${flag('selected', optionValue === (value ?? ''))}>${text}</option>`)}
          </select>
          ${helpOf(field)}${errorSlot(path)}
        </div>`;
      case 'check':
        return html`<div class="lz-field">
          <label class="lz-check"><input id="${id}" type="checkbox" data-k="casilla" data-f="${path}" ${flag('checked', value === true)} /><span>${field.label}</span></label>
          ${helpOf(field)}${errorSlot(path)}
        </div>`;
      case 'multi':
        return checks(
          field,
          path,
          value,
          field.options.map(([optionValue, text]) => ({ id: optionValue, name: text })),
        );
      case 'refs':
        return checks(field, path, value, sourceItems(field.source) || []);
      case 'ref': {
        const items = sourceItems(field.source);
        // Sin la lista de la marca no hay de dónde elegir: se deja escribir el identificador.
        if (!items) {
          return html`<div class="lz-field">
            ${label}
            <input id="${id}" type="text" class="lz-mono" data-k="campo" data-f="${path}" value="${value ?? ''}" maxlength="${LIMITS.title}" autocomplete="off" />
            ${helpOf(field)}${errorSlot(path)}
          </div>`;
        }
        return html`<div class="lz-field">
          ${label}
          <select id="${id}" data-k="ref" data-f="${path}">
            ${optionsOf(items, value, field.empty)}
          </select>
          ${helpOf(field)}${errorSlot(path)}
        </div>`;
      }
      case 'list':
        return listHtml(field, path, Array.isArray(value) ? value : []);
      default:
        return html`<div class="lz-field">
          ${label}
          <div class="lz-control">
            <input id="${id}" type="${field.kind === 'time' ? 'time' : 'text'}" class="${field.mono ? 'lz-mono' : ''}" data-k="campo" data-f="${path}" value="${value ?? ''}" ${field.max ? html`maxlength="${field.max}"` : ''} ${field.suggest ? html`list="${lists[field.suggest]}"` : ''} autocomplete="off" />
            ${count}
          </div>
          ${helpOf(field)}${errorSlot(path)}
        </div>`;
    }
  }

  const fieldsHtml = (fields, scope, base) =>
    fields.filter(field => visible(field, scope)).map(field => fieldHtml(field, scope, base));

  function listHtml(field, path, items) {
    fieldByPath.set(path, field);
    const min = field.min ?? 0;
    return html`<fieldset class="lz-list">
      <legend>${field.label}</legend>
      ${items.map(
        (item, i) => html`<div class="lz-item">
          <div class="lz-item-head">
            <strong>${field.item} ${i + 1}</strong>
            <span class="lz-item-tools">
              <button type="button" class="lz-icon-btn" data-k="lista-subir" data-f="${path}" data-i="${i}" aria-label="Subir ${field.item} ${i + 1}" title="Subir" ${flag('disabled', i === 0)}>${icon('up')}</button>
              <button type="button" class="lz-icon-btn" data-k="lista-bajar" data-f="${path}" data-i="${i}" aria-label="Bajar ${field.item} ${i + 1}" title="Bajar" ${flag('disabled', i === items.length - 1)}>${icon('down')}</button>
              <button type="button" class="lz-icon-btn" data-k="lista-quitar" data-f="${path}" data-i="${i}" aria-label="Quitar ${field.item} ${i + 1}" title="Quitar" ${flag('disabled', items.length <= min)}>${icon('trash')}</button>
            </span>
          </div>
          ${fieldsHtml(field.fields, item, `${path}.${i}`)}${errorSlot(`${path}.${i}`)}
        </div>`,
      )}
      ${errorSlot(path)}
      <button type="button" class="lz-btn lz-add" data-k="lista-agregar" data-f="${path}" ${flag('disabled', items.length >= field.max)}>${icon('plus')} ${field.add}</button>
      ${items.length >= field.max ? html`<p class="lz-hint">Máximo ${field.max}.</p>` : ''}
    </fieldset>`;
  }

  // ---- Vistas del panel ------------------------------------------------------------------------------------------------

  const closeButton = () =>
    html`<button type="button" class="lz-icon-btn lz-narrow-only" data-k="panel-cerrar" aria-label="Cerrar el panel">${icon('close')}</button>`;

  function issuesHtml(issues, withLinks) {
    const item = (issue, level, word) => html`<li data-level="${level}">
      ${icon(level)}
      <span>
        <span class="lz-sr">${word}: </span>${issue.message}
        ${
          withLinks && issue.nodeId && store.node(issue.nodeId)
            ? html`<button type="button" class="lz-link" data-k="panel-ir" data-node="${issue.nodeId}">Ir al paso «${nodeName(store.node(issue.nodeId), store.context)}»</button>`
            : ''
        }
      </span>
    </li>`;
    return html`${issues.errors.map(i => item(i, 'error', 'Error'))}${issues.warnings.map(i => item(i, 'warn', 'Aviso'))}`;
  }

  function portsHtml(node) {
    const ports = portsOf(node);
    if (!ports.length) {
      return node.type === 'note'
        ? html``
        : html`<p class="lz-row-end">${icon('flag')}<span>Aquí termina el recorrido: este paso no tiene salidas.</span></p>`;
    }
    return html`<fieldset class="lz-group">
      <legend>Salidas: a dónde sigue</legend>
      ${ports.map(port => {
        const id = uid('salida-' + port.id);
        const to = store.edgeFrom(node.id, port.id);
        return html`<div class="lz-field">
          <label for="${id}">${port.label}</label>
          <select id="${id}" data-k="salida" data-port="${port.id}">
            ${targetOptions(store.graph, store.context, to)}
          </select>
          ${!to && UNLINKED[port.id] ? html`<p class="lz-hint">${UNLINKED[port.id]}</p>` : ''}
        </div>`;
      })}
    </fieldset>`;
  }

  function nodeHtml(node) {
    const def = typeOf(node.type);
    if (!def) {
      return html`<div class="lz-panel-head">
          <span class="lz-pill" data-group="logica">${icon('unknown')}</span>
          <div class="lz-panel-names">
            <h2 class="lz-panel-title">Paso desconocido</h2>
            <p class="lz-hint">Este tipo de paso no existe en esta versión de la aplicación. Quítalo o sustitúyelo.</p>
          </div>
          ${closeButton()}
        </div>
        <fieldset class="lz-fs" ${flag('disabled', store.readOnly)}>
          <div class="lz-actions"><button type="button" class="lz-btn lz-danger" data-k="panel-eliminar">${icon('trash')} Eliminar</button></div>
        </fieldset>`;
    }
    const titleId = uid('titulo');
    lists = { variables: uid('lista-variables'), slots: uid('lista-espacios') };
    const slots = [...new Set((options.catalogue().materials || []).map(m => m.slot).filter(Boolean))];
    return html`<div class="lz-panel-head">
        <span class="lz-pill" data-group="${def.group}">${icon(def.icon)}</span>
        <div class="lz-panel-names">
          <h2 class="lz-panel-title">${def.label}</h2>
          <p class="lz-hint">${def.hint}</p>
        </div>
        ${closeButton()}
      </div>
      <ul class="lz-issues" data-slot="problemas" aria-label="Problemas de este paso"></ul>
      <fieldset class="lz-fs" ${flag('disabled', store.readOnly)}>
        ${
          node.type === 'start'
            ? ''
            : html`<div class="lz-field">
              <label for="${titleId}">Nombre del paso (opcional)</label>
              <div class="lz-control">
                <input id="${titleId}" type="text" data-k="titulo" value="${node.title || ''}" maxlength="${LIMITS.title}" placeholder="${def.label}" autocomplete="off" />
                <span class="lz-count" data-c="title">${(node.title || '').length}/${LIMITS.title}</span>
              </div>
              ${errorSlot('title')}
            </div>`
        }
        ${fieldsHtml(def.fields, node.data, '')}
        <datalist id="${lists.variables}">
          ${[...definedVariables(store.graph).keys()].map(name => html`<option value="${name}"></option>`)}
        </datalist>
        <datalist id="${lists.slots}">
          ${slots.map(slot => html`<option value="${slot}"></option>`)}
        </datalist>
        <div data-slot="salidas">${portsHtml(node)}</div>
        ${
          node.type === 'start'
            ? ''
            : html`<div class="lz-actions">
              <button type="button" class="lz-btn" data-k="panel-duplicar">${icon('copy')} Duplicar</button>
              <button type="button" class="lz-btn lz-danger" data-k="panel-eliminar">${icon('trash')} Eliminar</button>
            </div>`
        }
      </fieldset>`;
  }

  function manyHtml(ids) {
    return html`<div class="lz-panel-head">
        <span class="lz-pill" data-group="logica">${icon('copy')}</span>
        <div class="lz-panel-names">
          <h2 class="lz-panel-title">${ids.length} pasos seleccionados</h2>
          <p class="lz-hint">Se mueven juntos al arrastrar o con Alt + flechas.</p>
        </div>
        ${closeButton()}
      </div>
      <fieldset class="lz-fs" ${flag('disabled', store.readOnly)}>
        <div class="lz-actions">
          <button type="button" class="lz-btn" data-k="panel-duplicar">${icon('copy')} Duplicar</button>
          <button type="button" class="lz-btn" data-k="panel-copiar">${icon('copy')} Copiar</button>
          <button type="button" class="lz-btn lz-danger" data-k="panel-eliminar">${icon('trash')} Eliminar</button>
        </div>
      </fieldset>`;
  }

  function edgeHtml(edge) {
    const from = store.node(edge.from);
    const to = store.node(store.edgeFrom(edge.from, edge.port));
    const port = portsOf(from).find(p => p.id === edge.port);
    return html`<div class="lz-panel-head">
        <span class="lz-pill" data-group="logica">${icon('arrow')}</span>
        <div class="lz-panel-names">
          <h2 class="lz-panel-title">Conexión</h2>
          <p class="lz-hint">De «${nodeName(from, store.context)}», por la salida «${port ? port.label : edge.port}», hacia «${to ? nodeName(to, store.context) : ''}».</p>
        </div>
        ${closeButton()}
      </div>
      <fieldset class="lz-fs" ${flag('disabled', store.readOnly)}>
        <div class="lz-actions"><button type="button" class="lz-btn lz-danger" data-k="panel-desconectar">${icon('trash')} Quitar la conexión</button></div>
      </fieldset>`;
  }

  function flowHtml() {
    const graph = store.graph;
    const issues = store.issues();
    const steps = graph.nodes.filter(n => n.type !== 'note').length;
    const variables = [...definedVariables(graph).values()];
    const order = store.order();
    const nameId = uid('variable-nombre');
    const typeId = uid('variable-tipo');
    return html`<div class="lz-panel-head">
        <span class="lz-pill" data-group="logica">${icon('canvas')}</span>
        <div class="lz-panel-names">
          <h2 class="lz-panel-title">El recorrido</h2>
          <p class="lz-hint">${plural(steps, 'paso', 'pasos')} · ${plural(graph.edges.length, 'conexión', 'conexiones')}. Elige un paso para ver sus ajustes.</p>
        </div>
        ${closeButton()}
      </div>
      <section class="lz-section">
        <h3>Problemas</h3>
        ${
          issues.errors.length + issues.warnings.length
            ? html`<p class="lz-hint">${plural(issues.errors.length, 'error impide', 'errores impiden')} publicar; ${plural(issues.warnings.length, 'aviso', 'avisos')} sólo se ${issues.warnings.length === 1 ? 'confirma' : 'confirman'}.</p>
              <ul class="lz-issues">
                ${issuesHtml(issues, true)}
              </ul>`
            : html`<p class="lz-ok">${icon('check')}<span>Sin problemas: el recorrido se puede publicar.</span></p>`
        }
      </section>
      <section class="lz-section">
        <h3>Variables del recorrido</h3>
        <p class="lz-hint">Guardan respuestas mientras dura el recorrido. Se usan en los textos como {{var.nombre}}.</p>
        ${
          variables.length
            ? html`<ul class="lz-vars">
              ${variables.map(
                v => html`<li>
                  <code class="lz-mono">${v.name}</code>
                  <span class="lz-hint">${v.declared ? 'Declarada aquí' : 'La guarda el paso ' + v.writers.map(id => order.indexOf(id) + 1).join(', ')}</span>
                  ${v.declared && !store.readOnly ? html`<button type="button" class="lz-icon-btn" data-k="variable-quitar" data-name="${v.name}" aria-label="Quitar la variable ${v.name}" title="Quitar">${icon('trash')}</button>` : ''}
                </li>`,
              )}
            </ul>`
            : ''
        }
        <form class="lz-var-form" data-k="variable-form">
          <fieldset class="lz-fs" ${flag('disabled', store.readOnly)}>
            <div class="lz-field">
              <label for="${nameId}">Nueva variable</label>
              <input id="${nameId}" name="nombre" type="text" class="lz-mono" maxlength="30" placeholder="por_ejemplo" autocomplete="off" />
            </div>
            <div class="lz-field">
              <label for="${typeId}">Tipo</label>
              <select id="${typeId}" name="tipo">
                ${VARIABLE_TYPES.map(([value, text]) => html`<option value="${value}">${text}</option>`)}
              </select>
            </div>
            <button type="submit" class="lz-btn">${icon('plus')} Agregar variable</button>
          </fieldset>
        </form>
      </section>
      <details class="lz-keys">
        <summary>Atajos del teclado</summary>
        <dl>
          ${SHORTCUTS.map(([keys, what]) => html`<div><dt>${keys}</dt><dd>${what}</dd></div>`)}
        </dl>
      </details>`;
  }

  // ---- Pintar y refrescar ------------------------------------------------------------------------------------------------

  // Avisos de cada campo, en su sitio. Un problema cuyo campo no tiene sitio propio sube al de la lista que lo contiene.
  function paintErrors() {
    const node = current();
    const slots = new Map([...container.querySelectorAll('[data-e]')].map(el => [el.dataset.e, el]));
    const messages = new Map();
    for (const issue of node ? store.issuesFor(node.id).errors : []) {
      let path = issue.field || '';
      while (path && !slots.has(path)) path = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
      if (!path) continue;
      messages.set(path, [...(messages.get(path) || []), issue.message]);
    }
    for (const [path, slot] of slots) {
      const found = messages.get(path);
      slot.hidden = !found;
      slot.textContent = found ? found.join(' ') : '';
      if (found && !slot.id) slot.id = uid('error');
    }
    for (const control of container.querySelectorAll(
      'input[data-f], textarea[data-f], select[data-f], [data-k="titulo"]',
    )) {
      const path = control.dataset.k === 'titulo' ? 'title' : control.dataset.f;
      const slot = slots.get(path);
      if (slot && !slot.hidden) {
        control.setAttribute('aria-invalid', 'true');
        control.setAttribute('aria-describedby', slot.id);
      } else {
        control.removeAttribute('aria-invalid');
        control.removeAttribute('aria-describedby');
      }
    }
    const summary = container.querySelector('[data-slot="problemas"]');
    if (summary && node) {
      const issues = store.issuesFor(node.id);
      summary.hidden = !issues.errors.length && !issues.warnings.length;
      render(summary, issuesHtml(issues, false));
    }
  }

  function draw() {
    fieldByPath = new Map();
    const { nodes, edge } = store.selection;
    const node = current();
    shown = node ? node.id : null;
    if (node) render(container, nodeHtml(node));
    else if (nodes.length > 1) render(container, manyHtml(nodes));
    else if (edge) render(container, edgeHtml(edge));
    else render(container, flowHtml());
    paintErrors();
  }

  const sameControl = (el, memo) =>
    el.dataset.k === memo.k &&
    el.dataset.f === memo.f &&
    el.dataset.port === memo.port &&
    el.dataset.i === memo.i &&
    (memo.value === null || el.value === memo.value);

  // Vuelve a pintar el panel y devuelve el foco al mismo control (por lo que edita, no por su posición).
  function rebuild() {
    const active = doc.activeElement;
    const inside = active && container.contains(active) ? active : null;
    let memo = null;
    if (inside && inside.dataset.k) {
      memo = {
        k: inside.dataset.k,
        f: inside.dataset.f,
        port: inside.dataset.port,
        i: inside.dataset.i,
        value: inside.type === 'checkbox' ? inside.value : null,
        start: null,
        end: null,
      };
      try {
        memo.start = inside.selectionStart;
        memo.end = inside.selectionEnd;
      } catch {
        // Los campos numéricos y las listas no tienen cursor de texto.
      }
    }
    const scroll = container.scrollTop;
    draw();
    container.scrollTop = scroll;
    if (!memo) return;
    const again = [...container.querySelectorAll('[data-k]')].find(el => sameControl(el, memo));
    if (!again) return;
    again.focus({ preventScroll: true });
    if (memo.start !== null && typeof again.setSelectionRange === 'function') {
      try {
        again.setSelectionRange(memo.start, memo.end);
      } catch {
        // Igual que arriba: no todos los campos admiten una selección de texto.
      }
    }
  }

  // Lo que cambia mientras se teclea, sin tocar el control en uso.
  function refreshLive() {
    const node = current();
    if (!node) return;
    paintErrors();
    const ports = container.querySelector('[data-slot="salidas"]');
    if (ports && !ports.contains(doc.activeElement)) render(ports, portsHtml(node));
  }

  function focusIn(selector) {
    const target = container.querySelector(selector);
    if (target) target.focus();
    return Boolean(target);
  }

  // ---- Lo que hace cada control ----------------------------------------------------------------------------------------

  const nodeId = () => (current() ? current().id : null);
  const coalesce = path => ({ coalesce: `campo:${nodeId()}:${path}` });

  function typed(el) {
    const id = nodeId();
    if (!id) return;
    const path = el.dataset.f;
    const value = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    quiet(() => store.setData(id, path, value, coalesce(path)));
    const counter = [...container.querySelectorAll('[data-c]')].find(c => c.dataset.c === path);
    if (counter) counter.textContent = `${el.value.length}/${fieldByPath.get(path)?.max ?? ''}`;
    refreshLive();
  }

  function moveItem(el, delta) {
    const id = nodeId();
    const path = el.dataset.f;
    const index = Number(el.dataset.i);
    const items = getIn(store.node(id).data, path);
    const to = index + delta;
    if (!Array.isArray(items) || to < 0 || to >= items.length) return;
    const next = items.slice();
    [next[index], next[to]] = [next[to], next[index]];
    options.report(store.setData(id, path, next));
    // El foco sigue al elemento que se movió.
    const moved = [...container.querySelectorAll(`[data-k="${el.dataset.k}"]`)].find(
      b => b.dataset.f === path && Number(b.dataset.i) === to,
    );
    if (moved && !moved.disabled) moved.focus();
  }

  const handlers = {
    input: {
      campo: (event, el) => typed(el),
      titulo(event, el) {
        const id = nodeId();
        if (!id) return;
        quiet(() => store.setTitle(id, el.value, coalesce('title')));
        const counter = container.querySelector('[data-c="title"]');
        if (counter) counter.textContent = `${el.value.length}/${LIMITS.title}`;
        refreshLive();
      },
    },
    change: {
      // Al salir de un campo termina esa edición: lo siguiente que se teclee será otro paso de «deshacer». Si lo que
      // quedó guardado no es lo que se ve (un número fuera de forma vuelve a su valor de fábrica), se vuelve a pintar.
      campo(event, el) {
        store.seal();
        const node = current();
        if (node && String(getIn(node.data, el.dataset.f) ?? '') !== el.value) rebuild();
      },
      titulo: () => store.seal(),
      opcion: (event, el) => options.report(store.setData(nodeId(), el.dataset.f, el.value)),
      casilla: (event, el) => options.report(store.setData(nodeId(), el.dataset.f, el.checked)),
      varios(event, el) {
        const id = nodeId();
        const before = getIn(store.node(id).data, el.dataset.f);
        const picked = Array.isArray(before) ? before : [];
        const next = el.checked
          ? [...picked.filter(v => v !== el.value), el.value]
          : picked.filter(v => v !== el.value);
        options.report(store.setData(id, el.dataset.f, next));
      },
      ref(event, el) {
        const id = nodeId();
        const field = fieldByPath.get(el.dataset.f);
        // Elegir una plantilla trae también sus botones: son campos que se llenan juntos.
        if (field && field.onPick) {
          const meta = REF_SOURCES[field.source];
          const item = (options.catalogue()[field.source] || []).find(entry => entry[meta.id] === el.value);
          options.report(store.mergeData(id, { [field.key]: el.value, ...field.onPick(item) }));
        } else options.report(store.setData(id, el.dataset.f, el.value));
      },
      dato(event, el) {
        const target = doc.getElementById(el.dataset.for);
        const token = el.value;
        el.value = '';
        if (!target || !token) return;
        target.focus();
        target.setRangeText(token, target.selectionStart, target.selectionEnd, 'end');
        typed(target);
        store.seal();
      },
      salida: (event, el) => options.onConnect(nodeId(), el.dataset.port, el.value),
    },
    click: {
      'lista-agregar'(event, el) {
        const id = nodeId();
        const path = el.dataset.f;
        const field = fieldByPath.get(path);
        const items = getIn(store.node(id).data, path) || [];
        const added = store.setData(id, path, [...items, field.make(items)]);
        options.report(added, `${field.item} ${items.length + 1} agregado.`);
        // El foco pasa al primer campo de lo que se acaba de agregar.
        const fresh = [...container.querySelectorAll('[data-f]')].find(c =>
          c.dataset.f.startsWith(`${path}.${items.length}.`),
        );
        if (added.ok && fresh) fresh.focus();
      },
      'lista-quitar'(event, el) {
        const id = nodeId();
        const path = el.dataset.f;
        const items = getIn(store.node(id).data, path) || [];
        const removed = store.setData(
          id,
          path,
          items.filter((item, i) => i !== Number(el.dataset.i)),
        );
        options.report(removed, removed.pruned ? 'Quitado, junto con la conexión de su salida.' : 'Quitado.');
        // Si el foco no encontró un botón equivalente (se quitó el último), pasa al de agregar.
        const add = [...container.querySelectorAll('[data-k="lista-agregar"]')].find(b => b.dataset.f === path);
        if (add && !container.contains(doc.activeElement)) add.focus();
      },
      'lista-subir': (event, el) => moveItem(el, -1),
      'lista-bajar': (event, el) => moveItem(el, 1),
      'panel-duplicar': () => options.report(store.duplicateNodes(), 'Duplicado.'),
      'panel-copiar': () => options.report(store.copy(), 'Copiado.'),
      'panel-eliminar': () => options.report(store.deleteNodes(store.selection.nodes), 'Eliminado.'),
      'panel-desconectar': () => options.report(store.deleteSelection(), 'Conexión quitada.'),
      'panel-ir': (event, el) => options.onGo(el.dataset.node),
      'panel-cerrar': () => options.onClose(),
      'variable-quitar'(event, el) {
        options.report(
          store.setVariables(store.graph.variables.filter(v => v.name !== el.dataset.name)),
          'Variable quitada.',
        );
      },
    },
    submit: {
      'variable-form'(event, el) {
        const name = el.elements.nombre.value.trim();
        const added = store.setVariables([...store.graph.variables, { name, label: '', type: el.elements.tipo.value }]);
        options.report(added, `Variable ${name} agregada.`);
        // Al agregarla el panel se vuelve a pintar: el foco regresa al campo, listo para la siguiente.
        focusIn('.lz-var-form input');
      },
    },
  };

  draw();

  return {
    handlers,
    update(change) {
      if (change.selection || change.reset || change.mode || change.context) return rebuild();
      if (change.graph) return muted && shown === nodeId() ? undefined : rebuild();
      return undefined;
    },
    // Lleva el foco al primer ajuste del paso (doble clic o Entrar sobre la tarjeta) o a sus salidas (tecla C).
    focusFirst: () => focusIn('.lz-fs [data-f]') || focusIn('[data-k="titulo"]') || focusIn('[data-k="salida"]'),
    focusPorts: () => focusIn('[data-k="salida"]') || focusIn('.lz-fs [data-f]'),
    destroy() {
      container.replaceChildren();
    },
  };
}
