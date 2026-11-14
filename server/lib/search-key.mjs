// Clave de búsqueda de un texto: minúsculas y sin acentos («José Ñúñez» → «jose nunez»), igual en SQL y en JavaScript.
//
// Por qué existe: la lista de contactos busca y ordena por nombre sin distinguir mayúsculas ni acentos, y esa clave la
// escriben disparadores de SQLite (server/migrations/named/contacts/0001-search.mjs) que no pueden llamar a funciones
// de JavaScript: un disparador que nombra una función propia falla en cualquier conexión que no la registró (una copia
// de respaldo, una herramienta, una versión anterior del servidor). Por eso la clave se arma sólo con `lower()` y
// `replace()` de SQLite, y aquí está su gemela en JavaScript para preparar lo que se busca.
//
//   searchKeySql('new.name')   → expresión SQL para un disparador o un relleno
//   searchKey('Ángela')        → 'angela', para comparar con instr(name_key, ?)
//
// Las dos dan lo mismo por construcción: `lower()` de SQLite sólo cambia A-Z, así que aquí también; y cada letra
// acentuada se cambia por la misma de la tabla, en mayúscula y en minúscula. Lo que no está en la tabla se queda igual
// en los dos lados.
//
// Cambiar la tabla cambia las claves que ya están guardadas: exige otra migración que vuelva a crear los disparadores
// y a llenar la columna. No se edita sin ella.

// Letra → la que la sustituye. Español primero; después las vocales con otros acentos que llegan en nombres.
export const SEARCH_FOLD = Object.freeze([
  ['á', 'a'],
  ['é', 'e'],
  ['í', 'i'],
  ['ó', 'o'],
  ['ú', 'u'],
  ['ü', 'u'],
  ['ñ', 'n'],
  ['Á', 'a'],
  ['É', 'e'],
  ['Í', 'i'],
  ['Ó', 'o'],
  ['Ú', 'u'],
  ['Ü', 'u'],
  ['Ñ', 'n'],
  ['à', 'a'],
  ['è', 'e'],
  ['ì', 'i'],
  ['ò', 'o'],
  ['ù', 'u'],
  ['À', 'a'],
  ['È', 'e'],
  ['Ì', 'i'],
  ['Ò', 'o'],
  ['Ù', 'u'],
  ['â', 'a'],
  ['ê', 'e'],
  ['î', 'i'],
  ['ô', 'o'],
  ['û', 'u'],
  ['Â', 'a'],
  ['Ê', 'e'],
  ['Î', 'i'],
  ['Ô', 'o'],
  ['Û', 'u'],
  ['ä', 'a'],
  ['ë', 'e'],
  ['ï', 'i'],
  ['ö', 'o'],
  ['Ä', 'a'],
  ['Ë', 'e'],
  ['Ï', 'i'],
  ['Ö', 'o'],
  ['ã', 'a'],
  ['õ', 'o'],
  ['Ã', 'a'],
  ['Õ', 'o'],
  ['ç', 'c'],
  ['Ç', 'c'],
]);

const FOLD = new Map(SEARCH_FOLD);
const IDENTIFIER = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/i;

// Clave en JavaScript. Un texto en otra forma de Unicode (letra y acento por separado) se junta antes.
export function searchKey(value) {
  if (value === null || value === undefined) return '';
  let out = '';
  for (const char of String(value).normalize('NFC')) {
    const code = char.charCodeAt(0);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : (FOLD.get(char) ?? char);
  }
  return out;
}

// La misma clave como expresión SQL sobre una columna (`new.name`, `c.email`). Sólo acepta un nombre de columna: lo
// que escribe una persona nunca llega aquí.
export function searchKeySql(column) {
  if (!IDENTIFIER.test(column)) throw new TypeError('searchKeySql: se esperaba el nombre de una columna.');
  let sql = `lower(COALESCE(${column}, ''))`;
  for (const [from, to] of SEARCH_FOLD) sql = `replace(${sql}, '${from}', '${to}')`;
  return sql;
}
