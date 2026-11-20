// Modelo de las secuencias de seguimiento (docs/PLAN_SECUENCIAS.md): forma de la definición, su validación, las
// fechas en la zona horaria de la marca y los textos de cada motivo. Funciones puras: sin base de datos, sin red y
// sin reloj propio (el «ahora» lo entrega quien llama).
import {
  keywordMatch,
  validate as validateConditions,
  normalize as normalizeConditions,
} from '../../lib/conditions.mjs';
import { CONDITION_FIELDS } from '../chatflows/engine.mjs';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const LIMITS = Object.freeze({
  sequencesPerBrand: 50,
  steps: 10,
  titleLength: 80,
  descriptionLength: 300,
  textLength: 1000,
  phrases: 20,
  phraseLength: 60,
  maxDelayDays: 90,
  maxDaysBefore: 60,
  // Tope por persona entre todas las secuencias y difusiones de la marca: mensajes automáticos en 24 horas.
  perPersonPerDay: 2,
  monthlyCapMax: 100_000,
  monthlyCapDefault: 500,
  conversionDaysDefault: 7,
  // Holgura de un paso: si no pudo salir en este tiempo (horario, topes), se omite. Dos días: un paso que espera al
  // tope por persona (24 h) o a la apertura de un lunes todavía sale.
  grace: 2 * DAY,
});

export const UNITS = Object.freeze({ minutes: MINUTE, hours: HOUR, days: DAY });
export const TRIGGERS = Object.freeze({
  manual: 'Sólo a mano o desde un recorrido',
  course_card: 'Recibió la ficha del curso',
  enroll_interest: 'Preguntó cómo inscribirse',
});
export const SEND_HOURS = Object.freeze({
  business: 'En el horario de atención de la marca',
  daytime: 'De día (fuera del horario de silencio de las difusiones)',
});
export const ON_REPLY = Object.freeze({ pause: 'Pausar', stop: 'Detener' });
export const WHEN_CLOSED = Object.freeze({
  template: 'Enviar una plantilla aprobada en su lugar',
  skip: 'Omitir este paso',
  stop: 'Detener la secuencia',
});
export const DEFAULT_STOP_PHRASES = Object.freeze([
  'no, por el momento',
  'no por ahora',
  'no me interesa',
  'ya no me interesa',
  'no gracias',
]);
export const DEFAULT_YES_PHRASES = Object.freeze([
  'sí, deseo inscribirme',
  'deseo inscribirme',
  'quiero inscribirme',
  'me interesa',
]);

// Por qué una inscripción se detuvo o quedó en pausa, por qué un paso se omitió o espera. En palabras del equipo.
export const REASONS = Object.freeze({
  enrolled: 'Se inscribió o pagó el curso',
  opt_out: 'Pidió no recibir mensajes',
  suppressed: 'Está en una lista de exclusión',
  said_no: 'Dijo que no',
  replied: 'Respondió',
  human_takeover: 'Una persona del equipo atiende la conversación',
  closed: 'La conversación se cerró',
  blocked: 'La conversación está bloqueada',
  listen_only: 'El número está en modo escucha',
  automation_off: 'La automatización de la marca está apagada o su asistente no responde solo',
  sequence_off: 'La secuencia se apagó',
  edition_started: 'El curso ya empezó',
  edition_ended: 'El curso ya terminó',
  window_closed: 'La ventana de 24 horas estaba cerrada',
  completed: 'Terminó todos sus pasos',
  manual: 'La detuvo una persona del equipo',
  step_failed: 'Un paso falló varias veces y no se volvió a intentar',
  // pasos omitidos
  condition: 'No cumplía la condición del paso',
  too_late: 'Ya había pasado su momento',
  no_edition_date: 'El curso no tiene fecha de inicio en el catálogo',
  template_unavailable: 'La plantilla no está disponible',
  material_unavailable: 'El material no está disponible',
  no_consent: 'Sin consentimiento para mensajes promocionales',
  // esperas
  outside_hours: 'Fuera del horario de envío',
  frequency_cap: 'Ya recibió el máximo de mensajes automáticos del día',
  monthly_cap: 'La secuencia llegó a su tope del mes',
  not_due: 'Todavía no es su momento',
  flow_active: 'Un recorrido atiende la conversación',
});
export const reasonLabel = code => REASONS[code] ?? code ?? '';

export const STATES = Object.freeze({
  active: 'En curso',
  paused: 'En pausa',
  completed: 'Terminada',
  stopped: 'Detenida',
});

// ---- Fechas en una zona horaria

const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone))
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    );
  return formatters.get(timeZone);
}
// Fecha y hora locales de un instante: {year, month, day, hour, minute}.
export function zonedParts(t, timeZone) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(t))
      .map(p => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}
// Instante de una fecha y hora locales en la zona (corrige el desfase dos veces: cubre los cambios de horario).
export function zonedInstant({ year, month, day }, hour, minute, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone);
    const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (local === target) break;
    guess += target - local;
  }
  return guess;
}
// Una fecha local más `n` días (n puede ser negativo).
export function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
export const localDate = (t, timeZone) => {
  const p = zonedParts(t, timeZone);
  return { year: p.year, month: p.month, day: p.day };
};
// Último milisegundo del día local de `date`.
export const endOfDay = (date, timeZone) => zonedInstant(addDays(date, 1), 0, 0, timeZone) - 1;
// Primer instante del mes local de `t`.
export const monthStart = (t, timeZone) => {
  const p = zonedParts(t, timeZone);
  return zonedInstant({ year: p.year, month: p.month, day: 1 }, 0, 0, timeZone);
};

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isClock = v => typeof v === 'string' && CLOCK.test(v);

// Cuándo toca un paso y hasta cuándo puede salir: {due, latest} o {reason} si no se puede calcular.
//   base 'enrolled'       inscripción + cantidad × unidad; puede salir hasta dos días después.
//   base 'edition_start'  `daysBefore` días antes del día en que empieza la edición (0 = ese mismo día), a la hora
//                         `at` de la marca; puede salir hasta dos días después y nunca después del día de inicio.
// La fecha de inicio sale SIEMPRE del catálogo (la edición elegida al inscribir), nunca de un texto escrito.
export function stepTiming(step, { startedAt, edition, timeZone }) {
  const timing = step.timing;
  if (timing.base === 'edition_start') {
    if (!edition?.starts_at) return { reason: 'no_edition_date' };
    const startDay = localDate(edition.starts_at, timeZone);
    const [hh, mm] = timing.at.split(':').map(Number);
    const due = zonedInstant(addDays(startDay, -timing.daysBefore), hh, mm, timeZone);
    return { due, latest: Math.min(due + LIMITS.grace, endOfDay(startDay, timeZone)) };
  }
  const due = startedAt + timing.amount * UNITS[timing.unit];
  return { due, latest: due + LIMITS.grace };
}
// ¿Ya pasó el día en que empezó la edición, o ya terminó? Motivo de alto o null.
export function editionOver(edition, t, timeZone) {
  if (!edition) return null;
  if (edition.ends_at && edition.ends_at < t) return 'edition_ended';
  if (edition.starts_at && endOfDay(localDate(edition.starts_at, timeZone), timeZone) < t) return 'edition_started';
  return null;
}

// ---- Respuestas de la persona

// Qué dijo la persona: 'no' (frase de alto), 'yes' (frase de sí) o 'other'. Las de alto se miran primero: «no me
// interesa» contiene «me interesa».
export function classifyReply(text, settings) {
  if (keywordMatch(text || '', settings.stopPhrases, { mode: 'contains' })) return 'no';
  if (keywordMatch(text || '', settings.yesPhrases, { mode: 'contains' })) return 'yes';
  return 'other';
}

// ---- Validación de la definición

const clean = (v, max) =>
  typeof v === 'string'
    ? v
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, max + 1)
    : '';
const ID = /^[A-Za-z0-9-]{1,64}$/;
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function cleanPhrases(value, fallback, label, problems) {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) {
    problems.push(`${label}: escribe una frase por renglón.`);
    return [...fallback];
  }
  const list = [...new Set(value.map(p => clean(p, LIMITS.phraseLength)).filter(Boolean))];
  if (list.length > LIMITS.phrases) problems.push(`${label}: hasta ${LIMITS.phrases} frases.`);
  if (list.some(p => p.length > LIMITS.phraseLength))
    problems.push(`${label}: cada frase admite hasta ${LIMITS.phraseLength} caracteres.`);
  return list.slice(0, LIMITS.phrases);
}

export function normalizeSettings(input = {}, problems = []) {
  const s = input && typeof input === 'object' ? input : {};
  const pick = (value, options, fallback) => (Object.hasOwn(options, value) ? value : fallback);
  const monthlyCap = s.monthlyCap ?? LIMITS.monthlyCapDefault;
  if (!intIn(monthlyCap, 1, LIMITS.monthlyCapMax))
    problems.push(`El tope del mes va de 1 a ${LIMITS.monthlyCapMax.toLocaleString('es-MX')} mensajes.`);
  const resumeAfterHours = s.resumeAfterHours ?? 24;
  if (!intIn(resumeAfterHours, 0, 168)) problems.push('La reanudación va de 0 a 168 horas (0 = sólo a mano).');
  const conversionDays = s.conversionDays ?? LIMITS.conversionDaysDefault;
  if (!intIn(conversionDays, 1, 60)) problems.push('Los días para contar una inscripción van de 1 a 60.');
  return {
    trigger: pick(s.trigger, TRIGGERS, 'manual'),
    onReply: pick(s.onReply, ON_REPLY, 'pause'),
    onTakeover: pick(s.onTakeover, ON_REPLY, 'pause'),
    sendHours: pick(s.sendHours, SEND_HOURS, 'business'),
    stopPhrases: cleanPhrases(s.stopPhrases, DEFAULT_STOP_PHRASES, 'Frases de alto', problems),
    yesPhrases: cleanPhrases(s.yesPhrases, DEFAULT_YES_PHRASES, 'Frases de sí', problems),
    monthlyCap: intIn(monthlyCap, 1, LIMITS.monthlyCapMax) ? monthlyCap : LIMITS.monthlyCapDefault,
    requireConsent: s.requireConsent === undefined ? true : s.requireConsent === true,
    resumeAfterHours: intIn(resumeAfterHours, 0, 168) ? resumeAfterHours : 24,
    conversionDays: intIn(conversionDays, 1, 60) ? conversionDays : LIMITS.conversionDaysDefault,
  };
}

function normalizeStep(raw, i, problems) {
  const n = `Paso ${i + 1}`;
  const s = raw && typeof raw === 'object' ? raw : {};
  const id = typeof s.id === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(s.id) ? s.id : `p${i + 1}`;
  // cuándo
  const t = s.timing && typeof s.timing === 'object' ? s.timing : {};
  let timing;
  if (t.base === 'edition_start') {
    const daysBefore = t.daysBefore ?? 0;
    if (!intIn(daysBefore, 0, LIMITS.maxDaysBefore))
      problems.push(`${n}: los días antes del inicio van de 0 a ${LIMITS.maxDaysBefore}.`);
    const at = t.at ?? '10:00';
    if (!isClock(at)) problems.push(`${n}: la hora se escribe como 10:00.`);
    timing = {
      base: 'edition_start',
      daysBefore: intIn(daysBefore, 0, LIMITS.maxDaysBefore) ? daysBefore : 0,
      at: isClock(at) ? at : '10:00',
    };
  } else {
    const unit = Object.hasOwn(UNITS, t.unit) ? t.unit : 'days';
    const amount = t.amount ?? 1;
    const max = (LIMITS.maxDelayDays * DAY) / UNITS[unit];
    if (!intIn(amount, 0, max)) problems.push(`${n}: la espera va de 0 a ${LIMITS.maxDelayDays} días.`);
    timing = { base: 'enrolled', amount: intIn(amount, 0, max) ? amount : 1, unit };
  }
  // qué envía
  const x = s.send && typeof s.send === 'object' ? s.send : {};
  let send;
  if (x.kind === 'template') {
    if (!ID.test(String(x.templateId ?? ''))) problems.push(`${n}: elige una plantilla de WhatsApp aprobada.`);
    send = { kind: 'template', templateId: String(x.templateId ?? '') };
  } else if (x.kind === 'material') {
    if (!ID.test(String(x.materialId ?? ''))) problems.push(`${n}: elige un material del catálogo.`);
    send = { kind: 'material', materialId: String(x.materialId ?? '') };
  } else {
    const text = typeof x.text === 'string' ? x.text.trim().slice(0, LIMITS.textLength + 1) : '';
    if (!text) problems.push(`${n}: escribe el mensaje.`);
    if (text.length > LIMITS.textLength)
      problems.push(`${n}: el mensaje admite hasta ${LIMITS.textLength} caracteres.`);
    send = { kind: 'text', text: text.slice(0, LIMITS.textLength) };
  }
  // ventana cerrada (una plantilla sale aunque esté cerrada)
  let whenClosed = null;
  let fallbackTemplateId = null;
  if (send.kind !== 'template') {
    whenClosed = Object.hasOwn(WHEN_CLOSED, s.whenClosed) ? s.whenClosed : 'skip';
    if (whenClosed === 'template') {
      fallbackTemplateId = String(s.fallbackTemplateId ?? '');
      if (!ID.test(fallbackTemplateId)) problems.push(`${n}: elige la plantilla que sale si la ventana está cerrada.`);
    }
  }
  // condición opcional (gramática común, campos de los recorridos: datos, etiquetas, curso, canal, horario)
  let condition = null;
  if (
    s.condition &&
    typeof s.condition === 'object' &&
    Array.isArray(s.condition.groups) &&
    s.condition.groups.length
  ) {
    const found = validateConditions(s.condition, CONDITION_FIELDS);
    if (found.length) problems.push(`${n}: ${found[0]}`);
    else condition = normalizeConditions(s.condition, CONDITION_FIELDS);
  }
  return { id, timing, send, whenClosed, fallbackTemplateId, condition };
}

// Pasos y ajustes en su forma canónica, más la lista de problemas en palabras de quien la arma.
export function normalizeDefinition({ steps, settings } = {}) {
  const problems = [];
  const list = Array.isArray(steps) ? steps : [];
  if (list.length > LIMITS.steps) problems.push(`Una secuencia admite hasta ${LIMITS.steps} pasos.`);
  const out = list.slice(0, LIMITS.steps).map((s, i) => normalizeStep(s, i, problems));
  const ids = new Set();
  for (const [i, s] of out.entries()) {
    if (ids.has(s.id)) s.id = `p${i + 1}-${i}`;
    ids.add(s.id);
  }
  return { steps: out, settings: normalizeSettings(settings, problems), problems };
}

// Plantillas y materiales que usa una definición (para validarlos contra la marca).
export function referencedIds(steps) {
  const templates = new Set();
  const materials = new Set();
  for (const s of steps) {
    if (s.send.kind === 'template') templates.add(s.send.templateId);
    if (s.send.kind === 'material') materials.add(s.send.materialId);
    if (s.fallbackTemplateId) templates.add(s.fallbackTemplateId);
  }
  return { templates: [...templates], materials: [...materials] };
}

// Texto corto de cuándo sale un paso, para listas y la vista previa.
export function timingLabel(timing) {
  if (timing.base === 'edition_start')
    return timing.daysBefore === 0
      ? `El día que empieza el curso, ${timing.at}`
      : `${timing.daysBefore} ${timing.daysBefore === 1 ? 'día' : 'días'} antes del inicio, ${timing.at}`;
  if (timing.amount === 0) return 'Al inscribirse';
  const unit = { minutes: ['minuto', 'minutos'], hours: ['hora', 'horas'], days: ['día', 'días'] }[timing.unit];
  return `${timing.amount} ${timing.amount === 1 ? unit[0] : unit[1]} después de inscribirse`;
}
