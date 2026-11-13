import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPhone, phoneKey, displayPhone, maskPhone, DEFAULT_COUNTRY } from '../server/lib/identity-keys.mjs';

// Los caracteres invisibles se construyen: escritos tal cual no pasarían la puerta de codificación del repositorio.
const chr = String.fromCharCode;
const NBSP = chr(0xa0);
const NARROW_NBSP = chr(0x202f);
const ZERO_WIDTH = chr(0x200b);
const LEFT_TO_RIGHT = chr(0x202a);
const POP_DIRECTION = chr(0x202c);
const HARD_HYPHEN = chr(0x2011);
const EN_DASH = chr(0x2013);

const MX = '525512345678';

// Generador con semilla: las pruebas con datos al azar dan siempre lo mismo.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('tabla de casos del diseño de identidad: todas las formas de un número de México dan la misma clave', () => {
  const cases = [
    // Los casos de la comprobación del hallazgo 2 (identidad) y de H1 (difusiones).
    ['+5215512345678', 'identificador de WhatsApp con «+»: antes conservaba el 1'],
    ['5215512345678', 'identificador de WhatsApp tal como llega de Meta'],
    ['5512345678', 'diez dígitos capturados a mano'],
    ['525512345678', 'con país y sin «+»'],
    ['+525512345678', 'E.164'],
    ['+52 55 1234 5678', 'con espacios (prueba de la API de escritura)'],
    ['+52 1 55 1234 5678', 'con el 1 y espacios'],
    ['52 55 1234 5678', 'con país, sin «+» y con espacios'],
    ['521 55 1234 5678', 'con país y 1, sin «+»'],
    ['55 1234 5678', 'nacional con espacios'],
    ['(55) 1234-5678', 'paréntesis y guion'],
    ['55-1234-5678', 'guiones'],
    ['55.1234.5678', 'puntos'],
    ['55/1234/5678', 'diagonales'],
    ['0052 55 1234 5678', 'prefijo internacional 00'],
    ['00 52 1 55 1234 5678', '00, país y 1'],
    ['044 55 1234 5678', 'celular marcado desde fijo local (forma anterior a 2019)'],
    ['045 55 1234 5678', 'celular marcado desde fijo foráneo (forma anterior a 2019)'],
    ['01 55 1234 5678', 'larga distancia nacional (forma anterior a 2019)'],
    ['  5512345678  ', 'espacios alrededor'],
    [5512345678, 'número, no texto'],
    [525512345678n, 'entero grande'],
    ['5512345678.0', 'una hoja de cálculo lo guardó con decimales'],
    [`55${NBSP}1234${NBSP}5678`, 'espacios duros'],
    [`+52${NARROW_NBSP}55${NARROW_NBSP}1234${NARROW_NBSP}5678`, 'espacios duros estrechos'],
    [`55${HARD_HYPHEN}1234${EN_DASH}5678`, 'guiones tipográficos'],
    [`${LEFT_TO_RIGHT}+52 1 55 1234 5678${POP_DIRECTION}`, 'copiado de WhatsApp, con marcas de dirección'],
    [`55${ZERO_WIDTH}1234${ZERO_WIDTH}5678`, 'con espacios de ancho cero'],
  ];
  for (const [input, why] of cases) {
    const result = canonicalPhone(input);
    assert.deepEqual(
      { ...result },
      { key: MX, e164: '+' + MX, country: '52', national: '5512345678', reason: null, message: null },
      `${why}: ${String(input)}`,
    );
    assert.equal(phoneKey(input), MX, why);
  }
});

test('lo que hoy acepta normalizePhone sigue dando el mismo teléfono, salvo el 1 de México', () => {
  // Casos de test/persons.test.mjs: `normalizePhone` va a delegar aquí y esa prueba debe seguir pasando.
  const legacy = [
    ['5512345678', '+525512345678'],
    ['55 1234 5678', '+525512345678'],
    ['+52 55 1234 5678', '+525512345678'],
    ['52 55 1234 5678', '+525512345678'],
    ['521 55 1234 5678', '+525512345678'],
    ['044 55 1234 5678', '+525512345678'],
    ['0052 55 1234 5678', '+525512345678'],
    ['+1 (415) 555-2671', '+14155552671'],
    ['123', null],
    ['', null],
    ['abc', null],
    ['+1', null],
  ];
  for (const [input, want] of legacy) assert.equal(canonicalPhone(input).e164, want, input);
  assert.equal(canonicalPhone('3001234567', { defaultCountry: '57' }).e164, '+573001234567');
  // La diferencia buscada: con «+» delante ya no se conserva el 1.
  assert.equal(canonicalPhone('+5215512345678').e164, '+525512345678');
});

test('números de otros países: con «+», con 00 y sin «+» como los entrega el proveedor actual', () => {
  const cases = [
    ['+1 (415) 555-2671', '14155552671', '1', '4155552671'],
    ['14155552671', '14155552671', '1', '4155552671'],
    ['0014155552671', '14155552671', '1', '4155552671'],
    ['1 415 555 2671', '14155552671', '1', '4155552671'],
    ['+34 612 345 678', '34612345678', '34', '612345678'],
    ['34612345678', '34612345678', '34', '612345678'],
    ['0034612345678', '34612345678', '34', '612345678'],
    ['+57 300 123 4567', '573001234567', '57', '3001234567'],
    ['573001234567', '573001234567', '57', '3001234567'],
    ['+502 5555 1234', '50255551234', '502', '55551234'],
    ['50255551234', '50255551234', '502', '55551234'],
    ['+44 20 7946 0958', '442079460958', '44', '2079460958'],
    ['+7 912 345 67 89', '79123456789', '7', '9123456789'],
    ['+54 9 11 2345 6789', '5491123456789', '54', '91123456789'],
    ['+290 51234', '29051234', '290', '51234'],
    ['+593 99 123 4567', '593991234567', '593', '991234567'],
  ];
  for (const [input, key, country, national] of cases) {
    const result = canonicalPhone(input);
    assert.equal(result.key, key, input);
    assert.equal(result.e164, '+' + key, input);
    assert.equal(result.country, country, input);
    assert.equal(result.national, national, input);
    assert.equal(result.reason, null, input);
  }
});

test('códigos de país: se reconocen los que existen y se rechazan los que nadie tiene asignados', () => {
  const real =
    '1 7 20 27 33 34 39 44 49 51 52 54 55 56 57 58 61 81 86 91 98 212 254 351 353 380 420 502 503 506 507 591 593 595 ' +
    '598 852 880 886 966 971 972 977 998';
  for (const code of real.split(' ')) {
    const national = code === '1' || code === '52' ? '2125550199' : '212555019';
    assert.equal(canonicalPhone(`+${code}${national}`).country, code, code);
  }
  const unassigned = '0 210 214 259 28 292 384 422 671 684 693 80 83 851 87 89 969 978 990 997 999';
  for (const code of unassigned.split(' '))
    assert.equal(canonicalPhone(`+${code}212555019`).reason, 'unknown_country', code);
  // El largo total va de 8 a 15 dígitos (E.164).
  assert.equal(canonicalPhone('+290 5123').reason, 'too_short');
  assert.equal(phoneKey('+290 51234'), '29051234');
  assert.equal(phoneKey('+49 1512 3456 7890 1'), '491512345678901');
  assert.equal(canonicalPhone('+49 1512 3456 7890 12').reason, 'too_long');
});

test('international: los dígitos son el número completo aunque no lleven «+»', () => {
  // Sin la pista, diez dígitos son un número nacional; con ella, el país va delante (Noruega, 47 + 8).
  assert.equal(phoneKey('4712345678'), '524712345678');
  assert.equal(phoneKey('4712345678', { international: true }), '4712345678');
  assert.equal(canonicalPhone('4712345678', { international: true }).country, '47');
  // Lo que entregan Meta y el proveedor actual.
  assert.equal(phoneKey('5215512345678', { international: true }), MX);
  assert.equal(phoneKey('525512345678', { international: true }), MX);
  assert.equal(phoneKey('14155552671', { international: true }), '14155552671');
  assert.equal(phoneKey('+5215512345678', { international: true }), MX);
  // Diez dígitos de México sin su país no son un número completo.
  assert.equal(canonicalPhone('5512345678', { international: true }).country, '55');
  assert.equal(canonicalPhone('2221234567', { international: true }).reason, null);
  assert.equal(canonicalPhone('0123456789', { international: true }).reason, 'unknown_country');
});

test('defaultCountry: el país que se supone cuando el número no trae el suyo', () => {
  assert.equal(DEFAULT_COUNTRY, '52');
  assert.equal(phoneKey('5512345678', { defaultCountry: '52' }), MX);
  assert.equal(phoneKey('5512345678', { defaultCountry: '+52' }), MX);
  assert.equal(phoneKey('5512345678', { defaultCountry: 52 }), MX);
  assert.equal(phoneKey('5512345678', { defaultCountry: undefined }), MX);
  // Estados Unidos y Canadá: diez dígitos nacionales.
  assert.equal(phoneKey('4155552671', { defaultCountry: '1' }), '14155552671');
  assert.equal(phoneKey('14155552671', { defaultCountry: '1' }), '14155552671');
  assert.equal(phoneKey('(415) 555-2671', { defaultCountry: '1' }), '14155552671');
  assert.equal(phoneKey('525512345678', { defaultCountry: '1' }), MX);
  assert.equal(canonicalPhone('415555267', { defaultCountry: '1' }).reason, 'too_short');
  // El archivo del proveedor trae el país en otra columna y el teléfono con o sin él.
  assert.equal(phoneKey('612345678', { defaultCountry: '34' }), '34612345678');
  assert.equal(phoneKey('34612345678', { defaultCountry: '34' }), '34612345678');
  assert.equal(phoneKey('3001234567', { defaultCountry: '57' }), '573001234567');
  assert.equal(phoneKey('573001234567', { defaultCountry: '57' }), '573001234567');
  assert.equal(phoneKey('55551234', { defaultCountry: '502' }), '50255551234');
  // El cero de larga distancia no es parte del número (salvo en Italia).
  assert.equal(phoneKey('0612345678', { defaultCountry: '33' }), '33612345678');
  assert.equal(phoneKey('07911123456', { defaultCountry: '44' }), '447911123456');
  assert.equal(phoneKey('0612345678', { defaultCountry: '39' }), '390612345678');
  // Con «+» o con `international`, el país por omisión no cuenta.
  assert.equal(phoneKey('+34 612 345 678', { defaultCountry: '57' }), '34612345678');
  assert.equal(phoneKey('34612345678', { defaultCountry: '57', international: true }), '34612345678');
  for (const bad of ['MX', '', '0', '999', null])
    assert.equal(canonicalPhone('5512345678', { defaultCountry: bad }).reason, 'invalid_default_country', String(bad));
  assert.equal(phoneKey('+525512345678', { defaultCountry: 'MX' }), MX);
});

test('un teléfono que no sirve devuelve clave nula con su motivo y un mensaje en español', () => {
  const cases = [
    [null, 'empty'],
    [undefined, 'empty'],
    ['', 'empty'],
    ['   ', 'empty'],
    [`${ZERO_WIDTH}${NBSP}`, 'empty'],
    [true, 'invalid_type'],
    [{}, 'invalid_type'],
    [[], 'invalid_type'],
    [['5512345678'], 'invalid_type'],
    ['abc', 'invalid_characters'],
    ['55 1234 5678 ext 12', 'invalid_characters'],
    ['++525512345678', 'invalid_characters'],
    ['52+5512345678', 'invalid_characters'],
    ['5512345678x', 'invalid_characters'],
    ['5.51234567E+9', 'invalid_characters'],
    ['tel:5512345678', 'invalid_characters'],
    [5512345678.5, 'invalid_characters'],
    [-5512345678, 'invalid_characters'],
    [Number.NaN, 'invalid_characters'],
    [Number.POSITIVE_INFINITY, 'invalid_characters'],
    ['+', 'too_short'],
    ['()', 'too_short'],
    ['-', 'too_short'],
    ['123', 'too_short'],
    ['551234567', 'too_short'],
    ['+1', 'too_short'],
    ['+52', 'too_short'],
    ['+52 55 1234 567', 'too_short'],
    ['52551234567', 'too_short'],
    ['+1 415 555 267', 'too_short'],
    ['+34 61', 'too_short'],
    ['+290 5123', 'too_short'],
    ['+0 123', 'too_short'],
    ['+999 12', 'too_short'],
    ['+52 55 1234 56789', 'too_long'],
    ['+5255123456781', 'too_long'],
    ['52155123456789', 'too_long'],
    ['+1 415 555 26711', 'too_long'],
    ['+1 1 415 555 2671', 'too_long'],
    ['55123456789012345678', 'too_long'],
    ['09999999999999999', 'too_long'],
    ['+34 612 345 678 901 23', 'too_long'],
    ['+34 612 345 678 901 234', 'too_long'],
    ['+999 123456789', 'unknown_country'],
    ['+0 123456789', 'unknown_country'],
    ['+800 1234 5678', 'unknown_country'],
    ['05512345678', 'unknown_country'],
    ['0123456789', 'invalid_number'],
    ['1234567890', 'invalid_number'],
    ['+52 0123456789', 'invalid_number'],
    ['+52 1 55 1234 567', 'invalid_number'],
    ['+1 015 555 2671', 'invalid_number'],
  ];
  for (const [input, reason] of cases) {
    const result = canonicalPhone(input);
    assert.equal(result.reason, reason, String(input));
    assert.deepEqual(
      [result.key, result.e164, result.country, result.national],
      [null, null, null, null],
      String(input),
    );
    assert.match(result.message, /^[A-ZÁÉÍÓÚÑ].*\.$/, String(input));
    assert.equal(phoneKey(input), null, String(input));
  }
  // Cada motivo tiene su propio mensaje.
  const messages = new Map(cases.map(([input, reason]) => [reason, canonicalPhone(input).message]));
  assert.equal(new Set(messages.values()).size, messages.size);
});

test('propiedad: cualquier forma de escribir un número de México da 52 más sus diez dígitos', () => {
  const next = random(20261113);
  const digit = (from, to) => String(from + Math.floor(next() * (to - from + 1)));
  for (let round = 0; round < 300; round++) {
    let national = digit(2, 9);
    while (national.length < 10) national += digit(0, 9);
    const key = '52' + national;
    const [a, b, c] = [national.slice(0, 2), national.slice(2, 6), national.slice(6)];
    const forms = [
      national,
      Number(national),
      `${a} ${b} ${c}`,
      `(${a}) ${b}-${c}`,
      `${a}.${b}.${c}`,
      '52' + national,
      '521' + national,
      '+52' + national,
      '+521' + national,
      `+52 ${a} ${b} ${c}`,
      `+52 1 ${a} ${b} ${c}`,
      '0052' + national,
      '00521' + national,
      '044' + national,
      '045' + national,
      '01' + national,
      `${LEFT_TO_RIGHT}+52 1 ${a} ${b} ${c}${POP_DIRECTION}`,
    ];
    for (const form of forms) assert.equal(phoneKey(form), key, String(form));
    assert.equal(phoneKey(key, { international: true }), key);
    assert.equal(phoneKey('521' + national, { international: true }), key);
    // La clave, su forma E.164 y su forma para mostrar vuelven a la misma clave.
    assert.equal(phoneKey(key), key);
    assert.equal(phoneKey(canonicalPhone(key).e164), key);
    assert.equal(phoneKey(displayPhone(key)), key);
  }
});

test('propiedad: una clave válida es estable y nunca conserva separadores', () => {
  const next = random(7);
  const pool = ['1', '34', '44', '57', '502', '593', '54', '55', '49', '81'];
  for (let round = 0; round < 300; round++) {
    const country = pool[Math.floor(next() * pool.length)];
    let national = String(2 + Math.floor(next() * 8));
    const length = country === '1' ? 10 : 8 + Math.floor(next() * 4);
    while (national.length < length) national += String(Math.floor(next() * 10));
    const result = canonicalPhone(`+${country} ${national.slice(0, 3)}-${national.slice(3)}`);
    assert.equal(result.key, country + national);
    assert.match(result.key, /^\d{8,15}$/);
    assert.equal(result.country + result.national, result.key);
    assert.equal(phoneKey(result.e164), result.key);
    assert.equal(phoneKey(result.key, { international: true }), result.key);
    assert.equal(phoneKey(displayPhone(result.key)), result.key);
  }
});

test('el resultado es inmutable y la función no depende de llamadas anteriores', () => {
  const options = Object.freeze({ defaultCountry: '52' });
  const first = canonicalPhone('5512345678', options);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(canonicalPhone('x')));
  canonicalPhone('+34 612 345 678', { defaultCountry: '34', international: true });
  assert.deepEqual(canonicalPhone('5512345678', options), first);
  assert.deepEqual(canonicalPhone('5512345678'), first);
});

test('displayPhone: teléfono completo y legible para quien puede verlo', () => {
  assert.equal(displayPhone('525512345678'), '+52 55 1234 5678');
  assert.equal(displayPhone('525612345678'), '+52 56 1234 5678');
  assert.equal(displayPhone('523312345678'), '+52 33 1234 5678');
  assert.equal(displayPhone('528112345678'), '+52 81 1234 5678');
  assert.equal(displayPhone('522221234567'), '+52 222 123 4567');
  assert.equal(displayPhone('529981234567'), '+52 998 123 4567');
  assert.equal(displayPhone('14155552671'), '+1 415 555 2671');
  // Las claves de dos dígitos son de México: en Estados Unidos y Canadá siempre son tres.
  assert.equal(displayPhone('15512345678'), '+1 551 234 5678');
  assert.equal(displayPhone('18135550199'), '+1 813 555 0199');
  assert.equal(displayPhone('34612345678'), '+34 612345678');
  assert.equal(displayPhone('50255551234'), '+502 55551234');
  assert.equal(displayPhone('+52 55 1234 5678'), '+52 55 1234 5678');
  assert.equal(displayPhone(525512345678), '+52 55 1234 5678');
  // Sin clave no hay nada que mostrar; con una clave que no se reconoce, al menos los dígitos.
  for (const none of ['', null, undefined, 'sin número']) assert.equal(displayPhone(none), '');
  assert.equal(displayPhone('999123456'), '+999123456');
  assert.equal(displayPhone('5215512345678'), '+52 15512345678');
});

test('maskPhone: tres dígitos al inicio, cuatro al final y nunca menos de cuatro ocultos', () => {
  assert.equal(maskPhone('525512345678'), '+525 ••••• 5678');
  assert.equal(maskPhone('5215512345678'), '+521 ••••• 5678');
  assert.equal(maskPhone('14155552671'), '+141 ••••• 2671');
  assert.equal(maskPhone('+52 55 1234 5678'), '+525 ••••• 5678');
  assert.equal(maskPhone('4712345678'), '+47 ••••• 5678');
  assert.equal(maskPhone('291234567'), '+2 ••••• 4567');
  assert.equal(maskPhone('29051234'), '••••• 1234');
  assert.equal(maskPhone('1234567'), '••••• 567');
  assert.equal(maskPhone('12345'), '••••• 5');
  assert.equal(maskPhone('1234'), '•••••');
  assert.equal(maskPhone('12'), '•••••');
  for (const none of ['', null, undefined, 'sin número']) assert.equal(maskPhone(none), '');
  const next = random(99);
  for (let round = 0; round < 200; round++) {
    let key = '';
    const length = 1 + Math.floor(next() * 15);
    while (key.length < length) key += String(Math.floor(next() * 10));
    const masked = maskPhone(key);
    const shown = masked.replace(/\D/g, '');
    assert.ok(shown.length <= Math.max(0, key.length - 4), `${key} → ${masked}`);
    assert.ok(shown.length <= 7, masked);
    assert.equal((masked.match(/•/g) || []).length, 5, masked);
    assert.ok(key.endsWith(masked.split(' ').at(-1).replace(/\D/g, '')), masked);
  }
});
