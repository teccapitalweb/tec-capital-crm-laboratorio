// Dibujo del lienzo: una capa «mundo» que se desplaza y escala con `transform`, las tarjetas de los pasos como HTML
// (texto real, enfocable, legible por un lector de pantalla) y las conexiones como trazos SVG por debajo.
//
// No decide nada: lee el estado del store y lo pinta. Vuelve a pintar una tarjeta sólo si cambió ese paso o lo que se
// muestra de él (problemas, cifras, salidas conectadas); al arrastrar sólo se mueven la tarjeta y sus conexiones.

import {
  GEOMETRY,
  GROUPS,
  acceptsInput,
  describeNode,
  edgeMiddle,
  edgePath,
  inputPoint,
  nodeName,
  nodeSize,
  nodeSummary,
  portPoint,
  portsOf,
  typeOf,
} from '../../../kit/shared/flow-model.js';
import { html, render } from '../../../kit/html.js';
import { svgEl } from './dom.js';
import { icon } from './icons.js';
import { statsText } from './outline.js';
import { ZOOM } from './store.js';

const GROUP_LABEL = Object.fromEntries(GROUPS.map(g => [g.id, g.label]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function cardHtml(node, info) {
  const def = typeOf(node.type);
  const ports = portsOf(node);
  const titled = typeof node.title === 'string' && node.title.trim() !== '';
  const title = titled ? node.title : def ? def.label : 'Paso desconocido';
  // Con el lienzo alejado sólo cabe un rótulo: ahí va el nombre del paso (su texto), que dice más que su tipo.
  const brief = nodeName(node, info.ctx);
  const kind = def ? (titled ? def.label : GROUP_LABEL[def.group]) : 'No existe en esta versión';
  const badge = info.errors
    ? html`<span class="lz-badge" data-level="error" title="${plural(info.errors, 'error', 'errores')}">${icon('error')}<span>${info.errors}</span></span>`
    : info.warnings
      ? html`<span class="lz-badge" data-level="warn" title="${plural(info.warnings, 'aviso', 'avisos')}">${icon('warn')}<span>${info.warnings}</span></span>`
      : '';
  return html`<div class="lz-node-head">
      <span class="lz-pill">${icon(def ? def.icon : 'unknown')}</span>
      <span class="lz-node-names">
        <strong class="lz-node-title${brief === title ? '' : ' lz-full-only'}">${title}</strong>
        ${brief === title ? '' : html`<strong class="lz-node-title lz-compact-only">${brief}</strong>`}
        <span class="lz-node-kind">${kind}</span>
      </span>
      ${badge}
      ${info.deletable ? html`<button type="button" class="lz-node-x" data-do="nodo-borrar" tabindex="-1" aria-label="Eliminar este paso" title="Eliminar">${icon('trash')}</button>` : ''}
    </div>
    <p class="lz-node-sum">${node.type === 'start' ? 'Aquí empieza el recorrido' : nodeSummary(node, info.ctx)}</p>
    ${
      ports.length
        ? html`<ul class="lz-ports">
          ${ports.map(
            p => html`<li class="lz-port" data-port="${p.id}" data-linked="${info.linked.has(p.id) ? 'true' : 'false'}">
              <span class="lz-port-label">${p.label}</span>
              ${info.stats && info.stats.ports && info.stats.ports[p.id] !== undefined ? html`<span class="lz-port-count">${info.stats.ports[p.id]}</span>` : ''}
              <span class="lz-handle" aria-hidden="true"></span>
            </li>`,
          )}
        </ul>`
        : ''
    }
    ${acceptsInput(node) ? html`<span class="lz-in" aria-hidden="true"></span>` : ''}
    ${info.stats ? html`<p class="lz-node-stats" title="${statsText(info.stats)}"><span>${statsText(info.stats, true)}</span></p>` : ''}`;
}

export function createView(canvas, store) {
  const doc = canvas.ownerDocument;
  render(
    canvas,
    html`<div class="lz-world" data-slot="mundo">
        <svg class="lz-edges" data-slot="aristas" aria-hidden="true" focusable="false"></svg>
        <div class="lz-nodes" data-slot="nodos"></div>
        <div class="lz-tools" data-slot="extras"></div>
      </div>
      <div class="lz-marquee" data-slot="marco" hidden></div>`,
  );
  const world = canvas.querySelector('[data-slot="mundo"]');
  const edgesLayer = canvas.querySelector('[data-slot="aristas"]');
  const nodesLayer = canvas.querySelector('[data-slot="nodos"]');
  const toolsLayer = canvas.querySelector('[data-slot="extras"]');
  const marquee = canvas.querySelector('[data-slot="marco"]');
  const draft = svgEl(doc, 'path', { class: 'lz-edge-draft' });
  draft.style.display = 'none';
  edgesLayer.append(draft);

  const cards = new Map();
  const lines = new Map();
  let labelled = null;
  let dropTarget = null;

  function drawViewport() {
    const { x, y, zoom } = store.viewport;
    world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    canvas.style.setProperty('--lz-zoom', String(zoom));
    // Por debajo del 80 % la tarjeta sólo muestra icono y título, y el rótulo se agranda en la misma proporción en que
    // el lienzo se achica: en pantalla nunca baja de 11 px.
    canvas.style.setProperty('--lz-inv', String(1 / zoom));
    canvas.style.setProperty('--lz-x', `${x}px`);
    canvas.style.setProperty('--lz-y', `${y}px`);
    canvas.dataset.compact = zoom < ZOOM.compact ? 'true' : 'false';
  }

  function drawNodes() {
    const graph = store.graph;
    const order = store.order();
    const issues = store.issues();
    const overlay = store.overlay;
    const ctx = store.context;
    const active = doc.activeElement;
    const keep = active && nodesLayer.contains(active) ? active : null;
    const seen = new Set();
    let previous = null;
    let structural =
      !labelled || labelled.edges !== graph.edges || labelled.ctx !== ctx || labelled.count !== order.length;

    for (const id of order) {
      const node = store.node(id);
      const found = issues.byNode.get(id);
      const stats = overlay.showStats && overlay.stats && overlay.stats.nodes ? overlay.stats.nodes[id] || null : null;
      const linked = new Set(
        portsOf(node)
          .filter(p => store.edgeFrom(id, p.id))
          .map(p => p.id),
      );
      const errors = found ? found.errors.length : 0;
      const warnings = found ? found.warnings.length : 0;
      const deletable = !store.readOnly && node.type !== 'start';
      const key = [errors, warnings, [...linked].join(','), stats ? JSON.stringify(stats) : '', deletable].join('|');

      let card = cards.get(id);
      if (!card) {
        const el = doc.createElement('div');
        el.className = 'lz-node';
        el.dataset.node = id;
        el.tabIndex = 0;
        el.setAttribute('role', 'group');
        el.setAttribute('aria-roledescription', 'paso');
        card = { el, node: null, key: '', ctx: null };
        cards.set(id, card);
      }
      const same =
        card.node && card.node.data === node.data && card.node.title === node.title && card.node.type === node.type;
      if (!same) structural = true;
      if (!same || card.key !== key || card.ctx !== ctx) {
        const def = typeOf(node.type);
        card.el.dataset.group = def ? def.group : 'logica';
        card.el.dataset.type = node.type;
        card.el.dataset.level = errors ? 'error' : warnings ? 'warn' : '';
        card.el.style.height = `${nodeSize(node).h}px`;
        render(card.el, cardHtml(node, { errors, warnings, linked, stats, deletable, ctx }));
        card.key = key;
        card.ctx = ctx;
      }
      if (!card.node || card.node.x !== node.x || card.node.y !== node.y) {
        card.el.style.left = `${node.x}px`;
        card.el.style.top = `${node.y}px`;
      }
      card.node = node;
      // El orden del DOM es el orden de lectura desde el Inicio: así lo recorre el tabulador.
      const expected = previous ? previous.nextSibling : nodesLayer.firstChild;
      if (card.el !== expected) nodesLayer.insertBefore(card.el, expected);
      previous = card.el;
      seen.add(id);
    }
    for (const [id, card] of cards) {
      if (seen.has(id)) continue;
      card.el.remove();
      cards.delete(id);
    }
    // Las etiquetas para lector de pantalla nombran la posición del paso y a dónde lleva cada salida: dependen de todo
    // el recorrido, así que se rehacen sólo cuando cambia algo más que una posición.
    if (structural) {
      for (const [id, card] of cards) card.el.setAttribute('aria-label', describeNode(graph, id, ctx));
      labelled = { edges: graph.edges, ctx, count: order.length };
    }
    // Reordenar el DOM le quita el foco al elemento que se mueve: se lo devolvemos.
    if (keep && doc.activeElement !== keep && keep.isConnected) keep.focus({ preventScroll: true });
  }

  function drawStates() {
    const selected = new Set(store.selection.nodes);
    const overlay = store.overlay;
    const trail = new Set(overlay.simTrail);
    for (const [id, card] of cards) {
      const on = selected.has(id);
      card.el.dataset.selected = on ? 'true' : 'false';
      if (on) card.el.setAttribute('aria-current', 'true');
      else card.el.removeAttribute('aria-current');
      card.el.dataset.sim = overlay.simNode === id ? 'now' : trail.has(id) ? 'seen' : '';
      card.el.dataset.drop = dropTarget === id ? 'true' : 'false';
    }
  }

  function drawEdges() {
    const selected = store.selection.edge;
    const stats = store.overlay.showStats && store.overlay.stats ? store.overlay.stats.nodes || {} : null;
    let top = 1;
    if (stats) {
      for (const entry of Object.values(stats))
        for (const count of Object.values(entry.ports || {})) top = Math.max(top, Number(count) || 0);
    }
    const seen = new Set();
    let chosen = null;
    for (const e of store.graph.edges) {
      const from = store.node(e.from);
      const to = store.node(e.to);
      const a = from ? portPoint(from, e.port) : null;
      if (!a || !to) continue;
      const b = inputPoint(to);
      const key = e.from + '\n' + e.port;
      let line = lines.get(key);
      if (!line) {
        const g = svgEl(doc, 'g', { class: 'lz-edge', 'data-do': 'arista', 'data-from': e.from, 'data-port': e.port });
        line = {
          g,
          hit: svgEl(doc, 'path', { class: 'lz-edge-hit' }),
          path: svgEl(doc, 'path', { class: 'lz-edge-line' }),
          head: svgEl(doc, 'path', { class: 'lz-edge-head' }),
          d: '',
        };
        g.append(line.hit, line.path, line.head);
        edgesLayer.insertBefore(g, draft);
        lines.set(key, line);
      }
      const d = edgePath(a, b);
      if (line.d !== d) {
        line.hit.setAttribute('d', d);
        line.path.setAttribute('d', d);
        line.head.setAttribute('d', `M ${b.x} ${b.y} l -8 -4.5 v 9 z`);
        line.d = d;
      }
      const isSelected = Boolean(selected) && selected.from === e.from && selected.port === e.port;
      line.g.dataset.selected = isSelected ? 'true' : 'false';
      // Capa de rendimiento: el grosor dice cuánta gente pasó por esa conexión.
      const count = stats && stats[e.from] && stats[e.from].ports ? stats[e.from].ports[e.port] : undefined;
      line.path.style.strokeWidth =
        count === undefined ? '' : `${(1.5 + (4.5 * (Number(count) || 0)) / top).toFixed(2)}px`;
      if (isSelected) chosen = { a, b };
      seen.add(key);
    }
    for (const [key, line] of lines) {
      if (seen.has(key)) continue;
      line.g.remove();
      lines.delete(key);
    }
    // Botón para quitar la conexión seleccionada, en su punto medio.
    if (chosen && !store.readOnly) {
      const middle = edgeMiddle(chosen.a, chosen.b);
      render(
        toolsLayer,
        html`<button type="button" class="lz-edge-x" data-do="arista-quitar" aria-label="Quitar esta conexión" title="Quitar la conexión">${icon('close')}</button>`,
      );
      toolsLayer.firstElementChild.style.left = `${middle.x}px`;
      toolsLayer.firstElementChild.style.top = `${middle.y}px`;
    } else if (toolsLayer.firstChild) toolsLayer.replaceChildren();
  }

  function size() {
    const rect = canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  // De un punto de la ventana a un punto dentro del lienzo (sin escalar) y a coordenadas del mundo.
  function toLocal(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
  const toWorld = (clientX, clientY) => store.toWorld(toLocal(clientX, clientY));

  // El paso que está bajo un punto de la ventana (para soltar una conexión), o null.
  function nodeAt(clientX, clientY) {
    const under = doc.elementFromPoint(clientX, clientY);
    const card = under && canvas.contains(under) ? under.closest('.lz-node') : null;
    return card ? card.dataset.node : null;
  }

  function focusNode(id) {
    const card = cards.get(id);
    if (!card) return false;
    store.reveal(id, size());
    card.el.focus({ preventScroll: true });
    return true;
  }

  function setDraft(a, b) {
    draft.setAttribute('d', edgePath(a, b));
    draft.style.display = '';
  }

  function clearDraft() {
    draft.style.display = 'none';
  }

  function setDrop(id) {
    if (dropTarget === id) return;
    dropTarget = id;
    drawStates();
  }

  function setMarquee(rect) {
    marquee.hidden = !rect;
    if (!rect) return;
    marquee.style.left = `${Math.min(rect.x, rect.x + rect.w)}px`;
    marquee.style.top = `${Math.min(rect.y, rect.y + rect.h)}px`;
    marquee.style.width = `${Math.abs(rect.w)}px`;
    marquee.style.height = `${Math.abs(rect.h)}px`;
  }

  function update(change) {
    if (change.viewport || change.reset) drawViewport();
    if (change.graph || change.context || change.overlay || change.mode || change.reset) {
      drawNodes();
      drawEdges();
      drawStates();
    } else if (change.selection) {
      drawEdges();
      drawStates();
    }
  }

  canvas.style.setProperty('--lz-node-w', `${GEOMETRY.width}px`);
  canvas.style.setProperty('--lz-head', `${GEOMETRY.head}px`);
  canvas.style.setProperty('--lz-body', `${GEOMETRY.body}px`);
  canvas.style.setProperty('--lz-note-body', `${GEOMETRY.noteBody}px`);
  canvas.style.setProperty('--lz-port', `${GEOMETRY.port}px`);
  update({ reset: true });

  return {
    update,
    size,
    toLocal,
    toWorld,
    nodeAt,
    focusNode,
    setDraft,
    clearDraft,
    setDrop,
    setMarquee,
    card: id => (cards.has(id) ? cards.get(id).el : null),
    destroy() {
      canvas.replaceChildren();
      cards.clear();
      lines.clear();
    },
  };
}
