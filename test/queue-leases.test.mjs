import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { runLadder } from '../server/migrations/ladder.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { hasColumn, withTimeout, safeError } from '../server/app/leases.mjs';
import { createChannel } from '../server/channel.mjs';
import { createEvents } from '../server/events.mjs';
import { createIntegrations } from '../server/integrations.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';

const START = 1_700_000_000_000;
const NUMBER = '109000000000001';
const UNCERTAIN = /^No se confirmó si este mensaje salió: el servidor se reinició durante el envío\. Revisa el chat/;
const quiet = { error() {} };
const clock = (start = START) => {
  const c = { t: start, now: () => c.t };
  return c;
};
const deferred = () => {
  let resolve;
  const promise = new Promise(ok => (resolve = ok));
  return { promise, resolve };
};
const flush = () => new Promise(done => setImmediate(done));

// Base completa en disco y, si hace falta, una segunda conexión a la misma base: como otro proceso del servidor.
async function base(t, { ladderOnly = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-leases-'));
  const db = openDatabase(dir);
  if (ladderOnly) runLadder(db);
  else migrate(db, { backup: false });
  const opened = [db];
  t.after(async () => {
    for (const connection of opened) {
      try {
        connection.close();
      } catch {
        // ya estaba cerrada
      }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const second = () => {
    const other = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
    other.exec('PRAGMA foreign_keys=ON');
    opened.push(other);
    return other;
  };
  return { dir, db, second };
}

let people = 0;
// Una conversación REAL de WhatsApp (con número y destinatario) cuya persona acaba de escribir: ventana abierta.
function realConversation(db, id, at = START) {
  const user = 'u-' + id;
  db.prepare(
    'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
  ).run(user, 'wa-' + id, 'Persona ' + id, 'sin-acceso', 'customer', 700000 + ++people, 1, 1);
  db.prepare(
    'INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at,wa_number,wa_peer) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(id, user, 'globalvet', 'aves', 'whatsapp', 1, 1, NUMBER, '52155000000' + String(people).padStart(2, '0'));
  db.prepare(
    "INSERT INTO messages(id,conversation_id,sender_id,sender_kind,text,client_ref,created_at) VALUES(?,?,?,'customer','Hola',?,?)",
  ).run('in-' + id, id, user, 'meta:in-' + id, at - 1000);
}
const outbound = (db, conversation, id, at = START) =>
  db
    .prepare(
      "INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at,category) VALUES(?,?,'automation',?,?,?,'service')",
    )
    .run(id, conversation, 'Texto de ' + id, 'ref-' + id, at);
const message = (db, id) => db.prepare('SELECT * FROM messages WHERE id=?').get(id);
const trail = (db, id) =>
  db
    .prepare('SELECT state FROM channel_events WHERE message_id=? ORDER BY seq')
    .all(id)
    .map(event => event.state);

// Un canal sobre `db` cuyo «Meta» es la función `send` (por omisión acepta y anota el efecto en `sent`).
function channelOn(db, c, sent, options = {}) {
  const published = [];
  const channel = createChannel({
    db,
    crm: { requireBrand() {} },
    audit() {},
    broadcast() {},
    accessConversation: id => db.prepare('SELECT * FROM conversations WHERE id=?').get(id),
    domainEvents: { publish: event => published.push(event) },
    now: c.now,
    ...options.channel,
  });
  const send =
    options.send ??
    (async out => {
      await flush(); // cede el hilo, como una llamada de red
      sent.push(out.id);
      return { providerRef: 'wamid.' + (options.name ?? 'x') + '.' + out.id, state: 'sent', reason: null };
    });
  channel.useOutbound(async (m, { closed }) =>
    closed && options.holdWhenClosed ? { hold: true } : { id: m.id, to: '5215500000001', from: NUMBER, text: 'hola' },
  );
  channel.useConnector(() => ({ provider: 'meta', send }));
  return { channel, published };
}

// ---------------------------------------------------------------------------------------------------------------
// Migración y piezas comunes
// ---------------------------------------------------------------------------------------------------------------

test('las migraciones de este bloque llegan a una base ya publicada sin tocar sus filas, con un solo respaldo previo', async t => {
  const { dir, db } = await base(t, { ladderOnly: true });
  realConversation(db, 'c1');
  outbound(db, 'c1', 'm1');
  db.prepare("INSERT INTO jobs(id,conversation_id,message_id,due_at) VALUES('j1','c1','in-c1',?)").run(START);
  db.prepare(
    "INSERT INTO domain_events(id,type,brand_id,entity_kind,entity_id,source,dedupe_key,created_at) VALUES('e1','pago.confirmado','globalvet','order','o1','test','k1',1)",
  ).run();
  db.prepare(
    "INSERT INTO domain_deliveries(event_seq,subscriber,state,attempts,next_attempt_at,updated_at) VALUES(1,'core','pending',2,5,6)",
  ).run();
  db.prepare(
    "INSERT INTO webhook_endpoints(id,brand_id,url,secret,created_at,updated_at) VALUES('w1','globalvet','https://ejemplo.invalid/h','whsec_prueba',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO webhook_deliveries(id,endpoint_id,event_seq,next_attempt_at,created_at,updated_at) VALUES('d1','w1',1,5,5,5)",
  ).run();
  const snapshot = () => ({
    message: { ...message(db, 'm1') },
    job: { ...db.prepare("SELECT * FROM jobs WHERE id='j1'").get() },
    delivery: { ...db.prepare('SELECT * FROM domain_deliveries').get() },
    webhook: { ...db.prepare('SELECT * FROM webhook_deliveries').get() },
  });
  const before = snapshot();
  assert.equal(hasColumn(db, 'messages', 'send_lease_until'), false);
  assert.equal(hasColumn(db, 'jobs', 'lease_until'), false);

  const result = migrate(db, { dataDir: dir, now: () => 123 });
  // las de este bloque, en su orden; otros frentes añaden las suyas al mismo registro
  assert.deepEqual(
    result.applied.filter(name => /^(inbox|queues)\//.test(name)),
    ['inbox/0001-webhook-inbox', 'queues/0001-leases'],
  );
  assertSchemaCurrent(db);
  const backups = await readdir(join(dir, 'backups'));
  assert.equal(backups.length, 1, 'un solo respaldo para todas las migraciones pendientes');
  assert.match(backups[0], /^before-[a-z0-9-]+-123\.sqlite$/);
  const after = snapshot();
  // cada fila conserva lo que tenía y gana sus columnas nuevas, vacías
  const kept = (was, now, added) => {
    for (const [column, value] of Object.entries(was)) assert.deepEqual(now[column], value, column);
    for (const [column, value] of Object.entries(added)) assert.deepEqual(now[column], value, column);
  };
  kept(before.message, after.message, { send_lease_until: null, send_attempts: 0 });
  kept(before.job, after.job, { lease_owner: null, lease_until: null });
  kept(before.delivery, after.delivery, { lease_owner: null, lease_until: null });
  kept(before.webhook, after.webhook, { lease_owner: null, lease_until: null });
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE name='messages_send_lease'").get().sql,
    /WHERE send_lease_until IS NOT NULL/,
    'el índice sólo guarda los mensajes con un envío en vuelo o en duda',
  );
  assert.equal(db.prepare('SELECT count(*) n FROM webhook_inbox').get().n, 0);
  // arrancar otra vez no cambia nada ni respalda de nuevo
  assert.deepEqual(migrate(db, { dataDir: dir }).applied, []);
  assert.equal((await readdir(join(dir, 'backups'))).length, 1);
  assert.deepEqual(snapshot(), after);
});

test('piezas comunes: detectar una columna, cortar una espera y dejar un error en una línea', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE cola(id INTEGER PRIMARY KEY, lease_until INTEGER)');
  assert.equal(hasColumn(db, 'cola', 'lease_until'), true);
  assert.equal(hasColumn(db, 'cola', 'lease_owner'), false);
  assert.equal(hasColumn(db, 'no_existe', 'lease_until'), false);
  assert.throws(() => hasColumn(db, 'cola; DROP TABLE cola', 'x'), /no válido/);
  db.close();
  assert.equal(await withTimeout(Promise.resolve('a tiempo'), 1000), 'a tiempo');
  assert.equal(await withTimeout('valor directo', 1000), 'valor directo');
  await assert.rejects(withTimeout(Promise.reject(new Error('falló antes')), 1000), /falló antes/);
  const started = Date.now();
  await assert.rejects(
    withTimeout(new Promise(() => {}), 40),
    error => error.message === 'Tiempo de espera agotado.' && error.transient === true,
  );
  assert.ok(Date.now() - started < 4000);
  assert.equal(safeError(new Error('dos\nlíneas\ty un tabulador')), 'dos líneas y un tabulador');
  assert.equal(safeError('x'.repeat(500)).length, 200);
});

// ---------------------------------------------------------------------------------------------------------------
// Entrega del canal: el único doble envío que ve el cliente final
// ---------------------------------------------------------------------------------------------------------------

test('canal: dos procesos sobre la misma base envían cada saliente real una sola vez y sin desordenar la conversación', async t => {
  const { db, second } = await base(t);
  const c = clock();
  const sent = [];
  realConversation(db, 'c1');
  realConversation(db, 'c2');
  for (const id of ['m1', 'm2', 'm3']) outbound(db, 'c1', id);
  outbound(db, 'c2', 'n1');
  const gate = deferred();
  // el proceso «a» tarda en su primer envío; el resto del tiempo responde como Meta
  const a = channelOn(db, c, sent, {
    name: 'a',
    send: async out => {
      if (out.id === 'm1') await gate.promise;
      await flush();
      sent.push(out.id);
      return { providerRef: 'wamid.a.' + out.id, state: 'sent', reason: null };
    },
  });
  const b = channelOn(second(), c, sent, { name: 'b' });
  const first = a.channel.tick();
  await flush();
  await flush();
  assert.deepEqual(sent, ['n1'], 'la otra conversación no espera');
  assert.deepEqual(
    ['m1', 'm2', 'm3'].map(id => [message(db, id).send_lease_until, message(db, id).send_attempts]),
    [
      [START + 120_000, 1],
      [START + 120_000, 1],
      [START + 120_000, 1],
    ],
    'la marca de «en vuelo» queda en la base antes de llamar a Meta',
  );
  // mientras tanto llegan un mensaje más a esa conversación y otro a una conversación nueva
  outbound(db, 'c1', 'm4', START + 10);
  realConversation(db, 'c3');
  outbound(db, 'c3', 'p1', START + 10);
  c.t = START + 500;
  assert.deepEqual(await b.channel.tick(), ['c3'], 'el otro proceso sólo toma lo que no está en vuelo');
  assert.deepEqual(sent, ['n1', 'p1']);
  assert.equal(message(db, 'm4').send_lease_until, null, 'no adelanta a los que van antes en su conversación');
  assert.deepEqual(await b.channel.tick(), []);
  gate.resolve();
  assert.deepEqual(await first, ['c1', 'c2']);
  assert.deepEqual(sent, ['n1', 'p1', 'm1', 'm2', 'm3']);
  c.t = START + 1000;
  await Promise.all([a.channel.tick(), b.channel.tick()]);
  assert.deepEqual(sent, ['n1', 'p1', 'm1', 'm2', 'm3', 'm4'], 'exactamente un envío por mensaje, en orden');
  for (const id of ['m1', 'm2', 'm3', 'm4', 'n1', 'p1']) {
    const row = message(db, id);
    assert.match(row.provider_ref, /^wamid\.[ab]\./, id);
    assert.deepEqual([row.send_lease_until, row.send_attempts, row.delivery_state], [null, 0, 'sent'], id);
    assert.deepEqual(trail(db, id), ['sent'], id);
  }
  await Promise.all([a.channel.tick(), b.channel.tick()]);
  assert.equal(sent.length, 6);
});

test('canal: el proceso muere con un envío en vuelo; no se repite mientras dure la marca y después se reintenta con rastro', async t => {
  const { db, second } = await base(t);
  const c = clock();
  const sent = [];
  realConversation(db, 'c1');
  realConversation(db, 'c2');
  outbound(db, 'c1', 'm1');
  // el proceso llama a Meta y muere antes de saber la respuesta
  const dead = channelOn(db, c, sent, {
    send: out => {
      sent.push('muerto:' + out.id);
      return new Promise(() => {});
    },
  });
  dead.channel.tick();
  await flush();
  assert.deepEqual(sent, ['muerto:m1']);
  let m1 = message(db, 'm1');
  assert.deepEqual([m1.send_lease_until, m1.send_attempts, m1.provider_ref], [START + 120_000, 1, null]);

  // el arranque siguiente (política por omisión: reintentar)
  const next = channelOn(second(), c, sent, { name: 'nuevo' });
  outbound(db, 'c1', 'm2', START + 5); // otra respuesta de la misma conversación
  outbound(db, 'c2', 'n1', START + 5);
  c.t = START + 60_000;
  assert.deepEqual(await next.channel.tick(), ['c2']);
  assert.deepEqual(sent, ['muerto:m1', 'n1'], 'con la marca vigente no se reenvía, ni se adelanta lo que va detrás');
  c.t = START + 119_999;
  assert.deepEqual(await next.channel.tick(), []);
  c.t = START + 120_000;
  assert.deepEqual(await next.channel.tick(), ['c1']);
  assert.deepEqual(sent, ['muerto:m1', 'n1', 'm1', 'm2'], 'al vencer la marca sale una vez más, y en orden');
  m1 = message(db, 'm1');
  assert.deepEqual([m1.provider_ref, m1.send_lease_until, m1.send_attempts], ['wamid.nuevo.m1', null, 0]);
  assert.deepEqual(trail(db, 'm1'), ['lease_expired', 'sent'], 'el posible duplicado queda anotado en su historial');
  assert.deepEqual(trail(db, 'm2'), ['sent']);
  assert.deepEqual(next.published, [], 'un envío en duda que se reintenta no es un fallo');
  assert.deepEqual(await next.channel.tick(), []);
  assert.equal(sent.length, 4);
});

test('canal: con WA_UNCERTAIN_SEND=fail el envío en duda no se repite; queda no entregado y «Reintentar» lo manda', async t => {
  const { db, second } = await base(t);
  const c = clock();
  const sent = [];
  realConversation(db, 'c1');
  outbound(db, 'c1', 'm1');
  channelOn(db, c, sent, { send: () => new Promise(() => {}) }).channel.tick();
  await flush();
  const next = channelOn(second(), c, sent, { name: 'nuevo', channel: { uncertainSend: 'fail' } });
  c.t = START + 119_999;
  assert.deepEqual(await next.channel.tick(), []);
  c.t = START + 120_000;
  assert.deepEqual(await next.channel.tick(), ['c1']);
  assert.deepEqual(sent, [], 'no se le pide nada a Meta');
  let m1 = message(db, 'm1');
  assert.equal(m1.delivery_state, 'failed');
  assert.match(m1.failed_reason, UNCERTAIN);
  assert.deepEqual([m1.provider_ref, m1.send_lease_until, m1.send_attempts], [null, null, 0]);
  assert.deepEqual(trail(db, 'm1'), ['failed'], 'con el mismo rastro que cualquier fallo');
  assert.equal(next.published.length, 1);
  assert.equal(next.published[0].type, 'mensaje.fallido');
  assert.match(next.published[0].payload.reason, UNCERTAIN);
  assert.deepEqual(await next.channel.tick(), [], 'ni se reintenta solo');
  // una persona revisa el chat y decide reenviarlo
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('admin','admin','Administración','sin-acceso','admin',799998,1,1)",
  ).run();
  const retried = next.channel.retry('m1', { id: 'admin', role: 'admin' });
  assert.equal(retried.delivery_state, 'sent');
  assert.deepEqual(await next.channel.tick(), ['c1']);
  assert.deepEqual(sent, ['m1']);
  m1 = message(db, 'm1');
  assert.deepEqual([m1.provider_ref, m1.delivery_state, m1.send_attempts], ['wamid.nuevo.m1', 'sent', 0]);
  assert.deepEqual(trail(db, 'm1'), ['failed', 'retry', 'sent']);
});

test('canal: aunque la política sea reintentar, una plantilla en duda nunca se repite sola y al tercer envío en duda se deja de insistir', async t => {
  const { db } = await base(t);
  const c = clock();
  const sent = [];
  realConversation(db, 'c1');
  realConversation(db, 'c2');
  realConversation(db, 'c3');
  outbound(db, 'c1', 'dos');
  outbound(db, 'c2', 'tres');
  outbound(db, 'c3', 'plantilla');
  // como quedan tras morir el proceso dos y tres veces seguidas con el mismo mensaje en vuelo
  db.prepare("UPDATE messages SET send_attempts=2,send_lease_until=? WHERE id='dos'").run(START - 1);
  db.prepare("UPDATE messages SET send_attempts=3,send_lease_until=? WHERE id='tres'").run(START - 1);
  // y una plantilla aprobada (de pago) que estaba en vuelo cuando murió el proceso, una sola vez
  db.prepare("UPDATE messages SET send_attempts=1,send_lease_until=?,wa_template=? WHERE id='plantilla'").run(
    START - 1,
    JSON.stringify({ name: 'aviso_novedad', language: 'es_MX', params: ['María'] }),
  );
  const { channel, published } = channelOn(db, c, sent);
  assert.deepEqual((await channel.tick()).sort(), ['c1', 'c2', 'c3']);
  assert.deepEqual(sent, ['dos'], 'sólo se repite el texto libre que todavía tiene intentos');
  assert.deepEqual(trail(db, 'dos'), ['lease_expired', 'sent']);
  for (const id of ['tres', 'plantilla']) {
    const row = message(db, id);
    assert.equal(row.delivery_state, 'failed', id);
    assert.match(row.failed_reason, UNCERTAIN, id);
    assert.deepEqual([row.provider_ref, row.send_lease_until, row.send_attempts], [null, null, 0], id);
    assert.deepEqual(trail(db, id), ['failed'], id);
  }
  assert.equal(published.length, 2);
});

test('canal: lo que queda en espera o lo que Meta rechaza deja de estar en vuelo, y volver a encolarlo no es un envío en duda', async t => {
  const { db } = await base(t);
  const c = clock();
  const sent = [];
  realConversation(db, 'c1');
  realConversation(db, 'c2', START - 30 * 3600_000); // su último mensaje fue hace más de 24 h: ventana cerrada
  outbound(db, 'c1', 'rechazado');
  outbound(db, 'c2', 'aviso');
  let reject = true;
  const { channel } = channelOn(db, c, sent, {
    holdWhenClosed: true,
    send: async out => {
      if (reject) throw new Error('Meta rechazó la operación (código 131000)');
      sent.push(out.id);
      return { providerRef: 'wamid.' + out.id, state: 'sent', reason: null };
    },
  });
  assert.deepEqual((await channel.tick()).sort(), ['c1', 'c2']);
  const held = message(db, 'aviso');
  assert.deepEqual(
    [held.wa_hold, held.send_lease_until, held.send_attempts],
    [START, null, 0],
    'en espera: nunca salió',
  );
  assert.deepEqual(trail(db, 'aviso'), ['held']);
  let failed = message(db, 'rechazado');
  assert.deepEqual(
    [failed.delivery_state, failed.failed_reason, failed.send_lease_until, failed.send_attempts],
    ['failed', 'Meta rechazó la operación (código 131000)', null, 0],
    'el resultado se conoce: no salió',
  );
  // lo mismo que hace el CRM al volver a mandar un aviso fallido: lo encola otra vez sin pasar por «Reintentar»
  db.prepare(
    "UPDATE messages SET delivery_state='sent',failed_reason=NULL,provider_ref=NULL WHERE id='rechazado'",
  ).run();
  reject = false;
  c.t = START + 1000;
  assert.deepEqual(await channel.tick(), ['c1']);
  assert.deepEqual(sent, ['rechazado']);
  failed = message(db, 'rechazado');
  assert.deepEqual([failed.provider_ref, failed.send_lease_until, failed.send_attempts], ['wamid.rechazado', null, 0]);
  assert.deepEqual(trail(db, 'rechazado'), ['failed', 'sent'], 'sin «lease_expired»: no hubo ningún envío en duda');
});

test('canal: los mensajes del laboratorio no llevan marca, e idle() espera al lote en vuelo', async t => {
  const { db } = await base(t);
  const c = clock();
  const sent = [];
  // conversación del laboratorio (sin número real) en una marca con el canal simulado encendido
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('lab','lab','Perfil de prueba','x','customer',799999,1,1)",
  ).run();
  db.prepare(
    "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES('lab1','lab','globalvet','aves','whatsapp',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO channel_settings(brand_id,enabled,enforce_window,delivery_delay_ms,failure_rate,updated_at) VALUES('globalvet',1,0,0,0,1)",
  ).run();
  outbound(db, 'lab1', 'simulado');
  realConversation(db, 'c1');
  outbound(db, 'c1', 'real');
  const gate = deferred();
  const { channel } = channelOn(db, c, sent, {
    send: async out => {
      await gate.promise;
      sent.push(out.id);
      return { providerRef: 'ref.' + out.id, state: 'sent', reason: null };
    },
  });
  await channel.idle(); // sin nada en vuelo se cumple al momento
  const batch = channel.tick();
  await flush();
  let free = false;
  const waiting = channel.idle().then(() => (free = true));
  await flush();
  assert.equal(free, false, 'con un lote en vuelo, idle espera');
  assert.equal(message(db, 'simulado').send_lease_until, null, 'el laboratorio no se marca: no tiene efecto externo');
  assert.equal(message(db, 'real').send_lease_until, START + 120_000);
  gate.resolve();
  assert.deepEqual((await batch).sort(), ['c1', 'lab1']);
  await waiting;
  assert.equal(free, true);
  const lab = message(db, 'simulado');
  assert.deepEqual([lab.delivery_state, lab.send_lease_until, lab.send_attempts], ['delivered', null, 0]);
  assert.deepEqual(trail(db, 'simulado'), ['delivered']);
  assert.equal(message(db, 'real').send_lease_until, null);
});

// ---------------------------------------------------------------------------------------------------------------
// Entregas de eventos de dominio
// ---------------------------------------------------------------------------------------------------------------

const publish = (events, n) =>
  events.publish({
    type: 'pago.confirmado',
    brandId: 'globalvet',
    entityId: 'pedido-' + n,
    payload: { reference: 'TC-' + n },
    source: 'test',
  });
const deliveries = db =>
  db
    .prepare(
      'SELECT event_seq,subscriber,state,attempts,error,lease_owner,lease_until FROM domain_deliveries ORDER BY event_seq,subscriber',
    )
    .all()
    .map(row => ({ ...row }));

test('eventos: dos procesos sobre la misma base entregan cada evento una sola vez', async t => {
  const { db, second } = await base(t);
  const c = clock();
  const effects = [];
  const worker = (connection, workerId) => {
    const events = createEvents({ db: connection, now: c.now, log: quiet, workerId });
    events.subscribe('pago.confirmado', 'contador', async event => {
      await flush(); // cede el hilo: el otro proceso corre mientras tanto
      effects.push(workerId + ':' + event.entity_id);
    });
    return events;
  };
  const a = worker(db, 'a');
  const b = worker(second(), 'b');
  for (let n = 1; n <= 12; n++) publish(a, n);
  const counts = await Promise.all([a.tick(), b.tick()]);
  assert.equal(counts[0] + counts[1], 12);
  assert.ok(counts[0] > 0 && counts[1] > 0, 'los dos trabajaron: ' + counts);
  assert.equal(effects.length, 12, 'un efecto por evento');
  assert.equal(new Set(effects.map(effect => effect.split(':')[1])).size, 12);
  for (const delivery of deliveries(db))
    assert.deepEqual(
      [delivery.state, delivery.attempts, delivery.lease_owner, delivery.lease_until],
      ['done', 1, null, null],
    );
  assert.deepEqual(await Promise.all([a.tick(), b.tick()]), [0, 0]);
  assert.equal(effects.length, 12);
});

test('eventos: si el proceso muere a mitad de una entrega, otro la retoma al vencer el arrendamiento y el primero no pisa el resultado', async t => {
  const { db, second } = await base(t);
  const c = clock();
  const gate = deferred();
  const effects = [];
  const a = createEvents({ db, now: c.now, log: quiet, workerId: 'a', leaseMs: 60_000, handlerTimeoutMs: 600_000 });
  a.subscribe('pago.confirmado', 'contador', async () => {
    effects.push('a');
    await gate.promise; // el proceso «a» se queda a medias
  });
  const b = createEvents({ db: second(), now: c.now, log: quiet, workerId: 'b', leaseMs: 60_000 });
  b.subscribe('pago.confirmado', 'contador', async () => {
    effects.push('b');
  });
  publish(a, 1);
  const hung = a.tick();
  await flush();
  assert.deepEqual(deliveries(db), [
    {
      event_seq: 1,
      subscriber: 'contador',
      state: 'pending',
      attempts: 0,
      error: null,
      lease_owner: 'a',
      lease_until: START + 60_000,
    },
  ]);
  c.t = START + 59_999;
  assert.equal(await b.tick(), 0, 'con el arrendamiento vigente no se entrega dos veces a la vez');
  assert.deepEqual(effects, ['a']);
  c.t = START + 60_000;
  assert.equal(await b.tick(), 1);
  assert.deepEqual(effects, ['a', 'b'], 'al menos una vez: el suscriptor es idempotente');
  const done = deliveries(db);
  assert.deepEqual(done, [
    {
      event_seq: 1,
      subscriber: 'contador',
      state: 'done',
      attempts: 1,
      error: null,
      lease_owner: null,
      lease_until: null,
    },
  ]);
  const stamp = db.prepare('SELECT updated_at FROM domain_deliveries').get().updated_at;
  c.t = START + 90_000;
  gate.resolve();
  assert.equal(await hung, 1);
  assert.deepEqual(deliveries(db), done);
  assert.equal(
    db.prepare('SELECT updated_at FROM domain_deliveries').get().updated_at,
    stamp,
    'el que llegó tarde no toca la fila',
  );
});

test('eventos: un suscriptor que no termina no detiene a los demás y se reintenta como fallo transitorio', async t => {
  const { db } = await base(t);
  const c = clock();
  const seen = [];
  const events = createEvents({ db, now: c.now, log: quiet, handlerTimeoutMs: 40, baseDelayMs: 1000 });
  events.subscribe('pago.confirmado', 'colgado', () => new Promise(() => {}));
  events.subscribe('pago.confirmado', 'normal', event => {
    seen.push(event.entity_id);
  });
  publish(events, 1);
  publish(events, 2);
  const started = Date.now();
  assert.equal(await events.tick(), 2);
  assert.ok(Date.now() - started < 3000, 'el reloj termina aunque un suscriptor no responda');
  assert.deepEqual(seen, ['pedido-1', 'pedido-2']);
  assert.deepEqual(
    deliveries(db).map(d => [d.subscriber, d.state, d.attempts, d.error, d.lease_owner]),
    [
      ['colgado', 'pending', 1, 'Tiempo de espera agotado.', null],
      ['normal', 'done', 1, null, null],
      ['colgado', 'pending', 1, 'Tiempo de espera agotado.', null],
      ['normal', 'done', 1, null, null],
    ],
  );
  assert.equal(
    db.prepare("SELECT min(next_attempt_at) t FROM domain_deliveries WHERE subscriber='colgado'").get().t,
    START + 1000,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Webhooks salientes
// ---------------------------------------------------------------------------------------------------------------

// Cada «proceso» con sus propios eventos de dominio sobre su conexión, como en el servidor.
function webhookWorker(db, c, workerId, fetchImpl) {
  return createIntegrations({
    db,
    crm: {},
    events: createEvents({ db, now: c.now, log: quiet, workerId }),
    audit() {},
    rate() {},
    now: c.now,
    env: { WEBHOOK_ALLOW_PRIVATE: '1' },
    fetchImpl,
    log: quiet,
    workerId,
    leaseMs: 45_000,
  });
}
function seedWebhooks(db, count) {
  db.prepare(
    "INSERT INTO webhook_endpoints(id,brand_id,url,secret,created_at,updated_at) VALUES('w1','globalvet','http://127.0.0.1:9/webhook','whsec_prueba',1,1)",
  ).run();
  for (let n = 1; n <= count; n++) {
    db.prepare(
      "INSERT INTO domain_events(id,type,brand_id,entity_kind,entity_id,source,dedupe_key,created_at) VALUES(?,'pago.confirmado','globalvet','order',?,'test',?,?)",
    ).run('e' + n, 'pedido-' + n, 'k' + n, START);
    db.prepare(
      'INSERT INTO webhook_deliveries(id,endpoint_id,event_seq,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    ).run('entrega-' + n, 'w1', n, START, START, START);
  }
}
const ok = { status: 200, body: { cancel: async () => {} } };

test('webhooks salientes: dos procesos sobre la misma base envían cada entrega una sola vez', async t => {
  const { db, second } = await base(t);
  const c = clock();
  const posts = [];
  const post = workerId => async (url, init) => {
    await flush();
    posts.push(workerId + ':' + init.headers['TC-Delivery']);
    return ok;
  };
  seedWebhooks(db, 8);
  const a = webhookWorker(db, c, 'a', post('a'));
  const b = webhookWorker(second(), c, 'b', post('b'));
  const counts = await Promise.all([a.tick(), b.tick()]);
  assert.equal(counts[0] + counts[1], 8);
  assert.ok(counts[0] > 0 && counts[1] > 0, 'los dos trabajaron: ' + counts);
  assert.equal(posts.length, 8, 'un envío por entrega');
  assert.equal(new Set(posts.map(p => p.split(':')[1])).size, 8);
  for (const row of db.prepare('SELECT * FROM webhook_deliveries').all())
    assert.deepEqual(
      [row.state, row.attempts, row.last_status, row.lease_owner, row.lease_until],
      ['done', 1, 200, null, null],
    );
  assert.deepEqual(await Promise.all([a.tick(), b.tick()]), [0, 0]);
  assert.equal(posts.length, 8);
});

test('webhooks salientes: tras morir el proceso la entrega se reintenta al vencer el arrendamiento, con el mismo identificador', async t => {
  const { db, second } = await base(t);
  const c = clock();
  const posts = [];
  const gate = deferred();
  seedWebhooks(db, 1);
  const a = webhookWorker(db, c, 'a', async (url, init) => {
    posts.push('a:' + init.headers['TC-Delivery']);
    await gate.promise;
    return { status: 500, body: { cancel: async () => {} } };
  });
  const b = webhookWorker(second(), c, 'b', async (url, init) => {
    posts.push('b:' + init.headers['TC-Delivery']);
    return ok;
  });
  const hung = a.tick();
  await flush();
  await flush();
  const row = () =>
    db.prepare('SELECT state,attempts,last_status,error,lease_owner,lease_until FROM webhook_deliveries').get();
  assert.deepEqual(
    { ...row() },
    { state: 'pending', attempts: 0, last_status: null, error: null, lease_owner: 'a', lease_until: START + 45_000 },
  );
  c.t = START + 44_999;
  assert.equal(await b.tick(), 0);
  c.t = START + 45_000;
  assert.equal(await b.tick(), 1);
  assert.deepEqual(
    posts,
    ['a:entrega-1', 'b:entrega-1'],
    'el destino puede recibirlo dos veces, con el mismo TC-Delivery',
  );
  const done = { state: 'done', attempts: 1, last_status: 200, error: null, lease_owner: null, lease_until: null };
  assert.deepEqual({ ...row() }, done);
  gate.resolve();
  await hung;
  assert.deepEqual({ ...row() }, done, 'la respuesta tardía del proceso anterior no cambia el resultado');
});
