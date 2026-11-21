import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { normalize, bestMatch, validateDraft, tokens, stem } from './ai-provider.mjs';
import { seedBrandKnowledge } from './replies-schema.mjs';
import { isOpen, openingLabel } from './service-hours.mjs';
import { rankKnowledge } from './retrieval.mjs';
import { customerMemory } from './memory.mjs';
import * as copy from './reply-copy.mjs';
import { forBrand, isRealBrand } from './lib/real-mode.mjs';
import { brandCourses, matchCourse, byNumber, candidates } from './course-match.mjs';
import * as sales from './lib/sales-replies.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const MODES = ['off', 'suggest', 'templates', 'autonomous'];
export const INTENTS = [
  'opt_out',
  'human',
  'refund',
  'enroll',
  'payment',
  'price',
  'schedule',
  'syllabus',
  'certificate',
  'requirements',
  'modality',
  'recording',
  'duration',
  'greeting',
  'thanks',
  'identity',
  'decline',
  'objection',
  'seats',
  'courses',
  'affirm',
  'later',
  'bye',
  'help',
  'menu',
  'choose_course',
  'access',
  'cert_data',
  'unknown',
];
// Mensajes de trato (saludo, gracias, «sí», «no», «espera», «¿sigues ahí?»…): se contestan con un texto fijo y NO cuentan como pregunta sin respuesta.
export const SOFT_INTENTS = [
  'greeting',
  'thanks',
  'affirm',
  'decline',
  'later',
  'bye',
  'help',
  'menu',
  'identity',
  'choose_course',
];
// Con el primer mensaje de una conversación estas intenciones se contestan tal cual; las demás de trato reciben la bienvenida.
const DIRECT_INTENTS = ['seats', 'courses', 'identity', 'objection'];
// Respuestas cortas que se leen contra el último mensaje del asistente («sí» después de «¿Quieres apartar tu lugar?»).
const FOLLOW_UP = ['affirm', 'thanks', 'greeting', 'decline'];
const YES =
  /^(si+|sip|simon|claro|claro que si|por supuesto|desde luego|si claro|por favor|porfa|porfavor|si por favor|si porfa|quiero|si quiero|lo quiero|si lo quiero|me interesa|si me interesa|adelante|dale|va|sale|sale va|orale|bueno|andale|juega|si gracias|hagamoslo|de acuerdo|esta bien|ok|okey|okay|oki|vale)$/;
const STRONG_YES =
  /^(si+|sip|simon|claro que si|por supuesto|si claro|si por favor|si porfa|quiero|si quiero|lo quiero|si lo quiero|me interesa|si me interesa|adelante|dale|hagamoslo|si gracias)$/;
const OPTIONS = ['Precio', 'Temario', 'Fechas'],
  WITH_HUMAN = ['Precio', 'Fechas', 'Hablar con asesor'],
  OFFER_BUTTONS = ['Sí, con un asesor', 'Ver opciones'];
const clean = raw => normalize(raw).replace(/\s+/g, ' ').trim();
const TOPIC_INTENTS = ['certificate', 'payment', 'requirements', 'modality', 'recording', 'duration'];
// «¿Qué pasa si un día no puedo conectarme a la sesión?» menciona palabras de horario pero pregunta por una SITUACIÓN: se contesta con
// el conocimiento aprobado (o la IA), no con la ficha de fechas del catálogo.
const SITUATION = /\b(que pasa si|y si|si no puedo|no puedo|no alcanzo|no me deja|se me|problema)\b/;
const CATALOGUE_INTENTS = ['schedule', 'syllabus', 'duration'];
// Un primer mensaje con una pregunta concreta merece respuesta, no sólo la bienvenida.
const looksLikeQuestion = raw => /[?¿]/.test(raw) || normalize(raw).split(' ').filter(Boolean).length >= 6;
// Cada regla: [intención, expresión, confianza, condición opcional sobre el texto normalizado]. El orden importa: gana la primera que coincide.
// Una regla demasiado amplia contesta MAL sin costo («¿vale la pena?» no es una pregunta de precio; «¿qué sabré hacer cuando termine?» no es de
// fechas): ante la duda, la pregunta debe caer en «unknown» y resolverse con el conocimiento aprobado o la IA, no con la ficha equivocada.
const words = t => t.split(' ').filter(Boolean).length;
const PATTERNS = [
  // «¿Eres un bot?» pregunta con quién habla; no pide un asesor (salvo que además lo pida: «quiero hablar con una persona real»).
  [
    'identity',
    /\b(eres|es|hablo con|estoy hablando con|me atiende|me contesta|esto es) (un |una |el |la )?(bot|robot|maquina|persona|humano|humana|ia|inteligencia artificial|asistente virtual|alguien real|persona real)\b|\bquien (eres|me atiende|me contesta|habla|escribe)\b|\bcon quien (hablo|estoy hablando|tengo el gusto)\b|^(bot|robot)$/,
    0.85,
    t =>
      !/\b(quiero|necesito|prefiero|mejor|asesor|asesora|agente|ponme|dame|pasame|pasa|pasas|pasen|comunicame|comunica|comunicas|comuniquen)\b/.test(
        t,
      ),
  ],
  // «persona» y «alguien» sueltos no piden un asesor («¿aplica para alguien que apenas empieza?»): sólo cuando se pide que alguien atienda.
  [
    'human',
    /\b(asesor|asesora|humano|atencion|hablar con|persona real|(con|a) (una|alguna) persona|una persona del equipo|(atienda|atiende|responda|conteste|ayude|escriba|llame) (una|alguna) persona|con alguien|alguien (que )?(me )?(atienda|ayude|llame|explique|responda|conteste)|alguien me (puede|podria)|llamenme|llamame|llamada|(pueden|podrian|puedes|podria|puede) (llamar|marcar)(me)?)\b/,
    0.9,
  ],
  [
    'refund',
    /\b(reembolso|devolucion|devolver|devuelv|queja|molest|pesimo|fraude|engan)|\b(regres\w*|quiero|y|de vuelta) mi dinero\b|\bmi dinero de (vuelta|regreso)\b/,
    0.9,
  ],
  // «No», «no gracias», «ya no me interesa», «no quiero inscribirme»: se despide sin insistir. Va antes de «enroll» y de «greeting» («me interesa»).
  [
    'decline',
    /^(no+|nel|nop|nope|no gracias|no muchas gracias|gracias no|gracias pero no|no por ahora|por ahora no|ahorita no|ahora no|no de momento|de momento no|por el momento no|no por el momento|mejor no|no quiero|ya no|no ya no|ya no gracias)$|\b(ya no|no) me interesa\b|\bno estoy interesad[oa]\b|\bya no (lo )?quiero\b|\b(no|ya no|todavia no|aun no) (me )?(quiero|voy a|pienso) (inscribir|registrar|apuntar|anotar)/,
    0.8,
    (t, raw) => words(t) <= 7 && !/[?¿]/.test(raw),
  ],
  // ---- Venta y posventa (docs/PLAN_RESPUESTAS_DE_VENTA.md). Busca trabajo, no un curso: no es una pregunta de cupo («vacante»).
  ['help', sales.JOBS, 0.8],
  // Datos para la constancia («mi nombre completo para la constancia es…», «les paso mis datos»): no son una pregunta del
  // certificado ni una inscripción nueva. Un correo o un nombre sueltos se reconocen en plan(), sólo si ya hay un pedido.
  ['cert_data', /\S/, 0.8, (t, raw) => sales.certDataSignal(t, raw)],
  // Accesos después de pagar («¿dónde entro?», «no me llegó el enlace», «no me han agregado al grupo»).
  // Sólo con una inscripción activa o un pedido pagado o en revisión (plan() la vuelve a leer sin esta regla si no los hay).
  ['access', /\S/, 0.8, t => sales.isAccess(t)],
  // «Ya realicé el pago de mi inscripción»: avisar de un pago gana siempre a la inscripción (antes creaba otro pedido).
  ['payment', /\S/, 0.85, t => sales.claimsPaid(t)],
  // «¿Hasta qué día me puedo registrar?» pregunta un plazo: no pide crear un pedido todavía.
  ['schedule', sales.DEADLINE, 0.8],
  [
    'enroll',
    /\b(inscrib|registr|apuntar|apuntarme|apunto|anotarme|quiero el curso|quiero entrar|quiero tomarlo|me anoto|como me inscribo)/,
    0.85,
    t =>
      !/\b(no|ya no|todavia no|aun no) (me )?(quiero|voy a|pienso|deseo) (inscribir|registrar|apuntar|anotar|el curso|entrar|tomarlo)/.test(
        t,
      ) &&
      // «me registré pero no me llegó nada», «ya me inscribí»: dice que ya lo hizo, no pide un pedido nuevo
      !/\b(ya )?(me )?(registre|inscribi|apunte|anote)\b/.test(t),
  ],
  // Inscripción dicha como sustantivo o decisión: «el proceso de inscripción», «apartar mi lugar», «lo tomo», «me apunto».
  [
    'enroll',
    /\b(inscripcion|apartar (mi |el |un )?lugar|aparto (mi )?lugar|lo tomo|la tomo|lo quiero tomar|quiero tomar(lo)?|me apunto|estoy interesad[oa] en (tomarlo|tomar|inscribirme|el curso))\b/,
    0.8,
    // «¿qué incluye la inscripción?» y «gracias, lo tomo en cuenta» no piden un pedido
    t =>
      !/\b(cuanto|costo|precio|cuesta|requisitos?|cierran|hasta|incluye|incluyen|en cuenta)\b|\bno (quiero|voy a|pienso)\b/.test(
        t,
      ),
  ],
  // «Está caro», «no me alcanza»: no es una pregunta de pago ni de precio; se contesta con el precio vigente y la opción de hablar con una persona.
  [
    'objection',
    /\b(caro|cara|carisimo|carisima|costoso|costosa|no me alcanza|no tengo (dinero|presupuesto|para pagar(lo)?)|no puedo pagar(lo)?|fuera de mi presupuesto|es mucho dinero|mas barato|mas economico|rebaja)\b/,
    0.75,
    t => !/comprobante|pague|transferi|deposite|\btiempo\b/.test(t),
  ],
  // «No tengo tiempo», «estoy de guardia»: tampoco es una pregunta de fechas (antes recibía otra vez la ficha de fechas).
  [
    'objection',
    sales.TIME_OBJECTION,
    0.75,
    (t, raw) =>
      !/\b(grabaci\w*|grabad[oa]s?|repeticion|ver despues|verlo despues|verla despues)\b/.test(t) &&
      !(/[?¿]/.test(raw) && /\b(a que hora|que hora|cuando|que dias?|horario)\b/.test(t)), // «¿a qué hora es? salgo tarde» pregunta la hora
  ],
  // «¿Cuánto hay que pagar?» pregunta el precio, no una forma de pago: va antes que «payment».
  ['price', /\bcuanto (se |hay que |tengo que |debo |es lo que hay que )?(pag(a|ar|o)|cobran)\b/, 0.85],
  [
    'payment',
    /\b(comprobante|pague|pago|pagos|pagar|transferencia|transferi|transfiero|deposito|deposite|depositar|tarjeta|oxxo|spei|factura|facturan?|facturar|cfdi|iva|meses sin intereses|msi|parcialidades|mensualidades|en (dos|2|tres|3) (partes|pagos)|numero de cuenta|cuenta bancaria|clabe|voucher|baucher|bauche)\b/,
    0.85,
  ],
  // Duración va antes que precio: «¿cuánto dura?» no es una pregunta de precio. «¿Cuánto tiempo tengo para…?» tampoco es de duración.
  [
    'duration',
    /\b(duracion|cuanto dura|cuantas (horas|sesiones|clases|semanas)|cuanto tiempo (dura|es|son|tarda|lleva|toma)|cuantos dias (es|son|dura)|cuantos dias$)\b/,
    0.8,
  ],
  [
    'price',
    /\b(precio|precios|cuesta|costo|costos|inversion|promo|promos|promocion|promociones|descuento|descuentos|oferta|cupon|cupones|cuanto (cuesta|vale|sale|es|seria|cobran|me queda|queda)|en cuanto|que vale|queda en \d+)\b|^cuanto$/,
    0.85,
  ],
  // Otra fecha («¿va a haber otra fecha?», «avísame de la siguiente»): ni la ficha de siempre ni una pregunta sin respuesta.
  [
    'schedule',
    /\S/,
    0.8,
    t => sales.NEXT.test(t) || (sales.NOTIFY.test(t) && /\b(siguiente|proxima|otra|vuelv\w*|abrir|abran)\b/.test(t)),
  ],
  // «¿Hay repetición?» o «¿lo veo después?» preguntan por la grabación aunque mencionen el horario.
  [
    'recording',
    /\b(repeticion|se graban?|quedan? grabad[oa]s?|lo veo despues|verlo despues|verla despues|ver despues|grabacion|grabaciones|grabad[oa]s?)\b/,
    0.8,
  ],
  [
    'schedule',
    /\b(fecha|fechas|horario|horarios|calendario|empieza|empiezan|inicia|inician|comienza|comienzan|arranca|a que hora|que hora|(que|cual|primer|ultimo|proximo) dias?|cuando (es|son|seria|empieza|empiezan|inicia|inician|comienza|comienzan|arranca|abren|hay|toca)|para cuando|quien (lo |la |los |las |nos )?(da|dara|imparte|impartira|ensena|va a dar|va a impartir)|docente|docentes|profesor|profesora|maestro|maestra|instructor|ponente|(es|son|sera|seria) (en la|por la|de) (noche|tarde|manana)|hoy (es|hay) (la )?clase|es hoy|ya empezo|ya inicio|ya comenzo|ya arranco)\b|^cuando$/,
    0.8,
  ],
  [
    'syllabus',
    /\b(temario|incluye|temas?|contenido|que voy a aprender|programa|de que (se )?trata|que (se )?(ve|vera|veremos|ensenan)|que es (esto|eso|el curso))\b/,
    0.8,
  ],
  // Validez oficial, SEP, cédula, valor curricular: se contesta sólo lo que consta (ver plan()), nunca «Sí».
  ['certificate', /\S/, 0.85, t => sales.isValidity(t)],
  // «diplomados» no es «diploma»: «¿manejan diplomados?» pregunta por otros cursos.
  ['certificate', /\b(certificad|constancia|diplomas?\b|aval|validez|reconocimiento)/, 0.85],
  [
    'requirements',
    /\b(requisito|conocimientos previos|necesito saber|que necesito|(desde|con|en) (el|mi|un) (celular|cel|telefono|tablet))\b/,
    0.8,
  ],
  [
    'modality',
    /\b(modalidad|en linea|online|presencial|virtual|zoom|meet|plataforma|donde es|donde se imparte|donde me conecto|como me conecto|por donde (es|son|se da)|en vivo|ubicad[oa]s?|ubicacion|sucursal|sucursales|direccion|donde (estan|se encuentran|quedan)|donde se toma|donde es la clase|donde son las clases)\b/,
    0.8,
  ],
  ['recording', /\b(grabaci|grabad|graban?\b|grabar\b|no puedo asistir|repeticion|ver despues)/, 0.8],
  // Cupo y otros cursos: datos del catálogo.
  [
    'seats',
    /\b(cupos?|lugar|lugares|vacantes?|lleno|espacio|espacios)\b/,
    0.8,
    t =>
      /\b(hay|queda|quedan|cuantos|todavia|aun|tienen|lleno|disponibles?|cupos?)\b/.test(t) &&
      !/\b(estacion\w*|parking|auto|autos|carro|coche|lugar de (la clase|reunion))\b/.test(t), // «¿hay espacio para estacionarse?»
  ],
  // Pide una recomendación o nombra una especie o un tema («¿cuál me recomiendas?», «tengo un rancho», «¿tienen algo de
  // cirugía?»): se contesta con los cursos de la marca que coinciden (plan()), sin IA.
  ['courses', sales.RECOMMEND, 0.8],
  [
    'courses',
    /\b(otros?|mas|cuales|que) (cursos|diplomados|talleres)\b|\b(cursos|diplomados|talleres) (tienen|hay|manejan|ofrecen|dan|imparten)\b|\botro (curso|diplomado|taller)\b|\b(manejan|tienen|hay|ofrecen|dan|imparten) (otros? )?(cursos|diplomados|talleres)\b/,
    0.8,
  ],
  // ---- Mensajes de trato. Casi todos exigen que el mensaje sea SÓLO eso, para no robarle una pregunta de verdad al conocimiento o a la IA.
  [
    'menu',
    /^(ver )?(las )?(opciones|menu)$|^el menu$|\bque (puedes|sabes|pueden) (hacer|responder|decirme)\b|\ben que (me )?(puedes|pueden) ayudar\b/,
    0.8,
  ],
  [
    'affirm',
    /^(si+|sip|simon|claro|claro que si|por supuesto|desde luego|si claro|por favor|porfa|porfavor|si por favor|si porfa|quiero|si quiero|lo quiero|si lo quiero|adelante|dale|va|sale|sale va|orale|bueno|andale|juega|si gracias|hagamoslo)$/,
    0.6,
  ],
  [
    'later',
    /\b(espera|esperame|espereme|un momento|un momentito|un segundo|dame chance|dame un momento|permiteme|dejame (pensarlo|verlo|checarlo|revisarlo|consultarlo|platicarlo)|deja lo (pienso|checo|reviso|consulto|platico)|lo (voy a|tengo que|quiero) (pensar|consultar|checar|platicar|revisar)|lo (pienso|consulto|checo|platico)|voy a pensarlo|tengo que pensarlo|(luego|despues|manana|al rato|mas tarde|ahorita|en la tarde|en la noche|la proxima semana|en la quincena) (te|les|le) (aviso|digo|confirmo|escribo|marco)|te aviso|les aviso|cuando (cobre|me paguen)|mas adelante|en otra ocasion|para la proxima)\b/,
    0.6,
    (t, raw) => words(t) <= 12 && !/[?¿]/.test(raw) && !SITUATION.test(t),
  ],
  [
    'bye',
    /^(bye|bay|adios|hasta luego|hasta pronto|hasta manana|nos vemos|chao|chau|cuidate|cuidense)\b|\bque (tengas?|tengan|pases?|pasen) (un )?(buen|bonito|lindo|excelente|buena|bonita|linda)\b/,
    0.6,
    t => words(t) <= 6,
  ],
  [
    'help',
    /^(disculpa|disculpe|disculpen|perdon|perdona|oye|oiga|oigan|hey|ey|eh|m+|h+m+|que|como|a ver|dime|digame|mande|ayuda|ayudame|una pregunta|una duda|una consulta|tengo una (duda|pregunta|consulta)|tengo dudas|me (puedes|pueden|podrias|podrian) ayudar|necesito ayuda|siguen ahi|sigues ahi|estan ahi|hay alguien|nadie contesta|nadie responde|que mas|y luego|y ahora|como le hago|que hago|otra vez|repite|repiteme|como dices|que dices|no (te |le |les )?(entiendo|entendi|comprendo))( una pregunta| una duda| una consulta| por favor| porfa)?$/,
    0.6,
  ],
  [
    'greeting',
    /\b(hola|buen[oa]s?|buen dia|informacion|info|informes|detalles|datos del curso|flyer|imagen|me interesa|saludos|saber mas|cuentame|platicame|explicame)\b/,
    0.6,
  ],
  // Un agradecimiento no es una pregunta: «¿el curso vale la pena?» debe resolverse con conocimiento o IA, no con «¡con gusto!».
  [
    'thanks',
    /\b(gracias|perfecto|ok|vale|listo|entendido)\b/,
    0.5,
    (t, raw) => !/vale la pena/.test(t) && (words(t) <= 4 || !/[?¿]/.test(raw)),
  ],
  // Acuses cortos: «okey», «entiendo», «de acuerdo», «eso es todo», «jaja».
  [
    'thanks',
    /\b(okey|okay|oki|okis|va|sale|claro|excelente|genial|super|de acuerdo|esta bien|muy bien|que bien|ah ya|ya vi|ya entendi|entiendo|enterad[oa]|eso es todo|es todo|nada mas|y ya|ja(ja)+|je(je)+)\b/,
    0.5,
    (t, raw) => words(t) <= 4 && !/[?¿]/.test(raw),
  ],
];

// Motor de respuestas v2. Reglas del proyecto que cumple: precios/fechas/cupos sólo del catálogo; nunca confirma pagos ni
// inscripciones; cada decisión queda en reply_log con intención, fuentes y motivo; las llamadas al proveedor de IA van fuera
// de las transacciones (plan() y commit() son síncronos; el proveedor se consulta entre ambos).
export function createReplies({
  db,
  catalogue,
  crm,
  contacts,
  operations,
  insertMessage,
  provider,
  payments = null,
  content = null,
  flows = null,
  now = Date.now,
  env = process.env,
}) {
  const TOP_K = Math.max(1, Math.min(20, Number(env.AI_KB_TOP_K) || 6)); // entradas de conocimiento que recibe la IA por llamada
  const defaults = brandId => ({
    brand_id: brandId,
    mode: 'templates',
    provider_enabled: 0,
    max_unknown: 2,
    revision: 0,
    updated_by: null,
    updated_at: null,
  });
  const settings = brandId =>
    db.prepare('SELECT * FROM reply_settings WHERE brand_id=?').get(brandId) || defaults(brandId);
  const entry = id =>
    typeof id === 'string' ? db.prepare('SELECT * FROM knowledge_entries WHERE id=?').get(id) : null;
  const view = e => e && { ...e, variants: JSON.parse(e.variants) };
  const approved = (brandId, courseId) =>
    db
      .prepare(
        "SELECT * FROM knowledge_entries WHERE brand_id=? AND status='approved' AND (course_id IS NULL OR course_id=?) ORDER BY course_id IS NULL,updated_at DESC",
      )
      .all(brandId, courseId)
      .map(view);

  // `skip`: intenciones que no aplican a esta conversación (p. ej. 'access' sin inscripción ni pedido pagado).
  function classify(raw, { skip = [] } = {}) {
    if (contacts.isOptOutText(raw)) return { intent: 'opt_out', confidence: 0.95 };
    const t = clean(raw);
    if (!t)
      return /[?¿]/.test(String(raw || ''))
        ? { intent: 'help', confidence: 0.6 }
        : /\p{Extended_Pictographic}/u.test(String(raw || ''))
          ? { intent: 'thanks', confidence: 0.5 }
          : { intent: 'unknown', confidence: 0 };
    for (const [intent, re, confidence, when] of PATTERNS)
      if (!skip.includes(intent) && re.test(t) && (!when || when(t, String(raw || ''))))
        return { intent, confidence };
    return { intent: 'unknown', confidence: 0 };
  }
  // Todas las intenciones que aparecen en el mensaje, en el orden de las reglas (para contestar varias preguntas a la vez).
  function classifyAll(raw) {
    const t = clean(raw),
      found = [];
    for (const [intent, re, , when] of PATTERNS)
      if (!found.includes(intent) && re.test(t) && (!when || when(t, String(raw || '')))) found.push(intent);
    return found;
  }
  // Respuestas seguidas SIN contestar: intención desconocida y ninguna fuente de conocimiento (ni aprobado ni usado por la IA). Una pregunta que
  // el conocimiento o la IA sí contestaron no cuenta, y los mensajes de trato («ok», «¿sigues ahí?») ni suman ni reinician la cuenta.
  const unanswered = r => {
    if (r.intent !== 'unknown') return false;
    try {
      return !JSON.parse(r.sources).some(s => s.type === 'knowledge');
    } catch {
      return true;
    }
  };
  const unknownStreak = conversationId => {
    let n = 0;
    for (const r of db
      .prepare(
        "SELECT intent,sources,action FROM reply_log WHERE conversation_id=? AND action IN ('replied','suggested','escalated') ORDER BY created_at DESC,rowid DESC LIMIT 10",
      )
      .all(conversationId)) {
      if (r.action === 'escalated') break;
      if (r.intent !== 'menu' && SOFT_INTENTS.includes(r.intent)) continue;
      if (unanswered(r)) n++;
      else break;
    }
    return n;
  }; // pedir las opciones (o decir «no» a la persona) reinicia la cuenta
  // Último mensaje que recibió la persona, si fue del asistente: su texto y si era la propuesta de pasar con una persona.
  const lastBot = conversationId => {
    const m = db
      .prepare(
        "SELECT id,text,sender_kind FROM messages WHERE conversation_id=? AND sender_kind!='customer' ORDER BY seq DESC LIMIT 1",
      )
      .get(conversationId);
    if (!m || m.sender_kind !== 'automation') return null;
    const r = db
      .prepare('SELECT intent,sources FROM reply_log WHERE conversation_id=? AND reply_message_id=?')
      .get(conversationId, m.id);
    return {
      text: String(m.text || ''),
      intent: r?.intent || null,
      offer: Boolean(r && r.sources.includes('"kind":"offer_human"')),
    };
  };
  // ---- Número de WhatsApp que atiende toda la marca (docs/PLAN_NUMERO_POR_CONSULTORA.md). Decide, sin escribir nada, si este mensaje elige o cambia el
  // curso de la conversación: por el número de la lista que se le acaba de ofrecer o porque nombra un curso de la marca. Con el curso todavía por elegir
  // basta una palabra propia del curso; a media conversación hace falta además una señal («el de aves», «también…»), y un pedido vigente lo impide.
  // ¿Se puede pasar la conversación al curso `hit`? 'same' (ya es su curso), 'taken' (la persona ya tiene otra conversación abierta de ese curso en
  // el mismo canal), 'blocked' (tiene un pedido vigente del curso actual: no se cambia solo) u 'ok'. Sólo lee: quien cambia es crm.moveConversation.
  function courseSwitch(c, hit) {
    const pending = Boolean(c.course_pending);
    if (!pending && hit.id === c.course_id) return 'same';
    if (
      db
        .prepare(
          "SELECT 1 FROM conversations WHERE customer_id=? AND course_id=? AND edition_id=? AND channel=? AND status!='resolved' AND id!=?",
        )
        .get(c.customer_id, hit.id, hit.editionId, c.channel, c.id)
    )
      return 'taken';
    if (!pending && payments?.openOrder(c.id)) return 'blocked';
    return 'ok';
  }
  // El curso que nombra una respuesta: el número de la lista que se le mostró (`titles`, en el orden en que salieron) o el nombre del curso. La misma
  // lectura que route() hace con la lista del asistente; `strict` pide además una señal («el de…», «curso») cuando la persona no está eligiendo.
  const pickCourse = (list, text, { titles = null, strict = false } = {}) =>
    (titles?.length && byNumber(list, text, titles.map((t, i) => i + 1 + '. ' + t).join('\n'))) ||
    matchCourse(list, text, { strict });
  // Devuelve null si no aplica (laboratorio, o número de un solo curso); si no, {list, pending, course? | ask? | blocked?}.
  function route(c, trigger) {
    if (!c.wa_number) return null;
    const number = db.prepare('SELECT multi FROM wa_numbers WHERE phone_number_id=?').get(c.wa_number),
      pending = Boolean(c.course_pending);
    if (!number?.multi && !pending) return null;
    const list = brandCourses(db, catalogue, c.brand_id),
      base = { multi: true, list, pending };
    if (pending && list.length === 1) return { ...base, course: list[0] };
    const shown = lastBot(c.id),
      hit =
        (shown && byNumber(list, trigger.text, shown.text)) || matchCourse(list, trigger.text, { strict: !pending });
    if (hit && (pending || hit.id !== c.course_id)) {
      const verdict = courseSwitch(c, hit);
      if (verdict === 'taken') return { ...base, ask: pending && list.length > 1 };
      if (verdict === 'blocked') return { ...base, blocked: hit };
      return { ...base, course: hit };
    }
    // Nombró algo que comparten varios cursos y ninguno gana: se le preguntará sólo por ésos (sin cambiar nada todavía).
    const narrow = hit ? [] : candidates(list, trigger.text, { strict: !pending });
    return { ...base, ask: pending && list.length > 1, narrow: narrow.length ? narrow : null };
  }
  const askedStreak = conversationId => {
    let n = 0;
    for (const r of db
      .prepare(
        "SELECT intent FROM reply_log WHERE conversation_id=? AND action IN ('replied','suggested') ORDER BY created_at DESC,rowid DESC LIMIT 4",
      )
      .all(conversationId)) {
      if (r.intent === 'choose_course') n++;
      else break;
    }
    return n;
  };
  // Otros cursos activos de la MISMA marca con una edición disponible (sólo títulos).
  const otherCourses = c =>
    db
      .prepare('SELECT id,title FROM courses WHERE brand_id=? AND active=1 AND id!=? ORDER BY title LIMIT 20')
      .all(c.brand_id, c.course_id)
      .filter(k => {
        try {
          return !catalogue.info(k.id).reason;
        } catch {
          return false;
        }
      })
      .slice(0, 6)
      .map(k => k.title);
  // ---- Venta y posventa (docs/PLAN_RESPUESTAS_DE_VENTA.md). Sólo leen.
  // El pedido más reciente del curso en esta conversación (cualquier estado) y si la persona ya está inscrita por aquí.
  const lastOrder = conversationId =>
    db
      .prepare(
        "SELECT * FROM orders WHERE conversation_id=? AND COALESCE(kind,'course')='course' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(conversationId);
  const enrolledHere = conversationId =>
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM enrollments n JOIN orders o ON o.id=n.order_id WHERE o.conversation_id=? AND n.status='enrolled' LIMIT 1",
        )
        .get(conversationId),
    );
  const sessionsOf = editionId =>
    db.prepare("SELECT count(*) n FROM edition_sessions WHERE edition_id=? AND status!='cancelled'").get(editionId).n;
  // Quien emite el certificado de la marca (Certificados → ajustes); el mismo valor por omisión que server/certificates.mjs.
  const issuerOf = brandId =>
    db.prepare('SELECT issuer_name FROM certificate_settings WHERE brand_id=?').get(brandId)?.issuer_name ||
    'IPCI · TEC Capital';
  // Accesos del curso (server/modules/course-access): el módulo se registra al crearse. Sin él, nadie reenvía accesos.
  let accessApi = null;
  const useAccess = api => {
    accessApi = api;
  };

  // Ningún fallo del asistente deja a la persona sin respuesta ni sin pase (docs/PLAN_RESPUESTAS_DE_VENTA.md): si armar la
  // respuesta falla (un dato del catálogo que ya no existe, una consulta que lanza), se contesta que una persona la atiende y
  // se pasa la conversación. El error queda en la bitácora del servidor.
  function plan(c, trigger, opts = {}) {
    try {
      return planOrThrow(c, trigger, opts);
    } catch (error) {
      console.error('Reply plan failed', error?.name, String(error?.message || '').slice(0, 160));
      return {
        mode: settings(c.brand_id).mode,
        intent: 'unknown',
        confidence: 0,
        reply: copy.escalate,
        sources: [],
        stage: null,
        handoff: true,
        prepared: null,
        reason: 'No se pudo armar la respuesta automática: pasa a una persona.',
        needsProvider: false,
        knowledge: [],
        buttons: null,
        order: false,
        course: { courseId: c.course_id, editionId: c.edition_id },
      };
    }
  }
  // Plan síncrono: decide intención, texto, fuentes y si hace falta el proveedor. No escribe nada.
  // `opts.noFlow`: hay un recorrido en curso (docs/PLAN_RECORRIDOS.md); el flujo de bienvenida no decora esta respuesta.
  // `opts.forcedIntent`: la persona pulsó una opción del recorrido que contesta el asistente (precio, temario…).
  function planOrThrow(c, trigger, opts = {}) {
    // El curso de ESTE mensaje: si lo elige o lo cambia, todo lo demás (catálogo, conocimiento, ficha) se planea ya con el curso nuevo; commit() lo guarda.
    const routed = route(c, trigger);
    if (routed?.course)
      c = { ...c, course_id: routed.course.id, edition_id: routed.course.editionId, course_pending: 0 };
    const s = settings(c.brand_id),
      user = db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id),
      first = (user?.name || '').split(' ')[0];
    // Flujo de bienvenida de la marca (server/flows.mjs): si la persona pulsó un botón del paso en el que va, ese botón manda. Un botón de acción
    // (precio, temario, fechas, inscribirse, asesor) equivale a pedirlo con esas palabras: se responde por el camino de siempre.
    const flow = (!opts?.noFlow && flows?.active(c.brand_id)) || null,
      pressed = flow ? flows.pressed(flow, c.id, trigger.text) : null,
      forced =
        (INTENTS.includes(opts?.forcedIntent) && opts.forcedIntent) ||
        (pressed?.kind === 'action' ? pressed.target : null);
    // Posventa sólo para quien ya compró: inscripción activa o pedido pagado o en revisión en esta conversación. Sin eso,
    // «¿me pasas el link para pagar?» o «¿me mandan información?» se leen como siempre (pago, ficha, temario…).
    const bought =
      c.id !== 'simulacion' && (enrolledHere(c.id) || ['paid', 'review'].includes(lastOrder(c.id)?.status));
    const ctx = catalogue.info(c.course_id, c.edition_id),
      course = ctx.course,
      cls = forced
        ? { intent: forced, confidence: 1 }
        : classify(trigger.text, { skip: bought ? [] : ['access'] }),
      situational =
        !forced &&
        CATALOGUE_INTENTS.includes(cls.intent) &&
        SITUATION.test(normalize(trigger.text)) &&
        !/\b(siguiente|proxima|otra fecha|vuelv\w* a abrir|hasta (que|cuando)|alcanzo a)\b/.test(clean(trigger.text)); // «no alcanzo esta vez, avísame de la siguiente» sí es de fechas
    let intent = situational ? 'unknown' : cls.intent,
      confidence = situational ? 0.3 : cls.confidence;
    // «Hola, quiero el curso de aves» como primer mensaje a un número que atiende toda la marca ELIGE el curso; no es todavía una inscripción:
    // recibe la ficha. Con «inscribirme», «registrarme» o «apuntarme» sí sigue el camino de la inscripción.
    if (
      routed?.course &&
      routed.pending &&
      intent === 'enroll' &&
      !forced &&
      !/inscrib|registr|apunt|anot/.test(normalize(trigger.text))
    ) {
      intent = 'greeting';
      confidence = 0.6;
    }
    const count = db
      .prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND sender_kind='customer'")
      .get(c.id).n;
    const fresh = count === 1 || Boolean(routed?.course); // primer mensaje, o acaba de elegir curso: lo que no sea una pregunta concreta recibe la ficha de ese curso
    // Respuestas cortas que sólo se entienden por lo que el asistente acaba de decir («sí», «va», «no»):
    //  · tras proponer una persona («¿Quieres que te pase con…?»): «sí» pasa a un asesor y «no» muestra las opciones;
    //  · tras invitar a inscribirse: «sí» sigue el camino de la inscripción, el mismo de «Quiero inscribirme» (nunca se confirma sola);
    //  · tras ofrecer datos («¿Te cuento el precio o las fechas?»): «sí» los contesta.
    let offered = null,
      followed = '';
    const prev = !forced && !pressed && FOLLOW_UP.includes(intent) ? lastBot(c.id) : null;
    if (prev) {
      const said = clean(trigger.text),
        yes = YES.test(said),
        whole = normalize(prev.text),
        lastQ = normalize((prev.text.match(/¿[^?¿]*\?/g) || []).pop() || '').trim();
      if (prev.offer && yes) {
        intent = 'human';
        confidence = 0.9;
        followed = 'Aceptó la propuesta de hablar con una persona.';
      } else if (prev.offer && intent === 'decline') {
        intent = 'menu';
        confidence = 0.8;
        followed = 'No quiso pasar con una persona: se le muestran las opciones.';
      }
      // Sólo cuenta una pregunta DIRECTA de inscripción («¿Quieres apartar tu lugar?»). Una pregunta con varias opciones («¿Quieres conocer el temario,
      // el precio o cómo inscribirte?», la bienvenida) no se contesta con un pedido: un «ok» ahí sólo recibe las opciones.
      // Y exige un «sí» claro («sí», «sí quiero», «me interesa»): «ok», «va» o «vale» sólo acusan recibo y no arman un pedido.
      else if (
        STRONG_YES.test(said) &&
        ((/apartar tu lugar|inscrib/.test(lastQ) && !/\bo\b/.test(lastQ)) ||
          (!lastQ && /quiero inscribirme|apartar tu lugar/.test(whole)))
      ) {
        intent = 'enroll';
        confidence = 0.8;
        followed = 'Respondió que sí a la invitación a inscribirse del mensaje anterior.';
      } else if (yes && !/inscrib/.test(lastQ)) {
        const info = [
          ['price', /\b(precio|costo)\b/],
          ['schedule', /\b(fechas?|horarios?)\b/],
          ['syllabus', /\btemario\b/],
        ]
          .filter(([, re]) => re.test(lastQ))
          .map(([k]) => k);
        if (info.length) {
          intent = info[0];
          confidence = 0.75;
          offered = info.length > 1 ? info : null;
          followed = 'Respondió que sí a lo que ofrecía el mensaje anterior (' + info.join(', ') + ').';
        }
      }
    }
    const said = clean(trigger.text);
    // «Sí, me interesa» a media conversación (el botón de una plantilla de seguimiento, o después de contestar una duda) pide
    // seguir con la inscripción del curso de esta conversación; reenviar la ficha no ayuda. Justo después de la ficha (la
    // bienvenida o un paso del flujo, que ya ofrecen opciones) se sigue contestando como siempre.
    if (
      !forced &&
      !pressed &&
      !fresh &&
      !followed &&
      intent === 'greeting' &&
      sales.INTERESTED.test(said) &&
      !(prev && ['greeting', 'flow'].includes(prev.intent))
    ) {
      intent = 'enroll';
      confidence = 0.8;
      followed = '«Sí, me interesa» fuera de la pregunta de la ficha: sigue el camino de la inscripción.';
    }
    // Un correo, un teléfono o un nombre sueltos cuando ya hay un pedido en esta conversación son los datos para la constancia.
    if (
      !forced &&
      !pressed &&
      ['unknown', 'greeting', 'thanks', 'help'].includes(intent) &&
      sales.weakCertData(said, trigger.text) &&
      c.id !== 'simulacion' &&
      db
        .prepare(
          "SELECT 1 FROM orders WHERE conversation_id=? AND status IN ('pending','review','paid') AND COALESCE(kind,'course')='course' LIMIT 1",
        )
        .get(c.id)
    ) {
      intent = 'cert_data';
      confidence = 0.75;
    }
    const payKind = intent === 'payment' ? sales.paymentKind(said) : null;
    // ¿El cliente pregunta algo concreto? (un tema del conocimiento, o una pregunta sin intención reconocida)
    const asks = TOPIC_INTENTS.includes(intent) || (intent === 'unknown' && looksLikeQuestion(trigger.text));
    const out = {
      mode: s.mode,
      intent,
      confidence,
      reply: '',
      sources: [],
      stage: null,
      handoff: false,
      prepared: null,
      reason: '',
      needsProvider: false,
      knowledge: [],
      buttons: null,
      order: false,
    };
    const flowValues = () => ({
      name: copy.firstName(user?.name),
      course: course.title,
      edition: ctx.edition.name,
      brand: ctx.brand.name,
    });
    const menu = (step, o = out) => {
      o.buttons = step.buttons.length ? step.buttons.map(b => b.label) : null;
      o.keepButtons = true;
      o.flow = { step: step.id };
    }; // los botones del paso viajan con la respuesta
    // Texto con opciones para tocar. Con un flujo de bienvenida encendido se ofrecen los botones de su primer paso (los que el flujo entiende).
    const options = (reply, buttons = OPTIONS) => {
      out.reply = reply;
      out.buttons = buttons;
      out.keepButtons = true;
      if (flow) {
        const st = flow.steps[0];
        if (st.buttons.length) {
          menu(st);
          out.sources.push({ type: 'flow', step: st.id });
        }
      }
    };
    const catalogueSource = {
      type: 'catalogue',
      courseId: course.id,
      editionId: ctx.edition.id,
      promotionId: ctx.promotion?.id || null,
      priceCents: ctx.priceCents,
      currency: ctx.currency,
    };
    const kb = approved(c.brand_id, c.course_id);
    const sessions = sessionsOf(ctx.edition.id),
      durationKnown = ctx.edition.starts_at !== null && (Boolean(ctx.edition.ends_at) || sessions > 0);
    // Bienvenida con la ficha vigente del curso (o la de anuncio): saludo, primer mensaje sin pregunta y respaldo del primer mensaje.
    const welcome = () => {
      out.prepared = catalogue.prepare(c, { kind: 'flyer' });
      const ad =
        c.referral && count === 1
          ? content?.render('ad_welcome', c.brand_id, { courseId: course.id, editionId: c.edition_id, name: first })
          : null;
      out.reply = ad ? ad.text : copy.welcome(ctx, user?.name);
      out.sources.push(
        catalogueSource,
        ad ? { type: 'template', kind: 'ad_welcome', id: ad.templateId } : { type: 'template', kind: 'welcome' },
      );
      out.buttons = ['Precio', 'Temario', 'Fechas'];
      if (flow) {
        const st = flow.steps[0];
        if (!ad) out.reply = flows.render(st.text, flowValues());
        if (!flow.withFlyer) out.prepared = null;
        menu(st);
        out.sources.push({ type: 'flow', step: st.id });
      }
      out.reason =
        count === 1
          ? 'Primer mensaje: bienvenida con la ficha vigente del curso.'
          : 'Saludo o petición de información: ficha vigente del curso.';
    };
    // Con un tema reconocido (pago, certificado, grabación…) no se usa una respuesta aprobada de OTRO tema reconocido aunque se parezca en palabras:
    // «¿cuánto tiempo tengo para pagar?» no se contesta con «¿cuánto dura el curso?».
    const pool = TOPIC_INTENTS.includes(intent)
      ? kb.filter(k => k.topic === intent || !TOPIC_INTENTS.includes(k.topic))
      : kb;
    const fromKnowledge = (threshold = 0.5) => {
      const hit =
        bestMatch(trigger.text, pool, threshold) ||
        (TOPIC_INTENTS.includes(intent) ? { entry: kb.find(k => k.topic === intent), score: 1 } : null);
      if (!hit?.entry) return false;
      out.reply = hit.entry.answer;
      out.sources.push({
        type: 'knowledge',
        id: hit.entry.id,
        revision: hit.entry.revision,
        question: hit.entry.question,
      });
      out.reason =
        'Conocimiento aprobado «' +
        hit.entry.question +
        '»' +
        (hit.score < 1 ? ' (parecido ' + Math.round(hit.score * 100) + '%)' : '') +
        '.';
      return true;
    };
    // Varias preguntas en un mensaje («¿qué temas incluye, y tiene certificado?»): antes sólo se contestaba la primera intención reconocida.
    // Se juntan cuando el mensaje une dos o más preguntas informativas (con «y», coma o un segundo signo de pregunta) y cada una tiene
    // respuesta en el catálogo o en el conocimiento aprobado. Pedir un asesor, una queja, inscribirse o avisar de un pago siguen su camino de siempre.
    const INFO = [
      'price',
      'schedule',
      'syllabus',
      'certificate',
      'requirements',
      'modality',
      'recording',
      'duration',
      'payment',
    ];
    const paidClaim = sales.claimsPaid(said);
    const several = (only = null) => {
      if (!only) {
        if (situational || paidClaim || !INFO.includes(intent)) return false;
        // señal de que son dos preguntas y no una: un conector («y», «también»…), una coma o dos signos de cierre de pregunta
        if (
          !/\b(y|e|tambien|ademas|aparte)\b|[,;]|\?.*\S.*\?/.test(
            normalize(trigger.text) + ' ' + trigger.text.toLowerCase(),
          )
        )
          return false;
      }
      const asked =
        only ||
        classifyAll(trigger.text)
          .filter(i => INFO.includes(i))
          .slice(0, 3);
      if (asked.length < 2) return false;
      // «¿cuántos días dura y en qué horario?»: el fin y las sesiones van dentro de la ficha de fechas, sin repetir el inicio
      const endsToo = durationKnown && asked.includes('schedule') && asked.includes('duration');
      const parts = [],
        sources = [];
      let kind = null;
      for (const it of asked) {
        if (it === 'price') {
          parts.push(copy.priceBody(ctx));
          kind = 'price';
        } else if (it === 'schedule') {
          parts.push(copy.scheduleBody(ctx) + (endsToo ? copy.durationExtra(ctx, sessions) : ''));
          kind = kind === 'price' ? kind : 'schedule';
        } else if (it === 'syllabus') {
          parts.push(copy.syllabusBody(ctx));
          kind = kind || 'syllabus';
        } else if (it === 'certificate' && sales.isValidity(said)) {
          parts.push(copy.validity(ctx, issuerOf(c.brand_id))); // nunca «Sí» a una validez oficial que no consta
        } else if (it === 'duration' && durationKnown) {
          if (endsToo) continue; // va dentro de la ficha de fechas, sin repetir el inicio
          parts.push(copy.durationBody(ctx, sessions));
          kind = kind || 'schedule';
        } else if (it === 'payment' && sales.paymentKind(said) !== 'methods') {
          continue; // factura, meses, varias personas…: la respuesta general de pago no los contesta
        } else {
          const entry = kb.find(k => k.topic === it);
          if (entry) {
            parts.push(entry.answer);
            sources.push({ type: 'knowledge', id: entry.id, revision: entry.revision, question: entry.question });
          }
        }
      }
      if (parts.length + (endsToo ? 1 : 0) < 2) return false; // sólo una tenía respuesta: se contesta como siempre
      if (kind) {
        out.prepared = catalogue.prepare(c, { kind });
        out.sources.push(catalogueSource);
      }
      out.sources.push(...sources);
      if (asked.includes('price')) out.stage = 'interesado';
      out.reply = copy.several(parts, { price: asked.includes('price') });
      out.reason =
        'Varias preguntas en un mensaje (' +
        asked.join(', ') +
        '): se contestan juntas con el catálogo vigente y el conocimiento aprobado.';
      return true;
    };
    // Recomendar sin IA («¿cuál me recomiendas?», «tengo un rancho», «¿tienen algo de reptiles?»): con los títulos y temarios
    // de los cursos de la marca que tienen una apertura disponible, hasta 5, con su inicio y precio vigentes. Si no dice
    // especie ni tema, se le pregunta (o contesta una respuesta aprobada) en lugar de soltar la lista completa.
    let notMine = false;
    const recommendation = () => {
      const list = brandCourses(db, catalogue, c.brand_id).map(k => ({
        ...k,
        syllabus: db.prepare('SELECT syllabus FROM courses WHERE id=?').get(k.id)?.syllabus || '',
      }));
      const items = sales
        .recommend(trigger.text, list)
        .map(k => {
          try {
            const x = catalogue.info(k.id, k.editionId);
            return { title: k.title, start: copy.startText(x.edition), price: copy.priceText(x) };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (items.length) {
        out.reply = copy.recommend(ctx, items, { multi: Boolean(routed?.multi && routed.list.length > 1) });
        out.sources.push(catalogueSource);
        out.reason =
          'Recomendación con el catálogo de la marca: ' +
          items.length +
          ' curso(s) que coinciden con lo que dijo (título y temario), con su inicio y precio vigentes.';
        return true;
      }
      if (!sales.RECOMMEND.test(said) && !sales.FITS.test(said)) return false;
      // Nombra temas que ESTE curso no cubre («¿este curso aplica para bovinos?» en uno de aves): ni requisitos (sonaría a
      // «sí») ni la lista: se resuelve como una pregunta sin intención (conocimiento, IA o una persona).
      if (sales.FITS.test(said) && sales.notCovered(trigger.text, course).length) {
        notMine = true;
        out.intent = 'unknown';
        out.confidence = 0.3;
        return false;
      }
      if (!sales.RECOMMEND.test(said)) return false;
      if (fromKnowledge(0.5)) return true;
      // Nombró un tema y ningún curso de la marca lo tiene: se dice claro y se ofrece lo que sí hay.
      if (sales.ASKS_TOPIC.test(said) && sales.topicWords(trigger.text).length) {
        out.reply = copy.noTopicMatch(ctx, otherCourses(c));
        out.sources.push(catalogueSource);
        out.reason = 'Buscó un tema que ningún curso de la marca tiene (título o temario): se dice y se ofrecen los cursos que sí hay.';
        return true;
      }
      // «Soy estudiante, ¿me sirve?», «soy técnico, ¿puedo tomarlo?»: pregunta por ESTE curso; contesta la respuesta aprobada de requisitos.
      const req = kb.find(k => k.topic === 'requirements');
      if (req && sales.FITS.test(said)) {
        out.reply = req.answer;
        out.sources.push({ type: 'knowledge', id: req.id, revision: req.revision, question: req.question });
        out.reason = 'Pregunta si el curso le sirve: respuesta aprobada de requisitos «' + req.question + '».';
        return true;
      }
      out.reply = copy.askTopic(ctx);
      out.reason =
        'Pide una recomendación sin decir especie ni tema: se le pregunta con qué trabaja en lugar de soltar la lista completa.';
      return true;
    };
    const POSTSALE = ['access', 'cert_data'].includes(intent) || ['paid', 'status'].includes(payKind); // ya compró: no depende del curso que elija ahora
    const OWN_PATH = ['opt_out', 'human', 'refund'].includes(intent) || (intent === 'payment' && paidClaim) || POSTSALE; // la baja, pedir una persona, una queja y avisar de un pago siguen su camino aunque falte el curso
    if (routed?.ask && !OWN_PATH) {
      const asked = askedStreak(c.id);
      out.intent = 'choose_course';
      out.confidence = 1;
      out.noFlow = true;
      if (asked >= 2) {
        out.handoff = true;
        out.reply = copy.escalate;
        out.reason = 'Se le preguntó dos veces qué curso le interesa y no se reconoció ninguno: pasa a una persona.';
      } else if (routed.narrow) {
        out.reply = copy.whichCourse(routed.narrow.map(k => k.title));
        out.reason =
          'Nombró algo que comparten ' + routed.narrow.length + ' cursos de la marca: se le pregunta cuál de ésos.';
      } else {
        out.reply = copy.chooseCourse(
          ctx.brand.name,
          routed.list.map(k => k.title),
          { again: asked > 0 },
        );
        out.reason =
          'El número atiende toda la marca y todavía no se sabe el curso: se le pregunta antes de hablar de precios o fechas.';
      }
    } else if (routed?.narrow && !OWN_PATH && !payments?.openOrder(c.id)) {
      out.intent = 'choose_course';
      out.confidence = 1;
      out.noFlow = true;
      out.reply = copy.whichCourse(routed.narrow.map(k => k.title));
      out.reason =
        'Pidió otro curso con una palabra que comparten ' +
        routed.narrow.length +
        ' cursos: se le pregunta cuál, sin cambiar nada todavía.';
    } else if (routed?.blocked && !OWN_PATH) {
      out.intent = 'choose_course';
      out.confidence = 1;
      out.noFlow = true;
      out.reply = copy.switchBlocked(ctx, routed.blocked.title);
      out.reason = 'Pidió otro curso teniendo un pedido vigente: no se cambia solo.';
    } else if (pressed?.kind === 'step' && !ctx.reason) {
      out.intent = 'flow';
      out.confidence = 1;
      out.reply = flows.render(pressed.step.text, flowValues());
      menu(pressed.step);
      out.sources.push({ type: 'flow', step: pressed.step.id });
      out.reason = 'Flujo de bienvenida: la persona eligió «' + pressed.label + '».';
    } else if (intent === 'opt_out') {
      out.reply =
        'Listo: no volveremos a enviarte mensajes de seguimiento. Si más adelante necesitas ayuda, escríbenos cuando quieras.';
      out.reason = 'El cliente pidió la baja; se registra y se confirma una sola vez.';
    } else if (intent === 'human' || intent === 'refund') {
      out.reply = intent === 'refund' ? copy.refund(user?.name) : copy.human(user?.name);
      out.handoff = true;
      out.reason =
        intent === 'refund'
          ? 'Queja o reembolso: siempre lo atiende una persona.'
          : 'El cliente pidió hablar con una persona.';
    } else if (intent === 'access') {
      // Posventa: con una inscripción activa y los accesos de la apertura listos, se reenvían; si no, una persona.
      const st = c.id === 'simulacion' ? null : accessApi?.forConversation(c) || null,
        problem = sales.ACCESS_PROBLEM.test(said);
      if (st?.ready && !problem) {
        out.reply = copy.accessResend(user?.name, st.text);
        out.accessResend = { enrollmentId: st.enrollmentId };
        out.reason = 'Pidió sus accesos con una inscripción activa: se le reenvían los accesos de su apertura.';
      } else if (problem || st?.enrolled || enrolledHere(c.id)) {
        out.reply = problem ? copy.accessProblem(user?.name) : copy.accessPending;
        out.handoff = true;
        out.reason = problem
          ? 'Inscrito con una falla en el acceso: la revisa una persona.'
          : 'Inscrito sin accesos listos para reenviar: se los manda una persona.';
      } else {
        const o = payments?.openOrder(c.id);
        if (o) {
          out.reply = copy.accessAfterPayment(o.reference, o.status);
          out.handoff = o.status === 'review';
          out.reason =
            'Pregunta por sus accesos con el pedido ' +
            o.reference +
            ' sin pago confirmado: los accesos llegan al confirmarse el pago.';
        } else {
          out.reply = copy.accessUnknown;
          out.handoff = true;
          out.reason = 'Pregunta por sus accesos y no hay una inscripción en este chat: lo revisa una persona.';
        }
      }
    } else if (intent === 'cert_data') {
      // Datos para la constancia: se guardan como PROPUESTA ligada al pedido (commit) y se acusan. Ni pedido nuevo ni texto
      // del certificado; el nombre lo confirma una persona del equipo antes de emitir.
      const data = sales.certData(trigger.text),
        order = c.id === 'simulacion' ? null : lastOrder(c.id),
        live = order && ['pending', 'review', 'paid'].includes(order.status) ? order : null;
      if (sales.hasCertData(data) && live) {
        const kept = nameRequest(live.id),
          // una señal débil (correo o teléfono sueltos) no trae nombre; un nombre explícito sí reemplaza al anterior
          changedFrom = data.name && kept?.requested_name && kept.requested_name !== data.name ? kept.requested_name : null;
        out.certData = { ...data, orderId: live.id };
        out.reply = copy.certDataThanks(user?.name, data, {
          enrolled: live.status === 'paid',
          order: true,
          changedFrom,
        });
        out.reason =
          'Datos para la constancia: se guardan como propuesta con el pedido ' +
          live.reference +
          ' (el nombre lo confirma el equipo al emitir) y se acusa recibo, sin crear otro pedido.';
      } else if (sales.hasCertData(data)) {
        out.reply = copy.certDataNoOrder;
        out.reason = 'Datos para la constancia sin pedido en este chat: no se guardan; se le invita a inscribirse.';
      } else {
        out.reply = copy.certDataAsk;
        out.reason = 'Ofrece sus datos o pregunta cómo escribir su nombre: se le piden en un solo mensaje.';
      }
    } else if (
      intent === 'enroll' &&
      c.id !== 'simulacion' &&
      (enrolledHere(c.id) ||
        db
          .prepare(
            "SELECT 1 FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id=? AND o.stage='ganada'",
          )
          .get(c.id))
    ) {
      // Ya inscrita (o la oportunidad ya está ganada): no se intenta otro pedido, que fallaría y la dejaría sin respuesta.
      const st = accessApi?.forConversation(c) || null;
      out.reply = st?.ready ? copy.alreadyEnrolled(ctx) + '\n\n' + st.text : copy.alreadyEnrolled(ctx, { advisor: true });
      if (st?.ready) out.accessResend = { enrollmentId: st.enrollmentId };
      out.sources.push(catalogueSource);
      out.reason =
        'Pide inscribirse pero ya está inscrita (o la oportunidad está ganada): no se crea otro pedido' +
        (st?.ready ? '; se le reenvían sus accesos.' : '; se le ofrece una persona.');
    } else if (payKind === 'paid') {
      // Quien avisa que YA pagó no pregunta cómo pagar: se le agradece, se le dice el estado de su pedido y pasa a una persona, que es quien valida.
      // Nunca se confirma un pago desde aquí.
      const open = payments?.openOrder(c.id);
      out.reply = copy.paidAck({ reference: open?.reference || null, status: open?.status || null });
      out.handoff = true;
      out.reason = 'Menciona un pago realizado: lo valida una persona.';
    } else if (payKind === 'status') {
      // «¿Ya verificaron mi pago?»: el estado real del pedido. En revisión (o sin pedido) se avisa al equipo.
      const o = c.id === 'simulacion' ? null : lastOrder(c.id),
        // pagado pero con la inscripción dada de baja: no se dice «activa»; lo revisa una persona
        cancelled =
          o?.status === 'paid' &&
          !db.prepare("SELECT 1 FROM enrollments WHERE order_id=? AND status='enrolled'").get(o.id),
        state = !o
          ? 'none'
          : cancelled
            ? 'cancelled'
            : ['paid', 'review', 'pending'].includes(o.status)
              ? o.status
              : 'none',
        v = o && state !== 'none' ? payments?.view(o) : null;
      out.reply = copy.payStatus(state, {
        reference: o?.reference || null,
        course: v?.courseTitle || course.title,
        edition: v?.editionName || '',
      });
      out.handoff =
        state === 'none' || state === 'review' || state === 'cancelled' || (state === 'pending' && paidClaim);
      out.reason =
        'Pregunta por el estado de su pago: ' +
        (state === 'none' ? 'no hay pedido en este chat' : 'el pedido ' + o.reference + ' está «' + o.status + '»') +
        (out.handoff ? '; lo revisa una persona.' : '.') +
        ' Nunca se confirma un pago desde el asistente.';
    } else if (ctx.reason) {
      out.reply = copy.unavailable(ctx.reason);
      out.handoff = true;
      out.reason = 'La edición no está disponible según el catálogo.';
      out.sources.push(catalogueSource);
    } else if ((offered && several(offered)) || several()) {
      /* varias preguntas: respondidas juntas */
    } else if (intent === 'enroll' && sales.GROUP.test(said)) {
      // Inscribir a varias personas: cada quien necesita su lugar; lo arma una persona del equipo.
      out.reply = copy.paymentAdvisor('group');
      out.stage = 'inscripcion';
      out.handoff = true;
      out.reason = 'Quiere inscribir a varias personas: lo atiende una persona del equipo.';
      out.sources.push(catalogueSource);
    } else if (intent === 'enroll') {
      const open = payments?.openOrder(c.id);
      if (open) {
        out.reply = copy.orderReminder(open.reference) + payments.linkMessage(open);
        out.stage = 'inscripcion';
        out.reason = 'Ya existía un pedido vigente: se recuerda el enlace de pago.';
        out.sources.push(catalogueSource);
      } else if (payments?.settings(c.brand_id).enabled) {
        out.order = true;
        out.reply = copy.enrollWithOrder(ctx, user?.name);
        out.stage = 'inscripcion';
        out.reason =
          'Solicitud de inscripción con venta activa: se genera un pedido con enlace de pago simulado; un comprobante siempre lo valida una persona.';
        out.sources.push(catalogueSource);
      } else {
        out.reply = copy.enrollWithAdvisor(ctx, user?.name);
        out.stage = 'inscripcion';
        out.handoff = true;
        out.reason = 'Solicitud de inscripción: avanza la etapa y pasa a una persona; nunca se confirma sola.';
        out.sources.push(catalogueSource);
      }
    } else if (intent === 'payment') {
      // «Ya pagué» y «¿ya verificaron?» se contestaron arriba. Aquí: pagar después, factura, meses, varias personas, cuenta, o cómo pagar.
      if (payKind === 'later') {
        const o = payments?.openOrder(c.id);
        out.reply = copy.payLater(user?.name, {
          reference: o?.reference || null,
          until: o ? copy.startText({ starts_at: o.expires_at, timezone: ctx.edition.timezone }) : null,
          hold: /\b(apart\w*|reserv\w*|guard\w*)\b/.test(said),
          canOrder: Boolean(payments?.settings(c.brand_id).enabled),
        });
        out.reason =
          'Avisa que pagará después: acuse sin presionar y el siguiente paso' +
          (o ? ' (pedido ' + o.reference + ' vigente).' : '.') +
          ' No se aparta el lugar: se asegura al confirmarse el pago.';
      } else if (['invoice', 'installments', 'group', 'account'].includes(payKind)) {
        // Sólo una respuesta aprobada que de verdad hable de eso; si no, una persona (nada de inventar factura o meses).
        const re = sales.ANSWERS[payKind],
          hit = bestMatch(
            trigger.text,
            kb.filter(k => re.test(normalize(k.answer))),
            0.5,
          );
        if (hit) {
          out.reply = hit.entry.answer;
          out.sources.push({
            type: 'knowledge',
            id: hit.entry.id,
            revision: hit.entry.revision,
            question: hit.entry.question,
          });
          out.reason = 'Conocimiento aprobado «' + hit.entry.question + '».';
        } else {
          out.reply = copy.paymentAdvisor(payKind);
          out.handoff = true;
          out.reason =
            ({
              invoice: 'Pide factura',
              installments: 'Pregunta por meses o pagos en partes',
              group: 'Quiere pagar por varias personas',
              account: 'Pide los datos de la cuenta',
            }[payKind] || 'Consulta de pago') +
            ' y no hay una respuesta aprobada que lo conteste: lo atiende una persona (no se inventa).';
        }
      } else {
        if (!fromKnowledge(0.6)) {
          if (payments?.settings(c.brand_id).enabled) out.reply = copy.paymentMethods;
          else {
            out.reply = copy.paymentWithAdvisor;
            out.handoff = true;
          }
        }
        out.reason =
          (out.reason ? out.reason + ' ' : '') +
          (out.handoff
            ? 'Consulta de pago sin respuesta aprobada ni venta activa: la atiende una persona.'
            : 'Información general de pago.');
      }
    } else if (
      intent === 'price' &&
      !ctx.promotion &&
      /\b(descuentos?|promos?|promocion|promociones|ofertas?|cupon|cupones|precio especial)\b/.test(said)
    ) {
      // «¿Hay descuento?» sin promoción vigente en el catálogo: se dice claro. Para grupos, lo confirma una persona.
      out.sources.push(catalogueSource);
      out.stage = 'interesado';
      if (sales.GROUP.test(said) || /\bsomos\b/.test(said)) {
        out.reply = copy.paymentAdvisor('discount');
        out.handoff = true;
        out.reason = 'Pide descuento para un grupo y el catálogo no tiene promoción vigente: lo atiende una persona.';
      } else {
        out.prepared = catalogue.prepare(c, { kind: 'price' });
        out.reply = copy.noPromotion(ctx);
        out.reason =
          'Pregunta por descuentos: el catálogo no tiene promoción vigente para esta apertura y se dice claro.';
      }
    } else if (intent === 'price') {
      out.prepared = catalogue.prepare(c, { kind: 'price' });
      out.reply = copy.price(ctx);
      out.stage = 'interesado';
      out.sources.push(catalogueSource);
      out.reason = 'Precio y promoción vigentes consultados en el catálogo al responder.';
    } else if (intent === 'syllabus') {
      out.prepared = catalogue.prepare(c, { kind: 'syllabus' });
      out.reply = copy.syllabus(ctx);
      out.sources.push(catalogueSource);
      out.reason = 'Temario del curso en el catálogo.';
    } else if (
      intent === 'schedule' &&
      sales.NOTIFY.test(said) &&
      /\b(siguiente|proxima|otra|vuelv\w*|abrir|abran)\b/.test(said)
    ) {
      // «Avísame de la siguiente»: el asistente no puede prometer avisar solo; se lo pide al equipo.
      out.reply = copy.notifyNext(ctx, user?.name);
      out.handoff = true;
      out.sources.push(catalogueSource);
      out.reason = 'Pide que le avisen de la siguiente fecha: se le pasa al equipo.';
    } else if (
      intent === 'schedule' &&
      sales.DEADLINE.test(said) &&
      /\b(promo|promos|promocion|promociones|oferta|descuento)\b/.test(said)
    ) {
      // «¿Hasta cuándo es la promoción?»: el fin de la promoción vigente del catálogo, o que no hay.
      out.reply = copy.promoUntil(ctx);
      out.stage = 'interesado';
      out.sources.push(catalogueSource);
      out.reason = ctx.promotion
        ? 'Pregunta hasta cuándo dura la promoción: su vigencia en el catálogo.'
        : 'Pregunta hasta cuándo dura la promoción: el catálogo no tiene promoción vigente y se dice claro.';
    } else if (intent === 'schedule' && sales.DEADLINE.test(said) && /\bpag\w*/.test(said)) {
      // «¿Cuál es el último día para pagar?»: la vigencia de su pedido si lo hay.
      const o = c.id === 'simulacion' ? null : payments?.openOrder(c.id);
      out.reply = copy.payUntil(
        o
          ? {
              reference: o.reference,
              until: copy.startText({ starts_at: o.expires_at, timezone: ctx.edition.timezone }),
            }
          : {},
      );
      out.reason = o
        ? 'Pregunta el último día para pagar: la vigencia de su pedido ' + o.reference + '.'
        : 'Pregunta el último día para pagar sin pedido: el enlace de pago llega con su vigencia al inscribirse.';
    } else if (intent === 'schedule' && (sales.NEXT.test(said) || sales.DEADLINE.test(said))) {
      out.prepared = catalogue.prepare(c, { kind: 'schedule' });
      out.reply = sales.NEXT.test(said) ? copy.nextEdition(ctx) : copy.deadline(ctx);
      out.sources.push(catalogueSource);
      out.reason = sales.NEXT.test(said)
        ? 'Pregunta por otra fecha: la apertura vigente del catálogo y la opción de preguntar a una persona.'
        : 'Pregunta hasta cuándo puede inscribirse: fecha de inicio del catálogo; no se crea un pedido sin que lo pida.';
    } else if (intent === 'schedule') {
      out.prepared = catalogue.prepare(c, { kind: 'schedule' });
      out.reply = copy.schedule(ctx);
      out.sources.push(catalogueSource);
      out.reason = 'Fecha, horario y docente de la edición en el catálogo.';
    } else if (intent === 'certificate' && sales.isValidity(said)) {
      // Validez oficial, SEP, cédula, valor curricular: sólo lo que consta. Una respuesta aprobada que hable de eso a propósito gana.
      const own = kb.filter(k => sales.VALIDITY_ENTRY.test(normalize([k.question, ...(k.variants || [])].join(' '))));
      const hit = bestMatch(trigger.text, own, 0.3);
      if (hit) {
        out.reply = hit.entry.answer;
        out.sources.push({
          type: 'knowledge',
          id: hit.entry.id,
          revision: hit.entry.revision,
          question: hit.entry.question,
        });
        out.reason = 'Conocimiento aprobado sobre la validez «' + hit.entry.question + '».';
      } else {
        out.reply = copy.validity(ctx, issuerOf(c.brand_id));
        out.reason =
          'Pregunta por la validez oficial del certificado: se dice lo que consta (digital, emisor, folio y QR) y nunca se afirma una validez oficial.';
      }
    } else if (intent === 'duration' && durationKnown) {
      out.prepared = catalogue.prepare(c, { kind: 'schedule' });
      out.reply = copy.duration(ctx, sessions);
      out.sources.push(catalogueSource);
      out.reason =
        'Duración con el calendario de la apertura de esta conversación (inicio, fin y sesiones del catálogo).';
    } else if (intent === 'objection' && sales.TIME_OBJECTION.test(said)) {
      const rec = kb.find(k => k.topic === 'recording');
      out.reply = copy.timeObjection(ctx, rec?.answer || '');
      out.sources.push(catalogueSource);
      if (rec) out.sources.push({ type: 'knowledge', id: rec.id, revision: rec.revision, question: rec.question });
      out.reason =
        'No le acomoda el horario: se le dice lo que el conocimiento aprobado dice de la grabación y cómo preguntar por otra fecha.';
    } else if (intent === 'greeting' || (fresh && !asks && !DIRECT_INTENTS.includes(intent))) welcome();
    else if (intent === 'thanks') {
      const done = c.id !== 'simulacion' && (enrolledHere(c.id) || lastOrder(c.id)?.status === 'review');
      out.reply = done
        ? copy.thanksEnrolled(user?.name)
        : prev?.intent === 'thanks'
          ? copy.thanksAgain
          : copy.thanks(user?.name);
      out.reason = 'Agradecimiento o cierre.' + (done ? ' Ya pagó: no se le ofrece inscribirse otra vez.' : '');
    } else if (intent === 'affirm') {
      options(copy.affirm(ctx));
      out.reason = 'Dijo que sí sin una pregunta pendiente: se le ofrecen las opciones.';
    } else if (intent === 'decline') {
      out.reply = copy.decline(user?.name);
      out.reason = 'Dijo que no o que ya no le interesa: se despide sin insistir.';
    } else if (intent === 'later') {
      out.reply = copy.later(user?.name);
      out.reason = 'Pidió tiempo o avisará después: se le deja la puerta abierta.';
    } else if (intent === 'bye') {
      out.reply = copy.bye(user?.name);
      out.reason = 'Despedida.';
    } else if (intent === 'help' && sales.JOBS.test(said)) {
      out.reply = copy.jobs(ctx);
      out.reason =
        'Busca trabajo o colaborar, no un curso: se le dice con amabilidad que este chat es de inscripciones.';
    } else if (intent === 'help') {
      options(copy.help(ctx), WITH_HUMAN);
      out.reason =
        'Llamó la atención o dijo que no entendió: se le ofrecen las opciones; no cuenta como pregunta sin respuesta.';
    } else if (intent === 'menu') {
      options(flow ? flows.render(flow.steps[0].text, flowValues()) : copy.menu(ctx));
      out.reason = 'Pidió ver las opciones.';
    } else if (intent === 'identity') {
      options(copy.identity(ctx), WITH_HUMAN);
      out.reason = 'Preguntó con quién habla: se le dice que es el asistente automático y cómo pedir una persona.';
    } else if (intent === 'seats') {
      // Sin lugares disponibles anotados pero con el tamaño del grupo: «el grupo es de 40 lugares, cupo limitado».
      const e = ctx.edition;
      out.reply =
        (e.available_seats === null || e.available_seats === undefined) && e.capacity > 0
          ? copy.seatsCapacity(ctx)
          : copy.seats(ctx);
      out.sources.push(catalogueSource);
      out.reason = 'Cupo de la edición consultado en el catálogo al responder.';
    } else if (intent === 'courses' && recommendation()) {
      /* recomendación con el catálogo: respondida */
    } else if (intent === 'courses' && !notMine) {
      out.reply =
        routed?.multi && routed.list.length > 1
          ? copy.courseMenu(
              ctx,
              routed.list.map(k => k.title),
            )
          : copy.courses(ctx, otherCourses(c));
      out.sources.push(catalogueSource);
      out.reason = 'Otros cursos activos de la marca, consultados en el catálogo.';
    } else if (intent === 'objection') {
      if (!fromKnowledge(0.6)) {
        out.reply = copy.objection(ctx);
        out.sources.push(catalogueSource);
        out.reason =
          'Le parece caro: precio vigente del catálogo y opción de hablar con una persona; no se ofrecen descuentos.';
      }
    } else if (fromKnowledge(0.5)) {
      /* respondido con conocimiento */
    } else {
      // A la IA sólo se le manda lo relevante (BM25 + sinónimos del negocio), no todo el conocimiento (server/retrieval.mjs)
      const recent = db
        .prepare(
          "SELECT text FROM messages WHERE conversation_id=? AND sender_kind='customer' AND id!=? ORDER BY seq DESC LIMIT 2",
        )
        .all(c.id, trigger.id || '')
        .map(m => m.text)
        .join(' ');
      let picked = rankKnowledge(trigger.text, kb, { k: TOP_K, extraQuery: recent });
      // Con pocas respuestas aprobadas (TOP_K o menos) y ninguna parecida, una PREGUNTA real (con signo o de 6 palabras o
      // más) sí va a la IA: el ahorro sale de las reglas (saludos, cortesías, pagos, posventa…), no de dejar sin IA una
      // pregunta. Se manda el conocimiento chico completo porque el validador exige que la IA cite una respuesta aprobada:
      // sin ninguna, cualquier borrador se descartaría y la llamada se pagaría para nada. Un mensaje corto que no es
      // pregunta no llega a la IA.
      if (!picked.sent && kb.length && kb.length <= TOP_K && looksLikeQuestion(trigger.text))
        picked = {
          selected: kb.map((entry, i) => ({ entry, score: 0, i })),
          considered: kb.length,
          sent: kb.length,
          truncated: false,
          mode: 'pocas-pregunta',
        };
      out.knowledge = picked.selected.map(x => ({
        id: x.entry.id,
        question: x.entry.question,
        answer: x.entry.answer,
        score: x.score,
      }));
      out.retrieval = {
        considered: picked.considered,
        sent: picked.sent,
        mode: picked.mode,
        truncated: picked.truncated,
      };
      out.needsProvider = Boolean(s.provider_enabled) && picked.sent > 0;
      if (out.needsProvider && c.id !== 'simulacion' && !routed?.pending)
        out.memory = customerMemory(db, c, { now }).text; // con el curso recién elegido, el interés de relleno todavía figura en su historia: no se le manda a la IA
      out.reply = copy.fallback(ctx);
      if (!flow) {
        out.buttons = WITH_HUMAN;
        out.keepButtons = true;
      }
      out.reason =
        'Sin intención reconocida ni conocimiento parecido.' +
        (s.provider_enabled && kb.length
          ? picked.sent
            ? ' Contexto para la IA: ' + picked.sent + ' de ' + picked.considered + ' entradas.'
            : ' Ninguna entrada del conocimiento se parece a la pregunta: no se consultó a la IA.'
          : '');
      if (fresh) {
        welcome();
        if (out.needsProvider) {
          out.prepared = null;
          if (!flow) out.buttons = null;
        }
        out.reason =
          'Primer mensaje sin respuesta en el conocimiento: bienvenida con la ficha vigente del curso.' +
          (out.needsProvider ? ' Si el proveedor de IA responde con fuentes aprobadas, se usa su respuesta.' : '');
      }
      // Sin respuesta, en tres escalones en lugar de pasar a una persona de golpe:
      //  1) opciones para tocar (precio, fechas, asesor);  2) al llegar al máximo de la marca, se PREGUNTA si quiere una persona;
      //  3) si después de eso tampoco hay respuesta, entonces sí se pasa. Si la IA contesta bien, nada de esto se aplica (commit()).
      const streak = unknownStreak(c.id) + 1,
        level = streak > s.max_unknown ? 'escalate' : streak === s.max_unknown ? 'offer' : 'options';
      out.miss = level;
      out.ifAnswered = {
        buttons: fresh ? out.buttons : null,
        keepButtons: fresh ? Boolean(out.keepButtons) : false,
        flow: fresh ? out.flow || null : null,
      };
      if (level === 'offer') {
        out.reply = copy.offerHuman;
        out.prepared = null;
        out.buttons = OFFER_BUTTONS;
        out.keepButtons = true;
        out.flow = null;
        out.sources = [{ type: 'template', kind: 'offer_human' }];
        out.reason +=
          ' Van ' +
          streak +
          ' respuestas seguidas sin contestar (máximo de la marca: ' +
          s.max_unknown +
          '): antes de pasar a una persona se le pregunta si la quiere.';
      } else if (level === 'escalate') {
        out.handoff = true;
        out.reply = copy.escalate;
        out.prepared = null;
        out.buttons = null;
        out.keepButtons = false;
        out.flow = null;
        out.reason +=
          ' Se superó el máximo de respuestas sin contestar (' +
          s.max_unknown +
          ') después de ofrecerle una persona: se escala.';
      }
    }
    if (out.mode === 'templates' && out.needsProvider) {
      out.needsProvider = false;
      out.reason += ' (El proveedor de IA sólo se usa en modo autónomo.)';
    }
    const flowStep = o => {
      if (!flow || o.miss === 'offer' || o.noFlow) return; // la propuesta de pasar con una persona lleva sus propios botones y no mueve el recorrido
      if (o.handoff || forced === 'enroll' || forced === 'human' || intent === 'opt_out') {
        o.flow = { end: true };
        o.buttons = null;
        o.keepButtons = false;
      } // pasa a una persona, se inscribe o pide la baja: el recorrido termina y ya no se ofrece el menú
      else if (forced) {
        menu(pressed.step, o);
        o.reason += ' Opción «' + pressed.label + '» del flujo de bienvenida: el menú sigue a la vista.';
      } else if (!o.flow && fresh && !o.order)
        menu(flow.steps[0], o); // su primer mensaje fue una pregunta concreta: se contesta y se le ofrece el menú
      else if (o.flow && !pressed) o.reason += ' Flujo de bienvenida de la marca.';
      else if (!o.flow && !pressed && flows.running(c.id)) o.flow = { miss: true }; // escribió otra cosa: contesta el motor; el menú vale una vez más
    };
    // Lo que acompaña a la respuesta si la IA sí contesta: sin propuesta de asesor, sin pase a una persona y sin botones de «no la tengo».
    if (out.miss) {
      if (out.needsProvider) {
        const a = { ...out.ifAnswered, handoff: false, order: false, reason: '' };
        flowStep(a);
        out.ifAnswered = { buttons: a.buttons || null, keepButtons: Boolean(a.keepButtons), flow: a.flow || null };
      } else out.ifAnswered = null;
    }
    flowStep(out);
    if (followed) out.reason = followed + ' ' + out.reason;
    out.course = { courseId: c.course_id, editionId: c.edition_id }; // el curso con el que se planeó: quien consulte a la IA debe darle ESTE curso
    if (routed?.course) {
      out.move = { courseId: routed.course.id, editionId: routed.course.editionId, placeholder: routed.pending };
      out.reason =
        (routed.pending ? 'Eligió el curso «' : 'Cambió al curso «') +
        routed.course.title +
        '»: la conversación pasa a ese curso. ' +
        out.reason;
    }
    return out;
  }

  // Aviso de fuera de horario: sólo si la marca mapeó una plantilla aprobada al evento «away_hours», el mensaje debe esperar a una
  // persona y la marca está cerrada ahora; una vez cada 12 horas por conversación. Dentro de la transacción del llamador.
  const AWAY_GAP = 12 * 3600e3;
  function away(c, trigger) {
    if (!content) return;
    const t = now(),
      policy = operations.settings(c.brand_id);
    if (isOpen(t, policy)) return;
    if (
      db
        .prepare("SELECT 1 FROM messages WHERE conversation_id=? AND client_ref LIKE 'away:%' AND created_at>?")
        .get(c.id, t - AWAY_GAP)
    )
      return;
    const first = (db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id)?.name || '').split(' ')[0];
    const tpl = content.render('away_hours', c.brand_id, {
      courseId: c.course_id,
      editionId: c.edition_id,
      name: first,
      extra: { apertura: openingLabel(t, policy) },
    });
    if (!tpl) return;
    insertMessage(c, null, tpl.text, 'automation', 'away:' + trigger.id, null, null, null, { category: 'service' });
  }

  // Pasa la conversación a una persona: asistente apagado en ella, estado «en espera», cola del equipo y aviso de fuera
  // de horario. Dentro de la transacción del llamador. La usan la respuesta que escala y los recorridos (conciliación,
  // fila 20); `trigger` es el mensaje de la persona que se está atendiendo.
  function escalate(c, trigger) {
    db.prepare("UPDATE conversations SET bot_enabled=0,status='waiting' WHERE id=?").run(c.id);
    operations.requestHuman(c, trigger.created_at);
    away(c, trigger);
  }

  // ---- aprender de la IA (docs/PLAN_APRENDER_DE_LA_IA.md): cuando el proveedor redacta una respuesta y el motor la acepta, la pregunta y la
  // respuesta quedan como BORRADOR de conocimiento. Un borrador no se usa para responder: una persona lo revisa y lo aprueba; desde entonces esa
  // pregunta se contesta sola, sin llamar a la IA. Cuidados: se quitan correos y teléfonos de la pregunta y el saludo con nombre de la respuesta;
  // no se guarda nada con precios o datos de contacto; no se repite lo que ya existe; y hay tope de borradores sin revisar por marca.
  const AI_DRAFT_CAP = 30;
  function learnFromDraft(c, trigger, answer) {
    try {
      // Datos de la persona que NO deben llegar al conocimiento: su nombre (el proveedor recibe su memoria y puede usarlo en cualquier parte del
      // texto), correos y teléfonos (con o sin separadores). La pregunta se limpia; una RESPUESTA que los traiga, o que hable de la historia de
      // esa persona («como ya preguntaste…», «tu pedido»), no se guarda: no sirve como respuesta general.
      const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g,
        PHONE = /\+?\d[\d\s().-]{6,}\d/g;
      const person = db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id)?.name || '';
      const names = [
        ...new Set(
          normalize(person)
            .split(' ')
            .filter(w => w.length >= 3),
        ),
      ];
      const hasName = t => {
        const words = new Set(normalize(t).split(' '));
        return names.some(n => words.has(n));
      };
      let q = String(trigger?.text || '')
        .replace(EMAIL, ' ')
        .replace(PHONE, ' ');
      for (const n of String(person)
        .split(/\s+/)
        .filter(w => w.length >= 3))
        q = q.replace(
          new RegExp('(^|[^\\p{L}])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}])', 'giu'),
          '$1',
        );
      q = q
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.;:?!])/g, '$1')
        .trim()
        .slice(0, 200);
      const a = String(answer || '')
        .replace(/^¡?\s*hola[^.!?\n]{0,40}[.!]\s*/i, '')
        .trim()
        .slice(0, 1500);
      if (q.length < 8 || a.length < 10 || hasName(q)) return null;
      if (/\$\s?\d|\d+\s?(pesos|mxn|usd)/i.test(a)) return null; // precios: sólo del catálogo
      if (EMAIL.test(a) || PHONE.test(a) || /\d{7,}/.test(a) || hasName(a)) return null; // datos de una persona
      if (
        /\b(como (ya )?(me |nos )?(comentaste|preguntaste|dijiste|mencionaste|contaste)|la vez pasada|anteriormente|tu pedido|tu pago|tu inscripcion|tu comprobante|ya estas inscrit)/.test(
          normalize(a),
        )
      )
        return null; // habla de la historia de esa persona
      const all = db
        .prepare("SELECT * FROM knowledge_entries WHERE brand_id=? AND status!='archived'")
        .all(c.brand_id)
        .map(view);
      if (all.length >= 300 || all.filter(e => e.status === 'draft' && e.created_by === null).length >= AI_DRAFT_CAP)
        return null;
      if (all.some(e => normalize(e.answer) === normalize(a)) || bestMatch(q, all, 0.6)) return null;
      const id = randomUUID(),
        t = now();
      db.prepare(
        "INSERT INTO knowledge_entries(id,brand_id,course_id,topic,question,variants,answer,created_by,created_at,updated_at) VALUES(?,?,?,'general',?,'[]',?,NULL,?,?)",
      ).run(id, c.brand_id, c.course_id || null, q, a, t, t);
      snapshot(id, null);
      return id;
    } catch {
      return null;
    } // aprender nunca debe impedir que la respuesta salga
  }

  // Datos para la constancia (docs/PLAN_RESPUESTAS_DE_VENTA.md): una PROPUESTA por pedido (certificate_name_requests). Un
  // nombre explícito reemplaza al anterior y vuelve a quedar por confirmar; el correo y el teléfono sólo llenan lo vacío si
  // llegan sueltos. server/certificates.mjs muestra la propuesta al equipo y sólo usa un nombre confirmado (o idéntico al
  // de la persona).
  const nameRequest = orderId =>
    orderId ? db.prepare('SELECT * FROM certificate_name_requests WHERE order_id=?').get(orderId) : null;
  function saveCertData(c, messageId, d) {
    const o = d.orderId ? db.prepare('SELECT * FROM orders WHERE id=? AND brand_id=?').get(d.orderId, c.brand_id) : null;
    if (!o) return null;
    const t = now(),
      cur = nameRequest(o.id);
    if (!cur) {
      db.prepare(
        "INSERT INTO certificate_name_requests(id,brand_id,contact_id,order_id,conversation_id,requested_name,email,phone,message_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)",
      ).run(randomUUID(), c.brand_id, o.contact_id, o.id, c.id, d.name || '', d.email || '', d.phone || '', messageId, t, t);
      return { changedFrom: null };
    }
    const renamed = Boolean(d.name && d.name !== cur.requested_name);
    db.prepare(
      'UPDATE certificate_name_requests SET requested_name=?,email=?,phone=?,message_id=?,status=?,confirmed_name=?,confirmed_by=?,confirmed_at=?,updated_at=? WHERE id=?',
    ).run(
      d.name || cur.requested_name,
      d.email || cur.email,
      d.phone || cur.phone,
      messageId,
      renamed ? 'pending' : cur.status,
      renamed ? null : cur.confirmed_name,
      renamed ? null : cur.confirmed_by,
      renamed ? null : cur.confirmed_at,
      t,
      cur.id,
    );
    return { changedFrom: renamed && cur.requested_name ? cur.requested_name : null };
  }

  // Mientras la conversación espera a una persona porque el asistente la pasó (docs/PLAN_RESPUESTAS_DE_VENTA.md): antes, lo que
  // la persona escribía después («¿ya verificaron mi pago?», «nadie me contesta») no recibía nada. Ahora recibe UNA sola
  // respuesta automática por espera (el acuse, o el acuse de sus datos para la constancia si eso fue lo que escribió), sin
  // que el asistente retome la conversación. Los datos que lleguen después se guardan sin contestar. No aplica si alguien del
  // equipo la tomó o ya escribió, si el nivel de la marca es «Apagado» o «Sugerir», ni a un archivo (un comprobante sigue su
  // propio camino). Un mensaje que pide algo (que le llamen, un asesor) nunca recibe «anoté…»: es el acuse de siempre y
  // vuelve a avisar al equipo. Lo llama server/operations.mjs al guardar el mensaje, dentro de la misma transacción.
  function ackWhileWaiting(c0) {
    const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(c0.id);
    if (!c || c.bot_enabled || c.assigned_to || c.status !== 'waiting') return null;
    if (!['templates', 'autonomous'].includes(settings(c.brand_id).mode)) return null;
    const m = db
      .prepare(
        "SELECT id,text,attachment_id FROM messages WHERE conversation_id=? AND sender_kind='customer' ORDER BY seq DESC LIMIT 1",
      )
      .get(c.id);
    if (!m || m.attachment_id || contacts.isOptOutText(m.text)) return null;
    const last = db
      .prepare('SELECT action,created_at FROM reply_log WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
      .get(c.id);
    if (last?.action !== 'escalated') return null; // sólo tras un pase del asistente (no el nivel de la marca ni otra vía)
    if (
      db
        .prepare("SELECT 1 FROM messages WHERE conversation_id=? AND created_at>=? AND sender_kind='agent' LIMIT 1")
        .get(c.id, last.created_at)
    )
      return null; // una persona ya escribió: la conversación es suya
    const t = clean(m.text),
      asks = sales.ASKS_SOMETHING.test(t) || ['human', 'refund'].includes(classify(m.text).intent),
      order = lastOrder(c.id),
      live = order && ['pending', 'review', 'paid'].includes(order.status) ? order : null,
      data = sales.certData(m.text),
      isData =
        !asks &&
        live &&
        sales.hasCertData(data) &&
        (sales.certDataSignal(t, m.text) || sales.weakCertData(t, m.text));
    let saved = null;
    if (isData) saved = saveCertData(c, m.id, { ...data, orderId: live.id });
    if (asks) {
      // pide algo: la conversación sigue en la cola del equipo (si el aviso se había cerrado, se abre otra vez)
      try {
        operations.requestHuman(c, now());
      } catch {}
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM messages WHERE conversation_id=? AND created_at>=? AND (client_ref LIKE 'wait-ack:%' OR client_ref LIKE 'wait-data:%') LIMIT 1",
        )
        .get(c.id, last.created_at)
    )
      return null; // una sola respuesta automática por espera
    const person = db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id)?.name;
    if (saved)
      return insertMessage(
        c,
        null,
        copy.certDataThanks(person, data, {
          enrolled: live.status === 'paid',
          order: true,
          changedFrom: saved.changedFrom,
        }),
        'automation',
        'wait-data:' + m.id,
        null,
        null,
        null,
        { category: 'service' },
      );
    const o = payments?.openOrder(c.id);
    return insertMessage(
      c,
      null,
      copy.waitingAck(person, { reference: o?.reference || null, review: o?.status === 'review' }),
      'automation',
      'wait-ack:' + m.id,
      null,
      null,
      null,
      { category: 'service' },
    );
  }
  operations.useCustomerWaiting?.(ackWhileWaiting);

  // Aplica el plan dentro de una transacción del llamador. Revalida que nadie respondió ya a este mensaje.
  function commit(c, trigger, p, draft = null) {
    const ref = 'automation:' + trigger.id;
    if (db.prepare('SELECT id FROM messages WHERE client_ref=?').get(ref))
      return { action: 'skipped', reason: 'Ya existía una respuesta para este mensaje.' };
    // El curso elegido o cambiado se guarda antes de responder: el mensaje, la etapa y un pedido ya pertenecen al curso nuevo.
    // Si ya no se puede (otra conversación abierta de ese curso, o el curso dejó de estar disponible), la persona no se queda sin respuesta: pasa a un asesor.
    if (p.move && !crm.moveConversation(c, p.move.courseId, p.move.editionId, { placeholder: p.move.placeholder })) {
      p = {
        ...p,
        move: null,
        handoff: true,
        reply: copy.escalate,
        prepared: null,
        buttons: null,
        keepButtons: false,
        flow: null,
        stage: null,
        order: false,
        ifAnswered: null,
        sources: [],
        reason: p.reason + ' No se pudo pasar la conversación a ese curso: pasa a una persona.',
      };
      draft = null;
    }
    const t = now();
    let sources = [...p.sources],
      reply = p.reply,
      model = null,
      reason = p.reason,
      handoff = p.handoff,
      buttons = p.buttons,
      keepButtons = p.keepButtons,
      move = p.flow;
    if (draft) {
      model = draft.model;
      const v = validateDraft(draft, p.knowledge);
      if (v.ok) {
        reply = v.text;
        if (p.ifAnswered) {
          handoff = false;
          buttons = p.ifAnswered.buttons;
          keepButtons = p.ifAnswered.keepButtons;
          move = p.ifAnswered.flow;
          sources = sources.filter(s => s.kind !== 'offer_human');
        }
        if (provider.name === 'claude') learnFromDraft(c, trigger, v.text);
        reason =
          'Proveedor de IA: ' +
          draft.reason +
          (p.retrieval
            ? ' Contexto: ' + p.retrieval.sent + ' de ' + p.retrieval.considered + ' entradas del conocimiento.'
            : '') +
          (p.memory ? ' Memoria del cliente enviada: «' + p.memory + '»' : '');
        for (const id of v.usedIds) sources.push({ type: 'knowledge', id });
      } else reason += ' Proveedor descartado: ' + v.reason + (draft.text ? '' : ' (' + draft.reason + ')');
    }
    reply = forBrand(db, c.brand_id, reply); // modo real (docs/PLAN_MODO_REAL.md): sin avisos de prueba
    // lo que se registra, se sugiere y se envía es el mismo texto
    const log = (action, replyMessageId = null) => {
      const id = randomUUID();
      db.prepare(
        'INSERT INTO reply_log(id,conversation_id,brand_id,trigger_message_id,reply_message_id,intent,confidence,mode,action,reply_text,sources,model,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        c.id,
        c.brand_id,
        trigger.id,
        replyMessageId,
        p.intent,
        p.confidence,
        p.mode,
        action,
        reply,
        JSON.stringify(sources),
        model,
        reason,
        t,
      );
      return id;
    };
    if (p.mode === 'off') {
      log('skipped');
      escalate(c, trigger);
      return { action: 'skipped', reason: 'Respuestas automáticas apagadas para la marca: pasa a una persona.' };
    }
    if (p.mode === 'suggest') {
      log('suggested');
      escalate(c, trigger);
      return { action: 'suggested', reply, reason };
    }
    let orderFailed = false;
    if (p.order) {
      // Si el pedido no se puede crear (p. ej. la oportunidad ya está cerrada), la persona no se queda sin respuesta: pasa
      // a una persona del equipo en lugar de que el trabajo falle y se reintente en silencio.
      db.exec('SAVEPOINT reply_order');
      try {
        const made = payments.createOrder(c, { user: null, source: 'bot' });
        reply = reply.replace('{{pedido}}', payments.linkMessage(made.order));
        db.exec('RELEASE reply_order');
      } catch (error) {
        db.exec('ROLLBACK TO reply_order');
        db.exec('RELEASE reply_order');
        orderFailed = true;
        reply = forBrand(db, c.brand_id, copy.orderFailed);
        handoff = true;
        buttons = null;
        keepButtons = false;
        move = null;
        reason += ' No se pudo crear el pedido (' + String(error?.message || '').slice(0, 120) + '): pasa a una persona.';
      }
    }
    const messageId = insertMessage(
      c,
      null,
      reply,
      'automation',
      ref,
      null,
      p.prepared?.flyerSnapshot ? c.course_id : null,
      p.prepared,
      { buttons, keepButtons, category: 'service' },
    ); // responde a un mensaje entrante: siempre dentro de la ventana de servicio
    log(handoff ? 'escalated' : 'replied', messageId);
    if (p.certData) saveCertData(c, trigger.id, p.certData);
    if (p.accessResend) accessApi?.record?.(p.accessResend.enrollmentId, messageId);
    if (move) flows?.apply(c.id, move);
    if (p.stage && !orderFailed) {
      // una etapa que ya no se puede mover (oportunidad cerrada) no tumba la respuesta que ya salió
      db.exec('SAVEPOINT reply_stage');
      try {
        crm.setStage(c, p.stage);
        db.exec('RELEASE reply_stage');
      } catch {
        db.exec('ROLLBACK TO reply_stage');
        db.exec('RELEASE reply_stage');
      }
    }
    if (handoff) escalate(c, trigger);
    return { action: handoff ? 'escalated' : 'replied', messageId, reply, reason };
  }

  // Reanuda al asistente en una conversación que sólo quedó en espera por el NIVEL de la marca («Apagado» o «Sugerir») cuando la marca ya responde sola
  // («Plantillas» o «Autónomo»). No toca las que alguien tomó, las cerradas, ni las que se escalaron a una persona (lo pidió el cliente, queja, pago
  // reportado), ni aquéllas donde alguien del equipo intervino después de la pausa: ésas siguen esperando a un asesor. Dentro de la transacción del
  // llamador; actualiza también `c`.
  function resumeIfPausedByMode(c) {
    if (c.bot_enabled || c.assigned_to || c.status !== 'waiting') return false;
    if (!['templates', 'autonomous'].includes(settings(c.brand_id).mode)) return false;
    const last = db
      .prepare(
        'SELECT action,trigger_message_id,created_at FROM reply_log WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(c.id);
    if (!last || !['suggested', 'skipped'].includes(last.action) || !last.trigger_message_id) return false;
    // Una persona ya intervino después de la pausa (respondió, tomó, transfirió, devolvió a la cola, anotó): la decisión es suya, no del cliente.
    if (
      db
        .prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='agent' AND created_at>=? LIMIT 1")
        .get(c.id, last.created_at)
    )
      return false;
    if (
      db
        .prepare(
          "SELECT 1 FROM operation_events WHERE conversation_id=? AND created_at>=? AND (actor_id IS NOT NULL OR kind IN ('assignment','response') OR kind LIKE 'transfer.%') LIMIT 1",
        )
        .get(c.id, last.created_at)
    )
      return false;
    // En «Sugerir»/«Apagado» la bitácora dice «suggested»/«skipped» aunque el mensaje pidiera una persona. Se revisa el mensaje que quedó en pausa y los
    // que el cliente escribió después: si alguno pide asesor, es queja o reembolso, reporta un pago o trae un archivo, sigue esperando a una persona.
    const trig = db.prepare('SELECT seq FROM messages WHERE id=?').get(last.trigger_message_id);
    if (!trig) return false;
    const pending = db
      .prepare(
        "SELECT text,attachment_id FROM messages WHERE conversation_id=? AND sender_kind='customer' AND seq>=? ORDER BY seq LIMIT 21",
      )
      .all(c.id, trig.seq);
    if (pending.length > 20) return false; // demasiados mensajes sin atender: que lo vea una persona
    for (const m of pending) {
      if (m.attachment_id) return false;
      const intent = classify(m.text).intent;
      if (intent === 'human' || intent === 'refund') return false;
      if (intent === 'payment' && sales.claimsPaid(clean(m.text))) return false;
    }
    consumeSuggestions(c.id);
    db.prepare("UPDATE conversations SET bot_enabled=1,status='open',updated_at=? WHERE id=?").run(now(), c.id);
    operations.reset(c, 'automation.resumed', null);
    c.bot_enabled = 1;
    c.status = 'open';
    return true;
  }

  // Simulación para administración: mismo plan, sin escribir y con la llamada al proveedor incluida.
  // `options.provider: false` (sólo en el mismo proceso, nunca desde el cuerpo de una petición): no se consulta a la IA;
  // si el plan la necesitaba, la respuesta lo dice con `providerSkipped` (simulador de recorridos desde el conector).
  async function test(user, input, { provider: useProvider = true } = {}) {
    const brandId = input.brandId;
    if (typeof brandId !== 'string' || !db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))
      throw fail(404, 'Marca no disponible.');
    crm.requireBrand(user, brandId);
    // Sin curso indicado se simula con el primer curso activo (por título) que tenga una edición disponible; si ninguno la tiene, con el primero, y el motor dirá por qué escala.
    const course = input.courseId
      ? db.prepare('SELECT * FROM courses WHERE id=? AND brand_id=?').get(input.courseId, brandId)
      : (() => {
          const all = db.prepare('SELECT * FROM courses WHERE brand_id=? AND active=1 ORDER BY title').all(brandId);
          return (
            all.find(k => {
              try {
                return !catalogue.info(k.id).reason;
              } catch {
                return false;
              }
            }) || all[0]
          );
        })();
    if (!course) throw fail(400, 'La marca no tiene cursos activos para simular.');
    const message = text(input.text, 2000);
    if (!message) throw fail(400, 'Escribe el mensaje del cliente.');
    const fake = {
        id: 'simulacion',
        customer_id: user.id,
        brand_id: brandId,
        course_id: course.id,
        edition_id: input.editionId || null,
        channel: ['whatsapp', 'instagram', 'facebook'].includes(input.channel) ? input.channel : 'whatsapp',
        status: 'open',
        bot_enabled: 1,
        assigned_to: null,
      },
      trigger = { id: 'simulacion', text: message, created_at: now() };
    const p = plan(fake, trigger);
    let draft = null;
    const wantsProvider = Boolean(
      p.needsProvider || (input.forceProvider && p.intent === 'unknown' && p.knowledge.length),
    );
    if (wantsProvider && useProvider !== false) {
      const ctx = catalogue.info(course.id, fake.edition_id);
      draft = await provider.draft({
        brand: ctx.brand,
        course: ctx.course,
        edition: {
          name: ctx.edition.name,
          dateLabel: ctx.dateLabel,
          priceLabel: (ctx.priceCents / 100).toFixed(2) + ' ' + ctx.currency,
        },
        question: message,
        knowledge: p.knowledge,
        history: [],
      });
    }
    const v = draft ? validateDraft(draft, p.knowledge) : null,
      answered = Boolean(v?.ok && p.ifAnswered),
      reply = forBrand(db, brandId, v?.ok ? v.text : p.reply).replace(
        '{{pedido}}',
        isRealBrand(db, brandId)
          ? '[aquí iría el pedido con su enlace de pago]'
          : '[aquí iría el pedido con su enlace de pago de prueba]',
      );
    return {
      context: {
        retrieval: p.retrieval || null,
        knowledge: (p.knowledge || []).map(k => ({ id: k.id, question: k.question, score: k.score })),
        memory: p.memory || null,
      },
      intent: p.intent,
      confidence: p.confidence,
      mode: p.mode,
      reply,
      providerSkipped: wantsProvider && useProvider === false,
      handoff: answered ? false : p.handoff,
      buttons: (answered ? p.ifAnswered.buttons : p.buttons) || null,
      stage: p.stage,
      sources: [
        ...p.sources.filter(s => !answered || s.kind !== 'offer_human'),
        ...(v?.ok ? v.usedIds : []).map(id => ({ type: 'knowledge', id })),
      ],
      reason: draft
        ? v.ok
          ? 'Proveedor de IA: ' + draft.reason
          : p.reason +
            ' Proveedor descartado: ' +
            v.reason +
            (draft.called || provider.name !== 'claude' ? '' : ' · NO se consultó a la IA: ' + draft.reason)
        : p.reason,
      provider: {
        name: provider.name,
        model: draft?.model || null,
        used: Boolean(draft),
        called: Boolean(draft?.called),
        accepted: Boolean(v?.ok),
        error: draft && !draft.called && provider.name === 'claude' ? String(draft.reason || '').slice(0, 200) : null,
      },
    };
  }

  // ---- huecos de conocimiento: lo que los clientes preguntaron y el motor no supo responder con conocimiento aprobado
  // (intención desconocida y ninguna fuente de conocimiento en la respuesta). Se agrupan las preguntas parecidas para que quien
  // administra el conocimiento vea primero lo que más se pregunta y pueda convertirlo en una respuesta con un clic.
  function gaps(user, { brand = null, days = 30 } = {}) {
    const ids = crm
      .brandsFor(user)
      .map(b => b.id)
      .filter(id => !brand || id === brand);
    if (!ids.length) return [];
    const since = now() - Math.min(90, Math.max(1, Number(days) || 30)) * 86400000;
    const rows = db
      .prepare(
        `SELECT r.brand_id,r.conversation_id,r.created_at,r.sources,m.text FROM reply_log r JOIN messages m ON m.id=r.trigger_message_id WHERE r.intent='unknown' AND r.brand_id IN (${ids.map(() => '?').join(',')}) AND r.created_at>=? ORDER BY r.created_at DESC LIMIT 600`,
      )
      .all(...ids, since);
    const clusters = [];
    for (const r of rows) {
      let sources = [];
      try {
        sources = JSON.parse(r.sources);
      } catch {}
      if (sources.some(s => s.type === 'knowledge')) continue; // sí se respondió con conocimiento aprobado
      const set = new Set(tokens(r.text).map(stem));
      if (set.size < 2) continue;
      let hit = null,
        best = 0;
      for (const c of clusters) {
        if (c.brandId !== r.brand_id) continue;
        const inter = [...set].filter(t => c.terms.has(t)).length,
          j = inter / (set.size + c.terms.size - inter);
        if (j >= 0.45 && j > best) {
          best = j;
          hit = c;
        }
      }
      if (!hit) {
        hit = {
          brandId: r.brand_id,
          example: r.text.slice(0, 200),
          count: 0,
          conversations: new Set(),
          lastAt: r.created_at,
          terms: new Set(set),
        };
        clusters.push(hit);
      }
      hit.count++;
      hit.conversations.add(r.conversation_id);
      for (const t of set) hit.terms.add(t);
    }
    return clusters
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
      .slice(0, 25)
      .map(c => ({
        brandId: c.brandId,
        example: c.example,
        count: c.count,
        conversations: c.conversations.size,
        lastAt: c.lastAt,
      }));
  }

  // ---- conocimiento
  function normalizeEntry(input, brandId) {
    const topic =
        text(input.topic, 40)
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '') || 'general',
      question = text(input.question, 200),
      answer = text(input.answer, 1500);
    if (question.length < 8) throw fail(400, 'Escribe la pregunta completa, tal como la haría un cliente.');
    if (answer.length < 10) throw fail(400, 'Escribe una respuesta completa.');
    const variants = [
      ...new Set(
        (Array.isArray(input.variants) ? input.variants : String(input.variants || '').split(/\n|;/))
          .map(v => text(v, 120))
          .filter(Boolean),
      ),
    ].slice(0, 20);
    let courseId = null;
    if (input.courseId) {
      const k = db.prepare('SELECT brand_id FROM courses WHERE id=?').get(input.courseId);
      if (!k || k.brand_id !== brandId) throw fail(400, 'Curso no válido para la marca.');
      courseId = input.courseId;
    }
    if (/\$\s?\d|\d+\s?(pesos|mxn|usd)/i.test(answer))
      throw fail(400, 'No escribas precios en el conocimiento: el precio vigente sale del catálogo.');
    return { topic, question, answer, variants, courseId };
  }
  const snapshot = (id, actor) => {
    const e = entry(id);
    db.prepare('INSERT INTO knowledge_versions(entry_id,revision,snapshot,actor_id,created_at) VALUES(?,?,?,?,?)').run(
      id,
      e.revision,
      JSON.stringify({
        topic: e.topic,
        question: e.question,
        variants: JSON.parse(e.variants),
        answer: e.answer,
        status: e.status,
        course_id: e.course_id,
      }),
      actor,
      now(),
    );
  };
  const guard = (e, input) => {
    if (!e) throw fail(404, 'Entrada no encontrada.');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== e.revision)
      throw fail(409, 'La entrada cambió. Recárgala.');
  };
  function createEntry(user, input) {
    const brandId = input.brandId;
    if (typeof brandId !== 'string' || !db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))
      throw fail(404, 'Marca no disponible.');
    crm.requireBrand(user, brandId);
    const n = normalizeEntry(input, brandId);
    return transaction(db, () => {
      if (
        db.prepare("SELECT count(*) n FROM knowledge_entries WHERE brand_id=? AND status!='archived'").get(brandId).n >=
        300
      )
        throw fail(409, 'La marca alcanzó el máximo de 300 entradas.');
      const id = randomUUID(),
        t = now();
      db.prepare(
        'INSERT INTO knowledge_entries(id,brand_id,course_id,topic,question,variants,answer,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(id, brandId, n.courseId, n.topic, n.question, JSON.stringify(n.variants), n.answer, user.id, t, t);
      snapshot(id, user.id);
      return view(entry(id));
    });
  }
  function updateEntry(user, id, input) {
    return transaction(db, () => {
      const e = entry(id);
      guard(e, input);
      crm.requireBrand(user, e.brand_id);
      const n = normalizeEntry({ ...view(e), courseId: e.course_id, ...input }, e.brand_id);
      db.prepare(
        "UPDATE knowledge_entries SET topic=?,question=?,variants=?,answer=?,course_id=?,status='draft',approved_by=NULL,approved_at=NULL,revision=revision+1,updated_at=? WHERE id=?",
      ).run(n.topic, n.question, JSON.stringify(n.variants), n.answer, n.courseId, now(), id);
      snapshot(id, user.id);
      return view(entry(id));
    });
  }
  function setStatus(user, id, input, status) {
    if (user.role !== 'admin') throw fail(403, 'Aprobar o archivar conocimiento requiere un administrador.');
    return transaction(db, () => {
      const e = entry(id);
      guard(e, input);
      crm.requireBrand(user, e.brand_id);
      if (e.status === status) throw fail(409, 'La entrada ya está en ese estado.');
      if (status === 'archived' && e.created_by === null && e.approved_at === null && e.status === 'draft') {
        db.prepare('DELETE FROM knowledge_versions WHERE entry_id=?').run(id);
        db.prepare('DELETE FROM knowledge_entries WHERE id=?').run(id);
        return { ...view(e), status: 'archived', deleted: true };
      }
      db.prepare(
        'UPDATE knowledge_entries SET status=?,approved_by=?,approved_at=?,revision=revision+1,updated_at=? WHERE id=?',
      ).run(
        status,
        status === 'approved' ? user.id : e.approved_by,
        status === 'approved' ? now() : e.approved_at,
        now(),
        id,
      );
      snapshot(id, user.id);
      return view(entry(id));
    });
  }
  function setSettings(user, brandId, input) {
    if (user.role !== 'admin') throw fail(403, 'El nivel de respuesta lo define un administrador.');
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId)) throw fail(404, 'Marca no disponible.');
    const mode = input.mode === undefined ? null : input.mode;
    if (mode !== null && !MODES.includes(mode)) throw fail(400, 'Nivel no válido.');
    const maxUnknown = input.maxUnknown === undefined ? null : input.maxUnknown;
    if (maxUnknown !== null && (!Number.isInteger(maxUnknown) || maxUnknown < 1 || maxUnknown > 5))
      throw fail(400, 'El máximo de respuestas sin reconocer va de 1 a 5.');
    return transaction(db, () => {
      const cur = settings(brandId);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== cur.revision)
        throw fail(409, 'La configuración cambió. Recárgala.');
      const next = {
        mode: mode ?? cur.mode,
        provider_enabled: input.providerEnabled === undefined ? cur.provider_enabled : input.providerEnabled ? 1 : 0,
        max_unknown: maxUnknown ?? cur.max_unknown,
      };
      if (next.provider_enabled && !provider.configured)
        throw fail(400, 'El proveedor de IA no está configurado en el servidor.');
      db.prepare(
        'INSERT INTO reply_settings(brand_id,mode,provider_enabled,max_unknown,revision,updated_by,updated_at) VALUES(?,?,?,?,1,?,?) ON CONFLICT(brand_id) DO UPDATE SET mode=excluded.mode,provider_enabled=excluded.provider_enabled,max_unknown=excluded.max_unknown,revision=reply_settings.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
      ).run(brandId, next.mode, next.provider_enabled, next.max_unknown, user.id, now());
      return settings(brandId);
    });
  }
  const suggestion = conversationId =>
    db
      .prepare(
        "SELECT id,intent,confidence,reply_text,sources,reason,created_at FROM reply_log WHERE conversation_id=? AND action='suggested' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(conversationId);
  const consumeSuggestions = conversationId =>
    db
      .prepare(
        "UPDATE reply_log SET consumed_at=? WHERE conversation_id=? AND action='suggested' AND consumed_at IS NULL",
      )
      .run(now(), conversationId).changes;
  const history = conversationId =>
    db
      .prepare(
        'SELECT id,trigger_message_id,reply_message_id,intent,confidence,mode,action,reply_text,sources,model,reason,consumed_at,created_at FROM reply_log WHERE conversation_id=? ORDER BY created_at DESC LIMIT 30',
      )
      .all(conversationId)
      .map(r => ({ ...r, sources: JSON.parse(r.sources) }));

  async function handle(req, res, path, user, { body, json, audit, accessConversation }) {
    let m;
    if ((m = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/replies(?:\/(dismiss))?$/))) {
      const c = accessConversation(m[1], user);
      if (user.role === 'customer') throw fail(403, 'Vista del equipo.');
      if (!m[2] && req.method === 'GET') {
        const s = suggestion(c.id);
        json(res, 200, {
          suggestion: s ? { ...s, sources: JSON.parse(s.sources) } : null,
          log: history(c.id),
          settings: settings(c.brand_id),
        });
        return true;
      }
      if (m[2] === 'dismiss' && req.method === 'POST') {
        await body(req);
        json(res, 200, { dismissed: consumeSuggestions(c.id) });
        return true;
      }
      throw fail(405, 'Método no permitido.');
    }
    if (!path.startsWith('/api/replies')) return false;
    if (user.role === 'customer') throw fail(403, 'Vista del equipo.');
    if (path === '/api/replies/provider' && req.method === 'GET') {
      json(res, 200, {
        name: provider.name,
        model: provider.model,
        configured: provider.configured,
        usage: provider.usage?.() || null,
      });
      return true;
    }
    if (path === '/api/replies/gaps' && req.method === 'GET') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      json(res, 200, { gaps: gaps(user, { brand: q.get('brand') || null, days: q.get('days') }) });
      return true;
    }
    if (path === '/api/replies/settings' && req.method === 'GET') {
      json(res, 200, {
        settings: crm.brandsFor(user).map(b => ({ ...settings(b.id), brand_name: b.name })),
        modes: MODES,
        provider: {
          name: provider.name,
          model: provider.model,
          configured: provider.configured,
          usage: provider.usage?.() || null,
        },
      });
      return true;
    }
    if ((m = path.match(/^\/api\/replies\/brands\/([\w-]{1,64})$/)) && req.method === 'PATCH') {
      const s = setSettings(user, m[1], await body(req));
      audit(user, 'replies.settings', m[1]);
      json(res, 200, { settings: s });
      return true;
    }
    if (path === '/api/replies/test' && req.method === 'POST') {
      json(res, 200, { result: await test(user, await body(req)) });
      return true;
    }
    if (path === '/api/replies/knowledge') {
      if (req.method === 'GET') {
        const q = new URL(req.url, 'http://localhost').searchParams,
          brand = q.get('brand');
        const ids = crm
          .brandsFor(user)
          .map(b => b.id)
          .filter(id => !brand || id === brand);
        json(res, 200, {
          entries: ids.length
            ? db
                .prepare(
                  `SELECT * FROM knowledge_entries WHERE brand_id IN (${ids.map(() => '?').join(',')}) ORDER BY status='approved' DESC,updated_at DESC LIMIT 500`,
                )
                .all(...ids)
                .map(view)
            : [],
        });
        return true;
      }
      if (req.method === 'POST') {
        const e = createEntry(user, await body(req));
        audit(user, 'knowledge.created', e.id);
        json(res, 201, { entry: e });
        return true;
      }
    }
    if ((m = path.match(/^\/api\/replies\/knowledge\/([a-f0-9-]{36})(?:\/(approve|archive|history))?$/))) {
      if (!m[2] && req.method === 'PATCH') {
        const e = updateEntry(user, m[1], await body(req));
        audit(user, 'knowledge.updated', e.id);
        json(res, 200, { entry: e });
        return true;
      }
      if ((m[2] === 'approve' || m[2] === 'archive') && req.method === 'POST') {
        const e = setStatus(user, m[1], await body(req), m[2] === 'approve' ? 'approved' : 'archived');
        audit(user, 'knowledge.' + m[2], e.id);
        json(res, 200, { entry: e });
        return true;
      }
      if (m[2] === 'history' && req.method === 'GET') {
        const e = entry(m[1]);
        if (!e) throw fail(404, 'Entrada no encontrada.');
        crm.requireBrand(user, e.brand_id);
        json(res, 200, {
          versions: db
            .prepare(
              'SELECT v.revision,v.snapshot,v.created_at,u.name actor_name FROM knowledge_versions v LEFT JOIN users u ON u.id=v.actor_id WHERE v.entry_id=? ORDER BY v.revision DESC',
            )
            .all(m[1])
            .map(v => ({ ...v, snapshot: JSON.parse(v.snapshot) })),
        });
        return true;
      }
    }
    throw fail(404, 'Ruta de respuestas no encontrada.');
  }
  return {
    handle,
    plan,
    commit,
    escalate,
    classify,
    // ¿Este mensaje elige o cambia el curso? (número que atiende toda la marca). Sin escribir: lo usa también el motor
    // de recorridos para empezar ya con el curso que la persona nombró.
    routeCourse: route,
    // Las piezas de la pregunta «¿sobre qué curso?» para el paso «¿Qué curso te interesa?» de los recorridos: la lista que se ofrece (cursos
    // activos de la marca con una edición disponible), cómo se lee la respuesta y si se puede cambiar de curso. Ninguna escribe.
    courseList: brandId => brandCourses(db, catalogue, brandId),
    pickCourse,
    courseSwitch,
    // El módulo de accesos del curso se registra aquí para que el asistente reenvíe los accesos de quien ya pagó.
    useAccess,
    settings,
    resumeIfPausedByMode,
    suggestion,
    consumeSuggestions,
    history,
    test,
    createEntry,
    normalizeEntry,
    seedBrand: brandId => seedBrandKnowledge(db, brandId, now()),
  };
}
