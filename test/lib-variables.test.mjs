import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAM_MAX_LENGTH,
  createCatalogue,
  extract,
  extractKeys,
  hasWrittenAmount,
  validate,
  cleanParam,
  render,
  toNumbered,
  toNamed,
  templateParams,
  fillNumbered,
} from '../server/lib/variables.mjs';

// Los sistemas de variables que este resolutor unifica. Si algún día se retiran, las pruebas de compatibilidad se
// saltan solas; las demás no dependen de ellos.
const legacyFlows = await import('../server/flows.mjs').catch(() => ({}));
const legacyQuick = await import('../server/quickreplies.mjs').catch(() => ({}));
const legacyCatalogue = await import('../server/catalogue.mjs').catch(() => ({}));

// Los caracteres invisibles se construyen: escritos tal cual no pasarían la puerta de codificación del repositorio.
const chr = String.fromCharCode;
const NBSP = chr(0xa0);
const LINE_SEPARATOR = chr(0x2028);
const PARAGRAPH_SEPARATOR = chr(0x2029);
const ZERO_WIDTH_JOINER = chr(0x200d);
const FACE = String.fromCodePoint(0x1f600);

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
const thrown = fn => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

// El catálogo del diseño del núcleo (§4.4): persona, conversación, quien envía, catálogo, atributos y variables de flujo.
const CATALOGUE = createCatalogue([
  { key: 'nombre', label: 'Nombre de pila', source: 'contacto', sample: 'María', group: 'Persona', fallback: 'Hola' },
  { key: 'nombre_completo', label: 'Nombre completo', source: 'contacto', sample: 'María Pérez', group: 'Persona' },
  { key: 'curso', label: 'Curso', source: 'conversación', sample: 'Plan sanitario para aves', group: 'Curso' },
  { key: 'edicion', label: 'Edición', source: 'conversación', sample: 'Edición noviembre', group: 'Curso' },
  { key: 'marca', label: 'Marca', source: 'conversación', sample: 'GlobalVet', group: 'Curso' },
  { key: 'asesor', label: 'Tu nombre', source: 'quien envía', sample: 'Laura', surfaces: ['quick_reply', 'manual'] },
  {
    key: 'precio',
    label: 'Precio vigente',
    source: 'catálogo',
    sample: '$379.00 MXN',
    surfaces: ['material', 'rule', 'flow'],
  },
  {
    key: 'fecha',
    label: 'Fecha de inicio',
    source: 'catálogo',
    sample: '20 nov 2026',
    surfaces: ['material', 'rule', 'flow'],
  },
  { key: 'contacto.ciudad', label: 'Ciudad', source: 'atributo', sample: 'Puebla', group: 'Datos del contacto' },
  { key: 'var.respuesta', label: 'Respuesta', source: 'flujo', sample: 'Sí', surfaces: ['flow'] },
]);

// ---- Catálogo

test('catálogo: cada variable con etiqueta, fuente y muestra; se consulta, se filtra y se amplía sin cambiarlo', () => {
  assert.deepEqual(CATALOGUE.keys().slice(0, 3), ['nombre', 'nombre_completo', 'curso']);
  assert.equal(CATALOGUE.has('curso'), true);
  assert.equal(CATALOGUE.has('cursos'), false);
  assert.equal(CATALOGUE.get('nada'), undefined);
  assert.deepEqual(
    { ...CATALOGUE.get('nombre') },
    {
      key: 'nombre',
      label: 'Nombre de pila',
      source: 'contacto',
      sample: 'María',
      group: 'Persona',
      surfaces: null,
      fallback: 'Hola',
    },
  );
  assert.deepEqual(CATALOGUE.get('asesor').surfaces, ['quick_reply', 'manual']);
  assert.ok(
    Object.isFrozen(CATALOGUE) &&
      Object.isFrozen(CATALOGUE.get('nombre')) &&
      Object.isFrozen(CATALOGUE.get('asesor').surfaces),
  );
  // Sin superficie, todas; con superficie, las de «en todo» y las de esa superficie.
  assert.equal(CATALOGUE.list().length, 10);
  assert.deepEqual(
    CATALOGUE.list({ surface: 'quick_reply' }).map(entry => entry.key),
    ['nombre', 'nombre_completo', 'curso', 'edicion', 'marca', 'asesor', 'contacto.ciudad'],
  );
  assert.deepEqual(
    CATALOGUE.list({ surface: 'flow' }).map(entry => entry.key),
    ['nombre', 'nombre_completo', 'curso', 'edicion', 'marca', 'precio', 'fecha', 'contacto.ciudad', 'var.respuesta'],
  );
  assert.equal(CATALOGUE.samples().nombre, 'María');
  assert.equal(CATALOGUE.samples()['contacto.ciudad'], 'Puebla');
  // Ampliar devuelve otro catálogo: cada módulo aporta las suyas sin tocar el de los demás.
  const wider = CATALOGUE.extend([{ key: 'cupon', label: 'Cupón', source: 'difusión', sample: 'NOV25' }]);
  assert.equal(wider.has('cupon'), true);
  assert.equal(wider.has('nombre'), true);
  assert.equal(CATALOGUE.has('cupon'), false);
  assert.throws(() => CATALOGUE.extend(['nombre']), TypeError);
});

test('catálogo: acepta nombres sueltos o un objeto de etiquetas y conserva lo que cada módulo le cuelgue', () => {
  const names = createCatalogue(['nombre', 'curso']);
  assert.deepEqual(
    { ...names.get('curso') },
    { key: 'curso', label: 'curso', source: '', sample: '', group: '', surfaces: null, fallback: null },
  );
  // La forma de `quickreplies.VARIABLES`: clave → etiqueta.
  const labels = createCatalogue({ nombre: 'Nombre de pila del cliente', asesor: 'Tu nombre' });
  assert.equal(labels.get('asesor').label, 'Tu nombre');
  const withResolver = createCatalogue({ curso: { label: 'Curso', value: scope => scope.course, sample: 'Aves' } });
  assert.equal(withResolver.get('curso').value({ course: 'Aves' }), 'Aves');
  assert.equal(withResolver.get('curso').key, 'curso');
  assert.deepEqual(createCatalogue().keys(), []);
  for (const bad of [
    [{ key: 'Nombre' }],
    [{ key: 'a b' }],
    [{ key: '' }],
    [{}],
    [null],
    ['1x'],
    ['a.b.c.d'],
    [{ key: 'edición' }],
  ])
    assert.throws(() => createCatalogue(bad), TypeError, JSON.stringify(bad));
  assert.throws(() => createCatalogue(['nombre', 'nombre']), /dos veces/);
  assert.throws(() => createCatalogue([{ key: 'x', surfaces: 'flow' }]), /lista/);
});

// ---- Leer

test('extract: cada llave con su nombre canónico, su respaldo y su posición', () => {
  const text = 'Hola {{ Nombre }}, {{contacto.ciudad|tu ciudad}} y {{1}}; {{a b}} {{Edición}} {{año_1}} {{var.x.y}}';
  assert.deepEqual(extract(text), [
    { raw: '{{ Nombre }}', index: 5, kind: 'named', key: 'nombre', fallback: null },
    { raw: '{{contacto.ciudad|tu ciudad}}', index: 19, kind: 'named', key: 'contacto.ciudad', fallback: 'tu ciudad' },
    { raw: '{{1}}', index: 51, kind: 'numbered', key: null, number: 1, fallback: null },
    { raw: '{{a b}}', index: 58, kind: 'invalid', key: null, name: 'a b', fallback: null },
    { raw: '{{Edición}}', index: 66, kind: 'named', key: 'edicion', fallback: null },
    { raw: '{{año_1}}', index: 78, kind: 'named', key: 'año_1', fallback: null },
    { raw: '{{var.x.y}}', index: 88, kind: 'named', key: 'var.x.y', fallback: null },
  ]);
  for (const token of extract(text)) assert.equal(text.slice(token.index, token.index + token.raw.length), token.raw);
  const kinds = raw => extract(raw).map(token => token.kind);
  assert.deepEqual(
    kinds('{{}} {{ }} {{0}} {{1000}} {{1x}} {{nombre!}} {{a.b.c.d}} {{.a}} {{a.}} {{-a}}'),
    Array(10).fill('invalid'),
  );
  assert.deepEqual(kinds('{{1}} {{ 2 }} {{010}} {{999}}'), Array(4).fill('numbered'));
  assert.deepEqual(
    extract('{{ 2 }} {{010}}').map(token => token.number),
    [2, 10],
  );
  assert.deepEqual(kinds('{{_x}} {{ñu}} {{a1}} {{A_B}} {{ÁRBOL}}'), Array(5).fill('named'));
  assert.equal(extract('{{ÁRBOL}}')[0].key, 'arbol');
  // El respaldo es todo lo que sigue a la primera barra; uno vacío es como no ponerlo.
  assert.equal(extract('{{nombre| amigo | o amiga }}')[0].fallback, 'amigo | o amiga');
  assert.equal(extract('{{nombre|}}')[0].fallback, null);
  assert.equal(extract('{{nombre|   }}')[0].fallback, null);
  // Sin llaves dobles no hay nada; unas llaves de más quedan fuera.
  assert.deepEqual(extract('sin datos, {una} llave y { { espacios } }'), []);
  assert.deepEqual(
    extract('{{{nombre}}}').map(token => [token.raw, token.index]),
    [['{{nombre}}', 1]],
  );
  assert.deepEqual(extract(''), []);
  assert.deepEqual(extract(null), []);
  assert.deepEqual(extract(undefined), []);
  assert.deepEqual(extract(42), []);
});

test('extractKeys: los datos que hay que conseguir, una vez cada uno y en orden de aparición', () => {
  assert.deepEqual(extractKeys('{{curso}} {{nombre}} {{ CURSO }} {{1}} {{a b}} {{contacto.ciudad|x}}'), [
    'curso',
    'nombre',
    'contacto.ciudad',
  ]);
  assert.deepEqual(extractKeys('nada'), []);
});

// ---- Validar

test('validate: un texto correcto no tiene problemas', () => {
  assert.deepEqual(
    validate('¡Hola, {{nombre}}! Tu curso es {{curso}} ({{ Edición }}) en {{contacto.ciudad|tu ciudad}}.', CATALOGUE),
    [],
  );
  assert.deepEqual(validate('Sin datos, con {una} llave y un 50% de avance.', CATALOGUE), []);
  assert.deepEqual(validate('', CATALOGUE), []);
  assert.deepEqual(validate('Te atiende {{asesor}}.', CATALOGUE, { surface: 'quick_reply' }), []);
  assert.deepEqual(validate('Dijiste {{var.respuesta}} y cuesta {{precio}}.', CATALOGUE, { surface: 'flow' }), []);
  // Sin catálogo sólo se revisa la forma.
  assert.deepEqual(validate('Hola {{lo_que_sea}} {{otra.cosa}}'), []);
  // Un catálogo se puede pasar como lista o como objeto de etiquetas.
  assert.deepEqual(validate('{{nombre}}', ['nombre']), []);
  assert.deepEqual(validate('{{nombre}}', { nombre: 'Nombre' }), []);
});

test('validate: dice en español qué corregir, una vez por problema', () => {
  assert.deepEqual(validate('Hola {{nombre}}, {{cursos}} y otra vez {{ Cursos }}.', CATALOGUE), [
    'El mensaje usa un dato que no existe: {{cursos}}.',
  ]);
  assert.deepEqual(validate('Te atiende {{asesor}}.', CATALOGUE, { surface: 'flow' }), [
    'El dato {{asesor}} no está disponible en este tipo de mensaje.',
  ]);
  assert.deepEqual(validate('Dijiste {{var.respuesta}}.', CATALOGUE, { surface: 'quick_reply' }), [
    'El dato {{var.respuesta}} no está disponible en este tipo de mensaje.',
  ]);
  // Sin indicar dónde se usa no se puede objetar la superficie.
  assert.deepEqual(validate('Te atiende {{asesor}}.', CATALOGUE), []);
  assert.deepEqual(validate('Hola {{1}}, tu curso {{2}} y {{1}}.', CATALOGUE), [
    'Usa los datos por su nombre, no por número: «{{1}}».',
    'Usa los datos por su nombre, no por número: «{{2}}».',
  ]);
  assert.deepEqual(validate('Hola {{1}}, tu curso {{2}}.', CATALOGUE, { numbered: true }), []);
  assert.deepEqual(validate('Hola {{nombre del cliente}}.', CATALOGUE), [
    '«{{nombre del cliente}}» no es un dato válido: escribe el nombre del dato entre llaves, como {{nombre}}.',
  ]);
  assert.deepEqual(validate('{{}}', CATALOGUE).length, 1);
  assert.deepEqual(validate('{{a b}} y otra vez {{a b}}', CATALOGUE).length, 1);
  for (const open of [
    'Hola {{nombre',
    'Hola nombre}}',
    'Hola {{nombre}',
    'Hola {nombre}}',
    '{{ {{nombre}} }}',
    '{{nombre}} }} {{',
  ])
    assert.deepEqual(validate(open, CATALOGUE), ['Hay llaves sin cerrar en el texto.'], open);
  for (const missing of [null, undefined, 42, {}, ['{{nombre}}']])
    assert.deepEqual(validate(missing, CATALOGUE), ['Falta el texto.']);
  // Varios problemas a la vez, en el orden en que aparecen.
  assert.deepEqual(validate('{{nada}} {{2}} {{x y}} {{', CATALOGUE).length, 4);
});

test('validate y hasWrittenAmount: un importe escrito a mano se rechaza cuando se pide', () => {
  const problem = 'El texto lleva un importe escrito a mano: los precios salen del catálogo, usa {{precio}}.';
  assert.deepEqual(validate('El curso cuesta $379.', CATALOGUE, { forbidAmounts: true }), [problem]);
  assert.deepEqual(validate('El curso cuesta $379.', CATALOGUE), []);
  assert.deepEqual(validate('El curso cuesta {{precio}}.', CATALOGUE, { forbidAmounts: true }), []);
  for (const text of [
    '$379',
    '$ 379',
    'son 379 pesos',
    '1,500.00 MXN',
    '20 usd',
    '379 PESOS',
    '{{precio|$379}}',
    'Hola {{nombre|379 pesos}}',
  ])
    assert.equal(hasWrittenAmount(text), true, text);
  for (const text of [
    '',
    'cuesta {{precio}}',
    '{{precio}} pesos',
    '$ {{precio}}',
    'cuenta 0123456789',
    'CLABE 012180001234567895',
    '50% de avance',
    'pesos',
    '$',
    null,
  ])
    assert.equal(hasWrittenAmount(text), false, String(text));
});

test('hasWrittenAmount: acepta y rechaza exactamente lo mismo que la expresión de Contenido', () => {
  // La expresión de `server/content.mjs`, copiada: es la regla que este módulo debe conservar.
  const original = /(\$\s?\d|\d[\d.,]*\s?(pesos|mxn|usd)\b)/i;
  for (const text of [
    '.5 pesos',
    ',5 mxn',
    '5,, pesos',
    '1.2.3 usd',
    '5pesos',
    '5  pesos',
    '5\npesos',
    '5 pesosx',
    'x5 usd',
    '$,5',
    '..',
    '5.',
  ])
    assert.equal(hasWrittenAmount(text), original.test(text), text);
  const next = random(21);
  const pieces = ['1', '5', '0', '.', ',', ' ', ' ', '$', 'pesos', 'PESOS', 'mxn', 'usd', 'x', '\n', 'peso', 'a'];
  for (let round = 0; round < 5000; round++) {
    let text = '';
    for (let i = 0; i < Math.floor(next() * 10); i++) text += pick(next, pieces);
    assert.equal(hasWrittenAmount(text), original.test(text), JSON.stringify(text));
  }
});

test('entradas desmedidas: el trabajo crece con el largo del texto, no con su cuadrado', { timeout: 120_000 }, () => {
  // Con un algoritmo cuadrático el primer caso y el de `render` tardan más de medio minuto cada uno (medido); aquí
  // todo junto, menos de un segundo. El margen es amplio a propósito, para que una máquina ocupada no haga fallar.
  const started = Date.now();
  assert.equal(hasWrittenAmount('1'.repeat(200_000)), false);
  assert.equal(hasWrittenAmount('1.'.repeat(100_000) + ' pesos'), true);
  assert.equal(hasWrittenAmount(','.repeat(200_000)), false);
  const many = 'Hola, {{nombre}} y {{curso}}. '.repeat(20_000);
  const removed = render(many, {}, { onMissing: 'remove' });
  assert.deepEqual(removed.missing, ['nombre', 'curso']);
  // Se compara con `===` para que un fallo no imprima medio millón de caracteres.
  assert.ok(removed.text === 'Hola y. '.repeat(20_000), removed.text.slice(0, 40));
  assert.ok(render(many, { nombre: 'Ana', curso: 'Aves' }).text === 'Hola, Ana y Aves. '.repeat(20_000));
  assert.equal(extract(many).length, 40_000);
  assert.equal(extract('{{'.repeat(100_000)).length, 0);
  assert.deepEqual(validate('{{' + 'a'.repeat(200_000), CATALOGUE), ['Hay llaves sin cerrar en el texto.']);
  assert.equal(cleanParam(' x '.repeat(100_000)), 'x '.repeat(100).trimEnd());
  assert.ok(Date.now() - started < 15_000, `tardó ${Date.now() - started} ms`);
});

// ---- Sustituir

test('render: sustituye por nombre, con valores planos, anidados, en un Map o por función', () => {
  const text = '¡Hola, {{nombre}}! Tu curso es {{ Curso }} en {{contacto.ciudad}}.';
  const want = { text: '¡Hola, Ana! Tu curso es Aves en Puebla.', missing: [], unknown: [], defaulted: [] };
  assert.deepEqual(render(text, { nombre: 'Ana', curso: 'Aves', contacto: { ciudad: 'Puebla' } }), want);
  assert.deepEqual(render(text, { nombre: 'Ana', curso: 'Aves', 'contacto.ciudad': 'Puebla' }), want);
  assert.deepEqual(
    render(text, new Map(Object.entries({ nombre: 'Ana', curso: 'Aves', 'contacto.ciudad': 'Puebla' }))),
    want,
  );
  const asked = [];
  const lazy = key => {
    asked.push(key);
    return { nombre: 'Ana', curso: 'Aves', 'contacto.ciudad': 'Puebla' }[key];
  };
  assert.deepEqual(render(text, lazy), want);
  assert.deepEqual(asked, ['nombre', 'curso', 'contacto.ciudad'], 'sólo se piden los datos que el texto usa');
  // La clave plana gana a la anidada; un dato repetido sale igual cada vez.
  assert.equal(render('{{a.b}}', { 'a.b': 'plano', a: { b: 'anidado' } }).text, 'plano');
  assert.equal(render('{{x}} y {{x}} y {{ X }}', { x: 'uno' }).text, 'uno y uno y uno');
  // Números tal cual; el valor no se recorta ni se altera.
  assert.equal(
    render('{{n}} de {{total}} ({{grande}})', { n: 0, total: 12.5, grande: 12345678901234567890n }).text,
    '0 de 12.5 (12345678901234567890)',
  );
  assert.equal(render('[{{x}}]', { x: '  dos  espacios\ny salto ' }).text, '[  dos  espacios\ny salto ]');
  // Sin llaves, el texto vuelve intacto.
  assert.deepEqual(render('  Sin datos.\n\n  Fin  ', {}), {
    text: '  Sin datos.\n\n  Fin  ',
    missing: [],
    unknown: [],
    defaulted: [],
  });
  assert.equal(render(null, {}).text, '');
  assert.equal(render(42, {}).text, '42');
});

test('render: lo que falta o no existe se informa; por omisión la llave se queda en el texto', () => {
  assert.deepEqual(render('Hola {{nombre}}, tu curso es {{curso}}.', { curso: 'Aves' }), {
    text: 'Hola {{nombre}}, tu curso es Aves.',
    missing: ['nombre'],
    unknown: [],
    defaulted: [],
  });
  // Vacío es: sin valor, nulo, texto en blanco o algo que no es texto ni número.
  for (const empty of [
    undefined,
    null,
    '',
    '   ',
    '\n\t',
    NBSP,
    true,
    false,
    {},
    [],
    () => 'x',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Symbol('x'),
  ])
    assert.deepEqual(
      render('[{{x}}]', { x: empty }),
      { text: '[{{x}}]', missing: ['x'], unknown: [], defaulted: [] },
      String(empty),
    );
  for (const values of [undefined, null, 'texto', 42, [], new Map()])
    assert.deepEqual(render('{{x}}', values).missing, ['x']);
  assert.deepEqual(render('{{a}} {{b}} {{a}} {{ A }}', {}).missing, ['a', 'b']);
  // Una llave mal escrita o numerada no es un dato: se deja y se informa aparte.
  assert.deepEqual(render('{{a b}} {{1}} {{}} {{x}}', { x: 'sí' }), {
    text: '{{a b}} {{1}} {{}} sí',
    missing: [],
    unknown: ['a b', '1', ''],
    defaulted: [],
  });
  // Un valor anidado que no llega hasta el final no es un dato.
  assert.deepEqual(render('{{contacto.ciudad}} {{contacto}}', { contacto: { nombre: 'Ana' } }).missing, [
    'contacto.ciudad',
    'contacto',
  ]);
  assert.deepEqual(render('{{a.b.c}}', { a: { b: 'texto' } }).missing, ['a.b.c']);
});

test('render: sólo lee propiedades propias y nunca vuelve a interpretar un valor', () => {
  // Nombres que existen en cualquier objeto no deben encontrar nada.
  const inherited = render('{{constructor}} {{__proto__}} {{toString}} {{hasownproperty}} {{a.constructor}}', {
    a: {},
  });
  assert.equal(inherited.text, '{{constructor}} {{__proto__}} {{toString}} {{hasownproperty}} {{a.constructor}}');
  assert.deepEqual(inherited.missing, ['constructor', '__proto__', 'tostring', 'hasownproperty', 'a.constructor']);
  // Tampoco lo que un objeto hereda de otro: sólo cuenta lo que quien llama puso en él.
  const heir = Object.create({ secreto: 'heredado', dentro: { dato: 'heredado' } });
  heir.propio = 'mío';
  assert.deepEqual(render('{{secreto}} {{dentro.dato}} {{propio}}', heir), {
    text: '{{secreto}} {{dentro.dato}} mío',
    missing: ['secreto', 'dentro.dato'],
    unknown: [],
    defaulted: [],
  });
  assert.deepEqual(render('{{a.secreto}}', { a: heir }).missing, ['a.secreto']);
  // Una lista no es un conjunto de valores: ni su largo ni sus posiciones son datos.
  assert.equal(
    render('{{length}} {{lista.length}} {{lista.0}}', ['x']).text,
    '{{length}} {{lista.length}} {{lista.0}}',
  );
  assert.deepEqual(render('{{lista.length}} {{lista.0}} {{lista}}', { lista: ['x'] }).missing, [
    'lista.length',
    'lista.0',
    'lista',
  ]);
  assert.deepEqual(render('{{texto.length}}', { texto: 'abc' }).missing, ['texto.length']);
  // Una persona que se llama como una variable no consigue el dato de otra.
  assert.equal(render('Hola {{nombre}}', { nombre: '{{precio}}', precio: '$1' }).text, 'Hola {{precio}}');
  // Los signos especiales de reemplazo son texto.
  for (const value of ['$&', '$1', '$$', "$'", '$`', '\\n'])
    assert.equal(render('[{{x}}]', { x: value }).text, `[${value}]`);
});

test('render: respaldo escrito en el texto, respaldo de quien llama y respaldo del catálogo, en ese orden', () => {
  const fallbacks = { nombre: 'qué tal' };
  assert.deepEqual(render('Hola {{nombre|amigo}}', { nombre: 'Ana' }, { fallbacks, catalogue: CATALOGUE }), {
    text: 'Hola Ana',
    missing: [],
    unknown: [],
    defaulted: [],
  });
  assert.deepEqual(render('Hola {{nombre|amigo}}', {}, { fallbacks, catalogue: CATALOGUE }), {
    text: 'Hola amigo',
    missing: [],
    unknown: [],
    defaulted: ['nombre'],
  });
  assert.equal(render('Hola {{nombre}}', {}, { fallbacks, catalogue: CATALOGUE }).text, 'Hola qué tal');
  assert.equal(render('Hola {{nombre}}', {}, { catalogue: CATALOGUE }).text, 'Hola Hola');
  assert.deepEqual(render('Hola {{nombre}}', {}, { catalogue: CATALOGUE }).defaulted, ['nombre']);
  // Un respaldo vacío no cuenta; un valor en blanco usa el respaldo.
  assert.deepEqual(render('Hola {{curso|}}', {}, { fallbacks: { curso: '  ' } }).missing, ['curso']);
  assert.equal(render('Hola {{curso|tu curso}}', { curso: '   ' }).text, 'Hola tu curso');
  assert.equal(render('{{a|uno}} {{a|dos}} {{a}}', {}, { fallbacks: { a: 'tres' } }).text, 'uno dos tres');
  // Tampoco los respaldos se leen de propiedades heredadas.
  assert.deepEqual(render('{{constructor}}', {}, { fallbacks: {} }).missing, ['constructor']);
  assert.deepEqual(render('{{x}}', {}, { fallbacks: Object.create({ x: 'heredado' }) }).missing, ['x']);
  assert.deepEqual(templateParams(['x'], Object.create({ x: 'heredado' })).missing, ['x']);
  assert.equal(render('{{n}}', {}, { fallbacks: { n: 7 } }).text, '7');
});

test('render con catálogo: sólo se sustituyen sus variables', () => {
  const result = render(
    '{{nombre}} {{cupon}} {{1}} {{curso}}',
    { nombre: 'Ana', cupon: 'NOV25' },
    { catalogue: CATALOGUE },
  );
  assert.deepEqual(result, {
    text: 'Ana {{cupon}} {{1}} {{curso}}',
    missing: ['curso'],
    unknown: ['cupon', '1'],
    defaulted: [],
  });
  assert.equal(render('{{cupon}}', { cupon: 'NOV25' }).text, 'NOV25', 'sin catálogo basta con que haya valor');
  assert.equal(render('{{cupon}}', { cupon: 'NOV25' }, { catalogue: ['cupon'] }).text, 'NOV25');
});

test("render con onMissing 'remove': el dato vacío se va con su coma y sin dejar huecos, y aun así se informa", () => {
  const cases = [
    ['¡Hola, {{nombre}}! Tu curso es {{curso}}.', '¡Hola! Tu curso es Aves.'],
    ['Hola {{nombre}}, ¿cómo estás?', 'Hola, ¿cómo estás?'],
    ['Hola {{nombre}} bienvenido', 'Hola bienvenido'],
    ['Hola {{nombre}}', 'Hola'],
    ['Hola {{nombre}}   ', 'Hola'],
    ['{{nombre}}, gracias por escribir', 'gracias por escribir'],
    ['{{nombre}} gracias', 'gracias'],
    ['¡{{nombre}}, hola!', '¡hola!'],
    ['¿{{nombre}}: listo?', '¿listo?'],
    ['Hola\n{{nombre}}, bienvenido', 'Hola\nbienvenido'],
    ['Hola {{nombre}}\n¿Listo?', 'Hola\n¿Listo?'],
    ['Hola {{nombre}}{{apellido}} ok', 'Hola ok'],
    ['Hola {{nombre}} {{apellido}} ok', 'Hola ok'],
    ['Hola {{nombre}} {{apellido}}fin', 'Hola fin'],
    ['Hola{{nombre}} {{apellido}}fin', 'Hola fin'],
    ['Hola{{nombre}} {{curso}}', 'Hola Aves'],
    ['Hola {{nombre}}y adiós', 'Hola y adiós'],
    ['Hola{{nombre}}mundo', 'Holamundo'],
    ['Hola,{{nombre}} bienvenido', 'Hola bienvenido'],
    ['Hola {{nombre}}.', 'Hola.'],
    ['Hola {{nombre}} !', 'Hola!'],
    ['({{nombre}})', '()'],
    ['{{nombre}}', ''],
    ['{{nombre}} {{apellido}}', ''],
    ['Hola {{nombre}}, {{curso}} te espera', 'Hola, Aves te espera'],
    ['Hola {{nombre}} {{curso}}', 'Hola Aves'],
    ['{{nombre}} {{curso}}', 'Aves'],
    ['{{curso}}, {{nombre}}.', 'Aves.'],
    ['Tu curso: {{curso}}. Inicio: {{fecha}}', 'Tu curso: Aves. Inicio:'],
    ['{{a b}} y {{1}}', 'y'],
    // Los tabuladores cuentan como espacio; lo que ya se escribió con valor no se vuelve a tocar.
    ['Hola,\t{{nombre}}!', 'Hola!'],
    ['Hola\t{{nombre}}\tbienvenido', 'Hola bienvenido'],
    ['Hola, {{curso}} {{nombre}}!', 'Hola, Aves!'],
    ['Curso {{curso}},{{nombre}} bienvenido', 'Curso Aves bienvenido'],
    ['A {{nombre}} B{{apellido}}C', 'A BC'],
  ];
  for (const [text, want] of cases) {
    const result = render(text, { curso: 'Aves' }, { onMissing: 'remove' });
    assert.equal(result.text, want, text);
    assert.ok(result.missing.length + result.unknown.length > 0, 'quitar no es callar: ' + text);
    assert.doesNotMatch(result.text, /\{\{|\}\}| {2}/, text);
  }
  // Lo que sí tiene valor no se toca, ni los espacios que la persona escribió a propósito.
  assert.equal(render('Uno:   {{curso}}   dos', { curso: 'Aves' }, { onMissing: 'remove' }).text, 'Uno:   Aves   dos');
  assert.deepEqual(render('¡Hola, {{nombre}}!', { nombre: 'Ana' }, { onMissing: 'remove' }), {
    text: '¡Hola, Ana!',
    missing: [],
    unknown: [],
    defaulted: [],
  });
  assert.equal(render('¡Hola, {{nombre|amiga}}!', {}, { onMissing: 'remove' }).text, '¡Hola, amiga!');
});

test("render con onMissing 'throw' o una función", () => {
  const error = thrown(() => render('Hola {{nombre}}, {{a b}} y {{curso}}', { curso: 'Aves' }, { onMissing: 'throw' }));
  assert.deepEqual([error.name, error.code, error.status], ['VariablesError', 'missing_variables', 422]);
  assert.equal(error.message, 'Faltan datos para escribir el mensaje: {{nombre}}, {{a b}}.');
  assert.deepEqual([error.missing, error.unknown], [['nombre'], ['a b']]);
  assert.equal(render('Hola {{curso}}', { curso: 'Aves' }, { onMissing: 'throw' }).text, 'Hola Aves');
  // Una llave mal escrita o fuera del catálogo también detiene el envío, aunque no falte ningún dato.
  assert.deepEqual(thrown(() => render('Hola {{a b}}', {}, { onMissing: 'throw' }))?.unknown, ['a b']);
  const stranger = thrown(() => render('{{cupon}}', { cupon: 'X' }, { onMissing: 'throw', catalogue: CATALOGUE }));
  assert.deepEqual([stranger?.code, stranger?.missing, stranger?.unknown], ['missing_variables', [], ['cupon']]);
  assert.equal(render('Hola {{nombre|amiga}}', {}, { onMissing: 'throw' }).text, 'Hola amiga');
  // Una función decide el texto de cada dato que falta; lo que no resuelve se queda. Sigue contando como faltante.
  const seen = [];
  const result = render(
    '{{a}} {{b}} {{c}} {{a}}',
    { c: 'C' },
    {
      onMissing: (key, token) => {
        seen.push([key, token.kind]);
        return key === 'a' ? '<a>' : null;
      },
    },
  );
  assert.deepEqual(result, { text: '<a> {{b}} C <a>', missing: ['a', 'b'], unknown: [], defaulted: [] });
  assert.deepEqual(seen, [
    ['a', 'named'],
    ['b', 'named'],
    ['a', 'named'],
  ]);
  for (const bad of ['quitar', '', null, 1, {}])
    assert.throws(() => render('x', {}, { onMissing: bad }), TypeError, String(bad));
});

test('propiedad: nunca desaparece un dato sin avisar', () => {
  const next = random(11);
  const keys = ['nombre', 'curso', 'fecha', 'contacto.ciudad', 'var.x'];
  const words = ['Hola', ',', ' ', '¡', '!', '\n', 'tu curso', '.', '¿', '?', ':', '(', ')'];
  for (let round = 0; round < 500; round++) {
    let text = '';
    const used = new Set();
    for (let i = 0; i < 2 + Math.floor(next() * 10); i++) {
      if (next() < 0.4) {
        const key = pick(next, keys);
        used.add(key);
        text += `{{${key}}}`;
      } else text += pick(next, words);
    }
    const values = {};
    for (const key of keys) if (next() < 0.5) values[key] = 'V' + key.length;
    for (const onMissing of ['keep', 'remove']) {
      const result = render(text, values, { onMissing });
      const absent = [...used].filter(key => !(key in values));
      assert.deepEqual([...result.missing].sort(), absent.sort(), text);
      for (const key of used) if (key in values) assert.ok(result.text.includes(values[key]), text);
      if (onMissing === 'keep') for (const key of absent) assert.ok(result.text.includes(`{{${key}}}`), text);
      else assert.doesNotMatch(result.text, /\{\{/, text);
    }
  }
});

// ---- Plantillas de Meta

test('cleanParam: sin saltos de línea ni tabuladores, nunca más de un espacio seguido y con largo máximo', () => {
  assert.equal(cleanParam('  Ana\nMaría\r\nJosé\tPérez      y  más  '), 'Ana María José Pérez y más');
  assert.equal(
    cleanParam(`a${NBSP}${NBSP}b${LINE_SEPARATOR}c${PARAGRAPH_SEPARATOR}d${chr(0x0b)}e${chr(0x0c)}f`),
    'a b c d e f',
  );
  assert.equal(cleanParam(`a${chr(0)}b${chr(1)}${chr(0x1b)}c${chr(0x7f)}d${chr(0x85)}e`), 'a b c d e');
  assert.equal(cleanParam('texto normal'), 'texto normal');
  assert.equal(cleanParam(12.5), '12.5');
  assert.equal(cleanParam(0), '0');
  for (const empty of [null, undefined, '', '   ', '\n\t', true, {}, []])
    assert.equal(cleanParam(empty), '', String(empty));
  // Largo máximo: 200 por omisión, sin partir un emoji ni dejar un espacio al final.
  assert.equal(PARAM_MAX_LENGTH, 200);
  assert.equal(cleanParam('x'.repeat(500)).length, 200);
  assert.equal(cleanParam('x'.repeat(200)).length, 200);
  assert.equal(cleanParam('abcdef', { maxLength: 3 }), 'abc');
  assert.equal(cleanParam('ab cdef', { maxLength: 3 }), 'ab');
  assert.equal(cleanParam('ab' + FACE + 'cd', { maxLength: 3 }), 'ab');
  assert.equal(cleanParam('ab' + FACE + 'cd', { maxLength: 4 }), 'ab' + FACE);
  // Un emoji compuesto conserva su unión de ancho cero.
  const family = FACE + ZERO_WIDTH_JOINER + FACE;
  assert.equal(cleanParam(` ${family} `), family);
  const next = random(5);
  const pieces = [
    'a',
    'ñ',
    ' ',
    '  ',
    '     ',
    '\n',
    '\r\n',
    '\t',
    NBSP,
    LINE_SEPARATOR,
    FACE,
    '.',
    chr(0x0b),
    chr(0x1f),
  ];
  for (let round = 0; round < 500; round++) {
    let raw = '';
    for (let i = 0; i < Math.floor(next() * 40); i++) raw += pick(next, pieces);
    const clean = cleanParam(raw);
    assert.doesNotMatch(clean, /[\r\n\t\v\f]|\s{2}|^\s|\s$/u, JSON.stringify(raw));
    assert.doesNotMatch(clean, /\p{Cc}/u, JSON.stringify(raw));
    assert.equal(cleanParam(clean), clean, 'limpiar dos veces da lo mismo');
    assert.equal(clean.replace(/\s/gu, ''), raw.replace(/[\s\p{Cc}]/gu, ''), 'no se pierde nada visible');
  }
});

test('render para plantilla: cada valor sale limpio para Meta', () => {
  const values = { nombre: ' Ana\nMaría ', curso: 'Plan\tsanitario     para aves', vacio: '\n\t' };
  assert.deepEqual(render('Hola {{nombre}}, curso {{curso}}.', values, { forTemplate: true }), {
    text: 'Hola Ana María, curso Plan sanitario para aves.',
    missing: [],
    unknown: [],
    defaulted: [],
  });
  // Sin la opción, el valor sale como viene.
  assert.equal(render('{{nombre}}', values).text, ' Ana\nMaría ');
  // El texto fijo no se toca: sólo los valores.
  assert.equal(render('Línea 1\n\n{{nombre}}', values, { forTemplate: true }).text, 'Línea 1\n\nAna María');
  // También se limpian los respaldos y lo que devuelva `onMissing`.
  assert.equal(render('{{x|dos\nlíneas}}', {}, { forTemplate: true }).text, 'dos líneas');
  assert.equal(render('{{x}}', {}, { forTemplate: true, fallbacks: { x: 'a\tb' } }).text, 'a b');
  assert.equal(render('{{x}}', {}, { forTemplate: true, onMissing: () => 'a\n\nb' }).text, 'a b');
  // Un valor que al limpiarse queda vacío es un dato que falta.
  assert.deepEqual(render('[{{vacio}}]', { vacio: chr(1) + chr(2) }, { forTemplate: true }).missing, ['vacio']);
  assert.equal(render('{{x}}', { x: 'y'.repeat(300) }, { forTemplate: true }).text.length, 200);
  assert.equal(render('{{x}}', { x: 'y'.repeat(300) }, { forTemplate: true, maxLength: 50 }).text.length, 50);
});

test('toNumbered: de nombres a los números de Meta, por orden de primera aparición', () => {
  // Lo mismo que hace hoy el alta de plantillas de WhatsApp con sus cuatro datos.
  assert.deepEqual(
    toNumbered('Hola {{nombre}}, ya abrimos {{curso}} ({{ Edición }}) de {{marca}}. {{nombre}}, te esperamos.'),
    {
      text: 'Hola {{1}}, ya abrimos {{2}} ({{3}}) de {{4}}. {{1}}, te esperamos.',
      keys: ['nombre', 'curso', 'edicion', 'marca'],
      fallbacks: {},
    },
  );
  // El ejemplo del diseño de difusiones (§6.2 y §6.3).
  assert.deepEqual(
    toNumbered(
      'Hola {{nombre}}, ya abrimos inscripciones a {{curso}}. Inicia el {{fecha}} y la inversión es de {{precio}}.',
    ),
    {
      text: 'Hola {{1}}, ya abrimos inscripciones a {{2}}. Inicia el {{3}} y la inversión es de {{4}}.',
      keys: ['nombre', 'curso', 'fecha', 'precio'],
      fallbacks: {},
    },
  );
  // Los respaldos escritos en el texto viajan aparte: la forma numerada no puede llevarlos. Gana el primero.
  assert.deepEqual(toNumbered('Hola {{nombre|Hola}} de {{contacto.ciudad|tu ciudad}}, {{nombre|otra}}'), {
    text: 'Hola {{1}} de {{2}}, {{1}}',
    keys: ['nombre', 'contacto.ciudad'],
    fallbacks: { nombre: 'Hola', 'contacto.ciudad': 'tu ciudad' },
  });
  assert.deepEqual(toNumbered('Sin datos'), { text: 'Sin datos', keys: [], fallbacks: {} });
  assert.deepEqual(toNumbered(null), { text: '', keys: [], fallbacks: {} });
  // Cada componente (cuerpo, encabezado, botón) se numera por separado y empieza en 1.
  assert.equal(toNumbered('Curso {{curso}}').text, 'Curso {{1}}');
  assert.equal(toNumbered('https://ejemplo.mx/c/{{cupon}}').text, 'https://ejemplo.mx/c/{{1}}');
  // No se mezclan nombres con números ni se aceptan llaves mal escritas.
  const numbered = thrown(() => toNumbered('Hola {{1}} y {{nombre}}'));
  assert.deepEqual([numbered.name, numbered.code, numbered.status], ['VariablesError', 'invalid_variable', 400]);
  assert.equal(numbered.message, 'Usa los datos por su nombre, no por número: «{{1}}».');
  assert.match(thrown(() => toNumbered('Hola {{a b}}')).message, /no es un dato válido/);
});

test('toNamed y fillNumbered: de vuelta a los nombres y a un texto legible', () => {
  const keys = ['nombre', 'curso'];
  assert.deepEqual(toNamed('Hola {{1}}, tu curso {{2}}. {{ 1 }}', keys), {
    text: 'Hola {{nombre}}, tu curso {{curso}}. {{nombre}}',
    unknown: [],
  });
  // Los números sin clave se dejan y se informan; lo que no es número no se toca.
  assert.deepEqual(toNamed('{{1}} {{3}} {{7}} {{3}} {{ya_nombrada}} {{a b}}', keys), {
    text: '{{nombre}} {{3}} {{7}} {{3}} {{ya_nombrada}} {{a b}}',
    unknown: [3, 7],
  });
  assert.deepEqual(toNamed('{{1}}', []), { text: '{{1}}', unknown: [1] });
  assert.deepEqual(toNamed('{{1}}', null), { text: '{{1}}', unknown: [1] });
  assert.deepEqual(toNamed('{{1}}', ['']), { text: '{{1}}', unknown: [1] });

  assert.deepEqual(fillNumbered('Hola {{1}}, tu curso {{2}}. {{1}}', ['Ana', 'Aves']), {
    text: 'Hola Ana, tu curso Aves. Ana',
    missing: [],
  });
  assert.deepEqual(fillNumbered('Hola {{1}}, {{2}} y {{3}} ({{nombre}})', ['Ana', '  ']), {
    text: 'Hola Ana, {{2}} y {{3}} ({{nombre}})',
    missing: [2, 3],
  });
  assert.deepEqual(fillNumbered('{{1}}', null), { text: '{{1}}', missing: [1] });
  assert.equal(fillNumbered('{{1}} {{2}}', ['$&', 7]).text, '$& 7');
});

test('propiedad: nombres → números → nombres devuelve el mismo texto', () => {
  const next = random(3);
  const keys = ['nombre', 'curso', 'fecha', 'precio', 'contacto.ciudad', 'var.x', 'marca'];
  for (let round = 0; round < 300; round++) {
    let text = '';
    let named = '';
    for (let i = 0; i < 1 + Math.floor(next() * 12); i++) {
      if (next() < 0.5) {
        const key = pick(next, keys);
        text += pick(next, [`{{${key}}}`, `{{ ${key} }}`, `{{${key.toUpperCase()}}}`, `{{${key}|respaldo}}`]);
        named += `{{${key}}}`;
      } else {
        const piece = pick(next, ['Hola ', ', ', '. ', 'tu curso ', '\n', '{ ', ' }', '¡', '!']);
        text += piece;
        named += piece;
      }
    }
    const numbered = toNumbered(text);
    assert.deepEqual(numbered.keys, extractKeys(text));
    assert.ok(extract(numbered.text).every(token => token.kind === 'numbered'));
    assert.deepEqual(toNamed(numbered.text, numbered.keys), { text: named, unknown: [] });
    // Numerar un texto ya canónico y volver da ese mismo texto; y los números van de 1 a n sin huecos.
    assert.equal(toNamed(toNumbered(named).text, toNumbered(named).keys).text, named);
    const numbers = [...new Set(extract(numbered.text).map(token => token.number))].sort((a, b) => a - b);
    assert.deepEqual(
      numbers,
      numbered.keys.map((_, index) => index + 1),
    );
    // Llenar la forma numerada con los parámetros equivale a sustituir por nombre.
    const values = Object.fromEntries(keys.map(key => [key, 'V' + key.length + key[0]]));
    const { params, missing } = templateParams(numbered.keys, values);
    assert.deepEqual(missing, []);
    assert.equal(fillNumbered(numbered.text, params).text, render(named, values, { forTemplate: true }).text);
  }
});

test('templateParams: los valores en el orden de la plantilla, limpios, y lo que falta a la vista', () => {
  const keys = ['nombre', 'curso', 'fecha', 'contacto.ciudad'];
  const values = { nombre: ' Ana\nMaría ', curso: 'Plan  sanitario\tpara aves', contacto: { ciudad: 'Puebla' } };
  assert.deepEqual(templateParams(keys, values), {
    params: ['Ana María', 'Plan sanitario para aves', null, 'Puebla'],
    missing: ['fecha'],
    defaulted: [],
  });
  // Respaldo de quien llama, del catálogo y, al final, lo que diga `onMissing`.
  assert.deepEqual(
    templateParams(['nombre', 'curso', 'fecha'], {}, { fallbacks: { curso: 'tu\ncurso' }, catalogue: CATALOGUE }),
    {
      params: ['Hola', 'tu curso', null],
      missing: ['fecha'],
      defaulted: ['nombre', 'curso'],
    },
  );
  assert.deepEqual(templateParams(['a', 'b'], { a: 'A' }, { onMissing: key => `sin\n${key}` }), {
    params: ['A', 'sin b'],
    missing: ['b'],
    defaulted: [],
  });
  assert.deepEqual(templateParams(['a'], {}, { onMissing: () => '  ' }).params, [null]);
  assert.deepEqual(templateParams([], {}), { params: [], missing: [], defaulted: [] });
  // Un dato repetido en la lista ocupa cada una de sus posiciones.
  assert.deepEqual(templateParams(['a', 'b', 'a'], { a: 1, b: 2 }).params, ['1', '2', '1']);
  assert.deepEqual(templateParams(['x'], key => (key === 'x' ? 'por función' : null)).params, ['por función']);
  assert.equal(templateParams(['x'], { x: 'y'.repeat(300) }).params[0].length, 200);
  assert.equal(templateParams(['x'], { x: 'y'.repeat(300) }, { maxLength: 60 }).params[0].length, 60);
  // Lo que Meta rechazaría nunca llega a un parámetro.
  const next = random(8);
  const pieces = ['a', ' ', '     ', '\n', '\r\n', '\t', NBSP, LINE_SEPARATOR, 'ñ', FACE];
  for (let round = 0; round < 300; round++) {
    let raw = 'x';
    for (let i = 0; i < Math.floor(next() * 30); i++) raw += pick(next, pieces);
    const [param] = templateParams(['v'], { v: raw }).params;
    assert.doesNotMatch(param, /[\r\n\t]| {5}/, JSON.stringify(raw));
    assert.ok(param.length <= 200);
  }
});

// ---- Compatibilidad con los sistemas actuales

test('compatibilidad: con todos los datos, igual que las respuestas rápidas', { skip: !legacyQuick.fill }, () => {
  const values = {
    nombre: 'Ana',
    nombre_completo: 'Ana Pérez',
    curso: 'Aves',
    edicion: 'Edición nov',
    marca: 'GlobalVet',
    asesor: 'Laura',
  };
  const catalogue = createCatalogue(legacyQuick.VARIABLES);
  assert.deepEqual(catalogue.keys(), Object.keys(legacyQuick.VARIABLES));
  for (const body of [
    'Hola {{nombre}}, te atiende {{asesor}} de {{marca}}.',
    '{{nombre_completo}}: tu curso es {{curso}} ({{edicion}}).\n\nSaludos, {{ asesor }}',
    'Sin variables.',
    '{{nombre}}{{nombre}} {{curso}}',
  ]) {
    assert.doesNotThrow(() => legacyQuick.validateBody(body));
    assert.deepEqual(validate(body, catalogue), [], body);
    assert.equal(render(body, values).text, legacyQuick.fill(body, values), body);
  }
  // Lo que aquel validador rechaza, éste también.
  for (const body of ['Hola {{nombres}}', 'Hola {{nombre', 'Hola nombre}}', 'Hola {{precio}}']) {
    assert.throws(() => legacyQuick.validateBody(body));
    assert.notDeepEqual(validate(body, catalogue), [], body);
  }
});

test(
  'compatibilidad: con todos los datos, igual que las plantillas del catálogo',
  { skip: !legacyCatalogue.fillTemplate },
  () => {
    const catalogue = createCatalogue(legacyCatalogue.variables);
    assert.equal(catalogue.keys().length, legacyCatalogue.variables.length);
    const values = Object.fromEntries(legacyCatalogue.variables.map((key, index) => [key, `valor ${index} de ${key}`]));
    for (const body of [
      'Hola {{nombre}}: {{curso}} ({{edicion}}) inicia el {{fecha}} con {{docente}}. Precio: {{precio}}.',
      '{{temario}}\n\nMás información: {{ enlace }}\nCupo: {{cupo}}',
      legacyCatalogue.variables.map(key => `{{${key}}}`).join(' · '),
      'Sin variables.',
    ]) {
      assert.doesNotThrow(() => legacyCatalogue.validateTemplateBody(body));
      assert.deepEqual(validate(body, catalogue), [], body);
      assert.equal(render(body, values).text, legacyCatalogue.fillTemplate(body, values), body);
    }
    for (const body of ['Hola {{nombres}}', 'Hola {{nombre', 'Hola nombre}}']) {
      assert.throws(() => legacyCatalogue.validateTemplateBody(body));
      assert.notDeepEqual(validate(body, catalogue), [], body);
    }
  },
);

test(
  'compatibilidad: igual que el flujo de bienvenida, también cuando falta el nombre',
  { skip: !legacyFlows.render },
  () => {
    const scopes = [
      { name: 'Ana', course: 'Aves', edition: 'Edición nov', brand: 'GlobalVet' },
      { name: '', course: 'Aves', edition: 'Edición nov', brand: 'GlobalVet' },
      { name: 'Ana', course: 'Aves', edition: '', brand: 'GlobalVet' },
    ];
    const texts = [
      '¡Hola, {{nombre}}! Soy el asistente de {{marca}}.',
      'Hola {{nombre}}, ¿te interesa {{curso}} ({{edición}})?',
      '{{nombre}}, bienvenido a {{ Marca }}',
      'Bienvenida a {{curso}}, {{nombre}}.',
      'Gracias por escribir, {{NOMBRE}}',
      'Sin datos por aquí.',
    ];
    for (const scope of scopes)
      for (const text of texts) {
        // El flujo usa el curso cuando la conversación no tiene edición: eso lo decide quien arma los valores.
        const values = {
          nombre: scope.name,
          curso: scope.course,
          edicion: scope.edition || scope.course,
          marca: scope.brand,
        };
        const want = legacyFlows.render(text, scope);
        // Las dos únicas diferencias, a propósito: el flujo deja «, bienvenido» si el nombre vacío abría la frase y
        // «Hola , ¿…» si la coma iba después; aquí esa coma no queda suelta.
        const tidy = want.replace(/^, /, '').replace(/ ,/g, ',');
        assert.equal(render(text, values, { onMissing: 'remove' }).text, tidy, `${text} · ${JSON.stringify(scope)}`);
        if (scope.name) assert.equal(render(text, values).text, want, text);
      }
  },
);
