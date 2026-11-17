// Todo el SQL de los recorridos (docs/PLAN_RECORRIDOS.md). Cada función recibe la marca primero y filtra por ella:
// un recorrido, una sesión o un evento de otra marca no existe para quien pregunta.
import { FLOW_FILE_MIMES } from '../../../public/kit/shared/flow-support.js';

const json = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

export function createRepo(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  const flowRow = row =>
    row && {
      ...row,
      draft: json(row.draft, null),
      settings: json(row.settings, {}),
      start: json(row.start, { type: 'manual' }),
    };
  const versionRow = row =>
    row && { ...row, graph: json(row.graph, null), settings: json(row.settings, {}), start: json(row.start, {}) };
  const sessionRow = row =>
    row && {
      ...row,
      vars: json(row.vars, {}),
      waiting: row.waiting ? json(row.waiting, null) : null,
    };

  return {
    // ---- recorridos
    brandOf: id => one('SELECT brand_id FROM chatflows WHERE id=?', id)?.brand_id ?? null,
    flow: (brandId, id) => flowRow(one('SELECT * FROM chatflows WHERE brand_id=? AND id=?', brandId, id)),
    flowByRef: (brandId, ref) =>
      flowRow(one('SELECT * FROM chatflows WHERE brand_id=? AND client_ref=?', brandId, ref)),
    flows: (brandIds, { archived = false } = {}) =>
      brandIds.length
        ? all(
            `SELECT * FROM chatflows WHERE brand_id IN (${brandIds.map(() => '?').join(',')})${archived ? '' : " AND status!='archived'"} ORDER BY brand_id,updated_at DESC,id`,
            ...brandIds,
          ).map(flowRow)
        : [],
    count: brandId => one("SELECT count(*) n FROM chatflows WHERE brand_id=? AND status!='archived'", brandId).n,
    insertFlow(brandId, f) {
      run(
        'INSERT INTO chatflows(id,brand_id,name,description,status,draft,settings,start,revision,client_ref,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?)',
        f.id,
        brandId,
        f.name,
        f.description,
        'draft',
        JSON.stringify(f.draft),
        JSON.stringify(f.settings),
        JSON.stringify(f.start),
        f.clientRef ?? null,
        f.userId,
        f.userId,
        f.at,
        f.at,
      );
    },
    // Cambia campos con candado de revisión; devuelve false si alguien más guardó antes.
    updateFlow(brandId, id, expectedRevision, fields, userId, at) {
      const cols = [];
      const args = [];
      for (const [key, value] of Object.entries(fields)) {
        cols.push(key + '=?');
        args.push(value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
      }
      return (
        run(
          `UPDATE chatflows SET ${cols.join(',')},revision=revision+1,updated_by=?,updated_at=? WHERE brand_id=? AND id=? AND revision=?`,
          ...args,
          userId,
          at,
          brandId,
          id,
          expectedRevision,
        ).changes === 1
      );
    },
    insertVersion(brandId, v) {
      run(
        'INSERT INTO chatflow_versions(flow_id,version,brand_id,name,graph,settings,start,note,published_by,published_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        v.flowId,
        v.version,
        brandId,
        v.name,
        JSON.stringify(v.graph),
        JSON.stringify(v.settings),
        JSON.stringify(v.start),
        v.note,
        v.userId,
        v.at,
      );
    },
    version: (brandId, flowId, version) =>
      versionRow(
        one('SELECT * FROM chatflow_versions WHERE brand_id=? AND flow_id=? AND version=?', brandId, flowId, version),
      ),
    versions: (brandId, flowId) =>
      all(
        'SELECT version,name,note,published_by,published_at FROM chatflow_versions WHERE brand_id=? AND flow_id=? ORDER BY version DESC',
        brandId,
        flowId,
      ),
    lastVersion: (brandId, flowId) =>
      one('SELECT max(version) v FROM chatflow_versions WHERE brand_id=? AND flow_id=?', brandId, flowId).v ?? 0,
    // Recorridos que pueden iniciar una sesión: activos y con versión publicada, con lo publicado.
    startable: brandId =>
      all(
        "SELECT f.id,f.name,f.created_at,v.version,v.graph,v.settings,v.start FROM chatflows f JOIN chatflow_versions v ON v.flow_id=f.id AND v.version=f.published_version WHERE f.brand_id=? AND f.status='active' ORDER BY f.created_at,f.id",
        brandId,
      ).map(versionRow),
    published: (brandId, flowId) =>
      versionRow(
        one(
          'SELECT f.id,f.name,f.status,v.version,v.graph,v.settings,v.start FROM chatflows f JOIN chatflow_versions v ON v.flow_id=f.id AND v.version=f.published_version WHERE f.brand_id=? AND f.id=?',
          brandId,
          flowId,
        ),
      ),

    // ---- sesiones
    activeSession: (brandId, conversationId) =>
      sessionRow(
        one(
          "SELECT * FROM chatflow_sessions WHERE brand_id=? AND conversation_id=? AND state!='ended'",
          brandId,
          conversationId,
        ),
      ),
    activeAnyBrand: conversationId =>
      sessionRow(one("SELECT * FROM chatflow_sessions WHERE conversation_id=? AND state!='ended'", conversationId)),
    session: (brandId, id) => sessionRow(one('SELECT * FROM chatflow_sessions WHERE brand_id=? AND id=?', brandId, id)),
    sessionBySource: (brandId, key) =>
      sessionRow(one('SELECT * FROM chatflow_sessions WHERE brand_id=? AND source_key=?', brandId, key)),
    insertSession(brandId, s) {
      run(
        'INSERT INTO chatflow_sessions(id,brand_id,flow_id,flow_version,conversation_id,course_id,state,node_id,seq,vars,waiting,steps,unanswered,started_by,source_key,expires_at,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        s.id,
        brandId,
        s.flowId,
        s.version,
        s.conversationId,
        s.courseId ?? null,
        s.state,
        s.nodeId,
        s.seq,
        JSON.stringify(s.vars),
        s.waiting ? JSON.stringify(s.waiting) : null,
        s.steps,
        s.unanswered,
        s.startedBy,
        s.sourceKey ?? null,
        s.expiresAt,
        s.startedAt,
        s.startedAt,
      );
    },
    // Guarda la sesión sólo si nadie la movió desde que se leyó (`seq` leído): candado optimista.
    saveSession(brandId, s, readSeq, at) {
      return (
        run(
          'UPDATE chatflow_sessions SET state=?,node_id=?,seq=?,vars=?,waiting=?,steps=?,unanswered=?,expires_at=?,outcome=?,end_node_id=?,last_input_message_id=?,updated_at=?,ended_at=? WHERE brand_id=? AND id=? AND seq=?',
          s.state,
          s.nodeId,
          s.seq,
          JSON.stringify(s.vars),
          s.waiting ? JSON.stringify(s.waiting) : null,
          s.steps,
          s.unanswered,
          s.expiresAt,
          s.outcome,
          s.endNodeId,
          s.lastInputMessageId ?? null,
          at,
          s.state === 'ended' ? at : null,
          brandId,
          s.id,
          readSeq,
        ).changes === 1
      );
    },
    // Termina la sesión activa de una conversación desde afuera (toma humana, cierre, baja). Sube `seq` para que
    // ningún paso pendiente de esa sesión la vuelva a mover.
    endActive(brandId, conversationId, outcome, at) {
      const s = one(
        "SELECT id,flow_id,flow_version,node_id,course_id FROM chatflow_sessions WHERE brand_id=? AND conversation_id=? AND state!='ended'",
        brandId,
        conversationId,
      );
      if (!s) return null;
      run(
        "UPDATE chatflow_sessions SET state='ended',outcome=?,end_node_id=node_id,waiting=NULL,expires_at=NULL,seq=seq+1,updated_at=?,ended_at=? WHERE brand_id=? AND id=? AND state!='ended'",
        outcome,
        at,
        at,
        brandId,
        s.id,
      );
      return s;
    },
    endFlowSessions(brandId, flowId, outcome, at) {
      const rows = all(
        "SELECT id,flow_id,flow_version,node_id,course_id,conversation_id FROM chatflow_sessions WHERE brand_id=? AND flow_id=? AND state!='ended' LIMIT 500",
        brandId,
        flowId,
      );
      for (const s of rows)
        run(
          "UPDATE chatflow_sessions SET state='ended',outcome=?,end_node_id=node_id,waiting=NULL,expires_at=NULL,seq=seq+1,updated_at=?,ended_at=? WHERE brand_id=? AND id=?",
          outcome,
          at,
          at,
          brandId,
          s.id,
        );
      return rows;
    },
    // Sesiones anteriores del mismo recorrido en la conversación (para «volver a empezar»).
    lastSessionOf: (brandId, conversationId, flowId) =>
      one(
        'SELECT started_at,ended_at FROM chatflow_sessions WHERE brand_id=? AND conversation_id=? AND flow_id=? ORDER BY started_at DESC LIMIT 1',
        brandId,
        conversationId,
        flowId,
      ),
    sessions(brandId, flowId, { state = null, before = null, limit = 50 } = {}) {
      const where = ['s.brand_id=?', 's.flow_id=?'];
      const args = [brandId, flowId];
      if (state === 'active') where.push("s.state!='ended'");
      else if (state === 'ended') where.push("s.state='ended'");
      if (before) {
        where.push('s.started_at<?');
        args.push(before);
      }
      return all(
        `SELECT s.id,s.flow_version,s.conversation_id,s.state,s.node_id,s.outcome,s.end_node_id,s.steps,s.started_by,s.started_at,s.updated_at,s.ended_at,u.name customer_name FROM chatflow_sessions s JOIN conversations c ON c.id=s.conversation_id LEFT JOIN users u ON u.id=c.customer_id WHERE ${where.join(' AND ')} ORDER BY s.started_at DESC,s.id LIMIT ?`,
        ...args,
        Math.min(200, Math.max(1, limit)),
      );
    },
    counts: (brandId, flowId) =>
      all(
        'SELECT outcome,state,count(*) n FROM chatflow_sessions WHERE brand_id=? AND flow_id=? GROUP BY outcome,state',
        brandId,
        flowId,
      ),

    // ---- bitácora
    insertEvent(brandId, e) {
      run(
        'INSERT INTO chatflow_events(brand_id,session_id,flow_id,flow_version,node_id,node_type,course_id,event,port,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        brandId,
        e.sessionId,
        e.flowId,
        e.version,
        e.nodeId ?? null,
        e.nodeType ?? null,
        e.courseId ?? null,
        e.event,
        e.port ?? null,
        e.detail === undefined || e.detail === null ? null : String(e.detail).slice(0, 300),
        e.at,
      );
    },
    events: (brandId, sessionId) =>
      all(
        'SELECT seq,node_id,node_type,event,port,detail,created_at FROM chatflow_events WHERE brand_id=? AND session_id=? ORDER BY seq LIMIT 500',
        brandId,
        sessionId,
      ),
    flowLog: (brandId, flowId, limit = 100) =>
      all(
        'SELECT seq,session_id,flow_version,node_id,node_type,event,port,detail,created_at FROM chatflow_events WHERE brand_id=? AND flow_id=? ORDER BY seq DESC LIMIT ?',
        brandId,
        flowId,
        Math.min(500, Math.max(1, limit)),
      ),

    // ---- lo que el motor lee de la conversación (siempre de la marca)
    conversation: (brandId, id) => one('SELECT * FROM conversations WHERE brand_id=? AND id=?', brandId, id),
    conversationBrand: id => one('SELECT brand_id FROM conversations WHERE id=?', id)?.brand_id ?? null,
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
    lastCustomerMessage: (brandId, conversationId) =>
      one(
        "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.brand_id=? AND m.conversation_id=? AND m.sender_kind='customer' ORDER BY m.seq DESC LIMIT 1",
        brandId,
        conversationId,
      ),
    messageByRef: ref => one('SELECT id,conversation_id FROM messages WHERE client_ref=?', ref),
    refsWithPrefix: prefix =>
      one('SELECT count(*) n FROM messages WHERE client_ref >= ? AND client_ref < ?', prefix, prefix + '￿').n,
    // Las plantillas de WhatsApp que esta atención del recorrido ya envió (sus ids), por la referencia de sus mensajes.
    templatesOfSession(sessionId) {
      const prefix = `flow:${sessionId}:`;
      return all(
        'SELECT wa_template FROM messages WHERE client_ref >= ? AND client_ref < ? AND wa_template IS NOT NULL',
        prefix,
        prefix + '￿',
      ).map(row => {
        try {
          return JSON.parse(row.wa_template)?.templateId ?? '';
        } catch {
          return '';
        }
      });
    },
    consentOf: (brandId, contactId) =>
      contactId
        ? (one('SELECT status FROM contact_consent WHERE brand_id=? AND contact_id=?', brandId, contactId)?.status ??
          'unknown')
        : 'unknown',
    material: (brandId, id) =>
      one('SELECT id,title,status FROM content_templates WHERE brand_id=? AND id=?', brandId, id),
    // Archivos de la biblioteca: siempre con la marca. Uno de otra marca no existe para el recorrido.
    libraryFile: (brandId, id) =>
      one(
        'SELECT id,filename,mime,size FROM library_files WHERE brand_id=? AND id=? AND storage_name IS NOT NULL',
        brandId,
        id,
      ),
    waTemplate: (brandId, id) => one('SELECT * FROM wa_templates WHERE brand_id=? AND id=?', brandId, id),
    insertFile(brandId, f) {
      run(
        'INSERT INTO library_files(id,brand_id,filename,mime,size,storage_name,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
        f.id,
        brandId,
        f.filename,
        f.mime,
        f.size,
        f.storageName,
        f.userId,
        f.at,
      );
    },
    // Lo que el mensaje recién guardado lleva además de su texto (dentro de la misma transacción que lo insertó).
    attachFile: (messageId, snapshot) =>
      run('UPDATE messages SET flyer_snapshot=? WHERE id=?', JSON.stringify(snapshot), messageId),
    setInteractive: (messageId, interactive) =>
      run('UPDATE messages SET interactive=? WHERE id=?', JSON.stringify(interactive), messageId),
    replyLog(brandId, r) {
      run(
        'INSERT INTO reply_log(id,conversation_id,brand_id,trigger_message_id,reply_message_id,intent,confidence,mode,action,reply_text,sources,reason,created_at) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
        r.id,
        r.conversationId,
        brandId,
        r.triggerId,
        r.replyId,
        'flow',
        r.mode,
        r.action,
        r.text,
        JSON.stringify(r.sources),
        r.reason,
        r.at,
      );
    },
    replyLogged: (brandId, triggerId) =>
      Boolean(
        one("SELECT 1 FROM reply_log WHERE brand_id=? AND trigger_message_id=? AND intent='flow'", brandId, triggerId),
      ),
    adminNotice(brandId, kind, details, at) {
      run(
        'INSERT INTO automation_events(step_id,brand_id,kind,details,created_at) VALUES(NULL,?,?,?,?)',
        brandId,
        kind,
        JSON.stringify(details),
        at,
      );
    },

    // ---- listas de la marca para validar al publicar (flow-model.js, contexto de validación)
    // Interruptores que deciden si la marca habla sola (sólo para explicar el motivo; la regla es runtime.brandSpeaks).
    globalPaused: () => Boolean(one('SELECT paused FROM automation_global WHERE id=1')?.paused),
    automationEnabled: brandId =>
      Boolean(one('SELECT enabled FROM automation_settings WHERE brand_id=?', brandId)?.enabled),
    brandName: brandId => one('SELECT name FROM brands WHERE id=?', brandId)?.name ?? brandId,
    // Cuándo se publicó la versión que está en servicio (para la lista de recorridos).
    publishedAt: (brandId, flowId, version) =>
      version === null || version === undefined
        ? null
        : (one(
            'SELECT published_at FROM chatflow_versions WHERE brand_id=? AND flow_id=? AND version=?',
            brandId,
            flowId,
            version,
          )?.published_at ?? null),
    validationLists(brandId) {
      return {
        tags: all('SELECT id,name FROM contact_tags WHERE brand_id=?', brandId),
        courses: all('SELECT id,title FROM courses WHERE brand_id=?', brandId),
        users: all(
          "SELECT u.id,u.name,u.disabled FROM users u WHERE u.role IN ('admin','agent') AND (u.role='admin' OR EXISTS(SELECT 1 FROM brand_members b WHERE b.user_id=u.id AND b.brand_id=?))",
          brandId,
        ).map(u => ({ id: u.id, name: u.name, active: !u.disabled })),
        materials: all('SELECT id,title name,status FROM content_templates WHERE brand_id=?', brandId),
        flows: all(
          "SELECT id,name,published_version FROM chatflows WHERE brand_id=? AND status!='archived'",
          brandId,
        ).map(f => ({ id: f.id, name: f.name, published: f.published_version !== null })),
        // Archivos que un recorrido puede enviar: de la biblioteca de la marca, guardados por el CRM (no los artes de
        // ejemplo) y de un tipo admitido. Un id que no esté aquí se rechaza al publicar como «no existe en esta marca».
        files: all(
          `SELECT id,filename name,mime FROM library_files WHERE brand_id=? AND storage_name IS NOT NULL AND mime IN (${FLOW_FILE_MIMES.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 500`,
          brandId,
          ...FLOW_FILE_MIMES,
        ),
        // ¿La marca tiene un número real de WhatsApp activo? Sin él, una Plantilla de WhatsApp no tiene por dónde salir.
        realWhatsApp: Boolean(one('SELECT 1 FROM wa_numbers WHERE brand_id=? AND enabled=1', brandId)),
      };
    },
  };
}
