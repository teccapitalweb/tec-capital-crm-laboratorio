import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { canonicalPhone, DEFAULT_COUNTRY } from './lib/identity-keys.mjs';

// Esquema v21 (Fase 2 · bloque 2.2 Identidad única de persona). Una persona (nombre, teléfono E.164, correo,
// consentimiento con historial) a la que cuelgan los contactos por marca que ya existen (`contacts.persona_id`). Las
// identidades (perfil del laboratorio, teléfono normalizado, correo) son únicas en toda la empresa y permiten unir
// automáticamente; cuando sólo coincide el nombre, o hay conflicto entre identidades, queda una candidatura para revisión
// humana. El consentimiento vive en la persona y se proyecta a `contact_consent` de cada contacto (lo que las recetas y
// la exportación ya leen). El alcance por marca no cambia: la ficha de persona muestra sólo las marcas autorizadas.
export { DEFAULT_COUNTRY };
// Teléfono a E.164 con México por omisión; devuelve '' si no es un número utilizable. Delega en la única regla de
// teléfono del CRM (server/lib/identity-keys.mjs): el resultado es «+» más la clave canónica, la misma que guarda
// `contacts.phone_key`. Lo que cambió al delegar (docs/PLAN_TELEFONO_CANONICO.md):
//   - «+521…» (el identificador de WhatsApp con «+») ya no conserva el 1: da «+52» más diez dígitos, igual que «521…».
//   - Un número de otro país se reconoce aunque venga sin «+» («14155552671»), y también «01» más diez dígitos.
//   - Deja de aceptarse lo que no es un teléfono: texto con letras, un código de país que no existe y un número de
//     México, Estados Unidos o Canadá que no tenga diez dígitos válidos después del código de país.
export function normalizePhone(raw, country = DEFAULT_COUNTRY) {
  return canonicalPhone(raw, { defaultCountry: country }).e164 ?? '';
}
export const normalizeEmail = raw => {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : '';
};
export const normalizeName = v =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
const RANK = { unknown: 0, opted_in: 1, opted_out: 2 };

export function migratePersons(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 21) return;
  transaction(db, () => {
    db.exec(`
    CREATE TABLE persons(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',source_user_id TEXT REFERENCES users(id),consent_status TEXT NOT NULL DEFAULT 'unknown' CHECK(consent_status IN ('unknown','opted_in','opted_out')),consent_source TEXT,consent_note TEXT NOT NULL DEFAULT '',consent_actor_id TEXT REFERENCES users(id),consent_brand_id TEXT REFERENCES brands(id),consent_updated_at INTEGER,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX persons_profile ON persons(source_user_id) WHERE source_user_id IS NOT NULL;
    CREATE TABLE person_identities(kind TEXT NOT NULL CHECK(kind IN ('profile','phone','email')),value TEXT NOT NULL,person_id TEXT NOT NULL REFERENCES persons(id),source TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(kind,value));
    CREATE INDEX person_identities_person ON person_identities(person_id);
    CREATE TABLE person_consent_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,person_id TEXT NOT NULL REFERENCES persons(id),brand_id TEXT REFERENCES brands(id),status TEXT NOT NULL,source TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE INDEX person_consent_history ON person_consent_events(person_id,seq);
    CREATE TABLE person_candidates(id TEXT PRIMARY KEY,person_a TEXT NOT NULL REFERENCES persons(id),person_b TEXT NOT NULL REFERENCES persons(id),reason TEXT NOT NULL CHECK(reason IN ('name','identity_conflict')),detail TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dismissed','merged')),decided_by TEXT REFERENCES users(id),decided_at INTEGER,created_at INTEGER NOT NULL,UNIQUE(person_a,person_b));
    CREATE TABLE person_merges(id TEXT PRIMARY KEY,kept_id TEXT NOT NULL,merged_id TEXT NOT NULL,merged_snapshot TEXT NOT NULL,moved TEXT NOT NULL,actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    ALTER TABLE contacts ADD COLUMN persona_id TEXT REFERENCES persons(id);
    CREATE INDEX contacts_person ON contacts(persona_id);`);
    backfill(db);
    db.exec('PRAGMA user_version=21');
  });
}
// Relleno: un perfil del laboratorio = una persona; después, teléfono o correo iguales unen; el resto, una persona por
// contacto. El consentimiento de la persona es el más estricto de sus contactos y se proyecta a todos ellos.
export function backfill(db) {
  const t = Date.now();
  const byIdentity = (kind, value) =>
    db.prepare('SELECT person_id FROM person_identities WHERE kind=? AND value=?').get(kind, value)?.person_id || null;
  const claim = (kind, value, personId) => {
    if (value)
      db.prepare(
        "INSERT OR IGNORE INTO person_identities(kind,value,person_id,source,created_at) VALUES(?,?,?,'backfill',?)",
      ).run(kind, value, personId, t);
  };
  const create = (c, phone, email) => {
    const id = randomUUID();
    db.prepare(
      'INSERT INTO persons(id,name,phone,email,source_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    ).run(id, c.name, phone, email, c.source_user_id || null, c.created_at, t);
    return id;
  };
  for (const c of db.prepare('SELECT * FROM contacts WHERE persona_id IS NULL ORDER BY created_at,rowid').all()) {
    const phone = normalizePhone(c.phone),
      email = normalizeEmail(c.email);
    let pid =
      (c.source_user_id && byIdentity('profile', c.source_user_id)) ||
      (phone && byIdentity('phone', phone)) ||
      (email && byIdentity('email', email)) ||
      null;
    if (!pid) pid = create(c, phone, email);
    if (c.source_user_id) claim('profile', c.source_user_id, pid);
    claim('phone', phone, pid);
    claim('email', email, pid);
    if (c.source_user_id)
      db.prepare('UPDATE persons SET source_user_id=COALESCE(source_user_id,?) WHERE id=?').run(c.source_user_id, pid);
    db.prepare(
      "UPDATE persons SET phone=CASE WHEN phone='' THEN ? ELSE phone END,email=CASE WHEN email='' THEN ? ELSE email END WHERE id=?",
    ).run(phone, email, pid);
    db.prepare('UPDATE contacts SET persona_id=? WHERE id=?').run(pid, c.id);
  }
  for (const p of db.prepare('SELECT id FROM persons').all()) {
    const rows = db
      .prepare(
        'SELECT k.* FROM contact_consent k JOIN contacts c ON c.id=k.contact_id WHERE c.persona_id=? ORDER BY k.updated_at',
      )
      .all(p.id);
    if (!rows.length) continue;
    const top = rows.reduce((a, b) => (RANK[b.status] >= RANK[a.status] ? b : a));
    db.prepare(
      'UPDATE persons SET consent_status=?,consent_source=?,consent_note=?,consent_actor_id=?,consent_brand_id=?,consent_updated_at=? WHERE id=?',
    ).run(top.status, top.source, top.note, top.actor_id, top.brand_id, top.updated_at, p.id);
    db.prepare(
      'INSERT INTO person_consent_events(person_id,brand_id,status,source,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(p.id, top.brand_id, top.status, top.source, top.note, top.actor_id, top.updated_at);
    if (top.status !== 'unknown')
      for (const c of db.prepare('SELECT id,brand_id FROM contacts WHERE persona_id=?').all(p.id)) {
        const same = c.brand_id === top.brand_id;
        db.prepare(
          'INSERT INTO contact_consent(contact_id,brand_id,status,source,note,actor_id,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(contact_id) DO UPDATE SET status=excluded.status,source=excluded.source,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at WHERE excluded.status!=contact_consent.status',
        ).run(
          c.id,
          c.brand_id,
          top.status,
          'person',
          same ? top.note : 'Registro actualizado desde otra marca de la empresa',
          same ? top.actor_id : null,
          top.updated_at,
        );
      }
  }
}
