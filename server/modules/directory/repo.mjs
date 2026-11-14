// Todo el SQL del módulo `directory` (lista de contactos a escala). Cada función recibe primero la marca o la lista de
// marcas permitidas: el alcance lo decide module.mjs con host.access y aquí sólo se aplica. Los valores que escribe una
// persona viajan siempre como parámetros; en el texto de las consultas sólo hay expresiones escritas aquí.
//
// La lista lee de `contact_search` (migración contacts/0001-search): una fila por contacto con la clave del nombre y
// del correo, la fecha de alta y la última actividad, cada una con su índice por marca. Una página es una consulta por
// marca que lee del índice sólo las filas que necesita (más una) y la mezcla de las marcas se hace aquí.
import { compile, defineFields, registerSqlFunctions } from '../../lib/conditions.mjs';

export const STAGES = Object.freeze([
  { value: 'nuevo', label: 'Nuevo' },
  { value: 'interesado', label: 'Interesado' },
  { value: 'inscripcion', label: 'Inscripción' },
  { value: 'ganada', label: 'Ganada' },
  { value: 'perdida', label: 'Perdida' },
]);
export const CONSENTS = Object.freeze([
  { value: 'unknown', label: 'Sin respuesta' },
  { value: 'opted_in', label: 'Aceptó mensajes' },
  { value: 'opted_out', label: 'No quiere mensajes' },
]);

// Campos del contacto para la gramática común de condiciones (server/lib/conditions.mjs), ámbito «contact». Las
// expresiones usan los alias de la consulta de la lista: `c` (contacts), `s` (contact_search) y `k` (contact_consent).
// Lo que pregunta por intereses o etiquetas va en su propia subconsulta, así que repetir un campo no choca.
export const CONTACT_FIELDS = defineFields([
  { key: 'name', type: 'text', label: 'Nombre', sql: 'c.name', ops: ['contains', 'not_contains', 'starts_with', 'eq'] },
  {
    key: 'email',
    type: 'text',
    label: 'Correo',
    sql: 'c.email',
    ops: ['contains', 'not_contains', 'empty', 'not_empty'],
  },
  { key: 'has_phone', type: 'boolean', label: 'Tiene teléfono', sql: "(c.phone_key != '')", ops: ['is'] },
  { key: 'brand', type: 'choice', label: 'Marca', sql: 'c.brand_id', ops: ['eq', 'neq', 'in', 'not_in'] },
  { key: 'source', type: 'choice', label: 'Origen', sql: 'c.source', ops: ['eq', 'neq', 'in', 'not_in'] },
  {
    key: 'consent',
    type: 'choice',
    label: 'Consentimiento',
    sql: "COALESCE(k.status, 'unknown')",
    options: CONSENTS.map(item => item.value),
    ops: ['eq', 'neq', 'in', 'not_in'],
  },
  {
    key: 'tag',
    type: 'list',
    label: 'Etiqueta',
    sql: { from: 'contact_tag_links tl', where: 'tl.contact_id = c.id', value: 'tl.tag_id' },
  },
  {
    key: 'stage',
    type: 'list',
    label: 'Etapa de un interés',
    options: STAGES.map(item => item.value),
    sql: { from: 'opportunities so', where: 'so.contact_id = c.id', value: 'so.stage' },
    ops: ['any', 'none'],
  },
  {
    key: 'owner',
    type: 'list',
    label: 'Responsable de un interés',
    sql: { from: 'opportunities oo', where: 'oo.contact_id = c.id AND oo.owner_id IS NOT NULL', value: 'oo.owner_id' },
    ops: ['any', 'none', 'empty', 'not_empty'],
  },
  {
    key: 'course',
    type: 'list',
    label: 'Curso de un interés',
    sql: { from: 'opportunities ko', where: 'ko.contact_id = c.id', value: 'ko.course_id' },
    ops: ['any', 'none'],
  },
  {
    key: 'active_interest',
    type: 'boolean',
    label: 'Tiene un interés abierto',
    sql: "EXISTS (SELECT 1 FROM opportunities ai WHERE ai.contact_id = c.id AND ai.stage NOT IN ('ganada', 'perdida'))",
    ops: ['is'],
  },
  {
    key: 'created',
    type: 'date',
    label: 'Fecha de alta',
    sql: 's.created_at',
    ops: ['after', 'before', 'between', 'in_last_days', 'not_in_last_days'],
  },
  {
    key: 'activity',
    type: 'date',
    label: 'Última actividad',
    sql: 's.activity_at',
    ops: ['after', 'before', 'between', 'in_last_days', 'not_in_last_days'],
  },
]);

// Columna de contact_search por la que ordena cada orden de la lista.
export const SORTS = Object.freeze({ name: 's.name_key', created: 's.created_at', activity: 's.activity_at' });

const marks = count => Array.from({ length: count }, () => '?').join(',');

// Comparación igual a la de SQLite (bytes de UTF-8): así la mezcla de varias marcas da el mismo orden que el índice.
const bytes = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
const compareSortValue = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : bytes(a, b));

export function createRepo(db) {
  // La gramática de condiciones necesita su normalización de texto dentro de SQLite (es la misma de JavaScript).
  registerSqlFunctions(db);

  // Lo que la búsqueda y los filtros añaden al WHERE, ya armado por `where()`.
  //   search: {words: ['jose'], nameOnly?} | {phone: {key, digits}} | {last4: '5678'} | null
  //   conditions: lista de {sql, params} de compile()
  function where({ search = null, conditions = [] } = {}) {
    const parts = [];
    const params = [];
    if (search?.words?.length) {
      for (const word of search.words) {
        // Sin permiso para ver el correo completo, se busca sólo en el nombre.
        parts.push(search.nameOnly ? 'instr(s.name_key, ?) > 0' : "instr(s.name_key || ' ' || s.email_key, ?) > 0");
        params.push(word);
      }
    } else if (search?.phone) {
      // Teléfono completo (por su clave) o un tramo de sus dígitos.
      parts.push("(c.phone_key != '' AND (c.phone_key = ? OR instr(c.phone_key, ?) > 0))");
      params.push(search.phone.key ?? '', search.phone.digits);
    } else if (search?.last4) {
      // Sin permiso para ver teléfonos completos sólo se busca por los cuatro últimos dígitos, los que ya se ven.
      parts.push("(c.phone_key != '' AND substr(c.phone_key, -4) = ?)");
      params.push(search.last4);
    }
    for (const condition of conditions) {
      parts.push(condition.sql);
      params.push(...condition.params);
    }
    return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
  }

  const FROM = `FROM contact_search s
    CROSS JOIN contacts c ON c.id = s.contact_id
    LEFT JOIN contact_consent k ON k.contact_id = c.id`;
  const COLUMNS = `c.id, c.brand_id, c.name, c.phone, c.email, c.source, c.created_at, c.updated_at, c.persona_id,
    c.source_user_id, s.name_key, s.activity_at, COALESCE(k.status, 'unknown') consent,
    (SELECT u.test_number FROM users u WHERE u.id = c.source_user_id) test_number`;

  // Una página de una marca. `after` es el cursor ya validado ({v, i}) o null.
  function brandPage(brandId, { sort, dir, after, limit, filter }) {
    const column = SORTS[sort];
    const direction = dir === 'asc' ? 'ASC' : 'DESC';
    const extra = where(filter);
    const params = [brandId, brandId];
    let cursor = '';
    if (after) {
      // Comparación de pares: SQLite la usa como tramo del índice y empieza a leer justo después del cursor.
      cursor = ` AND (${column}, s.contact_id) ${dir === 'asc' ? '>' : '<'} (?, ?)`;
      params.push(after.v, after.i);
    }
    return db
      .prepare(
        `SELECT ${COLUMNS} ${FROM}
         WHERE s.brand_id = ? AND c.brand_id = ?${cursor}${extra.sql}
         ORDER BY ${column} ${direction}, s.contact_id ${direction} LIMIT ?`,
      )
      .all(...params, ...extra.params, limit)
      .map(row => ({ ...row }));
  }

  // Una página de varias marcas: `limit` filas en el orden pedido y el cursor de la siguiente (o null). `filters` da
  // la búsqueda y las condiciones de cada marca (la búsqueda por teléfono depende del permiso en esa marca). Cada
  // marca aporta como mucho `limit + 1` filas: si entre todas sobran, hay página siguiente.
  function page(brandIds, { sort = 'activity', dir = 'desc', after = null, limit = 50, filters = new Map() } = {}) {
    if (!SORTS[sort]) throw new TypeError('Orden desconocido: ' + sort);
    const rows = brandIds.flatMap(brandId =>
      brandPage(brandId, { sort, dir, after, limit: limit + 1, filter: filters.get(brandId) }),
    );
    const key = row => (sort === 'name' ? row.name_key : sort === 'created' ? row.created_at : row.activity_at);
    const sign = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => sign * (compareSortValue(key(a), key(b)) || bytes(a.id, b.id)));
    const more = rows.length > limit;
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return { rows: shown, next: more && last ? { v: key(last), i: last.id } : null };
  }

  // Cuántos contactos cumplen, contando hasta `cap` (y diciendo si hay más).
  function count(brandIds, { filters = new Map(), cap = 10_000 } = {}) {
    let n = 0;
    for (const brandId of brandIds) {
      const extra = where(filters.get(brandId));
      n += db
        .prepare(
          `SELECT count(*) n FROM (SELECT 1 ${FROM} WHERE s.brand_id = ? AND c.brand_id = ?${extra.sql} LIMIT ?)`,
        )
        .get(brandId, brandId, ...extra.params, cap + 1 - n).n;
      if (n > cap) return { n: cap, capped: true };
    }
    return { n, capped: false };
  }

  // Las filas de estos contactos que siguen cumpliendo la búsqueda y los filtros (para los avisos en vivo).
  function byIds(brandIds, ids, { filters = new Map() } = {}) {
    if (!ids.length) return [];
    return brandIds.flatMap(brandId => {
      const extra = where(filters.get(brandId));
      return db
        .prepare(
          `SELECT ${COLUMNS} ${FROM}
           WHERE s.contact_id IN (${marks(ids.length)}) AND s.brand_id = ? AND c.brand_id = ?${extra.sql}`,
        )
        .all(...ids, brandId, brandId, ...extra.params)
        .map(row => ({ ...row }));
    });
  }

  // Lo que cada fila muestra además de sus datos, en tres consultas por página (nunca una por fila).
  function extras(brandIds, ids) {
    const tags = new Map();
    const interests = new Map();
    const brands = new Map();
    if (!ids.length) return { tags, interests, brands };
    const scope = marks(brandIds.length);
    for (const row of db
      .prepare(
        `SELECT l.contact_id, t.id, t.name, t.color FROM contact_tag_links l JOIN contact_tags t ON t.id = l.tag_id
         WHERE l.contact_id IN (${marks(ids.length)}) AND t.brand_id IN (${scope}) ORDER BY t.name`,
      )
      .all(...ids, ...brandIds)) {
      if (!tags.has(row.contact_id)) tags.set(row.contact_id, []);
      tags.get(row.contact_id).push({ id: row.id, name: row.name, color: row.color });
    }
    for (const row of db
      .prepare(
        `SELECT o.contact_id, o.stage, o.updated_at, k.title course, u.name owner FROM opportunities o
         JOIN courses k ON k.id = o.course_id LEFT JOIN users u ON u.id = o.owner_id
         WHERE o.contact_id IN (${marks(ids.length)}) AND o.brand_id IN (${scope})
         ORDER BY o.updated_at DESC, o.id DESC`,
      )
      .all(...ids, ...brandIds)) {
      const entry = interests.get(row.contact_id) ?? { total: 0, active: 0, latest: null };
      entry.total++;
      if (!['ganada', 'perdida'].includes(row.stage)) entry.active++;
      entry.latest ??= { stage: row.stage, course: row.course, owner: row.owner ?? null };
      interests.set(row.contact_id, entry);
    }
    for (const row of db.prepare(`SELECT id, name FROM brands WHERE id IN (${scope})`).all(...brandIds))
      brands.set(row.id, row.name);
    return { tags, interests, brands };
  }

  // Todo lo que muestra el panel de un contacto. null si no existe o no es de esas marcas.
  function detail(brandIds, id) {
    if (!brandIds.length) return null;
    const scope = marks(brandIds.length);
    const contact = db
      .prepare(`SELECT ${COLUMNS} ${FROM} WHERE s.contact_id = ? AND c.brand_id IN (${scope})`)
      .get(id, ...brandIds);
    if (!contact) return null;
    const consent = db
      .prepare('SELECT status, source, note, updated_at FROM contact_consent WHERE contact_id = ?')
      .get(contact.id);
    const history = db
      .prepare(
        `SELECT e.status, e.source, e.created_at, u.name actor FROM contact_consent_events e
         LEFT JOIN users u ON u.id = e.actor_id WHERE e.contact_id = ? ORDER BY e.seq DESC LIMIT 10`,
      )
      .all(contact.id);
    const opportunities = db
      .prepare(
        `SELECT o.id, o.stage, o.lost_reason, o.created_at, o.updated_at, k.title course, e.name edition, u.name owner,
           (SELECT MIN(t.due_at) FROM tasks t WHERE t.opportunity_id = o.id AND t.status = 'open') next_due
         FROM opportunities o JOIN courses k ON k.id = o.course_id LEFT JOIN editions e ON e.id = o.edition_id
         LEFT JOIN users u ON u.id = o.owner_id
         WHERE o.contact_id = ? AND o.brand_id = ? ORDER BY o.updated_at DESC, o.id DESC LIMIT 50`,
      )
      .all(contact.id, contact.brand_id);
    // Sus conversaciones: las del mismo perfil de cliente en la marca y las unidas a alguno de sus intereses.
    const mine = `v.brand_id = ? AND (v.customer_id = ? OR v.id IN (SELECT co.conversation_id
      FROM conversation_opportunities co JOIN opportunities o ON o.id = co.opportunity_id WHERE o.contact_id = ?))`;
    const conversationArgs = [contact.brand_id, contact.source_user_id ?? '', contact.id];
    const conversation = db
      .prepare(
        `SELECT v.id, v.channel, v.status, v.updated_at, k.title course, u.name assigned FROM conversations v
         JOIN courses k ON k.id = v.course_id LEFT JOIN users u ON u.id = v.assigned_to
         WHERE ${mine} ORDER BY v.updated_at DESC, v.id DESC LIMIT 1`,
      )
      .get(...conversationArgs);
    const conversations = db.prepare(`SELECT count(*) n FROM conversations v WHERE ${mine}`).get(...conversationArgs).n;
    const { tags, brands } = extras([contact.brand_id], [contact.id]);
    return {
      contact: { ...contact },
      brandName: brands.get(contact.brand_id) ?? contact.brand_id,
      tags: tags.get(contact.id) ?? [],
      consent: consent ? { ...consent } : null,
      history: history.map(row => ({ ...row })),
      opportunities: opportunities.map(row => ({ ...row })),
      conversation: conversation ? { ...conversation } : null,
      conversations,
    };
  }

  // Opciones para el constructor de filtros: sólo lo de las marcas permitidas.
  function options(brandIds) {
    if (!brandIds.length) return { brands: [], tags: [], courses: [], owners: [], sources: [] };
    const scope = marks(brandIds.length);
    const all = (sql, ...args) =>
      db
        .prepare(sql)
        .all(...args)
        .map(row => ({ ...row }));
    return {
      brands: all(`SELECT id, name FROM brands WHERE id IN (${scope}) ORDER BY created_at, id`, ...brandIds),
      tags: all(
        `SELECT id, name, color, brand_id FROM contact_tags WHERE brand_id IN (${scope}) ORDER BY name LIMIT 500`,
        ...brandIds,
      ),
      courses: all(
        `SELECT id, title, brand_id FROM courses WHERE brand_id IN (${scope}) ORDER BY title LIMIT 500`,
        ...brandIds,
      ),
      // Quien puede ser responsable en esas marcas: administración y el equipo de cada una.
      owners: all(
        `SELECT DISTINCT u.id, u.name FROM users u LEFT JOIN brand_members m ON m.user_id = u.id
         WHERE u.disabled = 0 AND (u.role = 'admin' OR (u.role = 'agent' AND m.brand_id IN (${scope})))
         ORDER BY u.name LIMIT 500`,
        ...brandIds,
      ),
      sources: all(
        `SELECT DISTINCT source FROM contacts WHERE brand_id IN (${scope}) ORDER BY source LIMIT 30`,
        ...brandIds,
      ).map(row => row.source),
    };
  }

  // Avisos en vivo: los contactos que cambiaron después del número de cambio `rev`, de todas las marcas (quien los
  // anuncia los entrega sólo a quien puede ver cada marca). Es la única consulta del módulo sin marca: recorre el
  // índice de cambios, no datos de contactos.
  function changesSince(rev, limit = 500) {
    return db
      .prepare('SELECT contact_id, brand_id, rev FROM contact_search WHERE rev > ? ORDER BY rev LIMIT ?')
      .all(rev, limit)
      .map(row => ({ ...row }));
  }
  const lastRev = () => db.prepare('SELECT COALESCE(MAX(rev), 0) rev FROM contact_search').get().rev;

  // El SQL de una definición de condiciones ya validada, para `where()`.
  const compileConditions = (definition, now) => compile(definition, CONTACT_FIELDS, { now });

  return { page, count, byIds, extras, detail, options, changesSince, lastRev, compileConditions };
}
