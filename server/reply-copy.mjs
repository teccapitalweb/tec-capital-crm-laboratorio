// Textos del asistente (docs/PLAN_MENSAJES_AMABLES.md). Un solo lugar para lo que el asistente le escribe al cliente cuando no hay una
// plantilla aprobada de Contenido: tono cercano, la información necesaria y, cuando aplica, el siguiente paso hacia la inscripción.
// Reglas que estos textos respetan:
//  · Precio, fecha, docente y promoción salen SIEMPRE del catálogo vigente (el contexto `ctx`), nunca de un texto fijo.
//  · No prometen lo que el sistema no hace: no confirman pagos por su cuenta ni apartan lugares.
//  · Es un laboratorio: donde hay dinero o una oferta se dice, una vez y en corto, que es de prueba.
// Funciones puras: reciben datos y devuelven texto; no leen la base ni la red.

const money = (cents, currency) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency, minimumFractionDigits: 2 }).format(cents / 100) +
  ' ' +
  currency;
const ZONES = {
  'America/Mexico_City': 'hora del centro de México',
  'America/Monterrey': 'hora del centro de México',
  'America/Cancun': 'hora de Cancún',
  'America/Tijuana': 'hora de Tijuana',
  'America/Bogota': 'hora de Colombia',
  'America/Lima': 'hora de Perú',
  'Europe/Madrid': 'hora de España',
};
const MODALITY = { online: 'En línea', in_person: 'Presencial', hybrid: 'Híbrida' };

// Nombre de pila para saludar, sólo si parece un nombre (no un alias como «miguel.admin2»).
export const firstName = name => {
  const f =
    String(name || '')
      .trim()
      .split(/\s+/)[0] || '';
  return /^[\p{L}'’-]{2,20}$/u.test(f) ? f : '';
};
const hi = name => {
  const f = firstName(name);
  return f ? ', ' + f : '';
};

// «martes, 1 de diciembre de 2026, 7:00 p.m. (hora del centro de México)», o null si la edición no tiene fecha.
export const noHour = (t, zone) =>
  new Intl.DateTimeFormat('en-US', {
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone || 'America/Mexico_City',
  }).format(t) === '00:00';
export function startText(edition) {
  if (edition?.starts_at === null || edition?.starts_at === undefined) return null;
  const zone = edition.timezone || 'America/Mexico_City';
  // Medianoche exacta en la zona de la edición significa «sólo se sabe el día»: no se dice «12:00 a.m.».
  if (noHour(edition.starts_at, zone))
    return new Intl.DateTimeFormat('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: zone,
    }).format(edition.starts_at);
  return (
    new Intl.DateTimeFormat('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: zone,
    }).format(edition.starts_at) +
    ' (' +
    (ZONES[zone] || zone) +
    ')'
  );
}
const shortDay = (t, zone) =>
  new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', timeZone: zone || 'America/Mexico_City' }).format(
    t,
  );

export function priceText(ctx) {
  const p = ctx.promotion,
    e = ctx.edition;
  return (
    money(ctx.priceCents, ctx.currency || e.currency) +
    (p
      ? ' con la promoción «' +
        p.name +
        '»' +
        (p.ends_at ? ', vigente hasta el ' + shortDay(p.ends_at, e.timezone) : '')
      : '')
  );
}
// Datos de la edición en renglones; lo que no se sabe se omite o se dice claro, sin «Por confirmar» sueltos.
export function facts(ctx, { price = true } = {}) {
  const e = ctx.edition,
    start = startText(e),
    legacy = ctx.dateLabel && !/por confirmar/i.test(ctx.dateLabel) ? ctx.dateLabel : null,
    lines = [];
  lines.push('• Inicio: ' + (start || legacy || 'fecha por confirmar'));
  if (e.instructor) lines.push('• Docente: ' + e.instructor);
  if (MODALITY[e.modality]) lines.push('• Modalidad: ' + MODALITY[e.modality] + (e.location ? ' · ' + e.location : ''));
  if (price) lines.push('• Precio: ' + priceText(ctx));
  return lines;
}
const title = ctx => ctx.course.title + ' · ' + ctx.edition.name;
export const LAB_NOTE = 'Chat de prueba: los precios y las fechas son de ejemplo.';

// Ficha del curso que acompaña a la bienvenida.
export const card = ctx => title(ctx) + '\n' + facts(ctx).join('\n') + '\n\n' + LAB_NOTE;
export const welcome = (ctx, name) =>
  ctx.course.welcome.replaceAll('{{nombre}}', firstName(name) || 'qué tal').replaceAll('{{curso}}', ctx.course.title) +
  '\n\n' +
  card(ctx);

// Cada respuesta tiene un CUERPO (el dato) y un CIERRE (el siguiente paso). Por separado sirven para contestar varias preguntas en un mensaje.
const ENROLL_CTA = 'Si quieres apartar tu lugar, escribe «Quiero inscribirme» y te mando tu enlace de pago.';
const PRICE_NOTE = '(Precio de ejemplo: este es un chat de prueba.)';
export const priceBody = ctx => 'El precio de ' + title(ctx) + ' es de ' + priceText(ctx) + '.';
export const price = ctx => priceBody(ctx) + '\n\n' + ENROLL_CTA + '\n' + PRICE_NOTE;

export function syllabusBody(ctx) {
  const items = String(ctx.course.syllabus || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => (/^([•\-–*]|\d+[.)])\s/.test(l) ? l : '• ' + l));
  return 'Esto es lo que verás en ' + ctx.course.title + ':\n\n' + items.join('\n');
}
export const syllabus = ctx => syllabusBody(ctx) + '\n\n¿Te cuento el precio o las fechas?';
export function scheduleBody(ctx) {
  const lines = facts(ctx, { price: false });
  if (!ctx.edition.instructor) lines.splice(1, 0, '• Docente: por confirmar');
  return title(ctx) + '\n' + lines.join('\n');
}
export const schedule = ctx =>
  scheduleBody(ctx) +
  '\n\n' +
  (startText(ctx.edition) !== null
    ? '¿Quieres apartar tu lugar? Escribe «Quiero inscribirme».'
    : 'En cuanto se confirme la fecha te avisamos por aquí. Mientras tanto, ¿te cuento el precio o el temario?');

// Varias preguntas en un mismo mensaje («¿qué temas incluye y tiene certificado?»): se contestan todas, en el orden en que se reconocen,
// con un solo cierre. `parts` son cuerpos ya armados (del catálogo o respuestas aprobadas del conocimiento).
export function several(parts, { price = false } = {}) {
  return (
    parts.join('\n\n') +
    '\n\n' +
    (price
      ? ENROLL_CTA + '\n' + PRICE_NOTE
      : 'Si quieres apartar tu lugar, escribe «Quiero inscribirme». ¿Te ayudo con algo más?')
  );
}

export const enrollWithOrder = (ctx, name) => '¡Qué gusto' + hi(name) + '! Ya tengo listo tu pedido:\n\n{{pedido}}';
export const orderReminder = () => 'Tu pedido sigue vigente. Aquí lo tienes de nuevo:\n\n';
export const enrollWithAdvisor = (ctx, name) =>
  '¡Qué gusto' +
  hi(name) +
  '! Anoté tu interés en ' +
  title(ctx) +
  '. Un asesor te escribe por aquí para completar tu inscripción.\n(Chat de prueba: no se realizan cobros reales.)';

export const paymentMethods =
  'Puedes pagar con tarjeta u OXXO desde el enlace que te mando al inscribirte, o por transferencia enviando tu comprobante por este chat. Si quieres empezar, escribe «Quiero inscribirme».';
export const paymentWithAdvisor =
  'Con gusto te paso las formas de pago: ya le avisé a un asesor para que te escriba por aquí.';

export const thanks = name =>
  '¡Con gusto' + hi(name) + '! Aquí sigo por si quieres ver el precio, las fechas o inscribirte.';
// Segundo «gracias» u «ok» seguido: no se repite el mismo texto.
export const thanksAgain = '¡Perfecto! Cualquier cosa, aquí estoy.';

// ---- Mensajes de trato (docs/PLAN_ASISTENTE_SIN_CALLEJONES.md): contestan «sí», «no», «espera», «¿sigues ahí?», «¿eres un bot?»… sin tratarlos
// como una pregunta sin respuesta. Ninguno promete nada: no apartan lugares, no ofrecen descuentos y no dicen que ya viene una persona.
export const affirm = ctx => '¡Perfecto! ¿Qué te cuento de ' + ctx.course.title + '?';
export const decline = name =>
  'Sin problema' + hi(name) + '. Si más adelante quieres retomarlo, escríbeme por aquí y lo vemos con gusto.';
export const later = name =>
  '¡Claro' + hi(name) + ', sin prisa! Aquí te queda la información; cuando quieras seguir, escríbeme por este chat.';
export const bye = name => '¡Hasta pronto' + hi(name) + '! Aquí estaré si necesitas algo más.';
export const help = ctx =>
  'Aquí estoy para ayudarte. Puedo contarte el precio, el temario o las fechas de ' +
  ctx.course.title +
  ', o ayudarte a inscribirte. ¿Qué necesitas saber?';
export const menu = ctx => 'Esto es lo que te puedo contar de ' + ctx.course.title + ':';
export const identity = ctx =>
  'Soy el asistente automático de ' +
  ctx.brand.name +
  ': respondo al momento sobre el precio, el temario y las fechas, y te ayudo a inscribirte. Si prefieres que te atienda una persona del equipo, escribe «asesor».';
// Cupo: sólo lo que dice el catálogo. Con muchos lugares no se da la cifra; con pocos sí, sin decir que queda apartado.
export function seats(ctx) {
  const n = ctx.edition.available_seats;
  if (n === null || n === undefined)
    return (
      'Las inscripciones de ' +
      title(ctx) +
      ' están abiertas. No tengo a la mano el número exacto de lugares; si quieres que te lo confirme una persona, escribe «asesor».'
    );
  if (n <= 0)
    return (
      'Por ahora no quedan lugares en ' +
      title(ctx) +
      '. Si quieres que una persona te proponga otra fecha, escribe «asesor».'
    );
  return (
    'Todavía hay lugar en ' +
    title(ctx) +
    (n <= 10 ? ': ' + (n === 1 ? 'queda 1 lugar' : 'quedan ' + n + ' lugares') + ' al momento de responderte' : '') +
    '. ' +
    ENROLL_CTA
  );
}
export const courses = (ctx, titles) =>
  titles.length
    ? 'En ' +
      ctx.brand.name +
      ' también tenemos:\n' +
      titles.map(t => '• ' + t).join('\n') +
      '\n\nEste chat es sobre ' +
      ctx.course.title +
      '. Si te interesa otro, escribe «asesor» y una persona te da los detalles.'
    : 'Por ahora ' +
      ctx.course.title +
      ' es el curso que tenemos abierto en ' +
      ctx.brand.name +
      '. ¿Te cuento el precio o las fechas?';
// ---- Un número de WhatsApp para toda la marca (docs/PLAN_NUMERO_POR_CONSULTORA.md): se pregunta el curso antes de hablar de precios o fechas.
const numbered = titles => titles.map((t, i) => i + 1 + '. ' + t).join('\n');
export const chooseCourse = (brand, titles, { again = false } = {}) =>
  (again
    ? 'Para darte la información correcta necesito saber qué curso te interesa:'
    : '¡Hola! Soy el asistente de ' + brand + '. ¿Sobre qué curso te gustaría información?') +
  '\n\n' +
  numbered(titles) +
  '\n\nResponde con el número o el nombre del curso.' +
  (again ? ' Si prefieres que te atienda una persona, escribe «asesor».' : '');
export const courseMenu = (ctx, titles) =>
  'Estos son los cursos de ' +
  ctx.brand.name +
  ':\n\n' +
  numbered(titles) +
  '\n\nAhora estamos viendo ' +
  ctx.course.title +
  '. Para cambiar, responde con el número o el nombre del curso.';
// Nombró algo que comparten varios cursos («el de reptiles»): se le ofrecen sólo ésos.
export const whichCourse = titles =>
  'Tenemos ' +
  titles.length +
  ' cursos de ese tema. ¿Cuál te interesa?\n\n' +
  numbered(titles) +
  '\n\nResponde con el número o el nombre del curso.';
export const switchBlocked = (ctx, other) =>
  'Tienes un pedido pendiente de ' +
  ctx.course.title +
  '. Para cambiarte a ' +
  other +
  ', escribe «asesor» y una persona te ayuda.';
export const objection = ctx =>
  'Te entiendo. El precio vigente de ' +
  title(ctx) +
  ' es de ' +
  priceText(ctx) +
  '. Por este chat no puedo ofrecerte otro precio, pero una persona del equipo puede revisar las opciones contigo: escribe «asesor» y le aviso.\n' +
  PRICE_NOTE;

// ---- Cuando no hay respuesta: primero opciones, después se PREGUNTA si quiere una persona, y sólo al final se pasa.
export const fallback = ctx =>
  'Esa pregunta todavía no la tengo a la mano. Lo que sí puedo contarte ahora mismo es el precio, el temario o las fechas de ' +
  ctx.course.title +
  '. Si prefieres que te responda una persona, escribe «asesor».';
export const offerHuman =
  'Perdona, no logré darte una buena respuesta. ¿Quieres que te pase con una persona del equipo para que te atienda directamente?';
export const escalate =
  'Para no hacerte dar más vueltas, le paso tu conversación a una persona del equipo. Te escribe por aquí en cuanto pueda.';
export const human = name =>
  '¡Claro' + hi(name) + '! Ya le avisé al equipo: un asesor te escribe por aquí en cuanto esté disponible.';
// WhatsApp real: llega un audio, un video o un sticker sin texto. Se pide por escrito en lugar de adivinar.
export const unsupportedMedia = what =>
  'Por ahora no puedo abrir ' +
  what +
  ' por aquí. ¿Me lo escribes en un mensaje, por favor? Así te respondo enseguida.';
export const refund = name =>
  'Lamento mucho la molestia' +
  hi(name) +
  '. Ya pasé tu caso a una persona del equipo para que lo revise y te responda por aquí.';
export const unavailable = reason =>
  'Por ahora esta edición no está disponible (' +
  String(reason || '')
    .charAt(0)
    .toLowerCase() +
  String(reason || '').slice(1) +
  '). Ya le avisé a un asesor para que te proponga otra opción.';

// Mensaje del pedido con su enlace de pago y confirmación del pago (los usa server/payments.mjs cuando no hay plantilla aprobada).
export function orderLink({ reference, course, edition, amount, note = '', coupon = '', link, until }) {
  return (
    'Pedido ' +
    reference +
    '\n' +
    course +
    ' · ' +
    edition +
    ' — ' +
    amount +
    note +
    '.' +
    coupon +
    '\n\nPaga aquí: ' +
    link +
    '\nEl enlace vence el ' +
    until +
    (String(until).endsWith('.') ? '' : '.') +
    '\nSi prefieres transferencia, envía tu comprobante por este chat y una persona lo valida.\n\nPago de prueba: no se cobra nada real.'
  );
}
export function paymentConfirmed({ name, reference, course, edition, perSession = false }) {
  return (
    '✅ ¡Pago confirmado' +
    hi(name) +
    '! Tu inscripción a ' +
    course +
    ' · ' +
    edition +
    ' quedó lista' +
    (perSession
      ? ' con plan por sesión: este pago cubre tu primera sesión y el enlace de pago de cada sesión siguiente llegará por aquí antes de la clase'
      : '') +
    '. Pedido ' +
    reference +
    '.\nEl equipo coordinador te enviará por aquí los accesos y los recordatorios antes de empezar.\n\nPago de prueba: no se realizó ningún cobro real.'
  );
}
