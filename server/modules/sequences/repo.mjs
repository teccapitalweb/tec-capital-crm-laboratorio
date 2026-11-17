// Todo el SQL de las secuencias de seguimiento (docs/PLAN_SECUENCIAS.md). Cada consulta de datos de la marca lleva
// `brand_id`; las pocas que no (por id de una fila propia) devuelven la marca para que quien llama la compruebe.
//
// Lecturas de tablas de otras áreas, sólo lectura: conversaciones, mensajes, contactos y consentimiento, pedidos,
// inscripciones académicas y oportunidades (la fuente de «ya se inscribió»), ediciones del catálogo, envíos de
// difusiones (tope por persona) y el horario de silencio de las difusiones (`campaign_settings`).
import { withStatementCache } from '../../lib/statement-cache.mjs';

const json = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const LIVE_CAMPAIGN = "COALESCE(json_extract(k.options,'$.mode'),'live')='live'";
// Conversaciones de la misma persona en la marca (o sólo ésta, si no tiene contacto).
const PERSON_CONVERSATIONS = `SELECT co.conversation_id FROM conversation_opportunities co
  JOIN opportunities o ON o.id=co.opportunity_id WHERE o.contact_id=?`;
// ¿Se inscribió o pagó el curso? Una sola definición para el alto y para los resultados: pedido pagado (de esta
// conversación o de la misma persona), inscripción académica vigente u oportunidad ganada del curso.
const PAID_SQL = `
  SELECT at FROM (
    SELECT paid_at at FROM orders WHERE status='paid' AND course_id=:course AND (conversation_id=:conv OR contact_id=:contact)
    UNION ALL SELECT created_at FROM enrollments WHERE status='enrolled' AND course_id=:course AND contact_id=:contact
    UNION ALL SELECT updated_at FROM opportunities WHERE stage='ganada' AND course_id=:course AND contact_id=:contact)
  WHERE at IS NOT NULL AND at>=:from AND at<=:to LIMIT 1`;

export function createRepo(db) {
  const cached = withStatementCache(db);
  const cache = sql => cached.prepare(sql);
  const one = (sql, ...args) => cache(sql).get(...args) ?? null;
  const all = (sql, ...args) => cache(sql).all(...args);
  const run = (sql, ...args) => cache(sql).run(...args);
  const seqRow = row =>
    row && { ...row, steps: json(row.steps, []), settings: json(row.settings, {}), enabled: Boolean(row.enabled) };
  const enrRow = row => row && { ...row, definition: json(row.definition, { steps: [] }) };

  return {
    // ---- secuencias
    brandOf: id => one('SELECT brand_id FROM sequences WHERE id=?', id)?.brand_id ?? null,
    sequence: (brandId, id) => seqRow(one('SELECT * FROM sequences WHERE brand_id=? AND id=?', brandId, id)),
    sequenceByRef: (brandId, ref) =>
      seqRow(one('SELECT * FROM sequences WHERE brand_id=? AND client_ref=?', brandId, ref)),
    sequences(brandIds, { archived = false } = {}) {
      if (!brandIds.length) return [];
      const marks = brandIds.map(() => '?').join(',');
      return all(
        `SELECT * FROM sequences WHERE brand_id IN (${marks}) ${archived ? '' : 'AND archived_at IS NULL'} ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT 200`,
        ...brandIds,
      ).map(seqRow);
    },
    count: brandId => one('SELECT count(*) n FROM sequences WHERE brand_id=? AND archived_at IS NULL', brandId).n,
    insertSequence(s) {
      run(
        'INSERT INTO sequences(id,brand_id,title,description,course_id,steps,settings,enabled,revision,client_ref,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,1,?,?,?,?,?)',
        s.id,
        s.brandId,
        s.title,
        s.description,
        s.courseId,
        JSON.stringify(s.steps),
        JSON.stringify(s.settings),
        s.clientRef,
        s.userId,
        s.userId,
        s.at,
        s.at,
      );
    },
    updateSequence(brandId, id, revision, s) {
      return run(
        'UPDATE sequences SET title=?,description=?,course_id=?,steps=?,settings=?,revision=revision+1,updated_by=?,updated_at=? WHERE brand_id=? AND id=? AND revision=?',
        s.title,
        s.description,
        s.courseId,
        JSON.stringify(s.steps),
        JSON.stringify(s.settings),
        s.userId,
        s.at,
        brandId,
        id,
        revision,
      ).changes;
    },
    setEnabled(brandId, id, revision, { enabled, enabledAt, cursor }, userId, at) {
      return run(
        'UPDATE sequences SET enabled=?,enabled_at=?,trigger_cursor=?,revision=revision+1,updated_by=?,updated_at=? WHERE brand_id=? AND id=? AND revision=? AND archived_at IS NULL',
        enabled ? 1 : 0,
        enabledAt,
        cursor,
        userId,
        at,
        brandId,
        id,
        revision,
      ).changes;
    },
    archive(brandId, id, revision, userId, at) {
      return run(
        'UPDATE sequences SET enabled=0,archived_at=?,revision=revision+1,updated_by=?,updated_at=? WHERE brand_id=? AND id=? AND revision=? AND archived_at IS NULL',
        at,
        userId,
        at,
        brandId,
        id,
        revision,
      ).changes;
    },
    setCursor: (id, cursor) =>
      run('UPDATE sequences SET trigger_cursor=? WHERE id=? AND trigger_cursor<?', cursor, id, cursor),
    triggered: () =>
      all(
        "SELECT * FROM sequences WHERE enabled=1 AND archived_at IS NULL AND json_extract(settings,'$.trigger') IN ('course_card','enroll_interest') ORDER BY updated_at LIMIT 100",
      ).map(seqRow),

    // ---- inscripciones
    enrollment: (brandId, id) =>
      enrRow(one('SELECT * FROM sequence_enrollments WHERE brand_id=? AND id=?', brandId, id)),
    enrollmentBrand: id => one('SELECT brand_id FROM sequence_enrollments WHERE id=?', id)?.brand_id ?? null,
    enrollmentByRef: (brandId, ref) =>
      enrRow(one('SELECT * FROM sequence_enrollments WHERE brand_id=? AND client_ref=?', brandId, ref)),
    live: (brandId, sequenceId, conversationId) =>
      enrRow(
        one(
          "SELECT * FROM sequence_enrollments WHERE brand_id=? AND sequence_id=? AND conversation_id=? AND state IN ('active','paused')",
          brandId,
          sequenceId,
          conversationId,
        ),
      ),
    everEnrolled: (brandId, sequenceId, conversationId) =>
      Boolean(
        one(
          'SELECT 1 FROM sequence_enrollments WHERE brand_id=? AND sequence_id=? AND conversation_id=? LIMIT 1',
          brandId,
          sequenceId,
          conversationId,
        ),
      ),
    liveOfConversation: conversationId =>
      all(
        "SELECT * FROM sequence_enrollments WHERE conversation_id=? AND state IN ('active','paused')",
        conversationId,
      ).map(enrRow),
    ofConversation: (brandId, conversationId) =>
      all(
        `SELECT e.*, s.title FROM sequence_enrollments e JOIN sequences s ON s.id=e.sequence_id
         WHERE e.brand_id=? AND e.conversation_id=? ORDER BY e.state IN ('active','paused') DESC, e.started_at DESC LIMIT 50`,
        brandId,
        conversationId,
      ).map(enrRow),
    ofSequence: (brandId, sequenceId, { state = null, before = null, limit = 50 } = {}) =>
      all(
        `SELECT e.*, u.name customer_name FROM sequence_enrollments e
           JOIN conversations c ON c.id=e.conversation_id JOIN users u ON u.id=c.customer_id
         WHERE e.brand_id=? AND e.sequence_id=? AND (? IS NULL OR e.state=?) AND (? IS NULL OR e.started_at<?)
         ORDER BY e.started_at DESC LIMIT ?`,
        brandId,
        sequenceId,
        state,
        state,
        before,
        before,
        Math.min(100, Math.max(1, limit)),
      ).map(enrRow),
    liveOfSequence: (brandId, sequenceId) =>
      all(
        "SELECT * FROM sequence_enrollments WHERE brand_id=? AND sequence_id=? AND state IN ('active','paused') LIMIT 5000",
        brandId,
        sequenceId,
      ).map(enrRow),
    dueOfSequence: (brandId, sequenceId, until, limit = 50) =>
      all(
        "SELECT * FROM sequence_enrollments WHERE brand_id=? AND sequence_id=? AND state='active' AND next_due_at<=? ORDER BY next_due_at LIMIT ?",
        brandId,
        sequenceId,
        until,
        limit,
      ).map(enrRow),
    insertEnrollment(e) {
      run(
        `INSERT INTO sequence_enrollments(id,sequence_id,brand_id,conversation_id,sequence_revision,definition,course_id,
           edition_id,state,next_index,schedule_seq,reply_seen_seq,source,started_by,client_ref,revision,started_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,'active',0,0,?,?,?,?,1,?,?)`,
        e.id,
        e.sequenceId,
        e.brandId,
        e.conversationId,
        e.sequenceRevision,
        JSON.stringify(e.definition),
        e.courseId,
        e.editionId,
        e.replySeenSeq,
        e.source,
        e.userId,
        e.clientRef,
        e.at,
        e.at,
      );
    },
    saveEnrollment(e, at) {
      run(
        `UPDATE sequence_enrollments SET state=?,reason=?,next_index=?,schedule_seq=?,next_due_at=?,last_sent_at=?,
           last_step_index=?,reply_seen_seq=?,paused_at=?,ended_at=?,revision=revision+1,updated_at=? WHERE id=?`,
        e.state,
        e.reason ?? null,
        e.next_index,
        e.schedule_seq,
        e.next_due_at ?? null,
        e.last_sent_at ?? null,
        e.last_step_index ?? null,
        e.reply_seen_seq,
        e.paused_at ?? null,
        e.ended_at ?? null,
        at,
        e.id,
      );
      e.revision += 1;
    },
    // Barridos del reloj (con tope de filas por pasada).
    liveBrands: () =>
      all("SELECT DISTINCT brand_id FROM sequence_enrollments WHERE state IN ('active','paused')").map(r => r.brand_id),
    liveOfBrand: (brandId, limit) =>
      all(
        "SELECT * FROM sequence_enrollments WHERE brand_id=? AND state IN ('active','paused') LIMIT ?",
        brandId,
        limit,
      ).map(enrRow),
    withReplies: limit =>
      all(
        `SELECT e.* FROM sequence_enrollments e WHERE e.state='active' AND e.last_sent_at IS NOT NULL AND EXISTS(
           SELECT 1 FROM messages m WHERE m.conversation_id=e.conversation_id AND m.sender_kind='customer' AND m.seq>e.reply_seen_seq)
         LIMIT ?`,
        limit,
      ).map(enrRow),
    resumable: limit =>
      all(
        "SELECT * FROM sequence_enrollments WHERE state='paused' AND reason IN ('replied','human_takeover') ORDER BY paused_at LIMIT ?",
        limit,
      ).map(enrRow),
    // Inscripciones en curso sin un paso durable vivo (se canceló al tomar o cerrar la conversación, o se perdió).
    orphans: limit =>
      all(
        `SELECT e.* FROM sequence_enrollments e WHERE e.state='active' AND NOT EXISTS(
           SELECT 1 FROM automation_steps a WHERE a.dedupe_key='seq:'||e.id||':'||e.next_index||':'||e.schedule_seq
             AND a.state IN ('pending','reserved'))
         LIMIT ?`,
        limit,
      ).map(enrRow),
    pendingStepsOf: enrollmentId =>
      all(
        "SELECT id,brand_id FROM automation_steps WHERE dedupe_key>=? AND dedupe_key<? AND state IN ('pending','reserved')",
        'seq:' + enrollmentId + ':',
        'seq:' + enrollmentId + ':￿',
      ),

    // ---- bitácora
    insertEvent(ev) {
      run(
        'INSERT INTO sequence_events(brand_id,sequence_id,enrollment_id,conversation_id,step_index,event,detail,message_id,at) VALUES(?,?,?,?,?,?,?,?,?)',
        ev.brandId,
        ev.sequenceId,
        ev.enrollmentId,
        ev.conversationId,
        ev.stepIndex ?? null,
        ev.event,
        ev.detail ?? null,
        ev.messageId ?? null,
        ev.at,
      );
    },
    eventsOf: (brandId, enrollmentId) =>
      all(
        'SELECT step_index,event,detail,message_id,at FROM sequence_events WHERE brand_id=? AND enrollment_id=? ORDER BY seq LIMIT 200',
        brandId,
        enrollmentId,
      ),
    lastEvent: enrollmentId =>
      one(
        'SELECT event,detail,step_index FROM sequence_events WHERE enrollment_id=? ORDER BY seq DESC LIMIT 1',
        enrollmentId,
      ),
    monthSends: (sequenceId, since) =>
      one("SELECT count(*) n FROM sequence_events WHERE sequence_id=? AND event='sent' AND at>=?", sequenceId, since).n,
    // Envíos automáticos a la persona en la marca desde `since`: los de todas sus secuencias y los de difusiones.
    recentSends(brandId, conversationId, contactId, since) {
      const own = contactId
        ? all(
            `SELECT at FROM sequence_events WHERE brand_id=? AND event='sent' AND at>=? AND conversation_id IN (${PERSON_CONVERSATIONS})`,
            brandId,
            since,
            contactId,
          )
        : all(
            "SELECT at FROM sequence_events WHERE brand_id=? AND event='sent' AND at>=? AND conversation_id=?",
            brandId,
            since,
            conversationId,
          );
      const broadcasts = contactId
        ? all(
            `SELECT r.sent_at at FROM campaign_recipients r JOIN campaigns k ON k.id=r.campaign_id
             WHERE r.contact_id=? AND k.brand_id=? AND r.sent_at>=? AND ${LIVE_CAMPAIGN}`,
            contactId,
            brandId,
            since,
          )
        : [];
      return [...own, ...broadcasts].map(r => r.at).sort((a, b) => a - b);
    },
    stepCounts: (brandId, sequenceId) =>
      all(
        'SELECT step_index,event,detail,count(*) n FROM sequence_events WHERE brand_id=? AND sequence_id=? GROUP BY step_index,event,detail',
        brandId,
        sequenceId,
      ),
    stateCounts: (brandId, sequenceId) =>
      all(
        'SELECT state,reason,count(*) n FROM sequence_enrollments WHERE brand_id=? AND sequence_id=? GROUP BY state,reason',
        brandId,
        sequenceId,
      ),
    // «Se inscribió en N días después del paso», con la misma fuente que la regla de alto (PAID_SQL).
    convertedByStep: (brandId, sequenceId, windowMs) =>
      all(
        `SELECT ev.step_index, count(*) n FROM sequence_events ev
           JOIN sequence_enrollments e ON e.id=ev.enrollment_id
           LEFT JOIN conversation_opportunities co ON co.conversation_id=ev.conversation_id
           LEFT JOIN opportunities o ON o.id=co.opportunity_id
         WHERE ev.brand_id=? AND ev.sequence_id=? AND ev.event='sent' AND e.course_id IS NOT NULL AND EXISTS(
           SELECT 1 FROM (
             SELECT paid_at at FROM orders WHERE status='paid' AND course_id=e.course_id
               AND (conversation_id=ev.conversation_id OR contact_id=o.contact_id)
             UNION ALL SELECT created_at FROM enrollments WHERE status='enrolled' AND course_id=e.course_id AND contact_id=o.contact_id
             UNION ALL SELECT updated_at FROM opportunities WHERE stage='ganada' AND course_id=e.course_id AND contact_id=o.contact_id)
           WHERE at>=ev.at AND at<=ev.at+?)
         GROUP BY ev.step_index`,
        brandId,
        sequenceId,
        windowMs,
      ),

    // ---- conversación, persona y catálogo (lectura)
    conversation: (brandId, id) => one('SELECT * FROM conversations WHERE brand_id=? AND id=?', brandId, id),
    conversationBrand: id => one('SELECT brand_id FROM conversations WHERE id=?', id)?.brand_id ?? null,
    customerName: conversationId =>
      one('SELECT u.name FROM conversations c JOIN users u ON u.id=c.customer_id WHERE c.id=?', conversationId)?.name ??
      '',
    contactId: conversationId =>
      one(
        'SELECT o.contact_id id FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id=?',
        conversationId,
      )?.id ?? null,
    consent: contactId =>
      contactId
        ? (one('SELECT status FROM contact_consent WHERE contact_id=?', contactId)?.status ?? 'unknown')
        : 'unknown',
    paid: (conversationId, contactId, courseId, from = 0, to = 8.64e15) =>
      courseId
        ? Boolean(
            cache(PAID_SQL).get({
              course: courseId,
              conv: conversationId,
              contact: contactId ?? '',
              from,
              to,
            }),
          )
        : false,
    customerMessagesAfter: (conversationId, seq, limit = 50) =>
      all(
        "SELECT seq,id,text,created_at FROM messages WHERE conversation_id=? AND sender_kind='customer' AND seq>? ORDER BY seq LIMIT ?",
        conversationId,
        seq,
        limit,
      ),
    maxCustomerSeq: conversationId =>
      one("SELECT max(seq) n FROM messages WHERE conversation_id=? AND sender_kind='customer'", conversationId)?.n ?? 0,
    lastCustomerAt: conversationId =>
      one("SELECT max(created_at) t FROM messages WHERE conversation_id=? AND sender_kind='customer'", conversationId)
        ?.t ?? null,
    maxMessageSeq: () => one('SELECT max(seq) n FROM messages')?.n ?? 0,
    messageByRef: ref => one('SELECT id,conversation_id FROM messages WHERE client_ref=?', ref),
    edition: (brandId, id) => one('SELECT * FROM editions WHERE brand_id=? AND id=?', brandId, id),
    // La edición de la conversación o, si no tiene, la próxima publicada del curso con fecha de inicio.
    nextEdition: (brandId, courseId, t) =>
      one(
        "SELECT * FROM editions WHERE brand_id=? AND course_id=? AND status='published' AND starts_at IS NOT NULL AND starts_at>? ORDER BY starts_at LIMIT 1",
        brandId,
        courseId,
        t,
      ),
    quietHours: brandId =>
      one('SELECT quiet_start start,quiet_end end FROM campaign_settings WHERE brand_id=?', brandId),
    course: (brandId, id) => one('SELECT id,title FROM courses WHERE brand_id=? AND id=?', brandId, id),
    courses: brandId => all('SELECT id,title FROM courses WHERE brand_id=? AND active=1 ORDER BY title', brandId),
    materials: brandId =>
      all(
        "SELECT id,title,course_id FROM content_templates WHERE brand_id=? AND status='approved' ORDER BY title LIMIT 200",
        brandId,
      ),
    material: (brandId, id) => one('SELECT id FROM content_templates WHERE brand_id=? AND id=?', brandId, id),
    tags: brandId => all('SELECT id,name FROM contact_tags WHERE brand_id=? ORDER BY name LIMIT 500', brandId),
    brandName: brandId => one('SELECT name FROM brands WHERE id=?', brandId)?.name ?? brandId,

    // ---- entrada automática: mensajes nuevos que cumplen el disparador (de la marca y, si aplica, del curso)
    courseCards: (brandId, courseId, after, limit) =>
      all(
        `SELECT m.seq, m.conversation_id FROM messages m JOIN conversations c ON c.id=m.conversation_id
         WHERE m.seq>? AND c.brand_id=? AND (? IS NULL OR c.course_id=?) AND m.sender_kind IN ('automation','agent')
           AND m.flyer_course_id IS NOT NULL ORDER BY m.seq LIMIT ?`,
        after,
        brandId,
        courseId,
        courseId,
        limit,
      ),
    enrollAsks: (brandId, courseId, after, limit) =>
      all(
        `SELECT m.seq, m.conversation_id FROM reply_log r JOIN messages m ON m.id=r.trigger_message_id
           JOIN conversations c ON c.id=r.conversation_id
         WHERE m.seq>? AND r.brand_id=? AND r.intent='enroll' AND (? IS NULL OR c.course_id=?) ORDER BY m.seq LIMIT ?`,
        after,
        brandId,
        courseId,
        courseId,
        limit,
      ),
    // Vista previa de la entrada: conversaciones de la marca con el disparador en los últimos días.
    candidates(brandId, courseId, trigger, since, limit) {
      const byCard = `SELECT DISTINCT m.conversation_id id FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE c.brand_id=:brand AND (:course IS NULL OR c.course_id=:course) AND m.sender_kind IN ('automation','agent')
          AND m.flyer_course_id IS NOT NULL AND m.created_at>=:since`;
      const byAsk = `SELECT DISTINCT r.conversation_id id FROM reply_log r JOIN conversations c ON c.id=r.conversation_id
        WHERE r.brand_id=:brand AND (:course IS NULL OR c.course_id=:course) AND r.intent='enroll' AND r.created_at>=:since`;
      const sql = trigger === 'enroll_interest' ? byAsk : byCard;
      return cache(`SELECT id FROM (${sql}) LIMIT :limit`)
        .all({ brand: brandId, course: courseId, since, limit })
        .map(r => r.id);
    },
  };
}
