// Hilo de una persona (docs/PLAN_CICLO_DE_VIDA.md; diseño de bandeja §2.6, conciliación fila 24). Sólo lectura.
//
// Es la ÚNICA búsqueda de «la conversación de esta persona»: la usan el entrante de WhatsApp, el alta de una
// conversación del laboratorio y el ciclo de vida (lifecycle.threadFor). Comportamiento de hoy («episodes»): la
// conversación viva del hilo (status != 'resolved', incluye las expiradas); si no hay, ninguna y quien llama crea una
// nueva, que apunta a la anterior con previous_id. El hilo continuo («continuous») es del incremento 5.
//
// Clave del hilo:
//   - WhatsApp real: persona + marca + número del negocio (customerId, brandId, waNumber);
//   - laboratorio: persona + curso + edición + canal (customerId, courseId, editionId, channel).

export function findThread(
  db,
  { customerId, brandId = null, waNumber = null, courseId = null, editionId = null, channel = null },
) {
  const real = Boolean(waNumber);
  const conversation = real
    ? db
        .prepare(
          "SELECT * FROM conversations WHERE customer_id=? AND wa_number=? AND brand_id=? AND status!='resolved' ORDER BY updated_at DESC LIMIT 1",
        )
        .get(customerId, waNumber, brandId)
    : db
        .prepare(
          "SELECT * FROM conversations WHERE customer_id=? AND course_id=? AND edition_id=? AND channel=? AND status!='resolved'",
        )
        .get(customerId, courseId, editionId, channel);
  return {
    conversation: conversation ?? null,
    previousId: conversation ? null : previousOf(db, { customerId, brandId, waNumber, courseId, editionId, channel }),
  };
}

// La conversación más reciente del hilo, sea cual sea su estado (sin `excludeId`, la última de todas).
export function previousOf(
  db,
  {
    customerId,
    brandId = null,
    waNumber = null,
    courseId = null,
    editionId = null,
    channel = null,
    excludeId = '',
    before = Number.MAX_SAFE_INTEGER,
  },
) {
  const row = waNumber
    ? db
        .prepare(
          'SELECT id FROM conversations WHERE customer_id=? AND brand_id=? AND wa_number=? AND id!=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 1',
        )
        .get(customerId, brandId, waNumber, excludeId, before)
    : db
        .prepare(
          'SELECT id FROM conversations WHERE customer_id=? AND course_id=? AND edition_id IS ? AND channel=? AND wa_number IS NULL AND id!=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 1',
        )
        .get(customerId, courseId, editionId, channel, excludeId, before);
  return row?.id ?? null;
}

// La clave del hilo de una conversación ya guardada.
export const threadKey = c => ({
  customerId: c.customer_id,
  brandId: c.brand_id,
  waNumber: c.wa_number || null,
  courseId: c.course_id,
  editionId: c.edition_id ?? null,
  channel: c.channel,
});
