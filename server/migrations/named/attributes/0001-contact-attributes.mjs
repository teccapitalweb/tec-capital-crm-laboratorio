// Atributos de contacto (docs/PLAN_ATRIBUTOS_CONTACTO.md): datos propios de cada marca sobre sus contactos, como la
// ciudad, el curso de interés o el estado de seguimiento.
//
//   contact_attributes          definiciones por marca. `key` es inmutable y es el nombre en {{contacto.<key>}}.
//                               `type` SIN restricción en la tabla: la lista de tipos se valida en código, para que
//                               un tipo nuevo no obligue a reconstruirla. Se archivan, no se borran.
//   contact_attribute_values    un valor por contacto y atributo, en su forma canónica; `value_num` guarda el número,
//                               la fecha (milisegundos) o el sí/no (1/0) para comparar y ordenar en SQL.
//   contact_attribute_events    historial: quién cambió qué, de qué a qué y desde dónde.
//   contact_attribute_requests  respuesta de cada escritura de valores por `clientRef`: un reintento no repite nada.
export default {
  name: 'attributes/0001-contact-attributes',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE contact_attributes(
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        type TEXT NOT NULL,
        options TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        personal INTEGER NOT NULL DEFAULT 0,
        searchable INTEGER NOT NULL DEFAULT 0,
        show_in_chat INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'custom',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
        revision INTEGER NOT NULL DEFAULT 1,
        client_ref TEXT UNIQUE,
        created_by TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(brand_id,key)
      );
      CREATE INDEX contact_attributes_brand ON contact_attributes(brand_id,status,position);
      CREATE TABLE contact_attribute_values(
        contact_id TEXT NOT NULL REFERENCES contacts(id),
        attribute_id TEXT NOT NULL REFERENCES contact_attributes(id),
        brand_id TEXT NOT NULL REFERENCES brands(id),
        value TEXT NOT NULL,
        value_num REAL,
        source TEXT NOT NULL,
        source_id TEXT,
        updated_by TEXT REFERENCES users(id),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(contact_id,attribute_id)
      );
      CREATE INDEX contact_attribute_lookup ON contact_attribute_values(attribute_id,value);
      CREATE INDEX contact_attribute_number ON contact_attribute_values(attribute_id,value_num) WHERE value_num IS NOT NULL;
      CREATE TABLE contact_attribute_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        contact_id TEXT NOT NULL,
        attribute_id TEXT,
        key TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        source TEXT NOT NULL,
        source_id TEXT,
        actor_id TEXT REFERENCES users(id),
        conversation_id TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX contact_attribute_history ON contact_attribute_events(contact_id,seq);
      CREATE TABLE contact_attribute_requests(
        client_ref TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        contact_id TEXT NOT NULL,
        actor_id TEXT REFERENCES users(id),
        response TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  },
};
