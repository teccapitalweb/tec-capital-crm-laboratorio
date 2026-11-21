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
        `INSERT INTO mcp_upload_tokens(id,brand_id,edition_id,course_draft_id,token_hash,source_kind,source_id,created_by,
           status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'open',?,?)`,
      ).run(
        t.id,
        t.brandId,
        t.editionId ?? null,
        t.draftId ?? null,
        t.hash,
        t.sourceKind,
        t.sourceId,
        t.createdBy,
        t.at,
        t.expiresAt,
      );
    },

    // ---- cursos en borrador del conector (mcp_course_drafts): siempre dentro de la marca
    draft: (brandId, id) => one('SELECT * FROM mcp_course_drafts WHERE id=? AND brand_id=?', id, brandId),
    // Los de un origen (lo que ve y toca el conector)
    ownDraft: (brandId, kind, sourceId, id) =>
      one(
        'SELECT * FROM mcp_course_drafts WHERE id=? AND brand_id=? AND source_kind=? AND source_id=?',
        id,
        brandId,
        kind,
        sourceId,
      ),
    draftByRef: (brandId, kind, sourceId, ref) =>
      one(
        'SELECT * FROM mcp_course_drafts WHERE brand_id=? AND source_kind=? AND source_id=? AND client_ref=?',
        brandId,
        kind,
        sourceId,
        ref,
      ),
    ownDrafts: (brandId, kind, sourceId, limit) =>
      all(
        'SELECT * FROM mcp_course_drafts WHERE brand_id=? AND source_kind=? AND source_id=? ORDER BY updated_at DESC LIMIT ?',
        brandId,
        kind,
        sourceId,
        limit,
      ),
    liveDraftsBySource: (brandId, kind, sourceId) =>
      count(
        "SELECT count(*) n FROM mcp_course_drafts WHERE brand_id=? AND source_kind=? AND source_id=? AND status='draft'",
        brandId,
        kind,
        sourceId,
      ),
    liveDraftsByBrand: brandId =>
      count("SELECT count(*) n FROM mcp_course_drafts WHERE brand_id=? AND status='draft'", brandId),
    // Títulos con los que se compara uno nuevo: los cursos de la marca (activos o archivados, salvo el que ya creó este
    // borrador en un intento anterior) y los borradores vivos de la marca (de cualquier origen, salvo éste).
    titlesOf: (brandId, exceptDraft, exceptCourse) =>
      [
        ...all('SELECT title FROM courses WHERE brand_id=? AND id IS NOT ?', brandId, exceptCourse ?? null),
        ...all(
          "SELECT title FROM mcp_course_drafts WHERE brand_id=? AND status='draft' AND id IS NOT ?",
          brandId,
          exceptDraft ?? null,
        ),
      ].map(r => r.title),
    file: (brandId, id) =>
      id ? one('SELECT id,mime,filename FROM library_files WHERE id=? AND brand_id=?', id, brandId) : null,
    insertDraft(d) {
      const keys = Object.keys(d);
      db.prepare(`INSERT INTO mcp_course_drafts(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(
        ...keys.map(k => d[k]),
      );
    },
    // Guardar sólo si sigue en borrador y en la revisión que se leyó; devuelve si cambió.
    saveDraft(brandId, id, revision, fields, at) {
      const keys = Object.keys(fields);
      return (
        db
          .prepare(
            `UPDATE mcp_course_drafts SET ${keys.map(k => k + '=?').join(',')},revision=revision+1,updated_at=?
             WHERE id=? AND brand_id=? AND revision=? AND status='draft'`,
          )
          .run(...keys.map(k => fields[k]), at, id, brandId, revision).changes === 1
      );
    },
    // El avance del alta (ids creados), sin tocar la revisión: lo escribe la aprobación paso a paso.
    launchProgress(brandId, id, fields, at) {
      const keys = Object.keys(fields);
      db.prepare(
        `UPDATE mcp_course_drafts SET ${keys.map(k => k + '=?').join(',')},updated_at=? WHERE id=? AND brand_id=? AND status='draft'`,
      ).run(...keys.map(k => fields[k]), at, id, brandId);
    },
    markCreated: (brandId, id, at) =>
      db
        .prepare(
          "UPDATE mcp_course_drafts SET status='created',updated_at=? WHERE id=? AND brand_id=? AND status='draft'",
        )
        .run(at, id, brandId).changes === 1,
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
