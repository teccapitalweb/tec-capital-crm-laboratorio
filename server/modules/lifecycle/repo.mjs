// SQL del ciclo de vida (docs/PLAN_CICLO_DE_VIDA.md). Todo con parámetros y, donde hay marca, la marca primero.
// Ninguna función abre transacción: se llaman dentro de la de quien escribe.
import { withStatementCache } from '../../lib/statement-cache.mjs';

export function createRepo(rawDb) {
  const db = withStatementCache(rawDb);
  const q = sql => db.prepare(sql);
  return {
    conversation: (brandId, id) => q('SELECT * FROM conversations WHERE brand_id=? AND id=?').get(brandId, id),
    conversationById: id => q('SELECT * FROM conversations WHERE id=?').get(id),
    openCycle: (brandId, conversationId) =>
      q('SELECT * FROM conversation_cycles WHERE brand_id=? AND conversation_id=? AND closed_at IS NULL').get(
        brandId,
        conversationId,
      ),
    cycle: (brandId, id) => q('SELECT * FROM conversation_cycles WHERE brand_id=? AND id=?').get(brandId, id),
    cycles: (brandId, conversationId, limit = 50) =>
      q('SELECT * FROM conversation_cycles WHERE brand_id=? AND conversation_id=? ORDER BY number DESC LIMIT ?').all(
        brandId,
        conversationId,
        limit,
      ),
    maxCycleNumber: (brandId, conversationId) =>
      q('SELECT COALESCE(MAX(number),0) n FROM conversation_cycles WHERE brand_id=? AND conversation_id=?').get(
        brandId,
        conversationId,
      ).n,
    insertCycle: (brandId, row) =>
      q(
        `INSERT INTO conversation_cycles(id,conversation_id,brand_id,number,opened_at,opened_by,origin,origin_ref,opportunity_id,
          customer_messages,first_response_at,first_response_by,first_human_at,human_messages,automation_messages,closed_at,close_kind,closed_by,backfilled)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.id,
        row.conversationId,
        brandId,
        row.number,
        row.openedAt,
        row.openedBy,
        row.origin,
        row.originRef ?? null,
        row.opportunityId ?? null,
        row.customerMessages ?? 0,
        row.firstResponseAt ?? null,
        row.firstResponseBy ?? null,
        row.firstHumanAt ?? null,
        row.humanMessages ?? 0,
        row.automationMessages ?? 0,
        row.closedAt ?? null,
        row.closeKind ?? null,
        row.closedBy ?? null,
        row.backfilled ? 1 : 0,
      ),
    countCustomer: (brandId, cycleId) =>
      q('UPDATE conversation_cycles SET customer_messages=customer_messages+1 WHERE brand_id=? AND id=?').run(
        brandId,
        cycleId,
      ),
    countOutbound: (brandId, cycleId, kind, at, isResponse) =>
      q(
        `UPDATE conversation_cycles SET
          human_messages=human_messages+(CASE WHEN ?='agent' THEN 1 ELSE 0 END),
          automation_messages=automation_messages+(CASE WHEN ?='automation' THEN 1 ELSE 0 END),
          first_response_at=CASE WHEN ?=1 AND first_response_at IS NULL THEN ? ELSE first_response_at END,
          first_response_by=CASE WHEN ?=1 AND first_response_by IS NULL THEN ? ELSE first_response_by END,
          first_human_at=CASE WHEN ?='agent' AND first_human_at IS NULL THEN ? ELSE first_human_at END
         WHERE brand_id=? AND id=?`,
      ).run(kind, kind, isResponse ? 1 : 0, at, isResponse ? 1 : 0, kind, kind, at, brandId, cycleId),
    setPending: (brandId, cycleId, at) =>
      q('UPDATE conversation_cycles SET pending_since=? WHERE brand_id=? AND id=? AND pending_since IS NULL').run(
        at,
        brandId,
        cycleId,
      ),
    clearPending: (brandId, cycleId, at) =>
      q(
        'UPDATE conversation_cycles SET pending_ms=pending_ms+MAX(0,?-pending_since),pending_since=NULL WHERE brand_id=? AND id=? AND pending_since IS NOT NULL',
      ).run(at, brandId, cycleId),
    closeCycle: (brandId, cycleId, f) =>
      q(
        `UPDATE conversation_cycles SET closed_at=?,close_kind=?,closed_by=?,handler_at_close=?,assignee_at_close=?,
          missed=?,missed_strict=?,expired_while_pending=?,backfilled=MAX(backfilled,?),
          pending_ms=pending_ms+CASE WHEN pending_since IS NULL THEN 0 ELSE MAX(0,?-pending_since) END,pending_since=NULL
         WHERE brand_id=? AND id=? AND closed_at IS NULL`,
      ).run(
        f.at,
        f.kind,
        f.closedBy ?? null,
        f.handler ?? null,
        f.assignee ?? null,
        f.missed ? 1 : 0,
        f.missedStrict ? 1 : 0,
        f.whilePending ? 1 : 0,
        f.backfilled ? 1 : 0,
        f.at,
        brandId,
        cycleId,
      ),
    // Estado y ciclo de la conversación. `cycleId` undefined = no tocar el ciclo apuntado.
    setState: (brandId, id, { state, at, resolvedBy, cycleId, cycleCount }) =>
      q(
        `UPDATE conversations SET state=?,state_since=?,
          resolved_by=CASE WHEN ?='solved' THEN ? ELSE NULL END,
          cycle_id=CASE WHEN ?=1 THEN ? ELSE cycle_id END,
          cycle_count=COALESCE(?,cycle_count)
         WHERE brand_id=? AND id=?`,
      ).run(
        state,
        at,
        state,
        resolvedBy ?? null,
        cycleId === undefined ? 0 : 1,
        cycleId ?? null,
        cycleCount ?? null,
        brandId,
        id,
      ),
    setOrigin: (brandId, id, origin, originRef) =>
      q('UPDATE conversations SET origin=?,origin_ref=? WHERE brand_id=? AND id=?').run(
        origin,
        originRef ?? null,
        brandId,
        id,
      ),
    setPrevious: (brandId, id, previousId) =>
      q('UPDATE conversations SET previous_id=? WHERE brand_id=? AND id=? AND previous_id IS NULL').run(
        previousId,
        brandId,
        id,
      ),
    touchCustomer: (brandId, id, at, windowUntil) =>
      q('UPDATE conversations SET last_customer_at=?,window_until=? WHERE brand_id=? AND id=?').run(
        at,
        windowUntil,
        brandId,
        id,
      ),
    touchOutbound: (brandId, id, at) =>
      q('UPDATE conversations SET last_outbound_at=? WHERE brand_id=? AND id=?').run(at, brandId, id),
    touchCampaign: (brandId, id, campaignId, at) =>
      q('UPDATE conversations SET last_campaign_id=?,last_campaign_at=? WHERE brand_id=? AND id=?').run(
        campaignId,
        at,
        brandId,
        id,
      ),
    setWindow: (brandId, id, until) =>
      q('UPDATE conversations SET window_until=? WHERE brand_id=? AND id=?').run(until, brandId, id),
    humanAfter: (brandId, id, at) =>
      Boolean(
        q(
          "SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.brand_id=? AND m.conversation_id=? AND m.sender_kind='agent' AND m.created_at>=? LIMIT 1",
        ).get(brandId, id, at),
      ),
    opportunityOf: (brandId, id) =>
      q(
        'SELECT co.opportunity_id id FROM conversation_opportunities co JOIN conversations c ON c.id=co.conversation_id WHERE c.brand_id=? AND co.conversation_id=?',
      ).get(brandId, id)?.id ?? null,
    serviceState: (brandId, id) =>
      q(
        'SELECT s.* FROM service_state s JOIN conversations c ON c.id=s.conversation_id WHERE c.brand_id=? AND s.conversation_id=?',
      ).get(brandId, id),
    bumpRevision: (brandId, id) =>
      q(
        'UPDATE service_state SET revision=revision+1 WHERE conversation_id=(SELECT id FROM conversations WHERE brand_id=? AND id=?)',
      ).run(brandId, id),
    stateEvent: (brandId, id, actorId, details, at) =>
      q(
        "INSERT INTO operation_events(brand_id,conversation_id,actor_id,kind,details,created_at) VALUES(?,?,?,'state',?,?)",
      ).run(brandId, id, actorId ?? null, JSON.stringify(details), at),
    notify: (brandId, userId, conversationId, kind, title, key, id, at) =>
      q(
        'INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(id, userId, brandId, conversationId, kind, title, key, at),
    admins: () => q("SELECT * FROM users WHERE role='admin' AND disabled=0").all(),
    // Idempotencia de las acciones manuales (la misma tabla que tomar y liberar: operation_requests).
    request: (actorId, ref) =>
      q('SELECT * FROM operation_requests WHERE actor_id=? AND client_ref=?').get(actorId, ref),
    saveRequest: (actorId, ref, kind, target, result, at) =>
      q('INSERT INTO operation_requests VALUES(?,?,?,?,?,?)').run(actorId, ref, kind, target, result, at),

    // ---- ajustes por marca
    settings: brandId => q('SELECT * FROM inbox_settings WHERE brand_id=?').get(brandId),
    insertSettings: (brandId, s, userId, at) =>
      q(
        'INSERT INTO inbox_settings(brand_id,auto_expire,auto_expire_at,attribution_days,missed_notify,revision,updated_by,updated_at) VALUES(?,?,?,?,?,1,?,?)',
      ).run(brandId, s.autoExpire, s.autoExpireAt, s.attributionDays, s.missedNotify, userId, at),
    updateSettings: (brandId, s, userId, at, revision) =>
      q(
        'UPDATE inbox_settings SET auto_expire=?,auto_expire_at=?,attribution_days=?,missed_notify=?,revision=revision+1,updated_by=?,updated_at=? WHERE brand_id=? AND revision=?',
      ).run(s.autoExpire, s.autoExpireAt, s.attributionDays, s.missedNotify, userId, at, brandId, revision),
    expiringBrands: () => q('SELECT brand_id,auto_expire_at FROM inbox_settings WHERE auto_expire=1').all(),

    // ---- reloj
    dueForExpiry: (brandId, at, limit) =>
      q(
        "SELECT id FROM conversations INDEXED BY conversations_window WHERE state IN ('open','pending') AND window_until<=? AND brand_id=? ORDER BY window_until LIMIT ?",
      ).all(at, brandId, limit),
    resolvedOutOfSync: limit =>
      q("SELECT * FROM conversations WHERE status='resolved' AND state NOT IN ('solved','blocked') LIMIT ?").all(limit),
    solvedButLive: limit =>
      q("SELECT * FROM conversations WHERE status!='resolved' AND state='solved' LIMIT ?").all(limit),

    // ---- relleno de lo que ya existía (trabajo por trozos): conversaciones sin ciclo, hasta el rowid del encargo
    maxRowid: () => q('SELECT COALESCE(MAX(rowid),0) n FROM conversations').get().n,
    backfillBatch: (after, upTo, limit) =>
      q(
        'SELECT rowid AS rid,* FROM conversations WHERE rowid>? AND rowid<=? AND cycle_count=0 ORDER BY rowid LIMIT ?',
      ).all(after, upTo, limit),
    messageFacts: (brandId, id) =>
      q(
        `SELECT
          MAX(CASE WHEN m.sender_kind='customer' THEN m.created_at END) last_customer_at,
          MAX(CASE WHEN m.sender_kind IN ('agent','automation') THEN m.created_at END) last_outbound_at,
          MIN(CASE WHEN m.sender_kind IN ('agent','automation') THEN m.created_at END) first_response_at,
          MIN(CASE WHEN m.sender_kind='agent' THEN m.created_at END) first_human_at,
          SUM(m.sender_kind='customer') customer_messages,
          SUM(m.sender_kind='agent') human_messages,
          SUM(m.sender_kind='automation') automation_messages
         FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.brand_id=? AND m.conversation_id=?`,
      ).get(brandId, id),
    firstResponseKind: (brandId, id) =>
      q(
        "SELECT m.sender_kind k FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.brand_id=? AND m.conversation_id=? AND m.sender_kind IN ('agent','automation') ORDER BY m.seq LIMIT 1",
      ).get(brandId, id)?.k ?? null,
    resolvedEvent: (brandId, id) =>
      q(
        "SELECT actor_id,created_at FROM operation_events WHERE brand_id=? AND conversation_id=? AND kind='resolved' ORDER BY seq DESC LIMIT 1",
      ).get(brandId, id),
    backfillColumns: (brandId, id, lastCustomerAt, lastOutboundAt, windowUntil) =>
      q(
        'UPDATE conversations SET last_customer_at=COALESCE(last_customer_at,?),last_outbound_at=COALESCE(last_outbound_at,?),window_until=COALESCE(window_until,?) WHERE brand_id=? AND id=?',
      ).run(lastCustomerAt, lastOutboundAt, windowUntil, brandId, id),
  };
}
