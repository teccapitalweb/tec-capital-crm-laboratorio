// Lo puro de la Jornada simulada (docs/PLAN_JORNADA_SIMULADA.md): cuándo llega cada cliente, los bloques de 15 minutos
// para la gráfica, las alertas que se detectan sobre filas de la base y la mediana. Sin base ni reloj: todo entra por
// parámetros, así se prueba solo.

export const RHYTHMS = Object.freeze({
  goteo: { label: 'Goteo con horas pico', hint: 'Más llegadas a media jornada, pocas al principio y al final.' },
  parejo: { label: 'Parejo', hint: 'La misma cantidad cada rato.' },
  rafagas: { label: 'Ráfagas', hint: 'Grupos de tres o cuatro seguidos y luego calma.' },
});
export const ALERT_KINDS = Object.freeze({
  sin_respuesta: {
    label: 'Cliente sin respuesta',
    icon: '⏱',
    tone: 'peach',
    hint: 'Nadie le ha contestado en el tiempo elegido.',
  },
  no_supo: {
    label: 'El asistente no supo',
    icon: '🤷',
    tone: 'butter',
    hint: 'Contestó «todavía no la tengo a la mano».',
  },
  paso_sin_motivo: {
    label: 'Pasó a persona sin motivo claro',
    icon: '↪',
    tone: 'lilac',
    hint: 'La persona sólo dijo «ok», «gracias» o algo así.',
  },
  persona_tarda: {
    label: 'La persona tarda',
    icon: '👤',
    tone: 'peach',
    hint: 'El chat ya es de alguien del equipo y lleva más del tiempo elegido sin respuesta.',
  },
  molesto: {
    label: 'Cliente molesto',
    icon: '😠',
    tone: 'peach',
    hint: 'Escribió una queja o lleva esperando.',
  },
});
export const DEFAULT_ALERTS = Object.freeze({
  waitMinutes: 5,
  sin_respuesta: true,
  no_supo: true,
  paso_sin_motivo: true,
  persona_tarda: true,
  molesto: false,
});
export const LIMITS = Object.freeze({ maxCount: 60, minMinutes: 1, maxMinutes: 12 * 60, blockMs: 15 * 60_000 });
const CHANNELS = ['whatsapp', 'instagram', 'facebook'];

// Peso de cada tramo de la jornada según el ritmo (10 tramos). «goteo»: campana con el pico a media jornada.
function weights(rhythm) {
  if (rhythm === 'goteo') return [2, 4, 6, 9, 11, 11, 9, 6, 4, 2];
  if (rhythm === 'rafagas') return [8, 1, 9, 1, 8, 1, 9, 1, 8, 1];
  return [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
}
// A qué hora llega cada cliente, con qué perfil y canal. `rnd()` en [0,1) para poder repetirlo en las pruebas. Las
// llegadas salen ordenadas y dentro de [startAt, startAt + minutes).
export function planArrivals({ count, startAt, minutes, rhythm = 'goteo', personas, rnd = Math.random }) {
  const w = weights(rhythm),
    total = w.reduce((a, b) => a + b, 0),
    span = minutes * 60_000,
    tramo = span / w.length,
    out = [];
  const list = Array.isArray(personas) && personas.length ? personas : ['curioso'];
  for (let i = 0; i < count; i++) {
    // elige el tramo por su peso y una hora al azar dentro de él
    let r = rnd() * total,
      k = 0;
    while (k < w.length - 1 && r >= w[k]) r -= w[k++];
    const at = startAt + Math.floor(k * tramo + rnd() * tramo);
    out.push({ plannedAt: at, persona: list[Math.floor(rnd() * list.length)], channel: CHANNELS[i % CHANNELS.length] });
  }
  out.sort((a, b) => a.plannedAt - b.plannedAt);
  // el primero llega de inmediato (a nadie le gusta esperar a que empiece)
  if (out.length) out[0].plannedAt = startAt;
  return out;
}

// Bloques de 15 minutos: cuántas llegadas planeadas y cuántas ya ocurrieron en cada uno, y cuál es el de «ahora».
export function blocks({ startAt, minutes, arrivals, now, blockMs = LIMITS.blockMs }) {
  const n = Math.max(1, Math.ceil((minutes * 60_000) / blockMs));
  const out = Array.from({ length: n }, (_, i) => ({
    at: startAt + i * blockMs,
    planned: 0,
    arrived: 0,
    current: now >= startAt + i * blockMs && now < startAt + (i + 1) * blockMs,
  }));
  for (const a of arrivals) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((a.plannedAt - startAt) / blockMs)));
    out[i].planned += 1;
    if (a.state === 'arrived') out[i].arrived += 1;
  }
  return out;
}

export function median(values) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

// una o varias palabras de trato seguidas («ok gracias», «va, listo»), sin nada más
const TRIVIAL =
  /^(?:(?:ok|okey|okay|vale|va|gracias|muchas|grax|listo|perfecto|genial|si|sí|no|bien|sale|dale)[.!,\s]*){1,4}$/i;
const UPSET =
  /\b(molest|enojad|p[ée]sim|queja|reclam|nadie (me )?(contesta|responde)|llevo .* esperando|me van a contestar|no me (han )?contesta|ya me cans)\b/i;
const NO_SUPO = /no la tengo a la mano/i;
const HANDOFF = /(te paso|pasarte|te comunico|te conecto|te canalizo) con (una persona|alguien|un asesor|el equipo)/i;

// Qué alertas tocan HOY sobre una conversación de la jornada. `c` trae lo que la jornada lee de la base:
//   { conversationId, name, status, assignedTo, lastCustomerAt, lastOutboundAt, lastCustomerText, previousCustomerText,
//     lastAutomationText, lastAutomationAt, lastAgentAt }
// Devuelve [{kind, text, detail}] (la clave única por conversación y clase evita repetir). Cada alerta se evalúa
// contra la configuración (`alerts`) y el reloj (`now`).
export function detectAlerts(c, alerts, now) {
  const cfg = { ...DEFAULT_ALERTS, ...(alerts || {}) },
    wait = Math.max(1, Number(cfg.waitMinutes) || DEFAULT_ALERTS.waitMinutes) * 60_000,
    out = [];
  if (!c || c.status === 'resolved') return out;
  const waitingOnUs = c.lastCustomerAt && (!c.lastOutboundAt || c.lastOutboundAt < c.lastCustomerAt);
  const sinceCustomer = waitingOnUs ? now - c.lastCustomerAt : 0;
  if (waitingOnUs && sinceCustomer >= wait) {
    const mins = Math.floor(sinceCustomer / 60_000);
    if (c.assignedTo && cfg.persona_tarda)
      out.push({
        kind: 'persona_tarda',
        text: `${c.name} lleva ${mins} min sin respuesta de ${c.assigneeName || 'la persona asignada'}`,
        detail: c.lastCustomerText ? 'Último mensaje: «' + c.lastCustomerText.slice(0, 120) + '»' : '',
      });
    else if (!c.assignedTo && cfg.sin_respuesta)
      out.push({
        kind: 'sin_respuesta',
        text: `${c.name} lleva ${mins} min sin respuesta`,
        detail:
          (c.status === 'waiting' ? 'Espera a una persona del equipo. ' : '') +
          (c.lastCustomerText ? 'Último mensaje: «' + c.lastCustomerText.slice(0, 120) + '»' : ''),
      });
  }
  if (cfg.no_supo && c.lastAutomationText && NO_SUPO.test(c.lastAutomationText) && c.previousCustomerText)
    out.push({
      kind: 'no_supo',
      text: `El asistente no supo: «${c.previousCustomerText.slice(0, 80)}»`,
      detail: `${c.name} · revisa si la respuesta está en el catálogo o en el conocimiento`,
    });
  if (
    cfg.paso_sin_motivo &&
    c.lastAutomationText &&
    HANDOFF.test(c.lastAutomationText) &&
    c.previousCustomerText &&
    TRIVIAL.test(c.previousCustomerText.trim())
  )
    out.push({
      kind: 'paso_sin_motivo',
      text: 'Pasó a persona sin motivo claro',
      detail: `${c.name} · después de «${c.previousCustomerText.trim().slice(0, 40)}»`,
    });
  if (cfg.molesto && c.lastCustomerText && UPSET.test(c.lastCustomerText))
    out.push({
      kind: 'molesto',
      text: `Cliente molesto: ${c.name}`,
      detail: '«' + c.lastCustomerText.slice(0, 120) + '»',
    });
  return out;
}
