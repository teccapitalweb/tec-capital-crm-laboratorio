// Datos para la constancia (docs/PLAN_RESPUESTAS_DE_VENTA.md). Lo que la persona escribe en el chat después de pedir o
// pagar («mi nombre completo para la constancia es…», su correo, su teléfono). Una fila por conversación: lo nuevo
// reemplaza sólo lo que trae. server/certificates.mjs usa el nombre al emitir el certificado de la inscripción que nació
// en esa conversación; si no hay fila, todo sigue como antes (nombre de la persona o del contacto).
//
//   certificate_details   conversation_id (llave), marca, nombre, correo, teléfono, el mensaje de donde salieron y fechas.
//                         Sin contact_id: cuelga de la conversación, que no cambia de dueño en una fusión.
export default {
  name: 'replies/0001-certificate-details',
  after: [], // tabla propia; sólo referencia tablas de la escalera
  up(db) {
    db.exec(`
      CREATE TABLE certificate_details(
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
        brand_id TEXT NOT NULL REFERENCES brands(id),
        full_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        message_id TEXT REFERENCES messages(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX certificate_details_brand ON certificate_details(brand_id,updated_at);`);
  },
};
