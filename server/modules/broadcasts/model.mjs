// Reglas del motor de difusiones sin base ni red (docs/PLAN_MOTOR_DIFUSIONES.md; diseño de difusiones §5 y apéndice
// B; conciliación, filas 25, 37, 39 y 41). Todo lo de aquí es puro y se prueba solo (test/broadcasts-engine.test.mjs).

export const DAY = 86_400_000;
export const MINUTE = 60_000;

// Estados de la campaña (§5.2). `stopped` lo pone el sistema; `paused`, una persona.
export const CAMPAIGN_STATUS = Object.freeze({
  draft: 'Borrador',
  scheduled: 'Programada',
  sending: 'Enviando',
  paused: 'Pausada',
  stopped: 'Detenida',
  completed: 'Completada',
  cancelled: 'Cancelada',
});

// Estados del destinatario (§5.9).
export const RECIPIENT_STATES = Object.freeze({
  queued: 'En cola',
  sending: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'Fallido',
  deferred: 'Se reintentará',
  skipped: 'Omitido',
  cancelled: 'Cancelado',
});

// Por qué alguien no recibió (§5.5). Los seis primeros vienen del módulo de audiencias; `no_address` sustituye a
// `no_phone` (fila 37: el destinatario podrá ser un identificador de usuario cuando exista I-2).
export const SKIP_REASONS = Object.freeze({
  no_address: 'No tiene un WhatsApp al que escribirle',
  opted_out: 'Pidió la baja',
  no_consent: 'Sin consentimiento registrado',
  suppressed: 'Está en una lista de exclusión',
  excluded: 'Excluido por la campaña',
  duplicate: 'Número repetido en el público',
  recent_campaign: 'Recibió otra difusión hace poco',
  missing_variable: 'Le falta un dato de la plantilla',
  too_long: 'El mensaje quedó demasiado largo',
  over_limit: 'Quedó fuera del público máximo de la marca',
  campaign_cancelled: 'La difusión se canceló antes de su turno',
});
// Motivos del módulo de audiencias → motivos del motor.
export const AUDIENCE_REASON = Object.freeze({
  excluded: 'excluded',
  no_phone: 'no_address',
  suppressed: 'suppressed',
  opted_out: 'opted_out',
  no_consent: 'no_consent',
  duplicate: 'duplicate',
});

// Por qué una campaña está en espera sin cambiar de estado (`status_reason` con status scheduled o sending).
export const WAIT_REASONS = Object.freeze({
  brand_off: 'Las difusiones o la automatización de la marca están apagadas',
  waiting_template: 'Esperando la aprobación de Meta',
  outside_hours: 'Fuera del horario de envío de la marca',
  daily_limit: 'Se alcanzó el límite diario de mensajes del número',
  batch_pause: 'Pausa entre tandas',
});

// Detención automática (§5.10).
export const STOP_REASONS = Object.freeze({
  template_paused: 'Meta pausó la plantilla por baja calidad',
  template_disabled: 'Meta desactivó la plantilla',
  template_rejected: 'La plantilla ya no está aprobada en Meta',
  template_missing: 'Meta no tiene esa plantilla aprobada con ese nombre e idioma',
  template_mismatch: 'La plantilla de Meta no coincide con la del CRM: sincroniza y revisa sus datos',
  template_not_approved_in_time: 'La plantilla no se aprobó a tiempo',
  number_restricted: 'Meta restringió el número o la cuenta',
  number_paused: 'El número está en pausa en el CRM',
  payment_problem: 'Meta reporta un problema con el método de pago',
  token_invalid: 'El acceso a Meta venció o no tiene permiso',
  header_unavailable: 'La imagen o el archivo del encabezado ya no se puede enviar',
  high_failure_rate: 'Demasiados fallos seguidos; se detuvo para cuidar el número',
  budget_exceeded: 'Se alcanzó el presupuesto mensual de la marca',
  whatsapp_off: 'WhatsApp real está apagado',
  quality_low: 'La calidad del número no permite enviar promociones',
});

export const FAIL_KINDS = Object.freeze({
  meta: 'Rechazo de Meta',
  unconfirmed: 'No se pudo confirmar si salió. No se reintentó para no duplicarlo.',
  network: 'No hubo conexión con Meta',
  retry_window_ended: 'Terminó el periodo de reintento',
  error: 'Error al preparar el envío',
});

// Códigos de Meta → qué hace el motor (apéndice B). `recipient`: failed | requeue (vuelve a la cola sin gastar el
// intento) | cap (131049: se difiere si hay reintento, si no falla). `stop`: la campaña se detiene con ese motivo.
const META_CODES = [
  [[131049], { recipient: 'cap', label: 'WhatsApp limitó los mensajes promocionales para esta persona.' }],
  [[131026], { recipient: 'failed', label: 'No se pudo entregar: el número no tiene WhatsApp o bloqueó al negocio.' }],
  [[131050], { recipient: 'failed', label: 'La persona pidió en WhatsApp dejar de recibir promociones.' }],
  [[130472], { recipient: 'failed', label: 'WhatsApp no le entrega promociones a este número por ahora.' }],
  [[131056], { recipient: 'requeue', delayMs: 10 * MINUTE, label: 'Demasiados mensajes seguidos a la misma persona.' }],
  [[130429, 4, 80007], { recipient: 'requeue', delayMs: MINUTE, label: 'Se alcanzó el límite de velocidad de envío.' }],
  [[131000, 131016, 131057], { recipient: 'requeue', backoff: true, label: 'WhatsApp no estuvo disponible.' }],
  [[131048, 131031, 368, 133010, 131045], { recipient: 'requeue', stop: 'number_restricted' }],
  [[132015], { recipient: 'requeue', stop: 'template_paused' }],
  [[132016], { recipient: 'requeue', stop: 'template_disabled' }],
  [[132001], { recipient: 'requeue', stop: 'template_missing' }],
  [[132007], { recipient: 'requeue', stop: 'template_rejected' }],
  [
    [132000, 132012],
    { recipient: 'failed', streak: 'template_mismatch', label: 'Los datos no coinciden con la plantilla.' },
  ],
  [[131053, 131052], { recipient: 'failed', streak: 'header_unavailable', label: 'WhatsApp no aceptó el archivo.' }],
  [[131042], { recipient: 'requeue', stop: 'payment_problem' }],
  [[190, 10, 200, 131005], { recipient: 'requeue', stop: 'token_invalid' }],
  [[132005], { recipient: 'failed', label: 'El texto con sus datos quedó demasiado largo.' }],
  [[131030], { recipient: 'failed', label: 'El número no está en la lista de destinatarios del número de prueba.' }],
  [[130497], { recipient: 'failed', label: 'Meta restringe los envíos a ese país.' }],
  [[131021], { recipient: 'failed', label: 'El destinatario es el mismo número que envía.' }],
];
const BY_CODE = new Map(META_CODES.flatMap(([codes, rule]) => codes.map(code => [code, rule])));
// Códigos que no cuentan para la detención por tasa de fallos: son de la persona, no del número (§5.10).
export const PERSONAL_CODES = Object.freeze([131049, 131026]);

export function classifyMetaError(code, message = '') {
  const rule = BY_CODE.get(Number(code));
  if (rule) return { ...rule, label: rule.label ?? STOP_REASONS[rule.stop] ?? String(message).slice(0, 200) };
  return { recipient: 'failed', label: String(message || 'Meta rechazó el mensaje.').slice(0, 200) };
}

// Espera de los reintentos por un fallo pasajero: 1, 5 y 15 minutos; al cuarto intento, fallido.
export const BACKOFF_MS = Object.freeze([MINUTE, 5 * MINUTE, 15 * MINUTE]);

// Carga del botón de respuesta rápida de una difusión: c:<destinatario>:<índice>.
const PAYLOAD = /^c:([0-9a-f]{32}):(\d)$/;
export const buttonPayload = (recipientId, index) => `c:${recipientId}:${index}`;
export function parsePayload(value) {
  const m = typeof value === 'string' ? value.match(PAYLOAD) : null;
  return m ? { recipientId: m[1], index: Number(m[2]) } : null;
}
// Lo que viaja como biz_opaque_callback_data: tc:<destinatario>:<intento>.
const CALLBACK = /^tc:([0-9a-f]{32}):(\d{1,3})$/;
export const callbackOf = (recipientId, attempt) => `tc:${recipientId}:${attempt}`;
export function parseCallback(value) {
  const m = typeof value === 'string' ? value.match(CALLBACK) : null;
  return m ? { recipientId: m[1], attempt: Number(m[2]) } : null;
}

// Hora local «HH:MM» de un instante en una zona IANA.
export function localClock(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at))
    .reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  return `${parts.hour}:${parts.minute}`;
}
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isClock = value => typeof value === 'string' && CLOCK.test(value);
const minutesOf = clock => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
// ¿Es horario de silencio? `start`–`end` puede cruzar la medianoche (21:00–08:00). Iguales = sin horario de silencio.
export function inQuietHours(at, timeZone, start, end) {
  if (!isClock(start) || !isClock(end) || start === end) return false;
  const now = minutesOf(localClock(at, timeZone));
  const a = minutesOf(start),
    b = minutesOf(end);
  return a < b ? now >= a && now < b : now >= a || now < b;
}

// Cubeta de fichas: `ratePerMinute` envíos por minuto, con una ráfaga de un segundo como mucho. Empieza llena.
export function createBucket(ratePerMinute, at) {
  const rate = Math.max(1, Number(ratePerMinute) || 1);
  const capacity = Math.max(1, Math.ceil(rate / 60));
  let tokens = capacity,
    last = at;
  return {
    available(now) {
      tokens = Math.min(capacity, tokens + ((now - last) * rate) / MINUTE);
      last = now;
      return Math.floor(tokens + 0.05); // tolera el desfase del reloj: un tic de 990 ms no pierde su envío
    },
    take(n) {
      tokens -= n; // la deuda se paga en la siguiente recarga: el ritmo medio es exacto
    },
    rate,
  };
}

// ¿Hay que detener por tasa de fallos? `outcomes`: los últimos resultados (true = falló), más reciente primero. Mira
// hasta 50 y exige al menos 10 para no detener por los tres primeros envíos.
export function tooManyFailures(outcomes, pct = 50) {
  const last = outcomes.slice(0, 50);
  if (last.length < 10) return false;
  const failed = last.filter(Boolean).length;
  return failed * 100 > last.length * Math.min(100, Math.max(1, pct));
}

// Teléfono enmascarado para quien no tiene contacts.phone: los dos últimos dígitos.
export const maskDigits = value => {
  const d = String(value || '').replace(/\D/g, '');
  return d ? '••••' + d.slice(-2) : '';
};

// Opciones de una difusión (§5.3), validadas. `admin` puede elegir sendHours 'any'.
export function normalizeOptions(input = {}, current = {}, { admin = false } = {}) {
  const src = { ...current, ...(input && typeof input === 'object' ? input : {}) };
  const problems = [];
  const mode = src.mode === 'rehearsal' ? 'rehearsal' : src.mode === undefined || src.mode === 'live' ? 'live' : null;
  if (!mode) problems.push(['mode', 'El modo es «live» o «rehearsal» (ensayo).']);
  let rate = src.ratePerMinute === undefined || src.ratePerMinute === null ? null : Number(src.ratePerMinute);
  if (rate !== null && !(Number.isInteger(rate) && rate >= 6 && rate <= 600))
    problems.push(['ratePerMinute', 'El ritmo va de 6 a 600 mensajes por minuto.']);
  const batchSize = src.batchSize === undefined || src.batchSize === null ? null : Number(src.batchSize);
  const batchPause =
    src.batchPauseMinutes === undefined || src.batchPauseMinutes === null ? null : Number(src.batchPauseMinutes);
  if ((batchSize === null) !== (batchPause === null))
    problems.push(['batchSize', 'Las tandas llevan tamaño y pausa a la vez.']);
  else if (batchSize !== null) {
    if (!(Number.isInteger(batchSize) && batchSize >= 50 && batchSize <= 5000))
      problems.push(['batchSize', 'Cada tanda lleva de 50 a 5,000 personas.']);
    if (!(Number.isInteger(batchPause) && batchPause >= 5 && batchPause <= 1440))
      problems.push(['batchPauseMinutes', 'La pausa entre tandas va de 5 a 1,440 minutos.']);
  }
  const retry = Boolean(src.retry?.enabled);
  const sendHours = src.sendHours === 'any' ? 'any' : 'brand';
  if (sendHours === 'any' && current.sendHours !== 'any' && !admin)
    problems.push(['sendHours', 'Sólo administración puede enviar fuera del horario de la marca.']);
  if (rate === null) rate = undefined;
  return {
    problems,
    options: {
      mode: mode || 'live',
      ...(rate ? { ratePerMinute: rate } : {}),
      batchSize,
      batchPauseMinutes: batchPause,
      retry: { enabled: retry },
      sendHours,
      ...(src.origin === 'api' ? { origin: 'api' } : {}),
    },
  };
}
