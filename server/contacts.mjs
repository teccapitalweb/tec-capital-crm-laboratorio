import { randomUUID, createHash } from 'node:crypto';
import { transaction } from './database.mjs';
import { cancelConversationSteps } from './automation.mjs';
import { phoneKey } from './lib/identity-keys.mjs';
import { createPersonData, moveRows } from './lib/person-data.mjs';
import { withStatementCache } from './lib/statement-cache.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const norm = v =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
const text = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
export const COLORS = ['neutral', 'blue', 'green', 'amber', 'red', 'violet'];
const MAX_TAGS_PER_BRAND = 100,
  MAX_TAGS_PER_CONTACT = 12,
  MAX_EXPORT = 20000;
const closed = s => ['ganada', 'perdida'].includes(s);

// Neutraliza fórmulas de hoja de cálculo (=, +, -, @) y escapa comillas, comas y saltos de línea.
export const csvCell = v => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",;\t\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}; // ; y tabulador también fuerzan comillas: una hoja con otro separador no debe partir la celda
export const csvLine = cells => cells.map(csvCell).join(',');

export function createContacts({
  db,
  crm,
  body,
  json,
  audit,
  broadcast,
  events = null,
  persons = null,
  personData = null,
  now = Date.now,
}) {
  // Cada sentencia se prepara una vez (server/lib/statement-cache.mjs): una importación llama aquí miles de veces.
  db = withStatementCache(db);
  // Registro de tablas ligadas a la persona (server/lib/person-data.mjs). Sin él (pruebas con esquema parcial) se usa
  // uno propio con sólo las tablas de este módulo.
  const registry = personData ?? createPersonData({ db });
  const requireAdmin = user => {
    const u = db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if (!u || u.disabled || u.role !== 'admin') throw fail(403, 'Esta acción requiere un administrador.');
  };
  const requireStaff = user => {
    const u = db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if (!u || u.disabled || !['admin', 'agent'].includes(u.role))
      throw fail(403, 'Esta acción es para el equipo de atención.');
  };
  const contactOf = (id, user) => {
    const c = typeof id === 'string' ? db.prepare('SELECT * FROM contacts WHERE id=?').get(id) : null;
    if (!c) throw fail(404, 'Contacto no disponible.');
    crm.requireBrand(user, c.brand_id);
    return c;
  };
  const tagOf = (id, user) => {
    const t = typeof id === 'string' ? db.prepare('SELECT * FROM contact_tags WHERE id=?').get(id) : null;
    if (!t) throw fail(404, 'Etiqueta no disponible.');
    crm.requireBrand(user, t.brand_id);
    return t;
  };
  const changed = brand => broadcast('crm', null, { brandId: brand });

  // ---- etiquetas
  function listTags(user) {
    const ids = crm.brandsFor(user).map(b => b.id),
      q = ids.map(() => '?').join(',') || 'NULL';
    const tags = db
      .prepare(
        `SELECT t.id,t.brand_id,t.name,t.color,(SELECT count(*) FROM contact_tag_links l WHERE l.tag_id=t.id) count FROM contact_tags t WHERE t.brand_id IN (${q}) ORDER BY t.name_key`,
      )
      .all(...ids);
    const links = {};
    for (const l of db
      .prepare(
        `SELECT l.contact_id,l.tag_id FROM contact_tag_links l JOIN contacts c ON c.id=l.contact_id WHERE c.brand_id IN (${q})`,
      )
      .all(...ids))
      (links[l.contact_id] ||= []).push(l.tag_id);
    return { tags, links, colors: COLORS };
  }
  function createTag(user, input) {
    requireStaff(user);
    const brandId = input.brandId;
    if (typeof brandId !== 'string' || !db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))
      throw fail(404, 'Marca no disponible.');
    crm.requireBrand(user, brandId);
    const name = text(input.name, 30),
      color = input.color || 'neutral';
    if (name.length < 1) throw fail(400, 'Escribe el nombre de la etiqueta.');
    if (!COLORS.includes(color)) throw fail(400, 'Color no válido.');
    return transaction(db, () => {
      if (db.prepare('SELECT count(*) n FROM contact_tags WHERE brand_id=?').get(brandId).n >= MAX_TAGS_PER_BRAND)
        throw fail(409, 'Esta marca ya tiene el máximo de etiquetas.');
      const key = norm(name);
      if (db.prepare('SELECT 1 FROM contact_tags WHERE brand_id=? AND name_key=?').get(brandId, key))
        throw fail(409, 'Ya existe una etiqueta con ese nombre.');
      const id = randomUUID();
      db.prepare(
        'INSERT INTO contact_tags(id,brand_id,name,name_key,color,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
      ).run(id, brandId, name, key, color, user.id, now());
      return { id, brand_id: brandId, name, color, count: 0 };
    });
  }
  function updateTag(user, id, input) {
    requireAdmin(user);
    const t = tagOf(id, user),
      name = input.name === undefined ? t.name : text(input.name, 30),
      color = input.color === undefined ? t.color : input.color;
    if (name.length < 1) throw fail(400, 'Escribe el nombre de la etiqueta.');
    if (!COLORS.includes(color)) throw fail(400, 'Color no válido.');
    const key = norm(name);
    if (db.prepare('SELECT 1 FROM contact_tags WHERE brand_id=? AND name_key=? AND id!=?').get(t.brand_id, key, t.id))
      throw fail(409, 'Ya existe una etiqueta con ese nombre.');
    db.prepare('UPDATE contact_tags SET name=?,name_key=?,color=? WHERE id=?').run(name, key, color, t.id);
    return { id: t.id, brand_id: t.brand_id, name, color };
  }
  function deleteTag(user, id) {
    requireAdmin(user);
    const t = tagOf(id, user);
    transaction(db, () => {
      db.prepare('DELETE FROM contact_tag_links WHERE tag_id=?').run(t.id);
      db.prepare('DELETE FROM contact_tags WHERE id=?').run(t.id);
    });
    return t;
  }
  function setContactTags(user, contactId, input) {
    requireStaff(user);
    const c = contactOf(contactId, user);
    if (!Array.isArray(input.tagIds)) throw fail(400, 'Indica tagIds.');
    const ids = [...new Set(input.tagIds)];
    if (ids.length > MAX_TAGS_PER_CONTACT)
      throw fail(400, 'Máximo ' + MAX_TAGS_PER_CONTACT + ' etiquetas por contacto.');
    return transaction(db, () => {
      for (const id of ids) {
        const t = typeof id === 'string' ? db.prepare('SELECT brand_id FROM contact_tags WHERE id=?').get(id) : null;
        if (!t || t.brand_id !== c.brand_id) throw fail(400, 'Etiqueta no válida para la marca del contacto.');
      }
      db.prepare('DELETE FROM contact_tag_links WHERE contact_id=?').run(c.id);
      for (const id of ids)
        db.prepare('INSERT INTO contact_tag_links(contact_id,tag_id,created_by,created_at) VALUES(?,?,?,?)').run(
          c.id,
          id,
          user.id,
          now(),
        );
      return ids;
    });
  }
  // Etiquetas componibles (conciliación técnica, fila 17): para la importación y, después, la API y las difusiones.
  // Sin transacción propia, sin permisos (los comprueba quien llama) y sin avisos: una importación no publica un
  // evento por contacto. `ensureTag` devuelve la etiqueta de ese nombre en la marca, creándola si falta.
  function ensureTag(brandId, name, actorId = null) {
    const clean = text(name, 30);
    if (!clean) throw Object.assign(fail(400, 'La etiqueta no tiene nombre.'), { code: 'tag_invalid' });
    const key = norm(clean);
    const found = db.prepare('SELECT id,name FROM contact_tags WHERE brand_id=? AND name_key=?').get(brandId, key);
    if (found) return { id: found.id, name: found.name, created: false };
    if (db.prepare('SELECT count(*) n FROM contact_tags WHERE brand_id=?').get(brandId).n >= MAX_TAGS_PER_BRAND)
      throw Object.assign(fail(409, 'Esta marca ya tiene el máximo de etiquetas (' + MAX_TAGS_PER_BRAND + ').'), {
        code: 'tag_limit',
      });
    const id = randomUUID();
    db.prepare(
      "INSERT INTO contact_tags(id,brand_id,name,name_key,color,created_by,created_at) VALUES(?,?,?,?,'neutral',?,?)",
    ).run(id, brandId, clean, key, actorId, now());
    return { id, name: clean, created: true };
  }
  // Devuelven true si cambiaron algo. La etiqueta debe ser de la marca del contacto.
  function addTag(contactId, tagId, actorId = null) {
    const ok = db
      .prepare('SELECT 1 FROM contacts c JOIN contact_tags t ON t.brand_id=c.brand_id WHERE c.id=? AND t.id=?')
      .get(contactId, tagId);
    if (!ok) throw Object.assign(fail(400, 'Etiqueta no válida para la marca del contacto.'), { code: 'tag_invalid' });
    if (db.prepare('SELECT 1 FROM contact_tag_links WHERE contact_id=? AND tag_id=?').get(contactId, tagId))
      return false;
    if (
      db.prepare('SELECT count(*) n FROM contact_tag_links WHERE contact_id=?').get(contactId).n >= MAX_TAGS_PER_CONTACT
    )
      throw Object.assign(fail(400, 'Máximo ' + MAX_TAGS_PER_CONTACT + ' etiquetas por contacto.'), {
        code: 'tag_limit',
      });
    db.prepare('INSERT INTO contact_tag_links(contact_id,tag_id,created_by,created_at) VALUES(?,?,?,?)').run(
      contactId,
      tagId,
      actorId,
      now(),
    );
    return true;
  }
  const removeTag = (contactId, tagId) =>
    db.prepare('DELETE FROM contact_tag_links WHERE contact_id=? AND tag_id=?').run(contactId, tagId).changes > 0;

  // ---- consentimiento y baja
  const STATUS = ['unknown', 'opted_in', 'opted_out'];
  const consentOf = id =>
    db.prepare('SELECT status,source,note,actor_id,updated_at FROM contact_consent WHERE contact_id=?').get(id) || {
      status: 'unknown',
      source: null,
      note: '',
      actor_id: null,
      updated_at: null,
    };
  const conversationsOf = id =>
    db
      .prepare(
        'SELECT co.conversation_id id FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE o.contact_id=?',
      )
      .all(id)
      .map(r => r.id);
  // El consentimiento es de la persona (bloque 2.2): se escribe en la persona y se proyecta a todos sus contactos.
  // Sin módulo de personas (pruebas unitarias con esquema parcial) se conserva el registro por contacto.
  function localConsent(c, status, source, note, actor) {
    const t = now();
    db.prepare(
      'INSERT INTO contact_consent(contact_id,brand_id,status,source,note,actor_id,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(contact_id) DO UPDATE SET status=excluded.status,source=excluded.source,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at',
    ).run(c.id, c.brand_id, status, source, note, actor, t);
    db.prepare(
      'INSERT INTO contact_consent_events(contact_id,brand_id,status,source,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(c.id, c.brand_id, status, source, note, actor, t);
    if (status === 'opted_out') {
      for (const id of conversationsOf(c.id)) cancelConversationSteps(db, id, 'contact_opted_out', t);
      events?.publish({
        type: 'baja.registrada',
        brandId: c.brand_id,
        entityKind: 'contact',
        entityId: c.id,
        payload: { source, note: String(note || '').slice(0, 120) },
        actorId: actor || null,
        source: 'consent',
        dedupeKey: 'baja.registrada:' + c.id + ':' + t,
      });
    }
  }
  const writeConsent = (c, status, source, note, actor) =>
    persons
      ? persons.setConsentForContact(c, status, source, note, actor)
      : localConsent(c, status, source, note, actor);
  function setConsent(user, contactId, input) {
    requireStaff(user);
    const c = contactOf(contactId, user),
      status = input.status,
      note = text(input.note, 200);
    if (!STATUS.includes(status)) throw fail(400, 'Estado de consentimiento no válido.');
    return transaction(db, () => {
      const current = consentOf(c.id);
      if (current.status === status) return { ...current, unchanged: true };
      if (current.status === 'opted_out') {
        requireAdmin(user);
        if (note.length < 5)
          throw fail(
            400,
            'Para reactivar a un contacto que pidió la baja, administración debe explicar el motivo (mínimo 5 caracteres).',
          );
      }
      writeConsent(c, status, 'staff', note, user.id);
      return consentOf(c.id);
    });
  }
  // Baja pedida por el propio cliente en un mensaje: frases claras y cortas, nunca fragmentos de textos largos.
  const OPT_OUT = [
    /^(baja|stop|unsubscribe|no mas mensajes|no mas)$/,
    /\b(darme|darnos|dame) de baja\b/,
    /\bno (quiero|deseo|queremos) (recibir|mas)( mas)? (mensajes|informacion|promociones|publicidad|correos|notificaciones)\b/,
    /\b(deja|dejen|dejar|dejes) de (escribir|enviar|mandar)(me|nos)?\b/,
    /\bno me (escriban|envien|manden|contacten|llamen)( mas)?\b/,
  ];
  const isOptOutText = t => {
    const s = norm(t)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > 0 && s.length <= 120 && OPT_OUT.some(r => r.test(s));
  };
  function recordInbound(conversation, messageText) {
    if (!isOptOutText(messageText)) return false;
    const link = db
      .prepare(
        'SELECT o.contact_id FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id=?',
      )
      .get(conversation.id);
    if (!link) return false;
    const c = db.prepare('SELECT * FROM contacts WHERE id=?').get(link.contact_id);
    if (!c || consentOf(c.id).status === 'opted_out') return false;
    writeConsent(c, 'opted_out', 'customer_message', 'Mensaje del cliente: «' + text(messageText, 60) + '»', null);
    changed(c.brand_id);
    return true;
  }
  const consentLabel = { unknown: 'sin_registro', opted_in: 'acepta', opted_out: 'no_desea' };

  // ---- duplicados
  const summary = c => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    linked: Boolean(c.source_user_id),
    created_at: c.created_at,
    opportunities: db.prepare('SELECT count(*) n FROM opportunities WHERE contact_id=?').get(c.id).n,
    notes: db.prepare('SELECT count(*) n FROM internal_notes WHERE contact_id=?').get(c.id).n,
  });
  function duplicates(user, brandId) {
    requireStaff(user);
    if (typeof brandId !== 'string' || !db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))
      throw fail(404, 'Marca no disponible.');
    crm.requireBrand(user, brandId);
    const rows = db.prepare('SELECT * FROM contacts WHERE brand_id=?').all(brandId),
      groups = [];
    const by = (reason, keyFn) => {
      const map = new Map();
      for (const c of rows) {
        const k = keyFn(c);
        if (k) (map.get(k) || map.set(k, []).get(k)).push(c);
      }
      for (const list of map.values()) if (list.length > 1) groups.push({ reason, contacts: list.map(summary) });
    };
    by('phone', c => c.phone_key); // la clave canónica: el mismo número escrito de cualquier forma, y sólo ese número
    by('email', c => norm(c.email));
    by('name', c => {
      const n = norm(c.name);
      return n.includes(' ') ? n : '';
    });
    return groups.slice(0, 100);
  }

  // ---- fusión
  function plan(keepId, mergeId, user) {
    requireAdmin(user);
    if (keepId === mergeId) throw fail(400, 'Elige dos contactos distintos.');
    const keep = contactOf(keepId, user),
      merge = contactOf(mergeId, user);
    if (keep.brand_id !== merge.brand_id) throw fail(400, 'Sólo se pueden fusionar contactos de la misma marca.');
    const problems = problemsOf(keep, merge);
    const moves = movesOf(keep, merge);
    const linked = registry.count(merge.id);
    const fill = { phone: !keep.phone && Boolean(merge.phone), email: !keep.email && Boolean(merge.email) };
    const token = createHash('sha256')
      .update(
        JSON.stringify([
          keep.id,
          keep.updated_at,
          keep.phone,
          keep.email,
          merge.id,
          merge.updated_at,
          merge.phone,
          merge.email,
          moves,
          db.prepare('SELECT max(updated_at) m FROM opportunities WHERE contact_id IN (?,?)').get(keep.id, merge.id).m,
          linked,
        ]),
      )
      .digest('hex');
    return { keep, merge, moves, linked, fill, problems, previewToken: token };
  }
  // Por qué no se puede fusionar (vacío si se puede). Lo usan la vista previa y la fusión interna.
  function problemsOf(keep, merge) {
    const problems = [];
    if (merge.source_user_id && keep.source_user_id)
      problems.push('Los dos contactos están vinculados a perfiles distintos; no se pueden fusionar.');
    if (merge.source_user_id && !keep.source_user_id)
      problems.push(
        'El contacto que se une está vinculado a un perfil: elígelo como principal para no perder su vínculo.',
      );
    const keepActive = db
      .prepare('SELECT * FROM opportunities WHERE contact_id=?')
      .all(keep.id)
      .filter(o => !closed(o.stage));
    for (const o of db.prepare('SELECT * FROM opportunities WHERE contact_id=?').all(merge.id))
      if (!closed(o.stage) && keepActive.some(k => k.course_id === o.course_id && k.edition_id === o.edition_id))
        problems.push('Ambos tienen un interés activo en el mismo curso y edición. Cierra uno antes de fusionar.');
    return problems;
  }
  const movesOf = (keep, merge) => ({
    opportunities: db.prepare('SELECT count(*) n FROM opportunities WHERE contact_id=?').get(merge.id).n,
    notes: db.prepare('SELECT count(*) n FROM internal_notes WHERE contact_id=?').get(merge.id).n,
    tags: db
      .prepare(
        'SELECT count(*) n FROM contact_tag_links WHERE contact_id=? AND tag_id NOT IN (SELECT tag_id FROM contact_tag_links WHERE contact_id=?)',
      )
      .get(merge.id, keep.id).n,
  });
  const publicPlan = p => ({
    keep: summary(p.keep),
    merge: summary(p.merge),
    moves: p.moves,
    linked: p.linked,
    fill: p.fill,
    problems: p.problems,
    canMerge: p.problems.length === 0,
    previewToken: p.previewToken,
  });
  function applyMerge(user, input) {
    return transaction(db, () => {
      const p = plan(input.keepId, input.mergeId, user);
      if (p.problems.length) throw fail(409, p.problems[0]);
      if (input.previewToken !== p.previewToken)
        throw fail(409, 'Los contactos cambiaron desde la vista previa. Vuelve a revisarlos.');
      return mergeInternal(p.keep.id, p.merge.id, { user, reason: 'manual' });
    });
  }

  // Lo que este módulo declara en el registro: intereses, notas, etiquetas y consentimiento del contacto. La regla del
  // consentimiento más restrictivo se aplica en mergeInternal antes de mover su historial.
  registry.register({
    name: 'contacts',
    tables: ['opportunities', 'internal_notes', 'contact_tag_links', 'contact_consent', 'contact_consent_events'],
    merge(keepId, mergedId) {
      const opportunities = moveRows(db, 'opportunities', 'contact_id', keepId, mergedId);
      const notes = moveRows(db, 'internal_notes', 'contact_id', keepId, mergedId);
      const tags = Number(
        db
          .prepare(
            'INSERT OR IGNORE INTO contact_tag_links(contact_id,tag_id,created_by,created_at) SELECT ?,tag_id,created_by,created_at FROM contact_tag_links WHERE contact_id=?',
          )
          .run(keepId, mergedId).changes,
      );
      db.prepare('DELETE FROM contact_tag_links WHERE contact_id=?').run(mergedId);
      const consent = moveRows(db, 'contact_consent_events', 'contact_id', keepId, mergedId);
      db.prepare('DELETE FROM contact_consent WHERE contact_id=?').run(mergedId);
      return {
        opportunities,
        internal_notes: notes,
        contact_tag_links: tags,
        contact_consent_events: consent,
      };
    },
  });

  // Fusión interna (docs/PLAN_FUSION_Y_DATOS_DE_PERSONA.md): une `mergedId` en `keepId` moviendo TODAS las tablas
  // registradas en personData y borra el contacto absorbido. Componible: no abre transacción ni comprueba permisos
  // (lo hace quien llama: la fusión manual, una fusión automática o una importación). Aplica las mismas reglas de
  // seguridad que la vista previa. Repetirla con un contacto ya absorbido devuelve la fusión anterior.
  //   opciones: user (quien fusiona; null en una fusión automática) y reason ('manual', 'auto'…).
  function mergeInternal(keepId, mergedId, { user = null, reason = 'manual' } = {}) {
    const row = id => (typeof id === 'string' ? db.prepare('SELECT * FROM contacts WHERE id=?').get(id) : null);
    const keep = row(keepId),
      merge = row(mergedId);
    if (keep && !merge) {
      const previous = db
        .prepare('SELECT moved FROM contact_merges WHERE kept_id=? AND merged_id=? ORDER BY created_at DESC LIMIT 1')
        .get(keepId, mergedId);
      if (previous) return { keepId, mergedId, moved: JSON.parse(previous.moved), repeated: true };
    }
    if (!keep || !merge) throw fail(404, 'Contacto no disponible.');
    if (keep.id === merge.id) throw fail(400, 'Elige dos contactos distintos.');
    if (keep.brand_id !== merge.brand_id) throw fail(400, 'Sólo se pueden fusionar contactos de la misma marca.');
    const problems = problemsOf(keep, merge);
    if (problems.length) throw fail(409, problems[0]);
    const t = now(),
      actorId = user?.id ?? null,
      moves = movesOf(keep, merge),
      fill = { phone: !keep.phone && Boolean(merge.phone), email: !keep.email && Boolean(merge.email) };
    // El consentimiento resultante es el más restrictivo de los dos; se escribe antes de mover el historial.
    const ck = consentOf(keep.id),
      cm = consentOf(merge.id),
      rank = { unknown: 0, opted_in: 1, opted_out: 2 };
    if (rank[cm.status] > rank[ck.status])
      writeConsent(keep, cm.status, 'merge', 'Heredado al fusionar con «' + merge.name + '»', actorId);
    // El teléfono que se hereda llega con su clave (las dos condiciones miran el teléfono de antes de la sentencia).
    db.prepare(
      "UPDATE contacts SET phone=CASE WHEN phone='' THEN ? ELSE phone END,phone_key=CASE WHEN phone='' THEN ? ELSE phone_key END,email=CASE WHEN email='' THEN ? ELSE email END,updated_at=? WHERE id=?",
    ).run(merge.phone, phoneKey(merge.phone) ?? '', merge.email, t, keep.id);
    const linked = registry.mergeContacts(keep.id, merge.id, { keep, merge, user, actorId, reason, now: t });
    const moved = { ...moves, phone: fill.phone, email: fill.email, linked, reason };
    db.prepare(
      'INSERT INTO contact_merges(id,brand_id,kept_id,merged_id,merged_snapshot,moved,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(randomUUID(), keep.brand_id, keep.id, merge.id, JSON.stringify(merge), JSON.stringify(moved), actorId, t);
    // La nota necesita autor: una fusión automática queda sólo en contact_merges.
    if (actorId)
      db.prepare('INSERT INTO internal_notes VALUES(?,?,?,?,?,?)').run(
        randomUUID(),
        keep.id,
        keep.brand_id,
        actorId,
        'Fusión de contactos: se unió «' +
          merge.name +
          '»' +
          (merge.phone ? ' · ' + merge.phone : '') +
          (merge.email ? ' · ' + merge.email : '') +
          '. Se movieron ' +
          moves.opportunities +
          ' interés(es), ' +
          moves.notes +
          ' nota(s) y ' +
          moves.tags +
          ' etiqueta(s).',
        t,
      );
    db.prepare('DELETE FROM contacts WHERE id=?').run(merge.id);
    persons?.afterContactMerge(row(keep.id), merge.persona_id, user);
    return { keepId: keep.id, mergedId: merge.id, moved };
  }

  // ---- exportación (sólo administración; siempre dentro de las marcas autorizadas)
  function exportCsv(user, kind, params) {
    requireAdmin(user);
    const allowed = crm.brandsFor(user).map(b => b.id),
      brand = params.get('brand');
    if (brand && !allowed.includes(brand)) throw fail(404, 'Marca no disponible.');
    const ids = brand ? [brand] : allowed,
      q = ids.map(() => '?').join(',') || 'NULL',
      stamp = new Date(now())
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
    let lines, count;
    if (kind === 'contacts') {
      const tag = params.get('tag'),
        filter = tag ? ' AND c.id IN (SELECT contact_id FROM contact_tag_links WHERE tag_id=?)' : '';
      if (tag && !db.prepare(`SELECT 1 FROM contact_tags WHERE id=? AND brand_id IN (${q})`).get(tag, ...ids))
        throw fail(404, 'Etiqueta no disponible.');
      const rows = db
        .prepare(
          `SELECT c.*,b.name brand_name,(SELECT group_concat(t.name,'; ') FROM contact_tag_links l JOIN contact_tags t ON t.id=l.tag_id WHERE l.contact_id=c.id) tags,(SELECT count(*) FROM opportunities o WHERE o.contact_id=c.id AND o.stage NOT IN ('ganada','perdida')) active,(SELECT status FROM contact_consent k WHERE k.contact_id=c.id) consent FROM contacts c JOIN brands b ON b.id=c.brand_id WHERE c.brand_id IN (${q})${filter} ORDER BY b.name,c.name LIMIT ${MAX_EXPORT}`,
        )
        .all(...ids, ...(tag ? [tag] : []));
      count = rows.length;
      lines = [
        csvLine([
          'marca',
          'nombre',
          'telefono',
          'correo',
          'origen',
          'etiquetas',
          'intereses_activos',
          'creado',
          'actualizado',
          'consentimiento',
          'persona',
        ]),
        ...rows.map(r =>
          csvLine([
            r.brand_name,
            r.name,
            r.phone,
            r.email,
            r.source_user_id ? 'perfil' : 'manual',
            r.tags,
            r.active,
            new Date(r.created_at).toISOString(),
            new Date(r.updated_at).toISOString(),
            consentLabel[r.consent || 'unknown'],
            r.persona_id || '',
          ]),
        ),
      ];
    } else {
      const rows = db
        .prepare(
          `SELECT o.*,b.name brand_name,c.name contact_name,k.title course_title,e.name edition_name,e.price_cents,e.currency,u.name owner_name FROM opportunities o JOIN contacts c ON c.id=o.contact_id JOIN brands b ON b.id=o.brand_id JOIN courses k ON k.id=o.course_id LEFT JOIN editions e ON e.id=o.edition_id LEFT JOIN users u ON u.id=o.owner_id WHERE o.brand_id IN (${q}) ORDER BY b.name,o.updated_at DESC LIMIT ${MAX_EXPORT}`,
        )
        .all(...ids);
      count = rows.length;
      lines = [
        csvLine([
          'marca',
          'contacto',
          'curso',
          'edicion',
          'etapa',
          'responsable',
          'precio',
          'moneda',
          'motivo_perdida',
          'creada',
          'actualizada',
        ]),
        ...rows.map(r =>
          csvLine([
            r.brand_name,
            r.contact_name,
            r.course_title,
            r.edition_name,
            r.stage,
            r.owner_name,
            r.price_cents === null || r.price_cents === undefined ? '' : (r.price_cents / 100).toFixed(2),
            r.currency,
            r.lost_reason,
            new Date(r.created_at).toISOString(),
            new Date(r.updated_at).toISOString(),
          ]),
        ),
      ];
    }
    return {
      filename: `${kind === 'contacts' ? 'contactos' : 'oportunidades'}-${stamp}.csv`,
      csv: '\uFEFF' + lines.join('\r\n') + '\r\n',
      count,
    };
  }

  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/crm/')) return false;
    const url = new URL(req.url, 'http://localhost');
    let m;
    if (path === '/api/crm/tags') {
      if (req.method === 'GET') {
        requireStaff(user);
        json(res, 200, listTags(user));
        return true;
      }
      if (req.method === 'POST') {
        const tag = createTag(user, await body(req));
        audit(user, 'tag.created', tag.id);
        changed(tag.brand_id);
        json(res, 201, { tag });
        return true;
      }
    }
    if ((m = path.match(/^\/api\/crm\/tags\/([a-f0-9-]{36})$/))) {
      if (req.method === 'PATCH') {
        const tag = updateTag(user, m[1], await body(req));
        audit(user, 'tag.updated', tag.id);
        changed(tag.brand_id);
        json(res, 200, { tag });
        return true;
      }
      if (req.method === 'DELETE') {
        const tag = deleteTag(user, m[1]);
        audit(user, 'tag.deleted', tag.id);
        changed(tag.brand_id);
        json(res, 200, { ok: true });
        return true;
      }
    }
    if ((m = path.match(/^\/api\/crm\/contacts\/([a-f0-9-]{36})\/tags$/)) && req.method === 'PUT') {
      const c = contactOf(m[1], user),
        ids = setContactTags(user, m[1], await body(req));
      audit(user, 'contact.tags', c.id);
      changed(c.brand_id);
      json(res, 200, { tagIds: ids });
      return true;
    }
    if ((m = path.match(/^\/api\/crm\/contacts\/([a-f0-9-]{36})\/consent$/))) {
      if (req.method === 'GET') {
        requireStaff(user);
        const c = contactOf(m[1], user);
        json(res, 200, {
          consent: consentOf(c.id),
          history: db
            .prepare(
              'SELECT e.status,e.source,e.note,e.created_at,u.name actor_name FROM contact_consent_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.contact_id=? ORDER BY e.seq DESC LIMIT 20',
            )
            .all(c.id),
        });
        return true;
      }
      if (req.method === 'PUT') {
        requireStaff(user);
        const c = contactOf(m[1], user),
          r = setConsent(user, m[1], await body(req));
        audit(user, 'contact.consent', c.id);
        changed(c.brand_id);
        json(res, 200, { consent: r });
        return true;
      }
    }
    if (path === '/api/crm/duplicates' && req.method === 'GET') {
      json(res, 200, { groups: duplicates(user, url.searchParams.get('brand')) });
      return true;
    }
    if (path === '/api/crm/contacts/merge-preview' && req.method === 'POST') {
      const i = await body(req);
      json(res, 200, { plan: publicPlan(plan(i.keepId, i.mergeId, user)) });
      return true;
    }
    if (path === '/api/crm/contacts/merge' && req.method === 'POST') {
      const r = applyMerge(user, await body(req));
      audit(user, 'contact.merged', r.keepId);
      changed(db.prepare('SELECT brand_id FROM contacts WHERE id=?').get(r.keepId).brand_id);
      json(res, 200, r);
      return true;
    }
    if ((m = path.match(/^\/api\/crm\/export\/(contacts|opportunities)\.csv$/)) && req.method === 'GET') {
      const out = exportCsv(user, m[1], url.searchParams);
      audit(user, 'export.' + m[1], String(out.count));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${out.filename}"`,
        'Cache-Control': 'no-store',
      });
      res.end(out.csv);
      return true;
    }
    return false;
  }
  return {
    handle,
    isOptOutText,
    recordInbound,
    consentOf,
    setConsent,
    // Componibles (sin transacción ni permisos): importación de contactos y, después, la API de escritura.
    writeConsent,
    ensureTag,
    addTag,
    removeTag,
    listTags,
    createTag,
    updateTag,
    deleteTag,
    setContactTags,
    duplicates,
    plan,
    applyMerge,
    mergeInternal,
    exportCsv,
  };
}
