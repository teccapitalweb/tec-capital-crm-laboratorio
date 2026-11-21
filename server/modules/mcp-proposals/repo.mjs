// Todo el SQL de las propuestas del asistente (server/modules/mcp-proposals/module.mjs). Las funciones reciben la marca
// primero: nada se lee ni se cambia fuera de ella. Las lecturas de las entidades (recorrido, secuencia, regla,
// apertura, accesos, promoción, texto) son sólo de consulta: el cambio real lo hace la ruta de cada módulo.
export function createRepo(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null;
  const all = (sql, ...args) => db.prepare(sql).all(...args);

  // Lo que hace falta de cada entidad para describirla, comprobar su revisión y decidir si la acción tiene sentido.
  const ENTITY = {
    // Con el inicio de su versión publicada (el que vale al activarlo o pausarlo) y su antigüedad (decide el orden
    // entre recorridos del mismo tipo de inicio, server/modules/chatflows/runtime.mjs: pick()).
    chatflow: (b, id) =>
      one(
        `SELECT f.id,f.name,f.status,f.revision,f.published_version,f.draft,f.created_at,v.start published_start
         FROM chatflows f LEFT JOIN chatflow_versions v ON v.flow_id=f.id AND v.version=f.published_version
         WHERE f.id=? AND f.brand_id=?`,
        id,
        b,
      ),
    sequence: (b, id) =>
      one('SELECT id,title name,enabled,archived_at,revision,steps FROM sequences WHERE id=? AND brand_id=?', id, b),
    rule: (b, id) =>
      one('SELECT id,title name,status,revision,definition FROM automation_rules WHERE id=? AND brand_id=?', id, b),
    edition: (b, id) =>
      one(
        'SELECT e.*,k.title course_title,k.active course_active,k.syllabus course_syllabus FROM editions e JOIN courses k ON k.id=e.course_id WHERE e.id=? AND e.brand_id=?',
        id,
        b,
      ),
    course_access: (b, id) =>
      one(
        `SELECT e.id,e.name edition_name,e.status edition_status,e.group_url,e.starts_at,e.timezone,k.title course_title,
           k.active course_active,COALESCE(a.enabled,0) enabled,COALESCE(a.body,'') body,COALESCE(a.revision,0) revision
         FROM editions e JOIN courses k ON k.id=e.course_id LEFT JOIN course_access a ON a.edition_id=e.id
         WHERE e.id=? AND e.brand_id=?`,
        id,
        b,
      ),
    promotion: (b, id) =>
      one(
        `SELECT p.*,e.name edition_name,e.status edition_status,e.starts_at edition_starts,e.price_cents edition_price,
           e.currency,e.timezone,k.title course_title
         FROM promotions p JOIN editions e ON e.id=p.edition_id JOIN courses k ON k.id=e.course_id
         WHERE p.id=? AND p.brand_id=?`,
        id,
        b,
      ),
    content_template: (b, id) =>
      one('SELECT id,title name,status,revision,body,scenario FROM content_templates WHERE id=? AND brand_id=?', id, b),
    // Una imagen (flyer) con su archivo, su apertura y su curso: para ver qué se aprueba y si su `binding` sigue al día.
    flyer: (b, id) =>
      one(
        `SELECT f.id,f.title,f.status,f.revision,f.binding,f.file_id,f.edition_id,f.course_id,f.promotion_id,f.channel,
           f.expires_at,e.name edition_name,e.status edition_status,e.revision edition_revision,e.starts_at,
           e.timezone,e.instructor,e.modality,e.location,e.price_cents,e.currency,k.title course_title,
           k.active course_active,k.version course_version,l.mime,l.builtin_id
         FROM flyers f JOIN editions e ON e.id=f.edition_id JOIN courses k ON k.id=f.course_id
           JOIN library_files l ON l.id=f.file_id
         WHERE f.id=? AND f.brand_id=?`,
        id,
        b,
      ),
    // Un curso en borrador del conector, con su imagen (si sigue en la biblioteca de la marca) y lo que ya se creó en
    // un intento anterior de darlo de alta.
    course_draft: (b, id) =>
      one(
        `SELECT d.*,l.mime file_mime,k.active created_course_active
         FROM mcp_course_drafts d
           LEFT JOIN library_files l ON l.id=d.file_id AND l.brand_id=d.brand_id
           LEFT JOIN courses k ON k.id=d.course_id AND k.brand_id=d.brand_id
         WHERE d.id=? AND d.brand_id=?`,
        id,
        b,
      ),
    // Un curso: su «revisión» es su versión (la que pide la ruta de archivar como expectedRevision).
    course: (b, id) =>
      one('SELECT id,brand_id,title name,active,version revision FROM courses WHERE id=? AND brand_id=?', id, b),
  };

  // Dónde se usa un curso (para avisar antes de archivarlo). Todo dentro de la marca. Recorridos, secuencias, reglas y
  // difusiones guardan el curso dentro de su configuración (JSON): se busca su id entre comillas, así que un aviso
  // puede salir de más (otro dato con el mismo texto), nunca de menos.
  const n = (sql, ...args) => one(sql, ...args)?.n ?? 0;
  function courseUsage(b, courseId) {
    const like = '%"' + String(courseId).replace(/[%_\\]/g, '\\$&') + '"%';
    return {
      publishedEditions: n(
        "SELECT count(*) n FROM editions WHERE brand_id=? AND course_id=? AND status='published'",
        b,
        courseId,
      ),
      draftEditions: n(
        "SELECT count(*) n FROM editions WHERE brand_id=? AND course_id=? AND status='draft'",
        b,
        courseId,
      ),
      liveOrders: n(
        "SELECT count(*) n FROM orders WHERE brand_id=? AND course_id=? AND status IN ('pending','review')",
        b,
        courseId,
      ),
      openConversations: n(
        "SELECT count(*) n FROM conversations WHERE brand_id=? AND course_id=? AND status!='resolved'",
        b,
        courseId,
      ),
      waNumbers: all(
        "SELECT COALESCE(NULLIF(label,''),'Número sin nombre') label FROM wa_numbers WHERE brand_id=? AND course_id=? ORDER BY label",
        b,
        courseId,
      ).map(r => r.label),
      ads: n('SELECT count(*) n FROM wa_ads WHERE brand_id=? AND course_id=?', b, courseId),
      sequences: n(
        `SELECT count(*) n FROM sequences WHERE brand_id=? AND enabled=1 AND archived_at IS NULL
           AND (course_id=? OR steps LIKE ? ESCAPE '\\' OR settings LIKE ? ESCAPE '\\')`,
        b,
        courseId,
        like,
        like,
      ),
      flows: n(
        `SELECT count(*) n FROM chatflows f WHERE f.brand_id=? AND f.status='active' AND (f.start LIKE ? ESCAPE '\\'
           OR EXISTS(SELECT 1 FROM chatflow_versions v WHERE v.flow_id=f.id AND v.version=f.published_version
             AND (v.graph LIKE ? ESCAPE '\\' OR v.start LIKE ? ESCAPE '\\' OR v.settings LIKE ? ESCAPE '\\')))`,
        b,
        like,
        like,
        like,
        like,
      ),
      rules: n(
        "SELECT count(*) n FROM automation_rules WHERE brand_id=? AND status='active' AND definition LIKE ? ESCAPE '\\'",
        b,
        like,
      ),
      broadcasts: n(
        `SELECT count(*) n FROM campaigns WHERE brand_id=? AND status IN ('scheduled','sending')
           AND (content LIKE ? ESCAPE '\\' OR segment LIKE ? ESCAPE '\\')`,
        b,
        like,
        like,
      ),
    };
  }

  // Nombres de lo que nombra un recorrido, una secuencia o una regla, siempre dentro de la marca (fuera de ella no hay
  // nombre). Para la vista previa de «Lo que se enviará a los clientes».
  const named = sql => (b, id) => (typeof id === 'string' && id ? (one(sql, id, b)?.name ?? null) : null);
  const NAMES = {
    file: named('SELECT filename name FROM library_files WHERE id=? AND brand_id=?'),
    material: named('SELECT title name FROM content_templates WHERE id=? AND brand_id=?'),
    template: named('SELECT name FROM wa_templates WHERE id=? AND brand_id=?'),
    sequence: named('SELECT title name FROM sequences WHERE id=? AND brand_id=?'),
    flow: named('SELECT name FROM chatflows WHERE id=? AND brand_id=?'),
    tag: named('SELECT name FROM contact_tags WHERE id=? AND brand_id=?'),
    course: named('SELECT title name FROM courses WHERE id=? AND brand_id=?'),
    user: named(
      "SELECT u.name FROM users u WHERE u.id=? AND u.role IN ('admin','agent') AND (u.role='admin' OR EXISTS(SELECT 1 FROM brand_members m WHERE m.user_id=u.id AND m.brand_id=?))",
    ),
  };
  const DECIDED = "status NOT IN ('pending','approving')";

  return {
    entity: (brandId, type, id) => (Object.hasOwn(ENTITY, type) ? ENTITY[type](brandId, id) : null),
    courseUsage,
    // Lecturas para el alta paso a paso (siempre dentro de la marca).
    read: {
      draftEdition: (brandId, courseId) =>
        one(
          "SELECT id FROM editions WHERE brand_id=? AND course_id=? AND status='draft' ORDER BY created_at LIMIT 1",
          brandId,
          courseId,
        )?.id ?? null,
      edition: (brandId, id) => one('SELECT id,status,revision FROM editions WHERE id=? AND brand_id=?', id, brandId),
      flyer: (brandId, id) => one('SELECT id,status,revision FROM flyers WHERE id=? AND brand_id=?', id, brandId),
    },
    // ¿Hay una propuesta pendiente de publicar esta apertura? (la imagen se puede aprobar en el mismo lote, después)
    pendingPublish: (brandId, editionId) =>
      Boolean(
        one(
          "SELECT 1 FROM mcp_proposals WHERE brand_id=? AND action='publicar_apertura' AND entity_id=? AND status IN ('pending','approving')",
          brandId,
          editionId,
        ),
      ),
    names: brandId => Object.fromEntries(Object.entries(NAMES).map(([k, f]) => [k, id => f(brandId, id)])),
    versionGraph: (brandId, flowId, version) =>
      one('SELECT graph FROM chatflow_versions WHERE flow_id=? AND version=? AND brand_id=?', flowId, version, brandId)
        ?.graph ?? null,
    // Conversaciones que están dentro de un recorrido ahora mismo (sesión sin terminar).
    flowLiveSessions: (brandId, flowId) =>
      one("SELECT count(*) n FROM chatflow_sessions WHERE brand_id=? AND flow_id=? AND state!='ended'", brandId, flowId)
        ?.n ?? 0,
    // Los recorridos activos de la marca con el inicio de su versión publicada, del más antiguo al más nuevo (el mismo
    // orden con que el motor elige cuál arranca).
    activeFlows: brandId =>
      all(
        `SELECT f.id,f.name,f.created_at,v.start FROM chatflows f
           JOIN chatflow_versions v ON v.flow_id=f.id AND v.version=f.published_version
         WHERE f.brand_id=? AND f.status='active' ORDER BY f.created_at,f.id`,
        brandId,
      ).map(f => {
        let start = null;
        try {
          start = JSON.parse(f.start || 'null');
        } catch {
          start = null;
        }
        return { id: f.id, name: f.name, createdAt: f.created_at, start };
      }),
    // ¿Otra promoción publicada de la misma apertura coincide en fechas? (la misma regla que el catálogo)
    promotionOverlap: p =>
      Boolean(
        one(
          "SELECT id FROM promotions WHERE edition_id=? AND id!=? AND status='published' AND starts_at<? AND ends_at>?",
          p.edition_id,
          p.id,
          p.ends_at,
          p.starts_at,
        ),
      ),
    brandName: id => one('SELECT name FROM brands WHERE id=?', id)?.name ?? id,
    userName: id => (id ? (one('SELECT name FROM users WHERE id=?', id)?.name ?? null) : null),

    get: (brandId, id) => one('SELECT * FROM mcp_proposals WHERE id=? AND brand_id=?', id, brandId),
    byId: id => one('SELECT * FROM mcp_proposals WHERE id=?', id),
    open: (brandId, action, entityId) =>
      one(
        "SELECT * FROM mcp_proposals WHERE brand_id=? AND action=? AND entity_id=? AND status IN ('pending','approving')",
        brandId,
        action,
        entityId,
      ),
    pendingCount: brandId =>
      one("SELECT count(*) n FROM mcp_proposals WHERE brand_id=? AND status IN ('pending','approving')", brandId).n,
    pending: brandIds =>
      brandIds.length
        ? all(
            `SELECT * FROM mcp_proposals WHERE brand_id IN (${brandIds.map(() => '?').join(',')}) AND status IN ('pending','approving') ORDER BY created_at DESC`,
            ...brandIds,
          )
        : [],
    // Pendientes de un mismo origen (la llave o el permiso OAuth que las propuso).
    pendingBySource: (brandId, kind, sourceId) =>
      one(
        "SELECT count(*) n FROM mcp_proposals WHERE brand_id=? AND source_kind=? AND source_id=? AND status IN ('pending','approving')",
        brandId,
        kind,
        sourceId,
      ).n,
    history: (brandIds, limit) =>
      brandIds.length
        ? all(
            `SELECT * FROM mcp_proposals WHERE brand_id IN (${brandIds.map(() => '?').join(',')}) AND ${DECIDED} ORDER BY updated_at DESC LIMIT ?`,
            ...brandIds,
            limit,
          )
        : [],
    // Lo que ve el conector: sólo las de su propio origen.
    forSource: (brandId, kind, sourceId, limit) =>
      all(
        'SELECT * FROM mcp_proposals WHERE brand_id=? AND source_kind=? AND source_id=? ORDER BY created_at DESC LIMIT ?',
        brandId,
        kind,
        sourceId,
        limit,
      ),
    allPending: limit => all("SELECT * FROM mcp_proposals WHERE status='pending' ORDER BY expires_at LIMIT ?", limit),
    // Las decididas (todo lo que no es pendiente ni aprobándose) de antes de `before`, por trozos; devuelve cuántas borró.
    purgeDecided: (before, limit) =>
      db
        .prepare(
          `DELETE FROM mcp_proposals WHERE id IN (SELECT id FROM mcp_proposals WHERE ${DECIDED} AND updated_at<? ORDER BY updated_at LIMIT ?)`,
        )
        .run(before, limit).changes,

    insert(p) {
      db.prepare(
        `INSERT INTO mcp_proposals(id,brand_id,action,entity_type,entity_id,entity_revision,entity_name,note,source_kind,
           source_id,source_name,proposed_by,status,created_at,updated_at,expires_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
      ).run(
        p.id,
        p.brandId,
        p.action,
        p.entityType,
        p.entityId,
        p.revision,
        p.entityName,
        p.note,
        p.sourceKind,
        p.sourceId,
        p.sourceName,
        p.proposedBy,
        p.at,
        p.at,
        p.expiresAt,
      );
    },
    // Cambio de estado atómico: sólo si sigue en el estado que se espera. Devuelve si cambió. Con `decided`, anota quién
    // y cuándo (sin persona, los borra: una propuesta que vuelve a pendiente no tiene quien la decidió).
    move(brandId, id, from, to, { userId = null, error = null, at, decided = false }) {
      return (
        db
          .prepare(
            `UPDATE mcp_proposals SET status=?,error=?,updated_at=?${decided ? ',decided_by=?,decided_at=?' : ''}
             WHERE id=? AND brand_id=? AND status=?`,
          )
          .run(...[to, error, at, ...(decided ? [userId, userId ? at : null] : []), id, brandId, from]).changes === 1
      );
    },
    // Lo que se aprobaba y no terminó (el proceso se detuvo a la mitad) se marca como fallido.
    unstick: (before, at) =>
      db
        .prepare(
          "UPDATE mcp_proposals SET status='failed',error=?,updated_at=? WHERE status='approving' AND updated_at<?",
        )
        .run('La aprobación se interrumpió. Revisa en su pantalla si se aplicó.', at, before).changes,
    expire: at =>
      db
        .prepare("UPDATE mcp_proposals SET status='expired',updated_at=? WHERE status='pending' AND expires_at<=?")
        .run(at, at).changes,
  };
}
