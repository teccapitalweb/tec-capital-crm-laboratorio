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
  const problems = unsupportedProblems(graph);
  assert.deepEqual(problems.map(p => p.nodeId).sort(), ['b', 'c', 'd', 'e', 'f', 'g', 'i', 'k']);
  assert.ok(problems.every(p => p.code === 'unsupported' && p.message.length > 20));
  assert.match(problems.find(p => p.nodeId === 'b').message, /servicios externos/);
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
