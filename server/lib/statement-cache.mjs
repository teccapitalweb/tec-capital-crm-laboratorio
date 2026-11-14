// Sentencias SQLite preparadas una sola vez.
//
// Por qué existe: varios servicios escriben `db.prepare('…').run(…)` en cada llamada. Preparar una sentencia que toca
// `contacts` compila también sus disparadores (la búsqueda de contactos) y cuesta unas décimas de milisegundo: en una
// importación de miles de filas eso es la mitad del tiempo. `withStatementCache(db)` devuelve la misma conexión con
// un `prepare` que recuerda cada texto SQL (hasta `max`). Una sentencia de node:sqlite se reinicia en cada `run`,
// `get` y `all`, así que reutilizarla es seguro; no se debe usar con `iterate()` anidado sobre el mismo texto.
export function withStatementCache(db, { max = 500 } = {}) {
  const cache = new Map();
  const prepare = sql => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      if (cache.size < max) cache.set(sql, statement);
    }
    return statement;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return prepare;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
