// Todo el SQL del módulo `audiences` (docs/PLAN_AUDIENCIAS.md). Cada función recibe primero la marca: el alcance lo
// decide module.mjs con host.access y aquí sólo se aplica. Lo que escribe una persona viaja siempre como parámetro;
// en el texto de las consultas sólo hay expresiones escritas aquí o en la declaración de campos de condiciones.
//
// Cómo se arma el público:
//   selección   SELECT de los ids de contacto de una lista (audience_members) o de un segmento (contacts con la
//               condición compilada por server/lib/conditions.mjs). Siempre acotada a la marca.
//   clasificar  a cada contacto seleccionado se le da su motivo de exclusión (o ninguno): sin teléfono, en lista de
//               exclusión, baja, sin consentimiento para promociones, repetido (mismo teléfono que otro anterior) o
//               excluido por quien arma la difusión. Una sola consulta con CTE y una función de ventana.
import { defineFields, registerSqlFunctions } from '../../lib/conditions.mjs';
import { CONTACT_FIELD_DECLARATIONS } from '../directory/repo.mjs';

export const KINDS = Object.freeze(['list', 'segment']);
export const ROLES = Object.freeze(['audience', 'suppression']);
export const CHANNELS = Object.freeze([
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
]);

// Motivos de exclusión, en el orden en que se aplican: cada contacto queda con el primero que cumple.
export const REASONS = Object.freeze({
  excluded: 'Excluido de esta difusión',
  no_phone: 'Sin teléfono',
  suppressed: 'En una lista de exclusión de la marca',
  opted_out: 'Pidió no recibir mensajes (baja)',
  no_consent: 'Sin consentimiento para promociones',
  duplicate: 'Repetido: otro contacto con el mismo teléfono ya está',
});

// Lo que toda consulta de contactos de un segmento lee: los alias son los de la lista de contactos (directory), así
// que sus campos se reutilizan tal cual: `c` contacts, `s` contact_search y `k` contact_consent.
const CONTACT_FROM = `FROM contacts c
  LEFT JOIN contact_search s ON s.contact_id = c.id
  LEFT JOIN contact_consent k ON k.contact_id = c.id`;

const LAST_INBOUND = `(SELECT MAX(m.created_at) FROM opportunities lo
  JOIN conversation_opportunities lk ON lk.opportunity_id = lo.id
  JOIN messages m ON m.conversation_id = lk.conversation_id
  WHERE lo.contact_id = c.id AND m.sender_kind = 'customer')`;

// Campos de condición de una audiencia (ámbito contacto): los de la lista de contactos (sin «marca»: un segmento ya
// es de una marca) más los propios. `options` son los de la marca: una etiqueta, un curso o una lista de otra marca
// no pasa la validación. `extra` son los de otros módulos (la familia `attr` de los atributos).
export function audienceFieldDeclarations({ tags = [], courses = [], lists = [] } = {}) {
  const own = {
    tag: { options: tags },
    course: { options: courses },
  };
  const contact = CONTACT_FIELD_DECLARATIONS.filter(d => d.key !== 'brand').map(d =>
    own[d.key] ? { ...d, ...own[d.key] } : d,
  );
  return [
    ...contact,
    {
      key: 'phone',
      type: 'text',
      label: 'Teléfono (dígitos)',
      sql: 'c.phone_key',
      ops: ['starts_with', 'contains'],
    },
    {
      key: 'list',
      type: 'list',
      label: 'Está en la lista',
      options: lists,
      sql: { from: 'audience_members am', where: 'am.contact_id = c.id', value: 'am.audience_id' },
      ops: ['any', 'none'],
    },
    {
      key: 'last_inbound',
      type: 'date',
      label: 'Último mensaje del contacto',
      sql: LAST_INBOUND,
      ops: ['in_last_days', 'not_in_last_days', 'before', 'after', 'empty', 'not_empty'],
    },
    {
      key: 'channel',
      type: 'list',
      label: 'Escribió por',
      options: CHANNELS.map(item => item.value),
      sql: {
        from: 'opportunities cho JOIN conversation_opportunities chk ON chk.opportunity_id = cho.id JOIN conversations chv ON chv.id = chk.conversation_id',
        where: 'cho.contact_id = c.id',
        value: 'chv.channel',
      },
      ops: ['any', 'none'],
    },
    {
      key: 'enrolled',
      type: 'boolean',
      label: 'Es alumno inscrito',
      sql: "EXISTS (SELECT 1 FROM enrollments en WHERE en.contact_id = c.id AND en.status = 'enrolled')",
      ops: ['is'],
    },
    {
      key: 'enrolled_course',
      type: 'list',
      label: 'Inscrito en el curso',
      options: courses,
      sql: { from: 'enrollments ec', where: "ec.contact_id = c.id AND ec.status = 'enrolled'", value: 'ec.course_id' },
      ops: ['any', 'none'],
    },
    {
      key: 'pending_order',
      type: 'boolean',
      label: 'Tiene un pago pendiente',
      sql: "EXISTS (SELECT 1 FROM orders po WHERE po.contact_id = c.id AND po.status IN ('pending', 'review'))",
      ops: ['is'],
    },
  ];
}

export const buildFields = (options, extra = []) => defineFields([...audienceFieldDeclarations(options), ...extra]);

const marks = count => Array.from({ length: count }, () => '?').join(',');
const json = value => JSON.stringify(value);

export function createRepo(db) {
  registerSqlFunctions(db);
  const cache = new Map();
  const prepare = sql => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      cache.set(sql, statement);
    }
    return statement;
  };
  const one = (sql, ...args) => prepare(sql).get(...args);
  const all = (sql, ...args) => prepare(sql).all(...args);
  const run = (sql, ...args) => prepare(sql).run(...args);

  // ---- selección de contactos

  // SELECT de los ids de contacto de una audiencia: `{sql, args}`. `compiled` es la condición de un segmento ya
  // compilada ({sql, params}); una lista lee sus miembros.
  function selectFor(brandId, audience, compiled) {
    if (audience.kind === 'list')
      return {
        sql: 'SELECT am.contact_id FROM audience_members am JOIN contacts c ON c.id = am.contact_id WHERE am.audience_id = ? AND c.brand_id = ?',
        args: [audience.id, brandId],
      };
    return {
      sql: `SELECT c.id ${CONTACT_FROM} WHERE c.brand_id = ? AND ${compiled.sql}`,
      args: [brandId, ...compiled.params],
    };
  }
  // SELECT de un filtro en línea (sin guardar).
  const selectDefinition = (brandId, compiled) => selectFor(brandId, { kind: 'segment' }, compiled);
  const selectAll = brandId => ({ sql: 'SELECT c.id FROM contacts c WHERE c.brand_id = ?', args: [brandId] });
  // Miembros de las listas de exclusión vigentes de la marca.
  const selectSuppressed = brandId => ({
    sql: "SELECT sm.contact_id FROM audience_members sm JOIN audiences sa ON sa.id = sm.audience_id WHERE sa.brand_id = ? AND sa.role = 'suppression' AND sa.archived_at IS NULL",
    args: [brandId],
  });

  // Unión de selecciones (`include`) menos otra unión (`exclude`), en un solo SELECT.
  function union(parts) {
    if (!parts.length) return null;
    return { sql: parts.map(part => part.sql).join(' UNION '), args: parts.flatMap(part => part.args) };
  }

  const count = (brandId, select) =>
    one(`SELECT count(*) n FROM contacts c WHERE c.brand_id = ? AND c.id IN (${select.sql})`, brandId, ...select.args)
      .n;

  // Clasificación de cada contacto de `include` (una selección) con su motivo de exclusión. `exclude` (opcional) son
  // los que quien arma la difusión quitó. Devuelve el texto de la CTE y sus parámetros; quien lo usa añade su SELECT.
  function classified(brandId, include, { exclude = null, requireConsent = true } = {}) {
    const suppressed = selectSuppressed(brandId);
    const sql = `WITH m AS (
        SELECT c.id, c.phone_key, COALESCE(k.status, 'unknown') consent,
          ${exclude ? `c.id IN (${exclude.sql})` : '0'} excluded,
          c.id IN (${suppressed.sql}) suppressed
        FROM contacts c LEFT JOIN contact_consent k ON k.contact_id = c.id
        WHERE c.brand_id = ? AND c.id IN (${include.sql})
      ), r AS (
        SELECT id, phone_key, consent,
          CASE WHEN excluded THEN 'excluded'
               WHEN phone_key = '' THEN 'no_phone'
               WHEN suppressed THEN 'suppressed'
               WHEN consent = 'opted_out' THEN 'opted_out'
               WHEN ? AND consent <> 'opted_in' THEN 'no_consent' END reason0
        FROM m
      ), x AS (
        SELECT id, consent, COALESCE(reason0,
          CASE WHEN ROW_NUMBER() OVER (PARTITION BY reason0 IS NULL, phone_key ORDER BY id) > 1 THEN 'duplicate' END) reason
        FROM r
      )`;
    return {
      sql,
      args: [...(exclude ? exclude.args : []), ...suppressed.args, brandId, ...include.args, requireConsent ? 1 : 0],
    };
  }

  // Conteo por motivo: {total, eligible, excluded: {motivo: n}}.
  function summary(brandId, include, options) {
    const cte = classified(brandId, include, options);
    const rows = db.prepare(`${cte.sql} SELECT reason, count(*) n FROM x GROUP BY reason`).all(...cte.args);
    const out = { total: 0, eligible: 0, excluded: {} };
    for (const row of rows) {
      out.total += row.n;
      if (row.reason === null) out.eligible += row.n;
      else out.excluded[row.reason] = row.n;
    }
    return out;
  }

  // Una página de contactos clasificados. `status`: all | eligible | excluded; `reason`: un motivo. Orden estable y
  // sin repetidos: por (clave del nombre, id) o por id, desde el cursor `after` (el último de la página anterior).
  // Aquí el motivo se calcula sólo para las filas que se recorren (el de «repetido», con el índice de teléfono): así
  // una página no clasifica a toda la audiencia. Da lo mismo que `summary`: repetido = hay otro miembro con el mismo
  // teléfono, id menor y sin ningún otro motivo.
  function page(
    brandId,
    include,
    { exclude = null, requireConsent = true, status = 'all', reason = null, order = 'name', after = null, limit = 50 },
  ) {
    const suppressed = selectSuppressed(brandId);
    const args = [];
    const add = (sql, values) => {
      args.push(...values);
      return sql;
    };
    const consent = alias => `COALESCE(${alias}.status, 'unknown')`;
    const required = requireConsent ? 1 : 0;
    // Lo que deja a un contacto sin motivo propio (antes de mirar si se repite).
    const clean = (c, k) =>
      [
        exclude ? add(`${c}.id NOT IN (${exclude.sql})`, exclude.args) : '1',
        `${c}.phone_key <> ''`,
        add(`${c}.id NOT IN (${suppressed.sql})`, suppressed.args),
        `${consent(k)} <> 'opted_out'`,
        add(`(? = 0 OR ${consent(k)} = 'opted_in')`, [required]),
      ].join(' AND ');
    const reasonSql = [
      'CASE',
      exclude ? add(`WHEN c.id IN (${exclude.sql}) THEN 'excluded'`, exclude.args) : '',
      "WHEN c.phone_key = '' THEN 'no_phone'",
      add(`WHEN c.id IN (${suppressed.sql}) THEN 'suppressed'`, suppressed.args),
      `WHEN ${consent('k')} = 'opted_out' THEN 'opted_out'`,
      add(`WHEN ? AND ${consent('k')} <> 'opted_in' THEN 'no_consent'`, [required]),
      'WHEN EXISTS (SELECT 1 FROM contacts d LEFT JOIN contact_consent dk ON dk.contact_id = d.id',
      add('WHERE d.brand_id = ? AND d.phone_key = c.phone_key AND d.id < c.id', [brandId]),
      add(`AND d.id IN (${include.sql})`, include.args),
      `AND ${clean('d', 'dk')}) THEN 'duplicate'`,
      'END',
    ].join(' ');
    const byName = order === 'name';
    const from = byName
      ? 'FROM contact_search s JOIN contacts c ON c.id = s.contact_id'
      : 'FROM contacts c LEFT JOIN contact_search s ON s.contact_id = c.id';
    const where = [
      add(byName ? 's.brand_id = ? AND c.brand_id = ?' : 'c.brand_id = ?', byName ? [brandId, brandId] : [brandId]),
      add(`c.id IN (${include.sql})`, include.args),
    ];
    if (after)
      where.push(byName ? add('(s.name_key, s.contact_id) > (?, ?)', [after.n, after.i]) : add('c.id > ?', [after.i]));
    const outer = [];
    if (status === 'eligible') outer.push('reason IS NULL');
    if (status === 'excluded') outer.push('reason IS NOT NULL');
    if (reason) outer.push(add('reason = ?', [reason]));
    const rows = db
      .prepare(
        `SELECT * FROM (
          SELECT c.id, c.name, c.phone, c.phone_key, c.email, c.persona_id, ${consent('k')} consent,
            COALESCE(s.name_key, '') name_key, ${reasonSql} reason
          ${from} LEFT JOIN contact_consent k ON k.contact_id = c.id
          WHERE ${where.join(' AND ')}
          ORDER BY ${byName ? 's.name_key, s.contact_id' : 'c.id'}
        ) ${outer.length ? 'WHERE ' + outer.join(' AND ') : ''} LIMIT ?`,
      )
      .all(...args, limit + 1);
    const more = rows.length > limit;
    if (more) rows.pop();
    const last = rows.at(-1);
    return { rows, next: more && last ? { n: last.name_key, i: last.id } : null };
  }

  // ---- audiencias

  const ORDER = "ORDER BY a.preset IS NULL, a.role = 'suppression', a.kind, a.name_key, a.id";

  return {
    selectFor,
    selectDefinition,
    selectAll,
    selectSuppressed,
    union,
    count,
    summary,
    page,

    brandName: brandId => one('SELECT name FROM brands WHERE id = ?', brandId)?.name ?? brandId,
    brandOf: id =>
      typeof id === 'string' ? (one('SELECT brand_id FROM audiences WHERE id = ?', id)?.brand_id ?? null) : null,
    tags: brandId => all('SELECT id, name FROM contact_tags WHERE brand_id = ? ORDER BY name_key, id', brandId),
    courses: brandId => all('SELECT id, title FROM courses WHERE brand_id = ? ORDER BY title, id', brandId),

    list(brandId, { archived = false } = {}) {
      return all(
        `SELECT a.* FROM audiences a WHERE a.brand_id = ? AND (? OR a.archived_at IS NULL) ${ORDER}`,
        brandId,
        archived ? 1 : 0,
      );
    },
    lists: brandId =>
      all(
        "SELECT id, name, role, archived_at FROM audiences WHERE brand_id = ? AND kind = 'list' ORDER BY name_key, id",
        brandId,
      ),
    get: (brandId, id) => one('SELECT * FROM audiences WHERE brand_id = ? AND id = ?', brandId, id) ?? null,
    byClientRef: (brandId, ref) =>
      one('SELECT * FROM audiences WHERE brand_id = ? AND client_ref = ?', brandId, ref) ?? null,
    byPreset: (brandId, preset) =>
      one('SELECT * FROM audiences WHERE brand_id = ? AND preset = ?', brandId, preset) ?? null,
    nameTaken: (brandId, nameKey, exceptId = '') =>
      Boolean(
        one(
          'SELECT 1 FROM audiences WHERE brand_id = ? AND name_key = ? AND archived_at IS NULL AND id <> ?',
          brandId,
          nameKey,
          exceptId,
        ),
      ),
    active: (brandId, kind) =>
      one(
        'SELECT count(*) n FROM audiences WHERE brand_id = ? AND kind = ? AND archived_at IS NULL AND preset IS NULL',
        brandId,
        kind,
      ).n,

    insert(brandId, a) {
      run(
        `INSERT INTO audiences(id, brand_id, kind, role, name, name_key, description, definition, preset, source, source_ref,
          member_count, counted_at, status, client_ref, created_by, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ready', ?, ?, ?, ?)`,
        a.id,
        brandId,
        a.kind,
        a.role,
        a.name,
        a.nameKey,
        a.description ?? '',
        json(a.definition ?? {}),
        a.preset ?? null,
        a.source ?? 'manual',
        a.sourceRef ?? null,
        a.countedAt ?? null,
        a.clientRef ?? null,
        a.createdBy ?? null,
        a.at,
        a.at,
      );
    },
    // Cambia nombre, descripción, definición o papel si la revisión coincide. Devuelve si se aplicó.
    update(brandId, id, fields, expectedRevision, at) {
      return (
        run(
          `UPDATE audiences SET name = ?, name_key = ?, description = ?, definition = ?, role = ?, revision = revision + 1,
            updated_at = ? WHERE brand_id = ? AND id = ? AND revision = ?`,
          fields.name,
          fields.nameKey,
          fields.description,
          json(fields.definition),
          fields.role,
          at,
          brandId,
          id,
          expectedRevision,
        ).changes === 1
      );
    },
    setArchived(brandId, id, archived, expectedRevision, at) {
      return (
        run(
          `UPDATE audiences SET archived_at = ?, status = ?, revision = revision + 1, updated_at = ?
            WHERE brand_id = ? AND id = ? AND revision = ?`,
          archived ? at : null,
          archived ? 'archived' : 'ready',
          at,
          brandId,
          id,
          expectedRevision,
        ).changes === 1
      );
    },
    setCount: (brandId, id, n, at) =>
      run('UPDATE audiences SET member_count = ?, counted_at = ? WHERE brand_id = ? AND id = ?', n, at, brandId, id),
    // El conteo exacto de una lista, desde sus filas.
    recountList(brandId, id, at) {
      const n = one(
        'SELECT count(*) n FROM audience_members am JOIN contacts c ON c.id = am.contact_id WHERE am.audience_id = ? AND c.brand_id = ?',
        id,
        brandId,
      ).n;
      run('UPDATE audiences SET member_count = ?, counted_at = ? WHERE brand_id = ? AND id = ?', n, at, brandId, id);
      return n;
    },

    // ---- miembros de una lista (componibles: sin transacción propia)

    // Añade los contactos de la marca que no estaban; los de otra marca o inexistentes se ignoran. Devuelve cuántos
    // entraron. `room` corta lo que pase del tope de la lista.
    addMembers(
      brandId,
      audienceId,
      contactIds,
      { source = 'manual', sourceRef = null, actorId = null, at, room = Infinity },
    ) {
      if (!contactIds.length || room <= 0) return 0;
      const added = run(
        `INSERT OR IGNORE INTO audience_members(audience_id, contact_id, source, source_ref, added_by, added_at)
          SELECT ?, c.id, ?, ?, ?, ? FROM (SELECT DISTINCT value id FROM json_each(?)) j
          JOIN contacts c ON c.id = j.id
          WHERE c.brand_id = ? AND NOT EXISTS (SELECT 1 FROM audience_members x WHERE x.audience_id = ? AND x.contact_id = c.id)
          LIMIT ?`,
        audienceId,
        source,
        sourceRef,
        actorId,
        at,
        json(contactIds),
        brandId,
        audienceId,
        Number.isFinite(room) ? room : -1,
      ).changes;
      if (added)
        run(
          'UPDATE audiences SET member_count = member_count + ?, counted_at = ?, updated_at = ? WHERE brand_id = ? AND id = ?',
          added,
          at,
          at,
          brandId,
          audienceId,
        );
      return added;
    },
    removeMembers(brandId, audienceId, contactIds, at) {
      if (!contactIds.length) return 0;
      const removed = run(
        `DELETE FROM audience_members WHERE audience_id = ? AND contact_id IN (SELECT value FROM json_each(?))
          AND EXISTS (SELECT 1 FROM audiences a WHERE a.id = audience_id AND a.brand_id = ?)`,
        audienceId,
        json(contactIds),
        brandId,
      ).changes;
      if (removed)
        run(
          'UPDATE audiences SET member_count = max(member_count - ?, 0), counted_at = ?, updated_at = ? WHERE brand_id = ? AND id = ?',
          removed,
          at,
          at,
          brandId,
          audienceId,
        );
      return removed;
    },
    // Copia los miembros de una selección a una lista (instantánea de un segmento o de otra lista).
    copyInto(brandId, audienceId, select, { source, sourceRef, actorId, at, room }) {
      const added = run(
        `INSERT OR IGNORE INTO audience_members(audience_id, contact_id, source, source_ref, added_by, added_at)
          SELECT ?, c.id, ?, ?, ?, ? FROM contacts c WHERE c.brand_id = ? AND c.id IN (${select.sql}) ORDER BY c.id LIMIT ?`,
        audienceId,
        source,
        sourceRef,
        actorId,
        at,
        brandId,
        ...select.args,
        room,
      ).changes;
      run(
        'UPDATE audiences SET member_count = ?, counted_at = ? WHERE brand_id = ? AND id = ?',
        added,
        at,
        brandId,
        audienceId,
      );
      return added;
    },
    memberInfo: (audienceId, ids) =>
      ids.length
        ? all(
            `SELECT contact_id, source, added_at FROM audience_members WHERE audience_id = ? AND contact_id IN (${marks(ids.length)})`,
            audienceId,
            ...ids,
          )
        : [],

    // Fusión de contactos: las membresías del absorbido pasan al que queda sin repetir y se recuentan las listas.
    moveContact(keepId, mergedId, at) {
      const touched = all('SELECT audience_id FROM audience_members WHERE contact_id = ?', mergedId).map(
        r => r.audience_id,
      );
      if (!touched.length) return 0;
      run(
        `INSERT OR IGNORE INTO audience_members(audience_id, contact_id, source, source_ref, added_by, added_at)
          SELECT audience_id, ?, source, source_ref, added_by, added_at FROM audience_members WHERE contact_id = ?`,
        keepId,
        mergedId,
      );
      const moved = run('DELETE FROM audience_members WHERE contact_id = ?', mergedId).changes;
      for (const id of touched)
        run(
          'UPDATE audiences SET member_count = (SELECT count(*) FROM audience_members WHERE audience_id = ?), counted_at = ? WHERE id = ?',
          id,
          at,
          id,
        );
      return moved;
    },

    // Campañas que usan la audiencia como público, con su estado.
    campaignsUsing: (brandId, id) =>
      all(
        "SELECT id, title, status FROM campaigns WHERE brand_id = ? AND json_valid(segment) AND json_extract(segment, '$.audienceId') = ? ORDER BY created_at, id",
        brandId,
        id,
      ),

    // ---- lo que necesita la evaluación en memoria (pruebas y diagnósticos): un registro por contacto
    record(brandId, contactId) {
      const c = one(
        `SELECT c.id, c.name, c.email, c.phone_key, c.source, COALESCE(k.status, 'unknown') consent, s.created_at, s.activity_at
          ${CONTACT_FROM} WHERE c.brand_id = ? AND c.id = ?`,
        brandId,
        contactId,
      );
      if (!c) return null;
      const ids = (sql, ...args) => all(sql, ...args).map(row => row.v);
      const lastInbound = one(`SELECT ${LAST_INBOUND} v FROM contacts c WHERE c.id = ?`, contactId).v;
      return {
        name: c.name,
        email: c.email,
        has_phone: c.phone_key !== '',
        phone: c.phone_key,
        source: c.source,
        consent: c.consent,
        tag: ids('SELECT tag_id v FROM contact_tag_links WHERE contact_id = ?', contactId),
        stage: ids('SELECT stage v FROM opportunities WHERE contact_id = ?', contactId),
        owner: ids('SELECT owner_id v FROM opportunities WHERE contact_id = ? AND owner_id IS NOT NULL', contactId),
        course: ids('SELECT course_id v FROM opportunities WHERE contact_id = ?', contactId),
        active_interest: Boolean(
          one("SELECT 1 v FROM opportunities WHERE contact_id = ? AND stage NOT IN ('ganada', 'perdida')", contactId),
        ),
        created: c.created_at,
        activity: c.activity_at,
        list: ids('SELECT audience_id v FROM audience_members WHERE contact_id = ?', contactId),
        last_inbound: lastInbound,
        channel: ids(
          'SELECT chv.channel v FROM opportunities cho JOIN conversation_opportunities chk ON chk.opportunity_id = cho.id JOIN conversations chv ON chv.id = chk.conversation_id WHERE cho.contact_id = ?',
          contactId,
        ),
        enrolled: Boolean(one("SELECT 1 v FROM enrollments WHERE contact_id = ? AND status = 'enrolled'", contactId)),
        enrolled_course: ids(
          "SELECT course_id v FROM enrollments WHERE contact_id = ? AND status = 'enrolled'",
          contactId,
        ),
        pending_order: Boolean(
          one("SELECT 1 v FROM orders WHERE contact_id = ? AND status IN ('pending', 'review')", contactId),
        ),
      };
    },
  };
}
