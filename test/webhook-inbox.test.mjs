import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyNamed, defineRegistry } from '../server/migrations/named.mjs';
import inboxMigrations from '../server/migrations/named/inbox/index.mjs';
import { createWebhookInbox } from '../server/app/webhook-inbox.mjs';

const DAY = 86_400_000;
const START = 1_700_000_000_000;

// Base mínima: sólo la tabla de la bandeja, creada con su migración real.
function schema(db) {
  applyNamed(db, defineRegistry(inboxMigrations));
  return db;
}
const clock = (start = START) => {
  const c = { t: start, now: () => c.t };
  return c;
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise(done => setImmediate(done));
// Dos conexiones a la misma base en disco, como dos procesos del servidor.
async function twoConnections(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-inbox-'));
  const open = () => {
    const db = new DatabaseSync(join(dir, 'inbox.sqlite'), { timeout: 5000 });
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
    return db;
  };
  const one = schema(open());
  const two = open();
  t.after(async () => {
    one.close();
    two.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return [one, two];
}

// Una bandeja con reloj inyectado y un `process` de mentira: por omisión responde «hecho <id>»; `script[id]` puede
// ser un valor, una promesa o una función (que puede lanzar).
function setup(t, options = {}) {
  const db = options.db ?? schema(new DatabaseSync(':memory:'));
  if (!options.db) t.after(() => db.close());
  const c = options.clock ?? clock();
  const calls = [];
  const lines = [];
  const script = {};
  const inbox = createWebhookInbox({
    db,
    now: c.now,
    log: { error: (...args) => lines.push(args.join(' ')) },
    process(row) {
      calls.push(row.event_id);
      const step = script[row.event_id];
      return typeof step === 'function' ? step(row) : step === undefined ? 'hecho ' + row.event_id : step;
    },
    ...options.inbox,
  });
  const add = (id, lane, extra = {}) =>
    inbox.accept({ kind: 'channel', provider: 'meta', id, type: 'message.inbound', lane, payload: { id }, ...extra });
  const row = id => db.prepare('SELECT * FROM webhook_inbox WHERE event_id=?').get(id);
  const state = id => row(id)?.state;
  return { db, c, calls, lines, script, inbox, add, row, state };
}

test('la tabla de la bandeja: sin restricción sobre «kind», con restricción sobre el estado y un evento por proveedor e id', t => {
  const { db } = setup(t);
  const insert = (kind, state, id) =>
    db
      .prepare(
        "INSERT INTO webhook_inbox(kind,provider,event_id,type,lane,state,next_attempt_at,received_at,updated_at) VALUES(?,'meta',?,'x','l',?,1,1,1)",
      )
      .run(kind, id, state);
  insert('integration', 'pending', 'a'); // un tipo que todavía no existe entra sin reconstruir la tabla
  assert.throws(() => insert('channel', 'otro', 'b'), /CHECK/);
  assert.throws(() => insert('channel', 'pending', 'a'), /UNIQUE/);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='webhook_inbox' AND sql IS NOT NULL")
    .all()
    .map(index => index.name)
    .sort();
  assert.deepEqual(indexes, [
    'webhook_inbox_done',
    'webhook_inbox_due',
    'webhook_inbox_failed',
    'webhook_inbox_lane',
    'webhook_inbox_leases',
  ]);
  const defaults = db.prepare("SELECT state,attempts,max_attempts,payload FROM webhook_inbox WHERE event_id='a'").get();
  assert.deepEqual({ ...defaults }, { state: 'pending', attempts: 0, max_attempts: 12, payload: null });
});

test('aceptar es idempotente por proveedor e id, guarda la carga y valida el tipo en código', t => {
  const { db, c, inbox, add } = setup(t);
  const first = add('wamid.1', 'in:meta:1:aaa');
  assert.deepEqual({ ...first }, { seq: 1, state: 'pending', result: null, error: null, existing: false });
  c.t += 5000;
  const again = add('wamid.1', 'otro-carril', { payload: { otro: true } });
  assert.deepEqual({ ...again }, { seq: 1, state: 'pending', result: null, error: null, existing: true });
  const saved = db.prepare('SELECT * FROM webhook_inbox').all();
  assert.equal(saved.length, 1, 'el segundo aviso no crea otra fila');
  assert.equal(saved[0].lane, 'in:meta:1:aaa', 'ni cambia la que había');
  assert.deepEqual(JSON.parse(saved[0].payload), { id: 'wamid.1' });
  assert.equal(saved[0].received_at, START);
  assert.equal(saved[0].next_attempt_at, START);
  // el mismo id de otro proveedor es otro evento
  const other = inbox.accept({
    kind: 'payment',
    provider: 'stripe',
    id: 'wamid.1',
    type: 'payment.succeeded',
    lane: 'pay:stripe:o1',
    payload: {},
  });
  assert.ok(other.seq > first.seq);
  assert.equal(other.existing, false);
  assert.equal(db.prepare('SELECT count(*) n FROM webhook_inbox').get().n, 2);
  // id, tipo y carril se acotan
  const long = add('x'.repeat(500), 'l'.repeat(500), { type: 't'.repeat(500) });
  const stored = db.prepare('SELECT event_id,type,lane FROM webhook_inbox WHERE seq=?').get(long.seq);
  assert.deepEqual([stored.event_id.length, stored.type.length, stored.lane.length], [200, 80, 200]);
  assert.equal(add('x'.repeat(500), 'l').existing, true, 'el id acotado se reconoce al repetirse');
  // el tipo de webhook se valida en código, no en la tabla
  assert.throws(
    () => inbox.accept({ kind: 'integration', provider: 'x', id: 'i1', type: 'x', lane: 'l', payload: {} }),
    /Tipo de webhook no admitido: integration/,
  );
  const wider = createWebhookInbox({ db, process: () => 'ok', kinds: ['channel', 'payment', 'integration'] });
  assert.equal(
    wider.accept({ kind: 'integration', provider: 'x', id: 'i1', type: 'x', lane: 'l', payload: {} }).existing,
    false,
    'ampliar la lista no exige tocar la tabla',
  );
});

test('orden dentro de un carril con el primero lento; carriles distintos avanzan a la vez', async t => {
  const { db, calls, script, inbox, add, row, state } = setup(t);
  const slow = deferred();
  script.a1 = () => slow.promise;
  add('a1', 'A');
  add('a2', 'A');
  add('b1', 'B');
  add('a3', 'A');
  assert.equal(inbox.tick(), 2, 'una cabeza por carril');
  await flush();
  assert.deepEqual(calls, ['a1', 'b1'], 'el segundo del carril A espera al primero; el carril B no');
  assert.equal(state('b1'), 'done');
  assert.equal(state('a1'), 'reserved');
  assert.equal(state('a2'), 'pending');
  assert.equal(inbox.tick(), 0, 'mientras el primero no termine, el carril A no avanza');
  assert.deepEqual(inbox.stats(), {
    pending: 2,
    reserved: 1,
    failed: 0,
    oldestPendingSec: 0,
    inFlight: 1,
    paused: false,
  });
  slow.resolve('hecho a1 (tarde)');
  await inbox.idle();
  assert.deepEqual(
    calls,
    ['a1', 'b1', 'a2', 'a3'],
    'al terminar el primero, los demás salen solos y en orden de llegada',
  );
  const done = row('a1');
  assert.equal(done.state, 'done');
  assert.equal(done.result, 'hecho a1 (tarde)');
  assert.equal(done.payload, null, 'la carga se vacía en cuanto se procesa');
  assert.equal(done.attempts, 1);
  assert.equal(done.lease_owner, null);
  assert.equal(done.lease_until, null);
  assert.equal(done.done_at, START);
  assert.equal(db.prepare("SELECT count(*) n FROM webhook_inbox WHERE state='done'").get().n, 4);
  assert.equal(inbox.stats().oldestPendingSec, null);
});

test('eventos de carriles distintos se procesan en orden de llegada y como mucho «concurrency» a la vez', async t => {
  const { calls, script, inbox, add, state } = setup(t, { inbox: { concurrency: 3 } });
  // sin esperas: cada uno termina antes de que empiece el siguiente, como cuando los procesaba la petición
  for (let i = 1; i <= 5; i++) add('s' + i, 'carril-' + i);
  inbox.tick();
  await inbox.idle();
  assert.deepEqual(calls, ['s1', 's2', 's3', 's4', 's5']);
  // con esperas: sólo tres en vuelo
  calls.length = 0;
  const gates = {};
  for (let i = 1; i <= 6; i++) {
    gates['w' + i] = deferred();
    script['w' + i] = () => gates['w' + i].promise;
    add('w' + i, 'lento-' + i);
  }
  assert.equal(inbox.tick(), 3);
  await flush();
  assert.deepEqual(calls, ['w1', 'w2', 'w3']);
  assert.equal(inbox.tick(), 0, 'sin huecos libres no se reclama nada');
  gates.w2.resolve('ok');
  await flush();
  assert.deepEqual(calls, ['w1', 'w2', 'w3', 'w4'], 'al liberarse un hueco entra el siguiente');
  assert.equal(state('w5'), 'pending');
  for (const gate of Object.values(gates)) gate.resolve('ok');
  await inbox.idle();
  assert.equal(calls.length, 6);
  assert.equal(inbox.stats().inFlight, 0);
});

test('reintento con espera creciente; al agotar los intentos queda fallido y deja de bloquear su carril', async t => {
  const { c, calls, lines, script, inbox, add, row, state } = setup(t, {
    inbox: { maxAttempts: 3, baseDelayMs: 1000, capDelayMs: 8000 },
  });
  script.x = () => {
    throw new Error('red caída\ncon salto de línea');
  };
  add('x', 'L');
  add('y', 'L');
  inbox.tick();
  await inbox.idle();
  let x = row('x');
  assert.equal(x.state, 'pending');
  assert.equal(x.attempts, 1);
  assert.equal(x.error, 'red caída con salto de línea');
  assert.equal(x.next_attempt_at, START + 1000);
  assert.equal(x.lease_owner, null);
  assert.ok(x.payload, 'la carga se conserva para el reintento');
  assert.deepEqual(calls, ['x'], 'el siguiente de su carril espera mientras haya un reintento pendiente');
  c.t = START + 999;
  assert.equal(inbox.tick(), 0);
  c.t = START + 1000;
  assert.equal(inbox.tick(), 1);
  await inbox.idle();
  x = row('x');
  assert.equal(x.attempts, 2);
  assert.equal(x.next_attempt_at, START + 1000 + 2000, 'la espera se duplica');
  assert.equal(state('y'), 'pending');
  c.t = START + 3000;
  inbox.tick();
  await inbox.idle();
  x = row('x');
  assert.equal(x.state, 'failed', 'tercer intento: agotado');
  assert.equal(x.attempts, 3);
  assert.ok(x.payload, 'una fila fallida conserva su carga para poder reprocesarla');
  assert.deepEqual(calls, ['x', 'x', 'x', 'y'], 'el fallido deja pasar al siguiente de su carril');
  assert.equal(state('y'), 'done');
  assert.equal(lines.filter(line => line.startsWith('Webhook inbox item failed: message.inbound')).length, 3);
  assert.deepEqual(inbox.stats(), {
    pending: 0,
    reserved: 0,
    failed: 1,
    oldestPendingSec: null,
    inFlight: 0,
    paused: false,
  });
});

test('la espera entre reintentos tiene tope', async t => {
  const { c, script, inbox, add, row } = setup(t, { inbox: { maxAttempts: 6, baseDelayMs: 1000, capDelayMs: 3000 } });
  script.z = () => Promise.reject(new Error('sigue caído'));
  add('z', 'L');
  const waits = [];
  for (let i = 0; i < 5; i++) {
    inbox.tick();
    await inbox.idle();
    const z = row('z');
    waits.push(z.next_attempt_at - c.t);
    c.t = z.next_attempt_at;
  }
  assert.deepEqual(waits, [1000, 2000, 3000, 3000, 3000]);
});

test('un fallo permanente (4xx o permanent) no se reintenta; un 5xx sí', async t => {
  const { script, inbox, add, row, calls } = setup(t);
  script.bad = () => {
    throw Object.assign(new Error('dato no válido'), { status: 422 });
  };
  script.quarantine = async () => {
    throw Object.assign(new Error('no_identifier'), { permanent: true });
  };
  script.busy = async () => {
    throw Object.assign(new Error('servicio no disponible'), { status: 503 });
  };
  add('bad', 'uno');
  add('quarantine', 'dos');
  add('busy', 'tres');
  add('after', 'uno');
  inbox.tick();
  await inbox.idle();
  assert.deepEqual([row('bad').state, row('bad').attempts, row('bad').error], ['failed', 1, 'dato no válido']);
  assert.deepEqual([row('quarantine').state, row('quarantine').error], ['failed', 'no_identifier']);
  assert.ok(row('quarantine').payload, 'lo que queda en cuarentena conserva su carga');
  assert.deepEqual([row('busy').state, row('busy').attempts], ['pending', 1]);
  assert.equal(row('after').state, 'done', 'el fallo permanente no detiene a su carril');
  assert.deepEqual(calls, ['bad', 'quarantine', 'busy', 'after']);
});

test('un proceso que no termina se corta a tiempo y cuenta como fallo transitorio', async t => {
  const { script, inbox, add, row } = setup(t, { inbox: { processTimeoutMs: 30 } });
  script.hung = () => new Promise(() => {});
  add('hung', 'L');
  inbox.tick();
  await inbox.idle();
  const hung = row('hung');
  assert.equal(hung.state, 'pending');
  assert.equal(hung.error, 'Tiempo de espera agotado.');
  assert.equal(hung.attempts, 1);
});

test('arrendamiento vencido: otro trabajador retoma la fila y el que lo perdió no pisa el resultado', async t => {
  const [one, two] = await twoConnections(t);
  const c = clock();
  const slow = deferred();
  const a = setup(t, { db: one, clock: c, inbox: { workerId: 'a', leaseMs: 60_000, processTimeoutMs: 600_000 } });
  const b = setup(t, { db: two, clock: c, inbox: { workerId: 'b', leaseMs: 60_000, baseDelayMs: 2000 } });
  a.script.e1 = () => slow.promise; // el trabajador «a» se queda a medias (o su proceso murió)
  b.script.e1 = 'hecho por b';
  a.add('e1', 'L');
  a.add('e2', 'L');
  assert.equal(a.inbox.tick(), 1);
  await flush();
  assert.deepEqual(
    [a.row('e1').state, a.row('e1').lease_owner, a.row('e1').lease_until],
    ['reserved', 'a', START + 60_000],
  );
  assert.equal(b.inbox.tick(), 0, 'con el arrendamiento vigente nadie más la toma');
  c.t = START + 59_999;
  assert.equal(b.inbox.tick(), 0);
  assert.deepEqual(b.calls, []);
  c.t = START + 60_000;
  assert.equal(b.inbox.tick(), 0, 'al vencer vuelve a la cola, con su espera');
  let e1 = b.row('e1');
  assert.deepEqual([e1.state, e1.attempts, e1.lease_owner, e1.next_attempt_at], ['pending', 1, null, c.t + 2000]);
  c.t += 2000;
  assert.equal(b.inbox.tick(), 1);
  await b.inbox.idle();
  e1 = b.row('e1');
  assert.deepEqual([e1.state, e1.result, e1.attempts], ['done', 'hecho por b', 2]);
  assert.deepEqual(b.calls, ['e1', 'e2'], 'y el carril sigue con el trabajador que la retomó');
  // el primero termina tarde: su resultado no se anota
  slow.resolve('hecho por a (tarde)');
  await a.inbox.idle();
  assert.equal(a.row('e1').result, 'hecho por b');
  assert.equal(one.prepare("SELECT count(*) n FROM webhook_inbox WHERE state='done'").get().n, 2);
  assert.deepEqual(a.calls, ['e1'], 'el que perdió el arrendamiento no sigue con el carril por su cuenta');
});

test('dos trabajadores sobre la misma base: cada evento lo procesa exactamente uno', async t => {
  const [one, two] = await twoConnections(t);
  const c = clock();
  const effects = [];
  const worker = (db, workerId) =>
    createWebhookInbox({
      db,
      workerId,
      now: c.now,
      log: { error() {} },
      async process(row) {
        await flush(); // cede el hilo, como una llamada de red
        effects.push(row.event_id);
        return 'hecho por ' + workerId;
      },
    });
  const a = worker(one, 'a');
  const b = worker(two, 'b');
  for (let i = 0; i < 40; i++)
    a.accept({ kind: 'channel', provider: 'meta', id: 'e' + i, type: 'x', lane: 'carril-' + (i % 10), payload: { i } });
  // los dos reclaman a la vez, una y otra vez, hasta vaciar la bandeja
  for (let round = 0; round < 20 && one.prepare("SELECT 1 FROM webhook_inbox WHERE state!='done'").get(); round++) {
    a.tick();
    b.tick();
    await Promise.all([a.idle(), b.idle()]);
  }
  assert.equal(effects.length, 40, 'ni uno más ni uno menos');
  assert.equal(new Set(effects).size, 40);
  const by = one
    .prepare('SELECT result,count(*) n FROM webhook_inbox GROUP BY result ORDER BY result')
    .all()
    .map(row => row.n);
  assert.equal(
    by.reduce((sum, n) => sum + n, 0),
    40,
  );
  assert.equal(by.length, 2, 'los dos trabajaron');
  for (let lane = 0; lane < 10; lane++) {
    const order = effects.filter(id => Number(id.slice(1)) % 10 === lane).map(id => Number(id.slice(1)));
    assert.deepEqual(
      order,
      [...order].sort((x, y) => x - y),
      'dentro de cada carril, en orden de llegada',
    );
  }
});

test('un arrendamiento que vence con los intentos agotados deja la fila fallida y libera su carril', async t => {
  const first = setup(t, { inbox: { workerId: 'a', maxAttempts: 1, leaseMs: 1000, processTimeoutMs: 600_000 } });
  first.script.dead = () => new Promise(() => {}); // el proceso murió con el evento a medias
  first.add('dead', 'L');
  first.add('next', 'L');
  first.inbox.tick();
  await flush();
  assert.equal(first.state('dead'), 'reserved');
  first.c.t += 1000;
  // el arranque siguiente encuentra el arrendamiento vencido
  const second = setup(t, { db: first.db, clock: first.c, inbox: { workerId: 'b' } });
  assert.equal(second.inbox.tick(), 1);
  await second.inbox.idle();
  const dead = first.row('dead');
  assert.deepEqual(
    [dead.state, dead.error, dead.attempts, dead.lease_owner, dead.lease_until],
    ['failed', 'Arrendamiento vencido sin resultado', 1, null, null],
  );
  assert.ok(dead.payload, 'conserva su carga para reprocesarla a mano');
  assert.deepEqual(second.calls, ['next']);
  assert.equal(first.state('next'), 'done');
});

test('settled: no espera con 0, se cumple cuando las filas terminan y vence a tiempo si no terminan', async t => {
  const { script, inbox, add } = setup(t, { inbox: { pollMs: 20, processTimeoutMs: 600_000 } });
  const gate = deferred();
  script.slow = () => gate.promise;
  script.never = () => new Promise(() => {});
  const fast = add('fast', 'uno');
  const slow = add('slow', 'dos');
  const never = add('never', 'tres');
  assert.deepEqual([...(await inbox.settled([], 1000))], [], 'sin filas no hay nada que esperar');
  const now = await inbox.settled([fast.seq, slow.seq], 0);
  assert.deepEqual([now.get(fast.seq).state, now.get(slow.seq).state], ['pending', 'pending']);
  inbox.wake();
  const started = Date.now();
  const waiting = inbox.settled([fast.seq, slow.seq], 5000);
  setTimeout(() => gate.resolve('listo'), 60);
  const rows = await waiting;
  assert.ok(Date.now() - started < 4000, 'no agota la espera cuando las filas terminan antes');
  assert.deepEqual({ ...rows.get(fast.seq) }, { seq: fast.seq, state: 'done', result: 'hecho fast', error: null });
  assert.equal(rows.get(slow.seq).result, 'listo');
  // ya terminadas: responde al momento aunque se pida esperar
  const again = await inbox.settled([fast.seq], 5000);
  assert.equal(again.get(fast.seq).state, 'done');
  // la que no termina: la espera vence y devuelve su estado de ese momento
  const before = Date.now();
  const late = await inbox.settled([never.seq, fast.seq, 9999], 120);
  const waited = Date.now() - before;
  assert.ok(waited >= 100 && waited < 4000, 'esperó ' + waited + ' ms');
  assert.equal(late.get(never.seq).state, 'reserved');
  assert.equal(late.get(fast.seq).state, 'done');
  assert.equal(late.has(9999), false, 'una fila que no existe no detiene la espera');
});

test('settled también se entera de lo que termina otro trabajador', async t => {
  const [one, two] = await twoConnections(t);
  const receiver = createWebhookInbox({ db: one, process: () => 'nunca', paused: true, pollMs: 20 });
  const worker = createWebhookInbox({ db: two, process: () => 'hecho en otro proceso' });
  const saved = receiver.accept({ kind: 'channel', provider: 'meta', id: 'e1', type: 'x', lane: 'L', payload: {} });
  const waiting = receiver.settled([saved.seq], 5000);
  setTimeout(() => worker.tick(), 40);
  const rows = await waiting;
  assert.equal(rows.get(saved.seq).result, 'hecho en otro proceso');
});

test('en pausa (sólo pruebas) no se procesa nada; al apagar no se toma nada nuevo y lo reservado se devuelve', async t => {
  const paused = setup(t, { inbox: { paused: true } });
  paused.add('p1', 'L');
  assert.equal(paused.inbox.tick(), 0);
  paused.inbox.wake();
  await flush();
  assert.deepEqual(paused.calls, []);
  assert.equal(paused.state('p1'), 'pending');
  assert.equal(paused.inbox.stats().paused, true);

  const { db, c, calls, script, inbox, add, row, state } = setup(t, { inbox: { processTimeoutMs: 600_000 } });
  const gate = deferred();
  script.flying = () => gate.promise;
  add('flying', 'uno');
  add('queued', 'uno');
  inbox.tick();
  await flush();
  let idle = false;
  const waiting = inbox.idle().then(() => (idle = true));
  inbox.stop();
  add('late', 'dos'); // llega durante el apagado: se guarda, no se procesa
  assert.equal(inbox.tick(), 0);
  inbox.wake();
  await flush();
  assert.deepEqual(calls, ['flying']);
  assert.equal(idle, false, 'idle espera a lo que está en vuelo');
  // si la espera del apagado se acaba, lo reservado vuelve a la cola sin gastar un intento…
  c.t += 500;
  assert.equal(inbox.release(), 1);
  const released = row('flying');
  assert.deepEqual(
    [released.state, released.attempts, released.lease_owner, released.lease_until, released.next_attempt_at],
    ['pending', 0, null, null, c.t],
  );
  // …y lo que el proceso viejo termine después ya no se anota
  gate.resolve('tarde');
  await waiting;
  assert.equal(idle, true);
  assert.equal(state('flying'), 'pending');
  assert.equal(state('queued'), 'pending');
  assert.equal(state('late'), 'pending');
  assert.deepEqual(calls, ['flying'], 'ni siquiera al terminar lo que estaba en vuelo se toma lo siguiente');
  // el siguiente arranque (otra bandeja sobre la misma base) lo procesa todo, sin esperar a ningún arrendamiento
  const next = setup(t, { db, clock: c });
  next.inbox.tick();
  await next.inbox.idle();
  assert.deepEqual(next.calls, ['late', 'flying', 'queued'], 'cada carril conserva su orden');
  assert.equal(db.prepare("SELECT count(*) n FROM webhook_inbox WHERE state='done'").get().n, 3);
});

test('reproceso manual, lista para administración y estadísticas', async t => {
  const { c, db, calls, script, inbox, add, row } = setup(t);
  let broken = true;
  script.q = () => {
    if (broken) throw Object.assign(new Error('no_identifier'), { permanent: true });
    return 'recibido tras el arreglo';
  };
  const q = add('q', 'L', { payload: { secreto: 'texto del mensaje' } });
  add('ok', 'M');
  inbox.tick();
  await inbox.idle();
  assert.equal(row('q').state, 'failed');
  const listed = inbox.list();
  assert.equal(listed.length, 1, 'por omisión, sólo lo fallido');
  assert.deepEqual(listed[0], {
    seq: q.seq,
    kind: 'channel',
    provider: 'meta',
    eventId: 'q',
    type: 'message.inbound',
    state: 'failed',
    attempts: 1,
    maxAttempts: 12,
    nextAttemptAt: START,
    result: null,
    error: 'no_identifier',
    receivedAt: START,
    updatedAt: START,
    doneAt: null,
    hasPayload: true,
  });
  assert.equal(JSON.stringify(listed).includes('texto del mensaje'), false, 'la lista nunca lleva la carga');
  assert.deepEqual(
    inbox.list({ state: 'all' }).map(item => item.eventId),
    ['ok', 'q'],
  );
  assert.deepEqual(
    inbox.list({ state: 'done', limit: 1 }).map(item => item.eventId),
    ['ok'],
  );
  assert.deepEqual(inbox.list({ state: 'pending' }), []);
  assert.deepEqual(inbox.list({ state: 'reserved' }), []);
  assert.equal(inbox.list({ state: 'no-existe' }).length, 1, 'un estado desconocido se lee como «fallidos»');
  assert.throws(
    () => inbox.retry(9999),
    e => e.status === 404,
  );
  assert.throws(
    () => inbox.retry(row('ok').seq),
    e => e.status === 409 && /fallido/.test(e.message),
  );
  // todavía no hay arreglo: el reproceso vuelve a fallar, con los intentos desde cero
  c.t += 60_000;
  const back = inbox.retry(q.seq);
  assert.deepEqual([back.state, back.attempts, back.error, back.nextAttemptAt], ['pending', 0, null, c.t]);
  await flush();
  await inbox.idle();
  assert.deepEqual([row('q').state, row('q').attempts], ['failed', 1]);
  // con el arreglo puesto, el mismo evento entra
  broken = false;
  inbox.retry(q.seq);
  await flush();
  await inbox.idle();
  assert.deepEqual([row('q').state, row('q').result, row('q').payload], ['done', 'recibido tras el arreglo', null]);
  assert.deepEqual(calls, ['q', 'ok', 'q', 'q']);
  assert.equal(inbox.get(q.seq).state, 'done');
  assert.equal(inbox.get(12345), undefined);
  // una fila fallida que ya no conserva su carga no se puede reprocesar
  script.gone = () => {
    throw Object.assign(new Error('rechazado'), { status: 400 });
  };
  const gone = add('gone', 'N');
  inbox.tick();
  await inbox.idle();
  db.prepare('UPDATE webhook_inbox SET payload=NULL WHERE seq=?').run(gone.seq);
  assert.throws(
    () => inbox.retry(gone.seq),
    e => e.status === 409 && /ya no conserva su contenido/.test(e.message),
  );
});

test('limpieza: lo procesado se borra a los 30 días; lo fallido pierde la carga a los 14 y se borra a los 90', async t => {
  const { c, db, script, inbox, add, row } = setup(t, { inbox: { purgeBatch: 2 } });
  script.f = () => {
    throw Object.assign(new Error('rechazado'), { permanent: true });
  };
  for (const id of ['d1', 'd2', 'd3']) add(id, id);
  add('f', 'f');
  inbox.tick();
  await inbox.idle();
  const pending = add('p', 'p'); // sigue pendiente: nunca se limpia
  db.prepare('UPDATE webhook_inbox SET next_attempt_at=? WHERE seq=?').run(START + 400 * DAY, pending.seq);
  c.t = START + 13 * DAY;
  assert.deepEqual(inbox.purge(), { done: 0, emptied: 0, failed: 0, more: false });
  c.t = START + 14 * DAY + 1;
  assert.deepEqual(inbox.purge(), { done: 0, emptied: 1, failed: 0, more: false });
  assert.equal(row('f').payload, null);
  assert.equal(row('f').state, 'failed', 'sigue ahí, como rastro');
  c.t = START + 30 * DAY + 1;
  assert.deepEqual(inbox.purge(), { done: 2, emptied: 0, failed: 0, more: true }, 'como mucho un lote por pasada');
  // el reloj hace la limpieza una vez por hora
  inbox.tick();
  assert.equal(db.prepare("SELECT count(*) n FROM webhook_inbox WHERE state='done'").get().n, 0);
  const cleaned = c.t;
  db.prepare("UPDATE webhook_inbox SET updated_at=? WHERE event_id='f'").run(cleaned - 91 * DAY);
  c.t = cleaned + 3_600_000 - 1;
  inbox.tick();
  assert.equal(row('f').state, 'failed', 'dentro de la misma hora no se repite');
  c.t = cleaned + 3_600_000;
  inbox.tick();
  assert.equal(row('f'), undefined, 'lo fallido se borra a los 90 días');
  assert.equal(row('p').state, 'pending');
});

test('el reloj continúa la limpieza en la pasada siguiente cuando el lote se llenó', async t => {
  const { c, db, inbox, add } = setup(t, { inbox: { purgeBatch: 2 } });
  for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) add(id, id);
  inbox.tick(); // primera pasada: procesa y anota la hora de la limpieza
  await inbox.idle();
  const left = () => db.prepare("SELECT count(*) n FROM webhook_inbox WHERE state='done'").get().n;
  c.t = START + 31 * DAY;
  inbox.tick();
  assert.equal(left(), 3);
  inbox.tick();
  assert.equal(left(), 1);
  inbox.tick();
  assert.equal(left(), 0);
});
