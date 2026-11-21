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
const RECEIPT = /\b(comprobante|comprobantes|voucher|baucher|bauche|captura del pago|ficha de deposito)\b/;
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
  /\b((dos|2|tres|3|cuatro|4|cinco|5|varias|varios) (personas|lugares|inscripciones|alumnos|companeros|companeras)|(los|las|el de|la de) (dos|2|tres|3) (personas|lugares)?|somos (dos|2|tres|3|cuatro|4|cinco|5|varios|varias)|para (mi|un|una) (hermana|hermano|amiga|amigo|esposa|esposo|companera|companero|socio|socia|hija|hijo)|tambien a mi|(otra|otras) personas?|en un solo deposito)\b/;
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

// ---- Datos para la constancia (nombre completo, correo, teléfono). Se reconocen con seguridad cuando la persona dice
// para qué son («para la constancia», «para el registro») o los ofrece («les paso mis datos»); un correo, un teléfono o
// «mi nombre es…» sueltos sólo cuentan cuando ya hay un pedido o una inscripción en la conversación (lo decide replies).
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const NAME_INTRO =
  /(?:mi nombre(?: completo)?(?: para (?:la constancia|el certificado|el diploma|el registro|la inscripcion))?(?: es| seria|:)|nombre completo(?: es|:)?|a nombre de|el nombre (?:para|en) (?:la constancia|el certificado|el diploma)(?: es|:)?|(?:para|en) (?:la constancia|el certificado|el diploma)(?: va| es| seria)?(?: a nombre de)?|nombre:)\s+(.+)/i;
export function certData(raw) {
  const text = String(raw || ''),
    email = (text.match(EMAIL) || [])[0] || '',
    noMail = text.replace(EMAIL, ' ');
  let phone = '';
  for (const m of noMail.match(/\+?\d[\d\s().-]{7,}\d/g) || []) {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13) {
      phone = (m.trim().startsWith('+') ? '+' : '') + digits;
      break;
    }
  }
  let name = '';
  const intro = NAME_INTRO.exec(
    noMail
      .replace(/\+?\d[\d\s().-]{7,}\d/g, ' ')
      .normalize('NFC')
      .replace(/[¿?¡!]/g, ' '),
  );
  const candidate = intro
    ? intro[1]
    : /^[\p{Lu}\s'’.-]{5,}$/u.test(noMail.trim()) // un nombre escrito todo en mayúsculas, solo en el mensaje
      ? noMail.trim()
      : '';
  if (candidate) {
    const words = candidate
      .split(/[,;\n]| y | mi correo| mi cel| mi telefono| correo| cel\b| telefono/i)[0]
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.:]+$/, '')
      .split(' ')
      .filter(Boolean);
    if (
      words.length >= 2 &&
      words.length <= 6 &&
      words.every(w => /^[\p{L}'’.-]{1,30}$/u.test(w)) &&
      !words.some(w => /^(es|para|la|el|constancia|certificado|diploma|registro|quien)$/i.test(w) && words.length < 3)
    )
      name = words.join(' ');
  }
  return { name, email, phone };
}
export const hasCertData = d => Boolean(d.name || d.email || d.phone);
// Señal fuerte (se reconoce sin pedido): habla de la constancia o del registro y trae o promete sus datos, o pregunta
// cómo escribir su nombre.
const CERT_WORDS = /\b(constancia|certificado|diploma|registro|inscripcion)\b/;
const OFFERS =
  /\b((te|les|le) (paso|mando|envio|comparto|dejo) (mis|mi) (datos|nombre|correo|cel|celular|telefono|numero|whats)|mis datos (son|para|van)|aqui (van|estan|te van|les van) mis datos)\b/;
const HOW_NAME =
  /\b(el nombre va (con|en)|como (pongo|escribo|pongo mi|escribo mi) (mi |el )?nombre|nombre (va )?con mayusculas)\b/;
export function certDataSignal(t, raw) {
  if (HOW_NAME.test(t) || OFFERS.test(t)) return true;
  if (/\b(factura|pago|deposito|transferencia|quien)\b/.test(t)) return false; // «factura a nombre de…», «¿a nombre de quién pago?»
  const d = certData(raw);
  if (/\b(mi nombre completo|nombre completo)\b/.test(t) && d.name) return true;
  return CERT_WORDS.test(t) && hasCertData(d);
}
// Señal débil: un correo, un teléfono, «mi nombre es…» o un nombre en mayúsculas, sin más. Sólo cuenta tras un pedido.
export const weakCertData = (t, raw) =>
  !/[?¿]/.test(String(raw || '')) && hasCertData(certData(raw)) && !/\b(factura|cuenta|clabe|quien)\b/.test(t);

// ---- Accesos después de pagar: «¿dónde entro?», «no me llegó el enlace», «no me han agregado al grupo», «no abre».
const ACCESS_NOUN =
  /\b(link|links|enlace|enlaces|liga|ligas|acceso|accesos|zoom|meet|grupo|clase|clases|sesion|plataforma|material|materiales|aula|curso)\b/;
const ACCESS_ASK =
  /\b(no (me )?(llega|llego|ha llegado|han llegado|abre|funciona|deja|carga|puedo entrar|aparece)|donde (entro|ingreso|veo|me conecto|esta|estan|lo veo|la veo)|como (entro|ingreso|accedo|veo|me meto)|me (pasan|pasas|pasa|mandan|mandas|envian|envias|comparten|agregan|agregas|agregaran)|cuando me (mandan|envian|agregan|pasan|llega|llegan|dan)|no me (agregan|han agregado|han mandado|han enviado|llega|llego)|todavia no me|aun no me|ya empezo|como ingreso|despues del pago como|se (corto|cayo|trabo|congelo)|no se (escucha|oye|ve))\b/;
export const ACCESS_PROBLEM =
  /\b(no (abre|funciona|deja|carga|sirve|puedo entrar)|se (corto|cayo|trabo|congelo)|no se (escucha|oye|ve)|marca error|da error)\b/;
export const isAccess = t => ACCESS_NOUN.test(t) && ACCESS_ASK.test(t);

// ---- Fechas que no son «¿cuándo empieza?»: hasta cuándo se puede inscribir, otra fecha y «avísame de la siguiente».
export const DEADLINE =
  /\b(hasta (que|cuando)|aun (me )?puedo (inscribir|registrar|entrar|apuntar)|todavia (me )?puedo (inscribir|registrar|entrar|apuntar)|todavia alcanzo|aun alcanzo|alcanzo a (entrar|inscribirme|registrarme)|ultimo dia|fecha limite|cuando cierran|cierran (las )?inscripciones)\b/;
export const NEXT =
  /\b(otra fecha|otras fechas|siguiente (fecha|apertura|edicion|generacion|grupo)|proxima (fecha|apertura|edicion|generacion)|vuelv\w* a (abrir|dar|impartir)|lo (vuelven|van) a (abrir|dar)|habra otr[oa]|otra generacion|otro grupo|de la siguiente)\b/;
export const NOTIFY = /\b(avisame|avisenme|me avisan|me avisas|me pueden avisar|aviseme|me avisen)\b/;

// ---- Objeción de tiempo («no tengo tiempo», «salgo a las 8», «estoy de guardia»): no es una pregunta de fechas.
export const TIME_OBJECTION =
  /\b(no tengo tiempo|no me da tiempo|no llego|no alcanzo a (llegar|conectarme)|salgo (de \w+ )?(a las|tarde)|estoy de guardia|tengo guardia|trabajo (en )?ese horario|se me (cruza|empalma)|no puedo en ese horario|esas fechas no)\b/;

// ---- Recomendar un curso sin IA: con los títulos y temarios del catálogo de la marca y familias de palabras del ramo.
// Pide una recomendación o busca cursos de un tema («¿cuál me recomiendas?», «¿tienen algo de cirugía?»).
const ASKS_COURSE =
  /\b(recomiend\w*|me conviene|cual (me )?(sirve|conviene|tomo)|que curso|cual curso|por cual (empiezo|empezar)|(tienen|hay|manejan|dan|ofrecen) (algo|alguno|algun curso|algun diplomado|algun taller|cursos?|diplomados?|talleres?) (de|sobre|para|con)|tienen de)\b/;
// Cuenta a qué se dedica («soy estudiante», «trabajo con perros», «tengo un rancho»): cuenta como pedir recomendación sólo
// si además nombra una especie o un tema, o pregunta si el curso le sirve.
const SAYS_ROLE = /\bsoy (estudiante|tecnico|tecnica|pasante|auxiliar|asistente|veterinari[oa]|mvz|medico|medica)\b/;
const SAYS_WORK =
  /\b(trabajo (con|en)|tengo (un|una) (rancho|clinica|estetica|granja|criadero|consultorio|hospital|veterinaria))\b/;
export const FITS = /\b(me sirve|sirve|puedo tomar\w*|lo puedo tomar|es para mi|aplica para|me conviene este)\b/;
export const wantsCourses = t =>
  ASKS_COURSE.test(t) || (SAYS_ROLE.test(t) && (FITS.test(t) || topicSaid(t))) || (SAYS_WORK.test(t) && topicSaid(t));
export const RECOMMEND = { test: wantsCourses };
const FAMILIES = [
  ['perr', 'gat', 'canin', 'felin', 'mascot', 'pequen'],
  ['bovin', 'vaca', 'ganad', 'rancho', 'becerr', 'lecher'],
  ['ave', 'gallin', 'pollo', 'avicol', 'postura', 'engord'],
  ['reptil', 'exotic', 'tortug', 'serpient', 'iguan', 'conej', 'huron', 'convencional', 'hamster'],
  ['cirug', 'quirurg', 'esteriliz', 'castrac', 'anestes'],
  ['laborator', 'citolog', 'hemogram', 'analisis', 'microscop'],
  ['derma', 'piel', 'alergi', 'otitis'],
  ['etolog', 'conduct', 'comport'],
  ['nutric', 'dieta', 'aliment'],
  ['urgenc', 'emergenc', 'auxili', 'trauma'],
  ['geriatr', 'viejit', 'senior', 'ancian'],
  ['parasit', 'pulga', 'garrapat'],
  ['equin', 'caball'],
  ['porcin', 'cerd'],
];
// Palabras que aparecen en muchos títulos o en cualquier pregunta y no dicen de qué tema se habla.
const GENERIC = new Set(
  [
    'curso',
    'cursos',
    'tienen',
    'tiene',
    'algo',
    'alguno',
    'hay',
    'clinica',
    'clinico',
    'veterinaria',
    'veterinario',
    'medicina',
    'manejo',
    'practica',
    'animal',
    'animales',
    'especie',
    'especies',
    'trabajo',
    'tengo',
    'quiero',
    'recomiendas',
    'recomienda',
    'sirve',
    'conviene',
    'estudiante',
    'tecnico',
    'semestre',
    'cual',
    'cuales',
    'manejan',
    'diplomado',
    'diplomados',
    'taller',
    'talleres',
    'casos',
    'caso',
    'basico',
    'avanzado',
    'tomar',
    'tomarlo',
    'para',
    'sobre',
    'como',
    'este',
    'esta',
    'ese',
    'tambien',
  ].map(stem),
);
const rootsOf = text =>
  tokens(text)
    .map(stem)
    .filter(w => w.length >= 3 && !GENERIC.has(w));
const hits = (root, word) => word.startsWith(root) || (root.length >= 5 && root.startsWith(word) && word.length >= 5);
// ¿Nombra una especie o un tema de las familias? (sin mirar el catálogo)
export function topicSaid(t) {
  const said = rootsOf(t);
  return /\b(grandes|pequenas) especies\b/.test(t) || FAMILIES.some(fam => said.some(w => fam.some(r => hits(r, w))));
}
// Los temas que nombra el texto: raíces de familia (y su familia completa) más palabras propias que coinciden con un
// título o temario. `courses`: [{id, title, syllabus}].
export function recommend(text, courses, { max = 5 } = {}) {
  const t = plain(text),
    said = rootsOf(t),
    wanted = new Set();
  for (const fam of FAMILIES) if (said.some(w => fam.some(r => hits(r, w)))) fam.forEach(r => wanted.add(r));
  if (/\bgrandes especies\b/.test(t)) for (const r of [...FAMILIES[1], ...FAMILIES[12], ...FAMILIES[13]]) wanted.add(r);
  if (/\bpequenas especies\b/.test(t)) FAMILIES[0].forEach(r => wanted.add(r));
  const bags = courses.map(k => ({ k, title: rootsOf(k.title), body: rootsOf(k.syllabus || '') }));
  // palabras de la persona que nombran algo de algún curso (p. ej. «citología», «hemograma»), además de las familias
  const vocab = new Set(bags.flatMap(b => [...b.title, ...b.body]));
  for (const w of said) if (w.length >= 5 && [...vocab].some(v => hits(w, v))) wanted.add(w);
  if (!wanted.size) return [];
  const roots = [...wanted];
  return bags
    .map(b => ({
      k: b.k,
      score:
        2 * b.title.filter(w => roots.some(r => hits(r, w))).length +
        b.body.filter(w => roots.some(r => hits(r, w))).length,
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(x => x.k);
}

// ---- «Sí, me interesa» (botón de una plantilla de seguimiento) dicho a media conversación.
export const INTERESTED =
  /^(si )?(me interesa|me interesa el curso|me interesa mucho|estoy interesad[oa]|si estoy interesad[oa])( gracias)?$/;

// ---- Saber si la persona busca trabajo, no un curso.
export const JOBS =
  /\b(vacante|vacantes|empleo|busco trabajo|bolsa de trabajo|contratan|estan contratando|dar clases con ustedes|ser (docente|instructor|instructora|ponente|maestro|maestra) con ustedes|trabajar con ustedes|colaborar con ustedes)\b/;
