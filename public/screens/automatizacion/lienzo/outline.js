// Vista «Pasos»: el recorrido como una lista numerada de tarjetas, en el orden en que lo vive la persona. Es la vista
// principal en cualquier tamaño de pantalla (el lienzo es la segunda) y también la alternativa accesible al lienzo:
// cada paso es un botón, y todo lo que se hace arrastrando en el lienzo aquí se hace con controles nativos.
//
// Cada tarjeta lleva el color de su clase de paso (tones.js), su número, el nombre de su tipo, su nombre, lo que le
// falta dicho en palabras («Ningún camino llega a este paso…») y, si tiene varias salidas, a dónde lleva cada una. Un
// recorrido tiene ramas que se vuelven a juntar y pasos que regresan: un árbol no lo podría decir, así que es una
// lista plana y cada salida nombra su destino y permite saltar a él. Dónde lleva cada salida se cambia en el panel del
// paso (el centro de la vista), que tiene la lista completa de destinos y «crear aquí».

import {
  GROUPS,
  INTENTS,
  PALETTE,
  acceptsInput,
  nodeName,
  nodeSummary,
  portsOf,
  reachable,
  readingOrder,
  typeOf,
} from '../../../kit/shared/flow-model.js';
import { attrs, html, render } from '../../../kit/html.js';
import { icon } from './icons.js';
import { toneOf } from './tones.js';

const GROUP_LABEL = Object.fromEntries(GROUPS.map(g => [g.id, g.label]));

// Renglones del esquema, en orden de lectura. Función pura: sólo depende del grafo y de las listas de la marca.
export function buildOutline(graph, ctx = {}) {
  const order = readingOrder(graph);
  const reached = reachable(graph);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const position = new Map(order.map((id, i) => [id, i + 1]));
  const out = new Map(graph.edges.map(e => [e.from + '\n' + e.port, e.to]));
  const incoming = new Map();
  for (const e of graph.edges) incoming.set(e.to, (incoming.get(e.to) || 0) + 1);

  return order.map((id, i) => {
    const node = byId.get(id);
    const def = typeOf(node.type);
    const section = node.type === 'note' ? 'notes' : reached.has(id) ? 'flow' : 'loose';
    return {
      id,
      index: i + 1,
      type: node.type,
      tone: toneOf(node.type),
      kind: def ? def.label : 'Paso desconocido',
      group: def ? def.group : 'logica',
      groupLabel: def ? GROUP_LABEL[def.group] : '',
      icon: def ? def.icon : 'unknown',
      name: nodeName(node, ctx),
      summary: nodeSummary(node, ctx),
      section,
      incoming: incoming.get(id) || 0,
      outputs: portsOf(node).map(p => {
        const to = out.get(id + '\n' + p.id) ?? null;
        return {
          port: p.id,
          label: p.label,
          optional: Boolean(p.optional),
          to,
          toIndex: to ? position.get(to) : null,
          toName: to ? nodeName(byId.get(to), ctx) : '',
          // La salida lleva al renglón de abajo: es el caso común y no hace falta un salto.
          next: to !== null && position.get(to) === i + 2,
        };
      }),
    };
  });
}

// Las opciones de unos botones o de una lista, en su orden, también las que contesta el asistente (ésas no tienen
// salida: «al elegirla» responde él). [{id, label, port, intent, stay}].
export function optionsOf(node) {
  const d = node?.data;
  if (!d) return [];
  const items =
    node.type === 'buttons'
      ? d.options.map(o => ({ id: o.id, label: o.label, action: o.do }))
      : node.type === 'list'
        ? d.sections.flatMap(s => s.rows).map(r => ({ id: r.id, label: r.title, action: r.do }))
        : [];
  return items.map(({ id, label, action }) => ({
    id,
    label,
    port: action?.type === 'goto' ? 'opt:' + id : null,
    intent: action?.type === 'intent' ? action.intent : null,
    stay: Boolean(action?.stay),
  }));
}

// Qué hace el asistente con una opción que no lleva a un paso: «Lo contesta el asistente: enviar el temario».
export const intentText = option =>
  `Lo contesta el asistente: ${String(INTENTS[option.intent] || '').toLowerCase()}${option.stay ? ' (las opciones siguen a la vista)' : ''}`;

// Opciones de una lista de selección para elegir el destino de una salida: los pasos que admiten una entrada y, al
// final, los tipos de paso que se pueden crear ahí mismo. La usa el panel del paso.
export function targetOptions(graph, ctx, selected) {
  const order = readingOrder(graph);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const targets = order.map(id => byId.get(id)).filter(acceptsInput);
  return html`<option value="" ${attrs({ selected: !selected })}>Sin conectar</option>
    <optgroup label="Llevar a un paso que ya existe">
      ${targets.map(n => html`<option value="${n.id}" ${attrs({ selected: n.id === selected })}>${order.indexOf(n.id) + 1}. ${nodeName(n, ctx)}</option>`)}
    </optgroup>
    ${PALETTE.map(
      group => html`<optgroup label="Crear aquí · ${group.label}">
        ${group.types.filter(type => type !== 'note').map(type => html`<option value="new:${type}">Nuevo: ${typeOf(type).label}</option>`)}
      </optgroup>`,
    )}`;
}

const SECTION_TITLES = {
  flow: '',
  loose: 'Pasos sueltos (ningún camino llega a ellos)',
  notes: 'Notas',
};

// Cifras de un paso para la capa de rendimiento, en palabras: «Entraron 24 · completó el 25 % · se quedaron 14».
export function statsText(stats, brief = false) {
  if (!stats) return '';
  const entered = Number(stats.entered) || 0;
  const completed = Number(stats.completed) || 0;
  const parts = [`Entraron ${entered}`];
  // En la tarjeta del lienzo no cabe la frase entera: el porcentaje va solo y la frase completa queda como título.
  if (entered) parts.push(`${brief ? '' : 'completó el '}${Math.round((completed / entered) * 100)} %`);
  parts.push(`se quedaron ${Number(stats.dropped) || 0}`);
  if (Number(stats.left)) parts.push(`salieron escribiendo ${Number(stats.left)}`);
  return parts.join(' · ');
}

// Monta la lista de pasos. `options.onOpen(id)` pide abrir el panel de ese paso; `options.startText()` dice cómo
// empieza el recorrido (lo que muestra la tarjeta del Inicio).
export function createOutline(container, store, options) {
  let last = null;
  const startText = () => (typeof options.startText === 'function' ? options.startText() : '');

  // A dónde lleva una salida, como botón que salta a ese paso (con el color de su clase) o «sin conectar».
  function destination(label, to, row, required) {
    const target = to ? store.node(to) : null;
    const index = to ? store.order().indexOf(to) + 1 : 0;
    return html`<li class="lz-out" data-linked="${target ? 'true' : 'false'}">
      <span class="lz-out-label">${label}</span>
      ${icon('arrow')}
      ${
        target
          ? html`<button type="button" class="lz-out-to" data-do="fila-ir" data-to="${to}" data-tone="${toneOf(target.type)}" aria-label="${label}: sigue al paso ${index}, ${nodeName(target, store.context)}. Ir a ese paso">${index}. ${nodeName(target, store.context)}</button>`
          : html`<span class="lz-out-none" data-level="${required ? 'warn' : ''}">${required ? 'Sin conectar' : 'Sin conectar (termina)'}</span>`
      }
    </li>`;
  }

  // Salidas que vale la pena decir en la tarjeta: en un paso con opciones, todas las opciones (y las opcionales que
  // estén conectadas); en uno de una sola salida, sólo si no sigue al renglón de abajo.
  function exitsHtml(row, node) {
    if (row.type === 'note') return '';
    if (!row.outputs.length) {
      return html`<p class="lz-row-end">${icon('flag')}<span>Aquí termina el recorrido.</span></p>`;
    }
    const choices = optionsOf(node);
    const required = row.outputs.filter(o => !o.optional);
    const lines = [];
    if (choices.length) {
      for (const c of choices) {
        if (c.port) {
          const o = row.outputs.find(x => x.port === c.port);
          lines.push(destination(c.label || 'Opción sin texto', o ? o.to : null, row, true));
        } else
          lines.push(
            html`<li class="lz-out"><span class="lz-out-label">${c.label || 'Opción sin texto'}</span>${icon('arrow')}<span class="lz-out-ai" data-tone="sky">${intentText(c)}</span></li>`,
          );
      }
      for (const o of row.outputs.filter(o => o.optional && o.to)) lines.push(destination(o.label, o.to, row, false));
    } else if (required.length > 1 || row.outputs.some(o => o.optional && o.to)) {
      for (const o of row.outputs.filter(o => !o.optional || o.to))
        lines.push(destination(o.label, o.to, row, !o.optional));
    } else if (required.length === 1 && required[0].to && !required[0].next) {
      lines.push(destination('Sigue a', required[0].to, row, true));
    }
    return lines.length ? html`<ul class="lz-row-outs" aria-label="A dónde sigue «${row.name}»">${lines}</ul>` : '';
  }

  function rowHtml(row) {
    const node = store.node(row.id);
    const issues = store.issuesFor(row.id);
    const selected = store.selection.nodes.includes(row.id);
    const stats = store.overlay.showStats ? store.overlay.stats?.nodes?.[row.id] : null;
    const trail = store.overlay.simTrail.includes(row.id);
    const problems = [
      ...issues.errors.map(i => ({ ...i, level: 'error' })),
      ...issues.warnings.map(i => ({ ...i, level: 'warn' })),
    ];
    const name = row.type === 'start' ? startText() || row.name : row.name;
    return html`<li class="lz-row" data-key="${row.id}" data-node="${row.id}" data-group="${row.group}" data-tone="${row.tone}" data-current="${selected ? 'true' : 'false'}" data-sim="${store.overlay.simNode === row.id ? 'now' : trail ? 'seen' : ''}">
      <button type="button" class="lz-row-main" data-do="fila" aria-current="${selected ? 'true' : 'false'}">
        <span class="lz-row-n" aria-hidden="true">${row.index}</span>
        <span class="lz-row-text">
          <span class="lz-sr">Paso ${row.index}: </span>
          <span class="lz-row-kind">${row.kind}</span>
          <strong class="lz-row-name">${name}</strong>
          ${row.type !== 'start' && row.summary && row.summary !== row.name ? html`<span class="lz-row-sum">${row.summary}</span>` : ''}
        </span>
        ${problems.length ? html`<span class="lz-sr">. ${problems.length === 1 ? 'Tiene un problema' : `Tiene ${problems.length} problemas`}.</span>` : ''}
      </button>
      ${
        problems.length
          ? html`<ul class="lz-row-issues">
              ${problems.slice(0, 2).map(p => html`<li data-level="${p.level}">${icon(p.level)}<span>${p.message}</span></li>`)}
              ${problems.length > 2 ? html`<li data-level="${problems[2].level}"><span>Y ${problems.length - 2} más: elige el paso para verlos.</span></li>` : ''}
            </ul>`
          : ''
      }
      ${stats ? html`<p class="lz-row-stats">${icon('chart')}<span>${statsText(stats)}</span></p>` : ''}
      ${exitsHtml(row, node)}
    </li>`;
  }

  function draw() {
    const rows = buildOutline(store.graph, store.context);
    const sections = ['flow', 'loose', 'notes']
      .map(key => ({ key, rows: rows.filter(r => r.section === key) }))
      .filter(s => s.rows.length);
    const active = container.ownerDocument.activeElement;
    const focused = container.contains(active)
      ? { node: active.closest('[data-node]')?.dataset.node, k: active.dataset.do, to: active.dataset.to }
      : null;
    const scroll = container.scrollTop;
    render(
      container,
      html`${sections.map(
        section => html`${SECTION_TITLES[section.key] ? html`<h3 class="lz-outline-title">${SECTION_TITLES[section.key]}</h3>` : ''}
          <ol class="lz-outline-list" start="${section.rows[0].index}" aria-label="${section.key === 'flow' ? 'Pasos del recorrido' : SECTION_TITLES[section.key]}">
            ${section.rows.map(rowHtml)}
          </ol>`,
      )}`,
    );
    container.scrollTop = scroll;
    // Volver a pintar no debe quitarle el sitio a quien navega con el teclado.
    if (focused?.node) {
      const row = container.querySelector(`[data-node="${focused.node}"]`);
      const again =
        row && [...row.querySelectorAll(`[data-do="${focused.k}"]`)].find(el => el.dataset.to === focused.to);
      (again || row?.querySelector('[data-do="fila"]'))?.focus({ preventScroll: true });
    }
  }

  function focusRow(id) {
    const main = container.querySelector(`[data-node="${id}"] [data-do="fila"]`);
    if (!main) return false;
    main.scrollIntoView({ block: 'nearest' });
    main.focus({ preventScroll: true });
    return true;
  }

  const handlers = {
    click: {
      fila(event, el) {
        const id = el.closest('[data-node]').dataset.node;
        store.select(id);
        options.onOpen(id);
      },
      'fila-ir'(event, el) {
        store.select(el.dataset.to);
        focusRow(el.dataset.to);
      },
    },
  };

  return {
    handlers,
    focusRow,
    // Se vuelve a pintar entero: son a lo más 80 renglones y sólo cuando cambia algo que se ve aquí.
    update(change) {
      const visible = !container.hidden;
      if (!visible) {
        last = null;
        return;
      }
      if (last && !change.graph && !change.selection && !change.overlay && !change.context && !change.mode) return;
      last = true;
      draw();
    },
    refresh() {
      last = true;
      draw();
    },
    destroy() {
      container.replaceChildren();
    },
  };
}
