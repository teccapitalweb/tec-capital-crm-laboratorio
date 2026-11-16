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
      () => steps.every(s => db.prepare('SELECT state FROM automation_steps WHERE id=?').get(s.id).state !== 'pending'),
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
