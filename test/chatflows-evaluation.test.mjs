// Evaluación de recorridos (docs/PLAN_RECORRIDOS.md, «Evaluación»): rendimiento por paso desde la bitácora y revisión
// con IA. Las sesiones y su bitácora se escriben a mano con horas fijas, así ninguna cifra depende del reloj.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin } from './helpers/crm.mjs';
import { outlineOf, mask } from '../server/modules/chatflows/review.mjs';

const ref = () => randomUUID();
const node = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data });
const LONG = 'Te cuento todo sobre el curso. '.repeat(25);
const graph = () => ({
  v: 1,
  start: 's',
  variables: [{ name: 'correo', label: 'Correo', type: 'text' }],
  nodes: [
    node('s', 'start'),
    node('m', 'message', {
      parts: [{ kind: 'text', text: LONG + 'Escríbenos a ventas@ejemplo.mx o al 55 1234 5678.' }],
    }),
    node('b', 'buttons', {
      header: { kind: 'none' },
      text: '¿Te gustaría inscribirte?',
      footer: '',
      options: [{ id: 'si', label: 'Sí, me interesa', do: { type: 'goto' } }],
    }),
    node('q', 'question', {
      text: '¿Me compartes tu correo?',
      answer: { type: 'email' },
      saveTo: { kind: 'var', name: 'correo' },
      errorText: 'Ese correo no parece válido.',
      attempts: 2,
    }),
    node('h', 'handoff', { text: 'Una persona del equipo te escribe.', to: 'queue' }),
    node('e', 'end', { text: 'Gracias.' }),
  ],
  edges: [
    ['s', 'next', 'm'],
    ['m', 'next', 'b'],
    ['b', 'opt:si', 'q'],
    ['b', 'timeout', 'e'],
    ['q', 'next', 'h'],
  ].map(([from, port, to]) => ({ from, port, to })),
});

async function lab(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-recorridos-eval-'));
  const code = randomUUID();
  const server = await startServer({
    dir,
    env: { ADMIN_INVITE_CODE: code, AI_PROVIDER: '', CHANNEL_CONNECTOR: '', ...env },
  });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  assertSchemaCurrent(db);
  const origin = server.origin;
  const admin = await registerAdmin(origin, code);
  const api = (path, options = {}) => call(origin, path, { cookie: admin, ...options });
  const register = async (username, name) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  async function agent(username, brand) {
    const cookie = await register(username, 'Asesor ' + brand);
    const id = db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
    db.prepare("UPDATE users SET role='agent' WHERE id=?").run(id);
    db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(id, brand);
    return cookie;
  }
  async function conversation(brand) {
    const courseId = db.prepare('SELECT id FROM courses WHERE brand_id=? ORDER BY id LIMIT 1').get(brand).id;
    const cookie = await register('persona-' + brand, 'Ana Pérez Confidencial');
    return (await call(origin, '/api/conversations', { cookie, body: { courseId, channel: 'whatsapp' } })).conversation
      .id;
  }
  async function published(brandId) {
    let { flow } = await api('/api/chatflows', {
      body: { brandId, name: 'Venta ' + brandId, graph: graph(), clientRef: ref() },
      expected: 201,
    });
    ({ flow } = await api('/api/chatflows/' + flow.id + '/publish', { body: { expectedRevision: flow.revision } }));
    return flow;
  }
  // Una sesión con su bitácora: `steps` es [[evento, paso, salida|detalle, ms desde el inicio]].
  let seq = 0;
  function session(brandId, flowId, conv, { state = 'ended', outcome, at, steps, end }) {
    const id = 'ses' + ++seq;
    db.prepare(
      'INSERT INTO chatflow_sessions(id,brand_id,flow_id,flow_version,conversation_id,state,node_id,outcome,end_node_id,started_at,updated_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      brandId,
      flowId,
      1,
      conv,
      state,
      end,
      outcome ?? null,
      state === 'ended' ? end : null,
      at,
      at,
      state === 'ended' ? at + 1 : null,
    );
    for (const [event, nodeId, extra, ms] of steps) {
      const isPort = event === 'exit';
      db.prepare(
        'INSERT INTO chatflow_events(brand_id,session_id,flow_id,flow_version,node_id,event,port,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(brandId, id, flowId, 1, nodeId, event, isPort ? extra : null, isPort ? null : (extra ?? null), at + ms);
    }
    return id;
  }
  return { db, origin, api, agent, conversation, published, session };
}

const path = (to, ms = 0) => {
  // Recorre s → m → b y deja la sesión esperando en los botones.
  const out = [
    ['enter', 's', null, 0],
    ['exit', 's', 'next', 0],
    ['enter', 'm', null, 0],
    ['exit', 'm', 'next', 0],
    ['enter', 'b', null, 0],
    ['wait', 'b', 'choice', 1000],
  ];
  if (to === 'b') return out;
  return [
    ...out,
    ['input', 'b', 'consume', 1000 + ms],
    ['exit', 'b', 'opt:si', 1000 + ms],
    ['enter', 'q', null, 1000 + ms],
    ['wait', 'q', 'question', 2000 + ms],
  ];
};

test('rendimiento por paso: llegaron, siguieron, dónde se fueron, cuánto tardan y cómo terminaron; por marca y sin datos de personas', async t => {
  const L = await lab(t);
  const flow = await L.published('globalvet');
  const conv = await L.conversation('globalvet');
  const T = 1_000_000;
  // 1. pasa con una persona: tarda 5 s en los botones y 30 s en el correo
  L.session('globalvet', flow.id, conv, {
    outcome: 'handoff',
    at: T,
    end: 'h',
    steps: [
      ...path('q', 5000),
      ['input', 'q', 'answer', 2000 + 5000 + 30000],
      ['exit', 'q', 'next', 37000],
      ['enter', 'h', null, 37000],
      ['end', 'h', 'handoff', 37000],
    ],
  });
  // 2 y 3. dejan de contestar en los botones
  for (const i of [1, 2])
    L.session('globalvet', flow.id, conv, { outcome: 'timeout', at: T + i, end: 'b', steps: path('b') });
  // 4. escribe otra cosa en el correo (tarda 3 s en los botones y 20 s en contestar mal)
  L.session('globalvet', flow.id, conv, {
    outcome: 'left',
    at: T + 3,
    end: 'q',
    steps: [...path('q', 3000), ['miss', 'q', 'detour', 2000 + 3000 + 20000]],
  });
  // 5. una persona toma el chat en el correo (7 s y 10 s)
  L.session('globalvet', flow.id, conv, {
    outcome: 'human_takeover',
    at: T + 4,
    end: 'q',
    steps: [...path('q', 7000), ['input', 'q', 'answer', 2000 + 7000 + 10000]],
  });
  // 6. error en el mensaje; 7. sigue en curso en los botones
  L.session('globalvet', flow.id, conv, {
    outcome: 'error',
    at: T + 5,
    end: 'm',
    steps: [
      ['enter', 's', null, 0],
      ['exit', 's', 'next', 0],
      ['enter', 'm', null, 0],
      ['error', 'm', 'falló', 0],
    ],
  });
  L.session('globalvet', flow.id, conv, { state: 'waiting', at: T + 6, end: 'b', steps: path('b') });

  // Otra marca con su recorrido y una sesión: no se mezcla.
  const other = await L.published('odonteck');
  const otherConv = await L.conversation('odonteck');
  L.session('odonteck', other.id, otherConv, { outcome: 'timeout', at: T, end: 'b', steps: path('b') });

  const all = `/api/chatflows/${flow.id}/analytics?from=0&to=${T + 1000}`;
  const r = await L.api(all);
  assert.equal(r.version, 1, 'por omisión, la versión publicada');
  assert.deepEqual(r.versions, [{ version: 1, sessions: 7 }]);
  assert.deepEqual(r.sessions, {
    started: 7,
    completed: 0,
    handoff: 2,
    left: 1,
    dropped: 2,
    excluded: 1,
    inProgress: 1,
  });
  const ending = key => r.endings.find(e => e.key === key).n;
  assert.equal(ending('handoff'), 1);
  assert.equal(ending('human_takeover'), 1);
  assert.equal(ending('stopped_replying'), 2);
  assert.equal(ending('left'), 1);
  assert.equal(ending('error'), 1);
  assert.equal(ending('completed'), 0);
  const { b, q, h, m } = r.nodes;
  assert.equal(r.nodes.s.entered, 7);
  assert.equal(m.entered, 7);
  assert.equal(m.completed, 6);
  assert.equal(b.entered, 6);
  assert.equal(b.completed, 3);
  assert.deepEqual(b.ports, { 'opt:si': 3 });
  assert.equal(b.dropped, 2);
  assert.equal(b.lost, 2);
  assert.equal(b.responses, 3);
  assert.equal(b.medianResponseMs, 5000);
  assert.equal(q.entered, 3);
  assert.equal(q.completed, 1);
  assert.equal(q.left, 1);
  assert.equal(q.lost, 1);
  assert.equal(q.handoff, 1, 'la persona que tomó el chat cuenta como pase');
  assert.equal(q.medianResponseMs, 20000);
  assert.equal(h.entered, 1);
  assert.equal(h.handoff, 1);
  // lo más débil primero: en los botones se va 2 de 6
  assert.deepEqual(
    r.weakest.map(w => [w.nodeId, w.lost, w.entered]),
    [
      ['b', 2, 6],
      ['q', 1, 3],
    ],
  );
  // sólo cifras: ni nombres, ni conversaciones
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /Ana Pérez|Confidencial/);
  assert.ok(!text.includes(conv), 'no aparece la conversación');

  // periodo y versión
  assert.equal((await L.api(`/api/chatflows/${flow.id}/analytics?from=${T + 5}&to=${T + 1000}`)).sessions.started, 2);
  assert.equal(
    (await L.api(`/api/chatflows/${flow.id}/analytics?version=2&from=0&to=${T + 1000}`)).sessions.started,
    0,
  );
  assert.equal((await L.api(`/api/chatflows/${flow.id}/analytics?version=all&from=0&to=${T + 1000}`)).version, null);
  // la otra marca sólo ve lo suyo
  const o = await L.api(`/api/chatflows/${other.id}/analytics?from=0&to=${T + 1000}`);
  assert.equal(o.sessions.started, 1);
  assert.equal(o.nodes.b.entered, 1);

  // alcance por marca: un asesor de GlobalVet lee lo suyo; OdonTeck no existe para él
  const gv = await L.agent('asesor-gv', 'globalvet');
  assert.equal((await call(L.origin, all, { cookie: gv })).sessions.started, 7);
  await call(L.origin, `/api/chatflows/${other.id}/analytics`, { cookie: gv, expected: 404 });
  // la lista dice que no puede editar, y las sugerencias (que gastan) son de quien edita
  const list = await call(L.origin, '/api/chatflows', { cookie: gv });
  assert.deepEqual(list.brands, [
    { id: 'globalvet', name: list.brands[0].name, canManage: false, attending: list.brands[0].attending },
  ]);
  assert.ok(list.unavailable.webhook, 'la pantalla sabe qué tipos de paso no están disponibles');
  assert.equal(typeof list.flows[0].publishedAt, 'number');
  await call(L.origin, `/api/chatflows/${flow.id}/suggestions`, { cookie: gv, body: {}, expected: 403 });
  // las listas de la marca para el editor
  const lists = (await L.api('/api/chatflows/lists?brand=globalvet')).lists;
  assert.ok(lists.courses.length > 0);
  assert.equal(lists.brand.id, 'globalvet');
  await call(L.origin, '/api/chatflows/lists?brand=odonteck', { cookie: gv, expected: 404 });

  // sin IA: lo dice y no falla; la revisión por reglas sí sale
  const s = await L.api(`/api/chatflows/${flow.id}/suggestions`, { body: {} });
  assert.equal(s.ai.available, false);
  assert.match(s.ai.reason, /no está configurada/);
  assert.ok(s.suggestions.some(x => x.source === 'rules' && x.kind === 'length' && x.nodeId === 'm'));
  assert.equal(
    L.db.prepare("SELECT count(*) n FROM audit WHERE action='ai.call'").get().n,
    0,
    'sin IA no se registra ninguna llamada',
  );
});

test('¿atiende la marca con recorridos?: la misma regla que el motor, con su motivo y dónde se enciende', async t => {
  const L = await lab(t);
  const flow = await L.published('globalvet');
  const brand = async () =>
    (await L.api('/api/chatflows?brand=globalvet')).brands.find(b => b.id === 'globalvet').attending;
  // pedir los recorridos de una marca no acorta la lista de marcas: la pantalla necesita todas para su selector
  const one = await L.api('/api/chatflows?brand=globalvet');
  const every = await L.api('/api/chatflows');
  assert.ok(every.brands.length > 1, 'la administración ve varias marcas');
  assert.deepEqual(
    one.brands.map(b => b.id),
    every.brands.map(b => b.id),
  );
  assert.ok(
    one.flows.every(f => f.brandId === 'globalvet'),
    'los recorridos sí vienen sólo de la marca pedida',
  );
  // apagada por omisión
  let a = await brand();
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'automation_off');
  assert.match(a.where, /Operación → Ventas y cobro → Seguimientos → Automatización/);
  assert.match(a.info, /modo real de esta marca está apagado.*avisos de prueba/, 'sólo información: sí atiende');
  assert.doesNotMatch(a.info, /WhatsApp real está apagado/, 'no dice que el canal esté apagado');
  assert.deepEqual((await L.api('/api/chatflows/' + flow.id)).attending, a, 'el detalle dice lo mismo');
  // encendida
  const current = (await L.api('/api/automation')).brands.find(b => b.id === 'globalvet');
  await L.api('/api/automation/brands/globalvet', {
    method: 'PATCH',
    body: { enabled: true, expectedRevision: current.revision },
  });
  a = await brand();
  assert.equal(a.ok, true);
  assert.equal(a.reason, null);
  // el asistente sólo sugiere: tampoco atiende
  const setMode = async mode => {
    const cur = (await L.api('/api/replies/settings')).settings.find(x => x.brand_id === 'globalvet');
    await L.api('/api/replies/brands/globalvet', { method: 'PATCH', body: { mode, expectedRevision: cur.revision } });
  };
  await setMode('suggest');
  a = await brand();
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'assistant_mode');
  assert.match(a.where, /Nivel de respuestas/);
  // pausa global
  await setMode('templates');
  L.db.prepare('UPDATE automation_global SET paused=1 WHERE id=1').run();
  a = await brand();
  assert.equal(a.reason, 'automation_paused');
});

test('lo que se manda a la IA: sólo la estructura y cifras, con correos y teléfonos tapados', () => {
  const outline = outlineOf(graph(), { b: { entered: 6, completed: 3, lost: 2, medianResponseMs: 5000 } });
  assert.deepEqual(
    outline.map(s => s.step + ':' + s.id),
    ['1:s', '2:m', '3:b', '4:q', '5:h', '6:e'],
  );
  const b = outline.find(s => s.id === 'b');
  assert.deepEqual(b.stats, { entered: 6, continued: 3, left: 2, medianResponseSeconds: 5 });
  assert.deepEqual(b.exits.find(x => x.to === 4).label, 'Sí, me interesa');
  const sent = JSON.stringify(outline);
  assert.doesNotMatch(sent, /ventas@ejemplo\.mx|1234 5678/);
  assert.match(sent, /\[correo\]/);
  assert.equal(mask('Llama al +52 (55) 1234-5678'), 'Llama al [número]');
});

test('sugerencias con IA: proveedor de mentira, cuenta contra el tope, se detiene al alcanzarlo y la respuesta es sólo texto', async t => {
  const seen = [];
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      seen.push(raw);
      const answer = {
        sugerencias: [
          { paso: 2, tipo: 'length', texto: 'El saludo es muy largo: <b>acórtalo</b>.' },
          { paso: 3, tipo: 'drop', texto: 'En los botones se va un tercio: añade «Hablar con una persona».' },
          { paso: 99, tipo: 'inventado', texto: 'Algo general.' },
          { paso: 3, tipo: 'tone', texto: '' },
        ],
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_prueba',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [{ type: 'text', text: JSON.stringify(answer) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 40, output_tokens: 20 },
        }),
      );
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => stub.close(r)));
  const L = await lab(t, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'sk-ant-api03-valor-de-prueba',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + stub.address().port,
    AI_MONTHLY_CALL_LIMIT: '1',
  });
  const flow = await L.published('globalvet');
  const conv = await L.conversation('globalvet');
  L.session('globalvet', flow.id, conv, { outcome: 'timeout', at: Date.now() - 1000, end: 'b', steps: path('b') });

  const r = await L.api(`/api/chatflows/${flow.id}/suggestions`, { body: {} });
  assert.equal(r.ai.available, true);
  const ai = r.suggestions.filter(x => x.source === 'ai');
  assert.deepEqual(
    ai.map(x => [x.nodeId, x.kind]),
    [
      ['m', 'length'],
      ['b', 'drop'],
      [null, 'other'],
    ],
    'ligadas sólo a pasos que existen; un tipo desconocido queda como «otra»; sin texto no cuenta',
  );
  assert.equal(ai[0].text, 'El saludo es muy largo: <b>acórtalo</b>.', 'llega como texto: la pantalla lo escapa');
  assert.equal(r.sent.steps, 6);
  // lo que salió hacia la IA: la estructura y las cifras, nunca personas ni conversaciones
  assert.equal(seen.length, 1);
  const body = JSON.parse(seen[0]);
  const sent = JSON.stringify(body);
  assert.match(sent, /¿Te gustaría inscribirte\?/);
  assert.match(sent, /entered/);
  assert.doesNotMatch(sent, /Ana Pérez|Confidencial|ventas@ejemplo\.mx|1234 5678/);
  assert.ok(!sent.includes(conv), 'sin la conversación');
  // el uso se registra como las demás llamadas
  const calls = L.db
    .prepare("SELECT entity_id FROM audit WHERE action='ai.call'")
    .all()
    .map(x => JSON.parse(x.entity_id));
  assert.deepEqual(
    calls.map(c => [c.kind, c.in, c.out]),
    [['flow_review', 40, 20]],
  );
  // tope alcanzado (1 al mes): lo dice, no falla y no llama
  const again = await L.api(`/api/chatflows/${flow.id}/suggestions`, { body: {} });
  assert.equal(again.ai.available, false);
  assert.equal(again.ai.budget, true);
  assert.match(again.ai.reason, /tope mensual/);
  assert.equal(seen.length, 1);
  assert.ok(again.suggestions.every(x => x.source === 'rules'));
});
