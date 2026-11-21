// Reglas de un curso en borrador del conector (docs/PLAN_MCP_CLAUDE.md, «Dar de alta un curso»). Son las MISMAS que
// aplican las rutas del catálogo al darlo de alta (server/catalogue.mjs: POST /api/catalogue/courses y PATCH
// /api/catalogue/editions con estado «published»), para que lo que se guarda como borrador sea aceptable para el
// catálogo: largos, temario obligatorio, zona IANA, fechas en hora local (zonedToUtc), final después del inicio, inicio
// futuro para publicar, modalidad, moneda, precio con dos decimales y hasta 1 000 000, cupo entero de 1 en adelante y
// enlace http(s). Si el catálogo cambia una regla, la prueba de alta de punta a punta lo nota (el borrador «listo»
// tiene que darse de alta sin error). Funciones puras: lo que necesitan de la base se les pasa.
import { zonedToUtc } from '../catalogue-import.mjs';

export const DRAFT_MAX = Object.freeze({
  title: 180,
  syllabus: 5000,
  welcome: 2000,
  name: 120,
  instructor: 120,
  location: 250,
  link: 1000,
  zone: 80,
});
export const MODALITIES = Object.freeze(['online', 'in_person', 'hybrid']);
export const CURRENCIES = Object.freeze(['MXN', 'USD', 'COP', 'PEN', 'EUR']);
export const MAX_PRICE = 1_000_000;
const MODALITY_LABEL = { online: 'En línea', in_person: 'Presencial', hybrid: 'Híbrida' };

// Título comparable: sin mayúsculas, acentos ni espacios de más (la misma idea que la importación por CSV).
export const titleKey = v =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');

const txt = (v, n) =>
  String(v ?? '')
    .trim()
    .slice(0, n);
const zoneOk = zone => {
  try {
    new Intl.DateTimeFormat('es-MX', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

// De lo que manda el asistente (título, temario, bienvenida y `apertura` con hora local) a la fila del borrador. Lo que
// el catálogo rechazaría por su forma (fecha mal escrita, zona inexistente, precio con tres decimales, cupo de 0,
// enlace que no es http(s), final antes del inicio) se rechaza aquí con 400. Lo que falta no: se guarda y se dice.
// `current` es la fila actual (al actualizar): se conserva lo que no se manda.
export function draftRow(a, current, { zoneDefault, fail }) {
  const ap = a.apertura ?? {};
  const pick = (v, cur, fallback) => (v === undefined ? (cur ?? fallback) : v);
  const zone = txt(pick(ap.zona, current?.timezone, zoneDefault), DRAFT_MAX.zone);
  if (!zoneOk(zone)) throw fail(400, 'Zona horaria no válida: usa una zona IANA, por ejemplo America/Mexico_City.');
  const when = (v, label, cur) => {
    if (v === undefined) return cur ?? null;
    if (v === null || v === '') return null;
    const t = zonedToUtc(String(v), zone);
    if (t === null) throw fail(400, `${label} debe verse como «2026-12-01 19:00» (hora local de la zona).`);
    return t;
  };
  // Si cambia la zona y no se mandan las fechas, se conservan los instantes guardados.
  const startsAt = when(ap.inicio, 'El inicio', current?.starts_at);
  const endsAt = when(ap.fin, 'El fin', current?.ends_at);
  if (endsAt !== null && (startsAt === null || endsAt <= startsAt))
    throw fail(400, 'El final debe ser posterior al inicio.');
  const modality = pick(ap.modalidad, current?.modality, 'online');
  if (!MODALITIES.includes(modality)) throw fail(400, 'Modalidad: online, in_person o hybrid.');
  const currency = String(pick(ap.moneda, current?.currency, 'MXN')).toUpperCase();
  if (!CURRENCIES.includes(currency)) throw fail(400, 'Moneda: ' + CURRENCIES.join(', ') + '.');
  let priceCents = current?.price_cents ?? null;
  if (ap.precio !== undefined) {
    const n = ap.precio;
    if (
      n === null ||
      !Number.isFinite(n) ||
      n < 0 ||
      n > MAX_PRICE ||
      Math.abs(n * 100 - Math.round(n * 100)) > 0.00001
    )
      throw fail(400, 'El precio debe ser un número de 0 a 1 000 000 con como máximo dos decimales.');
    priceCents = Math.round(n * 100);
  }
  const capacity = ap.cupo === undefined ? (current?.capacity ?? null) : ap.cupo;
  if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 1))
    throw fail(400, 'El cupo debe ser un número entero de 1 en adelante (o vacío: sin límite).');
  const link = txt(pick(ap.enlace, current?.info_url, ''), DRAFT_MAX.link);
  if (link) {
    let ok = false;
    try {
      ok = ['https:', 'http:'].includes(new URL(link).protocol);
    } catch {
      ok = false;
    }
    if (!ok) throw fail(400, 'El enlace debe comenzar con https:// o http://.');
  }
  return {
    title: txt(pick(a.titulo, current?.title, ''), DRAFT_MAX.title),
    syllabus: txt(pick(a.temario, current?.syllabus, ''), DRAFT_MAX.syllabus),
    welcome: txt(pick(a.bienvenida, current?.welcome, ''), DRAFT_MAX.welcome),
    edition_name: txt(pick(ap.nombre, current?.edition_name, ''), DRAFT_MAX.name),
    starts_at: startsAt,
    ends_at: endsAt,
    timezone: zone,
    instructor: txt(pick(ap.docente, current?.instructor, ''), DRAFT_MAX.instructor),
    modality,
    location: txt(pick(ap.lugar, current?.location, ''), DRAFT_MAX.location),
    info_url: link,
    capacity,
    price_cents: priceCents,
    currency,
  };
}

// Lo que le falta para poder darse de alta (`missing`, impide proponer y aprobar) y los avisos (`warnings`).
// ctx: { now, takenTitle: bool (otro curso de la marca o un borrador vivo ya se llama así), similar: [títulos] }
export function draftReview(d, { now, takenTitle = false, similar = [] }) {
  const missing = [];
  const warnings = [];
  if (d.title.length < 3) missing.push('El título necesita al menos 3 caracteres.');
  if (takenTitle) missing.push('Ya hay un curso (o un curso en borrador) con ese título en la marca: usa otro.');
  if (!d.syllabus) missing.push('Falta el temario.');
  if (!d.edition_name) missing.push('Falta el nombre de la apertura (por ejemplo «Enero 2027»).');
  if (d.starts_at === null) missing.push('Falta el inicio de la apertura.');
  else if (d.starts_at <= now)
    missing.push('El inicio ya pasó: el catálogo sólo publica una apertura con fecha futura. Cambia la fecha.');
  if (d.price_cents === null) missing.push('Falta el precio.');
  for (const t of similar) warnings.push(`El título se parece a un curso que ya existe: ${t}.`);
  if (!d.file_id) warnings.push('No tiene imagen: el curso se ofrecería sin imagen hasta que se suba y apruebe una.');
  if (!d.instructor) warnings.push('No tiene docente: se mostrará «Por confirmar».');
  return { missing, warnings };
}

// Fecha en palabras, en la zona de la apertura.
export function whenWords(t, zone) {
  if (t === null || t === undefined) return 'Sin fecha';
  try {
    return (
      new Intl.DateTimeFormat('es-MX', { dateStyle: 'full', timeStyle: 'short', timeZone: zone }).format(t) +
      ' (' +
      zone +
      ')'
    );
  } catch {
    return new Date(t).toISOString();
  }
}
// Hora local «2026-12-01 19:00» (lo que escribe el asistente).
export function localText(t, zone) {
  if (t === null || t === undefined) return null;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(t))
      .map(x => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export const modalityLabel = m => MODALITY_LABEL[m] || m;
