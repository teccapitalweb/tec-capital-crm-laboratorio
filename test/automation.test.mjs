import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { migrateCRM } from '../server/crm.mjs';
import { migrateFollowup } from '../server/followup.mjs';
import { migrateCatalogue } from '../server/catalogue-schema.mjs';
import { migrateOperations } from '../server/operations-schema.mjs';
import { migrateAutomation, migrateRecipes } from '../server/automation-schema.mjs';
import { createAutomation, cancelConversationSteps, backoff } from '../server/automation.mjs';

const migrate = db => {
  migrateCRM(db);
  migrateFollowup(db);
  migrateCatalogue(db);
  migrateOperations(db);
  migrateAutomation(db);
  migrateRecipes(db);
};
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-automation-')),
    db = openDatabase(dir);
  migrate(db);
  t.after(async () => {
    try {
      db.close();
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  const t0 = Date.now();
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u1','cliente','Cliente','x','customer',1,?,?)",
  ).run(t0, t0);
  const course = db.prepare('SELECT id,brand_id FROM courses LIMIT 1').get();
  db.prepare(
    "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES('c1','u1',?,?,'whatsapp',?,?)",
  ).run(course.brand_id, course.id, t0, t0);
  return { dir, db, brand: course.brand_id };
}
const clock = (start = 1_000_000) => {
  const c = { t: start, now: () => c.t };
  return c;
};
const quiet = { error() {} };

test('migración v7 es aditiva, repetible y deja la automatización desactivada', async t => {
  const { db, dir } = await setup(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
  const cols = db
    .prepare('PRAGMA table_info(jobs)')
    .all()
    .map(c => c.name);
  for (const c of ['attempts', 'next_attempt_at', 'last_error']) assert.ok(cols.includes(c));
  assert.equal(db.prepare('SELECT count(*) n FROM automation_settings').get().n, 0);
  assert.equal(db.prepare('SELECT paused FROM automation_global').get().paused, 0);
  migrateAutomation(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
  db.close();
  const again = openDatabase(dir);
  migrate(again);
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, 8);
  again.close();
});

test('desactivado por defecto: no encola; con marca habilitada es idempotente', async t => {
  const { db, brand } = await setup(t),
    a = createAutomation({ db, handlers: { noop: { commit: () => ({ ok: true }) } }, log: quiet });
  assert.deepEqual(a.enqueue({ brandId: brand, kind: 'noop', dedupeKey: 'k1' }), { skipped: 'disabled' });
  assert.equal(db.prepare('SELECT count(*) n FROM automation_steps').get().n, 0);
  a.setBrand(brand, true, 0, null);
  const first = a.enqueue({ brandId: brand, conversationId: 'c1', kind: 'noop', dedupeKey: 'k1' }),
    second = a.enqueue({ brandId: brand, conversationId: 'c1', kind: 'noop', dedupeKey: 'k1' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.step.id, first.step.id);
  assert.throws(() => a.enqueue({ brandId: brand, conversationId: null, kind: 'noop', dedupeKey: 'k1' }), /otro paso/);
  assert.throws(() => a.enqueue({ brandId: brand, kind: 'desconocido', dedupeKey: 'k2' }), /no registrado/);
  assert.throws(() => a.setBrand(brand, false, 0, null), /cambió/);
});

test('efecto y estado completado se confirman juntos; un fallo del efecto revierte todo', async t => {
  const { db, brand } = await setup(t),
    c = clock();
  let boom = true;
  db.exec('CREATE TABLE effect(n INTEGER)');
  const a = createAutomation({
    db,
    now: c.now,
    baseDelayMs: 1000,
    log: quiet,
    handlers: {
      write: {
        commit: s => {
          db.prepare('INSERT INTO effect VALUES(?)').run(s.payload.n);
          if (boom) throw Error('fallo local');
          return { n: s.payload.n };
        },
      },
    },
  });
  a.setBrand(brand, true, 0, null);
  const { step } = a.enqueue({ brandId: brand, kind: 'write', payload: { n: 1 }, dedupeKey: 'w1', scheduledAt: c.t });
  await a.tick();
  assert.equal(db.prepare('SELECT count(*) n FROM effect').get().n, 0);
  let s = a.get(step.id);
  assert.equal(s.state, 'pending');
  assert.equal(s.attempts, 1);
  assert.equal(s.next_attempt_at, c.t + 1000);
  await a.tick();
  assert.equal(a.get(step.id).attempts, 1);
  boom = false;
  c.t += 1000;
  await a.tick();
  s = a.get(step.id);
  assert.equal(s.state, 'completed');
  assert.equal(db.prepare('SELECT count(*) n FROM effect').get().n, 1);
  c.t += 10_000_000;
  await a.tick();
  assert.equal(db.prepare('SELECT count(*) n FROM effect').get().n, 1);
  assert.deepEqual(
    a.history(step.id).map(e => e.kind),
    ['created', 'reserved', 'retry_scheduled', 'reserved', 'completed'],
  );
});

test('reintentos acotados con espera creciente, fallo visible y reintento manual', async t => {
  const { db, brand } = await setup(t),
    c = clock();
  let calls = 0;
  assert.deepEqual(
    [1, 2, 3, 4, 10].map(n => backoff(n, 1000, 8000)),
    [1000, 2000, 4000, 8000, 8000],
  );
  const a = createAutomation({
    db,
    now: c.now,
    baseDelayMs: 1000,
    capDelayMs: 8000,
    log: quiet,
    handlers: {
      flaky: {
        call: async () => {
          calls++;
          throw Error('proveedor caído');
        },
        commit: () => ({}),
      },
    },
  });
  a.setBrand(brand, true, 0, null);
  const { step } = a.enqueue({ brandId: brand, kind: 'flaky', dedupeKey: 'f1', scheduledAt: c.t, maxAttempts: 3 });
  for (let i = 0; i < 10; i++) {
    await a.tick();
    c.t += 60_000;
  }
  const s = a.get(step.id);
  assert.equal(s.state, 'failed');
  assert.equal(s.attempts, 3);
  assert.equal(calls, 3);
  assert.match(s.error, /proveedor/);
  assert.equal(a.list({ state: 'failed' }).length, 1);
  assert.throws(() => a.retry('inexistente'), /no encontrado/);
  a.retry(step.id, null);
  assert.equal(a.get(step.id).state, 'pending');
  assert.throws(() => a.retry(step.id, null), /fallido/);
});

test('errores permanentes (4xx) no se reintentan y el tiempo de espera cuenta como transitorio', async t => {
  const { db, brand } = await setup(t),
    c = clock();
  const a = createAutomation({
    db,
    now: c.now,
    callTimeoutMs: 20,
    baseDelayMs: 1000,
    log: quiet,
    handlers: {
      denied: {
        call: async () => {
          throw Object.assign(Error('rechazado'), { status: 403 });
        },
        commit: () => ({}),
      },
      slow: { call: () => new Promise(() => {}), commit: () => ({}) },
    },
  });
  a.setBrand(brand, true, 0, null);
  const d = a.enqueue({ brandId: brand, kind: 'denied', dedupeKey: 'd', scheduledAt: c.t }).step,
    sl = a.enqueue({ brandId: brand, kind: 'slow', dedupeKey: 's', scheduledAt: c.t }).step;
  await a.tick();
  assert.equal(a.get(d.id).state, 'failed');
  assert.equal(a.get(d.id).attempts, 1);
  assert.equal(a.get(sl.id).state, 'pending');
  assert.match(a.get(sl.id).error, /espera/);
});

test('reinicio: un paso reservado cuyo arrendamiento venció se recupera sin saltar efectos', async t => {
  const { db, brand } = await setup(t),
    c = clock();
  let commits = 0;
  const handlers = {
    w: {
      commit: () => {
        commits++;
        return {};
      },
    },
  };
  const first = createAutomation({
    db,
    now: c.now,
    leaseMs: 5000,
    baseDelayMs: 1000,
    workerId: 'proceso-1',
    handlers,
    log: quiet,
  });
  first.setBrand(brand, true, 0, null);
  const { step } = first.enqueue({ brandId: brand, kind: 'w', dedupeKey: 'r1', scheduledAt: c.t });
  assert.equal(first.claim().length, 1);
  assert.equal(first.get(step.id).state, 'reserved'); // el proceso cae aquí
  const second = createAutomation({
    db,
    now: c.now,
    leaseMs: 5000,
    baseDelayMs: 1000,
    workerId: 'proceso-2',
    handlers,
    log: quiet,
  });
  await second.tick();
  assert.equal(commits, 0);
  assert.equal(second.get(step.id).state, 'reserved'); // el arrendamiento sigue vigente
  c.t += 5001;
  await second.tick();
  assert.equal(commits, 0);
  assert.equal(second.get(step.id).state, 'pending');
  c.t += 1000;
  await second.tick();
  assert.equal(commits, 1);
  assert.equal(second.get(step.id).state, 'completed');
  assert.equal(second.get(step.id).attempts, 2);
  assert.ok(second.history(step.id).some(e => e.kind === 'lease_expired'));
});

test('arrendamientos vencidos repetidos terminan en fallo en lugar de reintentarse sin límite', async t => {
  const { db, brand } = await setup(t),
    c = clock(),
    a = createAutomation({
      db,
      now: c.now,
      leaseMs: 100,
      baseDelayMs: 10,
      handlers: { w: { commit: () => ({}) } },
      log: quiet,
    });
  a.setBrand(brand, true, 0, null);
  const { step } = a.enqueue({ brandId: brand, kind: 'w', dedupeKey: 'l', scheduledAt: c.t, maxAttempts: 2 });
  for (let i = 0; i < 4; i++) {
    a.claim();
    c.t += 1000;
  }
  a.claim();
  assert.equal(a.get(step.id).state, 'failed');
  assert.match(a.get(step.id).error, /Arrendamiento/);
});

test('carrera de cancelación: una respuesta, cierre o toma humana durante la llamada impide el efecto', async t => {
  const { db, brand } = await setup(t),
    c = clock();
  let effects = 0,
    release;
  const gate = new Promise(r => {
    release = r;
  });
  const a = createAutomation({
    db,
    now: c.now,
    log: quiet,
    handlers: {
      send: {
        check: s =>
          db.prepare('SELECT status,assigned_to FROM conversations WHERE id=?').get(s.conversation_id).assigned_to
            ? { cancel: 'human_takeover' }
            : null,
        call: async () => {
          await gate;
          return 'ok';
        },
        commit: () => {
          effects++;
          return {};
        },
      },
    },
  });
  a.setBrand(brand, true, 0, null);
  const { step } = a.enqueue({ brandId: brand, conversationId: 'c1', kind: 'send', dedupeKey: 'x1', scheduledAt: c.t });
  const running = a.tick();
  await new Promise(r => setImmediate(r));
  assert.equal(a.get(step.id).state, 'reserved');
  // cancelación por toma humana mientras la llamada está en curso
  db.exec('BEGIN IMMEDIATE');
  cancelConversationSteps(db, 'c1', 'human_takeover', c.t);
  db.exec('COMMIT');
  release();
  await running;
  assert.equal(effects, 0);
  const s = a.get(step.id);
  assert.equal(s.state, 'cancelled');
  assert.equal(s.cancel_reason, 'human_takeover');

  // la revalidación justo antes del efecto también cancela, aunque nadie llamó a cancelar
  let release2;
  const gate2 = new Promise(r => {
    release2 = r;
  });
  const b = createAutomation({
    db,
    now: c.now,
    log: quiet,
    handlers: {
      send: {
        check: s =>
          db.prepare('SELECT assigned_to FROM conversations WHERE id=?').get(s.conversation_id).assigned_to
            ? { cancel: 'human_takeover' }
            : null,
        call: async () => {
          await gate2;
        },
        commit: () => {
          effects++;
          return {};
        },
      },
    },
  });
  const second = b.enqueue({
    brandId: brand,
    conversationId: 'c1',
    kind: 'send',
    dedupeKey: 'x2',
    scheduledAt: c.t,
  }).step;
  const run2 = b.tick();
  await new Promise(r => setImmediate(r));
  db.prepare("UPDATE conversations SET assigned_to='u1' WHERE id='c1'").run();
  release2();
  await run2;
  assert.equal(effects, 0);
  assert.equal(b.get(second.id).cancel_reason, 'human_takeover');
  assert.deepEqual(
    b
      .history(second.id)
      .map(e => e.kind)
      .slice(-1),
    ['cancelled'],
  );
});

test('un resultado tardío de un intento anterior se descarta (fence por intento)', async t => {
  const { db, brand } = await setup(t),
    c = clock();
  let effects = 0,
    calls = 0;
  const gates = [];
  const a = createAutomation({
    db,
    now: c.now,
    leaseMs: 1000,
    callTimeoutMs: 100_000,
    baseDelayMs: 1,
    log: quiet,
    handlers: {
      w: {
        call: () => new Promise(r => gates.push(r)),
        commit: (s, out) => {
          effects++;
          calls++;
          return { out };
        },
      },
    },
  });
  a.setBrand(brand, true, 0, null);
  const { step } = a.enqueue({ brandId: brand, kind: 'w', dedupeKey: 'late', scheduledAt: c.t });
  const slow = a.tick();
  await new Promise(r => setImmediate(r));
  c.t += 2000; // vence el arrendamiento; el mismo proceso recupera el paso
  a.claim();
  c.t += 10;
  const claimed = a.claim();
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].attempts, 2);
  gates[0]('tardío');
  await slow; // el intento 1 termina tarde
  assert.equal(effects, 0);
  assert.equal(a.get(step.id).state, 'reserved');
});

test('pausa por marca y global detiene la ejecución sin perder pasos', async t => {
  const { db, brand } = await setup(t),
    c = clock();
  let effects = 0;
  const a = createAutomation({
    db,
    now: c.now,
    log: quiet,
    handlers: {
      w: {
        commit: () => {
          effects++;
          return {};
        },
      },
    },
  });
  a.setBrand(brand, true, 0, null);
  const { step } = a.enqueue({ brandId: brand, kind: 'w', dedupeKey: 'p', scheduledAt: c.t });
  a.setGlobalPause(true, 1, null);
  await a.tick();
  assert.equal(effects, 0);
  assert.equal(a.get(step.id).state, 'pending');
  assert.equal(a.get(step.id).attempts, 0);
  assert.deepEqual(a.enqueue({ brandId: brand, kind: 'w', dedupeKey: 'p2' }), { skipped: 'disabled' });
  a.setGlobalPause(false, 2, null);
  a.setBrand(brand, false, 1, null);
  await a.tick();
  assert.equal(effects, 0);
  a.setBrand(brand, true, 2, null);
  await a.tick();
  assert.equal(effects, 1);
  assert.equal(a.get(step.id).state, 'completed');
});

test('cancelar manualmente y por conversación sólo afecta pasos activos de esa conversación', async t => {
  const { db, brand } = await setup(t),
    c = clock(),
    a = createAutomation({ db, now: c.now, log: quiet, handlers: { w: { commit: () => ({}) } } });
  a.setBrand(brand, true, 0, null);
  const one = a.enqueue({
      brandId: brand,
      conversationId: 'c1',
      kind: 'w',
      dedupeKey: 'a',
      scheduledAt: c.t + 99999,
    }).step,
    two = a.enqueue({ brandId: brand, conversationId: null, kind: 'w', dedupeKey: 'b', scheduledAt: c.t + 99999 }).step;
  assert.equal(cancelConversationSteps(db, 'c1', 'conversation_action', c.t), 1);
  assert.equal(a.get(one.id).state, 'cancelled');
  assert.equal(a.get(two.id).state, 'pending');
  assert.throws(() => a.cancel(one.id, 'manual'), /pendientes/);
  a.cancel(two.id, 'manual', 'u1');
  assert.equal(a.get(two.id).cancel_reason, 'manual');
});
