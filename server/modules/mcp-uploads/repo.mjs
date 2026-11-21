// Todo el SQL de las direcciones de subida (server/modules/mcp-uploads/module.mjs). Lo que lee de las aperturas,
// cursos e imágenes es sólo de consulta: el archivo y la imagen (flyer) los crean las rutas del catálogo.
export function createRepo(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null;
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const count = (sql, ...args) => one(sql, ...args).n;

  return {
    // La apertura con su curso, dentro de la marca.
    edition: (brandId, id) =>
      one(
        `SELECT e.id,e.brand_id,e.course_id,e.name,e.status,e.revision,k.title course_title,k.active course_active
         FROM editions e JOIN courses k ON k.id=e.course_id WHERE e.id=? AND e.brand_id=?`,
        id,
        brandId,
      ),
    user: id => one('SELECT * FROM users WHERE id=?', id),

    insert(t) {
      db.prepare(
        `INSERT INTO mcp_upload_tokens(id,brand_id,edition_id,token_hash,source_kind,source_id,created_by,status,
           created_at,expires_at) VALUES(?,?,?,?,?,?,?,'open',?,?)`,
      ).run(t.id, t.brandId, t.editionId, t.hash, t.sourceKind, t.sourceId, t.createdBy, t.at, t.expiresAt);
    },
    byHash: hash => one('SELECT * FROM mcp_upload_tokens WHERE token_hash=?', hash),
    get: id => one('SELECT * FROM mcp_upload_tokens WHERE id=?', id),
    // Gastar la ficha: abierta → usada, sólo si sigue abierta y sin vencer. Devuelve si la gastó esta llamada.
    spend: (id, at) =>
      db
        .prepare("UPDATE mcp_upload_tokens SET status='used',used_at=? WHERE id=? AND status='open' AND expires_at>?")
        .run(at, id, at).changes === 1,
    finish: (id, { status, error = null, fileId = null, flyerId = null }) =>
      db
        .prepare("UPDATE mcp_upload_tokens SET status=?,error=?,file_id=?,flyer_id=? WHERE id=? AND status='used'")
        .run(status, error, fileId, flyerId, id).changes === 1,

    // ---- topes
    openBySource: (kind, sourceId, at) =>
      count(
        "SELECT count(*) n FROM mcp_upload_tokens WHERE source_kind=? AND source_id=? AND status='open' AND expires_at>?",
        kind,
        sourceId,
        at,
      ),
    openByBrand: (brandId, at) =>
      count(
        "SELECT count(*) n FROM mcp_upload_tokens WHERE brand_id=? AND status='open' AND expires_at>?",
        brandId,
        at,
      ),
    usedSince: (brandId, since) =>
      count('SELECT count(*) n FROM mcp_upload_tokens WHERE brand_id=? AND used_at>=?', brandId, since),
    // Imágenes en borrador de una apertura y de la marca (de quien sea), sin contar las del conector que se van a
    // sustituir.
    draftsOfEdition: (brandId, editionId, except) =>
      count(
        `SELECT count(*) n FROM flyers WHERE brand_id=? AND edition_id=? AND status='draft'
           AND id NOT IN (SELECT value FROM json_each(?))`,
        brandId,
        editionId,
        JSON.stringify(except),
      ),
    draftsOfBrand: (brandId, except) =>
      count(
        "SELECT count(*) n FROM flyers WHERE brand_id=? AND status='draft' AND id NOT IN (SELECT value FROM json_each(?))",
        brandId,
        JSON.stringify(except),
      ),
    // Las imágenes en borrador que dejó el conector en esta apertura (las que un borrador nuevo sustituye).
    connectorDrafts: (brandId, editionId) =>
      all(
        `SELECT f.id,f.revision FROM flyers f
         WHERE f.brand_id=? AND f.edition_id=? AND f.status='draft'
           AND f.id IN (SELECT flyer_id FROM mcp_upload_tokens WHERE brand_id=? AND edition_id=? AND status='done')`,
        brandId,
        editionId,
        brandId,
        editionId,
      ),
    flyer: (brandId, id) => one('SELECT * FROM flyers WHERE id=? AND brand_id=?', id, brandId),

    // ---- limpieza: las abiertas que vencieron se marcan fallidas; las de más de `keepMs` se borran por trozos.
    expire: at =>
      db
        .prepare(
          "UPDATE mcp_upload_tokens SET status='failed',error='Venció sin usarse.' WHERE status='open' AND expires_at<=?",
        )
        .run(at).changes,
    // Una subida que se quedó a medias (el proceso se detuvo) se marca fallida.
    unstick: before =>
      db
        .prepare(
          "UPDATE mcp_upload_tokens SET status='failed',error='La subida se interrumpió.' WHERE status='used' AND used_at<?",
        )
        .run(before).changes,
    purge: (before, limit) =>
      db
        .prepare(
          'DELETE FROM mcp_upload_tokens WHERE id IN (SELECT id FROM mcp_upload_tokens WHERE created_at<? ORDER BY created_at LIMIT ?)',
        )
        .run(before, limit).changes,
  };
}
