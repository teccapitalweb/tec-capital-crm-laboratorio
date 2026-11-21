// Nombre que la persona pide para su constancia (docs/PLAN_RESPUESTAS_DE_VENTA.md, «Revisión independiente»). Lo que
// escribe en el chat es una PROPUESTA: queda ligada a su pedido (y a su contacto, para fusiones, exportación y borrado de
// datos de persona) y una persona del equipo la confirma o la corrige antes de que salga en un certificado.
//
//   certificate_name_requests   una fila por pedido: nombre pedido, correo y teléfono que dio, de qué mensaje salieron,
//                               estado (pending · confirmed · rejected), el nombre confirmado y quién lo confirmó.
//
// Reemplaza a `certificate_details` (replies/0001), que guardaba los datos por conversación y nunca se publicó en `main`:
// se elimina aquí sin datos que conservar (sólo existió en la rama de integración).
export default {
  name: 'replies/0002-certificate-name-requests',
  after: [],
  up(db) {
    db.exec(`
      DROP TABLE certificate_details;
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
      CREATE INDEX certificate_name_requests_brand ON certificate_name_requests(brand_id,updated_at);`);
  },
};
