// Identidad por identificador de usuario de WhatsApp (docs/PLAN_IDENTIDAD_SIN_TELEFONO.md, incremento I-2).
//
// Meta ya entrega personas que escriben sin teléfono visible: sólo un identificador de usuario propio de la cuenta de
// negocio («BSUID», p. ej. «MX.1349120865530274»). Aquí se decide quién es cada persona que escribe con lo que llegue
// (teléfono, identificador o los dos), se guardan sus llaves (`identity_keys`), se deja bitácora de cada vínculo
// (`identity_events`) y se lleva la ventana de 24 horas por persona y número (`wa_peer_state`).
//
// Regla de fondo (diseño §3.4): cuando llegan los dos, el identificador decide quién es y el teléfono se mueve con él;
// la única excepción es el cliente que todavía no tenía identificador (lo recibe).
//
// El identificador es un dato personal, como el teléfono: nunca va a registros, eventos ni respuestas completo; la
// bitácora guarda sólo sus últimos cuatro caracteres. Todo lo que escribe corre DENTRO de la transacción de quien
// llama (no abre otra ni hace red).
import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from '../app/http.mjs';
import { canonicalPhone, phoneKey } from './identity-keys.mjs';

export const KIND = Object.freeze({ phone: 'wa_phone', bsuid: 'wa_bsuid', parent: 'wa_parent_bsuid' });
const BSUID = /^[A-Z]{2}\.[A-Za-z0-9._-]{1,128}$/;
const PHONE = /^\d{7,20}$/;
const DAY = 86_400_000;
const CLOSED = "('ganada','perdida')";

// Forma documentada por Meta: dos letras de país, un punto y hasta 128 caracteres.
export const isBsuid = value => typeof value === 'string' && BSUID.test(value);
// Últimos cuatro caracteres: lo único que se enseña o se anota de un identificador.
export const hint = value => String(value ?? '').slice(-4);
const clip = (value, max) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f<>]/g, '')
        .trim()
        .slice(0, max)
    : '';

// Ámbito de un identificador: el portafolio de Meta si se conoce; si no, la cuenta de WhatsApp Business del número;
// si tampoco, el propio número (se re-etiqueta en cuanto el webhook trae la cuenta).
export function scopeOf(number) {
  if (!number) return '';
  if (number.business_id) return 'biz:' + number.business_id;
  if (number.waba_id) return 'waba:' + number.waba_id;
  return 'num:' + number.phone_number_id;
}

// Quién escribe, según el evento normalizado (contrato de canal 1.1, `peer.ids`; o los campos sueltos de 1.0).
export function peerOf(d) {
  const ids = Array.isArray(d?.peer?.ids) ? d.peer.ids : [];
  const pick = kind => String(ids.find(id => id?.kind === kind)?.value ?? '').trim();
  const phone = String(d?.from ?? '').replace(/\D/g, '') || pick(KIND.phone).replace(/\D/g, '');
  const bsuid = pick(KIND.bsuid) || String(d?.fromUserId ?? '').trim();
  const parent = pick(KIND.parent);
  return {
    phone: PHONE.test(phone) ? phone : '',
    bsuid: isBsuid(bsuid) ? bsuid : '',
    parent: isBsuid(parent) ? parent : '',
    username: clip(d?.peer?.username ?? d?.username, 80).replace(/^@/, ''),
    name: clip(d?.name ?? d?.peer?.name, 60),
  };
}

// Lo que se enseña en lugar del número cuando la persona no lo comparte.
export function displayOf({ phone = '', username = '', bsuid = '' } = {}) {
  if (phone) return '+' + phone;
  if (username) return '@' + username;
  if (bsuid) return 'Número oculto ··' + hint(bsuid);
  return '';
}

// Relleno de lo que ya existe (diseño §3.9), por trozos: los teléfonos de wa_identities pasan a identity_keys y
// wa_peer_state recibe el último mensaje de la persona en cada conversación real. Idempotente: repetir un trozo no
// cambia nada. Devuelve lo que pide el ejecutor de trabajos ({processed, cursor, finished}).
export function backfillStep(db, cursor, limit, now = Date.now()) {
  const at = cursor ?? { phase: 'keys', after: 0 };
  if (at.phase === 'keys') {
    const rows = db
      .prepare(
        'SELECT rowid AS r,wa_id,user_id,profile_name,created_at,last_seen FROM wa_identities WHERE rowid>? ORDER BY rowid LIMIT ?',
      )
      .all(at.after, limit);
    const owner = db.prepare("SELECT user_id FROM identity_keys WHERE kind='wa_phone' AND scope='' AND value=?");
    for (const row of rows) {
      const key = phoneKey(row.wa_id, { international: true });
      if (!key) continue;
      const found = owner.get(key);
      if (!found)
        db.prepare(
          "INSERT INTO identity_keys(kind,scope,value,user_id,wa_id,profile_name,source,phone_seen_at,first_seen,last_seen) VALUES('wa_phone','',?,?,?,?,'backfill',?,?,?)",
        ).run(key, row.user_id, row.wa_id, row.profile_name || '', row.last_seen, row.created_at, row.last_seen);
      else if (found.user_id !== row.user_id) {
        // dos clientes con el mismo teléfono escrito de dos formas («52…» y «521…»): se queda el más antiguo y el
        // otro queda anotado para revisión (una sola vez por par)
        const seen = db
          .prepare(
            "SELECT 1 FROM identity_events WHERE action='conflict' AND source='backfill' AND user_id=? AND other_user_id=?",
          )
          .get(row.user_id, found.user_id);
        if (!seen)
          db.prepare(
            "INSERT INTO identity_events(user_id,other_user_id,kind,action,hint,source,detail,created_at) VALUES(?,?,'wa_phone','conflict',?,'backfill','Mismo teléfono en dos clientes',?)",
          ).run(row.user_id, found.user_id, hint(key), now);
      }
    }
    if (rows.length < limit) return { processed: rows.length, cursor: { phase: 'peer', after: 0 } };
    return { processed: rows.length, cursor: { phase: 'keys', after: rows.at(-1).r } };
  }
  const rows = db
    .prepare(
      "SELECT c.rowid AS r,c.wa_number,c.customer_id,(SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id=c.id AND m.sender_kind='customer') l FROM conversations c WHERE c.wa_number IS NOT NULL AND c.rowid>? ORDER BY c.rowid LIMIT ?",
    )
    .all(at.after, limit);
  const upsert = db.prepare(
    'INSERT INTO wa_peer_state(phone_number_id,user_id,last_inbound_at) VALUES(?,?,?) ON CONFLICT(phone_number_id,user_id) DO UPDATE SET last_inbound_at=MAX(last_inbound_at,excluded.last_inbound_at)',
  );
  for (const row of rows) if (row.l) upsert.run(row.wa_number, row.customer_id, row.l);
  if (rows.length < limit) return { processed: rows.length, cursor: { phase: 'done', after: 0 }, finished: true };
  return { processed: rows.length, cursor: { phase: 'peer', after: rows.at(-1).r } };
}

export function createIdentity({ db, crm = null, now = Date.now }) {
  if (!db) throw new TypeError('createIdentity necesita { db }.');
  const statements = new Map();
  const q = sql => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  let contacts = null;
  // El módulo de identidad presta la fusión de contactos (server/contacts.mjs) cuando se crea; sin ella, lo que
  // necesitaría fusionar queda marcado para revisión.
  const use = services => {
    if (services?.contacts) contacts = services.contacts;
  };

  const keyOwner = (kind, scope, value) =>
    q('SELECT * FROM identity_keys WHERE kind=? AND scope=? AND value=?').get(kind, scope, value);
  const keyOf = (userId, kind, scope) =>
    q('SELECT * FROM identity_keys WHERE user_id=? AND kind=? AND scope=? ORDER BY last_seen DESC LIMIT 1').get(
      userId,
      kind,
      scope,
    );
  const numberRow = id => q('SELECT * FROM wa_numbers WHERE phone_number_id=?').get(String(id ?? ''));

  // Dueño de un teléfono: su llave canónica y, mientras el relleno no termina, el registro anterior (wa_identities),
  // también en la otra forma mexicana («52…» ↔ «521…»).
  function phoneOwner(waId) {
    // Un identificador que no se reconoce como teléfono no tiene llave: se sigue reconociendo tal como llegó.
    const key = phoneKey(waId, { international: true });
    const row = key ? keyOwner(KIND.phone, '', key) : null;
    if (row) return { key, userId: row.user_id };
    const forms = key ? [waId, key] : [waId];
    if (key && /^52\d{10}$/.test(key)) forms.push('521' + key.slice(2));
    for (const form of forms) {
      const legacy = q('SELECT user_id FROM wa_identities WHERE wa_id=?').get(form);
      if (legacy) return { key, userId: legacy.user_id };
    }
    return { key, userId: null };
  }

  // Qué caso de la tabla del diseño (§3.4) aplica. Sólo lee: lo usan la comprobación previa (¿hace falta crear un
  // cliente?) y resolve().
  function decide({ scope, phone, bsuid }) {
    const uB = bsuid ? (keyOwner(KIND.bsuid, scope, bsuid)?.user_id ?? null) : null;
    const owner = phone ? phoneOwner(phone) : { key: null, userId: null };
    const uP = owner.userId;
    const otherBsuid = uP && bsuid ? (keyOf(uP, KIND.bsuid, scope)?.value ?? null) : null;
    if (uB) {
      if (!phone || !uP) return { case: phone ? 3 : 2, userId: uB, key: owner.key };
      if (uP === uB) return { case: 2, userId: uB, key: owner.key };
      if (otherBsuid && otherBsuid !== bsuid) return { case: 8, userId: uB, from: uP, key: owner.key };
      return { case: 7, userId: uB, other: uP, key: owner.key };
    }
    if (uP) {
      if (!bsuid || !otherBsuid) return { case: bsuid ? 5 : 4, userId: uP, key: owner.key };
      return { case: 6, create: true, from: uP, key: owner.key };
    }
    return { case: bsuid ? 1 : 4, create: true, key: owner.key };
  }
  const needsUser = input => Boolean(decide(input).create);

  function event(userId, kind, action, value, source, { other = null, detail = '', t = now() } = {}) {
    q(
      'INSERT INTO identity_events(user_id,other_user_id,kind,action,hint,source,detail,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(userId, other, kind, action, value ? hint(value) : '', source, String(detail).slice(0, 200), t);
  }

  // Escribe o renueva una llave. Si era de otro cliente, pasa a éste (y queda anotado).
  function putKey(kind, scope, value, userId, { waId = null, username = '', profileName = '', source, t, fresh }) {
    const row = keyOwner(kind, scope, value);
    const phoneSeen = kind === KIND.phone ? t : null;
    if (!row) {
      q(
        'INSERT INTO identity_keys(kind,scope,value,user_id,wa_id,username,profile_name,source,phone_seen_at,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      ).run(kind, scope, value, userId, waId, username, profileName, source, phoneSeen, t, t);
      event(userId, kind, fresh ? 'added' : 'linked', value, source, { t });
      return;
    }
    if (row.user_id !== userId) {
      q('UPDATE identity_keys SET user_id=? WHERE kind=? AND scope=? AND value=?').run(userId, kind, scope, value);
      event(userId, kind, 'moved', value, source, { other: row.user_id, t });
    }
    q(
      "UPDATE identity_keys SET last_seen=?,wa_id=COALESCE(?,wa_id),username=CASE WHEN ?!='' THEN ? ELSE username END,profile_name=CASE WHEN ?!='' THEN ? ELSE profile_name END,phone_seen_at=COALESCE(?,phone_seen_at) WHERE kind=? AND scope=? AND value=?",
    ).run(t, waId, username, username, profileName, profileName, phoneSeen, kind, scope, value);
  }

  // wa_identities (v38) se sigue escribiendo para los clientes con teléfono: así una vuelta atrás del código sigue
  // reconociéndolos. Un cliente tiene a lo sumo una fila.
  function legacyPhone(waId, userId, name, t) {
    const row = q('SELECT user_id FROM wa_identities WHERE wa_id=?').get(waId);
    if (row && row.user_id !== userId) {
      if (q('SELECT 1 FROM wa_identities WHERE user_id=?').get(userId))
        q('DELETE FROM wa_identities WHERE wa_id=?').run(waId);
      else q('UPDATE wa_identities SET user_id=? WHERE wa_id=?').run(userId, waId);
    } else if (!row)
      q('INSERT OR IGNORE INTO wa_identities(wa_id,user_id,profile_name,created_at,last_seen) VALUES(?,?,?,?,?)').run(
        waId,
        userId,
        name,
        t,
        t,
      );
    q(
      "UPDATE wa_identities SET last_seen=?,profile_name=CASE WHEN ?!='' THEN ? ELSE profile_name END WHERE wa_id=?",
    ).run(t, name, name, waId);
  }

  function createUser(name, label, hash, t) {
    const id = randomUUID();
    const n = q('SELECT COALESCE(MAX(test_number),100000)+1 n FROM users').get().n;
    const shown = name.length >= 2 ? name : 'WhatsApp ··' + hint(label);
    q(
      'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
    ).run(id, 'wa-' + randomBytes(8).toString('hex'), shown, hash, 'customer', n, t, t);
    return id;
  }

  // El teléfono deja de ser de `userId` (pasó a otra cuenta de WhatsApp): sus conversaciones abiertas ya no le
  // escriben a ese número; si tiene identificador, se le escribe por él.
  function releasePhone(userId, key) {
    for (const c of q(
      "SELECT id,wa_peer FROM conversations WHERE customer_id=? AND wa_peer IS NOT NULL AND status!='resolved'",
    ).all(userId))
      if (phoneKey(c.wa_peer, { international: true }) === key)
        q('UPDATE conversations SET wa_peer=NULL WHERE id=?').run(c.id);
  }

  const contactsOf = userId => q('SELECT * FROM contacts WHERE source_user_id=?').all(userId);
  const overlap = (a, b) =>
    Boolean(
      q(
        `SELECT 1 FROM opportunities x JOIN opportunities y ON y.course_id=x.course_id AND y.edition_id IS x.edition_id WHERE x.contact_id=? AND y.contact_id=? AND x.stage NOT IN ${CLOSED} AND y.stage NOT IN ${CLOSED} LIMIT 1`,
      ).get(a, b),
    );

  // Candidatura «misma persona» entre las personas de dos contactos (o de dos clientes), para la pantalla de siempre.
  function candidate(personA, personB, detail, t) {
    if (!personA || !personB || personA === personB) return;
    const [a, b] = [personA, personB].sort();
    q(
      "INSERT OR IGNORE INTO person_candidates(id,person_a,person_b,reason,detail,status,created_at) VALUES(?,?,?,'identity_conflict',?,'pending',?)",
    ).run(randomUUID(), a, b, detail, t);
  }
  const personOfUser = (userId, brandId = null) =>
    (brandId
      ? q('SELECT persona_id FROM contacts WHERE source_user_id=? AND brand_id=? AND persona_id IS NOT NULL').get(
          userId,
          brandId,
        )?.persona_id
      : null) ||
    q('SELECT persona_id FROM contacts WHERE source_user_id=? AND persona_id IS NOT NULL LIMIT 1').get(userId)
      ?.persona_id ||
    q('SELECT id FROM persons WHERE source_user_id=?').get(userId)?.id ||
    null;

  // Fusión segura de clientes (diseño §3.5, caso 7): sobrevive el más antiguo. Devuelve el motivo si no es segura.
  function unsafeMerge(survivor, absorbed) {
    if (
      q(
        "SELECT 1 FROM conversations x JOIN conversations y ON y.course_id=x.course_id AND y.edition_id IS x.edition_id AND y.channel=x.channel WHERE x.customer_id=? AND y.customer_id=? AND x.status!='resolved' AND y.status!='resolved' LIMIT 1",
      ).get(survivor, absorbed)
    )
      return 'Los dos tienen una conversación abierta del mismo curso.';
    if (
      q(
        `SELECT 1 FROM identity_keys x JOIN identity_keys y ON y.kind=x.kind AND y.scope=x.scope AND y.value!=x.value WHERE x.user_id=? AND y.user_id=? AND x.kind='${KIND.bsuid}' LIMIT 1`,
      ).get(survivor, absorbed)
    )
      return 'Cada uno conserva su propio identificador de WhatsApp.';
    const kept = new Map(contactsOf(survivor).map(c => [c.brand_id, c]));
    for (const c of contactsOf(absorbed)) {
      const k = kept.get(c.brand_id);
      if (!k) continue;
      if (!contacts) return 'La fusión de contactos no está disponible.';
      if (overlap(k.id, c.id)) return 'Los dos tienen un interés activo en el mismo curso y edición.';
    }
    return null;
  }
  function mergeUsers(a, b, { source, t }) {
    const [survivor, absorbed] = q('SELECT id FROM users WHERE id IN (?,?) ORDER BY created_at,id')
      .all(a, b)
      .map(r => r.id);
    const why = unsafeMerge(survivor, absorbed);
    if (why) return { merged: false, reason: why };
    const kept = new Map(contactsOf(survivor).map(c => [c.brand_id, c]));
    for (const c of contactsOf(absorbed)) {
      const k = kept.get(c.brand_id);
      if (k) {
        // mismo cliente en la misma marca: un solo contacto, con la fusión interna de siempre
        q('UPDATE contacts SET source_user_id=NULL WHERE id=?').run(c.id);
        contacts.mergeInternal(k.id, c.id, { reason: 'identity' });
      } else {
        q('UPDATE contacts SET source_user_id=?,updated_at=? WHERE id=?').run(survivor, t, c.id);
        crm?.contactChanged(c.id);
      }
    }
    q('UPDATE conversations SET customer_id=? WHERE customer_id=?').run(survivor, absorbed);
    q('UPDATE messages SET sender_id=? WHERE sender_id=?').run(survivor, absorbed);
    q('UPDATE attachments SET owner_id=? WHERE owner_id=?').run(survivor, absorbed);
    q('UPDATE identity_keys SET user_id=? WHERE user_id=?').run(survivor, absorbed);
    q(
      'INSERT INTO wa_peer_state(phone_number_id,user_id,last_inbound_at) SELECT phone_number_id,?,last_inbound_at FROM wa_peer_state WHERE user_id=? ON CONFLICT(phone_number_id,user_id) DO UPDATE SET last_inbound_at=MAX(last_inbound_at,excluded.last_inbound_at)',
    ).run(survivor, absorbed);
    q('DELETE FROM wa_peer_state WHERE user_id=?').run(absorbed);
    if (q('SELECT 1 FROM wa_identities WHERE user_id=?').get(survivor))
      q('DELETE FROM wa_identities WHERE user_id=?').run(absorbed);
    else q('UPDATE wa_identities SET user_id=? WHERE user_id=?').run(survivor, absorbed);
    // El cliente absorbido no se borra (otras tablas guardan su id sin clave foránea): queda desactivado.
    q('UPDATE users SET disabled=1 WHERE id=?').run(absorbed);
    event(survivor, 'user', 'merged', '', source, {
      other: absorbed,
      detail: 'WhatsApp confirmó que es la misma persona',
      t,
    });
    return { merged: true, survivor, absorbed };
  }

  // La cuenta de Meta del número (entry.id del webhook) se aprende la primera vez; las llaves guardadas con el ámbito
  // provisional del número pasan al de la cuenta.
  function learnScope(number, account) {
    const waba = clip(String(account?.scopeId ?? ''), 60);
    if (!number || number.waba_id || !waba) return scopeOf(number);
    const before = scopeOf(number);
    q('UPDATE wa_numbers SET waba_id=? WHERE phone_number_id=? AND waba_id IS NULL').run(waba, number.phone_number_id);
    const after = scopeOf({ ...number, waba_id: waba });
    if (!number.business_id) q('UPDATE OR IGNORE identity_keys SET scope=? WHERE scope=?').run(after, before);
    return after;
  }
  const scopeFor = (number, account) =>
    number?.waba_id || number?.business_id || !account?.scopeId
      ? scopeOf(number)
      : scopeOf({ ...number, waba_id: clip(String(account.scopeId), 60) });

  // ---- Resolver quién escribe (diseño §3.4). Dentro de la transacción del entrante. `hash`: contraseña inutilizable
  // ya calculada fuera de la transacción, por si hay que crear un cliente. Devuelve {userId, created, case, phone}:
  // `phone` es el teléfono con el que se completan sus contactos, o null si no se debe usar (conflicto).
  function resolve({ number, account = null, phone = '', bsuid = '', parent = '', username = '', name = '', hash }) {
    const t = now(),
      source = 'webhook';
    const scope = learnScope(number, account);
    const d = decide({ scope, phone, bsuid });
    let userId = d.userId ?? null,
      created = false,
      usePhone = Boolean(phone);
    if (d.create) {
      if (!hash) throw fail(503, 'Identidad en creación; reintentar.');
      userId = createUser(name, phone || bsuid, hash, t);
      created = true;
    }
    if (d.case === 7) {
      const r = mergeUsers(d.userId, d.other, { source, t });
      if (r.merged) userId = r.survivor;
      else {
        // no es seguro: el identificador decide, el teléfono se queda con quien lo tenía y queda para revisión
        usePhone = false;
        event(d.userId, KIND.phone, 'conflict', d.key, source, { other: d.other, detail: r.reason, t });
        candidate(
          personOfUser(d.userId, number?.brand_id),
          personOfUser(d.other, number?.brand_id),
          'Mismo WhatsApp: identificador y teléfono en dos clientes',
          t,
        );
      }
    }
    if ((d.case === 6 || d.case === 8) && d.from && d.key) releasePhone(d.from, d.key);
    if (usePhone) {
      if (d.key) putKey(KIND.phone, '', d.key, userId, { waId: phone, profileName: name, source, t, fresh: created });
      legacyPhone(phone, userId, name, t);
    }
    if (bsuid) putKey(KIND.bsuid, scope, bsuid, userId, { username, profileName: name, source, t, fresh: created });
    if (parent) putKey(KIND.parent, scope, parent, userId, { source, t, fresh: created });
    q('UPDATE users SET last_seen=? WHERE id=?').run(t, userId);
    return { userId, created, case: d.case, scope, phone: usePhone ? phone : null };
  }

  // Contacto de la marca que se adopta (diseño §3.5): el cliente todavía no tiene contacto en la marca y hay uno con
  // su mismo teléfono que no es de nadie. El de modificación más reciente.
  function adoptable(brandId, userId, phone) {
    const key = phone ? phoneKey(phone, { international: true }) : null;
    if (!key || q('SELECT 1 FROM contacts WHERE source_user_id=? AND brand_id=?').get(userId, brandId)) return null;
    return (
      q(
        'SELECT id FROM contacts WHERE brand_id=? AND phone_key=? AND source_user_id IS NULL ORDER BY updated_at DESC,id LIMIT 1',
      ).get(brandId, key)?.id ?? null
    );
  }

  // Completa los contactos del cliente en la marca (diseño §3.5, «el teléfono apareció»): teléfono canónico y su
  // clave, `wa_peer` en sus conversaciones reales abiertas y, si otro contacto de la marca ya tenía ese teléfono, la
  // fusión segura (o, si no es segura, una candidatura). Nunca toca otra marca.
  function completeContacts(userId, brandId, phone) {
    const t = now();
    if (!phone) {
      q(
        "UPDATE contacts SET source='whatsapp' WHERE source_user_id=? AND brand_id=? AND source='laboratorio' AND phone=''",
      ).run(userId, brandId);
      return { filled: 0, merged: 0 };
    }
    const p = canonicalPhone(phone, { international: true });
    const e164 = p.e164 ?? '+' + phone,
      key = p.key ?? '';
    let filled = 0,
      merged = 0;
    for (const c of q("SELECT * FROM contacts WHERE source_user_id=? AND brand_id=? AND phone=''").all(
      userId,
      brandId,
    )) {
      q("UPDATE contacts SET phone=?,phone_key=?,source='whatsapp',updated_at=? WHERE id=?").run(e164, key, t, c.id);
      crm?.contactChanged(c.id);
      filled++;
      if (!key) continue;
      for (const other of q(
        'SELECT * FROM contacts WHERE brand_id=? AND phone_key=? AND id!=? ORDER BY created_at',
      ).all(brandId, key, c.id)) {
        if (!other.source_user_id && contacts && !overlap(c.id, other.id)) {
          contacts.mergeInternal(c.id, other.id, { reason: 'identity' });
          event(userId, KIND.phone, 'merged', key, 'webhook', {
            detail: 'Fusión automática: WhatsApp confirmó que es la misma persona',
            t,
          });
          merged++;
        } else {
          event(userId, KIND.phone, 'conflict', key, 'webhook', {
            other: other.source_user_id,
            detail: 'Otro contacto de la marca tiene ese teléfono',
            t,
          });
          const mine = q('SELECT persona_id FROM contacts WHERE id=?').get(c.id)?.persona_id;
          candidate(mine, other.persona_id, 'Mismo teléfono ' + e164, t);
        }
      }
    }
    q(
      "UPDATE conversations SET wa_peer=? WHERE customer_id=? AND brand_id=? AND wa_number IS NOT NULL AND wa_peer IS NULL AND status!='resolved'",
    ).run(phone, userId, brandId);
    return { filled, merged };
  }

  // Ventana de 24 h por persona y número (diseño §3.6; conciliación, fila 41).
  function touchPeer(numberId, userId, at) {
    q(
      'INSERT INTO wa_peer_state(phone_number_id,user_id,last_inbound_at) VALUES(?,?,?) ON CONFLICT(phone_number_id,user_id) DO UPDATE SET last_inbound_at=MAX(last_inbound_at,excluded.last_inbound_at)',
    ).run(numberId, userId, at);
  }
  function lastInboundAt(c) {
    if (!c?.wa_number) return null;
    const userId = c.customer_id ?? q('SELECT customer_id FROM conversations WHERE id=?').get(c.id)?.customer_id;
    if (!userId) return null;
    return (
      q('SELECT last_inbound_at FROM wa_peer_state WHERE phone_number_id=? AND user_id=?').get(c.wa_number, userId)
        ?.last_inbound_at ?? null
    );
  }

  // Identificador con el que se le escribe a un cliente desde un número (sólo si no hay teléfono).
  function bsuidFor(userId, numberId) {
    const number = numberRow(numberId);
    if (!number || !userId) return null;
    return keyOf(userId, KIND.bsuid, scopeOf(number))?.value ?? null;
  }
  function recipientForContact(contactId, numberId) {
    const c = q('SELECT source_user_id FROM contacts WHERE id=?').get(contactId);
    return c?.source_user_id ? bsuidFor(c.source_user_id, numberId) : null;
  }
  // Texto del número visible de una conversación real (diseño §3.7).
  function displayFor(c) {
    if (!c?.wa_number) return '';
    if (c.wa_peer) return '+' + c.wa_peer;
    const number = numberRow(c.wa_number);
    const key = number && c.customer_id ? keyOf(c.customer_id, KIND.bsuid, scopeOf(number)) : null;
    return displayOf({ username: key?.username ?? '', bsuid: key?.value ?? '' }) || 'Número oculto';
  }
  // Lo que se enseña de las llaves de un cliente. El identificador completo sólo si `full` (administración).
  function keysView(userId, { full = false } = {}) {
    const keys = q('SELECT * FROM identity_keys WHERE user_id=? ORDER BY kind,last_seen DESC').all(userId);
    const phone = keys.find(k => k.kind === KIND.phone);
    const bsuid = keys.find(k => k.kind === KIND.bsuid);
    return {
      hasPhone: Boolean(phone),
      hasBsuid: Boolean(bsuid),
      username: bsuid?.username || '',
      bsuidHint: bsuid ? hint(bsuid.value) : null,
      ...(full ? { bsuid: bsuid?.value ?? null } : {}),
      phoneSeenAt: phone?.phone_seen_at ?? null,
    };
  }
  function stats() {
    const t = now();
    const count = (sql, ...args) => q(sql).get(...args).n;
    const held = q(
      "SELECT count(*) n,min(received_at) oldest FROM webhook_inbox WHERE state='failed' AND error IN ('no_phone','no_identifier') AND payload IS NOT NULL",
    ).get();
    return {
      withPhone: count(
        "SELECT count(*) n FROM (SELECT user_id FROM identity_keys WHERE kind='wa_phone' UNION SELECT user_id FROM wa_identities)",
      ),
      withoutPhone: count(
        "SELECT count(DISTINCT user_id) n FROM identity_keys k WHERE kind='wa_bsuid' AND NOT EXISTS(SELECT 1 FROM identity_keys p WHERE p.user_id=k.user_id AND p.kind='wa_phone') AND NOT EXISTS(SELECT 1 FROM wa_identities w WHERE w.user_id=k.user_id)",
      ),
      linkedThisWeek: count(
        "SELECT count(*) n FROM identity_events WHERE action IN ('linked','merged','moved') AND created_at>=?",
        t - 7 * DAY,
      ),
      conflicts: count(
        "SELECT count(*) n FROM identity_events WHERE action='conflict' AND created_at>=?",
        t - 30 * DAY,
      ),
      quarantine: { held: held.n, oldest: held.oldest ?? null },
    };
  }

  return {
    use,
    needsUser,
    resolve,
    adoptable,
    completeContacts,
    touchPeer,
    lastInboundAt,
    bsuidFor,
    recipientForContact,
    displayFor,
    keysView,
    stats,
    scopeFor,
  };
}
