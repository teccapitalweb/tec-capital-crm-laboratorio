// Todo el SQL del motor de costo de WhatsApp (docs/PLAN_CIMIENTOS_DIFUSIONES.md §4). Ninguna función abre una
// transacción: el registro de costos corre como oyente del estado de Meta y debe poder componerse (riesgo F-1).
const HOUR = 3_600_000;

export function createRepo(db) {
  const one = sql => {
    let statement = null;
    return (...args) => (statement ??= db.prepare(sql)).get(...args);
  };
  const all = sql => {
    let statement = null;
    return (...args) => (statement ??= db.prepare(sql)).all(...args);
  };
  const run = sql => {
    let statement = null;
    return (...args) => (statement ??= db.prepare(sql)).run(...args);
  };
  const placeholders = list => list.map(() => '?').join(',');

  return {
    // ---- reglas y tarifas (fechadas: manda la fila vigente en el instante pedido)
    rules: one('SELECT * FROM wa_pricing_rules WHERE effective_from<=? ORDER BY effective_from DESC LIMIT 1'),
    rulesList: all('SELECT * FROM wa_pricing_rules ORDER BY effective_from DESC'),
    rule: one('SELECT * FROM wa_pricing_rules WHERE effective_from=?'),
    addRule: run(
      'INSERT INTO wa_pricing_rules(effective_from,free_service_per_number,free_entry_days,free_entry_reply_hours,service_charged,utility_in_window_free,verified,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ),
    // la del mercado exacto si existe; si no, la de «cualquier otro» (*)
    rate: one(
      "SELECT * FROM wa_rates WHERE market IN (?,'*') AND category=? AND effective_from<=? ORDER BY market='*', effective_from DESC LIMIT 1",
    ),
    rates: all('SELECT * FROM wa_rates ORDER BY market,category,effective_from DESC'),
    rateAt: one('SELECT * FROM wa_rates WHERE market=? AND category=? AND effective_from=?'),
    addRate: run(
      'INSERT INTO wa_rates(id,market,category,currency,rate_micros,effective_from,verified,source,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ),

    // ---- cuenta de WhatsApp Business (se crea al primer uso)
    account: one('SELECT * FROM wa_account WHERE waba_id=?'),
    createAccount: run('INSERT OR IGNORE INTO wa_account(waba_id,created_at,updated_at) VALUES(?,?,?)'),

    // ---- libro de costos
    cost: one('SELECT * FROM wa_message_costs WHERE provider_ref=?'),
    insertCost: run(
      'INSERT OR IGNORE INTO wa_message_costs(provider_ref,phone_number_id,brand_id,market,origin,campaign_id,category,category_source,price_type,billable,delivered_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ),
    // completa lo que faltaba; la categoría de Meta sustituye a la del CRM. Nunca borra un dato.
    completeCost: run(
      "UPDATE wa_message_costs SET category=CASE WHEN ?1 IS NOT NULL THEN ?1 ELSE category END,category_source=CASE WHEN ?1 IS NOT NULL THEN 'meta' ELSE category_source END,price_type=COALESCE(price_type,?2),billable=COALESCE(billable,?3),delivered_at=COALESCE(delivered_at,?4) WHERE provider_ref=?5",
    ),
    // de dónde salió un mensaje real: del chat (conversación con número de WhatsApp) o de una difusión
    chatOrigin: one(
      'SELECT m.id,m.category,c.brand_id,c.wa_number,c.wa_peer FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.provider_ref=? AND c.wa_number IS NOT NULL',
    ),
    campaignOrigin: one(
      'SELECT r.campaign_id,r.wa_to,c.brand_id,c.wa_number FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE r.provider_ref=?',
    ),
    serviceDelivered: one(
      "SELECT count(*) n FROM wa_message_costs WHERE phone_number_id=? AND category='service' AND delivered_at>=? AND delivered_at<?",
    ),
    // Grupos de mensajes entregados en [from, to) por número, mercado, categoría, dato de Meta y hora (en orden): el
    // medidor reparte la cuota de servicio en orden de entrega y aplica la tarifa vigente al inicio de cada hora.
    groups(brandIds, from, to) {
      if (!brandIds.length) return [];
      return db
        .prepare(
          `SELECT phone_number_id,brand_id,market,category,price_type,billable,origin,campaign_id,
             (delivered_at/${HOUR})*${HOUR} AS bucket,count(*) AS n
           FROM wa_message_costs WHERE delivered_at>=? AND delivered_at<? AND brand_id IN (${placeholders(brandIds)})
           GROUP BY phone_number_id,brand_id,market,category,price_type,billable,origin,campaign_id,bucket
           ORDER BY phone_number_id,bucket`,
        )
        .all(from, to, ...brandIds);
    },
    // La cuota es del NÚMERO aunque se mire una sola marca: cuenta los mensajes de servicio de todas sus marcas.
    serviceGroups(numbers, from, to) {
      if (!numbers.length) return [];
      return db
        .prepare(
          `SELECT phone_number_id,brand_id,price_type,billable,(delivered_at/${HOUR})*${HOUR} AS bucket,count(*) AS n
           FROM wa_message_costs WHERE category='service' AND delivered_at>=? AND delivered_at<? AND phone_number_id IN (${placeholders(numbers)})
           GROUP BY phone_number_id,brand_id,price_type,billable,bucket
           ORDER BY phone_number_id,bucket,billable IS NULL,brand_id,price_type`,
        )
        .all(from, to, ...numbers);
    },
    numbers(brandIds) {
      if (!brandIds.length) return [];
      return db
        .prepare(
          `SELECT phone_number_id,brand_id,label FROM wa_numbers WHERE brand_id IN (${placeholders(brandIds)}) ORDER BY brand_id,phone_number_id`,
        )
        .all(...brandIds);
    },
    // ---- ventana gratuita por anuncio: primer saliente después del anuncio
    firstReplyAfter: one(
      "SELECT min(created_at) at FROM messages WHERE conversation_id=? AND sender_kind IN ('agent','automation') AND created_at>=?",
    ),
  };
}
