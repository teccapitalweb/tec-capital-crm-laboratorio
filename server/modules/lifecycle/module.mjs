// Ciclo de vida de la conversación (docs/PLAN_CICLO_DE_VIDA.md; diseño de bandeja §2, conciliación filas 20 a 25).
//
// Dos ejes que hoy se confundían, ahora separados:
//   - ESTADO (`conversations.state`, de este módulo): open «Abierta», pending «Pendiente» (el equipo espera algo de la
//     persona), solved «Resuelta», expired «Expirada» (se cerró la ventana de 24 h), awaiting y blocked (reservados
//     para «Nuevo chat» y el bloqueo, incrementos posteriores).
//   - QUIÉN ATIENDE (`status` + `bot_enabled` + `assigned_to`): sin cambios. La única liga: status='resolved' ⇔
//     state='solved'. Pasar al asistente, a una persona o a la cola no cambia el estado.
// Cada atención es un CICLO (`conversation_cycles`): lo abre un mensaje de la persona y lo cierra «Resolver» o la
// expiración. Al cerrar por expiración se calcula una sola vez si se PERDIÓ (missed).
//
// Todo lo que escribe corre dentro de la transacción de quien llama (síncrono y sin red). Nada de esto envía mensajes
// a la persona: resolver, expirar o reabrir sólo cambian el estado.
//
// Rutas (con sesión):
//   GET   /api/lifecycle/conversations/:id          {state, revision, cycle, actions}               inbox.view
//   POST  /api/lifecycle/conversations/:id/state    {to:'pending'|'open'|'solved', expectedRevision, clientRef, reason?}
//                                                   inbox.resolve (+ «colisión»: chat de otra persona, sólo inbox.manage_others)
//   GET   /api/lifecycle/conversations/:id/cycles   {cycles}                                         inbox.view
//   GET   /api/lifecycle/settings                   {settings:[…]} de las marcas de la persona       inbox.view
//   GET   /api/lifecycle/settings/:brandId          {settings}                                       inbox.view
//   PATCH /api/lifecycle/settings/:brandId          {expectedRevision, autoExpire?, attributionDays?, missedNotify?}
//                                                   settings.inbox (administración)
// Para el servidor y otros módulos (host.module('lifecycle')): onMessage, resolve, pend, unpend, reopen, threadFor,
// settings, tick. Tiempo real v2: 'inbox.upsert' {conversationId, state, cycleId}.
import { randomUUID } from 'node:crypto';
import { sharedJobRunner } from '../../app/background-jobs.mjs';
import { cancelConversationSteps } from '../../automation.mjs';
import { findThread, previousOf, threadKey } from '../../lib/conversation-thread.mjs';
import { createRepo } from './repo.mjs';

const DAY = 24 * 3600000;
const BATCH = 200;
const REF = /^[a-zA-Z0-9-]{16,100}$/;
const ORIGINS = new Set(['inbound', 'ad', 'broadcast', 'outbound', 'api', 'import', 'lab']);
export const STATE_LABELS = Object.freeze({
  open: 'Abierta',
  pending: 'Pendiente',
  solved: 'Resuelta',
  expired: 'Expirada',
  awaiting: 'Esperando respuesta',
  blocked: 'Bloqueada',
});
const EVENT_TYPES = {
  'conversacion.estado': {
    title: 'Cambio de estado de la conversación',
    entity: 'conversation',
    payload: 'from, to, reason, by, cycleId',
  },
  'conversacion.resuelta': {
    title: 'Conversación resuelta',
    entity: 'conversation',
    payload: 'cycleId, by, assignedTo, resolutionMs, pendingMs',
  },
  'conversacion.expirada': {
    title: 'Conversación expirada',
    entity: 'conversation',
    payload: 'cycleId, missed, missedStrict, handler, assignedTo, whilePending',
  },
  'conversacion.reabierta': {
    title: 'Conversación reabierta',
    entity: 'conversation',
    payload: 'cycleId, number, by, origin, originRef, daysSinceLast, first',
  },
};

export default {
  name: 'lifecycle',
  create(host) {
    const { db, fail, json, body, transaction, access } = host;
    const { events, operations, channel, crm } = host.services;
    const repo = createRepo(db);
    const now = () => Date.now();
    events.registerTypes(EVENT_TYPES);

    // ---- ajustes por marca (sin fila: los valores por omisión, todo como hoy)
    function settings(brandId) {
      const r = repo.settings(brandId);
      return {
        brandId,
        autoExpire: Boolean(r?.auto_expire),
        autoExpireAt: r?.auto_expire_at ?? null,
        attributionDays: r?.attribution_days ?? 7,
        missedNotify: r ? Boolean(r.missed_notify) : true,
        threadMode: r?.thread_mode ?? 'episodes',
        reopenPolicy: r?.reopen_policy ?? 'assistant',
        revision: r?.revision ?? 0,
        updatedAt: r?.updated_at ?? null,
      };
    }

    // ---- avisos en vivo: después de confirmar la transacción, con el estado que haya entonces
    const dirty = new Set();
    let flushing = false;
    function touched(id) {
      dirty.add(id);
      if (flushing) return;
      flushing = true;
      setImmediate(() => {
        flushing = false;
        const ids = [...dirty];
        dirty.clear();
        for (const id of ids) {
          const c = repo.conversationById(id);
          if (!c) continue;
          try {
            host.realtime.emit('inbox.upsert', {
              conversationId: id,
              data: { conversationId: id, state: c.state, stateSince: c.state_since, cycleId: c.cycle_id },
            });
          } catch {
            // un aviso en vivo nunca rompe nada
          }
        }
      });
    }

    // ---- registro de cada transición: bitácora de Operación, revisión (expectedRevision), evento de dominio
    function record(c, from, to, { reason, by, actorId = null, cycleId = null, silent = false, at = now() }) {
      operations.state(c);
      repo.bumpRevision(c.brand_id, c.id);
      touched(c.id);
      if (silent) return;
      repo.stateEvent(c.brand_id, c.id, actorId, { from, to, reason, cycleId, source: by }, at);
      const rev = repo.serviceState(c.brand_id, c.id)?.revision ?? 0;
      events.publish({
        type: 'conversacion.estado',
        brandId: c.brand_id,
        entityKind: 'conversation',
        entityId: c.id,
        payload: { from, to, reason, by, cycleId },
        actorId,
        source: 'lifecycle',
        dedupeKey: `conversacion.estado:${c.id}:${rev}`,
      });
    }
    const publish = (c, type, cycleId, payload, actorId = null) =>
      events.publish({
        type,
        brandId: c.brand_id,
        entityKind: 'conversation',
        entityId: c.id,
        payload: { cycleId, ...payload },
        actorId,
        source: 'lifecycle',
        dedupeKey: `${type}:${cycleId}`,
      });

    // ---- ciclos: única escritura de conversation_cycles
    function openCycle(c, { by, origin, originRef = null, at, customerMessages = 0, backfilled = false }) {
      const number = repo.maxCycleNumber(c.brand_id, c.id) + 1,
        id = randomUUID();
      repo.insertCycle(c.brand_id, {
        id,
        conversationId: c.id,
        number,
        openedAt: at,
        openedBy: by,
        origin,
        originRef,
        opportunityId: repo.opportunityOf(c.brand_id, c.id),
        customerMessages,
        backfilled,
      });
      repo.setState(c.brand_id, c.id, { state: 'open', at, cycleId: id, cycleCount: number });
      return { id, number };
    }
    // Quién atendía al cerrar y, si expiró, si se perdió (docs/PLAN_CICLO_DE_VIDA.md, «perdido»).
    function closeCycle(c, cycle, kind, { at, closedBy = null, backfilled = false }) {
      const handler = c.assigned_to ? 'agent' : c.bot_enabled ? 'automation' : 'queue',
        whilePending = cycle.pending_since !== null;
      let missed = false,
        missedStrict = false;
      if (kind === 'expired') {
        const waiting = repo.serviceState(c.brand_id, c.id)?.waiting_since ?? null,
          unanswered =
            c.last_customer_at !== null && (c.last_outbound_at === null || c.last_outbound_at < c.last_customer_at);
        missed = !whilePending && (waiting !== null || (handler === 'automation' && unanswered));
        missedStrict = cycle.first_response_at === null;
      }
      repo.closeCycle(c.brand_id, cycle.id, {
        at,
        kind,
        closedBy,
        handler,
        assignee: c.assigned_to,
        missed,
        missedStrict,
        whilePending,
        backfilled,
      });
      return { handler, missed, missedStrict, whilePending, pendingMs: cycle.pending_ms };
    }

    // ¿De dónde viene este ciclo? Manda lo que el entrante ya sabe (anuncio o difusión, fila 25); si no, el anuncio
    // con el que nació la conversación (sólo el primer ciclo), una campaña reciente sin nadie del equipo después,
    // y por último laboratorio o entrante.
    function originFor(c, m, first, at) {
      const given = m.origin;
      if (given && ORIGINS.has(given.kind)) return { origin: given.kind, ref: given.ref ? String(given.ref) : null };
      if (first && c.referral) {
        try {
          const r = JSON.parse(c.referral);
          if (r?.source === 'ad') return { origin: 'ad', ref: r.adId ?? null };
        } catch {
          // referencia antigua sin formato: se ignora
        }
      }
      const days = settings(c.brand_id).attributionDays;
      if (
        c.last_campaign_at !== null &&
        at - c.last_campaign_at <= days * DAY &&
        !repo.humanAfter(c.brand_id, c.id, c.last_campaign_at)
      )
        return { origin: 'broadcast', ref: c.last_campaign_id };
      return { origin: c.wa_number ? 'inbound' : 'lab', ref: null };
    }

    // ---- la llama insertMessage DESPUÉS de guardar el mensaje y ANTES de operations.message (fila 33).
    // m = { id, kind, at, origin?: {kind, ref}, campaignId? }. Devuelve la conversación releída.
    function onMessage(c0, m) {
      const at = m.at ?? now(),
        kind = m.kind;
      let c = repo.conversationById(c0.id);
      if (!c) return null;
      const b = c.brand_id;
      if (kind === 'customer') repo.touchCustomer(b, c.id, at, at + DAY);
      else if (kind === 'agent' || kind === 'automation') {
        repo.touchOutbound(b, c.id, at);
        if (m.campaignId) repo.touchCampaign(b, c.id, String(m.campaignId).slice(0, 100), at);
      } else return c; // sistema: no cuenta
      const cycle = c.cycle_id ? repo.openCycle(b, c.id) : null;
      c = repo.conversationById(c.id);
      if (kind !== 'customer') {
        // un mensaje del equipo o del asistente nunca cambia el estado; sólo cuenta (una campaña no es «respuesta»)
        if (cycle) repo.countOutbound(b, cycle.id, kind, at, !m.campaignId);
        return c;
      }
      if (c.state === 'blocked' || c.status === 'resolved') return c; // hilo por episodios: una resuelta no se reabre
      if ((c.state === 'open' || c.state === 'pending') && cycle) {
        repo.countCustomer(b, cycle.id);
        if (c.state === 'pending') {
          repo.clearPending(b, cycle.id, at);
          repo.setState(b, c.id, { state: 'open', at });
          record(c, 'pending', 'open', { reason: 'customer_message', by: 'customer', cycleId: cycle.id, at });
        }
        return repo.conversationById(c.id);
      }
      // Abre un ciclo: primera vez (T1), respuesta a lo que iniciamos (T3), regreso tras expirar (T8), o una
      // conversación viva marcada como resuelta por fuera del módulo (reparación).
      const first = c.cycle_count === 0,
        from = c.state,
        o = originFor(c, m, first, at);
      if (first) {
        repo.setOrigin(b, c.id, o.origin, o.ref);
        if (!c.previous_id) {
          const prev = previousOf(db, { ...threadKey(c), excludeId: c.id, before: c.created_at });
          if (prev) repo.setPrevious(b, c.id, prev);
        }
      }
      const opened = openCycle(c, { by: 'customer', origin: o.origin, originRef: o.ref, at, customerMessages: 1 });
      if (!first || from !== 'open') {
        record(c, from, 'open', { reason: 'customer_message', by: 'customer', cycleId: opened.id, at });
        const lastClosed = c.state_since ?? at;
        publish(c, 'conversacion.reabierta', opened.id, {
          number: opened.number,
          by: 'customer',
          origin: o.origin,
          originRef: o.ref,
          daysSinceLast: Math.max(0, Math.floor((at - lastClosed) / DAY)),
          first: from === 'awaiting' || first,
        });
      } else touched(c.id);
      return repo.conversationById(c.id);
    }

    // ---- Resolver (T6; sobre una expirada, T11: «archivar» sin tocar su ciclo ya cerrado). Deja status='resolved'
    // y bot_enabled=0 como la acción de siempre; los efectos de la acción (cancelar trabajos y pasos, operations.reset)
    // los hace quien la pide: la ruta de siempre ya los tiene y la de estado los añade.
    function resolve(c0, actor, { by = 'agent', reason = 'manual', closeKind = null, silent = false } = {}) {
      const c = repo.conversationById(c0.id),
        at = now();
      if (!c) return null;
      if (c.state === 'blocked') throw fail(409, 'La conversación está bloqueada.', { code: 'blocked' });
      if (c.status !== 'resolved')
        db.prepare("UPDATE conversations SET bot_enabled=0,status='resolved',updated_at=? WHERE id=?").run(at, c.id);
      if (c.state === 'solved') return { changed: false, cycleId: null };
      const cycle = c.cycle_id ? repo.openCycle(c.brand_id, c.id) : null,
        kind = closeKind ?? (by === 'automation' ? 'solved_automation' : 'solved_agent');
      const info = cycle
        ? closeCycle(c, cycle, kind, { at, closedBy: actor?.id ?? null, backfilled: closeKind === 'repair' })
        : null;
      repo.setState(c.brand_id, c.id, { state: 'solved', at, resolvedBy: by, cycleId: null });
      record(c, c.state, 'solved', { reason, by, actorId: actor?.id ?? null, cycleId: cycle?.id ?? null, silent, at });
      if (cycle && !silent) {
        const closed = repo.cycle(c.brand_id, cycle.id);
        publish(
          c,
          'conversacion.resuelta',
          cycle.id,
          {
            by,
            assignedTo: c.assigned_to,
            resolutionMs: Math.max(0, at - closed.opened_at - closed.pending_ms),
            pendingMs: closed.pending_ms,
            handler: info.handler,
          },
          actor?.id ?? null,
        );
      }
      return { changed: true, cycleId: cycle?.id ?? null };
    }

    // ---- Dejar pendiente (T4) y quitar pendiente (T5, a mano)
    function pend(c0, actor) {
      const c = repo.conversationById(c0.id),
        at = now();
      if (c.state !== 'open') throw transitionError(c.state, 'pending');
      const cycle = c.cycle_id ? repo.openCycle(c.brand_id, c.id) : null;
      if (!cycle)
        throw fail(409, 'Esta conversación todavía no tiene una atención abierta: la persona no ha escrito.', {
          code: 'no_cycle',
        });
      repo.setPending(c.brand_id, cycle.id, at);
      repo.setState(c.brand_id, c.id, { state: 'pending', at });
      record(c, 'open', 'pending', { reason: 'manual', by: 'agent', actorId: actor?.id, cycleId: cycle.id, at });
      return { cycleId: cycle.id };
    }
    function unpend(c0, actor) {
      const c = repo.conversationById(c0.id),
        at = now();
      if (c.state !== 'pending') throw transitionError(c.state, 'open');
      const cycle = c.cycle_id ? repo.openCycle(c.brand_id, c.id) : null;
      if (cycle) repo.clearPending(c.brand_id, cycle.id, at);
      repo.setState(c.brand_id, c.id, { state: 'open', at });
      record(c, 'pending', 'open', { reason: 'manual', by: 'agent', actorId: actor?.id, cycleId: cycle?.id, at });
      return { cycleId: cycle?.id ?? null };
    }

    // ---- Reabrir a mano una resuelta (T9 con la ventana abierta; T10 con la ventana cerrada: queda Expirada).
    // Quien reabre la toma, como «Tomar chat»: queda a su cargo y el asistente se apaga. No se envía nada.
    function reopen(c0, actor) {
      const c = repo.conversationById(c0.id),
        at = now();
      if (c.state !== 'solved' || c.status !== 'resolved') throw transitionError(c.state, 'open');
      const live = findThread(db, threadKey(c)).conversation;
      const clash = db
        .prepare(
          "SELECT id FROM conversations WHERE customer_id=? AND course_id=? AND edition_id IS ? AND channel=? AND status!='resolved' AND id!=? LIMIT 1",
        )
        .get(c.customer_id, c.course_id, c.edition_id, c.channel, c.id);
      const newer = (live && live.id !== c.id ? live.id : null) || clash?.id || null;
      if (newer)
        throw fail(409, 'Esta persona ya tiene una conversación más reciente abierta. Continúa en esa.', {
          code: 'newer_thread',
          details: { conversationId: newer },
        });
      host.takeOver(c, actor.id);
      db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(at, c.id);
      const fresh = repo.conversationById(c.id);
      if (channel.windowOf(fresh).open) {
        const opened = openCycle(fresh, { by: 'agent', origin: fresh.origin, originRef: fresh.origin_ref, at });
        record(fresh, 'solved', 'open', { reason: 'manual', by: 'agent', actorId: actor.id, cycleId: opened.id, at });
        publish(
          fresh,
          'conversacion.reabierta',
          opened.id,
          {
            number: opened.number,
            by: 'agent',
            origin: fresh.origin,
            originRef: fresh.origin_ref,
            daysSinceLast: Math.max(0, Math.floor((at - (c.state_since ?? at)) / DAY)),
            first: false,
          },
          actor.id,
        );
        return { cycleId: opened.id };
      }
      repo.setState(fresh.brand_id, fresh.id, { state: 'expired', at, cycleId: null });
      record(fresh, 'solved', 'expired', { reason: 'window_closed', by: 'agent', actorId: actor.id, at });
      return { cycleId: null };
    }

    // ---- Expirar (T7): cierra el ciclo con «perdido» calculado; no toca status, bot_enabled ni assigned_to.
    function expire(c, { at, silent }) {
      const cycle = c.cycle_id ? repo.openCycle(c.brand_id, c.id) : null;
      const info = cycle ? closeCycle(c, cycle, 'expired', { at, backfilled: silent }) : null;
      repo.setState(c.brand_id, c.id, { state: 'expired', at, cycleId: null });
      record(c, c.state, 'expired', { reason: 'window_closed', by: 'system', cycleId: cycle?.id ?? null, silent, at });
      if (!cycle || silent) return;
      publish(c, 'conversacion.expirada', cycle.id, {
        missed: info.missed,
        missedStrict: info.missedStrict,
        handler: info.handler,
        assignedTo: c.assigned_to,
        whilePending: info.whilePending,
      });
      if (info.missed && settings(c.brand_id).missedNotify) {
        const to = new Set([c.assigned_to, ...repo.admins().map(u => u.id)].filter(Boolean));
        for (const userId of to) {
          const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
          if (!u || u.disabled || !crm.canBrand(u, c.brand_id)) continue;
          repo.notify(
            c.brand_id,
            userId,
            c.id,
            'missed',
            'Se perdió una conversación: expiró sin respuesta',
            'missed:' + cycle.id,
            randomUUID(),
            at,
          );
        }
      }
    }

    // ---- Reloj: expiración por marca (apagada por omisión) y reparación de lo escrito por fuera del módulo.
    // Síncrono: no puede pisarse a sí mismo. Cada conversación en su propia transacción, releída antes de cambiar.
    function tick() {
      const t = now(),
        changed = new Map();
      for (const brand of repo.expiringBrands()) {
        for (const { id } of repo.dueForExpiry(brand.brand_id, t, BATCH)) {
          transaction(db, () => {
            const c = repo.conversation(brand.brand_id, id);
            if (!c || !['open', 'pending'].includes(c.state) || c.window_until === null || c.window_until > t) return;
            const w = channel.windowOf(c); // fuente única de la ventana, con el estado de la persona (fila 22)
            if (w.open) return repo.setWindow(c.brand_id, c.id, w.until);
            const closedAt = w.until ?? c.window_until;
            // al encender la expiración, lo que ya estaba vencido expira en silencio (sin avisos ni eventos)
            expire(c, { at: t, silent: brand.auto_expire_at !== null && closedAt <= brand.auto_expire_at });
            changed.set(c.id, c.brand_id);
          });
        }
      }
      // Reparación: status='resolved' escrito sin pasar por aquí (demostraciones, SQL de pruebas) → Resuelta.
      for (const c of repo.resolvedOutOfSync(BATCH))
        transaction(db, () => {
          if (repo.conversationById(c.id)?.status !== 'resolved') return;
          resolve(c, null, { by: 'agent', reason: 'repair', closeKind: 'repair', silent: true });
          changed.set(c.id, c.brand_id);
        });
      // …y una viva marcada como Resuelta: vuelve a Abierta (con la ventana abierta) o a Expirada.
      for (const c of repo.solvedButLive(BATCH))
        transaction(db, () => {
          const fresh = repo.conversationById(c.id);
          if (fresh?.status === 'resolved' || fresh?.state !== 'solved') return;
          if (channel.windowOf(fresh).open)
            openCycle(fresh, {
              by: 'repair',
              origin: fresh.origin,
              originRef: fresh.origin_ref,
              at: t,
              backfilled: true,
            });
          else repo.setState(fresh.brand_id, fresh.id, { state: 'expired', at: t, cycleId: null });
          record(fresh, 'solved', repo.conversationById(fresh.id).state, {
            reason: 'repair',
            by: 'system',
            silent: true,
          });
          changed.set(c.id, c.brand_id);
        });
      for (const [id, brandId] of changed) {
        host.broadcast('conversation', id);
        host.broadcast('crm', null, { brandId });
      }
      return { changed: changed.size };
    }

    // ---- Relleno de lo que ya existía: un ciclo por conversación (backfilled=1) y las columnas de la ventana.
    const runner = sharedJobRunner(host);
    runner.define('lifecycle.backfill', {
      step(job, { limit }) {
        const upTo = Number(job.params?.upTo) || 0,
          after = Number(job.cursor?.rid) || 0,
          rows = repo.backfillBatch(after, upTo, limit);
        for (const r of rows) {
          const b = r.brand_id,
            f = repo.messageFacts(b, r.id);
          repo.backfillColumns(
            b,
            r.id,
            f.last_customer_at,
            f.last_outbound_at,
            f.last_customer_at === null ? null : f.last_customer_at + DAY,
          );
          const resolved = r.status === 'resolved',
            ev = resolved ? repo.resolvedEvent(b, r.id) : null,
            id = randomUUID();
          repo.insertCycle(b, {
            id,
            conversationId: r.id,
            number: 1,
            openedAt: r.created_at,
            openedBy: 'customer',
            origin: r.origin,
            originRef: r.origin_ref,
            opportunityId: repo.opportunityOf(b, r.id),
            customerMessages: f.customer_messages ?? 0,
            humanMessages: f.human_messages ?? 0,
            automationMessages: f.automation_messages ?? 0,
            firstResponseAt: f.first_response_at,
            firstResponseBy: repo.firstResponseKind(b, r.id),
            firstHumanAt: f.first_human_at,
            closedAt: resolved ? (ev?.created_at ?? r.updated_at) : null,
            closeKind: resolved ? 'solved_agent' : null,
            closedBy: resolved ? (ev?.actor_id ?? null) : null,
            backfilled: true,
          });
          repo.setState(b, r.id, {
            state: r.state,
            at: r.state_since ?? r.created_at,
            resolvedBy: r.resolved_by,
            cycleId: !resolved && (r.state === 'open' || r.state === 'pending') ? id : null,
            cycleCount: 1,
          });
        }
        return {
          processed: rows.length,
          cursor: { rid: rows.at(-1)?.rid ?? after },
          finished: rows.length < limit,
        };
      },
    });
    transaction(db, () =>
      runner.enqueue({ kind: 'lifecycle.backfill', clientRef: 'v1', params: { upTo: repo.maxRowid() } }),
    );

    // ---- rutas
    const transitionError = (from, to) =>
      fail(409, `No se puede pasar de «${STATE_LABELS[from] ?? from}» a «${STATE_LABELS[to] ?? to}».`, {
        code: 'invalid_transition',
        details: { from, to },
      });
    // Lo que puede hacer quien mira, según el estado (el chip de la cabecera del chat).
    const actionsFor = c =>
      c.state === 'open'
        ? ['pending', 'solved']
        : c.state === 'pending'
          ? ['open', 'solved']
          : c.state === 'solved'
            ? ['open']
            : c.state === 'expired' || c.state === 'awaiting'
              ? ['solved']
              : [];
    function view(c) {
      const cycle = c.cycle_id ? repo.openCycle(c.brand_id, c.id) : null;
      return {
        conversationId: c.id,
        brandId: c.brand_id,
        state: c.state,
        label: STATE_LABELS[c.state],
        stateSince: c.state_since,
        revision: operations.state(c).revision,
        origin: c.origin,
        originRef: c.origin_ref,
        windowUntil: c.window_until,
        cycle: cycle ? cycleView(cycle) : null,
        cycleCount: c.cycle_count,
        previousId: c.previous_id,
        actions: actionsFor(c),
      };
    }
    const cycleView = y => ({
      id: y.id,
      number: y.number,
      openedAt: y.opened_at,
      openedBy: y.opened_by,
      origin: y.origin,
      originRef: y.origin_ref,
      firstResponseAt: y.first_response_at,
      firstResponseBy: y.first_response_by,
      firstHumanAt: y.first_human_at,
      customerMessages: y.customer_messages,
      pendingSince: y.pending_since,
      pendingMs: y.pending_ms,
      closedAt: y.closed_at,
      closeKind: y.close_kind,
      handler: y.handler_at_close,
      assignee: y.assignee_at_close,
      missed: Boolean(y.missed),
      missedStrict: Boolean(y.missed_strict),
      expiredWhilePending: Boolean(y.expired_while_pending),
      backfilled: Boolean(y.backfilled),
    });

    function changeState(user, id, input) {
      const to = input.to,
        ref = typeof input.clientRef === 'string' ? input.clientRef : '';
      if (!['pending', 'open', 'solved'].includes(to)) throw fail(400, 'Estado no válido.', { code: 'invalid_state' });
      if (!REF.test(ref)) throw fail(400, 'Referencia de operación no válida.', { code: 'invalid_client_ref' });
      if (!Number.isSafeInteger(input.expectedRevision))
        throw fail(400, 'Falta la revisión de la conversación.', { code: 'invalid_revision' });
      return transaction(db, () => {
        const old = repo.request(user.id, ref);
        if (old) {
          if (old.kind !== 'lifecycle.state' || old.target_id !== id)
            throw fail(409, 'Referencia ya utilizada.', { code: 'client_ref_reused' });
          return { ...JSON.parse(old.result), duplicate: true };
        }
        const c = host.accessConversation(id, user);
        access.require(user, 'inbox.resolve', c.brand_id);
        if (c.assigned_to && c.assigned_to !== user.id && !access.can(user, 'inbox.manage_others', c.brand_id))
          throw fail(409, 'Otro asesor está atendiendo esta conversación.', { code: 'collision' });
        const revision = operations.state(c).revision;
        if (revision !== input.expectedRevision)
          throw fail(409, 'La conversación cambió mientras decidías (por ejemplo, la persona acaba de escribir).', {
            code: 'stale_record',
            details: { current: { state: c.state, revision } },
          });
        let out;
        if (to === 'pending') out = pend(c, user);
        else if (to === 'open') out = c.state === 'pending' ? unpend(c, user) : reopen(c, user);
        else {
          if (c.state === 'solved') throw transitionError('solved', 'solved');
          out = resolve(c, user, { by: 'agent', reason: 'manual' });
          // los mismos efectos que la acción «resolve» de siempre
          operations.reset(c, 'resolved', user);
          db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending'").run(c.id);
          cancelConversationSteps(db, c.id, 'conversation_action');
        }
        host.audit(user, 'conversation.state.' + to, c.id);
        const fresh = repo.conversationById(c.id);
        const result = { conversation: view(fresh), cycleId: out?.cycleId ?? null };
        repo.saveRequest(user.id, ref, 'lifecycle.state', id, JSON.stringify(result), now());
        return result;
      });
    }

    function saveSettings(user, brandId, input) {
      access.require(user, 'settings.inbox', brandId);
      if (!Number.isSafeInteger(input.expectedRevision))
        throw fail(400, 'Falta la revisión de los ajustes.', { code: 'invalid_revision' });
      const flag = (v, current) => {
        if (v === undefined) return current;
        if (typeof v !== 'boolean') throw fail(400, 'Valor no válido.', { code: 'invalid_value' });
        return v;
      };
      return transaction(db, () => {
        const before = settings(brandId);
        if (before.revision !== input.expectedRevision)
          throw fail(409, 'Otra persona cambió estos ajustes. Recarga y vuelve a intentar.', {
            code: 'stale_record',
            details: { current: before },
          });
        const autoExpire = flag(input.autoExpire, before.autoExpire),
          missedNotify = flag(input.missedNotify, before.missedNotify);
        let attributionDays = before.attributionDays;
        if (input.attributionDays !== undefined) {
          attributionDays = Number(input.attributionDays);
          if (!Number.isSafeInteger(attributionDays) || attributionDays < 1 || attributionDays > 30)
            throw fail(400, 'Los días de atribución van de 1 a 30.', {
              code: 'invalid_value',
              field: 'attributionDays',
            });
        }
        const t = now(),
          next = {
            autoExpire: autoExpire ? 1 : 0,
            autoExpireAt: autoExpire ? (before.autoExpire ? before.autoExpireAt : t) : null,
            attributionDays,
            missedNotify: missedNotify ? 1 : 0,
          };
        if (before.revision === 0) repo.insertSettings(brandId, next, user.id, t);
        else repo.updateSettings(brandId, next, user.id, t, before.revision);
        const after = settings(brandId);
        db.prepare(
          "INSERT INTO operation_events(brand_id,conversation_id,actor_id,kind,details,created_at) VALUES(?,NULL,?,'inbox.settings',?,?)",
        ).run(
          brandId,
          user.id,
          JSON.stringify({
            before: {
              autoExpire: before.autoExpire,
              attributionDays: before.attributionDays,
              missedNotify: before.missedNotify,
            },
            after: {
              autoExpire: after.autoExpire,
              attributionDays: after.attributionDays,
              missedNotify: after.missedNotify,
            },
          }),
          t,
        );
        host.audit(user, 'inbox.settings', brandId);
        return after;
      });
    }

    async function handle(req, res, path, user) {
      host.requireStaff(user);
      let m = path.match(/^\/api\/lifecycle\/conversations\/([a-f0-9-]+)(\/state|\/cycles)?$/);
      if (m) {
        const id = m[1],
          sub = m[2] ?? '';
        if (req.method === 'GET' && !sub) {
          const c = host.accessConversation(id, user);
          access.require(user, 'inbox.view', c.brand_id);
          json(
            res,
            200,
            transaction(db, () => view(c)),
          );
          return true;
        }
        if (req.method === 'GET' && sub === '/cycles') {
          const c = host.accessConversation(id, user);
          access.require(user, 'inbox.view', c.brand_id);
          json(res, 200, { cycles: repo.cycles(c.brand_id, c.id).map(cycleView) });
          return true;
        }
        if (req.method === 'POST' && sub === '/state') {
          host.rate('lifecycle:' + user.id, 60);
          const result = changeState(user, id, await body(req));
          host.broadcast('conversation', id);
          host.broadcast('crm', null, { brandId: result.conversation.brandId });
          json(res, 200, result);
          return true;
        }
        return false;
      }
      if (req.method === 'GET' && path === '/api/lifecycle/settings') {
        json(res, 200, {
          settings: access
            .brandIds(user)
            .filter(b => access.can(user, 'inbox.view', b))
            .map(b => ({ ...settings(b), canEdit: access.can(user, 'settings.inbox', b) })),
        });
        return true;
      }
      m = path.match(/^\/api\/lifecycle\/settings\/([a-z0-9-]{1,60})$/);
      if (m) {
        const brandId = m[1];
        if (req.method === 'GET') {
          access.require(user, 'inbox.view', brandId);
          json(res, 200, { settings: { ...settings(brandId), canEdit: access.can(user, 'settings.inbox', brandId) } });
          return true;
        }
        if (req.method === 'PATCH') {
          const after = saveSettings(user, brandId, await body(req));
          try {
            host.realtime.emit('inbox.settings', { brandId, data: { brandId, revision: after.revision } });
          } catch {
            // aviso en vivo opcional
          }
          json(res, 200, { settings: { ...after, canEdit: true } });
          return true;
        }
      }
      return false;
    }

    const api = {
      handle,
      tick,
      onMessage,
      resolve,
      pend,
      unpend,
      reopen,
      settings,
      view,
      threadFor: key => findThread(db, key),
      labels: STATE_LABELS,
    };
    host.useLifecycle?.(api); // insertMessage y la acción «resolve» de siempre llaman aquí
    return api;
  },
  timers: [{ name: 'reloj', everyMs: 60_000, testEveryMs: 1000, run: api => api.tick() }],
};
