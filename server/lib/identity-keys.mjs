// Clave canónica de teléfono: la única forma de comparar un teléfono con otro en todo el CRM.
//
// Por qué existe: el mismo número llega escrito de muchas maneras (10 dígitos capturados a mano, «+52 55…» de un
// formulario, «521…» del identificador de WhatsApp, «52…» o un extranjero sin «+» en lo que exporta el proveedor
// actual). Si cada módulo normaliza a su modo, la persona importada y la que escribe por WhatsApp no se reconocen y
// nace un contacto duplicado. Aquí vive una sola regla y lo demás delega en ella.
//
// La clave son sólo dígitos con código de país. México: 52 más 10 dígitos, sin el «1» que WhatsApp intercala después
// del 52. Funciones puras: sin base de datos, sin red y sin estado.

export const DEFAULT_COUNTRY = '52';

// Códigos de país de la UIT (E.164) que identifican un territorio. Ninguno es prefijo de otro, así que basta probar
// con 1, 2 y 3 dígitos. Se dejan fuera los de servicios (800, 870, 881…): no son el teléfono de una persona.
const CALLING_CODES = new Set(
  (
    '1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 ' +
    '81 82 84 86 90 91 92 93 94 95 98 ' +
    '211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 ' +
    '240 241 242 243 244 245 246 247 248 249 250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 ' +
    '268 269 290 291 297 298 299 350 351 352 353 354 355 356 357 358 359 370 371 372 373 374 375 376 377 378 379 ' +
    '380 381 382 383 385 386 387 389 420 421 423 500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 595 ' +
    '596 597 598 599 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 ' +
    '850 852 853 855 856 880 886 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 ' +
    '992 993 994 995 996 998'
  ).split(' '),
);

// Países cuyo número nacional mide siempre 10 dígitos y no empieza con 0 ni con 1: ahí sí se puede decir con certeza
// si faltan o sobran dígitos. Del resto sólo se comprueba el largo total que admite E.164.
const FIXED_COUNTRIES = new Set(['52', '1']);
const FIXED_NATIONAL = /^[2-9]\d{9}$/;
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

// Lo que la gente y las hojas de cálculo ponen entre los dígitos: espacios de cualquier tipo, guiones de cualquier
// tipo, paréntesis, puntos y diagonales.
const SEPARATORS = /[\s().\-/\p{Pd}]/gu;
// Marcas invisibles de dirección y de ancho cero: WhatsApp las pega alrededor del número al copiarlo.
const INVISIBLE = /\p{Cf}/gu;
// «5512345678.0»: la hoja de cálculo guardó el teléfono como número con decimales.
const FLOAT_ARTIFACT = /^\+?\d+\.0+$/;

const MESSAGES = {
  empty: 'Falta el teléfono.',
  invalid_type: 'El teléfono debe escribirse como texto.',
  invalid_characters: 'El teléfono sólo puede llevar dígitos, espacios, guiones, paréntesis y un «+» al inicio.',
  too_short: 'Al teléfono le faltan dígitos: usa 10 dígitos de México o el formato internacional (+52…).',
  too_long: 'El teléfono tiene dígitos de más.',
  unknown_country:
    'No se reconoce el código de país del teléfono. Si es de otro país, escríbelo con «+» y su código de país.',
  invalid_number: 'Ese número no existe: después del código de país van 10 dígitos que no empiezan con 0 ni con 1.',
  invalid_default_country: 'El país por omisión no es un código de país válido.',
};

const failure = reason =>
  Object.freeze({ key: null, e164: null, country: null, national: null, reason, message: MESSAGES[reason] });

function countryOf(digits) {
  for (const size of [1, 2, 3]) {
    const code = digits.slice(0, size);
    if (CALLING_CODES.has(code)) return code;
  }
  return null;
}

// Número escrito sin «+» ni «00»: se decide si es nacional o si ya trae su código de país.
function fromLocal(digits, country) {
  if (!CALLING_CODES.has(country)) return { reason: 'invalid_default_country' };
  if (country === '52') {
    // Formas de marcar que México usó hasta 2019 y todavía aparecen en agendas viejas.
    if (digits.length === 12 && digits.startsWith('01')) return { full: '52' + digits.slice(2) };
    if (digits.length === 13 && /^04[45]/.test(digits)) return { full: '52' + digits.slice(3) };
  }
  // Con el país por delante: el largo exacto se comprueba después, para poder decir si falta o sobra.
  if (digits.startsWith(country) && digits.length > 10) return { full: digits };
  if (FIXED_COUNTRIES.has(country)) {
    if (digits.length === 10) return { full: country + digits };
    // Once dígitos o más no caben en un número nacional: es un número completo de otro país, como los entrega el
    // proveedor actual («14155552671»). Con menos de diez no se puede saber de dónde es.
    if (digits.length > 10 && countryOf(digits)) return { full: digits };
    if (digits.length < 10) return { reason: 'too_short' };
    return { reason: digits.length > MAX_DIGITS ? 'too_long' : 'unknown_country' };
  }
  // Otros países: se toma como número nacional, sin el cero de larga distancia (Italia lo conserva).
  return { full: country + (country !== '39' && digits.startsWith('0') ? digits.slice(1) : digits) };
}

// Devuelve siempre un objeto. Con un teléfono válido: `key` (dígitos con país), `e164` («+» y la clave), `country`
// (código de país), `national` y `reason: null`. Con uno inválido: todo en `null` salvo `reason` (código estable
// para el programa) y `message` (texto para la persona).
//
// `defaultCountry` es el país que se supone cuando el número no trae el suyo. `international: true` es para lo que
// entregan Meta y el proveedor actual: dígitos que ya son el número completo aunque no lleven «+» (sin esa pista,
// diez dígitos se leen como un número nacional).
export function canonicalPhone(input, { defaultCountry = DEFAULT_COUNTRY, international = false } = {}) {
  if (input === null || input === undefined) return failure('empty');
  let raw = input;
  if (typeof raw === 'number' || typeof raw === 'bigint') {
    if (typeof raw === 'number' && !Number.isSafeInteger(raw)) return failure('invalid_characters');
    if (raw < 0) return failure('invalid_characters');
    raw = String(raw);
  }
  if (typeof raw !== 'string') return failure('invalid_type');
  let text = raw.replace(INVISIBLE, '').trim();
  if (!text) return failure('empty');
  if (FLOAT_ARTIFACT.test(text)) text = text.slice(0, text.indexOf('.'));
  const plus = text.startsWith('+');
  let digits = (plus ? text.slice(1) : text).replace(SEPARATORS, '');
  if (/\D/.test(digits)) return failure('invalid_characters');
  if (!digits) return failure('too_short');
  let complete = plus || Boolean(international);
  if (!plus && digits.startsWith('00')) {
    complete = true;
    digits = digits.slice(2);
  }
  let full = digits;
  if (!complete) {
    const local = fromLocal(digits, String(defaultCountry ?? '').replace(/\D/g, ''));
    if (local.reason) return failure(local.reason);
    full = local.full;
  }
  if (full.length > MAX_DIGITS) return failure('too_long');
  const country = countryOf(full);
  if (!country) return failure(full.length < MIN_DIGITS ? 'too_short' : 'unknown_country');
  let national = full.slice(country.length);
  if (FIXED_COUNTRIES.has(country)) {
    // El «1» que WhatsApp pone a los celulares de México después del 52 no forma parte del número.
    if (country === '52' && national.length === 11 && national.startsWith('1')) national = national.slice(1);
    if (national.length < 10) return failure('too_short');
    if (national.length > 10) return failure('too_long');
    if (!FIXED_NATIONAL.test(national)) return failure('invalid_number');
  } else if (full.length < MIN_DIGITS) return failure('too_short');
  const key = country + national;
  return Object.freeze({ key, e164: '+' + key, country, national, reason: null, message: null });
}

// La clave sola, o `null` si el teléfono no sirve. Para una columna `NOT NULL DEFAULT ''`: `phoneKey(x) ?? ''`.
export function phoneKey(input, options) {
  return canonicalPhone(input, options).key;
}

const MX_TWO_DIGIT_AREAS = new Set(['55', '56', '33', '81']);
const digitsOf = key => (key === null || key === undefined ? '' : String(key).replace(/\D/g, ''));

// Teléfono completo para mostrar a quien sí puede verlo: «+52 55 1234 5678».
export function displayPhone(key) {
  const digits = digitsOf(key);
  if (!digits) return '';
  const country = countryOf(digits);
  if (!country) return '+' + digits;
  const national = digits.slice(country.length);
  if (FIXED_COUNTRIES.has(country) && national.length === 10) {
    const area = country === '52' && MX_TWO_DIGIT_AREAS.has(national.slice(0, 2)) ? 2 : 3;
    return `+${country} ${national.slice(0, area)} ${national.slice(area, 6)} ${national.slice(6)}`;
  }
  return `+${country} ${national}`;
}

// Teléfono enmascarado para los roles que no pueden ver números completos: los tres primeros dígitos y los cuatro
// últimos («+525 ••••• 5678»). Nunca deja menos de cuatro dígitos ocultos: con claves cortas enseña menos del inicio,
// para que el número no se pueda reconstruir por tanteo. La cantidad de puntos es fija y no revela el largo.
export function maskPhone(key) {
  const digits = digitsOf(key);
  if (!digits) return '';
  const tail = Math.max(0, Math.min(4, digits.length - 4));
  const head = Math.max(0, Math.min(3, digits.length - 4 - tail));
  return [head ? '+' + digits.slice(0, head) : '', '•••••', tail ? digits.slice(-tail) : ''].filter(Boolean).join(' ');
}
