// Accesos del curso (docs/PLAN_CIERRE_DE_VENTA.md). Lo que recibe el alumno cuando su pago queda confirmado.
//
//   course_access              una fila por apertura que alguien haya configurado: el texto con los accesos, si se envía
//                              solo al confirmar el pago (enabled, 0 por omisión) y si también sale con un pago de prueba
//                              (on_test_payment, 0 por omisión). Sin fila, la apertura no envía nada, igual que hoy.
//   course_access_deliveries   cada entrega: la automática (una por inscripción) y los reenvíos de una persona. «skipped»
//                              guarda por qué no salió (apagado, sin texto, pago de prueba). No copia el texto: queda en
//                              el mensaje de la conversación.
export default {
  name: 'course-access/0001-course-access',
  after: [], // tablas propias; sólo referencian tablas de la escalera
  up(db) {
    db.exec(`
      CREATE TABLE course_access(
        edition_id TEXT PRIMARY KEY REFERENCES editions(id),
        brand_id TEXT NOT NULL REFERENCES brands(id),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        on_test_payment INTEGER NOT NULL DEFAULT 0 CHECK(on_test_payment IN (0,1)),
        body TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT REFERENCES users(id),
        updated_at INTEGER
      );
      CREATE INDEX course_access_brand ON course_access(brand_id);
      CREATE TABLE course_access_deliveries(
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        edition_id TEXT NOT NULL REFERENCES editions(id),
        enrollment_id TEXT NOT NULL REFERENCES enrollments(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        kind TEXT NOT NULL CHECK(kind IN ('auto','manual')),
        status TEXT NOT NULL CHECK(status IN ('sent','skipped')),
        reason TEXT NOT NULL DEFAULT '',
        message_id TEXT REFERENCES messages(id),
        access_revision INTEGER NOT NULL DEFAULT 0,
        sent_by TEXT REFERENCES users(id),
        client_ref TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX course_access_auto ON course_access_deliveries(enrollment_id) WHERE kind='auto';
      CREATE UNIQUE INDEX course_access_ref ON course_access_deliveries(client_ref) WHERE client_ref IS NOT NULL;
      CREATE INDEX course_access_deliveries_brand ON course_access_deliveries(brand_id,created_at);
      CREATE INDEX course_access_deliveries_conversation ON course_access_deliveries(conversation_id,created_at);`);
  },
};
