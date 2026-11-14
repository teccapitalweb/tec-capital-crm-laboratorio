// Teléfono canónico (docs/PLAN_TELEFONO_CANONICO.md).
//
// Cada contacto guarda en `phone_key` la clave con la que se compara su teléfono: sólo dígitos con código de país
// (México, 52 más diez dígitos, sin el 1 de WhatsApp). El teléfono tal como se capturó (`phone`) no se toca. Lo que la
// biblioteca no reconoce como teléfono se queda sin clave y conserva su texto.
//
// Además corrige lo que la normalización anterior dejó escrito de otra manera: la identidad de teléfono de una persona
// y el teléfono de la persona guardados como «+521» más diez dígitos pasan a «+52» más diez dígitos, que es lo que
// produce ahora la única función de teléfono (server/lib/identity-keys.mjs).
//
// Repetir el cuerpo no cambia nada: la columna y el índice se crean sólo si faltan, la clave se escribe sólo donde no
// coincide con la de su teléfono y la corrección sólo mira lo que todavía tiene la forma anterior.
import { randomUUID } from 'node:crypto';
import { addColumn } from '../../named.mjs';
import { canonicalPhone, phoneKey } from '../../../lib/identity-keys.mjs';

// Sólo las filas que tienen teléfono (o una clave que ya no corresponde a ningún teléfono): el resto ya tiene la clave
// vacía por omisión. `updated_at` no cambia: el contacto no se editó.
function fillContactKeys(db) {
  const update = db.prepare('UPDATE contacts SET phone_key=? WHERE id=?');
  for (const row of db.prepare("SELECT id,phone,phone_key FROM contacts WHERE phone!='' OR phone_key!=''").all()) {
    const key = phoneKey(row.phone) ?? '';
    if (key !== row.phone_key) update.run(key, row.id);
  }
}

// La forma anterior: «+521» y diez dígitos (14 caracteres). Es la única que la función nueva escribe distinto.
const OLD_FORM = column => `length(${column})=14 AND substr(${column},1,4)='+521'`;

function fixPersonPhones(db) {
  const ownerOf = db.prepare("SELECT person_id FROM person_identities WHERE kind='phone' AND value=?");
  const rewrite = db.prepare("UPDATE person_identities SET value=? WHERE kind='phone' AND value=?");
  // Igual que persons.claim(): si el teléfono ya es de otra persona no se mueve; queda una candidatura para que
  // administración revise si son la misma (un par de personas sólo tiene una candidatura).
  const candidate = db.prepare(
    "INSERT OR IGNORE INTO person_candidates(id,person_a,person_b,reason,detail,status,created_at) VALUES(?,?,?,'identity_conflict',?,'pending',?)",
  );
  const now = Date.now();
  const identities = db
    .prepare(`SELECT value,person_id FROM person_identities WHERE kind='phone' AND ${OLD_FORM('value')}`)
    .all();
  for (const row of identities) {
    const e164 = canonicalPhone(row.value).e164;
    if (!e164 || e164 === row.value) continue;
    const owner = ownerOf.get(e164)?.person_id;
    if (!owner) rewrite.run(e164, row.value);
    else if (owner !== row.person_id) {
      const [a, b] = [owner, row.person_id].sort();
      candidate.run(randomUUID(), a, b, 'Mismo teléfono ' + e164, now);
    }
    // Si la misma persona ya tenía la identidad canónica, la anterior se queda: ninguna búsqueda vuelve a producirla.
  }
  // El teléfono de la persona no es único: se escribe siempre en la forma nueva, que es la que respaldan sus contactos.
  // No cambian `revision` ni `updated_at`: nadie editó a la persona.
  const setPhone = db.prepare('UPDATE persons SET phone=? WHERE id=?');
  for (const row of db.prepare(`SELECT id,phone FROM persons WHERE ${OLD_FORM('phone')}`).all()) {
    const e164 = canonicalPhone(row.phone).e164;
    if (e164 && e164 !== row.phone) setPhone.run(e164, row.id);
  }
}

export default {
  name: 'identity/0001-phone-key',
  after: [],
  up(db) {
    addColumn(db, 'contacts', 'phone_key', "TEXT NOT NULL DEFAULT ''");
    fillContactKeys(db);
    // Índice parcial: la mayoría de las búsquedas son «contacto de esta marca con este teléfono»; sin teléfono no hay
    // nada que buscar.
    db.exec("CREATE INDEX IF NOT EXISTS contacts_phone_key ON contacts(brand_id, phone_key) WHERE phone_key != ''");
    fixPersonPhones(db);
  },
};
