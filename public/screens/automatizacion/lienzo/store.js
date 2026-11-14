// Estado del editor de recorridos, sin DOM: el grafo, la selección, el portapapeles, el historial, la vista (posición y
// acercamiento) y la capa de cifras. El lienzo, el esquema, el panel y el simulador sólo leen de aquí y piden cambios
// aquí; por eso se puede probar entero con `node --test`.
//
// Dos reglas sostienen todo lo demás:
//
// 1. El grafo es inmutable. Cada edición crea un grafo nuevo que comparte con el anterior lo que no cambió, y se
//    congela. Deshacer es volver a la referencia anterior, «hay cambios sin guardar» es comparar dos referencias, y
//    ninguna parte de la interfaz puede estropear el grafo por accidente.
// 2. Toda edición conserva la estructura válida (ids únicos, un Inicio, una conexión por salida, ninguna conexión
//    colgando, dentro de los límites) o no hace nada y devuelve por qué: {ok: false, reason, message}. El contenido a
//    medias (un texto vacío, un botón de más) sí se permite: es un borrador, y eso lo señala la validación.

import {
  GEOMETRY,
  LIMITS,
  VARIABLE_RE,
  VARIABLE_TYPES,
  acceptsInput,
  applyLayout,
  boundsOf,
  createNode,
  issuesByNode,
  layout,
  nextId,
  nodeSize,
  portsOf,
  readingOrder,
  repairGraph,
  typeOf,
  validateGraph,
} from '../../../kit/shared/flow-model.js';

export const ZOOM = Object.freeze({ min: 0.5, max: 1.5, step: 0.1, compact: 0.8 });
export const HISTORY_LIMIT = 100;
export const PASTE_OFFSET = 30;
export const DUPLICATE_OFFSET = 40;

const MESSAGES = {
  read_only: 'El recorrido está en modo de sólo lectura.',
  missing: 'Ese paso ya no existe.',
  type: 'Ese tipo de paso no existe.',
  start: 'El Inicio es único: no se puede quitar, copiar ni agregar otro.',
  port: 'Ese paso no tiene esa salida.',
  source: 'Una nota no se conecta: sólo sirve para dejar comentarios.',
  target: 'No se puede conectar hacia el Inicio ni hacia una nota.',
  empty: 'No hay nada seleccionado.',
  clipboard: 'No hay nada copiado.',
  undo: 'No hay nada que deshacer.',
  redo: 'No hay nada que rehacer.',
  variable: 'El nombre de la variable no es válido o está repetido.',
};

const ok = (extra = {}) => ({ ok: true, ...extra });
const no = (reason, message) => ({
  ok: false,
  reason,
  message: message || MESSAGES[reason] || 'No se pudo hacer el cambio.',
});

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) freeze(inner);
  }
  return value;
}

// Copia con un valor cambiado en una ruta («options.1.label»), sin tocar el original.
function setIn(value, keys, next) {
  if (!keys.length) return next;
  const [key, ...rest] = keys;
  if (Array.isArray(value)) {
    const copy = value.slice();
    copy[Number(key)] = setIn(value[Number(key)], rest, next);
    return copy;
  }
  const base = value && typeof value === 'object' ? value : {};
  return { ...base, [key]: setIn(base[key], rest, next) };
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameEdge = (a, b) => a === b || (Boolean(a) && Boolean(b) && a.from === b.from && a.port === b.port);
const number = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const rectOf = node => ({ x: node.x, y: node.y, ...nodeSize(node) });
const overlap = (a, b, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

export function createStore(options = {}) {
  const limits = { nodes: LIMITS.nodes, edges: LIMITS.edges, variables: LIMITS.variables, ...options.limits };
  const historyLimit = Math.max(1, options.historyLimit ?? HISTORY_LIMIT);
  const listeners = new Set();

  let graph = freeze(repairGraph(options.graph).graph);
  let saved = graph;
  let ctx = options.context || {};
  let readOnly = Boolean(options.readOnly);
  let past = [];
  let future = [];
  let selection = freeze({ nodes: [], edge: null });
  let clipboard = null;
  let pasteCount = 0;
  let viewport = freeze({ x: 0, y: 0, zoom: 1 });
  let snap = true;
  let overlay = freeze({ stats: null, showStats: false, simNode: null, simTrail: [] });

  // Derivados del grafo: se calculan al pedirlos y se tiran con cada grafo nuevo.
  let cache = {};
  const derived = (name, compute) => (name in cache ? cache[name] : (cache[name] = compute()));
  const index = () =>
    derived('index', () => {
      const byId = new Map(graph.nodes.map(n => [n.id, n]));
      const out = new Map();
      const into = new Map();
      for (const e of graph.edges) {
        if (!out.has(e.from)) out.set(e.from, new Map());
        out.get(e.from).set(e.port, e.to);
        if (!into.has(e.to)) into.set(e.to, []);
        into.get(e.to).push(e);
      }
      return { byId, out, into };
    });
  const order = () => derived('order', () => readingOrder(graph));
  const issues = () =>
    derived('issues', () => {
      const result = validateGraph(graph, ctx);
      return { ...result, ...issuesByNode(result) };
    });

  const node = id => index().byId.get(id) || null;
  const edgeFrom = (id, port) => index().out.get(id)?.get(port) ?? null;
  const edgesInto = id => index().into.get(id) || [];

  function emit(change) {
    for (const listener of [...listeners]) listener(change);
  }

  // Una selección sólo puede nombrar pasos y conexiones que existen en el grafo actual.
  function sanitize(sel) {
    const nodes = sel.nodes.filter(id => index().byId.has(id));
    const edge = sel.edge && edgeFrom(sel.edge.from, sel.edge.port) ? sel.edge : null;
    return sameList(nodes, sel.nodes) && edge === sel.edge ? sel : freeze({ nodes, edge });
  }

  function setSelection(next) {
    const clean = sanitize(freeze({ nodes: [...next.nodes], edge: next.edge ? { ...next.edge } : null }));
    if (sameList(clean.nodes, selection.nodes) && sameEdge(clean.edge, selection.edge)) return false;
    selection = clean;
    emit({ selection: true });
    return true;
  }

  // Registra un grafo nuevo en el historial. Con la misma `key` que la edición anterior las dos se funden en un solo
  // paso de «deshacer» (arrastrar un paso o teclear en un campo son muchas ediciones pequeñas y una sola intención).
  function commit(label, next, { key = null, select: wanted } = {}) {
    if (next === graph) return ok({ changed: false });
    const before = graph;
    const selBefore = selection;
    graph = freeze(next);
    cache = {};
    selection = sanitize(wanted ? freeze({ nodes: [...wanted.nodes], edge: wanted.edge || null }) : selection);
    const last = past[past.length - 1];
    if (key && last && last.key === key) {
      past[past.length - 1] = { ...last, after: graph, selAfter: selection };
    } else {
      past.push({ label, key, before, after: graph, selBefore, selAfter: selection });
      if (past.length > historyLimit) past.shift();
    }
    future = [];
    emit({ graph: true, history: true, selection: selection !== selBefore });
    return ok({ changed: true });
  }

  const fix = v => {
    const rounded = snap ? Math.round(v / GEOMETRY.grid) * GEOMETRY.grid : Math.round(v);
    return Math.max(-100_000, Math.min(100_000, rounded));
  };

  // Primer sitio libre bajando desde un punto: un paso nuevo nunca cae encima de otro.
  function freeSpot(x, y, size) {
    const spot = { x: fix(x), y: fix(y), ...size };
    for (let tries = 0; tries < graph.nodes.length + 1; tries += 1) {
      const hit = graph.nodes.find(n => overlap(spot, rectOf(n), GEOMETRY.gapY / 2));
      if (!hit) break;
      spot.y = fix(hit.y + nodeSize(hit).h + GEOMETRY.gapY);
    }
    return { x: spot.x, y: spot.y };
  }

  // Conexión nueva (o cambio de destino) sobre un grafo dado. No registra nada: la usan `connect` y `addNode`.
  function link(g, from, port, to) {
    const a = g.nodes.find(n => n.id === from);
    const b = g.nodes.find(n => n.id === to);
    if (!a || !b) return no('missing');
    if (a.type === 'note') return no('source');
    if (!acceptsInput(b)) return no('target');
    if (!portsOf(a).some(p => p.id === port)) return no('port');
    const current = g.edges.find(e => e.from === from && e.port === port);
    if (current?.to === to) return { ok: true, graph: g, changed: false };
    if (!current && g.edges.length >= limits.edges) {
      return no('limit', `Un recorrido admite hasta ${limits.edges} conexiones.`);
    }
    const edge = { from, port, to };
    const edges = current ? g.edges.map(e => (e === current ? edge : e)) : [...g.edges, edge];
    return { ok: true, graph: { ...g, edges }, changed: true, replaced: Boolean(current) };
  }

  // ---- Edición --------------------------------------------------------------------------------------------------------

  function addNode(type, opts = {}) {
    if (readOnly) return no('read_only');
    if (!typeOf(type)) return no('type');
    if (type === 'start') return no('start');
    if (graph.nodes.length >= limits.nodes) return no('limit', `Un recorrido admite hasta ${limits.nodes} pasos.`);
    const id = nextId(new Set(graph.nodes.map(n => n.id)));
    const draft = createNode(type, { id, title: String(opts.title || '').slice(0, LIMITS.title), data: opts.data });
    const box = boundsOf(graph.nodes);
    const wanted = { x: number(opts.x, box.x + box.w + GEOMETRY.gapX), y: number(opts.y, box.y) };
    const at = opts.exact ? { x: fix(wanted.x), y: fix(wanted.y) } : freeSpot(wanted.x, wanted.y, nodeSize(draft));
    let next = { ...graph, nodes: [...graph.nodes, { ...draft, x: at.x, y: at.y }] };
    let connected = false;
    if (opts.connect) {
      const linked = link(next, opts.connect.from, opts.connect.port, id);
      if (linked.ok) {
        next = linked.graph;
        connected = true;
      }
    }
    commit('Agregar paso', next, { select: opts.select === false ? null : { nodes: [id], edge: null } });
    return ok({ id, connected });
  }

  // Lo que hace un clic en la paleta: el paso cae junto al seleccionado y se conecta a su primera salida libre.
  function addNodeNear(type, opts = {}) {
    const anchor = node(opts.anchor ?? selection.nodes[selection.nodes.length - 1]);
    if (!anchor) return addNode(type, opts.at ? { x: opts.at.x, y: opts.at.y } : {});
    const ports = portsOf(anchor);
    const free = ports.find(p => !edgeFrom(anchor.id, p.id));
    const row = free ? ports.indexOf(free) : 0;
    return addNode(type, {
      x: anchor.x + GEOMETRY.width + GEOMETRY.gapX,
      y: anchor.y + row * GEOMETRY.port,
      connect: free && type !== 'note' ? { from: anchor.id, port: free.id } : null,
    });
  }

  function setPositions(map, opts = {}) {
    if (readOnly) return no('read_only');
    let changed = false;
    const nodes = graph.nodes.map(n => {
      const to = map[n.id];
      if (!to) return n;
      const x = fix(number(to.x, n.x));
      const y = fix(number(to.y, n.y));
      if (x === n.x && y === n.y) return n;
      changed = true;
      return { ...n, x, y };
    });
    if (!changed) return ok({ changed: false });
    return commit('Mover', { ...graph, nodes }, { key: opts.coalesce || null });
  }

  function moveNodes(ids, dx, dy, opts = {}) {
    const map = {};
    for (const id of ids) {
      const n = node(id);
      if (n) map[id] = { x: n.x + dx, y: n.y + dy };
    }
    return setPositions(map, opts);
  }

  function deleteNodes(ids) {
    if (readOnly) return no('read_only');
    const found = [...new Set(ids)].map(node).filter(Boolean);
    const doomed = new Set(found.filter(n => n.type !== 'start').map(n => n.id));
    if (!doomed.size) return no(found.length ? 'start' : 'missing');
    const next = {
      ...graph,
      nodes: graph.nodes.filter(n => !doomed.has(n.id)),
      edges: graph.edges.filter(e => !doomed.has(e.from) && !doomed.has(e.to)),
    };
    commit('Eliminar', next);
    return ok({ removed: [...doomed] });
  }

  function disconnect(from, port) {
    if (readOnly) return no('read_only');
    if (edgeFrom(from, port) === null) return ok({ changed: false });
    return commit('Desconectar', { ...graph, edges: graph.edges.filter(e => !(e.from === from && e.port === port)) });
  }

  function deleteSelection() {
    if (selection.edge) return disconnect(selection.edge.from, selection.edge.port);
    if (!selection.nodes.length) return no('empty');
    return deleteNodes(selection.nodes);
  }

  // Inserta copias con ids nuevos. Sólo se copian las conexiones entre los propios pasos copiados: una copia que
  // heredara las salidas hacia el resto del recorrido crearía caminos que nadie pidió.
  function insertCopies(nodes, edges, shift, label) {
    if (readOnly) return no('read_only');
    if (!nodes.length) return no('empty');
    if (graph.nodes.length + nodes.length > limits.nodes) {
      return no('limit', `Un recorrido admite hasta ${limits.nodes} pasos.`);
    }
    const taken = new Set(graph.nodes.map(n => n.id));
    const renamed = new Map();
    const copies = nodes.map(n => {
      const id = nextId(taken);
      taken.add(id);
      renamed.set(n.id, id);
      return { ...n, id, x: fix(n.x + shift.x), y: fix(n.y + shift.y) };
    });
    const links = edges
      .filter(e => renamed.has(e.from) && renamed.has(e.to))
      .map(e => ({ from: renamed.get(e.from), port: e.port, to: renamed.get(e.to) }));
    if (graph.edges.length + links.length > limits.edges) {
      return no('limit', `Un recorrido admite hasta ${limits.edges} conexiones.`);
    }
    const next = { ...graph, nodes: [...graph.nodes, ...copies], edges: [...graph.edges, ...links] };
    const created = copies.map(c => c.id);
    commit(label, next, { select: { nodes: created, edge: null } });
    return ok({ ids: created, renamed: Object.fromEntries(renamed) });
  }

  // Los pasos que se pueden copiar de una lista de ids (el Inicio no), con las conexiones entre ellos.
  function copyable(ids) {
    const wanted = new Set(ids);
    const nodes = graph.nodes.filter(n => wanted.has(n.id) && n.type !== 'start');
    const inside = new Set(nodes.map(n => n.id));
    return { nodes, edges: graph.edges.filter(e => inside.has(e.from) && inside.has(e.to)) };
  }

  function duplicateNodes(ids = selection.nodes) {
    const { nodes, edges } = copyable(ids);
    if (!nodes.length && ids.some(id => node(id)?.type === 'start')) return no('start');
    return insertCopies(nodes, edges, { x: DUPLICATE_OFFSET, y: DUPLICATE_OFFSET }, 'Duplicar');
  }

  function copy(ids = selection.nodes) {
    const { nodes, edges } = copyable(ids);
    if (!nodes.length) return no(ids.length ? 'start' : 'empty');
    const box = boundsOf(nodes);
    clipboard = freeze({ nodes, edges, origin: { x: box.x, y: box.y } });
    pasteCount = 0;
    emit({ clipboard: true });
    return ok({ count: nodes.length });
  }

  function cut(ids = selection.nodes) {
    if (readOnly) return no('read_only');
    const copied = copy(ids);
    return copied.ok ? deleteNodes(clipboard.nodes.map(n => n.id)) : copied;
  }

  // Sin punto de destino, cada pegado cae un poco más abajo y a la derecha que el anterior, para que no se tapen.
  function paste(opts = {}) {
    if (!clipboard) return no('clipboard');
    const step = PASTE_OFFSET * (pasteCount + 1);
    const shift = opts.at
      ? { x: opts.at.x - clipboard.origin.x, y: opts.at.y - clipboard.origin.y }
      : { x: step, y: step };
    const result = insertCopies(clipboard.nodes, clipboard.edges, shift, 'Pegar');
    if (result.ok) pasteCount += 1;
    return result;
  }

  function connect(from, port, to) {
    if (readOnly) return no('read_only');
    const linked = link(graph, from, port, to);
    if (!linked.ok) return linked;
    if (!linked.changed) return ok({ changed: false });
    commit('Conectar', linked.graph);
    return ok({ changed: true, replaced: linked.replaced });
  }

  function setTitle(id, title, opts = {}) {
    if (readOnly) return no('read_only');
    const current = node(id);
    if (!current) return no('missing');
    const value = String(title ?? '').slice(0, LIMITS.title);
    if ((current.title || '') === value) return ok({ changed: false });
    // Un título vacío no se guarda: la forma canónica no lleva la clave.
    const { id: same, type, x, y, data } = current;
    const renamed = value ? { id: same, type, title: value, x, y, data } : { id: same, type, x, y, data };
    const nodes = graph.nodes.map(n => (n === current ? renamed : n));
    return commit('Cambiar título', { ...graph, nodes }, { key: opts.coalesce || null });
  }

  // Cambia los ajustes de un paso. Los deja en su forma canónica y quita las conexiones de las salidas que dejaron de
  // existir (al borrar un botón, por ejemplo): el cambio y esa limpieza son un solo paso del historial.
  function writeData(id, change, opts) {
    if (readOnly) return no('read_only');
    const current = node(id);
    if (!current) return no('missing');
    const def = typeOf(current.type);
    if (!def) return no('type');
    const data = def.clean(change(current.data));
    if (JSON.stringify(data) === JSON.stringify(current.data)) return ok({ changed: false });
    const updated = { ...current, data };
    const ports = new Set(portsOf(updated).map(p => p.id));
    const edges = graph.edges.filter(e => e.from !== id || ports.has(e.port));
    const pruned = graph.edges.length - edges.length;
    const next = {
      ...graph,
      nodes: graph.nodes.map(n => (n === current ? updated : n)),
      edges: pruned ? edges : graph.edges,
    };
    return { ...commit('Editar paso', next, { key: opts?.coalesce || null }), pruned };
  }

  const setData = (id, path, value, opts) => writeData(id, data => setIn(data, String(path).split('.'), value), opts);
  const mergeData = (id, patch, opts) => writeData(id, data => ({ ...data, ...patch }), opts);

  function setVariables(list) {
    if (readOnly) return no('read_only');
    const input = Array.isArray(list) ? list : [];
    if (input.length > limits.variables) {
      return no('limit', `Un recorrido admite hasta ${limits.variables} variables.`);
    }
    const names = new Set();
    const variables = [];
    for (const v of input) {
      const name = typeof v?.name === 'string' ? v.name : '';
      if (!VARIABLE_RE.test(name) || names.has(name)) return no('variable');
      names.add(name);
      const type = VARIABLE_TYPES.some(t => t[0] === v.type) ? v.type : 'text';
      variables.push({ name, label: typeof v.label === 'string' ? v.label : '', type });
    }
    if (JSON.stringify(variables) === JSON.stringify(graph.variables)) return ok({ changed: false });
    return commit('Cambiar variables', { ...graph, variables });
  }

  function autoLayout() {
    if (readOnly) return no('read_only');
    const { positions } = layout(graph);
    if (graph.nodes.every(n => positions[n.id].x === n.x && positions[n.id].y === n.y)) return ok({ changed: false });
    return commit('Acomodar', applyLayout(graph, positions));
  }

  // ---- Historial ------------------------------------------------------------------------------------------------------

  // Cierra la edición en curso: la siguiente, aunque lleve la misma `key`, será otro paso del historial.
  function seal() {
    const last = past[past.length - 1];
    if (last?.key) past[past.length - 1] = { ...last, key: null };
  }

  function undo() {
    if (readOnly) return no('read_only');
    const entry = past.pop();
    if (!entry) return no('undo');
    future.push(entry);
    graph = entry.before;
    cache = {};
    selection = sanitize(entry.selBefore);
    // Lo que se edite después de deshacer es una edición nueva: no se funde con la que quedó arriba del historial.
    seal();
    emit({ graph: true, history: true, selection: true });
    return ok({ label: entry.label });
  }

  function redo() {
    if (readOnly) return no('read_only');
    const entry = future.pop();
    if (!entry) return no('redo');
    past.push(entry);
    graph = entry.after;
    cache = {};
    selection = sanitize(entry.selAfter);
    seal();
    emit({ graph: true, history: true, selection: true });
    return ok({ label: entry.label });
  }

  // ---- Selección ------------------------------------------------------------------------------------------------------

  function select(ids, mode = 'replace') {
    const valid = [...new Set(Array.isArray(ids) ? ids : [ids])].filter(id => index().byId.has(id));
    const rest = selection.nodes.filter(id => !valid.includes(id));
    let nodes = valid;
    if (mode === 'add') nodes = [...rest, ...valid];
    if (mode === 'toggle') nodes = valid.every(id => selection.nodes.includes(id)) ? rest : [...rest, ...valid];
    return setSelection({ nodes, edge: null });
  }

  const selectEdge = edge => setSelection({ nodes: [], edge: edge ? { from: edge.from, port: edge.port } : null });
  const selectAll = () => setSelection({ nodes: order(), edge: null });
  const clearSelection = () => setSelection({ nodes: [], edge: null });

  // Pasos cuyo rectángulo toca uno dado (en coordenadas del lienzo): es el marco de selección.
  function nodesInRect(rect) {
    const box = {
      x: Math.min(rect.x, rect.x + rect.w),
      y: Math.min(rect.y, rect.y + rect.h),
      w: Math.abs(rect.w),
      h: Math.abs(rect.h),
    };
    return order().filter(id => overlap(box, rectOf(node(id))));
  }

  // A qué paso lleva una flecha del teclado desde otro: a la derecha, el destino de su primera salida conectada; a la
  // izquierda, el paso del que viene; arriba y abajo, el anterior y el siguiente en el orden de lectura.
  function neighbour(id, direction) {
    const current = node(id);
    if (!current) return null;
    const list = order();
    const at = list.indexOf(id);
    if (direction === 'down') return list[at + 1] ?? null;
    if (direction === 'up') return list[at - 1] ?? null;
    if (direction === 'right') {
      const port = portsOf(current).find(p => edgeFrom(id, p.id));
      return port ? edgeFrom(id, port.id) : null;
    }
    const sources = edgesInto(id).map(e => e.from);
    return list.find(other => sources.includes(other) && other !== id) ?? null;
  }

  // ---- Vista ----------------------------------------------------------------------------------------------------------

  const clampZoom = z => Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(z * 100) / 100));
  const toWorld = point => ({ x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom });
  const toScreen = point => ({ x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y });

  function setViewport(next) {
    const view = {
      x: Math.round(number(next.x, viewport.x)),
      y: Math.round(number(next.y, viewport.y)),
      zoom: clampZoom(number(next.zoom, viewport.zoom)),
    };
    if (view.x === viewport.x && view.y === viewport.y && view.zoom === viewport.zoom) return false;
    viewport = freeze(view);
    emit({ viewport: true });
    return true;
  }

  const panBy = (dx, dy) => setViewport({ x: viewport.x + dx, y: viewport.y + dy });

  // Acerca o aleja dejando quieto el punto de la pantalla indicado (el cursor, o el centro entre dos dedos).
  function zoomTo(zoom, center = { x: 0, y: 0 }) {
    const next = clampZoom(zoom);
    const world = toWorld(center);
    return setViewport({ zoom: next, x: center.x - world.x * next, y: center.y - world.y * next });
  }

  const zoomBy = (steps, center) => zoomTo(viewport.zoom + steps * ZOOM.step, center);

  // «Ajustar»: todo el recorrido a la vista, sin pasar del 100 %.
  function fit({ width, height, padding = 40 }) {
    const box = boundsOf(graph.nodes);
    if (!box.w || !box.h || !width || !height) return setViewport({ x: padding, y: padding, zoom: 1 });
    const zoom = clampZoom(Math.min(1, (width - padding * 2) / box.w, (height - padding * 2) / box.h));
    // Si cabe, queda centrado. Si ni al mínimo cabe (un recorrido largo en una ventana estrecha), se muestra desde
    // su principio: lo que debe verse es el Inicio, no la mitad del recorrido.
    const place = (space, size, start) =>
      (size * zoom <= space - padding * 2 ? (space - size * zoom) / 2 : padding) - start * zoom;
    return setViewport({ zoom, x: place(width, box.w, box.x), y: place(height, box.h, box.y) });
  }

  // Mueve la vista lo justo para que un paso quede a la vista (al llegar a él con el teclado o con «Ir al paso»).
  function reveal(id, { width, height, padding = 24 }) {
    const target = node(id);
    if (!target || !width || !height) return false;
    const size = nodeSize(target);
    const a = toScreen({ x: target.x, y: target.y });
    const b = toScreen({ x: target.x + size.w, y: target.y + size.h });
    let dx = 0;
    let dy = 0;
    if (b.x - a.x > width - padding * 2 || a.x < padding) dx = padding - a.x;
    else if (b.x > width - padding) dx = width - padding - b.x;
    if (b.y - a.y > height - padding * 2 || a.y < padding) dy = padding - a.y;
    else if (b.y > height - padding) dy = height - padding - b.y;
    return dx || dy ? panBy(dx, dy) : false;
  }

  // ---- Sesión ---------------------------------------------------------------------------------------------------------

  function setGraph(input) {
    const { graph: next, repairs } = repairGraph(input);
    graph = freeze(next);
    saved = graph;
    cache = {};
    past = [];
    future = [];
    selection = freeze({ nodes: [], edge: null });
    emit({ graph: true, history: true, selection: true, reset: true });
    return repairs;
  }

  function markSaved(which = graph) {
    saved = which;
    emit({ history: true });
  }

  function setReadOnly(value) {
    if (readOnly === Boolean(value)) return;
    readOnly = Boolean(value);
    emit({ mode: true });
  }

  function setContext(next) {
    ctx = next || {};
    delete cache.issues;
    emit({ context: true });
  }

  function setOverlay(patch) {
    overlay = freeze({ ...overlay, ...patch });
    emit({ overlay: true });
  }

  function setSnap(value) {
    snap = Boolean(value);
    emit({ mode: true });
  }

  return {
    get graph() {
      return graph;
    },
    get selection() {
      return selection;
    },
    get viewport() {
      return viewport;
    },
    get readOnly() {
      return readOnly;
    },
    get clipboard() {
      return clipboard;
    },
    get overlay() {
      return overlay;
    },
    get snap() {
      return snap;
    },
    get context() {
      return ctx;
    },
    node,
    edgeFrom,
    edgesInto,
    order,
    issues,
    issuesFor: id => issues().byNode.get(id) || { errors: [], warnings: [] },
    neighbour,
    nodesInRect,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undoLabel: () => past[past.length - 1]?.label || '',
    redoLabel: () => future[future.length - 1]?.label || '',
    historySize: () => past.length,
    isDirty: () => graph !== saved,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setGraph,
    markSaved,
    setReadOnly,
    setContext,
    setOverlay,
    setSnap,
    addNode,
    addNodeNear,
    setPositions,
    moveNodes,
    deleteNodes,
    deleteSelection,
    duplicateNodes,
    connect,
    disconnect,
    setTitle,
    setData,
    mergeData,
    setVariables,
    autoLayout,
    copy,
    cut,
    paste,
    undo,
    redo,
    seal,
    select,
    selectEdge,
    selectAll,
    clearSelection,
    setViewport,
    panBy,
    zoomTo,
    zoomBy,
    fit,
    reveal,
    toWorld,
    toScreen,
  };
}
