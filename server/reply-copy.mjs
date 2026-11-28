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
// El nombre de la zona para una persona: «hora del centro de México»; una zona que no está en la lista se dice por su
// ciudad («America/Guatemala» → «hora de Guatemala»), nunca con el identificador técnico.
// Cuerpo del mensaje corto con los botones cuando el texto no cabe en el cuerpo de unos botones de WhatsApp (1024).
export const BUTTONS_PROMPT = '¿Qué te gustaría hacer?';
// «UTC», «GMT» y las zonas Etc/* se dicen por su desfase real: en «Etc/GMT+6» el signo va al revés (POSIX) y es UTC−6.
export const zoneWords = zone => {
  const z = String(zone || 'America/Mexico_City');
  if (ZONES[z]) return ZONES[z];
  if (/^(Etc\/)?(UTC|UCT|GMT|GMT0|GMT[+-]0|Zulu|Universal|Greenwich)$/i.test(z)) return 'UTC';
  const etc = /^Etc\/GMT([+-])(\d{1,2})$/.exec(z);
  if (etc) return 'UTC' + (etc[1] === '+' ? '−' : '+') + Number(etc[2]);
  return 'hora de ' + z.split('/').pop().replace(/_/g, ' ');
};
const validZone = zone => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
// Un instante dicho para el cliente, en la zona dada: «lunes, 23 de noviembre de 2026, 7:00 p.m. (hora del centro de
// México)»; a medianoche exacta sólo se sabe el día y se dice sin hora. Lo usan la ficha del asistente y {{fecha}}.
// Nunca lanza: una fecha no válida da null (quien llama dice «por confirmar») y una zona que no existe se dice en UTC.
export function whenText(t, zone = 'America/Mexico_City') {
  if (t === null || t === undefined || t === '' || !Number.isFinite(Number(t))) return null;
  t = Number(t);
  if (!Number.isFinite(new Date(t).getTime())) return null;
  zone = zone || 'America/Mexico_City';
  if (!validZone(zone)) zone = 'UTC';
  // Medianoche exacta en la zona de la edición significa «sólo se sabe el día»: no se dice «12:00 a.m.».
  if (noHour(t, zone))
    return new Intl.DateTimeFormat('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: zone,
    }).format(t);
  return (
    new Intl.DateTimeFormat('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: zone,
    }).format(t) +
    ' (' +
    zoneWords(zone) +
    ')'
  );
}
export function startText(edition) {
  if (edition?.starts_at === null || edition?.starts_at === undefined) return null;
  return whenText(edition.starts_at, edition.timezone || 'America/Mexico_City');
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
// ---- Estilo de los mensajes (docs/PLAN_MENSAJES_AMABLES.md, «Estilo»). Por marca, `ctx.style.emojis` (encendido por
// omisión; Operación → Seguimientos → «Mensajes con emojis»). Con emojis: cada dato en su renglón con un emoji y su etiqueta,
// negritas de WhatsApp (*así*) en el nombre del curso y en lo que la persona debe escribir, y un solo siguiente paso; un
// emoji por renglón y pocos por mensaje. Sin emojis: viñetas y texto plano. Los mensajes serios (pago en revisión, queja,
// baja, pasar con una persona) no llevan emojis en ningún caso. Un `ctx` sin estilo se trata como «con emojis».
const on = ctx => !ctx?.style || ctx.style.emojis !== false;
const b = (ctx, t) => (on(ctx) ? '*' + t + '*' : t);
// Lo que la persona debe escribir: en negritas, o entre comillas en texto plano.
const key = (ctx, t) => (on(ctx) ? '*' + t + '*' : '«' + t + '»');
const li = (ctx, emoji, label, value) => (on(ctx) ? emoji + ' ' : '• ') + label + ': ' + value;
const item = (ctx, emoji, text) => (on(ctx) ? emoji + ' ' : '• ') + text;
const step = (ctx, text) => (on(ctx) ? '👉 ' : '') + text;
const MODALITY_EMOJI = { online: '💻', in_person: '📍', hybrid: '🏫' };
// ---- Tono (docs/PLAN_MENSAJES_VENDEDORA.md): «vendedor» es el estilo de las consultoras (título con gancho, promoción
// con el precio anterior tachado, horario sesión por sesión, cupo cuando quedan pocos lugares y «Responde … para asegurar
// tu lugar»); «sereno» es el estilo anterior. Por marca, `ctx.style.tone`; un `ctx` sin estilo es sereno (las funciones
// puras no cambian solas). Nada se inventa: cada renglón sale del catálogo o de Coordinación, y si el dato no existe, no va.
export const seller = ctx => ctx?.style?.tone === 'vendedor';
const strike = (ctx, t) => (on(ctx) ? '~' + t + '~' : t);
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
// El nombre del curso como primer renglón: con gancho en tono vendedor (mayúsculas y emoji), en negritas si no.
const hook = ctx =>
  seller(ctx) ? (on(ctx) ? '🎓 ' : '') + b(ctx, '¡' + title(ctx).toUpperCase() + '!') : b(ctx, title(ctx));
const dayWords = (t, zone) =>
  new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: zone || 'America/Mexico_City',
  })
    .format(t)
    .replace(',', '');
const hourWords = (t, zone) =>
  new Intl.DateTimeFormat('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone || 'America/Mexico_City',
  }).format(t);
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
// Horario sesión por sesión (Coordinación): hasta ocho renglones; con más, cuántas son y de qué día a qué día.
export function sessionLines(ctx) {
  const list = Array.isArray(ctx?.sessions) ? ctx.sessions.filter(x => Number.isFinite(Number(x?.starts_at))) : [];
  if (!list.length) return [];
  const zone = ctx.edition?.timezone || 'America/Mexico_City';
  if (list.length > 8)
    return [
      li(
        ctx,
        '🗓️',
        'Sesiones',
        list.length + ', del ' + dayWords(list[0].starts_at, zone) + ' al ' + dayWords(list.at(-1).starts_at, zone),
      ),
    ];
  return [
    (on(ctx) ? '🗓️ ' : '') + 'Horario:',
    ...list.map(
      x =>
        '• ' +
        cap(dayWords(x.starts_at, zone)) +
        ': ' +
        hourWords(x.starts_at, zone) +
        ' a ' +
        hourWords(Number(x.starts_at) + (Number(x.duration_min) || 90) * 60000, zone),
    ),
  ];
}
const sessionBlock = ctx => {
  const lines = sessionLines(ctx);
  return lines.length ? '\n\n' + lines.join('\n') : ''; // el horario va en su propio bloque
};
// Cupo y cierre, sólo en tono vendedor y sólo con el dato del catálogo: pocos lugares (10 o menos) y, con 3 o menos, el cierre.
export function urgency(ctx) {
  if (!seller(ctx)) return '';
  const n = ctx.edition?.available_seats;
  if (!Number.isInteger(n) || n <= 0 || n > 10) return '';
  const lines = [
    (on(ctx) ? '🎈 ' : '') + 'Cupo limitado: ' + (n === 1 ? 'queda 1 lugar' : 'quedan ' + n + ' lugares') + '.',
  ];
  if (n <= 3) lines.push((on(ctx) ? '✅ ' : '') + '¡Estamos cerrando inscripciones!');
  return lines.join('\n');
}
const withUrgency = (ctx, text) => (urgency(ctx) ? text + '\n\n' + urgency(ctx) : text);
// Datos de la edición en renglones; lo que no se sabe se omite o se dice claro, sin «Por confirmar» sueltos.
export function facts(ctx, { price = true } = {}) {
  const e = ctx.edition,
    start = startText(e),
    legacy = ctx.dateLabel && !/por confirmar/i.test(ctx.dateLabel) ? ctx.dateLabel : null,
    lines = [];
  lines.push(li(ctx, '📅', 'Inicio', start || legacy || 'fecha por confirmar'));
  if (e.instructor) lines.push(li(ctx, '🧑', 'Docente', e.instructor));
  if (MODALITY[e.modality])
    lines.push(
      li(
        ctx,
        MODALITY_EMOJI[e.modality] || '📍',
        'Modalidad',
        MODALITY[e.modality] + (e.location ? ' · ' + e.location : ''),
      ),
    );
  if (price)
    lines.push(
      seller(ctx) && ctx.promotion && before(ctx)
        ? // tono vendedor con promoción: el precio de hoy en negritas y el anterior tachado, en el mismo renglón
          (on(ctx) ? '🔥 ' : '• ') +
            'Precio promocional: ' +
            b(ctx, money(ctx.priceCents, ctx.currency || e.currency)) +
            ' ' +
            strike(ctx, money(ctx.regularPriceCents, ctx.currency || e.currency)) +
            (ctx.promotion.ends_at ? ' · hasta el ' + shortDay(ctx.promotion.ends_at, e.timezone) : '')
        : li(ctx, '💳', 'Precio', priceText(ctx)),
    );
  return lines;
}
const title = ctx => ctx.course.title + ' · ' + ctx.edition.name;
export const LAB_NOTE = 'Chat de prueba: los precios y las fechas son de ejemplo.';

// Ficha del curso que acompaña a la bienvenida.
export const card = ctx =>
  withUrgency(ctx, hook(ctx) + (seller(ctx) ? '\n\n' : '\n') + facts(ctx).join('\n') + sessionBlock(ctx)) +
  '\n\n' +
  (seller(ctx) ? seatCta(ctx) + '\n\n' : '') +
  LAB_NOTE;
// El saludo lo escribe la marca; si viene en un solo párrafo, su pregunta final («¿Quieres conocer…?») pasa a su propio párrafo.
const greeting = t => (/\n/.test(t) ? t : t.replace(/([.!])\s+(¿[^¿?]+\?)\s*$/, '$1\n\n$2'));
export const welcome = (ctx, name) =>
  greeting(
    ctx.course.welcome.replaceAll('{{nombre}}', firstName(name) || 'qué tal').replaceAll('{{curso}}', ctx.course.title),
  ) +
  '\n\n' +
  card(ctx);

// Cada respuesta tiene un CUERPO (el dato) y un CIERRE (el siguiente paso). Por separado sirven para contestar varias preguntas en un mensaje.
const ENROLL_CTA = 'Si quieres apartar tu lugar, escribe «Quiero inscribirme» y te mando tu enlace de pago.';
const enrollCta = ctx =>
  step(
    ctx,
    seller(ctx)
      ? 'Responde ' + key(ctx, 'Quiero inscribirme') + ' para asegurar tu lugar y te mando tu enlace de pago.'
      : 'Si quieres apartar tu lugar, escribe ' + key(ctx, 'Quiero inscribirme') + ' y te mando tu enlace de pago.',
  );
const seatCta = ctx =>
  step(
    ctx,
    seller(ctx)
      ? 'Responde ' + key(ctx, 'Quiero inscribirme') + ' para asegurar tu lugar.'
      : '¿Quieres apartar tu lugar? Escribe ' + key(ctx, 'Quiero inscribirme') + '.',
  );
const PRICE_NOTE = '(Precio de ejemplo: este es un chat de prueba.)';
// El «antes» tachado: sólo con una promoción vigente y un precio regular mayor (datos del catálogo).
const before = ctx =>
  ctx.promotion && Number.isFinite(ctx.regularPriceCents) && ctx.regularPriceCents > ctx.priceCents
    ? '\n' + strike(ctx, 'Antes: ' + money(ctx.regularPriceCents, ctx.currency || ctx.edition.currency))
    : '';
// Lo que incluye el precio, sólo con datos: sesiones de Coordinación y la modalidad.
const includes = ctx => {
  const n = Array.isArray(ctx.sessions) ? ctx.sessions.length : 0,
    e = ctx.edition;
  if (!n) return '';
  return (
    'Incluye ' +
    (n === 1 ? '1 sesión' : n + ' sesiones') +
    (e.modality === 'online' ? ' en vivo' : '') +
    (e.location ? ' por ' + e.location : '') +
    '.'
  );
};
export const priceBody = ctx =>
  seller(ctx) && ctx.promotion
    ? (on(ctx) ? '🔥 ' : '') +
      'Promoción «' +
      ctx.promotion.name +
      '»: ' +
      b(ctx, money(ctx.priceCents, ctx.currency || ctx.edition.currency)) +
      before(ctx) +
      (ctx.promotion.ends_at
        ? '\n' + (on(ctx) ? '⏳ ' : '') + 'Vigente hasta el ' + shortDay(ctx.promotion.ends_at, ctx.edition.timezone)
        : '') +
      (includes(ctx) ? '\n\n' + includes(ctx) : '')
    : (on(ctx) ? '💳 ' : '') +
      'El precio de ' +
      b(ctx, title(ctx)) +
      ' es de ' +
      priceText(ctx) +
      '.' +
      before(ctx) +
      (seller(ctx) && includes(ctx) ? '\n\n' + includes(ctx) : '');
export const price = ctx => withUrgency(ctx, priceBody(ctx)) + '\n\n' + enrollCta(ctx) + '\n\n' + PRICE_NOTE;

export function syllabusBody(ctx) {
  const items = String(ctx.course.syllabus || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map((l, i, all) =>
      /^([•\-–*]|\d+[.)])\s/.test(l) ? l : (seller(ctx) && on(ctx) && all.length <= 10 ? NUMBERS[i] : '•') + ' ' + l,
    );
  return (on(ctx) ? '📚 ' : '') + 'Esto es lo que verás en ' + b(ctx, ctx.course.title) + ':\n\n' + items.join('\n');
}
export const syllabus = ctx => syllabusBody(ctx) + '\n\n¿Te cuento el precio o las fechas?';
export function scheduleBody(ctx) {
  const lines = facts(ctx, { price: false });
  if (!ctx.edition.instructor) lines.splice(1, 0, li(ctx, '🧑', 'Docente', 'por confirmar'));
  return b(ctx, title(ctx)) + '\n' + lines.join('\n') + sessionBlock(ctx);
}
export const schedule = ctx =>
  scheduleBody(ctx) +
  '\n\n' +
  (startText(ctx.edition) !== null
    ? seatCta(ctx)
    : 'En cuanto se confirme la fecha te avisamos por aquí. Mientras tanto, ¿te cuento el precio o el temario?');

// Varias preguntas en un mismo mensaje («¿qué temas incluye y tiene certificado?»): se contestan todas, en el orden en que se reconocen,
// con un solo cierre. `parts` son cuerpos ya armados (del catálogo o respuestas aprobadas del conocimiento).
export function several(parts, { price = false, ctx = null } = {}) {
  return (
    parts.join('\n\n') +
    '\n\n' +
    (price
      ? enrollCta(ctx) + '\n\n' + PRICE_NOTE
      : step(
          ctx,
          'Si quieres apartar tu lugar, escribe ' + key(ctx, 'Quiero inscribirme') + '. ¿Te ayudo con algo más?',
        ))
  );
}

export const enrollWithOrder = (ctx, name) =>
  '¡Qué gusto' + hi(name) + '!' + (on(ctx) ? ' 🎉' : '') + ' Ya tengo listo tu pedido:\n\n{{pedido}}';
export const orderReminder = () => 'Tu pedido sigue vigente. Aquí lo tienes de nuevo:\n\n';
export const enrollWithAdvisor = (ctx, name) =>
  '¡Qué gusto' +
  hi(name) +
  '!' +
  (on(ctx) ? ' 🙌' : '') +
  ' Anoté tu interés en ' +
  title(ctx) +
  '. Un asesor te escribe por aquí para completar tu inscripción.\n(Chat de prueba: no se realizan cobros reales.)';

const PAYMENT_METHODS =
  'Puedes pagar con tarjeta u OXXO desde el enlace que te mando al inscribirte, o por transferencia enviando tu comprobante por este chat. Si quieres empezar, escribe «Quiero inscribirme».';
export const paymentMethods = ctx => (on(ctx) ? '💳 ' : '') + PAYMENT_METHODS;
export const paymentWithAdvisor =
  'Con gusto te paso las formas de pago: ya le avisé a un asesor para que te escriba por aquí.';

export const thanks = (name, ctx = null) =>
  '¡Con gusto' +
  hi(name) +
  '!' +
  (on(ctx) ? ' 😊' : '') +
  ' Aquí sigo por si quieres ver el precio, las fechas o inscribirte.';
// Segundo «gracias» u «ok» seguido: no se repite el mismo texto.
export const thanksAgain = '¡Perfecto! Cualquier cosa, aquí estoy.';

// ---- Mensajes de trato (docs/PLAN_ASISTENTE_SIN_CALLEJONES.md): contestan «sí», «no», «espera», «¿sigues ahí?», «¿eres un bot?»… sin tratarlos
// como una pregunta sin respuesta. Ninguno promete nada: no apartan lugares, no ofrecen descuentos y no dicen que ya viene una persona.
export const affirm = ctx =>
  '¡Perfecto!' + (on(ctx) ? ' 👍' : '') + ' ¿Qué te cuento de ' + b(ctx, ctx.course.title) + '?';
export const decline = name =>
  'Sin problema' + hi(name) + '. Si más adelante quieres retomarlo, escríbeme por aquí y lo vemos con gusto.';
export const later = (name, ctx = null) =>
  '¡Claro' +
  hi(name) +
  ', sin prisa!' +
  (on(ctx) ? ' 🙂' : '') +
  ' Aquí te queda la información; cuando quieras seguir, escríbeme por este chat.';
export const bye = (name, ctx = null) =>
  '¡Hasta pronto' + hi(name) + '!' + (on(ctx) ? ' 👋' : '') + ' Aquí estaré si necesitas algo más.';
export const help = ctx =>
  (on(ctx) ? '🙂 ' : '') +
  'Aquí estoy para ayudarte. Puedo contarte el precio, el temario o las fechas de ' +
  b(ctx, ctx.course.title) +
  ', o ayudarte a inscribirte.\n\n¿Qué necesitas saber?';
export const menu = ctx =>
  (on(ctx) ? '📋 ' : '') + 'Esto es lo que te puedo contar de ' + b(ctx, ctx.course.title) + ':';
export const identity = ctx =>
  (on(ctx) ? '🤖 ' : '') +
  'Soy el asistente automático de ' +
  ctx.brand.name +
  ': respondo al momento sobre el precio, el temario y las fechas, y te ayudo a inscribirte.\n\nSi prefieres que te atienda una persona del equipo, escribe «asesor».';
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
    (on(ctx) ? '✅ ' : '') +
    'Todavía hay lugar en ' +
    b(ctx, title(ctx)) +
    (n <= 10 ? ': ' + (n === 1 ? 'queda 1 lugar' : 'quedan ' + n + ' lugares') + ' al momento de responderte' : '') +
    '.\n\n' +
    enrollCta(ctx)
  );
}
export const courses = (ctx, titles) =>
  titles.length
    ? 'En ' +
      ctx.brand.name +
      ' también tenemos:\n\n' +
      titles.map(t => item(ctx, '🎓', t)).join('\n') +
      '\n\nEste chat es sobre ' +
      b(ctx, ctx.course.title) +
      '. Si te interesa otro, escribe ' +
      key(ctx, 'asesor') +
      ' y una persona te da los detalles.'
    : 'Por ahora ' +
      b(ctx, ctx.course.title) +
      ' es el curso que tenemos abierto en ' +
      ctx.brand.name +
      '. ¿Te cuento el precio o las fechas?';
// ---- Un número de WhatsApp para toda la marca (docs/PLAN_NUMERO_POR_CONSULTORA.md): se pregunta el curso antes de hablar de precios o fechas.
const numbered = titles => titles.map((t, i) => i + 1 + '. ' + t).join('\n');
// `greeted`: la conversación ya oyó al negocio en esta atención (un recorrido que saludó antes de preguntar): la
// pregunta sale sin saludo ni presentación, para que no lleguen dos saludos seguidos.
export const chooseCourse = (brand, titles, { again = false, greeted = false, ctx = null } = {}) =>
  (again
    ? 'Para darte la información correcta necesito saber qué curso te interesa:'
    : greeted
      ? '¿Sobre qué curso te gustaría información?'
      : (on(ctx) ? '👋 ' : '') +
        '¡Hola! Soy el asistente de ' +
        brand +
        '. ¿Sobre qué curso te gustaría información?') +
  '\n\n' +
  numbered(titles) +
  '\n\n' +
  step(ctx, 'Responde con el número o el nombre del curso.') +
  (again ? '\n\nSi prefieres que te atienda una persona, escribe «asesor».' : '');
export const courseMenu = (ctx, titles) =>
  (on(ctx) ? '📋 ' : '') +
  'Estos son los cursos de ' +
  ctx.brand.name +
  ':\n\n' +
  numbered(titles) +
  '\n\nAhora estamos viendo ' +
  b(ctx, ctx.course.title) +
  '.\n\n' +
  step(ctx, 'Para cambiar, responde con el número o el nombre del curso.');
// Nombró algo que comparten varios cursos («el de reptiles»): se le ofrecen sólo ésos. `seeAll`: el paso «¿Qué curso
// te interesa?» de un recorrido además deja pedir la lista completa con «ver todos».
export const whichCourse = (titles, { seeAll = false, ctx = null } = {}) =>
  (on(ctx) ? '🎓 ' : '') +
  'Tenemos ' +
  titles.length +
  ' cursos de ese tema. ¿Cuál te interesa?\n\n' +
  numbered(titles) +
  '\n\n' +
  step(
    ctx,
    seeAll
      ? 'Responde con el número o el nombre del curso, o escribe «ver todos» para ver la lista completa.'
      : 'Responde con el número o el nombre del curso.',
  );
export const switchBlocked = (ctx, other) =>
  'Tienes un pedido pendiente de ' +
  ctx.course.title +
  '. Para cambiarte a ' +
  other +
  ', escribe «asesor» y una persona te ayuda.';
// Lo que incluye ese precio, sólo con lo que el catálogo sabe: sesiones, modalidad y fechas. Nada que no esté ahí.
function included(ctx, sessions = 0) {
  const e = ctx.edition,
    zone = e.timezone,
    parts = [];
  if (sessions) parts.push(sessions + (sessions === 1 ? ' sesión' : ' sesiones'));
  if (MODALITY[e.modality]) parts.push('modalidad ' + MODALITY[e.modality].toLowerCase());
  if (e.starts_at !== null && e.starts_at !== undefined)
    parts.push(
      e.ends_at
        ? 'del ' + shortDay(e.starts_at, zone) + ' al ' + shortDay(e.ends_at, zone)
        : 'inicio el ' + shortDay(e.starts_at, zone),
    );
  return parts.length ? ' Lo que incluye ese precio: ' + parts.join(', ') + '.' : '';
}
// «Está caro»: el precio vigente, lo que incluye y, si la marca la tiene, su respuesta aprobada de pago en partes (`installments`),
// tal cual. Nunca un descuento ni otro precio: eso lo ve una persona.
export const objection = (ctx, { sessions = 0, installments = '' } = {}) =>
  'Te entiendo.\n\n' +
  (seller(ctx)
    ? (on(ctx) ? '💳 ' : '') + 'El precio vigente de ' + b(ctx, title(ctx))
    : 'El precio vigente de ' + title(ctx)) +
  ' es de ' +
  priceText(ctx) +
  '.' +
  before(ctx) +
  included(ctx, sessions).replace(/^ /, before(ctx) ? '\n' : ' ') +
  (installments ? '\n\n' + installments : '') +
  '\n\nPor este chat no puedo ofrecerte otro precio, pero una persona del equipo puede revisar las opciones contigo: escribe «asesor» y le aviso.\n\n' +
  PRICE_NOTE;
// «Lo pienso», «lo consulto», «te aviso»: sin presionar, con lo que sí es cierto hoy según el catálogo (promoción vigente y
// hasta cuándo, pocos lugares, o el inicio con las inscripciones abiertas) y una invitación a resolver la duda por aquí.
export function thinking(ctx, name, { seats = null } = {}) {
  const e = ctx.edition,
    p = ctx.promotion,
    facts = [];
  if (p?.ends_at) facts.push('la promoción «' + p.name + '» está vigente hasta el ' + shortDay(p.ends_at, e.timezone));
  if (typeof seats === 'number' && seats > 0 && seats <= 10)
    facts.push(
      seats === 1
        ? 'queda 1 lugar al momento de responderte'
        : 'quedan ' + seats + ' lugares al momento de responderte',
    );
  else if (startText(e))
    facts.push('el curso inicia el ' + shortDay(e.starts_at, e.timezone) + ' y las inscripciones siguen abiertas');
  const lines = [];
  if (seller(ctx)) {
    if (p?.ends_at)
      lines.push(
        (on(ctx) ? '🔥 ' : '') +
          'La promoción «' +
          p.name +
          '» (' +
          money(ctx.priceCents, ctx.currency || e.currency) +
          ') está vigente hasta el ' +
          shortDay(p.ends_at, e.timezone),
      );
    if (typeof seats === 'number' && seats > 0 && seats <= 10)
      lines.push(
        (on(ctx) ? '🎈 ' : '') +
          (seats === 1 ? 'Queda 1 lugar' : 'Quedan ' + seats + ' lugares') +
          ' al momento de responderte',
      );
    else if (startText(e))
      lines.push(
        (on(ctx) ? '📅 ' : '') +
          'El curso inicia el ' +
          shortDay(e.starts_at, e.timezone) +
          ' y las inscripciones siguen abiertas',
      );
  }
  return (
    '¡Claro' +
    hi(name) +
    ', tómate tu tiempo!' +
    (on(ctx) ? ' 🙂' : '') +
    (seller(ctx)
      ? lines.length
        ? '\n\nSólo para que lo tengas en cuenta:\n' + lines.join('\n')
        : ''
      : facts.length
        ? '\n\nSólo para que lo tengas en cuenta: ' + facts.join(', y ') + '.'
        : '') +
    '\n\nSi te queda alguna duda del precio, las fechas o el temario, dime y te la resuelvo por aquí.\n\n' +
    step(ctx, 'Cuando quieras seguir, escribe ' + key(ctx, 'Quiero inscribirme') + '.')
  );
}

// ---- Cuando no hay respuesta: primero opciones, después se PREGUNTA si quiere una persona, y sólo al final se pasa.
export const fallback = ctx =>
  (on(ctx) ? '🤔 ' : '') +
  'Esa pregunta todavía no la tengo a la mano.\n\nLo que sí puedo contarte ahora mismo es el precio, el temario o las fechas de ' +
  ctx.course.title +
  '.\n\nSi prefieres que te responda una persona, escribe «asesor».';
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
    '\n\nSi prefieres transferencia, envía tu comprobante por este chat y una persona lo valida.\n\nPago de prueba: no se cobra nada real.'
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
  'Al inscribirte te mando tu pedido con las formas de pago.\n\nPara completar tu inscripción, mándame en un solo mensaje:\n✅ Tu comprobante de pago\n✅ Tu nombre completo, como quieres que aparezca en tu certificado\n✅ Tu correo electrónico\n✅ Tu número de WhatsApp\n\nAl transferir, escribe tu nombre en el concepto. Una persona del equipo valida tu pago y te confirma por aquí.\n\nSi quieres empezar, escribe «Quiero inscribirme».';
export const LAB_SWAPS = Object.freeze([
  [PAYMENT_METHODS, REAL_PAYMENT_METHODS],
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
        '\n\nSi tienes tu comprobante, puedes enviarlo en este chat.')
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
  if (state === 'cancelled')
    return (
      'Tu pedido' +
      refOf(reference) +
      ' aparece pagado, pero tu inscripción no está activa. Ya le avisé al equipo para que lo revise contigo por aquí.'
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
export function payLater(name, { reference = null, until = null, hold = false, canOrder = true, ctx = null } = {}) {
  const asked = hold ? ' El lugar queda asegurado cuando se confirma el pago.' : '';
  return reference
    ? '¡Perfecto' +
        hi(name) +
        ', sin problema!' +
        (on(ctx) ? ' 🙂' : '') +
        ' Tu pedido' +
        refOf(reference) +
        (until ? ' sigue vigente hasta el ' + until + '.' : ' sigue vigente.') +
        asked +
        ' Cuando pagues, mándame tu comprobante por aquí y una persona del equipo lo valida.'
    : '¡Claro' +
        hi(name) +
        ', sin prisa!' +
        (on(ctx) ? ' 🙂' : '') +
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
// `coupons`: la marca tiene cupones que la persona puede escribir en su página de pago (no se niega que haya descuento).
// `enrolled`: ya pagó; no se le invita a inscribirse otra vez.
export const noPromotion = (ctx, { enrolled = false, coupons = false } = {}) =>
  priceBody(ctx) +
  (coupons
    ? '\n\nSi tienes un cupón de descuento, puedes escribirlo en tu página de pago.'
    : '\n\nPor ahora no hay una promoción vigente para esta apertura.') +
  '\n\n' +
  (enrolled ? '' : enrollCta(ctx) + '\n\n') +
  'Si quieres que una persona del equipo revise tu caso, escribe ' +
  key(ctx, 'asesor') +
  '.\n\n' +
  PRICE_NOTE;
// Pide inscribirse con la oportunidad ganada sin inscripción viva, o con una inscripción dada de baja: lo ve una persona.
export const enrollmentCheck = ctx =>
  'Le pedí a una persona del equipo que revise tu inscripción a ' + title(ctx) + '; te escribe por aquí.';
// «El link para pagar no abre».
export const payLinkProblem = name =>
  'Lamento la falla' + hi(name) + '. Ya le avisé al equipo para que revise tu enlace de pago y te escriba por aquí.';
// «Nunca me llegó el comprobante»: algo que no le llegó, sin decir que se revisa un pago.
export const notArrived = name =>
  'Gracias por avisar' + hi(name) + '. Ya le avisé al equipo para que lo revise y te escriba por aquí.';
// «¿Hasta cuándo es la promoción?»: la vigencia de la promoción del catálogo, o que no hay.
export const promoUntil = ctx =>
  ctx.promotion
    ? priceBody(ctx) + '\n\n' + enrollCta(ctx) + '\n\n' + PRICE_NOTE
    : 'Por ahora no hay una promoción vigente para ' +
      b(ctx, title(ctx)) +
      '.\n\n' +
      priceBody(ctx) +
      '\n\n' +
      enrollCta(ctx) +
      '\n' +
      PRICE_NOTE;
// «¿Cuál es el último día para pagar?»: la vigencia de su pedido, si lo hay.
export const payUntil = ({ reference = null, until = null, ctx = null } = {}) =>
  reference
    ? (on(ctx) ? '⏳ ' : '') +
      'Tu pedido' +
      refOf(reference) +
      (until ? ' vence el ' + until + '.' : ' sigue vigente.') +
      ' Cuando pagues, mándame tu comprobante por aquí y una persona del equipo lo valida.'
    : 'Cuando escribas «Quiero inscribirme» te mando tu enlace de pago con su fecha de vencimiento.';
// Ya está inscrita (o la oportunidad está ganada) y pide inscribirse: no se crea otro pedido.
export const alreadyEnrolled = (ctx, { advisor = false } = {}) =>
  (on(ctx) ? '✅ ' : '') +
  'Tu inscripción a ' +
  b(ctx, title(ctx)) +
  ' ya está activa: no hace falta otro pedido.' +
  (advisor ? '\n\nSi necesitas tus accesos o algo más, escribe «asesor» y una persona del equipo te ayuda.' : '');
// El pedido no se pudo crear (p. ej. la oportunidad ya estaba cerrada): una persona lo ve.
export const orderFailed =
  'No pude generar tu pedido en este momento, así que ya le avisé al equipo: una persona te escribe por aquí para completar tu inscripción.';
// Validez del certificado: lo que consta (digital, emisor, folio y QR) y nada más. Nunca se afirma validez oficial.
// Sin emisor configurado (`issuer` vacío) no se afirma emisor ni formato (revisión, M6).
export const validity = (ctx, issuer = '') =>
  (issuer
    ? 'El certificado que emitimos es digital: lo emite ' +
      issuer +
      ', lleva folio y un código QR para verificarlo en línea. '
    : '') +
  'Sobre su validez ante la SEP, para tu cédula, puntos o valor curricular no te puedo confirmar nada por aquí. Si lo necesitas para un trámite, escribe «asesor» y una persona del equipo te dice exactamente qué ampara.';
// Datos para la constancia: se acusa lo que se anotó, sin crear pedidos ni repetir el texto del certificado. El nombre es una
// propuesta: el equipo lo revisa antes de emitir. `changedFrom`: el nombre anterior, para que la persona vea el cambio.
export function certDataThanks(name, data, { enrolled = false, order = false, changedFrom = null, ctx = null } = {}) {
  const got = [
    data.name && !changedFrom ? 'tu nombre «' + data.name + '» para tu certificado' : '',
    data.email ? 'tu correo' : '',
    data.phone ? 'tu teléfono' : '',
  ].filter(Boolean);
  const list = got.length > 1 ? got.slice(0, -1).join(', ') + ' y ' + got[got.length - 1] : got[0];
  return (
    '¡Gracias' +
    hi(name) +
    '!' +
    (on(ctx) ? ' ✅' : '') +
    (changedFrom ? ' Cambié el nombre de tu certificado de «' + changedFrom + '» a «' + data.name + '».' : '') +
    (list ? ' Anoté ' + list + '.' : '') +
    (data.name ? ' El equipo lo revisa antes de emitir tu certificado.' : '') +
    (enrolled
      ? ' Queda junto con tu inscripción; si algo cambia, escríbemelo por aquí.'
      : order
        ? ' Lo dejo junto con tu pedido; si algo cambia, escríbemelo por aquí.'
        : ' Cuando quieras apartar tu lugar, escribe «Quiero inscribirme».')
  );
}
// Datos para la constancia sin pedido: no se guardan todavía.
export const certDataNoOrder =
  '¡Gracias! Tus datos para el certificado te los pido cuando apartes tu lugar. Si quieres empezar, escribe «Quiero inscribirme».';
export const certDataAsk = (ctx = null) =>
  (on(ctx) ? '📝 ' : '') +
  'Claro. Escríbeme en un solo mensaje:\n' +
  item(
    ctx,
    '✅',
    'Tu nombre completo, tal como quieres que aparezca en tu certificado (con acentos y mayúsculas donde van)',
  ) +
  '\n' +
  item(ctx, '✅', 'Tu correo') +
  '\n' +
  item(ctx, '✅', 'Tu teléfono');
// Accesos después de pagar.
export const accessResend = (name, text, ctx = null) =>
  (on(ctx) ? '🔑 ' : '') + 'Claro' + hi(name) + ', aquí tienes de nuevo tus accesos:\n\n' + text;
export const accessPending =
  'Tu inscripción está activa, pero tus accesos todavía no están listos en este chat. Ya le avisé al equipo para que te los envíe por aquí.';
// Ya se le reenviaron hoy las veces que el asistente puede (revisión, M5).
export const accessLimit =
  'Ya te reenvié tus accesos hace un rato. Para no llenarte el chat, le pedí a una persona del equipo que revise contigo qué pasa; te escribe por aquí.';
// Los accesos de la apertura cambiaron desde que se le entregaron: los nuevos los envía una persona.
export const accessChanged =
  'Los accesos de tu curso se actualizaron después de que te los enviamos, así que le pedí a una persona del equipo que te mande los vigentes por aquí.';
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
  scheduleBody(ctx) + '\n\n' + 'Por ahora las inscripciones están abiertas. ' + seatCta(ctx);
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
// «No tengo tiempo»: lo que el conocimiento aprobado dice de la grabación, el calendario real (inicio, fin y sesiones) para que
// lo mida, y cómo preguntar por otra fecha.
export const timeObjection = (ctx, recording = '', sessions = 0) =>
  'Te entiendo.' +
  (recording ? '\n\n' + recording : '') +
  (startText(ctx.edition) ? '\n\nPara que lo midas, así va el calendario:\n' + durationBody(ctx, sessions) : '') +
  '\n\nSi estas fechas no te acomodan, escribe «asesor» y una persona del equipo te dice cuándo es la siguiente apertura de ' +
  ctx.course.title +
  '.';
// Duración con el calendario de la apertura que ya se conoce (sin pedir «dime qué edición»).
// Los renglones de fin y sesiones (también se añaden a la ficha de fechas cuando preguntan las dos cosas).
export function durationExtra(ctx, sessions = 0) {
  const e = ctx.edition,
    end = e.ends_at ? startText({ ...e, starts_at: e.ends_at }) : null;
  const rows = sessionLines(ctx);
  return (
    (end ? '\n' + li(ctx, '🏁', 'Termina', end) : '') +
    (rows.length ? '\n' + rows.join('\n') : sessions ? '\n' + li(ctx, '🗓️', 'Sesiones', sessions) : '')
  );
}
export const durationBody = (ctx, sessions = 0) =>
  b(ctx, title(ctx)) +
  '\n' +
  li(ctx, '📅', 'Inicio', startText(ctx.edition) || 'fecha por confirmar') +
  durationExtra(ctx, sessions);
export const duration = (ctx, sessions = 0) => durationBody(ctx, sessions) + '\n\n' + seatCta(ctx);
// Cupo cuando el catálogo sabe el tamaño del grupo pero no los lugares que quedan.
export const seatsCapacity = ctx =>
  'Las inscripciones de ' +
  b(ctx, title(ctx)) +
  ' están abiertas y el grupo es de ' +
  ctx.edition.capacity +
  ' lugares, así que el cupo es limitado.\n\n' +
  enrollCta(ctx);
// Recomendar cursos de la marca con lo que la persona dice (especie o tema), con inicio y precio vigentes.
// `remembered`: no lo dijo ahora, lo contó antes en esta conversación («tengo un rancho con vacas») y se le recuerda.
export function recommend(ctx, items, { multi = false, remembered = false } = {}) {
  return (
    (remembered
      ? 'Por lo que me contaste antes, te pueden servir estos cursos de '
      : 'Por lo que me cuentas, te pueden servir estos cursos de ') +
    ctx.brand.name +
    ':\n\n' +
    items
      .map((i, n) =>
        seller(ctx) && on(ctx) && items.length <= 10
          ? NUMBERS[n] +
            ' ' +
            b(ctx, i.title) +
            '\n   📅 Inicia ' +
            (i.start || 'en fecha por confirmar') +
            ' · 💳 ' +
            i.price
          : item(ctx, '🎓', b(ctx, i.title) + ' — inicia ' + (i.start || 'en fecha por confirmar') + ' · ' + i.price),
      )
      .join('\n') +
    '\n\n' +
    (multi
      ? 'Responde con el nombre del que te interesa y te paso su información.'
      : 'Este chat es sobre ' +
        b(ctx, ctx.course.title) +
        '. Si te interesa otro, escribe ' +
        key(ctx, 'asesor') +
        ' y una persona te da los detalles.') +
    '\n' +
    PRICE_NOTE
  );
}
// Buscó un tema que ningún curso de la marca tiene.
export const noTopicMatch = (ctx, titles) =>
  (on(ctx) ? '🔎 ' : '') +
  'No encontré un curso con ese tema en su nombre ni en su temario en ' +
  ctx.brand.name +
  '.\n\n' +
  (titles.length
    ? 'Estos son los que sí tenemos, además de ' +
      b(ctx, ctx.course.title) +
      ':\n\n' +
      titles.map(t => item(ctx, '🎓', t)).join('\n') +
      '\n\nSi te interesa alguno, escribe «asesor» y una persona te da los detalles.'
    : 'Por ahora ' + ctx.course.title + ' es el curso que tenemos abierto. ¿Te cuento el precio o las fechas?');
export const askTopic = ctx =>
  'Con gusto te recomiendo.' +
  (on(ctx) ? ' 🙂' : '') +
  '\n\n¿Qué tema te interesa? Así te digo cuál de los cursos de ' +
  ctx.brand.name +
  ' te conviene.';
export const jobs = ctx =>
  'Gracias por escribirnos. Por este chat sólo atiendo información e inscripciones a los cursos de ' +
  ctx.brand.name +
  ', así que no manejo vacantes ni colaboraciones. Si tienes una duda de algún curso, aquí estoy.';
