// Una sola gramática de condiciones para segmentos de contactos, filtros de la bandeja, filtros de reglas y reglas
// de reparto.
//
// Por qué existe: cada pantalla iba a traer su propia sintaxis de filtros, su validador y su compilador. Aquí hay una
// forma, un validador y dos evaluadores que dan la misma respuesta: en memoria (`evaluate`, para decidir sobre un
// mensaje o un registro que ya se tiene) y en SQL (`compile`, para listar miles de filas sin traerlas).
//
// Forma canónica: grupos unidos por O y, dentro de cada grupo, condiciones unidas por Y (`match` permite invertirlo):
//
//   {"version": 1, "match": "any", "groups": [
//     {"match": "all", "rules": [{"field": "ciudad", "op": "eq", "value": "Puebla"},
//                                {"field": "attr", "key": "edad", "op": "gte", "value": 18}]}]}
//
// Los campos no viven aquí: los declara quien llama con `defineFields` (clave, tipo, cómo se lee de un objeto y, si
// se puede consultar, cómo se escribe en SQL). Esas expresiones SQL las escribe quien programa; lo que escribe una
// persona en una condición viaja siempre como parámetro, nunca dentro del texto de la consulta.
//
// Regla para lo vacío: una comparación afirmativa (igual, contiene, mayor, antes, en los últimos N días…) nunca se
// cumple con un dato vacío; su negación (distinto, no contiene, no en los últimos N días…) es exactamente lo
// contrario, así que sí se cumple. Cada condición vale sí o no, nunca «desconocido»: por eso SQL y memoria coinciden.
//
// Funciones puras y síncronas: sin base de datos, sin red y sin estado. El «ahora» lo entrega quien llama.

const DAY = 86_400_000;
const MAX_INSTANT = 8.64e15;

export const LIMITS = Object.freeze({
  maxGroups: 5,
  maxRules: 8,
  maxValues: 50,
  maxWords: 30,
  maxWordLength: 60,
  maxTextLength: 200,
  maxDays: 3650,
  maxBytes: 16_384,
  minThreshold: 60,
  maxThreshold: 95,
  defaultThreshold: 80,
});

// ---- Texto: normalización y palabra clave

// Forma comparable de un texto: minúsculas, sin acentos, y todo lo que no es letra ni número se vuelve un espacio.
// Para el español da lo mismo que la normalización de los botones del flujo de bienvenida; además conserva las letras
// de otros alfabetos en vez de borrarlas.
export function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/(?:[^\p{L}\p{N}]|[ºª])+/gu, ' ')
    .trim();
}
export const norm = normalizeText;

// Distancia de Damerau-Levenshtein (alineación óptima): insertar, borrar, sustituir o intercambiar dos letras vecinas
// cuesta 1. «hidrocaburos» está a 1 de «hidrocarburos».
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let older = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current = [];
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let best = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1))
        best = Math.min(best, older[j - 2] + 1);
      current[j] = best;
    }
    [older, previous, current] = [previous, current, older];
  }
  return previous[b.length];
}

// Parecido entre dos textos, de 0 a 1: uno menos la distancia entre el largo del mayor.
export function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  return longest ? 1 - editDistance(a, b) / longest : 1;
}

export const KEYWORD_MODES = Object.freeze(['exact', 'contains', 'fuzzy']);
const FUZZY_WORDS = 60;
const FUZZY_MIN_LETTERS = 4;

// Palabras completas: «recurso» no contiene «curso».
const containsWords = (haystack, needle) => ` ${haystack} `.includes(` ${needle} `);

// Parecido (0 a 100) de la primera ventana de palabras del mensaje que alcanza el umbral, o `null`. La ventana mide
// una palabra menos, igual o una más que la clave, y sólo se miran las primeras palabras del mensaje. Se compara con
// enteros para que un 80 % exacto no se pierda por redondeo.
function fuzzyScore(haystack, needle, threshold) {
  const words = haystack.split(' ', FUZZY_WORDS);
  const size = needle.split(' ').length;
  for (const span of [size - 1, size, size + 1]) {
    if (span < 1) continue;
    for (let at = 0; at + span <= words.length; at++) {
      const window = words.slice(at, at + span).join(' ');
      const longest = Math.max(window.length, needle.length);
      // La distancia nunca es menor que la diferencia de largos: si ni así alcanza, no hace falta calcularla.
      if ((longest - Math.abs(window.length - needle.length)) * 100 < threshold * longest) continue;
      const kept = longest - editDistance(window, needle);
      if (kept * 100 >= threshold * longest) return (kept / longest) * 100;
    }
  }
  return null;
}

// Una clave contra un texto, ambos ya normalizados. Devuelve el parecido (100 si es exacto) o `null`.
function keywordScore(haystack, needle, mode, threshold) {
  if (mode === 'exact') return haystack === needle ? 100 : null;
  // Con menos de cuatro letras cualquier palabra corta «se parece»: se exige la palabra completa.
  if (mode === 'contains' || needle.replaceAll(' ', '').length < FUZZY_MIN_LETTERS)
    return containsWords(haystack, needle) ? 100 : null;
  return fuzzyScore(haystack, needle, threshold);
}

const keywordHit = (haystack, needles, mode, threshold) =>
  haystack !== '' && needles.some(needle => keywordScore(haystack, needle, mode, threshold) !== null);

// Primera palabra clave de la lista que coincide con el texto: `{word, mode, score}`, o `null`. No distingue
// mayúsculas, acentos ni signos. Modos: `exact` (el mensaje entero es la clave), `contains` (la clave aparece como
// palabras completas) y `fuzzy` (se parece al menos `threshold` por ciento a algún tramo del mensaje). Un texto sin
// letras ni números (un archivo sin pie, sólo emojis) nunca coincide.
export function keywordMatch(text, words, { mode = 'contains', threshold = LIMITS.defaultThreshold } = {}) {
  if (!KEYWORD_MODES.includes(mode)) throw new TypeError(`Modo de palabra clave desconocido: ${mode}.`);
  const haystack = normalizeText(text);
  if (!haystack) return null;
  for (const word of Array.isArray(words) ? words : [words]) {
    const needle = normalizeText(word);
    const score = needle ? keywordScore(haystack, needle, mode, Number(threshold)) : null;
    if (score !== null) return { word, mode, score };
  }
  return null;
}

export function matchKeyword(text, words, options) {
  return keywordMatch(text, words, options) !== null;
}

// ---- Operadores

export const OPERATORS = Object.freeze({
  text: Object.freeze([
    'eq',
    'neq',
    'contains',
    'not_contains',
    'starts_with',
    'not_starts_with',
    'in',
    'not_in',
    'keyword',
    'empty',
    'not_empty',
  ]),
  number: Object.freeze(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty']),
  date: Object.freeze([
    'eq',
    'neq',
    'before',
    'after',
    'between',
    'in_last_days',
    'not_in_last_days',
    'empty',
    'not_empty',
  ]),
  boolean: Object.freeze(['is', 'empty', 'not_empty']),
  choice: Object.freeze(['eq', 'neq', 'in', 'not_in', 'empty', 'not_empty']),
  list: Object.freeze(['any', 'all', 'none', 'empty', 'not_empty']),
});

export const OPERATOR_LABELS = Object.freeze({
  eq: 'es igual a',
  neq: 'es distinto de',
  contains: 'contiene',
  not_contains: 'no contiene',
  starts_with: 'empieza con',
  not_starts_with: 'no empieza con',
  in: 'es una de',
  not_in: 'no es ninguna de',
  keyword: 'coincide con la palabra clave',
  empty: 'está vacío',
  not_empty: 'tiene valor',
  gt: 'es mayor que',
  gte: 'es mayor o igual que',
  lt: 'es menor que',
  lte: 'es menor o igual que',
  between: 'está entre',
  before: 'es anterior a',
  after: 'es posterior a',
  in_last_days: 'fue en los últimos días',
  not_in_last_days: 'no fue en los últimos días',
  is: 'es',
  any: 'tiene alguna de',
  all: 'tiene todas',
  none: 'no tiene ninguna de',
});

// ---- Registro de campos

const REGISTRIES = new WeakSet();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => (isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined);
const sqlText = value => typeof value === 'string' && value.trim() !== '';

function optionSet(options, name) {
  if (options === undefined || options === null) return null;
  if (!Array.isArray(options)) throw new TypeError(`«options» del campo «${name}» debe ser una lista.`);
  return new Set(options.map(option => String(isObject(option) ? option.value : option)));
}

function prepareField(declaration, family = null) {
  const key = declaration.key;
  const name = family ? `${family.key}.${key}` : key;
  const type = declaration.type;
  const custom = type === 'custom';
  if (!custom && !Object.hasOwn(OPERATORS, type))
    throw new TypeError(`El campo «${name}» tiene un tipo desconocido: ${type}.`);
  const available = custom ? declaration.ops : OPERATORS[type];
  if (!Array.isArray(available) || !available.length)
    throw new TypeError(`El campo «${name}» es de tipo propio y debe declarar sus operadores («ops»).`);
  const ops = declaration.ops ?? available;
  const stranger = ops.find(op => !available.includes(op));
  if (stranger !== undefined)
    throw new TypeError(`El campo «${name}» declara un operador que su tipo no tiene: ${stranger}.`);
  const sql = declaration.sql;
  if (custom) {
    if (typeof declaration.test !== 'function') throw new TypeError(`El campo «${name}» necesita su función «test».`);
    if (sql !== undefined && typeof sql !== 'function')
      throw new TypeError(`«sql» del campo «${name}» debe ser una función.`);
  } else if (type === 'list') {
    if (sql !== undefined && !(isObject(sql) && sqlText(sql.from) && sqlText(sql.where) && sqlText(sql.value)))
      throw new TypeError(`«sql» del campo «${name}» debe ser {from, where, value}: de dónde salen sus valores.`);
  } else if (sql !== undefined && !sqlText(sql))
    throw new TypeError(`«sql» del campo «${name}» debe ser una expresión SQL.`);
  if (declaration.sqlNorm !== undefined && !(type === 'text' && sqlText(sql) && sqlText(declaration.sqlNorm)))
    throw new TypeError(`«sqlNorm» del campo «${name}» sólo vale en un campo de texto que también declare «sql».`);
  const read = declaration.read ?? (family ? record => own(own(record, family.key), key) : record => record?.[key]);
  if (typeof read !== 'function') throw new TypeError(`«read» del campo «${name}» debe ser una función.`);
  return Object.freeze({
    key,
    family: family ? family.key : null,
    type,
    label: String(declaration.label ?? key),
    ops: Object.freeze([...ops]),
    options: optionSet(declaration.options, name),
    maxValues: declaration.maxValues,
    read,
    sql,
    sqlNorm: declaration.sqlNorm,
    test: declaration.test,
    check: declaration.check,
  });
}

// Registro de los campos que una pantalla o un módulo ofrece. Cada declaración lleva:
//   key      nombre del campo en las condiciones.
//   type     text | number | date | boolean | choice | list | custom.
//   label    cómo se llama en los mensajes de error (por omisión, la clave).
//   read     cómo se lee de un objeto (por omisión, la propiedad con ese nombre).
//   sql      cómo se escribe en SQL, si el campo se puede consultar. Texto, número, fecha, sí o no y opción: una
//            expresión («c.name»). Lista: {from, where, value} («contact_tag_links l», «l.contact_id = c.id»,
//            «l.tag_id»). Tipo propio: una función (regla, {now}) → {sql, params}.
//   sqlNorm  (texto) una columna que ya guarda el valor normalizado con `norm`: evita llamar a la función por fila.
//   ops      los operadores que se ofrecen, si no son todos los del tipo. En un tipo propio es obligatorio.
//   options  (opción y lista) los valores admitidos, si son un conjunto cerrado.
// Tipos: un número es un número (un texto que parece número cuenta como vacío, igual en memoria que en SQL); una
// fecha es un instante en milisegundos; «sí o no» es true/false o 1/0; una opción es un identificador de texto que se
// compara tal cual, y una lista, un arreglo de ellos. Un tipo propio trae `test(regla, registro, {now})` y, opcional,
// `check(regla)` → problemas; su SQL debe llevar sus valores como parámetros.
// Una familia agrupa campos que se eligen con `key` en la condición, como los atributos de una marca:
// {key: 'attr', members: {ciudad: {type: 'text', …}}}; `members` también puede ser una función clave → declaración.
export function defineFields(declarations) {
  const list = Array.isArray(declarations)
    ? declarations
    : Object.entries(declarations ?? {}).map(([key, declaration]) => ({ ...declaration, key }));
  const fields = new Map();
  for (const declaration of list) {
    const key = declaration?.key;
    if (typeof key !== 'string' || !key) throw new TypeError('Cada campo necesita una clave («key»).');
    if (fields.has(key)) throw new TypeError(`El campo «${key}» está declarado dos veces.`);
    if (declaration.members === undefined) fields.set(key, prepareField(declaration));
    else if (typeof declaration.members !== 'function' && !isObject(declaration.members))
      throw new TypeError(`«members» de la familia «${key}» debe ser un objeto o una función.`);
    else
      fields.set(key, { key, label: String(declaration.label ?? key), members: declaration.members, ready: new Map() });
  }
  const member = (family, key) => {
    if (typeof family.members === 'function') {
      const declaration = family.members(key);
      return declaration ? prepareField({ ...declaration, key }, family) : null;
    }
    if (!family.ready.has(key) && Object.hasOwn(family.members, key))
      family.ready.set(key, prepareField({ ...family.members[key], key }, family));
    return family.ready.get(key) ?? null;
  };
  const registry = Object.freeze({
    // Campo de una condición: `{field}` o `{problem}` con el motivo.
    find(fieldKey, memberKey) {
      const entry = fields.get(fieldKey);
      if (!entry) return { problem: 'unknown_field' };
      if (!entry.members) return { field: entry };
      if (typeof memberKey !== 'string' || !memberKey) return { problem: 'missing_member', family: entry };
      const field = member(entry, memberKey);
      return field ? { field } : { problem: 'unknown_member', family: entry };
    },
    // Todos los campos conocidos; de una familia con función sólo se sabe que existe.
    all() {
      return [...fields.values()].flatMap(entry => {
        if (!entry.members) return [entry];
        if (typeof entry.members === 'function')
          return [{ key: entry.key, label: entry.label, family: entry.key, open: true }];
        return Object.keys(entry.members).map(key => member(entry, key));
      });
    },
  });
  REGISTRIES.add(registry);
  return registry;
}

const asRegistry = fields => (REGISTRIES.has(fields) ? fields : defineFields(fields));

// Catálogo para armar un constructor de condiciones en pantalla: cada campo con su tipo y sus operadores con
// etiqueta. Una familia con función aparece una sola vez, con `open: true`.
export function describeFields(fields) {
  return asRegistry(fields)
    .all()
    .map(field =>
      field.open
        ? { field: field.key, label: field.label, open: true }
        : {
            field: field.family ?? field.key,
            ...(field.family ? { key: field.key } : {}),
            label: field.label,
            type: field.type,
            ops: field.ops.map(op => ({ op, label: OPERATOR_LABELS[op] ?? op })),
            ...(field.options ? { options: [...field.options] } : {}),
            queryable: field.sql !== undefined,
          },
    );
}

// ---- Lectura de los valores de una condición

const fail = error => ({ error });

// Un número, o un número escrito como texto por un formulario («18», « 18.5 »). El tope de largo es para no ponerse
// a leer una cadena desmedida: ningún número que alguien escriba lo necesita.
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 40) return null;
  return /^\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(value) ? Number(value) : null;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// Instante en milisegundos a partir de un número, de «AAAA-MM-DD» (medianoche UTC) o de una fecha ISO con su zona.
// Una hora sin zona se rechaza: significaría algo distinto en cada servidor.
function instant(value) {
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= MAX_INSTANT ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const day = ISO_DAY.exec(text);
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const at = new Date(Date.UTC(year, month - 1, date));
    const real = at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === date;
    return real ? at.getTime() : null;
  }
  const at = ISO_INSTANT.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(at) ? at : null;
}

function oneText(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') return fail('escribe el texto a comparar.');
  const text = String(value).trim();
  if (!text) return fail('escribe el texto a comparar.');
  if (text.length > maxLength) return fail(`el texto admite hasta ${maxLength} caracteres.`);
  const needle = normalizeText(text);
  return needle ? { text, needle } : fail('el texto necesita al menos una letra o un número.');
}

// Lista de textos sin repetir (se comparan ya normalizados). Admite un texto suelto.
function textList(value, maxCount, maxLength) {
  const items = Array.isArray(value) ? value : [value];
  if (!items.length || value === undefined || value === null) return fail('indica al menos un valor.');
  if (items.length > maxCount) return fail(`admite hasta ${maxCount} valores.`);
  const texts = [];
  const needles = [];
  for (const item of items) {
    const one = oneText(item, maxLength);
    if (one.error) return one;
    if (needles.includes(one.needle)) continue;
    texts.push(one.text);
    needles.push(one.needle);
  }
  return { texts, needles };
}

// Identificadores (opciones, etiquetas): se comparan tal cual, sin normalizar.
function idList(value, field, maxCount, maxLength, single) {
  const items = single ? [value] : value;
  if (!Array.isArray(items) || !items.length) return fail(single ? 'elige un valor.' : 'elige al menos un valor.');
  if (items.length > maxCount) return fail(`admite hasta ${maxCount} valores.`);
  const ids = [];
  for (const item of items) {
    const id = typeof item === 'number' && Number.isFinite(item) ? String(item) : item;
    if (typeof id !== 'string' || !id) return fail(single ? 'elige un valor.' : 'cada valor debe ser un texto.');
    if (id.length > maxLength) return fail(`cada valor admite hasta ${maxLength} caracteres.`);
    if (field.options && !field.options.has(id)) return fail(`«${id}» no es una opción de este campo.`);
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
}

function range(value, read, problem) {
  const from = read(own(value, 'from'));
  const to = read(own(value, 'to'));
  if (from === null || to === null) return fail(problem);
  return from > to ? fail('«desde» no puede ser mayor que «hasta».') : { from, to };
}

const PARSERS = {
  text(rule, field, limits) {
    const { op } = rule;
    if (op === 'keyword') {
      const mode = rule.mode ?? 'contains';
      if (!KEYWORD_MODES.includes(mode)) return fail('el modo de la palabra clave debe ser exact, contains o fuzzy.');
      const words = textList(rule.value, limits.maxWords, limits.maxWordLength);
      if (words.error) return words;
      const threshold = mode === 'fuzzy' ? (rule.threshold ?? limits.defaultThreshold) : undefined;
      if (
        mode === 'fuzzy' &&
        !(Number.isInteger(threshold) && threshold >= limits.minThreshold && threshold <= limits.maxThreshold)
      )
        return fail(`el parecido debe ser un número entero entre ${limits.minThreshold} y ${limits.maxThreshold}.`);
      return {
        canonical: { mode, value: words.texts, ...(mode === 'fuzzy' ? { threshold } : {}) },
        data: { mode, needles: words.needles, threshold },
      };
    }
    if (op === 'in' || op === 'not_in') {
      const list = textList(rule.value, field.maxValues ?? limits.maxValues, limits.maxTextLength);
      return list.error ? list : { canonical: { value: list.texts }, data: { needles: list.needles } };
    }
    const one = oneText(rule.value, limits.maxTextLength);
    return one.error ? one : { canonical: { value: one.text }, data: { needle: one.needle } };
  },
  number(rule) {
    if (rule.op === 'between') {
      const span = range(rule.value, finiteNumber, 'indica «desde» y «hasta» como números.');
      return span.error ? span : { canonical: { value: span }, data: span };
    }
    const value = finiteNumber(rule.value);
    return value === null ? fail('el valor debe ser un número.') : { canonical: { value }, data: { value } };
  },
  date(rule, field, limits) {
    const { op } = rule;
    if (op === 'in_last_days' || op === 'not_in_last_days') {
      const days = finiteNumber(rule.value);
      if (!Number.isInteger(days) || days < 1 || days > limits.maxDays)
        return fail(`los días deben ser un número entero entre 1 y ${limits.maxDays}.`);
      return { canonical: { value: days }, data: { days } };
    }
    const problem = 'la fecha debe ser AAAA-MM-DD, una fecha ISO con zona horaria o un instante en milisegundos.';
    if (op === 'between') {
      const span = range(rule.value, instant, problem);
      return span.error ? span : { canonical: { value: { from: rule.value.from, to: rule.value.to } }, data: span };
    }
    const value = instant(rule.value);
    return value === null ? fail(problem) : { canonical: { value: rule.value }, data: { value } };
  },
  boolean(rule) {
    const value =
      rule.value === true || rule.value === 1 ? true : rule.value === false || rule.value === 0 ? false : null;
    return value === null
      ? fail('el valor debe ser sí (true) o no (false).')
      : { canonical: { value }, data: { value } };
  },
  choice(rule, field, limits) {
    const single = rule.op === 'eq' || rule.op === 'neq';
    const list = idList(rule.value, field, field.maxValues ?? limits.maxValues, limits.maxTextLength, single);
    if (list.error) return list;
    return single
      ? { canonical: { value: list.ids[0] }, data: { value: list.ids[0] } }
      : { canonical: { value: list.ids }, data: { ids: list.ids } };
  },
  list(rule, field, limits) {
    const list = idList(rule.value, field, field.maxValues ?? limits.maxValues, limits.maxTextLength, false);
    return list.error ? list : { canonical: { value: list.ids }, data: { ids: list.ids } };
  },
};

function prepareRule(rule, registry, limits, where) {
  if (!isObject(rule)) return { problem: `${where}: no es una condición válida.` };
  if (typeof rule.field !== 'string' || !rule.field) return { problem: `${where}: falta el campo.` };
  const found = registry.find(rule.field, rule.key);
  if (found.problem === 'unknown_field') return { problem: `${where}: el campo «${rule.field}» no existe.` };
  if (found.problem === 'missing_member')
    return { problem: `${where}: falta indicar qué dato de «${found.family.label}» se compara («key»).` };
  if (found.problem === 'unknown_member')
    return { problem: `${where}: el dato «${rule.key}» no existe o ya no está disponible.` };
  const { field } = found;
  const here = `${where} («${field.label}»)`;
  if (typeof rule.op !== 'string' || !rule.op) return { problem: `${here}: falta el operador («op»).` };
  if (!field.ops.includes(rule.op)) {
    const allowed = field.ops.join(', ');
    return { problem: `${here}: el operador «${rule.op}» no se puede usar con este campo. Usa uno de: ${allowed}.` };
  }
  const address = field.family ? { field: rule.field, key: rule.key } : { field: rule.field };
  if (field.type === 'custom') {
    let canonical;
    try {
      canonical = JSON.parse(JSON.stringify(rule));
    } catch {
      return { problem: `${here}: la condición no se puede guardar.` };
    }
    const problems = [field.check ? field.check(canonical) : []].flat().filter(Boolean);
    return problems.length
      ? { problem: `${here}: ${problems[0]}` }
      : { rule: { field, op: rule.op, data: null, canonical } };
  }
  if (rule.op === 'empty' || rule.op === 'not_empty')
    return { rule: { field, op: rule.op, data: null, canonical: { ...address, op: rule.op } } };
  const parsed = PARSERS[field.type](rule, field, limits);
  if (parsed.error) return { problem: `${here}: ${parsed.error}` };
  return {
    rule: { field, op: rule.op, data: parsed.data, canonical: { ...address, op: rule.op, ...parsed.canonical } },
  };
}

const MATCHES = ['any', 'all'];

// Revisa la definición entera y la deja lista para evaluar. Nunca lanza: devuelve los problemas encontrados.
function prepare(definition, fields, options = {}) {
  const registry = asRegistry(fields);
  const limits = { ...LIMITS, ...options.limits };
  const result = { problems: [], match: 'any', groups: [] };
  const { problems } = result;
  if (definition === null || definition === undefined) return result;
  if (!isObject(definition)) {
    problems.push('Las condiciones deben ser un objeto con sus grupos («groups»).');
    return result;
  }
  if (definition.version !== undefined && definition.version !== 1)
    problems.push(`No se reconoce la versión ${definition.version} de las condiciones: se esperaba la 1.`);
  if (definition.match === undefined || MATCHES.includes(definition.match)) result.match = definition.match ?? 'any';
  else problems.push('«match» debe ser "any" (basta que se cumpla un grupo) o "all" (todos los grupos).');
  const groups = definition.groups ?? [];
  if (!Array.isArray(groups)) {
    problems.push('«groups» debe ser una lista de grupos.');
    return result;
  }
  if (groups.length > limits.maxGroups)
    problems.push(`Hay ${groups.length} grupos de condiciones y el máximo es ${limits.maxGroups}.`);
  // Lo que pasa del tope ya quedó anotado como problema: no se sigue leyendo, para no trabajar de más con una
  // definición desmedida.
  groups.slice(0, limits.maxGroups).forEach((group, index) => {
    const ready = prepareGroup(group, `Grupo ${index + 1}`, registry, limits, problems);
    // Un grupo sin condiciones no decide nada: se ignora, igual que una definición sin grupos.
    if (ready.rules.length) result.groups.push(ready);
  });
  return result;
}

function prepareGroup(group, label, registry, limits, problems) {
  const ready = { match: 'all', rules: [] };
  if (!isObject(group)) {
    problems.push(`${label}: no es un grupo válido.`);
    return ready;
  }
  if (group.match === undefined || MATCHES.includes(group.match)) ready.match = group.match ?? 'all';
  else problems.push(`${label}: «match» debe ser "all" (todas las condiciones) o "any" (alguna).`);
  const rules = group.rules ?? [];
  if (!Array.isArray(rules)) {
    problems.push(`${label}: «rules» debe ser una lista de condiciones.`);
    return ready;
  }
  if (rules.length > limits.maxRules)
    problems.push(`${label}: tiene ${rules.length} condiciones y el máximo es ${limits.maxRules}.`);
  rules.slice(0, limits.maxRules).forEach((rule, index) => {
    const prepared = prepareRule(rule, registry, limits, `${label}, condición ${index + 1}`);
    if (prepared.problem) problems.push(prepared.problem);
    else ready.rules.push(prepared.rule);
  });
  return ready;
}

function invalid(problems) {
  const more = problems.length > 1 ? ` (y ${problems.length - 1} más)` : '';
  return Object.assign(new Error(problems[0] + more), {
    name: 'ConditionsError',
    code: 'invalid_conditions',
    status: 400,
    problems,
  });
}

function prepareOrThrow(definition, fields, options) {
  const prepared = prepare(definition, fields, options);
  if (prepared.problems.length) throw invalid(prepared.problems);
  return prepared;
}

// Lista de problemas de una definición, en palabras de quien la arma; vacía si se puede guardar. Con `{sql: true}`
// también exige que todos sus campos se puedan consultar. `limits` cambia los topes (véase LIMITS).
export function validate(definition, fields, options = {}) {
  const prepared = prepare(definition, fields, options);
  const problems = [...prepared.problems];
  const limits = { ...LIMITS, ...options.limits };
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(definition ?? null), 'utf8');
  } catch {
    problems.push('Las condiciones no se pueden guardar: no son datos simples.');
  }
  if (size > limits.maxBytes)
    problems.push(`Las condiciones ocupan demasiado: el máximo es ${Math.floor(limits.maxBytes / 1024)} KB.`);
  if (options.sql)
    for (const group of prepared.groups)
      for (const rule of group.rules)
        if (rule.field.sql === undefined) {
          const text = `El campo «${rule.field.label}» no se puede usar en una consulta: sólo se evalúa en memoria.`;
          if (!problems.includes(text)) problems.push(text);
        }
  return problems;
}

// La definición en su forma canónica (versión, `match` explícito, valores limpios y sin repetidos, sin grupos
// vacíos), lista para guardar. Lanza un error con `problems` si no es válida.
export function normalize(definition, fields, options) {
  const prepared = prepareOrThrow(definition, fields, options);
  return {
    version: 1,
    match: prepared.match,
    groups: prepared.groups.map(group => ({ match: group.match, rules: group.rules.map(rule => rule.canonical) })),
  };
}

// ---- Evaluación en memoria

const blank = raw => raw === null || raw === undefined || !/\S/.test(String(raw));

function clock(now) {
  const at = now instanceof Date ? now.getTime() : now;
  if (typeof at !== 'number' || !Number.isFinite(at))
    throw new TypeError('Las condiciones de «últimos N días» necesitan la fecha de referencia («now»).');
  return at;
}

const TESTS = {
  text({ op, data }, raw) {
    if (op === 'empty') return blank(raw);
    if (op === 'not_empty') return !blank(raw);
    const text = normalizeText(raw);
    if (op === 'eq') return text === data.needle;
    if (op === 'neq') return text !== data.needle;
    if (op === 'contains') return containsWords(text, data.needle);
    if (op === 'not_contains') return !containsWords(text, data.needle);
    if (op === 'starts_with') return text.startsWith(data.needle);
    if (op === 'not_starts_with') return !text.startsWith(data.needle);
    if (op === 'in') return data.needles.includes(text);
    if (op === 'not_in') return !data.needles.includes(text);
    return keywordHit(text, data.needles, data.mode, data.threshold);
  },
  number({ op, data }, raw) {
    const value = typeof raw === 'bigint' ? Number(raw) : raw;
    const known = typeof value === 'number' && Number.isFinite(value);
    if (op === 'empty') return !known;
    if (op === 'not_empty') return known;
    if (op === 'neq') return !(known && value === data.value);
    if (!known) return false;
    if (op === 'eq') return value === data.value;
    if (op === 'gt') return value > data.value;
    if (op === 'gte') return value >= data.value;
    if (op === 'lt') return value < data.value;
    if (op === 'lte') return value <= data.value;
    return value >= data.from && value <= data.to;
  },
  date({ op, data }, raw, now) {
    const value = raw instanceof Date ? raw.getTime() : typeof raw === 'bigint' ? Number(raw) : raw;
    const known = typeof value === 'number' && Number.isFinite(value);
    if (op === 'empty') return !known;
    if (op === 'not_empty') return known;
    if (op === 'neq') return !(known && value === data.value);
    if (op === 'in_last_days' || op === 'not_in_last_days') {
      const at = clock(now);
      return (known && value >= at - data.days * DAY && value <= at) === (op === 'in_last_days');
    }
    if (!known) return false;
    if (op === 'eq') return value === data.value;
    if (op === 'before') return value < data.value;
    if (op === 'after') return value > data.value;
    return value >= data.from && value <= data.to;
  },
  boolean({ op, data }, raw) {
    const value =
      raw === true || raw === 1 || raw === 1n ? true : raw === false || raw === 0 || raw === 0n ? false : null;
    if (op === 'empty') return value === null;
    if (op === 'not_empty') return value !== null;
    return value === data.value;
  },
  choice({ op, data }, raw) {
    const value = raw === null || raw === undefined || raw === '' ? null : String(raw);
    if (op === 'empty') return value === null;
    if (op === 'not_empty') return value !== null;
    if (op === 'eq') return value === data.value;
    if (op === 'neq') return value !== data.value;
    return (value !== null && data.ids.includes(value)) === (op === 'in');
  },
  list({ op, data }, raw) {
    const items = Array.isArray(raw) ? raw : raw instanceof Set ? [...raw] : [];
    if (op === 'empty') return items.length === 0;
    if (op === 'not_empty') return items.length > 0;
    const members = new Set(items.filter(item => item !== null && item !== undefined).map(String));
    if (op === 'all') return data.ids.every(id => members.has(id));
    return data.ids.some(id => members.has(id)) === (op === 'any');
  },
};

function test(rule, record, now) {
  if (rule.field.type === 'custom') return Boolean(rule.field.test(rule.canonical, record, { now }));
  return TESTS[rule.field.type](rule, rule.field.read(record), now);
}

function run(prepared, record, now) {
  if (!prepared.groups.length) return true;
  const passes = group =>
    group.match === 'all'
      ? group.rules.every(rule => test(rule, record, now))
      : group.rules.some(rule => test(rule, record, now));
  return prepared.match === 'all' ? prepared.groups.every(passes) : prepared.groups.some(passes);
}

// ¿El registro cumple la definición? Sin condiciones, siempre. `now` (milisegundos o Date) sólo hace falta para las
// condiciones de «últimos N días». Lanza un error con `problems` si la definición no es válida: una regla o un
// segmento que ya no se entiende no debe pasar por cumplido ni por incumplido.
export function evaluate(definition, record, fields, now) {
  return run(prepareOrThrow(definition, fields), record, now);
}

// Lo mismo, preparado una vez para muchos registros: devuelve `(registro, now) → sí o no`.
export function matcher(definition, fields) {
  const prepared = prepareOrThrow(definition, fields);
  return (record, now) => run(prepared, record, now);
}

// ---- Compilación a SQL

export const SQL_NORM = 'cond_norm';
export const SQL_FUZZY = 'cond_fuzzy';

// Funciones que la conexión debe tener registradas para ejecutar lo que produce `compile`: la normalización de texto
// y la palabra clave «parecida», que SQLite no trae. Son las mismas funciones que usa `evaluate`.
export const SQL_FUNCTIONS = Object.freeze({
  [SQL_NORM]: value => normalizeText(value),
  [SQL_FUZZY]: (text, words, threshold) =>
    keywordHit(normalizeText(text), JSON.parse(words), 'fuzzy', Number(threshold)) ? 1 : 0,
});

export function registerSqlFunctions(db) {
  for (const [name, fn] of Object.entries(SQL_FUNCTIONS)) db.function(name, { deterministic: true }, fn);
  return db;
}

// Los caracteres que JavaScript cuenta como espacio en blanco. Van como parámetro de `trim()` para que «vacío»
// signifique lo mismo en SQL que en memoria. Se construyen: varios son invisibles y no deben ir escritos en el código.
const WHITESPACE = String.fromCharCode(
  ...[9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff],
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
);

const marks = count => Array.from({ length: count }, () => '?').join(', ');
const numeric = sql => `typeof(${sql}) IN ('integer', 'real')`;
const COMPARE = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=', before: '<', after: '>' };

// Cada constructor devuelve un predicado que vale 0 o 1, nunca NULL, y añade sus valores a `params` en el mismo orden
// en que aparecen sus «?».
const BUILDERS = {
  text({ field, op, data }, params) {
    const raw = field.sql;
    if (op === 'empty' || op === 'not_empty') {
      params.push(WHITESPACE);
      return `(trim(COALESCE(${raw}, ''), ?) ${op === 'empty' ? '=' : '<>'} '')`;
    }
    const text = field.sqlNorm ? `COALESCE(${field.sqlNorm}, '')` : `${SQL_NORM}(${raw})`;
    const padded = `' ' || ${text} || ' '`;
    const whole = needle => {
      params.push(` ${needle} `);
      return `instr(${padded}, ?) > 0`;
    };
    if (op === 'keyword' && data.mode === 'fuzzy') {
      params.push(JSON.stringify(data.needles), data.threshold);
      return `(${SQL_FUZZY}(${raw}, ?, ?) = 1)`;
    }
    if (op === 'keyword' && data.mode === 'contains') return `(${data.needles.map(whole).join(' OR ')})`;
    if (op === 'in' || op === 'not_in' || op === 'keyword') {
      params.push(...data.needles);
      return `(${text} ${op === 'not_in' ? 'NOT IN' : 'IN'} (${marks(data.needles.length)}))`;
    }
    if (op === 'contains') return `(${whole(data.needle)})`;
    if (op === 'not_contains') return `(NOT (${whole(data.needle)}))`;
    params.push(data.needle);
    if (op === 'eq') return `(${text} = ?)`;
    if (op === 'neq') return `(${text} <> ?)`;
    return op === 'starts_with' ? `(instr(${text}, ?) = 1)` : `(instr(${text}, ?) <> 1)`;
  },
  number({ field, op, data }, params) {
    const raw = field.sql;
    if (op === 'empty') return `(NOT (${numeric(raw)}))`;
    if (op === 'not_empty') return `(${numeric(raw)})`;
    if (op === 'between') {
      params.push(data.from, data.to);
      return `(${numeric(raw)} AND ${raw} >= ? AND ${raw} <= ?)`;
    }
    params.push(data.value);
    return op === 'neq' ? `(NOT (${numeric(raw)} AND ${raw} = ?))` : `(${numeric(raw)} AND ${raw} ${COMPARE[op]} ?)`;
  },
  date(rule, params, now) {
    const { field, op, data } = rule;
    if (op !== 'in_last_days' && op !== 'not_in_last_days') return BUILDERS.number(rule, params);
    const at = clock(now);
    params.push(at - data.days * DAY, at);
    const recent = `${numeric(field.sql)} AND ${field.sql} >= ? AND ${field.sql} <= ?`;
    return op === 'in_last_days' ? `(${recent})` : `(NOT (${recent}))`;
  },
  boolean({ field, op, data }, params) {
    const raw = field.sql;
    if (op === 'empty') return `(NOT (${numeric(raw)} AND ${raw} IN (0, 1)))`;
    if (op === 'not_empty') return `(${numeric(raw)} AND ${raw} IN (0, 1))`;
    params.push(data.value ? 1 : 0);
    return `(${numeric(raw)} AND ${raw} = ?)`;
  },
  choice({ field, op, data }, params) {
    const raw = field.sql;
    if (op === 'empty') return `(${raw} IS NULL OR ${raw} = '')`;
    if (op === 'not_empty') return `(${raw} IS NOT NULL AND ${raw} <> '')`;
    const ids = data.ids ?? [data.value];
    params.push(...ids);
    const found = `${raw} IS NOT NULL AND ${raw} IN (${marks(ids.length)})`;
    return op === 'eq' || op === 'in' ? `(${found})` : `(NOT (${found}))`;
  },
  list({ field, op, data }, params) {
    const { from, where, value } = field.sql;
    const rows = `SELECT 1 FROM ${from} WHERE (${where})`;
    if (op === 'empty') return `(NOT EXISTS (${rows}))`;
    if (op === 'not_empty') return `(EXISTS (${rows}))`;
    params.push(...data.ids);
    const among = `${value} IN (${marks(data.ids.length)})`;
    if (op === 'any') return `(EXISTS (${rows} AND ${among}))`;
    if (op === 'none') return `(NOT EXISTS (${rows} AND ${among}))`;
    params.push(data.ids.length);
    return `((SELECT COUNT(DISTINCT ${value}) FROM ${from} WHERE (${where}) AND ${among}) = ?)`;
  },
};

function build(rule, params, now) {
  const { field } = rule;
  if (field.sql === undefined)
    throw Object.assign(
      new Error(`El campo «${field.label}» no se puede usar en una consulta: sólo se evalúa en memoria.`),
      {
        name: 'ConditionsError',
        code: 'not_compilable',
        status: 400,
      },
    );
  if (field.type !== 'custom') return BUILDERS[field.type](rule, params, now);
  const built = field.sql(rule.canonical, { now });
  if (!isObject(built) || !sqlText(built.sql))
    throw new TypeError(`«sql» del campo «${field.label}» debe devolver {sql, params}.`);
  params.push(...(built.params ?? []));
  // Lo que escribe otro módulo podría valer NULL: aquí se fuerza a sí o no.
  return `(COALESCE((${built.sql}), 0) <> 0)`;
}

// La definición como condición de un WHERE de SQLite: `{sql, params}`. Todo valor de la definición va en `params`
// (parámetros «?» en orden); en `sql` sólo hay expresiones declaradas en el registro de campos. Sin condiciones
// devuelve «1». La conexión necesita `registerSqlFunctions`. Con los mismos datos, las filas que selecciona son las
// que `evaluate` da por buenas.
export function compile(definition, fields, { now } = {}) {
  const prepared = prepareOrThrow(definition, fields);
  const params = [];
  const groups = prepared.groups.map(group => {
    const parts = group.rules.map(rule => build(rule, params, now));
    return parts.length === 1 ? parts[0] : `(${parts.join(group.match === 'all' ? ' AND ' : ' OR ')})`;
  });
  if (!groups.length) return { sql: '1', params };
  return {
    sql: groups.length === 1 ? groups[0] : `(${groups.join(prepared.match === 'all' ? ' AND ' : ' OR ')})`,
    params,
  };
}
