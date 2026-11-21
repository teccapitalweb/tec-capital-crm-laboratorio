// Recorridos de conversación de punta a punta (docs/PLAN_RECORRIDOS.md): almacén con borrador y versiones, motor con
// esperas duraderas, preguntas, condiciones y pase a una persona, y sus reglas de seguridad, con el servidor real.
// Las esperas no dependen del reloj: la prueba mueve la hora de los pasos pendientes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, crash, openDb, registerAdmin, until, whatsappLab } from './helpers/crm.mjs';
import { NUMBER, metaText } from './helpers/fake-meta.mjs';

const MIGRATION = 'chatflows/0001-chatflows';
const ref = () => randomUUID();

// Recorrido «Venta de curso»: saludo, ficha del curso, espera, botones, inscripción, correo, condición y pase a una
// persona. «Ver el temario» lo contesta el asistente con el menú a la vista.
const node = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data });
function saleGraph(greeting = 'Hola, {{nombre}}. Gracias por tu interés en {{curso}}.') {
  return {
    v: 1,
    start: 'n1',
    variables: [{ name: 'correo', label: 'Correo', type: 'text' }],
    nodes: [
      node('n1', 'start'),
      node('n2', 'message', { parts: [{ kind: 'text', text: greeting }] }),
      node('n3', 'course_card', { text: '', flyer: true }),
      node('n4', 'delay', { seconds: 30 }),
      node('n5', 'buttons', {
        header: { kind: 'none' },
        text: '¿Te gustaría conocer el proceso de inscripción?',
        footer: '',
        options: [
          { id: 'si', label: 'Sí, me interesa', do: { type: 'goto' } },
          { id: 'tem', label: 'Ver el temario', do: { type: 'intent', intent: 'syllabus', stay: true } },
        ],
      }),
      node('n6', 'enroll'),
      node('n7', 'end', { text: '' }),
      node('n8', 'question', {
        text: 'Para apartar tu lugar, ¿me compartes tu correo?',
        answer: { type: 'email' },
        saveTo: { kind: 'var', name: 'correo' },
        errorText: 'Ese correo no parece válido. ¿Lo revisas?',
        attempts: 2,
      }),
      node('n9', 'condition', {
        cases: [
          {
            id: 'c1',
            label: 'Con correo',
            when: {
              mode: 'all',
              groups: [{ mode: 'all', items: [{ f: 'attr', key: 'var.correo', op: 'contains', value: 'example' }] }],
            },
          },
        ],
      }),
      node('n10', 'handoff', { text: 'Gracias. Una persona del equipo te escribe a {{var.correo}}.', to: 'queue' }),
      node('n11', 'end', { text: 'Te esperamos cuando quieras.' }),
    ],
    edges: [
      ['n1', 'next', 'n2'],
      ['n2', 'next', 'n3'],
      ['n3', 'next', 'n4'],
      ['n4', 'next', 'n5'],
      ['n5', 'opt:si', 'n6'],
      ['n5', 'timeout', 'n11'],
      ['n6', 'order', 'n7'],
      ['n6', 'manual', 'n8'],
      ['n8', 'next', 'n9'],
      ['n9', 'case:c1', 'n10'],
      ['n9', 'else', 'n11'],
    ].map(([from, port, to]) => ({ from, port, to })),
  };
}

// Servidor del laboratorio con administración, la automatización de GlobalVet encendida y ayudas para clientes.
async function lab(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-recorridos-'));
  const code = randomUUID();
  const env = { ADMIN_INVITE_CODE: code, AI_PROVIDER: '', CHANNEL_CONNECTOR: '' };
  const state = { server: await startServer({ dir, env }), db: null };
  t.after(async () => {
    try {
      state.db?.close();
    } catch {
      /* ya cerrada */
    }
    await state.server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = () => state.server.origin;
  const admin = await registerAdmin(origin(), code);
  state.db = openDb(dir);
  assertSchemaCurrent(state.db);
  const db = state.db;
  const api = (path, options = {}) => call(origin(), path, { cookie: admin, ...options });
  let n = 0;
  async function customer(name = 'Ana Pérez', courseId = 'aves') {
    const u = await call(origin(), '/api/auth/register', {
      body: { username: 'persona' + ++n, name, password: PASSWORD },
    });
    const conv = (
      await call(origin(), '/api/conversations', { cookie: u.cookie, body: { courseId, channel: 'whatsapp' } })
    ).conversation.id;
    const send = async text =>
      (
        await call(origin(), '/api/conversations/' + conv + '/messages', {
          cookie: u.cookie,
          body: { text, clientRef: ref() },
          expected: 201,
        })
      ).id;
    // Manda un mensaje y espera a que alguien (recorrido o asistente) lo atienda: devuelve su fila de reply_log.
    const say = async text => {
      const id = await send(text);
      const log = await until(
        () => db.prepare('SELECT * FROM reply_log WHERE trigger_message_id=?').get(id),
        'respuesta a «' + text + '»',
        { logs: () => state.server.logs() },
      );
      return { id, log, reply: log.reply_message_id ? message(log.reply_message_id) : null };
    };
    return { conv, cookie: u.cookie, send, say };
  }
  const message = id => {
    const m = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    return m && { ...m, buttons: m.buttons ? JSON.parse(m.buttons) : null };
  };
  const outgoing = conv =>
    db
      .prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_kind='automation' ORDER BY seq")
      .all(conv)
      .map(m => ({ ...m, buttons: m.buttons ? JSON.parse(m.buttons) : null }));
  const session = conv =>
    db.prepare('SELECT * FROM chatflow_sessions WHERE conversation_id=? ORDER BY started_at DESC').get(conv);
  const conversation = conv => db.prepare('SELECT * FROM conversations WHERE id=?').get(conv);
  // Adelanta los pasos pendientes de un recorrido en esa conversación (la espera «ya pasó») y espera a que corran.
  async function wake(conv, kind = null) {
    const steps = db
      .prepare("SELECT * FROM automation_steps WHERE conversation_id=? AND kind='flow.wake' AND state='pending'")
      .all(conv)
      .filter(s => !kind || JSON.parse(s.payload).kind === kind);
    assert.ok(steps.length, 'hay un paso pendiente del recorrido');
    const past = Date.now() - 1000;
    for (const s of steps)
      db.prepare('UPDATE automation_steps SET scheduled_at=?,next_attempt_at=? WHERE id=?').run(past, past, s.id);
    await until(
      () =>
        steps.every(s =>
          ['completed', 'cancelled', 'failed'].includes(
            db.prepare('SELECT state FROM automation_steps WHERE id=?').get(s.id).state,
          ),
        ),
      'el paso del recorrido corrió',
      { logs: () => state.server.logs() },
    );
  }
  async function enableAutomation(brandId = 'globalvet', enabled = true) {
    const current = (await api('/api/automation')).brands.find(b => b.id === brandId);
    await api('/api/automation/brands/' + brandId, {
      method: 'PATCH',
      body: { enabled, expectedRevision: current.revision },
    });
  }
  // Crea, guarda, publica y activa un recorrido; devuelve su vista.
  async function publishFlow({
    brandId = 'globalvet',
    name = 'Venta de curso',
    graph = saleGraph(),
    start = { type: 'first_message' },
    settings = {},
  } = {}) {
    let { flow } = await api('/api/chatflows', {
      body: { brandId, name, graph, start, settings, clientRef: ref() },
      expected: 201,
    });
    ({ flow } = await api('/api/chatflows/' + flow.id + '/publish', { body: { expectedRevision: flow.revision } }));
    ({ flow } = await api('/api/chatflows/' + flow.id + '/activate', { body: { expectedRevision: flow.revision } }));
    return flow;
  }
  return {
    state,
    db,
    origin,
    admin,
    api,
    customer,
    message,
    outgoing,
    session,
    conversation,
    wake,
    enableAutomation,
    publishFlow,
    dir,
    env,
  };
}

test('migración chatflows/0001 sobre una base ya publicada: tablas nuevas, aditiva y una sola vez', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-recorridos-mig-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const db = openDatabase(dir);
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== MIGRATION)) });
  const before = db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'chatflow%'").get().n;
  assert.equal(before, 0);
  const conversations = db.prepare('SELECT count(*) n FROM conversations').get().n;
  assert.deepEqual(migrate(db, { backup: false }).applied, [MIGRATION]);
  assertSchemaCurrent(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chatflow%' ORDER BY name")
    .all()
    .map(r => r.name);
  assert.deepEqual(tables, ['chatflow_events', 'chatflow_sessions', 'chatflow_versions', 'chatflows']);
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, conversations);
  assert.deepEqual(migrate(db, { backup: false }).applied, [], 'no se aplica dos veces');
  // una base nueva y una actualizada quedan con el mismo esquema
  const fresh = await mkdtemp(join(tmpdir(), 'crm-recorridos-nueva-'));
  t.after(() => rm(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const other = openDatabase(fresh);
  migrate(other, { backup: false });
  assert.deepEqual(schemaShape(db), schemaShape(other));
  other.close();
  db.close();
});

test('almacén: borrador, validación, versiones, activar y pausar, duplicar, archivar, permisos y simulación sin efectos', async t => {
  const L = await lab(t);
  const { api, db } = L;
  // Sin clientRef no se crea; con el mismo clientRef no se duplica.
  await api('/api/chatflows', { body: { brandId: 'globalvet', name: 'Sin referencia' }, expected: 400 });
  const clientRef = ref();
  const created = await api('/api/chatflows', {
    body: { brandId: 'globalvet', name: 'Venta de curso', graph: saleGraph(), clientRef },
    expected: 201,
  });
  const again = await api('/api/chatflows', { body: { brandId: 'globalvet', name: 'Otra', clientRef } });
  assert.equal(again.flow.id, created.flow.id);
  assert.equal(again.duplicate, true);
  let flow = created.flow;
  assert.equal(flow.status, 'draft');
  assert.equal(flow.publishedVersion, null);
  assert.deepEqual(flow.start, { type: 'manual' }, 'nace sin inicio automático');
  // Un cliente no ve los recorridos; otra marca no existe para nadie que no la tenga.
  const outsider = await L.customer('Curioso');
  await call(L.origin(), '/api/chatflows', { cookie: outsider.cookie, expected: 403 });
  await call(L.origin(), '/api/chatflows/' + flow.id, { cookie: outsider.cookie, expected: 403 });
  await call(L.origin(), '/api/chatflows', {
    cookie: outsider.cookie,
    body: { brandId: 'globalvet', name: 'x', clientRef: ref() },
    expected: 403,
  });
  // No se activa sin publicar.
  await api('/api/chatflows/' + flow.id + '/activate', { body: { expectedRevision: flow.revision }, expected: 409 });
  // Guardar con revisión vieja: 409. Un paso que el servidor no ejecuta se rechaza al publicar con su motivo.
  const withWebhook = saleGraph();
  withWebhook.nodes.push(node('w1', 'webhook', { method: 'GET', url: 'https://ejemplo.mx/x' }));
  withWebhook.edges.find(e => e.from === 'n9' && e.port === 'else').to = 'w1';
  const saved = await api('/api/chatflows/' + flow.id + '/draft', {
    method: 'PUT',
    body: { graph: withWebhook, expectedRevision: flow.revision },
  });
  assert.ok(saved.issues.errors.some(e => e.code === 'unsupported' && e.nodeId === 'w1'));
  await api('/api/chatflows/' + flow.id + '/draft', {
    method: 'PUT',
    body: { name: 'Tarde', expectedRevision: flow.revision },
    expected: 409,
  });
  flow = saved.flow;
  const rejected = await api('/api/chatflows/' + flow.id + '/publish', {
    body: { expectedRevision: flow.revision },
    expected: 422,
  });
  assert.equal(rejected.code, 'flow_invalid');
  assert.ok(rejected.details.issues.errors.some(e => /servicios externos/.test(e.message)));
  // Un ciclo sin espera y un botón demasiado largo los marca el modelo compartido.
  const loop = saleGraph();
  loop.edges.find(e => e.from === 'n9' && e.port === 'else').to = 'n9';
  loop.nodes.find(x => x.id === 'n5').data.options[0].label = 'Una opción con demasiado texto';
  const checked = await api('/api/chatflows/' + flow.id + '/validate', { body: { graph: loop } });
  assert.equal(checked.ok, false);
  assert.ok(checked.issues.errors.some(e => e.code === 'node' && e.nodeId === 'n5'));
  assert.ok(
    checked.issues.errors.some(e => e.code === 'loop'),
    'un ciclo que no espera a la persona',
  );
  // Límites del modelo en el servidor: demasiados pasos no se guardan.
  const huge = saleGraph();
  for (let i = 0; i < 80; i += 1) huge.nodes.push(node('z' + i, 'end', { text: 'Fin' }));
  await api('/api/chatflows/' + flow.id + '/draft', {
    method: 'PUT',
    body: { graph: huge, expectedRevision: flow.revision },
    expected: 400,
  });
  // Publicar congela la versión 1; un cambio posterior del borrador no la toca; publicar otra vez da la 2.
  ({ flow } = await api('/api/chatflows/' + flow.id + '/draft', {
    method: 'PUT',
    body: { graph: saleGraph(), start: { type: 'keyword', keywords: ['aves'] }, expectedRevision: flow.revision },
  }));
  let published = await api('/api/chatflows/' + flow.id + '/publish', {
    body: { expectedRevision: flow.revision, note: 'Primera' },
  });
  assert.equal(published.version, 1);
  flow = published.flow;
  ({ flow } = await api('/api/chatflows/' + flow.id + '/draft', {
    method: 'PUT',
    body: { graph: saleGraph('Hola de nuevo, {{nombre}}.'), expectedRevision: flow.revision },
  }));
  const v1 = (await api('/api/chatflows/' + flow.id + '/versions/1')).version;
  assert.match(v1.graph.nodes.find(x => x.id === 'n2').data.parts[0].text, /Gracias por tu interés/);
  assert.deepEqual(v1.start, { type: 'keyword', keywords: ['aves'], mode: 'contains' });
  published = await api('/api/chatflows/' + flow.id + '/publish', { body: { expectedRevision: flow.revision } });
  assert.equal(published.version, 2);
  flow = published.flow;
  const detail = await api('/api/chatflows/' + flow.id);
  assert.deepEqual(
    detail.versions.map(v => v.version),
    [2, 1],
  );
  // Activar, pausar; duplicar copia el borrador sin versiones; archivar lo saca de la lista.
  ({ flow } = await api('/api/chatflows/' + flow.id + '/activate', { body: { expectedRevision: flow.revision } }));
  assert.equal(flow.status, 'active');
  ({ flow } = await api('/api/chatflows/' + flow.id + '/pause', { body: { expectedRevision: flow.revision } }));
  assert.equal(flow.status, 'paused');
  const copyRef = ref();
  const copy = await api('/api/chatflows/' + flow.id + '/duplicate', { body: { clientRef: copyRef }, expected: 201 });
  assert.equal(copy.flow.name, 'Venta de curso (copia)');
  assert.equal(copy.flow.publishedVersion, null);
  assert.equal(copy.flow.status, 'draft');
  ({ flow } = await api('/api/chatflows/' + flow.id + '/archive', { body: { expectedRevision: flow.revision } }));
  assert.equal(flow.status, 'archived');
  const listed = (await api('/api/chatflows?brand=globalvet')).flows.map(f => f.id);
  assert.deepEqual(listed, [copy.flow.id]);
  assert.equal((await api('/api/chatflows?brand=odonteck')).flows.length, 0, 'otra marca no ve los de GlobalVet');
  // Simular no escribe ni envía nada: ni sesiones, ni mensajes, ni pasos.
  const counts = () =>
    ['chatflow_sessions', 'messages', 'automation_steps', 'chatflow_events'].map(
      table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
    );
  const before = counts();
  let sim = await api('/api/chatflows/' + copy.flow.id + '/simulate', { body: {} });
  assert.equal(sim.waiting.kind, 'choice');
  assert.match(sim.messages[0].text, /^Hola de nuevo/, 'la copia lleva el último borrador');
  assert.ok(
    sim.messages.some(m => m.flyer),
    'la ficha sale con el flyer del catálogo',
  );
  assert.ok(sim.notes.some(note => /Esperaría 30 s/.test(note)));
  sim = await api('/api/chatflows/' + copy.flow.id + '/simulate', {
    body: { state: sim.state, input: { optionId: 'si' } },
  });
  assert.equal(sim.waiting.kind, 'question');
  sim = await api('/api/chatflows/' + copy.flow.id + '/simulate', {
    body: { state: sim.state, input: { text: 'ana@example.com' } },
  });
  assert.equal(sim.ended, true);
  assert.equal(sim.outcome, 'handoff');
  assert.match(sim.messages.at(-1).text, /ana@example\.com/);
  // Un estado fabricado no salta la validación: lo que espera el paso se arma desde el grafo guardado (aquí, un
  // correo), no desde la expresión que trae el estado; y la respuesta llega en tiempo acotado.
  const evil = '(a+)+$';
  const started = Date.now();
  sim = await api('/api/chatflows/' + copy.flow.id + '/simulate', {
    body: {
      state: {
        nodeId: 'n8',
        seq: 1,
        vars: { correo: 'x', 'mal nombre': 'y' },
        waiting: { kind: 'question', answer: { type: 'regex', pattern: evil } },
      },
      input: { text: 'a'.repeat(40) + '!' },
    },
  });
  assert.ok(Date.now() - started < 5000, 'responde en tiempo acotado');
  assert.equal(sim.waiting.kind, 'question');
  assert.match(sim.messages.at(-1).text, /no parece válido/);
  assert.deepEqual(sim.state.vars, { correo: 'x' });
  await api('/api/chatflows/' + copy.flow.id + '/simulate', {
    body: { state: { nodeId: 'n2', seq: 1, vars: {} }, input: { text: 'hola' } },
    expected: 400,
  });
  // Una expresión con cuantificadores anidados no se publica, ni se prueba sin guardar.
  const risky = saleGraph();
  risky.nodes.find(x => x.id === 'n8').data.answer = { type: 'regex', pattern: evil };
  for (const pattern of [evil, '(a|aa)+$', '(a?){30}a{30}', '(\\w)\\1', 'a*a*a*a*a*a*b']) {
    risky.nodes.find(x => x.id === 'n8').data.answer = { type: 'regex', pattern };
    const riskyCheck = await api('/api/chatflows/' + copy.flow.id + '/validate', { body: { graph: risky } });
    assert.ok(
      riskyCheck.issues.errors.some(e => e.nodeId === 'n8'),
      pattern,
    );
  }
  risky.nodes.find(x => x.id === 'n8').data.answer = { type: 'regex', pattern: evil };
  await api('/api/chatflows/' + copy.flow.id + '/simulate', { body: { graph: risky }, expected: 422 });
  // Probar un grafo sin guardar es de quien edita recorridos.
  await call(L.origin(), '/api/chatflows/' + copy.flow.id + '/simulate', {
    cookie: outsider.cookie,
    body: { graph: saleGraph() },
    expected: 403,
  });
  assert.deepEqual(counts(), before);
  // Bitácora de auditoría.
  const audited = db
    .prepare("SELECT action FROM audit WHERE action LIKE 'chatflow.%'")
    .all()
    .map(r => r.action);
  for (const action of [
    'chatflow.created',
    'chatflow.draft',
    'chatflow.published',
    'chatflow.activate',
    'chatflow.archive',
  ])
    assert.ok(audited.includes(action), action);
});

test('venta de curso de punta a punta: saludo, espera, botones, desvío, versión fija, inscripción, correo y pase a una persona', async t => {
  const L = await lab(t);
  const { api, db } = L;
  // Sin recorridos publicados todo responde como hoy, aun con la automatización encendida.
  await L.enableAutomation();
  const plain = await L.customer('Beto Ruiz');
  const first = await plain.say('Hola');
  assert.notEqual(first.log.intent, 'flow');
  assert.equal(L.session(plain.conv), undefined);
  // Con la automatización apagada el recorrido publicado no atiende.
  await L.enableAutomation('globalvet', false);
  const flow = await L.publishFlow();
  const off = await L.customer('Carla Díaz');
  assert.notEqual((await off.say('Hola')).log.intent, 'flow');
  assert.equal(L.session(off.conv), undefined);
  await L.enableAutomation();

  const ana = await L.customer('Ana Pérez');
  const hello = await ana.say('Hola');
  assert.equal(hello.log.intent, 'flow');
  assert.match(hello.reply.text, /^Hola, Ana\. Gracias por tu interés en /);
  let out = L.outgoing(ana.conv);
  assert.equal(out.length, 2);
  assert.ok(out[1].flyer_course_id, 'la ficha sale con el flyer vigente del catálogo');
  let s = L.session(ana.conv);
  assert.equal(s.state, 'delayed');
  assert.equal(s.flow_version, 1);
  // La espera corre con un paso duradero (no un temporizador en memoria).
  await L.wake(ana.conv, 'delay');
  out = L.outgoing(ana.conv);
  assert.deepEqual(out.at(-1).buttons, ['Sí, me interesa', 'Ver el temario']);
  assert.equal(L.session(ana.conv).state, 'waiting');
  // Una versión nueva no cambia la sesión en curso.
  let current = (await api('/api/chatflows/' + flow.id)).flow;
  current = (
    await api('/api/chatflows/' + flow.id + '/draft', {
      method: 'PUT',
      body: { graph: saleGraph('Versión dos'), expectedRevision: current.revision },
    })
  ).flow;
  assert.equal(
    (await api('/api/chatflows/' + flow.id + '/publish', { body: { expectedRevision: current.revision } })).version,
    2,
  );
  // «Ver el temario» lo contesta el asistente con el menú a la vista; no cuenta como fallo.
  const syllabus = await ana.say('Ver el temario');
  assert.equal(syllabus.log.intent, 'syllabus');
  assert.deepEqual(syllabus.reply.buttons, ['Sí, me interesa', 'Ver el temario']);
  // Algo inesperado: contesta el asistente y vuelve a ofrecer las opciones (un fallo).
  const odd = await ana.say('mi gato se llama Pelusa');
  assert.notEqual(odd.log.intent, 'flow');
  assert.deepEqual(odd.reply.buttons, ['Sí, me interesa', 'Ver el temario']);
  assert.equal(JSON.parse(L.session(ana.conv).waiting).misses, 1);
  // Elige inscribirse: la venta en línea está apagada, así que sale por «Pago manual» y pregunta el correo.
  const yes = await ana.say('Sí, me interesa');
  assert.equal(yes.log.intent, 'flow');
  assert.match(yes.reply.text, /me compartes tu correo/);
  assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n, 0, 'nunca crea ni confirma un pago por su cuenta');
  const wrong = await ana.say('no-es-correo');
  assert.match(wrong.reply.text, /no parece válido/);
  const done = await ana.say('ana@example.com');
  assert.equal(done.log.action, 'escalated');
  assert.match(done.reply.text, /ana@example\.com/);
  s = L.session(ana.conv);
  assert.equal(s.state, 'ended');
  assert.equal(s.outcome, 'handoff');
  assert.equal(s.flow_version, 1, 'terminó con la versión con la que empezó');
  assert.equal(JSON.parse(s.vars).correo, 'ana@example.com');
  const c = L.conversation(ana.conv);
  assert.deepEqual([c.bot_enabled, c.status], [0, 'waiting']);
  // Bitácora del recorrido y sesiones por la API.
  const sessions = (await api('/api/chatflows/' + flow.id + '/sessions')).sessions;
  const mine = sessions.find(x => x.conversationId === ana.conv);
  assert.equal(mine.outcome, 'handoff');
  const trace = (await api('/api/chatflows/' + flow.id + '/sessions/' + mine.id)).events;
  for (const id of ['n2', 'n3', 'n4', 'n5', 'n6', 'n8', 'n9', 'n10'])
    assert.ok(
      trace.some(e => e.node_id === id && e.event === 'enter'),
      id,
    );
  assert.equal((await api('/api/chatflows/conversations/' + ana.conv)).session, null);

  // Sin respuesta: el tiempo límite de los botones sigue por «Sin respuesta».
  const quiet = await L.customer('Dora Luna');
  await quiet.say('Hola');
  await L.wake(quiet.conv, 'delay');
  await L.wake(quiet.conv, 'timeout');
  s = L.session(quiet.conv);
  assert.equal(s.outcome, 'completed');
  assert.equal(L.outgoing(quiet.conv).at(-1).text, 'Te esperamos cuando quieras.');

  // Dos respuestas inesperadas seguidas: el recorrido termina («salió escribiendo») y el asistente sigue.
  const chatty = await L.customer('Eva Mora');
  await chatty.say('Hola');
  await L.wake(chatty.conv, 'delay');
  await chatty.say('mi gato se llama Pelusa');
  const second = await chatty.say('y mi perro Firulais');
  assert.equal(L.session(chatty.conv).outcome, 'left');
  assert.equal(second.reply?.buttons?.includes('Ver el temario') ?? false, false);

  // Una persona del equipo toma el chat: la sesión termina y el recorrido no vuelve a hablar.
  const taken = await L.customer('Fer Ríos');
  await taken.say('Hola');
  await L.wake(taken.conv, 'delay');
  await api('/api/conversations/' + taken.conv + '/messages', {
    body: { text: 'Te atiendo yo', clientRef: ref() },
    expected: 201,
  });
  assert.equal(L.session(taken.conv).outcome, 'human_takeover');
  const after = await taken.send('Sí, me interesa');
  assert.equal(db.prepare('SELECT count(*) n FROM jobs WHERE message_id=?').get(after).n, 0);
  assert.equal(
    db.prepare("SELECT count(*) n FROM automation_steps WHERE conversation_id=? AND state='pending'").get(taken.conv).n,
    0,
  );

  // La persona pide la baja: la sesión termina y el asistente confirma la baja una sola vez.
  const leaving = await L.customer('Gil Soto');
  await leaving.say('Hola');
  await L.wake(leaving.conv, 'delay');
  const bye = await leaving.say('baja');
  assert.equal(L.session(leaving.conv).outcome, 'opt_out');
  assert.equal(bye.log.intent, 'opt_out');

  // Falla el motor (la versión de la sesión desapareció): el mensaje se guarda, se registra y pasa a una persona.
  const broken = await L.customer('Hugo Paz');
  await broken.say('Hola');
  await L.wake(broken.conv, 'delay');
  db.prepare('UPDATE chatflow_sessions SET flow_version=99 WHERE conversation_id=?').run(broken.conv);
  const failed = await broken.say('Sí, me interesa');
  assert.ok(L.message(failed.id), 'el mensaje de la persona quedó guardado');
  assert.equal(failed.log.action, 'escalated');
  assert.ok(failed.reply, 'la persona recibe un mensaje: nunca se queda sin respuesta');
  assert.equal(L.session(broken.conv).outcome, 'error');
  assert.deepEqual([L.conversation(broken.conv).bot_enabled, L.conversation(broken.conv).status], [0, 'waiting']);
  assert.ok(db.prepare("SELECT 1 FROM automation_events WHERE kind='chatflow_error'").get());

  // La automatización de la marca se apaga con una sesión en curso: la sesión termina y contesta el asistente.
  const paused = await L.customer('Iris Vega');
  await paused.say('Hola');
  await L.wake(paused.conv, 'delay');
  await L.enableAutomation('globalvet', false);
  const plainAgain = await paused.say('Sí, me interesa');
  assert.notEqual(plainAgain.log.intent, 'flow');
  assert.equal(L.session(paused.conv).outcome, 'automation_off');
  await L.enableAutomation();

  // Ventana cerrada (canal simulado con la regla de 24 horas): la espera vence y el recorrido no escribe.
  const late = await L.customer('Juan Lara');
  await late.say('Hola');
  db.prepare(
    "INSERT INTO channel_settings(brand_id,enabled,enforce_window,delivery_delay_ms,failure_rate,revision,updated_by,updated_at) VALUES('globalvet',1,1,0,0,1,NULL,?) ON CONFLICT(brand_id) DO UPDATE SET enabled=1,enforce_window=1",
  ).run(Date.now());
  db.prepare("UPDATE messages SET created_at=created_at-? WHERE conversation_id=? AND sender_kind='customer'").run(
    25 * 3600_000,
    late.conv,
  );
  const sentBefore = L.outgoing(late.conv).length;
  await L.wake(late.conv, 'delay');
  assert.equal(L.session(late.conv).outcome, 'window_closed');
  assert.equal(L.outgoing(late.conv).length, sentBefore);
  db.prepare("UPDATE channel_settings SET enabled=0 WHERE brand_id='globalvet'").run();

  // Dos marcas no se mezclan: un recorrido de OdonTeck que atiende cualquier mensaje no toca a GlobalVet.
  await L.enableAutomation('odonteck');
  const odon = await L.publishFlow({ brandId: 'odonteck', name: 'OdonTeck', start: { type: 'any_message' } });
  const gv = await L.customer('Kim Ortiz');
  await gv.say('Hola');
  assert.notEqual(L.session(gv.conv).flow_id, odon.id);
  const od = await L.customer('Lia Cano', 'odontologia');
  const odHello = await od.say('Buenas tardes');
  assert.equal(odHello.log.intent, 'flow');
  assert.equal(L.session(od.conv).flow_id, odon.id);
  assert.equal(
    db.prepare("SELECT count(*) n FROM chatflow_events WHERE brand_id='globalvet' AND flow_id=?").get(odon.id).n,
    0,
  );
});

test('una espera sobrevive a un reinicio y un reintento del reloj no repite el mensaje', async t => {
  const L = await lab(t);
  const { db } = L;
  await L.enableAutomation();
  await L.publishFlow();
  const ana = await L.customer('Ana Pérez');
  await ana.say('Hola');
  assert.equal(L.session(ana.conv).state, 'delayed');
  // Muerte brusca con la espera pendiente; la hora del paso ya pasó cuando el servidor vuelve.
  await crash(L.state.server);
  const step = db
    .prepare("SELECT * FROM automation_steps WHERE conversation_id=? AND kind='flow.wake' AND state='pending'")
    .get(ana.conv);
  db.prepare('UPDATE automation_steps SET scheduled_at=?,next_attempt_at=? WHERE id=?').run(
    Date.now() - 1000,
    Date.now() - 1000,
    step.id,
  );
  L.state.server = await startServer({ dir: L.dir, env: L.env });
  const buttons = () => L.outgoing(ana.conv).filter(m => m.buttons);
  await until(() => buttons().length === 1, 'los botones salieron tras el reinicio', {
    logs: () => L.state.server.logs(),
  });
  assert.equal(L.session(ana.conv).state, 'waiting');
  // El mismo paso vuelve a quedar pendiente (un reintento del reloj): se cancela porque la sesión ya avanzó.
  db.prepare("UPDATE automation_steps SET state='pending',next_attempt_at=?,attempts=0 WHERE id=?").run(
    Date.now() - 1000,
    step.id,
  );
  await until(
    () => db.prepare('SELECT state,cancel_reason FROM automation_steps WHERE id=?').get(step.id).state === 'cancelled',
    'el reintento se canceló',
    { logs: () => L.state.server.logs() },
  );
  assert.equal(
    db.prepare('SELECT cancel_reason FROM automation_steps WHERE id=?').get(step.id).cancel_reason,
    'session_moved',
  );
  assert.equal(buttons().length, 1, 'un solo mensaje con botones');
  // Inicio manual desde el chat, con clientRef: un reintento no crea otra sesión; detenerla la termina.
  const flowId = L.session(ana.conv).flow_id;
  const bea = await L.customer('Bea Gil');
  const manualRef = ref();
  const manual = await L.api('/api/chatflows/conversations/' + bea.conv, {
    body: { flowId, clientRef: manualRef },
    expected: 201,
  });
  const repeat = await L.api('/api/chatflows/conversations/' + bea.conv, { body: { flowId, clientRef: manualRef } });
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.session.id, manual.session.id);
  await L.api('/api/chatflows/conversations/' + bea.conv, { body: { flowId, clientRef: ref() }, expected: 409 });
  assert.equal((await L.api('/api/chatflows/conversations/' + bea.conv)).session.id, manual.session.id);
  assert.equal((await L.api('/api/chatflows/conversations/' + bea.conv, { method: 'DELETE' })).stopped, true);
  assert.equal(L.session(bea.conv).outcome, 'stopped');
});

test('WhatsApp real: un webhook repetido no repite el recorrido y un número en modo escucha no lo inicia', async t => {
  const lab = await whatsappLab(t, { AI_PROVIDER: '' });
  const origin = lab.origin();
  const api = (path, options = {}) => call(origin, path, { cookie: lab.admin, ...options });
  const current = (await api('/api/automation')).brands.find(b => b.id === 'globalvet');
  await api('/api/automation/brands/globalvet', {
    method: 'PATCH',
    body: { enabled: true, expectedRevision: current.revision },
  });
  let { flow } = await api('/api/chatflows', {
    body: {
      brandId: 'globalvet',
      name: 'Venta',
      graph: saleGraph(),
      start: { type: 'first_message' },
      clientRef: ref(),
    },
    expected: 201,
  });
  ({ flow } = await api('/api/chatflows/' + flow.id + '/publish', { body: { expectedRevision: flow.revision } }));
  await api('/api/chatflows/' + flow.id + '/activate', { body: { expectedRevision: flow.revision } });
  const db = lab.db;
  const from = '5215511112222';
  assert.equal((await metaText(origin, from, 'wamid.recorrido.1', 'Hola')).status, 200);
  assert.equal((await metaText(origin, from, 'wamid.recorrido.1', 'Hola')).status, 200);
  const conv = await until(
    () => db.prepare("SELECT conversation_id id FROM chatflow_sessions WHERE brand_id='globalvet'").get()?.id,
    'el recorrido inició con el mensaje real',
  );
  await until(
    () => db.prepare('SELECT 1 FROM reply_log WHERE conversation_id=?').get(conv),
    'el recorrido atendió el mensaje',
  );
  assert.equal(db.prepare('SELECT count(*) n FROM chatflow_sessions WHERE conversation_id=?').get(conv).n, 1);
  assert.equal(
    db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND client_ref LIKE 'flow:%'").get(conv).n,
    2,
    'el saludo y la ficha, una sola vez',
  );
  // Modo escucha: lo que escribe otra persona se guarda para el corte, pero ningún recorrido le contesta.
  db.prepare("UPDATE wa_numbers SET mode='listen' WHERE phone_number_id=?").run(NUMBER);
  const before = db.prepare('SELECT count(*) n FROM chatflow_sessions').get().n;
  const heard = await metaText(origin, '5215533334444', 'wamid.recorrido.2', 'Hola');
  assert.match(heard.body.results[0].result, /^escucha/);
  assert.equal(db.prepare('SELECT count(*) n FROM chatflow_sessions').get().n, before);
});

test('la palabra clave otra vez, con el recorrido esperando una respuesta, lo empieza de nuevo', async t => {
  const L = await lab(t);
  const { db } = L;
  await L.enableAutomation();
  const flow = await L.publishFlow({ start: { type: 'keyword', keywords: ['aves'] } });
  const ana = await L.customer('Ana Pérez');
  assert.equal((await ana.say('Quiero info de aves')).log.intent, 'flow');
  await L.wake(ana.conv, 'delay');
  const first = L.session(ana.conv);
  assert.equal(first.state, 'waiting');
  // Otra cosa sigue siendo una respuesta que no se entendió: contesta el asistente y la sesión sigue esperando.
  assert.notEqual((await ana.say('mi gato se llama Pelusa')).log.intent, 'flow');
  assert.equal(L.session(ana.conv).id, first.id);
  // La palabra clave (como al tocar otra vez el anuncio): la atención anterior se cierra y el recorrido arranca.
  const before = L.outgoing(ana.conv).length;
  const again = await ana.say('aves');
  assert.equal(again.log.intent, 'flow');
  assert.match(again.reply.text, /^Hola, Ana\. Gracias por tu interés en /);
  const second = L.session(ana.conv);
  assert.notEqual(second.id, first.id);
  assert.equal(second.flow_id, flow.id);
  assert.equal(second.state, 'delayed');
  assert.ok(L.outgoing(ana.conv).length > before, 'el saludo salió otra vez');
  const closed = db.prepare('SELECT state,outcome FROM chatflow_sessions WHERE id=?').get(first.id);
  assert.deepEqual({ ...closed }, { state: 'ended', outcome: 'restarted' });
  // Empezar de nuevo no cuenta como terminar ni como abandonar: queda fuera de las tasas.
  const counts = (await L.api('/api/chatflows')).flows.find(f => f.id === flow.id).metrics;
  assert.equal(counts.excluded, 1);
  assert.equal(counts.left + counts.dropped + counts.completed, 0);

  // La ventana «Probar» hace lo mismo y lo anota.
  let sim = await L.api('/api/chatflows/' + flow.id + '/simulate', { body: {} });
  assert.equal(sim.waiting.kind, 'choice');
  sim = await L.api('/api/chatflows/' + flow.id + '/simulate', { body: { state: sim.state, input: { text: 'aves' } } });
  assert.ok(sim.notes.some(note => /empieza de nuevo/.test(note)));
  assert.ok(sim.messages.some(m => /Gracias por tu interés en /.test(m.text || '')));
  assert.equal(sim.waiting.kind, 'choice');
  sim = await L.api('/api/chatflows/' + flow.id + '/simulate', {
    body: { state: sim.state, input: { text: 'otra cosa' } },
  });
  assert.ok(!sim.notes.some(note => /empieza de nuevo/.test(note)), 'otra cosa sigue siendo un desvío');

  // Un recorrido de «una vez por conversación» no se reinicia: la palabra sigue contando como no entendida.
  const once = await L.publishFlow({
    name: 'Una vez',
    start: { type: 'keyword', keywords: ['perros'] },
    settings: { reentry: 'once_conversation' },
  });
  const luis = await L.customer('Luis Mora');
  assert.equal((await luis.say('perros')).log.intent, 'flow');
  await L.wake(luis.conv, 'delay');
  const only = L.session(luis.conv);
  assert.equal(only.flow_id, once.id);
  assert.notEqual((await luis.say('perros')).log.intent, 'flow');
  const still = L.session(luis.conv);
  assert.equal(still.id, only.id);
  assert.equal(JSON.parse(still.waiting).misses, 1);
});

// Paso «Inscribir en secuencia»: valida contra las secuencias de la marca, inscribe dentro de la transacción del
// recorrido una sola vez por sesión y paso, sigue aunque la persona no pueda entrar y el simulador no inscribe a nadie.
test('Inscribir en secuencia: valida, inscribe una vez, sigue si no puede entrar y la prueba no inscribe', async t => {
  const L = await lab(t);
  const { api, db } = L;
  await L.enableAutomation();
  // Una secuencia de GlobalVet (encendida, su primer paso al día siguiente) y otra de OdonTeck.
  async function sequence(brandId, title) {
    let { sequence: seq } = await api('/api/sequences', {
      body: {
        brandId,
        title,
        steps: [{ timing: { base: 'enrolled', amount: 1, unit: 'days' }, send: { kind: 'text', text: 'Hola' } }],
        clientRef: ref(),
      },
      expected: 201,
    });
    ({ sequence: seq } = await api('/api/sequences/' + seq.id + '/enable', {
      body: { expectedRevision: seq.revision },
    }));
    return seq;
  }
  const mine = await sequence('globalvet', 'Seguimiento de aves');
  const theirs = await sequence('odonteck', 'Seguimiento de OdonTeck');
  // Saludo → Inscribir en secuencia → «¿Algo más?» (volver a inscribir o terminar).
  const graph = sequenceId => ({
    v: 1,
    start: 'n1',
    variables: [],
    nodes: [
      node('n1', 'start'),
      node('n2', 'message', { parts: [{ kind: 'text', text: 'Hola, {{nombre}}.' }] }),
      node('n3', 'sequence', { sequenceId }),
      node('n4', 'buttons', {
        header: { kind: 'none' },
        text: '¿Algo más?',
        footer: '',
        options: [
          { id: 'otra', label: 'Otra vez', do: { type: 'goto' } },
          { id: 'listo', label: 'Listo', do: { type: 'goto' } },
        ],
      }),
      node('n5', 'end', { text: 'Gracias.' }),
    ],
    edges: [
      ['n1', 'next', 'n2'],
      ['n2', 'next', 'n3'],
      ['n3', 'next', 'n4'],
      ['n4', 'opt:otra', 'n3'],
      ['n4', 'opt:listo', 'n5'],
    ].map(([from, port, to]) => ({ from, port, to })),
  });

  // Validación con las listas reales de la marca: sin elegir o de otra marca impiden publicar.
  const draft = (
    await api('/api/chatflows', {
      body: { brandId: 'globalvet', name: 'Con secuencia', graph: graph(''), clientRef: ref() },
      expected: 201,
    })
  ).flow;
  const check = async sequenceId =>
    (await api('/api/chatflows/' + draft.id + '/validate', { body: { graph: graph(sequenceId) } })).issues;
  assert.ok((await check('')).errors.some(e => e.nodeId === 'n3' && /Elige la secuencia/.test(e.message)));
  assert.ok((await check(theirs.id)).errors.some(e => e.nodeId === 'n3' && /no existe en esta marca/.test(e.message)));
  assert.deepEqual((await check(mine.id)).errors, []);
  const lists = (await api('/api/chatflows/lists?brand=globalvet')).lists;
  assert.deepEqual(lists.sequences, [{ id: mine.id, name: 'Seguimiento de aves', enabled: true, archived: false }]);

  // Corre de verdad: inscribe con el origen «recorrido» y una referencia de la sesión y el paso, y sigue.
  const flow = await L.publishFlow({ name: 'Inscribe en secuencia', graph: graph(mine.id) });
  const enrollments = conv =>
    db.prepare('SELECT * FROM sequence_enrollments WHERE conversation_id=? ORDER BY started_at').all(conv);
  const exits = conv =>
    db
      .prepare(
        "SELECT e.detail FROM chatflow_events e JOIN chatflow_sessions s ON s.id=e.session_id WHERE s.conversation_id=? AND e.node_id='n3' AND e.event='exit' ORDER BY e.seq",
      )
      .all(conv)
      .map(r => r.detail);
  const ana = await L.customer('Ana Pérez');
  await ana.say('Hola');
  let s = L.session(ana.conv);
  assert.equal(s.state, 'waiting', 'siguió hasta los botones');
  assert.deepEqual(L.outgoing(ana.conv).at(-1).buttons, ['Otra vez', 'Listo']);
  let rows = enrollments(ana.conv);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].sequence_id, rows[0].source, rows[0].state, rows[0].client_ref],
    [mine.id, 'flow', 'active', `flow:${s.id}:n3`],
  );
  assert.deepEqual(exits(ana.conv), ['enrolled']);
  // Su primer paso queda para el día siguiente: no habla en medio del recorrido.
  const due = db
    .prepare("SELECT scheduled_at FROM automation_steps WHERE conversation_id=? AND kind='sequence.send'")
    .get(ana.conv).scheduled_at;
  assert.ok(due > Date.now() + 23 * 3600_000);
  // Volver al mismo paso en la misma sesión no inscribe otra vez.
  await ana.say('Otra vez');
  assert.equal(enrollments(ana.conv).length, 1);
  assert.deepEqual(exits(ana.conv), ['enrolled', 'duplicate']);
  assert.equal(L.session(ana.conv).state, 'waiting');
  await ana.say('Listo');
  s = L.session(ana.conv);
  assert.deepEqual([s.state, s.outcome], ['ended', 'completed']);
  assert.equal(L.outgoing(ana.conv).at(-1).text, 'Gracias.');

  // La misma persona empieza otra vez el recorrido (otra sesión, a mano desde el chat): ya está en esa secuencia,
  // así que no entra otra vez, y el recorrido sigue igual.
  await api('/api/chatflows/conversations/' + ana.conv, { body: { flowId: flow.id, clientRef: ref() }, expected: 201 });
  rows = enrollments(ana.conv);
  assert.equal(rows.length, 1);
  assert.equal(exits(ana.conv).at(-1), 'refused:already_enrolled');
  assert.equal(L.session(ana.conv).state, 'waiting', 'una negativa no detiene el recorrido');

  // Secuencia apagada: nadie entra y el recorrido sigue; el motivo queda en la salida del paso.
  const current = (await api('/api/sequences/' + mine.id)).sequence;
  await api('/api/sequences/' + mine.id + '/disable', { body: { expectedRevision: current.revision } });
  const beto = await L.customer('Beto Ruiz');
  await beto.say('Hola');
  assert.equal(enrollments(beto.conv).length, 0);
  assert.deepEqual(exits(beto.conv), ['refused:sequence_off']);
  assert.equal(L.session(beto.conv).state, 'waiting');
  assert.deepEqual(L.outgoing(beto.conv).at(-1).buttons, ['Otra vez', 'Listo']);
  // Apagada sólo avisa al revisar; publicar sigue permitido.
  const off = await check(mine.id);
  assert.deepEqual(off.errors, []);
  assert.ok(off.warnings.some(w => w.code === 'sequence_off' && w.nodeId === 'n3'));

  // Probar no inscribe a nadie: lo dice en una nota.
  const count = () => db.prepare('SELECT count(*) n FROM sequence_enrollments').get().n;
  const before = count();
  const sim = await api('/api/chatflows/' + flow.id + '/simulate', { body: {} });
  assert.ok(sim.notes.some(n => /entraría a la secuencia «Seguimiento de aves»/.test(n)));
  assert.equal(sim.waiting.kind, 'choice');
  assert.equal(count(), before);

  // Archivada: ya no se ofrece en el editor y no se puede publicar.
  const latest = (await api('/api/sequences/' + mine.id)).sequence;
  await api('/api/sequences/' + mine.id + '/archive', { body: { expectedRevision: latest.revision } });
  assert.ok((await check(mine.id)).errors.some(e => e.nodeId === 'n3' && /está archivada/.test(e.message)));
  assert.deepEqual((await api('/api/chatflows/lists?brand=globalvet')).lists.sequences, []);
});

// Paso «¿Qué curso te interesa?» (docs/PLAN_RECORRIDOS.md): con las piezas del asistente (su lista de cursos, su
// pregunta y su forma de leer la respuesta) y el cambio de curso de siempre (crm.moveConversation). Una conversación
// con el curso «por elegir» se prepara como la de un número que atiende toda la marca (course_pending = 1).
test('«¿Qué curso te interesa?»: pasa de largo, toma el del mensaje, pregunta, entiende la respuesta y lo usa después', async t => {
  const L = await lab(t);
  const { api, db } = L;
  await L.enableAutomation();
  const graph = (data = {}) => ({
    v: 1,
    start: 'n1',
    variables: [],
    nodes: [
      node('n1', 'start'),
      node('c', 'choose_course', { skipIfKnown: true, useMessage: true, attempts: 2, ...data }),
      node('card', 'course_card', { text: '', flyer: false }),
      node('ok', 'end', { text: 'Listo con {{curso}}.' }),
      node('no', 'end', { text: 'Sin curso: te escribe una persona.' }),
      node('late', 'end', { text: 'Se acabó el tiempo.' }),
    ],
    edges: [
      ['n1', 'next', 'c'],
      ['c', 'next', 'card'],
      ['c', 'none', 'no'],
      ['c', 'timeout', 'late'],
      ['card', 'next', 'ok'],
    ].map(([from, port, to]) => ({ from, port, to })),
  });
  // 10) ya no se rechaza al publicar
  const draft = (
    await api('/api/chatflows', {
      body: { brandId: 'globalvet', name: 'Curso', graph: graph(), clientRef: ref() },
      expected: 201,
    })
  ).flow;
  const issues = (await api('/api/chatflows/' + draft.id + '/validate', { body: { graph: graph() } })).issues;
  assert.deepEqual(
    issues.errors.filter(e => e.nodeId === 'c'),
    [],
  );
  const flow = await L.publishFlow({ name: 'Elige curso', graph: graph() });
  const titles = Object.fromEntries(
    db
      .prepare("SELECT id,title FROM courses WHERE brand_id='globalvet'")
      .all()
      .map(k => [k.id, k.title]),
  );
  const pending = async name => {
    const who = await L.customer(name);
    db.prepare('UPDATE conversations SET course_pending=1 WHERE id=?').run(who.conv);
    return who;
  };
  const texts = conv => L.outgoing(conv).map(m => m.text);
  const exits = conv =>
    db
      .prepare(
        "SELECT e.port,e.detail FROM chatflow_events e JOIN chatflow_sessions s ON s.id=e.session_id WHERE s.conversation_id=? AND e.node_id='c' AND e.event='exit' ORDER BY e.seq",
      )
      .all(conv)
      .map(r => [r.port, r.detail]);

  // 1) ya tiene un curso real: no pregunta y la ficha es la de su curso
  const ana = await L.customer('Ana Pérez');
  await ana.say('Hola');
  assert.deepEqual(exits(ana.conv), [['next', 'known']]);
  assert.ok(texts(ana.conv)[0].includes(titles.aves));
  assert.equal(texts(ana.conv).at(-1), `Listo con ${titles.aves}.`);

  // 2) curso por elegir y el primer mensaje lo nombra: lo toma sin preguntar y todo lo siguiente es de ese curso
  const beto = await pending('Beto Ruiz');
  await beto.say('Hola, quiero información del curso de nutrición');
  assert.deepEqual(exits(beto.conv), [['next', 'message']]);
  assert.deepEqual(
    { ...db.prepare('SELECT course_id,course_pending FROM conversations WHERE id=?').get(beto.conv) },
    { course_id: 'nutricion', course_pending: 0 },
  );
  assert.ok(texts(beto.conv)[0].includes(titles.nutricion), 'la ficha es la del curso elegido');
  assert.equal(texts(beto.conv).at(-1), `Listo con ${titles.nutricion}.`);
  assert.equal(
    db
      .prepare(
        'SELECT o.course_id FROM conversation_opportunities x JOIN opportunities o ON o.id=x.opportunity_id WHERE x.conversation_id=?',
      )
      .get(beto.conv).course_id,
    'nutricion',
    'el interés de relleno pasa al curso elegido',
  );

  // 3) y 4) no lo nombra: la pregunta del asistente, una sola vez; «el número» de la lista elige y la ficha es la suya
  const caro = await pending('Caro Díaz');
  const asked = await caro.say('Hola');
  assert.match(asked.reply.text, /Soy el asistente de GlobalVet\. ¿Sobre qué curso te gustaría información\?/);
  assert.equal(JSON.parse(L.session(caro.conv).waiting).kind, 'course');
  const line = asked.reply.text.split('\n').find(l => l.endsWith(titles.nutricion));
  await caro.say(line.split('.')[0]);
  assert.deepEqual(exits(caro.conv), [['next', 'answer']]);
  assert.equal(L.conversation(caro.conv).course_id, 'nutricion');
  assert.equal(texts(caro.conv).filter(x => /¿Sobre qué curso/.test(x)).length, 1, 'la pregunta salió una vez');
  assert.ok(texts(caro.conv).at(-2).includes(titles.nutricion));
  assert.equal(texts(caro.conv).at(-1), `Listo con ${titles.nutricion}.`);
  assert.equal(L.session(caro.conv).outcome, 'completed');

  // … o por su nombre
  const dani = await pending('Dani Gómez');
  await dani.say('Hola');
  await dani.say(titles.aves);
  assert.deepEqual(exits(dani.conv), [['next', 'answer']]);
  assert.deepEqual(
    { ...db.prepare('SELECT course_id,course_pending FROM conversations WHERE id=?').get(dani.conv) },
    { course_id: 'aves', course_pending: 0 },
  );

  // 5) lo que no es un curso: otra vez la pregunta; agotados los intentos, «Ninguno» y el curso sigue por elegir
  const eva = await pending('Eva Luna');
  await eva.say('Hola');
  await eva.say('no sé');
  assert.match(texts(eva.conv).at(-1), /^Para darte la información correcta necesito saber qué curso te interesa:/);
  await eva.say('lo que sea');
  assert.deepEqual(exits(eva.conv), [['none', 'invalid']]);
  assert.equal(texts(eva.conv).at(-1), 'Sin curso: te escribe una persona.');
  assert.equal(L.conversation(eva.conv).course_pending, 1);
  // un «no» sale por «Ninguno» en seguida
  const fer = await pending('Fer Soto');
  await fer.say('Hola');
  await fer.say('no gracias');
  assert.deepEqual(exits(fer.conv), [['none', 'declined']]);

  // 6) sin respuesta: la salida «Sin respuesta»
  const gil = await pending('Gil Mora');
  await gil.say('Hola');
  await L.wake(gil.conv, 'timeout');
  assert.equal(texts(gil.conv).at(-1), 'Se acabó el tiempo.');
  assert.equal(L.conversation(gil.conv).course_pending, 1);

  // 8) un solo curso que ofrecer: lo toma sin preguntar
  const hugo = await pending('Hugo Paz');
  db.prepare("UPDATE courses SET active=0 WHERE id='nutricion'").run();
  try {
    await hugo.say('Hola');
  } finally {
    db.prepare("UPDATE courses SET active=1 WHERE id='nutricion'").run();
  }
  assert.deepEqual(exits(hugo.conv), [['next', 'single']]);
  assert.equal(L.conversation(hugo.conv).course_pending, 0);
  assert.ok(!texts(hugo.conv).some(x => /¿Sobre qué curso/.test(x)));

  // 9) la prueba pregunta y deja contestar, sin mover ninguna conversación
  const snapshot = () => db.prepare('SELECT id,course_id,course_pending FROM conversations ORDER BY id').all();
  const before = JSON.stringify(snapshot());
  let sim = await api('/api/chatflows/' + flow.id + '/simulate', { body: {} });
  assert.equal(sim.waiting.kind, 'course');
  const simLine = sim.messages[0].text.split('\n').find(l => l.endsWith(titles.nutricion));
  sim = await api('/api/chatflows/' + flow.id + '/simulate', {
    body: { state: sim.state, input: { text: simLine.split('.')[0] } },
  });
  assert.ok(sim.notes.some(n => n.includes(`quedaría en el curso «${titles.nutricion}»`)));
  assert.ok(sim.messages.some(m => m.from === 'flow' && m.text.includes(titles.nutricion)));
  assert.equal(sim.outcome, 'completed');
  // con un curso elegido en la prueba, pasa de largo
  sim = await api('/api/chatflows/' + flow.id + '/simulate', { body: { courseId: 'aves' } });
  assert.equal(sim.waiting, null);
  assert.ok(sim.messages.some(m => m.text.includes(titles.aves)));
  assert.equal(JSON.stringify(snapshot()), before, 'la prueba no movió ninguna conversación');
});

// 7) Con un pedido vigente no se cambia de curso: se explica como lo hace el asistente y sale por «Ninguno».
test('«¿Qué curso te interesa?» con un pedido vigente: no cambia de curso y sale por «Ninguno»', async t => {
  const L = await lab(t);
  const { api } = L;
  await L.enableAutomation();
  const ps = (await api('/api/payments/settings')).settings.find(x => x.brand_id === 'globalvet');
  await api('/api/payments/brands/globalvet', {
    method: 'PATCH',
    body: { enabled: true, expectedRevision: ps.revision },
  });
  const enroll = await L.publishFlow({
    name: 'Inscribe',
    start: { type: 'manual' },
    graph: {
      v: 1,
      start: 'n1',
      variables: [],
      nodes: [node('n1', 'start'), node('e', 'enroll'), node('f', 'end', { text: '' })],
      edges: [
        { from: 'n1', port: 'next', to: 'e' },
        { from: 'e', port: 'order', to: 'f' },
      ],
    },
  });
  const choose = await L.publishFlow({
    name: 'Cambia de curso',
    start: { type: 'manual' },
    graph: {
      v: 1,
      start: 'n1',
      variables: [],
      nodes: [
        node('n1', 'start'),
        node('c', 'choose_course', { skipIfKnown: false, useMessage: false, attempts: 2 }),
        node('ok', 'end', { text: 'Listo.' }),
        node('no', 'end', { text: 'Seguimos con tu pedido.' }),
      ],
      edges: [
        { from: 'n1', port: 'next', to: 'c' },
        { from: 'c', port: 'next', to: 'ok' },
        { from: 'c', port: 'none', to: 'no' },
      ],
    },
  });
  const ana = await L.customer('Ana Pérez');
  await api('/api/chatflows/conversations/' + ana.conv, {
    body: { flowId: enroll.id, clientRef: ref() },
    expected: 201,
  });
  assert.match(L.outgoing(ana.conv).at(-1).text, /Pedido TC-/);
  await api('/api/chatflows/conversations/' + ana.conv, {
    body: { flowId: choose.id, clientRef: ref() },
    expected: 201,
  });
  assert.match(L.outgoing(ana.conv).at(-1).text, /¿Sobre qué curso te gustaría información\?/);
  await ana.say('el de nutrición');
  const texts = L.outgoing(ana.conv).map(m => m.text);
  assert.match(texts.at(-2), /^Tienes un pedido pendiente de .*Para cambiarte a .*escribe «asesor»/);
  assert.equal(texts.at(-1), 'Seguimos con tu pedido.');
  assert.equal(L.conversation(ana.conv).course_id, 'aves', 'el curso no cambió');
  assert.equal(L.session(ana.conv).outcome, 'completed');
});

// Prueba real del 21 nov 2026: saludo del recorrido y, en seguida, la pregunta del curso con OTRO saludo. Con el
// servidor real: la pregunta sale sin saludo cuando el recorrido ya habló, y un mensaje inicial que acota («algo de
// reptiles») recibe primero sólo esos cursos, con «ver todos» para la lista completa.
test('«¿Qué curso te interesa?» tras un saludo: sin doble saludo, y la lista acotada por el mensaje inicial', async t => {
  const L = await lab(t);
  const { db } = L;
  await L.enableAutomation();
  // Dos cursos de reptiles en la marca, copiados de uno real con su edición publicada (datos inventados).
  const clone = (table, id, over) => {
    const row = { ...db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id), ...over };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(
      ...cols.map(c => row[c]),
    );
  };
  const avesEdition = db.prepare("SELECT id FROM editions WHERE course_id='aves' AND status='published'").get().id;
  for (const [id, title] of [
    ['rep-manejo', 'Reptiles: manejo básico'],
    ['rep-clinica', 'Reptiles: medicina clínica'],
  ]) {
    clone('courses', 'aves', { id, title });
    clone('editions', avesEdition, { id: 'ed-' + id, course_id: id });
  }
  const graph = {
    v: 1,
    start: 'n1',
    variables: [],
    nodes: [
      node('n1', 'start'),
      node('hi', 'message', { parts: [{ kind: 'text', text: '¡Hola! Gracias por escribir a GlobalVet.' }] }),
      node('c', 'choose_course', { skipIfKnown: true, useMessage: true, attempts: 2 }),
      node('ok', 'end', { text: 'Listo con {{curso}}.' }),
      node('no', 'end', { text: 'Sin curso.' }),
    ],
    edges: [
      ['n1', 'next', 'hi'],
      ['hi', 'next', 'c'],
      ['c', 'next', 'ok'],
      ['c', 'none', 'no'],
    ].map(([from, port, to]) => ({ from, port, to })),
  };
  await L.publishFlow({ name: 'Saludo y curso', graph });
  const pending = async name => {
    const who = await L.customer(name);
    db.prepare('UPDATE conversations SET course_pending=1 WHERE id=?').run(who.conv);
    return who;
  };
  const texts = conv => L.outgoing(conv).map(m => m.text);

  // Sin acotar: el saludo del recorrido y la pregunta SIN otro saludo, con la lista completa.
  const ana = await pending('Ana Pérez');
  await ana.say('Hola');
  const [hello, question] = texts(ana.conv);
  assert.equal(hello, '¡Hola! Gracias por escribir a GlobalVet.');
  assert.match(question, /^¿Sobre qué curso te gustaría información\?\n\n1\. /);
  assert.doesNotMatch(question, /Soy el asistente|¡Hola!/);
  assert.ok(question.includes('Reptiles: manejo básico') && question.includes('Plan sanitario'));

  // Acota: sólo los dos de reptiles, con «ver todos»; «ver todos» trae la lista completa (sin saludo) y se elige.
  const beto = await pending('Beto Ruiz');
  await beto.say('Hola, me interesa algo de reptiles');
  const short = texts(beto.conv)[1];
  assert.equal(
    short,
    'Tenemos 2 cursos de ese tema. ¿Cuál te interesa?\n\n1. Reptiles: manejo básico\n2. Reptiles: medicina clínica\n\nResponde con el número o el nombre del curso, o escribe «ver todos» para ver la lista completa.',
  );
  assert.equal(JSON.parse(L.session(beto.conv).waiting).narrowed, true);
  await beto.say('ver todos');
  const full = texts(beto.conv).at(-1);
  assert.match(full, /^¿Sobre qué curso te gustaría información\?\n\n1\. /);
  assert.ok(full.includes('Plan sanitario') && full.includes('Reptiles: medicina clínica'));
  assert.equal(JSON.parse(L.session(beto.conv).waiting).tries, 0, '«ver todos» no gasta un intento');
  const line = full.split('\n').find(l => l.endsWith('Reptiles: medicina clínica'));
  await beto.say(line.split('.')[0]);
  assert.equal(L.conversation(beto.conv).course_id, 'rep-clinica');
  assert.equal(texts(beto.conv).at(-1), 'Listo con Reptiles: medicina clínica.');

  // Desde la lista corta también se elige por su número.
  const caro = await pending('Caro Díaz');
  await caro.say('quiero algo de reptiles');
  await caro.say('1');
  assert.equal(L.conversation(caro.conv).course_id, 'rep-manejo');
});

// WhatsApp real, con un número que atiende toda la marca: la pregunta sale a Meta como texto, igual que la del
// asistente (la persona contesta con el número o el nombre); un webhook repetido no la manda dos veces y la respuesta
// mueve la conversación al curso elegido.
test('WhatsApp real: «¿Qué curso te interesa?» pregunta por texto y la respuesta elige el curso', async t => {
  const lab = await whatsappLab(t, { AI_PROVIDER: '' });
  const origin = lab.origin();
  const api = (path, options = {}) => call(origin, path, { cookie: lab.admin, ...options });
  const { db } = lab;
  db.prepare('UPDATE wa_numbers SET multi=1 WHERE phone_number_id=?').run(NUMBER);
  const current = (await api('/api/automation')).brands.find(b => b.id === 'globalvet');
  await api('/api/automation/brands/globalvet', {
    method: 'PATCH',
    body: { enabled: true, expectedRevision: current.revision },
  });
  let { flow } = await api('/api/chatflows', {
    body: {
      brandId: 'globalvet',
      name: 'Elige curso',
      graph: {
        v: 1,
        start: 'n1',
        variables: [],
        nodes: [
          node('n1', 'start'),
          node('c', 'choose_course', { skipIfKnown: true, useMessage: true, attempts: 2 }),
          node('ok', 'end', { text: 'Listo con {{curso}}.' }),
        ],
        edges: [
          { from: 'n1', port: 'next', to: 'c' },
          { from: 'c', port: 'next', to: 'ok' },
        ],
      },
      start: { type: 'first_message' },
      clientRef: ref(),
    },
    expected: 201,
  });
  ({ flow } = await api('/api/chatflows/' + flow.id + '/publish', { body: { expectedRevision: flow.revision } }));
  await api('/api/chatflows/' + flow.id + '/activate', { body: { expectedRevision: flow.revision } });
  const from = '5215522223333';
  assert.equal((await metaText(origin, from, 'wamid.curso.1', 'Hola')).status, 200);
  assert.equal((await metaText(origin, from, 'wamid.curso.1', 'Hola')).status, 200);
  const conv = await until(
    () => db.prepare("SELECT conversation_id id FROM chatflow_sessions WHERE brand_id='globalvet'").get()?.id,
    'el recorrido inició con el mensaje real',
  );
  assert.equal(db.prepare('SELECT course_pending FROM conversations WHERE id=?').get(conv).course_pending, 1);
  const question = await until(
    () => lab.meta.sent.find(b => b.to === from && /¿Sobre qué curso/.test(b.text?.body || '')),
    'la pregunta salió a Meta',
  );
  assert.equal(question.type, 'text', 'como la lista del asistente: texto numerado, sin lista interactiva');
  assert.equal(question.interactive, undefined);
  const nutricion = db.prepare("SELECT title FROM courses WHERE id='nutricion'").get().title;
  const line = question.text.body.split('\n').find(l => l.endsWith(nutricion));
  assert.equal((await metaText(origin, from, 'wamid.curso.2', line.split('.')[0])).status, 200);
  await until(
    () => lab.meta.sent.find(b => b.to === from && b.text?.body === `Listo con ${nutricion}.`),
    'el recorrido siguió con el curso elegido',
  );
  assert.deepEqual(
    { ...db.prepare('SELECT course_id,course_pending FROM conversations WHERE id=?').get(conv) },
    { course_id: 'nutricion', course_pending: 0 },
  );
  assert.equal(
    lab.meta.sent.filter(b => b.to === from && /¿Sobre qué curso/.test(b.text?.body || '')).length,
    1,
    'el webhook repetido no repitió la pregunta',
  );
});
