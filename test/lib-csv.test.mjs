import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CSV_BOM,
  stripBom,
  detectDelimiter,
  iterateCsv,
  parseCsv,
  headerKey,
  mapHeader,
  unprotectCell,
  rowToObject,
  readTable,
  decodeCsv,
  csvCell,
  csvLine,
  toCsv,
} from '../server/lib/csv.mjs';

// Los lectores y escritores que esta biblioteca sustituye. Si algún día se retiran, las pruebas de compatibilidad se
// saltan solas; las demás no dependen de ellos.
const legacyReader = await import('../server/catalogue-import.mjs').catch(() => ({}));
const legacyWriter = await import('../server/contacts.mjs').catch(() => ({}));

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
const pick = (next, list) => list[Math.floor(next() * list.length)];
const cellsOf = rows => rows.map(row => row.cells);
const thrown = fn => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

// Trozos con todo lo que complica un CSV: comillas, separadores, saltos de línea de los dos tipos y fórmulas.
const PIECES = [
  'a',
  'b',
  'ñ',
  'á',
  ' ',
  ' ',
  '"',
  '"',
  ',',
  ',',
  ';',
  ';',
  '\n',
  '\n',
  '\r',
  '\r\n',
  '\t',
  '=',
  '+',
  '-',
  '@',
  "'",
  'x',
  '1',
  '0',
];
function noise(next, length) {
  let text = '';
  for (let i = 0; i < length; i++) text += pick(next, PIECES);
  return text;
}

// ---- Lectura

test('la marca de orden de bytes se construye y se quita sólo al inicio', () => {
  assert.equal(CSV_BOM.length, 1);
  assert.equal(CSV_BOM.charCodeAt(0), 0xfeff);
  assert.equal(stripBom(CSV_BOM + 'a,b'), 'a,b');
  assert.equal(stripBom('a,b'), 'a,b');
  assert.equal(stripBom('a' + CSV_BOM), 'a' + CSV_BOM);
  assert.equal(stripBom(null), '');
  assert.deepEqual(cellsOf(parseCsv(CSV_BOM + 'marca,curso\nA,B\n')), [
    ['marca', 'curso'],
    ['A', 'B'],
  ]);
});

test('lee comillas, comillas dobles, saltos de línea dentro de una celda, punto y coma y líneas reales', () => {
  const rows = parseCsv(CSV_BOM + 'marca;curso;temario\r\nOdonTeck;"Curso ""A""";"uno\ndos"\r\n\r\nGlobalVet;B;x\r\n');
  assert.deepEqual(cellsOf(rows), [
    ['marca', 'curso', 'temario'],
    ['OdonTeck', 'Curso "A"', 'uno\ndos'],
    ['GlobalVet', 'B', 'x'],
  ]);
  assert.deepEqual(
    rows.map(row => row.line),
    [1, 2, 5],
  );
  assert.deepEqual(Object.keys(rows[0]), ['line', 'cells']);
  assert.deepEqual(parseCsv('a,b\n1,"2,5"\n')[1].cells, ['1', '2,5']);
});

test('fines de línea CRLF, LF y mezclados dan las mismas filas', () => {
  const want = [
    ['a', 'b'],
    ['1', '2'],
    ['3', '4'],
  ];
  for (const text of ['a,b\n1,2\n3,4\n', 'a,b\r\n1,2\r\n3,4\r\n', 'a,b\r\n1,2\n3,4', 'a,b\n1,2\r\n3,4\r\n'])
    assert.deepEqual(cellsOf(parseCsv(text)), want, JSON.stringify(text));
  // Dentro de comillas el salto de línea es contenido y se conserva tal cual.
  assert.deepEqual(cellsOf(parseCsv('a,"x\r\ny"\r\n')), [['a', 'x\r\ny']]);
  // Un retorno de carro suelto fuera de comillas se descarta (como hacía el lector anterior).
  assert.deepEqual(cellsOf(parseCsv('a\rb,c\n')), [['ab', 'c']]);
});

test('casos límite del lector', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(null), []);
  assert.deepEqual(parseCsv(undefined), []);
  assert.deepEqual(parseCsv('\n\n  \n\t\n'), []);
  assert.deepEqual(parseCsv(CSV_BOM), []);
  // La última fila no necesita salto de línea.
  assert.deepEqual(cellsOf(parseCsv('a,b')), [['a', 'b']]);
  // Un separador al final abre una celda vacía.
  assert.deepEqual(cellsOf(parseCsv('a,b,\n')), [['a', 'b', '']]);
  assert.deepEqual(cellsOf(parseCsv(',a\n')), [['', 'a']]);
  // Celda vacía entre comillas.
  assert.deepEqual(cellsOf(parseCsv('a,"",b\n')), [['a', '', 'b']]);
  // Unas comillas a media celda son texto; lo que sigue a un campo entre comillas se pega.
  assert.deepEqual(cellsOf(parseCsv('di "hola",x\n')), [['di "hola"', 'x']]);
  assert.deepEqual(cellsOf(parseCsv('"a"b,c\n')), [['ab', 'c']]);
  assert.deepEqual(cellsOf(parseCsv(' "a",b\n')), [[' "a"', 'b']]);
  // Los espacios de una celda se conservan: recortar es decisión de quien importa.
  assert.deepEqual(cellsOf(parseCsv(' a , b \n')), [[' a ', ' b ']]);
  // Por omisión unas comillas sin cerrar se tragan el resto (como el lector anterior).
  assert.deepEqual(cellsOf(parseCsv('a,"b\nc,d\n')), [['a', 'b\nc,d\n']]);
  // Las filas sin contenido se saltan, pero cuentan como líneas.
  assert.deepEqual(parseCsv('a\n\n , \n\nb\n'), [
    { line: 1, cells: ['a'] },
    { line: 5, cells: ['b'] },
  ]);
  assert.deepEqual(cellsOf(parseCsv('a\n\n , \nb\n', { skipBlank: false })), [['a'], [''], [' ', ' '], ['b']]);
  // Una fila que ocupa varias líneas mueve el número de línea de las siguientes.
  assert.deepEqual(
    parseCsv('a,"1\n2\n3"\nb,c\n').map(row => row.line),
    [1, 4],
  );
  // Lo que no es texto se convierte.
  assert.deepEqual(cellsOf(parseCsv(12345)), [['12345']]);
});

test('detección del separador: coma por omisión, punto y coma si aparece más, tabulador si se pide', () => {
  assert.equal(detectDelimiter('a,b,c\n1;2;3'), ',');
  assert.equal(detectDelimiter('a;b;c\n1,2,3'), ';');
  assert.equal(detectDelimiter('a;b,c\n'), ',', 'en un empate gana la coma');
  assert.equal(detectDelimiter('a;b;c,d\n'), ';');
  assert.equal(detectDelimiter('sin separadores'), ',');
  assert.equal(detectDelimiter(''), ',');
  assert.equal(detectDelimiter(CSV_BOM + 'a;b\r\n1;2'), ';');
  // Sólo cuenta la primera línea.
  assert.equal(detectDelimiter('a,b\n1;2;3;4;5'), ',');
  // El tabulador no se considera si no se pide.
  assert.equal(detectDelimiter('a\tb\tc\n'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n', { candidates: [',', ';', '\t'] }), '\t');
  assert.equal(detectDelimiter('a,b\tc\n', { candidates: [',', ';', '\t'] }), ',');
  assert.deepEqual(cellsOf(parseCsv('a\tb\n1\t2\n', { candidates: [',', ';', '\t'] })), [
    ['a', 'b'],
    ['1', '2'],
  ]);
  assert.deepEqual(cellsOf(parseCsv('a;b\n1;"2;3"\n')), [
    ['a', 'b'],
    ['1', '2;3'],
  ]);
  // Un separador explícito manda sobre la detección.
  assert.deepEqual(cellsOf(parseCsv('a;b,c\n', { delimiter: ';' })), [['a', 'b,c']]);
  assert.deepEqual(cellsOf(parseCsv('a|b|"c|d"\n', { delimiter: '|' })), [['a', 'b', 'c|d']]);
  for (const bad of ['', ',,', '"', '\n', '\r', 5]) assert.throws(() => parseCsv('a,b', { delimiter: bad }), TypeError);
  assert.throws(() => parseCsv('a,b', { candidates: ['"'] }), TypeError);
});

test('compatibilidad: parseCsv da lo mismo que el lector de catalogue-import', { skip: !legacyReader.parseCsv }, () => {
  const fixed = [
    CSV_BOM + 'marca;curso;temario\r\nOdonTeck;"Curso ""A""";"uno\ndos"\r\n\r\nGlobalVet;B;x\r\n',
    'a,b\n1,"2,5"\n',
    legacyReader.TEMPLATE_CSV,
    '',
    '"',
    '""',
    '"""',
    'a,"b',
    'a"b"c',
    '"a""b""c"\n',
    ',\n,\n',
    ';;;\n1;2\n',
    'a\rb\r\nc',
    '\r\n\r\n',
    ' , \n',
    'Name,CountryCode,Phone,Allow Campaign,Allow SMS,attribute_1\nAna,52,5512345678,TRUE,FALSE,"Aves, nov 2026"\n',
  ];
  for (const text of fixed) assert.deepEqual(parseCsv(text), legacyReader.parseCsv(text), JSON.stringify(text));
  const next = random(41);
  for (let round = 0; round < 5000; round++) {
    const text = (next() < 0.1 ? CSV_BOM : '') + noise(next, Math.floor(next() * 40));
    assert.deepEqual(parseCsv(text), legacyReader.parseCsv(text), JSON.stringify(text));
  }
});

test('iterateCsv entrega las filas de una en una y no lee más de lo que se le pide', () => {
  // La tercera fila tiene unas comillas sin cerrar: con lectura estricta sólo falla si se llega a ella.
  const rows = iterateCsv('a,b\n1,2\n3,"4\n', { strictQuotes: true });
  assert.deepEqual(rows.next().value, { line: 1, cells: ['a', 'b'], end: 4, nextLine: 2 });
  assert.deepEqual(rows.next().value, { line: 2, cells: ['1', '2'], end: 8, nextLine: 3 });
  assert.throws(() => rows.next(), { code: 'unclosed_quote' });
  // Se puede cortar con un tope propio sin recorrer el archivo.
  let seen = 0;
  for (const row of iterateCsv('h\n' + 'x\n'.repeat(1000))) {
    seen++;
    if (row.line === 10) break;
  }
  assert.equal(seen, 10);
  assert.deepEqual([...iterateCsv('')], []);
});

test('iterateCsv se reanuda donde se quedó, con cualquier fin de línea y con celdas de varias líneas', () => {
  const text = CSV_BOM + 'nombre;nota\r\nAna;"uno\r\ndos"\r\n\r\nLuis;x\nEva;"a;b"\r\nFin;z';
  const all = [...iterateCsv(text)];
  assert.deepEqual(
    all.map(row => row.line),
    [1, 2, 5, 6, 7],
  );
  assert.equal(all.at(-1).end, text.length);
  for (let cut = 0; cut < all.length; cut++) {
    const { end, nextLine } = all[cut];
    const rest = [...iterateCsv(text, { delimiter: ';', offset: end, line: nextLine })];
    assert.deepEqual(rest, all.slice(cut + 1), `corte tras la fila ${cut + 1}`);
  }
  // `offset: 0` es empezar de cero: la marca inicial no se cuela en la primera celda.
  assert.deepEqual([...iterateCsv(text, { delimiter: ';', offset: 0, line: 1 })], all);
});

test('propiedad: leer por trozos de cualquier tamaño da lo mismo que leer de corrido', () => {
  const next = random(9);
  for (let round = 0; round < 300; round++) {
    const text = noise(next, 5 + Math.floor(next() * 80));
    const delimiter = detectDelimiter(text);
    const whole = [...iterateCsv(text, { delimiter })];
    const chunk = 1 + Math.floor(next() * 3);
    const pieces = [];
    let position = { offset: 0, line: 1 };
    for (;;) {
      const batch = [];
      for (const row of iterateCsv(text, { delimiter, ...position })) {
        batch.push(row);
        if (batch.length === chunk) break;
      }
      if (!batch.length) break;
      pieces.push(...batch);
      position = { offset: batch.at(-1).end, line: batch.at(-1).nextLine };
      if (position.offset >= text.length) break;
    }
    assert.deepEqual(pieces, whole, JSON.stringify(text));
  }
});

// ---- Límites

test('límite de tamaño: se mide en bytes y responde 413 con un mensaje claro', () => {
  const error = thrown(() => parseCsv('a,b\n1,2\n', { maxBytes: 4 }));
  assert.equal(error.name, 'CsvError');
  assert.equal(error.code, 'too_large');
  assert.equal(error.status, 413);
  assert.equal(error.limit, 4);
  assert.equal(error.message, 'El archivo supera 4 bytes.');
  assert.deepEqual(cellsOf(parseCsv('a,b\n', { maxBytes: 4 })), [['a', 'b']]);
  // «ñ» ocupa dos bytes: cuatro caracteres pueden ser cinco bytes.
  assert.equal(thrown(() => parseCsv('ñ,b\n', { maxBytes: 4 }))?.code, 'too_large');
  // Los mismos textos que ya usan los importadores.
  assert.equal(
    thrown(() => parseCsv('x'.repeat(1_000_001), { maxBytes: 1_000_000 }))?.message,
    'El archivo supera 1 MB.',
  );
  assert.equal(
    thrown(() => parseCsv('x'.repeat(9), { maxBytes: 8 * 1024 * 1024 })),
    null,
  );
  const sizes = [
    [8 * 1024 * 1024, 'El archivo supera 8 MB.'],
    [2_000_000, 'El archivo supera 2 MB.'],
    [1_572_864, 'El archivo supera 1.5 MB.'],
    [2048, 'El archivo supera 2 KB.'],
    [1536, 'El archivo supera 1.5 KB.'],
    [100, 'El archivo supera 100 bytes.'],
  ];
  for (const [limit, message] of sizes)
    assert.equal(thrown(() => parseCsv('x'.repeat(limit + 1), { maxBytes: limit }))?.message, message);
});

test('límite de filas y de columnas', () => {
  const text = 'h1,h2\n1,2\n\n3,4\n5,6\n';
  assert.equal(parseCsv(text, { maxRows: 4 }).length, 4, 'las filas vacías no cuentan');
  const rows = thrown(() => parseCsv(text, { maxRows: 3 }));
  assert.deepEqual([rows.name, rows.code, rows.status, rows.limit], ['CsvError', 'too_many_rows', 400, 3]);
  assert.equal(rows.message, 'El archivo tiene más de 3 filas.');
  assert.equal(
    thrown(() => parseCsv('a\n'.repeat(50_001), { maxRows: 50_000 }))?.message,
    'El archivo tiene más de 50,000 filas.',
  );

  assert.equal(parseCsv('a,b,c\n1,2,3\n', { maxColumns: 3 }).length, 2);
  const columns = thrown(() => parseCsv('a,b\n\n1,2,3\n', { maxColumns: 2 }));
  assert.deepEqual(
    [columns.name, columns.code, columns.status, columns.limit, columns.line],
    ['CsvError', 'too_many_columns', 400, 2, 3],
  );
  assert.equal(columns.message, 'La fila 3 tiene más de 2 columnas.');
  // Una fila de puros separadores (lo que deja una hoja al final) no es un error: no tiene contenido.
  assert.equal(parseCsv('a,b\n,,,,,,,,\n', { maxColumns: 2 }).length, 1);
});

test('comillas sin cerrar: con lectura estricta es un error que dice dónde se abrieron', () => {
  const error = thrown(() => parseCsv('a,b\n1,2\nx,"abre\ny sigue\n', { strictQuotes: true }));
  assert.deepEqual([error.name, error.code, error.status, error.line], ['CsvError', 'unclosed_quote', 400, 3]);
  assert.equal(error.message, 'Unas comillas que se abren en la línea 3 nunca se cierran.');
  assert.equal(
    thrown(() => parseCsv('a,"b"\n"c ""d"""\n', { strictQuotes: true })),
    null,
  );
});

// ---- Encabezados

test('headerKey: los encabezados se comparan sin mayúsculas, acentos, espacios ni signos', () => {
  for (const header of ['Allow Campaign', 'allowcampaign', 'AllowCampaign', 'allow_campaign', ' ALLOW-CAMPAIGN '])
    assert.equal(headerKey(header), 'allowcampaign', header);
  assert.equal(headerKey('Teléfono (WhatsApp)'), 'telefonowhatsapp');
  assert.equal(headerKey('Código de país'), 'codigodepais');
  assert.equal(headerKey('cupo_disponible'), headerKey('Cupo disponible'));
  assert.equal(headerKey('attribute_1'), 'attribute1');
  assert.equal(headerKey(''), '');
  assert.equal(headerKey(null), '');
  assert.notEqual(headerKey('Имя'), '', 'un encabezado en otro alfabeto conserva sus letras');
});

// La forma del archivo que exporta el proveedor actual: Name, CountryCode (sin «+»), Phone, Allow Campaign,
// Allow SMS y, de la columna F en adelante, un atributo por encabezado.
const PROVIDER_FIELDS = {
  name: { aliases: ['name', 'nombre'], required: true },
  countryCode: ['countrycode', 'country code', 'código de país'],
  phone: { aliases: ['phone', 'phone number', 'teléfono', 'whatsapp'], required: true },
  consent: ['allow campaign', 'allowcampaign'],
  allowSms: ['allow sms', 'allowsms'],
  email: 'correo',
};
const PROVIDER_CSV =
  'Name,CountryCode,Phone,Allow Campaign,Allow SMS,attribute_1,status\r\n' +
  'Ana Pérez,52,5512345678,TRUE,FALSE,"Aves, nov 2026",PAGADO\r\n' +
  '  Luis  ,1,4155552671,FALSE,TRUE,,\r\n' +
  '"Eva ""la jefa""",52,=5512345679,TRUE,TRUE,"Línea 1\nLínea 2",PENDIENTE\r\n';

test('mapHeader reconoce el archivo del proveedor actual y deja ver lo que sobra y lo que falta', () => {
  const header = parseCsv(PROVIDER_CSV)[0].cells;
  const map = mapHeader(header, PROVIDER_FIELDS);
  assert.deepEqual(map.columns, { name: 0, countryCode: 1, phone: 2, consent: 3, allowSms: 4 });
  assert.deepEqual(map.unknown, [
    { index: 5, header: 'attribute_1' },
    { index: 6, header: 'status' },
  ]);
  assert.deepEqual(map.missing, []);
  assert.deepEqual(map.blank, []);
  assert.deepEqual(map.duplicates, []);

  // El mismo archivo con encabezados en español, sin teléfono, con una columna repetida y otra sin nombre.
  const other = mapHeader(['Nombre', ' CÓDIGO DE PAÍS ', '', 'Correo', 'nombre', 'Ciudad', 'NAME'], PROVIDER_FIELDS);
  assert.deepEqual(other.columns, { name: 0, countryCode: 1, email: 3 });
  assert.deepEqual(other.missing, ['phone']);
  assert.deepEqual(other.blank, [2]);
  assert.deepEqual(other.duplicates, [{ field: 'name', indexes: [0, 4, 6] }]);
  assert.deepEqual(other.unknown, [{ index: 5, header: 'Ciudad' }]);

  // Una lista de nombres basta cuando el archivo usa los nombres de los campos (catálogo, conocimiento).
  const plain = mapHeader(
    ['Marca', 'curso', 'Cupo disponible', 'otra'],
    ['marca', 'curso', 'precio', 'cupo_disponible'],
  );
  assert.deepEqual(plain.columns, { marca: 0, curso: 1, cupo_disponible: 2 });
  assert.deepEqual(plain.missing, []);
  assert.deepEqual(plain.unknown, [{ index: 3, header: 'otra' }]);
  assert.deepEqual(mapHeader([], ['a']).columns, {});
  assert.deepEqual(mapHeader(['constructor', 'toString'], ['a']).unknown.length, 2);

  // El mismo encabezado no puede ser de dos campos.
  assert.throws(() => mapHeader(['x'], { a: ['Teléfono'], b: ['telefono'] }), TypeError);
});

test('rowToObject: celdas recortadas, columnas que faltan y protección contra fórmulas deshecha', () => {
  const columns = { name: 0, phone: 2, extra: 9 };
  assert.deepEqual(rowToObject(['  Ana ', 'x', " '+52 55 1234 5678 "], columns), {
    name: 'Ana',
    phone: '+52 55 1234 5678',
    extra: '',
  });
  assert.deepEqual(rowToObject(['Ana', 'x', "'+52"], columns, { unprotect: false }).phone, "'+52");
  assert.deepEqual(rowToObject([], columns), { name: '', phone: '', extra: '' });
  assert.deepEqual(rowToObject(['a'], {}), {});
});

test('readTable: encabezados, filas como objetos y la separación de lo que el archivo trae de más', () => {
  const table = readTable(PROVIDER_CSV, { fields: PROVIDER_FIELDS });
  assert.equal(table.delimiter, ',');
  assert.equal(table.headerLine, 1);
  assert.deepEqual(table.header, [
    'Name',
    'CountryCode',
    'Phone',
    'Allow Campaign',
    'Allow SMS',
    'attribute_1',
    'status',
  ]);
  assert.deepEqual(table.columns, { name: 0, countryCode: 1, phone: 2, consent: 3, allowSms: 4 });
  assert.deepEqual(
    table.unknown.map(column => column.header),
    ['attribute_1', 'status'],
  );
  assert.deepEqual(table.missing, []);
  assert.deepEqual(
    table.rows.map(row => [row.line, row.values]),
    [
      [2, { name: 'Ana Pérez', countryCode: '52', phone: '5512345678', consent: 'TRUE', allowSms: 'FALSE' }],
      [3, { name: 'Luis', countryCode: '1', phone: '4155552671', consent: 'FALSE', allowSms: 'TRUE' }],
      [4, { name: 'Eva "la jefa"', countryCode: '52', phone: '=5512345679', consent: 'TRUE', allowSms: 'TRUE' }],
    ],
  );
  // Las columnas que nadie pidió siguen en `cells`: de ahí salen los atributos.
  assert.deepEqual(
    table.rows.map(row => table.unknown.map(column => row.cells[column.index])),
    [
      ['Aves, nov 2026', 'PAGADO'],
      ['', ''],
      ['Línea 1\nLínea 2', 'PENDIENTE'],
    ],
  );
  // Sin `fields` sólo separa encabezados y filas.
  const bare = readTable('a;b\n1;2\n');
  assert.deepEqual(bare, { delimiter: ';', header: ['a', 'b'], headerLine: 1, rows: [{ line: 2, cells: ['1', '2'] }] });
  // Los encabezados son la primera fila con contenido.
  assert.equal(readTable('\n\na,b\n1,2\n').headerLine, 3);
});

test('readTable: el tope de filas cuenta sólo los datos y un archivo sin filas es un error', () => {
  const text = 'h\n' + 'x\n'.repeat(500);
  assert.equal(readTable(text, { maxRows: 500 }).rows.length, 500);
  const error = thrown(() => readTable(text + 'x\n', { maxRows: 500 }));
  assert.deepEqual([error.name, error.code, error.status, error.limit], ['CsvError', 'too_many_rows', 400, 500]);
  assert.equal(error.message, 'Máximo 500 filas por archivo.');
  for (const empty of ['', '\n\n', 'sólo,encabezados\n', null]) {
    const none = thrown(() => readTable(empty));
    assert.deepEqual([none?.code, none?.status], ['no_rows', 400], JSON.stringify(empty));
    assert.equal(none.message, 'El archivo necesita encabezados y al menos una fila.');
  }
  assert.equal(thrown(() => readTable('a,b\n1,2\n', { maxBytes: 3 }))?.code, 'too_large');
  assert.equal(thrown(() => readTable('a,b\n1,2,3\n', { maxColumns: 2 }))?.code, 'too_many_columns');
  assert.equal(thrown(() => readTable('a,b\n1,"2\n', { strictQuotes: true }))?.code, 'unclosed_quote');
});

test('decodeCsv: UTF-8 con y sin marca, UTF-16 con marca y Windows-1252 como último recurso', () => {
  const text = 'Año,Niño\nMaría,José\n';
  assert.deepEqual(decodeCsv(Buffer.from(text, 'utf8')), { text, encoding: 'utf-8' });
  assert.deepEqual(decodeCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])), {
    text,
    encoding: 'utf-8',
  });
  assert.deepEqual(decodeCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), {
    text,
    encoding: 'utf-16le',
  });
  const bigEndian = Buffer.from(text, 'utf16le').swap16();
  assert.deepEqual(decodeCsv(Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])), { text, encoding: 'utf-16be' });
  // Lo que guarda una hoja de cálculo antigua: «ñ» es el byte F1, que no es UTF-8 válido.
  assert.deepEqual(decodeCsv(Buffer.from('Año,Niño\nMaría,José\n', 'latin1')), { text, encoding: 'windows-1252' });
  assert.deepEqual(decodeCsv(Buffer.from([0x93, 0x61, 0x94, 0x80])), { text: '“a”€', encoding: 'windows-1252' });
  // Acepta cualquier vista de bytes.
  assert.deepEqual(decodeCsv(new Uint8Array(Buffer.from('a,b', 'utf8'))), { text: 'a,b', encoding: 'utf-8' });
  assert.deepEqual(decodeCsv(new Uint8Array(Buffer.from('a,b', 'utf8')).buffer), { text: 'a,b', encoding: 'utf-8' });
  assert.deepEqual(decodeCsv(Buffer.alloc(0)), { text: '', encoding: 'utf-8' });
  assert.throws(() => decodeCsv('a,b'), TypeError);
  // Y lo decodificado se lee sin más.
  assert.deepEqual(cellsOf(parseCsv(decodeCsv(Buffer.from('a;ñ\r\n1;2', 'latin1')).text)), [
    ['a', 'ñ'],
    ['1', '2'],
  ]);
});

// ---- Escritura

test('csvCell: comillas, separadores y saltos de línea', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('di "hola"'), '"di ""hola"""');
  assert.equal(csvCell('uno\ndos'), '"uno\ndos"');
  assert.equal(csvCell('uno\r\ndos'), '"uno\r\ndos"');
  // El punto y coma y el tabulador también fuerzan comillas: una hoja con otro separador no debe partir la celda.
  assert.equal(csvCell('a;=b'), '"a;=b"');
  assert.equal(csvCell('a\tb'), '"a\tb"');
  assert.equal(csvCell('texto simple'), 'texto simple');
  assert.equal(csvCell('ñandú'), 'ñandú');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(12.5), '12.5');
  assert.equal(csvCell(false), 'false');
  assert.equal(csvCell('a|b'), 'a|b');
  assert.equal(csvCell('a|b', { delimiter: '|' }), '"a|b"');
});

test('csvCell: lo que una hoja de cálculo ejecutaría como fórmula queda como texto', () => {
  for (const formula of [
    '=1+1',
    '+52 55',
    '-2',
    '@SUMA(A1)',
    '=HYPERLINK("http://x","y")',
    '\t=1+1',
    '\r=1+1',
    '=',
    '+',
    '-',
    '@',
  ])
    assert.ok(csvCell(formula).replace(/^"/, '').startsWith("'"), JSON.stringify(formula));
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+52 55 1234 5678'), "'+52 55 1234 5678");
  assert.equal(csvCell('@usuario'), "'@usuario");
  assert.equal(csvCell('=cmd|"/c calc"!A1'), '"\'=cmd|""/c calc""!A1"');
  assert.equal(csvCell('=a,b'), '"\'=a,b"');
  assert.equal(csvCell('\tx'), '"\'\tx"');
  assert.equal(csvCell('\rx'), '"\'\rx"');
  // Un número negativo también empieza con «-»: se conserva la regla del escritor anterior.
  assert.equal(csvCell(-2), "'-2");
  // Sólo importa el primer carácter.
  for (const safe of ['a=1', '1+1', 'x-y', 'correo@dominio.mx', ' =1', "'=1", '52', 'Ñ'])
    assert.equal(csvCell(safe), safe, safe);
  // `unprotectCell` deshace exactamente eso al volver a importar.
  for (const value of ['=1+1', '+52 55 1234 5678', '-2', '@x', '\t1', '\r1'])
    assert.equal(unprotectCell("'" + value), value);
  for (const value of ["'hola", "''", "it's", '', 'a', "'"]) assert.equal(unprotectCell(value), value);
  assert.equal(unprotectCell(null), '');
});

test('csvLine y toCsv: separador, fin de línea CRLF para hojas de cálculo y marca opcional', () => {
  assert.equal(csvLine(['x', 1, '=y']), "x,1,'=y");
  assert.equal(csvLine(['a', null, 'b;c', undefined, 'd,e']), 'a,,"b;c",,"d,e"');
  assert.equal(csvLine(['a', 'b,c', 'd;e'], { delimiter: ';' }), 'a;"b,c";"d;e"');
  assert.equal(csvLine([]), '');
  // Se puede pasar a `map` tal cual, como hacen los módulos de hoy.
  assert.deepEqual(['a', '=b', 'c,d'].map(csvCell), ['a', "'=b", '"c,d"']);

  const rows = [
    ['Ana', '+52 55', 'dijo "hola"'],
    ['Luis', null, 'dos\nlíneas'],
  ];
  assert.equal(toCsv(rows), 'Ana,\'+52 55,"dijo ""hola"""\r\nLuis,,"dos\nlíneas"\r\n');
  assert.equal(toCsv(rows, { header: ['nombre', 'teléfono', 'nota'] }).split('\r\n')[0], 'nombre,teléfono,nota');
  assert.equal(toCsv([['a', 'b']], { eol: '\n' }), 'a,b\n');
  assert.equal(toCsv([['a', 'b']], { delimiter: ';' }), 'a;b\r\n');
  assert.equal(toCsv([['a']], { bom: true }), CSV_BOM + 'a\r\n');
  assert.equal(toCsv([['a']]).startsWith(CSV_BOM), false);
  assert.equal(toCsv([]), '');
  assert.equal(toCsv([], { header: ['a', 'b'], bom: true }), CSV_BOM + 'a,b\r\n');
  // Acepta cualquier iterable: una exportación grande puede generar sus filas una a una.
  const generated = (function* rowsOf() {
    yield [1, 2];
    yield [3, 4];
  })();
  assert.equal(toCsv(generated), '1,2\r\n3,4\r\n');
  assert.throws(() => toCsv([['a']], { eol: '\r' }), TypeError);
  assert.throws(() => toCsv([['a']], { delimiter: '"' }), TypeError);
  assert.throws(() => toCsv([['a']], { delimiter: ';;' }), TypeError);
});

test('compatibilidad: csvCell y csvLine dan lo mismo que los de contacts.mjs', { skip: !legacyWriter.csvCell }, () => {
  const fixed = [
    'a,b',
    'di "hola"',
    'uno\ndos',
    'a;=b',
    'a\tb',
    '=1+1',
    '+52 55',
    '-2',
    '@SUMA(A1)',
    null,
    undefined,
    0,
    -2,
    1.5,
    true,
    '',
    "'",
    '\r',
    '\t',
  ];
  for (const value of fixed) assert.equal(csvCell(value), legacyWriter.csvCell(value), JSON.stringify(value));
  assert.equal(csvLine(fixed), legacyWriter.csvLine(fixed));
  assert.deepEqual(fixed.map(csvCell), fixed.map(legacyWriter.csvCell));
  const next = random(77);
  for (let round = 0; round < 5000; round++) {
    const value = noise(next, Math.floor(next() * 12));
    assert.equal(csvCell(value), legacyWriter.csvCell(value), JSON.stringify(value));
  }
});

test('propiedad: lo que se escribe se vuelve a leer igual, con cualquier separador y fin de línea', () => {
  const next = random(2026);
  const protect = value => (/^[=+\-@\t\r]/.test(value) ? "'" + value : value);
  for (let round = 0; round < 400; round++) {
    const width = 1 + Math.floor(next() * 5);
    const rows = Array.from({ length: 1 + Math.floor(next() * 6) }, () =>
      Array.from({ length: width }, () => noise(next, Math.floor(next() * 8))),
    );
    const delimiter = pick(next, [',', ';', '\t', '|']);
    const options = { delimiter, eol: pick(next, ['\r\n', '\n']), bom: next() < 0.5 };
    const text = toCsv(rows, options);
    const read = parseCsv(text, { delimiter, skipBlank: false, strictQuotes: true });
    assert.deepEqual(
      cellsOf(read),
      rows.map(row => row.map(protect)),
      JSON.stringify({ rows, options }),
    );
    // Y sin la protección contra fórmulas vuelve el valor original (salvo que ya empezara con apóstrofo y fórmula).
    for (const [r, row] of rows.entries())
      for (const [c, value] of row.entries())
        if (!/^'[=+\-@\t\r]/.test(value)) assert.equal(unprotectCell(read[r].cells[c]), value);
  }
});
