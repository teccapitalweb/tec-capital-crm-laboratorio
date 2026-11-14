// Todo el SQL del módulo de atributos de contacto. Cada función recibe la marca como primer parámetro y la usa en su
// consulta: una marca nunca lee ni escribe lo de otra. Las dos que localizan un registro por su id (`brandOfDefinition`,
// `brandOfContact`) sólo devuelven su marca, para que el módulo compruebe el permiso antes de leer nada más.
const DEFINITION =
  'id,brand_id,key,label,type,options,description,personal,searchable,show_in_chat,position,origin,status,revision,created_by,created_at,updated_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;

// Expresiones SQL para server/lib/conditions.mjs. `alias` es el de la tabla `contacts` en la consulta de quien
// compila. Lo único que se escribe dentro del texto es el id del atributo (un UUID que genera el servidor, comprobado
// aquí) y el alias (comprobado); los valores de una condición viajan siempre como parámetros.
export function conditionSql(alias = 'c') {
  if (!ALIAS.test(alias)) throw new TypeError('conditionSql: alias de tabla no válido.');
  const value = (attributeId, column) => {
    if (!UUID.test(attributeId)) throw new TypeError('conditionSql: id de atributo no válido.');
    return `(SELECT v.${column === 'num' ? 'value_num' : 'value'} FROM contact_attribute_values v WHERE v.contact_id = ${alias}.id AND v.attribute_id = '${attributeId}')`;
  };
  return {
    value,
    system: {
      nombre: `${alias}.name`,
      correo: `${alias}.email`,
      origen: `${alias}.source`,
      creado: `${alias}.created_at`,
      consentimiento: `COALESCE((SELECT cc.status FROM contact_consent cc WHERE cc.contact_id = ${alias}.id), 'unknown')`,
      etiquetas: { from: 'contact_tag_links l', where: `l.contact_id = ${alias}.id`, value: 'l.tag_id' },
    },
  };
}

export function createRepo(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  return {
    brandOfDefinition: id =>
      typeof id === 'string' ? (one('SELECT brand_id FROM contact_attributes WHERE id=?', id)?.brand_id ?? null) : null,
    brandOfContact: id =>
      typeof id === 'string' ? (one('SELECT brand_id FROM contacts WHERE id=?', id)?.brand_id ?? null) : null,
    brandName: brandId => one('SELECT name FROM brands WHERE id=?', brandId)?.name ?? brandId,

    // ---- definiciones
    definitions: (brandId, { archived = false } = {}) =>
      all(
        `SELECT ${DEFINITION} FROM contact_attributes WHERE brand_id=? ${archived ? '' : "AND status='active'"} ORDER BY position,created_at,key`,
        brandId,
      ),
    definition: (brandId, id) =>
      one(`SELECT ${DEFINITION} FROM contact_attributes WHERE brand_id=? AND id=?`, brandId, id),
    definitionByKey: (brandId, key) =>
      one(`SELECT ${DEFINITION} FROM contact_attributes WHERE brand_id=? AND key=?`, brandId, key),
    definitionByClientRef: (brandId, clientRef) =>
      one(`SELECT ${DEFINITION} FROM contact_attributes WHERE brand_id=? AND client_ref=?`, brandId, clientRef),
    clientRefTaken: (brandId, clientRef) =>
      Boolean(one('SELECT 1 FROM contact_attributes WHERE client_ref=? AND brand_id<>?', clientRef, brandId)),
    countActive: brandId =>
      one("SELECT count(*) n FROM contact_attributes WHERE brand_id=? AND status='active'", brandId).n,
    nextPosition: brandId =>
      one('SELECT COALESCE(max(position),-1)+1 p FROM contact_attributes WHERE brand_id=?', brandId).p,
    insertDefinition(brandId, d) {
      run(
        'INSERT INTO contact_attributes(id,brand_id,key,label,type,options,description,personal,searchable,show_in_chat,position,origin,client_ref,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        d.id,
        brandId,
        d.key,
        d.label,
        d.type,
        JSON.stringify(d.options),
        d.description,
        d.personal ? 1 : 0,
        d.searchable ? 1 : 0,
        d.showInChat ? 1 : 0,
        d.position,
        d.origin,
        d.clientRef,
        d.createdBy,
        d.at,
        d.at,
      );
    },
    // Cambia sólo si la revisión es la esperada. Devuelve cuántas filas cambió (0: alguien la cambió antes).
    updateDefinition(brandId, id, expectedRevision, d) {
      return Number(
        run(
          'UPDATE contact_attributes SET label=?,options=?,description=?,personal=?,searchable=?,show_in_chat=?,position=?,status=?,revision=revision+1,updated_at=? WHERE brand_id=? AND id=? AND revision=?',
          d.label,
          JSON.stringify(d.options),
          d.description,
          d.personal ? 1 : 0,
          d.searchable ? 1 : 0,
          d.showInChat ? 1 : 0,
          d.position,
          d.status,
          d.at,
          brandId,
          id,
          expectedRevision,
        ).changes,
      );
    },
    // Contactos con valor en cada atributo de la marca: {attributeId: n}.
    usage: brandId =>
      Object.fromEntries(
        all(
          'SELECT attribute_id id,count(*) n FROM contact_attribute_values WHERE brand_id=? GROUP BY attribute_id',
          brandId,
        ).map(row => [row.id, row.n]),
      ),
    // Contactos que tienen cada opción de una lista: {valor: n}.
    optionUsage: (brandId, attributeId) =>
      Object.fromEntries(
        all(
          'SELECT value,count(*) n FROM contact_attribute_values WHERE brand_id=? AND attribute_id=? GROUP BY value',
          brandId,
          attributeId,
        ).map(row => [row.value, row.n]),
      ),

    // ---- valores
    values: (brandId, contactId) =>
      all(
        'SELECT v.attribute_id,v.value,v.value_num,v.source,v.updated_by,v.updated_at FROM contact_attribute_values v WHERE v.brand_id=? AND v.contact_id=?',
        brandId,
        contactId,
      ),
    // Valores de muchos contactos a la vez (por lotes): [{contact_id, attribute_id, value, value_num}].
    valuesFor(brandId, contactIds) {
      const out = [];
      for (let i = 0; i < contactIds.length; i += 500) {
        const slice = contactIds.slice(i, i + 500);
        out.push(
          ...all(
            `SELECT contact_id,attribute_id,value,value_num FROM contact_attribute_values WHERE brand_id=? AND contact_id IN (${slice.map(() => '?').join(',')})`,
            brandId,
            ...slice,
          ),
        );
      }
      return out;
    },
    setValue(brandId, v) {
      run(
        'INSERT INTO contact_attribute_values(contact_id,attribute_id,brand_id,value,value_num,source,source_id,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(contact_id,attribute_id) DO UPDATE SET value=excluded.value,value_num=excluded.value_num,source=excluded.source,source_id=excluded.source_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
        v.contactId,
        v.attributeId,
        brandId,
        v.value,
        v.valueNum,
        v.source,
        v.sourceId,
        v.actorId,
        v.at,
      );
    },
    deleteValue: (brandId, contactId, attributeId) =>
      run(
        'DELETE FROM contact_attribute_values WHERE brand_id=? AND contact_id=? AND attribute_id=?',
        brandId,
        contactId,
        attributeId,
      ),
    touchContact: (brandId, contactId, at) =>
      run('UPDATE contacts SET updated_at=? WHERE brand_id=? AND id=?', at, brandId, contactId),
    insertEvent(brandId, e) {
      return Number(
        run(
          'INSERT INTO contact_attribute_events(brand_id,contact_id,attribute_id,key,old_value,new_value,source,source_id,actor_id,conversation_id,depth,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          brandId,
          e.contactId,
          e.attributeId,
          e.key,
          e.from,
          e.to,
          e.source,
          e.sourceId,
          e.actorId,
          e.conversationId,
          e.depth,
          e.at,
        ).lastInsertRowid,
      );
    },
    history: (brandId, contactId, limit = 20) =>
      all(
        'SELECT e.seq,e.key,e.old_value,e.new_value,e.source,e.actor_id,u.name actor_name,e.created_at FROM contact_attribute_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.brand_id=? AND e.contact_id=? ORDER BY e.seq DESC LIMIT ?',
        brandId,
        contactId,
        limit,
      ),
    request: (brandId, clientRef) =>
      one('SELECT brand_id,contact_id,actor_id,response FROM contact_attribute_requests WHERE client_ref=?', clientRef),
    saveRequest: (brandId, r) =>
      run(
        'INSERT INTO contact_attribute_requests(client_ref,brand_id,contact_id,actor_id,response,created_at) VALUES(?,?,?,?,?,?)',
        r.clientRef,
        brandId,
        r.contactId,
        r.actorId,
        JSON.stringify(r.response),
        r.at,
      ),

    // ---- datos de sistema: se leen de su tabla dueña, no se guardan aquí
    contact: (brandId, contactId) =>
      one(
        'SELECT id,brand_id,name,phone,email,source,created_at FROM contacts WHERE brand_id=? AND id=?',
        brandId,
        contactId,
      ),
    consent: (brandId, contactId) =>
      one('SELECT status FROM contact_consent WHERE brand_id=? AND contact_id=?', brandId, contactId)?.status ??
      'unknown',
    tags: (brandId, contactId) =>
      all(
        'SELECT t.id,t.name FROM contact_tag_links l JOIN contact_tags t ON t.id=l.tag_id WHERE t.brand_id=? AND l.contact_id=? ORDER BY t.name',
        brandId,
        contactId,
      ),
    latestOpportunity: (brandId, contactId) =>
      one(
        'SELECT o.stage,o.course_id,c.title course_title FROM opportunities o LEFT JOIN courses c ON c.id=o.course_id WHERE o.brand_id=? AND o.contact_id=? ORDER BY o.updated_at DESC,o.created_at DESC LIMIT 1',
        brandId,
        contactId,
      ),

    // ---- fusión de contactos (la llama personData dentro de la transacción de quien fusiona)
    // Gana el valor del contacto que queda; lo que él no tiene (vacío) se llena con el del absorbido. El historial y
    // las respuestas guardadas pasan al que queda.
    merge(brandId, keepId, mergedId) {
      const filled = Number(
        run(
          'INSERT INTO contact_attribute_values(contact_id,attribute_id,brand_id,value,value_num,source,source_id,updated_by,updated_at) SELECT ?,attribute_id,brand_id,value,value_num,source,source_id,updated_by,updated_at FROM contact_attribute_values WHERE brand_id=? AND contact_id=? AND attribute_id NOT IN (SELECT attribute_id FROM contact_attribute_values WHERE contact_id=?)',
          keepId,
          brandId,
          mergedId,
          keepId,
        ).changes,
      );
      const dropped = Number(run('DELETE FROM contact_attribute_values WHERE contact_id=?', mergedId).changes);
      const history = Number(
        run('UPDATE contact_attribute_events SET contact_id=? WHERE contact_id=?', keepId, mergedId).changes,
      );
      const requests = Number(
        run('UPDATE contact_attribute_requests SET contact_id=? WHERE contact_id=?', keepId, mergedId).changes,
      );
      return {
        contact_attribute_values: filled,
        contact_attribute_values_kept: dropped - filled,
        contact_attribute_events: history,
        contact_attribute_requests: requests,
      };
    },
  };
}
