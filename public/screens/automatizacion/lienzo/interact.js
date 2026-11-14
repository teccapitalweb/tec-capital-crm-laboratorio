// Gestos y teclado del lienzo. Traduce lo que hace la persona (arrastrar, soltar, la rueda, dos dedos, una tecla) en
// peticiones al store; no dibuja nada salvo lo provisional de un gesto (la conexión que se está tendiendo y el marco de
// selección), que pide a la vista.
//
// Con Pointer Events el mismo código atiende ratón, lápiz y dedo. La captura del puntero sólo se pide cuando el gesto
// ya es un arrastre: si se pidiera al pulsar, el clic de los botones de la tarjeta llegaría al lienzo y no al botón.
//
// Todo lo que se hace con el ratón tiene su tecla:
//   Tab                 recorre los pasos en orden de lectura        Flechas            van al paso vecino (o mueven el lienzo)
//   Entrar              abre el panel del paso                       Espacio            lo agrega o quita de la selección
//   Alt + flechas       mueven los pasos seleccionados               Supr               elimina lo seleccionado
//   C                   conecta: lleva al panel, a sus salidas       Ctrl+C, X, V, D    copiar, cortar, pegar, duplicar
//   + y −               acercan y alejan                             0 y 1              ajustar a la vista y 100 %
//   Esc                 cancela el gesto o quita la selección        Ctrl+A             selecciona todo
// Deshacer, rehacer y guardar (Ctrl+Z, Ctrl+Mayús+Z, Ctrl+S) los atiende index.js, porque valen en todo el editor.

import { GEOMETRY, acceptsInput, portPoint } from '../../../kit/shared/flow-model.js';
import { on } from './dom.js';
import { ZOOM } from './store.js';

const DRAG_THRESHOLD = 4;
const ARROWS = {
  ArrowLeft: [-1, 0, 'left'],
  ArrowRight: [1, 0, 'right'],
  ArrowUp: [0, -1, 'up'],
  ArrowDown: [0, 1, 'down'],
};
const clampZoom = z => Math.min(ZOOM.max, Math.max(ZOOM.min, z));
const closest = (target, selector) =>
  target && typeof target.closest === 'function' ? target.closest(selector) : null;

// `actions`: {edit(id), connect(id), tapped(id, wasSelected), report(resultado, textoSiSaleBien), announce(texto)}.
export function attachInteractions({ canvas, view, store, actions }) {
  const pointers = new Map();
  let gesture = null;
  let pinch = null;
  let drags = 0;
  let wheelZoom = null;
  let wheelAt = 0;
  let lastTap = { node: null, at: 0 };

  const release = id => {
    try {
      canvas.releasePointerCapture(id);
    } catch {
      // El puntero ya no existe (se levantó fuera de la ventana): no hay nada que soltar.
    }
  };

  function cancelGesture(revert) {
    const g = gesture;
    gesture = null;
    view.clearDraft();
    view.setDrop(null);
    view.setMarquee(null);
    delete canvas.dataset.dragging;
    delete canvas.dataset.connecting;
    if (!g) return;
    release(g.id);
    if (g.active && g.kind === 'node') {
      store.seal();
      // Un arrastre cancelado no debe dejar los pasos a medio camino.
      if (revert) store.undo();
    }
    if (g.active && g.kind === 'pan' && revert) store.setViewport(g.view);
  }

  // ---- Dos dedos: acercar y desplazar a la vez ------------------------------------------------------------------------

  const twoPoints = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, middle: view.toLocal((a.x + b.x) / 2, (a.y + b.y) / 2) };
  };

  function startPinch() {
    cancelGesture(true);
    const now = twoPoints();
    // El punto del recorrido que queda entre los dos dedos debe seguir entre ellos mientras dure el gesto.
    pinch = { distance: now.distance, zoom: store.viewport.zoom, anchor: store.toWorld(now.middle) };
  }

  function movePinch() {
    const now = twoPoints();
    const zoom = clampZoom((pinch.zoom * now.distance) / pinch.distance);
    store.setViewport({ zoom, x: now.middle.x - pinch.anchor.x * zoom, y: now.middle.y - pinch.anchor.y * zoom });
  }

  // ---- Un puntero: mover el lienzo, mover pasos, conectar o marcar -----------------------------------------------------

  function down(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) return startPinch();
    if (pointers.size > 2) return undefined;

    const handle = closest(event.target, '.lz-handle');
    const card = closest(event.target, '.lz-node');
    const base = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      active: false,
      multi: event.shiftKey || event.ctrlKey || event.metaKey,
      touch: event.pointerType === 'touch',
    };
    if (handle && card && !store.readOnly) {
      gesture = { ...base, kind: 'connect', from: card.dataset.node, port: closest(handle, '.lz-port').dataset.port };
    } else if (closest(event.target, 'button, select, input, textarea, a, .lz-edge')) {
      gesture = null;
    } else if (card) {
      gesture = {
        ...base,
        kind: 'node',
        node: card.dataset.node,
        wasSelected: store.selection.nodes.includes(card.dataset.node),
      };
    } else {
      gesture = { ...base, kind: event.shiftKey ? 'marquee' : 'pan', view: store.viewport };
    }
    // Con el puntero capturado el gesto sigue aunque salga del lienzo, y no se pierde si el primer movimiento ya cae
    // fuera. Los botones de las tarjetas y las conexiones no llegan aquí: conservan su clic.
    if (gesture) {
      // El teclado sigue al ratón: después de pulsar en el lienzo, sus atajos valen sin tener que tabular hasta él.
      if (!canvas.contains(canvas.ownerDocument.activeElement)) canvas.focus({ preventScroll: true });
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Sin captura el gesto sigue funcionando mientras el puntero no salga del lienzo.
      }
    }
    return undefined;
  }

  function begin(g) {
    if (g.kind === 'node') {
      // Con el dedo, arrastrar un paso que no está seleccionado mueve el lienzo: en una pantalla pequeña las tarjetas
      // lo ocupan casi todo y, si no, no habría de dónde desplazarlo. Para mover un paso primero se toca y luego se arrastra.
      if (store.readOnly || (g.touch && !g.wasSelected)) {
        g.kind = 'pan';
        g.view = store.viewport;
        return;
      }
      if (!store.selection.nodes.includes(g.node)) store.select(g.node, g.multi ? 'add' : 'replace');
      g.origin = Object.fromEntries(
        store.selection.nodes.map(id => [id, { x: store.node(id).x, y: store.node(id).y }]),
      );
      drags += 1;
      g.key = `arrastre:${drags}`;
      canvas.dataset.dragging = 'true';
    } else if (g.kind === 'connect') {
      // Mientras se tiende una conexión se ven los puntos de llegada de los pasos.
      canvas.dataset.connecting = 'true';
    }
  }

  function drag(g, event) {
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (g.kind === 'pan') {
      store.setViewport({ x: g.view.x + dx, y: g.view.y + dy });
    } else if (g.kind === 'node') {
      const zoom = store.viewport.zoom;
      const map = {};
      for (const [id, from] of Object.entries(g.origin)) map[id] = { x: from.x + dx / zoom, y: from.y + dy / zoom };
      store.setPositions(map, { coalesce: g.key });
    } else if (g.kind === 'marquee') {
      const a = view.toLocal(g.x, g.y);
      view.setMarquee({ x: a.x, y: a.y, w: dx, h: dy });
    } else if (g.kind === 'connect') {
      const from = store.node(g.from);
      const start = from ? portPoint(from, g.port) : null;
      if (!start) return cancelGesture(false);
      view.setDraft(start, view.toWorld(event.clientX, event.clientY));
      const over = view.nodeAt(event.clientX, event.clientY);
      view.setDrop(over && acceptsInput(store.node(over)) ? over : null);
    }
    return undefined;
  }

  function move(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch) {
      if (pointers.size >= 2) movePinch();
      return;
    }
    const g = gesture;
    if (!g || g.id !== event.pointerId) return;
    if (!g.active) {
      if (Math.hypot(event.clientX - g.x, event.clientY - g.y) < DRAG_THRESHOLD) return;
      g.active = true;
      begin(g);
    }
    drag(g, event);
  }

  // Un toque o un clic, sin arrastre.
  function tap(g, event) {
    if (g.kind === 'node') {
      store.select(g.node, g.multi ? 'toggle' : 'replace');
      view.focusNode(g.node);
      // Dos toques seguidos sobre el mismo paso abren sus ajustes. Se detecta aquí, y no con el evento de doble clic,
      // porque con el puntero capturado ese evento llega al lienzo y no a la tarjeta; así además vale para el dedo.
      const again = lastTap.node === g.node && event.timeStamp - lastTap.at < 400;
      lastTap = { node: again ? null : g.node, at: event.timeStamp };
      if (again && !g.multi) actions.edit(g.node);
      else actions.tapped(g.node, g.wasSelected);
    } else if (g.kind === 'connect') {
      // Tocar una salida conectada selecciona su conexión (para poder quitarla).
      if (store.edgeFrom(g.from, g.port)) store.selectEdge({ from: g.from, port: g.port });
    } else {
      store.clearSelection();
      canvas.focus({ preventScroll: true });
    }
  }

  function up(event) {
    pointers.delete(event.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    const g = gesture;
    if (!g || g.id !== event.pointerId) return;
    gesture = null;
    release(g.id);
    if (!g.active) {
      tap(g, event);
      return;
    }
    if (g.kind === 'node') {
      store.seal();
      delete canvas.dataset.dragging;
    } else if (g.kind === 'marquee') {
      const a = view.toWorld(g.x, g.y);
      const b = view.toWorld(event.clientX, event.clientY);
      view.setMarquee(null);
      store.select(
        store.nodesInRect({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }),
        event.ctrlKey || event.metaKey ? 'add' : 'replace',
      );
    } else if (g.kind === 'connect') {
      const to = view.nodeAt(event.clientX, event.clientY);
      view.clearDraft();
      view.setDrop(null);
      delete canvas.dataset.connecting;
      if (to) actions.report(store.connect(g.from, g.port, to), 'Pasos conectados.');
    }
  }

  function cancel(event) {
    pointers.delete(event.pointerId);
    if (pinch && pointers.size < 2) pinch = null;
    if (gesture && gesture.id === event.pointerId) cancelGesture(true);
  }

  // ---- Rueda: desplaza; con Ctrl (o el pellizco del panel táctil, que llega así) acerca ---------------------------------

  function wheel(event) {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? view.size().height : 1;
    if (event.ctrlKey || event.metaKey) {
      // Se acumula aparte porque el store redondea el acercamiento a centésimas: los pasos pequeños de un panel
      // táctil se perderían uno por uno.
      if (wheelZoom === null || event.timeStamp - wheelAt > 250) wheelZoom = store.viewport.zoom;
      wheelAt = event.timeStamp;
      wheelZoom = clampZoom(wheelZoom * Math.exp(-event.deltaY * unit * 0.0025));
      store.zoomTo(wheelZoom, view.toLocal(event.clientX, event.clientY));
      return;
    }
    const sideways = event.shiftKey && !event.deltaX;
    store.panBy(-(sideways ? event.deltaY : event.deltaX) * unit, sideways ? 0 : -event.deltaY * unit);
  }

  // ---- Teclado -------------------------------------------------------------------------------------------------------

  const centre = () => {
    const size = view.size();
    return { x: size.width / 2, y: size.height / 2 };
  };

  function key(event) {
    if (event.defaultPrevented || closest(event.target, 'input, textarea, select')) return;
    const card = closest(event.target, '.lz-node');
    const id = card ? card.dataset.node : null;
    // El paso enfocado es el sujeto de la orden: si no estaba seleccionado, se selecciona solo.
    const claim = () => {
      if (id && !store.selection.nodes.includes(id)) store.select(id);
      return store.selection.nodes.length > 0 || Boolean(store.selection.edge);
    };
    const handled = () => event.preventDefault();

    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const letter = event.key.toLowerCase();
      if (letter === 'a') {
        store.selectAll();
        actions.announce(`${store.selection.nodes.length} pasos seleccionados.`);
      } else if (letter === 'c') {
        if (claim()) actions.report(store.copy(), 'Copiado.');
      } else if (letter === 'x') {
        if (claim()) actions.report(store.cut(), 'Cortado.');
      } else if (letter === 'v') {
        const pasted = store.paste();
        actions.report(pasted, 'Pegado.');
        if (pasted.ok) view.focusNode(pasted.ids[0]);
      } else if (letter === 'd') {
        if (claim()) {
          const copies = store.duplicateNodes();
          actions.report(copies, 'Duplicado.');
          if (copies.ok) view.focusNode(copies.ids[0]);
        }
      } else return;
      handled();
      return;
    }

    const arrow = ARROWS[event.key];
    if (arrow) {
      const [dx, dy, direction] = arrow;
      if (event.altKey) {
        if (claim() && store.selection.nodes.length) {
          const step = GEOMETRY.grid * (event.shiftKey ? 5 : 1);
          actions.report(store.moveNodes(store.selection.nodes, dx * step, dy * step));
          if (id) store.reveal(id, view.size());
        }
      } else if (id) {
        const next = store.neighbour(id, direction);
        if (next) view.focusNode(next);
      } else {
        const step = event.shiftKey ? 200 : 40;
        store.panBy(-dx * step, -dy * step);
      }
      handled();
      return;
    }

    switch (event.key) {
      case 'Delete':
      case 'Backspace': {
        if (!claim()) return;
        const fallback = id ? store.neighbour(id, 'up') : null;
        const removed = store.deleteSelection();
        actions.report(removed, 'Eliminado.');
        // El elemento enfocado ya no existe: el foco pasa al paso anterior en lugar de perderse.
        if (removed.ok && !(fallback && view.focusNode(fallback))) canvas.focus({ preventScroll: true });
        break;
      }
      case 'Escape':
        if (gesture || pinch) cancelGesture(true);
        else store.clearSelection();
        break;
      case 'Enter':
        if (!id) return;
        store.select(id);
        actions.edit(id);
        break;
      case ' ':
        if (!id) return;
        store.select(id, 'toggle');
        break;
      case 'c':
      case 'C':
        if (!id) return;
        store.select(id);
        actions.connect(id);
        break;
      case '+':
      case '=':
        store.zoomBy(1, centre());
        break;
      case '-':
      case '_':
        store.zoomBy(-1, centre());
        break;
      case '0':
        store.fit(view.size());
        break;
      case '1':
        store.zoomTo(1, centre());
        break;
      default:
        return;
    }
    handled();
  }

  // Al llegar a un paso con el teclado, la vista se mueve para que se vea.
  function focusIn(event) {
    const card = closest(event.target, '.lz-node');
    if (!card || event.target !== card) return;
    let byKeyboard = true;
    try {
      byKeyboard = card.matches(':focus-visible');
    } catch {
      byKeyboard = true;
    }
    if (byKeyboard) store.reveal(card.dataset.node, view.size());
  }

  const offs = [
    on(canvas, 'pointerdown', down),
    on(canvas, 'pointermove', move),
    on(canvas, 'pointerup', up),
    on(canvas, 'pointercancel', cancel),
    on(canvas, 'wheel', wheel, { passive: false }),
    on(canvas, 'keydown', key),
    on(canvas, 'focusin', focusIn),
  ];

  return () => {
    cancelGesture(false);
    for (const off of offs) off();
  };
}
