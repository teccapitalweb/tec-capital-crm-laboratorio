// Nombre que la persona pide para su constancia (docs/PLAN_RESPUESTAS_DE_VENTA.md). Lo que escribe en el chat es una
// PROPUESTA: queda ligada a su pedido (y a su contacto, para fusiones y datos de persona) y una persona del equipo la
// confirma o la corrige antes de que salga en un certificado.
//
//   certificate_name_requests   una fila por pedido: nombre pedido, correo y teléfono que dio, de qué mensaje salieron,
//                               estado de la solicitud (pending · confirmed · rejected) y el nombre que confirmó el equipo
//                               (se conserva aunque llegue una solicitud nueva, hasta que alguien confirme otra).
//   certificate_name_events     cada confirmación o corrección del equipo: nombre anterior y nuevo, quién y cuándo.
export default {
  name: 'replies/0001-certificate-name-requests',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE certificate_name_requests(
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        contact_id TEXT NOT NULL REFERENCES contacts(id),
        order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
        conversation_id TEXT REFERENCES conversations(id),
        requested_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        message_id TEXT REFERENCES messages(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
        confirmed_name TEXT,
        confirmed_by TEXT REFERENCES users(id),
        confirmed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX certificate_name_requests_contact ON certificate_name_requests(contact_id);
      CREATE INDEX certificate_name_requests_brand ON certificate_name_requests(brand_id,updated_at);
      CREATE TABLE certificate_name_events(
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        contact_id TEXT NOT NULL REFERENCES contacts(id),
        order_id TEXT NOT NULL REFERENCES orders(id),
        actor_id TEXT REFERENCES users(id),
        from_name TEXT NOT NULL DEFAULT '',
        to_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX certificate_name_events_order ON certificate_name_events(order_id,created_at);
      CREATE INDEX certificate_name_events_contact ON certificate_name_events(contact_id);`);
  },
};
