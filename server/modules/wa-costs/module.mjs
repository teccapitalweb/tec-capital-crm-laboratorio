// Motor de costo de WhatsApp (docs/PLAN_CIMIENTOS_DIFUSIONES.md §4; conciliación, fila 40: un solo motor).
//
//   - Tarifas y reglas de Meta fechadas, en tablas que edita administración (wa_rates, wa_pricing_rules). Las de
//     ejemplo son orientativas (verified=0): el código no trae ninguna cifra comercial.
//   - Libro de costos (wa_message_costs): una fila por mensaje real que Meta informó, alimentada por los estados con
//     su `pricing` (oyente de connectors.on('message.status'), después de difusiones). Sin importes: el costo se
//     calcula al consultar con la tarifa vigente, así una tarifa corregida corrige los totales.
//   - Medidores: mensajes de servicio gratis por número y mes (en la zona de la cuenta), gasto por categoría, por
//     número y por marca.
//
// Rutas (con sesión, bajo /api/wa-costs):
//   GET  /api/wa-costs/meter?brand=all|<marca>&month=AAAA-MM    medidor (permiso settings.costs en esas marcas)
//   GET  /api/wa-costs/rates                                     tarifas y reglas (settings.costs)
//   POST /api/wa-costs/rates  {market,category,rateMicros,effectiveFrom,verified,source}   nueva fila (administración)
//   POST /api/wa-costs/rules  {effectiveFrom,freeServicePerNumber,…}                       nueva regla (administración)
// Nunca se edita ni se borra una fila pasada: una corrección es una fila nueva con su fecha de vigencia. Repetir la
// misma alta no duplica (clave: mercado, categoría y vigencia); con otros valores responde 409.
//
// Para otros módulos (host.module('wa-costs')): rules, rateFor, estimate, record, meter, freeEntry, monthSpend.
import { randomUUID } from 'node:crypto';
import { parseRates } from '../../presentation.mjs';
import { createRepo } from './repo.mjs';
import {
  CATEGORIES,
  amountOf,
  isCategory,
  marketOf,
  micros,
  money,
  monthOf,
  monthRange,
  splitGroup,
  validTimeZone,
} from './model.mjs';

const PREFIX = '/api/wa-costs';
const QUOTA_EVENT = 'whatsapp.cuota_servicio';
const QUOTA_STEPS = [80, 100];
const DAY = 86_400_000;
const MARKET = /^(\*|[A-Z]{2})$/;

export default {
  name: 'wa-costs',
  create(host) {
    const { db } = host;
    const repo = createRepo(db);
    const now = () => Date.now();
    const env = process.env;
    const { events, connectors } = host.services;

    events.registerTypes(
      {
        [QUOTA_EVENT]: {
          title: 'Mensajes de servicio gratis por agotarse',
          entity: 'wa_number',
          payload: 'phoneNumberId, month, threshold, used, free',
        },
      },
      { entities: { wa_number: 'Número de WhatsApp' } },
    );

    // ---- cuenta, reglas y tarifas
    const wabaId = () => String(env.META_WABA_ID || '').trim() || 'local';
    function account() {
      const id = wabaId();
      let row = repo.account(id);
      if (!row) {
        const t = now();
        repo.createAccount(id, t, t);
        row = repo.account(id);
      }
      return { ...row, timezone: validTimeZone(row.timezone) ? row.timezone : 'America/Mexico_City' };
    }
    const rules = (at = now()) => repo.rules(at) ?? null;
    // MESSAGE_RATES (laboratorio y demostraciones) sustituye la tarifa de «cualquier otro mercado» en sus tres
    // categorías, como antes; si no está definida, mandan las tablas.
    function rateFor(market, category, at = now()) {
      const row = repo.rate(market, category, at);
      if (env.MESSAGE_RATES && ['marketing', 'utility', 'service'].includes(category) && (!row || row.market === '*'))
        return {
          rateMicros: Math.round(parseRates(env.MESSAGE_RATES)[category] * 1e6),
          currency: 'MXN',
          verified: false,
          market: '*',
          from: null,
          source: 'MESSAGE_RATES',
        };
      return row
        ? {
            rateMicros: row.rate_micros,
            currency: row.currency,
            verified: Boolean(row.verified),
            market: row.market,
            from: row.effective_from,
            source: row.source,
          }
        : null;
    }

    // Estimación de una difusión antes de enviarla: {category, markets:{MX:5870,US:12}} → máximo si todo se entrega.
    function estimate({ category, markets = {}, at = now() } = {}) {
      if (!isCategory(category)) throw host.fail(400, 'Categoría no válida.', { code: 'invalid_category' });
      let total = 0,
        currency = 'MXN',
        unverified = false;
      const byMarket = [],
        missing = [];
      for (const [market, count] of Object.entries(markets)) {
        const n = Math.max(0, Math.floor(Number(count) || 0));
        const rate = rateFor(market, category, at);
        if (!rate) {
          missing.push(market);
          continue;
        }
        currency = rate.currency;
        unverified ||= !rate.verified;
        total += micros(rate.rateMicros, n);
        byMarket.push({ market, count: n, rateMicros: rate.rateMicros, verified: rate.verified, from: rate.from });
      }
      return {
        category,
        currency,
        max: { micros: total, amount: amountOf(total), label: money(total, currency) },
        byMarket,
        unverifiedRates: unverified,
        missingRates: missing,
      };
    }

    // ---- libro de costos: oyente del estado de Meta (síncrono, sin transacción propia ni red)
    function record(data) {
      const state = data?.state,
        ref = typeof data?.providerRef === 'string' ? data.providerRef.slice(0, 200) : '';
      if (!ref || !['sent', 'delivered', 'read'].includes(state)) return null;
      const t = Number(data.at) || now();
      const pricing = data.pricing && typeof data.pricing === 'object' ? data.pricing : {};
      const metaCategory = isCategory(pricing.category) ? pricing.category : null,
        priceType = typeof pricing.type === 'string' ? pricing.type.slice(0, 60) : null,
        billable = pricing.billable === true ? 1 : pricing.billable === false ? 0 : null,
        deliveredAt = state === 'sent' ? null : t;
      let row = repo.cost(ref);
      const before = row?.delivered_at ?? null;
      if (!row) {
        const chat = repo.chatOrigin(ref),
          campaign = chat ? null : repo.campaignOrigin(ref);
        if (!chat && !campaign) return null; // ni chat real ni difusión: no es un mensaje que Meta cobre a esta cuenta
        const crmCategory = isCategory(chat?.category) ? chat.category : campaign ? 'marketing' : 'service';
        repo.insertCost(
          ref,
          String(data.account?.externalId || chat?.wa_number || campaign?.wa_number || ''),
          chat?.brand_id ?? campaign.brand_id,
          marketOf(chat?.wa_peer ?? campaign?.wa_to ?? data.recipient?.phone),
          chat ? 'chat' : 'campaign',
          campaign?.campaign_id ?? null,
          metaCategory ?? crmCategory,
          metaCategory ? 'meta' : 'crm',
          priceType,
          billable,
          deliveredAt,
          now(),
        );
      } else repo.completeCost(metaCategory, priceType, billable, deliveredAt, ref);
      row = repo.cost(ref);
      if (row && row.category === 'service' && row.delivered_at && before === null) quotaNotice(row);
      return null;
    }
    // Aviso (evento de dominio, una sola vez por número, mes y umbral) cuando el número gasta el 80 % y el 100 % de
    // sus mensajes de servicio gratis del mes.
    function quotaNotice(row) {
      const r = rules(row.delivered_at);
      if (!r || !r.free_service_per_number || !row.phone_number_id) return;
      const tz = account().timezone,
        month = monthOf(row.delivered_at, tz),
        range = monthRange(month, tz),
        used = repo.serviceDelivered(row.phone_number_id, range.from, range.to).n;
      for (const step of QUOTA_STEPS)
        if (used >= Math.ceil((r.free_service_per_number * step) / 100))
          events.publish({
            type: QUOTA_EVENT,
            brandId: row.brand_id,
            entityKind: 'wa_number',
            entityId: row.phone_number_id,
            payload: {
              phoneNumberId: row.phone_number_id,
              month,
              threshold: step,
              used,
              free: r.free_service_per_number,
            },
            source: 'wa-costs',
            dedupeKey: [QUOTA_EVENT, row.phone_number_id, month, step].join(':'),
          });
    }

    // Se apunta al estado de Meta después del canal y de las difusiones (conciliación, fila 40).
    connectors.on('message.status', data => record(data), { order: 300, name: 'costos' });

    // ---- medidor
    function meter({ brandIds, month } = {}) {
      const acc = account(),
        tz = acc.timezone,
        chosen = month || monthOf(now(), tz),
        range = monthRange(chosen, tz);
      if (!range) throw host.fail(400, 'Mes no válido (AAAA-MM).', { code: 'invalid_month', field: 'month' });
      const r = rules(range.from);
      const free = r?.free_service_per_number ?? 0;
      const rows = repo.groups(brandIds, range.from, range.to);
      const labels = new Map(repo.numbers(brandIds).map(n => [n.phone_number_id, n]));
      const numberIds = [...new Set([...labels.keys(), ...rows.map(row => row.phone_number_id)])];
      // cuota de servicio: por número, con TODAS sus marcas, en orden de entrega
      const serviceSplit = new Map(),
        usedFree = new Map();
      for (const id of numberIds) {
        const quota = { left: free };
        for (const g of repo.serviceGroups([id], range.from, range.to)) {
          const split = splitGroup(
            { category: 'service', priceType: g.price_type, billable: g.billable, count: g.n },
            quota,
            rules(g.bucket),
          );
          serviceSplit.set([id, g.brand_id, g.price_type, g.billable, g.bucket].join('|'), split);
          usedFree.set(id, (usedFree.get(id) || 0) + split.usedQuota);
        }
      }
      const numbers = new Map(),
        brands = new Map();
      let unverified = false,
        total = 0;
      for (const g of rows) {
        const split =
          g.category === 'service'
            ? serviceSplit.get([g.phone_number_id, g.brand_id, g.price_type, g.billable, g.bucket].join('|'))
            : splitGroup(
                { category: g.category, priceType: g.price_type, billable: g.billable, count: g.n },
                { left: 0 },
                rules(g.bucket),
              );
        const share = split ?? { free: 0, billable: g.n };
        const rate = share.billable ? rateFor(g.market, g.category, g.bucket) : null;
        if (rate && !rate.verified) unverified = true;
        const cost = rate ? micros(rate.rateMicros, share.billable) : 0;
        const n = numbers.get(g.phone_number_id) ?? {
          phoneNumberId: g.phone_number_id,
          label: labels.get(g.phone_number_id)?.label ?? '',
          brandId: labels.get(g.phone_number_id)?.brand_id ?? g.brand_id,
          byCategory: Object.fromEntries(
            CATEGORIES.map(category => [category, { category, delivered: 0, billable: 0, free: 0, micros: 0 }]),
          ),
          micros: 0,
        };
        const c =
          n.byCategory[g.category] ??
          (n.byCategory[g.category] = {
            category: g.category,
            delivered: 0,
            billable: 0,
            free: 0,
            micros: 0,
          });
        c.delivered += g.n;
        c.billable += share.billable;
        c.free += share.free;
        c.micros += cost;
        n.micros += cost;
        numbers.set(g.phone_number_id, n);
        const b = brands.get(g.brand_id) ?? { brandId: g.brand_id, micros: 0, campaignMicros: 0 };
        b.micros += cost;
        if (g.origin === 'campaign') b.campaignMicros += cost;
        brands.set(g.brand_id, b);
        total += cost;
      }
      for (const id of labels.keys())
        if (!numbers.has(id))
          numbers.set(id, {
            phoneNumberId: id,
            label: labels.get(id).label,
            brandId: labels.get(id).brand_id,
            byCategory: Object.fromEntries(
              CATEGORIES.map(category => [category, { category, delivered: 0, billable: 0, free: 0, micros: 0 }]),
            ),
            micros: 0,
          });
      const currency = acc.currency || 'MXN';
      const price = value => ({ micros: value, amount: amountOf(value), label: money(value, currency) });
      return {
        month: chosen,
        timezone: tz,
        from: range.from,
        resetsAt: range.to,
        currency,
        // sin confirmar mientras alguna tarifa usada o vigente para México y «cualquier otro» no esté verificada
        ratesVerified:
          !unverified &&
          CATEGORIES.every(category => ['MX', '*'].every(market => rateFor(market, category, range.to - 1)?.verified)),
        rulesVerified: Boolean(r?.verified),
        payment: { status: acc.payment_status, note: acc.payment_note ?? null },
        numbers: [...numbers.values()].map(n => {
          const service = n.byCategory.service;
          const used = usedFree.get(n.phoneNumberId) ?? 0;
          return {
            phoneNumberId: n.phoneNumberId,
            label: n.label,
            brandId: n.brandId,
            service: {
              delivered: service.delivered,
              free,
              usedFree: used,
              billable: service.billable,
              pct: free ? Math.min(100, Math.round((used / free) * 100)) : 0,
            },
            byCategory: Object.values(n.byCategory).map(c => ({
              category: c.category,
              delivered: c.delivered,
              billable: c.billable,
              free: c.free,
              cost: price(c.micros),
            })),
            total: price(n.micros),
          };
        }),
        brands: [...brands.values()].map(b => ({
          brandId: b.brandId,
          cost: price(b.micros),
          campaignCost: price(b.campaignMicros),
        })),
        total: price(total),
      };
    }
    const monthSpend = (brandId, { origin = 'campaign', month } = {}) => {
      const out = meter({ brandIds: [brandId], month });
      const b = out.brands.find(x => x.brandId === brandId);
      return b ? (origin === 'campaign' ? b.campaignCost : b.cost) : { micros: 0, amount: 0, label: money(0) };
    };

    // Ventana gratuita por anuncio, estimada: la persona llegó por un anuncio en `at`; si el negocio respondió dentro
    // de las horas de la regla, desde esa respuesta hay N días en los que Meta no cobra. El dato firme es pricing.type
    // del estado («free_entry_point»): esto sólo sirve para avisar y estimar. No cambia la ventana de 24 h para escribir.
    function freeEntry(conversation) {
      let referral = null;
      try {
        referral = conversation?.referral ? JSON.parse(conversation.referral) : null;
      } catch {
        referral = null;
      }
      const at = Number(referral?.at);
      if (!referral || referral.source !== 'ad' || !Number.isFinite(at)) return null;
      const r = rules(at);
      if (!r) return null;
      const first = repo.firstReplyAfter(conversation.id, at)?.at ?? null;
      if (!first || first - at > r.free_entry_reply_hours * 3_600_000) return { open: false, from: null, until: null };
      const until = first + r.free_entry_days * DAY;
      return { open: now() < until, from: first, until };
    }

    // ---- rutas
    const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    const instant = (value, field) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw host.fail(400, 'Fecha de vigencia no válida.', { field });
      return n;
    };
    function addRate(input, user) {
      const market = text(input?.market, 10).toUpperCase();
      if (!MARKET.test(market)) throw host.fail(400, 'Mercado no válido (dos letras o *).', { field: 'market' });
      const category = text(input?.category, 30);
      if (!isCategory(category)) throw host.fail(400, 'Categoría no válida.', { field: 'category' });
      const rate = Number(input?.rateMicros);
      if (!Number.isInteger(rate) || rate < 0 || rate > 1e9)
        throw host.fail(400, 'Tarifa no válida (millonésimas de la moneda).', { field: 'rateMicros' });
      const from = instant(input?.effectiveFrom, 'effectiveFrom'),
        currency = text(input?.currency, 3).toUpperCase() || 'MXN',
        verified = input?.verified === true ? 1 : 0,
        source = text(input?.source, 300);
      const same = repo.rateAt(market, category, from);
      if (same) {
        if (same.rate_micros === rate && same.currency === currency && same.verified === verified) return same;
        throw host.fail(409, 'Ya hay una tarifa con esa fecha de vigencia: agrega otra con una fecha posterior.', {
          code: 'rate_exists',
        });
      }
      const id = randomUUID();
      repo.addRate(id, market, category, currency, rate, from, verified, source, user.id, now());
      host.audit(user, 'wa_costs.rate', id);
      return repo.rateAt(market, category, from);
    }
    function addRule(input, user) {
      const from = instant(input?.effectiveFrom, 'effectiveFrom');
      const count = (value, field) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 1e7) throw host.fail(400, 'Valor no válido.', { field });
        return n;
      };
      const values = [
        count(input?.freeServicePerNumber, 'freeServicePerNumber'),
        count(input?.freeEntryDays, 'freeEntryDays'),
        count(input?.freeEntryReplyHours, 'freeEntryReplyHours'),
        input?.serviceCharged === false ? 0 : 1,
        input?.utilityInWindowFree === true ? 1 : 0,
        input?.verified === true ? 1 : 0,
      ];
      const same = repo.rule(from);
      if (same) {
        const current = [
          same.free_service_per_number,
          same.free_entry_days,
          same.free_entry_reply_hours,
          same.service_charged,
          same.utility_in_window_free,
          same.verified,
        ];
        if (current.every((v, i) => v === values[i])) return same;
        throw host.fail(409, 'Ya hay una regla con esa fecha de vigencia.', { code: 'rule_exists' });
      }
      repo.addRule(from, ...values, text(input?.note, 500), user.id, now());
      host.audit(user, 'wa_costs.rule', String(from));
      return repo.rule(from);
    }

    return {
      rules,
      rateFor,
      estimate,
      record,
      meter,
      monthSpend,
      freeEntry,
      account,
      async handle(req, res, path, user, url) {
        if (req.method === 'GET' && path === PREFIX + '/meter') {
          const brand = url.searchParams.get('brand') || 'all';
          const brandIds =
            brand === 'all'
              ? host.access.brandIds(user, 'settings.costs')
              : (host.access.require(user, 'settings.costs', brand), [brand]);
          if (!brandIds.length) host.access.require(user, 'settings.costs');
          host.json(res, 200, { meter: meter({ brandIds, month: url.searchParams.get('month') || undefined }) });
          return true;
        }
        if (path === PREFIX + '/rates' && req.method === 'GET') {
          host.access.require(user, 'settings.costs');
          host.json(res, 200, { rates: repo.rates(), rules: repo.rulesList(), account: account() });
          return true;
        }
        if (path === PREFIX + '/rates' && req.method === 'POST') {
          host.requireAdmin(user);
          host.json(res, 201, { rate: addRate(await host.body(req), user) });
          return true;
        }
        if (path === PREFIX + '/rules' && req.method === 'POST') {
          host.requireAdmin(user);
          host.json(res, 201, { rule: addRule(await host.body(req), user) });
          return true;
        }
        return false;
      },
    };
  },
};
