// Todo el SQL de las propuestas del asistente (server/modules/mcp-proposals/module.mjs). Las funciones reciben la marca
// primero: nada se lee ni se cambia fuera de ella. Las lecturas de las entidades (recorrido, secuencia, regla,
// apertura, accesos, promoción, texto) son sólo de consulta: el cambio real lo hace la ruta de cada módulo.
export function createRepo(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null;
  const all = (sql, ...args) => db.prepare(sql).all(...args);

  // Lo que hace falta de cada entidad para describirla, comprobar su revisión y decidir si la acción tiene sentido.
  const ENTITY = {
    chatflow: (b, id) =>
      one('SELECT id,name,status,revision,published_version,draft FROM chatflows WHERE id=? AND brand_id=?', id, b),
    sequence: (b, id) =>
      one('SELECT id,title name,enabled,archived_at,revision,steps FROM sequences WHERE id=? AND brand_id=?', id, b),
    rule: (b, id) =>
      one('SELECT id,title name,status,revision,definition FROM automation_rules WHERE id=? AND brand_id=?', id, b),
    edition: (b, id) =>
      one(
        'SELECT e.*,k.title course_title,k.active course_active FROM editions e JOIN courses k ON k.id=e.course_id WHERE e.id=? AND e.brand_id=?',
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
  };

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
    names: brandId => Object.fromEntries(Object.entries(NAMES).map(([k, f]) => [k, id => f(brandId, id)])),
    versionGraph: (brandId, flowId, version) =>
      one('SELECT graph FROM chatflow_versions WHERE flow_id=? AND version=? AND brand_id=?', flowId, version, brandId)
        ?.graph ?? null,
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
