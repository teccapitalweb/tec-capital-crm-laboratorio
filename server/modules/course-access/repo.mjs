// SQL de los accesos del curso (docs/PLAN_CIERRE_DE_VENTA.md). Las consultas por marca llevan la marca primero; las que
// parten de una inscripción o de una conversación las resuelve el módulo, que comprueba la marca antes de responder.
const BLANK = Object.freeze({
  enabled: 0,
  on_test_payment: 0,
  body: '',
  revision: 0,
  updated_by: null,
  updated_at: null,
});

export function createRepo(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  return {
    brandName: brandId => one('SELECT name FROM brands WHERE id=?', brandId)?.name || null,
    userName: userId => one('SELECT name FROM users WHERE id=?', userId)?.name || null,

    // ---- configuración por apertura
    edition: (brandId, editionId) =>
      one(
        'SELECT e.*,c.title course_title,c.active course_active FROM editions e JOIN courses c ON c.id=e.course_id WHERE e.brand_id=? AND e.id=?',
        brandId,
        editionId,
      ),
    editionById: editionId => one('SELECT * FROM editions WHERE id=?', editionId),
    access: editionId => one('SELECT * FROM course_access WHERE edition_id=?', editionId) || { ...BLANK },
    // Guarda con su revisión. Devuelve false si otra persona cambió la fila mientras tanto.
    save(brandId, editionId, { enabled, onTestPayment, body, revision, userId, at }) {
      if (revision === 0)
        return (
          db
            .prepare(
              'INSERT INTO course_access(edition_id,brand_id,enabled,on_test_payment,body,revision,updated_by,updated_at) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(edition_id) DO NOTHING',
            )
            .run(editionId, brandId, enabled, onTestPayment, body, userId, at).changes === 1
        );
      return (
        db
          .prepare(
            'UPDATE course_access SET enabled=?,on_test_payment=?,body=?,revision=revision+1,updated_by=?,updated_at=? WHERE edition_id=? AND brand_id=? AND revision=?',
          )
          .run(enabled, onTestPayment, body, userId, at, editionId, brandId, revision).changes === 1
      );
    },
    // Aperturas de la marca que no están archivadas, con sus inscritos y cuántos ya recibieron sus accesos.
    editions: brandId =>
      all(
        `SELECT e.id,e.course_id,e.name,e.starts_at,e.timezone,e.status,e.group_url,c.title course_title,
           a.enabled,a.on_test_payment,a.body,a.revision,a.updated_by,a.updated_at,
           (SELECT COUNT(*) FROM enrollments n WHERE n.edition_id=e.id AND n.status='enrolled') enrolled,
           (SELECT COUNT(*) FROM enrollments n WHERE n.edition_id=e.id AND n.status='enrolled'
              AND EXISTS (SELECT 1 FROM course_access_deliveries d WHERE d.enrollment_id=n.id AND d.status='sent')) delivered
         FROM editions e JOIN courses c ON c.id=e.course_id LEFT JOIN course_access a ON a.edition_id=e.id
         WHERE e.brand_id=? AND e.status!='archived' AND c.active=1
         ORDER BY (e.starts_at IS NULL),e.starts_at DESC,c.title,e.name LIMIT 200`,
        brandId,
      ),
    // Aperturas publicadas con fecha futura (o sin fecha) que todavía no entregan accesos: lo que «Preparar marca» avisa.
    openWithoutAccess: (brandId, now) =>
      all(
        `SELECT c.title FROM editions e JOIN courses c ON c.id=e.course_id LEFT JOIN course_access a ON a.edition_id=e.id
         WHERE e.brand_id=? AND e.status='published' AND c.active=1 AND (e.starts_at IS NULL OR e.starts_at>?)
           AND (a.edition_id IS NULL OR a.enabled=0 OR TRIM(a.body)='') ORDER BY c.title`,
        brandId,
        now,
      ).map(r => r.title),
    publishedCount: (brandId, now) =>
      one(
        "SELECT COUNT(*) n FROM editions e JOIN courses c ON c.id=e.course_id WHERE e.brand_id=? AND e.status='published' AND c.active=1 AND (e.starts_at IS NULL OR e.starts_at>?)",
        brandId,
        now,
      ).n,

    // ---- inscripción y su pedido
    enrollment: id =>
      one(
        `SELECT n.*,o.conversation_id,o.reference,o.confirmed_by,o.method,o.provider_ref,k.name contact_name
         FROM enrollments n JOIN orders o ON o.id=n.order_id JOIN contacts k ON k.id=n.contact_id WHERE n.id=?`,
        id,
      ),
    conversation: id => one('SELECT * FROM conversations WHERE id=?', id),
    // Inscritos de una apertura que todavía no tienen una entrega enviada (para «Enviar a quienes faltan»).
    pending: (brandId, editionId, limit) =>
      all(
        `SELECT n.id FROM enrollments n WHERE n.brand_id=? AND n.edition_id=? AND n.status='enrolled'
           AND NOT EXISTS (SELECT 1 FROM course_access_deliveries d WHERE d.enrollment_id=n.id AND d.status='sent')
         ORDER BY n.created_at LIMIT ?`,
        brandId,
        editionId,
        limit,
      ).map(r => r.id),

    // ---- entregas
    autoDelivery: enrollmentId =>
      one("SELECT * FROM course_access_deliveries WHERE enrollment_id=? AND kind='auto'", enrollmentId),
    byRef: clientRef => one('SELECT * FROM course_access_deliveries WHERE client_ref=?', clientRef),
    delivery: id => one('SELECT * FROM course_access_deliveries WHERE id=?', id),
    lastDelivery: enrollmentId =>
      one(
        'SELECT * FROM course_access_deliveries WHERE enrollment_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
        enrollmentId,
      ),
    wasSent: enrollmentId =>
      Boolean(
        one("SELECT 1 FROM course_access_deliveries WHERE enrollment_id=? AND status='sent' LIMIT 1", enrollmentId),
      ),
    insertDelivery(d) {
      db.prepare(
        'INSERT INTO course_access_deliveries(id,brand_id,edition_id,enrollment_id,conversation_id,kind,status,reason,message_id,access_revision,sent_by,client_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        d.id,
        d.brandId,
        d.editionId,
        d.enrollmentId,
        d.conversationId,
        d.kind,
        d.status,
        d.reason || '',
        d.messageId || null,
        d.accessRevision || 0,
        d.sentBy || null,
        d.clientRef || null,
        d.at,
      );
    },
    deliveries: (brandId, limit) =>
      all(
        `SELECT d.id,d.enrollment_id,d.conversation_id,d.edition_id,d.kind,d.status,d.reason,d.created_at,
           k.name contact_name,c.title course_title,e.name edition_name,u.name sent_by_name
         FROM course_access_deliveries d JOIN enrollments n ON n.id=d.enrollment_id JOIN contacts k ON k.id=n.contact_id
           JOIN editions e ON e.id=d.edition_id JOIN courses c ON c.id=e.course_id LEFT JOIN users u ON u.id=d.sent_by
         WHERE d.brand_id=? ORDER BY d.created_at DESC,d.rowid DESC LIMIT ?`,
        brandId,
        limit,
      ),

    // ---- lo que el chat necesita saber de la venta de una conversación
    latestOrder: conversationId =>
      one(
        "SELECT * FROM orders WHERE conversation_id=? AND COALESCE(kind,'course')='course' ORDER BY created_at DESC,rowid DESC LIMIT 1",
        conversationId,
      ),
    pendingReceipt: orderId =>
      one(
        `SELECT r.id,r.created_at,r.attachment_id,a.filename,a.mime FROM receipts r JOIN attachments a ON a.id=r.attachment_id
         WHERE r.order_id=? AND r.status='pending' ORDER BY r.created_at DESC LIMIT 1`,
        orderId,
      ),
    enrollmentOfOrder: orderId => one('SELECT id,status,created_at FROM enrollments WHERE order_id=?', orderId),
    names: o => ({
      course: one('SELECT title FROM courses WHERE id=?', o.course_id)?.title || 'curso',
      edition: one('SELECT name FROM editions WHERE id=?', o.edition_id)?.name || '',
    }),
  };
}
