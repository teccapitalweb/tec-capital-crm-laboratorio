// Salud del canal de WhatsApp (X3 «Salud», docs/PLAN_SALUD_NUMERO.md; conciliación, filas 39 y 40).
//
// Estado, calidad y nombre visible de cada número (channel_health) y lo de la cuenta de WhatsApp Business: límite
// diario, revisión, verificación del negocio, pago y restricciones (wa_account). Se alimenta de dos fuentes:
//   - la consulta a Meta (refresh), SIEMPRE fuera de toda transacción: la hace el reloj (cada 15 min los números con
//     una difusión en curso, cada 6 h el resto, y cuanto antes —con un mínimo entre consultas— si un aviso lo pidió) o
//     administración con «Consultar ahora»;
//   - los avisos de Meta normalizados por el contrato de canal (connectors.on('account.update')): se aplica lo que el
//     aviso dice con claridad (calidad marcada, límite, restricción, revisión) y se pide una relectura, así una forma
//     distinta del aviso no rompe nada.
//
// Para otros módulos (host.module('channel-health')), en especial el motor de difusiones:
//   limitsOf(accountRef)          → {limit, used, remaining, tier, unlimited, estimated, source}
//   canSend(accountRef, category) → {ok, reason?, message?, warning?}
// accountRef es 'wa:' + phone_number_id. Sin datos todavía se deja enviar con el tope más bajo de Meta (250 personas
// en 24 h); sin WhatsApp real (CHANNEL_CONNECTOR distinto de «meta») el módulo está apagado: no consulta, no aplica
// avisos y no frena al laboratorio.
//
// Rutas (con sesión; server/index.mjs las encamina aquí antes que server/whatsapp.mjs):
//   GET  /api/whatsapp/health            números de las marcas de la persona; con channels.whatsapp.connect, el
//                                        detalle y el historial; la cuenta, sólo con el permiso en TODAS las marcas
//   POST /api/whatsapp/health/refresh    {accountRef?} consultar ahora (6 por minuto); sin accountRef, todo (cuenta entera)
// Nunca devuelve tokens ni el identificador de la cuenta.
import { randomUUID } from 'node:crypto';
import { createRepo } from './repo.mjs';

const PERM = 'channels.whatsapp.connect';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BUSY_EVERY = 15 * MINUTE; // números con una difusión en curso
const IDLE_EVERY = 6 * HOUR; // el resto
const MIN_GAP = MINUTE; // mínimo entre dos consultas de un mismo número pedidas por avisos
const MANUAL_GAP = 10_000; // «Consultar ahora» dentro de este plazo devuelve lo recién leído
const PER_PASS = 5; // números por pasada del reloj
const DEFAULT_LIMIT = 250; // sin dato de Meta: el nivel más bajo
const USED_CACHE_MS = 5_000;
const HISTORY = 50;
const CATEGORIES = ['marketing', 'utility', 'authentication', 'service'];

const QUALITY = { green: 'green', high: 'green', yellow: 'yellow', medium: 'yellow', red: 'red', low: 'red' };
const QUALITY_LABEL = { green: 'Alta', yellow: 'Media', red: 'Baja', unknown: 'Sin dato' };
const QUALITY_RANK = { green: 3, yellow: 2, red: 1 };
const STATUS_LABEL = {
  connected: 'Conectado',
  pending: 'Pendiente',
  flagged: 'Marcado por calidad',
  restricted: 'Restringido',
  banned: 'Bloqueado',
  offline: 'Sin conexión',
  unknown: 'Sin dato',
};
const BLOCKING = {
  pending: 'number_pending',
  offline: 'number_offline',
  restricted: 'number_restricted',
  banned: 'number_banned',
};
const REASONS = {
  invalid_category: 'Categoría de mensaje no válida.',
  unknown_number: 'Ese número no está dado de alta en el CRM.',
  number_disabled: 'El número está apagado en el CRM.',
  number_pending: 'El número todavía no está registrado en Meta.',
  number_offline: 'El número está desconectado en Meta.',
  number_restricted: 'Meta restringió el número: mientras dure, el CRM no envía nada por él.',
  number_banned: 'Meta bloqueó el número.',
  account_banned: 'Meta bloqueó la cuenta de WhatsApp Business.',
  account_restricted:
    'Meta restringió la cuenta de WhatsApp Business: no se pueden iniciar conversaciones hasta que termine la restricción.',
  account_review: 'La cuenta de WhatsApp Business está en revisión o Meta la rechazó.',
  payment_missing: 'Falta un método de pago válido en Meta.',
  quality_low: 'La calidad del número es baja: las difusiones de marketing se detienen para no empeorarla.',
  limit_reached: 'Se alcanzó el límite diario de personas a las que se puede escribir primero.',
};
const FIELD_LABEL = {
  status: 'Estado',
  quality: 'Calidad',
  name_status: 'Nombre visible',
  verified_name: 'Nombre',
  display: 'Número',
  official: 'Cuenta oficial',
  limit: 'Límite diario',
  review: 'Revisión de la cuenta',
  business_verification: 'Verificación del negocio',
  restriction: 'Restricción de la cuenta',
  payment: 'Método de pago',
  alert: 'Aviso de Meta',
};
// Cómo se lee cada valor en el historial.
const VALUE_LABEL = {
  quality: QUALITY_LABEL,
  status: STATUS_LABEL,
  name_status: { approved: 'aprobado', pending_review: 'en revisión', declined: 'rechazado', rejected: 'rechazado' },
  review: { approved: 'aprobada', pending: 'en revisión', deferred: 'en revisión', rejected: 'rechazada' },
  business_verification: {
    verified: 'verificado',
    pending: 'en revisión',
    rejected: 'rechazada',
    not_verified: 'sin verificar',
  },
  payment: { ok: 'correcto', missing: 'falta', problem: 'con problema', unknown: 'sin dato' },
};
const EVENT_TYPES = {
  'canal.calidad': {
    title: 'Cambió la calidad de un número de WhatsApp',
    entity: 'wa_number',
    payload: 'quality, previous',
  },
  'canal.estado': {
    title: 'Cambió el estado de un número de WhatsApp',
    entity: 'wa_number',
    payload: 'status, previous',
  },
  'canal.cuenta': {
    title: 'Cambió la cuenta de WhatsApp Business',
    entity: 'wa_number',
    payload: 'field, value, previous',
  },
};

const lower = v =>
  String(v ?? '')
    .trim()
    .toLowerCase();
const digits = v => String(v ?? '').replace(/\D/g, '');
const clip = (v, max) => String(v ?? '').slice(0, max);
export const qualityOf = v => QUALITY[lower(v)] ?? 'unknown';
export function statusOf(v) {
  const s = lower(v);
  if (!s) return 'unknown';
  if (s === 'connected') return 'connected';
  if (s === 'flagged') return 'flagged';
  if (/pending|unverified|not_verified/.test(s)) return 'pending';
  if (/restrict|rate_limited/.test(s)) return 'restricted';
  if (/ban|block/.test(s)) return 'banned';
  if (/disconnect|offline|delet|migrat|unavailable|remov/.test(s)) return 'offline';
  return 'unknown';
}
// TIER_250, TIER_2K, TIER_10K, TIER_100K, TIER_UNLIMITED (y el mismo texto en minúsculas de los avisos).
export function tierOf(raw) {
  const tier = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (!tier) return null;
  if (/UNLIMITED/.test(tier)) return { tier, value: null, unlimited: true };
  const m = tier.match(/(\d+(?:\.\d+)?)\s*(K|M)?/);
  if (!m) return null;
  const value = Math.round(Number(m[1]) * (m[2] === 'M' ? 1_000_000 : m[2] === 'K' ? 1000 : 1));
  return value > 0 ? { tier, value, unlimited: false } : null;
}
function when(at, timeZone) {
  try {
    return new Date(at).toLocaleString('es-MX', { timeZone });
  } catch {
    return new Date(at).toISOString();
  }
}
const refOf = id => 'wa:' + id;
const idOf = ref => {
  const m = String(ref ?? '').match(/^(?:wa:)?(\d{5,30})$/);
  return m ? m[1] : null;
};
// Instante de fin de una restricción en un aviso (restriction_info: [{restriction_type, expiration}], en segundos).
function untilOf(details) {
  try {
    const info = JSON.parse(details?.restriction || 'null');
    const list = Array.isArray(info) ? info : info ? [info] : [];
    const ends = list.map(r => Number(r?.expiration)).filter(n => n > 0);
    return ends.length ? Math.max(...ends) * 1000 : null;
  } catch {
    return null;
  }
}

export default {
  name: 'channel-health',
  create(host) {
    const { db, fail, json, body, rate } = host;
    const { connectors, events } = host.services;
    const repo = createRepo(db);
    const env = process.env;
    const now = () => Date.now();
    const test = env.NODE_ENV === 'test';
    // En las pruebas el mínimo entre consultas se puede acortar (nunca en producción).
    const minGap = test && Number(env.CHANNEL_HEALTH_MIN_GAP_MS) > 0 ? Number(env.CHANNEL_HEALTH_MIN_GAP_MS) : MIN_GAP;
    const manualGap = Math.min(MANUAL_GAP, minGap);
    const live = () => connectors.metaLive();
    const adapter = () => connectors.adapters.channel.meta;
    const wabaKey = () => String(env.META_WABA_ID || '').trim() || 'local';
    const accountRef = () => 'waba:' + wabaKey();
    const atomic = fn => (db.isTransaction ? fn() : host.transaction(db, fn));
    const inflight = new Map();
    let ticking = false;
    let usedCache = null;

    events.registerTypes(EVENT_TYPES, { entities: { wa_number: 'Número de WhatsApp' } });

    function account() {
      const key = wabaKey();
      let row = repo.account(key);
      if (!row) {
        repo.createAccount(key, now(), now());
        row = repo.account(key);
      }
      return row;
    }
    const brandsWithNumbers = () => [...new Set(repo.numbers().map(n => n.brand_id))];
    const labelOf = n => n?.label || 'Número ' + String(n?.phone_number_id || '').slice(-4);

    // ---- avisos al equipo: notificación a quien administra los números de esa marca, evento de dominio y tiempo real
    function tell(brandIds, title, key) {
      const t = now();
      for (const user of repo.staff())
        for (const brandId of brandIds)
          if (host.access.can(user, PERM, brandId))
            repo.notify(randomUUID(), user.id, brandId, 'channel_health', title.slice(0, 200), key.slice(0, 200), t);
    }
    function publish(type, brandId, entityId, payload, key) {
      try {
        events.publish({
          type,
          brandId,
          entityKind: 'wa_number',
          entityId,
          payload,
          source: 'channel-health',
          dedupeKey: key.slice(0, 200),
        });
      } catch {
        // un evento que no se puede publicar no deshace el cambio de salud
      }
    }
    function emit(brandIds, data = {}) {
      for (const brandId of brandIds)
        try {
          host.realtime.emit('channel_health.changed', { brandId, data });
        } catch {
          // el aviso en vivo es una cortesía
        }
    }
    const record = (ref, brandId, field, old, next, source, at) => {
      const a = old === null || old === undefined ? '' : String(old);
      const b = next === null || next === undefined ? '' : String(next);
      if (a === b) return false;
      repo.addEvent(ref, brandId, field, a || null, b || null, source, at);
      return true;
    };

    // ---- cambios de un número: historial, avisos y eventos (dentro de la transacción de quien llama)
    function numberChanges(n, before, next, source, at) {
      const ref = refOf(n.phone_number_id),
        brand = n.brand_id,
        label = labelOf(n);
      // la primera lectura del número y el nombre no es un cambio: sólo se anota cuando Meta los cambia
      for (const field of ['display', 'verified_name', 'official'])
        if (next[field] !== undefined && before[field] !== null && before[field] !== '')
          record(ref, brand, field, before[field], next[field], source, at);
      if (record(ref, brand, 'name_status', before.name_status, next.name_status, source, at))
        if (/reject|declin/.test(next.name_status))
          tell([brand], `Meta rechazó el nombre visible de ${label}.`, `ch:${ref}:name:${next.name_status}:${at}`);
      if (record(ref, brand, 'quality', before.quality, next.quality, source, at)) {
        const was = QUALITY_RANK[before.quality],
          is = QUALITY_RANK[next.quality];
        if (was && is && is < was)
          tell(
            [brand],
            `Bajó la calidad de ${label}: ${QUALITY_LABEL[before.quality]} → ${QUALITY_LABEL[next.quality]}.`,
            `ch:${ref}:quality:${next.quality}:${at}`,
          );
        publish(
          'canal.calidad',
          brand,
          n.phone_number_id,
          { quality: next.quality, previous: before.quality },
          ['canal.calidad', ref, next.quality, at].join(':'),
        );
      }
      if (record(ref, brand, 'status', before.status, next.status, source, at)) {
        const bad = s => Boolean(BLOCKING[s]) || s === 'flagged';
        if (bad(next.status))
          tell(
            [brand],
            `${label}: ${STATUS_LABEL[next.status]}. ${REASONS[BLOCKING[next.status]] || 'Meta marcó el número por su calidad.'}`,
            `ch:${ref}:status:${next.status}:${at}`,
          );
        else if (next.status === 'connected' && bad(before.status))
          tell([brand], `${label} volvió a estar conectado.`, `ch:${ref}:status:connected:${at}`);
        publish(
          'canal.estado',
          brand,
          n.phone_number_id,
          { status: next.status, previous: before.status },
          ['canal.estado', ref, next.status, at].join(':'),
        );
      }
    }
    // ---- cambios de la cuenta: historial (marca '*'), avisos a cada marca con números y evento por marca
    function accountChange(field, old, next, source, at, { notice = null } = {}) {
      if (!record(accountRef(), '*', field, old, next, source, at)) return false;
      const brands = brandsWithNumbers();
      if (notice) tell(brands, notice, `ch:account:${field}:${next ?? ''}:${at}`);
      for (const brand of brands)
        publish(
          'canal.cuenta',
          brand,
          'account',
          { field, value: next ?? null, previous: old ?? null },
          ['canal.cuenta', brand, field, next ?? '', at].join(':'),
        );
      return true;
    }
    function limitChange(raw, source, at) {
      const tier = tierOf(raw);
      if (!tier) return false;
      const acc = account();
      if (acc.limit_source === 'manual') return false;
      const old = acc.messaging_limit;
      repo.setLimit(tier.tier, tier.value, at, wabaKey());
      const known = tierOf(old);
      const text = t => (t ? (t.unlimited ? 'sin límite' : t.value.toLocaleString('es-MX')) : 'sin dato');
      return accountChange('limit', old, tier.tier, source, at, {
        notice: known ? `Cambió el límite diario de WhatsApp: ${text(known)} → ${text(tier)} personas en 24 h.` : null,
      });
    }

    // ---- consulta a Meta (fuera de toda transacción)
    const outside = () => {
      if (db.isTransaction) throw new Error('La salud del canal no consulta a Meta dentro de una transacción.');
    };
    async function refreshNumber(id, { manual = false } = {}) {
      outside();
      const n = repo.number(id);
      if (!n) throw fail(404, 'Ese número no está dado de alta en el CRM.', { code: 'not_found' });
      const ref = refOf(id);
      repo.ensureHealth(ref, n.brand_id, id, now(), now());
      const last = repo.health(ref)?.checked_at;
      if (manual && last && now() - last < manualGap) return false;
      if (inflight.has(id)) return inflight.get(id);
      const job = (async () => {
        const started = now(); // un aviso que llegue durante la consulta vuelve a pedir otra
        let info;
        try {
          info = await adapter().numberInfo(id);
        } catch (e) {
          const t = now();
          repo.setHealthError(t, clip(e?.message || 'No se pudo consultar a Meta.', 300), started, t, ref);
          emit([n.brand_id], { accountRef: ref });
          return true;
        }
        outside();
        const t = now();
        atomic(() => {
          const before = repo.health(ref);
          const current = repo.number(id) || n;
          const next = {
            display: clip(info.displayPhone, 40) || before.display,
            verified_name: clip(info.verifiedName, 160) || before.verified_name,
            name_status: info.nameStatus ? lower(info.nameStatus).slice(0, 40) : before.name_status,
            quality: info.quality ? qualityOf(info.quality) : before.quality,
            // sin el campo de estado: si Meta respondió, el número está conectado salvo que un aviso diga otra cosa
            status: info.status ? statusOf(info.status) : before.status === 'unknown' ? 'connected' : before.status,
            official: info.official === null || info.official === undefined ? before.official : info.official ? 1 : 0,
          };
          numberChanges(current, before, next, 'poll', t);
          repo.saveHealth(
            current.brand_id,
            next.display,
            next.verified_name,
            next.name_status,
            next.status,
            next.quality,
            next.official,
            t,
            '',
            started,
            t,
            ref,
          );
          if (info.limitTier) limitChange(info.limitTier, 'poll', t);
        });
        emit([n.brand_id], { accountRef: ref });
        return true;
      })().finally(() => inflight.delete(id));
      inflight.set(id, job);
      return job;
    }
    async function refreshAccount() {
      outside();
      const key = wabaKey();
      account();
      const started = now();
      let info;
      try {
        info = await adapter().accountInfo();
      } catch (e) {
        const t = now();
        repo.setAccountError(t, clip(e?.message || 'No se pudo consultar a Meta.', 300), started, t, key);
        return;
      }
      outside();
      const t = now();
      atomic(() => {
        const acc = account();
        const review = info?.reviewStatus ? lower(info.reviewStatus).slice(0, 40) : acc.review_status;
        const verification = info?.businessVerification
          ? lower(info.businessVerification).slice(0, 40)
          : acc.business_verification;
        accountChange('review', acc.review_status, review, 'poll', t, {
          notice:
            acc.review_status && review && review !== 'approved'
              ? 'Meta cambió la revisión de la cuenta de WhatsApp Business: ' + review + '.'
              : null,
        });
        accountChange('business_verification', acc.business_verification, verification, 'poll', t);
        repo.saveAccountRead(review ?? null, verification ?? null, t, '', started, t, key);
      });
      emit(brandsWithNumbers());
    }
    // Consulta un número ('wa:<id>') o, sin referencia, todos y la cuenta.
    async function refresh(ref, { manual = false } = {}) {
      if (ref !== undefined && ref !== null && ref !== '') {
        const id = idOf(ref);
        if (!id) throw fail(400, 'Referencia de número no válida.', { code: 'invalid_account_ref' });
        return refreshNumber(id, { manual });
      }
      for (const n of repo.numbers()) await refreshNumber(n.phone_number_id, { manual });
      const acc = account();
      if (!manual || !acc.health_checked_at || now() - acc.health_checked_at >= manualGap) await refreshAccount();
      return true;
    }

    // ---- reloj: no se pisa a sí mismo, nunca dentro de una transacción, con tope de números por pasada
    async function tick() {
      if (!live() || ticking || db.isTransaction) return;
      ticking = true;
      try {
        const t = now();
        const busy = new Set(repo.busyNumbers().map(r => r.wa_number));
        const health = new Map(repo.healthAll().map(h => [h.phone_number_id, h]));
        const due = repo.numbers().filter(n => {
          const h = health.get(n.phone_number_id);
          const last = h?.checked_at;
          if (!last) return true;
          if (t - last >= (busy.has(n.phone_number_id) ? BUSY_EVERY : IDLE_EVERY)) return true;
          return Boolean(h.refresh_due) && t - last >= minGap;
        });
        for (const n of due.slice(0, PER_PASS)) await refreshNumber(n.phone_number_id);
        const acc = account();
        const last = acc.health_checked_at;
        if (due.length || repo.numbers().length)
          if (!last || t - last >= IDLE_EVERY || (acc.health_due && t - last >= minGap)) await refreshAccount();
        // una restricción de la cuenta con fecha de fin termina sola
        const after = account();
        if (after.restriction && after.restricted_until && after.restricted_until <= now()) {
          const at = now();
          atomic(() => {
            repo.setRestriction(null, null, at, wabaKey());
            accountChange('restriction', after.restriction, null, 'poll', at, {
              notice: 'Terminó la restricción de la cuenta de WhatsApp Business.',
            });
          });
          emit(brandsWithNumbers());
        }
      } finally {
        ticking = false;
      }
    }

    // ---- avisos de Meta (oyente síncrono del contrato de canal; corre dentro de la transacción del procesador)
    function locate(data) {
      const id = digits(data?.account?.externalId);
      if (id && repo.number(id)) return repo.number(id);
      const phone = digits(data?.details?.displayPhone);
      if (!phone) return null;
      const h = repo.healthAll().find(r => r.display && digits(r.display) === phone);
      return h ? repo.number(h.phone_number_id) : null;
    }
    function applyUpdate(data) {
      if (!live() || !data || typeof data !== 'object') return null;
      const field = lower(data.field),
        value = lower(data.value),
        details = data.details && typeof data.details === 'object' ? data.details : {};
      const n = locate(data);
      const t = now();
      let note = null;
      atomic(() => {
        if (n) {
          const ref = refOf(n.phone_number_id);
          repo.ensureHealth(ref, n.brand_id, n.phone_number_id, t, t);
          const before = repo.health(ref);
          const next = { status: before.status, quality: before.quality, name_status: before.name_status };
          if (field === 'quality') {
            if (value === 'flagged') Object.assign(next, { quality: 'red', status: 'flagged' });
            else if (value === 'unflagged') next.status = before.status === 'flagged' ? 'connected' : before.status;
            else if (QUALITY[value]) next.quality = QUALITY[value];
          } else if (field === 'name' && value) next.name_status = value.slice(0, 40);
          else if (field === 'status' && value) {
            if (/reinstat|enable|unban|connected/.test(value)) next.status = 'connected';
            else if (statusOf(value) !== 'unknown') next.status = statusOf(value);
          } else if (field === 'restriction' && details.displayPhone) next.status = 'restricted';
          numberChanges(n, before, next, 'webhook', t);
          repo.noteHealth(next.status, next.quality, next.name_status, t, t, t, ref);
          note = `salud: ${labelOf(n)} ${field} ${value}`.trim();
        }
        // lo que es de la cuenta (y pide releerla)
        const acc = account();
        if (field === 'limit' || field === 'capability') {
          const raw = field === 'limit' ? value : details.maxDailyConversationsPerBusiness;
          limitChange(raw, 'webhook', t);
        } else if (field === 'review' && value) {
          if (/verified/.test(value)) {
            repo.setVerification('verified', t, wabaKey());
            accountChange('business_verification', acc.business_verification, 'verified', 'webhook', t);
          } else {
            repo.setReview(value.slice(0, 40), t, wabaKey());
            accountChange('review', acc.review_status, value.slice(0, 40), 'webhook', t, {
              notice:
                value === 'approved'
                  ? null
                  : 'Meta cambió la revisión de la cuenta de WhatsApp Business: ' + value + '.',
            });
          }
        } else if (field === 'restriction' && !n) {
          const until = untilOf(details);
          repo.setRestriction(value.slice(0, 60) || 'restricted', until, t, wabaKey());
          accountChange('restriction', acc.restriction, value.slice(0, 60) || 'restricted', 'webhook', t, {
            notice:
              'Meta restringió la cuenta de WhatsApp Business' +
              (until ? ' hasta el ' + when(until, acc.timezone) : '') +
              ': no se pueden iniciar conversaciones.',
          });
        } else if (field === 'status' && !n && value) {
          if (/ban|disabled/.test(value)) {
            repo.setRestriction('banned', null, t, wabaKey());
            accountChange('restriction', acc.restriction, 'banned', 'webhook', t, {
              notice: 'Meta bloqueó la cuenta de WhatsApp Business.',
            });
          } else if (/reinstat|enable|unban/.test(value) && acc.restriction) {
            repo.setRestriction(null, null, t, wabaKey());
            accountChange('restriction', acc.restriction, null, 'webhook', t, {
              notice: 'Meta levantó la restricción de la cuenta de WhatsApp Business.',
            });
          } else record(accountRef(), '*', 'status', null, value.slice(0, 60), 'webhook', t);
        } else if (field === 'alert') {
          const text = clip(details.description || value || 'aviso sin descripción', 160);
          accountChange('alert', null, text, 'webhook', t, { notice: 'Aviso de Meta sobre WhatsApp: ' + text });
        }
        if (!n || field === 'limit' || field === 'capability') repo.accountWebhook(t, t, t, wabaKey());
      });
      emit(n ? [n.brand_id] : brandsWithNumbers(), n ? { accountRef: refOf(n.phone_number_id) } : {});
      return note || `salud: cuenta ${field} ${value}`.trim();
    }
    connectors.on('account.update', applyUpdate, { order: 100, name: 'salud' });
    // Un rechazo 131042 es un problema con el método de pago de la cuenta (sin él, Meta deja de entregar al agotar
    // los mensajes de servicio gratis del mes). Un mensaje cobrable entregado después demuestra que ya se resolvió.
    connectors.on(
      'message.status',
      data => {
        if (!live() || !data) return null;
        const paid = Number(data.code) === 131042;
        const billed = ['delivered', 'read'].includes(data.state) && data.pricing?.billable === true;
        if (!paid && !billed) return null;
        const acc = account();
        const next = paid ? 'missing' : 'ok';
        if (acc.payment_status === next || (billed && !['missing', 'problem'].includes(acc.payment_status)))
          return null;
        const t = now();
        atomic(() => {
          repo.setPayment(
            next,
            paid ? 'Meta rechazó un envío por el método de pago (131042).' : 'Meta entregó un mensaje cobrable.',
            t,
            t,
            wabaKey(),
          );
          accountChange('payment', acc.payment_status, next, 'webhook', t, {
            notice: paid
              ? 'Meta rechazó un envío porque falta un método de pago válido en la cuenta de WhatsApp Business.'
              : 'El método de pago de la cuenta de WhatsApp Business vuelve a funcionar.',
          });
        });
        return paid ? 'salud: falta método de pago' : 'salud: método de pago correcto';
      },
      { order: 400, name: 'salud' },
    );

    // ---- límite diario y si se puede enviar
    function usedLast24h() {
      const t = now();
      if (usedCache && t - usedCache.at < USED_CACHE_MS) return usedCache.n;
      const n = repo.usedSince(t - DAY).n;
      usedCache = { at: t, n };
      return n;
    }
    function accountLimits() {
      const used = usedLast24h();
      if (!live())
        return { limit: null, used, remaining: null, tier: '', unlimited: true, estimated: true, source: 'simulated' };
      const acc = account();
      const tier = tierOf(acc.messaging_limit);
      if (!tier)
        return {
          limit: DEFAULT_LIMIT,
          used,
          remaining: Math.max(0, DEFAULT_LIMIT - used),
          tier: '',
          unlimited: false,
          estimated: true,
          source: 'default',
        };
      const source = acc.limit_source || 'meta';
      if (tier.unlimited)
        return { limit: null, used, remaining: null, tier: tier.tier, unlimited: true, estimated: true, source };
      const limit = Number(acc.limit_value) > 0 ? Number(acc.limit_value) : tier.value;
      return {
        limit,
        used,
        remaining: Math.max(0, limit - used),
        tier: tier.tier,
        unlimited: false,
        estimated: true,
        source,
      };
    }
    function limitsOf(ref) {
      const id = idOf(ref);
      if (!id || !repo.number(id))
        return {
          limit: 0,
          used: 0,
          remaining: 0,
          tier: '',
          unlimited: false,
          estimated: true,
          source: 'unknown_number',
        };
      return accountLimits();
    }
    const no = reason => ({ ok: false, reason, message: REASONS[reason] });
    function canSend(ref, category) {
      const cat = lower(category);
      if (!CATEGORIES.includes(cat)) return no('invalid_category');
      const id = idOf(ref);
      const n = id ? repo.number(id) : null;
      if (!n) return no('unknown_number');
      if (!n.enabled) return no('number_disabled');
      if (!live()) return { ok: true, warning: 'simulated' };
      const h = repo.health(refOf(id));
      const status = h?.status || 'unknown';
      if (BLOCKING[status]) return no(BLOCKING[status]);
      const acc = account();
      const restricted = acc.restriction && (!acc.restricted_until || acc.restricted_until > now());
      if (restricted && acc.restriction === 'banned') return no('account_banned');
      if (cat !== 'service') {
        if (restricted) return no('account_restricted');
        if (['rejected', 'pending', 'deferred'].includes(acc.review_status)) return no('account_review');
        if (['missing', 'problem'].includes(acc.payment_status)) return no('payment_missing');
        if (cat === 'marketing' && h?.quality === 'red') return no('quality_low');
        const lim = accountLimits();
        if (lim.remaining !== null && lim.remaining <= 0) return no('limit_reached');
      }
      if (!h?.checked_at && !h?.last_webhook_at) return { ok: true, warning: 'no_data' };
      if (h.quality === 'yellow') return { ok: true, warning: 'quality_medium' };
      return { ok: true };
    }

    // ---- vistas (sin tokens ni el identificador de la cuenta)
    function label(field, v) {
      if (v === null || v === undefined || v === '') return field === 'restriction' ? 'sin restricción' : 'sin dato';
      if (field === 'limit') {
        const tier = tierOf(v);
        return !tier ? v : tier.unlimited ? 'sin límite' : tier.value.toLocaleString('es-MX') + ' personas';
      }
      if (field === 'official') return v === '1' ? 'sí' : 'no';
      if (field === 'restriction') return v === 'banned' ? 'bloqueada' : 'restringida';
      return VALUE_LABEL[field]?.[v] ?? v;
    }
    function numberView(n, { detail }) {
      const ref = refOf(n.phone_number_id);
      const h = repo.health(ref) || {};
      const quality = h.quality || 'unknown',
        status = h.status || 'unknown';
      return {
        accountRef: ref,
        brandId: n.brand_id,
        brandName: n.brand_name || n.brand_id,
        label: labelOf(n),
        enabled: Boolean(n.enabled),
        display: h.display || '',
        verifiedName: h.verified_name || '',
        nameStatus: h.name_status || '',
        status,
        statusLabel: STATUS_LABEL[status] || status,
        quality,
        qualityLabel: QUALITY_LABEL[quality] || quality,
        official: h.official === null || h.official === undefined ? null : Boolean(h.official),
        checkedAt: h.checked_at ?? null,
        lastWebhookAt: h.last_webhook_at ?? null,
        ...(detail ? { error: h.error || '' } : {}),
        limit: limitsOf(ref),
        sending: Object.fromEntries(CATEGORIES.map(c => [c, canSend(ref, c)])),
      };
    }
    function accountView() {
      const acc = account();
      const restricted = Boolean(acc.restriction && (!acc.restricted_until || acc.restricted_until > now()));
      return {
        reviewStatus: acc.review_status || '',
        businessVerification: acc.business_verification || '',
        paymentStatus: acc.payment_status || 'unknown',
        restriction: restricted ? acc.restriction : '',
        restrictedUntil: restricted ? (acc.restricted_until ?? null) : null,
        limit: accountLimits(),
        checkedAt: acc.health_checked_at ?? null,
        lastWebhookAt: acc.last_webhook_at ?? null,
        error: acc.health_error || '',
      };
    }
    function historyView(brandIds, withAccount) {
      const names = new Map(repo.numbers().map(n => [refOf(n.phone_number_id), labelOf(n)]));
      return repo.events(brandIds, withAccount, HISTORY).map(e => {
        const scope = e.brand_id === '*' ? 'account' : 'number';
        return {
          seq: e.seq,
          scope,
          accountRef: scope === 'number' ? e.account_ref : null,
          brandId: scope === 'number' ? e.brand_id : null,
          subject:
            scope === 'number' ? names.get(e.account_ref) || 'Número dado de baja' : 'Cuenta de WhatsApp Business',
          field: e.field,
          text: `${FIELD_LABEL[e.field] || e.field}: ${label(e.field, e.old_value)} → ${label(e.field, e.new_value)}`,
          source: e.source,
          createdAt: e.created_at,
        };
      });
    }
    // ¿Tiene el permiso en TODAS las marcas? Lo de la cuenta es de la instalación entera, no de una marca.
    const accountWide = user =>
      host.access.can(user, PERM) && repo.brandIds().every(b => host.access.can(user, PERM, b.id));
    function summary(user) {
      const detailBrands = host.access.brandIds(user, PERM);
      const detail = detailBrands.length > 0;
      const brands = new Set(detail ? detailBrands : host.access.brandIds(user));
      const wide = detail && accountWide(user);
      return {
        live: live(),
        canRefresh: detail && live(),
        minRefreshMs: manualGap,
        numbers: repo
          .numbers()
          .filter(n => brands.has(n.brand_id))
          .map(n => numberView(n, { detail })),
        account: wide ? accountView() : null,
        history: detail ? historyView([...brands], wide) : [],
      };
    }
    // Lo que alimentará GET /api/v1/numbers (diseño de identidad y API, §4.10): los números de esas marcas.
    function numbersFor(brandIds) {
      const brands = new Set(brandIds);
      return repo
        .numbers()
        .filter(n => brands.has(n.brand_id))
        .map(n => {
          const v = numberView(n, { detail: false });
          return {
            ref: v.accountRef,
            label: v.label,
            displayPhone: v.display,
            status: v.status,
            quality: v.quality,
            nameStatus: v.nameStatus,
            verifiedName: v.verifiedName,
            limit: v.limit,
            checkedAt: v.checkedAt,
          };
        });
    }

    async function handle(req, res, path, user) {
      if (path === '/api/whatsapp/health' && req.method === 'GET') {
        host.requireStaff(user);
        json(res, 200, summary(user));
        return true;
      }
      if (path === '/api/whatsapp/health/refresh' && req.method === 'POST') {
        host.access.require(user, PERM);
        const input = await body(req);
        const ref = input?.accountRef;
        if (ref) {
          const n = repo.number(idOf(ref) || '');
          if (!n) throw fail(404, 'Ese número no está dado de alta en el CRM.', { code: 'not_found' });
          host.access.require(user, PERM, n.brand_id);
        } else for (const b of repo.brandIds()) host.access.require(user, PERM, b.id);
        if (!live())
          throw fail(409, 'WhatsApp real no está conectado: no hay nada que consultar a Meta.', {
            code: 'channel_off',
          });
        rate('wa-health:' + user.id, 6);
        await refresh(ref || null, { manual: true });
        json(res, 200, summary(user));
        return true;
      }
      if (path === '/api/whatsapp/health' || path.startsWith('/api/whatsapp/health/'))
        throw fail(404, 'Ruta de salud del canal no encontrada.', { code: 'not_found' });
      return false;
    }

    return { handle, tick, refresh, applyUpdate, limitsOf, canSend, summary, numbersFor };
  },
  timers: [{ name: 'consulta', everyMs: MINUTE, testEveryMs: 200, run: api => api.tick() }],
};
