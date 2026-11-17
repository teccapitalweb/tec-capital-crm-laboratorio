// Todo el SQL del módulo `inbox` (bandeja nueva: vistas, filtros, contadores y búsqueda; docs/PLAN_BANDEJA_VISTAS.md).
//
// Cada función recibe primero la marca o la lista de marcas permitidas: el alcance lo decide module.mjs con
// host.access y aquí sólo se aplica. Lo que escribe una persona viaja siempre como parámetro; en el texto de las
// consultas sólo hay expresiones escritas aquí (vistas del sistema y campos de la gramática común).
//
// Una página es una consulta por marca, que lee del índice sólo las filas que necesita (más una), y la mezcla de las
// marcas se hace aquí (SQLite no ordena varias franjas de índice sin ordenar todo). Las filas de la página se
// completan después con consultas por lote (IN de los ids de la página), nunca una por fila.
import { randomUUID } from 'node:crypto';
import { compile, defineFields, registerSqlFunctions, SQL_NORM } from '../../lib/conditions.mjs';
import { searchKey } from '../../lib/search-key.mjs';

export const STATES = Object.freeze(['open', 'pending', 'solved', 'expired', 'awaiting', 'blocked']);
const ACTIVE = "c.state IN ('open','pending')";
const WAITING =
  'EXISTS (SELECT 1 FROM service_state ws WHERE ws.conversation_id = c.id AND ws.waiting_since IS NOT NULL)';
const UNREAD = `EXISTS (SELECT 1 FROM messages um
  WHERE um.conversation_id = c.id AND um.read_at IS NULL AND um.sender_kind = 'customer')`;
const LOST = `(SELECT cy.missed FROM conversation_cycles cy WHERE cy.conversation_id = c.id ORDER BY cy.number DESC LIMIT 1) = 1`;

// Vistas del sistema (diseño de bandeja §3.2), con lo que existe hoy: el estado de la conversación del módulo
// `lifecycle` (Abierta, Pendiente, Resuelta, Expirada…), «quién atiende» (bot_enabled, assigned_to) y la espera de
// una persona (service_state.waiting_since). «Activas» = Abierta o Pendiente. `sql(me)` devuelve el predicado y sus
// parámetros; `sort` es el orden natural de la vista.
export const SYSTEM_VIEWS = Object.freeze([
  {
    key: 'mine',
    name: 'Mías',
    description: 'Abiertas o pendientes a tu cargo.',
    sql: me => ({ sql: `c.state IN ('open','pending','awaiting') AND c.assigned_to = ?`, params: [me] }),
  },
  {
    key: 'unreplied',
    name: 'Sin respuesta',
    description: 'La persona espera a alguien del equipo y nadie le ha contestado.',
    sql: () => ({ sql: `${ACTIVE} AND ${WAITING}`, params: [] }),
    sort: 'waiting',
  },
  {
    key: 'unassigned',
    name: 'Sin asignar',
    description: 'Activas, fuera del asistente y sin responsable.',
    sql: () => ({ sql: `${ACTIVE} AND c.assigned_to IS NULL AND c.bot_enabled = 0`, params: [] }),
  },
  {
    key: 'unread',
    name: 'No leídas',
    description: 'Tienen mensajes de la persona que nadie del equipo ha leído.',
    sql: () => ({ sql: `c.state != 'blocked' AND ${UNREAD}`, params: [] }),
  },
  {
    key: 'assistant',
    name: 'Con el asistente',
    description: 'Activas que atiende el asistente.',
    sql: () => ({ sql: `${ACTIVE} AND c.bot_enabled = 1`, params: [] }),
  },
  {
    key: 'active',
    name: 'Activas',
    description: 'Abiertas o pendientes.',
    sql: () => ({ sql: ACTIVE, params: [] }),
  },
  {
    key: 'pending',
    name: 'Pendientes',
    description: 'El equipo espera algo de la persona.',
    sql: () => ({ sql: "c.state = 'pending'", params: [] }),
  },
  {
    key: 'solved',
    name: 'Resueltas',
    description: 'Cerradas por el equipo.',
    sql: () => ({ sql: "c.state = 'solved'", params: [] }),
  },
  {
    key: 'expired',
    name: 'Expiradas',
    description: 'Se cerró la ventana de 24 horas sin resolverlas.',
    sql: () => ({ sql: "c.state = 'expired'", params: [] }),
  },
  {
    key: 'lost',
    name: 'Perdidas',
    description: 'Expiraron con la persona esperando respuesta.',
    sql: () => ({ sql: `c.state = 'expired' AND ${LOST}`, params: [] }),
  },
  {
    key: 'all',
    name: 'Todas',
    description: 'Todas, menos las bloqueadas.',
    sql: () => ({ sql: "c.state != 'blocked'", params: [] }),
  },
]);
export const SYSTEM_KEYS = Object.freeze(SYSTEM_VIEWS.map(view => view.key));
export const systemView = key => SYSTEM_VIEWS.find(view => view.key === key) ?? null;

// Órdenes de la lista: columna (o expresión) y sentido. «waiting» (espera más larga primero) sólo tiene sentido en
// una lista de conversaciones que esperan a alguien: el módulo lo permite únicamente con la vista «Sin respuesta».
export const SORTS = Object.freeze({
  recent: { expr: 'c.updated_at', dir: 'DESC' },
  oldest: { expr: 'c.updated_at', dir: 'ASC' },
  waiting: { expr: '(SELECT ss.waiting_since FROM service_state ss WHERE ss.conversation_id = c.id)', dir: 'ASC' },
});

export const ORIGINS = Object.freeze(['inbound', 'ad', 'broadcast', 'outbound', 'api', 'import', 'lab']);
export const CHANNELS = Object.freeze(['whatsapp', 'instagram', 'facebook']);
export const HANDLERS = Object.freeze(['assistant', 'person', 'queue']);
export const PRIORITIES = Object.freeze(['normal', 'high', 'urgent']);
export const STAGES = Object.freeze(['nuevo', 'interesado', 'inscripcion', 'ganada', 'perdida']);

// Campos de la conversación para la gramática común (ámbito «conversation»). Las expresiones usan el alias `c`
// (conversations). `assignee` admite el valor «me», que el módulo cambia por quien consulta antes de compilar: así una
// vista compartida «Mías con etiqueta VIP» funciona para cada quien.
export const CONVERSATION_FIELD_DECLARATIONS = Object.freeze([
  {
    key: 'state',
    type: 'choice',
    label: 'Estado',
    sql: 'c.state',
    options: STATES,
    ops: ['eq', 'neq', 'in', 'not_in'],
  },
  {
    key: 'assignee',
    type: 'choice',
    label: 'Responsable',
    sql: 'c.assigned_to',
    ops: ['eq', 'neq', 'in', 'not_in', 'empty', 'not_empty'],
  },
  {
    key: 'handler',
    type: 'choice',
    label: 'Quién atiende',
    sql: "(CASE WHEN c.bot_enabled = 1 THEN 'assistant' WHEN c.assigned_to IS NULL THEN 'queue' ELSE 'person' END)",
    options: HANDLERS,
    ops: ['eq', 'neq', 'in'],
  },
  { key: 'brand', type: 'choice', label: 'Marca', sql: 'c.brand_id', ops: ['in', 'not_in'] },
  { key: 'channel', type: 'choice', label: 'Canal', sql: 'c.channel', options: CHANNELS, ops: ['in', 'not_in'] },
  { key: 'number', type: 'choice', label: 'Número de WhatsApp', sql: 'c.wa_number', ops: ['in', 'not_in', 'empty'] },
  { key: 'course', type: 'choice', label: 'Curso', sql: 'c.course_id', ops: ['in', 'not_in'] },
  { key: 'edition', type: 'choice', label: 'Edición', sql: 'c.edition_id', ops: ['in', 'not_in'] },
  { key: 'origin', type: 'choice', label: 'Origen', sql: 'c.origin', options: ORIGINS, ops: ['eq', 'in', 'not_in'] },
  {
    key: 'tag',
    type: 'list',
    label: 'Etiqueta del contacto',
    sql: {
      from: 'contacts tc JOIN contact_tag_links tl ON tl.contact_id = tc.id',
      where: 'tc.brand_id = c.brand_id AND tc.source_user_id = c.customer_id',
      value: 'tl.tag_id',
    },
  },
  {
    key: 'stage',
    type: 'list',
    label: 'Etapa comercial',
    options: STAGES,
    sql: {
      from: 'conversation_opportunities sco JOIN opportunities so ON so.id = sco.opportunity_id',
      where: 'sco.conversation_id = c.id',
      value: 'so.stage',
    },
    ops: ['any', 'none'],
  },
  {
    key: 'priority',
    type: 'choice',
    label: 'Prioridad',
    sql: "COALESCE((SELECT ps.priority FROM service_state ps WHERE ps.conversation_id = c.id), 'normal')",
    options: PRIORITIES,
    ops: ['eq', 'in'],
  },
  { key: 'unread', type: 'boolean', label: 'Sin leer', sql: `(${UNREAD})`, ops: ['is'] },
  { key: 'waiting', type: 'boolean', label: 'Espera respuesta del equipo', sql: `(${WAITING})`, ops: ['is'] },
  {
    key: 'activity',
    type: 'date',
    label: 'Última actividad',
    sql: 'c.updated_at',
    ops: ['after', 'before', 'between', 'in_last_days', 'not_in_last_days'],
  },
  {
    key: 'created',
    type: 'date',
    label: 'Inicio',
    sql: 'c.created_at',
    ops: ['after', 'before', 'between', 'in_last_days', 'not_in_last_days'],
  },
]);
export const CONVERSATION_FIELDS = defineFields(CONVERSATION_FIELD_DECLARATIONS);

const marks = count => Array.from({ length: count }, () => '?').join(',');
const plain = row => (row ? { ...row } : row);

// Vista previa del último mensaje: una línea, hasta 200 caracteres; sin texto, lo que es.
const KIND_LABEL = {
  image: 'Imagen',
  audio: 'Nota de voz',
  video: 'Video',
  document: 'Documento',
  sticker: 'Sticker',
  location: 'Ubicación',
  contacts: 'Contacto',
  interactive: 'Respuesta con botón',
};
export function previewOf(message) {
  if (!message) return '';
  const text = String(message.text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) return text.length > 200 ? text.slice(0, 199) + '…' : text;
  if (message.flow_file) return 'Archivo'; // un archivo que mandó un recorrido viaja como la ficha, pero no lo es
  if (message.flyer_course_id) return 'Flyer del curso';
  if (message.wa_template) return 'Plantilla';
  if (KIND_LABEL[message.content_kind]) return KIND_LABEL[message.content_kind];
  return message.attachment_id ? 'Archivo' : '';
}

export function createRepo(db) {
  // La gramática de condiciones necesita su normalización de texto dentro de SQLite (la misma de JavaScript).
  registerSqlFunctions(db);

  // Lo que añaden al WHERE la vista y los filtros. `parts` es una lista de {sql, params}.
  function where(parts) {
    const sql = parts.map(part => ` AND (${part.sql})`).join('');
    return { sql, params: parts.flatMap(part => part.params) };
  }

  // Una página de una marca. `after` es el cursor ya validado ({v, i}) o null.
  function brandPage(brandId, { sort, after, limit, parts }) {
    const { expr, dir } = SORTS[sort];
    const extra = where(parts);
    const params = [brandId];
    let cursor = '';
    if (after) {
      // Comparación de pares: con el índice, SQLite empieza a leer justo después del cursor.
      cursor = ` AND (${expr}, c.id) ${dir === 'ASC' ? '>' : '<'} (?, ?)`;
      params.push(after.v, after.i);
    }
    return db
      .prepare(
        `SELECT c.id, c.brand_id, ${expr} AS sort_v FROM conversations c
         WHERE c.brand_id = ?${extra.sql}${cursor} ORDER BY sort_v ${dir}, c.id ${dir} LIMIT ?`,
      )
      .all(...params.slice(0, 1), ...extra.params, ...params.slice(1), limit)
      .map(plain);
  }

  // Una página de varias marcas: `limit` filas en orden y el cursor de la siguiente (o null). `partsFor(brandId)` da
  // el predicado de la vista y los filtros de cada marca. Cada marca aporta como mucho `limit + 1` filas.
  function page(brandIds, { sort = 'recent', after = null, limit = 40, partsFor }) {
    if (!SORTS[sort]) throw new TypeError('Orden desconocido: ' + sort);
    const rows = brandIds.flatMap(brandId =>
      brandPage(brandId, { sort, after, limit: limit + 1, parts: partsFor(brandId) }),
    );
    const sign = SORTS[sort].dir === 'ASC' ? 1 : -1;
    const value = v => (v === null || v === undefined ? -Infinity : v);
    rows.sort((a, b) => sign * (value(a.sort_v) - value(b.sort_v) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    const more = rows.length > limit;
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return { ids: shown.map(row => row.id), next: more && last ? { v: last.sort_v ?? 0, i: last.id } : null };
  }

  // Cuántas conversaciones cumplen, contando hasta `cap` (y diciendo si hay más). Una consulta acotada por marca:
  // el costo no crece con la historia por encima del tope.
  function count(brandIds, { partsFor, cap }) {
    let n = 0;
    for (const brandId of brandIds) {
      const extra = where(partsFor(brandId));
      n += db
        .prepare(`SELECT count(*) n FROM (SELECT 1 FROM conversations c WHERE c.brand_id = ?${extra.sql} LIMIT ?)`)
        .get(brandId, ...extra.params, cap + 1 - n).n;
      if (n > cap) return { n: cap, capped: true };
    }
    return { n, capped: false };
  }

  // Las filas de la lista, completas, en el orden de `ids`. Sólo de las marcas dadas.
  function rows(brandIds, ids) {
    if (!ids.length || !brandIds.length) return [];
    const list = db
      .prepare(
        `SELECT c.id, c.brand_id, c.course_id, c.edition_id, c.channel, c.customer_id, c.state, c.state_since, c.status,
           c.bot_enabled, c.assigned_to, c.updated_at, c.created_at, c.window_until, c.origin, c.origin_ref, c.wa_number,
           c.course_pending, c.cycle_count, u.name customer_name, u.test_number, b.name brand_name, k.title course_title,
           e.name edition_name, a.name assignee_name, s.revision service_revision, s.waiting_since, s.due_at,
           COALESCE(s.priority, 'normal') priority, ct.id contact_id, ct.phone contact_phone, o.id opportunity_id,
           o.stage, n.label number_label
         FROM conversations c
         JOIN users u ON u.id = c.customer_id
         JOIN brands b ON b.id = c.brand_id
         JOIN courses k ON k.id = c.course_id
         LEFT JOIN editions e ON e.id = c.edition_id
         LEFT JOIN users a ON a.id = c.assigned_to
         LEFT JOIN service_state s ON s.conversation_id = c.id
         LEFT JOIN contacts ct ON ct.brand_id = c.brand_id AND ct.source_user_id = c.customer_id
         LEFT JOIN conversation_opportunities co ON co.conversation_id = c.id
         LEFT JOIN opportunities o ON o.id = co.opportunity_id
         LEFT JOIN wa_numbers n ON n.phone_number_id = c.wa_number
         WHERE c.id IN (${marks(ids.length)}) AND c.brand_id IN (${marks(brandIds.length)})`,
      )
      .all(...ids, ...brandIds)
      .map(plain);
    const last = new Map(
      db
        .prepare(
          `SELECT m.conversation_id, m.text, m.sender_kind, m.content_kind, m.attachment_id, m.flyer_course_id,
             COALESCE(json_extract(m.flyer_snapshot,'$.file'),0) flow_file, m.wa_template, m.created_at FROM messages m
           WHERE m.seq IN (SELECT MAX(x.seq) FROM messages x WHERE x.conversation_id IN (${marks(ids.length)})
             AND x.sender_kind != 'system' GROUP BY x.conversation_id)`,
        )
        .all(...ids)
        .map(row => [row.conversation_id, plain(row)]),
    );
    const unread = new Map(
      db
        .prepare(
          `SELECT conversation_id, count(*) n FROM messages
           WHERE conversation_id IN (${marks(ids.length)}) AND read_at IS NULL AND sender_kind = 'customer'
           GROUP BY conversation_id`,
        )
        .all(...ids)
        .map(row => [row.conversation_id, row.n]),
    );
    const contactIds = [...new Set(list.map(row => row.contact_id).filter(Boolean))];
    const tags = new Map();
    if (contactIds.length)
      for (const row of db
        .prepare(
          `SELECT l.contact_id, t.id, t.name, t.color FROM contact_tag_links l JOIN contact_tags t ON t.id = l.tag_id
           WHERE l.contact_id IN (${marks(contactIds.length)}) AND t.brand_id IN (${marks(brandIds.length)})
           ORDER BY t.name`,
        )
        .all(...contactIds, ...brandIds)) {
        if (!tags.has(row.contact_id)) tags.set(row.contact_id, []);
        tags.get(row.contact_id).push({ id: row.id, name: row.name, color: row.color });
      }
    const byId = new Map(
      list.map(row => [
        row.id,
        {
          ...row,
          last: last.get(row.id) ?? null,
          unread: unread.get(row.id) ?? 0,
          tags: tags.get(row.contact_id) ?? [],
        },
      ]),
    );
    return ids.map(id => byId.get(id)).filter(Boolean);
  }

  // ---- Búsqueda (diseño §3.4, sin el índice de texto de F0-14, que todavía no existe)

  // Personas: por palabras en la clave del nombre del contacto (sin acentos), o por teléfono. `phone` es
  // {key, digits} (búsqueda completa) o {last4} (quien no ve teléfonos completos sólo busca por lo que ve).
  // Devuelve los ids de las conversaciones más recientes de esas personas, con el nombre que coincidió.
  function searchPeople(brandId, { words = [], phone = null }, limit) {
    const parts = [];
    const params = [brandId];
    if (words.length) {
      for (const word of words) {
        parts.push('instr(s.name_key, ?) > 0');
        params.push(word);
      }
    } else if (phone?.last4) {
      parts.push("(ct.phone_key != '' AND substr(ct.phone_key, -4) = ?)");
      params.push(phone.last4);
    } else if (phone) {
      parts.push("(ct.phone_key != '' AND instr(ct.phone_key, ?) > 0)");
      params.push(phone.digits);
    } else return [];
    return db
      .prepare(
        `SELECT c.id, ct.name FROM contact_search s
         JOIN contacts ct ON ct.id = s.contact_id
         JOIN conversations c ON c.customer_id = ct.source_user_id AND c.brand_id = ct.brand_id
         WHERE s.brand_id = ? AND ${parts.join(' AND ')} AND c.state != 'blocked'
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map(plain);
  }

  // Cursos: el título contiene lo buscado (sin acentos) → conversaciones de esos cursos, las más recientes.
  function searchCourses(brandId, needle, limit) {
    return db
      .prepare(
        `SELECT c.id, k.title FROM courses k JOIN conversations c ON c.course_id = k.id AND c.brand_id = k.brand_id
         WHERE k.brand_id = ? AND instr(${SQL_NORM}(k.title), ?) > 0 AND c.state != 'blocked'
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .all(brandId, needle, limit)
      .map(plain);
  }

  // Mensajes: recorre como mucho los `window` mensajes más recientes de todo el CRM (por su número de orden, que es
  // la clave primaria) y se queda con los de esas marcas que contienen lo buscado. Sin índice de texto no hay otra
  // forma acotada; `partial` dice si quedaron mensajes más viejos sin revisar.
  function searchMessages(brandIds, needle, { window, limit }) {
    if (!brandIds.length) return { hits: [], partial: false };
    const top = db.prepare('SELECT COALESCE(MAX(seq), 0) seq FROM messages').get().seq;
    const from = Math.max(0, top - window);
    const hits = db
      .prepare(
        `SELECT m.conversation_id id, m.text, m.seq FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.seq > ? AND m.sender_kind IN ('customer','agent','automation') AND c.brand_id IN (${marks(brandIds.length)})
           AND c.state != 'blocked' AND instr(${SQL_NORM}(m.text), ?) > 0
         ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(from, ...brandIds, needle, limit)
      .map(plain);
    return { hits, partial: from > 0 };
  }

  // ---- Avisos en vivo: qué conversaciones tuvieron mensajes o acciones del equipo después de los números de orden
  // dados. Recorre las claves primarias de messages y operation_events, no datos de clientes.
  function cursors() {
    return {
      message: db.prepare('SELECT COALESCE(MAX(seq), 0) n FROM messages').get().n,
      operation: db.prepare('SELECT COALESCE(MAX(seq), 0) n FROM operation_events').get().n,
    };
  }
  function changesSince(seen, limit = 500) {
    const messages = db
      .prepare(
        `SELECT m.seq, m.conversation_id, c.brand_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.seq > ? ORDER BY m.seq LIMIT ?`,
      )
      .all(seen.message, limit)
      .map(plain);
    const operations = db
      .prepare(
        `SELECT seq, conversation_id, brand_id FROM operation_events
         WHERE seq > ? AND conversation_id IS NOT NULL ORDER BY seq LIMIT ?`,
      )
      .all(seen.operation, limit)
      .map(plain);
    const lastOperation = db
      .prepare(
        'SELECT COALESCE(MAX(seq), ?) n FROM (SELECT seq FROM operation_events WHERE seq > ? ORDER BY seq LIMIT ?)',
      )
      .get(seen.operation, seen.operation, limit).n;
    return {
      changes: [...messages, ...operations],
      seen: { message: messages.at(-1)?.seq ?? seen.message, operation: lastOperation },
    };
  }

  // ---- Opciones del constructor de filtros: sólo lo de las marcas permitidas.
  function options(brandIds) {
    if (!brandIds.length) return { brands: [], courses: [], tags: [], assignees: [], numbers: [] };
    const scope = marks(brandIds.length);
    const all = (sql, ...args) =>
      db
        .prepare(sql)
        .all(...args)
        .map(plain);
    return {
      brands: all(`SELECT id, name FROM brands WHERE id IN (${scope}) ORDER BY created_at, id`, ...brandIds),
      courses: all(
        `SELECT id, title, brand_id FROM courses WHERE brand_id IN (${scope}) ORDER BY title LIMIT 500`,
        ...brandIds,
      ),
      tags: all(
        `SELECT id, name, color, brand_id FROM contact_tags WHERE brand_id IN (${scope}) ORDER BY name LIMIT 500`,
        ...brandIds,
      ),
      // Quien puede ser responsable en esas marcas: administración y el equipo de cada una.
      assignees: all(
        `SELECT DISTINCT u.id, u.name FROM users u LEFT JOIN brand_members m ON m.user_id = u.id
         WHERE u.disabled = 0 AND (u.role = 'admin' OR (u.role = 'agent' AND m.brand_id IN (${scope})))
         ORDER BY u.name LIMIT 500`,
        ...brandIds,
      ),
      numbers: all(
        `SELECT phone_number_id id, label, brand_id FROM wa_numbers WHERE brand_id IN (${scope}) ORDER BY label LIMIT 100`,
        ...brandIds,
      ),
    };
  }

  // ---- Vistas guardadas

  const viewColumns = `v.id, v.owner_id, v.brand_id, v.name, v.base, v.filter, v.sort, v.visibility, v.revision,
    v.client_ref, v.last_ref, v.archived_at, v.created_at, v.updated_at, u.name owner_name, b.name brand_name`;
  const viewFrom = 'FROM inbox_views v JOIN users u ON u.id = v.owner_id LEFT JOIN brands b ON b.id = v.brand_id';

  // Las que ve una persona: las suyas (de sus marcas o sin marca) y las compartidas de sus marcas.
  function viewsFor(brandIds, ownerId) {
    const scope = brandIds.length ? marks(brandIds.length) : "''";
    return db
      .prepare(
        `SELECT ${viewColumns} ${viewFrom}
         WHERE v.archived_at IS NULL AND (
           (v.owner_id = ? AND (v.brand_id IS NULL OR v.brand_id IN (${scope})))
           OR (v.visibility != 'me' AND v.brand_id IN (${scope})))
         ORDER BY v.created_at, v.id`,
      )
      .all(ownerId, ...brandIds, ...brandIds)
      .map(plain);
  }
  const viewById = (brandIds, id) => {
    const view = db.prepare(`SELECT ${viewColumns} ${viewFrom} WHERE v.id = ?`).get(id);
    if (!view) return null;
    // Una vista con marca sólo existe para quien tiene esa marca; una personal sin marca, sólo para su dueño (lo
    // comprueba el módulo).
    if (view.brand_id && !brandIds.includes(view.brand_id)) return null;
    return plain(view);
  };
  const viewByRef = (ownerId, clientRef) =>
    plain(
      db.prepare(`SELECT ${viewColumns} ${viewFrom} WHERE v.owner_id = ? AND v.client_ref = ?`).get(ownerId, clientRef),
    );
  const countOwn = ownerId =>
    db
      .prepare("SELECT count(*) n FROM inbox_views WHERE owner_id = ? AND archived_at IS NULL AND visibility = 'me'")
      .get(ownerId).n;
  const countShared = brandId =>
    db
      .prepare("SELECT count(*) n FROM inbox_views WHERE brand_id = ? AND archived_at IS NULL AND visibility != 'me'")
      .get(brandId).n;

  function createView(brandId, ownerId, view, at) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO inbox_views(id, owner_id, brand_id, name, base, filter, sort, visibility, client_ref, created_at,
         updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      ownerId,
      brandId,
      view.name,
      view.base,
      JSON.stringify(view.filter),
      view.sort,
      view.visibility,
      view.clientRef ?? null,
      at,
      at,
      ownerId,
    );
    return id;
  }

  // Cambia una vista si su revisión sigue siendo `expected`. Devuelve false si otra persona la cambió antes.
  function updateView(brandId, id, expected, view, actorId, ref, at) {
    return (
      db
        .prepare(
          `UPDATE inbox_views SET brand_id = ?, name = ?, base = ?, filter = ?, sort = ?, visibility = ?, last_ref = ?,
             revision = revision + 1, updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ? AND archived_at IS NULL`,
        )
        .run(
          brandId,
          view.name,
          view.base,
          JSON.stringify(view.filter),
          view.sort,
          view.visibility,
          ref ?? null,
          at,
          actorId,
          id,
          expected,
        ).changes === 1
    );
  }
  function archiveView(brandId, id, expected, actorId, at) {
    return (
      db
        .prepare(
          `UPDATE inbox_views SET archived_at = ?, revision = revision + 1, updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ? AND archived_at IS NULL`,
        )
        .run(at, at, actorId, id, expected).changes === 1
    );
  }

  // El predicado SQL de un filtro ya validado.
  const compileFilter = (definition, now) => compile(definition, CONVERSATION_FIELDS, { now });

  return {
    page,
    count,
    rows,
    searchPeople,
    searchCourses,
    searchMessages,
    cursors,
    changesSince,
    options,
    viewsFor,
    viewById,
    viewByRef,
    countOwn,
    countShared,
    createView,
    updateView,
    archiveView,
    compileFilter,
  };
}

// La clave de búsqueda de un texto para comparar con name_key (la misma de los disparadores de contact_search).
export const nameWords = text => searchKey(text).split(/\s+/).filter(Boolean).slice(0, 8);
