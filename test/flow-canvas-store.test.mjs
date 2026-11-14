// Estado del editor de recorridos (public/screens/automatizacion/lienzo/store.js): cada edición, deshacer y rehacer
// contra una referencia ingenua, el tope del historial, los desplazamientos al pegar y los invariantes de estructura
// después de secuencias de operaciones al azar. No usa DOM: el módulo se importa tal cual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEOMETRY,
  LIMITS,
  NODE_TYPES,
  checkStructure,
  layout,
  normalizeGraph,
  portsOf,
} from '../public/kit/shared/flow-model.js';
import { templateByKey } from '../public/kit/shared/flow-templates.js';
import {
  DUPLICATE_OFFSET,
  HISTORY_LIMIT,
  PASTE_OFFSET,
  ZOOM,
  createStore,
} from '../public/screens/automatizacion/lienzo/store.js';

const N = (id, type, data = {}, extra = {}) => ({ id, type, x: 0, y: 0, data, ...extra });
const E = (from, port, to) => ({ from, port, to });
const say = body => ({ parts: [{ kind: 'text', text: body }] });
const goto = { type: 'goto' };
const buttons = labels => ({
  text: '¿Qué prefieres?',
  options: labels.map((label, i) => ({ id: 'o' + (i + 1), label, do: goto })),
});
const json = value => JSON.stringify(value);
const copyOf = value => JSON.parse(JSON.stringify(value));

// Inicio (n1) → Botones (n2) con dos opciones → Mensaje (n3) y Mensaje (n4); n3 → Fin (n5).
const sample = () => ({
  v: 1,
  start: 'n1',
  nodes: [
    N('n1', 'start', {}, { x: 40, y: 40 }),
    N('n2', 'buttons', buttons(['Sí', 'No']), { x: 360, y: 40 }),
    N('n3', 'message', say('Qué bien'), { x: 680, y: 40 }),
    N('n4', 'message', say('Qué pena'), { x: 680, y: 200 }),
    N('n5', 'end', {}, { x: 1000, y: 40 }),
  ],
  edges: [E('n1', 'next', 'n2'), E('n2', 'opt:o1', 'n3'), E('n2', 'opt:o2', 'n4'), E('n3', 'next', 'n5')],
  variables: [],
});
const open = (options = {}) => createStore({ graph: sample(), ...options });
const ids = store => store.graph.nodes.map(n => n.id);
const at = (store, id) => [store.node(id).x, store.node(id).y];
const refused = (result, reason) => {
  assert.equal(result.ok, false, `se esperaba un rechazo «${reason}»`);
  assert.equal(result.reason, reason);
  assert.ok(result.message.length > 10, 'el rechazo explica por qué, en español');
};

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Todo lo que debe cumplirse después de cualquier operación, haya tenido éxito o no.
function assertInvariants(store, limits = LIMITS) {
  const graph = store.graph;
  assert.deepEqual(checkStructure(graph), []);
  assert.ok(
    graph.nodes.length <= limits.nodes &&
      graph.edges.length <= limits.edges &&
      graph.variables.length <= limits.variables,
  );
  assert.ok(Object.isFrozen(graph) && Object.isFrozen(graph.nodes) && Object.isFrozen(graph.edges));
  for (const n of graph.nodes) assert.ok(Object.isFrozen(n) && Object.isFrozen(n.data), `${n.id} congelado`);
  const known = new Set(graph.nodes.map(n => n.id));
  for (const id of store.selection.nodes) assert.ok(known.has(id), 'la selección sólo nombra pasos que existen');
  assert.equal(new Set(store.selection.nodes).size, store.selection.nodes.length);
  if (store.selection.edge) assert.ok(store.edgeFrom(store.selection.edge.from, store.selection.edge.port));
  assert.deepEqual([...store.order()].sort(), [...known].sort(), 'el orden de lectura nombra cada paso una vez');
}

// ---- Abrir -----------------------------------------------------------------------------------------------------------

test('abrir: el grafo queda canónico y congelado; lo que llegue roto se repara', () => {
  const store = open();
  assert.deepEqual(copyOf(store.graph), normalizeGraph(sample()));
  assertInvariants(store);
  assert.throws(() => {
    store.graph.nodes[0].x = 5;
  }, TypeError);
  assert.throws(() => store.graph.nodes.push({}), TypeError);
  assert.equal(store.isDirty(), false);
  assert.equal(store.canUndo(), false);
  assert.equal(store.canRedo(), false);
  assert.deepEqual(copyOf(store.selection), { nodes: [], edge: null });
  assert.deepEqual(copyOf(store.viewport), { x: 0, y: 0, zoom: 1 });

  const broken = createStore({
    graph: {
      nodes: [
        { id: 'x', type: 'message' },
        { id: 'x', type: 'message' },
      ],
      edges: [{ from: 'x', port: 'next', to: 'nadie' }],
    },
  });
  assertInvariants(broken);
  assert.equal(broken.graph.nodes.filter(n => n.type === 'start').length, 1);
  assertInvariants(createStore());
  assert.deepEqual(
    createStore().graph.nodes.map(n => n.type),
    ['start'],
  );
  // Una plantilla de la biblioteca (congelada) se abre sin tocarla.
  const tpl = templateByKey('venta_de_curso');
  const fromTemplate = createStore({ graph: tpl.graph });
  assert.ok(fromTemplate.addNode('note').ok);
  assert.equal(tpl.graph.nodes.length, 11);
});

// ---- Agregar ---------------------------------------------------------------------------------------------------------

test('agregar un paso: id nuevo, sobre la rejilla, seleccionado y sin caer encima de otro', () => {
  const store = open();
  const added = store.addNode('message', { x: 203, y: 507 });
  assert.deepEqual(added, { ok: true, id: 'n6', connected: false });
  assert.deepEqual(at(store, 'n6'), [200, 510], 'se ajusta a la rejilla de 10');
  assert.deepEqual(copyOf(store.node('n6').data), NODE_TYPES.message.defaults());
  assert.deepEqual(store.selection.nodes, ['n6']);
  assert.equal(store.isDirty(), true);
  assert.equal(store.undoLabel(), 'Agregar paso');

  // Encima de otro paso: baja hasta el primer sitio libre. Con `exact` se respeta el punto (al soltar desde la paleta).
  const onTop = store.addNode('delay', { x: 680, y: 40 });
  const rect = id => ({ x: store.node(id).x, y: store.node(id).y, w: GEOMETRY.width, h: 200 });
  assert.equal(store.node(onTop.id).x, 680);
  assert.ok(store.node(onTop.id).y > store.node('n4').y, 'quedó debajo de los que ya estaban ahí');
  assert.ok(rect(onTop.id).y >= store.node('n4').y + 100);
  const exact = store.addNode('delay', { x: 680, y: 40, exact: true });
  assert.deepEqual(at(store, exact.id), [680, 40]);

  // Sin posición: a la derecha de todo.
  const auto = store.addNode('end');
  assert.ok(store.node(auto.id).x > store.node('n5').x);
  // Con ajustes y título propios; el título se recorta a 60.
  const custom = store.addNode('message', { data: say('Hola'), title: 'a'.repeat(80), select: false });
  assert.equal(store.node(custom.id).data.parts[0].text, 'Hola');
  assert.equal(store.node(custom.id).title.length, 60);
  assert.deepEqual(store.selection.nodes, [auto.id], '`select: false` no cambia la selección');
  // Conectado desde una salida al nacer (lo que hace «agregar paso aquí» en el esquema).
  const linked = store.addNode('message', { connect: { from: 'n4', port: 'next' } });
  assert.equal(linked.connected, true);
  assert.equal(store.edgeFrom('n4', 'next'), linked.id);
  const notLinked = store.addNode('message', { connect: { from: 'n4', port: 'nada' } });
  assert.equal(notLinked.connected, false, 'una salida que no existe no impide agregar el paso');
  assertInvariants(store);

  refused(store.addNode('start'), 'start');
  refused(store.addNode('teletransporte'), 'type');
});

test('agregar desde la paleta: cae junto al seleccionado y se conecta a su primera salida libre', () => {
  const store = open();
  store.select('n4');
  const first = store.addNodeNear('delay');
  assert.equal(first.connected, true);
  assert.equal(store.edgeFrom('n4', 'next'), first.id);
  assert.deepEqual(at(store, first.id), [680 + GEOMETRY.width + GEOMETRY.gapX, 200]);
  assert.deepEqual(store.selection.nodes, [first.id], 'el nuevo queda seleccionado: el siguiente clic encadena');
  const second = store.addNodeNear('message');
  assert.equal(store.edgeFrom(first.id, 'next'), second.id);

  // Unos botones con su primera salida ocupada: se usa la siguiente libre, y el paso cae a la altura de esa salida.
  store.select('n2');
  const third = store.addNodeNear('message');
  assert.equal(store.edgeFrom('n2', 'default'), third.id);
  assert.equal(store.node(third.id).x, 360 + GEOMETRY.width + GEOMETRY.gapX);
  const fourth = store.addNodeNear('message', { anchor: 'n2' });
  assert.equal(store.edgeFrom('n2', 'timeout'), fourth.id);
  const fifth = store.addNodeNear('message', { anchor: 'n2' });
  assert.equal(fifth.connected, false, 'sin salidas libres no se conecta');
  // Una nota nunca se conecta; sin selección el paso sólo se agrega.
  store.select('n5');
  assert.equal(store.addNodeNear('note', { anchor: fifth.id }).connected, false);
  store.clearSelection();
  const loose = store.addNodeNear('message', { at: { x: 100, y: 900 } });
  assert.equal(loose.connected, false);
  assert.deepEqual(at(store, loose.id), [100, 900]);
  assertInvariants(store);
  const boxes = store.graph.nodes.map(n => ({ id: n.id, x: n.x, y: n.y }));
  assert.equal(new Set(boxes.map(b => b.x + ',' + b.y)).size, boxes.length, 'ningún paso quedó exactamente sobre otro');
});

test('límite de pasos: el 81 se rechaza y no cambia nada', () => {
  const store = createStore({ limits: { nodes: 6 } });
  for (let i = 0; i < 5; i += 1) assert.ok(store.addNode('message').ok);
  const before = store.graph;
  refused(store.addNode('message'), 'limit');
  refused(store.addNodeNear('message', { anchor: 'n2' }), 'limit');
  assert.equal(store.graph, before);
  store.select(['n2', 'n3']);
  refused(store.duplicateNodes(), 'limit');
  store.copy();
  refused(store.paste(), 'limit');
  assert.equal(store.graph, before);
  // Con el límite real: 79 pasos más el Inicio.
  const full = createStore();
  for (let i = 0; i < LIMITS.nodes - 1; i += 1) assert.ok(full.addNode('delay', { exact: true, x: i * 10, y: 0 }).ok);
  assert.equal(full.graph.nodes.length, 80);
  assert.match(full.addNode('delay').message, /hasta 80 pasos/);
});

// ---- Mover -----------------------------------------------------------------------------------------------------------

test('mover: sobre la rejilla, en coordenadas enteras, y un arrastre es un solo paso del historial', () => {
  const store = open();
  assert.deepEqual(store.moveNodes(['n3', 'n4'], 14, -6), { ok: true, changed: true });
  assert.deepEqual(at(store, 'n3'), [690, 30]);
  assert.deepEqual(at(store, 'n4'), [690, 190]);
  assert.deepEqual(
    store.moveNodes(['n3'], 2, 3),
    { ok: true, changed: false },
    'un movimiento menor que la rejilla no cuenta',
  );
  assert.deepEqual(store.moveNodes(['nadie'], 50, 50), { ok: true, changed: false });
  assert.equal(store.historySize(), 1);

  // Un arrastre son muchas posiciones seguidas con la misma clave: se deshace de una vez.
  const origin = at(store, 'n5');
  for (let step = 1; step <= 12; step += 1)
    store.setPositions({ n5: { x: origin[0] + step * 7, y: origin[1] + step * 3 } }, { coalesce: 'arrastre:1' });
  assert.equal(store.historySize(), 2);
  assert.deepEqual(at(store, 'n5'), [1080, 80]);
  store.seal();
  // Otro arrastre, aunque repita la clave, es otro paso.
  store.setPositions({ n5: { x: 1200, y: 80 } }, { coalesce: 'arrastre:1' });
  assert.equal(store.historySize(), 3);
  store.undo();
  assert.deepEqual(at(store, 'n5'), [1080, 80]);
  store.undo();
  assert.deepEqual(at(store, 'n5'), origin);

  // Sin rejilla las posiciones siguen siendo enteras.
  store.setSnap(false);
  store.setPositions({ n5: { x: 1003.6, y: 41.2 } });
  assert.deepEqual(at(store, 'n5'), [1004, 41]);
  store.setSnap(true);
  store.setPositions({ n5: { x: 1e9, y: -1e9 } });
  assert.deepEqual(at(store, 'n5'), [100000, -100000], 'las coordenadas tienen tope');
  assertInvariants(store);
});

// ---- Eliminar y duplicar ---------------------------------------------------------------------------------------------

test('eliminar: se van el paso y sus conexiones de entrada y de salida; el Inicio no se puede quitar', () => {
  const store = open();
  store.select(['n3', 'n5']);
  assert.deepEqual(store.deleteNodes(['n3']), { ok: true, removed: ['n3'] });
  assert.deepEqual(ids(store), ['n1', 'n2', 'n4', 'n5']);
  assert.deepEqual(copyOf(store.graph.edges), [E('n1', 'next', 'n2'), E('n2', 'opt:o2', 'n4')]);
  assert.deepEqual(store.selection.nodes, ['n5'], 'lo eliminado sale de la selección');
  refused(store.deleteNodes(['n1']), 'start');
  refused(store.deleteNodes(['nadie']), 'missing');
  assert.deepEqual(
    store.deleteNodes(['n1', 'n4', 'n4']),
    { ok: true, removed: ['n4'] },
    'el Inicio se salta; el resto se elimina',
  );
  assert.deepEqual(ids(store), ['n1', 'n2', 'n5']);
  assertInvariants(store);

  // «Suprimir» actúa sobre la conexión seleccionada antes que sobre los pasos.
  const other = open();
  other.selectEdge({ from: 'n2', port: 'opt:o1' });
  assert.ok(other.deleteSelection().ok);
  assert.equal(other.edgeFrom('n2', 'opt:o1'), null);
  assert.equal(other.graph.nodes.length, 5);
  assert.equal(other.selection.edge, null);
  refused(other.deleteSelection(), 'empty');
  other.select(['n3', 'n4']);
  assert.ok(other.deleteSelection().ok);
  assert.deepEqual(ids(other), ['n1', 'n2', 'n5']);
});

test('duplicar: copias con ids nuevos, desplazadas, con las conexiones que había entre ellas', () => {
  const store = open();
  const result = store.duplicateNodes(['n1', 'n2', 'n3']);
  assert.deepEqual(result, { ok: true, ids: ['n6', 'n7'], renamed: { n2: 'n6', n3: 'n7' } });
  assert.deepEqual(at(store, 'n6'), [360 + DUPLICATE_OFFSET, 40 + DUPLICATE_OFFSET]);
  assert.equal(store.node('n6').data, store.node('n2').data, 'los ajustes se comparten: son inmutables');
  // Sólo la conexión entre los dos copiados; no heredan la entrada desde el Inicio ni la salida hacia n4 o n5.
  assert.deepEqual(copyOf(store.graph.edges).slice(4), [E('n6', 'opt:o1', 'n7')]);
  assert.deepEqual(store.selection.nodes, ['n6', 'n7']);
  // Sin argumentos duplica la selección.
  assert.deepEqual(store.duplicateNodes().ids, ['n8', 'n9']);
  refused(store.duplicateNodes(['n1']), 'start');
  refused(store.duplicateNodes([]), 'empty');
  assertInvariants(store);
});

// ---- Conectar --------------------------------------------------------------------------------------------------------

test('conectar y desconectar: una sola conexión por salida, sólo hacia pasos que la admiten', () => {
  const store = open();
  assert.deepEqual(store.connect('n4', 'next', 'n5'), { ok: true, changed: true, replaced: false });
  assert.equal(store.edgeFrom('n4', 'next'), 'n5');
  assert.deepEqual(
    store.edgesInto('n5').map(e => e.from),
    ['n3', 'n4'],
    'a un paso pueden llegar muchas',
  );
  assert.deepEqual(store.connect('n4', 'next', 'n5'), { ok: true, changed: false });
  // Conectar una salida ocupada cambia su destino: no se acumulan dos conexiones.
  assert.deepEqual(store.connect('n2', 'opt:o1', 'n4'), { ok: true, changed: true, replaced: true });
  assert.equal(store.graph.edges.filter(e => e.from === 'n2' && e.port === 'opt:o1').length, 1);
  assert.equal(store.edgeFrom('n2', 'opt:o1'), 'n4');
  // Un paso que espera puede volver a sí mismo (unos botones que se repiten).
  assert.ok(store.connect('n2', 'default', 'n2').ok);

  refused(store.connect('n2', 'opt:o9', 'n3'), 'port');
  refused(store.connect('n3', 'timeout', 'n5'), 'port');
  refused(store.connect('n2', 'opt:o1', 'n1'), 'target');
  refused(store.connect('nadie', 'next', 'n3'), 'missing');
  refused(store.connect('n3', 'next', 'nadie'), 'missing');
  const note = store.addNode('note').id;
  refused(store.connect('n3', 'next', note), 'target');
  refused(store.connect(note, 'next', 'n3'), 'source');
  assertInvariants(store);

  assert.deepEqual(store.disconnect('n4', 'next'), { ok: true, changed: true });
  assert.equal(store.edgeFrom('n4', 'next'), null);
  assert.deepEqual(store.disconnect('n4', 'next'), { ok: true, changed: false });
  assert.deepEqual(store.disconnect('nadie', 'next'), { ok: true, changed: false });

  const tight = createStore({ graph: sample(), limits: { edges: 4 } });
  refused(tight.connect('n4', 'next', 'n5'), 'limit');
  assert.ok(tight.connect('n3', 'next', 'n4').ok, 'cambiar el destino de una conexión no cuenta contra el límite');
  refused(
    tight.addNode('message', { connect: { from: 'n4', port: 'next' } }).connected
      ? { ok: true }
      : { ok: false, reason: 'limit', message: 'sin conexión por el límite' },
    'limit',
  );
});

// ---- Ajustes de un paso ----------------------------------------------------------------------------------------------

test('editar los ajustes: quedan canónicos y las conexiones de las salidas que desaparecen se quitan en el mismo paso', () => {
  const store = open();
  assert.deepEqual(store.setData('n3', 'parts.0.text', 'Hola, {{nombre}}'), { ok: true, changed: true, pruned: 0 });
  assert.equal(store.node('n3').data.parts[0].text, 'Hola, {{nombre}}');
  assert.deepEqual(store.setData('n3', 'parts.0.text', 'Hola, {{nombre}}'), { ok: true, changed: false });
  // Cambiar el tipo de una parte deja sólo los campos de ese tipo.
  store.setData('n3', 'parts.0.kind', 'slot');
  assert.deepEqual(copyOf(store.node('n3').data.parts[0]), { kind: 'slot', slot: '', ifMissing: 'skip' });
  // Un valor imposible vuelve al de fábrica en lugar de guardarse.
  store.setData('n3', 'parts.0.ifMissing', 'explotar');
  assert.equal(store.node('n3').data.parts[0].ifMissing, 'skip');

  // Quitar el botón «Sí»: su salida deja de existir y su conexión se va con ella, en un solo paso del historial.
  const steps = store.historySize();
  const options = store.node('n2').data.options;
  const removed = store.setData('n2', 'options', [options[1]]);
  assert.deepEqual(removed, { ok: true, changed: true, pruned: 1 });
  assert.deepEqual(
    portsOf(store.node('n2')).map(p => p.id),
    ['opt:o2', 'default', 'timeout'],
  );
  assert.equal(store.edgeFrom('n2', 'opt:o1'), null);
  assert.equal(store.edgeFrom('n2', 'opt:o2'), 'n4', 'las demás conexiones siguen');
  assert.equal(store.historySize(), steps + 1);
  assertInvariants(store);
  store.undo();
  assert.equal(store.edgeFrom('n2', 'opt:o1'), 'n3', 'deshacer devuelve el botón y su conexión');
  assert.equal(store.node('n2').data.options.length, 2);

  // Un botón que pasa a «responde el asistente» ya no tiene salida propia.
  assert.equal(store.setData('n2', 'options.1.do', { type: 'intent', intent: 'price', stay: true }).pruned, 1);
  assert.equal(store.edgeFrom('n2', 'opt:o2'), null);
  // Agregar una opción sin id: recibe uno libre, y con él su salida.
  store.setData('n2', 'options', [...store.node('n2').data.options, { id: '', label: 'Quizá', do: goto }]);
  assert.deepEqual(
    store.node('n2').data.options.map(o => o.id),
    ['o1', 'o2', 'o3'],
  );
  assert.ok(store.connect('n2', 'opt:o3', 'n4').ok);

  // Varios campos a la vez (elegir una plantilla trae también sus botones).
  const tpl = store.addNode('template').id;
  store.mergeData(tpl, { waTemplateId: 'wt1', buttons: ['Sí, deseo inscribirme'], wait: true });
  assert.deepEqual(
    portsOf(store.node(tpl)).map(p => p.id),
    ['opt:1', 'default', 'timeout'],
  );
  store.connect(tpl, 'opt:1', 'n5');
  assert.equal(store.setData(tpl, 'wait', false).pruned, 1, 'sin esperar, la única salida es «Sigue»');
  assert.deepEqual(
    portsOf(store.node(tpl)).map(p => p.id),
    ['next'],
  );

  refused(store.setData('nadie', 'text', 'x'), 'missing');
  const unknown = createStore({
    graph: { v: 1, start: 's', nodes: [N('s', 'start'), N('u', 'teletransporte')], edges: [] },
  });
  refused(unknown.setData('u', 'x', 1), 'type');
  assertInvariants(store);
});

test('editar el título: hasta 60 caracteres; vacío, la clave desaparece', () => {
  const store = open();
  assert.ok(store.setTitle('n3', 'Buenas noticias').changed);
  assert.deepEqual(Object.keys(store.node('n3')), ['id', 'type', 'title', 'x', 'y', 'data']);
  assert.equal(store.setTitle('n3', 'Buenas noticias').changed, false);
  store.setTitle('n3', 'a'.repeat(99));
  assert.equal(store.node('n3').title.length, 60);
  store.setTitle('n3', '');
  assert.deepEqual(Object.keys(store.node('n3')), ['id', 'type', 'x', 'y', 'data']);
  refused(store.setTitle('nadie', 'x'), 'missing');
  assertInvariants(store);
});

test('teclear en un campo es un solo paso del historial hasta salir de él', () => {
  const store = open();
  const key = 'campo:n3:parts.0.text';
  for (const typed of ['H', 'Ho', 'Hol', 'Hola']) store.setData('n3', 'parts.0.text', typed, { coalesce: key });
  assert.equal(store.historySize(), 1);
  store.seal();
  for (const typed of ['Hola,', 'Hola, Ana']) store.setData('n3', 'parts.0.text', typed, { coalesce: key });
  assert.equal(store.historySize(), 2);
  store.undo();
  assert.equal(store.node('n3').data.parts[0].text, 'Hola');
  // Después de deshacer, seguir tecleando en el mismo campo es una edición nueva: no reescribe la anterior.
  store.setData('n3', 'parts.0.text', 'Hola!', { coalesce: key });
  assert.equal(store.historySize(), 2);
  store.undo();
  assert.equal(store.node('n3').data.parts[0].text, 'Hola');
  store.undo();
  assert.equal(store.node('n3').data.parts[0].text, 'Qué bien');
  // Otra clave no se funde.
  store.setData('n3', 'parts.0.text', 'A', { coalesce: key });
  store.setTitle('n3', 'T', { coalesce: 'campo:n3:title' });
  assert.equal(store.historySize(), 2);
});

test('variables del recorrido: nombres válidos y únicos, hasta 20', () => {
  const store = open();
  assert.ok(store.setVariables([{ name: 'correo', label: 'Correo', type: 'email' }, { name: 'ciudad' }]).changed);
  assert.deepEqual(copyOf(store.graph.variables), [
    { name: 'correo', label: 'Correo', type: 'email' },
    { name: 'ciudad', label: '', type: 'text' },
  ]);
  assert.equal(store.setVariables(copyOf(store.graph.variables)).changed, false);
  refused(store.setVariables([{ name: 'Mal Nombre' }]), 'variable');
  refused(store.setVariables([{ name: 'a' }, { name: 'a' }]), 'variable');
  refused(store.setVariables([{}]), 'variable');
  refused(store.setVariables(Array.from({ length: 21 }, (_, i) => ({ name: 'v' + i }))), 'limit');
  assert.equal(store.graph.variables.length, 2);
  assert.ok(store.setVariables([]).changed);
  assertInvariants(store);
});

test('acomodar: un solo paso del historial que se puede deshacer', () => {
  const store = open();
  store.moveNodes(['n3', 'n4', 'n5'], 300, 700);
  const messy = copyOf(store.graph);
  assert.deepEqual(store.autoLayout(), { ok: true, changed: true });
  assert.deepEqual(Object.fromEntries(store.graph.nodes.map(n => [n.id, { x: n.x, y: n.y }])), layout(messy).positions);
  assert.equal(store.undoLabel(), 'Acomodar');
  assert.deepEqual(store.autoLayout(), { ok: true, changed: false }, 'ya acomodado no cambia nada');
  store.undo();
  assert.deepEqual(copyOf(store.graph), messy);
  assertInvariants(store);
});

// ---- Selección -------------------------------------------------------------------------------------------------------

test('selección: una, varias, alternar, todas, una conexión, y el marco de selección', () => {
  const store = open();
  assert.equal(store.select('n3'), true);
  assert.equal(store.select('n3'), false, 'seleccionar lo mismo no avisa de ningún cambio');
  assert.deepEqual(store.selection.nodes, ['n3']);
  store.select(['n4', 'n5'], 'add');
  assert.deepEqual(store.selection.nodes, ['n3', 'n4', 'n5']);
  store.select('n3', 'add');
  assert.deepEqual(store.selection.nodes, ['n4', 'n5', 'n3'], 'el último seleccionado es el principal');
  store.select('n4', 'toggle');
  assert.deepEqual(store.selection.nodes, ['n5', 'n3']);
  store.select('n4', 'toggle');
  assert.deepEqual(store.selection.nodes, ['n5', 'n3', 'n4']);
  store.select(['nadie', 'n2', 'n2']);
  assert.deepEqual(store.selection.nodes, ['n2'], 'lo que no existe se ignora');
  store.selectAll();
  assert.deepEqual(store.selection.nodes, ['n1', 'n2', 'n3', 'n5', 'n4'], 'en orden de lectura');
  store.selectEdge({ from: 'n2', port: 'opt:o1' });
  assert.deepEqual(copyOf(store.selection), { nodes: [], edge: { from: 'n2', port: 'opt:o1' } });
  store.selectEdge({ from: 'n2', port: 'default' });
  assert.equal(store.selection.edge, null, 'una conexión que no existe no se puede seleccionar');
  store.select('n3');
  store.clearSelection();
  assert.deepEqual(copyOf(store.selection), { nodes: [], edge: null });
  assert.equal(store.historySize(), 0, 'seleccionar no es una edición');
  assert.equal(store.isDirty(), false);

  assert.deepEqual(store.nodesInRect({ x: 600, y: 0, w: 200, h: 400 }), ['n3', 'n4']);
  assert.deepEqual(
    store.nodesInRect({ x: 800, y: 400, w: -200, h: -400 }),
    ['n3', 'n4'],
    'el marco se puede arrastrar en cualquier dirección',
  );
  assert.deepEqual(store.nodesInRect({ x: 5000, y: 5000, w: 10, h: 10 }), []);
});

test('teclado: a qué paso lleva cada flecha', () => {
  const store = open();
  assert.equal(store.neighbour('n1', 'right'), 'n2');
  assert.equal(store.neighbour('n2', 'right'), 'n3', 'la primera salida conectada');
  assert.equal(store.neighbour('n5', 'right'), null);
  assert.equal(store.neighbour('n3', 'left'), 'n2');
  assert.equal(store.neighbour('n1', 'left'), null);
  assert.equal(store.neighbour('n2', 'down'), 'n3');
  assert.equal(store.neighbour('n3', 'down'), 'n5', 'el orden de lectura sigue las salidas');
  assert.equal(store.neighbour('n4', 'down'), null);
  assert.equal(store.neighbour('n4', 'up'), 'n5');
  assert.equal(store.neighbour('n1', 'up'), null);
  assert.equal(store.neighbour('nadie', 'right'), null);
  store.connect('n4', 'next', 'n5');
  assert.equal(store.neighbour('n5', 'left'), 'n3', 'de varios orígenes, el primero en orden de lectura');
});

// ---- Portapapeles ----------------------------------------------------------------------------------------------------

test('copiar y pegar: ids nuevos y cada pegado un poco más abajo y a la derecha que el anterior', () => {
  const store = open();
  refused(store.paste(), 'clipboard');
  refused(store.copy([]), 'empty');
  refused(store.copy(['n1']), 'start');
  store.select(['n1', 'n2', 'n3']);
  assert.deepEqual(store.copy(), { ok: true, count: 2 }, 'el Inicio no se copia');
  assert.equal(store.historySize(), 0, 'copiar no es una edición');

  const first = store.paste();
  assert.deepEqual(first, { ok: true, ids: ['n6', 'n7'], renamed: { n2: 'n6', n3: 'n7' } });
  assert.deepEqual(at(store, 'n6'), [360 + PASTE_OFFSET, 40 + PASTE_OFFSET]);
  assert.deepEqual(at(store, 'n7'), [680 + PASTE_OFFSET, 40 + PASTE_OFFSET]);
  assert.deepEqual(store.selection.nodes, ['n6', 'n7'], 'lo pegado queda seleccionado');
  assert.deepEqual(
    copyOf(store.graph.edges).slice(4),
    [E('n6', 'opt:o1', 'n7')],
    'sólo las conexiones entre lo copiado',
  );
  const second = store.paste();
  assert.deepEqual(second.ids, ['n8', 'n9']);
  assert.deepEqual(
    at(store, 'n8'),
    [360 + PASTE_OFFSET * 2, 40 + PASTE_OFFSET * 2],
    'el segundo pegado no tapa al primero',
  );
  const third = store.paste();
  assert.deepEqual(at(store, third.ids[0]), [360 + PASTE_OFFSET * 3, 40 + PASTE_OFFSET * 3]);
  // En un punto (el cursor): la esquina de lo copiado cae ahí.
  const placed = store.paste({ at: { x: 1203, y: 804 } });
  assert.deepEqual(at(store, placed.ids[0]), [1200, 800]);
  assert.deepEqual(at(store, placed.ids[1]), [1200 + 320, 800]);
  // El portapapeles es una foto: editar o borrar el original no cambia lo que se pega.
  store.setData('n2', 'text', 'Otro texto');
  store.deleteNodes(['n3']);
  const later = store.paste();
  assert.equal(store.node(later.ids[0]).data.text, '¿Qué prefieres?');
  assert.equal(later.ids.length, 2);
  // Volver a copiar reinicia el desplazamiento.
  store.copy(['n4']);
  const fresh = store.paste();
  assert.deepEqual(at(store, fresh.ids[0]), [680 + PASTE_OFFSET, 200 + PASTE_OFFSET]);
  assertInvariants(store);
  assert.equal(new Set(ids(store)).size, ids(store).length);
});

test('cortar: copia y elimina en un solo paso del historial', () => {
  const store = open();
  store.select(['n3', 'n4']);
  assert.deepEqual(store.cut(), { ok: true, removed: ['n3', 'n4'] });
  assert.deepEqual(ids(store), ['n1', 'n2', 'n5']);
  assert.equal(store.historySize(), 1);
  const pasted = store.paste();
  assert.deepEqual(pasted.ids, ['n3', 'n4'], 'los ids que quedaron libres se vuelven a usar');
  store.undo();
  store.undo();
  assert.deepEqual(copyOf(store.graph), normalizeGraph(sample()));
  refused(store.cut(['n1']), 'start');
});

// ---- Historial -------------------------------------------------------------------------------------------------------

// Referencia ingenua: una lista de fotos del grafo y un índice. Sin compartir estructura, sin selección, sin nada más.
class Reference {
  constructor(graph, limit = HISTORY_LIMIT) {
    this.states = [json(graph)];
    this.at = 0;
    this.limit = limit;
  }
  record(graph) {
    this.states.length = this.at + 1;
    this.states.push(json(graph));
    this.at += 1;
    if (this.states.length - 1 > this.limit) {
      this.states.shift();
      this.at -= 1;
    }
  }
  undo() {
    if (this.at === 0) return false;
    this.at -= 1;
    return true;
  }
  redo() {
    if (this.at >= this.states.length - 1) return false;
    this.at += 1;
    return true;
  }
  get current() {
    return this.states[this.at];
  }
}

test('deshacer y rehacer: una secuencia de ediciones, comparada paso a paso con una referencia ingenua', () => {
  const store = open();
  const ref = new Reference(store.graph);
  const edits = [
    () => store.addNode('message', { x: 100, y: 500 }),
    () => store.connect('n4', 'next', 'n6'),
    () => store.setData('n6', 'parts.0.text', 'Gracias'),
    () => store.moveNodes(['n6'], 50, 50),
    () => store.duplicateNodes(['n2', 'n3']),
    () => store.setTitle('n2', 'Pregunta inicial'),
    () => store.setData('n2', 'options', [store.node('n2').data.options[0]]),
    () => store.deleteNodes(['n5']),
    () => store.disconnect('n1', 'next'),
    () => store.setVariables([{ name: 'correo' }]),
    () => store.autoLayout(),
    () => (store.copy(['n3', 'n4']), store.paste()),
    () => store.cut(['n6']),
  ];
  for (const edit of edits) {
    const before = store.graph;
    assert.ok(edit().ok);
    assert.notEqual(store.graph, before, 'cada edición de la lista cambia el grafo');
    ref.record(store.graph);
    assertInvariants(store);
  }
  assert.equal(store.historySize(), edits.length);
  // Todo hacia atrás…
  for (let i = 0; i < edits.length; i += 1) {
    assert.equal(store.canUndo(), true);
    assert.equal(ref.undo(), true);
    assert.ok(store.undo().ok);
    assert.equal(json(store.graph), ref.current, `deshacer ${i + 1}`);
    assertInvariants(store);
  }
  assert.equal(json(store.graph), json(normalizeGraph(sample())));
  assert.equal(store.canUndo(), false);
  refused(store.undo(), 'undo');
  assert.equal(ref.undo(), false);
  // …y todo hacia adelante.
  for (let i = 0; i < edits.length; i += 1) {
    assert.equal(ref.redo(), true);
    assert.ok(store.redo().ok);
    assert.equal(json(store.graph), ref.current, `rehacer ${i + 1}`);
  }
  refused(store.redo(), 'redo');
  // A medio camino, una edición nueva borra lo que se podía rehacer.
  for (let i = 0; i < 5; i += 1) {
    store.undo();
    ref.undo();
  }
  assert.equal(store.canRedo(), true);
  store.addNode('note');
  ref.record(store.graph);
  assert.equal(store.canRedo(), false);
  assert.equal(ref.redo(), false);
  while (ref.undo()) {
    assert.ok(store.undo().ok);
    assert.equal(json(store.graph), ref.current);
  }
  assert.equal(store.canUndo(), false);
});

test('deshacer y rehacer devuelven también la selección de ese momento', () => {
  const store = open();
  store.select('n4');
  const added = store.addNode('message').id;
  assert.deepEqual(store.selection.nodes, [added]);
  store.undo();
  assert.deepEqual(store.selection.nodes, ['n4'], 'vuelve lo que estaba seleccionado antes de agregar');
  store.redo();
  assert.deepEqual(store.selection.nodes, [added]);
  store.deleteNodes([added]);
  assert.deepEqual(store.selection.nodes, []);
  store.undo();
  assert.deepEqual(store.selection.nodes, [added]);
  assert.deepEqual(store.undo().label, 'Agregar paso');
  assert.equal(store.redoLabel(), 'Agregar paso');
});

test('historial acotado: 100 pasos; lo más viejo se olvida y lo demás se sigue pudiendo deshacer', () => {
  assert.equal(HISTORY_LIMIT, 100);
  const small = createStore({ graph: sample(), historyLimit: 5 });
  const ref = new Reference(small.graph, 5);
  for (let i = 1; i <= 8; i += 1) {
    small.moveNodes(['n3'], 10, 0);
    ref.record(small.graph);
  }
  assert.equal(small.historySize(), 5);
  let undone = 0;
  while (small.undo().ok) {
    undone += 1;
    assert.equal(ref.undo(), true);
    assert.equal(json(small.graph), ref.current);
  }
  assert.equal(undone, 5);
  assert.equal(ref.undo(), false);
  assert.equal(small.node('n3').x, 680 + 30, 'los tres primeros movimientos ya no se pueden deshacer');
  assert.equal(small.isDirty(), true, 'y por eso no se puede volver al estado guardado');

  const store = open();
  for (let i = 0; i < 130; i += 1) store.moveNodes(['n4'], 0, 10);
  assert.equal(store.historySize(), 100);
  let count = 0;
  while (store.undo().ok) count += 1;
  assert.equal(count, 100);
  assert.equal(store.node('n4').y, 200 + 300);
  for (let i = 0; i < 100; i += 1) assert.ok(store.redo().ok);
  assert.equal(store.node('n4').y, 200 + 1300);
});

test('cambios sin guardar: se sabe comparando con el grafo guardado, también al deshacer y rehacer', () => {
  const store = open();
  assert.equal(store.isDirty(), false);
  store.select('n3');
  store.setViewport({ x: 50, zoom: 0.8 });
  store.copy();
  assert.equal(store.isDirty(), false, 'seleccionar, mover la vista o copiar no ensucian');
  store.moveNodes(['n3'], 10, 0);
  assert.equal(store.isDirty(), true);
  store.undo();
  assert.equal(store.isDirty(), false, 'deshacer hasta lo guardado deja todo limpio');
  store.redo();
  assert.equal(store.isDirty(), true);
  store.markSaved();
  assert.equal(store.isDirty(), false);
  store.undo();
  assert.equal(store.isDirty(), true, 'lo guardado es ahora el estado posterior');
  store.redo();
  assert.equal(store.isDirty(), false);
  // Un guardado que termina tarde marca el grafo que se envió, no el actual.
  const sent = store.graph;
  store.moveNodes(['n3'], 10, 0);
  store.markSaved(sent);
  assert.equal(store.isDirty(), true);
  store.undo();
  assert.equal(store.isDirty(), false);
});

// ---- Vista -----------------------------------------------------------------------------------------------------------

test('vista: desplazar, acercar entre 50 % y 150 % dejando quieto el punto bajo el cursor, ajustar y mostrar un paso', () => {
  const store = open();
  assert.deepEqual([ZOOM.min, ZOOM.max], [0.5, 1.5]);
  assert.equal(store.panBy(30.4, -12.6), true);
  assert.deepEqual(copyOf(store.viewport), { x: 30, y: -13, zoom: 1 });
  assert.equal(store.panBy(0, 0), false);
  store.setViewport({ zoom: 9 });
  assert.equal(store.viewport.zoom, 1.5);
  store.setViewport({ zoom: 0.01 });
  assert.equal(store.viewport.zoom, 0.5);
  store.setViewport({ x: 0, y: 0, zoom: 1 });

  // El punto del lienzo que está bajo el cursor sigue bajo el cursor después de acercar.
  const cursor = { x: 400, y: 300 };
  const under = store.toWorld(cursor);
  store.zoomTo(1.3, cursor);
  assert.equal(store.viewport.zoom, 1.3);
  const after = store.toScreen(under);
  assert.ok(Math.abs(after.x - cursor.x) <= 1 && Math.abs(after.y - cursor.y) <= 1);
  store.zoomBy(-3, cursor);
  assert.equal(store.viewport.zoom, 1);
  for (let i = 0; i < 20; i += 1) store.zoomBy(1, cursor);
  assert.equal(store.viewport.zoom, 1.5);
  for (let i = 0; i < 20; i += 1) store.zoomBy(-1, cursor);
  assert.equal(store.viewport.zoom, 0.5);
  const point = { x: 123, y: 456 };
  const back = store.toScreen(store.toWorld(point));
  assert.ok(Math.abs(back.x - point.x) < 1e-9 && Math.abs(back.y - point.y) < 1e-9);

  // Ajustar: todo el recorrido cabe, centrado, sin pasar del 100 %.
  store.fit({ width: 800, height: 400 });
  assert.ok(store.viewport.zoom < 1 && store.viewport.zoom >= 0.5);
  for (const n of store.graph.nodes) {
    const corner = store.toScreen({ x: n.x, y: n.y });
    assert.ok(corner.x >= 0 && corner.y >= 0 && corner.x <= 800 && corner.y <= 400, `${n.id} a la vista`);
  }
  store.fit({ width: 4000, height: 3000 });
  assert.equal(store.viewport.zoom, 1, 'con sitio de sobra no agranda');
  createStore().fit({ width: 0, height: 0 });
  // Si ni al 50 % cabe, no se centra: se muestra desde el principio, con el Inicio a la vista.
  store.fit({ width: 300, height: 200 });
  assert.equal(store.viewport.zoom, 0.5);
  const first = store.toScreen({ x: store.node('n1').x, y: store.node('n1').y });
  assert.deepEqual([first.x, first.y], [40, 40]);

  // Mostrar un paso: la vista se mueve lo justo; si ya se ve, no se mueve.
  store.setViewport({ x: 0, y: 0, zoom: 1 });
  assert.equal(store.reveal('n5', { width: 800, height: 400 }), true);
  const shown = store.toScreen({ x: store.node('n5').x + GEOMETRY.width, y: store.node('n5').y });
  assert.ok(shown.x <= 800 - 24 && shown.y >= 24);
  assert.equal(store.reveal('n5', { width: 800, height: 400 }), false);
  assert.equal(store.reveal('nadie', { width: 800, height: 400 }), false);
  assert.equal(store.historySize(), 0, 'la vista no es parte del historial');
  assert.equal(store.isDirty(), false);
});

// ---- Sólo lectura, avisos y sesión -----------------------------------------------------------------------------------

test('sólo lectura: ninguna edición pasa, pero se puede seleccionar, copiar y mover la vista', () => {
  const store = open({ readOnly: true });
  const before = store.graph;
  store.select(['n3', 'n4']);
  for (const result of [
    store.addNode('message'),
    store.addNodeNear('message'),
    store.moveNodes(['n3'], 50, 50),
    store.setPositions({ n3: { x: 0, y: 0 } }),
    store.deleteNodes(['n3']),
    store.deleteSelection(),
    store.duplicateNodes(['n3']),
    store.connect('n4', 'next', 'n5'),
    store.disconnect('n1', 'next'),
    store.setTitle('n3', 'x'),
    store.setData('n3', 'parts.0.text', 'x'),
    store.mergeData('n3', { parts: [] }),
    store.setVariables([{ name: 'a' }]),
    store.autoLayout(),
    store.cut(),
    store.undo(),
    store.redo(),
  ]) {
    refused(result, 'read_only');
  }
  assert.ok(store.copy().ok);
  refused(store.paste(), 'read_only');
  assert.equal(store.graph, before);
  assert.equal(store.panBy(10, 10), true);
  assert.deepEqual(store.selection.nodes, ['n3', 'n4']);
  // Se puede cambiar en marcha (la capa de rendimiento pone el lienzo en sólo lectura).
  store.setReadOnly(false);
  assert.ok(store.moveNodes(['n3'], 50, 50).ok);
  store.setReadOnly(true);
  assert.equal(store.readOnly, true);
  refused(store.undo(), 'read_only');
});

test('avisos: quien escucha sabe qué cambió, y deja de recibirlos al darse de baja', () => {
  const store = open();
  const seen = [];
  const off = store.subscribe(change =>
    seen.push(
      Object.keys(change)
        .filter(k => change[k])
        .sort()
        .join('+'),
    ),
  );
  store.select('n3');
  store.moveNodes(['n3'], 10, 0);
  store.panBy(5, 5);
  store.copy();
  store.undo();
  store.setOverlay({ simNode: 'n3' });
  store.setContext({ tags: [] });
  store.setReadOnly(true);
  store.markSaved();
  assert.deepEqual(seen, [
    'selection',
    'graph+history',
    'viewport',
    'clipboard',
    'graph+history+selection',
    'overlay',
    'context',
    'mode',
    'history',
  ]);
  off();
  store.setReadOnly(false);
  store.addNode('note');
  assert.equal(seen.length, 9);
  // Agregar selecciona el paso nuevo: el aviso lo dice.
  const flags = [];
  store.subscribe(change => flags.push(change));
  store.addNode('note');
  assert.deepEqual(flags, [{ graph: true, history: true, selection: true }]);
});

test('problemas del recorrido: se recalculan con cada grafo y con el contexto de la marca', () => {
  const store = open();
  assert.deepEqual(store.issues().errors, []);
  assert.deepEqual(
    store.issues().warnings.map(w => [w.code, w.nodeId]),
    [['port', 'n4']],
  );
  assert.equal(store.issuesFor('n4').warnings.length, 1);
  assert.deepEqual(store.issuesFor('n3'), { errors: [], warnings: [] });
  store.setData('n3', 'parts.0.text', '');
  assert.deepEqual(
    store.issuesFor('n3').errors.map(i => i.field),
    ['parts.0.text'],
  );
  assert.equal(store.issues(), store.issues(), 'no se recalcula si el grafo no cambió');
  const tagger = store.addNode('tags', { data: { add: ['vip'] } }).id;
  assert.deepEqual(store.issuesFor(tagger).errors, []);
  store.setContext({ tags: [{ id: 'otra', name: 'Otra' }] });
  assert.deepEqual(
    store.issuesFor(tagger).errors.map(i => i.code),
    ['ref'],
    'con la lista de la marca aparece la referencia rota',
  );
  assert.deepEqual(copyOf(store.context), { tags: [{ id: 'otra', name: 'Otra' }] });
});

test('cargar otro grafo reinicia el historial y la selección; la capa de cifras es estado aparte', () => {
  const store = open();
  store.addNode('note');
  store.select('n2');
  const repairs = store.setGraph({
    v: 1,
    start: 'a',
    nodes: [N('a', 'start'), N('b', 'message', say('Hola'))],
    edges: [E('a', 'next', 'b'), E('b', 'next', 'nadie')],
  });
  assert.equal(repairs.length, 1);
  assert.deepEqual(ids(store), ['a', 'b']);
  assert.equal(store.canUndo(), false);
  assert.equal(store.isDirty(), false);
  assert.deepEqual(store.selection.nodes, []);
  assertInvariants(store);
  store.setOverlay({ stats: { nodes: { b: { entered: 10, completed: 7, dropped: 2 } } }, showStats: true });
  assert.equal(store.overlay.stats.nodes.b.entered, 10);
  assert.equal(store.overlay.simNode, null);
  store.setOverlay({ simNode: 'b' });
  assert.equal(store.overlay.showStats, true, 'cambiar una parte de la capa no borra la otra');
  assert.equal(store.isDirty(), false);
});

// ---- Operaciones al azar ---------------------------------------------------------------------------------------------

// Un cambio de ajustes verosímil para cada tipo, incluidos los que hacen aparecer y desaparecer salidas.
function tweak(store, node, rnd) {
  const pickOne = items => items[Math.floor(rnd() * items.length)];
  const d = node.data;
  switch (node.type) {
    case 'message':
      return store.setData(
        node.id,
        'parts',
        rnd() < 0.5 ? [...d.parts, { kind: pickOne(['text', 'slot', 'material']), text: 'x' }] : d.parts.slice(1),
      );
    case 'buttons': {
      const r = rnd();
      if (r < 0.35)
        return store.setData(node.id, 'options', [
          ...d.options,
          { id: '', label: 'Opción ' + Math.floor(rnd() * 99), do: goto },
        ]);
      if (r < 0.6) return store.setData(node.id, 'options', d.options.slice(0, -1));
      if (r < 0.85 && d.options.length) {
        const i = Math.floor(rnd() * d.options.length);
        return store.setData(
          node.id,
          `options.${i}.do`,
          d.options[i].do.type === 'goto' ? { type: 'intent', intent: 'price', stay: true } : goto,
        );
      }
      return store.setData(node.id, 'text', 'Texto ' + Math.floor(rnd() * 99));
    }
    case 'condition':
      return store.setData(
        node.id,
        'cases',
        rnd() < 0.5 ? [...d.cases, { id: '', label: 'Caso', when: {} }] : d.cases.slice(1),
      );
    case 'assistant':
      return store.setData(node.id, 'mode', pickOne(['answer', 'handover', 'collect']));
    case 'status':
      return store.setData(node.id, 'status', pickOne(['waiting', 'resolved']));
    case 'template':
      return store.mergeData(node.id, {
        wait: rnd() < 0.6,
        buttons: rnd() < 0.6 ? ['Sí', 'No', 'Luego'].slice(0, 1 + Math.floor(rnd() * 3)) : [],
      });
    case 'delay':
      return store.setData(node.id, 'seconds', Math.floor(rnd() * 900) - 50);
    case 'start':
      return store.setTitle(node.id, rnd() < 0.5 ? 'Entrada' : '');
    default:
      return store.setTitle(node.id, 'Título ' + Math.floor(rnd() * 99));
  }
}

function randomRun(seed, steps, limits) {
  const rnd = random(seed);
  const store = createStore({ graph: sample(), limits, historyLimit: 30 });
  const ref = new Reference(store.graph, 30);
  const types = Object.keys(NODE_TYPES);
  const pickOne = items => items[Math.floor(rnd() * items.length)];
  const some = () => store.graph.nodes.filter(() => rnd() < 0.3).map(n => n.id);
  const anyNode = () => pickOne(store.graph.nodes);
  const counts = { done: 0, refused: 0, undone: 0, redone: 0 };
  let afterUndo = false;

  for (let step = 0; step < steps; step += 1) {
    const before = store.graph;
    const roll = rnd();
    let result;
    let history = null;
    // Rehacer sólo es posible justo después de deshacer: sin este empujón casi nunca se ejercitaría.
    if (afterUndo && rnd() < 0.45) {
      history = 'redo';
      result = store.redo();
    } else if (roll < 0.14)
      result = store.addNode(pickOne(types), {
        x: rnd() * 1500,
        y: rnd() * 900,
        connect: rnd() < 0.4 ? { from: anyNode().id, port: pickOne(portsOf(anyNode()))?.id ?? 'next' } : null,
      });
    else if (roll < 0.2) result = store.addNodeNear(pickOne(types), { anchor: rnd() < 0.7 ? anyNode().id : undefined });
    else if (roll < 0.3) result = store.moveNodes(some(), Math.floor(rnd() * 200) - 100, Math.floor(rnd() * 200) - 100);
    else if (roll < 0.37) result = store.deleteNodes(some());
    else if (roll < 0.42) result = store.duplicateNodes(some());
    else if (roll < 0.57) {
      const from = anyNode();
      result = store.connect(
        from.id,
        rnd() < 0.9 ? (pickOne(portsOf(from))?.id ?? 'next') : 'inventada',
        rnd() < 0.95 ? anyNode().id : 'nadie',
      );
    } else if (roll < 0.62) {
      const edge = pickOne(store.graph.edges);
      result = edge ? store.disconnect(edge.from, edge.port) : store.disconnect('n1', 'next');
    } else if (roll < 0.74) result = tweak(store, anyNode(), rnd);
    else if (roll < 0.77) result = { ok: store.select(some(), pickOne(['replace', 'add', 'toggle'])) || true };
    else if (roll < 0.79) result = rnd() < 0.5 ? store.copy(some()) : store.cut(some());
    else if (roll < 0.83) result = store.paste(rnd() < 0.5 ? { at: { x: rnd() * 1000, y: rnd() * 1000 } } : {});
    else if (roll < 0.85) result = store.autoLayout();
    else if (roll < 0.87)
      result = store.setVariables(Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => ({ name: 'v' + i })));
    else if (roll < 0.88) result = store.deleteSelection();
    else if (roll < 0.95) {
      history = 'undo';
      result = store.undo();
    } else {
      history = 'redo';
      result = store.redo();
    }
    afterUndo = history === 'undo';

    if (history) {
      const expected = history === 'undo' ? ref.undo() : ref.redo();
      assert.equal(result.ok, expected, `semilla ${seed}, paso ${step}: ${history}`);
      if (expected) counts[history === 'undo' ? 'undone' : 'redone'] += 1;
    } else if (store.graph !== before) {
      ref.record(store.graph);
      counts.done += 1;
    } else if (result.ok === false) {
      counts.refused += 1;
      assert.ok(result.reason && result.message, 'un rechazo siempre dice por qué');
    }
    assert.equal(json(store.graph), ref.current, `semilla ${seed}, paso ${step}: el grafo coincide con la referencia`);
    assert.equal(store.canUndo(), ref.at > 0);
    assert.equal(store.canRedo(), ref.at < ref.states.length - 1);
    assertInvariants(store, { ...LIMITS, ...limits });
  }
  return counts;
}

test('operaciones al azar: después de cada una la estructura sigue siendo válida y el historial coincide con la referencia', () => {
  const totals = { done: 0, refused: 0, undone: 0, redone: 0 };
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 2026]) {
    const counts = randomRun(seed, 700, {});
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  }
  // La prueba sólo vale si de verdad ejercitó ediciones, rechazos, deshacer y rehacer.
  assert.ok(totals.done > 2500, `ediciones: ${totals.done}`);
  assert.ok(totals.refused > 150, `rechazos: ${totals.refused}`);
  assert.ok(totals.undone > 250 && totals.redone > 60, `deshacer ${totals.undone}, rehacer ${totals.redone}`);
});

test('operaciones al azar con límites pequeños: nunca se pasa de pasos, conexiones ni variables', () => {
  for (const seed of [4, 9, 16]) {
    const counts = randomRun(seed, 500, { nodes: 9, edges: 7, variables: 2 });
    assert.ok(counts.refused > 40, `semilla ${seed}: los límites rechazaron ${counts.refused} operaciones`);
  }
});
