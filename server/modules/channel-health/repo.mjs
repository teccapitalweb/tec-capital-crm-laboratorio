// Todo el SQL de la salud del canal (docs/PLAN_SALUD_NUMERO.md). Ninguna función abre una transacción: el módulo
// decide dónde va cada una, y los avisos de Meta llegan como oyente dentro de la del procesador de webhooks.
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
    // ---- números del CRM (wa_numbers) y su salud
    numbers: all(
      'SELECT n.phone_number_id,n.brand_id,n.label,n.enabled,b.name brand_name FROM wa_numbers n LEFT JOIN brands b ON b.id=n.brand_id ORDER BY n.brand_id,n.phone_number_id',
    ),
    number: one('SELECT phone_number_id,brand_id,label,enabled FROM wa_numbers WHERE phone_number_id=?'),
    health: one('SELECT * FROM channel_health WHERE account_ref=?'),
    healthAll: all('SELECT * FROM channel_health'),
    ensureHealth: run(
      'INSERT OR IGNORE INTO channel_health(account_ref,brand_id,phone_number_id,created_at,updated_at) VALUES(?,?,?,?,?)',
    ),
    saveHealth: run(
      `UPDATE channel_health SET brand_id=?,display=?,verified_name=?,name_status=?,status=?,quality=?,official=?,
         checked_at=?,error=?,refresh_due=CASE WHEN refresh_due>=? THEN refresh_due END,updated_at=? WHERE account_ref=?`,
    ),
    setHealthError: run(
      'UPDATE channel_health SET checked_at=?,error=?,refresh_due=CASE WHEN refresh_due>=? THEN refresh_due END,updated_at=? WHERE account_ref=?',
    ),
    // un aviso: lo que dijo Meta, sin esperar a la relectura
    noteHealth: run(
      `UPDATE channel_health SET status=?,quality=?,name_status=?,last_webhook_at=?,
         refresh_due=?,updated_at=? WHERE account_ref=?`,
    ),
    // números de difusiones en curso: se releen cada 15 minutos
    busyNumbers: all(
      "SELECT DISTINCT wa_number FROM campaigns WHERE wa_number IS NOT NULL AND status IN ('sending','running','scheduled')",
    ),

    // ---- cuenta de WhatsApp Business (wa_account; la fila se crea al primer uso)
    account: one('SELECT * FROM wa_account WHERE waba_id=?'),
    createAccount: run('INSERT OR IGNORE INTO wa_account(waba_id,created_at,updated_at) VALUES(?,?,?)'),
    saveAccountRead: run(
      `UPDATE wa_account SET review_status=?,business_verification=?,health_checked_at=?,health_error=?,
         health_due=CASE WHEN health_due>=? THEN health_due END,updated_at=? WHERE waba_id=?`,
    ),
    setAccountError: run(
      'UPDATE wa_account SET health_checked_at=?,health_error=?,health_due=CASE WHEN health_due>=? THEN health_due END,updated_at=? WHERE waba_id=?',
    ),
    // el límite que dio Meta; uno fijado a mano (limit_source 'manual') no se pisa
    setLimit: run(
      "UPDATE wa_account SET messaging_limit=?,limit_value=?,limit_source='meta',updated_at=? WHERE waba_id=? AND COALESCE(limit_source,'')!='manual'",
    ),
    setReview: run('UPDATE wa_account SET review_status=?,updated_at=? WHERE waba_id=?'),
    setVerification: run('UPDATE wa_account SET business_verification=?,updated_at=? WHERE waba_id=?'),
    setRestriction: run('UPDATE wa_account SET restriction=?,restricted_until=?,updated_at=? WHERE waba_id=?'),
    setPayment: run('UPDATE wa_account SET payment_status=?,payment_note=?,payment_at=?,updated_at=? WHERE waba_id=?'),
    accountWebhook: run('UPDATE wa_account SET last_webhook_at=?,health_due=?,updated_at=? WHERE waba_id=?'),

    // ---- historial
    addEvent: run(
      'INSERT INTO channel_health_events(account_ref,brand_id,field,old_value,new_value,source,created_at) VALUES(?,?,?,?,?,?,?)',
    ),
    events(brandIds, withAccount, limit) {
      const brands = [...brandIds, ...(withAccount ? ['*'] : [])];
      if (!brands.length) return [];
      return db
        .prepare(
          `SELECT * FROM channel_health_events WHERE brand_id IN (${placeholders(brands)}) ORDER BY seq DESC LIMIT ?`,
        )
        .all(...brands, limit);
    },

    // ---- lo usado del límite diario: personas distintas que recibieron una plantilla en la ventana pedida, por chat o
    // por difusión, sumando todos los números (el límite es de la cuenta, no del número). Estimación propia.
    usedSince: one(
      `SELECT count(*) n FROM (
         SELECT c.wa_peer p FROM messages m JOIN conversations c ON c.id=m.conversation_id
           WHERE m.wa_template IS NOT NULL AND c.wa_number IS NOT NULL AND c.wa_peer IS NOT NULL AND m.created_at>=?1
         UNION
         SELECT r.wa_to FROM campaign_recipients r WHERE r.wa_to IS NOT NULL AND r.sent_at>=?1
       )`,
    ),

    // ---- avisos al equipo (tabla de notificaciones de siempre; un aviso repetido no se duplica)
    staff: all("SELECT id,role,disabled FROM users WHERE role IN ('admin','agent') AND disabled=0"),
    notify: run(
      'INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,NULL,?,?,?,?)',
    ),
    brandIds: all('SELECT id FROM brands ORDER BY created_at,id'),
  };
}
