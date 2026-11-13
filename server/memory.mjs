// Memoria del cliente para la IA (docs/PLAN_MEMORIA_CONTEXTO.md). La IA no recuerda nada entre llamadas: lo que «sabe» de una persona
// es lo que el CRM le arma en cada respuesta. Esta ficha se deriva de las tablas verdaderas (conversaciones, oportunidades, pedidos
// e inscripciones), así que nunca se desactualiza y no hay una segunda copia que mantener.
// Reglas de privacidad y alcance:
//  - SÓLO de la marca de la conversación: nada de otras marcas aunque la persona exista en ambas (una marca autorizada no
//    equivale a acceso a toda la empresa).
//  - Sin teléfono, correo, importes, notas internas, motivos de pérdida ni etiquetas del equipo (texto libre que no debe orientar una respuesta).
//  - Lo que escribe el cliente (su nombre) se reduce a una palabra corta de letras; el texto de catálogo se limpia. Y se entrega a la IA como
//    BLOQUE DE DATOS delimitado, no como instrucciones (ver ai-provider.mjs).
//  - Corta (máx. ~700 caracteres) y escrita para el modelo; queda a la vista del equipo en el «por qué respondió» de cada respuesta.
const STAGE = {
  nuevo: 'nuevo interés',
  interesado: 'interesado',
  inscripcion: 'pidió inscribirse',
  ganada: 'inscrito',
  perdida: 'lo dejó pasar',
};
const day = 86400000;

export function customerMemory(db, c, { now = Date.now } = {}) {
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id);
  // El nombre lo escribe el propio cliente (dato NO confiable): sólo se usa una palabra corta de letras; cualquier otra cosa se descarta
  // para que no pueda colar instrucciones en lo que lee la IA.
  const first = (user?.name || '').trim().split(/\s+/)[0] || '',
    name = /^[\p{L}'’-]{1,24}$/u.test(first) ? first : null;
  const contact = db
    .prepare('SELECT id,created_at FROM contacts WHERE brand_id=? AND source_user_id=?')
    .get(c.brand_id, c.customer_id);
  const convs = db
    .prepare(
      'SELECT id,course_id,channel,created_at FROM conversations WHERE brand_id=? AND customer_id=? ORDER BY created_at',
    )
    .all(c.brand_id, c.customer_id);
  const clean = (s, max) =>
    String(s ?? '')
      .replace(/[<>\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  const title = id => clean(db.prepare('SELECT title FROM courses WHERE id=?').get(id)?.title || 'curso', 80);
  const firstAt = Math.min(...convs.map(x => x.created_at), contact?.created_at ?? Infinity),
    days = Number.isFinite(firstAt) ? Math.max(0, Math.floor((now() - firstAt) / day)) : 0;
  const channels = [...new Set(convs.map(x => x.channel))];

  // cursos por los que ha preguntado en esta marca, con la etapa de su oportunidad (la conversación actual no cuenta como «otro»)
  const opps = contact
    ? db
        .prepare(
          'SELECT course_id,stage FROM opportunities WHERE contact_id=? AND brand_id=? ORDER BY updated_at DESC LIMIT 6',
        )
        .all(contact.id, c.brand_id)
    : [];
  const seen = new Set(),
    interests = [];
  for (const o of opps) {
    if (seen.has(o.course_id)) continue;
    seen.add(o.course_id);
    interests.push({
      courseId: o.course_id,
      course: title(o.course_id),
      stage: o.stage,
      current: o.course_id === c.course_id,
    });
  }
  for (const x of convs) {
    if (!seen.has(x.course_id)) {
      seen.add(x.course_id);
      interests.push({
        courseId: x.course_id,
        course: title(x.course_id),
        stage: null,
        current: x.course_id === c.course_id,
      });
    }
  }

  const enrolled = contact
    ? db
        .prepare("SELECT DISTINCT course_id FROM enrollments WHERE contact_id=? AND brand_id=? AND status='enrolled'")
        .all(contact.id, c.brand_id)
        .map(r => title(r.course_id))
    : [];
  const pending = contact
    ? db
        .prepare("SELECT count(*) n FROM orders WHERE contact_id=? AND brand_id=? AND status IN ('pending','review')")
        .get(contact.id, c.brand_id).n
    : 0;
  const lapsed = contact
    ? db
        .prepare(
          "SELECT count(*) n FROM orders WHERE contact_id=? AND brand_id=? AND status IN ('cancelled','expired')",
        )
        .get(contact.id, c.brand_id).n
    : 0;

  const facts = {
    name,
    days,
    conversations: convs.length,
    channels,
    interests,
    enrolled,
    pendingOrders: pending,
    lapsedOrders: lapsed,
  };

  const lines = [];
  lines.push(
    `Se llama ${name || '(sin nombre)'}. Primer contacto con esta marca hace ${days < 1 ? 'menos de un día' : days + ' día' + (days === 1 ? '' : 's')}; ${convs.length} conversación${convs.length === 1 ? '' : 'es'} (${channels.join(', ') || 'sin canal'}).`,
  );
  const others = interests.filter(i => !i.current);
  if (others.length)
    lines.push(
      'Ya ha preguntado por: ' +
        others
          .slice(0, 4)
          .map(i => i.course + (i.stage ? ' (' + STAGE[i.stage] + ')' : ''))
          .join('; ') +
        '.',
    );
  const cur = interests.find(i => i.current);
  if (cur?.stage) lines.push('En el curso de esta conversación está: ' + STAGE[cur.stage] + '.');
  if (enrolled.length) lines.push('Ya está inscrito en: ' + enrolled.slice(0, 3).join('; ') + '.');
  if (pending) lines.push('Tiene un pedido de pago pendiente (no confirmes ni cambies nada: lo ve una persona).');
  else if (lapsed) lines.push('Tuvo un pedido que se canceló o venció.');
  const text = lines.join(' ').slice(0, 700);
  return { facts, text };
}
