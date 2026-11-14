// Todo el SQL del motor de difusiones (docs/PLAN_MOTOR_DIFUSIONES.md). Las funciones que leen o escriben datos de una
// marca reciben `brandId` primero; ninguna abre una transacción (las abre quien llama, sin red dentro) y todas usan
// parámetros. Sólo campañas `kind='template'`: las de catálogo son de server/campaigns.mjs.
const LIVE = "COALESCE(json_extract(c.options,'$.mode'),'live')='live'";

export function createRepo(db) {
  const cache = new Map();
  const prepared = sql => {
    let statement = cache.get(sql);
    if (!statement) cache.set(sql, (statement = db.prepare(sql)));
    return statement;
  };
  const one =
    sql =>
    (...args) =>
      prepared(sql).get(...args);
  const all =
    sql =>
    (...args) =>
      prepared(sql).all(...args);
  const run =
    sql =>
    (...args) =>
      prepared(sql).run(...args);
  const marks = list => list.map(() => '?').join(',');

  return {
    // ---- campañas
    campaign: one("SELECT * FROM campaigns WHERE brand_id=? AND id=? AND kind='template'"),
    campaignAny: one("SELECT * FROM campaigns WHERE id=? AND kind='template'"),
    byClientRef: one("SELECT * FROM campaigns WHERE client_ref=? AND kind='template'"),
    insertCampaign: run(
      "INSERT INTO campaigns(id,brand_id,kind,title,wa_template_id,wa_number,content,segment,require_consent,options,status,scheduled_at,timezone,revision,client_ref,created_by,created_at,updated_at) VALUES(?,?,'template',?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)",
    ),
    updateDraft: run(
      "UPDATE campaigns SET title=?,wa_template_id=?,wa_number=?,content=?,segment=?,require_consent=?,options=?,audience_confirmed=NULL,cost_estimate=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='draft'",
    ),
    list(brandIds, { status = null, limit = 50, offset = 0 } = {}) {
      if (!brandIds.length) return { rows: [], total: 0 };
      const where = `kind='template' AND brand_id IN (${marks(brandIds)})` + (status ? ' AND status=?' : '');
      const args = [...brandIds, ...(status ? [status] : [])];
      return {
        rows: prepared(`SELECT * FROM campaigns WHERE ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(
          ...args,
          limit,
          offset,
        ),
        total: prepared(`SELECT count(*) n FROM campaigns WHERE ${where}`).get(...args).n,
      };
    },
    // Cambio de estado con revisión y estado de partida (409 si no coincide: lo decide quien llama por `changes`).
    transition: run(
      "UPDATE campaigns SET status=?,status_reason=?,resume_status=?,revision=revision+1,updated_at=? WHERE id=? AND kind='template' AND status=?",
    ),
    schedule: run(
      "UPDATE campaigns SET status='scheduled',status_reason=NULL,scheduled_at=?,audience_confirmed=?,cost_estimate=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='draft'",
    ),
    unschedule: run(
      "UPDATE campaigns SET status='draft',status_reason=NULL,audience_confirmed=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='scheduled'",
    ),
    setReason: run("UPDATE campaigns SET status_reason=? WHERE id=? AND COALESCE(status_reason,'')!=COALESCE(?,'')"),
    launched: run(
      "UPDATE campaigns SET status='sending',status_reason=NULL,started_at=COALESCE(started_at,?),launched_at=?,audience_size=?,batch_no=0,batch_release_at=NULL,retry_until=?,revision=revision+1,updated_at=? WHERE id=? AND status='scheduled'",
    ),
    releaseBatch: run(
      'UPDATE campaigns SET batch_no=batch_no+1,batch_release_at=NULL,status_reason=NULL,updated_at=? WHERE id=? AND batch_no=?',
    ),
    batchWait: run('UPDATE campaigns SET batch_release_at=? WHERE id=? AND batch_release_at IS NULL'),
    complete: run(
      "UPDATE campaigns SET status='completed',status_reason=NULL,finished_at=?,revision=revision+1,updated_at=? WHERE id=? AND status='sending'",
    ),
    due: all(
      "SELECT * FROM campaigns WHERE kind='template' AND status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 5",
    ),
    sending: all("SELECT * FROM campaigns WHERE kind='template' AND status='sending' ORDER BY launched_at LIMIT 50"),
    apiCampaign: one("SELECT * FROM campaigns WHERE kind='template' AND client_ref=?"),
    event: run('INSERT INTO campaign_events(campaign_id,kind,details,actor_id,created_at) VALUES(?,?,?,?,?)'),
    lastEvent: one('SELECT kind,details FROM campaign_events WHERE campaign_id=? ORDER BY seq DESC LIMIT 1'),
    events: all(
      'SELECT e.kind,e.details,e.created_at,u.name actor_name FROM campaign_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.campaign_id=? ORDER BY e.seq DESC LIMIT 100',
    ),

    // ---- destinatarios
    insertRecipient: run(
      'INSERT INTO campaign_recipients(id,campaign_id,contact_id,enrolled,state,position,batch_no,wa_to,wa_recipient,next_at,skip_reason,client_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,?,?)',
    ),
    recipient: one('SELECT * FROM campaign_recipients WHERE id=?'),
    recipientOf: one(
      'SELECT r.* FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.brand_id=? AND r.id=?',
    ),
    recipientByRef: one('SELECT * FROM campaign_recipients WHERE provider_ref=?'),
    recipientByClientRef: one('SELECT * FROM campaign_recipients WHERE client_ref=?'),
    recipientOfContact: one('SELECT * FROM campaign_recipients WHERE campaign_id=? AND contact_id=?'),
    dueRecipients: all(
      "SELECT * FROM campaign_recipients WHERE campaign_id=? AND state IN ('queued','deferred') AND next_at<=? AND batch_no<=? ORDER BY position, id LIMIT ?",
    ),
    reserve: run(
      "UPDATE campaign_recipients SET state='sending',attempts=attempts+1,lease_owner=?,lease_until=?,params=?,rendered=?,updated_at=? WHERE id=? AND state IN ('queued','deferred')",
    ),
    sent: run(
      "UPDATE campaign_recipients SET state='sent',sent_at=?,provider_ref=?,wa_id=?,lease_owner=NULL,lease_until=NULL,fail_code=NULL,fail_kind=NULL,fail_reason=NULL,updated_at=? WHERE id=? AND state='sending' AND attempts=?",
    ),
    requeue: run(
      "UPDATE campaign_recipients SET state='queued',attempts=MAX(attempts-?,0),next_at=?,lease_owner=NULL,lease_until=NULL,fail_code=?,fail_reason=?,updated_at=? WHERE id=? AND state='sending'",
    ),
    failed: run(
      "UPDATE campaign_recipients SET state='failed',failed_at=?,fail_code=?,fail_kind=?,fail_reason=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state IN ('sending','sent','queued','deferred')",
    ),
    deferred: run(
      "UPDATE campaign_recipients SET state='deferred',next_at=?,fail_code=?,fail_reason=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state IN ('sending','sent')",
    ),
    skip: run(
      "UPDATE campaign_recipients SET state='skipped',enrolled=0,skip_reason=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state IN ('queued','deferred','sending')",
    ),
    cancelPending: run(
      "UPDATE campaign_recipients SET state='cancelled',skip_reason='campaign_cancelled',updated_at=? WHERE campaign_id=? AND state IN ('queued','deferred')",
    ),
    adoptRef: run(
      "UPDATE campaign_recipients SET state='sent',provider_ref=?,sent_at=COALESCE(sent_at,?),lease_owner=NULL,lease_until=NULL,fail_kind=NULL,updated_at=? WHERE id=? AND state IN ('sending','failed') AND attempts=? AND provider_ref IS NULL",
    ),
    delivered: run(
      "UPDATE campaign_recipients SET state=CASE WHEN state='read' THEN 'read' ELSE 'delivered' END,delivered_at=COALESCE(delivered_at,?),updated_at=? WHERE id=? AND state IN ('sending','sent','delivered','read')",
    ),
    read: run(
      "UPDATE campaign_recipients SET state='read',delivered_at=COALESCE(delivered_at,?),read_at=COALESCE(read_at,?),updated_at=? WHERE id=? AND state IN ('sending','sent','delivered','read')",
    ),
    // en duda tras un reinicio o un tiempo de espera: nunca se reenvía; pasado el plazo queda fallido «sin confirmar»
    stale: all(
      "SELECT r.*,c.brand_id FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE r.state='sending' AND r.lease_until<? AND r.updated_at<? LIMIT 200",
    ),
    expiredRetries: all(
      "SELECT r.id,r.campaign_id FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE r.state='deferred' AND c.retry_until IS NOT NULL AND c.retry_until<? LIMIT 500",
    ),
    rehearsalSent: all(
      "SELECT r.id,r.campaign_id,r.state,r.sent_at FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.status IN ('sending','paused','stopped','completed') AND r.provider_ref LIKE 'sim\\_%' ESCAPE '\\' AND r.state IN ('sent','delivered') AND r.sent_at<? AND r.read_at IS NULL LIMIT 500",
    ),
    pendingCount: one(
      "SELECT sum(state='queued') queued,sum(state='sending') sending,sum(state='deferred') deferred FROM campaign_recipients WHERE campaign_id=?",
    ),
    batchOpen: one(
      "SELECT count(*) n FROM campaign_recipients WHERE campaign_id=? AND batch_no<=? AND state IN ('queued','sending')",
    ),
    maxBatch: one('SELECT COALESCE(MAX(batch_no),0) n FROM campaign_recipients WHERE campaign_id=? AND enrolled=1'),
    // últimos resultados de la campaña para la tasa de fallos (sin los fallos que son de la persona)
    outcomes: all(
      "SELECT state='failed' AND COALESCE(fail_code,0) NOT IN (131049,131026) bad FROM campaign_recipients WHERE campaign_id=? AND updated_at>=? AND state IN ('sent','delivered','read','failed') AND COALESCE(fail_kind,'')!='unconfirmed' ORDER BY updated_at DESC LIMIT 50",
    ),
    since: one("SELECT max(created_at) at FROM campaign_events WHERE campaign_id=? AND kind IN ('launched','resumed')"),
    streak: all(
      "SELECT fail_code FROM campaign_recipients WHERE campaign_id=? AND state IN ('sent','delivered','read','failed') ORDER BY updated_at DESC LIMIT 3",
    ),
    stats(campaignIds) {
      if (!campaignIds.length) return [];
      return prepared(
        `SELECT campaign_id,state,count(*) n,sum(replied_at IS NOT NULL) replied,sum(clicked_at IS NOT NULL) clicked FROM campaign_recipients WHERE campaign_id IN (${marks(campaignIds)}) GROUP BY campaign_id,state`,
      ).all(...campaignIds);
    },
    reasons: all(
      "SELECT skip_reason reason,count(*) n FROM campaign_recipients WHERE campaign_id=? AND state IN ('skipped','cancelled') GROUP BY skip_reason",
    ),
    failures: all(
      "SELECT fail_code code,fail_kind kind,max(fail_reason) reason,count(*) n FROM campaign_recipients WHERE campaign_id=? AND state='failed' GROUP BY fail_code,fail_kind ORDER BY n DESC LIMIT 20",
    ),
    recipientsPage(campaignId, { state = null, limit = 50, offset = 0 } = {}) {
      const where = 'r.campaign_id=?' + (state ? ' AND r.state=?' : '');
      const args = [campaignId, ...(state ? [state] : [])];
      return {
        rows: prepared(
          `SELECT r.*,k.name contact_name FROM campaign_recipients r JOIN contacts k ON k.id=r.contact_id WHERE ${where} ORDER BY r.position IS NULL, r.position, r.id LIMIT ? OFFSET ?`,
        ).all(...args, limit, offset),
        total: prepared(`SELECT count(*) n FROM campaign_recipients r WHERE ${where}`).get(...args).n,
      };
    },
    // personas distintas a las que el número escribió con plantilla (difusiones reales) en las últimas 24 h
    usedToday: one(
      `SELECT count(DISTINCT r.wa_to) n FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.wa_number=? AND r.sent_at>=? AND ${LIVE}`,
    ),
    recentCampaign: one(
      `SELECT 1 FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE r.contact_id=? AND c.brand_id=? AND r.campaign_id!=? AND r.sent_at>=? AND ${LIVE} LIMIT 1`,
    ),

    // ---- atribución de la respuesta (fila 25)
    lastSentTo: one(
      `SELECT r.* FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE (r.wa_to=? OR r.wa_id=?) AND c.wa_number=? AND r.sent_at>=? AND r.replied_at IS NULL AND r.state IN ('sent','delivered','read') AND ${LIVE} ORDER BY r.sent_at DESC LIMIT 1`,
    ),
    attributionDays() {
      try {
        return prepared('SELECT attribution_days d FROM inbox_settings LIMIT 1').get()?.d ?? null;
      } catch {
        return null; // la tabla de ajustes de la bandeja todavía no existe: 7 días
      }
    },
    replied: run(
      'UPDATE campaign_recipients SET replied_at=COALESCE(replied_at,?),reply_kind=COALESCE(reply_kind,?),clicked_at=CASE WHEN ? IS NOT NULL THEN COALESCE(clicked_at,?) ELSE clicked_at END,click_label=COALESCE(click_label,?),conversation_id=COALESCE(conversation_id,?),message_id=COALESCE(message_id,?),updated_at=? WHERE id=?',
    ),
    adoptContact: run(
      'UPDATE contacts SET source_user_id=?,updated_at=? WHERE id=? AND brand_id=? AND source_user_id IS NULL AND NOT EXISTS(SELECT 1 FROM contacts x WHERE x.source_user_id=? AND x.brand_id=?)',
    ),
    messageByRef: one('SELECT id FROM messages WHERE client_ref=?'),
    stampMessage: run(
      'UPDATE messages SET created_at=?,provider_ref=?,delivery_state=?,delivered_at=? WHERE id=? AND provider_ref IS NULL',
    ),

    // ---- datos de la marca
    settings: one('SELECT * FROM campaign_settings WHERE brand_id=?'),
    upsertSettings: run(
      'INSERT INTO campaign_settings(brand_id,enabled,rate_per_minute,daily_cap,quiet_start,quiet_end,monthly_budget_cents,fail_stop_pct,revision,updated_by,updated_at) VALUES(?,0,?,?,?,?,?,?,1,?,?) ON CONFLICT(brand_id) DO UPDATE SET rate_per_minute=excluded.rate_per_minute,daily_cap=excluded.daily_cap,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,monthly_budget_cents=excluded.monthly_budget_cents,fail_stop_pct=excluded.fail_stop_pct,revision=campaign_settings.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    ),
    brand: one('SELECT id,name FROM brands WHERE id=?'),
    timezone(brandId) {
      try {
        return prepared('SELECT timezone FROM operation_settings WHERE brand_id=?').get(brandId)?.timezone ?? null;
      } catch {
        return null;
      }
    },
    failureRate: one('SELECT failure_rate FROM channel_settings WHERE brand_id=?'),
    contact: one('SELECT id,brand_id,name,phone,phone_key,source_user_id FROM contacts WHERE brand_id=? AND id=?'),
    contactByKey: one(
      'SELECT id,brand_id,name,phone,phone_key FROM contacts WHERE brand_id=? AND phone_key=? ORDER BY created_at LIMIT 1',
    ),
    consent: one('SELECT status FROM contact_consent WHERE contact_id=?'),
    template: one('SELECT * FROM wa_templates WHERE id=?'),
    templates: all(
      "SELECT * FROM wa_templates WHERE brand_id=? AND archived_at IS NULL AND status IN ('approved','flagged','pending') ORDER BY name LIMIT 200",
    ),
    number: one('SELECT * FROM wa_numbers WHERE brand_id=? AND phone_number_id=?'),
    numberAny: one('SELECT * FROM wa_numbers WHERE phone_number_id=?'),
    numbers: all('SELECT phone_number_id,label,enabled FROM wa_numbers WHERE brand_id=? ORDER BY label'),
    accountLimit: one(
      'SELECT limit_value FROM wa_account WHERE limit_value IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
    ),
    course: one('SELECT id,title,active FROM courses WHERE brand_id=? AND id=?'),
    edition: one('SELECT id,name,course_id,status FROM editions WHERE brand_id=? AND id=?'),
    courses: all(
      "SELECT c.id,c.title,(SELECT json_group_array(json_object('id',e.id,'name',e.name)) FROM editions e WHERE e.course_id=c.id AND e.status='published') editions FROM courses c WHERE c.brand_id=? AND c.active=1 ORDER BY c.title",
    ),
    coupon: one("SELECT code FROM coupons WHERE brand_id=? AND id=? AND status='active'"),
  };
}
