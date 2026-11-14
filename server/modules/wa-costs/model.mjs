// Reglas de cálculo del costo de WhatsApp (docs/PLAN_CIMIENTOS_DIFUSIONES.md §4), sin base de datos ni red: mercado
// del destinatario, mes de la cuota en la zona de la cuenta y reparto de los mensajes de servicio gratis por número.
// Las cifras (tarifas y reglas) NO viven aquí: llegan de las tablas wa_rates y wa_pricing_rules, que edita
// administración. Aquí sólo está cómo se aplican.

export const CATEGORIES = Object.freeze(['marketing', 'utility', 'authentication', 'service']);
export const ORIGINS = Object.freeze(['chat', 'campaign']);
export const isCategory = value => CATEGORIES.includes(value);

// Prefijo internacional → mercado de Meta. El más largo gana; lo que no está es «*» (cualquier otro mercado).
// Estados Unidos y Canadá comparten el +1 y Meta los cobra igual: van como «US».
const PREFIXES = Object.freeze({
  52: 'MX',
  1: 'US',
  57: 'CO',
  54: 'AR',
  56: 'CL',
  51: 'PE',
  593: 'EC',
  502: 'GT',
  503: 'SV',
  504: 'HN',
  505: 'NI',
  506: 'CR',
  507: 'PA',
  591: 'BO',
  595: 'PY',
  598: 'UY',
  58: 'VE',
  53: 'CU',
  34: 'ES',
  55: 'BR',
});
const BY_LENGTH = Object.keys(PREFIXES).sort((a, b) => b.length - a.length);
export function marketOf(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return '*';
  return PREFIXES[BY_LENGTH.find(prefix => digits.startsWith(prefix))] ?? '*';
}

// Partes de la fecha local de `at` en la zona `timeZone`.
function localParts(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = type => Number(parts.find(p => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}
// Desfase de la zona en `at`, en milisegundos (hora local menos UTC).
function offsetAt(at, timeZone) {
  const p = localParts(at, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - (at - (at % 1000));
}
// Instante UTC de la medianoche local del día 1 del mes (y, m) en la zona.
function monthStart(y, m, timeZone) {
  const guess = Date.UTC(y, m - 1, 1);
  let at = guess - offsetAt(guess, timeZone);
  at = guess - offsetAt(at, timeZone); // segunda pasada por si el cambio de horario cae justo en medio
  return at;
}
export const validTimeZone = timeZone => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};
// 'AAAA-MM' del instante `at` en la zona de la cuenta (la cuota de Meta se reinicia el día 1 a medianoche local).
export function monthOf(at, timeZone) {
  const p = localParts(at, timeZone);
  return p.y + '-' + String(p.m).padStart(2, '0');
}
// [desde, hasta) del mes 'AAAA-MM' en la zona.
export function monthRange(month, timeZone) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''));
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return null;
  const y = Number(match[1]),
    m = Number(match[2]);
  return {
    from: monthStart(y, m, timeZone),
    to: m === 12 ? monthStart(y + 1, 1, timeZone) : monthStart(y, m + 1, timeZone),
  };
}

// ¿Cuesta este grupo de mensajes entregados? Devuelve cuántos son gratis y cuántos se cobran, y consume la cuota de
// servicio gratis del número (`quota.left`), que se lleva en orden de entrega:
//   - Entrada por anuncio («free_entry_point»): gratis y no gasta la cuota de servicio.
//   - Meta dijo billable=false u otro tipo «free_*»: gratis. Si es de servicio, gasta cuota (hasta agotarla).
//   - Meta dijo billable=true: se cobra.
//   - Meta no lo dijo: servicio → gratis mientras quede cuota; después se cobra si la regla dice que el servicio se
//     cobra. Marketing, utilidad y autenticación → se cobran (la utilidad gratis dentro de la ventana sólo se sabe
//     por el dato de Meta: sin él, se cuenta como cobrada; es la estimación prudente).
// Quien llama debe pasar, dentro de una misma hora, primero los grupos con dato de Meta y después los que no lo tienen.
export function splitGroup({ category, priceType, billable, count }, quota, rules) {
  const said = billable === 0 || billable === 1 ? billable : null;
  if (priceType === 'free_entry_point') return { free: count, billable: 0, usedQuota: 0 };
  const freeByType = typeof priceType === 'string' && priceType.startsWith('free');
  if (said === 0 || freeByType) {
    const used = category === 'service' ? Math.min(count, quota.left) : 0;
    quota.left -= used;
    return { free: count, billable: 0, usedQuota: used };
  }
  if (said === 1) return { free: 0, billable: count, usedQuota: 0 };
  if (category === 'service') {
    const free = Math.min(count, quota.left);
    quota.left -= free;
    return { free, billable: rules?.service_charged ? count - free : 0, usedQuota: free };
  }
  return { free: 0, billable: count, usedQuota: 0 };
}

export const micros = (rateMicros, count) => Math.max(0, Number(rateMicros) || 0) * Math.max(0, count);
export const amountOf = value => Math.round(Number(value) / 10_000) / 100; // millonésimas → importe con 2 decimales
export const money = (value, currency = 'MXN') =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amountOf(value));
