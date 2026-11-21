// Textos del asistente (docs/PLAN_MENSAJES_AMABLES.md). Un solo lugar para lo que el asistente le escribe al cliente cuando no hay una
// plantilla aprobada de Contenido: tono cercano, la información necesaria y, cuando aplica, el siguiente paso hacia la inscripción.
// Reglas que estos textos respetan:
//  · Precio, fecha, docente y promoción salen SIEMPRE del catálogo vigente (el contexto `ctx`), nunca de un texto fijo.
//  · No prometen lo que el sistema no hace: no confirman pagos por su cuenta ni apartan lugares.
//  · Es un laboratorio: donde hay dinero o una oferta se dice, una vez y en corto, que es de prueba. Una marca en modo real
//    (docs/PLAN_MODO_REAL.md) no lo dice: server/lib/real-mode.mjs pasa cada texto por LAB_SWAPS (al final de este
//    archivo) y quita las oraciones de aviso. Un texto nuevo con aviso de prueba lleva su equivalente real en LAB_SWAPS
//    si quitar la oración no basta.
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
// `accessSoon`: la apertura entrega sus accesos sola al confirmar (server/modules/course-access); si no, llegan después.
export function paymentConfirmed({ name, reference, course, edition, perSession = false, accessSoon = false }) {
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
    (accessSoon
      ? '.\nEnseguida te mando por aquí tus accesos; los recordatorios llegarán antes de empezar.'
      : '.\nEl equipo coordinador te enviará por aquí los accesos y los recordatorios antes de empezar.') +
    '\n\nPago de prueba: no se realizó ningún cobro real.'
  );
}

// ---- Modo real por marca (docs/PLAN_MODO_REAL.md): cambios exactos que server/lib/real-mode.mjs aplica antes de quitar las
// oraciones de aviso. Sólo hace falta una entrada cuando el texto de laboratorio promete algo que en una marca real no existe
// (tarjeta u OXXO simulados, «Paga aquí» con un botón de pago de prueba); los avisos sueltos se quitan solos.
export const REAL_PAYMENT_METHODS =
  'Al inscribirte te mando tu pedido con un enlace donde verás cómo pagar. Cuando hayas pagado, envía tu comprobante por este chat y una persona del equipo lo valida. Si quieres empezar, escribe «Quiero inscribirme».';
export const LAB_SWAPS = Object.freeze([
  [paymentMethods, REAL_PAYMENT_METHODS],
  [
    '\nSi prefieres transferencia, envía tu comprobante por este chat y una persona lo valida.\n\nPago de prueba: no se cobra nada real.',
    '\nCuando hayas pagado, envía tu comprobante por este chat y una persona del equipo lo valida.',
  ],
  ['\n\nPaga aquí: ', '\n\nCómo pagar: '],
  ['Paga aquí (simulado): ', 'Cómo pagar: '],
]);

// ---- Respuestas de venta y posventa (docs/PLAN_RESPUESTAS_DE_VENTA.md). Mismas reglas que todo el archivo: los datos
// salen del catálogo o del pedido real, nada confirma un pago, nada aparta un lugar y lo que no consta lo dice una
// persona. Ninguno de estos textos lleva aviso de prueba propio (el que acompaña a un precio es PRICE_NOTE).
const refOf = reference => (reference ? ' ' + reference : '');
// «Ya pagué», «ya hice la transferencia»: acuse, estado real del pedido y pase a una persona, que es quien valida.
export function paidAck({ reference = null, status = null } = {}) {
  return (
    'Gracias por avisar. Una persona del equipo revisará tu pago y te confirmará por aquí; no confirmamos pagos de forma automática.' +
    (status === 'review'
      ? ' Tu pedido' + refOf(reference) + ' ya está en revisión.'
      : (status === 'pending' ? ' Tu pedido' + refOf(reference) + ' todavía aparece sin pago confirmado.' : '') +
        ' Si tienes tu comprobante, puedes enviarlo en este chat.')
  );
}
// «¿Ya verificaron mi pago?»: el estado que dice el pedido, sin confirmar nada por cuenta propia.
export function payStatus(state, { reference = null, course = '', edition = '' } = {}) {
  if (state === 'paid')
    return (
      'Tu pedido' +
      refOf(reference) +
      ' ya aparece con el pago confirmado y tu inscripción a ' +
      course +
      (edition ? ' · ' + edition : '') +
      ' está activa. Si te falta algo, dime y te ayudo.'
    );
  if (state === 'review')
    return (
      'Tu comprobante del pedido' +
      refOf(reference) +
      ' está en revisión. Ya le avisé al equipo para que lo revise y te confirme por aquí; no confirmamos pagos de forma automática.'
    );
  if (state === 'pending')
    return (
      'Todavía no veo un comprobante en tu pedido' +
      refOf(reference) +
      '. Si ya pagaste, mándame por aquí la foto o captura del comprobante y una persona del equipo lo revisa.'
    );
  return 'No encuentro un pedido en este chat, así que le pasé tu mensaje a una persona del equipo para que revise tu pago. Te escribe por aquí.';
}
// «Mañana pago», «en la quincena»: sin presionar y con el siguiente paso. No aparta el lugar: se asegura al confirmar el pago.
export function payLater(name, { reference = null, until = null, hold = false, canOrder = true } = {}) {
  const asked = hold ? ' El lugar queda asegurado cuando se confirma el pago.' : '';
  return reference
    ? '¡Perfecto' +
        hi(name) +
        ', sin problema! Tu pedido' +
        refOf(reference) +
        (until ? ' sigue vigente hasta el ' + until + '.' : ' sigue vigente.') +
        asked +
        ' Cuando pagues, mándame tu comprobante por aquí y una persona del equipo lo valida.'
    : '¡Claro' +
        hi(name) +
        ', sin prisa!' +
        asked +
        (canOrder
          ? ' Cuando estés listo, escribe «Quiero inscribirme» y te mando tu enlace de pago.'
          : ' Cuando estés listo, escríbeme por aquí y seguimos.');
}
// Factura, meses o pagos en partes, varias personas, datos de la cuenta: si no hay una respuesta aprobada, lo dice una persona.
const ADVISOR = {
  invoice: 'Lo de la factura te lo confirma una persona del equipo para no darte un dato equivocado.',
  installments:
    'Las opciones para pagar en partes o a meses te las confirma una persona del equipo para no darte un dato equivocado.',
  group:
    'Con gusto. Para inscribir o pagar por varias personas te ayuda una persona del equipo, así cada quien queda con su lugar.',
  account: 'Los datos para depositar o transferir te los comparte una persona del equipo.',
  discount: 'Si hay alguna opción para grupos o un precio especial, te lo confirma una persona del equipo.',
};
export const paymentAdvisor = kind => (ADVISOR[kind] || ADVISOR.invoice) + ' Ya le avisé y te escribe por aquí.';
// «¿Hay descuento?» sin promoción vigente: se dice claro, con el precio del catálogo.
export const noPromotion = ctx =>
  priceBody(ctx) +
  ' Por ahora no hay una promoción vigente para esta apertura.\n\n' +
  ENROLL_CTA +
  ' Si buscas un precio especial (por ser estudiante o por grupo), escribe «asesor» y una persona del equipo te dice si aplica.\n' +
  PRICE_NOTE;
// Validez del certificado: lo que consta (digital, emisor, folio y QR) y nada más. Nunca se afirma validez oficial.
export const validity = (ctx, issuer) =>
  'El certificado que emitimos es digital: lo emite ' +
  issuer +
  ', lleva folio y un código QR para verificarlo en línea. Sobre su validez ante la SEP, para tu cédula, puntos o valor curricular no te puedo confirmar nada por aquí. Si lo necesitas para un trámite, escribe «asesor» y una persona del equipo te dice exactamente qué ampara.';
// Datos para la constancia: se acusa lo que se anotó, sin crear pedidos ni repetir el texto del certificado.
export function certDataThanks(name, data, { enrolled = false, order = false } = {}) {
  const got = [
    data.name ? 'tu nombre «' + data.name + '» para tu certificado' : '',
    data.email ? 'tu correo' : '',
    data.phone ? 'tu teléfono' : '',
  ].filter(Boolean);
  const list = got.length > 1 ? got.slice(0, -1).join(', ') + ' y ' + got[got.length - 1] : got[0];
  return (
    '¡Gracias' +
    hi(name) +
    '! Anoté ' +
    list +
    '.' +
    (enrolled
      ? ' Queda junto con tu inscripción; si algo cambia, escríbemelo por aquí.'
      : order
        ? ' Lo dejo junto con tu pedido; si algo cambia, escríbemelo por aquí.'
        : ' Cuando quieras apartar tu lugar, escribe «Quiero inscribirme».')
  );
}
export const certDataAsk =
  'Claro. Escríbeme en un solo mensaje tu nombre completo tal como quieres que aparezca en tu certificado (con acentos y mayúsculas donde van), tu correo y tu teléfono.';
// Accesos después de pagar.
export const accessResend = (name, text) => 'Claro' + hi(name) + ', aquí tienes de nuevo tus accesos:\n\n' + text;
export const accessPending =
  'Tu inscripción está activa, pero tus accesos todavía no están listos en este chat. Ya le avisé al equipo para que te los envíe por aquí.';
export const accessProblem = name =>
  'Lamento la falla' + hi(name) + '. Ya le avisé al equipo para que lo revise contigo y te escriba por aquí.';
export const accessAfterPayment = (reference, status) =>
  'Tus accesos llegan por este chat cuando tu pago queda confirmado.' +
  (status === 'review'
    ? ' Tu comprobante del pedido' + refOf(reference) + ' está en revisión; ya le avisé al equipo.'
    : ' Tu pedido' +
      refOf(reference) +
      ' todavía aparece sin pago confirmado: cuando pagues, mándame tu comprobante por aquí.');
export const accessUnknown =
  'No encuentro una inscripción activa en este chat, así que le pasé tu mensaje a una persona del equipo para que lo revise. Te escribe por aquí.';
// Mientras la conversación espera a una persona: un acuse por espera, sin retomar la conversación.
export const waitingAck = (name, { reference = null, review = false } = {}) =>
  'Gracias por tu mensaje' +
  hi(name) +
  '. Ya le avisé al equipo; en cuanto una persona esté disponible te contesta por aquí.' +
  (review ? ' Tu comprobante del pedido' + refOf(reference) + ' sigue en revisión.' : '');
// «Gracias» de alguien ya inscrito: no se le ofrece «ver el precio o inscribirte».
export const thanksEnrolled = name => '¡Con gusto' + hi(name) + '! Aquí estoy si necesitas algo más.';
// Fechas que no son «¿cuándo empieza?».
export const deadline = ctx =>
  scheduleBody(ctx) +
  '\n\n' +
  (startText(ctx.edition) !== null
    ? 'Las inscripciones siguen abiertas mientras haya lugar y hasta que empiece el curso. ¿Quieres apartar tu lugar? Escribe «Quiero inscribirme».'
    : 'Las inscripciones siguen abiertas. ¿Quieres apartar tu lugar? Escribe «Quiero inscribirme».');
export const nextEdition = ctx =>
  scheduleBody(ctx) +
  '\n\nPor ahora ésta es la fecha que tengo abierta de ' +
  ctx.course.title +
  '. Si buscas otra, escribe «asesor» y una persona del equipo te dice cuándo es la siguiente.';
export const notifyNext = (ctx, name) =>
  'Con gusto' +
  hi(name) +
  '. Le pedí al equipo que te avise de la siguiente fecha de ' +
  ctx.course.title +
  '; una persona te escribe por aquí.';
// «No tengo tiempo», «estoy de guardia»: la respuesta aprobada de la grabación si existe y la puerta a otra fecha.
export const timeObjection = (ctx, recording = '') =>
  'Te entiendo.' +
  (recording ? '\n\n' + recording : '') +
  '\n\nSi estas fechas no te acomodan, escribe «asesor» y una persona del equipo te dice cuándo es la siguiente apertura de ' +
  ctx.course.title +
  '.';
// Duración con el calendario de la apertura que ya se conoce (sin pedir «dime qué edición»).
// Los renglones de fin y sesiones (también se añaden a la ficha de fechas cuando preguntan las dos cosas).
export function durationExtra(ctx, sessions = 0) {
  const e = ctx.edition,
    end = e.ends_at ? startText({ ...e, starts_at: e.ends_at }) : null;
  return (end ? '\n• Termina: ' + end : '') + (sessions ? '\n• Sesiones: ' + sessions : '');
}
export const durationBody = (ctx, sessions = 0) =>
  title(ctx) + '\n• Inicio: ' + (startText(ctx.edition) || 'fecha por confirmar') + durationExtra(ctx, sessions);
export const duration = (ctx, sessions = 0) =>
  durationBody(ctx, sessions) + '\n\n¿Quieres apartar tu lugar? Escribe «Quiero inscribirme».';
// Cupo cuando el catálogo sabe el tamaño del grupo pero no los lugares que quedan.
export const seatsCapacity = ctx =>
  'Las inscripciones de ' +
  title(ctx) +
  ' están abiertas y el grupo es de ' +
  ctx.edition.capacity +
  ' lugares, así que el cupo es limitado. ' +
  ENROLL_CTA;
// Recomendar cursos de la marca con lo que la persona dice (especie o tema), con inicio y precio vigentes.
export function recommend(ctx, items, { multi = false } = {}) {
  return (
    'Por lo que me cuentas, te pueden servir estos cursos de ' +
    ctx.brand.name +
    ':\n\n' +
    items.map(i => '• ' + i.title + ' — inicia ' + (i.start || 'en fecha por confirmar') + ' · ' + i.price).join('\n') +
    '\n\n' +
    (multi
      ? 'Responde con el nombre del que te interesa y te paso su información.'
      : 'Este chat es sobre ' +
        ctx.course.title +
        '. Si te interesa otro, escribe «asesor» y una persona te da los detalles.') +
    '\n' +
    PRICE_NOTE
  );
}
export const askTopic = ctx =>
  'Con gusto te recomiendo. ¿Con qué especie o tema trabajas, o cuál te gustaría aprender? Así te digo cuál de los cursos de ' +
  ctx.brand.name +
  ' te conviene.';
export const jobs = ctx =>
  'Gracias por escribirnos. Por este chat sólo atiendo información e inscripciones a los cursos de ' +
  ctx.brand.name +
  ', así que no manejo vacantes ni colaboraciones. Si tienes una duda de algún curso, aquí estoy.';
