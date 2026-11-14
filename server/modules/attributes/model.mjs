// Tipos, límites y reglas de los atributos de contacto. Funciones puras: sin base de datos ni red.
//
// Forma canónica de cada tipo (lo que se guarda en `value`) y lo que va en `value_num` para comparar en SQL:
//   text      texto recortado, hasta 500 caracteres                     —
//   number    decimal con punto («1500», «12.5»)                         el número
//   date      AAAA-MM-DD                                                 medianoche UTC en milisegundos
//   boolean   «true» o «false»                                           1 o 0
//   select    el `value` de una de sus opciones                          —
// Un valor vacío no se guarda: escribir vacío borra el valor.

export const TYPES = Object.freeze({
  text: 'Texto',
  number: 'Número',
  date: 'Fecha',
  select: 'Lista',
  boolean: 'Sí o no',
});

export const LIMITS = Object.freeze({
  definitions: 60, // atributos activos por marca
  label: 60,
  description: 200,
  value: 500,
  options: 50,
  option: 60,
  changes: 50, // cambios por petición
  history: 20,
});

export const KEY = /^[a-z][a-z0-9_]{1,39}$/;

// Atributos de sistema (§4.2 del diseño): no se guardan aquí, se leen de su tabla dueña y son de sólo lectura.
// `scope: 'conversation'` se lee del interés comercial más reciente del contacto.
export const SYSTEM = Object.freeze([
  { key: 'nombre', label: 'Nombre', type: 'text', scope: 'contact', from: 'contacts.name' },
  { key: 'telefono', label: 'Teléfono', type: 'text', scope: 'contact', from: 'contacts.phone', personal: true },
  { key: 'correo', label: 'Correo', type: 'text', scope: 'contact', from: 'contacts.email', personal: true },
  { key: 'origen', label: 'Origen', type: 'text', scope: 'contact', from: 'contacts.source' },
  { key: 'creado', label: 'Fecha de alta', type: 'date', scope: 'contact', from: 'contacts.created_at' },
  {
    key: 'consentimiento',
    label: 'Consentimiento',
    type: 'select',
    scope: 'contact',
    from: 'contact_consent.status',
    options: [
      { value: 'unknown', label: 'Sin registro' },
      { value: 'opted_in', label: 'Acepta mensajes' },
      { value: 'opted_out', label: 'No desea mensajes' },
    ],
  },
  { key: 'etiquetas', label: 'Etiquetas', type: 'list', scope: 'contact', from: 'contact_tag_links' },
  {
    key: 'etapa',
    label: 'Etapa comercial',
    type: 'select',
    scope: 'conversation',
    from: 'opportunities.stage',
    options: [
      { value: 'nuevo', label: 'Nuevo' },
      { value: 'interesado', label: 'Interesado' },
      { value: 'inscripcion', label: 'Inscripción' },
      { value: 'ganada', label: 'Ganada' },
      { value: 'perdida', label: 'Perdida' },
    ],
  },
  {
    key: 'curso_interes',
    label: 'Curso de interés',
    type: 'text',
    scope: 'conversation',
    from: 'opportunities.course_id',
  },
]);
export const SYSTEM_KEYS = new Set(SYSTEM.map(item => item.key));

export const invalid = (message, field) =>
  Object.assign(new Error(message), { status: 400, code: 'attribute_invalid', field });

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TRUE = new Set(['true', '1', 'si', 'sí', 'yes']);
const FALSE = new Set(['false', '0', 'no']);

// Opciones de una lista: [{value, label}] sin repetir. Acepta textos sueltos (el valor es el texto).
export function normalizeOptions(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw invalid('Las opciones van en una lista.', 'options');
  if (input.length > LIMITS.options) throw invalid(`Una lista admite hasta ${LIMITS.options} opciones.`, 'options');
  const seen = new Set();
  const out = [];
  for (const item of input) {
    const raw = typeof item === 'string' ? { value: item, label: item } : item;
    const value = typeof raw?.value === 'string' ? raw.value.trim() : '';
    const label = typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim() : value;
    if (!value) continue;
    if (value.length > LIMITS.option || label.length > LIMITS.option)
      throw invalid(`Cada opción admite hasta ${LIMITS.option} caracteres.`, 'options');
    const key = value.toLowerCase();
    if (seen.has(key)) throw invalid(`La opción «${value}» está repetida.`, 'options');
    seen.add(key);
    out.push({ value, label });
  }
  return out;
}

// El valor en su forma canónica: {value, valueNum}, o null si viene vacío (borra el valor). Lanza attribute_invalid.
export function canonical(definition, raw) {
  const { type, label, key } = definition;
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) return null;
  const bad = message => invalid(`«${label}»: ${message}`, key);
  if (type === 'text') {
    if (typeof raw !== 'string' && typeof raw !== 'number') throw bad('escribe un texto.');
    const value = String(raw).trim().replace(/\r\n?/g, '\n');
    if (value.length > LIMITS.value) throw bad(`admite hasta ${LIMITS.value} caracteres.`);
    return { value, valueNum: null };
  }
  if (type === 'number') {
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim().replace(',', '.') : '';
    const number = text.length <= 30 && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
    if (!Number.isFinite(number)) throw bad('escribe un número (con punto para los decimales).');
    return { value: String(number), valueNum: number };
  }
  if (type === 'date') {
    const match = typeof raw === 'string' ? DAY.exec(raw.trim()) : null;
    const at = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
    if (!match || new Date(at).toISOString().slice(0, 10) !== raw.trim()) throw bad('escribe una fecha AAAA-MM-DD.');
    return { value: raw.trim(), valueNum: at };
  }
  if (type === 'boolean') {
    const text = typeof raw === 'boolean' ? String(raw) : typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (TRUE.has(text)) return { value: 'true', valueNum: 1 };
    if (FALSE.has(text)) return { value: 'false', valueNum: 0 };
    throw bad('elige sí o no.');
  }
  if (type === 'select') {
    const text = typeof raw === 'string' ? raw.trim() : '';
    const option = definition.options.find(item => item.value === text);
    if (!option) throw bad('elige una de sus opciones.');
    return { value: option.value, valueNum: null };
  }
  throw bad('tipo desconocido.');
}

// El valor guardado con su tipo, para evaluar condiciones en memoria: número, instante en ms, true/false o texto.
export function typed(definition, row) {
  if (!row) return null;
  if (definition.type === 'number' || definition.type === 'date') return row.value_num ?? null;
  if (definition.type === 'boolean') return row.value === 'true';
  return row.value;
}

// Cómo se lee el valor en pantalla y en un mensaje.
export function display(definition, value) {
  if (value === null || value === undefined || value === '') return '';
  if (definition.type === 'boolean') return value === 'true' ? 'Sí' : 'No';
  if (definition.type === 'select') return definition.options.find(item => item.value === value)?.label ?? value;
  if (definition.type === 'date') {
    const [y, m, d] = String(value).split('-');
    return `${d}/${m}/${y}`;
  }
  return String(value);
}
