// Un solo resolutor de {{variables}} para mensajes, materiales de respuesta, plantillas, reglas y flujos.
//
// Por qué existe: el flujo de bienvenida, las respuestas rápidas, las plantillas del catálogo y las plantillas de
// WhatsApp sustituyen llaves cada uno a su modo (cuatro listas de nombres y cuatro expresiones regulares). Aquí vive
// una sola gramática, un solo catálogo y una sola regla para lo que falta: un dato desconocido o vacío siempre se
// informa a quien llama; nunca se convierte en un hueco sin avisar.
//
// Gramática: `{{nombre}}`, `{{contacto.ciudad}}`, `{{var.respuesta}}` y `{{nombre|texto de respaldo}}`. Los nombres
// se comparan sin mayúsculas ni acentos («{{Edición}}» es «{{edicion}}»). A Meta las plantillas viajan numeradas
// (`{{1}}`, `{{2}}`…): este módulo convierte de nombres a números y de vuelta.
//
// Funciones puras y síncronas: los valores los entrega quien llama (un objeto o una función), no se leen de la base.

const TOKEN = /\{\{([^{}]*)\}\}/g;
const KEY = /^[a-zñ_][a-z0-9ñ_]*(?:\.[a-z0-9ñ_]+){0,2}$/;
const NUMBER = /^\d{1,3}$/;
// La virgulilla de la ñ es parte de la letra; los demás acentos de un nombre de dato se ignoran.
const TILDE = String.fromCharCode(0x303);
// Un importe escrito a mano: «$379», «379 pesos», «1,500.00 MXN». Acepta lo mismo que la expresión de Contenido, pero
// cada cifra se lee una sola vez desde su inicio: un texto con miles de dígitos no cuesta más que uno corto.
const AMOUNT = /\$\s?\d|(?<![\d.,])[.,]*\d[\d.,]*\s?(?:pesos|mxn|usd)\b/i;

export const PARAM_MAX_LENGTH = 200;

const asText = value => (value === null || value === undefined ? '' : String(value));
// Propiedad propia de un objeto simple. Una lista no es un conjunto de valores: su `length` no es un dato.
const has = (object, key) =>
  object !== null && typeof object === 'object' && !Array.isArray(object) && Object.hasOwn(object, key);
const note = (list, item) => {
  if (!list.includes(item)) list.push(item);
};

const canonicalKey = name =>
  name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, mark => (mark === TILDE ? mark : ''))
    .normalize('NFC');

function parseToken(content) {
  const bar = content.indexOf('|');
  const name = (bar < 0 ? content : content.slice(0, bar)).trim();
  const fallback = bar < 0 ? null : content.slice(bar + 1).trim() || null;
  if (NUMBER.test(name) && Number(name) > 0)
    return { kind: 'numbered', key: null, number: Number(name), fallback: null };
  const key = canonicalKey(name);
  return KEY.test(key) ? { kind: 'named', key, fallback } : { kind: 'invalid', key: null, name, fallback };
}

const invalidText = raw => `«${raw}» no es un dato válido: escribe el nombre del dato entre llaves, como {{nombre}}.`;
const numberedText = raw => `Usa los datos por su nombre, no por número: «${raw}».`;

// Lo que se puede escribir en un mensaje: texto con algo visible o un número. Cualquier otra cosa cuenta como vacío.
function printable(value) {
  if (typeof value === 'string') return /\S/.test(value) ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'bigint') return String(value);
  return null;
}

// Sólo propiedades propias: `{{constructor}}` o `{{__proto__}}` no deben encontrar nada en un objeto cualquiera.
function lookup(values, key) {
  if (typeof values === 'function') return values(key);
  if (values instanceof Map) return values.get(key);
  if (has(values, key)) return values[key];
  let node = values;
  for (const part of key.split('.')) {
    if (!has(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

// ---- Catálogo

const CATALOGUES = new WeakSet();

function listEntries(entries) {
  if (Array.isArray(entries)) return entries.map(entry => (typeof entry === 'string' ? { key: entry } : entry));
  return Object.entries(entries ?? {}).map(([key, entry]) =>
    typeof entry === 'string' ? { key, label: entry } : { ...entry, key },
  );
}

function build(map) {
  const catalogue = {
    get: key => map.get(key),
    has: key => map.has(key),
    keys: () => [...map.keys()],
    // Las variables que se pueden usar en una superficie (`flow`, `quick_reply`, `template`…); sin superficie, todas.
    list: ({ surface } = {}) =>
      [...map.values()].filter(entry => !surface || !entry.surfaces || entry.surfaces.includes(surface)),
    // Valores de muestra para la vista previa de un editor.
    samples: () => Object.fromEntries([...map.values()].map(entry => [entry.key, entry.sample])),
    // Otro catálogo con más variables (los atributos de una marca, las variables de un flujo). No cambia éste.
    extend: more => createCatalogue([...map.values(), ...listEntries(more)]),
  };
  CATALOGUES.add(catalogue);
  return Object.freeze(catalogue);
}

// Catálogo de variables: de cada una, `key`, `label` (cómo se llama en pantalla), `source` (de dónde sale el valor),
// `sample` (valor de muestra) y, si aplica, `group`, `surfaces` (dónde se permite; sin lista, en todo) y `fallback`
// (respaldo por omisión). Acepta una lista de entradas o de nombres, o un objeto `{clave: etiqueta | entrada}`.
// Cualquier otra propiedad se conserva, para que cada módulo cuelgue ahí lo suyo.
export function createCatalogue(entries = []) {
  const map = new Map();
  for (const entry of listEntries(entries)) {
    const key = entry?.key;
    if (typeof key !== 'string' || !KEY.test(key))
      throw new TypeError(`«${key}» no sirve como nombre de variable: usa minúsculas, números, guion bajo y puntos.`);
    if (map.has(key)) throw new TypeError(`La variable «${key}» está dos veces en el catálogo.`);
    if (entry.surfaces !== undefined && entry.surfaces !== null && !Array.isArray(entry.surfaces))
      throw new TypeError(`«surfaces» de la variable «${key}» debe ser una lista.`);
    map.set(
      key,
      Object.freeze({
        ...entry,
        key,
        label: asText(entry.label) || key,
        source: asText(entry.source),
        sample: asText(entry.sample),
        group: asText(entry.group),
        surfaces: entry.surfaces ? Object.freeze([...entry.surfaces]) : null,
        fallback: printable(entry.fallback),
      }),
    );
  }
  return build(map);
}

const asCatalogue = catalogue =>
  catalogue === null || catalogue === undefined
    ? null
    : CATALOGUES.has(catalogue)
      ? catalogue
      : createCatalogue(catalogue);

// ---- Leer y validar

// Cada `{{…}}` del texto, en orden: `raw`, `index`, `kind` (`named`, `numbered` o `invalid`), `key` (nombre canónico),
// `number` (sólo las numeradas) y `fallback` (texto de respaldo escrito tras la barra, o `null`).
export function extract(text) {
  return [...asText(text).matchAll(TOKEN)].map(match => ({
    raw: match[0],
    index: match.index,
    ...parseToken(match[1]),
  }));
}

// Los nombres de las variables que usa un texto, sin repetir: lo que hay que conseguir antes de enviarlo.
export function extractKeys(text) {
  const keys = [];
  for (const token of extract(text)) if (token.kind === 'named') note(keys, token.key);
  return keys;
}

// ¿El texto lleva un importe escrito a mano («$379», «379 pesos»)? Los precios sólo salen del catálogo. Los respaldos
// escritos tras la barra también cuentan: son texto de quien redacta.
export function hasWrittenAmount(text) {
  return AMOUNT.test(asText(text).replace(TOKEN, (raw, content) => ` ${parseToken(content).fallback ?? ''} `));
}

// Lista de problemas de un texto, en palabras de quien lo escribe; vacía si se puede guardar. Sin catálogo sólo se
// revisa la forma. Opciones: `surface` (dónde se va a usar), `numbered` (admite `{{1}}`: sólo para textos que ya
// vienen de Meta) y `forbidAmounts` (rechaza importes escritos a mano).
export function validate(text, catalogue, { surface, numbered = false, forbidAmounts = false } = {}) {
  if (typeof text !== 'string') return ['Falta el texto.'];
  const known = asCatalogue(catalogue);
  const problems = [];
  for (const token of extract(text)) {
    if (token.kind === 'invalid') note(problems, invalidText(token.raw));
    else if (token.kind === 'numbered') {
      if (!numbered) note(problems, numberedText(token.raw));
    } else if (known) {
      const entry = known.get(token.key);
      if (!entry) note(problems, `El mensaje usa un dato que no existe: {{${token.key}}}.`);
      else if (surface && entry.surfaces && !entry.surfaces.includes(surface))
        note(problems, `El dato {{${token.key}}} no está disponible en este tipo de mensaje.`);
    }
  }
  if (/\{\{|\}\}/.test(text.replace(TOKEN, ''))) problems.push('Hay llaves sin cerrar en el texto.');
  if (forbidAmounts && hasWrittenAmount(text))
    problems.push('El texto lleva un importe escrito a mano: los precios salen del catálogo, usa {{precio}}.');
  return problems;
}

// ---- Sustituir

// Valor listo para ir como parámetro de una plantilla de Meta, que rechaza saltos de línea, tabuladores y más de
// cuatro espacios seguidos: todo espacio en blanco se vuelve un solo espacio y el valor se recorta a su largo máximo
// sin partir un carácter.
export function cleanParam(value, { maxLength = PARAM_MAX_LENGTH } = {}) {
  const text = (printable(value) ?? '').replace(/[\s\p{Cc}]+/gu, ' ').trim();
  if (text.length <= maxLength) return text;
  const high = text.charCodeAt(maxLength - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? maxLength - 1 : maxLength).trimEnd();
}

// Busca el valor de una variable: primero el dato, después el respaldo escrito en el texto, el respaldo de quien
// llama y el respaldo del catálogo. `shape` deja el texto como lo necesita el destino.
function resolve(token, { values, fallbacks, known, shape }) {
  const value = shape(printable(lookup(values, token.key)));
  if (value !== null) return { value, defaulted: false };
  for (const candidate of [
    token.fallback,
    has(fallbacks, token.key) ? fallbacks[token.key] : null,
    known?.get(token.key)?.fallback,
  ]) {
    const fallback = shape(printable(candidate));
    if (fallback !== null) return { value: fallback, defaulted: true };
  }
  return { value: null, defaulted: false };
}

const shaper = (forTemplate, maxLength) =>
  forTemplate ? value => (value === null ? null : cleanParam(value, { maxLength }) || null) : value => value;

const isGap = char => char === ' ' || char === '\t';

// Escribe el texto pieza a pieza. Al quitar un dato vacío se lleva la coma que lo precedía y no deja espacios dobles
// ni un espacio antes del signo de cierre: «¡Hola, {{nombre}}!» queda «¡Hola!». Sólo mira el final de lo ya escrito,
// para que un texto con muchos datos vacíos no se recorra entero cada vez.
function writer() {
  const parts = [];
  let removed = false;
  let space = false;
  const lastChar = () => {
    for (let at = parts.length - 1; at >= 0; at--) if (parts[at] !== '') return parts[at].at(-1);
    return '';
  };
  return {
    write(piece) {
      if (!removed) {
        parts.push(piece);
        return;
      }
      const last = lastChar();
      const atStart = last === '' || '\n¡¿(«'.includes(last);
      const body = atStart ? piece.replace(/^[ \t]*[,;:]?[ \t]*/, '') : piece;
      const lead = /^[ \t]*/.exec(body)[0];
      const rest = body.slice(lead.length);
      if (rest === '') {
        space ||= lead !== '';
        return;
      }
      const glued = atStart || /^[,.;:!?)»\r\n]/.test(rest);
      parts.push((glued || !(lead || space) ? '' : ' ') + rest);
      removed = false;
      space = false;
    },
    remove() {
      removed = true;
      while (parts.length) {
        const piece = parts.at(-1);
        let end = piece.length;
        while (end > 0 && isGap(piece[end - 1])) end--;
        space ||= end < piece.length;
        if (end === 0) {
          parts.pop();
          continue;
        }
        parts[parts.length - 1] = piece.slice(0, piece[end - 1] === ',' ? end - 1 : end);
        return;
      }
    },
    text: () => parts.join(''),
  };
}

// Sustituye las variables de un texto. `values` es un objeto (`{nombre: 'Ana', contacto: {ciudad: 'Puebla'}}`) o una
// función `clave → valor`. Devuelve el texto y lo que pasó con cada dato: `missing` (sin valor ni respaldo), `unknown`
// (no está en el catálogo, o la llave está mal escrita) y `defaulted` (salió con su respaldo).
//
// `onMissing` decide qué se hace con lo que falta: `'keep'` deja la llave tal cual (por omisión: nada se pierde),
// `'remove'` la quita con su coma, `'throw'` lanza un error con la lista, y una función `(clave) → texto` da el valor.
// `forTemplate: true` limpia cada valor como parámetro de plantilla. Con `catalogue`, sólo se sustituyen sus variables.
export function render(text, values, options = {}) {
  const {
    fallbacks = {},
    onMissing = 'keep',
    catalogue = null,
    forTemplate = false,
    maxLength = PARAM_MAX_LENGTH,
  } = options;
  if (typeof onMissing !== 'function' && !['keep', 'remove', 'throw'].includes(onMissing))
    throw new TypeError('onMissing debe ser «keep», «remove», «throw» o una función.');
  const known = asCatalogue(catalogue);
  const shape = shaper(forTemplate, maxLength);
  const context = { values, fallbacks, known, shape };
  const src = asText(text);
  const missing = [];
  const unknown = [];
  const defaulted = [];
  const page = writer();
  let last = 0;
  for (const match of src.matchAll(TOKEN)) {
    const token = parseToken(match[1]);
    page.write(src.slice(last, match.index));
    last = match.index + match[0].length;
    let value = null;
    if (token.kind !== 'named' || (known && !known.has(token.key))) note(unknown, token.key ?? match[1].trim());
    else {
      const found = resolve(token, context);
      value = found.value;
      if (found.defaulted) note(defaulted, token.key);
      if (value === null) {
        note(missing, token.key);
        if (typeof onMissing === 'function') value = shape(printable(onMissing(token.key, token)));
      }
    }
    if (value !== null) page.write(value);
    else if (onMissing === 'remove') page.remove();
    else page.write(match[0]);
  }
  page.write(src.slice(last));
  if (onMissing === 'throw' && (missing.length || unknown.length)) {
    const names = [...missing, ...unknown].map(key => `{{${key}}}`).join(', ');
    throw Object.assign(new Error(`Faltan datos para escribir el mensaje: ${names}.`), {
      name: 'VariablesError',
      code: 'missing_variables',
      status: 422,
      missing,
      unknown,
    });
  }
  return { text: page.text(), missing, unknown, defaulted };
}

// ---- Plantillas de Meta: de nombres a números y de vuelta

// «Hola {{nombre}}, tu curso {{curso}}» → `{text: 'Hola {{1}}, tu curso {{2}}', keys: ['nombre', 'curso']}`. Se numera
// por orden de primera aparición y un dato repetido conserva su número. Cada componente de la plantilla (cuerpo,
// encabezado, cada botón) se convierte por separado: en cada uno la cuenta empieza en 1. Los respaldos escritos en el
// texto se devuelven aparte, porque la forma numerada no puede llevarlos.
export function toNumbered(text) {
  const keys = [];
  const fallbacks = {};
  const numbered = asText(text).replace(TOKEN, (raw, content) => {
    const token = parseToken(content);
    if (token.kind !== 'named')
      throw Object.assign(new Error(token.kind === 'numbered' ? numberedText(raw) : invalidText(raw)), {
        name: 'VariablesError',
        code: 'invalid_variable',
        status: 400,
      });
    note(keys, token.key);
    if (token.fallback !== null && !has(fallbacks, token.key)) fallbacks[token.key] = token.fallback;
    return `{{${keys.indexOf(token.key) + 1}}}`;
  });
  return { text: numbered, keys, fallbacks };
}

// El camino de vuelta: `{{1}}` → `{{nombre}}` según la lista de claves. Los números sin clave se dejan como están y se
// informan en `unknown`.
export function toNamed(text, keys) {
  const unknown = [];
  const named = asText(text).replace(TOKEN, (raw, content) => {
    const token = parseToken(content);
    if (token.kind !== 'numbered') return raw;
    const key = keys?.[token.number - 1];
    if (typeof key === 'string' && key) return `{{${key}}}`;
    note(unknown, token.number);
    return raw;
  });
  return { text: named, unknown };
}

// Los parámetros de una plantilla, en el orden de sus claves y ya limpios para Meta. Una clave sin valor ni respaldo
// queda en `null` (Meta rechazaría el envío: quien llama debe mirar `missing` antes de mandar), salvo que `onMissing`
// dé un texto.
export function templateParams(keys, values, { fallbacks = {}, onMissing = null, catalogue = null, maxLength } = {}) {
  const shape = shaper(true, maxLength ?? PARAM_MAX_LENGTH);
  const context = { values, fallbacks, known: asCatalogue(catalogue), shape };
  const missing = [];
  const defaulted = [];
  const params = keys.map(key => {
    const found = resolve({ key, fallback: null }, context);
    if (found.defaulted) note(defaulted, key);
    if (found.value !== null) return found.value;
    note(missing, key);
    return typeof onMissing === 'function' ? shape(printable(onMissing(key))) : null;
  });
  return { params, missing, defaulted };
}

// Un texto numerado con sus parámetros puestos, para guardar o mostrar lo que se envió. Las posiciones sin parámetro
// se dejan como están y se informan en `missing`.
export function fillNumbered(text, params) {
  const missing = [];
  const filled = asText(text).replace(TOKEN, (raw, content) => {
    const token = parseToken(content);
    if (token.kind !== 'numbered') return raw;
    const value = printable(params?.[token.number - 1]);
    if (value !== null) return value;
    note(missing, token.number);
    return raw;
  });
  return { text: filled, missing };
}
