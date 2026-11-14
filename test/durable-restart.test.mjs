// «El proceso muere a mitad»: con el servidor real, qué pasa con un envío de WhatsApp en vuelo y con un trabajo del
// asistente arrendado cuando el proceso desaparece sin apagarse (docs/PLAN_RECEPCION_DURADERA.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from './helpers/server.mjs';
import { metaText } from './helpers/fake-meta.mjs';
import { PASSWORD, call, crash, openDb, sleep, until, whatsappLab } from './helpers/crm.mjs';

const MARIA = '5215512345678';
const UNCERTAIN = /^No se confirmó si este mensaje salió: el servidor se reinició durante el envío\. Revisa el chat/;

// Una persona pregunta, el asistente responde y esa respuesta queda EN VUELO hacia Meta cuando el proceso muere:
// nadie sabe si Meta la aceptó. Devuelve el mensaje tal como quedó en la base.
async function replyInFlightThenCrash(lab) {
  const { meta, db, origin, state } = lab;
  meta.hold('send');
  const received = await metaText(origin(), MARIA, 'wamid.maria-1', 'Hola, ¿cuánto cuesta el curso?', {
    name: 'María López',
  });
  assert.match(received.body.results[0].result, /^recibido: conversación nueva/);
  await until(() => meta.waiting('send') === 1, 'la respuesta del asistente va camino de Meta', {
    logs: state.server.logs,
  });
  const reply = db
    .prepare(
      "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.wa_peer=? AND m.sender_kind='automation'",
    )
    .get(MARIA);
  assert.equal(reply.provider_ref, null);
  assert.equal(reply.delivery_state, 'sent');
  assert.equal(reply.send_attempts, 1);
  assert.ok(
    reply.send_lease_until > Date.now() + 60_000,
    'la marca de «en vuelo» está en la base antes de la respuesta',
  );
  await crash(state.server);
  meta.release('send'); // Meta contesta, pero ya no hay quien escuche
  assert.equal(meta.sent.length, 1);
  return reply;
}
const message = (db, id) => db.prepare('SELECT * FROM messages WHERE id=?').get(id);
const trail = (db, id) =>
  db
    .prepare('SELECT state FROM channel_events WHERE message_id=? ORDER BY seq')
    .all(id)
    .map(event => event.state);

test('el servidor muere con un envío de WhatsApp en vuelo: al arrancar no lo repite mientras dure la marca y después lo reintenta una vez, con rastro', async t => {
  const lab = await whatsappLab(t);
  const { meta, db, start, state } = lab;
  const reply = await replyInFlightThenCrash(lab);
  await start(); // política por omisión: reintentar
  await sleep(1600); // tres pasadas del reloj del canal
  assert.equal(meta.sent.length, 1, 'con la marca vigente no se le pide otra vez a Meta');
  let now = message(db, reply.id);
  assert.deepEqual(
    [now.delivery_state, now.provider_ref, now.send_attempts, now.send_lease_until],
    ['sent', null, 1, reply.send_lease_until],
  );
  // la marca dura dos minutos: se adelanta su vencimiento para no esperar
  db.prepare('UPDATE messages SET send_lease_until=? WHERE id=?').run(Date.now() - 1, reply.id);
  await until(() => message(db, reply.id).provider_ref, 'el envío en duda se reintenta', { logs: state.server.logs });
  assert.equal(meta.sent.length, 2);
  assert.equal(meta.sent[1].to, MARIA);
  await until(() => trail(db, reply.id).includes('sent'), 'el reintento queda en el historial de entrega');
  assert.deepEqual(trail(db, reply.id), ['lease_expired', 'sent'], 'el posible duplicado deja rastro');
  now = message(db, reply.id);
  assert.deepEqual([now.delivery_state, now.send_attempts, now.send_lease_until], ['sent', 0, null]);
  await sleep(1200);
  assert.equal(meta.sent.length, 2, 'y sólo una vez');
});

test('con WA_UNCERTAIN_SEND=fail el envío en duda no se repite: queda «no entregado» con su motivo hasta que alguien pulsa Reintentar', async t => {
  const lab = await whatsappLab(t);
  const { meta, db, start, state, admin, origin } = lab;
  const reply = await replyInFlightThenCrash(lab);
  await start({ WA_UNCERTAIN_SEND: 'fail' });
  await sleep(1200);
  assert.equal(message(db, reply.id).delivery_state, 'sent', 'mientras dura la marca no se decide nada');
  db.prepare('UPDATE messages SET send_lease_until=? WHERE id=?').run(Date.now() - 1, reply.id);
  const failed = await until(
    () => {
      const row = message(db, reply.id);
      return row.delivery_state === 'failed' ? row : null;
    },
    'el envío en duda queda como no entregado',
    { logs: state.server.logs },
  );
  assert.match(failed.failed_reason, UNCERTAIN);
  assert.deepEqual([failed.provider_ref, failed.send_attempts, failed.send_lease_until], [null, 0, null]);
  assert.equal(meta.sent.length, 1, 'no se le pide nada a Meta');
  assert.deepEqual(trail(db, reply.id), ['failed']);
  assert.ok(
    db.prepare("SELECT 1 FROM domain_events WHERE type='mensaje.fallido' AND entity_id=?").get(reply.id),
    'avisa al resto del sistema como cualquier fallo',
  );
  // el equipo lo ve en el chat con su motivo y decide reenviarlo
  const seen = (await call(origin(), '/api/conversations/' + reply.conversation_id + '/messages', { cookie: admin }))
    .messages;
  assert.match(seen.find(m => m.id === reply.id).failed_reason, UNCERTAIN);
  for (const served of seen)
    assert.equal(
      'send_lease_until' in served || 'send_attempts' in served,
      false,
      'las marcas internas del envío no salen por la API',
    );
  await call(origin(), '/api/messages/' + reply.id + '/retry', { cookie: admin, body: {} });
  await until(() => message(db, reply.id).provider_ref, 'el reintento manual sale por Meta', {
    logs: state.server.logs,
  });
  assert.equal(meta.sent.length, 2);
  await until(() => trail(db, reply.id).length === 3, 'el historial tiene los tres pasos');
  assert.deepEqual(trail(db, reply.id), ['failed', 'retry', 'sent']);
});

test('un trabajo del asistente arrendado por otro proceso no se toma; al vencer el arrendamiento se atiende una sola vez y lo suelta', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-duradero-'));
  const server = await startServer({ dir, env: { AI_PROVIDER: '' } });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const customer = await call(server.origin, '/api/auth/register', {
    body: { username: 'cliente', name: 'Cliente de prueba', password: PASSWORD },
  });
  const conversation = (
    await call(server.origin, '/api/conversations', {
      cookie: customer.cookie,
      body: { courseId: 'aves', channel: 'whatsapp' },
    })
  ).conversation;
  const answered = trigger => db.prepare('SELECT count(*) n FROM reply_log WHERE trigger_message_id=?').get(trigger).n;
  // el camino de siempre: se responde y el trabajo no conserva arrendamiento
  const first = await call(server.origin, '/api/conversations/' + conversation.id + '/messages', {
    cookie: customer.cookie,
    body: { text: '¿Cuánto cuesta el curso?', clientRef: randomUUID() },
    expected: 201,
  });
  await until(() => answered(first.id) === 1, 'el asistente responde la primera pregunta', { logs: server.logs });
  const done = db.prepare('SELECT state,lease_owner,lease_until FROM jobs WHERE message_id=?').get(first.id);
  assert.deepEqual({ ...done }, { state: 'done', lease_owner: null, lease_until: null });

  // otra pregunta cuyo trabajo ya tiene dueño: lo tomó otro proceso (que sigue con él, o que murió a la mitad)
  const question = randomUUID();
  const job = randomUUID();
  const at = Date.now();
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    "INSERT INTO messages(id,conversation_id,sender_id,sender_kind,text,client_ref,created_at) VALUES(?,?,?,'customer',?,?,?)",
  ).run(question, conversation.id, customer.user.id, '¿Qué temas incluye el curso?', 'prueba:' + question, at);
  db.prepare('INSERT INTO jobs(id,conversation_id,message_id,due_at,lease_owner,lease_until) VALUES(?,?,?,?,?,?)').run(
    job,
    conversation.id,
    question,
    at,
    'otro-proceso',
    at + 60_000,
  );
  db.exec('COMMIT');
  await sleep(1500); // cuatro pasadas del reloj de trabajos
  assert.equal(answered(question), 0, 'con el arrendamiento vigente nadie más lo atiende');
  assert.deepEqual(
    { ...db.prepare('SELECT state,lease_owner FROM jobs WHERE id=?').get(job) },
    { state: 'pending', lease_owner: 'otro-proceso' },
  );
  db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(Date.now() - 1, job); // el arrendamiento vence
  await until(
    () => db.prepare('SELECT state FROM jobs WHERE id=?').get(job).state === 'done',
    'al vencer, se atiende',
    {
      logs: server.logs,
    },
  );
  assert.equal(answered(question), 1, 'una sola respuesta');
  assert.deepEqual(
    { ...db.prepare('SELECT state,lease_owner,lease_until FROM jobs WHERE id=?').get(job) },
    { state: 'done', lease_owner: null, lease_until: null },
    'al terminar suelta el arrendamiento',
  );
  await sleep(800);
  assert.equal(answered(question), 1);
});
