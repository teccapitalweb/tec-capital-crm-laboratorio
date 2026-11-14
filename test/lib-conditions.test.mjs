import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  LIMITS,
  OPERATORS,
  OPERATOR_LABELS,
  KEYWORD_MODES,
  SQL_NORM,
  SQL_FUZZY,
  SQL_FUNCTIONS,
  normalizeText,
  norm,
  editDistance,
  similarity,
  keywordMatch,
  matchKeyword,
  defineFields,
  describeFields,
  validate,
  normalize,
  evaluate,
  matcher,
  compile,
  registerSqlFunctions,
} from '../server/lib/conditions.mjs';

// La normalización que el diseño manda igualar. Si algún día se retira, esa prueba se salta sola.
const legacyFlows = await import('../server/flows.mjs').catch(() => ({}));

// Los caracteres invisibles se construyen: escritos tal cual no pasarían la puerta de codificación del repositorio.
const chr = String.fromCharCode;
const NBSP = chr(0xa0);
const EM_SPACE = chr(0x2003);
const IDEOGRAPHIC_SPACE = chr(0x3000);
const LINE_SEPARATOR = chr(0x2028);
const BYTE_ORDER_MARK = chr(0xfeff);
const ZERO_WIDTH = chr(0x200b);
const NEXT_LINE = chr(0x85);
const FACE = String.fromCodePoint(0x1f600);

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 13, 18, 0, 0);

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
const pick = (next, list) => list[Math.floor(next() * list.length)];
const some = (next, list, max) => Array.from({ length: 1 + Math.floor(next() * max) }, () => pick(next, list));
const thrown = fn => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};
const one = (field, op, extra = {}) => ({ groups: [{ rules: [{ field, op, ...extra }] }] });

// ---- Texto y palabra clave

test('normalizeText: minúsculas, sin acentos y sin signos; lo que no es letra ni número es un espacio', () => {
  const cases = [
    ['¡Hola, María José! ¿Cómo estás?', 'hola maria jose como estas'],
    ['  CIENCIA   de  Materiales ', 'ciencia de materiales'],
    ['Integridad-de_ductos', 'integridad de ductos'],
    ['año 2026: 1,500 pesos', 'ano 2026 1 500 pesos'],
    ['Niño, ñandú y pingüino', 'nino nandu y pinguino'],
    ['a.b@c.com', 'a b c com'],
    ['línea 1\nlínea 2\tfin', 'linea 1 linea 2 fin'],
    [`uno${NBSP}dos${EM_SPACE}tres${LINE_SEPARATOR}cuatro${ZERO_WIDTH}cinco`, 'uno dos tres cuatro cinco'],
    ['n.º 5 y 3.ª', 'n 5 y 3'],
    [`curso ${FACE} ya`, 'curso ya'],
    [FACE, ''],
    ['¿¡...!?', ''],
    ['', ''],
    ['   ', ''],
    [null, ''],
    [undefined, ''],
    [0, '0'],
    [12.5, '12 5'],
    [true, 'true'],
  ];
  for (const [input, want] of cases) assert.equal(normalizeText(input), want, JSON.stringify(input));
  // Las letras de otros alfabetos se conservan: dos nombres distintos no deben volverse iguales.
  assert.equal(normalizeText('Søren Ørsted'), 'søren ørsted');
  assert.equal(normalizeText('ИВАН Петров'), 'иван петров');
  assert.equal(normalizeText('李雷 和 韩梅梅'), '李雷 和 韩梅梅');
  assert.notEqual(normalizeText('Иван'), normalizeText('Пётр'));
  assert.equal(norm, normalizeText);
});

test('normalizeText: aplicarla dos veces da lo mismo', () => {
  const next = random(1);
  const pieces = [
    'a',
    'Z',
    'ñ',
    'Á',
    'ü',
    'ß',
    'İ',
    'Σ',
    'ς',
    'ǅ',
    '5',
    '½',
    ' ',
    '-',
    '_',
    '.',
    '¿',
    FACE,
    NBSP,
    'й',
    '李',
    'ö',
    '\n',
    "'",
  ];
  for (let round = 0; round < 1000; round++) {
    const text = some(next, pieces, 12).join('');
    const once = normalizeText(text);
    assert.equal(normalizeText(once), once, JSON.stringify(text));
    assert.doesNotMatch(once, /^ | $| {2}|\p{Lu}|\p{M}/u, JSON.stringify(text));
  }
});

test('normalizeText: para el español da lo mismo que la de los botones del flujo', { skip: !legacyFlows.norm }, () => {
  const phrases = [
    '¡Hola! ¿Me das informes del curso de Integridad de Ductos?',
    'SÍ, DESEO INSCRIBIRME',
    'precio: $1,500.00 MXN (hasta el 20/nov)',
  ];
  phrases.push('Ciencia de materiales — edición 2026', 'no, gracias :)', 'pingüino Ñandú_niño', 'a@b.mx  y   c', '');
  for (const phrase of phrases) assert.equal(normalizeText(phrase), legacyFlows.norm(phrase), phrase);
  const next = random(2);
  const alphabet = [...'abcxyzABCXYZ0189áéíóúüñÁÉÍÓÚÜÑ¡!¿?.,;:-_()"\'/@#$%&*+= \t\n'];
  for (let round = 0; round < 2000; round++) {
    const text = some(next, alphabet, 30).join('');
    assert.equal(normalizeText(text), legacyFlows.norm(text), JSON.stringify(text));
  }
});

// Referencia lenta y evidente de la distancia, para comparar la implementación.
function slowDistance(a, b) {
  const memo = new Map();
  const walk = (i, j) => {
    if (i === 0) return j;
    if (j === 0) return i;
    const key = i * 1000 + j;
    if (memo.has(key)) return memo.get(key);
    let best = Math.min(walk(i - 1, j) + 1, walk(i, j - 1) + 1, walk(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, walk(i - 2, j - 2) + 1);
    memo.set(key, best);
    return best;
  };
  return walk(a.length, b.length);
}

test('editDistance y similarity: insertar, borrar, sustituir o intercambiar vecinas cuesta 1', () => {
  const cases = [
    ['', '', 0],
    ['abc', 'abc', 0],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['hidrocaburos', 'hidrocarburos', 1],
    ['hidrocarburso', 'hidrocarburos', 1],
    ['kitten', 'sitting', 3],
    ['abcd', 'acbd', 1],
    ['ab', 'ba', 1],
    ['ca', 'abc', 3],
    ['curso', 'recurso', 2],
    ['a', 'b', 1],
    ['abc', 'xyz', 3],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(editDistance(a, b), want, `${a} · ${b}`);
    assert.equal(editDistance(b, a), want, `${b} · ${a}`);
  }
  assert.equal(similarity('abc', 'abc'), 1);
  assert.equal(similarity('', ''), 1);
  assert.equal(similarity('abc', 'xyz'), 0);
  assert.equal(similarity('abcd', ''), 0);
  assert.equal(similarity('hidrocaburos', 'hidrocarburos'), 12 / 13);
  assert.equal(similarity('abcde', 'abcxy'), 0.6);
  const next = random(3);
  for (let round = 0; round < 1500; round++) {
    const a = some(next, [...'abca '], 9).join('');
    const b = next() < 0.3 ? a : some(next, [...'abcb '], 9).join('');
    const distance = editDistance(a, b);
    assert.equal(distance, slowDistance(a, b), `${a} · ${b}`);
    assert.equal(distance, editDistance(b, a));
    assert.ok(distance >= Math.abs(a.length - b.length) && distance <= Math.max(a.length, b.length));
    assert.equal(distance === 0, a === b);
  }
});

test('palabra clave: no distingue mayúsculas, acentos ni signos', () => {
  for (const mode of KEYWORD_MODES) {
    assert.equal(matchKeyword('INTEGRIDAD DE DUCTOS', ['integridad de ductos'], { mode }), true, mode);
    assert.equal(matchKeyword('¡Integridád de dúctos!', ['Integridad de Ductos'], { mode }), true, mode);
    assert.equal(matchKeyword('integridad-de-ductos', ['INTEGRIDAD DE DUCTOS'], { mode }), true, mode);
  }
  assert.deepEqual(KEYWORD_MODES, ['exact', 'contains', 'fuzzy']);
});

test('palabra clave exacta: el mensaje entero es la clave', () => {
  const exact = (text, words) => matchKeyword(text, words, { mode: 'exact' });
  assert.equal(exact('curso', ['curso']), true);
  assert.equal(exact('  ¿Curso?  ', ['curso']), true);
  assert.equal(exact('el curso', ['curso']), false);
  assert.equal(exact('curso de aves', ['curso']), false);
  assert.equal(exact('cursos', ['curso']), false);
  assert.equal(exact('si', ['sí', 'claro']), true);
  assert.equal(exact('claro que sí', ['sí', 'claro']), false);
});

test('palabra clave contenida: aparece como palabras completas («recurso» no es «curso»)', () => {
  const contains = (text, words) => matchKeyword(text, words, { mode: 'contains' });
  assert.equal(contains('Quiero el curso, por favor', ['curso']), true);
  assert.equal(contains('curso', ['curso']), true);
  assert.equal(contains('un recurso útil', ['curso']), false);
  assert.equal(contains('los cursos', ['curso']), false);
  assert.equal(contains('concurso de baile', ['curso']), false);
  assert.equal(contains('info de integridad de ductos hoy', ['integridad de ductos']), true);
  assert.equal(contains('integridad total de ductos', ['integridad de ductos']), false);
  assert.equal(contains('ductos de integridad', ['integridad de ductos']), false);
  assert.equal(contains('me interesa ductos', ['integridad de ductos', 'ductos']), true);
  assert.equal(
    matchKeyword('Quiero el curso', 'curso'),
    true,
    'contiene es el modo por omisión y admite una sola palabra',
  );
  // No hay límite de palabras en este modo: la clave puede ir al final de un mensaje largo.
  assert.equal(contains('palabra '.repeat(200) + 'ductos', ['ductos']), true);
});

test('palabra clave parecida: tolera errores de dedo según el umbral', () => {
  const fuzzy = (text, words, threshold) => matchKeyword(text, words, { mode: 'fuzzy', threshold });
  // El ejemplo del diseño: falta una letra, 12 de 13 coinciden (92 %).
  assert.equal(fuzzy('quiero info de hidrocaburos por favor', ['hidrocarburos'], 80), true);
  assert.equal(fuzzy('quiero info de hidrocaburos por favor', ['hidrocarburos'], 95), false);
  assert.deepEqual(keywordMatch('info de hidrocaburos', ['ductos', 'hidrocarburos'], { mode: 'fuzzy' }), {
    word: 'hidrocarburos',
    mode: 'fuzzy',
    score: (12 / 13) * 100,
  });
  // La ventana mide una palabra menos, igual o una más que la clave: palabras partidas o pegadas.
  assert.equal(fuzzy('curso de hidro carburos', ['hidrocarburos'], 80), true);
  assert.equal(fuzzy('ciensia de materiales', ['ciencia de materiales'], 80), true);
  assert.equal(fuzzy('cienciade materiales', ['ciencia de materiales'], 80), true);
  assert.equal(fuzzy('materiales', ['ciencia de materiales'], 80), false);
  assert.equal(fuzzy('historia del arte', ['ciencia de materiales'], 60), false);
  // El umbral se cumple justo en el límite: 8 de 10 letras es 80 %.
  assert.equal(fuzzy('abcdefghxy', ['abcdefghij'], 80), true);
  assert.equal(fuzzy('abcdefgxyz', ['abcdefghij'], 80), false);
  assert.equal(fuzzy('abcdefgxyz', ['abcdefghij'], 70), true);
  assert.equal(fuzzy('abcdefgxyz', ['abcdefghij'], 71), false);
  // También cuando lo que falta son letras: 8 de 10, sin ninguna cambiada.
  assert.equal(fuzzy('abcdefgh', ['abcdefghij'], 80), true);
  assert.equal(fuzzy('abcdefg', ['abcdefghij'], 80), false);
  // 80 es el umbral por omisión.
  assert.equal(matchKeyword('abcdefghxy', ['abcdefghij'], { mode: 'fuzzy' }), true);
  assert.equal(matchKeyword('abcdefgxyz', ['abcdefghij'], { mode: 'fuzzy' }), false);
  // Una clave de menos de cuatro letras se compara como palabra completa: «sí» no es «sip» ni «sin».
  assert.equal(fuzzy('sip', ['sí'], 60), false);
  assert.equal(fuzzy('sin duda', ['sí'], 60), false);
  assert.equal(fuzzy('sí, claro', ['sí'], 95), true);
  assert.equal(fuzzy('a b c', ['abc'], 60), false);
  assert.equal(fuzzy('abd', ['abc'], 60), false, 'con tres letras se exige la palabra completa, aunque se parezca');
  assert.equal(fuzzy('abc', ['abc'], 60), true);
  assert.equal(fuzzy('abcd', ['abce'], 75), true, 'con cuatro letras ya se compara por parecido');
  // Sólo se miran las primeras 60 palabras del mensaje.
  assert.equal(fuzzy('palabra '.repeat(59) + 'hidrocaburos', ['hidrocarburos'], 80), true);
  assert.equal(fuzzy('palabra '.repeat(60) + 'hidrocaburos', ['hidrocarburos'], 80), false);
});

test('palabra clave: un texto sin letras nunca coincide y las claves vacías se ignoran', () => {
  for (const mode of KEYWORD_MODES) {
    for (const text of ['', '   ', null, undefined, FACE, '¿?', '...'])
      assert.equal(matchKeyword(text, ['curso', FACE, '?'], { mode }), false);
    assert.equal(matchKeyword('curso', [], { mode }), false);
    assert.equal(matchKeyword('curso', ['', '  ', '¿?', null], { mode }), false);
    assert.equal(matchKeyword('curso', ['', 'curso'], { mode }), true);
    assert.equal(keywordMatch('nada que ver', ['curso'], { mode }), null);
  }
  // Devuelve la primera clave de la lista que coincide, tal como estaba escrita.
  assert.deepEqual(keywordMatch('quiero el CURSO de aves', ['Ductos', 'Curso', 'aves']), {
    word: 'Curso',
    mode: 'contains',
    score: 100,
  });
  assert.deepEqual(keywordMatch('curso', ['Curso'], { mode: 'exact' }), { word: 'Curso', mode: 'exact', score: 100 });
  assert.throws(() => matchKeyword('curso', ['curso'], { mode: 'regex' }), TypeError);
});

// ---- Registro de campos

const STAGES = ['nuevo', 'interesado', 'inscripcion', 'pagado'];

// Los campos de las pruebas: uno de cada tipo, con su lectura en memoria y su forma en SQL (alias «p» = people).
const FIELDS = defineFields([
  { key: 'name', type: 'text', label: 'Nombre', sql: 'p.name' },
  {
    key: 'name_fast',
    type: 'text',
    label: 'Nombre (columna normalizada)',
    read: r => r.name,
    sql: 'p.name',
    sqlNorm: 'p.name_key',
  },
  { key: 'city', type: 'text', label: 'Ciudad', sql: 'p.city' },
  { key: 'note', type: 'text', label: 'Mensaje', sql: 'p.note' },
  { key: 'age', type: 'number', label: 'Edad', sql: 'p.age' },
  { key: 'score', type: 'number', label: 'Puntos', sql: 'p.score' },
  { key: 'created', type: 'date', label: 'Alta', read: r => r.created_at, sql: 'p.created_at' },
  { key: 'last_seen', type: 'date', label: 'Último mensaje', sql: 'p.last_seen' },
  { key: 'vip', type: 'boolean', label: 'Preferente', sql: 'p.vip' },
  { key: 'stage', type: 'choice', label: 'Etapa', options: STAGES, sql: 'p.stage' },
  { key: 'source', type: 'choice', label: 'Origen', sql: 'p.source' },
  {
    key: 'tags',
    type: 'list',
    label: 'Etiquetas',
    sql: { from: 'people_tags t', where: 't.person_id = p.id', value: 't.tag' },
  },
  { key: 'langs', type: 'list', label: 'Idiomas', sql: { from: 'json_each(p.langs) j', where: '1', value: 'j.value' } },
  {
    key: 'attr',
    label: 'Dato del contacto',
    members: {
      company: {
        type: 'text',
        label: 'Empresa',
        sql: "(SELECT a.value FROM attrs a WHERE a.person_id = p.id AND a.key = 'company')",
      },
      visits: {
        type: 'number',
        label: 'Visitas',
        sql: "(SELECT a.num FROM attrs a WHERE a.person_id = p.id AND a.key = 'visits')",
      },
      renewal: {
        type: 'date',
        label: 'Renovación',
        sql: "(SELECT a.num FROM attrs a WHERE a.person_id = p.id AND a.key = 'renewal')",
      },
      plan: {
        type: 'choice',
        label: 'Plan',
        options: ['basico', 'pro'],
        sql: "(SELECT a.value FROM attrs a WHERE a.person_id = p.id AND a.key = 'plan')",
      },
      newsletter: {
        type: 'boolean',
        label: 'Boletín',
        sql: "(SELECT a.num FROM attrs a WHERE a.person_id = p.id AND a.key = 'newsletter')",
      },
    },
  },
  {
    key: 'orders',
    type: 'custom',
    label: 'Pedidos',
    ops: ['exists', 'not_exists'],
    check: rule =>
      rule.min !== undefined && typeof rule.min !== 'number' ? 'el importe mínimo debe ser un número.' : null,
    test: (rule, record) => (record.orders ?? []).some(total => total >= (rule.min ?? 0)) === (rule.op === 'exists'),
    sql: rule => ({
      sql: `${rule.op === 'exists' ? '' : 'NOT '}EXISTS (SELECT 1 FROM orders o WHERE o.person_id = p.id AND o.total >= ?)`,
      params: [rule.min ?? 0],
    }),
  },
  { key: 'memo', type: 'text', label: 'Nota interna' },
]);

test('defineFields: cada campo declara su tipo, cómo se lee y cómo se consulta', () => {
  const described = describeFields(FIELDS);
  assert.deepEqual(
    described.map(field => (field.key ? `${field.field}.${field.key}` : field.field)),
    [
      'name',
      'name_fast',
      'city',
      'note',
      'age',
      'score',
      'created',
      'last_seen',
      'vip',
      'stage',
      'source',
      'tags',
      'langs',
    ].concat(['attr.company', 'attr.visits', 'attr.renewal', 'attr.plan', 'attr.newsletter', 'orders', 'memo']),
  );
  assert.deepEqual(described[4], {
    field: 'age',
    label: 'Edad',
    type: 'number',
    ops: OPERATORS.number.map(op => ({ op, label: OPERATOR_LABELS[op] })),
    queryable: true,
  });
  assert.deepEqual(described.find(field => field.field === 'stage').options, STAGES);
  assert.deepEqual(
    described.find(field => field.key === 'plan'),
    {
      field: 'attr',
      key: 'plan',
      label: 'Plan',
      type: 'choice',
      ops: OPERATORS.choice.map(op => ({ op, label: OPERATOR_LABELS[op] })),
      options: ['basico', 'pro'],
      queryable: true,
    },
  );
  assert.deepEqual(described.find(field => field.field === 'orders').ops, [
    { op: 'exists', label: 'exists' },
    { op: 'not_exists', label: 'not_exists' },
  ]);
  assert.equal(described.at(-1).queryable, false);
  // Todos los operadores tienen etiqueta en español.
  for (const ops of Object.values(OPERATORS))
    for (const op of ops) assert.match(OPERATOR_LABELS[op], /^[a-záéíóúñ ]+$/, op);
  assert.deepEqual(Object.keys(OPERATORS), ['text', 'number', 'date', 'boolean', 'choice', 'list']);
});

test('defineFields: acepta un objeto, restringe operadores y resuelve familias por objeto o por función', () => {
  const asked = [];
  const fields = defineFields({
    nombre: { type: 'text', ops: ['contains', 'not_contains'] },
    activo: { type: 'boolean', read: record => record.estado === 'activo' },
    etiquetas: { type: 'list', options: [{ value: 'a', label: 'Etiqueta A' }, 'b'] },
    attr: {
      label: 'Dato',
      members: key => {
        asked.push(key);
        return key === 'edad' ? { type: 'number', label: 'Edad' } : null;
      },
    },
  });
  assert.deepEqual(describeFields(fields), [
    {
      field: 'nombre',
      label: 'nombre',
      type: 'text',
      ops: [
        { op: 'contains', label: 'contiene' },
        { op: 'not_contains', label: 'no contiene' },
      ],
      queryable: false,
    },
    {
      field: 'activo',
      label: 'activo',
      type: 'boolean',
      ops: OPERATORS.boolean.map(op => ({ op, label: OPERATOR_LABELS[op] })),
      queryable: false,
    },
    {
      field: 'etiquetas',
      label: 'etiquetas',
      type: 'list',
      ops: OPERATORS.list.map(op => ({ op, label: OPERATOR_LABELS[op] })),
      options: ['a', 'b'],
      queryable: false,
    },
    { field: 'attr', label: 'Dato', open: true },
  ]);
  const record = { nombre: 'Ana María', estado: 'activo', etiquetas: ['a'], attr: { edad: 30 } };
  assert.equal(evaluate(one('nombre', 'contains', { value: 'maria' }), record, fields), true);
  assert.equal(evaluate(one('activo', 'is', { value: true }), record, fields), true);
  assert.equal(evaluate(one('attr', 'gte', { key: 'edad', value: 18 }), record, fields), true);
  assert.deepEqual(asked, ['edad']);
  assert.deepEqual(validate(one('nombre', 'eq', { value: 'x' }), fields), [
    'Grupo 1, condición 1 («nombre»): el operador «eq» no se puede usar con este campo. Usa uno de: contains, not_contains.',
  ]);
  assert.deepEqual(validate(one('etiquetas', 'any', { value: ['c'] }), fields), [
    'Grupo 1, condición 1 («etiquetas»): «c» no es una opción de este campo.',
  ]);
  assert.deepEqual(validate(one('attr', 'eq', { key: 'peso', value: 1 }), fields), [
    'Grupo 1, condición 1: el dato «peso» no existe o ya no está disponible.',
  ]);
  // Los campos también se pueden pasar sin registrar, como lista o como objeto.
  assert.equal(evaluate(one('n', 'gt', { value: 1 }), { n: 2 }, [{ key: 'n', type: 'number' }]), true);
  assert.equal(evaluate(one('n', 'gt', { value: 1 }), { n: 2 }, { n: { type: 'number' } }), true);
  assert.deepEqual(validate(one('n', 'gt', { value: 1 }), undefined), [
    'Grupo 1, condición 1: el campo «n» no existe.',
  ]);
});

test('defineFields: una declaración mal hecha falla al arrancar, no al evaluar', () => {
  const bad = [
    [{ type: 'text' }],
    [{ key: '', type: 'text' }],
    [{ key: 'a', type: 'texto' }],
    [{ key: 'a' }],
    [
      { key: 'a', type: 'text' },
      { key: 'a', type: 'number' },
    ],
    [{ key: 'a', type: 'text', ops: ['gt'] }],
    [{ key: 'a', type: 'text', read: 'nombre' }],
    [{ key: 'a', type: 'text', sql: '' }],
    [{ key: 'a', type: 'text', sql: { from: 'x' } }],
    [{ key: 'a', type: 'text', sqlNorm: 'c.name_key' }],
    [{ key: 'a', type: 'number', sql: 'c.n', sqlNorm: 'c.n' }],
    [{ key: 'a', type: 'list', sql: 'c.tags' }],
    [{ key: 'a', type: 'list', sql: { from: 'x', where: 'y' } }],
    [{ key: 'a', type: 'choice', options: 'a,b' }],
    [{ key: 'a', type: 'custom', test: () => true }],
    [{ key: 'a', type: 'custom', ops: [], test: () => true }],
    [{ key: 'a', type: 'custom', ops: ['x'] }],
    [{ key: 'a', type: 'custom', ops: ['x'], test: () => true, sql: 'EXISTS (…)' }],
    [{ key: 'a', members: 'x' }],
    [{ key: 'a', members: ['x'] }],
    [null],
  ];
  for (const declarations of bad)
    assert.throws(() => defineFields(declarations), TypeError, JSON.stringify(declarations));
  // Un miembro mal declarado de una familia se descubre al usarlo.
  const family = defineFields([{ key: 'attr', members: { roto: { type: 'nada' } } }]);
  assert.throws(() => validate(one('attr', 'eq', { key: 'roto', value: 1 }), family), TypeError);
  assert.deepEqual(describeFields([]), []);
});

// ---- Validar y normalizar

test('validate: la forma canónica del fallo de conciliación no tiene problemas', () => {
  const canonical = {
    version: 1,
    match: 'any',
    groups: [
      {
        match: 'all',
        rules: [
          { field: 'city', op: 'eq', value: 'Puebla' },
          { field: 'attr', key: 'visits', op: 'gte', value: 3 },
        ],
      },
      {
        match: 'any',
        rules: [
          { field: 'tags', op: 'any', value: ['vip'] },
          { field: 'stage', op: 'in', value: ['pagado'] },
        ],
      },
    ],
  };
  assert.deepEqual(validate(canonical, FIELDS), []);
  assert.deepEqual(validate(canonical, FIELDS, { sql: true }), []);
  assert.deepEqual(normalize(canonical, FIELDS), canonical);
  // Sin condiciones también es válido: significa «todos».
  for (const empty of [null, undefined, {}, { groups: [] }, { version: 1, match: 'all', groups: [{ rules: [] }, {}] }])
    assert.deepEqual(validate(empty, FIELDS), [], JSON.stringify(empty));
});

test('validate: una condición de cada operador con un valor correcto', () => {
  const good = [
    ['name', 'eq', { value: 'María' }],
    ['name', 'neq', { value: 'María' }],
    ['name', 'contains', { value: 'maría josé' }],
    ['name', 'not_contains', { value: 'x' }],
    ['name', 'starts_with', { value: 'mar' }],
    ['name', 'not_starts_with', { value: 'mar' }],
    ['name', 'in', { value: ['Ana', 'Luis'] }],
    ['name', 'not_in', { value: 'Ana' }],
    ['name', 'empty', {}],
    ['name', 'not_empty', {}],
    ['name', 'eq', { value: 2026 }],
    ['note', 'keyword', { value: ['curso'] }],
    ['note', 'keyword', { value: 'curso', mode: 'exact' }],
    ['note', 'keyword', { value: ['curso', 'ductos'], mode: 'fuzzy' }],
    ['note', 'keyword', { value: ['curso'], mode: 'fuzzy', threshold: 60 }],
    ['note', 'keyword', { value: ['curso'], mode: 'fuzzy', threshold: 95 }],
    ['age', 'eq', { value: 18 }],
    ['age', 'neq', { value: -1.5 }],
    ['age', 'gt', { value: '18' }],
    ['age', 'gte', { value: ' 18.5 ' }],
    ['age', 'lt', { value: 0 }],
    ['age', 'lt', { value: '-3' }],
    ['age', 'lte', { value: '.5' }],
    ['age', 'lte', { value: '5.' }],
    ['age', 'between', { value: { from: 18, to: 30 } }],
    ['age', 'between', { value: { from: '18', to: 18 } }],
    ['age', 'empty', {}],
    ['age', 'not_empty', {}],
    ['created', 'empty', {}],
    ['created', 'before', { value: '2026-11-13' }],
    ['created', 'after', { value: '2026-11-13T12:00:00Z' }],
    ['created', 'after', { value: '2026-11-13T12:00-06:00' }],
    ['created', 'eq', { value: '2026-11-13T12:00:00.123+05:30' }],
    ['created', 'neq', { value: NOW }],
    ['created', 'before', { value: 0 }],
    ['created', 'between', { value: { from: '2026-01-01', to: '2026-12-31' } }],
    ['created', 'between', { value: { from: NOW, to: NOW } }],
    ['created', 'in_last_days', { value: 1 }],
    ['created', 'not_in_last_days', { value: '3650' }],
    ['created', 'not_empty', {}],
    ['vip', 'is', { value: true }],
    ['vip', 'is', { value: false }],
    ['vip', 'is', { value: 1 }],
    ['vip', 'is', { value: 0 }],
    ['vip', 'empty', {}],
    ['vip', 'not_empty', {}],
    ['stage', 'not_empty', {}],
    ['stage', 'eq', { value: 'pagado' }],
    ['stage', 'neq', { value: 'nuevo' }],
    ['stage', 'in', { value: ['nuevo', 'pagado'] }],
    ['stage', 'not_in', { value: ['nuevo'] }],
    ['stage', 'empty', {}],
    ['source', 'eq', { value: 7 }],
    ['tags', 'any', { value: ['a'] }],
    ['tags', 'all', { value: ['a', 'b'] }],
    ['tags', 'none', { value: ['a', 3] }],
    ['tags', 'empty', {}],
    ['tags', 'not_empty', {}],
    ['attr', 'contains', { key: 'company', value: 'acme' }],
    ['attr', 'between', { key: 'visits', value: { from: 1, to: 5 } }],
    ['attr', 'in_last_days', { key: 'renewal', value: 30 }],
    ['attr', 'eq', { key: 'plan', value: 'pro' }],
    ['attr', 'is', { key: 'newsletter', value: true }],
    ['orders', 'exists', {}],
    ['orders', 'not_exists', { min: 100 }],
    ['memo', 'contains', { value: 'pendiente' }],
  ];
  for (const [field, op, extra] of good)
    assert.deepEqual(validate(one(field, op, extra), FIELDS), [], `${field} ${op} ${JSON.stringify(extra)}`);
  // Cada tipo ofrece exactamente sus operadores, y todos quedaron probados.
  const tried = new Set(good.map(([field, op]) => `${field}:${op}`));
  const sample = {
    text: ['name', 'note'],
    number: ['age'],
    date: ['created'],
    boolean: ['vip'],
    choice: ['stage'],
    list: ['tags'],
  };
  for (const [type, keys] of Object.entries(sample))
    for (const op of OPERATORS[type])
      assert.ok(
        keys.some(key => tried.has(`${key}:${op}`)),
        `${type} ${op}`,
      );
});

test('validate: dice en español qué corregir y en qué grupo y condición', () => {
  const where = 'Grupo 1, condición 1';
  const bad = [
    [{ field: 'nope', op: 'eq', value: 1 }, `${where}: el campo «nope» no existe.`],
    [{ field: '__proto__', op: 'eq', value: 1 }, `${where}: el campo «__proto__» no existe.`],
    [{ field: 'constructor', op: 'eq', value: 1 }, `${where}: el campo «constructor» no existe.`],
    [{ op: 'eq', value: 1 }, `${where}: falta el campo.`],
    [{ field: 7, op: 'eq' }, `${where}: falta el campo.`],
    ['name eq x', `${where}: no es una condición válida.`],
    [null, `${where}: no es una condición válida.`],
    [['name', 'eq', 'x'], `${where}: no es una condición válida.`],
    [
      { field: 'attr', op: 'eq', value: 'x' },
      `${where}: falta indicar qué dato de «Dato del contacto» se compara («key»).`,
    ],
    [
      { field: 'attr', key: 'nope', op: 'eq', value: 'x' },
      `${where}: el dato «nope» no existe o ya no está disponible.`,
    ],
    [
      { field: 'attr', key: '__proto__', op: 'eq', value: 'x' },
      `${where}: el dato «__proto__» no existe o ya no está disponible.`,
    ],
    [
      { field: 'attr', key: 'toString', op: 'eq', value: 'x' },
      `${where}: el dato «toString» no existe o ya no está disponible.`,
    ],
    [{ field: 'name' }, `${where} («Nombre»): falta el operador («op»).`],
    [{ field: 'name', op: '' }, `${where} («Nombre»): falta el operador («op»).`],
    [
      { field: 'name', op: 'gt', value: 'x' },
      `${where} («Nombre»): el operador «gt» no se puede usar con este campo. Usa uno de: ${OPERATORS.text.join(', ')}.`,
    ],
    [
      { field: 'vip', op: 'eq', value: true },
      `${where} («Preferente»): el operador «eq» no se puede usar con este campo. Usa uno de: is, empty, not_empty.`,
    ],
    [{ field: 'name', op: 'eq' }, `${where} («Nombre»): escribe el texto a comparar.`],
    [{ field: 'name', op: 'eq', value: '   ' }, `${where} («Nombre»): escribe el texto a comparar.`],
    [{ field: 'name', op: 'eq', value: null }, `${where} («Nombre»): escribe el texto a comparar.`],
    [{ field: 'name', op: 'eq', value: ['a'] }, `${where} («Nombre»): escribe el texto a comparar.`],
    [
      { field: 'name', op: 'contains', value: '¿?' },
      `${where} («Nombre»): el texto necesita al menos una letra o un número.`,
    ],
    [{ field: 'name', op: 'eq', value: 'x'.repeat(201) }, `${where} («Nombre»): el texto admite hasta 200 caracteres.`],
    [{ field: 'name', op: 'in', value: [] }, `${where} («Nombre»): indica al menos un valor.`],
    [{ field: 'name', op: 'in' }, `${where} («Nombre»): indica al menos un valor.`],
    [{ field: 'name', op: 'in', value: ['a', ''] }, `${where} («Nombre»): escribe el texto a comparar.`],
    [
      { field: 'name', op: 'in', value: Array.from({ length: 51 }, (_, i) => `v${i}`) },
      `${where} («Nombre»): admite hasta 50 valores.`,
    ],
    [{ field: 'note', op: 'keyword', value: [] }, `${where} («Mensaje»): indica al menos un valor.`],
    [
      { field: 'note', op: 'keyword', value: ['curso'], mode: 'regex' },
      `${where} («Mensaje»): el modo de la palabra clave debe ser exact, contains o fuzzy.`,
    ],
    [
      { field: 'note', op: 'keyword', value: Array.from({ length: 31 }, (_, i) => `w${i}`) },
      `${where} («Mensaje»): admite hasta 30 valores.`,
    ],
    [
      { field: 'note', op: 'keyword', value: ['x'.repeat(61)] },
      `${where} («Mensaje»): el texto admite hasta 60 caracteres.`,
    ],
    [
      { field: 'note', op: 'keyword', value: ['curso', '...'] },
      `${where} («Mensaje»): el texto necesita al menos una letra o un número.`,
    ],
    [
      { field: 'note', op: 'keyword', value: ['curso'], mode: 'fuzzy', threshold: 59 },
      `${where} («Mensaje»): el parecido debe ser un número entero entre 60 y 95.`,
    ],
    [
      { field: 'note', op: 'keyword', value: ['curso'], mode: 'fuzzy', threshold: 96 },
      `${where} («Mensaje»): el parecido debe ser un número entero entre 60 y 95.`,
    ],
    [
      { field: 'note', op: 'keyword', value: ['curso'], mode: 'fuzzy', threshold: 80.5 },
      `${where} («Mensaje»): el parecido debe ser un número entero entre 60 y 95.`,
    ],
    [
      { field: 'note', op: 'keyword', value: ['curso'], mode: 'fuzzy', threshold: '80' },
      `${where} («Mensaje»): el parecido debe ser un número entero entre 60 y 95.`,
    ],
    [{ field: 'age', op: 'eq', value: 'abc' }, `${where} («Edad»): el valor debe ser un número.`],
    [{ field: 'age', op: 'eq' }, `${where} («Edad»): el valor debe ser un número.`],
    [{ field: 'age', op: 'gt', value: Number.NaN }, `${where} («Edad»): el valor debe ser un número.`],
    [{ field: 'age', op: 'gt', value: Number.POSITIVE_INFINITY }, `${where} («Edad»): el valor debe ser un número.`],
    [{ field: 'age', op: 'gt', value: '1e3' }, `${where} («Edad»): el valor debe ser un número.`],
    [{ field: 'age', op: 'gt', value: true }, `${where} («Edad»): el valor debe ser un número.`],
    [{ field: 'age', op: 'between', value: [1, 2] }, `${where} («Edad»): indica «desde» y «hasta» como números.`],
    [{ field: 'age', op: 'between', value: { from: 1 } }, `${where} («Edad»): indica «desde» y «hasta» como números.`],
    [
      { field: 'age', op: 'between', value: { from: 5, to: 1 } },
      `${where} («Edad»): «desde» no puede ser mayor que «hasta».`,
    ],
    [
      { field: 'created', op: 'before', value: 'ayer' },
      `${where} («Alta»): la fecha debe ser AAAA-MM-DD, una fecha ISO con zona horaria o un instante en milisegundos.`,
    ],
    [
      { field: 'created', op: 'before', value: '2026-02-30' },
      `${where} («Alta»): la fecha debe ser AAAA-MM-DD, una fecha ISO con zona horaria o un instante en milisegundos.`,
    ],
    [
      { field: 'created', op: 'before', value: '2026-13-01' },
      `${where} («Alta»): la fecha debe ser AAAA-MM-DD, una fecha ISO con zona horaria o un instante en milisegundos.`,
    ],
    [
      { field: 'created', op: 'before', value: '0099-01-01' },
      `${where} («Alta»): la fecha debe ser AAAA-MM-DD, una fecha ISO con zona horaria o un instante en milisegundos.`,
    ],
    [
      { field: 'created', op: 'before', value: '13/11/2026' },
      `${where} («Alta»): la fecha debe ser AAAA-MM-DD, una fecha ISO con zona horaria o un instante en milisegundos.`,
    ],
    [
      { field: 'created', op: 'after', value: '2026-11-13T12:00' },
      `${where} («Alta»): la fecha debe ser AAAA-MM-DD, una fecha ISO con zona horaria o un instante en milisegundos.`,
    ],
    [
      { field: 'created', op: 'after', value: 9e15 },
      `${where} («Alta»): la fecha debe ser AAAA-MM-DD, una fecha ISO con zona horaria o un instante en milisegundos.`,
    ],
    [
      { field: 'created', op: 'after' },
      `${where} («Alta»): la fecha debe ser AAAA-MM-DD, una fecha ISO con zona horaria o un instante en milisegundos.`,
    ],
    [
      { field: 'created', op: 'between', value: { from: '2026-12-31', to: '2026-01-01' } },
      `${where} («Alta»): «desde» no puede ser mayor que «hasta».`,
    ],
    [
      { field: 'created', op: 'between', value: { from: '2026-01-01' } },
      `${where} («Alta»): la fecha debe ser AAAA-MM-DD, una fecha ISO con zona horaria o un instante en milisegundos.`,
    ],
    [
      { field: 'created', op: 'in_last_days', value: 0 },
      `${where} («Alta»): los días deben ser un número entero entre 1 y 3650.`,
    ],
    [
      { field: 'created', op: 'in_last_days', value: 3651 },
      `${where} («Alta»): los días deben ser un número entero entre 1 y 3650.`,
    ],
    [
      { field: 'created', op: 'in_last_days', value: 1.5 },
      `${where} («Alta»): los días deben ser un número entero entre 1 y 3650.`,
    ],
    [
      { field: 'created', op: 'not_in_last_days', value: 'siete' },
      `${where} («Alta»): los días deben ser un número entero entre 1 y 3650.`,
    ],
    [{ field: 'vip', op: 'is', value: 'sí' }, `${where} («Preferente»): el valor debe ser sí (true) o no (false).`],
    [{ field: 'vip', op: 'is' }, `${where} («Preferente»): el valor debe ser sí (true) o no (false).`],
    [{ field: 'vip', op: 'is', value: 2 }, `${where} («Preferente»): el valor debe ser sí (true) o no (false).`],
    [{ field: 'stage', op: 'eq', value: 'otro' }, `${where} («Etapa»): «otro» no es una opción de este campo.`],
    [{ field: 'stage', op: 'eq', value: 'Pagado' }, `${where} («Etapa»): «Pagado» no es una opción de este campo.`],
    [{ field: 'stage', op: 'eq' }, `${where} («Etapa»): elige un valor.`],
    [{ field: 'stage', op: 'eq', value: '' }, `${where} («Etapa»): elige un valor.`],
    [{ field: 'stage', op: 'eq', value: ['pagado'] }, `${where} («Etapa»): elige un valor.`],
    [{ field: 'stage', op: 'in', value: 'pagado' }, `${where} («Etapa»): elige al menos un valor.`],
    [{ field: 'stage', op: 'in', value: [] }, `${where} («Etapa»): elige al menos un valor.`],
    [{ field: 'stage', op: 'in', value: ['pagado', null] }, `${where} («Etapa»): cada valor debe ser un texto.`],
    [
      { field: 'source', op: 'eq', value: 'x'.repeat(201) },
      `${where} («Origen»): cada valor admite hasta 200 caracteres.`,
    ],
    [{ field: 'tags', op: 'any', value: 'a' }, `${where} («Etiquetas»): elige al menos un valor.`],
    [{ field: 'tags', op: 'all', value: [{ id: 'a' }] }, `${where} («Etiquetas»): cada valor debe ser un texto.`],
    [
      { field: 'tags', op: 'none', value: Array.from({ length: 51 }, (_, i) => `t${i}`) },
      `${where} («Etiquetas»): admite hasta 50 valores.`,
    ],
    [
      { field: 'attr', key: 'plan', op: 'eq', value: 'oro' },
      `${where} («Plan»): «oro» no es una opción de este campo.`,
    ],
    [{ field: 'orders', op: 'exists', min: 'mucho' }, `${where} («Pedidos»): el importe mínimo debe ser un número.`],
    [
      { field: 'orders', op: 'any' },
      `${where} («Pedidos»): el operador «any» no se puede usar con este campo. Usa uno de: exists, not_exists.`,
    ],
  ];
  for (const [rule, problem] of bad) {
    const definition = { groups: [{ rules: [rule] }] };
    assert.deepEqual(validate(definition, FIELDS), [problem], JSON.stringify(rule));
    // Lo que no se puede guardar tampoco se evalúa ni se compila: lanza el mismo problema.
    for (const run of [
      () => evaluate(definition, {}, FIELDS, NOW),
      () => compile(definition, FIELDS, { now: NOW }),
      () => normalize(definition, FIELDS),
      () => matcher(definition, FIELDS),
    ]) {
      const error = thrown(run);
      assert.deepEqual(
        [error?.name, error?.code, error?.status, error?.message],
        ['ConditionsError', 'invalid_conditions', 400, problem],
        JSON.stringify(rule),
      );
      assert.deepEqual(error.problems, [problem]);
    }
  }
});

test('validate: forma de la definición, grupos y topes', () => {
  assert.deepEqual(validate('name = x', FIELDS), ['Las condiciones deben ser un objeto con sus grupos («groups»).']);
  assert.deepEqual(validate([], FIELDS), ['Las condiciones deben ser un objeto con sus grupos («groups»).']);
  assert.deepEqual(validate(7, FIELDS), ['Las condiciones deben ser un objeto con sus grupos («groups»).']);
  assert.deepEqual(validate({ version: 2 }, FIELDS), [
    'No se reconoce la versión 2 de las condiciones: se esperaba la 1.',
  ]);
  assert.deepEqual(validate({ version: '1' }, FIELDS), [
    'No se reconoce la versión 1 de las condiciones: se esperaba la 1.',
  ]);
  assert.deepEqual(validate({ match: 'or' }, FIELDS), [
    '«match» debe ser "any" (basta que se cumpla un grupo) o "all" (todos los grupos).',
  ]);
  assert.deepEqual(validate({ groups: {} }, FIELDS), ['«groups» debe ser una lista de grupos.']);
  assert.deepEqual(validate({ groups: ['x', null, []] }, FIELDS), [
    'Grupo 1: no es un grupo válido.',
    'Grupo 2: no es un grupo válido.',
    'Grupo 3: no es un grupo válido.',
  ]);
  assert.deepEqual(validate({ groups: [{ match: 'none', rules: [] }] }, FIELDS), [
    'Grupo 1: «match» debe ser "all" (todas las condiciones) o "any" (alguna).',
  ]);
  assert.deepEqual(validate({ groups: [{ rules: {} }] }, FIELDS), [
    'Grupo 1: «rules» debe ser una lista de condiciones.',
  ]);
  // Las formas que cada diseño traía por su cuenta no son la canónica: no se aceptan a medias.
  assert.deepEqual(validate({ groups: [{ all: [{ f: 'name', op: 'is', v: 'x' }] }] }, FIELDS), []);
  assert.equal(
    evaluate({ groups: [{ all: [{ f: 'name', op: 'is', v: 'x' }] }] }, { name: 'y' }, FIELDS),
    true,
    'un grupo sin «rules» no decide nada',
  );
  assert.deepEqual(validate({ groups: [{ rules: [{ f: 'name', op: 'eq', value: 'x' }] }] }, FIELDS), [
    'Grupo 1, condición 1: falta el campo.',
  ]);

  const rule = { field: 'name', op: 'eq', value: 'x' };
  const group = count => ({ rules: Array.from({ length: count }, () => rule) });
  assert.deepEqual(validate({ groups: Array.from({ length: 5 }, () => group(8)) }, FIELDS), []);
  assert.deepEqual(validate({ groups: Array.from({ length: 6 }, () => group(1)) }, FIELDS), [
    'Hay 6 grupos de condiciones y el máximo es 5.',
  ]);
  assert.deepEqual(validate({ groups: [group(1), group(9)] }, FIELDS), [
    'Grupo 2: tiene 9 condiciones y el máximo es 8.',
  ]);
  // Lo que pasa del tope no se sigue leyendo: una definición desmedida no hace trabajar de más.
  const huge = { groups: Array.from({ length: 2000 }, () => ({ rules: [{ field: 'nope', op: 'eq' }] })) };
  assert.equal(validate(huge, FIELDS).length, 1 + 5 + 1);
  assert.deepEqual(
    validate({ groups: [{ rules: Array.from({ length: 5000 }, () => ({ field: 'nope' })) }] }, FIELDS).length,
    1 + 8 + 1,
  );
  // Tamaño máximo de la definición guardada.
  const heavy = {
    groups: Array.from({ length: 5 }, () => ({
      rules: Array.from({ length: 8 }, () => ({
        field: 'name',
        op: 'in',
        value: Array.from({ length: 50 }, (_, i) => `valor ${i}`),
      })),
    })),
  };
  assert.deepEqual(validate(heavy, FIELDS), ['Las condiciones ocupan demasiado: el máximo es 16 KB.']);
  const circular = { groups: [] };
  circular.self = circular;
  assert.deepEqual(validate(circular, FIELDS), ['Las condiciones no se pueden guardar: no son datos simples.']);
  // Los topes se pueden cambiar por llamada.
  assert.deepEqual(validate({ groups: [group(1), group(1)] }, FIELDS, { limits: { maxGroups: 1 } }), [
    'Hay 2 grupos de condiciones y el máximo es 1.',
  ]);
  assert.deepEqual(validate({ groups: [group(3)] }, FIELDS, { limits: { maxRules: 2 } }), [
    'Grupo 1: tiene 3 condiciones y el máximo es 2.',
  ]);
  assert.deepEqual(validate(one('name', 'in', { value: ['a', 'b', 'c'] }), FIELDS, { limits: { maxValues: 2 } }), [
    'Grupo 1, condición 1 («Nombre»): admite hasta 2 valores.',
  ]);
  assert.deepEqual(validate(one('created', 'in_last_days', { value: 91 }), FIELDS, { limits: { maxDays: 90 } }), [
    'Grupo 1, condición 1 («Alta»): los días deben ser un número entero entre 1 y 90.',
  ]);
  assert.deepEqual(validate(heavy, FIELDS, { limits: { maxBytes: 1_000_000 } }), []);
  assert.deepEqual(
    { ...LIMITS },
    {
      maxGroups: 5,
      maxRules: 8,
      maxValues: 50,
      maxWords: 30,
      maxWordLength: 60,
      maxTextLength: 200,
      maxDays: 3650,
      maxBytes: 16384,
      minThreshold: 60,
      maxThreshold: 95,
      defaultThreshold: 80,
    },
  );
  assert.ok(Object.isFrozen(LIMITS));
});

test('validate con {sql: true}: los campos que sólo viven en memoria no sirven para una consulta', () => {
  const definition = {
    groups: [
      {
        rules: [
          { field: 'memo', op: 'contains', value: 'x' },
          { field: 'name', op: 'eq', value: 'x' },
          { field: 'memo', op: 'empty' },
        ],
      },
    ],
  };
  assert.deepEqual(validate(definition, FIELDS), []);
  assert.deepEqual(validate(definition, FIELDS, { sql: true }), [
    'El campo «Nota interna» no se puede usar en una consulta: sólo se evalúa en memoria.',
  ]);
  const error = thrown(() => compile(definition, FIELDS));
  assert.deepEqual([error.name, error.code, error.status], ['ConditionsError', 'not_compilable', 400]);
  assert.equal(error.message, 'El campo «Nota interna» no se puede usar en una consulta: sólo se evalúa en memoria.');
  assert.equal(evaluate(definition, { memo: 'x', name: 'x' }, FIELDS), false);
});

test('normalize: la forma lista para guardar, con valores limpios y sin repetidos', () => {
  const messy = {
    groups: [
      { rules: [] },
      {
        rules: [
          { field: 'name', op: 'eq', value: '  María  ', label: 'sobra' },
          { field: 'name', op: 'in', value: ['Ana', ' ANA ', 'aná', 'Luis'] },
          { field: 'note', op: 'keyword', value: 'curso' },
          { field: 'note', op: 'keyword', mode: 'fuzzy', value: ['Ductos', 'ductos', 'aves'] },
          { field: 'note', op: 'keyword', mode: 'exact', value: ['sí'], threshold: 70 },
          { field: 'age', op: 'gte', value: ' 18 ' },
          { field: 'age', op: 'between', value: { from: '1', to: 5, extra: true } },
          { field: 'name', op: 'empty', value: 'no cuenta' },
        ],
      },
      {
        match: 'any',
        rules: [
          { field: 'created', op: 'before', value: ' 2026-11-13 ' },
          { field: 'created', op: 'in_last_days', value: '30' },
          { field: 'vip', op: 'is', value: 1 },
          { field: 'stage', op: 'in', value: ['pagado', 'pagado', 'nuevo'] },
          { field: 'source', op: 'eq', value: 7 },
          { field: 'tags', op: 'all', value: ['a', 'a', 3] },
          { field: 'attr', key: 'visits', op: 'gt', value: '2' },
          { field: 'orders', op: 'exists', min: 50 },
        ],
      },
      {},
    ],
  };
  const canonical = normalize(messy, FIELDS);
  assert.deepEqual(canonical, {
    version: 1,
    match: 'any',
    groups: [
      {
        match: 'all',
        rules: [
          { field: 'name', op: 'eq', value: 'María' },
          { field: 'name', op: 'in', value: ['Ana', 'Luis'] },
          { field: 'note', op: 'keyword', mode: 'contains', value: ['curso'] },
          { field: 'note', op: 'keyword', mode: 'fuzzy', value: ['Ductos', 'aves'], threshold: 80 },
          { field: 'note', op: 'keyword', mode: 'exact', value: ['sí'] },
          { field: 'age', op: 'gte', value: 18 },
          { field: 'age', op: 'between', value: { from: 1, to: 5 } },
          { field: 'name', op: 'empty' },
        ],
      },
      {
        match: 'any',
        rules: [
          { field: 'created', op: 'before', value: ' 2026-11-13 ' },
          { field: 'created', op: 'in_last_days', value: 30 },
          { field: 'vip', op: 'is', value: true },
          { field: 'stage', op: 'in', value: ['pagado', 'nuevo'] },
          { field: 'source', op: 'eq', value: '7' },
          { field: 'tags', op: 'all', value: ['a', '3'] },
          { field: 'attr', key: 'visits', op: 'gt', value: 2 },
          { field: 'orders', op: 'exists', min: 50 },
        ],
      },
    ],
  });
  // Normalizar lo ya normalizado no cambia nada, y significa lo mismo que el original.
  assert.deepEqual(normalize(canonical, FIELDS), canonical);
  assert.deepEqual(validate(canonical, FIELDS), []);
  assert.deepEqual(compile(canonical, FIELDS, { now: NOW }), compile(messy, FIELDS, { now: NOW }));
  assert.deepEqual(normalize(null, FIELDS), { version: 1, match: 'any', groups: [] });
  assert.deepEqual(normalize({ match: 'all', groups: [{}] }, FIELDS), { version: 1, match: 'all', groups: [] });
  // No modifica lo que recibe.
  assert.equal(messy.groups[1].rules[0].value, '  María  ');
  assert.equal(messy.groups.length, 4);
});

// ---- Evaluar en memoria

const holds = (field, op, extra, record, now = NOW) => evaluate(one(field, op, extra), record, FIELDS, now);

test('evaluate, texto: comparaciones sin mayúsculas ni acentos; lo vacío nunca cumple una afirmación', () => {
  const ana = { name: '  María-José  PÉREZ ' };
  const table = [
    ['eq', 'maria jose perez', true],
    ['eq', 'María José Pérez', true],
    ['eq', 'maria jose', false],
    ['neq', 'maria jose perez', false],
    ['neq', 'otra', true],
    ['contains', 'José', true],
    ['contains', 'jose perez', true],
    ['contains', 'maria perez', false],
    ['contains', 'mari', false],
    ['contains', 'ose', false],
    ['not_contains', 'jose', false],
    ['not_contains', 'mari', true],
    ['starts_with', 'mar', true],
    ['starts_with', 'María J', true],
    ['starts_with', 'jose', false],
    ['not_starts_with', 'mar', false],
    ['not_starts_with', 'jose', true],
    ['in', ['Luis', 'MARIA JOSE PEREZ'], true],
    ['in', ['Luis', 'maria'], false],
    ['not_in', ['Luis', 'maria jose perez'], false],
    ['not_in', ['Luis'], true],
  ];
  for (const [op, value, want] of table)
    assert.equal(holds('name', op, { value }, ana), want, `${op} ${JSON.stringify(value)}`);
  assert.equal(holds('name', 'empty', {}, ana), false);
  assert.equal(holds('name', 'not_empty', {}, ana), true);
  // Vacío: nulo, sin la propiedad, cadena vacía o sólo espacios de cualquier tipo.
  const blanks = [
    { name: null },
    {},
    { name: undefined },
    { name: '' },
    { name: '   ' },
    { name: '\t\n' },
    { name: NBSP + EM_SPACE + IDEOGRAPHIC_SPACE + BYTE_ORDER_MARK + LINE_SEPARATOR },
  ];
  for (const record of blanks) {
    const label = JSON.stringify(record);
    assert.equal(holds('name', 'empty', {}, record), true, label);
    assert.equal(holds('name', 'not_empty', {}, record), false, label);
    for (const op of ['eq', 'contains', 'starts_with'])
      assert.equal(holds('name', op, { value: 'x' }, record), false, `${op} ${label}`);
    for (const op of ['neq', 'not_contains', 'not_starts_with'])
      assert.equal(holds('name', op, { value: 'x' }, record), true, `${op} ${label}`);
    assert.equal(holds('name', 'in', { value: ['x'] }, record), false, label);
    assert.equal(holds('name', 'not_in', { value: ['x'] }, record), true, label);
    assert.equal(holds('name', 'keyword', { value: ['x'] }, record), false, label);
  }
  // Un texto con signos pero sin letras no está vacío, aunque no sea igual a nada.
  for (const record of [{ name: '???' }, { name: ZERO_WIDTH }, { name: NEXT_LINE }, { name: 0 }]) {
    assert.equal(holds('name', 'empty', {}, record), false, JSON.stringify(record));
    assert.equal(holds('name', 'not_empty', {}, record), true, JSON.stringify(record));
  }
  assert.equal(holds('name', 'eq', { value: '2026' }, { name: 2026 }), true);
  assert.equal(holds('name', 'eq', { value: 2026 }, { name: '2026' }), true);
});

test('evaluate, palabra clave como condición: exacta, contenida y parecida', () => {
  const message = { note: 'Hola, quiero informes del curso de hidrocaburos' };
  assert.equal(holds('note', 'keyword', { value: ['curso'] }, message), true);
  assert.equal(holds('note', 'keyword', { value: ['recurso', 'CURSO DE'] }, message), true);
  assert.equal(holds('note', 'keyword', { value: ['cursos'] }, message), false);
  assert.equal(holds('note', 'keyword', { mode: 'exact', value: ['curso'] }, message), false);
  assert.equal(holds('note', 'keyword', { mode: 'exact', value: ['curso'] }, { note: '¡Curso!' }), true);
  assert.equal(holds('note', 'keyword', { mode: 'contains', value: ['hidrocarburos'] }, message), false);
  assert.equal(holds('note', 'keyword', { mode: 'fuzzy', value: ['hidrocarburos'] }, message), true);
  assert.equal(holds('note', 'keyword', { mode: 'fuzzy', value: ['hidrocarburos'], threshold: 95 }, message), false);
  assert.equal(holds('note', 'keyword', { mode: 'fuzzy', value: ['hidrocarburos'], threshold: 92 }, message), true);
  // Un archivo sin pie o un mensaje de puros emojis nunca coincide.
  for (const note of [null, '', FACE, '...'])
    for (const mode of KEYWORD_MODES)
      assert.equal(holds('note', 'keyword', { mode, value: ['curso'] }, { note }), false);
});

test('evaluate, número', () => {
  const table = [
    ['eq', 18, true],
    ['eq', '18', true],
    ['eq', 18.5, false],
    ['neq', 18, false],
    ['neq', 19, true],
    ['gt', 17, true],
    ['gt', 18, false],
    ['gte', 18, true],
    ['gte', 18.1, false],
    ['lt', 19, true],
    ['lt', 18, false],
    ['lte', 18, true],
    ['lte', 17.9, false],
    ['between', { from: 18, to: 18 }, true],
    ['between', { from: 10, to: 20 }, true],
    ['between', { from: 18.1, to: 20 }, false],
    ['between', { from: 1, to: 17.9 }, false],
  ];
  for (const [op, value, want] of table)
    assert.equal(holds('age', op, { value }, { age: 18 }), want, `${op} ${JSON.stringify(value)}`);
  assert.equal(holds('age', 'eq', { value: 0 }, { age: 0 }), true);
  assert.equal(holds('age', 'eq', { value: 0 }, { age: -0 }), true);
  assert.equal(holds('age', 'lt', { value: 0 }, { age: -2.5 }), true);
  // El valor de la condición puede venir escrito como texto por un formulario.
  assert.equal(holds('age', 'eq', { value: ' -2.5 ' }, { age: -2.5 }), true);
  assert.equal(holds('age', 'between', { value: { from: '-3', to: '.5' } }, { age: -2.5 }), true);
  assert.equal(holds('age', 'eq', { value: 7 }, { age: 7n }), true);
  assert.equal(holds('age', 'empty', {}, { age: 0 }), false);
  assert.equal(holds('age', 'not_empty', {}, { age: 0 }), true);
  // Lo que no es un número es vacío: también un texto que parece número, para que SQL y memoria coincidan.
  for (const age of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '18', '', true, {}, []]) {
    const record = { age };
    assert.equal(holds('age', 'empty', {}, record), true, String(age));
    assert.equal(holds('age', 'not_empty', {}, record), false, String(age));
    for (const op of ['eq', 'gt', 'gte', 'lt', 'lte'])
      assert.equal(holds('age', op, { value: 18 }, record), false, `${op} ${String(age)}`);
    assert.equal(holds('age', 'between', { value: { from: -1e9, to: 1e9 } }, record), false, String(age));
    assert.equal(holds('age', 'neq', { value: 18 }, record), true, String(age));
  }
});

test('evaluate, fecha: antes, después, entre y últimos N días; una fecha vacía nunca cumple', () => {
  const at = Date.UTC(2026, 10, 10, 12, 0, 0);
  const record = { created_at: at };
  const table = [
    ['before', '2026-11-11', true],
    ['before', '2026-11-10', false],
    ['before', at, false],
    ['before', at + 1, true],
    ['after', '2026-11-10', true],
    ['after', '2026-11-11', false],
    ['after', at, false],
    ['after', at - 1, true],
    ['after', '2026-11-10T11:59:59Z', true],
    ['after', '2026-11-10T06:00:00-06:00', false],
    ['after', '2026-11-10T05:59:00-06:00', true],
    ['eq', at, true],
    ['eq', '2026-11-10T12:00:00Z', true],
    ['eq', '2026-11-10T12:00:00.000+00:00', true],
    ['eq', '2026-11-10', false],
    ['neq', at, false],
    ['neq', at + 1, true],
    ['between', { from: '2026-11-10', to: '2026-11-11' }, true],
    ['between', { from: at, to: at }, true],
    ['between', { from: '2026-11-11', to: '2026-11-12' }, false],
    ['between', { from: '2026-11-01', to: '2026-11-10' }, false],
    ['in_last_days', 4, true],
    ['in_last_days', 3, false],
    ['not_in_last_days', 4, false],
    ['not_in_last_days', 3, true],
  ];
  for (const [op, value, want] of table)
    assert.equal(holds('created', op, { value }, record), want, `${op} ${JSON.stringify(value)}`);
  // Una fecha de sólo día guardada como medianoche UTC es igual a ese día.
  assert.equal(holds('created', 'eq', { value: '2026-11-10' }, { created_at: Date.UTC(2026, 10, 10) }), true);
  // El límite de «últimos N días» es inclusivo, y una fecha futura no es de los últimos días.
  assert.equal(holds('created', 'in_last_days', { value: 7 }, { created_at: NOW - 7 * DAY }), true);
  assert.equal(holds('created', 'in_last_days', { value: 7 }, { created_at: NOW - 7 * DAY - 1 }), false);
  assert.equal(holds('created', 'in_last_days', { value: 7 }, { created_at: NOW }), true);
  assert.equal(holds('created', 'in_last_days', { value: 7 }, { created_at: NOW + 1 }), false);
  assert.equal(holds('created', 'not_in_last_days', { value: 7 }, { created_at: NOW + 1 }), true);
  // El registro puede traer un Date; «now» también.
  assert.equal(holds('created', 'before', { value: '2026-11-11' }, { created_at: new Date(at) }), true);
  assert.equal(holds('created', 'in_last_days', { value: 4 }, record, new Date(NOW)), true);
  assert.equal(holds('created', 'eq', { value: 5 }, { created_at: 5n }), true);
  // Vacío: sin fecha, o algo que no es una fecha. Nunca cumple antes, después, entre ni últimos N días.
  for (const created_at of [null, undefined, '', '2026-11-10', Number.NaN, new Date('x'), true, {}]) {
    const empty = { created_at };
    const label = String(created_at);
    assert.equal(holds('created', 'empty', {}, empty), true, label);
    assert.equal(holds('created', 'not_empty', {}, empty), false, label);
    assert.equal(holds('created', 'before', { value: '2100-01-01' }, empty), false, label);
    assert.equal(holds('created', 'after', { value: '1970-01-01' }, empty), false, label);
    assert.equal(holds('created', 'eq', { value: 0 }, empty), false, label);
    assert.equal(holds('created', 'between', { value: { from: '1970-01-01', to: '2100-01-01' } }, empty), false, label);
    assert.equal(holds('created', 'in_last_days', { value: 3650 }, empty), false, label);
    // La negación sí lo incluye: «no escribió en los últimos 90 días» cuenta a quien nunca escribió.
    assert.equal(holds('created', 'not_in_last_days', { value: 90 }, empty), true, label);
    assert.equal(holds('created', 'neq', { value: 0 }, empty), true, label);
  }
  assert.equal(holds('created', 'empty', {}, { created_at: 0 }), false, 'el instante cero es una fecha');
});

test('evaluate: «últimos N días» exige el ahora; lo demás no lo necesita', () => {
  const relative = one('created', 'in_last_days', { value: 7 });
  for (const now of [undefined, null, 'hoy', Number.NaN, new Date('x')]) {
    assert.throws(() => evaluate(relative, { created_at: NOW }, FIELDS, now), TypeError, String(now));
    assert.throws(() => compile(relative, FIELDS, { now }), TypeError, String(now));
    assert.throws(() => matcher(relative, FIELDS)({ created_at: NOW }, now), TypeError, String(now));
  }
  assert.throws(() => compile(relative, FIELDS), /fecha de referencia/);
  assert.equal(evaluate(one('created', 'before', { value: '2030-01-01' }), { created_at: NOW }, FIELDS), true);
  assert.deepEqual(compile(one('created', 'before', { value: '2030-01-01' }), FIELDS).params, [Date.UTC(2030, 0, 1)]);
  // El resultado depende sólo de lo que recibe: con otro ahora, otra respuesta.
  assert.equal(evaluate(relative, { created_at: NOW }, FIELDS, NOW + 6 * DAY), true);
  assert.equal(evaluate(relative, { created_at: NOW }, FIELDS, NOW + 8 * DAY), false);
});

test('evaluate, sí o no', () => {
  for (const yes of [true, 1, 1n]) {
    assert.equal(holds('vip', 'is', { value: true }, { vip: yes }), true);
    assert.equal(holds('vip', 'is', { value: false }, { vip: yes }), false);
    assert.equal(holds('vip', 'empty', {}, { vip: yes }), false);
  }
  for (const no of [false, 0, 0n]) {
    assert.equal(holds('vip', 'is', { value: false }, { vip: no }), true);
    assert.equal(holds('vip', 'is', { value: true }, { vip: no }), false);
    assert.equal(holds('vip', 'not_empty', {}, { vip: no }), true);
  }
  assert.equal(holds('vip', 'is', { value: 1 }, { vip: true }), true);
  assert.equal(holds('vip', 'is', { value: 0 }, { vip: false }), true);
  // Ni sí ni no: vacío. No cumple «es sí» ni «es no».
  for (const vip of [null, undefined, 2, -1, 'true', 'sí', '', {}, Number.NaN]) {
    assert.equal(holds('vip', 'is', { value: true }, { vip }), false, String(vip));
    assert.equal(holds('vip', 'is', { value: false }, { vip }), false, String(vip));
    assert.equal(holds('vip', 'empty', {}, { vip }), true, String(vip));
    assert.equal(holds('vip', 'not_empty', {}, { vip }), false, String(vip));
  }
});

test('evaluate, opción: identificadores que se comparan tal cual', () => {
  const record = { stage: 'pagado', source: 7 };
  const table = [
    ['stage', 'eq', 'pagado', true],
    ['stage', 'eq', 'nuevo', false],
    ['stage', 'neq', 'pagado', false],
    ['stage', 'neq', 'nuevo', true],
    ['stage', 'in', ['nuevo', 'pagado'], true],
    ['stage', 'in', ['nuevo'], false],
    ['stage', 'not_in', ['nuevo', 'pagado'], false],
    ['stage', 'not_in', ['nuevo'], true],
    ['source', 'eq', '7', true],
    ['source', 'eq', 7, true],
    ['source', 'in', [7, 8], true],
    ['source', 'eq', '07', false],
  ];
  for (const [field, op, value, want] of table)
    assert.equal(holds(field, op, { value }, record), want, `${field} ${op} ${JSON.stringify(value)}`);
  // Sin normalizar: mayúsculas y acentos cuentan.
  assert.equal(holds('source', 'eq', { value: 'Web' }, { source: 'web' }), false);
  assert.equal(holds('source', 'eq', { value: 'web' }, { source: 'web' }), true);
  assert.equal(holds('source', 'eq', { value: 'web' }, { source: ' web ' }), false);
  for (const stage of [null, undefined, '']) {
    const empty = { stage };
    assert.equal(holds('stage', 'empty', {}, empty), true, String(stage));
    assert.equal(holds('stage', 'not_empty', {}, empty), false, String(stage));
    assert.equal(holds('stage', 'eq', { value: 'nuevo' }, empty), false, String(stage));
    assert.equal(holds('stage', 'in', { value: ['nuevo'] }, empty), false, String(stage));
    assert.equal(holds('stage', 'neq', { value: 'nuevo' }, empty), true, String(stage));
    assert.equal(holds('stage', 'not_in', { value: ['nuevo'] }, empty), true, String(stage));
  }
  assert.equal(holds('stage', 'empty', {}, record), false);
  assert.equal(holds('source', 'empty', {}, { source: 0 }), false, 'el cero es un identificador');
  // Un valor guardado que ya no es opción (dato viejo) se evalúa sin problema.
  assert.equal(holds('stage', 'neq', { value: 'nuevo' }, { stage: 'etapa-vieja' }), true);
});

test('evaluate, lista: alguna, todas, ninguna', () => {
  const record = { tags: ['a', 'b', 'b', 7] };
  const table = [
    ['any', ['a'], true],
    ['any', ['x', 'b'], true],
    ['any', ['x', 'y'], false],
    ['any', ['7'], true],
    ['any', [7], true],
    ['all', ['a'], true],
    ['all', ['a', 'b'], true],
    ['all', ['a', 'b', 7], true],
    ['all', ['a', 'x'], false],
    ['all', ['x'], false],
    ['none', ['x', 'y'], true],
    ['none', ['x', 'a'], false],
  ];
  for (const [op, value, want] of table)
    assert.equal(holds('tags', op, { value }, record), want, `${op} ${JSON.stringify(value)}`);
  assert.equal(holds('tags', 'empty', {}, record), false);
  assert.equal(holds('tags', 'not_empty', {}, record), true);
  assert.equal(holds('tags', 'all', { value: ['a', 'b'] }, { tags: new Set(['b', 'a', 'c']) }), true);
  assert.equal(holds('tags', 'any', { value: ['A'] }, record), false, 'sin normalizar');
  // Sin lista, o con algo que no lo es, no hay etiquetas.
  for (const tags of [null, undefined, [], 'a', { a: true }, 7]) {
    const empty = { tags };
    assert.equal(holds('tags', 'empty', {}, empty), true, String(tags));
    assert.equal(holds('tags', 'not_empty', {}, empty), false, String(tags));
    assert.equal(holds('tags', 'any', { value: ['a'] }, empty), false, String(tags));
    assert.equal(holds('tags', 'all', { value: ['a'] }, empty), false, String(tags));
    assert.equal(holds('tags', 'none', { value: ['a'] }, empty), true, String(tags));
  }
  // Un elemento nulo no coincide con nada, pero la lista no está vacía.
  assert.equal(holds('tags', 'any', { value: ['null'] }, { tags: [null, undefined] }), false);
  assert.equal(holds('tags', 'empty', {}, { tags: [null] }), false);
});

test('evaluate: familias (atributos) y campos de tipo propio', () => {
  const record = { attr: { company: 'ACME, S.A.', visits: 3, plan: 'pro', newsletter: 1 }, orders: [120, 80] };
  assert.equal(holds('attr', 'contains', { key: 'company', value: 'acme' }, record), true);
  assert.equal(holds('attr', 'gte', { key: 'visits', value: 3 }, record), true);
  assert.equal(holds('attr', 'eq', { key: 'plan', value: 'basico' }, record), false);
  assert.equal(holds('attr', 'is', { key: 'newsletter', value: true }, record), true);
  assert.equal(holds('attr', 'empty', { key: 'renewal' }, record), true);
  // Sin el dato, o sin la bolsa de datos, el atributo está vacío.
  for (const other of [{}, { attr: null }, { attr: {} }, { attr: 'x' }]) {
    assert.equal(holds('attr', 'empty', { key: 'company' }, other), true);
    assert.equal(holds('attr', 'neq', { key: 'plan', value: 'pro' }, other), true);
    assert.equal(holds('attr', 'gt', { key: 'visits', value: 0 }, other), false);
  }
  // Un dato heredado de otro objeto no cuenta como propio del registro.
  assert.equal(holds('attr', 'empty', { key: 'company' }, { attr: Object.create({ company: 'heredada' }) }), true);
  // El campo propio recibe la condición guardada, el registro y el ahora.
  assert.equal(holds('orders', 'exists', {}, record), true);
  assert.equal(holds('orders', 'exists', { min: 100 }, record), true);
  assert.equal(holds('orders', 'exists', { min: 500 }, record), false);
  assert.equal(holds('orders', 'not_exists', { min: 500 }, record), true);
  assert.equal(holds('orders', 'exists', {}, {}), false);
  const seen = [];
  const fields = defineFields([{ key: 'x', type: 'custom', ops: ['ok'], test: (...args) => seen.push(args) }]);
  const rule = { field: 'x', op: 'ok', extra: { deep: [1, 2] } };
  assert.equal(
    evaluate({ groups: [{ rules: [rule] }] }, { id: 1 }, fields, NOW),
    true,
    'el resultado se toma como sí o no',
  );
  assert.deepEqual(seen, [[rule, { id: 1 }, { now: NOW }]]);
  assert.notEqual(seen[0][0], rule, 'recibe una copia: no puede modificar la definición');
});

test('evaluate: Y dentro del grupo, O entre grupos, y `match` para invertirlo', () => {
  const a = { field: 'city', op: 'eq', value: 'Puebla' };
  const b = { field: 'age', op: 'gte', value: 18 };
  const c = { field: 'vip', op: 'is', value: true };
  const people = [
    { city: 'Puebla', age: 20, vip: 1 },
    { city: 'Puebla', age: 20, vip: 0 },
    { city: 'Puebla', age: 10, vip: 1 },
    { city: 'Mérida', age: 20, vip: 1 },
    { city: 'Mérida', age: 10, vip: 0 },
  ];
  const matches = definition => people.map(person => evaluate(definition, person, FIELDS)).join(' ');
  // Por omisión: (a Y b) O c.
  assert.equal(matches({ groups: [{ rules: [a, b] }, { rules: [c] }] }), 'true true true true false');
  assert.equal(
    matches({
      match: 'any',
      groups: [
        { match: 'all', rules: [a, b] },
        { match: 'all', rules: [c] },
      ],
    }),
    'true true true true false',
  );
  // Todos los grupos: (a Y b) Y c.
  assert.equal(matches({ match: 'all', groups: [{ rules: [a, b] }, { rules: [c] }] }), 'true false false false false');
  // Alguna condición del grupo: a O b.
  assert.equal(matches({ groups: [{ match: 'any', rules: [a, b] }] }), 'true true true true false');
  // (a O b) Y c.
  assert.equal(
    matches({ match: 'all', groups: [{ match: 'any', rules: [a, b] }, { rules: [c] }] }),
    'true false true true false',
  );
  // Sin condiciones todos cumplen; un grupo vacío no decide nada.
  for (const empty of [
    null,
    undefined,
    {},
    { groups: [] },
    { match: 'all', groups: [{ rules: [] }, {}] },
    { match: 'any', groups: [{}] },
  ])
    assert.equal(matches(empty), 'true true true true true', JSON.stringify(empty));
  assert.equal(matches({ match: 'any', groups: [{ rules: [] }, { rules: [c] }] }), 'true false true true false');
  assert.equal(matches({ match: 'all', groups: [{ rules: [] }, { rules: [c] }] }), 'true false true true false');
  // `matcher` prepara una vez y da lo mismo que `evaluate`.
  const definition = { groups: [{ rules: [a, b] }, { rules: [c] }] };
  const check = matcher(definition, FIELDS);
  assert.deepEqual(
    people.map(person => check(person, NOW)),
    people.map(person => evaluate(definition, person, FIELDS, NOW)),
  );
  // Evaluar no modifica ni la definición ni el registro.
  const frozen = Object.freeze({
    groups: Object.freeze([Object.freeze({ rules: Object.freeze([Object.freeze(a)]) })]),
  });
  assert.equal(evaluate(frozen, Object.freeze({ city: 'puebla' }), FIELDS), true);
});

test(
  'entradas desmedidas: ni una definición ni un mensaje enormes ponen a trabajar de más',
  { timeout: 120_000 },
  () => {
    // Con un algoritmo cuadrático el primer caso tarda más de dos minutos (medido); aquí todo junto, menos de un
    // segundo. El margen es amplio a propósito, para que una máquina ocupada no haga fallar la prueba.
    const started = Date.now();
    const digits = '1'.repeat(200_000);
    assert.deepEqual(validate(one('age', 'eq', { value: digits + 'x' }), FIELDS).slice(0, 1), [
      'Grupo 1, condición 1 («Edad»): el valor debe ser un número.',
    ]);
    assert.deepEqual(
      validate(one('age', 'eq', { value: digits }), FIELDS).length,
      2,
      'ni siquiera un número tan largo',
    );
    assert.deepEqual(validate(one('name', 'eq', { value: 'a '.repeat(100_000) }), FIELDS).slice(0, 1), [
      'Grupo 1, condición 1 («Nombre»): el texto admite hasta 200 caracteres.',
    ]);
    // Un mensaje de 200 000 palabras, o una sola «palabra» de un millón de letras, contra una clave parecida.
    const fuzzy = matcher(
      one('note', 'keyword', { mode: 'fuzzy', value: ['hidrocarburos', 'ciencia de materiales'] }),
      FIELDS,
    );
    assert.equal(fuzzy({ note: 'palabra '.repeat(200_000) + 'hidrocaburos' }), false);
    assert.equal(fuzzy({ note: 'hidrocaburos ' + 'palabra '.repeat(200_000) }), true);
    assert.equal(fuzzy({ note: 'x'.repeat(1_000_000) }), false);
    assert.equal(fuzzy({ note: 'x'.repeat(1_000_000) + ' ciensia de materiales' }), true);
    assert.equal(normalizeText('¡Hola! '.repeat(100_000)).length, 500_000 - 1);
    const contains = matcher(one('note', 'contains', { value: 'aguja' }), FIELDS);
    assert.equal(contains({ note: 'paja '.repeat(200_000) + 'aguja' }), true);
    assert.ok(Date.now() - started < 15_000, `tardó ${Date.now() - started} ms`);
  },
);

// ---- Compilar a SQL

test('compile: cada valor de la definición viaja como parámetro, nunca dentro del SQL', () => {
  const definition = {
    match: 'any',
    groups: [
      {
        rules: [
          { field: 'name', op: 'contains', value: 'María' },
          { field: 'age', op: 'gte', value: 18 },
        ],
      },
      {
        match: 'any',
        rules: [
          { field: 'tags', op: 'any', value: ['a', 'b'] },
          { field: 'stage', op: 'eq', value: 'pagado' },
        ],
      },
    ],
  };
  assert.deepEqual(compile(definition, FIELDS), {
    sql:
      "(((instr(' ' || cond_norm(p.name) || ' ', ?) > 0) AND (typeof(p.age) IN ('integer', 'real') AND p.age >= ?)) OR " +
      '((EXISTS (SELECT 1 FROM people_tags t WHERE (t.person_id = p.id) AND t.tag IN (?, ?))) OR (p.stage IS NOT NULL AND p.stage IN (?))))',
    params: [' maria ', 18, 'a', 'b', 'pagado'],
  });
  assert.deepEqual(compile(null, FIELDS), { sql: '1', params: [] });
  assert.deepEqual(compile({ groups: [{ rules: [] }] }, FIELDS), { sql: '1', params: [] });
  assert.deepEqual(compile(one('name', 'eq', { value: 'María' }), FIELDS), {
    sql: '(cond_norm(p.name) = ?)',
    params: ['maria'],
  });
  // Una columna ya normalizada evita llamar a la función por fila.
  assert.deepEqual(compile(one('name_fast', 'eq', { value: 'María' }), FIELDS), {
    sql: "(COALESCE(p.name_key, '') = ?)",
    params: ['maria'],
  });
  assert.deepEqual(compile(one('created', 'in_last_days', { value: 7 }), FIELDS, { now: NOW }), {
    sql: "(typeof(p.created_at) IN ('integer', 'real') AND p.created_at >= ? AND p.created_at <= ?)",
    params: [NOW - 7 * DAY, NOW],
  });
  assert.deepEqual(compile(one('created', 'in_last_days', { value: 7 }), FIELDS, { now: new Date(NOW) }).params, [
    NOW - 7 * DAY,
    NOW,
  ]);
  assert.deepEqual(
    compile(one('vip', 'is', { value: true }), FIELDS).params,
    [1],
    'un sí viaja como 1: SQLite no tiene booleanos',
  );
  assert.deepEqual(compile(one('vip', 'is', { value: false }), FIELDS).params, [0]);
  assert.deepEqual(compile(one('tags', 'all', { value: ['a', 'b', 'a'] }), FIELDS), {
    sql: '((SELECT COUNT(DISTINCT t.tag) FROM people_tags t WHERE (t.person_id = p.id) AND t.tag IN (?, ?)) = ?)',
    params: ['a', 'b', 2],
  });
  assert.deepEqual(compile(one('orders', 'exists', { min: 100 }), FIELDS), {
    sql: '(COALESCE((EXISTS (SELECT 1 FROM orders o WHERE o.person_id = p.id AND o.total >= ?)), 0) <> 0)',
    params: [100],
  });
  assert.deepEqual(
    compile(one('note', 'keyword', { mode: 'fuzzy', value: ['Hidrocarburos', 'sí'], threshold: 85 }), FIELDS),
    {
      sql: '(cond_fuzzy(p.note, ?, ?) = 1)',
      params: ['["hidrocarburos","si"]', 85],
    },
  );
  assert.equal(SQL_NORM, 'cond_norm');
  assert.equal(SQL_FUZZY, 'cond_fuzzy');
  // Un campo propio debe devolver su SQL.
  const broken = defineFields([{ key: 'x', type: 'custom', ops: ['ok'], test: () => true, sql: () => 'EXISTS (…)' }]);
  assert.throws(() => compile(one('x', 'ok'), broken), TypeError);
});

test('compile: un valor hostil no cambia la consulta', () => {
  const hostile = [
    "x' OR '1'='1",
    '"; DROP TABLE people; --',
    "') OR 1=1 --",
    'a ? b',
    '%',
    '_',
    '\\',
    "Robert'); DROP TABLE people;--",
  ];
  for (const value of hostile) {
    const shapes = [
      [one('name', 'eq', { value }), one('name', 'eq', { value: 'inofensivo' })],
      [one('name', 'contains', { value }), one('name', 'contains', { value: 'inofensivo' })],
      [one('name', 'in', { value: [value, 'otro'] }), one('name', 'in', { value: ['uno', 'otro'] })],
      [one('note', 'keyword', { value: [value] }), one('note', 'keyword', { value: ['inofensivo'] })],
      [
        one('note', 'keyword', { mode: 'fuzzy', value: [value] }),
        one('note', 'keyword', { mode: 'fuzzy', value: ['inofensivo'] }),
      ],
      [one('source', 'eq', { value }), one('source', 'eq', { value: 'inofensivo' })],
      [one('source', 'in', { value: [value, 'b'] }), one('source', 'in', { value: ['a', 'b'] })],
      [one('tags', 'any', { value: [value] }), one('tags', 'any', { value: ['inofensivo'] })],
      [one('tags', 'all', { value: [value, 'b'] }), one('tags', 'all', { value: ['a', 'b'] })],
      [
        one('attr', 'starts_with', { key: 'company', value }),
        one('attr', 'starts_with', { key: 'company', value: 'inofensivo' }),
      ],
    ];
    for (const [dangerous, harmless] of shapes) {
      // Si el valor sólo trae signos, la validación ya lo rechazó antes de llegar a SQL.
      if (validate(dangerous, FIELDS).length) continue;
      const compiled = compile(dangerous, FIELDS);
      assert.equal(compiled.sql, compile(harmless, FIELDS).sql, value);
      assert.equal((compiled.sql.match(/\?/g) || []).length, compiled.params.length, value);
      // Los valores de una sola letra coinciden por casualidad con algún nombre de columna: no dicen nada.
      if (value.length > 1) assert.equal(compiled.sql.includes(value), false, value);
    }
  }
  // La clave de un atributo tampoco llega al SQL: sólo elige entre las declaraciones del registro.
  assert.deepEqual(validate(one('attr', 'eq', { key: "company') OR 1=1 --", value: 'x' }), FIELDS).length, 1);
});

// ---- La misma respuesta en memoria y en SQL

const NAMES = [
  'María José Pérez',
  'MARIA JOSE PEREZ',
  'maria-josé pérez',
  'José María',
  'Ana Pérez',
  'ana perez',
  'Añil Núñez',
  'Ángel',
  'Luis  Ángel',
  "O'Brien",
  'Søren',
  'Zoë Müller',
];
NAMES.push(
  '李雷',
  'Иван Петров',
  'curso',
  'Recurso de curso',
  '¡Hola! ¿Cómo estás?',
  'Ana',
  'ANA MARÍA',
  'mar',
  'Marta',
  '???',
  FACE,
  `Ana ${FACE}`,
  'a',
  '0',
  "x' OR '1'='1",
  'María',
);
const BLANKS = [
  null,
  null,
  '',
  ' ',
  '   ',
  '\t',
  '\n',
  NBSP,
  EM_SPACE + IDEOGRAPHIC_SPACE,
  BYTE_ORDER_MARK,
  LINE_SEPARATOR + '\r\n',
  ZERO_WIDTH,
  NEXT_LINE,
  `${NBSP}Ana${EM_SPACE}`,
];
const CITIES = [
  'Puebla',
  'PUEBLA',
  'puebla de zaragoza',
  'Mérida',
  'merida',
  'Ciudad de México',
  'CDMX',
  'San Luis Potosí',
  'Monterrey',
  '',
  null,
];
const NOTES = [
  'Quiero informes del curso',
  'curso',
  '¿Tienen el curso de hidrocaburos?',
  'me interesa hidrocarburos',
  'un recurso',
  'ciensia de materiales por favor',
];
NOTES.push(
  'Ciencia de Materiales',
  'integridad de ductos',
  'info de integridad  de   ductos!!',
  'sí',
  'si claro',
  'sip',
  'no gracias',
  'precio?',
  FACE,
  '',
  null,
  'hola buenas tardes',
);
const COMPANIES = ['ACME, S.A. de C.V.', 'acme', 'Grupo Ávila', 'grupo avila', 'TEC Capital', '', '  '];
const TAGS = ['vip', 'alumno', 'moroso', 'prensa', 'VIP', '7', 'a b'];
const LANGS = ['es', 'en', 'fr', 'pt'];
const SOURCES = ['web', 'Web', 'import', 'whatsapp', 'api', '', null, 'x y'];
const PLANS = ['basico', 'pro', 'oro', ''];

function buildPeople(count, seed) {
  const next = random(seed);
  const maybe = (chance, make) => (next() < chance ? make() : null);
  // Uno de cada cuatro instantes es de los que las condiciones nombran, para que «igual a» tenga a quién encontrar.
  const instantNear = () =>
    next() < 0.25
      ? pick(next, [NOW, NOW - 30 * DAY, NOW - 200 * DAY, NOW + DAY, Date.UTC(2026, 10, 13), Date.UTC(2026, 5, 1)])
      : NOW - Math.floor((next() * 400 - 20) * DAY) + Math.floor(next() * DAY);
  return Array.from({ length: count }, (_, index) => {
    const attr = {};
    if (next() < 0.6) attr.company = pick(next, COMPANIES);
    if (next() < 0.6) attr.visits = pick(next, [0, 1, 2, 3, 5, 8, 13, 2.5, -1]);
    if (next() < 0.5) attr.renewal = instantNear();
    if (next() < 0.6) attr.plan = pick(next, PLANS);
    if (next() < 0.5) attr.newsletter = pick(next, [0, 1]);
    return {
      id: index + 1,
      name: next() < 0.2 ? pick(next, BLANKS) : pick(next, NAMES),
      city: pick(next, CITIES),
      note: next() < 0.15 ? pick(next, BLANKS) : pick(next, NOTES),
      // Columna sin tipo: además de números guarda textos que parecen números, que no cuentan como número.
      age: pick(next, [null, 0, 1, 17, 18, 18, 19, 30, 30.5, 65, -3, 1e6, '18', '', 'n/d']),
      score: pick(next, [null, 0, 0.1, 2.5, 7, 7, 9.99, 10, 100, -0.5]),
      created_at: maybe(0.85, instantNear),
      last_seen: maybe(0.6, instantNear),
      vip: pick(next, [null, 0, 0, 1, 1, 2, 'si', 0.5]),
      stage: pick(next, [...STAGES, ...STAGES, '', null, 'etapa-vieja']),
      source: pick(next, SOURCES),
      tags: next() < 0.25 ? [] : some(next, [...TAGS, ...TAGS, null], 4),
      langs: next() < 0.2 ? null : next() < 0.15 ? [] : some(next, LANGS, 3),
      attr,
      orders: next() < 0.5 ? [] : some(next, [50, 99.5, 100, 250, 1200], 3),
    };
  });
}

function openDatabase(people) {
  const db = new DatabaseSync(':memory:');
  registerSqlFunctions(db);
  db.exec(`
    CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, name_key TEXT, city TEXT, note TEXT, age, score REAL,
      created_at INTEGER, last_seen INTEGER, vip, stage TEXT, source TEXT, langs TEXT);
    CREATE TABLE people_tags(person_id INTEGER NOT NULL, tag TEXT);
    CREATE TABLE attrs(person_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, num REAL, PRIMARY KEY(person_id, key));
    CREATE TABLE orders(person_id INTEGER NOT NULL, total REAL NOT NULL);
  `);
  const person = db.prepare('INSERT INTO people VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const tag = db.prepare('INSERT INTO people_tags VALUES(?,?)');
  const attr = db.prepare('INSERT INTO attrs VALUES(?,?,?,?)');
  const order = db.prepare('INSERT INTO orders VALUES(?,?)');
  for (const p of people) {
    const key = p.name === null ? null : normalizeText(p.name);
    const langs = p.langs === null ? null : JSON.stringify(p.langs);
    person.run(
      p.id,
      p.name,
      key,
      p.city,
      p.note,
      p.age,
      p.score,
      p.created_at,
      p.last_seen,
      p.vip,
      p.stage,
      p.source,
      langs,
    );
    for (const value of p.tags) tag.run(p.id, value);
    for (const [name, value] of Object.entries(p.attr))
      attr.run(p.id, name, typeof value === 'string' ? value : null, typeof value === 'number' ? value : null);
    for (const total of p.orders) order.run(p.id, total);
  }
  return db;
}

const NEEDLES = [
  'maria',
  'María José',
  'JOSE',
  'pérez',
  'ana',
  'Ana María',
  'mar',
  'curso',
  'recurso',
  'angel',
  'luis angel',
  'o brien',
  'søren',
  '李雷',
  'иван',
];
NEEDLES.push(
  'puebla',
  'Mérida',
  'ciudad de mexico',
  'cdmx',
  'san luis',
  'acme',
  'grupo ávila',
  'tec',
  'hola',
  'como estas',
  '0',
  'a',
  'x',
  "x' OR '1'='1",
  'zoe muller',
  'm',
);
const WORDS = [
  'curso',
  'hidrocarburos',
  'ciencia de materiales',
  'integridad de ductos',
  'ductos',
  'sí',
  'no',
  'precio',
  'informes',
  'recurso',
  'buenas tardes',
];

// Valores para cada tipo de campo, sacados de los mismos datos para que haya aciertos y fallos.
function ruleFor(next, key, type, op) {
  const instantValue = () =>
    pick(next, [
      NOW,
      NOW - 30 * DAY,
      NOW - 200 * DAY,
      NOW + DAY,
      '2026-11-13',
      '2026-06-01',
      '2026-01-15T10:30:00-06:00',
      '2025-12-31T23:59:59Z',
    ]);
  const sorted = (a, b, read) => (read(a) <= read(b) ? { from: a, to: b } : { from: b, to: a });
  if (op === 'empty' || op === 'not_empty') return { op };
  if (type === 'text') {
    if (op === 'keyword') {
      const mode = pick(next, KEYWORD_MODES);
      return {
        op,
        mode,
        value: some(next, WORDS, 3),
        ...(mode === 'fuzzy' && next() < 0.7 ? { threshold: 60 + Math.floor(next() * 36) } : {}),
      };
    }
    return { op, value: op === 'in' || op === 'not_in' ? some(next, NEEDLES, 3) : pick(next, NEEDLES) };
  }
  if (type === 'number') {
    const numbers = [0, 1, 2, 2.5, 3, 7, 10, 17, 18, 19, 30, 30.5, 65, 100, -1, -3, 1e6];
    return {
      op,
      value: op === 'between' ? sorted(pick(next, numbers), pick(next, numbers), n => n) : pick(next, numbers),
    };
  }
  if (type === 'date') {
    if (op === 'in_last_days' || op === 'not_in_last_days') return { op, value: pick(next, [1, 7, 30, 90, 365, 3650]) };
    if (op === 'between')
      return {
        op,
        value: sorted(instantValue(), instantValue(), value => (typeof value === 'number' ? value : Date.parse(value))),
      };
    return { op, value: instantValue() };
  }
  if (type === 'boolean') return { op, value: next() < 0.5 };
  if (type === 'custom') return { op, ...(next() < 0.7 ? { min: pick(next, [0, 50, 100, 101, 1000, 5000]) } : {}) };
  const pool = { stage: STAGES, source: SOURCES.filter(Boolean), plan: ['basico', 'pro'], tags: TAGS, langs: LANGS }[
    key
  ];
  const single = type === 'choice' && (op === 'eq' || op === 'neq');
  return { op, value: single ? pick(next, pool) : some(next, pool, 3) };
}

// Todos los campos consultables con su tipo y sus operadores: de ahí salen las condiciones.
const QUERYABLE = describeFields(FIELDS).filter(field => field.queryable);

function randomRule(next) {
  const field = pick(next, QUERYABLE);
  const op = pick(next, field.ops).op;
  return {
    field: field.field,
    ...(field.key ? { key: field.key } : {}),
    ...ruleFor(next, field.key ?? field.field, field.type, op),
  };
}

test('propiedad: evaluate y compile dan exactamente las mismas filas', () => {
  const people = buildPeople(300, 20261113);
  const db = openDatabase(people);
  const total = people.length;
  const viaSql = (definition, now = NOW) => {
    const { sql, params } = compile(definition, FIELDS, { now });
    assert.equal((sql.match(/\?/g) || []).length, params.length, sql);
    for (const param of params)
      assert.ok(['string', 'number'].includes(typeof param), `parámetro de tipo ${typeof param}`);
    return db
      .prepare(`SELECT p.id FROM people p WHERE ${sql} ORDER BY p.id`)
      .all(...params)
      .map(row => row.id);
  };
  // En memoria: `matcher` prepara la definición una vez para las 300 personas; con una parte de ellas se comprueba
  // además que `evaluate`, que la prepara en cada llamada, responde lo mismo.
  const viaMemory = (definition, now = NOW) => {
    const check = matcher(definition, FIELDS);
    for (const person of people.slice(0, 20))
      assert.equal(evaluate(definition, person, FIELDS, now), check(person, now));
    return people.filter(person => check(person, now)).map(person => person.id);
  };
  const next = random(7);
  const seen = new Map();
  const count = (key, matched) => {
    const entry = seen.get(key) ?? { runs: 0, some: 0, notAll: 0 };
    entry.runs++;
    if (matched > 0) entry.some++;
    if (matched < total) entry.notAll++;
    seen.set(key, entry);
  };

  // 1) Cada operador de cada campo, solo, con varios valores.
  let single = 0;
  for (const field of QUERYABLE)
    for (const { op } of field.ops)
      for (let round = 0; round < 8; round++) {
        const rule = {
          field: field.field,
          ...(field.key ? { key: field.key } : {}),
          ...ruleFor(next, field.key ?? field.field, field.type, op),
        };
        const definition = { groups: [{ rules: [rule] }] };
        const expected = viaMemory(definition);
        assert.deepEqual(viaSql(definition), expected, JSON.stringify(rule));
        count(`${field.type}:${op}`, expected.length);
        single++;
      }
  // Ninguna comparación fue de adorno: cada operador acertó alguna vez y descartó alguna vez.
  for (const [key, entry] of seen) {
    assert.ok(entry.some > 0, `${key} nunca seleccionó a nadie`);
    assert.ok(entry.notAll > 0, `${key} siempre seleccionó a todos`);
  }
  for (const [type, ops] of Object.entries(OPERATORS))
    for (const op of ops) assert.ok(seen.has(`${type}:${op}`), `${type}:${op} sin probar`);
  assert.ok(seen.has('custom:exists') && seen.has('custom:not_exists'));

  // 2) Definiciones al azar: varios grupos, las dos formas de combinar y de 1 a 4 condiciones por grupo.
  let mixed = 0;
  let interesting = 0;
  for (let round = 0; round < 1200; round++) {
    const definition = {
      version: 1,
      match: pick(next, ['any', 'all']),
      groups: Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({
        match: pick(next, ['all', 'any']),
        rules: Array.from({ length: 1 + Math.floor(next() * 4) }, () => randomRule(next)),
      })),
    };
    assert.deepEqual(validate(definition, FIELDS, { sql: true }), [], JSON.stringify(definition));
    const now = next() < 0.8 ? NOW : NOW + Math.floor((next() * 60 - 30) * DAY);
    const expected = viaMemory(definition, now);
    assert.deepEqual(viaSql(definition, now), expected, JSON.stringify(definition));
    // La forma canónica significa lo mismo.
    if (round % 10 === 0)
      assert.deepEqual(viaSql(normalize(definition, FIELDS), now), expected, JSON.stringify(definition));
    if (expected.length > 0 && expected.length < total) interesting++;
    mixed++;
  }
  assert.ok(interesting > mixed / 3, `sólo ${interesting} de ${mixed} definiciones separaron a la gente`);

  // 3) Sin condiciones, todos; y la tabla sigue entera después de los valores hostiles.
  assert.equal(viaSql(null).length, total);
  assert.equal(viaSql({ groups: [{ rules: [] }] }).length, total);
  assert.equal(db.prepare('SELECT count(*) n FROM people').get().n, total);
  assert.ok(single > 500 && mixed === 1200);
  db.close();
});

test('propiedad: una condición y su negación reparten a todos sin repetir a nadie', () => {
  const people = buildPeople(200, 99);
  const db = openDatabase(people);
  const ids = definition => {
    const { sql, params } = compile(definition, FIELDS, { now: NOW });
    return db
      .prepare(`SELECT p.id FROM people p WHERE ${sql} ORDER BY p.id`)
      .all(...params)
      .map(row => row.id);
  };
  const next = random(5);
  const pairs = [
    ['name', 'text', 'eq', 'neq'],
    ['name', 'text', 'contains', 'not_contains'],
    ['name', 'text', 'starts_with', 'not_starts_with'],
    ['city', 'text', 'in', 'not_in'],
    ['note', 'text', 'empty', 'not_empty'],
    ['age', 'number', 'eq', 'neq'],
    ['age', 'number', 'empty', 'not_empty'],
    ['created', 'date', 'in_last_days', 'not_in_last_days'],
    ['created', 'date', 'eq', 'neq'],
    ['last_seen', 'date', 'empty', 'not_empty'],
    ['vip', 'boolean', 'empty', 'not_empty'],
    ['stage', 'choice', 'eq', 'neq'],
    ['stage', 'choice', 'in', 'not_in'],
    ['source', 'choice', 'empty', 'not_empty'],
    ['tags', 'list', 'any', 'none'],
    ['langs', 'list', 'empty', 'not_empty'],
  ];
  for (const [field, type, op, negation] of pairs)
    for (let round = 0; round < 10; round++) {
      const rule = ruleFor(next, field, type, op);
      const yes = ids({ groups: [{ rules: [{ field, ...rule }] }] });
      const no = ids({ groups: [{ rules: [{ field, ...rule, op: negation }] }] });
      assert.equal(yes.length + no.length, people.length, `${field} ${op} ${JSON.stringify(rule)}`);
      assert.equal(new Set([...yes, ...no]).size, people.length, `${field} ${op}`);
      // Y en un grupo con las dos: «todas» no deja a nadie y «alguna» deja a todos.
      const both = [
        { field, ...rule },
        { field, ...rule, op: negation },
      ];
      assert.equal(ids({ groups: [{ match: 'all', rules: both }] }).length, 0);
      assert.equal(ids({ groups: [{ match: 'any', rules: both }] }).length, people.length);
    }
  db.close();
});

test('funciones para SQLite: las mismas de memoria, registradas en la conexión', () => {
  assert.deepEqual(Object.keys(SQL_FUNCTIONS), ['cond_norm', 'cond_fuzzy']);
  assert.ok(Object.isFrozen(SQL_FUNCTIONS));
  const db = new DatabaseSync(':memory:');
  assert.throws(() => db.prepare("SELECT cond_norm('x')"), /no such function/);
  assert.equal(registerSqlFunctions(db), db);
  const row = db
    .prepare(
      'SELECT cond_norm(?) a, cond_norm(NULL) b, cond_norm(42) c, cond_norm(2.5) d, cond_fuzzy(?, ?, 80) e, cond_fuzzy(NULL, ?, 80) f, cond_fuzzy(?, ?, 95) g',
    )
    .get(
      '¡Hóla, MUNDO!',
      'quiero hidrocaburos',
      '["hidrocarburos"]',
      '["hidrocarburos"]',
      'quiero hidrocaburos',
      '["hidrocarburos"]',
    );
  assert.deepEqual({ ...row }, { a: 'hola mundo', b: '', c: '42', d: '2 5', e: 1, f: 0, g: 0 });
  // «Vacío» usa el mismo conjunto de espacios que JavaScript.
  const blank = one('name', 'empty');
  const { sql, params } = compile(blank, FIELDS);
  const isBlank = db.prepare(`SELECT ${sql.replaceAll('p.name', '?1').replace('?)', '?2)')} v`);
  for (const value of [
    null,
    '',
    ' ',
    '\t\r\n',
    NBSP,
    EM_SPACE,
    IDEOGRAPHIC_SPACE,
    BYTE_ORDER_MARK,
    LINE_SEPARATOR,
    ZERO_WIDTH,
    NEXT_LINE,
    `${NBSP}x`,
    'x',
    0,
  ])
    assert.equal(
      isBlank.get(value, params[0]).v === 1,
      evaluate(blank, { name: value }, FIELDS),
      JSON.stringify(value),
    );
  db.close();
});
