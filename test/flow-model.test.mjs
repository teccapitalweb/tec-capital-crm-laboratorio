// Modelo compartido de los recorridos (public/kit/shared/flow-model.js): registro de tipos, validación, acomodo,
// conversión del flujo de bienvenida, importar y exportar, resumen y plantillas. Son funciones puras: se importan tal
// cual, sin servidor ni navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  GEOMETRY,
  GROUPS,
  LIMITS,
  NODE_TYPES,
  PALETTE,
  applyLayout,
  boundsOf,
  checkStructure,
  createNode,
  definedVariables,
  describeNode,
  edgePath,
  emptyGraph,
  exportFlow,
  exportJson,
  flowRates,
  flowResult,
  fromWelcomeFlow,
  hasNestedQuantifier,
  importFlow,
  inputPoint,
  issuesByNode,
  layout,
  nextId,
  nodeName,
  nodeSize,
  norm,
  normalizeGraph,
  normalizeSettings,
  portPoint,
  portsOf,
  reachable,
  readingOrder,
  referencesOf,
  repairGraph,
  summarize,
  tokensIn,
  typeOf,
  validateGraph,
  validateSettings,
} from '../public/kit/shared/flow-model.js';
import { FLOW_TEMPLATES, instantiateTemplate, templateByKey } from '../public/kit/shared/flow-templates.js';
import { ACTIONS, DEFAULT_STEPS, LIMITS as WELCOME_LIMITS, norm as welcomeNorm } from '../server/flows.mjs';

// ---- Ayudantes para armar grafos de prueba ---------------------------------------------------------------------------

const N = (id, type, data = {}, extra = {}) => ({ id, type, x: 0, y: 0, data, ...extra });
const E = (from, port, to) => ({ from, port, to });
const say = body => ({ parts: [{ kind: 'text', text: body }] });
const G = (nodes, edges = [], variables = []) => ({ v: 1, start: nodes[0].id, nodes, edges, variables });
const goto = { type: 'goto' };
const buttons = (labels, extra = {}) => ({
  text: '¿Qué prefieres?',
  options: labels.map((label, i) => ({ id: 'o' + (i + 1), label, do: goto })),
  ...extra,
});

// Inicio → Mensaje → Fin: el recorrido correcto más pequeño. Las pruebas lo estropean de una sola manera cada vez.
const base = () =>
  G([N('s', 'start'), N('m', 'message', say('Hola')), N('e', 'end')], [E('s', 'next', 'm'), E('m', 'next', 'e')]);
// Inicio → un paso con los ajustes dados → Fin (por su primera salida).
const around = (type, data, ctx) => {
  const node = N('x', type, data);
  const port = portsOf({ ...node, data: typeOf(type).clean(data) })[0];
  const edges = [E('s', 'next', 'x')];
  if (port) edges.push(E('x', port.id, 'e'));
  return validateGraph(
    G([N('s', 'start'), node, N('m', 'message', say('Hola')), N('e', 'end')], [...edges, E('m', 'next', 'e')]),
    ctx,
  );
};

const errorsOf = (result, code, nodeId) =>
  result.errors.filter(i => i.code === code && (nodeId === undefined || i.nodeId === nodeId));
const warningsOf = (result, code, nodeId) =>
  result.warnings.filter(i => i.code === code && (nodeId === undefined || i.nodeId === nodeId));
const fails = (result, code, pattern, nodeId) => {
  const found = errorsOf(result, code, nodeId);
  assert.ok(found.length, `se esperaba un error «${code}» y hubo: ${JSON.stringify(result.errors)}`);
  if (pattern)
    assert.ok(
      found.some(i => pattern.test(i.message)),
      `ningún error «${code}» dice ${pattern}: ${JSON.stringify(found)}`,
    );
};
const passes = (result, code) => assert.deepEqual(errorsOf(result, code), [], `no se esperaba ningún error «${code}»`);
const clean = result => assert.deepEqual(result, { errors: [], warnings: [] });

// Generador con semilla: las pruebas con azar deben poder repetirse.
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
const shuffled = (items, rnd) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const k = Math.floor(rnd() * (i + 1));
    [out[i], out[k]] = [out[k], out[i]];
  }
  return out;
};

// ---- Registro de tipos -----------------------------------------------------------------------------------------------

test('registro: están los 24 tipos del diseño, con nombre, grupo, salidas, ajustes de fábrica y campos del panel', () => {
  const expected = {
    start: ['next'],
    message: ['next'],
    buttons: ['opt:o1', 'default', 'timeout'],
    list: ['opt:r1', 'default', 'timeout'],
    question: ['next', 'invalid', 'timeout'],
    template: ['next'],
    condition: ['case:c1', 'else'],
    delay: ['next'],
    set_attribute: ['next'],
    tags: ['next'],
    consent: ['next'],
    handoff: [],
    status: ['next'],
    assistant: ['next'],
    goto_flow: [],
    webhook: ['success', 'failure'],
    end: [],
    course_card: ['next', 'unavailable'],
    price: ['next', 'unavailable'],
    syllabus: ['next'],
    schedule: ['next', 'unavailable'],
    enroll: ['order', 'manual', 'unavailable'],
    choose_course: ['next', 'none', 'timeout'],
    note: [],
  };
  assert.deepEqual(Object.keys(NODE_TYPES).sort(), Object.keys(expected).sort());
  const groups = GROUPS.map(g => g.id);
  assert.deepEqual(groups, ['mensajes', 'catalogo', 'logica', 'contacto', 'atencion', 'integraciones']);
  for (const [type, ports] of Object.entries(expected)) {
    const def = typeOf(type);
    assert.equal(def.type, type);
    assert.ok(def.label && def.hint && def.icon, `${type}: nombre, ayuda e icono`);
    assert.ok(groups.includes(def.group), `${type}: grupo conocido`);
    assert.ok(Array.isArray(def.fields), `${type}: campos del panel`);
    const data = def.defaults();
    assert.deepEqual(def.clean(data), data, `${type}: los ajustes de fábrica ya son canónicos`);
    assert.deepEqual(
      def.ports(data).map(p => p.id),
      ports,
      `${type}: salidas`,
    );
    for (const p of def.ports(data)) assert.ok(p.label, `${type}.${p.id}: la salida tiene nombre en español`);
    assert.equal(typeof def.summary(data, {}), 'string');
  }
  assert.equal(typeOf('nada'), null);
  assert.equal(typeOf('constructor'), null, 'no confunde propiedades heredadas con tipos');
  assert.throws(() => createNode('nada', { id: 'n1' }), /desconocido/);
  // La paleta ofrece todos menos el Inicio, que es único.
  const offered = PALETTE.flatMap(g => g.types);
  assert.deepEqual(
    offered.slice().sort(),
    Object.keys(expected)
      .filter(t => t !== 'start')
      .sort(),
  );
  assert.deepEqual(
    PALETTE.map(g => g.label),
    ['Mensajes', 'Catálogo', 'Lógica', 'Contacto', 'Atención', 'Integraciones'],
  );
});

test('registro: las salidas dependen de los ajustes (opciones, casos, modo y plantilla)', () => {
  const ids = (type, data) =>
    typeOf(type)
      .ports(typeOf(type).clean(data))
      .map(p => p.id);
  const mixed = {
    options: [
      { id: 'si', label: 'Sí', do: goto },
      { id: 'precio', label: 'Precio', do: { type: 'intent', intent: 'price', stay: true } },
    ],
  };
  assert.deepEqual(
    ids('buttons', mixed),
    ['opt:si', 'default', 'timeout'],
    'sólo las opciones que siguen por su salida tienen puerto',
  );
  const rows = {
    sections: [
      { title: 'A', rows: [{ id: 'a', title: 'Uno', do: goto }] },
      { title: 'B', rows: [{ id: 'b', title: 'Dos', do: goto }] },
    ],
  };
  assert.deepEqual(ids('list', rows), ['opt:a', 'opt:b', 'default', 'timeout']);
  assert.deepEqual(
    ids('condition', {
      cases: [
        { id: 'vip', label: 'VIP' },
        { id: 'nuevo', label: 'Nuevo' },
      ],
    }),
    ['case:vip', 'case:nuevo', 'else'],
  );
  assert.deepEqual(ids('assistant', { mode: 'answer' }), ['next']);
  assert.deepEqual(ids('assistant', { mode: 'handover' }), []);
  assert.deepEqual(ids('assistant', { mode: 'collect' }), ['success', 'failure']);
  assert.deepEqual(ids('status', { status: 'waiting' }), ['next']);
  assert.deepEqual(ids('status', { status: 'resolved' }), [], '«resuelta» termina la sesión');
  assert.deepEqual(ids('template', { waTemplateId: 't', wait: false, buttons: ['Sí', 'No'] }), ['next']);
  assert.deepEqual(ids('template', { waTemplateId: 't', wait: true, buttons: ['Sí', 'No'] }), [
    'opt:1',
    'opt:2',
    'default',
    'timeout',
  ]);
  assert.deepEqual(
    ids('template', { waTemplateId: 't', wait: true, buttons: [] }),
    ['next'],
    'sin botones no hay nada que esperar',
  );
  // Los que tienen un comportamiento por omisión no avisan si quedan sin conectar.
  const optional = (type, data = {}) =>
    typeOf(type)
      .ports(typeOf(type).clean(data))
      .filter(p => p.optional)
      .map(p => p.id);
  assert.deepEqual(optional('buttons', mixed), ['default', 'timeout']);
  assert.deepEqual(optional('enroll'), ['unavailable']);
  assert.deepEqual(optional('question'), ['timeout']);
});

test('registro: limpiar los ajustes nunca falla, es idempotente y da ids únicos a opciones, filas y casos', () => {
  const rnd = random(42);
  const junk = [
    undefined,
    null,
    0,
    7,
    'x',
    true,
    [],
    {},
    [1, 'a'],
    { id: 5 },
    { kind: 'media' },
    { type: 'intent' },
    { f: 'clock', days: [1, '2', 9] },
  ];
  const keys = [
    'parts',
    'kind',
    'text',
    'header',
    'options',
    'id',
    'label',
    'do',
    'type',
    'intent',
    'stay',
    'sections',
    'rows',
    'title',
    'answer',
    'min',
    'max',
  ];
  keys.push(
    'pattern',
    'saveTo',
    'name',
    'key',
    'cases',
    'when',
    'mode',
    'groups',
    'items',
    'f',
    'op',
    'value',
    'seconds',
    'add',
    'remove',
    'to',
    'userId',
  );
  keys.push(
    'status',
    'url',
    'headers',
    'secret',
    'map',
    'path',
    'buttons',
    'wait',
    'in',
    'days',
    'from',
    'mediaKinds',
    'body',
    'flyer',
    'attempts',
    'saveAs',
  );
  const any = depth => {
    const r = rnd();
    if (depth > 3 || r < 0.35) return junk[Math.floor(rnd() * junk.length)];
    if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => any(depth + 1));
    const out = {};
    for (let i = 0; i < 6; i += 1) out[keys[Math.floor(rnd() * keys.length)]] = any(depth + 1);
    return out;
  };
  for (const def of Object.values(NODE_TYPES)) {
    for (let i = 0; i < 150; i += 1) {
      const once = def.clean(any(0));
      assert.deepEqual(def.clean(JSON.parse(JSON.stringify(once))), once, `${def.type}: limpiar dos veces da lo mismo`);
      const ports = def.ports(once).map(p => p.id);
      assert.equal(new Set(ports).size, ports.length, `${def.type}: salidas sin repetir`);
      // Nada de esto puede lanzar con ajustes limpios, por raros que fueran los originales.
      def.summary(once, {});
      def.validate(once, { ctx: {}, vars: new Set() });
      def.refs(once);
      def.writes(once);
      def.reads(once);
    }
  }
  const repeated = typeOf('buttons').clean({
    options: [{ id: 'a', label: 'Uno' }, { id: 'a', label: 'Dos' }, { id: 'MAL', label: 'Tres' }, { label: 'Cuatro' }],
  });
  assert.deepEqual(
    repeated.options.map(o => o.id),
    ['a', 'o1', 'o2', 'o3'],
    'el primero conserva su id; los repetidos e inválidos reciben uno nuevo',
  );
  assert.equal(
    typeOf('message').clean({
      parts: [{ kind: 'text', text: 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(7) + '\nc' }],
    }).parts[0].text,
    'ab\nc',
  );
});

test('límites: los del diseño y los que el flujo de bienvenida ya imponía', () => {
  assert.equal(LIMITS.nodes, 80);
  assert.equal(LIMITS.edges, 200);
  assert.equal(LIMITS.bytes, 200_000);
  assert.equal(LIMITS.flowsPerBrand, 100);
  assert.equal(LIMITS.variables, 20);
  assert.equal(LIMITS.buttons, WELCOME_LIMITS.buttons);
  assert.equal(LIMITS.buttonLabel, WELCOME_LIMITS.label);
  assert.equal(LIMITS.listRows, 10);
  assert.equal(LIMITS.delaySeconds, 600);
});

// ---- Validación: cada regla con un grafo que falla y uno que pasa ----------------------------------------------------

test('validación: el recorrido correcto más pequeño no tiene errores ni advertencias', () => {
  clean(validateGraph(base()));
  assert.deepEqual(checkStructure(normalizeGraph(base())), []);
});

test('validación «graph»: forma o versión que la aplicación no entiende, sin lanzar', () => {
  for (const bad of [null, undefined, 'x', 7, [], {}, { v: 1 }, { v: 1, nodes: [], edges: 'x' }])
    fails(validateGraph(bad), 'graph', /forma válida/);
  fails(validateGraph({ ...base(), v: 2 }), 'graph', /versión/);
  fails(validateGraph({ ...base(), variables: 'x' }), 'graph', /variables/);
  fails(validateGraph({ ...base(), variables: [{ name: 'Mal Nombre' }] }), 'graph', /nombre válido/);
  fails(validateGraph({ ...base(), variables: [{ name: 'correo' }, { name: 'correo' }] }), 'graph', /dos veces/);
  passes(validateGraph({ ...base(), variables: [{ name: 'correo', label: 'Correo', type: 'email' }] }), 'graph');
  // Lo que llegue del navegador nunca debe tumbar al servidor.
  const rnd = random(7);
  const pieces = [
    null,
    1,
    'x',
    {},
    [],
    { id: 'a' },
    { id: 'a', type: 'message' },
    { from: 'a', port: 'next', to: 'a' },
    { id: 's', type: 'start', data: [] },
  ];
  pieces.push(
    { id: 5, type: 'start' },
    { name: null },
    { name: 'ok' },
    { from: 's', port: 'next', to: 'a' },
    { id: 'b', type: 'buttons', data: { options: 7 } },
  );
  for (let i = 0; i < 600; i += 1) {
    const take = () => Array.from({ length: Math.floor(rnd() * 5) }, () => pieces[Math.floor(rnd() * pieces.length)]);
    const result = validateGraph(
      { v: 1, start: rnd() < 0.5 ? 's' : 5, nodes: take(), edges: take(), variables: rnd() < 0.8 ? take() : 3 },
      { settings: { proactive: true } },
    );
    assert.ok(Array.isArray(result.errors) && Array.isArray(result.warnings));
  }
});

test('validación «start»: exactamente un Inicio, y conectado', () => {
  passes(validateGraph(base()), 'start');
  const noStart = base();
  noStart.nodes.shift();
  noStart.edges.shift();
  fails(validateGraph(noStart), 'start', /falta el paso de Inicio/);
  const two = base();
  two.nodes.push(N('s2', 'start'));
  fails(validateGraph(two), 'start', /Sólo puede haber un Inicio/);
  const loose = base();
  loose.edges.shift();
  fails(validateGraph(loose), 'start', /Conecta el Inicio/, 's');
  fails(validateGraph({ ...base(), start: 'm' }), 'start', /no apunta/);
});

test('validación «edge»: destino inexistente, salida que el tipo no tiene, dos conexiones en una salida', () => {
  passes(validateGraph(base()), 'edge');
  const gone = base();
  gone.edges.push(E('m', 'next', 'fantasma'));
  gone.edges.splice(1, 1);
  fails(validateGraph(gone), 'edge', /ya no existe/, 'm');
  const orphan = base();
  orphan.edges.push(E('fantasma', 'next', 'e'));
  fails(validateGraph(orphan), 'edge', /sale de un paso que ya no existe/);
  const badPort = base();
  badPort.edges.push(E('m', 'timeout', 'e'));
  fails(validateGraph(badPort), 'edge', /salida que este paso no tiene \(timeout\)/, 'm');
  const twice = base();
  twice.edges.push(E('m', 'next', 's'));
  fails(validateGraph(twice), 'edge', /más de una conexión/, 'm');
  const toStart = base();
  toStart.edges[1] = E('m', 'next', 's');
  fails(validateGraph(toStart), 'edge', /al Inicio no puede llegar/, 'm');
  const toNote = base();
  toNote.nodes.push(N('n', 'note', { text: 'Pendiente' }));
  toNote.edges[1] = E('m', 'next', 'n');
  fails(validateGraph(toNote), 'edge', /nota/, 'm');
  // Muchas conexiones pueden llegar al mismo paso: eso sí es válido.
  const merge = G(
    [N('s', 'start'), N('b', 'buttons', buttons(['Uno', 'Dos'])), N('m', 'message', say('Hola'))],
    [E('s', 'next', 'b'), E('b', 'opt:o1', 'm'), E('b', 'opt:o2', 'm'), E('b', 'default', 'm')],
  );
  passes(validateGraph(merge), 'edge');
});

test('validación «speaks»: un recorrido que no le escribe nada a la persona', () => {
  passes(validateGraph(base()), 'speaks');
  const mute = G(
    [N('s', 'start'), N('d', 'delay', { seconds: 2 }), N('t', 'tags', { add: ['vip'] }), N('e', 'end')],
    [E('s', 'next', 'd'), E('d', 'next', 't'), E('t', 'next', 'e')],
  );
  fails(validateGraph(mute), 'speaks', /no envía ningún mensaje/);
  // Un mensaje al que no se llega no cuenta.
  const unreached = G(
    [N('s', 'start'), N('d', 'delay', { seconds: 2 }), N('m', 'message', say('Hola'))],
    [E('s', 'next', 'd')],
  );
  fails(validateGraph(unreached), 'speaks');
  // El Fin y «Pasar con una persona» hablan sólo si llevan texto.
  const bye = G([N('s', 'start'), N('e', 'end', { text: 'Hasta pronto.' })], [E('s', 'next', 'e')]);
  passes(validateGraph(bye), 'speaks');
  const silentHandoff = G([N('s', 'start'), N('h', 'handoff', { to: 'queue' })], [E('s', 'next', 'h')]);
  fails(validateGraph(silentHandoff), 'speaks');
});

test('validación «loop»: un ciclo que nunca espera a la persona', () => {
  passes(validateGraph(base()), 'loop');
  const endless = G(
    [N('s', 'start'), N('a', 'message', say('Uno')), N('d', 'delay', { seconds: 3 }), N('b', 'message', say('Dos'))],
    [E('s', 'next', 'a'), E('a', 'next', 'd'), E('d', 'next', 'b'), E('b', 'next', 'a')],
  );
  const result = validateGraph(endless);
  fails(result, 'loop', /nunca espera a la persona \(«Uno» → «Espera» → «Dos»\)/, 'a');
  assert.equal(errorsOf(result, 'loop').length, 1, 'un ciclo se reporta una vez, en su primer paso');
  const self = G([N('s', 'start'), N('a', 'message', say('Uno'))], [E('s', 'next', 'a'), E('a', 'next', 'a')]);
  fails(validateGraph(self), 'loop', /sin fin/, 'a');
  // Con unos botones, una lista, una pregunta o «¿Qué curso te interesa?» en el camino, el ciclo espera.
  for (const [type, data, port] of [
    ['buttons', buttons(['Otra vez']), 'opt:o1'],
    [
      'list',
      { text: 'Elige', button: 'Ver', sections: [{ rows: [{ id: 'r1', title: 'Otra vez', do: goto }] }] },
      'opt:r1',
    ],
    [
      'question',
      { text: '¿Tu correo?', answer: { type: 'email' }, saveTo: { kind: 'var', name: 'correo' } },
      'invalid',
    ],
    ['choose_course', {}, 'none'],
  ]) {
    const waiting = G(
      [N('s', 'start'), N('a', 'message', say('Uno')), N('w', type, data)],
      [E('s', 'next', 'a'), E('a', 'next', 'w'), E('w', port, 'a')],
    );
    passes(validateGraph(waiting), 'loop');
  }
  // Un paso que se repite a sí mismo es válido si espera (la pregunta que vuelve a preguntar).
  const again = G(
    [
      N('s', 'start'),
      N('q', 'question', { text: '¿Tu correo?', answer: { type: 'email' }, saveTo: { kind: 'var', name: 'correo' } }),
    ],
    [E('s', 'next', 'q'), E('q', 'invalid', 'q')],
  );
  passes(validateGraph(again), 'loop');
  // Un ciclo al que no se llega no puede enviar nada: se avisa como paso inalcanzable, no como ciclo.
  const dead = base();
  dead.nodes.push(N('x', 'message', say('X')), N('y', 'message', say('Y')));
  dead.edges.push(E('x', 'next', 'y'), E('y', 'next', 'x'));
  passes(validateGraph(dead), 'loop');
  assert.equal(warningsOf(validateGraph(dead), 'unreachable').length, 2);
});

test('validación «node»: textos, botones y listas', () => {
  fails(around('message', say('   ')), 'node', /Escribe el texto/, 'x');
  fails(around('message', say('a'.repeat(4097))), 'node', /demasiado largo: 4097 de 4096/, 'x');
  passes(around('message', say('a'.repeat(4096))), 'node');
  fails(around('message', { parts: [] }), 'node', /al menos una parte/, 'x');
  fails(
    around('message', { parts: Array.from({ length: 6 }, () => ({ kind: 'text', text: 'a' })) }),
    'node',
    /hasta 5 partes/,
    'x',
  );
  fails(around('message', { parts: [{ kind: 'slot', slot: 'Mal Espacio' }] }), 'node', /nombre del espacio/, 'x');
  passes(around('message', { parts: [{ kind: 'slot', slot: 'presentacion', ifMissing: 'skip' }] }), 'node');
  fails(around('message', { parts: [{ kind: 'material', templateId: '' }] }), 'node', /Elige el material/, 'x');
  fails(around('message', { parts: [{ kind: 'media', fileId: '' }] }), 'node', /Elige el archivo/, 'x');

  // 4 botones (el límite de WhatsApp es 3) y un botón de 21 caracteres (el límite es 20).
  fails(
    around('buttons', buttons(['Uno', 'Dos', 'Tres', 'Cuatro'])),
    'node',
    /hasta 3 botones por mensaje \(hay 4\)/,
    'x',
  );
  passes(around('buttons', buttons(['Uno', 'Dos', 'Tres'])), 'node');
  fails(around('buttons', buttons(['a'.repeat(21)])), 'node', /demasiado largo: 21 de 20/, 'x');
  passes(around('buttons', buttons(['a'.repeat(20)])), 'node');
  fails(around('buttons', buttons([])), 'node', /al menos un botón/, 'x');
  fails(around('buttons', buttons(['Sí', 'SI!'])), 'node', /mismo texto/, 'x');
  fails(around('buttons', buttons(['¡¿?!'])), 'node', /al menos una letra o un número/, 'x');
  fails(around('buttons', buttons([''])), 'node', /sin texto/, 'x');
  fails(around('buttons', buttons(['Uno'], { text: '' })), 'node', /Escribe el mensaje/, 'x');
  fails(around('buttons', buttons(['Uno'], { text: 'a'.repeat(1025) })), 'node', /1025 de 1024/, 'x');
  fails(around('buttons', buttons(['Uno'], { footer: 'a'.repeat(61) })), 'node', /el pie/i, 'x');
  fails(around('buttons', buttons(['Uno'], { header: { kind: 'text', text: '' } })), 'node', /encabezado/, 'x');
  fails(around('buttons', buttons(['Uno'], { saveAs: 'Mi Variable' })), 'node', /nombre de la variable/, 'x');
  passes(
    around(
      'buttons',
      buttons(['Uno'], { saveAs: 'eleccion', header: { kind: 'course_flyer' }, footer: 'Responde cuando quieras' }),
    ),
    'node',
  );

  // Lista de 11 filas (el límite es 10 en total, sumando las secciones).
  const listOf = (count, extra = {}) => ({
    text: 'Elige un tema',
    button: 'Ver temas',
    sections: [
      {
        title: '',
        rows: Array.from({ length: count }, (_, i) => ({ id: 'r' + (i + 1), title: 'Tema ' + (i + 1), do: goto })),
      },
    ],
    ...extra,
  });
  fails(around('list', listOf(11)), 'node', /hasta 10 filas por lista \(hay 11\)/, 'x');
  passes(around('list', listOf(10)), 'node');
  const split = listOf(0, {
    sections: [
      { title: 'A', rows: Array.from({ length: 6 }, (_, i) => ({ id: 'a' + i, title: 'A' + i, do: goto })) },
      { title: 'B', rows: Array.from({ length: 5 }, (_, i) => ({ id: 'b' + i, title: 'B' + i, do: goto })) },
    ],
  });
  fails(around('list', split), 'node', /hay 11/, 'x');
  fails(around('list', listOf(1, { button: '' })), 'node', /botón que abre la lista/, 'x');
  fails(around('list', listOf(1, { button: 'a'.repeat(21) })), 'node', /21 de 20/, 'x');
  fails(
    around('list', {
      text: 'Elige',
      button: 'Ver',
      sections: [{ title: 'A', rows: [{ id: 'r1', title: 'a'.repeat(25), do: goto }] }],
    }),
    'node',
    /25 de 24/,
    'x',
  );
  fails(
    around('list', {
      text: 'Elige',
      button: 'Ver',
      sections: [{ rows: [{ id: 'r1', title: 'Uno', description: 'a'.repeat(73), do: goto }] }],
    }),
    'node',
    /73 de 72/,
    'x',
  );
  fails(
    around('list', {
      text: 'Elige',
      button: 'Ver',
      sections: [{ rows: [{ id: 'r1', title: 'Uno', do: goto }] }, { rows: [{ id: 'r2', title: 'Dos', do: goto }] }],
    }),
    'node',
    /cada una necesita título/,
    'x',
  );
  fails(
    around('list', { text: 'Elige', button: 'Ver', sections: [{ title: 'A', rows: [] }] }),
    'node',
    /no tiene filas/,
    'x',
  );
  fails(around('list', { text: 'Elige', button: 'Ver', sections: [] }), 'node', /al menos una sección/, 'x');
});

test('validación «node»: datos que no existen, variables desconocidas e importes escritos a mano', () => {
  passes(
    around(
      'message',
      say('Hola, {{nombre}}. Te interesa {{curso}} ({{ Edición }}) de {{marca}}: {{precio}} hasta {{vigencia}}.'),
    ),
    'node',
  );
  passes(around('message', say('Hola, {{nombre|qué tal}}. Tu ciudad: {{contacto.ciudad}}.')), 'node');
  fails(around('message', say('Te atiende {{asesor}}.')), 'node', /dato que no existe: \{\{asesor\}\}/, 'x');
  fails(around('message', say('Hola {{}}')), 'node', /dato que no existe/, 'x');
  fails(around('message', say('Hola {{nombre')), 'node', /llaves \{\{ \}\} sin cerrar/, 'x');
  fails(
    around('message', say('Tu correo es {{var.correo}}.')),
    'node',
    /variable «correo», que ningún paso guarda/,
    'x',
  );
  fails(around('message', say('Dato {{contacto.Mal Nombre}}')), 'node', /dato que no existe/, 'x');

  // Una variable existe si está declarada o si algún paso la guarda.
  const usesVar = (variables, nodes = [], edges = []) =>
    validateGraph(
      G(
        [N('s', 'start'), N('m', 'message', say('Tu correo es {{var.correo}}.')), ...nodes],
        [E('s', 'next', 'm'), ...edges],
        variables,
      ),
    );
  fails(usesVar([]), 'node', /variable «correo»/, 'm');
  passes(usesVar([{ name: 'correo', label: 'Correo', type: 'email' }]), 'node');
  const question = N('q', 'question', {
    text: '¿Tu correo?',
    answer: { type: 'email' },
    saveTo: { kind: 'var', name: 'correo' },
  });
  passes(usesVar([], [question], [E('m', 'next', 'q')]), 'node');
  const chooser = N('b', 'buttons', buttons(['Uno'], { saveAs: 'correo' }));
  passes(usesVar([], [chooser], [E('m', 'next', 'b')]), 'node');
  assert.deepEqual(
    [...definedVariables(G([N('s', 'start'), question, chooser], [], [{ name: 'ciudad' }])).keys()],
    ['ciudad', 'correo'],
  );

  // El precio sólo sale del catálogo: la misma regla del conocimiento del asistente.
  for (const amount of ['Cuesta $1,500 hoy.', 'Cuesta $ 900', 'Son 1500 pesos', 'Son 99 USD', 'por 2000 mxn']) {
    fails(around('message', say(amount)), 'node', /importe escrito a mano/, 'x');
  }
  passes(around('message', say('Cuesta {{precio}} (antes {{precio_regular}}); ahorras {{ahorro}}.')), 'node');
  passes(around('message', say('Son 5 horas en 2 sesiones. Escribe al 55 1234 5678.')), 'node');
  fails(around('buttons', buttons(['Pagar $500'])), 'node', /importe escrito a mano/, 'x');
  fails(around('end', { text: 'Recuerda: 300 pesos de descuento.' }), 'node', /importe/, 'x');
});

test('validación «node»: pregunta, espera, condición, guardar dato, etiquetas, asistente, servicio externo y nota', () => {
  const ask = (extra = {}) => ({
    text: '¿Tu nombre?',
    answer: { type: 'text' },
    saveTo: { kind: 'var', name: 'nombre' },
    attempts: 2,
    ...extra,
  });
  passes(around('question', ask()), 'node');
  fails(around('question', ask({ text: '' })), 'node', /Escribe la pregunta/, 'x');
  fails(around('question', ask({ attempts: 4 })), 'node', /intentos van de 1 a 3/, 'x');
  fails(around('question', ask({ attempts: 0 })), 'node', /intentos/, 'x');
  fails(
    around('question', ask({ answer: { type: 'text', min: 9, max: 3 } })),
    'node',
    /mínimo no puede ser mayor/,
    'x',
  );
  fails(around('question', ask({ saveTo: { kind: 'var', name: '' } })), 'node', /nombre de la variable/, 'x');
  fails(around('question', ask({ saveTo: { kind: 'var', name: '9mal' } })), 'node', /no es válido/, 'x');
  fails(around('question', ask({ saveTo: { kind: 'attribute', key: '' } })), 'node', /Elige el dato del contacto/, 'x');
  // Formato propio: hasta 120 caracteres, expresión válida y sin una repetición dentro de otra.
  const regex = pattern => around('question', ask({ answer: { type: 'regex', pattern } }));
  passes(regex('^[A-Z]{4}\\d{6}$'), 'node');
  passes(regex('^(\\d{2}-){2}\\d{4}$'), 'node');
  fails(regex(''), 'node', /Escribe el formato/, 'x');
  fails(regex('a'.repeat(121)), 'node', /hasta 120 caracteres/, 'x');
  fails(regex('([a-z'), 'node', /no es una expresión válida/, 'x');
  fails(regex('^(a+)+$'), 'node', /repetir un grupo/, 'x');
  // Lo que calcula el sistema no se escribe; el teléfono y el correo sólo ya validados.
  fails(
    around('question', ask({ saveTo: { kind: 'attribute', key: 'estado_pago' } })),
    'node',
    /«Estado de pago» no se puede escribir/,
    'x',
  );
  fails(around('question', ask({ saveTo: { kind: 'attribute', key: 'correo' } })), 'node', /valide el correo/, 'x');
  passes(around('question', ask({ answer: { type: 'email' }, saveTo: { kind: 'attribute', key: 'correo' } })), 'node');
  fails(around('question', ask({ saveTo: { kind: 'attribute', key: 'telefono' } })), 'node', /valide el teléfono/, 'x');
  passes(
    around('question', ask({ answer: { type: 'phone' }, saveTo: { kind: 'attribute', key: 'telefono' } })),
    'node',
  );
  passes(around('question', ask({ saveTo: { kind: 'attribute', key: 'nombre_completo' } })), 'node');

  fails(around('delay', { seconds: 0 }), 'node', /de 1 a 600 segundos/, 'x');
  fails(around('delay', { seconds: 601 }), 'node', /de 1 a 600/, 'x');
  passes(around('delay', { seconds: 600 }), 'node');

  const when = items => ({ mode: 'all', groups: [{ mode: 'all', items }] });
  const cases = (items, label = 'Ya pagó') => ({ cases: [{ id: 'c1', label, when: when(items) }] });
  passes(around('condition', cases([{ f: 'attr', key: 'estado_pago', op: 'eq', value: 'pagado' }])), 'node');
  passes(
    around(
      'condition',
      cases([
        { f: 'attr', key: 'correo', op: 'empty' },
        { f: 'hours', is: 'open' },
        { f: 'channel', in: ['whatsapp'] },
      ]),
    ),
    'node',
  );
  passes(around('condition', cases([{ f: 'clock', days: ['1', '2'], from: '09:00', to: '18:00' }])), 'node');
  fails(around('condition', { cases: [] }), 'node', /al menos un caso/, 'x');
  fails(
    around('condition', {
      cases: Array.from({ length: 6 }, (_, i) => ({
        id: 'c' + i,
        label: 'Caso ' + i,
        when: when([{ f: 'hours', is: 'open' }]),
      })),
    }),
    'node',
    /hasta 5 casos/,
    'x',
  );
  fails(around('condition', cases([])), 'node', /no tiene ninguna condición/, 'x');
  fails(around('condition', cases([{ f: 'hours', is: 'open' }], '')), 'node', /Ponle nombre al caso 1/, 'x');
  fails(
    around('condition', cases([{ f: 'attr', key: '', op: 'eq', value: 'x' }])),
    'node',
    /Elige el dato que se compara/,
    'x',
  );
  fails(
    around('condition', cases([{ f: 'attr', key: 'estado_pago', op: 'eq', value: '' }])),
    'node',
    /valor con el que se compara/,
    'x',
  );
  fails(
    around('condition', cases([{ f: 'attr', key: 'var.ciudad', op: 'eq', value: 'Puebla' }])),
    'node',
    /variable «ciudad»/,
    'x',
  );
  fails(around('condition', cases([{ f: 'tag', op: 'has', tagId: '' }])), 'node', /Elige la etiqueta/, 'x');
  fails(
    around('condition', cases([{ f: 'clock', days: [], from: '09:00', to: '18:00' }])),
    'node',
    /al menos un día/,
    'x',
  );
  fails(
    around('condition', cases([{ f: 'clock', days: ['1'], from: '9', to: '25:00' }])),
    'node',
    /hora de inicio/,
    'x',
  );
  fails(around('condition', cases([{ f: 'course', in: [] }])), 'node', /al menos un curso/, 'x');
  fails(around('condition', cases([{ f: 'channel', in: ['telegram'] }])), 'node', /al menos un canal/, 'x');
  fails(
    around('condition', cases(Array.from({ length: 9 }, () => ({ f: 'hours', is: 'open' })))),
    'node',
    /hasta 8 condiciones/,
    'x',
  );

  passes(around('set_attribute', { key: 'ciudad', value: { from: 'fixed', text: 'Puebla' } }), 'node');
  passes(around('set_attribute', { key: 'ciudad', value: { from: 'last_message' } }), 'node');
  fails(
    around('set_attribute', { key: '', value: { from: 'fixed', text: 'x' } }),
    'node',
    /Elige el dato del contacto/,
    'x',
  );
  fails(
    around('set_attribute', { key: 'ciudad', value: { from: 'fixed', text: '' } }),
    'node',
    /valor que se guarda/,
    'x',
  );
  fails(
    around('set_attribute', { key: 'estado_pago', value: { from: 'fixed', text: 'pagado' } }),
    'node',
    /no se puede escribir/,
    'x',
  );
  fails(
    around('set_attribute', { key: 'correo', value: { from: 'fixed', text: 'a@b.mx' } }),
    'node',
    /Pregunta que valide el correo/,
    'x',
  );
  fails(
    around('set_attribute', { key: 'ciudad', value: { from: 'var', name: 'nadie' } }),
    'node',
    /variable «nadie»/,
    'x',
  );

  passes(around('tags', { add: ['vip'], remove: ['frio'] }), 'node');
  fails(around('tags', { add: [], remove: [] }), 'node', /al menos una etiqueta/, 'x');
  fails(around('tags', { add: ['vip'], remove: ['vip'] }), 'node', /poner y quitar a la vez/, 'x');

  fails(around('handoff', { to: 'user' }), 'node', /a quién se le asigna/, 'x');
  passes(around('handoff', { to: 'last', text: 'Te atiende una persona.' }), 'node');
  fails(around('goto_flow', { flowId: '' }), 'node', /Elige el recorrido/, 'x');
  fails(around('goto_flow', { flowId: 'este' }, { flowId: 'este' }), 'node', /no puede ir a sí mismo/, 'x');
  fails(around('template', { waTemplateId: '' }), 'node', /Elige la plantilla/, 'x');
  fails(around('template', { waTemplateId: 't1', wait: true, buttons: [] }), 'node', /debe tener botones/, 'x');
  fails(
    around('assistant', { mode: 'collect', prompt: '', saveTo: { kind: 'var', name: 'ciudad' } }),
    'node',
    /dato que se pide/,
    'x',
  );
  fails(
    around(
      'assistant',
      { mode: 'collect', prompt: 'Su ciudad', saveTo: { kind: 'var', name: 'ciudad' } },
      { ai: false },
    ),
    'node',
    /proveedor de IA/,
    'x',
  );
  passes(
    around('assistant', { mode: 'collect', prompt: 'Su ciudad', saveTo: { kind: 'var', name: 'ciudad' } }),
    'node',
  );
  fails(around('choose_course', { attempts: 5 }), 'node', /intentos/, 'x');
  fails(around('note', { text: 'a'.repeat(1001) }), 'node', /hasta 1000 caracteres/, 'x');

  const hook = (extra = {}) => ({
    method: 'GET',
    url: 'https://api.ejemplo.mx/alumnos?tel={{contacto.telefono}}',
    ...extra,
  });
  passes(around('webhook', hook()), 'node');
  fails(around('webhook', hook({ url: '' })), 'node', /dirección del servicio/, 'x');
  for (const url of [
    'http://api.ejemplo.mx',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://192.168.1.5/x',
    'https://172.20.0.1/x',
    'https://[::1]/x',
    'https://caja.internal/x',
  ]) {
    fails(around('webhook', hook({ url })), 'node', /pública y empezar con https/, 'x');
  }
  fails(around('webhook', hook({ url: 'https://usuario:clave@api.ejemplo.mx' })), 'node', /usuario ni contraseña/, 'x');
  fails(around('webhook', hook({ headers: [{ name: 'Mal Nombre', value: 'x' }] })), 'node', /nombre válido/, 'x');
  fails(around('webhook', hook({ headers: [{ name: 'Host', value: 'x' }] })), 'node', /la pone el sistema/, 'x');
  fails(
    around(
      'webhook',
      hook({
        headers: [
          { name: 'X-Token', value: 'a' },
          { name: 'x-token', value: 'b' },
        ],
      }),
    ),
    'node',
    /repetida/,
    'x',
  );
  fails(around('webhook', hook({ headers: [{ name: 'X-Token', value: '' }] })), 'node', /valor de la cabecera/, 'x');
  passes(around('webhook', hook({ headers: [{ name: 'Authorization', secret: 'llave-escuela' }] })), 'node');
  fails(
    around('webhook', hook({ map: [{ path: 'a..b', saveTo: { kind: 'var', name: 'folio' } }] })),
    'node',
    /Escribe dónde está el dato/,
    'x',
  );
  passes(
    around('webhook', hook({ map: [{ path: 'cliente.pedidos[0].folio', saveTo: { kind: 'var', name: 'folio' } }] })),
    'node',
  );
  fails(around('webhook', hook({ sample: '{mal' })), 'node', /JSON válido/, 'x');
  fails(
    around('webhook', hook({ method: 'POST', body: '{"x": "{{nada}}"}' })),
    'node',
    /cuerpo usa un dato que no existe/,
    'x',
  );
  passes(around('webhook', hook({ method: 'POST', body: '{"monto": 1500, "tel": "{{contacto.telefono}}"}' })), 'node');
});

test('validación «node»: identificadores, tipo desconocido, título y posición', () => {
  const twins = base();
  twins.nodes.push(N('m', 'message', say('Otra')));
  fails(validateGraph(twins), 'node', /mismo identificador \(m\)/, 'm');
  const badId = base();
  badId.nodes.push(N('Paso 9', 'message', say('Otra')));
  fails(validateGraph(badId), 'node', /sin un identificador válido/);
  const unknown = base();
  unknown.nodes.push(N('z', 'teletransporte'));
  fails(validateGraph(unknown), 'node', /no existe en esta versión/, 'z');
  const longTitle = base();
  longTitle.nodes[1].title = 'a'.repeat(61);
  fails(validateGraph(longTitle), 'node', /título del paso admite hasta 60/, 'm');
  longTitle.nodes[1].title = 'a'.repeat(60);
  passes(validateGraph(longTitle), 'node');
  const offGrid = base();
  offGrid.nodes[1].x = 10.5;
  fails(validateGraph(offGrid), 'node', /posición/, 'm');
});

test('validación «ref»: lo que no existe o no está listo en la marca (y lo de otra marca no existe)', () => {
  const ctx = {
    materials: [
      { id: 'mat1', name: 'Precio promocional', status: 'approved' },
      { id: 'mat2', name: 'Borrador', status: 'draft' },
    ],
    files: [{ id: 'file1', name: 'cuentas.png' }],
    tags: [{ id: 'vip', name: 'VIP' }],
    waTemplates: [
      { id: 'wt1', name: 'oferta', status: 'approved', buttons: ['Sí, deseo inscribirme'] },
      { id: 'wt2', name: 'pendiente', status: 'pending', buttons: [] },
    ],
    flows: [
      { id: 'f1', name: 'Inscripción', published: true },
      { id: 'f2', name: 'A medias', published: false },
    ],
    users: [
      { id: 'u1', name: 'Ana', active: true },
      { id: 'u2', name: 'Luis', active: false },
    ],
    courses: [{ id: 'c1', title: 'Aves' }],
    attributes: [
      { key: 'ciudad', label: 'Ciudad', type: 'text', status: 'active' },
      { key: 'viejo', label: 'Dato viejo', type: 'text', status: 'archived' },
      { key: 'folio', label: 'Folio', type: 'text', status: 'active', writable: false },
    ],
  };
  const material = id => ({ parts: [{ kind: 'material', templateId: id }] });
  passes(around('message', material('mat1'), ctx), 'ref');
  fails(around('message', material('mat2'), ctx), 'ref', /material «Borrador» no está aprobado/, 'x');
  // El id existe, pero en otra marca: la lista de esta marca no lo trae.
  fails(
    around('message', material('mat-de-otra-marca'), ctx),
    'ref',
    /material de este paso no existe en esta marca/,
    'x',
  );
  passes(around('message', material('mat-de-otra-marca'), {}), 'ref');
  passes(around('message', material('mat-de-otra-marca'), undefined), 'ref');

  fails(around('message', { parts: [{ kind: 'media', fileId: 'nada' }] }, ctx), 'ref', /archivo/, 'x');
  passes(around('message', { parts: [{ kind: 'media', fileId: 'file1' }] }, ctx), 'ref');
  fails(around('price', { templateId: 'mat2' }, ctx), 'ref', /no está aprobado/, 'x');
  passes(around('price', { templateId: '' }, ctx), 'ref');
  fails(around('tags', { add: ['borrada'] }, ctx), 'ref', /etiqueta de este paso no existe/, 'x');
  passes(around('tags', { add: ['vip'] }, ctx), 'ref');
  fails(
    around('template', { waTemplateId: 'wt2' }, ctx),
    'ref',
    /plantilla de WhatsApp «pendiente» no está aprobada/,
    'x',
  );
  passes(around('template', { waTemplateId: 'wt1', buttons: ['Sí, deseo inscribirme'] }, ctx), 'ref');
  fails(
    around('template', { waTemplateId: 'wt1', buttons: ['Texto viejo'] }, ctx),
    'ref',
    /botones de la plantilla cambiaron/,
    'x',
  );
  fails(around('goto_flow', { flowId: 'f2' }, ctx), 'ref', /recorrido «A medias» no está publicado/, 'x');
  fails(around('goto_flow', { flowId: 'borrado' }, ctx), 'ref', /no existe en esta marca/, 'x');
  passes(around('goto_flow', { flowId: 'f1' }, ctx), 'ref');
  fails(around('handoff', { to: 'user', userId: 'u2' }, ctx), 'ref', /«Luis» ya no tiene acceso/, 'x');
  passes(around('handoff', { to: 'user', userId: 'u1' }, ctx), 'ref');

  const save = key => ({ text: '¿Dato?', answer: { type: 'text' }, saveTo: { kind: 'attribute', key } });
  passes(around('question', save('ciudad'), ctx), 'ref');
  fails(around('question', save('viejo'), ctx), 'ref', /«Dato viejo» está archivado/, 'x');
  fails(around('question', save('inventado'), ctx), 'ref', /«inventado» no existe en esta marca/, 'x');
  fails(around('question', save('folio'), ctx), 'node', /«Folio» no se puede escribir/, 'x');
  fails(
    around('message', say('Vives en {{contacto.viejo}}.'), ctx),
    'ref',
    /no existe o está archivado: \{\{contacto.viejo\}\}/,
    'x',
  );
  passes(around('message', say('Vives en {{contacto.ciudad}} y pagaste: {{contacto.estado_pago}}.'), ctx), 'ref');

  const when = items => ({
    cases: [{ id: 'c1', label: 'Caso', when: { mode: 'all', groups: [{ mode: 'all', items }] } }],
  });
  fails(around('condition', when([{ f: 'tag', op: 'has', tagId: 'borrada' }]), ctx), 'ref', /etiqueta/, 'x');
  fails(around('condition', when([{ f: 'course', in: ['c9'] }]), ctx), 'ref', /curso/, 'x');
  fails(
    around('condition', when([{ f: 'attr', key: 'inventado', op: 'eq', value: 'x' }]), ctx),
    'ref',
    /dato del contacto/,
    'x',
  );
  passes(
    around(
      'condition',
      when([
        { f: 'tag', op: 'has', tagId: 'vip' },
        { f: 'course', in: ['c1'] },
        { f: 'attr', key: 'ciudad', op: 'eq', value: 'x' },
      ]),
      ctx,
    ),
    'ref',
  );

  assert.deepEqual(
    referencesOf(
      G([N('s', 'start'), N('a', 'message', material('mat1')), N('t', 'tags', { add: ['vip'], remove: ['frio'] })]),
    ).map(r => [r.source, r.id, r.nodeId, r.path]),
    [
      ['materials', 'mat1', 'a', 'parts.0.templateId'],
      ['tags', 'vip', 't', 'add.0'],
      ['tags', 'frio', 't', 'remove.0'],
    ],
  );
});

test('validación «window»: un recorrido que puede iniciarse solo debe abrir con una plantilla de WhatsApp', () => {
  const proactive = { settings: { proactive: true } };
  fails(
    validateGraph(base(), proactive),
    'window',
    /lo primero que envíe debe ser una Plantilla de WhatsApp; aquí lo primero es «Hola»/,
    'm',
  );
  passes(validateGraph(base(), { settings: { proactive: false } }), 'window');
  passes(validateGraph(base()), 'window');
  const opens = G(
    [
      N('s', 'start'),
      N('t', 'tags', { add: ['vip'] }),
      N('w', 'template', { waTemplateId: 'wt1' }),
      N('m', 'message', say('Gracias')),
    ],
    [E('s', 'next', 't'), E('t', 'next', 'w'), E('w', 'next', 'm')],
  );
  passes(validateGraph(opens, proactive), 'window');
  // Basta un camino que hable antes de la plantilla para que falle.
  const branch = G(
    [
      N('s', 'start'),
      N('c', 'condition', {
        cases: [
          {
            id: 'c1',
            label: 'Abierto',
            when: { mode: 'all', groups: [{ mode: 'all', items: [{ f: 'hours', is: 'open' }] }] },
          },
        ],
      }),
      N('w', 'template', { waTemplateId: 'wt1' }),
      N('m', 'message', say('Hola')),
    ],
    [E('s', 'next', 'c'), E('c', 'case:c1', 'w'), E('c', 'else', 'm')],
  );
  const result = validateGraph(branch, proactive);
  fails(result, 'window', null, 'm');
  assert.equal(errorsOf(result, 'window').length, 1);
});

test('validación «limit»: pasos, conexiones, variables, peso y recolecciones con IA', () => {
  const chain = count => {
    const nodes = [N('s', 'start')];
    const edges = [];
    for (let i = 1; i < count; i += 1) {
      nodes.push(N('m' + i, 'message', say('Paso ' + i)));
      edges.push(E(i === 1 ? 's' : 'm' + (i - 1), 'next', 'm' + i));
    }
    return G(nodes, edges);
  };
  passes(validateGraph(chain(80)), 'limit');
  fails(validateGraph(chain(81)), 'limit', /tiene 81 pasos y admite hasta 80/);
  const many = chain(80);
  // Las conexiones de más son inválidas por otras razones; aquí sólo importa que el límite se avise.
  for (let i = 0; i < 122; i += 1) many.edges.push(E('m1', 'next', 'm2'));
  fails(validateGraph(many), 'limit', /201 conexiones y admite hasta 200/);
  const vars = count => ({
    ...base(),
    variables: Array.from({ length: count }, (_, i) => ({ name: 'v' + i, label: '', type: 'text' })),
  });
  passes(validateGraph(vars(20)), 'limit');
  fails(validateGraph(vars(21)), 'limit', /21 variables y admite hasta 20/);
  const heavy = chain(60);
  for (const n of heavy.nodes.slice(1)) n.data = say('á'.repeat(2000));
  fails(validateGraph(heavy), 'limit', /KB y admite hasta 200 KB/);
  const collect = id =>
    N(id, 'assistant', { mode: 'collect', prompt: 'Su ciudad', saveTo: { kind: 'var', name: 'ciudad' } });
  const three = G(
    [N('s', 'start'), collect('a'), collect('b'), collect('c')],
    [E('s', 'next', 'a'), E('a', 'success', 'b'), E('b', 'success', 'c')],
  );
  fails(validateGraph(three), 'limit', /hasta 2 pasos que piden un dato con IA/, 'c');
  three.nodes.pop();
  three.edges.pop();
  passes(validateGraph(three), 'limit');
});

test('advertencias: paso inalcanzable, salida sin conectar, suscribir sin respuesta, otros canales y espera larga', () => {
  const lonely = base();
  lonely.nodes.push(N('x', 'message', say('Nadie llega aquí')), N('n', 'note', { text: 'Idea' }));
  const result = validateGraph(lonely);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.map(w => [w.code, w.nodeId]),
    [['unreachable', 'x']],
    'una nota suelta no es un problema',
  );
  assert.match(result.warnings[0].message, /Ningún camino llega/);

  // Una salida sin conectar termina el recorrido: es válido y se avisa. Las que tienen un comportamiento por omisión, no.
  const open = G(
    [N('s', 'start'), N('b', 'buttons', buttons(['Uno', 'Dos'])), N('m', 'message', say('Hola'))],
    [E('s', 'next', 'b'), E('b', 'opt:o1', 'm')],
  );
  const ports = validateGraph(open);
  assert.deepEqual(ports.errors, []);
  assert.deepEqual(
    ports.warnings.map(w => [w.code, w.nodeId]),
    [
      ['port', 'b'],
      ['port', 'm'],
    ],
  );
  assert.match(ports.warnings[0].message, /La salida «Dos» no está conectada/);
  const closed = G(
    [
      N('s', 'start'),
      N('q', 'question', { text: '¿Correo?', answer: { type: 'email' }, saveTo: { kind: 'var', name: 'correo' } }),
      N('e', 'end'),
    ],
    [E('s', 'next', 'q'), E('q', 'next', 'e'), E('q', 'invalid', 'e')],
  );
  clean(validateGraph(closed));

  const subscribe = before =>
    validateGraph(
      G(
        [
          N('s', 'start'),
          ...before,
          N('c', 'consent', { action: 'subscribe' }),
          N('m', 'message', say('Listo')),
          N('e', 'end'),
        ],
        [
          E('s', 'next', before[0]?.id || 'c'),
          ...before.map(n => E(n.id, typeOf(n.type).ports(typeOf(n.type).clean(n.data))[0].id, 'c')),
          E('c', 'next', 'm'),
          E('m', 'next', 'e'),
        ],
      ),
    );
  assert.equal(warningsOf(subscribe([]), 'consent', 'c').length, 1);
  assert.equal(warningsOf(subscribe([N('d', 'delay', { seconds: 2 })]), 'consent').length, 1);
  assert.equal(
    warningsOf(subscribe([N('b', 'buttons', buttons(['Sí, quiero novedades']))]), 'consent').length,
    0,
    'después de unos botones la persona ya respondió',
  );
  const unsubscribe = G(
    [
      N('s', 'start'),
      N('c', 'consent', { action: 'unsubscribe' }),
      N('e', 'end', { text: 'Listo, ya no recibirás novedades.' }),
    ],
    [E('s', 'next', 'c'), E('c', 'next', 'e')],
  );
  assert.equal(
    warningsOf(validateGraph(unsubscribe), 'consent').length,
    0,
    'dar de baja no necesita una respuesta previa',
  );

  const withList = ctx =>
    around('list', { text: 'Elige', button: 'Ver', sections: [{ rows: [{ id: 'r1', title: 'Uno', do: goto }] }] }, ctx);
  assert.equal(warningsOf(withList({ settings: { channels: ['whatsapp', 'instagram'] } }), 'channel', 'x').length, 1);
  assert.match(
    warningsOf(withList({ settings: { channels: ['whatsapp', 'facebook'] } }), 'channel')[0].message,
    /texto numerado/,
  );
  assert.equal(warningsOf(withList({ settings: { channels: ['whatsapp'] } }), 'channel').length, 0);
  assert.equal(warningsOf(withList({}), 'channel').length, 0);

  assert.equal(warningsOf(around('delay', { seconds: 61 }), 'delay', 'x').length, 1);
  assert.equal(warningsOf(around('delay', { seconds: 60 }), 'delay').length, 0);
});

test('validación: cada problema lleva su código, un mensaje en español y, si es de un paso, a cuál pertenece', () => {
  const messy = G(
    [
      N('s', 'start'),
      N('b', 'buttons', buttons(['Uno', 'Dos', 'Tres', 'Cuatro'], { text: '' })),
      N('d', 'delay', { seconds: 0 }),
      N('x', 'message', say('')),
    ],
    [E('s', 'next', 'b'), E('b', 'opt:o1', 'd'), E('d', 'next', 'd')],
  );
  const result = validateGraph(messy);
  for (const issue of [...result.errors, ...result.warnings]) {
    assert.equal(typeof issue.code, 'string');
    assert.ok(issue.message.length > 12 && /[a-záéíóú]/.test(issue.message), 'mensaje legible');
    assert.ok(issue.nodeId === undefined || messy.nodes.some(n => n.id === issue.nodeId));
  }
  const grouped = issuesByNode(result);
  assert.equal(grouped.byNode.get('b').errors.length, 2);
  assert.equal(grouped.byNode.get('b').errors[0].field, 'text', 'el panel sabe en qué campo mostrarlo');
  assert.ok(grouped.byNode.get('d').errors.some(i => i.code === 'loop'));
  assert.ok(grouped.byNode.get('x').warnings.some(i => i.code === 'unreachable'));
  assert.deepEqual(grouped.general, { errors: [], warnings: [] });
  assert.equal(
    issuesByNode(validateGraph(G([N('s', 'start')]))).general.errors.length,
    1,
    'lo que no es de un paso va aparte',
  );
});

// ---- Reparación y forma canónica -------------------------------------------------------------------------------------

test('reparación: abre cualquier cosa y deja un grafo con estructura válida, diciendo qué corrigió', () => {
  const broken = {
    v: 1,
    start: 'zz',
    nodes: [
      null,
      { id: 'Mal Id', type: 'message', x: 10.6, y: 'abajo', data: 'x' },
      { id: 'a', type: 'buttons', data: { options: [{ id: 'si', label: 'Sí', do: goto }] } },
      { id: 'a', type: 'message', data: say('Repetido') },
      { id: 'n', type: 'note', data: { text: 'Idea' } },
      { id: 'u', type: 'teletransporte', data: { lo: 'que sea' } },
    ],
    edges: [
      { from: 'Mal Id', port: 'next', to: 'a' },
      { from: 'a', port: 'opt:si', to: 'Mal Id' },
      { from: 'a', port: 'opt:si', to: 'n' },
      { from: 'a', port: 'opt:no', to: 'a' },
      { from: 'a', port: 'default', to: 'n' },
      { from: 'a', port: 'timeout', to: 'fantasma' },
      { from: 'u', port: 'next', to: 'a' },
      null,
    ],
    variables: [{ name: 'correo' }, { name: 'correo' }, { name: 'MAL' }, 5],
  };
  const { graph, repairs } = repairGraph(broken);
  assert.deepEqual(checkStructure(graph), []);
  assert.equal(graph.nodes.filter(n => n.type === 'start').length, 1, 'se agrega el Inicio que faltaba');
  assert.equal(graph.start, graph.nodes.find(n => n.type === 'start').id);
  assert.equal(new Set(graph.nodes.map(n => n.id)).size, graph.nodes.length);
  const renamed = graph.nodes.find(n => n.type === 'message' && n.data.parts.length === 0);
  assert.deepEqual([renamed.x, renamed.y], [11, 0], 'las posiciones quedan enteras');
  // El id inválido pero único conserva sus conexiones con su id nuevo; del repetido, son del primero.
  assert.deepEqual(graph.edges, [
    { from: renamed.id, port: 'next', to: 'a' },
    { from: 'a', port: 'opt:si', to: renamed.id },
  ]);
  assert.deepEqual(graph.variables, [{ name: 'correo', label: '', type: 'text' }]);
  assert.ok(
    repairs.some(r => /Inicio que faltaba/.test(r)) &&
      repairs.some(r => /conexiones/.test(r)) &&
      repairs.some(r => /identificador/.test(r)) &&
      repairs.some(r => /variable/.test(r)),
  );
  assert.equal(
    graph.nodes.find(n => n.id === 'u').type,
    'teletransporte',
    'un tipo desconocido se conserva para que la persona lo vea y lo quite',
  );
  assert.deepEqual(normalizeGraph(graph), graph, 'normalizar es idempotente');
  assert.deepEqual(repairGraph(graph).repairs, []);

  const twoStarts = repairGraph({
    v: 1,
    start: 'b',
    nodes: [N('a', 'start'), N('b', 'start'), N('m', 'message', say('Hola'))],
    edges: [E('a', 'next', 'm'), E('b', 'next', 'm')],
  });
  assert.deepEqual(
    twoStarts.graph.nodes.map(n => n.id),
    ['b', 'm'],
    'se conserva el Inicio al que apuntaba `start`',
  );
  assert.deepEqual(twoStarts.graph.edges, [E('b', 'next', 'm')]);
  for (const junk of [null, undefined, 'x', 5, [], {}]) assert.deepEqual(checkStructure(normalizeGraph(junk)), []);
  assert.deepEqual(checkStructure(emptyGraph()), []);
  assert.deepEqual(normalizeGraph(emptyGraph()), emptyGraph());
  assert.ok(checkStructure({ ...emptyGraph(), start: 'otro' }).length > 0);
  assert.ok(checkStructure(G([N('s', 'start'), N('m', 'message', { parts: 'x' })])).some(v => /canónicos/.test(v)));
});

test('identificadores: el menor libre, sin azar', () => {
  assert.equal(nextId(new Set()), 'n1');
  assert.equal(nextId(new Set(['n1', 'n2', 'n4'])), 'n3');
  assert.equal(nextId(new Set(['o1']), 'o'), 'o2');
  assert.deepEqual(createNode('delay', { id: 'n7', x: 10.4, y: 20.6 }), {
    id: 'n7',
    type: 'delay',
    x: 10,
    y: 21,
    data: { seconds: 3 },
  });
  assert.equal(createNode('message', { id: 'n1', title: 'Saludo' }).title, 'Saludo');
});

// ---- Geometría y acomodo ---------------------------------------------------------------------------------------------

test('geometría: tamaño de la tarjeta según sus salidas, y dónde quedan', () => {
  const message = createNode('message', { id: 'a', x: 100, y: 50 });
  assert.deepEqual(nodeSize(message), {
    w: GEOMETRY.width,
    h: GEOMETRY.head + GEOMETRY.body + GEOMETRY.port + GEOMETRY.foot,
  });
  const end = createNode('end', { id: 'b', x: 500, y: 50 });
  assert.equal(nodeSize(end).h, GEOMETRY.head + GEOMETRY.body + GEOMETRY.foot);
  const three = createNode('buttons', { id: 'c', data: buttons(['Uno', 'Dos', 'Tres']) });
  assert.equal(
    nodeSize(three).h,
    GEOMETRY.head + GEOMETRY.body + 5 * GEOMETRY.port + GEOMETRY.foot,
    'tres opciones, «si no elige» y «sin respuesta»',
  );
  assert.ok(nodeSize(createNode('note', { id: 'd' })).h > nodeSize(end).h, 'una nota tiene más sitio para su texto');
  assert.deepEqual(portPoint(message, 'next'), {
    x: 100 + GEOMETRY.width,
    y: 50 + GEOMETRY.head + GEOMETRY.body + GEOMETRY.port / 2,
  });
  assert.equal(portPoint(three, 'opt:o2').y - portPoint(three, 'opt:o1').y, GEOMETRY.port);
  assert.equal(portPoint(message, 'nada'), null);
  assert.deepEqual(inputPoint(end), { x: 500, y: 50 + GEOMETRY.head / 2 });
  assert.match(edgePath(portPoint(message, 'next'), inputPoint(end)), /^M 340 150 C \d+ 150, \d+ 72, 500 72$/);
  assert.deepEqual(boundsOf([message, end]), { x: 100, y: 50, w: 400 + GEOMETRY.width, h: nodeSize(message).h });
  assert.deepEqual(boundsOf([]), { x: 0, y: 0, w: 0, h: 0 });
});

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function assertTidy(graph) {
  const { positions } = layout(graph);
  const boxes = graph.nodes.map(n => ({ id: n.id, ...positions[n.id], ...nodeSize(n) }));
  for (const box of boxes) {
    assert.ok(Number.isInteger(box.x) && Number.isInteger(box.y), `${box.id}: coordenadas enteras`);
    assert.equal(box.y % GEOMETRY.grid, 0, `${box.id}: sobre la rejilla`);
    assert.ok(box.x >= 0 && box.y >= 0);
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let k = i + 1; k < boxes.length; k += 1)
      assert.ok(!overlaps(boxes[i], boxes[k]), `${boxes[i].id} y ${boxes[k].id} no se enciman`);
  }
  return positions;
}

test('acomodo: por capas desde el Inicio, sin encimar, determinista y sin depender del orden de los arreglos', () => {
  const graph = normalizeGraph(templateByKey('inscripcion').graph);
  const positions = assertTidy(graph);
  assert.deepEqual(layout(graph), layout(graph), 'la misma entrada da la misma salida');
  assert.deepEqual(layout(JSON.parse(JSON.stringify(graph))).positions, positions);
  // Toda conexión avanza hacia la derecha: la capa de un paso es su distancia más larga desde el Inicio.
  for (const e of graph.edges) assert.ok(positions[e.to].x > positions[e.from].x, `${e.from} → ${e.to} avanza`);
  // La primera salida sigue en línea recta; la segunda cuelga debajo.
  assert.equal(positions.a.y, positions.b.y);
  assert.equal(positions.b.y, positions.c.y);
  assert.equal(positions.c.y, positions.h.y, '«con enlace de pago» es la primera salida de la inscripción');
  assert.ok(positions.d.y > positions.h.y, '«pago manual» queda debajo');
  assert.equal(positions.d.x, positions.h.x);

  const rnd = random(2026);
  for (let i = 0; i < 25; i += 1) {
    const mixed = { ...graph, nodes: shuffled(graph.nodes, rnd), edges: shuffled(graph.edges, rnd) };
    assert.deepEqual(layout(mixed).positions, positions, 'barajar nodos y conexiones no cambia el acomodo');
  }
  // Tampoco importa dónde estaban antes: «Acomodar» dos veces deja todo igual.
  const moved = applyLayout(
    graph,
    Object.fromEntries(graph.nodes.map(n => [n.id, { x: Math.floor(rnd() * 900), y: Math.floor(rnd() * 900) }])),
  );
  assert.deepEqual(layout(moved).positions, positions);
  const applied = applyLayout(graph, positions);
  assert.deepEqual(layout(applied).positions, positions);
  assert.notEqual(applied, graph, 'devuelve una copia');
  assert.deepEqual(applyLayout(graph, {}), graph);
});

test('acomodo: ciclos, ramas que se juntan, pasos sueltos y notas', () => {
  const cyclic = normalizeGraph(
    G(
      [
        N('s', 'start'),
        N('b', 'buttons', buttons(['Sí', 'No', 'Quizá'])),
        N('m1', 'message', say('Uno')),
        N('m2', 'message', say('Dos')),
        N('m3', 'message', say('Tres')),
        N('q', 'question', { text: '¿?', saveTo: { kind: 'var', name: 'x' } }),
        N('e', 'end'),
        N('x', 'message', say('Suelto')),
        N('n', 'note', { text: 'Nota' }),
        N('y', 'delay'),
      ],
      [
        E('s', 'next', 'b'),
        E('b', 'opt:o1', 'm1'),
        E('b', 'opt:o2', 'm2'),
        E('b', 'opt:o3', 'm3'),
        E('m1', 'next', 'q'),
        E('m2', 'next', 'q'),
        E('m3', 'next', 'e'),
        E('q', 'next', 'e'),
        E('q', 'invalid', 'b'),
        E('x', 'next', 'y'),
      ],
    ),
  );
  const positions = assertTidy(cyclic);
  const column = id => positions[id].x;
  assert.ok(
    column('s') < column('b') && column('b') < column('m1') && column('m1') < column('q') && column('q') < column('e'),
  );
  assert.equal(column('m1'), column('m2'));
  assert.equal(column('m2'), column('m3'));
  assert.ok(
    positions.m1.y < positions.m2.y && positions.m2.y < positions.m3.y,
    'las ramas quedan en el orden de sus salidas',
  );
  // Lo que no se alcanza desde el Inicio queda abajo, ordenado por id y con las notas al final.
  const reached = reachable(cyclic);
  const bottom = Math.max(...cyclic.nodes.filter(n => reached.has(n.id)).map(n => positions[n.id].y + nodeSize(n).h));
  for (const id of ['x', 'y', 'n']) assert.ok(positions[id].y >= bottom, `${id} queda debajo del recorrido`);
  assert.ok(positions.x.x < positions.y.x && positions.y.x < positions.n.x);
  assert.deepEqual(layout(emptyGraph()).positions, { n1: { x: 40, y: 40 } });
  assert.deepEqual(layout(emptyGraph(), { x: 100, y: 200 }).positions, { n1: { x: 100, y: 200 } });

  // Grafos al azar: nunca se enciman y siempre da lo mismo.
  const rnd = random(99);
  const types = ['message', 'buttons', 'delay', 'question', 'condition', 'end', 'note', 'enroll'];
  for (let round = 0; round < 40; round += 1) {
    const nodes = [createNode('start', { id: 'n1' })];
    for (let i = 2; i <= 3 + Math.floor(rnd() * 25); i += 1)
      nodes.push(createNode(types[Math.floor(rnd() * types.length)], { id: 'n' + i }));
    const edges = [];
    for (const from of nodes)
      for (const p of portsOf(from))
        if (rnd() < 0.7) edges.push(E(from.id, p.id, nodes[Math.floor(rnd() * nodes.length)].id));
    const graph = normalizeGraph({ v: 1, start: 'n1', nodes, edges, variables: [] });
    const first = assertTidy(graph);
    assert.deepEqual(
      layout({ ...graph, nodes: shuffled(graph.nodes, rnd), edges: shuffled(graph.edges, rnd) }).positions,
      first,
    );
  }
});

// ---- Orden de lectura, resumen y descripciones -----------------------------------------------------------------------

test('orden de lectura: desde el Inicio por las salidas en su orden; después los sueltos y al final las notas', () => {
  const graph = normalizeGraph(
    G(
      [
        N('n', 'note', { text: 'Nota' }, { y: 0 }),
        N('x', 'message', say('Suelto')),
        N('m2', 'message', say('Dos')),
        N('b', 'buttons', buttons(['Uno', 'Dos'])),
        N('m1', 'message', say('Uno')),
        N('s', 'start'),
      ],
      [E('b', 'opt:o2', 'm2'), E('s', 'next', 'b'), E('b', 'opt:o1', 'm1'), E('m1', 'next', 'b')],
    ),
  );
  assert.deepEqual(readingOrder(graph), ['s', 'b', 'm1', 'm2', 'x', 'n']);
  assert.deepEqual([...reachable(graph)].sort(), ['b', 'm1', 'm2', 's']);
  assert.deepEqual(readingOrder({ ...graph, edges: [...graph.edges].reverse(), nodes: [...graph.nodes].reverse() }), [
    's',
    'b',
    'm1',
    'm2',
    'x',
    'n',
  ]);
});

test('resumen para las listas: cuántos pasos, dónde espera a la persona y qué datos usa', () => {
  const venta = summarize(templateByKey('venta_de_curso').graph);
  assert.equal(venta.nodes, 11);
  assert.equal(venta.edges, 10);
  assert.equal(venta.notes, 0);
  assert.deepEqual(venta.byGroup, { logica: 5, catalogo: 2, mensajes: 3, atencion: 1 });
  assert.equal(venta.byType.delay, 2);
  // Puntos de entrada: donde el recorrido espera a la persona, en orden de lectura.
  assert.deepEqual(
    venta.entryPoints.map(p => [p.id, p.type]),
    [
      ['c', 'choose_course'],
      ['b', 'buttons'],
    ],
  );
  assert.equal(venta.entryPoints[1].label, 'Invitación a inscribirse');
  assert.deepEqual(venta.firstSpeaker, { id: 'c', type: 'choose_course', label: '¿Qué curso te interesa?' });
  assert.deepEqual(venta.endings.map(p => p.id).sort(), ['e', 'g', 'h']);
  assert.deepEqual(venta.tokens, ['curso', 'nombre']);
  assert.deepEqual(venta.slots, ['presentacion', 'temario_imagen']);
  assert.deepEqual(venta.references, { flows: ['tpl:inscripcion'] });
  assert.equal(venta.speaks, true);
  assert.ok(venta.bytes > 500 && venta.bytes < LIMITS.bytes);

  const withVars = summarize(
    G(
      [
        N('s', 'start'),
        N('q', 'question', { text: '¿Tu ciudad?', saveTo: { kind: 'var', name: 'ciudad' } }),
        N('b', 'buttons', buttons(['Mañana', 'Tarde'], { saveAs: 'turno' })),
        N('m', 'message', say('Vives en {{var.ciudad}}, {{nombre}}; folio {{var.folio}} y dato {{contacto.empresa}}.')),
        N('c', 'condition', {
          cases: [
            {
              id: 'c1',
              label: 'Mañana',
              when: {
                mode: 'all',
                groups: [{ mode: 'all', items: [{ f: 'attr', key: 'var.turno', op: 'eq', value: 'Mañana' }] }],
              },
            },
          ],
        }),
        N('n', 'note', { text: 'Las notas no cuentan: {{var.nada}}' }),
      ],
      [E('s', 'next', 'q'), E('q', 'next', 'b'), E('b', 'opt:o1', 'm'), E('m', 'next', 'c')],
      [{ name: 'idioma', label: 'Idioma', type: 'text' }],
    ),
  );
  assert.deepEqual(withVars.variables, {
    declared: ['idioma'],
    saved: ['ciudad', 'turno'],
    used: ['ciudad', 'folio', 'turno'],
    unknown: ['folio'],
  });
  assert.deepEqual(withVars.tokens, ['contacto.empresa', 'nombre']);
  assert.equal(withVars.nodes, 5);
  assert.equal(withVars.notes, 1);
  assert.deepEqual(summarize(null).nodes, 1, 'de cualquier cosa sale un resumen: la reparación agrega el Inicio');
});

test('descripción de un paso para lectores de pantalla, y nombre con el que se le menciona', () => {
  const graph = templateByKey('venta_de_curso').graph;
  assert.equal(describeNode(graph, 's'), 'Paso 1 de 11, Inicio. Salidas: Sigue, hacia «¿Qué curso te interesa?».');
  assert.equal(
    describeNode(graph, 'b'),
    'Paso 8 de 11, «Invitación a inscribirse», Botones: ¿Te gustaría conocer el proceso de inscripción? Salidas: Sí, me interesa, hacia «Inscripción»; Si no elige, sin conectar; Sin respuesta, hacia «Fin».',
  );
  assert.equal(describeNode(graph, 'e'), 'Paso 10 de 11, Fin: Termina el recorrido. Aquí termina el recorrido.');
  assert.equal(describeNode(graph, 'nada'), '');
  const byId = id => graph.nodes.find(n => n.id === id);
  assert.equal(nodeName(byId('m1')), 'Saludo y presentación', 'el título manda');
  assert.equal(nodeName(byId('f')), 'Ficha del curso', 'sin título, un paso de catálogo se llama como su tipo');
  assert.equal(
    nodeName(N('x', 'message', say('Hola, ¿cómo estás?'))),
    'Hola, ¿cómo estás?',
    'un paso que escribe se llama como su texto',
  );
  assert.equal(nodeName(N('x', 'message', say(''))), 'Mensaje');
  assert.equal(nodeName(N('x', 'message', say('a'.repeat(200)))).length, 60);
  assert.equal(nodeName(N('x', 'nada')), 'Paso desconocido');
  const ctx = { tags: [{ id: 'vip', name: 'VIP' }], materials: [{ id: 'm1', name: 'Precio promocional' }] };
  assert.equal(typeOf('tags').summary({ add: ['vip'], remove: [] }, ctx), 'Pone: VIP');
  assert.equal(typeOf('price').summary({ body: 'data', templateId: 'm1' }, ctx), 'Material: Precio promocional');
  assert.equal(typeOf('delay').summary({ seconds: 1 }), '1 segundo');
});

test('datos en los textos y comparación de opciones: igual que el servidor', () => {
  assert.deepEqual(
    tokensIn(
      'Hola, {{ Nombre }}: {{curso|el curso}} {{contacto.ciudad}} {{var.folio}} {{asesor}} {{contacto.x y}}',
    ).map(t => [t.name, t.kind, t.fallback]),
    [
      ['nombre', 'base', null],
      ['curso', 'base', 'el curso'],
      ['contacto.ciudad', 'contact', null],
      ['var.folio', 'var', null],
      ['asesor', 'unknown', null],
      ['contacto.x y', 'unknown', null],
    ],
  );
  assert.equal(tokensIn('{{EDICIÓN}}')[0].name, 'edicion', 'con o sin acento');
  assert.deepEqual(tokensIn(null), []);
  // La misma normalización del flujo de bienvenida: si difiere, el servidor no reconocería un botón que el editor aceptó.
  for (const sample of [
    '  ¡Más OPCIONES! ',
    'Fechas y horario',
    'fechas   y  horario.',
    'Sí, me interesa',
    'ÑANDÚ & café',
    '1) Precio',
    '',
    null,
    'Inscripción — 2026',
  ]) {
    assert.equal(norm(sample), welcomeNorm(sample), JSON.stringify(sample));
  }
  assert.equal(norm('Sí, me interesa'), 'si me interesa');
  assert.deepEqual(
    Object.keys(
      typeOf('buttons')
        .fields.find(f => f.key === 'options')
        .fields.find(f => f.key === 'do.intent')
        .options.reduce((o, [id]) => ({ ...o, [id]: 1 }), {}),
    ),
    Object.keys(ACTIONS),
  );
});

test('formato propio de una pregunta: una repetición dentro de otra se rechaza; una repetición exacta no', () => {
  for (const pattern of ['(a+)+', '(a*)*', '(.+)*', '(a|b+)+', '((ab)+c)*', '(a{1,})+', '(\\d+)*x', '(?:a+){2,}']) {
    assert.equal(hasNestedQuantifier(pattern), true, pattern);
  }
  for (const pattern of [
    'a+b*',
    '(ab)+',
    '(a|b)*',
    '(\\d{2}-){2}\\d{4}',
    '[(+*)]+',
    '\\(a+\\)+',
    '(a+)(b+)',
    '(a+)?',
    '^[A-Z]{4}\\d{6}[A-Z0-9]{3}$',
    '',
  ]) {
    assert.equal(hasNestedQuantifier(pattern), false, pattern);
  }
});

// ---- Ajustes ---------------------------------------------------------------------------------------------------------

test('ajustes del recorrido: valores de fábrica, forma canónica y sus límites', () => {
  assert.deepEqual(normalizeSettings(undefined), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  assert.deepEqual(
    normalizeSettings({
      timeoutMinutes: '30',
      onUnexpected: 'raro',
      channels: ['instagram', 'telegram'],
      reentry: { cooldownMinutes: 90 },
      reminder: { afterMinutes: 10, text: '¿Sigues ahí?' },
      courseOverrides: { c1: 'f9', c2: '' },
    }),
    {
      ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      timeoutMinutes: 30,
      channels: ['instagram'],
      reentry: { cooldownMinutes: 90 },
      reminder: { afterMinutes: 10, text: '¿Sigues ahí?' },
      courseOverrides: { c1: 'f9' },
    },
  );
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), []);
  const problems = input => validateSettings(input).map(p => p.field);
  assert.deepEqual(problems({ timeoutMinutes: 4 }), ['timeoutMinutes']);
  assert.deepEqual(problems({ timeoutMinutes: 1441 }), ['timeoutMinutes']);
  assert.deepEqual(problems({ maxMisses: 4 }), ['maxMisses']);
  assert.deepEqual(problems({ onUnexpected: 'repeat' }), ['fallbackText']);
  assert.deepEqual(problems({ onUnexpected: 'repeat', fallbackText: 'Elige una de las opciones, por favor.' }), []);
  assert.deepEqual(problems({ reminder: { afterMinutes: 2000, text: 'Hola' } }), ['reminder.afterMinutes']);
  assert.deepEqual(problems({ reminder: { afterMinutes: 60, text: '' } }), ['reminder.text']);
  assert.deepEqual(problems({ exitText: 'Te quedan 500 pesos de descuento' }), ['exitText']);
  assert.deepEqual(problems({ reentry: { cooldownMinutes: 0 } }), ['reentry.cooldownMinutes']);
  assert.equal(validateSettings({ courseOverrides: { c1: 'este' } }, { flowId: 'este' })[0].code, 'settings');
  assert.deepEqual(
    validateSettings(
      { courseOverrides: { c1: 'f1' } },
      { flowId: 'este', flows: [{ id: 'f1' }], courses: [{ id: 'c1' }] },
    ),
    [],
  );
});

// ---- Conversión del flujo de bienvenida ------------------------------------------------------------------------------

test('conversión del flujo de bienvenida: cada paso con botones es un paso «Botones» con las mismas opciones', () => {
  const { graph, settings, rule } = fromWelcomeFlow({ steps: DEFAULT_STEPS, withFlyer: true });
  assert.deepEqual(checkStructure(graph), []);
  clean(validateGraph(graph, { settings }));
  assert.deepEqual(
    graph.nodes.map(n => [n.id, n.type]),
    [
      ['start', 'start'],
      ['inicio', 'buttons'],
      ['mas', 'buttons'],
    ],
  );
  const [, first, more] = graph.nodes;
  assert.equal(first.data.text, DEFAULT_STEPS[0].text);
  assert.deepEqual(first.data.header, { kind: 'course_flyer' }, '«enviar la ficha del curso con el saludo»');
  assert.deepEqual(more.data.header, { kind: 'none' });
  assert.deepEqual(first.data.options, [
    { id: 'o1', label: 'Precio', do: { type: 'intent', intent: 'price', stay: true } },
    { id: 'o2', label: 'Temario', do: { type: 'intent', intent: 'syllabus', stay: true } },
    { id: 'o3', label: 'Más opciones', do: { type: 'goto' } },
  ]);
  // Precio, temario y fechas dejan el menú a la vista; inscribirse y pasar con una persona terminan el recorrido.
  assert.deepEqual(
    more.data.options.map(o => [o.label, o.do.intent, o.do.stay]),
    [
      ['Fechas y horario', 'schedule', true],
      ['Inscribirme', 'enroll', false],
      ['Hablar con asesor', 'human', false],
    ],
  );
  assert.deepEqual(graph.edges, [E('start', 'next', 'inicio'), E('inicio', 'opt:o3', 'mas')]);
  // Los mismos textos y botones, en el mismo orden, que el flujo original.
  for (const step of DEFAULT_STEPS) {
    const node = graph.nodes.find(n => n.id === step.id);
    assert.equal(node.data.text, step.text);
    assert.deepEqual(
      node.data.options.map(o => o.label),
      step.buttons.map(b => b.label),
    );
  }
  assert.deepEqual(
    {
      timeoutMinutes: settings.timeoutMinutes,
      onUnexpected: settings.onUnexpected,
      maxMisses: settings.maxMisses,
      reofferOnDetour: settings.reofferOnDetour,
    },
    { timeoutMinutes: 1440, onUnexpected: 'assistant', maxMisses: 2, reofferOnDetour: false },
  );
  assert.equal(rule.trigger.type, 'chat_started');
  assert.deepEqual(rule.actions, [
    { type: 'start_flow', flowId: null, course: 'keep', firstMessage: 'answer_and_menu' },
  ]);
  assert.deepEqual(
    layout(graph).positions,
    Object.fromEntries(graph.nodes.map(n => [n.id, { x: n.x, y: n.y }])),
    'sale ya acomodado',
  );
});

test('conversión del flujo de bienvenida: pasos sin botones, sin ficha y casos límite', () => {
  const steps = [
    { id: 'hola', text: 'Hola, {{nombre}}.', buttons: [] },
    {
      id: 'start',
      text: 'Segundo',
      buttons: [
        { label: 'Volver', go: 'step:hola' },
        { label: 'Roto', go: 'step:nadie' },
        { label: 'Raro', go: 'action:borrar' },
      ],
    },
  ];
  const flyer = fromWelcomeFlow({ steps, withFlyer: true }).graph;
  assert.deepEqual(checkStructure(flyer), []);
  // Un paso sin botones es un mensaje; si era el saludo y llevaba la ficha, es la ficha del curso con ese texto.
  assert.deepEqual(flyer.nodes.find(n => n.id === 'hola').data, { text: 'Hola, {{nombre}}.', flyer: true });
  assert.equal(flyer.nodes.find(n => n.id === 'hola').type, 'course_card');
  assert.notEqual(flyer.start, 'start', 'el Inicio toma un id que no choque con un paso llamado «start»');
  assert.equal(flyer.nodes.find(n => n.id === flyer.start).type, 'start');
  const second = flyer.nodes.find(n => n.id === 'start');
  assert.deepEqual(
    second.data.options.map(o => o.do),
    [
      { type: 'goto' },
      { type: 'intent', intent: 'human', stay: false },
      { type: 'intent', intent: 'human', stay: false },
    ],
    'un destino que ya no existe pasa con una persona en lugar de perderse',
  );
  assert.deepEqual(flyer.edges, [E(flyer.start, 'next', 'hola'), E('start', 'opt:o1', 'hola')]);

  const plain = fromWelcomeFlow({ steps, withFlyer: false }).graph;
  assert.equal(plain.nodes.find(n => n.id === 'hola').type, 'message');
  assert.deepEqual(plain.nodes.find(n => n.id === 'hola').data, say('Hola, {{nombre}}.'));
  const noFlyer = fromWelcomeFlow({ steps: DEFAULT_STEPS, withFlyer: false }).graph;
  assert.deepEqual(noFlyer.nodes[1].data.header, { kind: 'none' });
  for (const empty of [undefined, {}, { steps: [] }, { steps: 'x' }, { steps: [null, { id: 'MAL' }] }]) {
    assert.deepEqual(
      fromWelcomeFlow(empty).graph.nodes.map(n => n.type),
      ['start'],
    );
  }
});

// ---- Importar y exportar ---------------------------------------------------------------------------------------------

test('exportar e importar: ida y vuelta sin pérdida, con número de versión', () => {
  for (const tpl of FLOW_TEMPLATES) {
    const file = exportFlow({ name: tpl.name, description: tpl.description, graph: tpl.graph, settings: tpl.settings });
    assert.equal(file.format, EXPORT_FORMAT);
    assert.equal(file.version, EXPORT_VERSION);
    assert.equal(file.graph.v, 1);
    const back = importFlow(JSON.stringify(file));
    assert.deepEqual(back.graph, JSON.parse(JSON.stringify(tpl.graph)), tpl.key);
    assert.deepEqual(back.settings, JSON.parse(JSON.stringify(tpl.settings)));
    assert.equal(back.name, tpl.name);
    assert.equal(back.description, tpl.description);
    assert.deepEqual(back.repairs, []);
    assert.deepEqual(back.unresolved, []);
    // Importar lo exportado y volver a exportar da el mismo archivo.
    assert.equal(
      exportJson(back),
      exportJson({ name: tpl.name, description: tpl.description, graph: tpl.graph, settings: tpl.settings }),
    );
    assert.deepEqual(importFlow(file).graph, back.graph, 'acepta el objeto o su texto');
  }
});

test('importar: resuelve las referencias por nombre en la marca de destino y devuelve las que no encontró', () => {
  const origin = {
    materials: [{ id: 'mat-a', name: 'Precio promocional', status: 'approved' }],
    tags: [
      { id: 'tag-a', name: 'Interesado' },
      { id: 'tag-b', name: 'Sólo aquí' },
    ],
    flows: [{ id: 'flow-a', name: 'Inscripción', published: true }],
  };
  const graph = G(
    [
      N('s', 'start'),
      N('p', 'price', { templateId: 'mat-a' }),
      N('t', 'tags', { add: ['tag-a', 'tag-b'] }),
      N('q', 'question', { text: '¿Empresa?', saveTo: { kind: 'attribute', key: 'empresa' } }),
      N('g', 'goto_flow', { flowId: 'flow-a' }),
    ],
    [E('s', 'next', 'p'), E('p', 'next', 't'), E('t', 'next', 'q'), E('q', 'next', 'g')],
  );
  const file = exportFlow({ name: 'Venta', graph }, origin);
  assert.deepEqual(file.references, [
    { source: 'materials', id: 'mat-a', name: 'Precio promocional' },
    { source: 'tags', id: 'tag-a', name: 'Interesado' },
    { source: 'tags', id: 'tag-b', name: 'Sólo aquí' },
    { source: 'flows', id: 'flow-a', name: 'Inscripción' },
  ]);
  // En la misma marca, todo sigue igual.
  assert.deepEqual(importFlow(file, origin).graph, normalizeGraph(graph));
  assert.deepEqual(importFlow(file, origin).unresolved, []);
  // Sin las listas de la marca no se puede saber: se deja como viene.
  assert.deepEqual(importFlow(file).graph, normalizeGraph(graph));

  const target = {
    materials: [{ id: 'mat-z', name: 'precio  PROMOCIONAL', status: 'approved' }],
    tags: [{ id: 'tag-z', name: 'interesado' }],
    flows: [],
    attributes: [],
  };
  const imported = importFlow(JSON.stringify(file), target);
  const data = id => imported.graph.nodes.find(n => n.id === id).data;
  assert.equal(data('p').templateId, 'mat-z', 'el material se encontró por su nombre');
  assert.deepEqual(data('t').add, ['tag-z'], 'la etiqueta que no existe se quita');
  assert.equal(data('g').flowId, '', 'el recorrido que no existe queda vacío para elegirlo');
  assert.equal(data('q').saveTo.key, 'empresa', 'un dato del contacto se identifica por su clave: se conserva');
  assert.deepEqual(imported.unresolved, [
    { source: 'tags', id: 'tag-b', name: 'Sólo aquí', nodeIds: ['t'] },
    { source: 'attributes', id: 'empresa', name: '', nodeIds: ['q'] },
    { source: 'flows', id: 'flow-a', name: 'Inscripción', nodeIds: ['g'] },
  ]);
  assert.deepEqual(checkStructure(imported.graph), []);
  // Lo que quedó vacío lo señala la validación en su paso.
  assert.ok(
    validateGraph(imported.graph, target).errors.some(i => i.nodeId === 'g' && /Elige el recorrido/.test(i.message)),
  );
});

test('importar: rechaza lo que no es un recorrido, con un mensaje claro', () => {
  const file = exportFlow({ name: 'Base', graph: base() });
  assert.throws(() => importFlow('{mal'), /no es un JSON válido/);
  assert.throws(() => importFlow('[]'), /no es un recorrido exportado/);
  assert.throws(() => importFlow({ ...file, format: 'chatbot' }), /no es un recorrido exportado/);
  assert.throws(() => importFlow({ ...file, version: EXPORT_VERSION + 1 }), /versión más nueva/);
  assert.throws(() => importFlow({ ...file, version: 'uno' }), /de qué versión/);
  assert.throws(() => importFlow({ ...file, graph: null }), /no trae el recorrido/);
  assert.throws(() => importFlow({ ...file, graph: { ...file.graph, v: 9 } }), /versión que la aplicación no entiende/);
  assert.throws(() => importFlow('"' + 'a'.repeat(LIMITS.bytes * 2) + '"'), /demasiado grande/);
  try {
    importFlow('{mal');
  } catch (error) {
    assert.equal(error.status, 400, 'el servidor puede responder 400 con ese mismo mensaje');
    assert.equal(error.code, 'flow_import');
  }
  // Un archivo dañado se repara y lo dice.
  const damaged = importFlow({
    ...file,
    graph: { ...file.graph, edges: [...file.graph.edges, E('m', 'timeout', 'e')] },
  });
  assert.deepEqual(damaged.graph, normalizeGraph(base()));
  assert.equal(damaged.repairs.length, 1);
});

// ---- Plantillas ------------------------------------------------------------------------------------------------------

test('plantillas de la biblioteca: las tres validan, vienen acomodadas y no se pueden alterar', () => {
  assert.deepEqual(
    FLOW_TEMPLATES.map(t => [t.key, t.name]),
    [
      ['venta_de_curso', 'Venta de curso'],
      ['inscripcion', 'Inscripción'],
      ['bienvenida_con_menu', 'Bienvenida con menú'],
    ],
  );
  for (const tpl of FLOW_TEMPLATES) {
    assert.deepEqual(checkStructure(tpl.graph), [], tpl.key);
    clean(validateGraph(tpl.graph, { settings: tpl.settings }));
    assert.deepEqual(validateSettings(tpl.settings), [], tpl.key);
    assert.deepEqual(normalizeGraph(tpl.graph), JSON.parse(JSON.stringify(tpl.graph)), `${tpl.key}: ya es canónica`);
    assert.deepEqual(
      layout(tpl.graph).positions,
      Object.fromEntries(tpl.graph.nodes.map(n => [n.id, { x: n.x, y: n.y }])),
      `${tpl.key}: acomodada`,
    );
    assert.ok(tpl.description.length > 40);
    assert.ok(
      Object.isFrozen(tpl) && Object.isFrozen(tpl.graph.nodes[0].data),
      `${tpl.key}: los datos de la biblioteca no se pueden alterar`,
    );
    for (const rule of tpl.rules) assert.equal(rule.definition.v, 1);
    // Ninguna plantilla escribe precios, fechas ni cupos: eso sale del catálogo al enviar.
    assert.doesNotMatch(JSON.stringify(tpl.graph), /\$\s?\d|\d+\s?(pesos|mxn|usd)/i);
  }
  assert.equal(templateByKey('nada'), null);
  assert.equal(instantiateTemplate('nada'), null);
});

test('plantilla «Venta de curso»: un recorrido para todos los cursos, como lo describe el diseño', () => {
  const { graph } = templateByKey('venta_de_curso');
  assert.deepEqual(
    readingOrder(graph).map(id => graph.nodes.find(n => n.id === id).type),
    [
      'start',
      'choose_course',
      'message',
      'delay',
      'course_card',
      'message',
      'delay',
      'buttons',
      'goto_flow',
      'end',
      'handoff',
    ],
  );
  const by = id => graph.nodes.find(n => n.id === id).data;
  assert.deepEqual(
    by('c'),
    { skipIfKnown: true, useMessage: true, attempts: 2 },
    'si llegó por anuncio o ya nombró el curso, pasa de largo',
  );
  assert.deepEqual(by('m1').parts, [
    { kind: 'text', text: 'Hola, {{nombre}}. Gracias por tu interés en {{curso}}.' },
    { kind: 'slot', slot: 'presentacion', ifMissing: 'skip' },
  ]);
  assert.deepEqual(
    by('m2').parts,
    [{ kind: 'slot', slot: 'temario_imagen', ifMissing: 'skip' }],
    'sólo si el curso tiene esa pieza aprobada',
  );
  assert.deepEqual([by('d1').seconds, by('d2').seconds], [3, 3]);
  assert.equal(by('b').text, '¿Te gustaría conocer el proceso de inscripción?');
  assert.deepEqual(by('b').options, [
    { id: 'si', label: 'Sí, me interesa', do: { type: 'goto' } },
    { id: 'temario', label: 'Ver el temario', do: { type: 'intent', intent: 'syllabus', stay: true } },
  ]);
  const out = (from, port) => graph.edges.find(e => e.from === from && e.port === port)?.to;
  assert.equal(graph.nodes.find(n => n.id === out('b', 'opt:si')).type, 'goto_flow');
  assert.equal(graph.nodes.find(n => n.id === out('b', 'timeout')).type, 'end', '24 horas sin respuesta: fin');
  assert.equal(out('b', 'default'), undefined, 'si escribe otra cosa, contesta el asistente');
  // Ningún paso lleva el nombre ni los datos de un curso: lo que varía está en el catálogo.
  assert.deepEqual(summarize(graph).references, { flows: ['tpl:inscripcion'] });
});

test('plantilla «Inscripción»: el grafo del Apéndice B', () => {
  const { graph } = templateByKey('inscripcion');
  assert.deepEqual(
    graph.nodes.map(n => [n.id, n.type]),
    [
      ['a', 'start'],
      ['b', 'price'],
      ['c', 'enroll'],
      ['d', 'message'],
      ['e', 'question'],
      ['f', 'question'],
      ['g', 'handoff'],
      ['h', 'end'],
    ],
  );
  assert.deepEqual(graph.edges, [
    E('a', 'next', 'b'),
    E('b', 'next', 'c'),
    E('c', 'order', 'h'),
    E('c', 'manual', 'd'),
    E('d', 'next', 'e'),
    E('e', 'next', 'f'),
    E('e', 'invalid', 'g'),
    E('f', 'next', 'g'),
    E('f', 'invalid', 'g'),
  ]);
  const by = id => graph.nodes.find(n => n.id === id).data;
  assert.deepEqual(by('d'), { parts: [{ kind: 'slot', slot: 'instrucciones_pago', ifMissing: 'stop' }] });
  assert.deepEqual(by('e').answer, { type: 'text', min: 5, max: 80 });
  assert.deepEqual(by('e').saveTo, { kind: 'attribute', key: 'nombre_constancia' });
  assert.deepEqual(by('f').answer, { type: 'email' });
  assert.deepEqual(by('f').saveTo, { kind: 'attribute', key: 'correo' });
  assert.equal(by('g').to, 'queue');
});

test('plantilla «Bienvenida con menú»: es exactamente la conversión del flujo de bienvenida de fábrica', () => {
  const converted = fromWelcomeFlow({ steps: DEFAULT_STEPS, withFlyer: true });
  const tpl = templateByKey('bienvenida_con_menu');
  assert.deepEqual(JSON.parse(JSON.stringify(tpl.graph)), converted.graph);
  assert.deepEqual(JSON.parse(JSON.stringify(tpl.settings)), converted.settings);
  assert.deepEqual(tpl.rules[0].definition.actions[0].firstMessage, converted.rule.actions[0].firstMessage);
});

test('plantillas: al crear un recorrido se sustituyen sus marcadores; lo que no se resuelve queda vacío y se avisa', () => {
  const brand = {
    flows: [{ id: 'flujo-77', name: 'Inscripción', published: true }],
    materials: [{ id: 'mat-9', name: 'Precio promocional vigente', status: 'approved' }],
    attributes: [{ key: 'nombre_constancia', label: 'Nombre para la constancia', type: 'text', status: 'active' }],
  };
  const resolve = link =>
    link.source === 'flows' ? brand.flows.find(f => norm(f.name) === norm(link.name))?.id : brand.materials[0].id;
  const venta = instantiateTemplate('venta_de_curso', resolve);
  assert.equal(venta.graph.nodes.find(n => n.id === 'g').data.flowId, 'flujo-77');
  assert.deepEqual(venta.unresolved, []);
  clean(validateGraph(venta.graph, brand));
  const inscripcion = instantiateTemplate('inscripcion', resolve);
  assert.equal(inscripcion.graph.nodes.find(n => n.id === 'b').data.templateId, 'mat-9');
  clean(validateGraph(inscripcion.graph, brand));
  assert.deepEqual(inscripcion.requires.attributes, [
    { key: 'nombre_constancia', label: 'Nombre para la constancia', type: 'text' },
  ]);
  assert.deepEqual(
    inscripcion.requires.slots.map(s => s.slot),
    ['instrucciones_pago'],
  );

  // Sin resolver: el paso queda vacío y la validación lo señala; la biblioteca no cambia.
  const bare = instantiateTemplate('venta_de_curso');
  assert.equal(bare.graph.nodes.find(n => n.id === 'g').data.flowId, '');
  assert.deepEqual(
    bare.unresolved.map(l => [l.nodeId, l.source, l.template]),
    [['g', 'flows', 'inscripcion']],
  );
  fails(validateGraph(bare.graph, brand), 'node', /Elige el recorrido/, 'g');
  assert.equal(templateByKey('venta_de_curso').graph.nodes.find(n => n.id === 'g').data.flowId, 'tpl:inscripcion');
  // El marcador sin sustituir no pasa por una referencia válida en una marca real.
  fails(validateGraph(templateByKey('venta_de_curso').graph, brand), 'ref', /no existe en esta marca/, 'g');
  bare.graph.nodes[0].x = 999;
  assert.notEqual(templateByKey('venta_de_curso').graph.nodes[0].x, 999, 'cada copia es independiente');
});

// ---- Resultado de una sesión -----------------------------------------------------------------------------------------

test('resultado de una sesión: una sola clasificación para la lista de recorridos y el tablero', () => {
  const expected = {
    completed: 'completed',
    assistant: 'completed',
    replaced: 'completed',
    handoff: 'handoff',
    human_takeover: 'handoff',
    closed: 'handoff',
    left: 'left',
    timeout: 'dropped',
    opt_out: 'dropped',
    window_closed: 'dropped',
    flow_archived: 'excluded',
    error: 'excluded',
  };
  for (const [outcome, result] of Object.entries(expected)) assert.equal(flowResult(outcome), result, outcome);
  assert.equal(flowResult(null), 'inProgress');
  assert.equal(flowResult(undefined), 'inProgress');
  assert.equal(flowResult(''), 'inProgress');
  assert.equal(flowResult('algo_nuevo'), 'excluded', 'lo desconocido queda fuera de las tasas');
  // Abandono = abandonadas ÷ (sesiones − en curso − fuera de las tasas); «salió escribiendo» no es abandono.
  const rates = flowRates({ completed: 4, handoff: 2, left: 2, dropped: 2, excluded: 3, inProgress: 5 });
  assert.deepEqual(rates, { sessions: 18, base: 10, completion: 0.4, dropOff: 0.2 });
  assert.deepEqual(flowRates({}), { sessions: 0, base: 0, completion: 0, dropOff: 0 });
  assert.deepEqual(flowRates(null), { sessions: 0, base: 0, completion: 0, dropOff: 0 });
});
