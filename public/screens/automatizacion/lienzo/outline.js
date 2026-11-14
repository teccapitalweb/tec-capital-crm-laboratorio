// Vista «Esquema»: el mismo recorrido como una lista ordenada, sin coordenadas. Es la alternativa accesible al lienzo
// (lector de pantalla, teclado, celular): cada paso es un renglón con su nombre, su resumen y sus salidas, y todo lo que
// se hace arrastrando en el lienzo aquí se hace con controles nativos (botones y listas de selección).
//
// Es una lista plana y no un árbol con sangrías: un recorrido tiene ramas que se vuelven a juntar y pasos que regresan,
// y eso un árbol no lo puede decir. Cada salida nombra a dónde lleva y permite saltar a ese renglón.

import {
  GROUPS,
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

// Opciones de una lista de selección para elegir el destino de una salida: los pasos que admiten una entrada y, al
// final, los tipos de paso que se pueden crear ahí mismo. La comparten el esquema y el panel.
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

// Monta el esquema. `options.onOpen(id)` pide abrir el panel de ese paso; `options.announce(texto)` avisa a quien usa
// lector de pantalla.
export function createOutline(container, store, options) {
  let last = null;

  function rowHtml(row) {
    const issues = store.issuesFor(row.id);
    const selected = store.selection.nodes.includes(row.id);
    const stats = store.overlay.showStats ? store.overlay.stats?.nodes?.[row.id] : null;
    const trail = store.overlay.simTrail.includes(row.id);
    const editable = !store.readOnly;
    return html`<li class="lz-row" data-key="${row.id}" data-node="${row.id}" data-group="${row.group}" data-sim="${store.overlay.simNode === row.id ? 'now' : trail ? 'seen' : ''}">
      <button type="button" class="lz-row-main" data-do="fila" aria-current="${selected ? 'true' : 'false'}">
        <span class="lz-row-n" aria-hidden="true">${row.index}</span>
        <span class="lz-pill">${icon(row.icon)}</span>
        <span class="lz-row-text">
          <span class="lz-sr">Paso ${row.index}: </span>
          <strong class="lz-row-name">${row.name}</strong>
          <span class="lz-row-kind">${[row.kind === row.name ? '' : row.kind, row.groupLabel].filter(Boolean).join(' · ')}</span>
          ${row.summary && row.summary !== row.name ? html`<span class="lz-row-sum">${row.summary}</span>` : ''}
        </span>
        ${issues.errors.length ? html`<span class="lz-badge" data-level="error">${icon('error')}<span>${issues.errors.length} ${issues.errors.length === 1 ? 'error' : 'errores'}</span></span>` : ''}
        ${issues.warnings.length ? html`<span class="lz-badge" data-level="warn">${icon('warn')}<span>${issues.warnings.length} ${issues.warnings.length === 1 ? 'aviso' : 'avisos'}</span></span>` : ''}
      </button>
      ${stats ? html`<p class="lz-row-stats">${icon('chart')}<span>${statsText(stats)}</span></p>` : ''}
      ${
        row.outputs.length
          ? html`<ul class="lz-row-outs" aria-label="Salidas de ${row.name}">
            ${row.outputs.map(o => outputHtml(row, o, editable, stats))}
          </ul>`
          : row.type === 'note'
            ? ''
            : html`<p class="lz-row-end">${icon('flag')}<span>Aquí termina el recorrido.</span></p>`
      }
    </li>`;
  }

  function outputHtml(row, o, editable, stats) {
    const count = stats?.ports?.[o.port];
    const where = o.to ? `${o.toIndex}. ${o.toName}` : 'Sin conectar';
    // La lista nace sólo con su valor actual y se llena al abrirla (`fill`): con 80 pasos y varias salidas por paso,
    // pintar todas las opciones de todas las listas en cada cambio haría lento el esquema.
    return html`<li class="lz-out">
      <span class="lz-out-label">${o.label}${count !== undefined ? html`<span class="lz-out-count"> · ${count}</span>` : ''}</span>
      ${icon('arrow')}
      ${
        editable
          ? html`<select class="lz-out-pick" data-do="fila-salida" data-node="${row.id}" data-port="${o.port}" aria-label="Salida «${o.label}» del paso ${row.index}: a dónde lleva">
            <option value="${o.to || ''}" selected>${where}</option>
          </select>`
          : html`<span class="lz-out-text">${where}</span>`
      }
      ${
        o.to
          ? html`<button type="button" class="lz-icon-btn" data-do="fila-ir" data-to="${o.to}" aria-label="Ir al paso ${o.toIndex}: ${o.toName}" title="Ir a ese paso">${icon('jump')}</button>`
          : ''
      }
    </li>`;
  }

  function fill(event, el) {
    if (el.options.length > 1) return;
    const current = store.edgeFrom(el.dataset.node, el.dataset.port);
    render(el, targetOptions(store.graph, store.context, current));
  }

  function draw() {
    const rows = buildOutline(store.graph, store.context);
    const sections = ['flow', 'loose', 'notes']
      .map(key => ({ key, rows: rows.filter(r => r.section === key) }))
      .filter(s => s.rows.length);
    const active = container.ownerDocument.activeElement;
    const focused = container.contains(active)
      ? {
          node: active.closest('[data-node]')?.dataset.node,
          k: active.dataset.do,
          port: active.dataset.port,
          to: active.dataset.to,
        }
      : null;
    const scroll = container.scrollTop;
    render(
      container,
      html`${sections.map(
        section => html`${SECTION_TITLES[section.key] ? html`<h3 class="lz-outline-title">${SECTION_TITLES[section.key]}</h3>` : ''}
          <ol class="lz-outline-list" start="${section.rows[0].index}">
            ${section.rows.map(rowHtml)}
          </ol>`,
      )}`,
    );
    container.scrollTop = scroll;
    // Volver a pintar no debe quitarle el sitio a quien navega con el teclado.
    if (focused?.node) {
      const row = container.querySelector(`[data-node="${focused.node}"]`);
      const again =
        row &&
        [...row.querySelectorAll(`[data-do="${focused.k}"]`)].find(
          el => el.dataset.port === focused.port && el.dataset.to === focused.to,
        );
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
    change: {
      'fila-salida'(event, el) {
        options.onConnect(el.dataset.node, el.dataset.port, el.value);
      },
    },
    // Antes de que la lista se abra, con el ratón, el dedo o el teclado.
    pointerdown: { 'fila-salida': fill },
    focusin: { 'fila-salida': fill },
    keydown: { 'fila-salida': fill },
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
