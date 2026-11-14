// Modelo compartido de los recorridos: conversaciones guiadas que se arman con pasos (nodos) y conexiones.
//
// Lo importan el navegador (lienzo, esquema y simulador) y el servidor (validación al guardar y al publicar), por eso es
// puro y síncrono: no toca el DOM, la red, el reloj ni el azar, y la misma entrada da siempre la misma salida.
// Vive en public/kit/shared/ porque la imagen de producción sólo copia public/ y server/; el servidor lo importa con una
// ruta relativa.
//
// Vocabulario de pantalla: «recorrido» (el flujo), «paso» (el nodo), «salida» (el puerto) y «conexión» (la arista).
//
// Contexto de validación (`ctx`). Todo es opcional: lo que no llega no se comprueba, así el navegador puede validar sin
// haber cargado todavía las listas de la marca y el servidor las pasa completas al publicar.
//   settings      ajustes del recorrido ({proactive, channels, …}; ver DEFAULT_SETTINGS)
//   materials     [{id, name, status?: 'approved' | …, slot?, courseId?, editionId?, text?}]
//   files         [{id, name}]
//   tags          [{id, name}]
//   waTemplates   [{id, name, status?: 'approved' | …, buttons?: [títulos]}]
//   flows         [{id, name, published?: boolean}]
//   users         [{id, name, active?: boolean}]
//   courses       [{id, title}]
//   attributes    [{key, label, type?, status?: 'active' | 'archived', writable?: boolean}]
//   flowId        id del recorrido que se valida (para detectar «ir a sí mismo»)
//   ai            false si la marca no tiene proveedor de IA
// Las listas deben venir ya filtradas por marca: una referencia a algo de otra marca no aparece y se reporta.

// ---------------------------------------------------------------------------------------------------------------------
// 1. Constantes y utilidades
// ---------------------------------------------------------------------------------------------------------------------

export const GRAPH_VERSION = 1;
export const EXPORT_FORMAT = 'recorrido';
export const EXPORT_VERSION = 1;

export const LIMITS = Object.freeze({
  nodes: 80,
  edges: 200,
  bytes: 200_000,
  flowsPerBrand: 100,
  variables: 20,
  title: 60,
  text: 4096,
  interactiveText: 1024,
  header: 60,
  footer: 60,
  caption: 1024,
  parts: 5,
  buttons: 3,
  buttonLabel: 20,
  listSections: 10,
  listRows: 10,
  listButton: 20,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  attempts: 3,
  regex: 120,
  cases: 5,
  caseLabel: 40,
  conditionGroups: 5,
  conditionItems: 8,
  value: 500,
  delaySeconds: 600,
  delayWarnSeconds: 60,
  tags: 12,
  templateButtons: 10,
  webhookHeaders: 10,
  webhookMap: 10,
  webhookBody: 8000,
  url: 2000,
  collectPerFlow: 2,
  prompt: 300,
  note: 1000,
});

export const ID_RE = /^[a-z0-9]{1,16}$/;
export const VARIABLE_RE = /^[a-z][a-z0-9_]{0,29}$/;
export const ATTRIBUTE_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const SLOT_RE = /^[a-z][a-z0-9_]{0,39}$/;

// Las marcas de acento se arman con su código: el repositorio no admite caracteres invisibles escritos en el archivo.
const MARKS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
// Caracteres de control, salvo tabulador y saltos de línea: llegan al pegar texto y rompen los mensajes.
const CONTROL = /[^\P{Cc}\t\n\r]/gu;
// La misma expresión que rechaza importes en el conocimiento (server/replies.mjs): el precio sólo sale del catálogo.
const AMOUNT_RE = /\$\s?\d|\d+\s?(pesos|mxn|usd)/i;

// Compara textos sin importar mayúsculas, acentos ni signos. Es la misma normalización de los botones del flujo de
// bienvenida (server/flows.mjs, `norm`): el servidor reconoce una opción con ella y el modelo debe coincidir.
export const norm = v =>
  String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(MARKS, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// `RegExp.test` convierte a texto lo que reciba: sin esta guarda, `undefined` pasaría por un nombre válido.
const matches = (re, v) => typeof v === 'string' && re.test(v);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const text = v => (typeof v === 'string' ? v.replace(CONTROL, '') : '');
const flag = (v, fallback = false) => (typeof v === 'boolean' ? v : fallback);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const list = (v, fn) => (Array.isArray(v) ? v.map(fn) : []);
const ids = v => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x !== ''))] : []);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const quote = s => '«' + s + '»';
const short = (s, max = 60) => {
  const flat = String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
};

function int(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v));
  return fallback;
}

// Menor identificador libre con un prefijo («n1», «n2»…). Sin azar: el mismo grafo da siempre el mismo id nuevo, y eso
// permite reproducir una secuencia de ediciones en las pruebas.
export function nextId(taken, prefix = 'n') {
  let n = 1;
  while (taken.has(prefix + n)) n += 1;
  return prefix + n;
}

// Deja ids válidos y únicos en una lista de opciones, filas o casos. El primero con un id lo conserva; los repetidos y
// los inválidos reciben uno nuevo, porque cada id da nombre a una salida y dos salidas iguales no se podrían conectar.
function uniqueIds(items, prefix) {
  const seen = new Set();
  for (const item of items) {
    if (ID_RE.test(item.id) && !seen.has(item.id)) seen.add(item.id);
    else item.id = '';
  }
  for (const item of items) {
    if (item.id) continue;
    item.id = nextId(seen, prefix);
    seen.add(item.id);
  }
  return items;
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Datos en los textos: {{dato}}, {{contacto.clave}}, {{var.nombre}} y {{dato|respaldo}}
// ---------------------------------------------------------------------------------------------------------------------

// «asesor» no está a propósito: en un recorrido no hay una persona que envíe.
export const TOKENS = Object.freeze([
  { name: 'nombre', label: 'Nombre de pila', group: 'Persona' },
  { name: 'nombre_completo', label: 'Nombre completo', group: 'Persona' },
  { name: 'curso', label: 'Curso', group: 'Curso' },
  { name: 'edicion', label: 'Edición', group: 'Curso' },
  { name: 'marca', label: 'Marca', group: 'Curso' },
  { name: 'docente', label: 'Docente', group: 'Curso' },
  { name: 'modalidad', label: 'Modalidad', group: 'Curso' },
  { name: 'temario', label: 'Temario', group: 'Curso' },
  { name: 'incluye', label: 'Qué incluye', group: 'Curso' },
  { name: 'duracion', label: 'Duración', group: 'Curso' },
  { name: 'sesiones', label: 'Sesiones', group: 'Curso' },
  { name: 'fecha', label: 'Fecha de inicio', group: 'Precio y fechas' },
  { name: 'precio', label: 'Precio vigente', group: 'Precio y fechas' },
  { name: 'precio_regular', label: 'Precio regular', group: 'Precio y fechas' },
  { name: 'promocion', label: 'Promoción', group: 'Precio y fechas' },
  { name: 'vigencia', label: 'Vigencia de la promoción', group: 'Precio y fechas' },
  { name: 'vigencia_corta', label: 'Vigencia (corta)', group: 'Precio y fechas' },
  { name: 'ahorro', label: 'Ahorro', group: 'Precio y fechas' },
  { name: 'cupo', label: 'Cupo', group: 'Precio y fechas' },
  { name: 'enlace', label: 'Enlace del curso', group: 'Precio y fechas' },
]);
const TOKEN_NAMES = new Set(TOKENS.map(t => t.name));

// Datos de sistema del contacto y de la conversación: existen en todas las marcas y no se guardan dos veces, se leen
// de su tabla dueña. `write` dice quién puede escribirlos desde un recorrido: «any» (una pregunta o «Guardar dato»),
// «phone» y «email» (sólo una pregunta que valide ese formato) o «never» (lo calcula el sistema o tiene su propio paso).
export const SYSTEM_ATTRIBUTES = Object.freeze({
  nombre: { label: 'Nombre', write: 'any' },
  nombre_completo: { label: 'Nombre completo', write: 'any' },
  telefono: { label: 'Teléfono', write: 'phone' },
  correo: { label: 'Correo', write: 'email' },
  origen: { label: 'Origen', write: 'never' },
  consentimiento: { label: 'Consentimiento', write: 'never' },
  etiquetas: { label: 'Etiquetas', write: 'never' },
  etapa: { label: 'Etapa comercial', write: 'never' },
  curso_interes: { label: 'Curso de interés', write: 'never' },
  edicion: { label: 'Edición', write: 'never' },
  estado_pago: { label: 'Estado de pago', write: 'never' },
  inscrito: { label: 'Inscrito', write: 'never' },
  responsable: { label: 'Responsable', write: 'never' },
  estado_chat: { label: 'Estado de la conversación', write: 'never' },
  canal: { label: 'Canal', write: 'never' },
  anuncio: { label: 'Anuncio de origen', write: 'never' },
  ultimo_mensaje: { label: 'Último mensaje del cliente', write: 'never' },
  creado: { label: 'Fecha de alta', write: 'never' },
  cx_score_latest: { label: 'Experiencia (última)', write: 'never' },
});

const TOKEN_RE = /\{\{([^{}]*)\}\}/g;
const tokenName = raw => raw.toLowerCase().normalize('NFD').replace(MARKS, '').trim();

// Lista los datos que usa un texto. `kind`: 'base' (del catálogo o la persona), 'contact', 'var' o 'unknown'.
export function tokensIn(value) {
  const out = [];
  for (const m of String(value ?? '').matchAll(TOKEN_RE)) {
    const bar = m[1].indexOf('|');
    const name = tokenName(bar < 0 ? m[1] : m[1].slice(0, bar));
    const fallback = bar < 0 ? null : m[1].slice(bar + 1).trim();
    let kind = 'unknown';
    let key = name;
    if (name.startsWith('contacto.')) {
      key = name.slice(9);
      if (ATTRIBUTE_RE.test(key)) kind = 'contact';
    } else if (name.startsWith('var.')) {
      key = name.slice(4);
      if (VARIABLE_RE.test(key)) kind = 'var';
    } else if (TOKEN_NAMES.has(name)) kind = 'base';
    out.push({ raw: m[0], name, key, kind, fallback, index: m.index });
  }
  return out;
}

// Problemas de un texto escrito a mano: vacío, largo, datos que no existen o un importe tecleado.
function textProblems(value, { field, what, max, required = true }, env) {
  const out = [];
  const body = String(value ?? '');
  if (!body.trim()) {
    if (required) out.push({ field, message: `Escribe ${what}.` });
    return out;
  }
  if (body.length > max) {
    out.push({ field, message: `${cap(what)} es demasiado largo: ${body.length} de ${max} caracteres.` });
  }
  for (const t of tokensIn(body)) {
    if (t.kind === 'unknown') {
      out.push({ field, message: `${cap(what)} usa un dato que no existe: ${t.raw}.` });
    } else if (t.kind === 'var' && !env.vars.has(t.key)) {
      const message = `${cap(what)} usa la variable ${quote(t.key)}, que ningún paso guarda ni está declarada.`;
      out.push({ field, message });
    } else if (t.kind === 'contact' && !SYSTEM_ATTRIBUTES[t.key] && Array.isArray(env.ctx.attributes)) {
      const found = env.ctx.attributes.find(a => a.key === t.key);
      if (!found || found.status === 'archived') {
        const message = `${cap(what)} usa un dato del contacto que no existe o está archivado: ${t.raw}.`;
        out.push({ code: 'ref', field, message });
      }
    }
  }
  const bare = body.replace(TOKEN_RE, ' ');
  if (bare.includes('{{') || bare.includes('}}')) {
    out.push({ field, message: `${cap(what)} tiene llaves {{ }} sin cerrar.` });
  }
  if (AMOUNT_RE.test(bare)) {
    out.push({
      field,
      message: `${cap(what)} lleva un importe escrito a mano: usa {{precio}}, que sale del catálogo.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Referencias a cosas de la marca (materiales, etiquetas, plantillas, recorridos…)
// ---------------------------------------------------------------------------------------------------------------------

// `id` y `name` dicen qué campo identifica y nombra a cada elemento; `ready` separa «no existe» de «existe pero no está
// listo» (material sin aprobar, recorrido sin publicar), que son los dos casos del error `ref`.
export const REF_SOURCES = Object.freeze({
  materials: {
    id: 'id',
    name: 'name',
    noun: 'el material',
    ready: m => !m.status || m.status === 'approved',
    notReady: 'no está aprobado',
  },
  files: { id: 'id', name: 'name', noun: 'el archivo' },
  tags: { id: 'id', name: 'name', noun: 'la etiqueta' },
  waTemplates: {
    id: 'id',
    name: 'name',
    noun: 'la plantilla de WhatsApp',
    ready: t => !t.status || t.status === 'approved',
    notReady: 'no está aprobada',
  },
  flows: {
    id: 'id',
    name: 'name',
    noun: 'el recorrido',
    ready: f => f.published !== false,
    notReady: 'no está publicado',
  },
  users: {
    id: 'id',
    name: 'name',
    noun: 'la persona del equipo',
    ready: u => u.active !== false,
    notReady: 'ya no tiene acceso a esta marca',
  },
  courses: { id: 'id', name: 'title', noun: 'el curso' },
  attributes: {
    id: 'key',
    name: 'label',
    noun: 'el dato del contacto',
    ready: a => a.status !== 'archived',
    notReady: 'está archivado',
  },
});

export function findRef(ctx, source, id) {
  const items = ctx?.[source];
  const meta = REF_SOURCES[source];
  if (!Array.isArray(items) || !meta) return null;
  return items.find(item => item?.[meta.id] === id) || null;
}

export function refName(ctx, source, id) {
  const found = findRef(ctx, source, id);
  return found ? String(found[REF_SOURCES[source].name] ?? '') : '';
}

function refProblems(id, source, { field, missing }, env) {
  if (!id) return missing ? [{ field, message: missing }] : [];
  const items = env.ctx[source];
  if (!Array.isArray(items)) return [];
  const meta = REF_SOURCES[source];
  const found = findRef(env.ctx, source, id);
  if (!found) return [{ code: 'ref', field, message: `${cap(meta.noun)} de este paso no existe en esta marca.` }];
  if (meta.ready && !meta.ready(found)) {
    const name = quote(String(found[meta.name] ?? id));
    return [{ code: 'ref', field, message: `${cap(meta.noun)} ${name} ${meta.notReady}.` }];
  }
  return [];
}

function variableProblems(name, field, what) {
  if (!name) return [{ field, message: `Escribe el nombre de la variable ${what}.` }];
  if (VARIABLE_RE.test(name)) return [];
  const rule = 'empieza con una letra minúscula y sólo lleva minúsculas, números y guion bajo (hasta 30)';
  return [{ field, message: `El nombre de la variable ${what} no es válido: ${rule}.` }];
}

// Un dato del contacto en el que un paso quiere escribir. `mode` es el formato que valida quien escribe ('phone',
// 'email' o 'any'): el teléfono y el correo sólo se aceptan ya validados, y lo que calcula el sistema, nunca.
function attributeProblems(key, { field, mode }, env) {
  if (!key) return [{ field, message: 'Elige el dato del contacto.' }];
  const system = SYSTEM_ATTRIBUTES[key];
  if (system) {
    if (system.write === 'never') {
      const message = `${quote(system.label)} no se puede escribir desde un recorrido: lo calcula el sistema o tiene su propio paso.`;
      return [{ field, message }];
    }
    if (system.write !== 'any' && system.write !== mode) {
      const kind = system.write === 'phone' ? 'teléfono' : 'correo';
      return [{ field, message: `${quote(system.label)} sólo se guarda desde una Pregunta que valide el ${kind}.` }];
    }
    return [];
  }
  if (!ATTRIBUTE_RE.test(key)) return [{ field, message: 'La clave del dato del contacto no es válida.' }];
  const found = Array.isArray(env.ctx.attributes) ? findRef(env.ctx, 'attributes', key) : undefined;
  if (found === undefined) return [];
  if (!found) return [{ code: 'ref', field, message: `El dato del contacto ${quote(key)} no existe en esta marca.` }];
  if (found.status === 'archived') {
    return [{ code: 'ref', field, message: `El dato del contacto ${quote(found.label || key)} está archivado.` }];
  }
  if (found.writable === false) {
    return [{ field, message: `${quote(found.label || key)} no se puede escribir desde un recorrido.` }];
  }
  return [];
}

const cleanSaveTo = v =>
  v?.kind === 'attribute' ? { kind: 'attribute', key: text(v.key) } : { kind: 'var', name: text(v?.name) };

function saveToProblems(saveTo, { field, mode = 'any' }, env) {
  if (saveTo.kind === 'attribute') return attributeProblems(saveTo.key, { field: `${field}.key`, mode }, env);
  return variableProblems(saveTo.name, `${field}.name`, 'donde se guarda la respuesta');
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Condiciones (las del paso «Condición»; misma forma que los filtros de las reglas: grupos de condiciones)
// ---------------------------------------------------------------------------------------------------------------------

export const CHANNELS = Object.freeze([
  ['whatsapp', 'WhatsApp'],
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
]);
const CHANNEL_IDS = CHANNELS.map(c => c[0]);

export const CONDITION_FIELDS = Object.freeze([
  ['attr', 'Un dato del contacto o una variable'],
  ['tag', 'Una etiqueta'],
  ['hours', 'El horario de atención'],
  ['clock', 'El día y la hora'],
  ['course', 'El curso de la conversación'],
  ['channel', 'El canal'],
]);
const CONDITION_IDS = CONDITION_FIELDS.map(f => f[0]);

export const CONDITION_OPS = Object.freeze([
  ['eq', 'es igual a'],
  ['neq', 'es distinto de'],
  ['contains', 'contiene'],
  ['not_contains', 'no contiene'],
  ['starts', 'empieza con'],
  ['gt', 'es mayor que'],
  ['gte', 'es mayor o igual que'],
  ['lt', 'es menor que'],
  ['lte', 'es menor o igual que'],
  ['empty', 'está vacío'],
  ['not_empty', 'tiene valor'],
]);
const OP_IDS = CONDITION_OPS.map(o => o[0]);
const OPS_WITHOUT_VALUE = ['empty', 'not_empty'];

export const WEEKDAYS = Object.freeze([
  ['1', 'Lunes'],
  ['2', 'Martes'],
  ['3', 'Miércoles'],
  ['4', 'Jueves'],
  ['5', 'Viernes'],
  ['6', 'Sábado'],
  ['0', 'Domingo'],
]);
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanCondition(c) {
  const f = pick(c?.f, CONDITION_IDS, 'attr');
  if (f === 'tag') return { f, op: pick(c.op, ['has', 'has_not'], 'has'), tagId: text(c.tagId) };
  if (f === 'hours') return { f, is: pick(c.is, ['open', 'closed'], 'open') };
  if (f === 'clock') {
    const days = ids(list(c.days, d => String(d))).filter(d => WEEKDAYS.some(w => w[0] === d));
    return { f, days, from: text(c.from), to: text(c.to) };
  }
  if (f === 'course') return { f, in: ids(c.in) };
  if (f === 'channel') return { f, in: ids(c.in).filter(id => CHANNEL_IDS.includes(id)) };
  const op = pick(c?.op, OP_IDS, 'eq');
  return OPS_WITHOUT_VALUE.includes(op)
    ? { f, key: text(c?.key), op }
    : { f, key: text(c?.key), op, value: text(c?.value) };
}

const cleanMode = v => pick(v, ['all', 'any'], 'all');

export function cleanWhen(when) {
  return {
    mode: cleanMode(when?.mode),
    groups: list(when?.groups, g => ({ mode: cleanMode(g?.mode), items: list(g?.items, cleanCondition) })),
  };
}

function whenProblems(when, field, what, env) {
  const out = [];
  const total = when.groups.reduce((sum, g) => sum + g.items.length, 0);
  if (!total) return [{ field, message: `${cap(what)} no tiene ninguna condición: siempre se cumpliría.` }];
  if (when.groups.length > LIMITS.conditionGroups) {
    out.push({ field, message: `${cap(what)} admite hasta ${LIMITS.conditionGroups} grupos de condiciones.` });
  }
  when.groups.forEach((group, g) => {
    const base = `${field}.groups.${g}.items`;
    if (!group.items.length) out.push({ field: base, message: `${cap(what)} tiene un grupo sin condiciones.` });
    if (group.items.length > LIMITS.conditionItems) {
      out.push({ field: base, message: `Cada grupo admite hasta ${LIMITS.conditionItems} condiciones.` });
    }
    group.items.forEach((item, i) => out.push(...conditionProblems(item, `${base}.${i}`, env)));
  });
  return out;
}

function conditionProblems(item, field, env) {
  if (item.f === 'tag')
    return refProblems(item.tagId, 'tags', { field: `${field}.tagId`, missing: 'Elige la etiqueta.' }, env);
  if (item.f === 'hours') return [];
  if (item.f === 'clock') {
    const out = [];
    if (!item.days.length) out.push({ field: `${field}.days`, message: 'Elige al menos un día.' });
    if (!CLOCK_RE.test(item.from) || !CLOCK_RE.test(item.to)) {
      out.push({
        field: `${field}.from`,
        message: 'Escribe la hora de inicio y la de fin (por ejemplo 09:00 y 18:00).',
      });
    }
    return out;
  }
  if (item.f === 'course') {
    if (!item.in.length) return [{ field: `${field}.in`, message: 'Elige al menos un curso.' }];
    return item.in.flatMap(id => refProblems(id, 'courses', { field: `${field}.in` }, env));
  }
  if (item.f === 'channel') {
    return item.in.length ? [] : [{ field: `${field}.in`, message: 'Elige al menos un canal.' }];
  }
  const out = [];
  if (!item.key) {
    out.push({ field: `${field}.key`, message: 'Elige el dato que se compara.' });
  } else if (item.key.startsWith('var.')) {
    const name = item.key.slice(4);
    if (!env.vars.has(name)) {
      const message = `La condición usa la variable ${quote(name)}, que ningún paso guarda ni está declarada.`;
      out.push({ field: `${field}.key`, message });
    }
  } else if (!SYSTEM_ATTRIBUTES[item.key]) {
    if (!ATTRIBUTE_RE.test(item.key)) {
      out.push({ field: `${field}.key`, message: 'La clave del dato que se compara no es válida.' });
    } else out.push(...refProblems(item.key, 'attributes', { field: `${field}.key` }, env));
  }
  if (!OPS_WITHOUT_VALUE.includes(item.op)) {
    if (!String(item.value ?? '').trim())
      out.push({ field: `${field}.value`, message: 'Escribe el valor con el que se compara.' });
    else if (item.value.length > LIMITS.value) {
      out.push({
        field: `${field}.value`,
        message: `El valor de la condición admite hasta ${LIMITS.value} caracteres.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Registro de tipos de paso
// ---------------------------------------------------------------------------------------------------------------------

export const GROUPS = Object.freeze([
  { id: 'mensajes', label: 'Mensajes' },
  { id: 'catalogo', label: 'Catálogo' },
  { id: 'logica', label: 'Lógica' },
  { id: 'contacto', label: 'Contacto' },
  { id: 'atencion', label: 'Atención' },
  { id: 'integraciones', label: 'Integraciones' },
]);

// Lo que el asistente ya sabe hacer cuando se lo piden (las mismas acciones del flujo de bienvenida, server/flows.mjs).
export const INTENTS = Object.freeze({
  price: 'Enviar el precio vigente',
  syllabus: 'Enviar el temario',
  schedule: 'Enviar fechas y horario',
  enroll: 'Inscribirse',
  human: 'Pasar con una persona',
});
const INTENT_IDS = Object.keys(INTENTS);

export const ANSWER_TYPES = Object.freeze({
  text: 'Texto libre',
  number: 'Número',
  email: 'Correo',
  phone: 'Teléfono',
  date: 'Fecha',
  time: 'Hora',
  datetime: 'Fecha y hora',
  regex: 'Formato propio (expresión)',
  media: 'Archivo',
  location: 'Ubicación',
});
const ANSWER_IDS = Object.keys(ANSWER_TYPES);

export const MEDIA_KINDS = Object.freeze([
  ['image', 'Imagen'],
  ['document', 'Documento'],
  ['video', 'Video'],
  ['audio', 'Audio'],
]);
const MEDIA_IDS = MEDIA_KINDS.map(m => m[0]);

// Salidas con nombre fijo. Las marcadas `optional` tienen un comportamiento por omisión definido (el recorrido termina
// como abandono, o hace lo mismo que el asistente), así que dejarlas sin conectar no merece una advertencia.
const NEXT = Object.freeze({ id: 'next', label: 'Sigue' });
const DEFAULT_PORT = Object.freeze({ id: 'default', label: 'Si no elige', optional: true });
const TIMEOUT_PORT = Object.freeze({ id: 'timeout', label: 'Sin respuesta', optional: true });
const UNAVAILABLE_PORT = Object.freeze({ id: 'unavailable', label: 'No disponible', optional: true });

const UNEXPECTED = [
  ['', 'Lo que diga el recorrido'],
  ['assistant', 'Que conteste el asistente y vuelva a ofrecer las opciones'],
  ['repeat', 'Repetir las opciones con el mensaje de reserva'],
  ['default', 'Seguir por «Si no elige»'],
];
const BODY_OPTIONS = [
  ['data', 'Sólo el dato'],
  ['full', 'El dato y la invitación a seguir'],
];
const DO_OPTIONS = [
  ['goto', 'Sigue por su salida'],
  ['intent', 'Responde el asistente'],
];
const INTENT_OPTIONS = INTENT_IDS.map(id => [id, INTENTS[id]]);

const cleanDo = v =>
  v?.type === 'intent'
    ? { type: 'intent', intent: pick(v.intent, INTENT_IDS, 'price'), stay: flag(v.stay, true) }
    : { type: 'goto' };

function cleanHeader(h) {
  const kind = pick(h?.kind, ['none', 'text', 'media', 'course_flyer'], 'none');
  if (kind === 'text') return { kind, text: text(h.text) };
  if (kind === 'media') return { kind, fileId: text(h.fileId) };
  return { kind };
}

const PART_KINDS = [
  ['text', 'Texto'],
  ['media', 'Archivo'],
  ['material', 'Material aprobado'],
  ['slot', 'Material según el curso'],
];

function cleanPart(p) {
  const kind = pick(
    p?.kind,
    PART_KINDS.map(k => k[0]),
    'text',
  );
  if (kind === 'media') return { kind, fileId: text(p.fileId), caption: text(p.caption) };
  if (kind === 'material') return { kind, templateId: text(p.templateId) };
  if (kind === 'slot') return { kind, slot: text(p.slot), ifMissing: pick(p.ifMissing, ['skip', 'stop'], 'skip') };
  return { kind, text: text(p?.text) };
}

// Campos de «dónde se guarda» que comparten Pregunta, Servicio externo y el asistente que recolecta.
const saveToFields = (prefix, label) => [
  {
    key: `${prefix}.kind`,
    kind: 'choice',
    label,
    options: [
      ['var', 'En una variable del recorrido'],
      ['attribute', 'En un dato del contacto'],
    ],
  },
  {
    key: `${prefix}.name`,
    kind: 'text',
    label: 'Nombre de la variable',
    max: 30,
    mono: true,
    suggest: 'variables',
    when: { key: `${prefix}.kind`, is: ['var'] },
    help: 'Sólo vive mientras dura el recorrido. Para conservarla, guárdala en un dato del contacto.',
  },
  {
    key: `${prefix}.key`,
    kind: 'ref',
    label: 'Dato del contacto',
    source: 'attributes',
    when: { key: `${prefix}.kind`, is: ['attribute'] },
  },
];

// Problemas de las opciones de Botones y de las filas de Lista: comparten texto obligatorio, largo y títulos distintos.
function optionProblems(options, { field, noun, max }) {
  const out = [];
  const seen = new Map();
  options.forEach((o, i) => {
    const at = field(i);
    const label = o.label ?? o.title;
    if (!String(label).trim()) {
      out.push({ field: at, message: `Hay ${noun} sin texto.` });
      return;
    }
    if (label.length > max) {
      out.push({
        field: at,
        message: `${cap(noun)} ${quote(short(label, 40))} es demasiado largo: ${label.length} de ${max} caracteres.`,
      });
    }
    const key = norm(label);
    if (!key) out.push({ field: at, message: `${cap(noun)} ${quote(label)} necesita al menos una letra o un número.` });
    else if (seen.has(key))
      out.push({ field: at, message: `Hay dos opciones con el mismo texto: ${quote(short(label, 40))}.` });
    else seen.set(key, i);
    if (AMOUNT_RE.test(label)) {
      out.push({ field: at, message: `${cap(noun)} ${quote(short(label, 40))} lleva un importe escrito a mano.` });
    }
  });
  return out;
}

// Detecta un grupo que contiene un cuantificador y a su vez se repite: «(a+)+», «(.*)*». Con un texto adverso esos
// patrones tardan un tiempo exponencial, y el patrón de una Pregunta corre en el servidor con lo que escribe cualquiera.
// Una repetición exacta («{2}») no cuenta: no puede crecer.
export function hasNestedQuantifier(pattern) {
  const open = [false];
  const grows = at => {
    const ch = pattern[at];
    return ch === '+' || ch === '*' || (ch === '{' && /^\{\d+,\d*\}/.test(pattern.slice(at)));
  };
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
    } else if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      open.push(false);
    } else if (ch === ')') {
      const inner = open.length > 1 ? open.pop() : false;
      const repeated = grows(i + 1);
      if (inner && repeated) return true;
      if (inner || repeated) open[open.length - 1] = true;
    } else if (grows(i)) {
      open[open.length - 1] = true;
    }
  }
  return false;
}

function urlProblems(value, field) {
  if (!value.trim()) return [{ field, message: 'Escribe la dirección del servicio.' }];
  if (value.length > LIMITS.url) return [{ field, message: `La dirección admite hasta ${LIMITS.url} caracteres.` }];
  const bad = [{ field, message: 'La dirección debe ser pública y empezar con https://.' }];
  if (!/^https:\/\//i.test(value)) return bad;
  let parsed;
  try {
    // Los datos {{…}} se sustituyen al enviar; aquí sólo importa que el resto de la dirección sea válido.
    parsed = new URL(value.replace(TOKEN_RE, 'x'));
  } catch {
    return [{ field, message: 'La dirección del servicio no es válida.' }];
  }
  if (parsed.username || parsed.password)
    return [{ field, message: 'La dirección no debe llevar usuario ni contraseña.' }];
  const host = parsed.hostname.toLowerCase();
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.startsWith('[') ||
    /^(127|10|0)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  // El servidor repite esta comprobación con la dirección ya resuelta en cada llamada; aquí se avisa pronto.
  return local ? bad : [];
}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = ['host', 'content-length', 'connection', 'transfer-encoding', 'idempotency-key'];

const TYPES = {
  start: {
    label: 'Inicio',
    group: 'logica',
    icon: 'play',
    palette: false,
    hint: 'Aquí empieza el recorrido. Las reglas que lo inician se ven en su ficha.',
    defaults: () => ({}),
    clean: () => ({}),
    ports: () => [NEXT],
    summary: () => 'Aquí empieza el recorrido',
    fields: [],
  },

  message: {
    label: 'Mensaje',
    group: 'mensajes',
    icon: 'message',
    hint: 'Envía texto, un archivo o un material. Cada parte es un mensaje.',
    speaks: () => true,
    defaults: () => ({ parts: [{ kind: 'text', text: '' }] }),
    clean: d => ({ parts: list(d.parts, cleanPart) }),
    ports: () => [NEXT],
    refs: d =>
      d.parts.flatMap((p, i) =>
        p.kind === 'media'
          ? [['files', p.fileId, `parts.${i}.fileId`]]
          : p.kind === 'material'
            ? [['materials', p.templateId, `parts.${i}.templateId`]]
            : [],
      ),
    validate(d, env) {
      const out = [];
      if (!d.parts.length) out.push({ field: 'parts', message: 'Agrega al menos una parte al mensaje.' });
      if (d.parts.length > LIMITS.parts) {
        out.push({
          field: 'parts',
          message: `Un mensaje admite hasta ${LIMITS.parts} partes; cada parte es un mensaje.`,
        });
      }
      d.parts.forEach((p, i) => {
        const at = `parts.${i}`;
        const n = d.parts.length > 1 ? ` de la parte ${i + 1}` : '';
        if (p.kind === 'text') {
          out.push(...textProblems(p.text, { field: `${at}.text`, what: `el texto${n}`, max: LIMITS.text }, env));
        } else if (p.kind === 'media') {
          out.push(...refProblems(p.fileId, 'files', { field: `${at}.fileId`, missing: `Elige el archivo${n}.` }, env));
          const caption = {
            field: `${at}.caption`,
            what: `el pie del archivo${n}`,
            max: LIMITS.caption,
            required: false,
          };
          out.push(...textProblems(p.caption, caption, env));
        } else if (p.kind === 'material') {
          const missing = `Elige el material${n}.`;
          out.push(...refProblems(p.templateId, 'materials', { field: `${at}.templateId`, missing }, env));
        } else if (!SLOT_RE.test(p.slot)) {
          const rule = 'en minúsculas, sin espacios (por ejemplo presentacion o instrucciones_pago)';
          out.push({ field: `${at}.slot`, message: `Escribe el nombre del espacio${n}, ${rule}.` });
        }
      });
      return out;
    },
    summary(d, ctx) {
      const first = d.parts[0];
      if (!first) return '';
      const more = d.parts.length > 1 ? ` · +${d.parts.length - 1}` : '';
      if (first.kind === 'text') return short(first.text) + more;
      if (first.kind === 'media') return 'Archivo: ' + (refName(ctx, 'files', first.fileId) || 'sin elegir') + more;
      if (first.kind === 'material') {
        return 'Material: ' + (refName(ctx, 'materials', first.templateId) || 'sin elegir') + more;
      }
      return 'Material según el curso: ' + (first.slot || 'sin espacio') + more;
    },
    fields: [
      {
        key: 'parts',
        kind: 'list',
        label: 'Partes del mensaje',
        item: 'Parte',
        add: 'Agregar parte',
        min: 1,
        max: LIMITS.parts,
        make: () => ({ kind: 'text', text: '' }),
        fields: [
          { key: 'kind', kind: 'choice', label: 'Qué envía', options: PART_KINDS },
          {
            key: 'text',
            kind: 'area',
            label: 'Texto',
            max: LIMITS.text,
            tokens: true,
            when: { key: 'kind', is: ['text'] },
          },
          { key: 'fileId', kind: 'ref', label: 'Archivo', source: 'files', when: { key: 'kind', is: ['media'] } },
          {
            key: 'caption',
            kind: 'area',
            label: 'Pie del archivo (opcional)',
            max: LIMITS.caption,
            tokens: true,
            when: { key: 'kind', is: ['media'] },
          },
          {
            key: 'templateId',
            kind: 'ref',
            label: 'Material',
            source: 'materials',
            when: { key: 'kind', is: ['material'] },
          },
          {
            key: 'slot',
            kind: 'text',
            label: 'Espacio',
            max: 40,
            mono: true,
            suggest: 'slots',
            when: { key: 'kind', is: ['slot'] },
            help: 'Se envía el material aprobado más específico de ese espacio: el de la edición, luego el del curso y luego el general de la marca.',
          },
          {
            key: 'ifMissing',
            kind: 'choice',
            label: 'Si el curso no tiene ese material',
            options: [
              ['skip', 'Saltar esta parte y seguir'],
              ['stop', 'Detener el recorrido aquí'],
            ],
            when: { key: 'kind', is: ['slot'] },
          },
        ],
      },
    ],
  },

  buttons: {
    label: 'Botones',
    group: 'mensajes',
    icon: 'buttons',
    hint: 'Un mensaje con hasta 3 botones. Espera a que la persona elija.',
    speaks: () => true,
    waits: () => true,
    defaults: () => ({
      header: { kind: 'none' },
      text: '',
      footer: '',
      options: [{ id: 'o1', label: '', do: { type: 'goto' } }],
      saveAs: '',
      onUnexpected: '',
    }),
    clean: d => ({
      header: cleanHeader(d.header),
      text: text(d.text),
      footer: text(d.footer),
      options: uniqueIds(
        list(d.options, o => ({ id: text(o?.id), label: text(o?.label), do: cleanDo(o?.do) })),
        'o',
      ),
      saveAs: text(d.saveAs),
      onUnexpected: pick(d.onUnexpected, ['assistant', 'repeat', 'default'], ''),
    }),
    ports: d => [
      ...d.options
        .filter(o => o.do.type === 'goto')
        .map(o => ({ id: 'opt:' + o.id, label: short(o.label, 30) || 'Botón sin texto' })),
      DEFAULT_PORT,
      TIMEOUT_PORT,
    ],
    refs: d => (d.header.kind === 'media' ? [['files', d.header.fileId, 'header.fileId']] : []),
    writes: d => (d.saveAs ? [d.saveAs] : []),
    validate(d, env) {
      const out = [];
      if (d.header.kind === 'text') {
        out.push(
          ...textProblems(d.header.text, { field: 'header.text', what: 'el encabezado', max: LIMITS.header }, env),
        );
      } else if (d.header.kind === 'media') {
        const missing = 'Elige el archivo del encabezado.';
        out.push(...refProblems(d.header.fileId, 'files', { field: 'header.fileId', missing }, env));
      }
      out.push(...textProblems(d.text, { field: 'text', what: 'el mensaje', max: LIMITS.interactiveText }, env));
      out.push(
        ...textProblems(d.footer, { field: 'footer', what: 'el pie', max: LIMITS.footer, required: false }, env),
      );
      if (!d.options.length) out.push({ field: 'options', message: 'Agrega al menos un botón.' });
      if (d.options.length > LIMITS.buttons) {
        const tip = 'para más opciones usa una Lista';
        out.push({
          field: 'options',
          message: `WhatsApp admite hasta ${LIMITS.buttons} botones por mensaje (hay ${d.options.length}); ${tip}.`,
        });
      }
      out.push(
        ...optionProblems(d.options, { field: i => `options.${i}.label`, noun: 'el botón', max: LIMITS.buttonLabel }),
      );
      if (d.saveAs) out.push(...variableProblems(d.saveAs, 'saveAs', 'donde se guarda la opción elegida'));
      return out;
    },
    summary: d => short(d.text),
    fields: [
      {
        key: 'header.kind',
        kind: 'choice',
        label: 'Encabezado',
        options: [
          ['none', 'Sin encabezado'],
          ['text', 'Texto'],
          ['media', 'Archivo'],
          ['course_flyer', 'Ficha vigente del curso'],
        ],
      },
      {
        key: 'header.text',
        kind: 'text',
        label: 'Texto del encabezado',
        max: LIMITS.header,
        when: { key: 'header.kind', is: ['text'] },
      },
      {
        key: 'header.fileId',
        kind: 'ref',
        label: 'Archivo del encabezado',
        source: 'files',
        when: { key: 'header.kind', is: ['media'] },
      },
      { key: 'text', kind: 'area', label: 'Mensaje', max: LIMITS.interactiveText, tokens: true },
      { key: 'footer', kind: 'text', label: 'Pie (opcional)', max: LIMITS.footer },
      {
        key: 'options',
        kind: 'list',
        label: 'Botones',
        item: 'Botón',
        add: 'Agregar botón',
        min: 1,
        max: LIMITS.buttons,
        make: () => ({ id: '', label: '', do: { type: 'goto' } }),
        fields: [
          { key: 'label', kind: 'text', label: 'Texto del botón', max: LIMITS.buttonLabel },
          { key: 'do.type', kind: 'choice', label: 'Al pulsarlo', options: DO_OPTIONS },
          {
            key: 'do.intent',
            kind: 'choice',
            label: 'Qué responde',
            options: INTENT_OPTIONS,
            when: { key: 'do.type', is: ['intent'] },
          },
          {
            key: 'do.stay',
            kind: 'check',
            label: 'Dejar los botones a la vista después de responder',
            when: { key: 'do.type', is: ['intent'] },
          },
        ],
      },
      {
        key: 'saveAs',
        kind: 'text',
        label: 'Guardar la opción elegida en la variable (opcional)',
        max: 30,
        mono: true,
        suggest: 'variables',
      },
      { key: 'onUnexpected', kind: 'choice', label: 'Si escribe otra cosa', options: UNEXPECTED },
    ],
  },

  list: {
    label: 'Lista',
    group: 'mensajes',
    icon: 'list',
    hint: 'Un menú de hasta 10 filas. Espera a que la persona elija.',
    speaks: () => true,
    waits: () => true,
    defaults: () => ({
      header: '',
      text: '',
      footer: '',
      button: 'Ver opciones',
      sections: [{ title: '', rows: [{ id: 'r1', title: '', description: '', do: { type: 'goto' } }] }],
      saveAs: '',
      onUnexpected: '',
    }),
    clean(d) {
      const sections = list(d.sections, s => ({
        title: text(s?.title),
        rows: list(s?.rows, r => ({
          id: text(r?.id),
          title: text(r?.title),
          description: text(r?.description),
          do: cleanDo(r?.do),
        })),
      }));
      // Los ids son únicos en toda la lista, no por sección: cada fila tiene su propia salida.
      uniqueIds(
        sections.flatMap(s => s.rows),
        'r',
      );
      return {
        header: text(d.header),
        text: text(d.text),
        footer: text(d.footer),
        button: text(d.button),
        sections,
        saveAs: text(d.saveAs),
        onUnexpected: pick(d.onUnexpected, ['assistant', 'repeat', 'default'], ''),
      };
    },
    ports: d => [
      ...d.sections
        .flatMap(s => s.rows)
        .filter(r => r.do.type === 'goto')
        .map(r => ({ id: 'opt:' + r.id, label: short(r.title, 30) || 'Fila sin texto' })),
      DEFAULT_PORT,
      TIMEOUT_PORT,
    ],
    writes: d => (d.saveAs ? [d.saveAs] : []),
    validate(d, env) {
      const out = [];
      out.push(
        ...textProblems(d.header, { field: 'header', what: 'el encabezado', max: LIMITS.header, required: false }, env),
      );
      out.push(...textProblems(d.text, { field: 'text', what: 'el mensaje', max: LIMITS.interactiveText }, env));
      out.push(
        ...textProblems(d.footer, { field: 'footer', what: 'el pie', max: LIMITS.footer, required: false }, env),
      );
      const button = { field: 'button', what: 'el texto del botón que abre la lista', max: LIMITS.listButton };
      out.push(...textProblems(d.button, button, env));
      if (!d.sections.length) out.push({ field: 'sections', message: 'Agrega al menos una sección con una fila.' });
      if (d.sections.length > LIMITS.listSections) {
        out.push({ field: 'sections', message: `Una lista admite hasta ${LIMITS.listSections} secciones.` });
      }
      const rows = [];
      d.sections.forEach((s, i) => {
        if (!s.rows.length) out.push({ field: `sections.${i}.rows`, message: `La sección ${i + 1} no tiene filas.` });
        if (d.sections.length > 1 && !s.title.trim()) {
          out.push({
            field: `sections.${i}.title`,
            message: `Con más de una sección, cada una necesita título (falta el de la ${i + 1}).`,
          });
        }
        if (s.title.length > LIMITS.sectionTitle) {
          const size = `${s.title.length} de ${LIMITS.sectionTitle} caracteres`;
          out.push({
            field: `sections.${i}.title`,
            message: `El título de la sección ${i + 1} es demasiado largo: ${size}.`,
          });
        }
        s.rows.forEach((r, j) => {
          rows.push({ row: r, at: `sections.${i}.rows.${j}` });
          if (r.description.length > LIMITS.rowDescription) {
            const size = `${r.description.length} de ${LIMITS.rowDescription} caracteres`;
            out.push({
              field: `sections.${i}.rows.${j}.description`,
              message: `La descripción de ${quote(short(r.title, 30))} es demasiado larga: ${size}.`,
            });
          }
        });
      });
      if (rows.length > LIMITS.listRows) {
        out.push({
          field: 'sections',
          message: `WhatsApp admite hasta ${LIMITS.listRows} filas por lista (hay ${rows.length}).`,
        });
      }
      const titled = rows.map(r => r.row);
      out.push(...optionProblems(titled, { field: i => `${rows[i].at}.title`, noun: 'la fila', max: LIMITS.rowTitle }));
      if (d.saveAs) out.push(...variableProblems(d.saveAs, 'saveAs', 'donde se guarda la opción elegida'));
      return out;
    },
    summary: d => short(d.text),
    fields: [
      { key: 'header', kind: 'text', label: 'Encabezado (opcional)', max: LIMITS.header },
      { key: 'text', kind: 'area', label: 'Mensaje', max: LIMITS.interactiveText, tokens: true },
      { key: 'footer', kind: 'text', label: 'Pie (opcional)', max: LIMITS.footer },
      { key: 'button', kind: 'text', label: 'Texto del botón que abre la lista', max: LIMITS.listButton },
      {
        key: 'sections',
        kind: 'list',
        label: 'Secciones',
        item: 'Sección',
        add: 'Agregar sección',
        min: 1,
        max: LIMITS.listSections,
        make: () => ({ title: '', rows: [{ id: '', title: '', description: '', do: { type: 'goto' } }] }),
        fields: [
          { key: 'title', kind: 'text', label: 'Título de la sección', max: LIMITS.sectionTitle },
          {
            key: 'rows',
            kind: 'list',
            label: 'Filas',
            item: 'Fila',
            add: 'Agregar fila',
            min: 1,
            max: LIMITS.listRows,
            make: () => ({ id: '', title: '', description: '', do: { type: 'goto' } }),
            fields: [
              { key: 'title', kind: 'text', label: 'Título de la fila', max: LIMITS.rowTitle },
              { key: 'description', kind: 'text', label: 'Descripción (opcional)', max: LIMITS.rowDescription },
              { key: 'do.type', kind: 'choice', label: 'Al elegirla', options: DO_OPTIONS },
              {
                key: 'do.intent',
                kind: 'choice',
                label: 'Qué responde',
                options: INTENT_OPTIONS,
                when: { key: 'do.type', is: ['intent'] },
              },
              {
                key: 'do.stay',
                kind: 'check',
                label: 'Dejar la lista a la vista después de responder',
                when: { key: 'do.type', is: ['intent'] },
              },
            ],
          },
        ],
      },
      {
        key: 'saveAs',
        kind: 'text',
        label: 'Guardar la opción elegida en la variable (opcional)',
        max: 30,
        mono: true,
        suggest: 'variables',
      },
      { key: 'onUnexpected', kind: 'choice', label: 'Si escribe otra cosa', options: UNEXPECTED },
    ],
  },

  question: {
    label: 'Pregunta',
    group: 'mensajes',
    icon: 'question',
    hint: 'Pide un dato, lo valida y lo guarda.',
    speaks: () => true,
    waits: () => true,
    defaults: () => ({
      text: '',
      answer: { type: 'text' },
      saveTo: { kind: 'var', name: '' },
      errorText: '',
      attempts: 2,
    }),
    clean(d) {
      const given = isObj(d.answer) ? d.answer : {};
      const type = pick(given.type, ANSWER_IDS, 'text');
      const answer = { type };
      if (type === 'text' || type === 'number') {
        const min = int(given.min, null);
        const max = int(given.max, null);
        if (min !== null) answer.min = min;
        if (max !== null) answer.max = max;
      }
      if (type === 'regex') answer.pattern = text(given.pattern);
      if (type === 'media') answer.mediaKinds = ids(given.mediaKinds).filter(k => MEDIA_IDS.includes(k));
      return {
        text: text(d.text),
        answer,
        saveTo: cleanSaveTo(d.saveTo),
        errorText: text(d.errorText),
        attempts: int(d.attempts, 2),
      };
    },
    ports: () => [{ id: 'next', label: 'Respuesta válida' }, { id: 'invalid', label: 'No válida' }, TIMEOUT_PORT],
    refs: d => (d.saveTo.kind === 'attribute' ? [['attributes', d.saveTo.key, 'saveTo.key']] : []),
    writes: d => (d.saveTo.kind === 'var' && d.saveTo.name ? [d.saveTo.name] : []),
    validate(d, env) {
      const out = [];
      out.push(...textProblems(d.text, { field: 'text', what: 'la pregunta', max: LIMITS.text }, env));
      const error = { field: 'errorText', what: 'el mensaje de error', max: LIMITS.interactiveText, required: false };
      out.push(...textProblems(d.errorText, error, env));
      if (d.attempts < 1 || d.attempts > LIMITS.attempts) {
        out.push({ field: 'attempts', message: `Los intentos van de 1 a ${LIMITS.attempts}.` });
      }
      const a = d.answer;
      if (a.min !== undefined && a.max !== undefined && a.min > a.max) {
        out.push({ field: 'answer.min', message: 'El mínimo no puede ser mayor que el máximo.' });
      }
      if (a.type === 'text' && ((a.min ?? 0) < 0 || (a.max ?? 0) > LIMITS.text)) {
        out.push({ field: 'answer.min', message: `El largo de la respuesta va de 0 a ${LIMITS.text} caracteres.` });
      }
      if (a.type === 'regex') {
        if (!a.pattern)
          out.push({ field: 'answer.pattern', message: 'Escribe el formato que debe cumplir la respuesta.' });
        else if (a.pattern.length > LIMITS.regex) {
          out.push({
            field: 'answer.pattern',
            message: `El formato admite hasta ${LIMITS.regex} caracteres (tiene ${a.pattern.length}).`,
          });
        } else {
          let valid = true;
          try {
            new RegExp(a.pattern);
          } catch {
            valid = false;
          }
          if (!valid) out.push({ field: 'answer.pattern', message: 'El formato no es una expresión válida.' });
          else if (hasNestedQuantifier(a.pattern)) {
            const why = 'una repetición dentro de otra puede tardar demasiado';
            out.push({
              field: 'answer.pattern',
              message: `El formato no puede repetir un grupo que ya repite algo, como (a+)+: ${why}.`,
            });
          }
        }
      }
      const mode = a.type === 'phone' || a.type === 'email' ? a.type : 'any';
      out.push(...saveToProblems(d.saveTo, { field: 'saveTo', mode }, env));
      return out;
    },
    summary: d => short(d.text),
    fields: [
      { key: 'text', kind: 'area', label: 'Pregunta', max: LIMITS.text, tokens: true },
      {
        key: 'answer.type',
        kind: 'choice',
        label: 'Qué se espera',
        options: ANSWER_IDS.map(id => [id, ANSWER_TYPES[id]]),
      },
      {
        key: 'answer.min',
        kind: 'number',
        label: 'Mínimo (opcional)',
        when: { key: 'answer.type', is: ['text', 'number'] },
      },
      {
        key: 'answer.max',
        kind: 'number',
        label: 'Máximo (opcional)',
        when: { key: 'answer.type', is: ['text', 'number'] },
      },
      {
        key: 'answer.pattern',
        kind: 'text',
        label: 'Formato (expresión regular)',
        max: LIMITS.regex,
        mono: true,
        when: { key: 'answer.type', is: ['regex'] },
        help: 'Se prueba contra los primeros 200 caracteres de la respuesta.',
      },
      {
        key: 'answer.mediaKinds',
        kind: 'multi',
        label: 'Tipos de archivo (ninguno marcado: cualquiera)',
        options: MEDIA_KINDS,
        when: { key: 'answer.type', is: ['media'] },
      },
      ...saveToFields('saveTo', 'Dónde se guarda la respuesta'),
      {
        key: 'errorText',
        kind: 'area',
        label: 'Qué decir si la respuesta no sirve (opcional)',
        max: LIMITS.interactiveText,
        tokens: true,
      },
      { key: 'attempts', kind: 'number', label: 'Intentos', min: 1, max: LIMITS.attempts },
    ],
  },

  template: {
    label: 'Plantilla de WhatsApp',
    group: 'mensajes',
    icon: 'template',
    hint: 'Una plantilla aprobada por Meta: lo único que sale con la ventana de 24 horas cerrada.',
    speaks: () => true,
    waits: d => d.wait && d.buttons.length > 0,
    defaults: () => ({ waTemplateId: '', wait: false, buttons: [] }),
    // `buttons` es la instantánea de los títulos de los botones de la plantilla al elegirla. Con ella las salidas se
    // conocen sin consultar la plantilla, y la validación avisa si en Meta cambiaron.
    clean: d => ({
      waTemplateId: text(d.waTemplateId),
      wait: flag(d.wait),
      buttons: list(d.buttons, text).filter(Boolean).slice(0, LIMITS.templateButtons),
    }),
    ports: d =>
      d.wait && d.buttons.length
        ? [...d.buttons.map((b, i) => ({ id: 'opt:' + (i + 1), label: short(b, 30) })), DEFAULT_PORT, TIMEOUT_PORT]
        : [NEXT],
    refs: d => [['waTemplates', d.waTemplateId, 'waTemplateId']],
    validate(d, env) {
      const out = refProblems(
        d.waTemplateId,
        'waTemplates',
        { field: 'waTemplateId', missing: 'Elige la plantilla de WhatsApp.' },
        env,
      );
      const found = findRef(env.ctx, 'waTemplates', d.waTemplateId);
      if (found && Array.isArray(found.buttons) && JSON.stringify(found.buttons) !== JSON.stringify(d.buttons)) {
        const message = 'Los botones de la plantilla cambiaron: vuelve a elegirla para actualizar las salidas.';
        out.push({ code: 'ref', field: 'waTemplateId', message });
      }
      if (d.wait && !d.buttons.length) {
        out.push({ field: 'wait', message: 'Para esperar la respuesta, la plantilla debe tener botones.' });
      }
      return out;
    },
    summary: (d, ctx) =>
      refName(ctx, 'waTemplates', d.waTemplateId) || (d.waTemplateId ? 'Plantilla elegida' : 'Sin plantilla'),
    fields: [
      {
        key: 'waTemplateId',
        kind: 'ref',
        label: 'Plantilla',
        source: 'waTemplates',
        onPick: item => ({ buttons: Array.isArray(item?.buttons) ? item.buttons : [] }),
      },
      { key: 'wait', kind: 'check', label: 'Esperar a que pulse un botón de la plantilla' },
    ],
  },

  condition: {
    label: 'Condición',
    group: 'logica',
    icon: 'branch',
    hint: 'Sigue por el primer caso que se cumple; si ninguno, por «Si no».',
    defaults: () => ({
      cases: [
        {
          id: 'c1',
          label: '',
          when: { mode: 'all', groups: [{ mode: 'all', items: [{ f: 'attr', key: '', op: 'eq', value: '' }] }] },
        },
      ],
    }),
    clean: d => ({
      cases: uniqueIds(
        list(d.cases, c => ({ id: text(c?.id), label: text(c?.label), when: cleanWhen(c?.when) })),
        'c',
      ),
    }),
    ports: d => [
      ...d.cases.map((c, i) => ({ id: 'case:' + c.id, label: short(c.label, 30) || `Caso ${i + 1}` })),
      { id: 'else', label: 'Si no' },
    ],
    refs: d =>
      d.cases.flatMap((c, ci) =>
        c.when.groups.flatMap((g, gi) =>
          g.items.flatMap((item, ii) => {
            const at = `cases.${ci}.when.groups.${gi}.items.${ii}`;
            if (item.f === 'tag') return [['tags', item.tagId, `${at}.tagId`]];
            if (item.f === 'course') return item.in.map((id, k) => ['courses', id, `${at}.in.${k}`]);
            if (item.f === 'attr' && item.key && !item.key.startsWith('var.'))
              return [['attributes', item.key, `${at}.key`]];
            return [];
          }),
        ),
      ),
    reads: d =>
      d.cases.flatMap(c =>
        c.when.groups.flatMap(g =>
          g.items.filter(i => i.f === 'attr' && i.key.startsWith('var.')).map(i => i.key.slice(4)),
        ),
      ),
    validate(d, env) {
      const out = [];
      if (!d.cases.length) out.push({ field: 'cases', message: 'Agrega al menos un caso.' });
      if (d.cases.length > LIMITS.cases)
        out.push({ field: 'cases', message: `Una condición admite hasta ${LIMITS.cases} casos.` });
      d.cases.forEach((c, i) => {
        const name = c.label.trim() ? `el caso ${quote(short(c.label, 30))}` : `el caso ${i + 1}`;
        if (!c.label.trim())
          out.push({ field: `cases.${i}.label`, message: `Ponle nombre al caso ${i + 1}: es el texto de su salida.` });
        if (c.label.length > LIMITS.caseLabel) {
          out.push({
            field: `cases.${i}.label`,
            message: `El nombre de ${name} admite hasta ${LIMITS.caseLabel} caracteres.`,
          });
        }
        out.push(...whenProblems(c.when, `cases.${i}.when`, name, env));
      });
      return out;
    },
    summary: d =>
      short(
        d.cases
          .map((c, i) => c.label.trim() || `Caso ${i + 1}`)
          .concat('Si no')
          .join(' · '),
      ),
    fields: [
      {
        key: 'cases',
        kind: 'list',
        label: 'Casos (se toma el primero que se cumple)',
        item: 'Caso',
        add: 'Agregar caso',
        min: 1,
        max: LIMITS.cases,
        make: () => ({
          id: '',
          label: '',
          when: { mode: 'all', groups: [{ mode: 'all', items: [{ f: 'attr', key: '', op: 'eq', value: '' }] }] },
        }),
        fields: [
          { key: 'label', kind: 'text', label: 'Nombre del caso', max: LIMITS.caseLabel },
          {
            key: 'when.mode',
            kind: 'choice',
            label: 'Se cumple si',
            options: [
              ['all', 'se cumplen todos los grupos'],
              ['any', 'se cumple algún grupo'],
            ],
          },
          {
            key: 'when.groups',
            kind: 'list',
            label: 'Grupos de condiciones',
            item: 'Grupo',
            add: 'Agregar grupo',
            min: 1,
            max: LIMITS.conditionGroups,
            make: () => ({ mode: 'all', items: [{ f: 'attr', key: '', op: 'eq', value: '' }] }),
            fields: [
              {
                key: 'mode',
                kind: 'choice',
                label: 'El grupo se cumple si',
                options: [
                  ['all', 'se cumplen todas sus condiciones'],
                  ['any', 'se cumple alguna'],
                ],
              },
              {
                key: 'items',
                kind: 'list',
                label: 'Condiciones',
                item: 'Condición',
                add: 'Agregar condición',
                min: 1,
                max: LIMITS.conditionItems,
                make: () => ({ f: 'attr', key: '', op: 'eq', value: '' }),
                fields: [
                  { key: 'f', kind: 'choice', label: 'Se compara', options: CONDITION_FIELDS },
                  {
                    key: 'key',
                    kind: 'ref',
                    label: 'Dato o variable',
                    source: 'attributesAndVariables',
                    when: { key: 'f', is: ['attr'] },
                  },
                  {
                    key: 'op',
                    kind: 'choice',
                    label: 'Comparación',
                    options: CONDITION_OPS,
                    when: { key: 'f', is: ['attr'] },
                  },
                  {
                    key: 'value',
                    kind: 'text',
                    label: 'Valor',
                    max: LIMITS.value,
                    when: { key: 'f', is: ['attr'] },
                    unless: { key: 'op', is: OPS_WITHOUT_VALUE },
                  },
                  {
                    key: 'op',
                    kind: 'choice',
                    label: 'La persona',
                    options: [
                      ['has', 'tiene la etiqueta'],
                      ['has_not', 'no tiene la etiqueta'],
                    ],
                    when: { key: 'f', is: ['tag'] },
                  },
                  { key: 'tagId', kind: 'ref', label: 'Etiqueta', source: 'tags', when: { key: 'f', is: ['tag'] } },
                  {
                    key: 'is',
                    kind: 'choice',
                    label: 'La marca está',
                    options: [
                      ['open', 'en horario de atención'],
                      ['closed', 'fuera de horario'],
                    ],
                    when: { key: 'f', is: ['hours'] },
                  },
                  { key: 'days', kind: 'multi', label: 'Días', options: WEEKDAYS, when: { key: 'f', is: ['clock'] } },
                  { key: 'from', kind: 'time', label: 'Desde', when: { key: 'f', is: ['clock'] } },
                  { key: 'to', kind: 'time', label: 'Hasta', when: { key: 'f', is: ['clock'] } },
                  { key: 'in', kind: 'refs', label: 'Cursos', source: 'courses', when: { key: 'f', is: ['course'] } },
                  {
                    key: 'in',
                    kind: 'multi',
                    label: 'Canales',
                    options: CHANNELS,
                    when: { key: 'f', is: ['channel'] },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },

  delay: {
    label: 'Espera',
    group: 'logica',
    icon: 'clock',
    hint: 'Una pausa corta entre mensajes.',
    defaults: () => ({ seconds: 3 }),
    clean: d => ({ seconds: int(d.seconds, 3) }),
    ports: () => [NEXT],
    validate: d =>
      d.seconds < 1 || d.seconds > LIMITS.delaySeconds
        ? [{ field: 'seconds', message: `La espera va de 1 a ${LIMITS.delaySeconds} segundos.` }]
        : [],
    summary: d => (d.seconds === 1 ? '1 segundo' : `${d.seconds} segundos`),
    fields: [{ key: 'seconds', kind: 'number', label: 'Segundos', min: 1, max: LIMITS.delaySeconds }],
  },

  set_attribute: {
    label: 'Guardar dato',
    group: 'contacto',
    icon: 'save',
    hint: 'Escribe un dato del contacto.',
    defaults: () => ({ key: '', value: { from: 'fixed', text: '' } }),
    clean(d) {
      const from = pick(d.value?.from, ['fixed', 'var', 'last_message'], 'fixed');
      const value =
        from === 'fixed'
          ? { from, text: text(d.value?.text) }
          : from === 'var'
            ? { from, name: text(d.value?.name) }
            : { from };
      return { key: text(d.key), value };
    },
    ports: () => [NEXT],
    refs: d => [['attributes', d.key, 'key']],
    reads: d => (d.value.from === 'var' && d.value.name ? [d.value.name] : []),
    validate(d, env) {
      const out = attributeProblems(d.key, { field: 'key', mode: 'any' }, env);
      if (d.value.from === 'fixed') {
        out.push(
          ...textProblems(
            d.value.text,
            { field: 'value.text', what: 'el valor que se guarda', max: LIMITS.value },
            env,
          ),
        );
      } else if (d.value.from === 'var') {
        if (!d.value.name) out.push({ field: 'value.name', message: 'Elige la variable de la que sale el valor.' });
        else if (!env.vars.has(d.value.name)) {
          out.push({
            field: 'value.name',
            message: `La variable ${quote(d.value.name)} no la guarda ningún paso ni está declarada.`,
          });
        }
      }
      return out;
    },
    summary(d, ctx) {
      if (!d.key) return 'Sin dato elegido';
      const name = refName(ctx, 'attributes', d.key) || SYSTEM_ATTRIBUTES[d.key]?.label || d.key;
      const value =
        d.value.from === 'fixed'
          ? short(d.value.text, 30)
          : d.value.from === 'var'
            ? `variable ${d.value.name}`
            : 'el último mensaje';
      return `${name} = ${value}`;
    },
    fields: [
      { key: 'key', kind: 'ref', label: 'Dato del contacto', source: 'attributes' },
      {
        key: 'value.from',
        kind: 'choice',
        label: 'Valor',
        options: [
          ['fixed', 'Un valor fijo'],
          ['var', 'Una variable del recorrido'],
          ['last_message', 'El último mensaje de la persona'],
        ],
      },
      {
        key: 'value.text',
        kind: 'text',
        label: 'Valor fijo',
        max: LIMITS.value,
        when: { key: 'value.from', is: ['fixed'] },
      },
      {
        key: 'value.name',
        kind: 'text',
        label: 'Variable',
        max: 30,
        mono: true,
        suggest: 'variables',
        when: { key: 'value.from', is: ['var'] },
      },
    ],
  },

  tags: {
    label: 'Etiquetas',
    group: 'contacto',
    icon: 'tag',
    hint: 'Pone o quita etiquetas del contacto.',
    defaults: () => ({ add: [], remove: [] }),
    clean: d => ({ add: ids(d.add), remove: ids(d.remove) }),
    ports: () => [NEXT],
    refs: d => [
      ...d.add.map((id, i) => ['tags', id, `add.${i}`]),
      ...d.remove.map((id, i) => ['tags', id, `remove.${i}`]),
    ],
    validate(d, env) {
      const out = [];
      if (!d.add.length && !d.remove.length)
        out.push({ field: 'add', message: 'Elige al menos una etiqueta para poner o quitar.' });
      if (d.add.some(id => d.remove.includes(id)))
        out.push({ field: 'remove', message: 'Una misma etiqueta no se puede poner y quitar a la vez.' });
      if (d.add.length > LIMITS.tags)
        out.push({ field: 'add', message: `Un contacto admite hasta ${LIMITS.tags} etiquetas.` });
      for (const id of d.add) out.push(...refProblems(id, 'tags', { field: 'add' }, env));
      for (const id of d.remove) out.push(...refProblems(id, 'tags', { field: 'remove' }, env));
      return out;
    },
    summary(d, ctx) {
      const names = idsList => idsList.map(id => refName(ctx, 'tags', id) || 'etiqueta').join(', ');
      const parts = [];
      if (d.add.length) parts.push('Pone: ' + names(d.add));
      if (d.remove.length) parts.push('Quita: ' + names(d.remove));
      return short(parts.join(' · ')) || 'Sin etiquetas elegidas';
    },
    fields: [
      { key: 'add', kind: 'refs', label: 'Poner', source: 'tags' },
      { key: 'remove', kind: 'refs', label: 'Quitar', source: 'tags' },
    ],
  },

  consent: {
    label: 'Suscribir · Dar de baja',
    group: 'contacto',
    icon: 'bell',
    hint: 'Registra si la persona quiere recibir novedades.',
    defaults: () => ({ action: 'subscribe' }),
    clean: d => ({ action: pick(d.action, ['subscribe', 'unsubscribe'], 'subscribe') }),
    ports: () => [NEXT],
    summary: d => (d.action === 'subscribe' ? 'Suscribe a novedades' : 'Da de baja de novedades'),
    fields: [
      {
        key: 'action',
        kind: 'choice',
        label: 'Qué hace',
        options: [
          ['subscribe', 'Suscribir a novedades'],
          ['unsubscribe', 'Dar de baja'],
        ],
        help: 'Suscribir no revierte una baja que la persona ya pidió.',
      },
    ],
  },

  handoff: {
    label: 'Pasar con una persona',
    group: 'atencion',
    icon: 'person',
    hint: 'Termina el recorrido y deja la conversación en manos del equipo.',
    speaks: d => d.text.trim() !== '',
    defaults: () => ({ text: '', to: 'queue' }),
    clean(d) {
      const to = pick(d.to, ['queue', 'user', 'last'], 'queue');
      return to === 'user' ? { text: text(d.text), to, userId: text(d.userId) } : { text: text(d.text), to };
    },
    ports: () => [],
    refs: d => (d.to === 'user' ? [['users', d.userId, 'userId']] : []),
    validate(d, env) {
      const out = textProblems(
        d.text,
        { field: 'text', what: 'el mensaje de despedida', max: LIMITS.text, required: false },
        env,
      );
      if (d.to === 'user')
        out.push(...refProblems(d.userId, 'users', { field: 'userId', missing: 'Elige a quién se le asigna.' }, env));
      return out;
    },
    summary(d, ctx) {
      const who =
        d.to === 'queue'
          ? 'A la cola del equipo'
          : d.to === 'last'
            ? 'A quien atendió la última vez'
            : 'A ' + (refName(ctx, 'users', d.userId) || 'una persona');
      return d.text.trim() ? short(`${who} · ${d.text}`) : who;
    },
    fields: [
      { key: 'text', kind: 'area', label: 'Mensaje antes de pasar (opcional)', max: LIMITS.text, tokens: true },
      {
        key: 'to',
        kind: 'choice',
        label: 'A quién',
        options: [
          ['queue', 'A la cola del equipo'],
          ['last', 'A quien atendió la última vez'],
          ['user', 'A una persona concreta'],
        ],
      },
      { key: 'userId', kind: 'ref', label: 'Persona', source: 'users', when: { key: 'to', is: ['user'] } },
    ],
  },

  status: {
    label: 'Estado de la conversación',
    group: 'atencion',
    icon: 'flag',
    hint: 'Deja la conversación en espera o la da por resuelta.',
    defaults: () => ({ status: 'waiting' }),
    clean: d => ({ status: pick(d.status, ['waiting', 'resolved'], 'waiting') }),
    // «Resuelta» termina la sesión: no hay a dónde seguir.
    ports: d => (d.status === 'waiting' ? [NEXT] : []),
    summary: d => (d.status === 'waiting' ? 'La deja en espera' : 'La da por resuelta y termina'),
    fields: [
      {
        key: 'status',
        kind: 'choice',
        label: 'Estado',
        options: [
          ['waiting', 'En espera'],
          ['resolved', 'Resuelta (termina el recorrido)'],
        ],
      },
    ],
  },

  assistant: {
    label: 'Asistente',
    group: 'atencion',
    icon: 'spark',
    hint: 'Deja que el asistente conteste el último mensaje o siga él.',
    speaks: () => true,
    waits: d => d.mode === 'collect',
    defaults: () => ({ mode: 'answer' }),
    clean(d) {
      const mode = pick(d.mode, ['answer', 'handover', 'collect'], 'answer');
      return mode === 'collect' ? { mode, prompt: text(d.prompt), saveTo: cleanSaveTo(d.saveTo) } : { mode };
    },
    ports(d) {
      if (d.mode === 'answer') return [NEXT];
      if (d.mode === 'collect') {
        return [
          { id: 'success', label: 'Obtuvo el dato' },
          { id: 'failure', label: 'No lo obtuvo' },
        ];
      }
      return [];
    },
    refs: d =>
      d.mode === 'collect' && d.saveTo.kind === 'attribute' ? [['attributes', d.saveTo.key, 'saveTo.key']] : [],
    writes: d => (d.mode === 'collect' && d.saveTo.kind === 'var' && d.saveTo.name ? [d.saveTo.name] : []),
    validate(d, env) {
      if (d.mode !== 'collect') return [];
      const out = textProblems(d.prompt, { field: 'prompt', what: 'el dato que se pide', max: LIMITS.prompt }, env);
      out.push(...saveToProblems(d.saveTo, { field: 'saveTo' }, env));
      if (env.ctx.ai === false)
        out.push({ field: 'mode', message: 'Pedir un dato con IA necesita un proveedor de IA activo en la marca.' });
      return out;
    },
    summary(d) {
      if (d.mode === 'answer') return 'Contesta el último mensaje y el recorrido sigue';
      if (d.mode === 'handover') return 'El asistente sigue con la persona';
      return short('Pide: ' + d.prompt);
    },
    fields: [
      {
        key: 'mode',
        kind: 'choice',
        label: 'Qué hace',
        options: [
          ['answer', 'Contesta el último mensaje y el recorrido sigue'],
          ['handover', 'Sigue él con la persona (termina el recorrido)'],
          ['collect', 'Pide un dato en lenguaje natural y lo guarda'],
        ],
      },
      {
        key: 'prompt',
        kind: 'text',
        label: 'Qué dato pide',
        max: LIMITS.prompt,
        when: { key: 'mode', is: ['collect'] },
      },
      ...saveToFields('saveTo', 'Dónde se guarda').map(f => ({
        ...f,
        when: undefined,
        all: [{ key: 'mode', is: ['collect'] }, f.when].filter(Boolean),
      })),
    ],
  },

  goto_flow: {
    label: 'Ir a otro recorrido',
    group: 'logica',
    icon: 'jump',
    hint: 'Termina este recorrido y empieza otro.',
    defaults: () => ({ flowId: '', passVars: false }),
    clean: d => ({ flowId: text(d.flowId), passVars: flag(d.passVars) }),
    ports: () => [],
    refs: d => [['flows', d.flowId, 'flowId']],
    validate(d, env) {
      if (d.flowId && d.flowId === env.ctx.flowId) {
        const message = 'Un recorrido no puede ir a sí mismo: conecta la salida con el paso que quieras repetir.';
        return [{ field: 'flowId', message }];
      }
      return refProblems(d.flowId, 'flows', { field: 'flowId', missing: 'Elige el recorrido al que se pasa.' }, env);
    },
    summary: (d, ctx) => refName(ctx, 'flows', d.flowId) || (d.flowId ? 'Recorrido elegido' : 'Sin recorrido elegido'),
    fields: [
      { key: 'flowId', kind: 'ref', label: 'Recorrido', source: 'flows' },
      { key: 'passVars', kind: 'check', label: 'Llevar las variables a ese recorrido' },
    ],
  },

  webhook: {
    label: 'Servicio externo',
    group: 'integraciones',
    icon: 'plug',
    hint: 'Llama a una dirección https y guarda lo que responde.',
    defaults: () => ({ method: 'GET', url: '', headers: [], body: '', map: [], retry: false, sample: '' }),
    clean: d => ({
      method: pick(d.method, ['GET', 'POST'], 'GET'),
      url: text(d.url),
      // El valor de un secreto nunca vive en el grafo: sólo el nombre con el que el servidor lo guarda aparte.
      headers: list(d.headers, h =>
        text(h?.secret)
          ? { name: text(h.name), secret: text(h.secret) }
          : { name: text(h?.name), value: text(h?.value) },
      ),
      body: text(d.body),
      map: list(d.map, m => ({ path: text(m?.path), saveTo: cleanSaveTo(m?.saveTo) })),
      retry: flag(d.retry),
      sample: text(d.sample),
    }),
    ports: () => [
      { id: 'success', label: 'Respondió bien' },
      { id: 'failure', label: 'Falló' },
    ],
    refs: d =>
      d.map.flatMap((m, i) =>
        m.saveTo.kind === 'attribute' ? [['attributes', m.saveTo.key, `map.${i}.saveTo.key`]] : [],
      ),
    writes: d => d.map.filter(m => m.saveTo.kind === 'var' && m.saveTo.name).map(m => m.saveTo.name),
    validate(d, env) {
      const out = urlProblems(d.url, 'url');
      if (d.headers.length > LIMITS.webhookHeaders)
        out.push({ field: 'headers', message: `Admite hasta ${LIMITS.webhookHeaders} cabeceras.` });
      const names = new Set();
      d.headers.forEach((h, i) => {
        const at = `headers.${i}.name`;
        const lower = h.name.toLowerCase();
        if (!HEADER_NAME_RE.test(h.name))
          out.push({ field: at, message: `La cabecera ${i + 1} no tiene un nombre válido.` });
        else if (FORBIDDEN_HEADERS.includes(lower))
          out.push({ field: at, message: `La cabecera ${quote(h.name)} la pone el sistema.` });
        else if (names.has(lower)) out.push({ field: at, message: `La cabecera ${quote(h.name)} está repetida.` });
        names.add(lower);
        if (h.secret === undefined && !h.value.trim())
          out.push({ field: `headers.${i}.value`, message: `Escribe el valor de la cabecera ${i + 1}.` });
        if ((h.value || '').length > LIMITS.value)
          out.push({ field: `headers.${i}.value`, message: `El valor de la cabecera ${i + 1} es demasiado largo.` });
      });
      if (d.method === 'POST') {
        // El cuerpo suele ser JSON con números: aquí no aplica la regla de importes de los mensajes.
        if (d.body.length > LIMITS.webhookBody)
          out.push({ field: 'body', message: `El cuerpo admite hasta ${LIMITS.webhookBody} caracteres.` });
        for (const t of tokensIn(d.body)) {
          if (t.kind === 'unknown')
            out.push({ field: 'body', message: `El cuerpo usa un dato que no existe: ${t.raw}.` });
          else if (t.kind === 'var' && !env.vars.has(t.key))
            out.push({ field: 'body', message: `El cuerpo usa la variable ${quote(t.key)}, que no existe.` });
        }
      }
      if (d.map.length > LIMITS.webhookMap)
        out.push({ field: 'map', message: `Se pueden guardar hasta ${LIMITS.webhookMap} datos de la respuesta.` });
      d.map.forEach((m, i) => {
        if (!PATH_RE.test(m.path)) {
          out.push({
            field: `map.${i}.path`,
            message: `Escribe dónde está el dato ${i + 1} en la respuesta, por ejemplo cliente.pedidos[0].folio.`,
          });
        }
        out.push(...saveToProblems(m.saveTo, { field: `map.${i}.saveTo` }, env));
      });
      if (d.sample.trim()) {
        if (d.sample.length > LIMITS.webhookBody)
          out.push({ field: 'sample', message: 'La respuesta de ejemplo es demasiado larga.' });
        else {
          try {
            JSON.parse(d.sample);
          } catch {
            out.push({ field: 'sample', message: 'La respuesta de ejemplo debe ser JSON válido.' });
          }
        }
      }
      return out;
    },
    summary(d) {
      if (!d.url.trim()) return 'Sin dirección';
      return short(d.method + ' ' + d.url.replace(/^https:\/\//i, ''));
    },
    fields: [
      {
        key: 'method',
        kind: 'choice',
        label: 'Método',
        options: [
          ['GET', 'GET (consultar)'],
          ['POST', 'POST (enviar)'],
        ],
      },
      { key: 'url', kind: 'text', label: 'Dirección (https)', max: LIMITS.url, mono: true },
      {
        key: 'headers',
        kind: 'list',
        label: 'Cabeceras',
        item: 'Cabecera',
        add: 'Agregar cabecera',
        min: 0,
        max: LIMITS.webhookHeaders,
        make: () => ({ name: '', value: '' }),
        fields: [
          { key: 'name', kind: 'text', label: 'Nombre', max: 64, mono: true },
          {
            key: 'value',
            kind: 'text',
            label: 'Valor',
            max: LIMITS.value,
            mono: true,
            unless: { key: 'secret', filled: true },
          },
          {
            kind: 'info',
            text: 'El valor es un secreto guardado aparte: no se muestra.',
            when: { key: 'secret', filled: true },
          },
        ],
      },
      {
        key: 'body',
        kind: 'area',
        label: 'Cuerpo',
        max: LIMITS.webhookBody,
        mono: true,
        tokens: true,
        when: { key: 'method', is: ['POST'] },
      },
      {
        key: 'retry',
        kind: 'check',
        label: 'Se puede repetir si falla',
        when: { key: 'method', is: ['POST'] },
        help: 'Márcalo sólo si repetir la llamada no duplica nada en el servicio.',
      },
      {
        key: 'map',
        kind: 'list',
        label: 'Datos que se guardan de la respuesta',
        item: 'Dato',
        add: 'Agregar dato',
        min: 0,
        max: LIMITS.webhookMap,
        make: () => ({ path: '', saveTo: { kind: 'var', name: '' } }),
        fields: [
          { key: 'path', kind: 'text', label: 'Dónde está en la respuesta', max: 200, mono: true },
          ...saveToFields('saveTo', 'Dónde se guarda'),
        ],
      },
      {
        key: 'sample',
        kind: 'area',
        label: 'Respuesta de ejemplo (para probar)',
        max: LIMITS.webhookBody,
        mono: true,
        help: 'Al probar el recorrido no se llama al servicio: se usa esta respuesta.',
      },
    ],
  },

  end: {
    label: 'Fin',
    group: 'logica',
    icon: 'stop',
    hint: 'Termina el recorrido; el siguiente mensaje lo atiende el asistente.',
    speaks: d => d.text.trim() !== '',
    defaults: () => ({ text: '' }),
    clean: d => ({ text: text(d.text) }),
    ports: () => [],
    validate: (d, env) =>
      textProblems(d.text, { field: 'text', what: 'el mensaje de cierre', max: LIMITS.text, required: false }, env),
    summary: d => short(d.text) || 'Termina el recorrido',
    fields: [{ key: 'text', kind: 'area', label: 'Mensaje de cierre (opcional)', max: LIMITS.text, tokens: true }],
  },

  course_card: {
    label: 'Ficha del curso',
    group: 'catalogo',
    icon: 'card',
    hint: 'La ficha vigente del curso de la conversación: imagen, inicio, docente, modalidad y precio.',
    speaks: () => true,
    defaults: () => ({ text: '', flyer: true }),
    clean: d => ({ text: text(d.text), flyer: flag(d.flyer, true) }),
    ports: () => [NEXT, UNAVAILABLE_PORT],
    validate: (d, env) =>
      textProblems(d.text, { field: 'text', what: 'el texto de la ficha', max: LIMITS.caption, required: false }, env),
    summary: d => short(d.text) || (d.flyer ? 'Imagen y datos vigentes del curso' : 'Datos vigentes del curso'),
    fields: [
      { key: 'flyer', kind: 'check', label: 'Enviar la imagen (flyer) vigente' },
      {
        key: 'text',
        kind: 'area',
        label: 'Texto propio (opcional)',
        max: LIMITS.caption,
        tokens: true,
        help: 'Vacío: se envían los datos vigentes del catálogo (inicio, docente, modalidad y precio).',
      },
    ],
  },

  price: {
    label: 'Precio y promoción',
    group: 'catalogo',
    icon: 'price',
    hint: 'El precio vigente del curso, con su promoción si la hay.',
    speaks: () => true,
    defaults: () => ({ body: 'data', templateId: '' }),
    clean: d => ({ body: pick(d.body, ['data', 'full'], 'data'), templateId: text(d.templateId) }),
    ports: () => [NEXT, UNAVAILABLE_PORT],
    refs: d => [['materials', d.templateId, 'templateId']],
    validate: (d, env) => refProblems(d.templateId, 'materials', { field: 'templateId' }, env),
    summary: (d, ctx) =>
      d.templateId
        ? 'Material: ' + (refName(ctx, 'materials', d.templateId) || 'elegido')
        : 'Precio vigente del catálogo',
    fields: [
      {
        key: 'templateId',
        kind: 'ref',
        label: 'Material de precio (opcional)',
        source: 'materials',
        empty: 'Usar el texto del asistente',
        help: 'El importe siempre sale del catálogo, también dentro del material.',
      },
      {
        key: 'body',
        kind: 'choice',
        label: 'Qué envía',
        options: BODY_OPTIONS,
        unless: { key: 'templateId', filled: true },
      },
    ],
  },

  syllabus: {
    label: 'Temario',
    group: 'catalogo',
    icon: 'book',
    hint: 'El temario del curso de la conversación.',
    speaks: () => true,
    defaults: () => ({ body: 'data' }),
    clean: d => ({ body: pick(d.body, ['data', 'full'], 'data') }),
    ports: () => [NEXT],
    summary: () => 'Temario del curso',
    fields: [{ key: 'body', kind: 'choice', label: 'Qué envía', options: BODY_OPTIONS }],
  },

  schedule: {
    label: 'Fechas y cupo',
    group: 'catalogo',
    icon: 'calendar',
    hint: 'Inicio, horario, docente y lugares disponibles.',
    speaks: () => true,
    defaults: () => ({ seats: true, sessions: false }),
    clean: d => ({ seats: flag(d.seats, true), sessions: flag(d.sessions) }),
    ports: () => [NEXT, UNAVAILABLE_PORT],
    summary: d => ['Fechas', d.seats ? 'cupo' : '', d.sessions ? 'sesiones' : ''].filter(Boolean).join(' · '),
    fields: [
      { key: 'seats', kind: 'check', label: 'Decir cuántos lugares quedan' },
      { key: 'sessions', kind: 'check', label: 'Listar las sesiones de la apertura' },
    ],
  },

  enroll: {
    label: 'Inscripción con enlace de pago',
    group: 'catalogo',
    icon: 'cart',
    hint: 'Crea el pedido y manda el enlace de pago. Nunca confirma un pago.',
    speaks: () => true,
    defaults: () => ({}),
    clean: () => ({}),
    ports: () => [
      { id: 'order', label: 'Con enlace de pago' },
      { id: 'manual', label: 'Pago manual' },
      UNAVAILABLE_PORT,
    ],
    summary: () => 'Pedido y enlace de pago del curso',
    fields: [
      {
        kind: 'info',
        text: 'Si la venta está activa crea el pedido (o recuerda el vigente) y sale por «Con enlace de pago». Con la venta apagada sale por «Pago manual».',
      },
    ],
  },

  choose_course: {
    label: '¿Qué curso te interesa?',
    group: 'catalogo',
    icon: 'compass',
    hint: 'Pregunta el curso si la conversación todavía no lo tiene.',
    speaks: () => true,
    waits: () => true,
    defaults: () => ({ skipIfKnown: true, useMessage: true, attempts: 2 }),
    clean: d => ({
      skipIfKnown: flag(d.skipIfKnown, true),
      useMessage: flag(d.useMessage, true),
      attempts: int(d.attempts, 2),
    }),
    ports: () => [{ id: 'next', label: 'Curso elegido' }, { id: 'none', label: 'Ninguno' }, TIMEOUT_PORT],
    validate: d =>
      d.attempts < 1 || d.attempts > LIMITS.attempts
        ? [{ field: 'attempts', message: `Los intentos van de 1 a ${LIMITS.attempts}.` }]
        : [],
    summary: d => (d.skipIfKnown ? 'Sólo pregunta si no se sabe el curso' : 'Pregunta siempre el curso'),
    fields: [
      { key: 'skipIfKnown', kind: 'check', label: 'Pasar de largo si la conversación ya tiene curso' },
      { key: 'useMessage', kind: 'check', label: 'Tomar el curso si el mensaje que inició el recorrido lo nombra' },
      { key: 'attempts', kind: 'number', label: 'Intentos', min: 1, max: LIMITS.attempts },
    ],
  },

  note: {
    label: 'Nota',
    group: 'logica',
    icon: 'note',
    hint: 'Un comentario para el equipo. No se ejecuta ni se conecta.',
    defaults: () => ({ text: '' }),
    clean: d => ({ text: text(d.text) }),
    ports: () => [],
    validate: d =>
      d.text.length > LIMITS.note
        ? [{ field: 'text', message: `Una nota admite hasta ${LIMITS.note} caracteres.` }]
        : [],
    summary: d => short(d.text, 160) || 'Nota vacía',
    fields: [{ key: 'text', kind: 'area', label: 'Nota', max: LIMITS.note, rows: 5 }],
  },
};

// Lo que todos los tipos comparten si no lo declaran.
const TYPE_DEFAULTS = {
  palette: true,
  speaks: () => false,
  waits: () => false,
  validate: () => [],
  refs: () => [],
  writes: () => [],
  reads: () => [],
};
for (const [type, def] of Object.entries(TYPES)) {
  // `clean` recibe lo que venga del navegador o de un archivo importado: nunca debe fallar por la forma de los ajustes.
  const clean = data => def.clean(isObj(data) ? data : {});
  TYPES[type] = Object.freeze({ type, ...TYPE_DEFAULTS, ...def, clean });
}

export const NODE_TYPES = Object.freeze(TYPES);
export const typeOf = type => (Object.hasOwn(TYPES, type) ? TYPES[type] : null);

// Tipos de la paleta, por grupo y en el orden en que se ofrecen.
export const PALETTE = Object.freeze(
  GROUPS.map(group => ({
    ...group,
    types: Object.values(TYPES)
      .filter(t => t.palette && t.group === group.id)
      .map(t => t.type),
  })),
);

// Salidas de un paso: [{id, label, optional?}]. Un tipo desconocido no tiene ninguna.
export function portsOf(node) {
  const def = typeOf(node?.type);
  return def ? def.ports(node.data) : [];
}

// ¿Puede llegarle una conexión? Al Inicio no llega nada y una nota no se ejecuta.
export const acceptsInput = node => Boolean(typeOf(node?.type)) && node.type !== 'start' && node.type !== 'note';

export function createNode(type, { id, x = 0, y = 0, title = '', data } = {}) {
  const def = typeOf(type);
  if (!def) throw new TypeError('Tipo de paso desconocido: ' + type);
  const node = { id, type };
  if (title) node.title = title;
  node.x = Math.round(x);
  node.y = Math.round(y);
  node.data = def.clean(data ? clone(data) : def.defaults());
  return node;
}

// Tipos cuyo resumen es el texto que escribió la persona que arma el recorrido: ese texto los nombra mejor que su tipo.
const NAMED_BY_TEXT = ['message', 'buttons', 'list', 'question'];

// Nombre con el que se menciona un paso en avisos, listas y lectores de pantalla: su título si lo tiene; si no, su
// texto (en los pasos que escriben) o el nombre de su tipo.
export function nodeName(node, ctx = {}) {
  const def = typeOf(node?.type);
  if (typeof node?.title === 'string' && node.title.trim()) return short(node.title, LIMITS.title);
  if (!def) return 'Paso desconocido';
  const own = NAMED_BY_TEXT.includes(node.type) ? def.summary(def.clean(node.data), ctx) : '';
  return own || def.label;
}

export function nodeSummary(node, ctx = {}) {
  const def = typeOf(node?.type);
  return def ? def.summary(node.data, ctx) : 'Este tipo de paso no existe en esta versión.';
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. Forma canónica y reparación
// ---------------------------------------------------------------------------------------------------------------------

export const VARIABLE_TYPES = Object.freeze([
  ['text', 'Texto'],
  ['number', 'Número'],
  ['email', 'Correo'],
  ['phone', 'Teléfono'],
  ['date', 'Fecha'],
  ['boolean', 'Sí o no'],
]);
const VARIABLE_TYPE_IDS = VARIABLE_TYPES.map(t => t[0]);

const coord = v =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(-100_000, Math.min(100_000, Math.round(v))) : 0;

export function emptyGraph() {
  return {
    v: GRAPH_VERSION,
    start: 'n1',
    nodes: [createNode('start', { id: 'n1', x: 40, y: 160 })],
    edges: [],
    variables: [],
  };
}

// Devuelve el grafo en su forma canónica y la lista de lo que hubo que corregir para que sea estructuralmente válido:
// ids únicos, un solo Inicio y ninguna conexión colgando. No juzga el contenido (eso es validateGraph): un texto vacío o
// un botón de más sigue ahí para que la persona lo vea y lo arregle. El editor abre cualquier cosa con esta función, y
// a partir de ahí cada edición conserva la estructura.
export function repairGraph(input) {
  const repairs = [];
  const src = isObj(input) ? input : {};
  const taken = new Set();
  const renamed = new Map();
  const nodes = [];

  for (const raw of Array.isArray(src.nodes) ? src.nodes : []) {
    if (!isObj(raw)) {
      repairs.push('Se descartó un paso que no tenía forma válida.');
      continue;
    }
    const original = typeof raw.id === 'string' ? raw.id : '';
    let id = original;
    if (!ID_RE.test(id) || taken.has(id)) {
      // Se reservan todos los ids válidos que vienen después, para no quitarle el suyo a otro paso.
      const reserved = new Set(taken);
      for (const other of src.nodes)
        if (isObj(other) && typeof other.id === 'string' && ID_RE.test(other.id)) reserved.add(other.id);
      id = nextId(reserved);
      // Un id inválido pero único conserva sus conexiones; de un id repetido, las conexiones son del primero.
      if (original && !taken.has(original) && !renamed.has(original)) renamed.set(original, id);
      repairs.push(`Un paso no tenía un identificador válido o estaba repetido: ahora es ${quote(id)}.`);
    }
    taken.add(id);
    const type = typeof raw.type === 'string' ? raw.type : '';
    const def = typeOf(type);
    const node = { id, type };
    const title = text(raw.title);
    if (title) node.title = title;
    node.x = coord(raw.x);
    node.y = coord(raw.y);
    const data = isObj(raw.data) ? raw.data : {};
    node.data = def ? def.clean(data) : clone(data);
    nodes.push(node);
  }

  const starts = nodes.filter(n => n.type === 'start');
  let start = starts.find(n => n.id === (renamed.get(src.start) ?? src.start)) || starts[0];
  if (!start) {
    const left = nodes.length ? Math.min(...nodes.map(n => n.x)) : 340;
    const top = nodes.length ? Math.min(...nodes.map(n => n.y)) : 160;
    start = createNode('start', { id: nextId(taken), x: left - 300, y: top });
    taken.add(start.id);
    nodes.unshift(start);
    repairs.push('Se agregó el paso de Inicio que faltaba.');
  }
  const extra = new Set(starts.filter(n => n !== start).map(n => n.id));
  if (extra.size) repairs.push('Había más de un Inicio: se conservó uno.');
  const kept = nodes.filter(n => !extra.has(n.id));

  const byId = new Map(kept.map(n => [n.id, n]));
  const used = new Set();
  const edges = [];
  let dropped = 0;
  for (const raw of Array.isArray(src.edges) ? src.edges : []) {
    const from = byId.get(renamed.get(raw?.from) ?? raw?.from);
    const to = byId.get(renamed.get(raw?.to) ?? raw?.to);
    const port = typeof raw?.port === 'string' ? raw.port : '';
    const key = from ? from.id + '\n' + port : '';
    const valid = from && to && acceptsInput(to) && !used.has(key) && portsOf(from).some(p => p.id === port);
    if (!valid) {
      dropped += 1;
      continue;
    }
    used.add(key);
    edges.push({ from: from.id, port, to: to.id });
  }
  if (dropped) {
    repairs.push(
      dropped === 1
        ? 'Se quitó una conexión que no llevaba a ningún lado.'
        : `Se quitaron ${dropped} conexiones que no llevaban a ningún lado.`,
    );
  }

  const names = new Set();
  const variables = [];
  for (const raw of Array.isArray(src.variables) ? src.variables : []) {
    const name = text(raw?.name);
    if (!VARIABLE_RE.test(name) || names.has(name)) {
      repairs.push('Se descartó una variable sin un nombre válido o repetida.');
      continue;
    }
    names.add(name);
    variables.push({ name, label: text(raw.label), type: pick(raw.type, VARIABLE_TYPE_IDS, 'text') });
  }

  return { graph: { v: GRAPH_VERSION, start: start.id, nodes: kept, edges, variables }, repairs };
}

export const normalizeGraph = input => repairGraph(input).graph;

// Comprueba los invariantes de estructura que el editor mantiene después de cada edición. Devuelve la lista de los
// que no se cumplen (vacía si todo está bien). Es más estricta que validateGraph en la forma y no mira el contenido.
export function checkStructure(graph) {
  const out = [];
  if (!isObj(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.variables)) {
    return ['El grafo no tiene nodos, aristas y variables.'];
  }
  if (graph.v !== GRAPH_VERSION) out.push('Versión distinta de ' + GRAPH_VERSION + '.');
  const byId = new Map();
  for (const n of graph.nodes) {
    if (!isObj(n) || !matches(ID_RE, n.id)) out.push('Id inválido: ' + JSON.stringify(n?.id));
    else if (byId.has(n.id)) out.push('Id repetido: ' + n.id);
    else byId.set(n.id, n);
    if (!Number.isInteger(n?.x) || !Number.isInteger(n?.y)) out.push('Posición no entera en ' + n?.id);
    const def = typeOf(n?.type);
    if (def && JSON.stringify(def.clean(n.data)) !== JSON.stringify(n.data))
      out.push('Ajustes no canónicos en ' + n.id);
    if (!isObj(n?.data)) out.push('Ajustes sin forma de objeto en ' + n?.id);
  }
  const starts = graph.nodes.filter(n => n?.type === 'start');
  if (starts.length !== 1) out.push('Debe haber un Inicio y hay ' + starts.length + '.');
  else if (graph.start !== starts[0].id) out.push('`start` no apunta al Inicio.');
  const used = new Set();
  for (const e of graph.edges) {
    const from = byId.get(e?.from);
    const to = byId.get(e?.to);
    const key = e?.from + '\n' + e?.port;
    if (!from || !to) out.push('Arista con extremo inexistente: ' + JSON.stringify(e));
    else if (!portsOf(from).some(p => p.id === e.port))
      out.push('Arista en un puerto inexistente: ' + JSON.stringify(e));
    else if (!acceptsInput(to)) out.push('Arista hacia un paso que no admite entradas: ' + JSON.stringify(e));
    if (used.has(key)) out.push('Dos aristas en el mismo puerto: ' + JSON.stringify(e));
    used.add(key);
  }
  const names = new Set();
  for (const v of graph.variables) {
    if (!matches(VARIABLE_RE, v?.name) || names.has(v.name)) {
      out.push('Variable inválida o repetida: ' + JSON.stringify(v?.name));
    }
    names.add(v?.name);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. Geometría: el tamaño de las tarjetas y dónde quedan sus salidas
// ---------------------------------------------------------------------------------------------------------------------

// Las tarjetas tienen tamaño fijo según su tipo y sus salidas. Vive aquí, y no en la hoja de estilos, porque el acomodo
// automático, las conexiones y el minimapa necesitan las mismas medidas; lienzo.css las repite como variables.
export const GEOMETRY = Object.freeze({
  width: 240,
  head: 44,
  body: 40,
  noteBody: 96,
  port: 32,
  foot: 6,
  grid: 10,
  gapX: 80,
  gapY: 30,
});

export function nodeSize(node) {
  const ports = portsOf(node).length;
  const body = node.type === 'note' ? GEOMETRY.noteBody : GEOMETRY.body;
  return { w: GEOMETRY.width, h: GEOMETRY.head + body + ports * GEOMETRY.port + GEOMETRY.foot };
}

// Punto del que sale la conexión de una salida (borde derecho, a la altura de su renglón), o null si no existe.
export function portPoint(node, portId) {
  const index = portsOf(node).findIndex(p => p.id === portId);
  if (index < 0) return null;
  const body = node.type === 'note' ? GEOMETRY.noteBody : GEOMETRY.body;
  return { x: node.x + GEOMETRY.width, y: node.y + GEOMETRY.head + body + index * GEOMETRY.port + GEOMETRY.port / 2 };
}

// Punto al que llegan las conexiones (borde izquierdo, a media altura del encabezado).
export const inputPoint = node => ({ x: node.x, y: node.y + GEOMETRY.head / 2 });

// Curva de una conexión entre dos puntos, con tangentes horizontales: sale hacia la derecha y llega por la izquierda.
// Una conexión que regresa (hacia la izquierda) se abre más, para que se vea que rodea a las tarjetas.
export function edgePath(a, b) {
  const reach = Math.max(40, Math.min(240, Math.abs(b.x - a.x) / 2 + (b.x < a.x ? 60 : 0)));
  return `M ${a.x} ${a.y} C ${a.x + reach} ${a.y}, ${b.x - reach} ${b.y}, ${b.x} ${b.y}`;
}

// Punto medio de esa curva (ahí va el botón para quitar una conexión seleccionada). Como sus dos puntos de control
// están a la misma distancia de cada extremo, el centro de la curva es el centro del segmento que los une.
export const edgeMiddle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function boundsOf(nodes) {
  if (!nodes.length) return { x: 0, y: 0, w: 0, h: 0 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const n of nodes) {
    const size = nodeSize(n);
    left = Math.min(left, n.x);
    top = Math.min(top, n.y);
    right = Math.max(right, n.x + size.w);
    bottom = Math.max(bottom, n.y + size.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. Consultas del grafo
// ---------------------------------------------------------------------------------------------------------------------

// Índice de trabajo. Sólo cuenta las conexiones bien formadas (extremos y salida existentes, una por salida): así el
// resto del análisis no depende de que el grafo ya esté reparado.
function indexGraph(graph) {
  const byId = new Map();
  for (const n of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    if (isObj(n) && typeof n.id === 'string' && !byId.has(n.id)) byId.set(n.id, n);
  }
  const out = new Map();
  const into = new Map();
  for (const e of Array.isArray(graph?.edges) ? graph.edges : []) {
    const from = byId.get(e?.from);
    if (!from || !byId.has(e.to)) continue;
    if (!out.has(from.id)) out.set(from.id, new Map());
    const ports = out.get(from.id);
    if (ports.has(e.port) || !portsOf(from).some(p => p.id === e.port)) continue;
    ports.set(e.port, e.to);
    if (!into.has(e.to)) into.set(e.to, []);
    into.get(e.to).push({ from: from.id, port: e.port });
  }
  // Destinos de un paso en el orden de sus salidas: el orden del arreglo de conexiones no debe cambiar ningún resultado.
  const targets = id => {
    const ports = out.get(id);
    if (!ports) return [];
    return portsOf(byId.get(id))
      .filter(p => ports.has(p.id))
      .map(p => ({ port: p.id, to: ports.get(p.id) }));
  };
  const start =
    [...byId.values()].find(n => n.type === 'start' && n.id === graph?.start) ||
    [...byId.values()].find(n => n.type === 'start');
  return { byId, out, into, targets, start: start || null };
}

// Recorrido en profundidad desde el Inicio siguiendo las salidas en su orden. Da el orden de lectura (preorden), el
// orden topológico (postorden invertido) y las conexiones que cierran un ciclo.
function walk(index) {
  const order = [];
  const post = [];
  const back = new Set();
  const state = new Map();
  const visit = id => {
    state.set(id, 1);
    order.push(id);
    for (const t of index.targets(id)) {
      const seen = state.get(t.to);
      if (seen === 1) back.add(id + '\n' + t.port);
      else if (!seen) visit(t.to);
    }
    state.set(id, 2);
    post.push(id);
  };
  if (index.start) visit(index.start.id);
  return { order, topo: post.reverse(), back, reached: new Set(order) };
}

const byPosition = (a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Orden de lectura: desde el Inicio siguiendo las salidas; después los pasos sueltos (de arriba abajo) y al final las
// notas. Es el orden del DOM, del tabulador y del esquema.
export function readingOrder(graph) {
  const index = indexGraph(graph);
  const { order, reached } = walk(index);
  const loose = [...index.byId.values()].filter(n => !reached.has(n.id));
  const steps = loose.filter(n => n.type !== 'note').sort(byPosition);
  const notes = loose.filter(n => n.type === 'note').sort(byPosition);
  return [...order, ...steps.map(n => n.id), ...notes.map(n => n.id)];
}

export function reachable(graph) {
  return walk(indexGraph(graph)).reached;
}

// Variables de sesión que el recorrido conoce: las declaradas y las que algún paso guarda («guardar en»).
export function definedVariables(graph) {
  const vars = new Map();
  for (const v of Array.isArray(graph?.variables) ? graph.variables : []) {
    if (!matches(VARIABLE_RE, v?.name) || vars.has(v.name)) continue;
    const type = pick(v.type, VARIABLE_TYPE_IDS, 'text');
    vars.set(v.name, { name: v.name, label: text(v.label), type, declared: true, writers: [] });
  }
  for (const n of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const def = typeOf(n?.type);
    if (!def || !isObj(n.data)) continue;
    for (const name of def.writes(def.clean(n.data))) {
      if (!VARIABLE_RE.test(name)) continue;
      if (!vars.has(name)) vars.set(name, { name, label: '', type: 'text', declared: false, writers: [] });
      vars.get(name).writers.push(n.id);
    }
  }
  return vars;
}

// Todas las cadenas de los ajustes de un paso, para buscar datos {{…}} sin que cada tipo tenga que listarlas.
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (isObj(value)) for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

// Referencias a cosas de la marca: [{source, id, nodeId, path}]. `path` es la ruta del id dentro de los ajustes del paso.
export function referencesOf(graph) {
  const out = [];
  for (const n of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const def = typeOf(n?.type);
    if (!def || !isObj(n.data)) continue;
    for (const [source, id, path] of def.refs(def.clean(n.data))) if (id) out.push({ source, id, nodeId: n.id, path });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 9. Validación
// ---------------------------------------------------------------------------------------------------------------------

// Componentes fuertemente conexas (Tarjan) de un subgrafo: sirven para encontrar ciclos.
function cycles(ids, targetsOf) {
  const found = [];
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  let counter = 0;
  const visit = id => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    let self = false;
    for (const to of targetsOf(id)) {
      if (to === id) self = true;
      if (!index.has(to)) {
        visit(to);
        low.set(id, Math.min(low.get(id), low.get(to)));
      } else if (onStack.has(to)) low.set(id, Math.min(low.get(id), index.get(to)));
    }
    if (low.get(id) !== index.get(id)) return;
    const group = [];
    let top;
    do {
      top = stack.pop();
      onStack.delete(top);
      group.push(top);
    } while (top !== id);
    if (group.length > 1 || self) found.push(group);
  };
  for (const id of ids) if (!index.has(id)) visit(id);
  return found;
}

// Valida un recorrido. Devuelve {errors, warnings}; cada problema es {nodeId?, code, message, field?} en español.
// Los errores impiden publicar; las advertencias sólo se confirman. Nunca lanza: recibe lo que llegue del navegador.
//
// Códigos de error:  graph (forma o versión) · limit · start · edge · node · ref · speaks · loop · window
// Advertencias:      unreachable · port · consent · channel · delay
export function validateGraph(graph, ctx = {}) {
  const errors = [];
  const warnings = [];
  const context = isObj(ctx) ? ctx : {};
  if (!isObj(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    errors.push({ code: 'graph', message: 'El recorrido no tiene una forma válida.' });
    return { errors, warnings };
  }
  if (graph.v !== GRAPH_VERSION) {
    errors.push({
      code: 'graph',
      message: `Este recorrido es de una versión que la aplicación no entiende (${String(graph.v)}).`,
    });
    return { errors, warnings };
  }

  // Límites
  const bytes = new TextEncoder().encode(JSON.stringify(graph)).length;
  if (graph.nodes.length > LIMITS.nodes) {
    errors.push({
      code: 'limit',
      message: `El recorrido tiene ${graph.nodes.length} pasos y admite hasta ${LIMITS.nodes}.`,
    });
  }
  if (graph.edges.length > LIMITS.edges) {
    errors.push({
      code: 'limit',
      message: `El recorrido tiene ${graph.edges.length} conexiones y admite hasta ${LIMITS.edges}.`,
    });
  }
  if (bytes > LIMITS.bytes) {
    const size = `${Math.ceil(bytes / 1000)} KB`;
    errors.push({
      code: 'limit',
      message: `El recorrido pesa ${size} y admite hasta ${LIMITS.bytes / 1000} KB: acorta textos o divídelo en dos.`,
    });
  }

  // Variables declaradas
  const declared = Array.isArray(graph.variables) ? graph.variables : [];
  if (graph.variables !== undefined && !Array.isArray(graph.variables)) {
    errors.push({ code: 'graph', message: 'La lista de variables del recorrido no tiene una forma válida.' });
  }
  if (declared.length > LIMITS.variables) {
    errors.push({
      code: 'limit',
      message: `El recorrido declara ${declared.length} variables y admite hasta ${LIMITS.variables}.`,
    });
  }
  const names = new Set();
  for (const v of declared) {
    const name = typeof v?.name === 'string' ? v.name : '';
    if (!VARIABLE_RE.test(name))
      errors.push({ code: 'graph', message: `La variable ${quote(name)} no tiene un nombre válido.` });
    else if (names.has(name))
      errors.push({ code: 'graph', message: `La variable ${quote(name)} está declarada dos veces.` });
    names.add(name);
  }

  // Pasos: identificador, tipo, título, posición y ajustes
  const index = indexGraph(graph);
  const vars = new Set(definedVariables(graph).keys());
  const seen = new Set();
  const cleaned = new Map();
  for (const n of graph.nodes) {
    if (!isObj(n) || typeof n.id !== 'string' || !ID_RE.test(n.id)) {
      errors.push({ code: 'node', message: 'Hay un paso sin un identificador válido.' });
      continue;
    }
    if (seen.has(n.id)) {
      errors.push({ code: 'node', nodeId: n.id, message: `Hay dos pasos con el mismo identificador (${n.id}).` });
      continue;
    }
    seen.add(n.id);
    const def = typeOf(n.type);
    if (!def) {
      errors.push({
        code: 'node',
        nodeId: n.id,
        message: 'Este tipo de paso no existe en esta versión: quítalo o sustitúyelo.',
      });
      continue;
    }
    if (n.title !== undefined && (typeof n.title !== 'string' || n.title.length > LIMITS.title)) {
      errors.push({
        code: 'node',
        nodeId: n.id,
        field: 'title',
        message: `El título del paso admite hasta ${LIMITS.title} caracteres.`,
      });
    }
    if (!Number.isInteger(n.x) || !Number.isInteger(n.y)) {
      errors.push({ code: 'node', nodeId: n.id, message: 'La posición del paso en el lienzo no es válida.' });
    }
    const data = def.clean(isObj(n.data) ? n.data : {});
    cleaned.set(n.id, data);
    for (const p of def.validate(data, { ctx: context, vars, graph, node: n })) {
      errors.push({ code: p.code || 'node', nodeId: n.id, field: p.field, message: p.message });
    }
  }
  const collectors = graph.nodes.filter(n => n?.type === 'assistant' && n.data?.mode === 'collect');
  for (const n of collectors.slice(LIMITS.collectPerFlow)) {
    const message = `Un recorrido admite hasta ${LIMITS.collectPerFlow} pasos que piden un dato con IA.`;
    errors.push({ code: 'limit', nodeId: n.id, message });
  }

  // Inicio
  const starts = graph.nodes.filter(n => n?.type === 'start');
  if (!starts.length) errors.push({ code: 'start', message: 'Al recorrido le falta el paso de Inicio.' });
  else if (starts.length > 1)
    errors.push({ code: 'start', message: `Sólo puede haber un Inicio (hay ${starts.length}).` });
  else if (graph.start !== starts[0].id)
    errors.push({ code: 'start', nodeId: starts[0].id, message: 'El recorrido no apunta a su paso de Inicio.' });
  else if (!index.targets(starts[0].id).length) {
    errors.push({
      code: 'start',
      nodeId: starts[0].id,
      message: 'Conecta el Inicio con el primer paso del recorrido.',
    });
  }

  // Conexiones
  const usedPorts = new Set();
  for (const e of graph.edges) {
    const from = index.byId.get(e?.from);
    const to = index.byId.get(e?.to);
    if (!from) {
      errors.push({ code: 'edge', message: 'Hay una conexión que sale de un paso que ya no existe.' });
      continue;
    }
    const port = portsOf(from).find(p => p.id === e.port);
    const label = port ? quote(port.label) : quote(String(e.port));
    if (!port)
      errors.push({
        code: 'edge',
        nodeId: from.id,
        message: `Hay una conexión en una salida que este paso no tiene (${String(e.port)}).`,
      });
    else if (usedPorts.has(from.id + '\n' + e.port))
      errors.push({ code: 'edge', nodeId: from.id, message: `La salida ${label} tiene más de una conexión.` });
    usedPorts.add(from.id + '\n' + e.port);
    if (!to)
      errors.push({ code: 'edge', nodeId: from.id, message: `La salida ${label} lleva a un paso que ya no existe.` });
    else if (to.type === 'start')
      errors.push({
        code: 'edge',
        nodeId: from.id,
        message: `La salida ${label} lleva al Inicio, y al Inicio no puede llegar ninguna conexión.`,
      });
    else if (to.type === 'note')
      errors.push({
        code: 'edge',
        nodeId: from.id,
        message: `La salida ${label} lleva a una nota, y las notas no se ejecutan.`,
      });
    if (from.type === 'note')
      errors.push({
        code: 'edge',
        nodeId: from.id,
        message: 'Una nota no se conecta: sólo sirve para dejar comentarios.',
      });
  }

  // Lo que sigue necesita un Inicio único y con un identificador válido
  if (starts.length !== 1 || !index.start) return { errors, warnings };
  const { order, reached } = walk(index);
  const live = order.map(id => index.byId.get(id)).filter(n => cleaned.has(n.id));
  const def = n => typeOf(n.type);
  const data = n => cleaned.get(n.id);
  const speaks = n => cleaned.has(n.id) && def(n).speaks(data(n));
  const waits = n => cleaned.has(n.id) && def(n).waits(data(n));
  const name = n => quote(nodeName({ ...n, data: data(n) }, context));

  if (!live.some(speaks)) {
    errors.push({
      code: 'speaks',
      message: 'El recorrido no envía ningún mensaje: agrega al menos un paso que le escriba a la persona.',
    });
  }

  // Ciclos que nunca esperan a la persona: se enviarían sin fin
  const quiet = live.filter(n => !waits(n)).map(n => n.id);
  const quietSet = new Set(quiet);
  for (const group of cycles(quiet, id =>
    index
      .targets(id)
      .map(t => t.to)
      .filter(to => quietSet.has(to)),
  )) {
    const members = order.filter(id => group.includes(id)).map(id => index.byId.get(id));
    const path = members.slice(0, 4).map(name).join(' → ') + (members.length > 4 ? ' → …' : '');
    const fix = 'Pon en el camino unos botones, una lista o una pregunta';
    errors.push({
      code: 'loop',
      nodeId: members[0].id,
      message: `Hay un ciclo que nunca espera a la persona (${path}): los mensajes se enviarían sin fin. ${fix}.`,
    });
  }

  // Primeros pasos que hablan, y pasos a los que se llega sin que la persona haya respondido
  const firstSpeakers = [];
  const unanswered = new Set();
  const visit = (id, visited, stopAt) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = index.byId.get(id);
    if (stopAt(node)) return;
    for (const t of index.targets(id)) visit(t.to, visited, stopAt);
  };
  visit(index.start.id, new Set(), node => {
    if (!speaks(node)) return false;
    firstSpeakers.push(node);
    return true;
  });
  visit(index.start.id, unanswered, node => waits(node));

  if (context.settings?.proactive) {
    for (const n of firstSpeakers.filter(n => n.type !== 'template')) {
      const why =
        'puede iniciarse sin que la persona haya escrito, así que lo primero que envíe debe ser una Plantilla de WhatsApp';
      errors.push({ code: 'window', nodeId: n.id, message: `Este recorrido ${why}; aquí lo primero es ${name(n)}.` });
    }
  }

  // Advertencias
  const otherChannels =
    Array.isArray(context.settings?.channels) && context.settings.channels.some(c => c !== 'whatsapp');
  for (const n of graph.nodes) {
    if (!isObj(n) || !cleaned.has(n.id) || index.byId.get(n.id) !== n) continue;
    if (!reached.has(n.id)) {
      if (n.type !== 'note')
        warnings.push({
          code: 'unreachable',
          nodeId: n.id,
          message: 'Ningún camino llega a este paso desde el Inicio: no se ejecutará.',
        });
      continue;
    }
    const connected = index.out.get(n.id);
    for (const p of def(n).ports(data(n))) {
      if (p.optional || connected?.has(p.id) || n.type === 'start') continue;
      warnings.push({
        code: 'port',
        nodeId: n.id,
        message: `La salida ${quote(p.label)} no está conectada: si la persona llega ahí, el recorrido termina.`,
      });
    }
    if (n.type === 'consent' && data(n).action === 'subscribe' && unanswered.has(n.id)) {
      const tip = 'pon antes unos botones o una pregunta';
      warnings.push({
        code: 'consent',
        nodeId: n.id,
        message: `Se suscribe a la persona sin que haya respondido nada en este recorrido: ${tip}.`,
      });
    }
    if (otherChannels && (n.type === 'list' || n.type === 'template')) {
      const what = n.type === 'list' ? 'esta lista' : 'esta plantilla';
      warnings.push({
        code: 'channel',
        nodeId: n.id,
        message: `En Instagram y Facebook ${what} se enviará como texto numerado.`,
      });
    }
    if (n.type === 'delay' && data(n).seconds > LIMITS.delayWarnSeconds && data(n).seconds <= LIMITS.delaySeconds) {
      const why = 'la persona puede creer que nadie le contesta';
      warnings.push({
        code: 'delay',
        nodeId: n.id,
        message: `Una espera de más de ${LIMITS.delayWarnSeconds} segundos es larga: ${why}.`,
      });
    }
  }
  return { errors, warnings };
}

// Agrupa los problemas por paso: {byNode: Map(id → {errors, warnings}), general: {errors, warnings}}.
export function issuesByNode(result) {
  const byNode = new Map();
  const general = { errors: [], warnings: [] };
  for (const kind of ['errors', 'warnings']) {
    for (const issue of result[kind]) {
      if (!issue.nodeId) {
        general[kind].push(issue);
        continue;
      }
      if (!byNode.has(issue.nodeId)) byNode.set(issue.nodeId, { errors: [], warnings: [] });
      byNode.get(issue.nodeId)[kind].push(issue);
    }
  }
  return { byNode, general };
}

// ---------------------------------------------------------------------------------------------------------------------
// 10. Acomodo automático
// ---------------------------------------------------------------------------------------------------------------------

const snapTo = (v, grid) => Math.round(v / grid) * grid;

// Acomodo por capas, de izquierda a derecha. La capa de un paso es su distancia más larga desde el Inicio (sin contar
// las conexiones que cierran un ciclo), así toda conexión normal avanza hacia la derecha. Dentro de una capa los pasos
// se ordenan por el baricentro de las salidas que llegan a ellos y cada uno se alinea con esa altura si hay sitio: la
// primera salida de un paso sigue en línea recta y las demás cuelgan debajo. Los pasos sueltos y las notas quedan en
// una fila aparte, abajo.
//
// Es determinista y no depende del orden de los arreglos `nodes` y `edges`: sólo de los ids, los tipos y las salidas.
export function layout(graph, { x = 40, y = 40 } = {}) {
  const index = indexGraph(graph);
  const { order, topo, back, reached } = walk(index);
  const positions = {};
  const rank = new Map(order.map((id, i) => [id, i]));

  const layer = new Map(topo.map(id => [id, 0]));
  for (const id of topo) {
    for (const t of index.targets(id)) {
      if (!back.has(id + '\n' + t.port)) layer.set(t.to, Math.max(layer.get(t.to), layer.get(id) + 1));
    }
  }
  const columns = [];
  for (const id of order) {
    const at = layer.get(id);
    if (!columns[at]) columns[at] = [];
    columns[at].push(id);
  }

  const step = GEOMETRY.width + GEOMETRY.gapX;
  let bottom = y;
  columns.forEach((column, at) => {
    const wanted = new Map();
    for (const id of column) {
      const heights = [];
      for (const source of index.into.get(id) || []) {
        const from = index.byId.get(source.from);
        if (back.has(source.from + '\n' + source.port) || !positions[from.id]) continue;
        // La primera salida deja a su destino a la misma altura (una cadena queda en un renglón); cada salida
        // siguiente lo quiere un renglón más abajo, y eso basta para ordenar las ramas como están en la tarjeta.
        const row = portsOf(from).findIndex(p => p.id === source.port);
        heights.push(positions[from.id].y + row * GEOMETRY.port);
      }
      wanted.set(id, heights.length ? heights.reduce((a, b) => a + b, 0) / heights.length : y);
    }
    column.sort((a, b) => wanted.get(a) - wanted.get(b) || rank.get(a) - rank.get(b));
    let floor = y;
    for (const id of column) {
      const top = snapTo(Math.max(wanted.get(id), floor), GEOMETRY.grid);
      positions[id] = { x: x + at * step, y: top };
      floor = top + nodeSize(index.byId.get(id)).h + GEOMETRY.gapY;
      bottom = Math.max(bottom, floor);
    }
  });

  const loose = [...index.byId.values()].filter(n => !reached.has(n.id));
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const parked = [
    ...loose.filter(n => n.type !== 'note').sort(byId),
    ...loose.filter(n => n.type === 'note').sort(byId),
  ];
  const perRow = 4;
  let rowTop = snapTo(bottom + (order.length ? GEOMETRY.gapY : 0), GEOMETRY.grid);
  for (let i = 0; i < parked.length; i += perRow) {
    const row = parked.slice(i, i + perRow);
    row.forEach((n, k) => {
      positions[n.id] = { x: x + k * step, y: rowTop };
    });
    rowTop = snapTo(rowTop + Math.max(...row.map(n => nodeSize(n).h)) + GEOMETRY.gapY, GEOMETRY.grid);
  }

  const placed = [...index.byId.values()].map(n => ({ ...n, ...positions[n.id] }));
  const box = boundsOf(placed);
  return { positions, width: box.w, height: box.h };
}

// Devuelve una copia del grafo con las posiciones dadas (las que falten se quedan como están).
export function applyLayout(graph, positions) {
  return {
    ...graph,
    nodes: graph.nodes.map(n => (positions[n.id] ? { ...n, x: positions[n.id].x, y: positions[n.id].y } : n)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 11. Resumen y descripciones
// ---------------------------------------------------------------------------------------------------------------------

// Resumen para las listas de recorridos: cuántos pasos tiene, dónde espera a la persona y qué datos usa.
export function summarize(graph, ctx = {}) {
  const g = normalizeGraph(graph);
  const order = readingOrder(g);
  const reached = reachable(g);
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const steps = g.nodes.filter(n => n.type !== 'note');
  const brief = n => ({ id: n.id, type: n.type, label: nodeName(n, ctx) });
  const live = order.map(id => byId.get(id)).filter(n => reached.has(n.id) && typeOf(n.type));
  const byType = {};
  const byGroup = {};
  for (const n of steps) {
    byType[n.type] = (byType[n.type] || 0) + 1;
    const group = typeOf(n.type)?.group;
    if (group) byGroup[group] = (byGroup[group] || 0) + 1;
  }
  const vars = definedVariables(g);
  const usedVars = new Set();
  const tokens = new Set();
  for (const n of g.nodes) {
    const def = typeOf(n.type);
    if (!def || n.type === 'note') continue;
    for (const name of def.reads(n.data)) usedVars.add(name);
    for (const value of stringsIn(n.data)) {
      for (const t of tokensIn(value)) {
        if (t.kind === 'var') usedVars.add(t.key);
        else if (t.kind !== 'unknown') tokens.add(t.name);
      }
    }
  }
  const references = {};
  for (const r of referencesOf(g)) {
    if (!references[r.source]) references[r.source] = [];
    if (!references[r.source].includes(r.id)) references[r.source].push(r.id);
  }
  const slots = [
    ...new Set(
      g.nodes.flatMap(n =>
        n.type === 'message' ? n.data.parts.filter(p => p.kind === 'slot' && p.slot).map(p => p.slot) : [],
      ),
    ),
  ];
  const firstSpeaker = live.find(n => typeOf(n.type).speaks(n.data));
  return {
    version: g.v,
    nodes: steps.length,
    notes: g.nodes.length - steps.length,
    edges: g.edges.length,
    byType,
    byGroup,
    // Puntos de entrada: los pasos donde el recorrido espera a la persona, en orden de lectura. El primero es donde se
    // coloca una sesión que empieza contestando una pregunta («se contesta y se ofrece el menú»).
    entryPoints: live.filter(n => typeOf(n.type).waits(n.data)).map(brief),
    firstSpeaker: firstSpeaker ? brief(firstSpeaker) : null,
    endings: live.filter(n => n.type !== 'start' && !portsOf(n).length).map(brief),
    variables: {
      declared: [...vars.values()].filter(v => v.declared).map(v => v.name),
      saved: [...vars.values()].filter(v => v.writers.length).map(v => v.name),
      used: [...usedVars].sort(),
      unknown: [...usedVars].filter(name => !vars.has(name)).sort(),
    },
    tokens: [...tokens].sort(),
    references,
    slots: slots.sort(),
    speaks: Boolean(firstSpeaker),
    bytes: new TextEncoder().encode(JSON.stringify(g)).length,
  };
}

// Etiqueta completa de un paso para lectores de pantalla: «Paso 3 de 12, Botones: ¿Te gustaría…? Salidas: Sí, me
// interesa hacia «Inscripción»; Si no elige, sin conectar.»
export function describeNode(graph, nodeId, ctx = {}) {
  const index = indexGraph(graph);
  const node = index.byId.get(nodeId);
  if (!node) return '';
  const def = typeOf(node.type);
  const order = readingOrder(graph);
  const where = `Paso ${order.indexOf(nodeId) + 1} de ${order.length}`;
  if (!def) return `${where}, paso desconocido.`;
  const summary = node.type === 'start' ? '' : def.summary(node.data, ctx);
  const title = node.title?.trim() ? `${quote(short(node.title))}, ` : '';
  const said = `${where}, ${title}${def.label}${summary ? ': ' + summary : ''}`;
  // Un texto que ya termina en signo («¿Te gustaría…?») no lleva además un punto.
  const head = /[.?!…]$/.test(said) ? said : said + '.';
  const ports = def.ports(node.data);
  if (!ports.length) return node.type === 'note' ? head : `${head} Aquí termina el recorrido.`;
  const connected = index.out.get(nodeId);
  const outs = ports.map(p => {
    const to = connected?.get(p.id);
    return `${p.label}, ${to ? 'hacia ' + quote(nodeName(index.byId.get(to), ctx)) : 'sin conectar'}`;
  });
  return `${head} Salidas: ${outs.join('; ')}.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// 12. Ajustes del recorrido
// ---------------------------------------------------------------------------------------------------------------------

export const DEFAULT_SETTINGS = Object.freeze({
  timeoutMinutes: 1440,
  reminder: null,
  exitText: '',
  onUnexpected: 'assistant',
  reofferOnDetour: true,
  maxMisses: 2,
  fallbackText: '',
  reentry: 'always',
  proactive: false,
  channels: Object.freeze(['whatsapp']),
  courseOverrides: Object.freeze({}),
});

export function normalizeSettings(input) {
  const s = isObj(input) ? input : {};
  const reminder = isObj(s.reminder)
    ? { afterMinutes: int(s.reminder.afterMinutes, 60), text: text(s.reminder.text) }
    : null;
  const reentry = isObj(s.reentry)
    ? { cooldownMinutes: int(s.reentry.cooldownMinutes, 60) }
    : pick(s.reentry, ['always', 'once_conversation'], 'always');
  const channels = ids(s.channels).filter(c => CHANNEL_IDS.includes(c));
  const courseOverrides = {};
  if (isObj(s.courseOverrides)) {
    for (const [course, flow] of Object.entries(s.courseOverrides))
      if (typeof flow === 'string' && flow) courseOverrides[course] = flow;
  }
  return {
    timeoutMinutes: int(s.timeoutMinutes, DEFAULT_SETTINGS.timeoutMinutes),
    reminder,
    exitText: text(s.exitText),
    onUnexpected: pick(s.onUnexpected, ['assistant', 'repeat', 'default'], 'assistant'),
    reofferOnDetour: flag(s.reofferOnDetour, true),
    maxMisses: int(s.maxMisses, DEFAULT_SETTINGS.maxMisses),
    fallbackText: text(s.fallbackText),
    reentry,
    proactive: flag(s.proactive),
    channels: channels.length ? channels : ['whatsapp'],
    courseOverrides,
  };
}

// Problemas de los ajustes: [{code: 'settings', field, message}].
export function validateSettings(input, ctx = {}) {
  const s = normalizeSettings(input);
  const out = [];
  const env = { ctx: isObj(ctx) ? ctx : {}, vars: new Set() };
  const push = (field, message) => out.push({ code: 'settings', field, message });
  if (s.timeoutMinutes < 5 || s.timeoutMinutes > 1440)
    push('timeoutMinutes', 'El tiempo para dar el recorrido por abandonado va de 5 a 1440 minutos.');
  if (s.maxMisses < 1 || s.maxMisses > 3)
    push('maxMisses', 'Los mensajes fuera de las opciones que se toleran van de 1 a 3.');
  if (s.reminder) {
    if (s.reminder.afterMinutes < 1 || s.reminder.afterMinutes >= s.timeoutMinutes) {
      push('reminder.afterMinutes', 'El recordatorio debe salir antes de que el recorrido se dé por abandonado.');
    }
    for (const p of textProblems(
      s.reminder.text,
      { field: 'reminder.text', what: 'el recordatorio', max: LIMITS.interactiveText },
      env,
    ))
      push(p.field, p.message);
  }
  for (const [field, what] of [
    ['exitText', 'el mensaje de salida'],
    ['fallbackText', 'el mensaje de reserva'],
  ]) {
    for (const p of textProblems(s[field], { field, what, max: LIMITS.interactiveText, required: false }, env))
      push(p.field, p.message);
  }
  if (s.onUnexpected === 'repeat' && !s.fallbackText.trim())
    push('fallbackText', 'Para repetir las opciones hace falta el mensaje de reserva.');
  if (isObj(s.reentry) && (s.reentry.cooldownMinutes < 1 || s.reentry.cooldownMinutes > 43_200)) {
    push('reentry.cooldownMinutes', 'El descanso entre un recorrido y el siguiente va de 1 minuto a 30 días.');
  }
  for (const [course, flow] of Object.entries(s.courseOverrides)) {
    if (Array.isArray(env.ctx.courses) && !findRef(env.ctx, 'courses', course))
      push('courseOverrides', 'Hay un recorrido propio para un curso que ya no existe.');
    if (flow === env.ctx.flowId)
      push('courseOverrides', 'El recorrido propio de un curso no puede ser este mismo recorrido.');
    else if (Array.isArray(env.ctx.flows) && !findRef(env.ctx, 'flows', flow))
      push('courseOverrides', 'El recorrido propio de un curso ya no existe.');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 13. Conversión del flujo de bienvenida (server/flows.mjs) a un recorrido
// ---------------------------------------------------------------------------------------------------------------------

// Acciones del menú anterior que dejaban el menú a la vista; con «inscribirse» y «persona» el recorrido termina.
const WELCOME_STAY = ['price', 'syllabus', 'schedule'];

// Convierte los pasos del flujo de bienvenida ({id, text, buttons: [{label, go}]}) en un grafo equivalente, con sus
// ajustes y la regla que lo iniciaría. La regla nace apagada: encenderla es lo que apaga el flujo anterior, y eso lo
// hace el servidor en una sola transacción.
export function fromWelcomeFlow({ steps, withFlyer = true } = {}) {
  const list = Array.isArray(steps) ? steps.filter(s => isObj(s) && ID_RE.test(String(s.id || ''))) : [];
  const taken = new Set(list.map(s => s.id));
  // Los pasos conservan su id; el Inicio toma uno que no choque (el primer paso de fábrica se llama «inicio»).
  const startId = taken.has('start') ? nextId(taken, 'start') : 'start';
  const nodes = [createNode('start', { id: startId })];
  const edges = [];
  const seen = new Set();

  list.forEach((step, i) => {
    if (seen.has(step.id)) return;
    seen.add(step.id);
    const body = text(step.text);
    const buttons = Array.isArray(step.buttons) ? step.buttons : [];
    const flyer = i === 0 && withFlyer;
    if (!buttons.length) {
      // Sin botones es un mensaje. Si además llevaba la ficha, es la ficha del curso con ese texto.
      const node = flyer
        ? createNode('course_card', { id: step.id, data: { text: body, flyer: true } })
        : createNode('message', { id: step.id, data: { parts: [{ kind: 'text', text: body }] } });
      nodes.push(node);
      return;
    }
    const options = buttons.map((b, k) => {
      const go = String(b?.go || '').match(/^(step|action):([a-z0-9]+)$/);
      const id = 'o' + (k + 1);
      if (go && go[1] === 'step' && taken.has(go[2])) {
        edges.push({ from: step.id, port: 'opt:' + id, to: go[2] });
        return { id, label: text(b.label), do: { type: 'goto' } };
      }
      const intent = go && go[1] === 'action' && INTENT_IDS.includes(go[2]) ? go[2] : 'human';
      return { id, label: text(b?.label), do: { type: 'intent', intent, stay: WELCOME_STAY.includes(intent) } };
    });
    const data = { header: { kind: flyer ? 'course_flyer' : 'none' }, text: body, options };
    nodes.push(createNode('buttons', { id: step.id, data }));
  });

  if (nodes.length > 1) edges.unshift({ from: startId, port: 'next', to: nodes[1].id });
  const graph = normalizeGraph({ v: GRAPH_VERSION, start: startId, nodes, edges, variables: [] });
  return {
    graph: applyLayout(graph, layout(graph).positions),
    // Lo que el flujo anterior hacía sin decirlo: recordar el paso 24 horas y terminar al segundo mensaje libre.
    settings: normalizeSettings({
      timeoutMinutes: 1440,
      onUnexpected: 'assistant',
      maxMisses: 2,
      reofferOnDetour: false,
    }),
    rule: {
      v: 1,
      trigger: { type: 'chat_started', channels: ['whatsapp'] },
      filters: { mode: 'all', groups: [] },
      actions: [{ type: 'start_flow', flowId: null, course: 'keep', firstMessage: 'answer_and_menu' }],
      options: { stop: false, limit: 'once_conversation' },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 14. Exportar e importar
// ---------------------------------------------------------------------------------------------------------------------

const fail = message => Object.assign(new Error(message), { status: 400, code: 'flow_import' });

function setPath(root, path, value) {
  const keys = path.split('.');
  let at = root;
  for (const key of keys.slice(0, -1)) at = at[key];
  at[keys[keys.length - 1]] = value;
}

// Archivo de un recorrido. Las referencias a cosas de la marca viajan también con su nombre, para poder resolverlas en
// otra marca, donde los ids son distintos. Los secretos no viajan: el grafo sólo guarda su nombre.
export function exportFlow({ name = '', description = '', graph, settings } = {}, ctx = {}) {
  const canonical = normalizeGraph(graph);
  const references = [];
  const seen = new Set();
  for (const r of referencesOf(canonical)) {
    const key = r.source + '\n' + r.id;
    if (seen.has(key) || r.source === 'attributes') continue;
    seen.add(key);
    references.push({ source: r.source, id: r.id, name: refName(ctx, r.source, r.id) });
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    name: text(name),
    description: text(description),
    settings: normalizeSettings(settings),
    graph: canonical,
    references,
  };
}

export const exportJson = (flow, ctx) => JSON.stringify(exportFlow(flow, ctx), null, 2);

// Lee un archivo exportado (texto u objeto). Lanza un error con mensaje en español si no es un recorrido o es de una
// versión más nueva. Devuelve el recorrido ya canónico, lo que se reparó y las referencias que no se pudieron resolver
// en la marca de destino (`ctx`): ésas quedan vacías para que la validación las señale en su paso.
export function importFlow(input, ctx = {}) {
  let file = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > LIMITS.bytes * 2)
      throw fail('El archivo es demasiado grande para ser un recorrido.');
    try {
      file = JSON.parse(input);
    } catch {
      throw fail('El archivo no es un JSON válido.');
    }
  }
  if (!isObj(file) || file.format !== EXPORT_FORMAT)
    throw fail('El archivo no es un recorrido exportado desde esta aplicación.');
  if (!Number.isInteger(file.version) || file.version < 1) throw fail('El archivo no dice de qué versión es.');
  if (file.version > EXPORT_VERSION)
    throw fail('El archivo es de una versión más nueva de la aplicación: actualízala antes de importarlo.');
  if (!isObj(file.graph)) throw fail('El archivo no trae el recorrido.');
  if (file.graph.v !== GRAPH_VERSION)
    throw fail('El recorrido del archivo es de una versión que la aplicación no entiende.');

  const { graph, repairs } = repairGraph(file.graph);
  const named = new Map();
  for (const r of Array.isArray(file.references) ? file.references : []) {
    if (isObj(r) && typeof r.source === 'string' && typeof r.id === 'string')
      named.set(r.source + '\n' + r.id, text(r.name));
  }
  const unresolved = new Map();
  for (const r of referencesOf(graph)) {
    const items = ctx?.[r.source];
    // Sin la lista de la marca no se puede saber: la referencia se deja como viene.
    if (!Array.isArray(items) || findRef(ctx, r.source, r.id)) continue;
    const meta = REF_SOURCES[r.source];
    const name = named.get(r.source + '\n' + r.id) || '';
    const match = name ? items.find(item => norm(item?.[meta.name]) === norm(name)) : null;
    const node = graph.nodes.find(n => n.id === r.nodeId);
    if (match) {
      setPath(node.data, r.path, match[meta.id]);
      continue;
    }
    // Un dato del contacto se identifica por su clave, que es la misma en todas las marcas: se conserva y se avisa.
    if (r.source !== 'attributes') setPath(node.data, r.path, '');
    const key = r.source + '\n' + (name || r.id);
    if (!unresolved.has(key)) unresolved.set(key, { source: r.source, id: r.id, name, nodeIds: [] });
    if (!unresolved.get(key).nodeIds.includes(r.nodeId)) unresolved.get(key).nodeIds.push(r.nodeId);
  }
  return {
    name: text(file.name),
    description: text(file.description),
    settings: normalizeSettings(file.settings),
    // Al vaciar una referencia dentro de una lista (etiquetas, cursos) queda un hueco: se vuelve a limpiar.
    graph: normalizeGraph(graph),
    repairs,
    unresolved: [...unresolved.values()],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 15. Resultado de una sesión
// ---------------------------------------------------------------------------------------------------------------------

export const FLOW_RESULTS = Object.freeze({
  completed: 'Terminada',
  handoff: 'Pasó a una persona',
  left: 'Salió escribiendo',
  dropped: 'Abandonada',
  excluded: 'Fuera de las tasas',
  inProgress: 'En curso',
});

const RESULT_OF = {
  completed: 'completed',
  assistant: 'completed',
  replaced: 'completed',
  handoff: 'handoff',
  human_takeover: 'handoff',
  closed: 'handoff',
  left: 'left',
  timeout: 'dropped',
  opt_out: 'dropped',
  window_closed: 'dropped',
  flow_archived: 'excluded',
  error: 'excluded',
};

// Categoría de un resultado de sesión. Es la única clasificación: la usan la lista de recorridos y el tablero de
// estadísticas, para que las dos pantallas den la misma cifra. Un resultado desconocido queda fuera de las tasas.
export function flowResult(outcome) {
  if (outcome === null || outcome === undefined || outcome === '') return 'inProgress';
  return RESULT_OF[outcome] || 'excluded';
}

// Tasas de un conjunto de sesiones ya clasificadas: {completed, handoff, left, dropped, excluded, inProgress}.
// «Salió escribiendo» y «pasó a una persona» no son abandono ni finalización, pero sí cuentan en el denominador.
export function flowRates(counts) {
  const n = key => Number(counts?.[key]) || 0;
  const base = n('completed') + n('handoff') + n('left') + n('dropped');
  return {
    sessions: base + n('excluded') + n('inProgress'),
    base,
    completion: base ? n('completed') / base : 0,
    dropOff: base ? n('dropped') / base : 0,
  };
}
