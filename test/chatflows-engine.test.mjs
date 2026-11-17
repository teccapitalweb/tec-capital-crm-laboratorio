// Motor de los recorridos sin base de datos (server/modules/chatflows/engine.mjs; docs/PLAN_RECORRIDOS.md): tipos de
// paso que se rechazan al publicar, respuestas de una Pregunta, condiciones con la biblioteca común, qué hace cada
// mensaje de la persona y los topes contra bucles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as copy from '../server/reply-copy.mjs';
import {
  CAPS,
  advance,
  checkAnswer,
  input,
  makeEnv,
  newSession,
  route,
  safePattern,
  unsupportedProblems,
} from '../server/modules/chatflows/engine.mjs';
import { createNode, normalizeGraph } from '../public/kit/shared/flow-model.js';

const NOW = Date.UTC(2026, 10, 16, 15, 0);

function fakeIo(over = {}) {
  const sent = [];
  const logs = [];
  const schedules = [];
  const io = {
    copy: { ...copy, invalidAnswer: 'No te entendí.' },
    values: () => ({ base: { nombre: 'Ana', curso: 'Aves' }, contacto: { ciudad: 'Puebla' } }),
    conditionRecord: () => ({
      attr: { ciudad: 'Puebla' },
      tags: ['t1'],
      course: 'aves',
      channel: 'whatsapp',
      open: true,
      clock: null,
    }),
    send: p => sent.push(p),
    windowOpen: () => true,
    stop: () => null,
    catalogue: () => ({ reason: 'Sin edición' }),
    material: () => ({ reason: 'Sin material' }),
    enroll: () => ({ reason: 'Sin edición' }),
    stage() {},
    setAttribute() {},
    tags() {},
    lastMessageText: () => '',
    schedule: (kind, at) => schedules.push([kind, at]),
    log: (event, d) => logs.push([event, d?.nodeId ?? null, d?.port ?? null, d?.detail ?? null]),
    ...over,
  };
  return { io, sent, logs, schedules };
}
const graphOf = (nodes, edges) =>
  normalizeGraph({
    v: 1,
    start: 'n1',
    nodes: [createNode('start', { id: 'n1' }), ...nodes.map(([id, type, data]) => createNode(type, { id, data }))],
    edges: edges.map(([from, port, to]) => ({ from, port, to })),
    variables: [],
  });
const session = env => newSession({ id: 's1', flowId: 'f1', version: 1, graph: env.graph, now: NOW });
const classify = text => ({ intent: /asesor/.test(text) ? 'human' : 'unknown' });

test('al publicar se rechaza con su motivo cada tipo de paso que el servidor todavía no ejecuta', () => {
  const graph = graphOf(
    [
      ['a', 'message', { parts: [{ kind: 'text', text: 'Hola' }] }],
      ['b', 'webhook', {}],
      ['c', 'list', {}],
      ['d', 'template', {}],
      ['e', 'consent', {}],
      ['f', 'choose_course', {}],
      ['g', 'assistant', { mode: 'answer' }],
      ['h', 'assistant', { mode: 'handover' }],
      ['i', 'status', { status: 'waiting' }],
      ['j', 'status', { status: 'resolved' }],
      ['k', 'message', { parts: [{ kind: 'slot', slot: 'presentacion' }] }],
    ],
    [],
  );
  // La Lista, la Plantilla, los archivos y «guardar el botón elegido» ya los ejecuta el motor; el material por espacio
  // sigue rechazado.
  const problems = unsupportedProblems(graph);
  assert.deepEqual(problems.map(p => p.nodeId).sort(), ['b', 'e', 'f', 'g', 'i', 'k']);
  assert.ok(problems.every(p => p.code === 'unsupported' && p.message.length > 20));
  assert.match(problems.find(p => p.nodeId === 'b').message, /servicios externos/);
  assert.match(problems.find(p => p.nodeId === 'k').message, /material por espacio/);
  // Una Plantilla de WhatsApp sólo pasa la revisión con un número real y sin otros canales.
  const tpl = graphOf([['d', 'template', { waTemplateId: 'x' }]], []);
  assert.deepEqual(unsupportedProblems(tpl, { realWhatsApp: true, settings: { channels: ['whatsapp'] } }), []);
  assert.match(unsupportedProblems(tpl, { realWhatsApp: false })[0].message, /número real de WhatsApp/);
  assert.match(
    unsupportedProblems(tpl, { realWhatsApp: true, settings: { channels: ['whatsapp', 'instagram'] } })[0].message,
    /sólo sale por WhatsApp/,
  );
  const media = graphOf(
    [
      ['m', 'message', { parts: [{ kind: 'media', fileId: 'f1' }] }],
      ['b', 'buttons', { header: { kind: 'media', fileId: 'f1' }, text: 'Hola', saveAs: 'eleccion' }],
    ],
    [],
  );
  assert.deepEqual(unsupportedProblems(media), []);
});

// Una lista de seis cursos: tres secciones de dos filas.
const sixRows = (extra = {}) => ({
  header: 'Cursos',
  text: 'Hola {{nombre}}, ¿cuál te interesa?',
  footer: 'Elige uno',
  button: 'Ver cursos',
  sections: [
    {
      title: 'Aves',
      rows: [
        { id: 'r1', title: 'Aves de corral', description: 'Básico', do: { type: 'goto' } },
        { id: 'r2', title: 'Aves exóticas', description: '', do: { type: 'goto' } },
      ],
    },
    {
      title: 'Perros',
      rows: [
        { id: 'r3', title: 'Cachorros', description: '', do: { type: 'goto' } },
        { id: 'r4', title: 'Perros senior', description: '', do: { type: 'intent', intent: 'price', stay: true } },
      ],
    },
    {
      title: 'Gatos',
      rows: [
        { id: 'r5', title: 'Gatos', description: '', do: { type: 'goto' } },
        { id: 'r6', title: 'Felinos salvajes', description: '', do: { type: 'goto' } },
      ],
    },
  ],
  saveAs: 'curso_elegido',
  ...extra,
});

test('lista: más de tres opciones, se elige por el número, por el nombre o por la fila pulsada, y se guarda', () => {
  const graph = graphOf(
    [
      ['l', 'list', sixRows()],
      ['a', 'end', { text: 'Elegiste {{var.curso_elegido}}' }],
      ['b', 'end', { text: 'Gatos' }],
    ],
    [
      ['n1', 'next', 'l'],
      ['l', 'opt:r2', 'a'],
      ['l', 'opt:r5', 'b'],
      ['l', 'opt:r6', 'a'],
    ],
  );
  const f = fakeIo();
  const env = makeEnv({ graph, settings: {}, io: f.io, now: NOW });
  const s = session(env);
  advance(s, env);
  assert.equal(s.state, 'waiting');
  assert.equal(s.waiting.list, true);
  assert.equal(s.waiting.saveAs, 'curso_elegido');
  assert.equal(s.waiting.options.length, 6);
  const sent = f.sent[0];
  assert.equal(sent.text, 'Cursos\n\nHola Ana, ¿cuál te interesa?\n\nElige uno');
  assert.equal(sent.list.button, 'Ver cursos');
  assert.equal(sent.list.sections.length, 3);
  assert.equal(sent.list.sections[0].rows[0].id, 'l:r1', 'la fila lleva el id del paso');
  assert.equal(sent.buttons, undefined, 'una lista no se manda como botones');
  const kind = message => route(s, env, message, classify);
  assert.equal(kind({ text: '5' }).option.id, 'r5');
  assert.equal(kind({ text: 'aves EXÓTICAS' }).option.id, 'r2');
  assert.equal(kind({ text: '4' }).kind, 'intent');
  // La fila pulsada en WhatsApp llega en `reply` (columna JSON): se reconoce por su id aunque el texto no coincida.
  const tap = { text: 'otra cosa', reply: JSON.stringify({ kind: 'list', id: 'l:r6', title: 'Felinos salvajes' }) };
  assert.equal(kind(tap).option.id, 'r6');
  // Una fila de OTRA lista (otro paso) no cuenta.
  assert.equal(kind({ text: 'otra cosa', reply: { kind: 'list', id: 'zz:r6' } }).kind, 'detour');
  input(s, env, kind(tap));
  assert.equal(s.vars.curso_elegido, 'Felinos salvajes');
  assert.equal(f.sent.at(-1).text, 'Elegiste Felinos salvajes');
});

test('lista con «repetir las opciones»: se vuelve a ofrecer como texto numerado, nunca como botones', () => {
  const graph = graphOf([['l', 'list', sixRows({ onUnexpected: 'repeat' })]], [['n1', 'next', 'l']]);
  const f = fakeIo();
  const env = makeEnv({ graph, settings: { fallbackText: 'Elige una opción.' }, io: f.io, now: NOW });
  const s = session(env);
  advance(s, env);
  input(s, env, route(s, env, { text: 'mmm' }, classify));
  const again = f.sent.at(-1);
  assert.equal(again.buttons, undefined);
  assert.match(again.text, /^Elige una opción\.\n\n1\. Aves de corral\n2\. Aves exóticas\n3\. Cachorros/);
});

test('botones: «guardar la opción elegida» deja el texto del botón en la variable', () => {
  const graph = graphOf(
    [
      [
        'b',
        'buttons',
        {
          text: '¿Horario?',
          options: [
            { id: 'm', label: 'Mañana', do: { type: 'goto' } },
            { id: 't', label: 'Tarde', do: { type: 'goto' } },
          ],
          saveAs: 'horario',
        },
      ],
      ['e', 'end', { text: 'Anotado: {{var.horario}}' }],
    ],
    [
      ['n1', 'next', 'b'],
      ['b', 'opt:t', 'e'],
    ],
  );
  const f = fakeIo();
  const env = makeEnv({ graph, settings: {}, io: f.io, now: NOW });
  const s = session(env);
  advance(s, env);
  input(s, env, route(s, env, { text: '2' }, classify));
  assert.equal(s.vars.horario, 'Tarde');
  assert.equal(f.sent.at(-1).text, 'Anotado: Tarde');
});

test('archivos: el motor pide el archivo a su puerta de salida; si no está, no manda otra cosa y pasa a una persona', () => {
  const graph = graphOf(
    [
      [
        'm',
        'message',
        {
          parts: [
            { kind: 'text', text: 'Te comparto el temario' },
            { kind: 'media', fileId: 'f1', caption: 'Temario de {{curso}}' },
          ],
        },
      ],
      [
        'b',
        'buttons',
        {
          header: { kind: 'media', fileId: 'f2' },
          text: '¿Te sirve?',
          options: [{ id: 'si', label: 'Sí', do: { type: 'goto' } }],
        },
      ],
    ],
    [
      ['n1', 'next', 'm'],
      ['m', 'next', 'b'],
    ],
  );
  const files = {
    f1: { id: 'f1', name: 'temario.pdf', mime: 'application/pdf' },
    f2: { id: 'f2', name: 'flyer.png', mime: 'image/png' },
  };
  let f = fakeIo({ file: id => files[id] || { reason: 'No está' } });
  let env = makeEnv({ graph, settings: {}, io: f.io, now: NOW });
  let s = session(env);
  advance(s, env);
  assert.equal(s.state, 'waiting');
  assert.deepEqual(f.sent[1].file, files.f1);
  assert.equal(f.sent[1].text, 'Temario de Aves');
  assert.deepEqual(f.sent[2].file, files.f2);
  // De otra marca (la puerta de salida no lo encuentra): el mensaje se corta ahí y pasa a una persona con aviso.
  f = fakeIo({ file: () => ({ reason: 'El archivo ya no está en la biblioteca de la marca' }) });
  env = makeEnv({ graph, settings: {}, io: f.io, now: NOW });
  s = session(env);
  const finals = advance(s, env);
  assert.equal(s.outcome, 'handoff');
  assert.deepEqual(finals.handoff, { to: 'queue', notice: true });
  assert.equal(f.sent.length, 1, 'sólo salió el texto anterior al archivo');
  assert.ok(f.logs.some(([event, , , detail]) => event === 'error' && /biblioteca de la marca/.test(detail)));
});

test('plantilla: sale con la ventana cerrada, puede esperar sus botones y sin plantilla válida no manda nada', () => {
  const graph = graphOf(
    [
      ['t', 'template', { waTemplateId: 'w1', wait: true, buttons: ['Sí, quiero', 'No, gracias'] }],
      ['y', 'end', { text: 'Genial' }],
    ],
    [
      ['n1', 'next', 't'],
      ['t', 'opt:1', 'y'],
    ],
  );
  const template = {
    name: 'oferta',
    text: 'Hola Ana, tenemos lugar.',
    category: 'marketing',
    template: {},
    buttons: ['Sí, quiero', 'No, gracias'],
  };
  let f = fakeIo({ windowOpen: () => false, template: () => template });
  let env = makeEnv({ graph, settings: {}, io: f.io, now: NOW });
  let s = session(env);
  advance(s, env);
  assert.equal(s.state, 'waiting', 'la ventana cerrada no detiene a la plantilla');
  assert.equal(f.sent[0].template, template);
  assert.deepEqual(
    s.waiting.options.map(o => o.label),
    ['Sí, quiero', 'No, gracias'],
  );
  assert.equal(route(s, env, { text: 'Sí, quiero' }, classify).port, 'opt:1');
  // Sin plantilla aprobada (o sin número real): termina y pasa a una persona; nada sale en su lugar.
  f = fakeIo({ template: () => ({ reason: 'Las plantillas de WhatsApp sólo salen por un número real' }) });
  env = makeEnv({ graph, settings: {}, io: f.io, now: NOW });
  s = session(env);
  advance(s, env);
  assert.equal(s.outcome, 'handoff');
  assert.equal(f.sent.length, 0);
});

test('respuestas de una Pregunta: formatos que se aceptan y valor que se guarda', () => {
  assert.equal(checkAnswer({ type: 'email' }, ' Ana@Example.com '), 'ana@example.com');
  assert.equal(checkAnswer({ type: 'email' }, 'no-es-correo'), null);
  assert.equal(checkAnswer({ type: 'phone' }, '55 1234 5678'), '5512345678');
  assert.equal(checkAnswer({ type: 'phone' }, '123'), null);
  assert.equal(checkAnswer({ type: 'date' }, '31/12/2026'), '2026-12-31');
  assert.equal(checkAnswer({ type: 'date' }, '31/02/2026'), null);
  assert.equal(checkAnswer({ type: 'time' }, '9:30'), '09:30');
  assert.equal(checkAnswer({ type: 'datetime' }, '2026-12-01 18:05'), '2026-12-01 18:05');
  assert.equal(checkAnswer({ type: 'number', min: 1, max: 10 }, '3,5'), '3.5');
  assert.equal(checkAnswer({ type: 'number', min: 1, max: 10 }, '11'), null);
  assert.equal(checkAnswer({ type: 'text', min: 3 }, 'ok'), null);
  assert.equal(checkAnswer({ type: 'regex', pattern: '^[A-Z]{3}\\d{2}$' }, 'ABC12'), 'ABC12');
  // Aunque llegara al motor, una expresión no segura no se evalúa: no coincide y no lanza.
  const started = Date.now();
  assert.equal(checkAnswer({ type: 'regex', pattern: '(a+)+$' }, 'a'.repeat(5000) + '!'), null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(safePattern('(.*)*'), null);
  assert.equal(safePattern('a'.repeat(121)), null);
  assert.equal(safePattern('(sin cerrar'), null);
  assert.ok(safePattern('^\\d{5}$'));
  assert.equal(checkAnswer({ type: 'text' }, '   '), null);
});

test('un recorrido avanza hasta los botones y cada mensaje de la persona se clasifica como en el diseño', () => {
  const graph = graphOf(
    [
      [
        'a',
        'message',
        { parts: [{ kind: 'text', text: 'Hola, {{nombre}}. {{contacto.ciudad}} · {{var.x|sin dato}}' }] },
      ],
      [
        'b',
        'buttons',
        {
          text: '¿Seguimos?',
          options: [
            { id: 'si', label: 'Sí, me interesa', do: { type: 'goto' } },
            { id: 'pr', label: 'Ver el precio', do: { type: 'intent', intent: 'price', stay: true } },
          ],
        },
      ],
      ['c', 'end', { text: 'Listo' }],
    ],
    [
      ['n1', 'next', 'a'],
      ['a', 'next', 'b'],
      ['b', 'opt:si', 'c'],
    ],
  );
  const f = fakeIo();
  const env = makeEnv({ graph, settings: {}, io: f.io, now: NOW });
  const s = session(env);
  advance(s, env);
  assert.equal(s.state, 'waiting');
  assert.equal(f.sent[0].text, 'Hola, Ana. Puebla · sin dato');
  assert.deepEqual(f.sent[1].buttons, ['Sí, me interesa', 'Ver el precio']);
  assert.deepEqual(
    f.schedules.map(([k]) => k),
    ['timeout'],
  );
  assert.equal(f.schedules[0][1], NOW + 1440 * 60_000);
  const kind = text => route(s, env, { text }, classify).kind;
  assert.equal(kind('sí, ME interesa'), 'consume');
  assert.equal(kind('1'), 'consume');
  assert.equal(kind('2'), 'intent');
  assert.equal(kind('quiero hablar con un asesor'), 'interrupt');
  assert.equal(kind('qué onda'), 'detour');
  const later = makeEnv({ graph, settings: {}, io: f.io, now: NOW + 1441 * 60_000 });
  assert.equal(route(s, later, { text: '1' }, classify).kind, 'expired');
  input(s, env, route(s, env, { text: '1' }, classify));
  assert.equal(s.state, 'ended');
  assert.equal(s.outcome, 'completed');
  assert.equal(f.sent.at(-1).text, 'Listo');
});

test('pregunta: error y otro intento, luego la respuesta queda en la variable y la condición la lee', () => {
  const when = {
    mode: 'all',
    groups: [{ mode: 'all', items: [{ f: 'attr', key: 'var.correo', op: 'contains', value: 'example' }] }],
  };
  const tagged = { mode: 'all', groups: [{ mode: 'all', items: [{ f: 'tag', op: 'has', tagId: 't1' }] }] };
  const graph = graphOf(
    [
      [
        'q',
        'question',
        { text: '¿Tu correo?', answer: { type: 'email' }, saveTo: { kind: 'var', name: 'correo' }, attempts: 2 },
      ],
      [
        'k',
        'condition',
        {
          cases: [
            { id: 'c1', label: 'Ejemplo', when },
            { id: 'c2', label: 'Etiqueta', when: tagged },
          ],
        },
      ],
      ['y', 'end', { text: 'Sí: {{var.correo}}' }],
      ['n', 'end', { text: 'No' }],
    ],
    [
      ['n1', 'next', 'q'],
      ['q', 'next', 'k'],
      ['k', 'case:c1', 'y'],
      ['k', 'else', 'n'],
    ],
  );
  const f = fakeIo();
  const env = makeEnv({ graph, settings: {}, io: f.io, now: NOW });
  const s = session(env);
  advance(s, env);
  input(s, env, route(s, env, { text: 'no-es-correo' }, classify));
  assert.equal(s.state, 'waiting');
  assert.equal(f.sent.at(-1).text, 'No te entendí.');
  input(s, env, route(s, env, { text: 'ana@example.com' }, classify));
  assert.equal(s.outcome, 'completed');
  assert.equal(s.vars.correo, 'ana@example.com');
  assert.equal(f.sent.at(-1).text, 'Sí: ana@example.com');
});

test('sin bucles: un ciclo sin espera se detiene y un ciclo con esperas topa en los mensajes sin respuesta', () => {
  // Ciclo sin esperar a la persona (la validación lo impide al publicar; el motor también lo corta).
  const loop = graphOf(
    [
      ['a', 'message', { parts: [{ kind: 'text', text: 'Otra vez' }] }],
      ['b', 'condition', { cases: [] }],
    ],
    [
      ['n1', 'next', 'a'],
      ['a', 'next', 'b'],
      ['b', 'else', 'a'],
    ],
  );
  let f = fakeIo();
  let env = makeEnv({ graph: loop, settings: {}, io: f.io, now: NOW });
  let s = session(env);
  const finals = advance(s, env);
  assert.equal(s.outcome, 'error');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(finals.handoff, { to: 'queue', notice: true });
  assert.ok(f.logs.some(([event, , , detail]) => event === 'error' && /sin esperar/.test(detail)));

  // Ciclo con una espera: cada despertar manda un mensaje; al pasar el tope de mensajes sin respuesta, termina.
  const slow = graphOf(
    [
      ['a', 'message', { parts: [{ kind: 'text', text: 'Recordatorio' }] }],
      ['d', 'delay', { seconds: 5 }],
    ],
    [
      ['n1', 'next', 'a'],
      ['a', 'next', 'd'],
      ['d', 'next', 'a'],
    ],
  );
  f = fakeIo();
  env = makeEnv({ graph: slow, settings: {}, io: f.io, now: NOW });
  s = session(env);
  advance(s, env);
  for (let i = 0; i < 40 && s.state !== 'ended'; i += 1) {
    assert.equal(s.state, 'delayed');
    s.nodeId = env.target(s.nodeId, 'next');
    s.state = 'running';
    advance(s, env);
  }
  assert.equal(s.outcome, 'error');
  assert.equal(f.sent.length, CAPS.unanswered);
});

test('el motor se detiene solo: ventana cerrada antes de hablar y una persona que tomó el chat', () => {
  const graph = graphOf([['a', 'message', { parts: [{ kind: 'text', text: 'Hola' }] }]], [['n1', 'next', 'a']]);
  let f = fakeIo({ windowOpen: () => false });
  let env = makeEnv({ graph, settings: {}, io: f.io, now: NOW });
  let s = session(env);
  advance(s, env);
  assert.equal(s.outcome, 'window_closed');
  assert.equal(f.sent.length, 0);
  f = fakeIo({ stop: () => 'human_takeover' });
  env = makeEnv({ graph, settings: {}, io: f.io, now: NOW });
  s = session(env);
  advance(s, env);
  assert.equal(s.outcome, 'human_takeover');
  assert.equal(f.sent.length, 0);
});
