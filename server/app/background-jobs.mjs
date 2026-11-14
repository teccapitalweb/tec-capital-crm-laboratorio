// Ejecutor de trabajos largos por trozos (docs/PLAN_IMPORTAR_CONTACTOS.md; conciliación técnica, fila 5).
//
// Por qué existe: importar 6 500 contactos, editar miles en lote o rellenar un índice no cabe en una petición ni en
// una sola transacción sin congelar el servidor (SQLite es síncrono). Aquí se parte en trozos: cada pasada del reloj
// RECLAMA un trabajo con arrendamiento (el patrón de server/app/leases.mjs), procesa un trozo en UNA transacción
// síncrona que guarda también el cursor y el progreso, y suelta el arrendamiento. Si el proceso muere a la mitad, la
// transacción se deshace y el arrendamiento vence: el trabajo sigue donde quedó el último trozo confirmado, sin repetir
// filas. Entre trozos cede el hilo y mira si se pidió cancelar.
//
// Hay un ejecutor por base de datos: sharedJobRunner(host) lo crea la primera vez y lo devuelve a todo módulo que lo
// pida, así que el orden en que se crean los módulos no importa (el reloj y las rutas están en server/modules/jobs/).
// Cada módulo declara sus tipos AL CREARSE (para que un trabajo a medias siga tras un reinicio) con
// define(kind, { step, onCancel?, onFail?, permission? }):
//
//   step(job, { limit, now })  síncrona, dentro de la transacción del ejecutor: sin red, sin transaction() propia.
//                              Procesa como mucho `limit` unidades desde `job.cursor` y devuelve
//                              { processed, cursor, finished?, total?, result? }. Lo que escriba se confirma junto
//                              con el cursor. Un error con `permanent: true` falla el trabajo de inmediato; cualquier
//                              otro se reintenta (hasta `maxAttempts`) con espera creciente.
//   onCancel(job) / onFail(job, error)   síncronas, en la transacción que marca el estado final.
//   permission                 clave del catálogo para ver o cancelar el trabajo por /api/jobs (por omisión, sólo
//                              administración).
//
// `enqueue` y `cancel` son componibles (sin transacción propia): se llaman dentro de la de quien los pide. Los avisos
// en vivo (`job.progress`) salen sólo después de confirmar cada trozo.
import { randomUUID } from 'node:crypto';
import { safeError } from './leases.mjs';

const KIND = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;
const ACTIVE = "state IN ('queued','running')";
const yieldThread = () => new Promise(done => setImmediate(done));

export function createJobRunner({
  db,
  transaction,
  emit = () => {},
  now = Date.now,
  workerId = randomUUID(),
  leaseMs = 30_000,
  rowsPerPass = 1000,
  chunkRows = 100,
  budgetMs = 800,
  maxAttempts = 3,
  log = console,
}) {
  if (!db || typeof transaction !== 'function') throw new TypeError('createJobRunner necesita { db, transaction }.');
  const kinds = new Map();
  let busy = false;

  const parse = row =>
    row && {
      ...row,
      cursor: row.cursor === null ? null : JSON.parse(row.cursor),
      params: JSON.parse(row.params || '{}'),
      result: JSON.parse(row.result || '{}'),
      cancel_requested: Boolean(row.cancel_requested),
    };
  const getRow = id => db.prepare('SELECT * FROM background_jobs WHERE id=?').get(id);
  const get = id => (typeof id === 'string' ? parse(getRow(id)) : null);

  // Lo que se enseña de un trabajo: nada de arrendamientos ni parámetros internos.
  const view = job =>
    job && {
      id: job.id,
      kind: job.kind,
      brandId: job.brand_id,
      refId: job.ref_id,
      state: job.state,
      done: job.done,
      total: job.total,
      cancelRequested: Boolean(job.cancel_requested),
      error: job.state === 'failed' ? job.error : null,
      result: job.result,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
    };

  function define(kind, handler) {
    if (typeof kind !== 'string' || !KIND.test(kind) || kind.length > 60)
      throw new TypeError(`Tipo de trabajo no válido: ${kind}`);
    if (kinds.has(kind)) throw new Error(`El tipo de trabajo «${kind}» ya está definido.`);
    if (typeof handler?.step !== 'function') throw new TypeError(`El trabajo «${kind}» necesita step(job, opciones).`);
    kinds.set(kind, handler);
  }
  const definition = kind => kinds.get(kind) ?? null;

  // Componible. Con `clientRef`, repetir la petición devuelve el mismo trabajo.
  function enqueue({ kind, brandId = null, createdBy = null, refId = null, params = {}, total = 0, clientRef = null }) {
    if (!kinds.has(kind)) throw new Error(`Tipo de trabajo sin definir: ${kind}`);
    const ref = clientRef ? `${kind}:${String(clientRef).slice(0, 100)}` : null;
    if (ref) {
      const found = db.prepare('SELECT * FROM background_jobs WHERE client_ref=?').get(ref);
      if (found) return { ...parse(found), replayed: true };
    }
    const id = randomUUID();
    const t = now();
    db.prepare(
      'INSERT INTO background_jobs(id,kind,brand_id,created_by,ref_id,total,params,client_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(id, kind, brandId, createdBy, refId, Math.max(0, Number(total) || 0), JSON.stringify(params), ref, t, t);
    return get(id);
  }

  // Componible. Uno en cola se cancela en el acto; uno en marcha se detiene antes de su siguiente trozo (lo ya hecho
  // se queda). Devuelve el trabajo como quedó.
  function cancel(id) {
    const job = get(id);
    if (!job || !['queued', 'running'].includes(job.state)) return job;
    if (job.state === 'queued' && !job.lease_owner) {
      finish(job, 'cancelled');
      definition(job.kind)?.onCancel?.(get(id));
      return get(id);
    }
    db.prepare('UPDATE background_jobs SET cancel_requested=1,updated_at=? WHERE id=?').run(now(), id);
    return get(id);
  }

  function finish(job, state, fields = {}) {
    const t = now();
    db.prepare(
      'UPDATE background_jobs SET state=?,error=?,result=?,lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE id=?',
    ).run(state, fields.error ?? null, JSON.stringify(fields.result ?? job.result ?? {}), t, t, job.id);
  }

  // Reclama el trabajo pendiente más antiguo de un tipo conocido cuyo arrendamiento esté libre o vencido.
  function claim() {
    if (!kinds.size) return null;
    const list = [...kinds.keys()];
    return transaction(db, () => {
      const t = now();
      const row = db
        .prepare(
          `SELECT id FROM background_jobs WHERE ${ACTIVE} AND kind IN (${list.map(() => '?').join(',')}) AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at LIMIT 1`,
        )
        .get(...list, t);
      if (!row) return null;
      const taken = db
        .prepare(
          `UPDATE background_jobs SET state='running',lease_owner=?,lease_until=?,started_at=coalesce(started_at,?),updated_at=? WHERE id=? AND ${ACTIVE} AND (lease_until IS NULL OR lease_until<=?)`,
        )
        .run(workerId, t + leaseMs, t, t, row.id, t).changes;
      return taken ? get(row.id) : null;
    });
  }

  // Un trozo del trabajo reclamado. Devuelve lo que se anuncia en vivo y cuántas unidades se procesaron.
  function runChunk(claimed, limit) {
    const handler = definition(claimed.kind);
    try {
      return transaction(db, () => {
        const job = get(claimed.id);
        if (!job || job.lease_owner !== workerId || job.state !== 'running') return { processed: 0, job };
        if (job.cancel_requested) {
          finish(job, 'cancelled');
          handler.onCancel?.(get(job.id));
          return { processed: 0, job: get(job.id) };
        }
        const out = handler.step(job, { limit, now: now() }) ?? {};
        const processed = Math.max(0, Number(out.processed) || 0);
        const t = now();
        const total = Number.isFinite(out.total) ? out.total : job.total;
        const result = JSON.stringify(out.result ?? job.result ?? {});
        if (out.finished)
          db.prepare(
            "UPDATE background_jobs SET state='done',done=done+?,total=?,cursor=?,result=?,error=NULL,lease_owner=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE id=?",
          ).run(processed, total, JSON.stringify(out.cursor ?? null), result, t, t, job.id);
        else
          db.prepare(
            'UPDATE background_jobs SET done=done+?,total=?,cursor=?,result=?,error=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?',
          ).run(processed, total, JSON.stringify(out.cursor ?? null), result, t, job.id);
        return { processed, job: get(job.id) };
      });
    } catch (error) {
      // El trozo se deshizo entero. Se anota el intento fuera de esa transacción.
      return transaction(db, () => {
        const job = get(claimed.id);
        if (!job || job.lease_owner !== workerId) return { processed: 0, job };
        const attempts = job.attempts + 1;
        if (error?.permanent || attempts >= maxAttempts) {
          db.prepare('UPDATE background_jobs SET attempts=? WHERE id=?').run(attempts, job.id);
          finish(job, 'failed', { error: safeError(error) });
          handler.onFail?.(get(job.id), error);
          log.error?.(`Trabajo ${job.kind} ${job.id} falló:`, safeError(error));
        } else {
          const t = now();
          db.prepare(
            'UPDATE background_jobs SET attempts=?,error=?,lease_owner=NULL,lease_until=?,updated_at=? WHERE id=?',
          ).run(attempts, safeError(error), t + 2000 * attempts, t, job.id);
        }
        return { processed: 0, job: get(job.id), failed: true };
      });
    }
  }

  function announce(job) {
    if (!job?.brand_id) return;
    try {
      emit('job.progress', {
        brandId: job.brand_id,
        data: { jobId: job.id, kind: job.kind, refId: job.ref_id, state: job.state, done: job.done, total: job.total },
      });
    } catch (error) {
      log.error?.('Aviso de progreso sin enviar:', safeError(error));
    }
  }

  // Una pasada del reloj: trozos de `chunkRows` hasta `rowsPerPass` unidades o `budgetMs`, cediendo el hilo entre
  // trozos. No se pisa a sí misma.
  async function tick() {
    if (busy) return { rows: 0, chunks: 0 };
    busy = true;
    const started = now();
    let rows = 0;
    let chunks = 0;
    try {
      while (rows < rowsPerPass && now() - started < budgetMs) {
        const claimed = claim();
        if (!claimed) break;
        const { processed, job, failed } = runChunk(claimed, Math.min(chunkRows, rowsPerPass - rows));
        rows += processed;
        chunks++;
        announce(job);
        if (failed) break;
        await yieldThread();
      }
    } finally {
      busy = false;
    }
    return { rows, chunks };
  }

  // Para pruebas y diagnósticos: ¿queda algo por hacer?
  const pending = () => db.prepare(`SELECT count(*) n FROM background_jobs WHERE ${ACTIVE}`).get().n;

  return { define, definition, enqueue, cancel, get, view, tick, pending, workerId };
}

const shared = new WeakMap();
const bounded = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

// El ejecutor común de un servidor (uno por base de datos). JOBS_LEASE_MS y JOBS_ROWS_PER_PASS sólo sirven para
// pruebas y diagnósticos; los valores por omisión bastan en producción.
export function sharedJobRunner(host) {
  if (!shared.has(host.db))
    shared.set(
      host.db,
      createJobRunner({
        db: host.db,
        transaction: host.transaction,
        emit: (type, target) => host.realtime?.emit?.(type, target),
        leaseMs: bounded(process.env.JOBS_LEASE_MS, 1000, 600_000, 30_000),
        rowsPerPass: bounded(process.env.JOBS_ROWS_PER_PASS, 50, 5000, 1000),
      }),
    );
  return shared.get(host.db);
}
