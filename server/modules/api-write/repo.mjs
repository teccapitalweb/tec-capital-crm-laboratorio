// SQL de la API de escritura (docs/PLAN_API_ESCRITURA.md). Toda consulta lleva la marca primero: la de la llave.
// `api_requests` guarda una fila por escritura (idempotencia y registro) sin cuerpos, llaves ni datos personales.
const DAY = 86400e3;
export const IDEM_TTL_MS = 7 * DAY;
export const KEEP_MS = 90 * DAY;

export function createRepo(db) {
  const findIdem = db.prepare('SELECT * FROM api_requests WHERE key_id=? AND idem_key=?');
  const insert = db.prepare(
    'INSERT INTO api_requests(id,key_id,brand_id,actor_id,method,route,idem_key,request_hash,status,code,entity_kind,entity_id,units,response,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  return {
    findIdem: (keyId, idemKey) => findIdem.get(keyId, idemKey),
    // Una clave vencida (más de 7 días) se libera para que el sistema que llama pueda volver a usarla.
    releaseIdem: id => db.prepare('UPDATE api_requests SET idem_key=NULL, response=NULL WHERE id=?').run(id),
    insert(r) {
      insert.run(
        r.id,
        r.keyId,
        r.brandId,
        r.actorId ?? null,
        r.method,
        r.route,
        r.idemKey ?? null,
        r.hash ?? null,
        r.status,
        r.code ?? null,
        r.entityKind ?? null,
        r.entityId ?? null,
        r.units ?? 1,
        r.response ?? null,
        r.durationMs ?? null,
        r.at,
      );
    },
    // Las claves de idempotencia valen 7 días; el registro se conserva 90.
    purge(at) {
      const released = db
        .prepare('UPDATE api_requests SET idem_key=NULL, response=NULL WHERE idem_key IS NOT NULL AND created_at<?')
        .run(at - IDEM_TTL_MS).changes;
      const removed = db.prepare('DELETE FROM api_requests WHERE created_at<?').run(at - KEEP_MS).changes;
      return released + removed;
    },
    contact: (brandId, id) => db.prepare('SELECT * FROM contacts WHERE brand_id=? AND id=?').get(brandId, id),
    contactByPhoneKey: (brandId, phoneKey) =>
      db
        .prepare(
          "SELECT * FROM contacts WHERE brand_id=? AND phone_key=? AND phone_key!='' ORDER BY created_at, id LIMIT 1",
        )
        .get(brandId, phoneKey),
    contactByEmail: (brandId, email) =>
      db
        .prepare(
          "SELECT * FROM contacts WHERE brand_id=? AND lower(email)=? AND email!='' ORDER BY created_at, id LIMIT 1",
        )
        .get(brandId, email),
    tags: (brandId, contactId) =>
      db
        .prepare(
          'SELECT t.name FROM contact_tag_links l JOIN contact_tags t ON t.id=l.tag_id WHERE t.brand_id=? AND l.contact_id=? ORDER BY t.name',
        )
        .all(brandId, contactId)
        .map(r => r.name),
    tagByKey: (brandId, nameKey) =>
      db.prepare('SELECT id,name FROM contact_tags WHERE brand_id=? AND name_key=?').get(brandId, nameKey),
    lists: brandId =>
      db
        .prepare(
          "SELECT id,name,role,member_count,updated_at FROM audiences WHERE brand_id=? AND kind='list' AND archived_at IS NULL ORDER BY name",
        )
        .all(brandId),
    knownContacts: (brandId, ids) =>
      db
        .prepare('SELECT id FROM contacts WHERE brand_id=? AND id IN (SELECT value FROM json_each(?))')
        .all(brandId, JSON.stringify(ids))
        .map(r => r.id),
    templates: brandId =>
      db
        .prepare(
          "SELECT * FROM wa_templates WHERE brand_id=? AND status IN ('approved','flagged') AND archived_at IS NULL ORDER BY name, language",
        )
        .all(brandId),

    // ---- envío de plantillas (docs/PLAN_API_ENVIO.md)
    templateById: (brandId, id) =>
      db.prepare('SELECT * FROM wa_templates WHERE brand_id=? AND id=? AND archived_at IS NULL').get(brandId, id),
    templatesByName: (brandId, name) =>
      db
        .prepare('SELECT * FROM wa_templates WHERE brand_id=? AND name=? AND archived_at IS NULL ORDER BY language')
        .all(brandId, name),
    number: (brandId, numberId) =>
      db
        .prepare('SELECT phone_number_id,enabled FROM wa_numbers WHERE brand_id=? AND phone_number_id=?')
        .get(brandId, numberId),
    enabledNumbers: brandId =>
      db.prepare('SELECT phone_number_id FROM wa_numbers WHERE brand_id=? AND enabled=1').all(brandId),
    // Envíos que la API aceptó a una llave desde `since`: su cuenta para el tope diario (sobrevive a un reinicio).
    sendsSince: (brandId, keyId, route, since) =>
      db
        .prepare(
          'SELECT coalesce(sum(units),0) n, min(created_at) oldest FROM api_requests WHERE brand_id=? AND key_id=? AND route=? AND status=202 AND created_at>?',
        )
        .get(brandId, keyId, route, since),
    // ¿Este envío lo hizo esta llave (o la que rotó en ella)? Sólo ésas pueden ver su estado.
    sendOwner: (brandId, sendId) =>
      db
        .prepare(
          "SELECT key_id FROM api_requests WHERE brand_id=? AND entity_kind='send' AND entity_id=? AND status=202 LIMIT 1",
        )
        .get(brandId, sendId),
    recipientByRef: ref =>
      db.prepare('SELECT id,state,fail_code FROM campaign_recipients WHERE provider_ref=?').get(ref),
    sendByRecipient: sendId =>
      db
        .prepare(
          "SELECT brand_id,key_id FROM api_requests WHERE entity_kind='send' AND entity_id=? AND status=202 LIMIT 1",
        )
        .get(sendId),
  };
}
