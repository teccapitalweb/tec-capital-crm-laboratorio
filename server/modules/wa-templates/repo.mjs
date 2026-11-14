// Todo el SQL de las plantillas de WhatsApp (docs/PLAN_PLANTILLAS_COMPLETAS.md). Ninguna función abre una transacción
// ni hace red: el módulo compone las escrituras dentro de las suyas y el oyente de avisos de Meta corre dentro de la
// del canal. Las funciones de una marca reciben `brandId` primero.
//
// Cuenta: una plantilla pertenece a una cuenta de WhatsApp Business (waba_id). La cuenta vigente es META_WABA_ID; las
// filas de antes de D-3 tienen waba_id '' («sin cuenta asignada») y cuentan como de la cuenta vigente hasta que la
// sincronización o el envío a revisión se las asigna.
const COLUMNS =
  'id,brand_id,waba_id,name,language,category,purpose,body,variables,components,tpl_type,status,status_detail,status_at,meta_id,reject_reason,quality,quality_at,prev_category,category_changed_at,category_ack_at,submitted_at,approved_at,header_handle,library_key,copied_from,archived_at,revision,created_by,updated_by,created_at,updated_at,synced_at';

export function createRepo(db) {
  const one = sql => {
    let statement = null;
    return (...args) => (statement ??= db.prepare(sql)).get(...args);
  };
  const all = sql => {
    let statement = null;
    return (...args) => (statement ??= db.prepare(sql)).all(...args);
  };
  const run = sql => {
    let statement = null;
    return (...args) => (statement ??= db.prepare(sql)).run(...args);
  };

  return {
    // ---- lectura
    byId: one(`SELECT ${COLUMNS} FROM wa_templates WHERE id=?`),
    // ¿Ocupa ya ese nombre e idioma la cuenta? (también las archivadas: en Meta el nombre sigue ocupado)
    taken: one("SELECT id,status,archived_at FROM wa_templates WHERE name=? AND language=? AND waba_id IN ('',?)"),
    // De la cuenta (vigente o sin asignar), todas o sólo las vivas, en orden de marca y nombre.
    inAccount: all(`SELECT ${COLUMNS} FROM wa_templates WHERE waba_id IN ('',?) ORDER BY brand_id,name,language`),
    all: all(`SELECT ${COLUMNS} FROM wa_templates ORDER BY brand_id,name,language`),
    // Lista paginada para la pantalla: marcas visibles, búsqueda y filtros. `brandIds` ya viene acotado por permiso.
    page(brandIds, { q, status, category, language, archived, limit, offset }) {
      if (!brandIds.length) return { rows: [], total: 0 };
      const where = [`brand_id IN (${brandIds.map(() => '?').join(',')})`];
      const args = [...brandIds];
      if (!archived) where.push('archived_at IS NULL');
      if (q) {
        where.push("(name LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
        const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
        args.push(like, like);
      }
      if (status) {
        where.push('status=?');
        args.push(status);
      }
      if (category) {
        where.push('category=?');
        args.push(category);
      }
      if (language) {
        where.push('language=?');
        args.push(language);
      }
      const sql = where.join(' AND ');
      const total = db.prepare(`SELECT count(*) n FROM wa_templates WHERE ${sql}`).get(...args).n;
      const rows = db
        .prepare(`SELECT ${COLUMNS} FROM wa_templates WHERE ${sql} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`)
        .all(...args, limit, offset);
      return { rows, total };
    },
    // Las que puede usar el chat de una marca (aprobadas, no archivadas, de la cuenta vigente).
    sendable: all(
      `SELECT ${COLUMNS} FROM wa_templates WHERE brand_id=? AND status IN ('approved','flagged') AND archived_at IS NULL AND waba_id IN ('',?) ORDER BY purpose,name`,
    ),
    notice: one(
      `SELECT ${COLUMNS} FROM wa_templates WHERE brand_id=? AND purpose='notice' AND status IN ('approved','flagged') AND archived_at IS NULL AND category=? AND waba_id IN ('',?) ORDER BY created_at DESC,id LIMIT 1`,
    ),
    // Una plantilla de la cuenta por su identificador de Meta o, si falta, por nombre e idioma.
    byMeta: one(`SELECT ${COLUMNS} FROM wa_templates WHERE meta_id=? AND waba_id IN ('',?) LIMIT 1`),
    byName: one(
      `SELECT ${COLUMNS} FROM wa_templates WHERE name=? AND language=? AND waba_id IN ('',?) AND status!='draft' LIMIT 1`,
    ),
    usedByCampaign: one(
      "SELECT id,title,status FROM campaigns WHERE wa_template_id=? AND status IN ('scheduled','running','paused') LIMIT 1",
    ),
    anyCampaign: one('SELECT 1 FROM campaigns WHERE wa_template_id=? LIMIT 1'),
    count: one(
      "SELECT count(*) n FROM wa_templates WHERE waba_id IN ('',?) AND archived_at IS NULL AND status!='draft'",
    ),
    brandName: one('SELECT name FROM brands WHERE id=?'),
    brandExists: one('SELECT 1 FROM brands WHERE id=?'),
    lastWebhook: one("SELECT MAX(created_at) t FROM connector_events WHERE type='template.update'"),

    // ---- escritura
    insert: run(
      `INSERT INTO wa_templates(id,brand_id,waba_id,name,language,category,purpose,body,variables,components,status,meta_id,reject_reason,quality,copied_from,approved_at,created_by,updated_by,created_at,updated_at,synced_at)
       VALUES(@id,@brandId,@wabaId,@name,@language,@category,@purpose,@body,@variables,@components,@status,@metaId,@rejectReason,@quality,@copiedFrom,@approvedAt,@userId,@userId,@at,@at,@syncedAt)`,
    ),
    // Edición del contenido (borrador o rechazada) o de lo propio del CRM; siempre con la revisión esperada.
    update: run(
      `UPDATE wa_templates SET category=@category,purpose=@purpose,body=@body,variables=@variables,components=@components,
       revision=revision+1,updated_by=@userId,updated_at=@at WHERE id=@id AND revision=@revision`,
    ),
    submitted: run(
      `UPDATE wa_templates SET waba_id=@wabaId,status=@status,status_detail=NULL,status_at=@at,meta_id=@metaId,reject_reason='',
       category=CASE WHEN @category IN ('utility','marketing') THEN @category ELSE category END,header_handle=COALESCE(@handle,header_handle),
       submitted_at=@at,approved_at=CASE WHEN @status='approved' THEN @at ELSE approved_at END,revision=revision+1,updated_by=@userId,synced_at=@at,updated_at=@at WHERE id=@id`,
    ),
    // Lo que dice Meta al sincronizar (estado, motivo, calidad, categoría) y asigna la cuenta si faltaba.
    synced: run(
      `UPDATE wa_templates SET waba_id=@wabaId,status=@status,meta_id=COALESCE(@metaId,meta_id),reject_reason=@reason,
       quality=COALESCE(@quality,quality),quality_at=CASE WHEN @quality IS NOT NULL AND @quality IS NOT quality THEN @at ELSE quality_at END,
       prev_category=CASE WHEN @category IN ('utility','marketing') AND @category!=category THEN category ELSE prev_category END,
       category_changed_at=CASE WHEN @category IN ('utility','marketing') AND @category!=category THEN @at ELSE category_changed_at END,
       category_ack_at=CASE WHEN @category IN ('utility','marketing') AND @category!=category THEN NULL ELSE category_ack_at END,
       category=CASE WHEN @category IN ('utility','marketing') THEN @category ELSE category END,
       status_at=CASE WHEN @status!=status THEN @at ELSE status_at END,
       approved_at=CASE WHEN @status IN ('approved','flagged') AND approved_at IS NULL THEN @at ELSE approved_at END,
       synced_at=@at,updated_at=@at WHERE id=@id`,
    ),
    missing: run(
      "UPDATE wa_templates SET status='missing',status_at=?,synced_at=?,updated_at=? WHERE id=? AND status!='missing'",
    ),
    // Avisos de Meta (template.update)
    setStatus: run(
      `UPDATE wa_templates SET status=@status,status_detail=@detail,status_at=@at,
       reject_reason=CASE WHEN @status='rejected' THEN COALESCE(@reason,'') ELSE reject_reason END,
       approved_at=CASE WHEN @status IN ('approved','flagged') AND approved_at IS NULL THEN @at ELSE approved_at END,
       revision=revision+1,updated_at=@at WHERE id=@id`,
    ),
    setQuality: run('UPDATE wa_templates SET quality=?,quality_at=?,revision=revision+1,updated_at=? WHERE id=?'),
    setCategory: run(
      `UPDATE wa_templates SET prev_category=category,category=?,category_changed_at=?,category_ack_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND category!=?`,
    ),
    ack: run('UPDATE wa_templates SET category_ack_at=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?'),
    archive: run(
      'UPDATE wa_templates SET archived_at=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=? AND archived_at IS NULL',
    ),
    restore: run('UPDATE wa_templates SET archived_at=NULL,revision=revision+1,updated_by=?,updated_at=? WHERE id=?'),
    remove: run('DELETE FROM wa_templates WHERE id=?'),

    // ---- cuenta y caché de las plantillas remotas (las que existen en Meta y el CRM no usa)
    ensureAccount: run('INSERT OR IGNORE INTO wa_account(waba_id,created_at,updated_at) VALUES(?,?,?)'),
    account: one('SELECT waba_id,template_limit,remote_cache,remote_at FROM wa_account WHERE waba_id=?'),
    saveRemote: run('UPDATE wa_account SET remote_cache=?,remote_at=?,updated_at=? WHERE waba_id=?'),

    // ---- archivos de muestra del encabezado (biblioteca de la marca)
    file: one('SELECT id,brand_id,filename,mime,size,storage_name FROM library_files WHERE id=? AND brand_id=?'),
    fileAny: one('SELECT id,brand_id,filename,mime,size,storage_name FROM library_files WHERE id=?'),
    insertFile: run(
      'INSERT INTO library_files(id,brand_id,filename,mime,size,storage_name,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ),

    // ---- conversación (para llenar los datos del chat)
    person: one('SELECT name FROM users WHERE id=?'),
    course: one('SELECT title FROM courses WHERE id=?'),
    edition: one('SELECT name FROM editions WHERE id=?'),
    conversation: one('SELECT * FROM conversations WHERE id=?'),
    lastCustomerAt: one("SELECT MAX(created_at) t FROM messages WHERE conversation_id=? AND sender_kind='customer'"),
    messageByRef: one('SELECT id,conversation_id,delivery_state FROM messages WHERE client_ref=?'),
    retryNotice: run(
      "UPDATE messages SET delivery_state='sent',failed_reason=NULL,provider_ref=NULL WHERE id=? AND delivery_state='failed'",
    ),
  };
}
