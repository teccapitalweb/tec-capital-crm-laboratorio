// Motor de difusiones con plantilla (docs/PLAN_MOTOR_DIFUSIONES.md; diseño de difusiones §5 adaptado a la
// conciliación técnica: filas 13, 15, 16, 25, 28, 37, 39, 40 y 41; hallazgos F-4 y F-19).
//
// Una difusión manda una plantilla aprobada por Meta a cada persona de una audiencia, por tandas y a un ritmo, y sigue
// cada envío por los avisos de Meta. Une lo que ya existía: plantillas (wa-templates: `resolve`, `forSend`), audiencias
// (audiences: `members`, `summary`, `suppressed`), costos (wa-costs: `estimate`, `monthSpend`) y la cola por
// destinatario de campaign_recipients. Las campañas de catálogo siguen en server/campaigns.mjs y no pasan por aquí.
//
// Seguridad del envío (lo más importante):
//   - Todo nace apagado: la marca necesita sus campañas (campaign_settings.enabled) y su automatización encendidas.
//     Sin WhatsApp real sólo se puede programar un ENSAYO (options.mode='rehearsal'), que recorre todo sin enviar.
//   - Nada sale sin plantilla aprobada, sin consentimiento cuando la campaña lo exige, a quien pidió la baja, está en
//     una lista de exclusión o no tiene WhatsApp: se juzga al previsualizar, al lanzar y otra vez justo antes de enviar.
//   - Un destinatario recibe COMO MUCHO un mensaje por campaña: una fila por (campaña, contacto) y por (campaña,
//     número); antes de llamar a Meta la fila queda «sending» con su intento (intención escrita en una transacción) y
//     el envío lleva `tc:<destinatario>:<intento>` como dato de vuelta. Si el proceso muere o Meta no contesta, la fila
//     se queda «sending» (en duda) y NUNCA se reenvía sola: la resuelve un aviso de Meta con ese dato o, pasado el
//     plazo, queda fallida «sin confirmar» para que una persona decida (hallazgo F-19).
//   - Ninguna llamada de red dentro de una transacción. El tope de gasto y el límite diario se miran antes de cada tanda.
//
// Rutas (con sesión; ver = campaigns.view, editar = campaigns.edit, enviar = campaigns.send en la marca):
//   GET    /api/broadcasts?brand&status&limit&offset          lista con contadores
//   GET    /api/broadcasts/options?brand                      datos del asistente
//   GET    /api/broadcasts/settings?brand · PATCH /api/broadcasts/settings/:brandId   (ajustes: administración)
//   POST   /api/broadcasts                                    {brandId,title?,waTemplateId,waNumber?,content?,segment,
//                                                              requireConsent?,options?,clientRef} → 201 {campaign}
//   GET    /api/broadcasts/:id · PATCH /api/broadcasts/:id    {…, expectedRevision} (sólo borradores)
//   POST   /api/broadcasts/:id/preview                        {preview}
//   POST   /api/broadcasts/:id/schedule                       {expectedRevision, confirmAudience, acceptCost?, scheduledAt?}
//   POST   /api/broadcasts/:id/unschedule|pause|resume|cancel {expectedRevision}
//   GET    /api/broadcasts/:id/recipients?state&limit&offset · GET /api/broadcasts/:id/events
//
// Para otros módulos (host.module('broadcasts')): attribute, adopt, courseOf y onReply (el entrante de WhatsApp, fila
// 25), sendOne y sendStatus (la futura API de envío, fila 37), applyStatus (oyente del estado de Meta, order 200, fila
// 40) y tick (el emisor).
import { randomUUID } from 'node:crypto';
import * as copy from '../../reply-copy.mjs';
import { transaction } from '../../database.mjs';
import { safeError, withTimeout } from '../../app/leases.mjs';
import { canonicalPhone } from '../../lib/identity-keys.mjs';
import { hasWrittenAmount } from '../../lib/variables.mjs';
import { marketOf } from '../wa-costs/model.mjs';
import { definitionOf } from '../wa-templates/definition.mjs';
import { createSendGate } from './gate.mjs';
import { createRepo } from './repo.mjs';
import {
  AUDIENCE_REASON,
  BACKOFF_MS,
  CAMPAIGN_STATUS,
  DAY,
  FAIL_KINDS,
  RECIPIENT_STATES,
  SKIP_REASONS,
  STOP_REASONS,
  WAIT_REASONS,
  buttonPayload,
  callbackOf,
  classifyMetaError,
  createBucket,
  inQuietHours,
  isClock,
  maskDigits,
  normalizeOptions,
  parseCallback,
  parsePayload,
  tooManyFailures,
} from './model.mjs';

const PREFIX = '/api/broadcasts';
const REF = /^[a-zA-Z0-9-]{16,100}$/;
const ID = /^[a-zA-Z0-9-]{8,64}$/;
const USABLE = ['approved', 'flagged'];
const BODY_MAX = 1024;
const SCHEDULE_MAX_MS = 90 * DAY;
const WAIT_TEMPLATE_MS = 3 * DAY;
const EVENT_TYPES = {
  'difusion.iniciada': { title: 'Empezó una difusión', entity: 'campaign', payload: 'title, recipients, rehearsal' },
  'difusion.detenida': { title: 'Una difusión se detuvo sola', entity: 'campaign', payload: 'title, reason' },
  'difusion.respondida': {
    title: 'Alguien respondió a una difusión',
    entity: 'campaign',
    payload: 'campaignId, recipientId, contactId, conversationId, kind, buttonIndex, buttonLabel',
  },
};
const json = value => {
  try {
    return JSON.parse(value || '{}') ?? {};
  } catch {
    return {};
  }
};
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const newId = () => randomUUID().replaceAll('-', '');
const atomic = (db, fn) => (db.isTransaction ? fn() : transaction(db, fn));

export default {
  name: 'broadcasts',
  create(host) {
    const { db, fail, access } = host;
    const env = process.env;
    const now = () => Date.now();
    const repo = createRepo(db);
    const services = host.services;
    const test = env.NODE_ENV === 'test';
    const LEASE_MS = Math.max(1000, Number(env.WA_BROADCAST_LEASE_MS) || 120_000);
    const RECONCILE_MS = Math.max(LEASE_MS, Number(env.WA_BROADCAST_RECONCILE_MS) || 600_000);
    const SEND_TIMEOUT_MS = Math.min(30_000, Math.floor(LEASE_MS / 2));
    const PER_SECOND = Math.max(1, Number(env.WA_BROADCAST_MAX_PER_SECOND) || 10);
    const RATE_SCALE = test ? Math.max(1, Number(env.WA_BROADCAST_RATE_SCALE) || 1) : 1;
    const RETRY_AFTER_MS = Math.max(60_000, Number(env.WA_RETRY_AFTER_MS) || DAY);
    const PARALLEL = 10; // llamadas a Meta a la vez dentro de una pasada
    const worker = randomUUID();
    const optional = name => {
      try {
        return host.module(name);
      } catch {
        return null;
      }
    };
    const templates = () => optional('wa-templates');
    // Destinatario por identificador de usuario (identidad I-2; conciliación, fila 37): a quien no tiene teléfono pero
    // escribió por WhatsApp se le escribe por su identificador en el ámbito del número de la campaña.
    const recipientOf = (contactId, numberId) =>
      services.whatsapp?.identity?.recipientForContact(contactId, numberId) ?? null;
    const audiences = () => optional('audiences');
    const costs = () => optional('wa-costs');
    const meta = () => services.connectors.adapters.channel.meta;
    services.events.registerTypes(EVENT_TYPES, { entities: { campaign: 'Difusión' } });

    // ---- ajustes, interruptores y la puerta de envío (unión con channel-health)
    const settings = brandId => {
      const row = repo.settings(brandId);
      return {
        enabled: Boolean(row?.enabled),
        minGapHours: row?.min_gap_hours ?? 72,
        maxAudience: row?.max_audience ?? 5000,
        ratePerMinute: row?.rate_per_minute ?? 60,
        dailyCap: row?.daily_cap ?? 250,
        quietStart: row?.quiet_start ?? '21:00',
        quietEnd: row?.quiet_end ?? '08:00',
        monthlyBudgetCents: row?.monthly_budget_cents ?? 0,
        failStopPct: row?.fail_stop_pct ?? 50,
        revision: row?.revision ?? 0,
      };
    };
    const switchesOn = brandId => settings(brandId).enabled && services.automation.enabledFor(brandId);
    const gate = createSendGate({
      health: () => optional('channel-health'),
      fallbackLimit: (numberId, brandId) => repo.accountLimit()?.limit_value ?? settings(brandId).dailyCap,
      usedToday: numberId => repo.usedToday(numberId, now() - DAY).n,
    });
    const timezoneOf = brandId => repo.timezone(brandId) || 'America/Mexico_City';

    // ---- vista
    const parse = c => ({
      content: json(c.content),
      options: json(c.options),
      segment: json(c.segment),
    });
    const rehearsal = c => json(c.options).mode === 'rehearsal';
    function statsOf(ids) {
      const out = new Map(ids.map(id => [id, blankStats()]));
      for (const row of repo.stats(ids)) {
        const s = out.get(row.campaign_id);
        s[row.state] = row.n;
        s.replied += row.replied;
        s.clicked += row.clicked;
      }
      for (const s of out.values()) {
        s.recipients = s.queued + s.sending + s.sent + s.delivered + s.read + s.failed + s.deferred;
        s.sentTotal = s.sent + s.delivered + s.read;
        s.deliveredTotal = s.delivered + s.read;
      }
      return out;
    }
    function blankStats() {
      const s = { replied: 0, clicked: 0 };
      for (const k of Object.keys(RECIPIENT_STATES)) s[k] = 0;
      return s;
    }
    function view(c, stats = null) {
      const p = parse(c);
      const tpl = c.wa_template_id ? repo.template(c.wa_template_id) : null;
      const reason = c.status_reason;
      return {
        id: c.id,
        brandId: c.brand_id,
        title: c.title,
        status: c.status,
        statusLabel: CAMPAIGN_STATUS[c.status] ?? c.status,
        statusReason: reason,
        reasonLabel: reason ? (STOP_REASONS[reason] ?? WAIT_REASONS[reason] ?? reason) : null,
        waTemplateId: c.wa_template_id,
        template: tpl
          ? { id: tpl.id, name: tpl.name, language: tpl.language, category: tpl.category, status: tpl.status }
          : null,
        waNumber: c.wa_number,
        content: p.content,
        segment: p.segment,
        requireConsent: Boolean(c.require_consent),
        options: p.options,
        rehearsal: p.options.mode === 'rehearsal',
        origin: p.options.origin === 'api' ? 'api' : 'manual',
        scheduledAt: c.scheduled_at,
        startedAt: c.started_at,
        finishedAt: c.finished_at,
        audienceSize: c.audience_size,
        audienceConfirmed: c.audience_confirmed,
        costEstimate: c.cost_estimate ? json(c.cost_estimate) : null,
        batchNo: c.batch_no,
        batchReleaseAt: c.batch_release_at,
        revision: c.revision,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        stats: stats ?? statsOf([c.id]).get(c.id),
      };
    }
    const emits = new Set();
    const touched = c => emits.add(c.brand_id + '|' + c.id);
    function flush() {
      for (const key of emits) {
        const [brandId, id] = key.split('|');
        try {
          host.realtime.emit('broadcasts.changed', { brandId, data: { id } });
        } catch {}
      }
      emits.clear();
    }
    const event = (c, kind, details = {}, actor = null) =>
      repo.event(c.id, kind, JSON.stringify(details), actor, now());

    // ---- validación del borrador
    function getCampaign(user, id, perm = 'campaigns.view') {
      const c = ID.test(id) ? repo.campaignAny(id) : null;
      if (!c || !access.can(user, 'campaigns.view', c.brand_id)) throw fail(404, 'Difusión no encontrada.');
      access.require(user, perm, c.brand_id);
      return c;
    }
    function templateFor(brandId, id) {
      const t = typeof id === 'string' && id ? repo.template(id) : null;
      if (!t || t.brand_id !== brandId || t.archived_at)
        throw fail(400, 'Elige una plantilla de WhatsApp de la marca.', { field: 'waTemplateId' });
      if (![...USABLE, 'pending'].includes(t.status))
        throw fail(409, 'Esa plantilla no está aprobada ni en revisión.', { code: 'template_not_usable' });
      return t;
    }
    function normalize(brandId, input, current, user) {
      const admin = user.role === 'admin';
      const tpl = templateFor(brandId, input.waTemplateId ?? current?.wa_template_id);
      let number = input.waNumber === undefined ? (current?.wa_number ?? null) : input.waNumber || null;
      if (number !== null && !repo.number(brandId, String(number)))
        throw fail(400, 'Ese número de WhatsApp no es de la marca.', { field: 'waNumber' });
      if (number === null && input.waNumber === undefined && !current) {
        const list = repo.numbers(brandId).filter(n => n.enabled);
        if (list.length === 1) number = list[0].phone_number_id; // la marca tiene uno solo: se elige solo
      }
      const prev = current ? json(current.content) : {};
      const src = input.content && typeof input.content === 'object' ? input.content : prev;
      const context = {};
      if (src.context?.courseId) {
        const course = repo.course(brandId, String(src.context.courseId));
        if (!course || !course.active) throw fail(400, 'El curso no está activo en la marca.', { field: 'content' });
        context.courseId = course.id;
        if (src.context.editionId) {
          const ed = repo.edition(brandId, String(src.context.editionId));
          if (!ed || ed.course_id !== course.id || ed.status !== 'published')
            throw fail(400, 'La edición no está publicada en ese curso.', { field: 'content' });
          context.editionId = ed.id;
        }
      }
      const fixed = {};
      for (const [key, value] of Object.entries(src.fixed && typeof src.fixed === 'object' ? src.fixed : {}).slice(
        0,
        10,
      )) {
        const v = text(String(value ?? ''), 60).replace(/\s+/g, ' ');
        if (!/^[a-z0-9_]{1,30}$/.test(key)) throw fail(400, 'Nombre de texto fijo no válido.', { field: 'content' });
        if (hasWrittenAmount(v))
          throw fail(400, 'Los importes salen del catálogo: usa un cupón o el precio de la edición.', {
            field: 'content',
          });
        fixed[key] = v;
      }
      let couponId = null;
      if (src.couponId) {
        if (!repo.coupon(brandId, String(src.couponId)))
          throw fail(400, 'Ese cupón no está activo.', { field: 'content' });
        couponId = String(src.couponId);
      }
      const segment = input.segment === undefined ? (current ? json(current.segment) : null) : input.segment || null;
      if (!segment || typeof segment !== 'object' || Array.isArray(segment))
        throw fail(400, 'Elige a quién se le envía (una audiencia).', { field: 'segment' });
      const requireConsent =
        input.requireConsent === undefined
          ? current
            ? Boolean(current.require_consent)
            : true
          : Boolean(input.requireConsent);
      if (!requireConsent && !admin && (!current || current.require_consent))
        throw fail(403, 'Sólo administración puede enviar sin consentimiento registrado.', {
          code: 'permission_denied',
        });
      const opts = normalizeOptions(input.options, current ? json(current.options) : {}, { admin });
      if (opts.problems.length)
        throw fail(400, opts.problems[0][1], { field: opts.problems[0][0], code: 'invalid_input' });
      const stamp = new Intl.DateTimeFormat('es-MX', {
        timeZone: timezoneOf(brandId),
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .format(new Date(now()))
        .replace(/\D/g, '');
      const title = text(input.title ?? current?.title ?? '', 120) || `${tpl.name}_${stamp}`;
      return {
        title,
        tpl,
        number,
        content: JSON.stringify({ context, fixed, couponId }),
        segment: JSON.stringify(segment),
        requireConsent: requireConsent ? 1 : 0,
        options: JSON.stringify(opts.options),
      };
    }

    function create(input, user) {
      const brandId = String(input.brandId || '');
      if (!repo.brand(brandId)) throw fail(400, 'Elige la marca.', { field: 'brandId' });
      if (!access.can(user, 'campaigns.view', brandId)) throw fail(404, 'Marca no encontrada.');
      access.require(user, 'campaigns.edit', brandId);
      const clientRef = String(input.clientRef || '');
      if (!REF.test(clientRef)) throw fail(400, 'Referencia no válida.', { field: 'clientRef' });
      const scoped = brandId + ':' + clientRef;
      const prev = repo.byClientRef(scoped);
      if (prev) return { campaign: view(prev), duplicate: true };
      const d = normalize(brandId, input, null, user);
      const id = randomUUID(),
        t = now();
      atomic(db, () => {
        repo.insertCampaign(
          id,
          brandId,
          d.title,
          d.tpl.id,
          d.number,
          d.content,
          d.segment,
          d.requireConsent,
          d.options,
          'draft',
          null,
          timezoneOf(brandId),
          scoped,
          user.id,
          t,
          t,
        );
        event({ id }, 'created', {}, user.id);
      });
      host.audit(user, 'broadcast.created', id);
      const c = repo.campaignAny(id);
      touched(c);
      flush();
      return { campaign: view(c), duplicate: false };
    }
    const guard = (c, input) => {
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== c.revision)
        throw fail(409, 'La difusión cambió. Recárgala.', { code: 'stale_record' });
    };
    function update(id, input, user) {
      const c = getCampaign(user, id, 'campaigns.edit');
      guard(c, input);
      if (c.status !== 'draft') throw fail(409, 'Sólo se edita un borrador.', { code: 'not_draft' });
      const d = normalize(c.brand_id, input, c, user);
      const r = repo.updateDraft(
        d.title,
        d.tpl.id,
        d.number,
        d.content,
        d.segment,
        d.requireConsent,
        d.options,
        now(),
        c.id,
        c.revision,
      );
      if (!r.changes) throw fail(409, 'La difusión cambió. Recárgala.', { code: 'stale_record' });
      host.audit(user, 'broadcast.updated', c.id);
      const fresh = repo.campaignAny(c.id);
      touched(fresh);
      flush();
      return { campaign: view(fresh) };
    }

    // ---- armar el mensaje de una persona (valores del contacto y del curso de la campaña)
    function contextOf(c) {
      const p = parse(c);
      const tpl = c.wa_template_id ? repo.template(c.wa_template_id) : null;
      const course = p.content.context?.courseId ? repo.course(c.brand_id, p.content.context.courseId) : null;
      const edition = p.content.context?.editionId ? repo.edition(c.brand_id, p.content.context.editionId) : null;
      return {
        tpl,
        category: tpl?.category === 'utility' ? 'utility' : 'marketing',
        brandName: repo.brand(c.brand_id)?.name ?? '',
        course: course?.active ? course : null,
        edition: edition?.status === 'published' ? edition : null,
        fixed: p.content.fixed ?? {},
        coupon: p.content.couponId ? (repo.coupon(c.brand_id, p.content.couponId)?.code ?? null) : null,
        options: p.options,
        hasFile: tpl ? ['image', 'document'].includes(definitionOf(tpl).header.type) : false,
      };
    }
    function render(ctx, contact, recipientId, overrides = {}) {
      const api = templates();
      if (!api || !ctx.tpl) return { reason: 'missing_variable', missing: [] };
      const values = {
        nombre: copy.firstName(contact.name || '') || '',
        marca: ctx.brandName,
        curso: ctx.course?.title ?? '',
        edicion: ctx.edition?.name || ctx.course?.title || '',
      };
      // El valor que manda quien llama (envío suelto por la API) tiene prioridad sobre la fuente declarada (§4.8).
      for (const key of Object.keys(values))
        if (typeof overrides?.[key] === 'string' && overrides[key].trim()) values[key] = overrides[key];
      const r = api.resolve(ctx.tpl, { values, fixed: ctx.fixed, overrides, coupon: ctx.coupon, strict: true });
      if (r.missing.length) return { reason: 'missing_variable', missing: r.missing };
      if (r.text.length > BODY_MAX) return { reason: 'too_long' };
      const buttons = r.buttons.map(b =>
        b.subType === 'quick_reply' ? { ...b, payload: buttonPayload(recipientId, b.index) } : b,
      );
      return {
        template: {
          name: ctx.tpl.name,
          language: ctx.tpl.language,
          params: r.params,
          ...(r.header ? { header: r.header } : {}),
          ...(buttons.length ? { buttons } : {}),
        },
        rendered: r.text,
        quickReplies: r.quickReplies,
      };
    }
    // Reglas que el motor añade a las de la audiencia, iguales en la vista previa y antes de cada envío.
    function judge(c, ctx, contact, set, t, overrides) {
      if (!contact.phone_key && !contact.wa_recipient) return { reason: 'no_address' };
      if (ctx.category === 'marketing' && set.minGapHours > 0)
        if (repo.recentCampaign(contact.id, c.brand_id, c.id, t - set.minGapHours * 3_600_000))
          return { reason: 'recent_campaign' };
      return render(ctx, contact, '0'.repeat(32), overrides);
    }

    // ---- vista previa (no escribe nada)
    function members(c, { status = 'all' } = {}) {
      const aud = audiences();
      if (!aud) throw fail(503, 'El módulo de audiencias no está disponible.');
      const spec = parse(c).segment;
      const rows = [];
      let after = null;
      const cap = settings(c.brand_id).maxAudience + 1000;
      do {
        const page = aud.members(c.brand_id, spec, {
          after,
          limit: 1000,
          status,
          requireConsent: Boolean(c.require_consent),
        });
        rows.push(...page.rows);
        after = page.next;
      } while (after && rows.length < cap);
      return rows;
    }
    function preview(c, user) {
      const t = now();
      const ctx = contextOf(c);
      const set = settings(c.brand_id);
      const excluded = new Map();
      const add = reason => excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
      const markets = {};
      const sample = [];
      let eligible = 0;
      const seen = new Set();
      for (const row of members(c)) {
        if (row.reason) {
          add(AUDIENCE_REASON[row.reason] ?? 'excluded');
          continue;
        }
        if (row.phoneKey && seen.has(row.phoneKey)) {
          add('duplicate');
          continue;
        }
        const recipient = row.phoneKey ? null : recipientOf(row.contactId, c.wa_number);
        const verdict = judge(
          c,
          ctx,
          { id: row.contactId, name: row.name, phone_key: row.phoneKey, wa_recipient: recipient },
          set,
          t,
        );
        if (verdict.reason) {
          add(verdict.reason);
          continue;
        }
        seen.add(row.phoneKey || 'u:' + recipient);
        eligible++;
        const market = marketOf(row.phoneKey);
        markets[market] = (markets[market] ?? 0) + 1;
        if (sample.length < 3)
          sample.push({
            contactId: row.contactId,
            name: row.name,
            phone: access.can(user, 'contacts.phone', c.brand_id) ? row.phone : maskDigits(row.phone),
            rendered: verdict.rendered,
          });
      }
      const willSend = Math.min(eligible, set.maxAudience);
      const live = !rehearsal(c);
      const engine = costs();
      let cost = null;
      if (engine && willSend) {
        const scaled = Object.fromEntries(
          Object.entries(markets).map(([m, n]) => [m, Math.round((n * willSend) / Math.max(1, eligible))]),
        );
        cost = engine.estimate({ category: ctx.category, markets: scaled });
      }
      const spent = live && engine ? engine.monthSpend(c.brand_id).micros : 0;
      const budgetMicros = set.monthlyBudgetCents * 10_000;
      const budget = {
        limitCents: set.monthlyBudgetCents,
        spentCents: Math.round(spent / 10_000),
        afterCents: Math.round((spent + (live ? (cost?.max.micros ?? 0) : 0)) / 10_000),
        exceeded: budgetMicros > 0 && spent + (live ? (cost?.max.micros ?? 0) : 0) > budgetMicros,
      };
      const limits = c.wa_number ? gate.check(c.wa_number, ctx.category, c.brand_id) : null;
      const blockers = blockersOf(c, ctx, { eligible, set, budget, live });
      const rate = (ctx.options.ratePerMinute ?? set.ratePerMinute) || 60;
      return {
        total: eligible + [...excluded.values()].reduce((a, b) => a + b, 0),
        eligible,
        willSend,
        overLimit: eligible > set.maxAudience,
        maxAudience: set.maxAudience,
        excluded: [...excluded].map(([reason, count]) => ({ reason, label: SKIP_REASONS[reason] ?? reason, count })),
        sample,
        message: ctx.tpl
          ? { category: ctx.category, text: sample[0]?.rendered ?? ctx.tpl.body, template: ctx.tpl.name }
          : null,
        cost,
        budget,
        limits: limits
          ? {
              limit: limits.limit,
              used: limits.used,
              remaining: limits.remaining === Infinity ? null : limits.remaining,
              source: limits.source,
              enough: limits.remaining >= willSend,
            }
          : null,
        schedule: {
          estimatedMinutes: Math.ceil(willSend / rate),
          quietHours: { from: set.quietStart, to: set.quietEnd, timezone: timezoneOf(c.brand_id) },
        },
        rehearsal: !live,
        blockers,
      };
    }
    function blockersOf(c, ctx, { eligible, set, budget, live }) {
      const out = [];
      const add = (code, label) => out.push({ code, label });
      if (!set.enabled) add('campaigns_off', 'Las difusiones de la marca están apagadas.');
      if (!services.automation.enabledFor(c.brand_id))
        add('automation_off', 'La automatización de la marca está apagada.');
      if (live && !services.connectors.metaLive())
        add('whatsapp_off', 'WhatsApp real está apagado: sólo se puede programar un ensayo.');
      if (live && !c.wa_number) add('no_number', 'Elige el número de WhatsApp que envía.');
      if (c.wa_number && !repo.number(c.brand_id, c.wa_number)?.enabled)
        add('number_paused', 'El número está en pausa en el CRM.');
      if (!ctx.tpl || ctx.tpl.archived_at || ![...USABLE, 'pending'].includes(ctx.tpl.status))
        add('template_not_usable', 'La plantilla ya no está aprobada.');
      if (!eligible) add('no_audience', 'Nadie del público puede recibir esta difusión.');
      if (eligible > set.maxAudience)
        add('over_limit', `El público supera el máximo de la marca (${set.maxAudience}).`);
      if (budget.exceeded) add('budget_exceeded', 'La difusión supera el presupuesto mensual de la marca.');
      return out;
    }

    // ---- programar, devolver a borrador, pausar, reanudar, cancelar
    function schedule(id, input, user) {
      const c = getCampaign(user, id, 'campaigns.send');
      guard(c, input);
      if (c.status !== 'draft') throw fail(409, 'Sólo se programa un borrador.', { code: 'not_draft' });
      const p = preview(c, user);
      if (p.blockers.length)
        throw fail(409, p.blockers[0].label, { code: 'blocked', details: { blockers: p.blockers } });
      if (input.confirmAudience !== p.willSend)
        throw fail(409, 'El público cambió: revisa la vista previa otra vez.', {
          code: 'audience_changed',
          details: { willSend: p.willSend },
        });
      if (!p.rehearsal && (p.cost?.max.micros ?? 0) > 0 && input.acceptCost !== true)
        throw fail(400, 'Confirma el costo estimado antes de programar.', { code: 'accept_cost', field: 'acceptCost' });
      const t = now();
      const at = input.scheduledAt === undefined || input.scheduledAt === null ? t : Number(input.scheduledAt);
      if (!Number.isFinite(at) || at < t - 60_000 || at > t + SCHEDULE_MAX_MS)
        throw fail(400, 'La fecha va de ahora a 90 días.', { field: 'scheduledAt' });
      const estimate = JSON.stringify({ cost: p.cost, willSend: p.willSend, at: t });
      const done = atomic(db, () => {
        if (!repo.schedule(Math.max(at, t), p.willSend, estimate, t, c.id, c.revision).changes) return false;
        event(c, 'scheduled', { at: Math.max(at, t), recipients: p.willSend, rehearsal: p.rehearsal }, user.id);
        return true;
      });
      if (!done) throw fail(409, 'La difusión cambió. Recárgala.', { code: 'stale_record' });
      host.audit(user, 'broadcast.scheduled', c.id);
      return changedView(c.id);
    }
    function changedView(id) {
      const fresh = repo.campaignAny(id);
      touched(fresh);
      flush();
      return { campaign: view(fresh) };
    }
    function move(id, input, user, { from, to, kind, reason = null, check }) {
      const c = getCampaign(user, id, 'campaigns.send');
      guard(c, input);
      if (!from.includes(c.status))
        throw fail(409, `No se puede ${kind} una difusión ${CAMPAIGN_STATUS[c.status]?.toLowerCase()}.`, {
          code: 'invalid_transition',
        });
      if (check) check(c);
      const t = now();
      const done = atomic(db, () => {
        const target = typeof to === 'function' ? to(c) : to;
        const resume = target === 'paused' ? c.status : null;
        if (!repo.transition(target, reason, resume, t, c.id, c.status).changes) return false;
        if (target === 'cancelled') {
          const n = repo.cancelPending(t, c.id).changes;
          event(c, 'cancelled', { pending: n }, user.id);
        } else event(c, kind, {}, user.id);
        return true;
      });
      if (!done) throw fail(409, 'La difusión cambió. Recárgala.', { code: 'stale_record' });
      host.audit(user, 'broadcast.' + kind, c.id);
      return changedView(c.id);
    }
    const unschedule = (id, input, user) => {
      const c = getCampaign(user, id, 'campaigns.send');
      guard(c, input);
      if (c.status !== 'scheduled') throw fail(409, 'Sólo una difusión programada vuelve a borrador.');
      if (!repo.unschedule(now(), c.id, c.revision).changes) throw fail(409, 'La difusión cambió. Recárgala.');
      event(c, 'unscheduled', {}, user.id);
      return changedView(c.id);
    };
    const pause = (id, input, user) =>
      move(id, input, user, { from: ['scheduled', 'sending'], to: 'paused', kind: 'paused' });
    const cancel = (id, input, user) =>
      getCampaign(user, id, 'campaigns.send').status === 'cancelled' // repetir la cancelación es inocuo
        ? { campaign: view(getCampaign(user, id)) }
        : move(id, input, user, {
            from: ['draft', 'scheduled', 'sending', 'paused', 'stopped'],
            to: 'cancelled',
            kind: 'cancelled',
          });
    function resume(id, input, user) {
      return move(id, input, user, {
        from: ['paused', 'stopped'],
        kind: 'resumed',
        to: c => c.resume_status || 'sending',
        check: c => {
          if (c.status === 'stopped') {
            const still = stopCause(c);
            if (still) throw fail(409, `Sigue sin poder enviarse: ${STOP_REASONS[still] ?? still}.`, { code: still });
          }
        },
      });
    }
    // ¿Sigue la causa de una detención? Una plantilla pausada o un número restringido no se reanudan solos.
    function stopCause(c) {
      const live = !rehearsal(c);
      const ctx = contextOf(c);
      if (live) {
        const tpl = ctx.tpl;
        if (!tpl) return 'template_missing';
        if (tpl.status === 'paused') return 'template_paused';
        if (tpl.status === 'disabled') return 'template_disabled';
        if (tpl.archived_at || !USABLE.includes(tpl.status)) return 'template_rejected';
        if (!services.connectors.metaLive()) return 'whatsapp_off';
        if (c.wa_number && !repo.number(c.brand_id, c.wa_number)?.enabled) return 'number_paused';
        if (c.wa_number) {
          const g = gate.check(c.wa_number, ctx.category, c.brand_id);
          if (!g.ok) return STOP_REASONS[g.reason] ? g.reason : 'number_restricted';
        }
        const set = settings(c.brand_id);
        const engine = costs();
        if (
          set.monthlyBudgetCents > 0 &&
          engine &&
          engine.monthSpend(c.brand_id).micros >= set.monthlyBudgetCents * 10_000
        )
          return 'budget_exceeded';
      }
      return null; // la tasa de fallos no «sigue»: reanudar es la decisión de una persona y se cuenta desde ahí
    }

    // ---- detener (el sistema): sin transacción propia; quien llama la abre si hace falta
    function stop(c, reason) {
      const fresh = repo.campaignAny(c.id);
      if (!fresh || !['scheduled', 'sending'].includes(fresh.status)) return false;
      const t = now();
      if (!repo.transition('stopped', reason, fresh.status, t, fresh.id, fresh.status).changes) return false;
      event(fresh, 'stopped', { reason });
      services.events.publish({
        type: 'difusion.detenida',
        brandId: fresh.brand_id,
        entityKind: 'campaign',
        entityId: fresh.id,
        payload: { title: fresh.title, reason },
        source: 'broadcasts',
        dedupeKey: ['difusion.detenida', fresh.id, reason, fresh.revision].join(':'),
      });
      touched(fresh);
      return true;
    }
    const waitFor = (c, reason) => {
      if (repo.setReason(reason, c.id, reason).changes) touched(c);
    };

    // ---- lanzar: escribe a todos los destinatarios y pasa a «enviando» (una transacción por campaña, sin red)
    function launch(c, t) {
      const ctx = contextOf(c);
      const live = !rehearsal(c);
      if (!switchesOn(c.brand_id)) return waitFor(c, 'brand_off');
      if (live) {
        if (!ctx.tpl || ctx.tpl.archived_at) return atomic(db, () => stop(c, 'template_missing'));
        if (ctx.tpl.status === 'pending') {
          if (t - c.scheduled_at > WAIT_TEMPLATE_MS) return atomic(db, () => stop(c, 'template_not_approved_in_time'));
          return waitFor(c, 'waiting_template');
        }
        if (!USABLE.includes(ctx.tpl.status)) return atomic(db, () => stop(c, stopCause(c) ?? 'template_rejected'));
      }
      const set = settings(c.brand_id);
      if (quiet(c, ctx, set, t)) return waitFor(c, 'outside_hours');
      const rows = members(c);
      const opts = ctx.options;
      const done = atomic(db, () => {
        const fresh = repo.campaignAny(c.id);
        if (fresh?.status !== 'scheduled') return false;
        const seen = new Set();
        let position = 0;
        for (const row of rows) {
          let reason = row.reason ? (AUDIENCE_REASON[row.reason] ?? 'excluded') : null;
          // sin teléfono, el identificador de usuario de WhatsApp en el ámbito del número de la campaña (I-2)
          const recipient = !reason && !row.phoneKey ? recipientOf(row.contactId, c.wa_number) : null;
          const address = row.phoneKey || (recipient ? 'u:' + recipient : '');
          if (!reason && (!address || seen.has(address))) reason = address ? 'duplicate' : 'no_address';
          if (!reason)
            reason =
              judge(
                c,
                ctx,
                { id: row.contactId, name: row.name, phone_key: row.phoneKey, wa_recipient: recipient },
                set,
                t,
              ).reason ?? null;
          if (!reason && position >= set.maxAudience) reason = 'over_limit';
          if (repo.recipientOfContact(c.id, row.contactId)) continue;
          if (reason) {
            repo.insertRecipient(
              newId(),
              c.id,
              row.contactId,
              0,
              'skipped',
              null,
              0,
              null,
              null,
              null,
              reason,
              null,
              t,
              t,
            );
            continue;
          }
          seen.add(address);
          const batch = opts.batchSize ? Math.floor(position / opts.batchSize) : 0;
          repo.insertRecipient(
            newId(),
            c.id,
            row.contactId,
            1,
            'queued',
            position,
            batch,
            row.phoneKey || null,
            row.phoneKey ? null : recipient,
            t,
            null,
            null,
            t,
            t,
          );
          position++;
        }
        const retryUntil = opts.retry?.enabled && ctx.category === 'marketing' ? c.scheduled_at + 7 * DAY : null;
        repo.launched(t, t, position, retryUntil, t, c.id);
        event(c, 'launched', { recipients: position, rehearsal: !live });
        services.events.publish({
          type: 'difusion.iniciada',
          brandId: c.brand_id,
          entityKind: 'campaign',
          entityId: c.id,
          payload: { title: c.title, recipients: position, rehearsal: !live },
          source: 'broadcasts',
          dedupeKey: 'difusion.iniciada:' + c.id,
        });
        return true;
      });
      if (done) touched(c);
    }
    function quiet(c, ctx, set, t) {
      if (ctx.category !== 'marketing' || ctx.options.sendHours === 'any') return false;
      return inQuietHours(t, timezoneOf(c.brand_id), set.quietStart, set.quietEnd);
    }

    // ---- emisor
    const buckets = new Map(); // campaña → cubeta de fichas (en memoria: al reiniciar empieza llena)
    const media = new Map(); // campaña → archivo del encabezado ya subido a Meta
    const inflight = new Set(); // destinatarios con la llamada a Meta en curso en ESTE proceso
    function plan(c, t, perNumber) {
      const ctx = contextOf(c);
      const live = !rehearsal(c);
      if (!switchesOn(c.brand_id)) return (waitFor(c, 'brand_off'), null);
      const set = settings(c.brand_id);
      if (live) {
        const cause = stopCause(c);
        if (cause) return (atomic(db, () => stop(c, cause)), null);
      }
      if (quiet(c, ctx, set, t)) return (waitFor(c, 'outside_hours'), null);
      // tandas: cuando la tanda liberada termina, una pausa y la siguiente
      if (ctx.options.batchSize && c.batch_no < repo.maxBatch(c.id).n && !repo.batchOpen(c.id, c.batch_no).n) {
        if (!c.batch_release_at) {
          repo.batchWait(t + ctx.options.batchPauseMinutes * 60_000, c.id);
          waitFor(c, 'batch_pause');
          return null;
        }
        if (t < c.batch_release_at) return null;
        if (repo.releaseBatch(t, c.id, c.batch_no).changes) {
          event(c, 'batch_released', { batch: c.batch_no + 1 });
          touched(c);
          c = repo.campaignAny(c.id);
        }
      }
      const rate = Math.min(600, (ctx.options.ratePerMinute ?? set.ratePerMinute) || 60) * RATE_SCALE;
      let bucket = buckets.get(c.id);
      if (!bucket || bucket.rate !== rate) buckets.set(c.id, (bucket = createBucket(rate, t)));
      let n = bucket.available(t);
      if (live) {
        const g = gate.check(c.wa_number, ctx.category, c.brand_id);
        const used = perNumber.get(c.wa_number) ?? 0;
        n = Math.min(n, Math.max(0, g.remaining - used), Math.max(0, PER_SECOND * RATE_SCALE - used));
        if (g.remaining - used <= 0) return (waitFor(c, 'daily_limit'), null);
        if (ctx.hasFile && !media.has(c.id)) n = Math.min(n, 1); // el archivo se sube una vez y se reutiliza
      }
      if (n <= 0) return null;
      if (c.status_reason) waitFor(c, null);
      return { c, ctx, set, n, bucket, live };
    }
    function reserve(p, row, t) {
      const { c, ctx, set } = p;
      return atomic(db, () => {
        const fresh = repo.campaignAny(c.id);
        if (fresh?.status !== 'sending') return null;
        const current = repo.recipient(row.id);
        if (!current || !['queued', 'deferred'].includes(current.state)) return null;
        const contact = repo.contact(c.brand_id, current.contact_id);
        const skip = reason => (repo.skip(reason, t, current.id), touched(c), null);
        if (!contact || (!current.wa_to && !current.wa_recipient)) return skip('no_address');
        const consent = repo.consent(contact.id)?.status ?? 'unknown';
        if (consent === 'opted_out') return skip('opted_out'); // pidió la baja mientras la campaña corría
        if (c.require_consent && consent !== 'opted_in') return skip('no_consent');
        if (audiences()?.suppressed(c.brand_id, contact.id)) return skip('suppressed');
        const overrides = json(current.params).overrides ?? {};
        const verdict = judge(c, ctx, { ...contact, wa_recipient: current.wa_recipient }, set, t, overrides);
        if (verdict.reason) return skip(verdict.reason);
        const r = render(ctx, contact, current.id, overrides);
        if (r.reason) return skip(r.reason);
        const snapshot = JSON.stringify({
          overrides,
          template: r.template,
          quickReplies: r.quickReplies,
          category: ctx.category,
          templateId: ctx.tpl.id,
          templateRevision: ctx.tpl.revision,
          commercial: { courseId: ctx.course?.id ?? null, editionId: ctx.edition?.id ?? null },
        });
        if (!repo.reserve(worker, t + LEASE_MS, snapshot, r.rendered, t, current.id).changes) return null;
        return {
          id: current.id,
          attempt: current.attempts + 1,
          to: current.wa_to,
          recipient: current.wa_to ? null : current.wa_recipient,
          template: r.template,
          campaign: c,
          ctx,
          live: p.live,
        };
      });
    }
    async function deliver(job) {
      try {
        if (!job.live) return settle(job, simulate(job));
        let template = job.template;
        const head = template.header;
        if (head && (head.type === 'image' || head.type === 'document')) {
          const cached = media.get(job.campaign.id);
          if (cached)
            template = { ...template, header: { type: head.type, mediaId: cached.id, filename: cached.filename } };
          else template = await templates().forSend(template);
        }
        const res = await withTimeout(
          meta().send({
            to: job.to,
            recipient: job.recipient,
            from: job.campaign.wa_number,
            template,
            callback: callbackOf(job.id, job.attempt),
          }),
          SEND_TIMEOUT_MS,
        );
        if (res?.mediaId && !media.has(job.campaign.id))
          media.set(job.campaign.id, { id: res.mediaId, filename: template.header?.media?.filename || 'archivo' });
        return settle(job, { ok: true, providerRef: res.providerRef, waId: res.waId ?? null });
      } catch (error) {
        return settle(job, { ok: false, error });
      } finally {
        inflight.delete(job.id);
      }
    }
    function simulate(job) {
      const rate = Number(repo.failureRate(job.campaign.brand_id)?.failure_rate) || 0;
      if (Math.random() * 100 < rate)
        return { ok: false, error: Object.assign(new Error('Fallo simulado del ensayo.'), { metaCode: 131026 }) };
      return { ok: true, providerRef: 'sim_' + newId().slice(0, 16), waId: null };
    }
    function settle(job, out) {
      const t = now();
      const c = job.campaign;
      atomic(db, () => {
        if (out.ok) {
          repo.sent(t, out.providerRef, out.waId, t, job.id, job.attempt);
          return;
        }
        const e = out.error;
        if (e?.metaCode) return failWithCode(c, job.id, job.attempt, e.metaCode, e.message, t, { atSend: true });
        if (e?.beforeSend) {
          // la conexión ni se abrió: no salió nada; se reintenta a 1, 5 y 15 minutos y al cuarto queda fallido
          if (job.attempt <= BACKOFF_MS.length)
            return repo.requeue(0, t + BACKOFF_MS[job.attempt - 1], null, safeError(e), t, job.id);
          return repo.failed(t, null, 'network', FAIL_KINDS.network, t, job.id);
        }
        if (e?.timeout || e?.transient || e?.network) return; // en duda: se queda «sending»; nunca se reenvía a ciegas
        if (e?.status === 503) {
          repo.requeue(1, t, null, null, t, job.id);
          return stop(c, 'whatsapp_off');
        }
        if (e?.status === 422) {
          repo.requeue(1, t, null, null, t, job.id);
          return stop(c, 'header_unavailable');
        }
        repo.failed(t, null, 'error', safeError(e), t, job.id);
      });
      touched(c);
      afterOutcome(c);
    }
    // Un rechazo de Meta con código (al enviar o por aviso posterior). Sin transacción propia.
    function failWithCode(c, recipientId, attempt, code, message, t, { atSend = false } = {}) {
      const rule = classifyMetaError(code, message);
      if (rule.stop && atSend) {
        repo.requeue(1, t, code, rule.label, t, recipientId); // no es culpa de la persona: vuelve a la cola
        return stop(c, rule.stop);
      }
      if (rule.recipient === 'requeue' && atSend) {
        if (rule.backoff && attempt > BACKOFF_MS.length)
          return repo.failed(t, code, 'meta', rule.label, t, recipientId);
        const delay = rule.backoff ? BACKOFF_MS[attempt - 1] : rule.delayMs;
        return repo.requeue(rule.backoff ? 0 : 1, t + delay, code, rule.label, t, recipientId);
      }
      if (rule.recipient === 'cap') {
        const fresh = repo.campaignAny(c.id);
        if (fresh?.retry_until && fresh.retry_until > t)
          return repo.deferred(
            t + RETRY_AFTER_MS + Math.floor(Math.random() * 30 * 60_000),
            code,
            rule.label,
            t,
            recipientId,
          );
      }
      repo.failed(t, code, 'meta', rule.label, t, recipientId);
      if (rule.stop) stop(c, rule.stop);
      else if (rule.streak) {
        const last = repo.streak(c.id).map(r => r.fail_code);
        const group = classifyMetaError(code).streak;
        if (last.length === 3 && last.every(x => classifyMetaError(x).streak === group)) stop(c, rule.streak);
      }
    }
    function afterOutcome(c) {
      const fresh = repo.campaignAny(c.id);
      if (fresh?.status !== 'sending') return;
      const since = repo.since(c.id)?.at ?? 0; // desde que se lanzó o se reanudó por última vez
      const outcomes = repo.outcomes(c.id, since).map(r => Boolean(r.bad));
      if (tooManyFailures(outcomes, settings(c.brand_id).failStopPct))
        atomic(db, () => stop(fresh, 'high_failure_rate'));
    }
    // Envío en duda: el arrendamiento venció y no llegó ningún aviso de Meta en el plazo → fallido «sin confirmar».
    function reconcile(t) {
      for (const r of repo.stale(t, t - RECONCILE_MS)) {
        if (inflight.has(r.id)) continue;
        atomic(db, () => repo.failed(t, null, 'unconfirmed', FAIL_KINDS.unconfirmed, t, r.id));
        touched({ id: r.campaign_id, brand_id: r.brand_id });
      }
      for (const r of repo.expiredRetries(t))
        repo.failed(t, null, 'retry_window_ended', FAIL_KINDS.retry_window_ended, t, r.id);
    }
    // Ensayo: entregado a los 2 s y, a 4 de cada 10, leído a los 5 s. No escribe costos ni conversaciones.
    function rehearse(t) {
      for (const r of repo.rehearsalSent(t - 2000)) {
        if (t - r.sent_at > 60_000) continue;
        const reads = parseInt(r.id.slice(-2), 16) % 10 < 4;
        if (r.state === 'sent') repo.delivered(r.sent_at + 2000, t, r.id);
        if (reads && t - r.sent_at >= 5000) repo.read(r.sent_at + 2000, r.sent_at + 5000, t, r.id);
        touched({ id: r.campaign_id, brand_id: repo.campaignAny(r.campaign_id)?.brand_id });
      }
    }
    function close(t) {
      for (const c of repo.sending()) {
        const p = repo.pendingCount(c.id);
        if ((p.queued ?? 0) + (p.sending ?? 0) + (p.deferred ?? 0) > 0) continue;
        if (json(c.options).origin === 'api') continue; // la campaña de envíos sueltos del día sigue abierta
        atomic(db, () => {
          if (repo.complete(t, t, c.id).changes) event(c, 'completed', {});
        });
        touched(c);
      }
    }
    let ticking = false;
    async function tick() {
      if (ticking) return;
      ticking = true;
      try {
        const t = now();
        reconcile(t);
        for (const c of repo.due(t)) launch(c, t);
        rehearse(t);
        const jobs = [];
        const perNumber = new Map();
        for (const c of repo.sending()) {
          const p = plan(c, t, perNumber);
          if (!p) continue;
          let taken = 0;
          for (const row of repo.dueRecipients(c.id, t, p.c.batch_no, p.n)) {
            const job = reserve(p, row, t);
            if (!job) continue;
            jobs.push(job);
            taken++;
          }
          p.bucket.take(taken);
          if (p.live && c.wa_number) perNumber.set(c.wa_number, (perNumber.get(c.wa_number) ?? 0) + taken);
          if (taken) touched(c);
        }
        // a Meta, fuera de toda transacción y con pocas llamadas a la vez (un solo hilo: hallazgo F-4)
        for (const job of jobs) inflight.add(job.id);
        let next = 0;
        const lane = async () => {
          while (next < jobs.length) {
            const job = jobs[next++];
            // la campaña se detuvo, pausó o canceló mientras esperaba su turno: vuelve a la cola sin salir
            const status = repo.campaignAny(job.campaign.id)?.status;
            if (status !== 'sending') {
              repo.requeue(1, now(), null, null, now(), job.id);
              if (status === 'cancelled') repo.cancelPending(now(), job.campaign.id);
              inflight.delete(job.id);
              continue;
            }
            await deliver(job);
          }
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, lane));
        close(now());
      } finally {
        ticking = false;
        flush();
      }
    }

    // ---- avisos de estado de Meta (oyente síncrono, después del canal y antes de los costos: fila 40)
    const ORDER = { sending: 0, sent: 1, delivered: 2, read: 3 };
    function applyStatus(data) {
      const ref = typeof data?.providerRef === 'string' ? data.providerRef.slice(0, 200) : '';
      const state = data?.state;
      if (!ref || !['sent', 'delivered', 'read', 'failed'].includes(state)) return null;
      const t = Number(data.at) || now();
      return atomic(db, () => {
        let r = repo.recipientByRef(ref);
        if (!r) {
          // la respuesta del envío se perdió (reinicio, tiempo de espera): el dato de vuelta dice qué destinatario era
          const cb = parseCallback(data.callback);
          const found = cb ? repo.recipient(cb.recipientId) : null;
          if (!found || found.attempts !== cb.attempt) return null;
          if (!repo.adoptRef(ref, t, t, found.id, cb.attempt).changes) return null;
          r = repo.recipient(found.id);
        }
        const c = repo.campaignAny(r.campaign_id);
        if (!c) return null;
        if (state === 'failed') {
          if (['delivered', 'read'].includes(r.state)) return 'difusión: fallo tardío ignorado';
          failWithCode(c, r.id, r.attempts, Number(data.code) || 0, data.reason || data.detail || '', t);
          touched(c);
          afterOutcome(c);
          return 'difusión: destinatario fallido';
        }
        if ((ORDER[r.state] ?? -1) >= ORDER[state] || !(r.state in ORDER)) return 'difusión: sin cambio';
        if (state === 'delivered') repo.delivered(t, t, r.id);
        else if (state === 'read') repo.read(t, t, t, r.id);
        touched(c);
        return 'difusión: destinatario ' + state;
      });
    }
    services.connectors.on('message.status', data => applyStatus(data), { order: 200, name: 'difusiones' });

    // ---- respuesta a una difusión (fila 25: manda attribute). Todo síncrono y sin transacción propia: lo llama el
    // entrante de WhatsApp dentro de la suya, antes de buscar o crear la conversación.
    function attribute({ waId, userId = null, numberId, contextRef = null, payload = null, at = now() } = {}) {
      const days = Number(repo.attributionDays()) || 7;
      const sender = String(waId || '');
      const key = canonicalPhone(sender, { international: true }).key ?? sender;
      const bsuid = String(userId || '');
      // Sólo cuenta una difusión real, del número por el que entró el mensaje (y por tanto de su marca), y un
      // destinatario que ES quien escribe (su teléfono canónico, el wa_id que Meta devolvió o, sin teléfono, su
      // identificador de usuario). Una carga de botón o una cita de otra persona no se atribuye: así nadie puede marcar
      // respuestas, clics ni conversaciones ajenas.
      const own = r =>
        Boolean(
          r &&
          ((r.wa_to && r.wa_to === key) ||
            (r.wa_id && r.wa_id === sender) ||
            (r.wa_recipient && bsuid && r.wa_recipient === bsuid)),
        );
      const hit = (r, exact, button = null) => {
        const c = r ? repo.campaignAny(r.campaign_id) : null;
        const usable = c && json(c.options).mode !== 'rehearsal' && c.wa_number === numberId;
        return usable && own(r) && r.sent_at ? { recipient: r, campaign: c, exact, button } : null;
      };
      const p = parsePayload(payload);
      if (p) {
        const r = repo.recipient(p.recipientId);
        const label = r ? (json(r.params).quickReplies?.[p.index] ?? null) : null;
        const found = hit(r, true, label === null ? null : { index: p.index, label });
        if (found) return found;
      }
      if (contextRef) {
        const found = hit(repo.recipientByRef(String(contextRef).slice(0, 200)), true);
        if (found) return found;
      }
      return hit(repo.lastSentTo(key, sender, bsuid || null, numberId, at - days * DAY), false);
    }
    // El contacto de la lista pasa a ser el de la persona que respondió (un solo contacto por persona y marca).
    function adopt(hit, userId) {
      if (!hit) return false;
      return (
        repo.adoptContact(userId, now(), hit.recipient.contact_id, hit.campaign.brand_id, userId, hit.campaign.brand_id)
          .changes > 0
      );
    }
    // Curso y edición de la campaña (sólo con atribución exacta): ahí nace o se mueve la conversación.
    function courseOf(hit) {
      if (!hit?.exact) return null;
      const context = json(hit.campaign.content).context ?? {};
      const course = context.courseId ? repo.course(hit.campaign.brand_id, context.courseId) : null;
      if (!course?.active) return null;
      const ed = context.editionId ? repo.edition(hit.campaign.brand_id, context.editionId) : null;
      return { id: course.id, editionId: ed?.status === 'published' && ed.course_id === course.id ? ed.id : null };
    }
    function onReply(hit, conversation, { at = now() } = {}) {
      if (!hit || !conversation) return null;
      const r = repo.recipient(hit.recipient.id);
      const c = hit.campaign;
      const snap = json(r.params);
      let messageId = repo.messageByRef('campaign:' + r.id)?.id ?? null;
      if (!messageId && r.rendered && snap.template) {
        // el mensaje de la difusión queda en la conversación ANTES del de la persona: quien atiende ve a qué responde
        messageId = host.insertMessage(
          conversation,
          null,
          r.rendered,
          'automation',
          'campaign:' + r.id,
          null,
          null,
          null,
          {
            category: snap.category === 'utility' ? 'utility' : 'marketing',
            template: { ...snap.template, templateId: snap.templateId, campaignId: c.id },
            buttons: snap.quickReplies?.length ? snap.quickReplies : undefined,
            keepButtons: true,
          },
        );
        repo.stampMessage(
          r.sent_at ?? at,
          r.provider_ref,
          ['delivered', 'read'].includes(r.state) ? r.state : 'sent',
          r.delivered_at,
          messageId,
        );
      }
      const button = hit.button;
      repo.replied(
        at,
        button ? 'button' : 'text',
        button ? at : null,
        button ? at : null,
        button?.label ?? null,
        conversation.id,
        messageId,
        at,
        r.id,
      );
      services.events.publish({
        type: 'difusion.respondida',
        brandId: c.brand_id,
        entityKind: 'campaign',
        entityId: c.id,
        payload: {
          campaignId: c.id,
          recipientId: r.id,
          contactId: r.contact_id,
          conversationId: conversation.id,
          kind: button ? 'button' : 'text',
          buttonIndex: button?.index ?? undefined,
          buttonLabel: button?.label ?? undefined,
        },
        source: 'broadcasts',
        dedupeKey: 'difusion.respondida:' + r.id,
      });
      touched(c);
      return { action: { type: 'default' }, messageId };
    }

    // ---- envío suelto (fila 37): lo usa la API de envío (server/modules/api-write, docs/PLAN_API_ENVIO.md)
    // sendOne({brandId, contactId | phone, waTemplateId, waNumber?, values?, label?, clientRef, actorId?, strict?}) →
    //   {id, campaignId, state, …, duplicate}. Un envío por (etiqueta, plantilla, día local, contacto); la misma
    //   clientRef devuelve el mismo destinatario. Sale por el emisor con las mismas reglas que una difusión.
    //   Con `strict` (la API) lo que el emisor juzgaría al enviar se juzga ya, para responder el motivo en lugar de
    //   dejar un envío que se omitirá: WhatsApp real y las difusiones de la marca encendidos, salud y límite del
    //   número, presupuesto, campaña de la API detenida, dirección, baja, lista de exclusión, consentimiento si es de
    //   marketing y los valores de la plantilla. El emisor lo vuelve a mirar justo antes de enviar, como siempre.
    const apiContext = (brandId, tpl) => ({
      tpl,
      category: tpl.category === 'utility' ? 'utility' : 'marketing',
      brandName: repo.brand(brandId)?.name ?? '',
      course: null,
      edition: null,
      fixed: {},
      coupon: null,
      options: {},
      hasFile: ['image', 'document'].includes(definitionOf(tpl).header.type),
    });
    function precheckBrand(brandId, tpl, number, campaignRef) {
      if (!['utility', 'marketing'].includes(tpl.category))
        throw fail(422, 'Por la API sólo se envían plantillas de utilidad o de marketing.', {
          code: 'template_category',
        });
      if (!services.connectors.metaLive())
        throw fail(503, 'WhatsApp real está apagado: no sale ningún mensaje.', { code: 'whatsapp_off' });
      if (!switchesOn(brandId))
        throw fail(409, 'Las difusiones o la automatización de la marca están apagadas.', { code: 'broadcasts_off' });
      const category = tpl.category === 'utility' ? 'utility' : 'marketing';
      const g = gate.check(number.phone_number_id, category, brandId);
      if (!g.ok)
        throw fail(409, 'El número de WhatsApp no puede enviar ahora.', {
          code: 'number_unavailable',
          details: { reason: g.reason },
        });
      if (g.remaining <= 0)
        throw fail(429, 'El número llegó a su límite de mensajes de 24 horas. Inténtalo más tarde.', {
          code: 'messaging_limit_reached',
        });
      const set = settings(brandId);
      const engine = costs();
      if (set.monthlyBudgetCents > 0 && engine && engine.monthSpend(brandId).micros >= set.monthlyBudgetCents * 10_000)
        throw fail(409, 'La marca agotó su presupuesto del mes para WhatsApp.', { code: 'budget_exceeded' });
      const c = repo.apiCampaign(campaignRef);
      if (c && ['stopped', 'paused', 'cancelled'].includes(c.status))
        throw fail(409, 'Los envíos de hoy con esta etiqueta y plantilla están detenidos en Difusiones.', {
          code: 'sending_stopped',
          details: { reason: c.status_reason ?? c.status },
        });
    }
    function precheckContact(brandId, tpl, number, contact, values) {
      if (!contact.phone_key && !recipientOf(contact.id, number.phone_number_id))
        throw fail(422, 'Este contacto no tiene WhatsApp al que escribirle.', { code: 'recipient_no_address' });
      const consent = repo.consent(contact.id)?.status ?? 'unknown';
      // Baja y lista de exclusión responden lo mismo: quien llama sabe que no se puede, no por qué.
      if (consent === 'opted_out' || audiences()?.suppressed(brandId, contact.id))
        throw fail(422, 'Esta persona no puede recibir mensajes de la marca.', { code: 'recipient_unavailable' });
      if (tpl.category !== 'utility' && consent !== 'opted_in')
        throw fail(422, 'Una plantilla de marketing sólo se envía a quien aceptó recibir mensajes.', {
          code: 'consent_required',
        });
      const r = render(apiContext(brandId, tpl), contact, '0'.repeat(32), values);
      if (r.reason === 'missing_variable')
        throw fail(422, 'Faltan valores para la plantilla.', {
          code: 'template_params',
          details: { missing: r.missing },
        });
      if (r.reason === 'too_long')
        throw fail(422, 'El mensaje pasa del máximo de Meta con esos valores.', { code: 'template_too_long' });
    }
    function sendOne(input = {}) {
      const brandId = String(input.brandId || '');
      if (!repo.brand(brandId)) throw fail(400, 'Marca no válida.', { field: 'brandId' });
      const clientRef = String(input.clientRef || '');
      if (!REF.test(clientRef)) throw fail(400, 'Referencia no válida.', { field: 'clientRef' });
      const scoped = brandId + ':' + clientRef;
      const prev = repo.recipientByClientRef(scoped);
      if (prev) return { ...sendStatus(brandId, prev.id), duplicate: true };
      const tpl = templateFor(brandId, input.waTemplateId);
      if (!USABLE.includes(tpl.status))
        throw fail(409, 'La plantilla todavía no está aprobada.', { code: 'template_not_usable' });
      const numbers = repo.numbers(brandId).filter(n => n.enabled);
      const number = input.waNumber
        ? repo.number(brandId, String(input.waNumber))
        : numbers.length === 1
          ? numbers[0]
          : null;
      if (!number?.enabled) throw fail(400, 'Indica un número de WhatsApp activo de la marca.', { field: 'waNumber' });
      let contact = null;
      if (input.contactId) contact = repo.contact(brandId, String(input.contactId));
      else if (input.phone) {
        const key = canonicalPhone(String(input.phone), { international: true }).key;
        contact = key ? repo.contactByKey(brandId, key) : null;
      }
      if (!contact) throw fail(404, 'Contacto no encontrado en la marca.', { code: 'contact_not_found' });
      const label = text(String(input.label || 'api'), 40).replace(/[^a-z0-9_-]/gi, '') || 'api';
      const values = {};
      for (const [k, v] of Object.entries(input.values && typeof input.values === 'object' ? input.values : {}).slice(
        0,
        10,
      ))
        if (/^[a-z0-9_]{1,30}$/.test(k)) values[k] = text(String(v ?? ''), 200);
      const t = now();
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezoneOf(brandId) }).format(new Date(t));
      const campaignRef = `api:${brandId}:${label}:${tpl.id}:${number.phone_number_id}:${day}`;
      if (input.strict === true) {
        precheckBrand(brandId, tpl, number, campaignRef);
        precheckContact(brandId, tpl, number, contact, values);
      }
      const id = atomic(db, () => {
        let c = repo.apiCampaign(campaignRef);
        if (!c) {
          const cid = randomUUID();
          repo.insertCampaign(
            cid,
            brandId,
            `API · ${label} · ${tpl.name} · ${day}`,
            tpl.id,
            number.phone_number_id,
            JSON.stringify({ context: {}, fixed: {}, couponId: null }),
            '{}',
            tpl.category === 'marketing' ? 1 : 0,
            JSON.stringify({
              mode: 'live',
              origin: 'api',
              sendHours: tpl.category === 'marketing' ? 'brand' : 'any',
              retry: { enabled: false },
            }),
            'sending',
            t,
            timezoneOf(brandId),
            campaignRef,
            input.actorId ?? null,
            t,
            t,
          );
          db.prepare('UPDATE campaigns SET started_at=?,launched_at=? WHERE id=?').run(t, t, cid);
          c = repo.campaignAny(cid);
          event(c, 'launched', { origin: 'api' });
        } else if (c.status === 'completed') repo.transition('sending', null, null, t, c.id, 'completed');
        if (repo.recipientOfContact(c.id, contact.id))
          throw fail(409, 'Ese contacto ya tiene este envío hoy.', { code: 'already_sent_today' });
        const rid = newId();
        const position = repo.pendingCount(c.id);
        const recipient = contact.phone_key ? null : recipientOf(contact.id, c.wa_number);
        const reachable = Boolean(contact.phone_key || recipient);
        repo.insertRecipient(
          rid,
          c.id,
          contact.id,
          reachable ? 1 : 0,
          reachable ? 'queued' : 'skipped',
          (position.queued ?? 0) + (position.sending ?? 0),
          0,
          contact.phone_key || null,
          recipient,
          t,
          reachable ? null : 'no_address',
          scoped,
          t,
          t,
        );
        db.prepare('UPDATE campaign_recipients SET params=? WHERE id=?').run(
          JSON.stringify({ overrides: values }),
          rid,
        );
        db.prepare('UPDATE campaigns SET audience_size=audience_size+1 WHERE id=?').run(c.id);
        touched(c);
        return rid;
      });
      flush();
      return { ...sendStatus(brandId, id), duplicate: false };
    }
    function sendStatus(brandId, id) {
      const r = typeof id === 'string' ? repo.recipientOf(String(brandId), id) : null;
      if (!r) throw fail(404, 'Envío no encontrado.', { code: 'not_found' });
      return {
        id: r.id,
        campaignId: r.campaign_id,
        contactId: r.contact_id,
        state: r.state,
        stateLabel: RECIPIENT_STATES[r.state] ?? r.state,
        skipReason: r.skip_reason,
        failCode: r.fail_code,
        failReason: r.fail_reason,
        sentAt: r.sent_at,
        deliveredAt: r.delivered_at,
        readAt: r.read_at,
        failedAt: r.failed_at,
        repliedAt: r.replied_at,
      };
    }

    // ---- lista, opciones, destinatarios, ajustes
    function list(user, url) {
      const brand = url.searchParams.get('brand');
      let brandIds = access.brandIds(user, 'campaigns.view');
      if (brand && brand !== 'all') {
        if (!brandIds.includes(brand)) throw fail(404, 'Marca no encontrada.');
        brandIds = [brand];
      }
      if (!brandIds.length) access.require(user, 'campaigns.view');
      const status = url.searchParams.get('status');
      if (status && !CAMPAIGN_STATUS[status]) throw fail(400, 'Estado no válido.', { field: 'status' });
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const { rows, total } = repo.list(brandIds, { status, limit, offset });
      const stats = statsOf(rows.map(r => r.id));
      return {
        broadcasts: rows.map(r => view(r, stats.get(r.id))),
        total,
        brands: access.brandIds(user, 'campaigns.view').map(id => ({ id, name: repo.brand(id)?.name ?? id })),
      };
    }
    function options(user, brandId) {
      if (!repo.brand(brandId) || !access.can(user, 'campaigns.view', brandId)) throw fail(404, 'Marca no encontrada.');
      const aud = audiences();
      try {
        aud?.ensurePresets?.(brandId);
      } catch {}
      return {
        templates: repo.templates(brandId).map(t => {
          const def = definitionOf(t);
          return {
            id: t.id,
            name: t.name,
            language: t.language,
            category: t.category,
            status: t.status,
            body: def.body.text,
            vars: def.body.vars.map(v => v.key),
            header: def.header.type,
            buttons: def.buttons.map(b => b.text || 'Copiar código'),
          };
        }),
        numbers: repo
          .numbers(brandId)
          .map(n => ({ id: n.phone_number_id, label: n.label, enabled: Boolean(n.enabled) })),
        audiences: aud
          ? db
              .prepare(
                'SELECT id,name,kind,role,member_count FROM audiences WHERE brand_id=? AND archived_at IS NULL ORDER BY role, name LIMIT 200',
              )
              .all(brandId)
              .map(a => ({ id: a.id, name: a.name, kind: a.kind, role: a.role, members: a.member_count }))
          : [],
        courses: repo.courses(brandId).map(c => ({ id: c.id, title: c.title, editions: json(c.editions) })),
        settings: settings(brandId),
        whatsappLive: services.connectors.metaLive(),
        automationOn: services.automation.enabledFor(brandId),
        canSend: access.can(user, 'campaigns.send', brandId),
        admin: user.role === 'admin',
      };
    }
    function recipients(user, id, url) {
      const c = getCampaign(user, id);
      const state = url.searchParams.get('state') || null;
      if (state && !RECIPIENT_STATES[state]) throw fail(400, 'Estado no válido.', { field: 'state' });
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const page = repo.recipientsPage(c.id, { state, limit, offset });
      const full = access.can(user, 'contacts.phone', c.brand_id);
      return {
        total: page.total,
        recipients: page.rows.map(r => ({
          id: r.id,
          contactId: r.contact_id,
          name: r.contact_name,
          // sin teléfono: «Número oculto» y los cuatro últimos del identificador de usuario, nunca el identificador
          phone: r.wa_to
            ? full
              ? '+' + r.wa_to
              : maskDigits(r.wa_to)
            : r.wa_recipient
              ? 'Número oculto ··' + String(r.wa_recipient).slice(-4)
              : full
                ? ''
                : maskDigits(r.wa_to),
          state: r.state,
          stateLabel: RECIPIENT_STATES[r.state] ?? r.state,
          reason: r.skip_reason,
          reasonLabel: r.skip_reason ? (SKIP_REASONS[r.skip_reason] ?? r.skip_reason) : null,
          failCode: r.fail_code,
          failReason: r.fail_reason,
          sentAt: r.sent_at,
          deliveredAt: r.delivered_at,
          readAt: r.read_at,
          repliedAt: r.replied_at,
          clickLabel: r.click_label,
          conversationId: r.conversation_id,
          rendered: r.rendered,
          nextAt: r.state === 'deferred' || r.state === 'queued' ? r.next_at : null,
        })),
        reasons: repo
          .reasons(c.id)
          .map(x => ({ reason: x.reason, label: SKIP_REASONS[x.reason] ?? x.reason, count: x.n })),
        failures: repo
          .failures(c.id)
          .map(x => ({ code: x.code, kind: x.kind, label: x.reason || FAIL_KINDS[x.kind] || 'Fallido', count: x.n })),
      };
    }
    function setSettings(brandId, input, user) {
      host.requireAdmin(user);
      if (!repo.brand(brandId)) throw fail(404, 'Marca no encontrada.');
      const cur = settings(brandId);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== cur.revision)
        throw fail(409, 'Los ajustes cambiaron. Recárgalos.', { code: 'stale_record' });
      const int = (value, min, max, field, label) => {
        if (value === undefined) return null;
        const n = Number(value);
        if (!Number.isInteger(n) || n < min || n > max)
          throw fail(400, `${label}: de ${min} a ${max}.`, { field, code: 'invalid_input' });
        return n;
      };
      const clock = (value, field) => {
        if (value === undefined) return null;
        if (!isClock(value)) throw fail(400, 'La hora va como HH:MM.', { field, code: 'invalid_input' });
        return value;
      };
      const next = {
        rate: int(input.ratePerMinute, 6, 600, 'ratePerMinute', 'Ritmo por minuto') ?? cur.ratePerMinute,
        cap: int(input.dailyCap, 1, 100_000, 'dailyCap', 'Tope diario') ?? cur.dailyCap,
        qs: clock(input.quietStart, 'quietStart') ?? cur.quietStart,
        qe: clock(input.quietEnd, 'quietEnd') ?? cur.quietEnd,
        budget: int(input.monthlyBudgetCents, 0, 1e10, 'monthlyBudgetCents', 'Presupuesto') ?? cur.monthlyBudgetCents,
        pct: int(input.failStopPct, 10, 100, 'failStopPct', 'Porcentaje de fallos') ?? cur.failStopPct,
      };
      repo.upsertSettings(brandId, next.rate, next.cap, next.qs, next.qe, next.budget, next.pct, user.id, now());
      host.audit(user, 'broadcast.settings', brandId);
      return { settings: settings(brandId) };
    }

    async function handle(req, res, path, user, url) {
      host.requireStaff(user);
      access.require(user, 'campaigns.view'); // 403 a quien no ve difusiones en ninguna marca; 404 lo de otra marca
      const send = (status, value) => (host.json(res, status, value), true);
      if (path === PREFIX && req.method === 'GET') return send(200, list(user, url));
      if (path === PREFIX && req.method === 'POST') {
        const out = create(await host.body(req), user);
        return send(out.duplicate ? 200 : 201, { campaign: out.campaign });
      }
      if (path === PREFIX + '/options' && req.method === 'GET')
        return send(200, options(user, url.searchParams.get('brand') || ''));
      if (path === PREFIX + '/settings' && req.method === 'GET') {
        const brandId = url.searchParams.get('brand') || '';
        if (!repo.brand(brandId) || !access.can(user, 'campaigns.view', brandId))
          throw fail(404, 'Marca no encontrada.');
        return send(200, { settings: settings(brandId) });
      }
      const s = path.match(/^\/api\/broadcasts\/settings\/([a-z0-9-]{1,64})$/);
      if (s && req.method === 'PATCH') return send(200, setSettings(s[1], await host.body(req), user));
      const m = path.match(/^\/api\/broadcasts\/([a-zA-Z0-9-]{8,64})(?:\/([a-z]+))?$/);
      if (!m) throw fail(404, 'Ruta de difusiones no encontrada.', { code: 'not_found' });
      const [, id, action] = m;
      if (!action && req.method === 'GET') return send(200, { campaign: view(getCampaign(user, id)) });
      if (!action && req.method === 'PATCH') return send(200, update(id, await host.body(req), user));
      if (action === 'recipients' && req.method === 'GET') return send(200, recipients(user, id, url));
      if (action === 'events' && req.method === 'GET') {
        const c = getCampaign(user, id);
        return send(200, {
          events: repo
            .events(c.id)
            .map(e => ({ kind: e.kind, details: json(e.details), at: e.created_at, actor: e.actor_name })),
        });
      }
      if (req.method === 'POST') {
        const input = await host.body(req);
        if (action === 'preview') {
          host.rate(`broadcasts.preview:${user.id}`, 30);
          return send(200, { preview: preview(getCampaign(user, id), user) });
        }
        if (action === 'schedule') return send(200, schedule(id, input, user));
        if (action === 'unschedule') return send(200, unschedule(id, input, user));
        if (action === 'pause') return send(200, pause(id, input, user));
        if (action === 'resume') return send(200, resume(id, input, user));
        if (action === 'cancel') return send(200, cancel(id, input, user));
      }
      throw fail(404, 'Ruta de difusiones no encontrada.', { code: 'not_found' });
    }

    const api = { handle, tick, applyStatus, attribute, adopt, courseOf, onReply, sendOne, sendStatus, gate };
    services.whatsapp?.useBroadcasts?.(api); // el entrante de WhatsApp pregunta aquí si responde a una difusión
    return api;
  },
  timers: [{ name: 'emisor', everyMs: 1000, testEveryMs: 100, run: api => api.tick() }],
};
