// Bandeja de entrada de webhooks (docs/PLAN_RECEPCION_DURADERA.md).
//
// Recibir y procesar son dos pasos. La petición del proveedor verifica la firma, GUARDA cada evento normalizado con
// accept() y responde; este trabajador los procesa aparte:
//   · con arrendamiento: una fila reservada no la toma nadie más mientras su arrendamiento esté vigente. Si el proceso
//     muere a la mitad, el arrendamiento vence y la fila se procesa otra vez: por eso `process` debe ser idempotente.
//   · con reintentos y espera creciente. Un error con status 4xx o permanent=true no se reintenta: la fila queda
//     «failed», con su carga, y administración puede reprocesarla.
//   · en orden dentro de cada carril (`lane`): de uno en uno y por orden de llegada. Un evento no empieza mientras
//     haya otro anterior de su carril pendiente, reservado o esperando reintento; uno fallido deja de bloquearlo.
//     Carriles distintos avanzan a la vez (hasta `concurrency`).
// Es genérico: no sabe qué es un evento. Quien lo crea le da `process(row)`, que devuelve el texto del resultado.
import { randomUUID } from 'node:crypto';
import { transaction } from '../database.mjs';
import { backoff } from '../automation.mjs';
import { safeError, withTimeout } from './leases.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Cómo listar cada estado. Los que son pocos frente al total se leen por su índice parcial (sin estadísticas, el
// planificador recorrería la tabla entera para encontrarlos).
const LISTS = {
  pending: "INDEXED BY webhook_inbox_due WHERE state='pending'",
  reserved: "INDEXED BY webhook_inbox_leases WHERE state='reserved'",
  failed: "INDEXED BY webhook_inbox_failed WHERE state='failed'",
  done: "WHERE state='done'",
  all: '',
};
const COLUMNS =
  'seq,kind,provider,event_id,type,state,attempts,max_attempts,next_attempt_at,result,error,received_at,updated_at,done_at,payload IS NOT NULL AS has_payload';
// La cabeza de cada carril libre: pendiente, ya vencida y sin nada anterior de su carril a medias.
const HEADS = `SELECT i.* FROM webhook_inbox i WHERE i.state='pending' AND i.next_attempt_at<=?
  AND NOT EXISTS(SELECT 1 FROM webhook_inbox p WHERE p.lane=i.lane AND p.seq<i.seq AND p.state IN ('pending','reserved'))
  ORDER BY i.next_attempt_at,i.seq LIMIT ?`;

const view = row =>
  row && {
    seq: row.seq,
    kind: row.kind,
    provider: row.provider,
    eventId: row.event_id,
    type: row.type,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    result: row.result,
    error: row.error,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at,
    hasPayload: Boolean(row.has_payload),
  };

export function createWebhookInbox({
  db,
  process: handler,
  kinds = ['channel', 'payment'],
  now = Date.now,
  workerId = randomUUID(),
  concurrency = 8,
  leaseMs = 120_000,
  processTimeoutMs = 60_000,
  baseDelayMs = 2_000,
  capDelayMs = 30 * 60_000,
  maxAttempts = 12,
  pollMs = 200,
  paused = false,
  doneKeepMs = 30 * DAY,
  failedPayloadKeepMs = 14 * DAY,
  failedKeepMs = 90 * DAY,
  purgeBatch = 1000,
  log = console,
}) {
  const allowed = new Set(kinds);
  const flying = new Set(); // filas que este proceso está procesando ahora
  const waiters = new Set(); // peticiones que esperan a que sus filas terminen
  const idleWaiters = [];
  let stopped = false;
  let purgedAt = 0;

  // 1) Guardar. Idempotente por (proveedor, id del evento): si ya estaba, devuelve la fila que hay, con existing=true.
  // `kind` no tiene restricción en la tabla: la lista admitida se valida aquí.
  function accept({ kind, provider, id, type, lane, payload }) {
    if (!allowed.has(kind)) throw new Error(`Tipo de webhook no admitido: ${kind}`);
    const t = now();
    const eventId = String(id).slice(0, 200);
    const made = db
      .prepare(
        'INSERT OR IGNORE INTO webhook_inbox(kind,provider,event_id,type,lane,payload,max_attempts,next_attempt_at,received_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        kind,
        provider,
        eventId,
        String(type).slice(0, 80),
        String(lane).slice(0, 200),
        JSON.stringify(payload),
        maxAttempts,
        t,
        t,
        t,
      ).changes;
    const row = db
      .prepare('SELECT seq,state,result,error FROM webhook_inbox WHERE provider=? AND event_id=?')
      .get(provider, eventId);
    return { ...row, existing: !made };
  }

  // 2) Reclamar: devuelve a la cola lo que dejó un trabajador cuyo arrendamiento venció y reserva la cabeza de cada
  // carril libre (mismo modelo que automation.claim).
  function claim(limit) {
    return transaction(db, () => {
      const t = now();
      const claimed = [];
      for (const row of db
        .prepare("SELECT seq,attempts,max_attempts FROM webhook_inbox WHERE state='reserved' AND lease_until<=?")
        .all(t)) {
        if (row.attempts >= row.max_attempts)
          db.prepare(
            "UPDATE webhook_inbox SET state='failed',error='Arrendamiento vencido sin resultado',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE seq=?",
          ).run(t, row.seq);
        else
          db.prepare(
            "UPDATE webhook_inbox SET state='pending',next_attempt_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE seq=?",
          ).run(t + backoff(row.attempts, baseDelayMs, capDelayMs), t, row.seq);
      }
      for (const row of db.prepare(HEADS).all(t, limit)) {
        const taken = db
          .prepare(
            "UPDATE webhook_inbox SET state='reserved',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE seq=? AND state='pending'",
          )
          .run(workerId, t + leaseMs, t, row.seq).changes;
        if (taken) claimed.push({ ...row, attempts: row.attempts + 1 });
      }
      return claimed;
    });
  }

  // 3) Ejecutar FUERA de cualquier transacción y anotar el resultado sólo si el arrendamiento sigue siendo nuestro:
  // un trabajador que lo perdió (tardó más de la cuenta y otro retomó la fila) no pisa lo que el otro anote.
  async function run(row) {
    const mine = "seq=? AND state='reserved' AND lease_owner=? AND attempts=?";
    try {
      if (row.payload === null)
        throw Object.assign(new Error('El evento ya no conserva su contenido.'), { permanent: true });
      const result = await withTimeout((async () => handler(row))(), processTimeoutMs);
      const t = now();
      db.prepare(
        `UPDATE webhook_inbox SET state='done',result=?,error=NULL,payload=NULL,lease_owner=NULL,lease_until=NULL,done_at=?,updated_at=? WHERE ${mine}`,
      ).run(String(result ?? '').slice(0, 300), t, t, row.seq, workerId, row.attempts);
    } catch (error) {
      const t = now();
      const permanent = error?.permanent === true || (error?.status >= 400 && error?.status < 500);
      const message = safeError(error);
      try {
        if (permanent || row.attempts >= row.max_attempts)
          db.prepare(
            `UPDATE webhook_inbox SET state='failed',error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE ${mine}`,
          ).run(message, t, row.seq, workerId, row.attempts);
        else
          db.prepare(
            `UPDATE webhook_inbox SET state='pending',error=?,next_attempt_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE ${mine}`,
          ).run(message, t + backoff(row.attempts, baseDelayMs, capDelayMs), t, row.seq, workerId, row.attempts);
      } catch (e) {
        log.error('Webhook inbox bookkeeping failed:', safeError(e)); // el arrendamiento vencerá y la fila se retomará
      }
      log.error('Webhook inbox item failed:', row.type, message.slice(0, 80));
    }
  }

  const notify = seq => {
    for (const waiter of [...waiters]) if (waiter.ids.has(seq)) waiter.check();
  };

  // No hay bandera global: un carril lento no detiene a los demás. Cada pasada toma como mucho los huecos libres.
  function pump() {
    if (paused || stopped) return 0;
    const free = concurrency - flying.size;
    if (free <= 0) return 0;
    const t = now();
    // Sin nada vencido ni arrendamientos caducados no se abre una transacción de escritura: el reloj llama cuatro
    // veces por segundo y casi siempre no hay nada.
    const due = db.prepare("SELECT 1 FROM webhook_inbox WHERE state='pending' AND next_attempt_at<=? LIMIT 1").get(t);
    const expired =
      !due && db.prepare("SELECT 1 FROM webhook_inbox WHERE state='reserved' AND lease_until<=? LIMIT 1").get(t);
    if (!due && !expired) return 0;
    const rows = claim(free);
    for (const row of rows) {
      flying.add(row.seq);
      run(row).finally(() => {
        flying.delete(row.seq);
        notify(row.seq);
        safePump();
        if (!flying.size) for (const resolve of idleWaiters.splice(0)) resolve();
      });
    }
    return rows.length;
  }
  function safePump() {
    try {
      return pump();
    } catch (error) {
      log.error('Webhook inbox pump failed:', safeError(error));
      return 0;
    }
  }
  // Arranca el procesamiento en cuanto termine lo que se está ejecutando ahora (nunca dentro de una transacción ajena).
  const wake = () => {
    if (!paused && !stopped) setImmediate(safePump);
  };

  // 4) Esperar, como mucho `ms`, a que estas filas terminen (done o failed). Devuelve un Map seq → {seq,state,result,error}
  // con su estado en ese momento. Con ms=0 no espera.
  function settled(seqs, ms = 0) {
    const ids = [...new Set(seqs)];
    const key = JSON.stringify(ids);
    const read = () =>
      new Map(
        db
          .prepare(
            'SELECT seq,state,result,error FROM webhook_inbox WHERE seq IN (SELECT value FROM json_each(?)) ORDER BY seq',
          )
          .all(key)
          .map(row => [row.seq, row]),
      );
    const finished = rows =>
      ids.every(seq => {
        const row = rows.get(seq);
        return !row || row.state === 'done' || row.state === 'failed';
      });
    let rows = read();
    if (!(ms > 0) || finished(rows)) return Promise.resolve(rows);
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        clearInterval(poll);
        waiters.delete(waiter);
        resolve(rows);
      };
      const check = final => {
        try {
          rows = read();
        } catch (error) {
          log.error('Webhook inbox wait failed:', safeError(error));
          return finish();
        }
        if (final || finished(rows)) finish();
      };
      const waiter = { ids: new Set(ids), check: () => check(false) };
      const timer = setTimeout(() => check(true), ms);
      // Sondeo: las filas también pueden terminar por otro proceso o al vencer un arrendamiento.
      const poll = setInterval(() => check(false), pollMs);
      waiters.add(waiter);
    });
  }

  // Promesa que se cumple cuando este proceso no tiene ninguna fila en vuelo (para el apagado ordenado y las pruebas).
  const idle = () => (flying.size ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve());
  // Apagado: no se toma nada nuevo; lo que está en vuelo termina.
  const stop = () => {
    stopped = true;
  };
  // Último paso del apagado, justo antes de salir: lo que este proceso tenía reservado y no terminó vuelve a la cola
  // sin gastar un intento, para que el siguiente arranque lo procese de inmediato en vez de esperar al arrendamiento.
  function release() {
    const t = now();
    return db
      .prepare(
        "UPDATE webhook_inbox SET state='pending',attempts=max(attempts-1,0),next_attempt_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE state='reserved' AND lease_owner=?",
      )
      .run(t, t, workerId).changes;
  }

  // Limpieza: lo procesado se borra a los 30 días; a lo fallido se le vacía la carga a los 14 y se borra a los 90.
  function purge() {
    const t = now();
    const done = db
      .prepare(
        "DELETE FROM webhook_inbox WHERE seq IN (SELECT seq FROM webhook_inbox WHERE state='done' AND done_at<? LIMIT ?)",
      )
      .run(t - doneKeepMs, purgeBatch).changes;
    const emptied = db
      .prepare("UPDATE webhook_inbox SET payload=NULL WHERE state='failed' AND payload IS NOT NULL AND updated_at<?")
      .run(t - failedPayloadKeepMs).changes;
    const failed = db
      .prepare("DELETE FROM webhook_inbox WHERE state='failed' AND updated_at<?")
      .run(t - failedKeepMs).changes;
    return { done, emptied, failed, more: done >= purgeBatch };
  }

  // Lo que llama el reloj: red de seguridad del procesamiento (lo normal es que wake() lo arranque al instante) y,
  // una vez por hora, la limpieza. Si la limpieza llenó su tope, continúa en la pasada siguiente.
  function tick() {
    const started = pump();
    const t = now();
    if (t - purgedAt >= HOUR) purgedAt = purge().more ? 0 : t;
    return started;
  }

  const get = seq => view(db.prepare(`SELECT ${COLUMNS} FROM webhook_inbox WHERE seq=?`).get(seq));
  // Para administración: nunca devuelve la carga (lleva textos y números), sólo si la fila la conserva.
  function list({ state = 'failed', limit = 100 } = {}) {
    const from = Object.hasOwn(LISTS, state) ? LISTS[state] : LISTS.failed;
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    return db.prepare(`SELECT ${COLUMNS} FROM webhook_inbox ${from} ORDER BY seq DESC LIMIT ?`).all(n).map(view);
  }
  function stats() {
    const count = sql => db.prepare(sql).get().n;
    const oldest = db.prepare("SELECT min(received_at) t FROM webhook_inbox WHERE state='pending'").get().t;
    return {
      pending: count("SELECT count(*) n FROM webhook_inbox WHERE state='pending'"),
      reserved: count("SELECT count(*) n FROM webhook_inbox WHERE state='reserved'"),
      failed: count("SELECT count(*) n FROM webhook_inbox WHERE state='failed'"),
      oldestPendingSec: oldest === null ? null : Math.max(0, Math.round((now() - oldest) / 1000)),
      inFlight: flying.size,
      paused: paused || stopped,
    };
  }
  // Reproceso manual de una fila fallida: vuelve a pendiente con los intentos en cero.
  function retry(seq) {
    const row = transaction(db, () => {
      const current = db
        .prepare('SELECT state,payload IS NOT NULL AS has_payload FROM webhook_inbox WHERE seq=?')
        .get(seq);
      if (!current) throw fail(404, 'Ese evento no está en la bandeja de webhooks.');
      if (current.state !== 'failed') throw fail(409, 'Sólo se reprocesa un evento fallido.');
      if (!current.has_payload)
        throw fail(409, 'Este evento ya no conserva su contenido (se vacía a los 14 días) y no se puede reprocesar.');
      const t = now();
      db.prepare(
        "UPDATE webhook_inbox SET state='pending',attempts=0,error=NULL,next_attempt_at=?,updated_at=? WHERE seq=?",
      ).run(t, t, seq);
      return get(seq);
    });
    wake();
    return row;
  }

  return { accept, tick, wake, settled, idle, stop, release, purge, get, list, stats, retry, workerId };
}
