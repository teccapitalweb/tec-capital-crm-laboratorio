import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const STALE = Symbol('stale');
const safeError = e =>
  String(e?.message || e)
    .replace(/[\x00-\x1f]+/g, ' ')
    .slice(0, 200);
export const backoff = (attempt, base, cap) => Math.min(cap, base * 2 ** Math.max(0, attempt - 1));

function event(db, step, kind, details = {}, actor = null, at = Date.now()) {
  db.prepare(
    'INSERT INTO automation_events(step_id,brand_id,actor_id,kind,details,created_at) VALUES(?,?,?,?,?,?)',
  ).run(step.id, step.brand_id, actor, kind, JSON.stringify(details), at);
}

// Cancela pasos pendientes o reservados de una conversación. No abre transacción: se compone con la del llamador
// (toma humana, cierre, cambio de responsable). Un paso reservado queda cancelado; su ejecutor lo detecta antes del efecto.
export function cancelSteps(db, rows, reason, actor = null, now = Date.now()) {
  for (const row of rows) {
    db.prepare(
      "UPDATE automation_steps SET state='cancelled',cancel_reason=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state IN ('pending','reserved')",
    ).run(reason, now, row.id);
    event(db, row, 'cancelled', { reason }, actor, now);
  }
  return rows.length;
}
export function cancelConversationSteps(db, conversationId, reason, now = Date.now()) {
  return cancelSteps(
    db,
    db
      .prepare("SELECT id,brand_id FROM automation_steps WHERE conversation_id=? AND state IN ('pending','reserved')")
      .all(conversationId),
    reason,
    null,
    now,
  );
}

// Motor de pasos diferidos. Cada tipo de paso registra un manejador:
//   check(step)        -> null | {cancel:'motivo'}   síncrono; se evalúa antes de la llamada y otra vez justo antes del efecto
//   call(step)         -> Promise (opcional)         trabajo lento o de red; se ejecuta FUERA de la transacción SQLite
//   commit(step,out)   -> objeto resultado           síncrono; se ejecuta dentro de la transacción junto con el cambio de estado
// Un error con permanent=true o status 4xx no se reintenta; cualquier otro se reintenta con espera creciente hasta max_attempts.
export function createAutomation({
  db,
  handlers = {},
  onChange = () => {},
  now = Date.now,
  workerId = randomUUID(),
  leaseMs = 60_000,
  callTimeoutMs = 30_000,
  baseDelayMs = 5_000,
  capDelayMs = 15 * 60_000,
  batch = 10,
  defaultAttempts = 4,
  log = console,
}) {
  const get = id => db.prepare('SELECT * FROM automation_steps WHERE id=?').get(id);
  const view = step => step && { ...step, payload: JSON.parse(step.payload) };
  const globalState = () => db.prepare('SELECT * FROM automation_global WHERE id=1').get();
  const brandState = id => db.prepare('SELECT * FROM automation_settings WHERE brand_id=?').get(id);
  const enabledFor = brandId => !globalState().paused && Boolean(brandState(brandId)?.enabled);
  let running = false;
  const register = (kind, handler) => {
    handlers[kind] = handler;
  };

  function enqueue({
    brandId,
    conversationId = null,
    kind,
    payload = {},
    dedupeKey,
    scheduledAt = now(),
    maxAttempts = defaultAttempts,
    onCreate = null,
  }) {
    if (!handlers[kind]) throw fail(400, 'Tipo de paso no registrado.');
    if (typeof dedupeKey !== 'string' || dedupeKey.length < 1 || dedupeKey.length > 200)
      throw fail(400, 'Clave de idempotencia no válida.');
    if (!Number.isFinite(scheduledAt) || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
      throw fail(400, 'Programación no válida.');
    const text = JSON.stringify(payload);
    if (text.length > 8000) throw fail(400, 'El contenido del paso es demasiado grande.');
    return transaction(db, () => {
      const existing = db.prepare('SELECT * FROM automation_steps WHERE dedupe_key=?').get(dedupeKey);
      if (existing) {
        if (existing.kind !== kind || existing.brand_id !== brandId || existing.conversation_id !== conversationId)
          throw fail(409, 'La clave de idempotencia ya pertenece a otro paso.');
        return { step: view(existing), duplicate: true };
      }
      if (!enabledFor(brandId)) return { skipped: 'disabled' };
      const t = now(),
        id = randomUUID();
      db.prepare(
        'INSERT INTO automation_steps(id,brand_id,conversation_id,kind,payload,dedupe_key,scheduled_at,next_attempt_at,max_attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      ).run(id, brandId, conversationId, kind, text, dedupeKey, scheduledAt, scheduledAt, maxAttempts, t, t);
      event(db, { id, brand_id: brandId }, 'created', { kind, scheduledAt }, null, t);
      const step = view(get(id));
      if (onCreate) onCreate(step);
      return { step, duplicate: false };
    });
  }

  // Recupera pasos cuyo ejecutor dejó caducar el arrendamiento y reserva los vencidos de marcas habilitadas.
  function claim(limit = batch) {
    return transaction(db, () => {
      const t = now();
      for (const s of db.prepare("SELECT * FROM automation_steps WHERE state='reserved' AND lease_until<=?").all(t)) {
        if (s.attempts >= s.max_attempts) {
          db.prepare(
            "UPDATE automation_steps SET state='failed',error='Arrendamiento vencido sin resultado',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          ).run(t, s.id);
          event(db, s, 'failed', { reason: 'lease_expired', attempts: s.attempts }, null, t);
        } else {
          db.prepare(
            "UPDATE automation_steps SET state='pending',next_attempt_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          ).run(t + backoff(s.attempts, baseDelayMs, capDelayMs), t, s.id);
          event(db, s, 'lease_expired', { attempts: s.attempts }, null, t);
        }
      }
      const claimed = [],
        cache = new Map();
      for (const s of db
        .prepare(
          "SELECT * FROM automation_steps WHERE state='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at LIMIT ?",
        )
        .all(t, limit * 4)) {
        if (claimed.length >= limit) break;
        if (!cache.has(s.brand_id)) cache.set(s.brand_id, enabledFor(s.brand_id));
        if (!cache.get(s.brand_id)) continue;
        const r = db
          .prepare(
            "UPDATE automation_steps SET state='reserved',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND state='pending'",
          )
          .run(workerId, t + leaseMs, t, s.id);
        if (!r.changes) continue;
        event(db, s, 'reserved', { attempt: s.attempts + 1, worker: workerId }, null, t);
        claimed.push(get(s.id));
      }
      return claimed;
    });
  }

  function cancel(id, reason, actor = null) {
    return transaction(db, () => {
      const s = get(id);
      if (!s) throw fail(404, 'Paso no encontrado.');
      if (!['pending', 'reserved'].includes(s.state))
        throw fail(409, 'Sólo se pueden cancelar pasos pendientes o en curso.');
      db.prepare(
        "UPDATE automation_steps SET state='cancelled',cancel_reason=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
      ).run(reason, now(), id);
      event(db, s, 'cancelled', { reason }, actor, now());
      return view(get(id));
    });
  }

  function retry(id, actor) {
    return transaction(db, () => {
      const s = get(id);
      if (!s) throw fail(404, 'Paso no encontrado.');
      if (s.state !== 'failed') throw fail(409, 'Sólo se puede reintentar un paso fallido.');
      const t = now();
      db.prepare(
        "UPDATE automation_steps SET state='pending',attempts=0,next_attempt_at=?,error=NULL,updated_at=? WHERE id=?",
      ).run(t, t, id);
      event(db, s, 'manual_retry', {}, actor, t);
      return view(get(id));
    });
  }

  function settle(step, error) {
    transaction(db, () => {
      const s = get(step.id);
      if (!s || s.state !== 'reserved' || s.attempts !== step.attempts) return;
      const t = now(),
        permanent = error?.permanent === true || (error?.status >= 400 && error?.status < 500),
        message = safeError(error);
      if (permanent || s.attempts >= s.max_attempts) {
        db.prepare(
          "UPDATE automation_steps SET state='failed',error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
        ).run(message, t, s.id);
        event(db, s, 'failed', { attempt: s.attempts, permanent, error: message }, null, t);
      } else {
        const next = t + backoff(s.attempts, baseDelayMs, capDelayMs);
        db.prepare(
          "UPDATE automation_steps SET state='pending',next_attempt_at=?,error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
        ).run(next, message, t, s.id);
        event(db, s, 'retry_scheduled', { attempt: s.attempts, nextAttemptAt: next, error: message }, null, t);
      }
    });
  }

  function withTimeout(promise) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(Error('Tiempo de espera agotado.'), { transient: true })),
          callTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  const owns = (live, step) =>
    live && live.state === 'reserved' && live.lease_owner === workerId && live.attempts === step.attempts;

  async function execute(step) {
    const handler = handlers[step.kind];
    let out;
    try {
      if (!handler) throw Object.assign(Error('Tipo de paso sin manejador.'), { permanent: true });
      const live = get(step.id);
      if (!owns(live, step)) return;
      const verdict = handler.check?.(view(live));
      if (verdict?.cancel) {
        transaction(db, () => {
          const s = get(step.id);
          if (!owns(s, step)) return;
          db.prepare(
            "UPDATE automation_steps SET state='cancelled',cancel_reason=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          ).run(verdict.cancel, now(), s.id);
          event(db, s, 'cancelled', { reason: verdict.cancel, phase: 'before_call' });
        });
        return;
      }
      if (handler.call) out = await withTimeout(handler.call(view(live)));
    } catch (error) {
      try {
        settle(step, error);
      } catch (e) {
        log.error('Automation settle failed:', safeError(e));
      }
      return;
    }
    let done = null;
    try {
      transaction(db, () => {
        const s = get(step.id);
        if (!owns(s, step)) throw STALE;
        const t = now();
        if (!enabledFor(s.brand_id)) {
          db.prepare(
            "UPDATE automation_steps SET state='pending',attempts=attempts-1,next_attempt_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          ).run(t, t, s.id);
          event(db, s, 'paused', {}, null, t);
          return;
        }
        const verdict = handler.check?.(view(s));
        if (verdict?.cancel) {
          db.prepare(
            "UPDATE automation_steps SET state='cancelled',cancel_reason=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          ).run(verdict.cancel, t, s.id);
          event(db, s, 'cancelled', { reason: verdict.cancel, phase: 'before_effect' }, null, t);
          return;
        }
        const result = handler.commit(view(s), out) ?? {};
        db.prepare(
          "UPDATE automation_steps SET state='completed',result=?,error=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
        ).run(JSON.stringify(result), t, s.id);
        event(db, s, 'completed', { attempt: s.attempts }, null, t);
        done = { step: view(s), result };
      });
      if (done)
        try {
          onChange(done.step, done.result);
        } catch (e) {
          log.error('Automation onChange failed:', safeError(e));
        }
    } catch (error) {
      if (error === STALE) return;
      try {
        settle(step, error);
      } catch (e) {
        log.error('Automation settle failed:', safeError(e));
      }
    }
  }

  async function tick() {
    if (running) return 0;
    running = true;
    try {
      const steps = claim();
      await Promise.all(steps.map(execute));
      return steps.length;
    } finally {
      running = false;
    }
  }

  function setBrand(brandId, enabled, expectedRevision, actor) {
    return transaction(db, () => {
      if (!db.prepare('SELECT id FROM brands WHERE id=?').get(brandId)) throw fail(404, 'Marca no encontrada.');
      const current = brandState(brandId),
        t = now();
      if (!current) {
        if (expectedRevision !== 0) throw fail(409, 'La configuración cambió. Recárgala.');
        db.prepare(
          'INSERT INTO automation_settings(brand_id,enabled,revision,updated_by,updated_at) VALUES(?,?,1,?,?)',
        ).run(brandId, enabled ? 1 : 0, actor, t);
      } else {
        if (expectedRevision !== current.revision) throw fail(409, 'La configuración cambió. Recárgala.');
        db.prepare(
          'UPDATE automation_settings SET enabled=?,revision=revision+1,updated_by=?,updated_at=? WHERE brand_id=?',
        ).run(enabled ? 1 : 0, actor, t, brandId);
      }
      return brandState(brandId);
    });
  }
  function setGlobalPause(paused, expectedRevision, actor) {
    return transaction(db, () => {
      const g = globalState();
      if (expectedRevision !== g.revision) throw fail(409, 'La configuración cambió. Recárgala.');
      db.prepare('UPDATE automation_global SET paused=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=1').run(
        paused ? 1 : 0,
        actor,
        now(),
      );
      return globalState();
    });
  }

  function overview() {
    const counts = db.prepare('SELECT brand_id,state,count(*) n FROM automation_steps GROUP BY brand_id,state').all();
    const brands = db
      .prepare(
        'SELECT b.id,b.name,COALESCE(s.enabled,0) enabled,COALESCE(s.revision,0) revision FROM brands b LEFT JOIN automation_settings s ON s.brand_id=b.id ORDER BY b.name',
      )
      .all()
      .map(b => ({
        ...b,
        enabled: Boolean(b.enabled),
        counts: Object.fromEntries(counts.filter(c => c.brand_id === b.id).map(c => [c.state, c.n])),
      }));
    const g = globalState();
    return { global: { paused: Boolean(g.paused), revision: g.revision }, brands };
  }
  function list({ state, brandId, limit = 50 } = {}) {
    const where = [],
      args = [];
    if (state) {
      where.push('state=?');
      args.push(state);
    }
    if (brandId) {
      where.push('brand_id=?');
      args.push(brandId);
    }
    return db
      .prepare(
        'SELECT * FROM automation_steps' +
          (where.length ? ' WHERE ' + where.join(' AND ') : '') +
          ' ORDER BY updated_at DESC,id LIMIT ?',
      )
      .all(...args, Math.min(100, Math.max(1, limit)))
      .map(view);
  }
  const history = id =>
    db
      .prepare('SELECT seq,kind,actor_id,details,created_at FROM automation_events WHERE step_id=? ORDER BY seq')
      .all(id)
      .map(e => ({ ...e, details: JSON.parse(e.details) }));

  async function handle(req, res, path, user, { body, json, audit }) {
    if (!path.startsWith('/api/automation')) return false;
    if (user.role !== 'admin') throw fail(403, 'La automatización la administra un administrador.');
    const m = re => path.match(re);
    if (req.method === 'GET' && path === '/api/automation') {
      json(res, 200, overview());
      return true;
    }
    if (req.method === 'GET' && path === '/api/automation/steps') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      json(res, 200, {
        steps: list({
          state: q.get('state') || undefined,
          brandId: q.get('brand') || undefined,
          limit: Number(q.get('limit')) || 50,
        }),
      });
      return true;
    }
    let x;
    if (req.method === 'GET' && (x = m(/^\/api\/automation\/steps\/([a-f0-9-]{36})\/events$/))) {
      if (!get(x[1])) throw fail(404, 'Paso no encontrado.');
      json(res, 200, { events: history(x[1]) });
      return true;
    }
    if (req.method === 'POST' && (x = m(/^\/api\/automation\/steps\/([a-f0-9-]{36})\/(retry|cancel)$/))) {
      await body(req);
      const step = x[2] === 'retry' ? retry(x[1], user.id) : cancel(x[1], 'manual', user.id);
      audit(user, 'automation.' + x[2], x[1]);
      json(res, 200, { step });
      return true;
    }
    if (req.method === 'PATCH' && (x = m(/^\/api\/automation\/brands\/([\w-]{1,64})$/))) {
      const input = await body(req);
      if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.expectedRevision))
        throw fail(400, 'Indica enabled y expectedRevision.');
      const settings = setBrand(x[1], input.enabled, input.expectedRevision, user.id);
      audit(user, 'automation.brand', x[1]);
      json(res, 200, { settings });
      return true;
    }
    if (req.method === 'PATCH' && path === '/api/automation/global') {
      const input = await body(req);
      if (typeof input.paused !== 'boolean' || !Number.isInteger(input.expectedRevision))
        throw fail(400, 'Indica paused y expectedRevision.');
      const state = setGlobalPause(input.paused, input.expectedRevision, user.id);
      audit(user, 'automation.global', 'global');
      json(res, 200, { global: { paused: Boolean(state.paused), revision: state.revision } });
      return true;
    }
    throw fail(404, 'Ruta de automatización no encontrada.');
  }

  return {
    register,
    enqueue,
    claim,
    tick,
    cancel,
    retry,
    setBrand,
    setGlobalPause,
    overview,
    list,
    history,
    handle,
    get: id => view(get(id)),
    enabledFor,
  };
}
