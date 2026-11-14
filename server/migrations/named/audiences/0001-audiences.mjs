// Audiencias (docs/PLAN_AUDIENCIAS.md; conciliación técnica, fila 16): a quién se le envía una difusión.
//
//   audiences          una lista (conjunto fijo de contactos) o un segmento (filtro vivo con la gramática común de
//                      condiciones, server/lib/conditions.mjs) por marca. `role` = 'audience' (público) o
//                      'suppression' (lista de exclusión de la marca: sus miembros nunca reciben difusiones). Los
//                      prediseñados llevan `preset`. `member_count`/`counted_at`: exacto en una lista; en un segmento,
//                      el último conteo. Archivar no borra miembros; un nombre archivado se puede volver a usar.
//   audience_members   los miembros de una lista, con su origen (manual, import, api) y quién los puso. Están
//                      registrados en host.personData: una fusión de contactos los mueve sin duplicar.
//
// Sin CHECK en tipos y estados (se validan en código): un valor nuevo no debe obligar a reconstruir la tabla.
export default {
  name: 'audiences/0001-audiences',
  after: ['contacts/0001-search', 'contact-import/0001-imports'],
  up(db) {
    db.exec(`
      CREATE TABLE audiences(
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        kind TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'audience',
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        definition TEXT NOT NULL DEFAULT '{}',
        preset TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        member_count INTEGER NOT NULL DEFAULT 0,
        counted_at INTEGER,
        status TEXT NOT NULL DEFAULT 'ready',
        revision INTEGER NOT NULL DEFAULT 1,
        client_ref TEXT,
        created_by TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX audiences_brand ON audiences(brand_id, kind, status);
      CREATE UNIQUE INDEX audiences_name ON audiences(brand_id, name_key) WHERE archived_at IS NULL;
      CREATE UNIQUE INDEX audiences_client_ref ON audiences(brand_id, client_ref) WHERE client_ref IS NOT NULL;
      CREATE UNIQUE INDEX audiences_preset ON audiences(brand_id, preset) WHERE preset IS NOT NULL;
      CREATE TABLE audience_members(
        audience_id TEXT NOT NULL REFERENCES audiences(id),
        contact_id TEXT NOT NULL REFERENCES contacts(id),
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        added_by TEXT REFERENCES users(id),
        added_at INTEGER NOT NULL,
        PRIMARY KEY(audience_id, contact_id)
      ) WITHOUT ROWID;
      CREATE INDEX audience_members_contact ON audience_members(contact_id);
    `);
  },
};
