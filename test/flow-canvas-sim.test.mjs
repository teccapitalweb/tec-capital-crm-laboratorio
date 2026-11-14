// Partes sin DOM del lienzo que no son el store: el recorrido de prueba del simulador (sim.js), los renglones del
// esquema (outline.js) y las reglas que los archivos del lienzo deben cumplir para convivir con la aplicación.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { checkStructure, normalizeGraph, validateGraph } from '../public/kit/shared/flow-model.js';
import { instantiateTemplate, templateByKey } from '../public/kit/shared/flow-templates.js';
import { DEMO_CATALOGUE, DEMO_STATS } from '../public/screens/automatizacion/lienzo/demo-data.js';
import { esc, flag, html } from '../public/screens/automatizacion/lienzo/dom.js';
import { hasIcon, icon } from '../public/screens/automatizacion/lienzo/icons.js';
import { buildOutline, statsText } from '../public/screens/automatizacion/lienzo/outline.js';
import {
  checkAnswer,
  fill,
  outcomeText,
  simInput,
  simNode,
  simStart,
  simTrail,
  simulationEnv,
} from '../public/screens/automatizacion/lienzo/sim.js';
import { NODE_TYPES } from '../public/kit/shared/flow-model.js';

const N = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data });
const E = (from, port, to) => ({ from, port, to });
const G = (nodes, edges = [], variables = []) => ({ v: 1, start: nodes[0].id, nodes, edges, variables });
const say = body => ({ parts: [{ kind: 'text', text: body }] });
const goto = { type: 'goto' };
const resolve = link => (DEMO_CATALOGUE[link.source] || []).find(item => item.name === link.name)?.id || '';
const outs = state => state.transcript.filter(e => e.who === 'out').map(e => e.text);
const notes = state => state.transcript.filter(e => e.who === 'note').map(e => e.text);
const run = (env, inputs) => inputs.reduce((state, input) => simInput(env, state, input), simStart(env));

// ---- Simulador -------------------------------------------------------------------------------------------------------

test('simulador: «Venta de curso» con dos cursos distintos da la ficha y el material de cada uno', () => {
  const venta = instantiateTemplate('venta_de_curso', resolve);
  const env = courseId =>
    simulationEnv({ graph: venta.graph, settings: venta.settings, catalogue: DEMO_CATALOGUE, courseId });

  const aves = simStart(env('curso-aves'));
  assert.equal(aves.status, 'waiting');
  assert.equal(aves.waiting.nodeId, 'b');
  assert.deepEqual(
    aves.waiting.options.map(o => o.title),
    ['Sí, me interesa', 'Ver el temario'],
  );
  assert.match(notes(aves)[0], /ya tiene curso \(«Medicina de aves de compañía»\): pasa de largo/);
  assert.equal(outs(aves)[0], 'Hola, María. Gracias por tu interés en Medicina de aves de compañía.');
  assert.match(
    outs(aves)[1],
    /asesora académica de Academia de ejemplo/,
    'el material del espacio «presentacion» de la marca',
  );
  const card = aves.transcript.find(e => e.nodeId === 'f');
  assert.equal(card.flyer, true);
  assert.match(card.text, /Medicina de aves de compañía · Enero 2027\n• Inicio: martes, 12 de enero/);
  assert.match(
    card.text,
    /Precio: \$1,200\.00 MXN con la promoción «Inscripción anticipada», vigente hasta el 20 de diciembre/,
  );
  assert.equal(
    aves.transcript.find(e => e.nodeId === 'm2').media,
    'temario-aves.png',
    'la imagen del temario es del curso',
  );
  assert.deepEqual(notes(aves).filter(n => /Esperaría/.test(n)).length, 2, 'las esperas no se duermen: se anotan');
  assert.deepEqual(simTrail(aves), ['s', 'c', 'm1', 'd1', 'f', 'm2', 'd2', 'b']);
  assert.equal(simNode(aves), 'b');

  // El mismo recorrido, otro curso: otra ficha, y sin imagen de temario esa parte se salta.
  const reptiles = simStart(env('curso-reptiles'));
  assert.match(
    reptiles.transcript.find(e => e.nodeId === 'f').text,
    /Clínica de reptiles · Febrero 2027[\s\S]*Presencial · Puebla/,
  );
  assert.equal(
    reptiles.transcript.some(e => e.nodeId === 'm2' && e.who === 'out'),
    false,
  );
  assert.ok(notes(reptiles).some(n => /Sin material aprobado en el espacio «temario_imagen»/.test(n)));

  // Sin curso: lo pregunta; se reconoce por número, por nombre o por una palabra propia del título.
  const asked = simStart(env(null));
  assert.equal(asked.waiting.kind, 'course');
  assert.match(outs(asked)[0], /1\. Medicina de aves de compañía\n2\. Clínica de reptiles/);
  for (const typed of ['2', 'clinica de reptiles', 'el de reptiles']) {
    const chosen = simInput(env(null), asked, { text: typed });
    assert.equal(chosen.courseId, 'curso-reptiles', typed);
    assert.equal(chosen.waiting.nodeId, 'b');
  }
  const lost = run(env(null), [{ text: 'no sé' }, { text: 'cuánto cuesta' }]);
  assert.equal(lost.outcome, 'handoff', 'agotados los intentos sale por «Ninguno», que lleva a una persona');
  assert.equal(asked.transcript.length, 1, 'el estado recibido no se altera');
});

test('simulador: botones por id, por texto y por intención; texto libre, repetir y sin respuesta', () => {
  const venta = instantiateTemplate('venta_de_curso', resolve);
  const env = simulationEnv({
    graph: venta.graph,
    settings: venta.settings,
    catalogue: DEMO_CATALOGUE,
    courseId: 'curso-aves',
  });
  const start = simStart(env);

  const byId = simInput(env, start, { optionId: 'si' });
  assert.equal(byId.outcome, 'replaced');
  assert.match(notes(byId).at(-1), /Aquí empezaría el recorrido «Inscripción»/);
  assert.equal(
    simInput(env, start, { text: '  SÍ, me interesa!! ' }).outcome,
    'replaced',
    'el texto igual al título, sin mayúsculas ni signos',
  );
  assert.equal(simInput(env, byId, { text: 'hola' }), byId, 'una prueba terminada ya no cambia');

  // «Ver el temario» lo contesta el asistente y el menú sigue a la vista.
  const stayed = simInput(env, start, { text: 'ver el temario' });
  assert.equal(stayed.status, 'waiting');
  assert.match(notes(stayed).at(-1), /Respondería el asistente: enviar el temario\. Las opciones siguen a la vista/);

  // Otra cosa: contesta el asistente; al segundo mensaje fuera de las opciones el recorrido termina («salió escribiendo»).
  const once = simInput(env, start, { text: '¿dan constancia?' });
  assert.equal(once.status, 'waiting');
  assert.equal(once.waiting.misses, 1);
  assert.ok(notes(once).some(n => /volvería a ofrecer las opciones/.test(n)));
  const twice = simInput(env, once, { text: '¿y factura?' });
  assert.equal(twice.outcome, 'left');
  assert.match(outcomeText(twice.outcome), /^Salió escribiendo/);

  // 24 horas sin respuesta: la salida «Sin respuesta» lleva al Fin.
  const silent = simInput(env, start, { timeout: true });
  assert.equal(silent.outcome, 'completed');
  assert.match(notes(silent).at(-1), /no responde en 24 h/);
  assert.equal(simNode(silent), 'e');

  // Con «repetir» (como el proveedor actual) se manda el mensaje de reserva y se repiten las opciones.
  const repeat = simulationEnv({
    graph: venta.graph,
    settings: { ...venta.settings, onUnexpected: 'repeat', fallbackText: 'Elige una opción, {{nombre}}.' },
    catalogue: DEMO_CATALOGUE,
    courseId: 'curso-aves',
  });
  const again = simInput(repeat, simStart(repeat), { text: 'hola' });
  assert.deepEqual(outs(again).slice(-2), [
    'Elige una opción, María.',
    '¿Te gustaría conocer el proceso de inscripción?',
  ]);
  assert.equal(simInput(repeat, again, { text: 'hola' }).outcome, 'left', 'sin «Si no elige» conectado, termina');

  // Sin respuesta y sin esa salida conectada: abandono.
  const menu = templateByKey('bienvenida_con_menu');
  const bare = simulationEnv({ graph: menu.graph, settings: menu.settings, catalogue: {} });
  const greeting = simStart(bare);
  assert.equal(
    outs(greeting)[0],
    '¡Hola! Soy el asistente de [marca]. ¿Qué te gustaría saber de [curso]?',
    'sin nombre no queda una coma suelta; lo que el ejemplo no trae se ve entre corchetes',
  );
  assert.equal(greeting.transcript[0].flyer, true);
  assert.equal(simInput(bare, greeting, { timeout: true }).outcome, 'timeout');
  const more = simInput(bare, greeting, { optionId: 'o3' });
  assert.equal(more.waiting.nodeId, 'mas');
  assert.equal(simInput(bare, more, { text: 'hablar con asesor' }).outcome, 'handoff');
  assert.equal(simInput(bare, more, { text: 'inscribirme' }).outcome, 'assistant');
  // El menú convertido no vuelve a ofrecer las opciones tras un desvío.
  assert.equal(
    notes(simInput(bare, greeting, { text: 'hola' })).some(n => /volvería a ofrecer/.test(n)),
    false,
  );
});

test('simulador: «Inscripción» crea el pedido, sale por pago manual o avisa que no está disponible', () => {
  const flow = instantiateTemplate('inscripcion', resolve);
  const env = courseId =>
    simulationEnv({ graph: flow.graph, settings: flow.settings, catalogue: DEMO_CATALOGUE, courseId });

  const order = simStart(env('curso-aves'));
  assert.equal(order.outcome, 'completed');
  assert.equal(
    outs(order)[0],
    'Precio promocional de Medicina de aves de compañía: $1,200.00 MXN (precio regular: $1,500.00 MXN). Vigente hasta el 20 de diciembre.',
  );
  assert.equal(outs(order)[1], '[Aquí iría el pedido con su enlace de pago]');
  assert.deepEqual(simTrail(order), ['a', 'b', 'c', 'h']);

  // Venta en línea apagada: instrucciones de pago, nombre para la constancia, correo y una persona.
  const manual = run(env('curso-reptiles'), [
    { text: 'Ana' },
    { text: 'Ana María Pérez' },
    { text: 'no tengo' },
    { text: 'ANA@ejemplo.mx' },
  ]);
  assert.equal(manual.outcome, 'handoff');
  assert.deepEqual(manual.attrs, { ciudad: 'Puebla', nombre_constancia: 'Ana María Pérez', correo: 'ana@ejemplo.mx' });
  assert.ok(outs(manual).includes('Necesito tu nombre y apellidos, por favor.'));
  assert.ok(outs(manual).includes('Ese correo no parece válido. ¿Me lo escribes de nuevo?'));
  assert.equal(
    outs(manual).at(-1),
    '¡Gracias, María! Envía tu comprobante por aquí y una persona del equipo lo valida.',
  );
  // Dos respuestas que no sirven: sale por «No válida».
  const invalid = run(env('curso-reptiles'), [{ text: 'A' }, { text: 'B' }]);
  assert.equal(invalid.outcome, 'handoff');
  assert.ok(notes(invalid).some(n => /Se agotaron los intentos/.test(n)));

  // Edición no disponible y la salida sin conectar: lo dice y pasa con una persona, como el asistente.
  const closed = simStart(env('curso-nutricion'));
  assert.equal(closed.outcome, 'handoff');
  assert.match(outs(closed)[0], /esta edición no está disponible/);
  // Sin el material de instrucciones de pago, el recorrido se detiene ahí.
  const noMaterial = simulationEnv({
    graph: flow.graph,
    catalogue: { ...DEMO_CATALOGUE, materials: [] },
    courseId: 'curso-reptiles',
  });
  assert.equal(simStart(noMaterial).outcome, 'error');
});

test('simulador: condiciones, datos guardados, etiquetas, servicio externo y lo que no se puede seguir', () => {
  const when = items => ({ mode: 'all', groups: [{ mode: 'all', items }] });
  const graph = G(
    [
      N('s', 'start'),
      N('q', 'question', {
        text: '¿Cuántas personas se inscriben?',
        answer: { type: 'number', min: 1, max: 20 },
        saveTo: { kind: 'var', name: 'personas' },
        attempts: 1,
      }),
      N('t', 'tags', { add: ['etiqueta-interesado'] }),
      N('a', 'set_attribute', { key: 'ciudad', value: { from: 'last_message' } }),
      N('w', 'webhook', {
        url: 'https://api.ejemplo.mx/x',
        map: [{ path: 'cliente.pedidos[0].folio', saveTo: { kind: 'var', name: 'folio' } }],
        sample: '{"cliente":{"pedidos":[{"folio":"F-77"}]}}',
      }),
      N('c', 'condition', {
        cases: [
          {
            id: 'grupo',
            label: 'Grupo',
            when: when([
              { f: 'attr', key: 'var.personas', op: 'gte', value: '5' },
              { f: 'tag', op: 'has', tagId: 'etiqueta-interesado' },
            ]),
          },
          { id: 'tarde', label: 'Tarde', when: when([{ f: 'clock', days: ['3'], from: '18:00', to: '02:00' }]) },
        ],
      }),
      N('g', 'message', say('Grupo de {{var.personas}}, folio {{var.folio}}, desde {{contacto.ciudad}}.')),
      N('n', 'message', say('Horario de tarde.')),
      N('o', 'end', { text: 'Listo.' }),
    ],
    [
      E('s', 'next', 'q'),
      E('q', 'next', 't'),
      E('t', 'next', 'a'),
      E('a', 'next', 'w'),
      E('w', 'success', 'c'),
      E('c', 'case:grupo', 'g'),
      E('c', 'case:tarde', 'n'),
      E('c', 'else', 'o'),
    ],
  );
  assert.deepEqual(validateGraph(graph).errors, []);
  const env = now => simulationEnv({ graph, catalogue: DEMO_CATALOGUE, now });
  const group = run(env(null), [{ text: '8' }]);
  assert.equal(outs(group).at(-1), 'Grupo de 8, folio F-77, desde 8.');
  assert.deepEqual(group.tags, ['etiqueta-interesado']);
  assert.ok(
    notes(group).some(n => /pondría «Interesado»/.test(n)) && notes(group).some(n => /No se llama al servicio/.test(n)),
  );
  // El reloj llega como dato: miércoles a las 23:30 cae en un horario que cruza la medianoche.
  assert.equal(outs(run(env({ day: 3, minutes: 23 * 60 + 30 }), [{ text: '2' }])).at(-1), 'Horario de tarde.');
  assert.equal(outs(run(env({ day: 3, minutes: 12 * 60 }), [{ text: '2' }])).at(-1), 'Listo.');
  assert.equal(outs(run(env(null), [{ text: '2' }])).at(-1), 'Listo.');
  // Un intento, respuesta fuera de rango: «No válida» sin conectar termina el recorrido.
  assert.equal(run(env(null), [{ text: '99' }]).outcome, 'completed');

  // Un ciclo que nunca espera no cuelga la prueba.
  const loop = simulationEnv({
    graph: G([N('s', 'start'), N('m', 'message', say('Otra vez'))], [E('s', 'next', 'm'), E('m', 'next', 'm')]),
  });
  const stuck = simStart(loop);
  assert.equal(stuck.outcome, 'error');
  assert.match(notes(stuck).at(-1), /más de 200 pasos seguidos sin esperar/);
  // Un tipo que esta versión no conoce detiene la prueba con un aviso.
  const odd = simulationEnv({
    graph: { v: 1, start: 's', nodes: [N('s', 'start'), N('u', 'message', say('x'))], edges: [E('s', 'next', 'u')] },
  });
  odd.byId.get('u').type = 'teletransporte';
  assert.equal(simStart(odd).outcome, 'error');
  // En un canal sin listas, la lista va como texto numerado y se acepta el número.
  const list = G(
    [
      N('s', 'start'),
      N('l', 'list', {
        text: 'Elige',
        button: 'Ver',
        sections: [
          {
            rows: [
              { id: 'a', title: 'Fechas', do: goto },
              { id: 'b', title: 'Precio', do: goto },
            ],
          },
        ],
      }),
      N('m', 'message', say('Precio.')),
    ],
    [E('s', 'next', 'l'), E('l', 'opt:b', 'm')],
  );
  const instagram = simulationEnv({ graph: list, channel: 'instagram' });
  assert.equal(outs(simStart(instagram))[0], 'Elige\n\n1. Fechas\n2. Precio');
  assert.equal(outs(simInput(instagram, simStart(instagram), { text: '2' })).at(-1), 'Precio.');
});

test('simulador: validación de cada tipo de respuesta y sustitución de datos', () => {
  const ok = (answer, input, value) => assert.deepEqual(checkAnswer(answer, input), { ok: true, value });
  const bad = (answer, input) => assert.equal(checkAnswer(answer, input).ok, false);
  ok({ type: 'text', min: 5, max: 80 }, { text: ' Ana María ' }, 'Ana María');
  bad({ type: 'text', min: 5 }, { text: 'Ana' });
  bad({ type: 'text' }, { text: '   ' });
  ok({ type: 'number' }, { text: '3,5' }, '3.5');
  bad({ type: 'number', max: 3 }, { text: '4' });
  bad({ type: 'number' }, { text: 'tres' });
  ok({ type: 'email' }, { text: 'Ana@Ejemplo.MX' }, 'ana@ejemplo.mx');
  bad({ type: 'email' }, { text: 'ana@ejemplo' });
  ok({ type: 'phone' }, { text: '+52 (222) 123-4567' }, '522221234567');
  bad({ type: 'phone' }, { text: '12345' });
  ok({ type: 'date' }, { text: '31/01/2027' }, '2027-01-31');
  ok({ type: 'date' }, { text: '1-2-2027' }, '2027-02-01');
  ok({ type: 'date' }, { text: '2027-12-05' }, '2027-12-05');
  bad({ type: 'date' }, { text: '31/02/2027' });
  ok({ type: 'time' }, { text: '9:05' }, '09:05');
  bad({ type: 'time' }, { text: '25:00' });
  ok({ type: 'datetime' }, { text: '31/01/2027 19:00' }, '2027-01-31 19:00');
  bad({ type: 'datetime' }, { text: '31/01/2027' });
  ok({ type: 'regex', pattern: '^[A-Z]{4}\\d{6}$' }, { text: 'PELA900101' }, 'PELA900101');
  bad({ type: 'regex', pattern: '^[A-Z]{4}\\d{6}$' }, { text: 'pela' });
  bad({ type: 'regex', pattern: '([a-z' }, { text: 'x' });
  ok({ type: 'media', mediaKinds: ['image'] }, { media: 'image' }, '[image]');
  bad({ type: 'media', mediaKinds: ['image'] }, { media: 'audio' });
  bad({ type: 'media', mediaKinds: [] }, { text: 'una foto' });
  ok({ type: 'location' }, { location: '19.43,-99.13' }, '19.43,-99.13');

  const env = simulationEnv({ graph: G([N('s', 'start')]), catalogue: DEMO_CATALOGUE, courseId: 'curso-aves' });
  const state = { vars: { folio: 'F-1' }, attrs: { ciudad: 'Puebla' }, courseId: 'curso-aves' };
  assert.equal(
    fill(env, state, 'Hola, {{nombre}}: {{curso}} con {{docente}} ({{var.folio}}, {{contacto.ciudad}}).'),
    'Hola, María: Medicina de aves de compañía con MVZ Ana Rivera (F-1, Puebla).',
  );
  assert.equal(fill(env, state, 'Dato {{contacto.empresa|sin empresa}} y {{var.nada|—}}.'), 'Dato sin empresa y —.');
  assert.equal(
    fill(env, state, 'Vacío, {{var.nada}} fin.'),
    'Vacío fin.',
    'un dato vacío sin respaldo se va con su coma',
  );
  const nobody = simulationEnv({ graph: G([N('s', 'start')]), catalogue: {} });
  assert.equal(
    fill(nobody, { vars: {}, attrs: {}, courseId: null }, '¡Hola, {{nombre}}! Precio: {{precio}}.'),
    '¡Hola! Precio: [precio].',
  );
});

// ---- Esquema ---------------------------------------------------------------------------------------------------------

test('esquema: un renglón por paso en orden de lectura, con a dónde lleva cada salida', () => {
  const graph = templateByKey('venta_de_curso').graph;
  const rows = buildOutline(graph, DEMO_CATALOGUE);
  assert.deepEqual(
    rows.map(r => r.id),
    ['s', 'c', 'm1', 'd1', 'f', 'm2', 'd2', 'b', 'g', 'e', 'h'],
  );
  assert.deepEqual(
    rows.map(r => r.index),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.ok(rows.every(r => r.section === 'flow' && hasIcon(r.icon)));
  const [start, choose] = rows;
  assert.deepEqual(start.outputs, [
    {
      port: 'next',
      label: 'Sigue',
      optional: false,
      to: 'c',
      toIndex: 2,
      toName: '¿Qué curso te interesa?',
      next: true,
    },
  ]);
  assert.deepEqual(
    choose.outputs.map(o => [o.label, o.toIndex, o.next, o.optional]),
    [
      ['Curso elegido', 3, true, false],
      ['Ninguno', 11, false, false],
      ['Sin respuesta', null, false, true],
    ],
  );
  const buttons = rows.find(r => r.id === 'b');
  assert.equal(buttons.name, 'Invitación a inscribirse');
  assert.equal(buttons.kind, 'Botones');
  assert.equal(buttons.groupLabel, 'Mensajes');
  assert.equal(buttons.summary, '¿Te gustaría conocer el proceso de inscripción?');
  assert.deepEqual(
    buttons.outputs.map(o => [o.port, o.toName]),
    [
      ['opt:si', 'Inscripción'],
      ['default', ''],
      ['timeout', 'Fin'],
    ],
  );
  assert.equal(rows.find(r => r.id === 'h').incoming, 1);
  assert.deepEqual(rows.find(r => r.id === 'e').outputs, []);

  // Los pasos a los que no llega ningún camino y las notas van en sus propias secciones, al final.
  const loose = normalizeGraph(
    G(
      [N('s', 'start'), N('m', 'message', say('Hola')), N('x', 'delay'), N('n', 'note', { text: 'Pendiente' })],
      [E('s', 'next', 'm')],
    ),
  );
  assert.deepEqual(
    buildOutline(loose).map(r => [r.id, r.section]),
    [
      ['s', 'flow'],
      ['m', 'flow'],
      ['x', 'loose'],
      ['n', 'notes'],
    ],
  );
  assert.equal(
    buildOutline(normalizeGraph({ nodes: [N('u', 'teletransporte')] })).find(r => r.id === 'u').kind,
    'Paso desconocido',
  );
});

test('cifras por paso, en palabras', () => {
  assert.equal(
    statsText({ entered: 24, completed: 6, dropped: 14, left: 4 }),
    'Entraron 24 · completó el 25 % · se quedaron 14 · salieron escribiendo 4',
  );
  assert.equal(statsText({ entered: 24, completed: 24, dropped: 0 }, true), 'Entraron 24 · 100 % · se quedaron 0');
  assert.equal(statsText({ entered: 0 }), 'Entraron 0 · se quedaron 0');
  assert.equal(statsText(null), '');
  // Las cifras de ejemplo de la demostración corresponden a pasos que existen en la plantilla.
  const ids = new Set(templateByKey('venta_de_curso').graph.nodes.map(n => n.id));
  for (const id of Object.keys(DEMO_STATS.nodes)) assert.ok(ids.has(id), id);
});

// ---- Convivencia con la aplicación -----------------------------------------------------------------------------------

test('plantillas del lienzo: toda interpolación se escapa', () => {
  assert.equal(esc('<img src=x onerror="alert(1)">&\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
  const evil = '"><script>alert(1)</script>';
  const out = html`<p title="${evil}">${evil}${[html`<b>${evil}</b>`, null, undefined, false, 0]}</p>`;
  assert.equal(out.text.includes('<script>'), false);
  assert.equal(
    out.text,
    '<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;<b>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</b>0</p>',
  );
  assert.equal(html`<button ${flag('disabled', true)}>x</button>`.text, '<button disabled>x</button>');
  assert.equal(html`<button ${flag('disabled', false)}>x</button>`.text, '<button >x</button>');
  assert.throws(() => flag('onclick=alert(1)', true), /no admitido/);
  assert.match(
    icon('message').text,
    /^<svg class="lz-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="[^"<>]+"><\/path><\/svg>$/,
  );
  for (const def of Object.values(NODE_TYPES)) assert.ok(hasIcon(def.icon), `${def.type}: su icono existe`);
});

test('archivos del lienzo: sin HTML crudo, sin globales, sin oyentes en document y sin los atributos de la aplicación', () => {
  const dir = new URL('../public/screens/automatizacion/lienzo/', import.meta.url);
  const shared = new URL('../public/kit/shared/', import.meta.url);
  const read = (base, name) => readFileSync(new URL(name, base), 'utf8');
  const scripts = [
    ...readdirSync(dir)
      .filter(f => f.endsWith('.js'))
      .map(f => [f, read(dir, f)]),
    ...readdirSync(shared).map(f => [f, read(shared, f)]),
  ];
  assert.ok(scripts.length >= 14);
  // Los catorce atributos por los que app.js reparte los clics: una pantalla nueva no puede usarlos.
  const taken = [
    'action',
    'view',
    'mode',
    'source',
    'filter',
    'conversation',
    'new-channel',
    'quick',
    'chat-action',
    'template',
    'start-course',
    'course-detail',
    'edit-course',
    'course-flyer',
  ];
  const invisible = new RegExp(
    '[' + [0xfeff, 0x200b, 0x200c, 0x200d, 0x2060, 0x00a0, 0x00ad].map(c => String.fromCharCode(c)).join('') + ']',
  );
  for (const [name, source] of [
    ...scripts,
    ['lienzo.css', read(dir, 'lienzo.css')],
    ['demo.html', read(dir, 'demo.html')],
    ['demo.css', read(dir, 'demo.css')],
  ]) {
    assert.doesNotMatch(
      source,
      /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/,
      `${name}: HTML sin escapar`,
    );
    assert.doesNotMatch(
      source,
      /\bwindow\.[A-Za-z_$]+\s*=[^=]|globalThis\.[A-Za-z_$]+\s*=[^=]/,
      `${name}: global nuevo`,
    );
    assert.doesNotMatch(
      source,
      /document\.addEventListener|window\.addEventListener/,
      `${name}: oyente fuera de la raíz`,
    );
    assert.doesNotMatch(source, /\beval\(|new Function\(|localStorage|sessionStorage/, name);
    for (const attr of taken)
      assert.equal(
        new RegExp(`data-${attr}(=|\\b(?!-))`).test(source),
        false,
        `${name}: usa data-${attr}, que es de la aplicación`,
      );
    assert.equal(invisible.test(source), false, `${name}: carácter invisible escrito en el archivo`);
    assert.equal(source.includes('\r'), false, `${name}: finales de línea LF`);
    assert.ok(source.endsWith('\n'), `${name}: termina con salto de línea`);
  }
  // La hoja del lienzo sólo usa las variables de Niebla: ningún color escrito, nada bajo 11 px, sin !important.
  for (const name of ['lienzo.css', 'demo.css']) {
    const css = read(dir, name).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/, `${name}: color literal`);
    assert.doesNotMatch(css, /!important/, name);
    for (const m of css.matchAll(/font-size:\s*(?:max\()?(\d+(?:\.\d+)?)px/g))
      assert.ok(Number(m[1]) >= 11, `${name}: letra de ${m[1]} px`);
  }
  // La demostración no lleva guiones ni estilos en línea: la política de contenido de la aplicación los bloquearía.
  const page = read(dir, 'demo.html');
  assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=|<style|\sstyle=/i);
  assert.match(page, /<script type="module" src="\.\/demo\.js"><\/script>/);
  assert.deepEqual(checkStructure(templateByKey('venta_de_curso').graph), []);
});
