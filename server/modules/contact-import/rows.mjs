// La función por fila de la importación de contactos (conciliación técnica, filas 14 y 15): la ÚNICA forma de escribir
// un contacto importado. La usan la importación por CSV y, después, la lista de una audiencia y la mudanza por API.
//
//   applyRow(brandId, row, opts) → { action, contactId, reason, message, consent, column?, value? }
//
//   row   ya mapeada: { name, phone, countryCode, email, tags: [nombres], consent: true|false|null, createdAt,
//         attrs: {clave: valor} }. Se aceptan también ownerId, locale, externalId y bsuid, que todavía no tienen dónde
//         guardarse en el CRM y se ignoran.
//   opts  { onExisting: 'update'|'skip', nameFallback: 'phone'|'error', actorId, importId, label (nombre del archivo),
//         consent: { mode: 'none'|'declared', origin } }
//   action  created | updated | unchanged | skipped | error
//   consent opted_in | opted_out | kept_opt_out | not_recorded | null (qué se hizo con el consentimiento)
//
// Componible y síncrona: no abre transacción (va dentro de la de quien llama) ni hace red. Sus escrituras van en un
// SAVEPOINT propio: una fila con error no deja nada a medias. No publica eventos por contacto (salvo la baja, que
// detiene automatizaciones) ni avisa en vivo: quien importa avisa una vez al terminar.
//
// Reglas:
//   - Se reconoce al contacto por la clave de teléfono dentro de la marca (el más antiguo, si hubiera repetidos) y, si
//     no hay, por el correo de un contacto sin teléfono o con el mismo. Quien ya escribía por WhatsApp no se duplica.
//   - Nunca se pisa un dato con una celda vacía. El teléfono de un contacto existente no se reescribe (sólo se añade
//     si no tenía); nombre y correo se actualizan si la fila trae otro valor.
//   - Etiquetas: sólo se añaden (se crean en la marca si faltan); nunca se quitan.
//   - Datos de contacto: con attributes.set (origen «import», sin eventos por cambio); un valor que no cumple el tipo
//     es un error de la fila.
//   - Consentimiento (fila 15): FALSE → baja siempre; TRUE → «acepta» sólo si hay declaración de origen del permiso
//     (`consent.mode = 'declared'`) y el contacto está «sin registro»; sin declaración queda «sin registro» y no recibe
//     promociones; una baja nunca se levanta; sin columna o celda vacía no se toca.
import { randomUUID } from 'node:crypto';
import { canonicalPhone } from '../../lib/identity-keys.mjs';
import { countryOptions } from './mapping.mjs';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TAGS = 12;
const text = (value, max) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);
const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

// Fecha de alta: milisegundos, AAAA-MM-DD (con hora o sin ella) o DD/MM/AAAA. Devuelve ms o null.
export function parseDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{12,13}$/.test(raw)) return Number(raw);
  const dmy = DMY.exec(raw);
  const at = dmy ? Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])) : Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  if (dmy && new Date(at).getUTCDate() !== Number(dmy[1])) return null;
  return at;
}

// Datos de contacto: se adelanta la forma que esperan los tipos lista, fecha y sí/no del módulo de atributos, para
// que la exportación de otra herramienta («PENDIENTE», «13/11/2026», «TRUE») entre sin retocar el archivo.
function attributeValue(definition, raw) {
  const value = String(raw).trim();
  if (definition.type === 'select') {
    const lower = value.toLowerCase();
    const option = definition.options.find(o => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower);
    return option ? option.value : value;
  }
  if (definition.type === 'date') {
    const dmy = DMY.exec(value);
    return dmy ? `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}` : value;
  }
  if (definition.type === 'boolean') {
    const lower = value.toLowerCase();
    if (['verdadero', 'true'].includes(lower)) return 'true';
    if (['falso', 'false'].includes(lower)) return 'false';
  }
  return value;
}

export function createRowWriter({ db, contacts, persons, attributes, now = Date.now }) {
  const byPhone = db.prepare(
    "SELECT * FROM contacts WHERE brand_id=? AND phone_key=? AND phone_key!='' ORDER BY created_at, id LIMIT 1",
  );
  const byEmail = db.prepare(
    "SELECT * FROM contacts WHERE brand_id=? AND lower(email)=? AND email!='' AND (phone_key='' OR phone_key=?) ORDER BY created_at, id LIMIT 1",
  );
  const contactRow = db.prepare('SELECT * FROM contacts WHERE id=?');
  const insert = db.prepare(
    "INSERT INTO contacts(id,brand_id,name,phone,phone_key,email,source,created_at,updated_at) VALUES(?,?,?,?,?,?,'import',?,?)",
  );
  const update = db.prepare('UPDATE contacts SET name=?,phone=?,phone_key=?,email=?,updated_at=? WHERE id=?');

  const error = (reason, message, extra = {}) => ({
    action: 'error',
    contactId: null,
    reason,
    message,
    consent: null,
    ...extra,
  });

  // Lo que se puede decidir sin tocar la base: teléfono, correo, nombre, etiquetas y fecha.
  function prepare(row, opts) {
    const phoneText = text(row.phone, 60);
    let phone = null;
    if (phoneText) {
      phone = canonicalPhone(phoneText, countryOptions(row.countryCode));
      if (!phone.key) return { problem: error('phone_invalid', phone.message, { field: 'phone', value: phoneText }) };
    }
    const email = text(row.email, 150).toLowerCase();
    if (email && !EMAIL.test(email))
      return {
        problem: error('email_invalid', 'El correo no tiene la forma nombre@dominio.', {
          field: 'email',
          value: email,
        }),
      };
    if (!phone && !email)
      return {
        problem: error('no_identifier', 'La fila no trae teléfono ni correo: no hay con qué reconocer al contacto.'),
      };
    const tags = [...new Set((row.tags ?? []).map(tag => text(tag, 60)).filter(Boolean))];
    const long = tags.find(tag => tag.length > 30);
    if (long)
      return {
        problem: error('tag_invalid', 'Una etiqueta admite hasta 30 caracteres.', { field: 'tags', value: long }),
      };
    if (tags.length > MAX_TAGS)
      return { problem: error('tag_limit', `Máximo ${MAX_TAGS} etiquetas por contacto.`, { field: 'tags' }) };
    let name = text(row.name, 100);
    if (!name && opts.nameFallback !== 'error') name = phone ? phone.e164 : email;
    let createdAt = null;
    if (row.createdAt !== undefined && row.createdAt !== null && String(row.createdAt).trim()) {
      createdAt = parseDate(row.createdAt);
      if (createdAt === null)
        return {
          problem: error('date_invalid', 'La fecha de alta no se reconoce (usa AAAA-MM-DD o DD/MM/AAAA).', {
            field: 'createdAt',
            value: String(row.createdAt),
          }),
        };
    }
    return { phone, email, name, tags, createdAt };
  }

  function findExisting(brandId, phone, email) {
    if (phone) {
      const found = byPhone.get(brandId, phone.key);
      if (found) return found;
    }
    return email ? (byEmail.get(brandId, email, phone?.key ?? '') ?? null) : null;
  }

  function writeConsent(contact, value, opts) {
    if (value !== true && value !== false) return null;
    const current = contacts.consentOf(contact.id).status;
    const label = text(opts.label, 80) || 'archivo';
    if (value === false) {
      if (current === 'opted_out') return null;
      contacts.writeConsent(
        contact,
        'opted_out',
        'import',
        text(`Importado de «${label}»: no desea mensajes.`, 200),
        opts.actorId ?? null,
      );
      return 'opted_out';
    }
    if (current === 'opted_out') return 'kept_opt_out';
    if (current === 'opted_in') return null;
    if (opts.consent?.mode !== 'declared') return 'not_recorded';
    const note = text(`Importado de «${label}». Origen del permiso: ${opts.consent.origin}`, 200);
    contacts.writeConsent(contact, 'opted_in', 'import', note, opts.actorId ?? null);
    return 'opted_in';
  }

  function applyRow(brandId, row, opts = {}) {
    const ready = prepare(row ?? {}, opts);
    if (ready.problem) return ready.problem;
    const { phone, email, tags, createdAt } = ready;
    const existing = findExisting(brandId, phone, email);
    if (existing && opts.onExisting === 'skip')
      return {
        action: 'skipped',
        contactId: existing.id,
        reason: 'exists',
        message: 'Ya existía y se pidió no actualizar.',
        consent: null,
      };
    if (!existing && (ready.name.length < 2 || !ready.name))
      return error('name_invalid', 'Falta el nombre del contacto (al menos 2 letras).', {
        field: 'name',
        value: ready.name,
      });
    const t = now();
    db.exec('SAVEPOINT import_row');
    try {
      let contact = existing;
      let changed = false;
      if (!contact) {
        const id = randomUUID();
        insert.run(id, brandId, ready.name, phone?.e164 ?? '', phone?.key ?? '', email, createdAt ?? t, t);
        contact = contactRow.get(id);
        persons?.attach(contact, 'import', { candidates: false });
        contact = contactRow.get(id);
      } else {
        const name = ready.name && text(row.name, 100) && ready.name !== contact.name ? ready.name : contact.name;
        const mail = email && email !== contact.email.toLowerCase() ? email : contact.email;
        const addPhone = phone && !contact.phone_key;
        if (name !== contact.name || mail !== contact.email || addPhone) {
          update.run(
            name,
            addPhone ? phone.e164 : contact.phone,
            addPhone ? phone.key : contact.phone_key,
            mail,
            t,
            contact.id,
          );
          changed = true;
          contact = contactRow.get(contact.id);
          if (addPhone || mail !== existing.email) {
            persons?.attach(contact, 'import', { candidates: false });
            contact = contactRow.get(contact.id);
          }
        }
      }
      for (const name of tags) {
        const tag = contacts.ensureTag(brandId, name, opts.actorId ?? null);
        if (contacts.addTag(contact.id, tag.id, opts.actorId ?? null)) changed = true;
      }
      const attrs = Object.entries(row.attrs ?? {}).filter(([, value]) => String(value ?? '').trim());
      if (attrs.length) {
        const api = attributes();
        const definitions = new Map(api.definitions(brandId).map(d => [d.key, d]));
        const changes = attrs.map(([key, value]) => {
          const definition = definitions.get(key);
          return { key, value: definition ? attributeValue(definition, value) : value };
        });
        const result = api.set(brandId, contact.id, changes, {
          source: 'import',
          sourceId: opts.importId ?? null,
          actorId: opts.actorId ?? null,
          events: false,
        });
        if (result.changed.length) changed = true;
      }
      const consent = writeConsent(contact, row.consent, opts);
      if (consent === 'opted_in' || consent === 'opted_out') changed = true;
      db.exec('RELEASE import_row');
      const action = existing ? (changed ? 'updated' : 'unchanged') : 'created';
      return { action, contactId: contact.id, reason: null, message: null, consent };
    } catch (failure) {
      db.exec('ROLLBACK TO import_row');
      db.exec('RELEASE import_row');
      if (!failure?.status) throw failure;
      const field = failure.field ?? null;
      return error(failure.code || 'invalid', failure.message, {
        field: field ? (failure.code?.startsWith('attribute') ? 'attr:' + field : field) : null,
        value: field && row.attrs?.[field] !== undefined ? String(row.attrs[field]) : undefined,
      });
    }
  }

  return { applyRow, prepare };
}
