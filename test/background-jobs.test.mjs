import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { createJobRunner } from '../server/app/background-jobs.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';

// Ejecutor de trabajos por trozos (server/app/background-jobs.mjs; docs/PLAN_IMPORTAR_CONTACTOS.md): trozos con su
// cursor en la misma transacción, reanudación con otro proceso, arrendamiento, cancelación, reintentos y fallos.

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-jobs-'));
  const db = openDatabase(dir);
  migrate(db, { backup: false });
  assertSchemaCurrent(db);
  db.exec('CREATE TABLE counted(n INTEGER PRIMARY KEY)');
  db.prepare("INSERT INTO brands(id,name,created_at) VALUES('marca-a','Marca A',1)").run();
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

// Un trabajo que cuenta de 1 a `params.upTo`, una fila por número, con el cursor en el último escrito.
function counter(db, { failAt = null, permanent = false } = {}) {
  let failures = 0;
  return {
    failures: () => failures,
    step(job, { limit }) {
      const from = job.cursor?.last ?? 0;
      const to = Math.min(job.params.upTo, from + limit);
      for (let n = from + 1; n <= to; n++) {
        if (n === failAt && (permanent || failures < 1)) {
          failures++;
          throw Object.assign(new Error('Fallo de prueba en ' + n), { permanent });
        }
        db.prepare('INSERT INTO counted(n) VALUES(?)').run(n);
      }
      return { processed: to - from, cursor: { last: to }, finished: to >= job.params.upTo, result: { last: to } };
    },
  };
}

const runner = (db, extra = {}) =>
  createJobRunner({ db, transaction, chunkRows: 10, rowsPerPass: 30, budgetMs: 10_000, log: { error() {} }, ...extra });

test('un trabajo avanza por trozos, anuncia su progreso y termina sin repetir filas', async t => {
  const db = await setup(t);
  const emitted = [];
  const jobs = runner(db, { emit: (type, target) => emitted.push({ type, ...target }) });
  jobs.define('prueba.contar', counter(db));
  const job = transaction(db, () =>
    jobs.enqueue({ kind: 'prueba.contar', brandId: 'marca-a', params: { upTo: 75 }, total: 75, clientRef: 'r1' }),
  );
  // El mismo clientRef devuelve el mismo trabajo.
  assert.equal(transaction(db, () => jobs.enqueue({ kind: 'prueba.contar', clientRef: 'r1' })).id, job.id);
  assert.deepEqual(await jobs.tick(), { rows: 30, chunks: 3 }, 'una pasada respeta el tope de filas');
  assert.equal(jobs.get(job.id).done, 30);
  assert.equal(jobs.get(job.id).state, 'running');
  assert.equal(jobs.get(job.id).lease_owner, null, 'entre pasadas no queda arrendamiento');
  await jobs.tick();
  await jobs.tick();
  const done = jobs.get(job.id);
  assert.equal(done.state, 'done');
  assert.equal(done.done, 75);
  assert.deepEqual(done.result, { last: 75 });
  assert.equal(db.prepare('SELECT count(*) n FROM counted').get().n, 75);
  assert.ok(emitted.every(e => e.type === 'job.progress' && e.brandId === 'marca-a' && e.data.jobId === job.id));
  assert.equal(emitted.at(-1).data.state, 'done');
  assert.deepEqual(await jobs.tick(), { rows: 0, chunks: 0 }, 'sin trabajo pendiente la pasada no hace nada');
});

test('otro proceso continúa donde quedó el último trozo confirmado, y respeta un arrendamiento vigente', async t => {
  const db = await setup(t);
  let clock = 1_000_000;
  const now = () => clock;
  const first = runner(db, { now, workerId: 'proceso-1' });
  first.define('prueba.contar', counter(db));
  const job = transaction(db, () => first.enqueue({ kind: 'prueba.contar', params: { upTo: 50 } }));
  await first.tick();
  assert.equal(first.get(job.id).done, 30);
  // Un proceso que murió con un trozo a medias: su arrendamiento sigue vigente y nadie más toma el trabajo.
  db.prepare("UPDATE background_jobs SET lease_owner='proceso-muerto',lease_until=? WHERE id=?").run(
    clock + 30_000,
    job.id,
  );
  const second = runner(db, { now, workerId: 'proceso-2' });
  second.define('prueba.contar', counter(db));
  assert.deepEqual(await second.tick(), { rows: 0, chunks: 0 });
  clock += 30_001; // el arrendamiento vence
  await second.tick();
  assert.equal(second.get(job.id).state, 'done');
  assert.equal(db.prepare('SELECT count(*) n FROM counted').get().n, 50, 'ninguna fila se escribió dos veces');
});

test('cancelar: en cola se cancela al momento; en marcha, antes del siguiente trozo', async t => {
  const db = await setup(t);
  const cancelled = [];
  const jobs = runner(db);
  jobs.define('prueba.contar', { ...counter(db), onCancel: job => cancelled.push(job.id) });
  const queued = transaction(db, () => jobs.enqueue({ kind: 'prueba.contar', params: { upTo: 10 } }));
  assert.equal(transaction(db, () => jobs.cancel(queued.id)).state, 'cancelled');
  const running = transaction(db, () => jobs.enqueue({ kind: 'prueba.contar', params: { upTo: 100 } }));
  await jobs.tick();
  assert.equal(transaction(db, () => jobs.cancel(running.id)).cancel_requested, true);
  await jobs.tick();
  const after = jobs.get(running.id);
  assert.equal(after.state, 'cancelled');
  assert.equal(after.done, 30, 'lo hecho se queda');
  assert.deepEqual(cancelled, [queued.id, running.id]);
  assert.equal(db.prepare('SELECT count(*) n FROM counted').get().n, 30);
});

test('un fallo pasajero se reintenta sin dejar el trozo a medias; uno permanente falla el trabajo', async t => {
  const db = await setup(t);
  let clock = 5_000_000;
  const now = () => clock;
  const failed = [];
  const jobs = runner(db, { now });
  const flaky = counter(db, { failAt: 15 });
  jobs.define('prueba.contar', flaky);
  const job = transaction(db, () => jobs.enqueue({ kind: 'prueba.contar', params: { upTo: 20 } }));
  await jobs.tick();
  assert.equal(jobs.get(job.id).done, 10, 'el segundo trozo se deshizo entero');
  assert.equal(jobs.get(job.id).attempts, 1);
  assert.match(jobs.get(job.id).error, /Fallo de prueba/);
  assert.deepEqual(await jobs.tick(), { rows: 0, chunks: 0 }, 'espera antes de reintentar');
  clock += 2001;
  await jobs.tick();
  assert.equal(jobs.get(job.id).state, 'done');
  assert.equal(db.prepare('SELECT count(*) n FROM counted').get().n, 20);

  const broken = createJobRunner({ db, transaction, now, chunkRows: 10, log: { error() {} } });
  broken.define('prueba.roto', { ...counter(db, { failAt: 3, permanent: true }), onFail: j => failed.push(j.id) });
  const bad = transaction(db, () => broken.enqueue({ kind: 'prueba.roto', params: { upTo: 5 } }));
  db.exec('DELETE FROM counted');
  await broken.tick();
  assert.equal(broken.get(bad.id).state, 'failed');
  assert.deepEqual(failed, [bad.id]);
  assert.equal(db.prepare('SELECT count(*) n FROM counted').get().n, 0);
  assert.equal(broken.view(broken.get(bad.id)).error, 'Fallo de prueba en 3');
});

test('un tipo de trabajo se define una vez y con step()', async t => {
  const db = await setup(t);
  const jobs = runner(db);
  jobs.define('prueba.uno', counter(db));
  assert.throws(() => jobs.define('prueba.uno', counter(db)), /ya está definido/);
  assert.throws(() => jobs.define('Mal Nombre', counter(db)), TypeError);
  assert.throws(() => jobs.define('prueba.dos', {}), TypeError);
  assert.throws(() => jobs.enqueue({ kind: 'prueba.desconocido' }), /sin definir/);
});
