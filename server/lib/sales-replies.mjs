// Lectura fina de los mensajes de venta y posventa (docs/PLAN_RESPUESTAS_DE_VENTA.md). Funciones puras: reciben el texto
// (normalizado con `normalize` de server/ai-provider.mjs: minúsculas, sin acentos ni signos) y devuelven qué pide la
// persona. No leen la base ni la red; quien decide qué contestar es server/replies.mjs.
import { normalize, stem, tokens } from '../ai-provider.mjs';

const plain = raw => normalize(raw).replace(/\s+/g, ' ').trim();

// ---- Pagos: «¿cómo pago?» no es lo mismo que «ya pagué», «pago mañana», «¿ya verificaron?», factura, meses o varias
// personas. Antes todo recibía «Puedes pagar con…».
// Ya pagó (verbo en pasado o un comprobante a la vista). Lo usan también el pase obligatorio a una persona y la reanudación.
const PAID_PAST =
  /\b(pague|pagamos|ya pague|transferi|transferimos|deposite|depositamos|(hice|hicimos|realice|ya hice) (la|el|mi|los) (transferencia|deposito|pago|pagos)|listo (el|mi) (pago|deposito)|ya (quedo|esta|estan) (el|mi|los) (pago|deposito|pagos)|(ahi|aqui) (va|esta|te va|le va|les va|van|estan) (la|el|mi|los) (captura|foto|comprobante|comprobantes|voucher|baucher|bauche|ticket))\b/;
const RECEIPT =
  /\b(comprobante|comprobantes|voucher|baucher|bauche|captura del pago|ficha de deposito|(les |te |le )?(mande|envie|mandamos|enviamos) (el|mi|la|los|las) (captura|capturas|foto|fotos|ticket|recibo))\b/;
export const claimsPaid = t => PAID_PAST.test(t) || RECEIPT.test(t);

const STATUS =
  /\b((ya )?(pudieron|pueden|podrian|alcanzaron a) (verificar|validar|revisar|confirmar|ver)|ya (verificaron|validaron|revisaron|confirmaron|vieron|checaron|registraron)|(les|te|le) llego (mi|el) (pago|deposito|transferencia|comprobante)|(estatus|status|estado) de mi (pago|pedido|inscripcion)|ya (quedo|se reflejo) (mi|el) pago|(desde ayer|desde hace|y nada|y no me|nadie me (contesta|responde|dice)|no me (han )?(contestado|confirmado|respondido|dicho nada)))\b/;
const FUTURE =
  /\b(manana|pasado manana|quincena|ahorita|al rato|mas tarde|en un rato|en la tarde|en la noche|hoy (mismo|en la tarde|en la noche)|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo)|la (proxima|otra|siguiente) semana|fin de (semana|mes)|cuando (cobre|me paguen|me depositen)|en cuanto (pueda|cobre|me paguen)|en unos dias|esta semana|luego)\b/;
const PAY_VERB =
  /\b(pago|pagar|pagaria|pagare|pagamos|deposito|depositar|depositaria|transfiero|transferir|transferencia|mando|envio|hago|realizo)\b/;
const INVOICE = /\b(factura|facturas|facturan|facturar|facturacion|cfdi|rfc|iva|deducible|recibo fiscal)\b/;
const INSTALLMENTS =
  /\b(meses sin intereses|a meses|msi|parcialidades|parcialidad|mensualidades|abonos?|en (dos|2|tres|3|cuatro|4) (partes|pagos|exhibiciones)|pagos? (parciales|diferidos)|(pagar|pago|pagarlo) (en partes|una parte|la mitad)|en partes|anticipo)\b/;
export const GROUP =
  /\b((dos|2|tres|3|cuatro|4|cinco|5|varias|varios) (personas|lugares|inscripciones|alumnos|companeros|companeras)|(los|las|el de|la de) (dos|2|tres|3) (personas|lugares)?|somos (dos|2|tres|3|cuatro|4|cinco|5|varios|varias)|para (mi|un|una) (hermana|hermano|amiga|amigo|esposa|esposo|companera|companero|socio|socia|hija|hijo)|tambien a mi|(otra|otras) personas?|en un solo deposito|(mi|una|un) (hermana|hermano|amiga|amigo|esposa|esposo|companera|companero|socio|socia|hija|hijo|prima|primo|mama|papa) (tambien )?(quiere|se quiere|desea|va a|quisiera))\b/;
const ACCOUNT =
  /\b(numero de cuenta|cuenta (bancaria|para (depositar|transferir|pagar))|clabe|a nombre de quien|datos (bancarios|de (la )?cuenta|para (pagar|depositar|transferir))|a que cuenta)\b/;
// status · paid · later · invoice · installments · group · account · methods (la pregunta general de siempre)
export function paymentKind(t) {
  if (
    STATUS.test(t) &&
    /\b(pago|pague|pedido|comprobante|deposito|transferencia|inscripcion|deposite|transferi)\b/.test(t)
  )
    return 'status';
  if (PAID_PAST.test(t)) return 'paid';
  if (FUTURE.test(t) && PAY_VERB.test(t)) return 'later';
  if (RECEIPT.test(t)) return 'paid';
  if (INVOICE.test(t)) return 'invoice';
  if (INSTALLMENTS.test(t)) return 'installments';
  if (GROUP.test(t)) return 'group';
  if (ACCOUNT.test(t)) return 'account';
  return 'methods';
}
// Lo que una respuesta aprobada debe mencionar para contestar de verdad esa pregunta. La respuesta general de pago
// («Puedes pagar con tarjeta…») trae «factura» entre sus variantes, pero no dice nada de factura: no cuenta.
export const ANSWERS = {
  invoice: /\b(factura|facturas|facturamos|facturacion|cfdi|iva)\b/,
  installments: /\b(meses|parcialidades|mensualidades|partes|abonos)\b/,
  group: /\b(grupo|grupos|varias personas|personas|cada persona)\b/,
  account: /\b(cuenta|clabe|titular|a nombre de)\b/,
};

// ---- Validez del certificado: «¿tiene validez oficial?», «¿es válido ante la SEP?», «¿valor curricular?», «¿cédula?».
// Nunca se afirma una validez oficial que no consta.
export const VALIDITY =
  /\b(validez oficial|oficial|sep|curricular|cedula|valida ante|valido ante|reconocid[oa] (por|ante)|puntos para)\b/;
export const isValidity = t =>
  VALIDITY.test(t) &&
  (!/\boficial\b/.test(t) ||
    /\b(certificad\w*|constancia|diploma|validez|curso|titulo|reconocimiento|valid\w*)\b/.test(
      t.replace(/\boficial\b/, ''),
    ));
// Una respuesta aprobada que habla de propósito de la validez (la pregunta o sus variantes la mencionan).
export const VALIDITY_ENTRY = /\b(oficial|sep|curricular|cedula)\b/;

// ---- Datos para la constancia (nombre completo, correo, teléfono). Un NOMBRE sólo se toma con una señal explícita
// («mi nombre completo es…», «nombre para la constancia: …», «a nombre de … para el certificado», o una ficha de datos en
// varias renglones con nombre y teléfono o correo), nunca de un saludo, un agradecimiento, una queja o una frase de pago.
// Un correo o un teléfono sueltos sólo cuentan cuando ya hay un pedido (lo decide replies) y nunca traen un nombre.
// Lo que se toma es una propuesta: una persona del equipo la confirma antes de que salga en un certificado.
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const CERT = '(?:la constancia|el certificado|el diploma|el registro|la inscripci[oó]n)';
const EXPLICIT = [
  new RegExp('mi nombre completo(?: (?:para|en) ' + CERT + ')?\\s*(?:es|:|seria|sería)\\s*(.+)', 'i'),
  new RegExp('mi nombre (?:para|en) ' + CERT + '\\s*(?:es|:|seria|sería)\\s*(.+)', 'i'),
  new RegExp('nombre (?:completo )?(?:para|en) ' + CERT + '\\s*(?:es|:)?\\s*(.+)', 'i'),
  new RegExp('(?:a nombre de|con el nombre de)\\s+(.+?)\\s+(?:para|en) ' + CERT, 'i'),
  new RegExp('(?:para|en) ' + CERT + '\\s*(?:va |es |sale )?(?:a nombre de|:)\\s*(.+)', 'i'),
  /^\s*nombre(?: completo)?\s*:\s*(.+)$/im,
];
// «mi nombre es …» sólo cuenta si el mismo mensaje dice que es para la constancia o el registro.
const NAME_IS = /mi nombre es\s+(.+)/i;
// Palabras que nunca forman parte de un nombre: saludos, trato, quejas, pagos.
const NOT_A_NAME = new Set(
  'hola buenas buenos buen tardes dias noches gracias muchas mil nadie contesta contestan responde responden esposo esposa veo deposito deposite transferencia transferi pago pague pagar tarjeta quiero ok okey favor porfa ayuda curso asesor tengo estoy espero esperando urgente gracias perfecto listo correo telefono celular cel numero whatsapp datos constancia certificado diploma registro inscripcion para'.split(
    ' ',
  ),
);
const PAYMENT_WORDS = /\b(deposit\w*|transfer\w*|pag[oaue]\w*|tarjeta|cuenta|clabe|factura\w*|oxxo|spei)\b/;
const cleanName = candidate => {
  const words = String(candidate || '')
    .split(/[,;\n]| y | mi correo| mi cel| mi telefono| mi teléfono| correo| cel\b| tel[eé]fono|\(/i)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:]+$/, '')
    .split(' ')
    .filter(Boolean);
  if (words.length < 2 || words.length > 6) return '';
  if (!words.every(w => /^[\p{L}'’.-]{1,30}$/u.test(w))) return '';
  if (words.some(w => NOT_A_NAME.has(normalize(w).trim()))) return '';
  return words.join(' ');
};
// Una «ficha» de datos: dos o más renglones, uno con sólo un nombre y otro con correo, teléfono o el curso.
function cardName(text) {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return '';
  const other = lines.some(
    l => EMAIL.test(l) || /\d{10}/.test(l.replace(/\D/g, '')) || /^(curso|tel|cel|correo)/i.test(l),
  );
  if (!other) return '';
  for (const l of lines) {
    const n = cleanName(l.replace(/^nombre(?: completo)?\s*[:-]?\s*/i, ''));
    if (
      n &&
      n.split(' ').length ===
        l
          .replace(/^nombre(?: completo)?\s*[:-]?\s*/i, '')
          .trim()
          .split(/\s+/).length
    )
      return n;
  }
  return '';
}
export function certData(raw) {
  const text = String(raw || '').normalize('NFC'),
    email = (text.match(EMAIL) || [])[0] || '',
    noMail = text.replace(EMAIL, ' ');
  let phone = '';
  for (const m of noMail.match(PHONE) || []) {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13) {
      phone = (m.trim().startsWith('+') ? '+' : '') + digits;
      break;
    }
  }
  let name = '';
  const t = plain(text);
  if (!PAYMENT_WORDS.test(t)) {
    const body = noMail.replace(PHONE, ' ').replace(/[¿?¡!]/g, ' ');
    for (const re of EXPLICIT) {
      const m = re.exec(body);
      if (m && (name = cleanName(m[1]))) break;
    }
    if (!name && /\b(constancia|certificado|diploma|registro)\b/.test(t)) {
      const m = NAME_IS.exec(body);
      if (m) name = cleanName(m[1]);
    }
    if (!name) name = cardName(noMail);
  }
  return { name, email, phone };
}
export const hasCertData = d => Boolean(d.name || d.email || d.phone);
// Señal fuerte (se reconoce sin pedido): trae un nombre con señal explícita, ofrece sus datos, pregunta cómo escribir su
// nombre, o da correo o teléfono diciendo que son para la constancia o el registro.
const CERT_WORDS = /\b(constancia|certificado|diploma|registro|inscripcion)\b/;
const OFFERS =
  /\b((te|les|le) (paso|mando|envio|comparto|dejo) (mis|mi) (datos|nombre|correo|cel|celular|telefono|numero|whats)|mis datos (son|para|van)|aqui (van|estan|te van|les van) mis datos)\b/;
const HOW_NAME =
  /\b(el nombre va (con|en)|como (pongo|escribo|pongo mi|escribo mi) (mi |el )?nombre|nombre (va )?con mayusculas)\b/;
// Un mensaje que pide algo (que le llamen, un asesor) no es sólo un dato: no se contesta con «anoté…».
export const ASKS_SOMETHING =
  /\b(llam\w*|marc(a|ar|en|ame|enme)|asesor\w*|persona|alguien|ayud\w*|contest\w*|urgente|queja|reembolso)\b/;
export function certDataSignal(t, raw) {
  if (ASKS_SOMETHING.test(t) && !HOW_NAME.test(t)) return false;
  if (HOW_NAME.test(t) || OFFERS.test(t)) return true;
  if (/\b(factura|quien)\b/.test(t)) return false; // «factura a nombre de…», «¿a nombre de quién pago?»
  const d = certData(raw);
  if (d.name) return true;
  return CERT_WORDS.test(t) && Boolean(d.email || d.phone);
}
// Señal débil: un correo o un teléfono sueltos (nunca un nombre). Sólo cuenta tras un pedido y no pisa lo ya guardado.
export const weakCertData = (t, raw) => {
  if (/[?¿]/.test(String(raw || '')) || ASKS_SOMETHING.test(t) || /\b(factura|cuenta|clabe|quien)\b/.test(t))
    return false;
  const d = certData(raw);
  return Boolean(d.email || d.phone);
};

// ---- Accesos después de pagar: «¿dónde entro?», «no me llegó el enlace», «no me han agregado al grupo», «no abre».
const ACCESS_NOUN =
  /\b(link|links|enlace|enlaces|liga|ligas|acceso|accesos|zoom|meet|grupo|clase|clases|sesion|plataforma|aula)\b/;
// Lo que pide un prospecto («el link para pagar», «me mandan información», «el temario»): nunca es posventa.
const PROSPECT = /\b(pagar|de pago|para el pago|precio|costo|temario|informacion|info|informes|datos|ficha|flyer)\b/;
const ACCESS_ASK =
  /\b(no (me )?(llega|llego|ha llegado|han llegado|abre|funciona|deja|carga|puedo entrar|aparece)|donde (entro|ingreso|veo|me conecto|esta|estan|lo veo|la veo)|como (entro|ingreso|accedo|veo|me meto)|me (pasan|pasas|pasa|mandan|mandas|envian|envias|comparten|agregan|agregas|agregaran)|cuando me (mandan|envian|agregan|pasan|llega|llegan|dan)|no me (agregan|han agregado|han mandado|han enviado|llega|llego)|todavia no me|aun no me|ya empezo|como ingreso|despues del pago como|se (corto|cayo|trabo|congelo)|no se (escucha|oye|ve))\b/;
export const ACCESS_PROBLEM =
  /\b(no (abre|funciona|deja|carga|sirve|puedo entrar)|se (corto|cayo|trabo|congelo)|no se (escucha|oye|ve)|marca error|da error)\b/;
// Sólo la forma del mensaje: replies.mjs además exige una inscripción activa o un pedido pagado o en revisión.
export const isAccess = t => ACCESS_NOUN.test(t) && ACCESS_ASK.test(t) && !PROSPECT.test(t);

// ---- Fechas que no son «¿cuándo empieza?»: hasta cuándo se puede inscribir, otra fecha y «avísame de la siguiente».
export const DEADLINE =
  /\b(hasta (que|cuando)|aun (me )?puedo (inscribir|registrar|entrar|apuntar)|todavia (me )?puedo (inscribir|registrar|entrar|apuntar)|todavia alcanzo|aun alcanzo|alcanzo a (entrar|inscribirme|registrarme)|ultimo dia|fecha limite|cuando cierran|cierran (las )?inscripciones)\b/;
export const NEXT =
  /\b(otra fecha|otras fechas|siguiente (fecha|apertura|edicion|generacion|grupo)|proxima (fecha|apertura|edicion|generacion)|vuelv\w* a (abrir|dar|impartir)|lo (vuelven|van) a (abrir|dar)|habra otr[oa]|otra generacion|otro grupo|de la siguiente)\b/;
export const NOTIFY = /\b(avisame|avisenme|me avisan|me avisas|me pueden avisar|aviseme|me avisen)\b/;

// ---- Objeción de tiempo («no tengo tiempo», «salgo a las 8», «estoy de guardia»): no es una pregunta de fechas.
export const TIME_OBJECTION =
  /\b(no tengo tiempo|no me da tiempo|no llego|no alcanzo a (llegar|conectarme)|salgo (de \w+ )?(a las|tarde)|estoy de guardia|tengo guardia|trabajo (en )?ese horario|se me (cruza|empalma)|no puedo en ese horario|esas fechas no)\b/;

// ---- Recomendar un curso sin IA, SÓLO con el catálogo de la marca (títulos y temarios) y palabras completas: nada de
// vocabulario de un ramo escrito en el código (hay marcas de veterinaria, odontología, dermocosmética…).
// Pide una recomendación o busca cursos de un tema («¿cuál me recomiendas?», «¿tienen algo de cirugía?»).
const ASKS_COURSE =
  /\b(recomiend\w*|me conviene|cual (me )?(sirve|conviene|tomo)|que curso|cual curso|por cual (empiezo|empezar)|(tienen|hay|manejan|dan|ofrecen) (algo|alguno|algun curso|algun diplomado|algun taller|cursos?|diplomados?|talleres?) (de|sobre|para|con)|tienen de|busco (algo|un curso|cursos?|algun curso) (de|sobre|para))\b/;
// Cuenta su perfil y pregunta si le sirve («soy estudiante, ¿me sirve?»).
const SAYS_ROLE = /\bsoy (estudiante|tecnico|tecnica|pasante|principiante|profesional)\b/;
export const FITS = /\b(me sirve|sirve|puedo tomar\w*|lo puedo tomar|es para mi|aplica para|me conviene este)\b/;
export const wantsCourses = t => ASKS_COURSE.test(t) || (SAYS_ROLE.test(t) && FITS.test(t));
export const RECOMMEND = { test: wantsCourses };
// Busca un tema concreto («¿tienen algo de cirugía?», «busco algo de citología»), no pide una recomendación abierta.
export const ASKS_TOPIC =
  /\b((tienen|hay|manejan|dan|ofrecen) (algo|alguno|algun curso|algun diplomado|algun taller|cursos?|diplomados?|talleres?) (de|sobre|para|con)|tienen de|busco (algo|un curso|cursos?|algun curso) (de|sobre|para))\b/;
// Palabras de la lengua que no dicen de qué tema se habla (no de un ramo).
const STOP = new Set(
  'curso cursos tienen tiene tengo tenemos algo alguno alguna algun hay quiero quisiera busco recomiendas recomienda recomiendan sirve conviene cual cuales manejan dan ofrecen diplomado diplomados taller talleres tomar tomarlo para sobre como este esta ese esa estos tambien trabajo trabajar soy estudiante tecnico tecnica pasante semestre informacion info favor gracias hola puedo puede aplica bien mucho muchos mas'.split(
    ' ',
  ),
);
// Palabra completa, con el plural y la vocal final de género quitados («perros» = «perro», «bovinas» = «bovino»).
const wordKey = w => {
  const s = stem(w);
  return s.length >= 5 ? s.replace(/[oa]$/, '') : s;
};
const contentWords = text => [
  ...new Set(
    tokens(text)
      .filter(w => w.length >= 4 && !STOP.has(w))
      .map(wordKey),
  ),
];
// Los cursos de la marca que coinciden con lo que dijo: por su TÍTULO, o por dos o más palabras de su temario. Una
// palabra que aparece en muchos títulos de la marca («clínica») no distingue nada y no cuenta.
// `courses`: [{id, title, syllabus}].
export function recommend(text, courses, { max = 5 } = {}) {
  const said = new Set(contentWords(text));
  if (!said.size || !courses.length) return [];
  const bags = courses.map(k => ({ k, title: contentWords(k.title), body: contentWords(k.syllabus || '') }));
  const freq = new Map();
  for (const b of bags) for (const w of b.title) freq.set(w, (freq.get(w) || 0) + 1);
  const common = w => (freq.get(w) || 0) >= Math.max(3, Math.ceil(courses.length / 4));
  return bags
    .map(b => {
      const inTitle = b.title.filter(w => said.has(w) && !common(w)).length,
        inBody = b.body.filter(w => said.has(w) && !common(w)).length;
      return { k: b.k, inTitle, inBody, score: 3 * inTitle + inBody };
    })
    .filter(x => x.inTitle >= 1 || x.inBody >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(x => x.k);
}
// ¿Nombró un tema? (alguna palabra con contenido después de quitar las de la lengua y las de pedir)
export const topicWords = text => contentWords(text).filter(w => !/^(recomend|conveng|interes|algo|cursill)/.test(w));
// ¿Lo que dice nombra temas que el curso de la conversación no cubre? (palabras con contenido que ni su título ni su
// temario tienen). «¿este curso aplica para bovinos?» en un curso de aves: sí → no se contesta con «requisitos».
export function notCovered(text, course) {
  const own = new Set([...contentWords(course?.title || ''), ...contentWords(course?.syllabus || '')]);
  return contentWords(text).filter(w => !own.has(w) && !/^(conocimient|previ|requisit|nivel|experienci)/.test(w));
}

// ---- «Sí, me interesa» (botón de una plantilla de seguimiento) dicho a media conversación.
export const INTERESTED =
  /^(si )?(me interesa|me interesa el curso|me interesa mucho|estoy interesad[oa]|si estoy interesad[oa])( gracias)?$/;

// ---- Saber si la persona busca trabajo, no un curso.
export const JOBS =
  /\b(vacante|vacantes|empleo|busco trabajo|bolsa de trabajo|contratan|estan contratando|dar clases con ustedes|ser (docente|instructor|instructora|ponente|maestro|maestra) con ustedes|trabajar con ustedes|colaborar con ustedes)\b/;
