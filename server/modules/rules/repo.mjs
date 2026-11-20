// Todo el SQL de las reglas por mensaje (docs/PLAN_REGLAS.md). Cada función recibe la marca primero y filtra por ella:
// una regla, una ejecución o un ajuste de otra marca no existe para quien pregunta.
const json = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
const RETENTION_MS = 90 * 24 * 3600_000; // conciliación, fila 48: ejecuciones de reglas, 90 días
const DEFAULT_CONSECUTIVE = 3;
// La referencia de una creación, por marca (el ref admite sólo letras, números y guiones: no choca con «:»).
const refKey = (brandId, ref) => brandId + ':' + ref;

export function createRepo(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const ruleRow = row => row && { ...row, definition: json(row.definition, null) };

  return {
    // ---- reglas
    brandOf: id => one('SELECT brand_id FROM automation_rules WHERE id=?', id)?.brand_id ?? null,
    rule: (brandId, id) => ruleRow(one('SELECT * FROM automation_rules WHERE brand_id=? AND id=?', brandId, id)),
    // client_ref es único en toda la tabla: se guarda como «marca:ref» para que el mismo ref en otra marca no choque
    // ni revele que existe allí. Los guardados antes, sin marca, se siguen encontrando en su marca.
    ruleByRef: (brandId, ref) =>
      ruleRow(
        one(
          'SELECT * FROM automation_rules WHERE brand_id=? AND client_ref IN (?,?) ORDER BY created_at LIMIT 1',
          brandId,
          refKey(brandId, ref),
          ref,
        ),
      ),
    rules: (brandId, { archived = false } = {}) =>
      all(
        `SELECT * FROM automation_rules WHERE brand_id=?${archived ? '' : " AND status!='archived'"} ORDER BY position,created_at,id`,
        brandId,
      ).map(ruleRow),
    // Las que corren con un mensaje, en el orden de la lista.
    active: brandId =>
      all(
        "SELECT * FROM automation_rules WHERE brand_id=? AND status='active' ORDER BY position,created_at,id",
        brandId,
      ).map(ruleRow),
    hasActive: brandId => Boolean(one("SELECT 1 FROM automation_rules WHERE brand_id=? AND status='active'", brandId)),
    count: brandId => one("SELECT count(*) n FROM automation_rules WHERE brand_id=? AND status!='archived'", brandId).n,
    minPosition: brandId =>
      one("SELECT min(position) p FROM automation_rules WHERE brand_id=? AND status!='archived'", brandId).p,
    insertRule(brandId, r) {
      run(
        'INSERT INTO automation_rules(id,brand_id,title,trigger,definition,status,position,revision,client_ref,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?)',
        r.id,
        brandId,
        r.title,
        r.definition.trigger.type,
        JSON.stringify(r.definition),
        'draft',
        r.position,
        refKey(brandId, r.clientRef),
        r.userId,
        r.userId,
        r.at,
        r.at,
      );
    },
    // Cambia campos con candado de revisión; devuelve false si alguien más guardó antes.
    updateRule(brandId, id, expectedRevision, fields, userId, at) {
      const cols = [];
      const args = [];
      for (const [key, value] of Object.entries(fields)) {
        cols.push(key + '=?');
        args.push(value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
      }
      return (
        run(
          `UPDATE automation_rules SET ${cols.join(',')},revision=revision+1,updated_by=?,updated_at=? WHERE brand_id=? AND id=? AND revision=?`,
          ...args,
          userId,
          at,
          brandId,
          id,
          expectedRevision,
        ).changes === 1
      );
    },
    setPosition: (brandId, id, position) =>
      run('UPDATE automation_rules SET position=? WHERE brand_id=? AND id=?', position, brandId, id),
    // El contador sólo sube si al menos una acción se ejecutó.
    fired: (brandId, id, at) =>
      run(
        'UPDATE automation_rules SET executions=executions+1,last_run_at=?,last_error=NULL WHERE brand_id=? AND id=?',
        at,
        brandId,
        id,
      ),
    failed: (brandId, id, error, at) =>
      run(
        'UPDATE automation_rules SET last_error=?,last_run_at=? WHERE brand_id=? AND id=?',
        String(error).slice(0, 200),
        at,
        brandId,
        id,
      ),

    // ---- ajustes por marca
    settings(brandId) {
      const row = one('SELECT * FROM automation_rule_settings WHERE brand_id=?', brandId);
      return {
        brandId,
        orderRevision: row?.order_revision ?? 0,
        maxConsecutive: row?.max_consecutive ?? DEFAULT_CONSECUTIVE,
        revision: row?.revision ?? 0,
      };
    },
    ensureSettings(brandId, at) {
      run(
        'INSERT INTO automation_rule_settings(brand_id,order_revision,max_consecutive,revision,updated_at) VALUES(?,0,?,1,?) ON CONFLICT(brand_id) DO NOTHING',
        brandId,
        DEFAULT_CONSECUTIVE,
        at,
      );
    },
    // Una regla entró o salió de la lista: quien tenga la lista vieja abierta ya no puede reordenarla.
    touchOrder: (brandId, userId, at) =>
      run(
        'UPDATE automation_rule_settings SET order_revision=order_revision+1,updated_by=?,updated_at=? WHERE brand_id=?',
        userId,
        at,
        brandId,
      ),
    bumpOrder: (brandId, expected, userId, at) =>
      run(
        'UPDATE automation_rule_settings SET order_revision=order_revision+1,updated_by=?,updated_at=? WHERE brand_id=? AND order_revision=?',
        userId,
        at,
        brandId,
        expected,
      ).changes === 1,
    saveSettings: (brandId, expected, maxConsecutive, userId, at) =>
      run(
        'UPDATE automation_rule_settings SET max_consecutive=?,revision=revision+1,updated_by=?,updated_at=? WHERE brand_id=? AND revision=?',
        maxConsecutive,
        userId,
        at,
        brandId,
        expected,
      ).changes === 1,

    // ---- ejecuciones
    runExists: (ruleId, sourceKey) =>
      Boolean(one('SELECT 1 FROM automation_rule_runs WHERE rule_id=? AND source_key=?', ruleId, sourceKey)),
    insertRun(brandId, r) {
      return (
        run(
          'INSERT INTO automation_rule_runs(id,rule_id,rule_revision,brand_id,conversation_id,source_key,outcome,voice,actions,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(rule_id,source_key) DO NOTHING',
          r.id,
          r.ruleId,
          r.revision,
          brandId,
          r.conversationId,
          r.sourceKey,
          r.outcome,
          r.voice ? 1 : 0,
          JSON.stringify(r.actions),
          r.reason ?? null,
          r.at,
        ).changes === 1
      );
    },
    // Última vez que la regla HIZO algo en la conversación (para «una vez» y el descanso).
    lastExecuted: (brandId, ruleId, conversationId) =>
      one(
        "SELECT max(created_at) at FROM automation_rule_runs WHERE brand_id=? AND rule_id=? AND conversation_id=? AND outcome IN ('executed','partial')",
        brandId,
        ruleId,
        conversationId,
      ).at ?? null,
    runs: (brandId, ruleId, { before = null, limit = 50 } = {}) =>
      all(
        `SELECT id,rule_revision,conversation_id,outcome,voice,actions,reason,created_at FROM automation_rule_runs WHERE brand_id=? AND rule_id=?${before ? ' AND created_at<?' : ''} ORDER BY created_at DESC,id LIMIT ?`,
        ...[brandId, ruleId, ...(before ? [before] : []), Math.min(200, Math.max(1, limit))],
      ).map(r => ({ ...r, actions: json(r.actions, []) })),
    purge: (at, limit = 500) =>
      run(
        'DELETE FROM automation_rule_runs WHERE rowid IN (SELECT rowid FROM automation_rule_runs WHERE created_at<? LIMIT ?)',
        at - RETENTION_MS,
        limit,
      ).changes,

    // ---- lo que la regla lee de la conversación (siempre de la marca)
    conversation: (brandId, id) => one('SELECT * FROM conversations WHERE brand_id=? AND id=?', brandId, id),
    customerName: (brandId, conversationId) =>
      one(
        'SELECT u.name FROM conversations c JOIN users u ON u.id=c.customer_id WHERE c.brand_id=? AND c.id=?',
        brandId,
        conversationId,
      )?.name ?? '',
    contactId: (brandId, conversationId) =>
      one(
        'SELECT o.contact_id id FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id JOIN conversations c ON c.id=co.conversation_id WHERE c.brand_id=? AND co.conversation_id=?',
        brandId,
        conversationId,
      )?.id ?? null,
    contactTags: (brandId, contactId) =>
      contactId
        ? all(
            'SELECT l.tag_id id FROM contact_tag_links l JOIN contact_tags t ON t.id=l.tag_id WHERE t.brand_id=? AND l.contact_id=?',
            brandId,
            contactId,
          ).map(r => r.id)
        : [],
    optedOut: (brandId, contactId) =>
      contactId
        ? one('SELECT status FROM contact_consent WHERE brand_id=? AND contact_id=?', brandId, contactId)?.status ===
          'opted_out'
        : false,
    customerMessages: (brandId, conversationId) =>
      one(
        "SELECT count(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.brand_id=? AND m.conversation_id=? AND m.sender_kind='customer'",
        brandId,
        conversationId,
      ).n,
    // Respuestas automáticas seguidas que dieron las reglas en la conversación: las últimas filas de reply_log, de la
    // más nueva a la más vieja, hasta la primera que no es de una regla. Cualquier otra respuesta (asistente, recorrido)
    // corta la racha.
    consecutiveRuleReplies(brandId, conversationId, cap) {
      const rows = all(
        'SELECT intent FROM reply_log WHERE brand_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?',
        brandId,
        conversationId,
        cap + 1,
      );
      let n = 0;
      for (const r of rows) {
        if (r.intent !== 'rule') break;
        n += 1;
      }
      return n;
    },
    messageByRef: ref => one('SELECT id FROM messages WHERE client_ref=?', ref),
    // «Resuelta» sin el módulo del ciclo de vida (instalación parcial): lo mismo que la acción de siempre.
    resolve: (brandId, conversationId, at) =>
      run(
        "UPDATE conversations SET bot_enabled=0,status='resolved',updated_at=? WHERE brand_id=? AND id=?",
        at,
        brandId,
        conversationId,
      ),
    cancelJobs: (brandId, conversationId) =>
      run(
        "UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending' AND conversation_id IN (SELECT id FROM conversations WHERE brand_id=?)",
        conversationId,
        brandId,
      ),
    adminNotice: (brandId, kind, details, at) =>
      run(
        'INSERT INTO automation_events(step_id,brand_id,kind,details,created_at) VALUES(NULL,?,?,?,?)',
        brandId,
        kind,
        JSON.stringify(details),
        at,
      ),
    replyLogged: (brandId, triggerId) =>
      Boolean(one('SELECT 1 FROM reply_log WHERE brand_id=? AND trigger_message_id=?', brandId, triggerId)),
    replyLog(brandId, r) {
      run(
        'INSERT INTO reply_log(id,conversation_id,brand_id,trigger_message_id,reply_message_id,intent,confidence,mode,action,reply_text,sources,reason,created_at) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
        r.id,
        r.conversationId,
        brandId,
        r.triggerId,
        r.replyId,
        'rule',
        r.mode,
        r.action,
        r.text,
        JSON.stringify(r.sources),
        r.reason,
        r.at,
      );
    },

    // ---- listas de la marca para el editor y para revisar referencias
    lists(brandId) {
      return {
        tags: all('SELECT id,name FROM contact_tags WHERE brand_id=? ORDER BY name', brandId),
        courses: all('SELECT id,title name FROM courses WHERE brand_id=? ORDER BY title', brandId),
        materials: all(
          'SELECT id,title name,status,course_id courseId,channel FROM content_templates WHERE brand_id=? ORDER BY title',
          brandId,
        ),
        flows: all(
          "SELECT id,name,status,published_version FROM chatflows WHERE brand_id=? AND status!='archived' ORDER BY name",
          brandId,
        ).map(f => ({
          id: f.id,
          name: f.name,
          published: f.published_version !== null,
          active: f.status === 'active' && f.published_version !== null,
        })),
        users: all(
          "SELECT u.id,u.name,u.disabled FROM users u WHERE u.role IN ('admin','agent') AND (u.role='admin' OR EXISTS(SELECT 1 FROM brand_members b WHERE b.user_id=u.id AND b.brand_id=?)) ORDER BY u.name",
          brandId,
        ).map(u => ({ id: u.id, name: u.name, active: !u.disabled })),
      };
    },
    brandName: brandId => one('SELECT name FROM brands WHERE id=?', brandId)?.name ?? brandId,
    globalPaused: () => Boolean(one('SELECT paused FROM automation_global WHERE id=1')?.paused),
    automationEnabled: brandId =>
      Boolean(one('SELECT enabled FROM automation_settings WHERE brand_id=?', brandId)?.enabled),
    activeFlows: brandId =>
      all(
        "SELECT f.id,f.name,v.start FROM chatflows f JOIN chatflow_versions v ON v.flow_id=f.id AND v.version=f.published_version WHERE f.brand_id=? AND f.status='active' ORDER BY f.created_at,f.id",
        brandId,
      ).map(f => ({ id: f.id, name: f.name, start: json(f.start, { type: 'manual' }) })),
  };
}
