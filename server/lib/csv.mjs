// Lectura y escritura de CSV, una sola vez para todo el CRM: importar contactos, catálogo, conocimiento e históricos,
// y exportar contactos, bitácoras y reportes.
//
// Por qué existe: había un lector en `catalogue-import.mjs` (`parseCsv`) y un escritor en `contacts.mjs` (`csvCell`,
// `csvLine`), cada importador repetía sus límites y la importación de contactos necesita además leer por trozos y
// reanudar. Con las opciones por omisión, `parseCsv`, `csvCell` y `csvLine` devuelven lo mismo que aquéllos para las
// mismas entradas, de modo que los módulos actuales pueden delegar aquí sin cambiar de comportamiento.
//
// Funciones puras y síncronas: sin archivos, sin red y sin estado.

// La marca de orden de bytes se construye: escrita tal cual en el código es un carácter invisible.
export const CSV_BOM = String.fromCharCode(0xfeff);

function csvError(code, message, extra = {}) {
  return Object.assign(new Error(message), {
    name: 'CsvError',
    code,
    status: code === 'too_large' ? 413 : 400,
    ...extra,
  });
}

const count = n => Number(n).toLocaleString('es-MX');
const round1 = n => String(Math.round(n * 10) / 10);
function sizeLabel(bytes) {
  if (bytes % 1_000_000 === 0) return bytes / 1_000_000 + ' MB';
  if (bytes >= 1_048_576) return round1(bytes / 1_048_576) + ' MB';
  if (bytes >= 1024) return round1(bytes / 1024) + ' KB';
  return bytes + ' bytes';
}

const asText = value => (value === null || value === undefined ? '' : String(value));

export function stripBom(text) {
  const src = asText(text);
  return src.startsWith(CSV_BOM) ? src.slice(1) : src;
}

// ---- Lectura

// El separador es el candidato que más aparece en la primera línea; en un empate gana el que va antes en la lista
// (la coma). Una hoja en español suele exportar con punto y coma. Para aceptar también tabuladores:
// `candidates: [',', ';', '\t']`.
export function detectDelimiter(text, { candidates = [',', ';'] } = {}) {
  const first = stripBom(text).split(/\r?\n/, 1)[0];
  let best = candidates[0];
  let top = 0;
  for (const candidate of candidates) {
    const found = first.split(candidate).length - 1;
    if (found > top) {
      best = candidate;
      top = found;
    }
  }
  return best;
}

function assertDelimiter(delimiter) {
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || '"\r\n'.includes(delimiter))
    throw new TypeError('El separador del CSV debe ser un solo carácter que no sea comilla ni salto de línea.');
}

// Recorre el texto fila por fila sin armar la tabla entera: quien importa puede procesar por trozos y parar cuando
// quiera. Cada fila trae `line` (línea del archivo donde empieza), `cells`, y `end` y `nextLine` (dónde sigue la
// lectura): con `{delimiter, offset: fila.end, line: fila.nextLine}` se reanuda un trabajo interrumpido sin releer
// lo anterior.
//
// Reglas de lectura (las mismas del lector anterior): unas comillas abren un campo sólo al inicio de la celda; dentro,
// dos comillas son una y caben separadores y saltos de línea; fuera de comillas el retorno de carro se descarta, así
// que da igual CRLF que LF; las filas sin contenido se saltan, pero cuentan para el número de línea.
export function* iterateCsv(text, options = {}) {
  const src = asText(text);
  const { maxBytes, maxRows, maxColumns, strictQuotes = false, skipBlank = true } = options;
  if (maxBytes !== undefined && Buffer.byteLength(src, 'utf8') > maxBytes)
    throw csvError('too_large', `El archivo supera ${sizeLabel(maxBytes)}.`, { limit: maxBytes });
  const delimiter = options.delimiter ?? detectDelimiter(src, options);
  assertDelimiter(delimiter);
  const size = src.length;
  let i = options.offset || (src.startsWith(CSV_BOM) ? 1 : 0);
  let line = options.line || 1;
  let start = line;
  let row = [];
  let cell = '';
  let quoted = false;
  let quoteLine = 0;
  let yielded = 0;

  // Cierra la fila en curso. Devuelve `null` si no tenía contenido.
  const flush = end => {
    row.push(cell);
    cell = '';
    const cells = row;
    const firstLine = start;
    row = [];
    start = line + 1;
    if (skipBlank && !cells.some(value => value.trim() !== '')) return null;
    if (maxColumns !== undefined && cells.length > maxColumns)
      throw csvError('too_many_columns', `La fila ${count(firstLine)} tiene más de ${count(maxColumns)} columnas.`, {
        line: firstLine,
        limit: maxColumns,
      });
    if (maxRows !== undefined && yielded >= maxRows)
      throw csvError('too_many_rows', `El archivo tiene más de ${count(maxRows)} filas.`, { limit: maxRows });
    yielded++;
    return { line: firstLine, cells, end, nextLine: line + 1 };
  };

  while (i < size) {
    if (quoted) {
      const close = src.indexOf('"', i);
      const stop = close < 0 ? size : close;
      if (stop > i) {
        const chunk = src.slice(i, stop);
        cell += chunk;
        for (let at = chunk.indexOf('\n'); at >= 0; at = chunk.indexOf('\n', at + 1)) line++;
      }
      if (close < 0) {
        i = size;
        break;
      }
      if (src[close + 1] === '"') {
        cell += '"';
        i = close + 2;
      } else {
        quoted = false;
        i = close + 1;
      }
      continue;
    }
    const ch = src[i];
    if (ch === '"' && cell === '') {
      quoted = true;
      quoteLine = line;
      i++;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
      i++;
    } else if (ch === '\n') {
      i++;
      const done = flush(i);
      line++;
      if (done) yield done;
    } else if (ch === '\r') {
      i++;
    } else {
      let next = i + 1;
      while (next < size) {
        const c = src[next];
        if (c === '"' || c === delimiter || c === '\n' || c === '\r') break;
        next++;
      }
      cell += src.slice(i, next);
      i = next;
    }
  }
  if (quoted && strictQuotes)
    throw csvError('unclosed_quote', `Unas comillas que se abren en la línea ${count(quoteLine)} nunca se cierran.`, {
      line: quoteLine,
    });
  if (cell !== '' || row.length) {
    const done = flush(size);
    if (done) yield done;
  }
}

// La tabla completa como lista de `{line, cells}`. Opciones: `delimiter` (si falta, se detecta), `candidates`,
// `maxBytes`, `maxRows`, `maxColumns`, `strictQuotes` (unas comillas sin cerrar son un error en vez de tragarse el
// resto del archivo) y `skipBlank`.
export function parseCsv(text, options) {
  const rows = [];
  for (const { line, cells } of iterateCsv(text, options)) rows.push({ line, cells });
  return rows;
}

// ---- Encabezados

// Forma comparable de un encabezado: sin mayúsculas, acentos, espacios ni signos. «Allow Campaign», «allowcampaign»
// y «allow_campaign» son la misma columna. Tras descomponer cada letra, su acento es un signo más y se va con ellos.
export function headerKey(value) {
  return asText(value)
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const fieldSpec = spec =>
  Array.isArray(spec) ? { aliases: spec } : typeof spec === 'string' ? { aliases: [spec] } : (spec ?? {});

function wantedFields(fields) {
  const list = Array.isArray(fields)
    ? fields.map(name => [name, {}])
    : Object.entries(fields ?? {}).map(([name, spec]) => [name, fieldSpec(spec)]);
  const byKey = new Map();
  const wanted = list.map(([name, spec]) => {
    for (const alias of [name, ...(spec.aliases ?? [])]) {
      const key = headerKey(alias);
      if (byKey.has(key) && byKey.get(key) !== name)
        throw new TypeError(`El encabezado «${alias}» está declarado para dos campos: ${byKey.get(key)} y ${name}.`);
      byKey.set(key, name);
    }
    return { name, required: Boolean(spec.required) };
  });
  return { wanted, byKey };
}

// Liga los encabezados del archivo con los campos que espera quien importa. `fields` es una lista de nombres o un
// objeto `{campo: ['alias', …]}` o `{campo: {aliases: […], required: true}}`. Devuelve `columns` (campo → índice de
// columna), `unknown` (encabezados que nadie pidió: quien importa decide si son atributos nuevos o se ignoran),
// `blank` (columnas sin encabezado), `duplicates` (un campo que aparece en dos columnas: gana la primera) y `missing`
// (campos obligatorios que no vinieron).
export function mapHeader(cells, fields) {
  const { wanted, byKey } = wantedFields(fields);
  const columns = {};
  const unknown = [];
  const blank = [];
  const repeated = new Map();
  cells.forEach((cell, index) => {
    const header = asText(cell).trim();
    const name = byKey.get(headerKey(header));
    if (!header) blank.push(index);
    else if (name === undefined) unknown.push({ index, header });
    else if (!Object.hasOwn(columns, name)) columns[name] = index;
    else if (repeated.has(name)) repeated.get(name).push(index);
    else repeated.set(name, [columns[name], index]);
  });
  return {
    columns,
    unknown,
    blank,
    duplicates: [...repeated].map(([field, indexes]) => ({ field, indexes })),
    missing: wanted.filter(field => field.required && !Object.hasOwn(columns, field.name)).map(field => field.name),
  };
}

// Deshace la protección contra fórmulas de `csvCell`: un archivo exportado por el CRM, editado en una hoja y vuelto a
// importar no debe traer «'+52…» en el teléfono.
export function unprotectCell(value) {
  const text = asText(value);
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}

// Una fila como objeto `{campo: texto}` según `columns` de `mapHeader`. Las celdas se recortan; una columna que la
// fila no trae queda como cadena vacía.
export function rowToObject(cells, columns, { unprotect = true } = {}) {
  const values = {};
  for (const [name, index] of Object.entries(columns)) {
    const text = asText(cells[index]).trim();
    values[name] = unprotect ? unprotectCell(text) : text;
  }
  return values;
}

// Lee un archivo con encabezados. La primera fila con contenido son los encabezados; `maxRows` cuenta sólo las filas
// de datos. Con `fields`, añade el resultado de `mapHeader` y, en cada fila, `values`.
export function readTable(text, { fields, maxRows, ...options } = {}) {
  const src = asText(text);
  const delimiter = options.delimiter ?? detectDelimiter(src, options);
  let header = null;
  let mapping = null;
  const rows = [];
  for (const { line, cells } of iterateCsv(src, { ...options, delimiter })) {
    if (!header) {
      header = { line, cells };
      if (fields) mapping = mapHeader(cells, fields);
      continue;
    }
    if (maxRows !== undefined && rows.length >= maxRows)
      throw csvError('too_many_rows', `Máximo ${count(maxRows)} filas por archivo.`, { limit: maxRows });
    rows.push(mapping ? { line, cells, values: rowToObject(cells, mapping.columns) } : { line, cells });
  }
  if (!header || !rows.length) throw csvError('no_rows', 'El archivo necesita encabezados y al menos una fila.');
  return { delimiter, header: header.cells, headerLine: header.line, rows, ...mapping };
}

// Texto de un archivo subido. Las hojas de cálculo en español guardan CSV en UTF-8 (con o sin marca), en UTF-16
// («texto Unicode») o en Windows-1252; si no es UTF-8 válido se lee como Windows-1252, que nunca falla.
export function decodeCsv(bytes) {
  if (typeof bytes === 'string') throw new TypeError('decodeCsv recibe los bytes del archivo, no texto.');
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view[0] === 0xff && view[1] === 0xfe)
    return { text: new TextDecoder('utf-16le').decode(view), encoding: 'utf-16le' };
  if (view[0] === 0xfe && view[1] === 0xff)
    return { text: new TextDecoder('utf-16be').decode(view), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(view), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(view), encoding: 'windows-1252' };
  }
}

// ---- Escritura

const FORMULA = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",;\t\r\n]/;

// Una celda lista para escribir. Lo que una hoja de cálculo ejecutaría como fórmula (empieza con =, +, -, @, tabulador
// o retorno de carro) se antepone con un apóstrofo: un nombre escrito por un cliente no debe correr nada en la
// computadora de quien abre la exportación. La coma, el punto y coma y el tabulador fuerzan comillas siempre, para que
// una hoja configurada con otro separador no parta la celda.
export function csvCell(value, options) {
  let text = asText(value);
  if (FORMULA.test(text)) text = "'" + text;
  const delimiter = options !== null && typeof options === 'object' ? options.delimiter : undefined;
  const quote =
    NEEDS_QUOTES.test(text) || (typeof delimiter === 'string' && delimiter !== '' && text.includes(delimiter));
  return quote ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// Una fila sin fin de línea.
export function csvLine(cells, { delimiter = ',' } = {}) {
  return cells.map(cell => csvCell(cell, { delimiter })).join(delimiter);
}

// Un archivo completo a partir de filas (listas de celdas). Por omisión termina cada línea con CRLF, que es lo que
// esperan las hojas de cálculo; `bom: true` antepone la marca con la que Excel reconoce UTF-8 y no rompe los acentos.
export function toCsv(rows, { header, delimiter = ',', bom = false, eol = '\r\n' } = {}) {
  assertDelimiter(delimiter);
  if (eol !== '\r\n' && eol !== '\n') throw new TypeError('El fin de línea del CSV debe ser CRLF o LF.');
  let out = bom ? CSV_BOM : '';
  if (header) out += csvLine(header, { delimiter }) + eol;
  for (const row of rows) out += csvLine(row, { delimiter }) + eol;
  return out;
}
