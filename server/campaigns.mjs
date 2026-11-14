import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { cancelSteps } from './automation.mjs';
import { parseRates } from './presentation.mjs';
import { createAccess } from './lib/access.mjs';

// Campañas y envíos segmentados (Fase 5, bloque 1; docs/PLAN_CAMPANAS.md). Una campaña es una plantilla aprobada, un
// segmento y una fecha. Cada destinatario es un paso durable del motor 4A (`campaign.send`) con clave de idempotencia
// `campaign:<campaña>:<contacto>`: reintentos y escaneos repetidos no duplican envíos. Todo apagado por marca por omisión.
// El estado de cada envío se lee del paso y del mensaje; aquí no se guardan contadores que puedan desajustarse.
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const KIND = 'campaign.send',
  HOUR = 3600000,
  DAY = 24 * HOUR,
  REPLY_WINDOW = 7 * DAY,
  MAX_RECIPE_MESSAGES_PER_DAY = 2;
export const STAGES = ['nuevo', 'interesado', 'inscripcion', 'ganada', 'perdida'];
export const CHANNELS = ['whatsapp', 'instagram', 'facebook'];
export const REASONS = {
  opted_out: 'Pidió la baja',
  suppressed: 'Está en una lista de exclusión de la marca',
  no_consent: 'Sin consentimiento registrado',
  conversation_closed: 'La conversación está cerrada',
  human_control: 'Lo atiende una persona del equipo',
  waiting_human: 'Espera a una persona del equipo',
  recent_campaign: 'Recibió otra campaña hace poco',
  frequency_limit: 'Alcanzó el tope de mensajes automáticos',
  template_unavailable: 'La plantilla no aplica a su curso, edición o canal',
  campaign_cancelled: 'La campaña se canceló',
  campaigns_disabled: 'Las campañas de la marca se apagaron',
  conversation_missing: 'La conversación ya no está disponible',
  contact_opted_out: 'Pidió la baja',
};
const integer = (v, min, max, label) => {
  if (!Number.isInteger(v) || v < min || v > max) throw fail(400, label + ' no válido.');
  return v;
};

export function createCampaigns({
  db,
  crm,
  catalogue,
  automation,
  insertMessage,
  broadcast,
  body,
  json,
  audit,
  now = Date.now,
  env = process.env,
}) {
  // Este módulo atiende las campañas de catálogo (kind 'catalogue', las de siempre). Las difusiones con plantilla
  // (kind 'template', docs/PLAN_CIMIENTOS_DIFUSIONES.md) no pasan por aquí: no tienen conversación ni paso por
  // destinatario, y su motor es otro. Para estas rutas, una difusión con plantilla no existe.
  const get = id =>
    typeof id === 'string' ? db.prepare("SELECT * FROM campaigns WHERE id=? AND kind='catalogue'").get(id) : null;
  // Permisos del catálogo (server/lib/permissions.mjs): campaigns.view, campaigns.edit y campaigns.send. Hoy sólo
  // administración los tiene, como antes; cuando haya roles, este módulo no cambia.
  const access = createAccess({ db, crm });
  const conv = id => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  // Audiencias (server/modules/audiences, docs/PLAN_AUDIENCIAS.md): el módulo se crea después de este servicio y se
  // presta con useAudiences(). Sin él, un público por audiencia no se acepta y nada más cambia.
  let audiences = null;
  function useAudiences(source) {
    audiences = source;
  }
  const defaults = b => ({
    brand_id: b,
    enabled: 0,
    min_gap_hours: 72,
    pace_seconds: 2,
    max_audience: 5000,
    revision: 0,
    updated_by: null,
    updated_at: null,
  });
  const settings = b => db.prepare('SELECT * FROM campaign_settings WHERE brand_id=?').get(b) || defaults(b);
  const event = (id, kind, details = {}, actor = null) =>
    db
      .prepare('INSERT INTO campaign_events(campaign_id,kind,details,actor_id,created_at) VALUES(?,?,?,?,?)')
      .run(id, kind, JSON.stringify(details), actor, now());
  const changed = brandId => broadcast('crm', null, { brandId });
  const guard = (c, input) => {
    if (!c) throw fail(404, 'Campaña no encontrada.');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== c.revision)
      throw fail(409, 'La campaña cambió. Recárgala.');
  };
  const rate = () => parseRates(env.MESSAGE_RATES).marketing;
  const money = amount => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(amount);

  // Sentencias preparadas una sola vez (las evaluaciones recorren miles de filas).
  const lazy = sql => {
    let s = null;
    return (...args) => (s ??= db.prepare(sql)).get(...args);
  };
  const consentOf = lazy('SELECT status FROM contact_consent WHERE contact_id=?');
  const campaignMessages = lazy(
    "SELECT count(*) n FROM messages m JOIN conversation_opportunities co ON co.conversation_id=m.conversation_id JOIN opportunities x ON x.id=co.opportunity_id WHERE x.contact_id=? AND m.client_ref LIKE 'campaign:%' AND m.created_at>?",
  );
  const recipeMessages = lazy(
    "SELECT count(*) n FROM messages m JOIN conversation_opportunities co ON co.conversation_id=m.conversation_id JOIN opportunities x ON x.id=co.opportunity_id WHERE x.contact_id=? AND m.client_ref LIKE 'recipe:%' AND m.created_at>?",
  );

  // ---- segmento
  function normalizeSegment(input, brandId) {
    const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {},
      out = {};
    // Una audiencia (lista o segmento) de la marca como público; se combina con los demás filtros.
    if (s.audienceId !== undefined && s.audienceId !== null) {
      if (!audiences) throw fail(400, 'Las audiencias no están disponibles.');
      out.audienceId = audiences.check(brandId, s.audienceId);
    }
    if (s.tagIds !== undefined) {
      if (!Array.isArray(s.tagIds) || s.tagIds.length < 1 || s.tagIds.length > 10)
        throw fail(400, 'Elige de una a diez etiquetas.');
      for (const id of s.tagIds) {
        const t = typeof id === 'string' ? db.prepare('SELECT brand_id FROM contact_tags WHERE id=?').get(id) : null;
        if (!t || t.brand_id !== brandId) throw fail(400, 'Etiqueta no válida para la marca.');
      }
      out.tagIds = [...new Set(s.tagIds)];
    }
    if (s.stages !== undefined) {
      if (!Array.isArray(s.stages) || !s.stages.length || s.stages.some(x => !STAGES.includes(x)))
        throw fail(400, 'Etapas no válidas.');
      out.stages = [...new Set(s.stages)];
    }
    if (s.courseId) {
      const k = db.prepare('SELECT brand_id FROM courses WHERE id=?').get(s.courseId);
      if (!k || k.brand_id !== brandId) throw fail(400, 'Curso no válido para la marca.');
      out.courseId = s.courseId;
    }
    if (s.editionId) {
      const e = db.prepare('SELECT brand_id,course_id FROM editions WHERE id=?').get(s.editionId);
      if (!e || e.brand_id !== brandId || (out.courseId && e.course_id !== out.courseId))
        throw fail(400, 'Edición no válida para la marca.');
      out.editionId = s.editionId;
    }
    if (s.channel) {
      if (!CHANNELS.includes(s.channel)) throw fail(400, 'Canal no válido.');
      out.channel = s.channel;
    }
    if (s.inactiveDays !== undefined && s.inactiveDays !== null)
      out.inactiveDays = integer(s.inactiveDays, 1, 365, 'Días sin responder');
    return out;
  }
  function templateOf(id, brandId, { forSend = false } = {}) {
    const t = typeof id === 'string' ? db.prepare('SELECT * FROM content_templates WHERE id=?').get(id) : null;
    if (!t || t.brand_id !== brandId) throw fail(400, 'Plantilla no válida para la marca.');
    if (t.status !== 'approved') throw fail(forSend ? 409 : 400, 'La plantilla debe estar aprobada.');
    return t;
  }

  // ---- público
  // Candidatos: por contacto, su conversación más reciente que cumpla el segmento (las abiertas pasan primero).
  function candidates(camp, seg) {
    const where = ['c.brand_id=?'],
      args = [camp.brand_id],
      ph = a => a.map(() => '?').join(',');
    if (seg.stages) {
      where.push(`o.stage IN (${ph(seg.stages)})`);
      args.push(...seg.stages);
    }
    if (seg.courseId) {
      where.push('v.course_id=?');
      args.push(seg.courseId);
    }
    if (seg.editionId) {
      where.push('v.edition_id=?');
      args.push(seg.editionId);
    }
    if (seg.channel) {
      where.push('v.channel=?');
      args.push(seg.channel);
    }
    if (seg.audienceId) {
      // Sin el módulo de audiencias el público no se amplía: no entra nadie.
      if (!audiences) where.push('0');
      else {
        const member = audiences.memberSql(camp.brand_id, seg.audienceId, { alias: 'c' });
        where.push(member.sql);
        args.push(...member.args);
      }
    }
    if (seg.tagIds) {
      where.push(`c.id IN (SELECT contact_id FROM contact_tag_links WHERE tag_id IN (${ph(seg.tagIds)}))`);
      args.push(...seg.tagIds);
    }
    if (seg.inactiveDays) {
      where.push(
        "COALESCE((SELECT MAX(m.created_at) FROM messages m JOIN conversation_opportunities k ON k.conversation_id=m.conversation_id JOIN opportunities y ON y.id=k.opportunity_id WHERE y.contact_id=c.id AND m.sender_kind='customer'),0)<?",
      );
      args.push(now() - seg.inactiveDays * DAY);
    }
    const rows = db
      .prepare(
        `SELECT v.*,c.id contact_id,c.name contact_name FROM contacts c JOIN opportunities o ON o.contact_id=c.id JOIN conversation_opportunities co ON co.opportunity_id=o.id JOIN conversations v ON v.id=co.conversation_id WHERE ${where.join(' AND ')} ORDER BY (v.status='resolved'),v.updated_at DESC,v.id LIMIT 50000`,
      )
      .all(...args);
    const seen = new Set();
    return rows.filter(r => !seen.has(r.contact_id) && seen.add(r.contact_id));
  }
  // Reglas de elegibilidad, las mismas en la vista previa, el lanzamiento y justo antes de cada envío.
  function judge(row, camp, ctx) {
    // Las listas de exclusión de la marca se restan siempre, sea cual sea el público.
    if (audiences?.suppressed(camp.brand_id, row.contact_id)) return 'suppressed';
    const consent = consentOf(row.contact_id)?.status || 'unknown';
    if (consent === 'opted_out') return 'opted_out';
    if (camp.require_consent && consent !== 'opted_in') return 'no_consent';
    if (row.status === 'resolved') return 'conversation_closed';
    if (row.assigned_to || !row.bot_enabled) return 'human_control';
    if (row.status === 'waiting') return 'waiting_human';
    if (ctx.set.min_gap_hours > 0 && campaignMessages(row.contact_id, now() - ctx.set.min_gap_hours * HOUR).n > 0)
      return 'recent_campaign';
    if (recipeMessages(row.contact_id, now() - DAY).n >= MAX_RECIPE_MESSAGES_PER_DAY) return 'frequency_limit';
    const key = row.course_id + '|' + row.edition_id + '|' + row.channel;
    if (!ctx.templates.has(key)) {
      let reason = null;
      try {
        catalogue.prepare(row, { templateId: camp.template_id }, row.contact_name);
      } catch {
        reason = 'template_unavailable';
      }
      ctx.templates.set(key, reason);
    }
    return ctx.templates.get(key);
  }
  function audience(camp) {
    const set = settings(camp.brand_id),
      ctx = { set, templates: new Map() },
      seg = JSON.parse(camp.segment),
      rows = candidates(camp, seg),
      eligible = [],
      excluded = {};
    for (const row of rows) {
      const reason = judge(row, camp, ctx);
      if (reason) excluded[reason] = (excluded[reason] || 0) + 1;
      else eligible.push(row);
    }
    return { total: rows.length, eligible, excluded, set };
  }
  function preview(camp) {
    const a = audience(camp),
      first = a.eligible[0];
    let message = null;
    if (first) {
      try {
        const p = catalogue.prepare(first, { templateId: camp.template_id }, first.contact_name);
        message = { text: p.text, hasFlyer: Boolean(p.flyerSnapshot), category: 'marketing' };
      } catch {
        message = null;
      }
    }
    const sample = a.eligible.slice(0, 5).map(r => ({
      contactId: r.contact_id,
      name: r.contact_name,
      channel: r.channel,
      course: db.prepare('SELECT title FROM courses WHERE id=?').get(r.course_id)?.title || '',
    }));
    const over = a.eligible.length > a.set.max_audience,
      send = Math.min(a.eligible.length, a.set.max_audience);
    return {
      total: a.total,
      eligible: a.eligible.length,
      willSend: send,
      overLimit: over,
      maxAudience: a.set.max_audience,
      excluded: Object.entries(a.excluded)
        .map(([reason, count]) => ({ reason, label: REASONS[reason] || reason, count }))
        .sort((x, y) => y.count - x.count),
      sample,
      message,
      cost: { rate: rate(), estimate: Math.round(send * rate() * 100) / 100, label: money(send * rate()) },
      enabled: Boolean(a.set.enabled) && automation.enabledFor(camp.brand_id),
      paceSeconds: a.set.pace_seconds,
      estimatedMinutes: Math.ceil((send * a.set.pace_seconds) / 60),
    };
  }

  // ---- resultados (calculados)
  function stats(id, brandId) {
    const rows = db
      .prepare(
        `SELECT s.state,s.cancel_reason,m.id message_id,m.delivery_state,
      EXISTS(SELECT 1 FROM messages x WHERE x.conversation_id=r.conversation_id AND x.sender_kind='customer' AND x.created_at>m.created_at AND x.created_at<=m.created_at+?) replied,
      EXISTS(SELECT 1 FROM contact_consent k WHERE k.contact_id=r.contact_id AND k.status='opted_out' AND k.updated_at>=m.created_at) opted_out
      FROM campaign_recipients r JOIN automation_steps s ON s.id=r.step_id LEFT JOIN messages m ON m.client_ref='campaign:'||s.id WHERE r.campaign_id=?`,
      )
      .all(REPLY_WINDOW, id);
    const out = {
      recipients: rows.length,
      queued: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      deliveryFailed: 0,
      stepFailed: 0,
      skipped: 0,
      skippedByReason: {},
      replied: 0,
      optedOut: 0,
    };
    for (const r of rows) {
      if (r.message_id) {
        out.sent++;
        if (['delivered', 'read'].includes(r.delivery_state)) out.delivered++;
        if (r.delivery_state === 'read') out.read++;
        if (r.delivery_state === 'failed') out.deliveryFailed++;
        if (r.replied) out.replied++;
        if (r.opted_out) out.optedOut++;
      } else if (r.state === 'cancelled') {
        out.skipped++;
        const k = r.cancel_reason || 'unknown';
        out.skippedByReason[k] = (out.skippedByReason[k] || 0) + 1;
      } else if (r.state === 'failed') out.stepFailed++;
      else out.queued++;
    }
    out.skippedReasons = Object.entries(out.skippedByReason).map(([reason, count]) => ({
      reason,
      label: REASONS[reason] || reason,
      count,
    }));
    delete out.skippedByReason;
    out.cost = { estimate: Math.round(out.sent * rate() * 100) / 100, label: money(out.sent * rate()) };
    return out;
  }
  const view = c =>
    c && {
      id: c.id,
      brandId: c.brand_id,
      brandName: db.prepare('SELECT name FROM brands WHERE id=?').get(c.brand_id)?.name || '',
      title: c.title,
      templateId: c.template_id,
      templateTitle: db.prepare('SELECT title FROM content_templates WHERE id=?').get(c.template_id)?.title || '',
      segment: JSON.parse(c.segment),
      requireConsent: Boolean(c.require_consent),
      status: c.status,
      scheduledAt: c.scheduled_at,
      audienceConfirmed: c.audience_confirmed,
      audienceSize: c.audience_size,
      revision: c.revision,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      startedAt: c.started_at,
      launchedAt: c.launched_at,
      finishedAt: c.finished_at,
      stats: stats(c.id, c.brand_id),
    };

  // ---- ciclo de vida
  function create(input, user) {
    const brandId = input.brandId;
    if (typeof brandId !== 'string' || !db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))
      throw fail(404, 'Marca no encontrada.');
    crm.requireBrand(user, brandId);
    const title = text(input.title, 120);
    if (!title) throw fail(400, 'La campaña necesita nombre.');
    const tpl = templateOf(input.templateId, brandId),
      segment = normalizeSegment(input.segment, brandId);
    if (input.requireConsent !== undefined && typeof input.requireConsent !== 'boolean')
      throw fail(400, 'Consentimiento requerido no válido.');
    const ref = input.clientRef === undefined ? null : text(input.clientRef, 80);
    if (input.clientRef !== undefined && ref.length < 8) throw fail(400, 'Referencia de idempotencia no válida.');
    return transaction(db, () => {
      if (ref) {
        const same = db.prepare('SELECT * FROM campaigns WHERE client_ref=?').get(ref);
        if (same) {
          if (same.brand_id !== brandId) throw fail(409, 'La referencia ya pertenece a otra campaña.');
          return view(same);
        }
      }
      const id = randomUUID(),
        t = now();
      db.prepare(
        'INSERT INTO campaigns(id,brand_id,title,template_id,segment,require_consent,client_ref,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        brandId,
        title,
        tpl.id,
        JSON.stringify(segment),
        input.requireConsent === false ? 0 : 1,
        ref,
        user.id,
        t,
        t,
      );
      event(id, 'created', { title, templateId: tpl.id, segment }, user.id);
      return view(get(id));
    });
  }
  function update(id, input, user) {
    return transaction(db, () => {
      const c = get(id);
      guard(c, input);
      crm.requireBrand(user, c.brand_id);
      if (c.status !== 'draft') throw fail(409, 'Sólo se edita una campaña en borrador. Cancela y crea otra.');
      const title = input.title === undefined ? c.title : text(input.title, 120);
      if (!title) throw fail(400, 'La campaña necesita nombre.');
      const tpl =
        input.templateId === undefined
          ? templateOf(c.template_id, c.brand_id)
          : templateOf(input.templateId, c.brand_id);
      const segment = input.segment === undefined ? JSON.parse(c.segment) : normalizeSegment(input.segment, c.brand_id);
      if (input.requireConsent !== undefined && typeof input.requireConsent !== 'boolean')
        throw fail(400, 'Consentimiento requerido no válido.');
      const req = input.requireConsent === undefined ? c.require_consent : input.requireConsent ? 1 : 0;
      db.prepare(
        'UPDATE campaigns SET title=?,template_id=?,segment=?,require_consent=?,revision=revision+1,updated_at=? WHERE id=?',
      ).run(title, tpl.id, JSON.stringify(segment), req, now(), id);
      event(id, 'updated', { title, templateId: tpl.id, segment }, user.id);
      return view(get(id));
    });
  }
  function schedule(id, input, user) {
    return transaction(db, () => {
      const c = get(id);
      guard(c, input);
      crm.requireBrand(user, c.brand_id);
      if (c.status !== 'draft') throw fail(409, 'La campaña ya está programada o terminó.');
      const set = settings(c.brand_id);
      if (!set.enabled) throw fail(409, 'Activa las campañas de esta marca antes de programar.');
      if (!automation.enabledFor(c.brand_id))
        throw fail(409, 'La automatización de la marca está apagada o en pausa global. Actívala en Seguimientos.');
      templateOf(c.template_id, c.brand_id, { forSend: true });
      const t = now(),
        at = input.scheduledAt === undefined || input.scheduledAt === null ? t : input.scheduledAt;
      if (!Number.isFinite(at) || at < t - 60000 || at > t + 90 * DAY)
        throw fail(400, 'La fecha de envío debe estar entre ahora y 90 días.');
      const p = preview(c);
      if (p.eligible < 1) throw fail(409, 'Ningún contacto cumple las reglas de envío. Revisa el segmento.');
      if (p.overLimit)
        throw fail(
          409,
          'El público (' +
            p.eligible +
            ') supera el máximo por campaña de la marca (' +
            p.maxAudience +
            '). Acota el segmento.',
        );
      if (!Number.isInteger(input.confirmAudience))
        throw fail(400, 'Confirma el número de destinatarios de la vista previa.');
      if (input.confirmAudience !== p.eligible)
        throw fail(
          409,
          'El público cambió: ahora son ' + p.eligible + ' destinatarios. Revisa la vista previa de nuevo.',
        );
      db.prepare(
        "UPDATE campaigns SET status='scheduled',scheduled_at=?,audience_confirmed=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(Math.max(at, t), p.eligible, t, id);
      event(id, 'scheduled', { scheduledAt: Math.max(at, t), audience: p.eligible }, user.id);
      changed(c.brand_id);
      return view(get(id));
    });
  }
  function cancel(id, input, user) {
    return transaction(db, () => {
      const c = get(id);
      if (!c) throw fail(404, 'Campaña no encontrada.');
      crm.requireBrand(user, c.brand_id);
      if (c.status === 'cancelled') return view(c);
      guard(c, input);
      if (c.status === 'completed') throw fail(409, 'La campaña ya terminó.');
      const steps = db
        .prepare(
          "SELECT s.id,s.brand_id FROM campaign_recipients r JOIN automation_steps s ON s.id=r.step_id WHERE r.campaign_id=? AND s.state IN ('pending','reserved')",
        )
        .all(id);
      const stopped = cancelSteps(db, steps, 'campaign_cancelled', user.id, now());
      db.prepare(
        "UPDATE campaigns SET status='cancelled',finished_at=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(now(), now(), id);
      event(id, 'cancelled', { stopped }, user.id);
      changed(c.brand_id);
      return view(get(id));
    });
  }

  // Lanza una campaña vencida: registra el inicio una sola vez y encola un paso por destinatario, espaciados. La clave de
  // idempotencia hace que un lanzamiento interrumpido pueda repetirse sin duplicar envíos. No es una transacción única
  // porque cada `enqueue` abre la suya; `launched_at` marca que ya se encolaron todos.
  function launch(c) {
    const set = settings(c.brand_id);
    if (!set.enabled || !automation.enabledFor(c.brand_id)) return false; // se reintenta cuando se active
    const t = now();
    if (c.status === 'scheduled')
      transaction(db, () => {
        if (
          db
            .prepare(
              "UPDATE campaigns SET status='sending',started_at=?,updated_at=? WHERE id=? AND status='scheduled'",
            )
            .run(t, t, c.id).changes
        )
          event(c.id, 'launched', {});
      });
    const fresh = get(c.id);
    if (fresh.status !== 'sending') return false;
    const rows = audience(fresh).eligible.slice(0, set.max_audience);
    let i = 0;
    for (const row of rows) {
      const out = automation.enqueue({
        brandId: c.brand_id,
        conversationId: row.id,
        kind: KIND,
        payload: { campaignId: c.id, contactId: row.contact_id },
        dedupeKey: 'campaign:' + c.id + ':' + row.contact_id,
        scheduledAt: t + i * set.pace_seconds * 1000,
        maxAttempts: 3,
        onCreate: step =>
          db
            .prepare(
              'INSERT OR IGNORE INTO campaign_recipients(campaign_id,contact_id,conversation_id,step_id,created_at) VALUES(?,?,?,?,?)',
            )
            .run(c.id, row.contact_id, row.id, step.id, t),
      });
      if (out.skipped) return false;
      if (!out.duplicate) i++;
    }
    transaction(db, () => {
      const n = db.prepare('SELECT count(*) n FROM campaign_recipients WHERE campaign_id=?').get(c.id).n;
      if (
        db
          .prepare("UPDATE campaigns SET launched_at=?,audience_size=?,updated_at=? WHERE id=? AND status='sending'")
          .run(t, n, t, c.id).changes
      )
        event(c.id, 'queued', { recipients: n });
    });
    changed(c.brand_id);
    return true;
  }
  let lastScan = 0;
  function scan() {
    const t = now();
    if (t - lastScan < 1000) return 0;
    lastScan = t;
    let launched = 0;
    for (const c of db
      .prepare(
        "SELECT * FROM campaigns WHERE kind='catalogue' AND ((status='scheduled' AND scheduled_at<=?) OR (status='sending' AND launched_at IS NULL)) ORDER BY scheduled_at LIMIT 5",
      )
      .all(t)) {
      try {
        if (launch(c)) launched++;
      } catch (e) {
        console.error('Campaign launch failed:', e.name, e.message);
      }
    }
    for (const c of db
      .prepare("SELECT * FROM campaigns WHERE kind='catalogue' AND status='sending' AND launched_at IS NOT NULL")
      .all()) {
      const open = db
        .prepare(
          "SELECT count(*) n FROM campaign_recipients r JOIN automation_steps s ON s.id=r.step_id WHERE r.campaign_id=? AND s.state IN ('pending','reserved')",
        )
        .get(c.id).n;
      if (open === 0)
        transaction(db, () => {
          if (
            db
              .prepare(
                "UPDATE campaigns SET status='completed',finished_at=?,updated_at=? WHERE id=? AND status='sending'",
              )
              .run(t, t, c.id).changes
          ) {
            event(c.id, 'completed', stats(c.id, c.brand_id));
            changed(c.brand_id);
          }
        });
    }
    return launched;
  }

  // ---- paso durable
  automation.register(KIND, {
    check(step) {
      const { campaignId, contactId } = step.payload,
        camp = get(campaignId),
        c = conv(step.conversation_id);
      if (!camp || camp.status === 'cancelled') return { cancel: 'campaign_cancelled' };
      if (!c || c.brand_id !== step.brand_id) return { cancel: 'conversation_missing' };
      const set = settings(c.brand_id);
      if (!set.enabled) return { cancel: 'campaigns_disabled' };
      const reason = judge(
        {
          ...c,
          contact_id: contactId,
          contact_name: db.prepare('SELECT name FROM contacts WHERE id=?').get(contactId)?.name || '',
        },
        camp,
        { set, templates: new Map() },
      );
      return reason ? { cancel: reason } : null;
    },
    commit(step) {
      const { campaignId, contactId } = step.payload,
        camp = get(campaignId),
        c = conv(step.conversation_id),
        name = db.prepare('SELECT name FROM contacts WHERE id=?').get(contactId)?.name || null;
      const prepared = catalogue.prepare(c, { templateId: camp.template_id }, name);
      const messageId = insertMessage(
        c,
        null,
        prepared.text,
        'automation',
        'campaign:' + step.id,
        null,
        prepared.flyerSnapshot ? c.course_id : null,
        prepared,
        { category: 'marketing' },
      );
      return { messageId };
    },
  });

  // ---- configuración por marca
  function setSettings(brandId, input, user) {
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId)) throw fail(404, 'Marca no encontrada.');
    crm.requireBrand(user, brandId);
    const cur = settings(brandId);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== cur.revision)
      throw fail(409, 'La configuración de campañas cambió. Recárgala.');
    const enabled = input.enabled === undefined ? cur.enabled : input.enabled ? 1 : 0,
      gap =
        input.minGapHours === undefined ? cur.min_gap_hours : integer(input.minGapHours, 0, 720, 'Separación mínima'),
      pace = input.paceSeconds === undefined ? cur.pace_seconds : integer(input.paceSeconds, 1, 60, 'Ritmo de envío'),
      max = input.maxAudience === undefined ? cur.max_audience : integer(input.maxAudience, 1, 20000, 'Público máximo');
    db.prepare(
      'INSERT INTO campaign_settings(brand_id,enabled,min_gap_hours,pace_seconds,max_audience,revision,updated_by,updated_at) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(brand_id) DO UPDATE SET enabled=excluded.enabled,min_gap_hours=excluded.min_gap_hours,pace_seconds=excluded.pace_seconds,max_audience=excluded.max_audience,revision=campaign_settings.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    ).run(brandId, enabled, gap, pace, max, user.id, now());
    audit(user, 'campaign.settings', brandId);
    changed(brandId);
    return settings(brandId);
  }
  function recipients(id, params) {
    const state = params.get('state'),
      limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 100)),
      offset = Math.max(0, Number(params.get('offset')) || 0);
    const rows = db
      .prepare(
        `SELECT r.contact_id,r.conversation_id,ct.name contact_name,v.channel,s.state,s.cancel_reason,s.error,s.scheduled_at,m.id message_id,m.created_at sent_at,m.delivery_state,
      EXISTS(SELECT 1 FROM messages x WHERE x.conversation_id=r.conversation_id AND x.sender_kind='customer' AND x.created_at>m.created_at AND x.created_at<=m.created_at+?) replied
      FROM campaign_recipients r JOIN contacts ct ON ct.id=r.contact_id JOIN conversations v ON v.id=r.conversation_id JOIN automation_steps s ON s.id=r.step_id LEFT JOIN messages m ON m.client_ref='campaign:'||s.id WHERE r.campaign_id=? ORDER BY ct.name,r.contact_id`,
      )
      .all(REPLY_WINDOW, id)
      .map(r => ({
        contactId: r.contact_id,
        conversationId: r.conversation_id,
        name: r.contact_name,
        channel: r.channel,
        state: r.message_id ? 'sent' : r.state === 'cancelled' ? 'skipped' : r.state === 'failed' ? 'failed' : 'queued',
        reason: r.cancel_reason ? REASONS[r.cancel_reason] || r.cancel_reason : null,
        error: r.error,
        scheduledAt: r.scheduled_at,
        sentAt: r.sent_at,
        delivery: r.delivery_state,
        replied: Boolean(r.replied),
      }));
    const filtered = state ? rows.filter(r => r.state === state) : rows;
    return { total: filtered.length, recipients: filtered.slice(offset, offset + limit) };
  }

  async function handle(req, res, path, user) {
    if (!(path === '/api/campaigns' || path.startsWith('/api/campaigns/'))) return false;
    access.require(user, 'campaigns.view');
    const url = new URL(req.url, 'http://localhost');
    let x;
    if (path === '/api/campaigns/settings' && req.method === 'GET') {
      json(res, 200, {
        settings: crm
          .brandsFor(user)
          .map(b => ({ ...settings(b.id), brand_name: b.name, automationEnabled: automation.enabledFor(b.id) })),
        reasons: REASONS,
      });
      return true;
    }
    if ((x = path.match(/^\/api\/campaigns\/settings\/([\w-]{1,64})$/)) && req.method === 'PATCH') {
      access.require(user, 'campaigns.send', x[1]);
      json(res, 200, { settings: setSettings(x[1], await body(req), user) });
      return true;
    }
    if (path === '/api/campaigns') {
      if (req.method === 'GET') {
        const brand = url.searchParams.get('brand'),
          ids = crm
            .brandsFor(user)
            .map(b => b.id)
            .filter(id => !brand || id === brand);
        if (brand && !ids.length) throw fail(404, 'Marca o registro no disponible.');
        const rows = ids.length
          ? db
              .prepare(
                `SELECT * FROM campaigns WHERE kind='catalogue' AND brand_id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 100`,
              )
              .all(...ids)
          : [];
        json(res, 200, { campaigns: rows.map(view), segmentOptions: { stages: STAGES, channels: CHANNELS } });
        return true;
      }
      if (req.method === 'POST') {
        access.require(user, 'campaigns.edit');
        const c = create(await body(req), user);
        audit(user, 'campaign.create', c.id);
        changed(c.brandId);
        json(res, 201, { campaign: c });
        return true;
      }
      throw fail(405, 'Método no permitido.');
    }
    if (!(x = path.match(/^\/api\/campaigns\/([a-f0-9-]{36})(?:\/(preview|schedule|cancel|recipients|events))?$/)))
      throw fail(404, 'Ruta de campañas no encontrada.');
    const c = get(x[1]);
    if (!c) throw fail(404, 'Campaña no encontrada.');
    crm.requireBrand(user, c.brand_id);
    access.require(user, 'campaigns.view', c.brand_id);
    if (req.method !== 'GET')
      access.require(user, x[2] === 'schedule' || x[2] === 'cancel' ? 'campaigns.send' : 'campaigns.edit', c.brand_id);
    if (!x[2] && req.method === 'GET') {
      json(res, 200, { campaign: view(c) });
      return true;
    }
    if (!x[2] && req.method === 'PATCH') {
      const out = update(c.id, await body(req), user);
      audit(user, 'campaign.update', c.id);
      changed(c.brand_id);
      json(res, 200, { campaign: out });
      return true;
    }
    if (x[2] === 'preview' && req.method === 'POST') {
      await body(req);
      json(res, 200, { preview: preview(c) });
      return true;
    }
    if (x[2] === 'schedule' && req.method === 'POST') {
      const out = schedule(c.id, await body(req), user);
      audit(user, 'campaign.schedule', c.id);
      json(res, 200, { campaign: out });
      return true;
    }
    if (x[2] === 'cancel' && req.method === 'POST') {
      const out = cancel(c.id, await body(req), user);
      audit(user, 'campaign.cancel', c.id);
      json(res, 200, { campaign: out });
      return true;
    }
    if (x[2] === 'recipients' && req.method === 'GET') {
      json(res, 200, recipients(c.id, url.searchParams));
      return true;
    }
    if (x[2] === 'events' && req.method === 'GET') {
      json(res, 200, {
        events: db
          .prepare(
            'SELECT e.kind,e.details,e.created_at,u.name actor_name FROM campaign_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.campaign_id=? ORDER BY e.seq',
          )
          .all(c.id)
          .map(e => ({ ...e, details: JSON.parse(e.details) })),
      });
      return true;
    }
    throw fail(405, 'Método no permitido.');
  }

  return {
    create,
    update,
    schedule,
    cancel,
    preview,
    scan,
    launch,
    stats,
    handle,
    settings,
    normalizeSegment,
    useAudiences,
    get: id => view(get(id)),
  };
}
