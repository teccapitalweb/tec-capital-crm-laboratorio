// Minimapa: el recorrido completo en pequeño, con un recuadro que marca la parte que se ve. Un clic o un arrastre sobre
// él lleva la vista a ese punto. Es una ayuda para el ratón y el dedo; con teclado y lector de pantalla se llega a
// cualquier paso por el orden de lectura y por el esquema, así que el minimapa queda oculto para ellos.

import { boundsOf, nodeSize, typeOf } from '../../../kit/shared/flow-model.js';
import { on, svgEl } from './dom.js';

const PADDING = 60;

export function createMinimap(container, store, view) {
  const doc = container.ownerDocument;
  const svg = svgEl(doc, 'svg', { class: 'lz-mini', 'aria-hidden': 'true', focusable: 'false' });
  const nodesLayer = svgEl(doc, 'g', {});
  const frame = svgEl(doc, 'rect', { class: 'lz-mini-view', rx: 6 });
  svg.append(nodesLayer, frame);
  container.replaceChildren(svg);
  const rects = [];
  let pressed = null;

  function draw() {
    const { zoom } = store.viewport;
    const size = view.size();
    const corner = store.toWorld({ x: 0, y: 0 });
    const seen = { x: corner.x, y: corner.y, w: size.width / zoom, h: size.height / zoom };
    const box = boundsOf(store.graph.nodes);
    const left = Math.min(box.x, seen.x) - PADDING;
    const top = Math.min(box.y, seen.y) - PADDING;
    const right = Math.max(box.x + box.w, seen.x + seen.w) + PADDING;
    const bottom = Math.max(box.y + box.h, seen.y + seen.h) + PADDING;
    svg.setAttribute('viewBox', `${left} ${top} ${Math.max(1, right - left)} ${Math.max(1, bottom - top)}`);

    const nodes = store.graph.nodes;
    while (rects.length < nodes.length) {
      const rect = svgEl(doc, 'rect', { class: 'lz-mini-node', rx: 14 });
      nodesLayer.append(rect);
      rects.push(rect);
    }
    while (rects.length > nodes.length) rects.pop().remove();
    const selected = new Set(store.selection.nodes);
    nodes.forEach((node, i) => {
      const box2 = nodeSize(node);
      const rect = rects[i];
      rect.setAttribute('x', node.x);
      rect.setAttribute('y', node.y);
      rect.setAttribute('width', box2.w);
      rect.setAttribute('height', box2.h);
      rect.dataset.group = typeOf(node.type) ? typeOf(node.type).group : 'logica';
      rect.dataset.selected = selected.has(node.id) ? 'true' : 'false';
    });
    frame.setAttribute('x', seen.x);
    frame.setAttribute('y', seen.y);
    frame.setAttribute('width', seen.w);
    frame.setAttribute('height', seen.h);
  }

  // Centra la vista en el punto del recorrido que está bajo el puntero.
  function jump(event) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const at = point.matrixTransform(matrix.inverse());
    const size = view.size();
    const { zoom } = store.viewport;
    store.setViewport({ x: size.width / 2 - at.x * zoom, y: size.height / 2 - at.y * zoom });
  }

  const offs = [
    on(svg, 'pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pressed = event.pointerId;
      try {
        svg.setPointerCapture(event.pointerId);
      } catch {
        // Sin captura, el arrastre vale mientras el puntero siga sobre el minimapa.
      }
      jump(event);
    }),
    on(svg, 'pointermove', event => {
      if (pressed === event.pointerId) jump(event);
    }),
    on(svg, 'pointerup', event => {
      if (pressed === event.pointerId) pressed = null;
    }),
    on(svg, 'pointercancel', () => {
      pressed = null;
    }),
  ];

  draw();
  return {
    update(change) {
      if (change.graph || change.viewport || change.selection || change.reset || change.resize) draw();
    },
    destroy() {
      for (const off of offs) off();
      container.replaceChildren();
    },
  };
}
