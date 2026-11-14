// SQL de la importación de contactos. Todas las funciones reciben la marca primero y la usan en cada consulta.
const ACTIVE = "('validating','applying')";
const PURGEABLE =
  "((state IN ('done','failed','cancelled') AND finished_at<?) OR (state IN ('uploaded','validated') AND updated_at<?))";

export function createRepo(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const parse = row =>
    row && {
      ...row,
      header: JSON.parse(row.header),
      mapping: JSON.parse(row.mapping),
      options: JSON.parse(row.options),
      report: JSON.parse(row.report),
    };

  return {
    brandOf: id => one('SELECT brand_id FROM contact_imports WHERE id=?', id)?.brand_id ?? null,
    get: (brandId, id) => parse(one('SELECT * FROM contact_imports WHERE brand_id=? AND id=?', brandId, id)),
    byClientRef: (brandId, clientRef) =>
      parse(one('SELECT * FROM contact_imports WHERE brand_id=? AND client_ref=?', brandId, clientRef)),
    list: (brandId, limit = 20) =>
      all('SELECT * FROM contact_imports WHERE brand_id=? ORDER BY created_at DESC, id LIMIT ?', brandId, limit).map(
        parse,
      ),
    // La importación anterior que ya aplicó este mismo archivo en la marca.
    previous: (brandId, sha256, exceptId) =>
      one(
        "SELECT id,filename,finished_at FROM contact_imports WHERE brand_id=? AND sha256=? AND id!=? AND state='done' ORDER BY finished_at DESC LIMIT 1",
        brandId,
        sha256,
        exceptId,
      ) ?? null,
    busy: (brandId, exceptId) =>
      one(
        `SELECT id FROM contact_imports WHERE brand_id=? AND state IN ${ACTIVE} AND id!=? LIMIT 1`,
        brandId,
        exceptId,
      ) ?? null,
    insert(brandId, i) {
      run(
        'INSERT INTO contact_imports(id,brand_id,filename,sha256,storage_name,size,encoding,delimiter,rows,header,data_offset,data_line,mapping,options,client_ref,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        i.id,
        brandId,
        i.filename,
        i.sha256,
        i.storageName,
        i.size,
        i.encoding,
        i.delimiter,
        i.rows,
        JSON.stringify(i.header),
        i.dataOffset,
        i.dataLine,
        JSON.stringify(i.mapping),
        JSON.stringify(i.options),
        i.clientRef,
        i.createdBy,
        i.at,
        i.at,
      );
    },
    // Nuevo mapeo u opciones: sube la revisión y deja la vista previa sin validez.
    setMapping: (brandId, id, mapping, options, at) =>
      run(
        "UPDATE contact_imports SET mapping=?,options=?,state='uploaded',report='{}',validated_revision=NULL,revision=revision+1,updated_at=? WHERE brand_id=? AND id=?",
        JSON.stringify(mapping),
        JSON.stringify(options),
        at,
        brandId,
        id,
      ),
    setOptions: (brandId, id, options, at) =>
      run(
        'UPDATE contact_imports SET options=?,updated_at=? WHERE brand_id=? AND id=?',
        JSON.stringify(options),
        at,
        brandId,
        id,
      ),
    setState: (brandId, id, state, fields, at) =>
      run(
        'UPDATE contact_imports SET state=?,job_id=coalesce(?,job_id),report=coalesce(?,report),validated_revision=coalesce(?,validated_revision),finished_at=coalesce(?,finished_at),updated_at=? WHERE brand_id=? AND id=?',
        state,
        fields.jobId ?? null,
        fields.report === undefined ? null : JSON.stringify(fields.report),
        fields.validatedRevision ?? null,
        fields.finishedAt ?? null,
        at,
        brandId,
        id,
      ),
    clearRows: (brandId, id, phase) =>
      run(
        'DELETE FROM contact_import_rows WHERE import_id=(SELECT id FROM contact_imports WHERE brand_id=? AND id=?) AND phase=?',
        brandId,
        id,
        phase,
      ),
    // Resultado de una fila. Si ya estaba anotada (un trozo repetido tras un fallo), se reemplaza.
    putRow(brandId, id, phase, r) {
      run(
        'INSERT OR REPLACE INTO contact_import_rows(import_id,phase,row,line,action,contact_id,problem,message,detail) SELECT id,?,?,?,?,?,?,?,? FROM contact_imports WHERE brand_id=? AND id=?',
        phase,
        r.row,
        r.line,
        r.action,
        r.contactId ?? null,
        r.problem ?? null,
        r.message ?? null,
        r.detail ? JSON.stringify(r.detail) : null,
        brandId,
        id,
      );
    },
    // Totales de una fase: por acción, por problema y por lo que se hizo con el consentimiento.
    totals(brandId, id, phase) {
      const rows = all(
        "SELECT r.action,r.problem,json_extract(r.detail,'$.consent') consent,count(*) n FROM contact_import_rows r JOIN contact_imports i ON i.id=r.import_id WHERE i.brand_id=? AND i.id=? AND r.phase=? GROUP BY 1,2,3",
        brandId,
        id,
        phase,
      );
      return rows;
    },
    rows: (brandId, id, phase, { actions, after = 0, limit = 50 }) =>
      all(
        `SELECT r.row,r.line,r.action,r.contact_id,r.problem,r.message,r.detail FROM contact_import_rows r JOIN contact_imports i ON i.id=r.import_id WHERE i.brand_id=? AND i.id=? AND r.phase=?${
          actions ? ` AND r.action IN (${actions.map(() => '?').join(',')})` : ''
        } AND r.row>? ORDER BY r.row LIMIT ?`,
        brandId,
        id,
        phase,
        ...(actions ?? []),
        after,
        limit,
      ),
    // Importaciones cuyo archivo ya debe borrarse (7 días después de terminar, o de quedarse a medias).
    purgeable: (brandId, before, limit) =>
      all(
        `SELECT id,brand_id,storage_name,state FROM contact_imports WHERE brand_id=? AND purged_at IS NULL AND ${PURGEABLE} LIMIT ?`,
        brandId,
        before,
        before,
        limit,
      ),
    brandsWithPurgeable: before =>
      all(`SELECT DISTINCT brand_id FROM contact_imports WHERE purged_at IS NULL AND ${PURGEABLE}`, before, before).map(
        row => row.brand_id,
      ),
    markPurged(brandId, id, at) {
      run(
        "UPDATE contact_imports SET purged_at=?,state=CASE WHEN state IN ('uploaded','validated') THEN 'cancelled' ELSE state END,finished_at=coalesce(finished_at,?),updated_at=? WHERE brand_id=? AND id=?",
        at,
        at,
        at,
        brandId,
        id,
      );
      // El detalle guarda el valor de la celda con problema (un teléfono, un correo): se va con el archivo. El
      // consentimiento de cada fila se conserva para que el informe siga cuadrando.
      run(
        "UPDATE contact_import_rows SET detail=CASE WHEN json_extract(detail,'$.consent') IS NULL THEN NULL ELSE json_object('consent',json_extract(detail,'$.consent')) END WHERE import_id=(SELECT id FROM contact_imports WHERE brand_id=? AND id=?) AND detail IS NOT NULL",
        brandId,
        id,
      );
    },
    // Fusión de contactos: el resultado de una fila pasa al contacto que queda.
    moveContact: (keepId, mergedId) =>
      Number(run('UPDATE contact_import_rows SET contact_id=? WHERE contact_id=?', keepId, mergedId).changes),
  };
}
