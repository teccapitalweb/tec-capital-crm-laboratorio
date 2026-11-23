// SQL del modo real por marca (docs/PLAN_MODO_REAL.md). Toda consulta lleva la marca primero.
export function createRepo(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  return {
    brandName: brandId => one('SELECT name FROM brands WHERE id=?', brandId)?.name || null,
    userName: userId => one('SELECT name FROM users WHERE id=?', userId)?.name || null,
    order: id => one('SELECT * FROM orders WHERE id=?', id),

    // Guarda el interruptor, las instrucciones y la imagen «Datos de pago» con su revisión. Devuelve false si otra
    // persona cambió la fila.
    save(brandId, { enabled, instructions, imageFileId = null, revision, userId, at }) {
      if (revision === 0)
        return (
          db
            .prepare(
              'INSERT INTO brand_real_mode(brand_id,enabled,payment_instructions,payment_image_file_id,revision,updated_by,updated_at) VALUES(?,?,?,?,1,?,?) ON CONFLICT(brand_id) DO NOTHING',
            )
            .run(brandId, enabled, instructions, imageFileId, userId, at).changes === 1
        );
      return (
        db
          .prepare(
            'UPDATE brand_real_mode SET enabled=?,payment_instructions=?,payment_image_file_id=?,revision=revision+1,updated_by=?,updated_at=? WHERE brand_id=? AND revision=?',
          )
          .run(enabled, instructions, imageFileId, userId, at, brandId, revision).changes === 1
      );
    },
    // Una imagen de la biblioteca de ESTA marca (JPG, PNG, WebP…), o null: la imagen «Datos de pago» nunca es de otra marca.
    libraryImage: (brandId, fileId) =>
      one(
        "SELECT id,mime,filename FROM library_files WHERE id=? AND brand_id=? AND mime LIKE 'image/%'",
        fileId,
        brandId,
      ) || null,
    // Las imágenes propias de la marca (sin el arte de demostración), de la más reciente a la más antigua, para elegir la
    // de «Datos de pago» en la pantalla.
    libraryImages: brandId =>
      db
        .prepare(
          "SELECT id,filename,mime FROM library_files WHERE brand_id=? AND mime LIKE 'image/%' AND builtin_id IS NULL ORDER BY created_at DESC LIMIT 60",
        )
        .all(brandId),

    // ---- lo que «Preparar marca» revisa antes de encender
    hasWhatsAppNumber: brandId => Boolean(one('SELECT 1 FROM wa_numbers WHERE brand_id=? LIMIT 1', brandId)),
    hasCurrentEdition: (brandId, now) =>
      Boolean(
        one(
          "SELECT 1 FROM editions e JOIN courses c ON c.id=e.course_id WHERE e.brand_id=? AND e.status='published' AND e.price_cents>0 AND e.starts_at>? AND c.active=1 LIMIT 1",
          brandId,
          now,
        ),
      ),
    // Cursos activos sin flyer propio aprobado: en laboratorio usan el arte de demostración (el incluido con los cursos de
    // ejemplo o el generado con «PRECIO DE EJEMPLO»); en modo real ese arte no sale y el material va sin imagen.
    demoFlyerCourses: brandId =>
      db
        .prepare(
          "SELECT c.title FROM courses c WHERE c.brand_id=? AND c.active=1 AND NOT EXISTS (SELECT 1 FROM flyers f JOIN library_files l ON l.id=f.file_id WHERE f.brand_id=c.brand_id AND f.course_id=c.id AND f.status='approved' AND l.builtin_id IS NULL) ORDER BY c.title",
        )
        .all(brandId)
        .map(r => r.title),
    // Textos que la marca escribió y que todavía avisan de la prueba: plantillas aprobadas, conocimiento aprobado,
    // respuestas rápidas compartidas, bienvenida del curso y flujo de bienvenida. En modo real esas frases se quitan al
    // enviar, pero conviene reescribirlos para que digan lo correcto.
    labTexts(brandId, pattern) {
      const rows = [
        ...db
          .prepare(
            "SELECT 'Plantilla' kind,title label,body text FROM content_templates WHERE brand_id=? AND status='approved'",
          )
          .all(brandId),
        ...db
          .prepare(
            "SELECT 'Conocimiento' kind,question label,answer text FROM knowledge_entries WHERE brand_id=? AND status='approved'",
          )
          .all(brandId),
        ...db
          .prepare(
            "SELECT 'Respuesta rápida' kind,title label,body text FROM quick_replies WHERE brand_id=? AND scope='brand' AND archived_at IS NULL",
          )
          .all(brandId),
        ...db
          .prepare(
            "SELECT 'Bienvenida del curso' kind,title label,welcome text FROM courses WHERE brand_id=? AND active=1",
          )
          .all(brandId),
        ...db
          .prepare("SELECT 'Flujo de bienvenida' kind,'Flujo' label,steps text FROM welcome_flows WHERE brand_id=?")
          .all(brandId),
      ];
      return rows.filter(r => pattern.test(String(r.text || ''))).map(r => ({ kind: r.kind, label: r.label }));
    },

    // ---- pago registrado a mano (dentro de la transacción del llamador)
    closeReceipts(orderId, userId, note, at) {
      db.prepare(
        "UPDATE receipts SET status='accepted',reviewed_by=?,review_note=?,reviewed_at=? WHERE order_id=? AND status='pending'",
      ).run(userId, note.slice(0, 500), at, orderId);
    },
    logPayment(orderId, details, userId, at) {
      db.prepare('INSERT INTO payment_events(order_id,kind,details,actor_id,created_at) VALUES(?,?,?,?,?)').run(
        orderId,
        'manual.recorded',
        JSON.stringify(details),
        userId,
        at,
      );
    },
  };
}
