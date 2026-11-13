// Migraciones con nombre: todo cambio de esquema posterior a la escalera cerrada (ladder.mjs).
//
// Una migración es un archivo server/migrations/named/<área>/<NNNN>-<descripción>.mjs que exporta
//   { name: '<área>/<NNNN>-<descripción>', after: [], up(db) { … } }
// y se apunta en el índice de su área, que a su vez está en registry.mjs. Se aplica una sola vez, dentro de la
// transacción que abre este ejecutor, y queda anotada en la tabla schema_migrations.
//
// Reglas del cuerpo up(db):
//   - Síncrono, sin BEGIN/COMMIT, sin PRAGMA user_version, sin red ni archivos.
//   - Aditivo: tablas, índices y columnas con DEFAULT o que admiten NULL (addColumn). Sólo toca tablas de su
//     área; si necesita algo de otra, lo declara en `after`.
//   - Tablas y disparadores se crean SIN «IF NOT EXISTS»: el ejecutor ya garantiza una sola pasada, y así dos
//     migraciones que crean el mismo objeto fallan en lugar de callar.
//   - Reconstruir una tabla (cambiar una restricción, quitar una columna) exige marcar la migración con
//     `rebuild: true` y usar rebuildTable; va siempre con una prueba de actualización sobre una base poblada.
//   - Rellenos de datos acotados; uno grande va en un trabajo reanudable, no aquí.
//   - Una vez publicada, el archivo no se modifica: un error se corrige con otra migración.
import { createHash } from 'node:crypto';
import { transaction } from '../database.mjs';

const NAME = /^([a-z][a-z0-9-]*)\/(\d{4})-[a-z0-9-]+$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE =
  'CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID';

const userVersion = db => db.prepare('PRAGMA user_version').get().user_version;
const isApplied = (db, name) => Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name));

// Valida el registro al cargarlo: nombres bien formados y únicos, numeración creciente dentro de cada área,
// cuerpo síncrono y dependencias declaradas antes que quien las pide.
export function defineRegistry(list) {
  const seen = new Set();
  const lastNumber = new Map();
  for (const m of list) {
    const parts = NAME.exec(m?.name ?? '');
    if (!parts) throw new Error(`Nombre de migración no válido: ${m?.name}`);
    if (seen.has(m.name)) throw new Error(`Migración repetida: ${m.name}`);
    if (typeof m.up !== 'function') throw new Error(`La migración ${m.name} no tiene up(db).`);
    if (m.up.constructor.name === 'AsyncFunction') throw new Error(`La migración ${m.name} debe ser síncrona.`);
    const area = parts[1];
    const number = Number(parts[2]);
    if (lastNumber.has(area) && number <= lastNumber.get(area))
      throw new Error(`${m.name}: la numeración del área «${area}» debe crecer.`);
    lastNumber.set(area, number);
    if (m.after !== undefined && !Array.isArray(m.after)) throw new Error(`${m.name}: «after» debe ser una lista.`);
    for (const dep of m.after ?? [])
      if (!seen.has(dep)) throw new Error(`${m.name} depende de ${dep}, que no aparece antes en el registro.`);
    seen.add(m.name);
  }
  return Object.freeze([...list]);
}

export const hasMigrationsTable = db =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get());

export const appliedNames = db =>
  hasMigrationsTable(db)
    ? db
        .prepare('SELECT name FROM schema_migrations ORDER BY name')
        .all()
        .map(row => row.name)
    : [];

export function pendingNamed(db, registry) {
  const done = new Set(appliedNames(db));
  return registry.filter(m => !done.has(m.name));
}

function applyOne(db, m, now) {
  const started = now();
  // Una reconstrucción necesita las claves foráneas apagadas, y ese interruptor no cambia dentro de una transacción.
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  if (m.rebuild) db.exec('PRAGMA foreign_keys=OFF');
  try {
    return transaction(db, () => {
      if (isApplied(db, m.name)) return false; // otro proceso se adelantó
      for (const dep of m.after ?? []) if (!isApplied(db, dep)) throw new Error(`${m.name}: falta ${dep}.`);
      const version = userVersion(db);
      const result = m.up(db);
      if (result && typeof result.then === 'function') throw new Error(`${m.name}: up(db) debe ser síncrona.`);
      if (userVersion(db) !== version) throw new Error(`${m.name}: una migración con nombre no cambia user_version.`);
      if (m.rebuild) {
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length)
          throw new Error(
            `${m.name}: la reconstrucción deja ${broken.length} referencias rotas (${[...new Set(broken.map(row => row.table))].join(', ')}).`,
          );
      }
      db.prepare('INSERT INTO schema_migrations(name,applied_at,duration_ms) VALUES(?,?,?)').run(
        m.name,
        started,
        Math.max(0, now() - started),
      );
      return true;
    });
  } finally {
    if (m.rebuild && foreignKeys) db.exec('PRAGMA foreign_keys=ON');
  }
}

// Aplica, en el orden del registro, las migraciones que la base todavía no tiene. `unknown` son las anotadas en la
// base que este código no conoce: la base es más nueva que el código (por ejemplo tras revertir un despliegue).
export function applyNamed(db, registry, { now = Date.now, log = () => {} } = {}) {
  db.exec(TABLE);
  const applied = [];
  for (const m of pendingNamed(db, registry)) {
    if (applyOne(db, m, now)) {
      applied.push(m.name);
      log(m.name);
    }
  }
  const known = new Set(registry.map(m => m.name));
  return { applied, unknown: appliedNames(db).filter(name => !known.has(name)) };
}

// Identidad del esquema: «41» sin migraciones con nombre; «41+3.9f2c1ab0» con tres (huella de los nombres ordenados).
export function formatSchemaId(version, names) {
  if (!names.length) return String(version);
  const digest = createHash('sha256')
    .update([...names].sort().join('\n'))
    .digest('hex');
  return `${version}+${names.length}.${digest.slice(0, 8)}`;
}
export const schemaId = db => formatSchemaId(userVersion(db), appliedNames(db));

// ALTER TABLE … ADD COLUMN no tiene «IF NOT EXISTS»: este ayudante añade la columna sólo si falta.
export function addColumn(db, table, column, ddl) {
  if (!IDENTIFIER.test(table) || !IDENTIFIER.test(column)) throw new Error(`Nombre no válido: ${table}.${column}`);
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some(info => info.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return !exists;
}

// Reconstruye una tabla (crear la nueva, copiar, borrar la vieja, renombrar) conservando filas, índices,
// disparadores y el contador de AUTOINCREMENT. Sólo dentro de una migración marcada `rebuild: true`.
//   definition  cuerpo entre paréntesis de la tabla nueva
//   columns     columnas de la tabla nueva que se llenan
//   select      expresiones sobre la tabla vieja, en el mismo orden (por omisión, las mismas columnas)
//   skip        índices o disparadores de la tabla vieja que NO se vuelven a crear (los sustituye la migración)
export function rebuildTable(db, table, { definition, columns, select = columns, skip = [] }) {
  if (!IDENTIFIER.test(table)) throw new Error(`Nombre de tabla no válido: ${table}`);
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys)
    throw new Error(`rebuildTable(${table}) sólo puede usarse en una migración marcada rebuild:true.`);
  if (!columns?.length || columns.length !== select.length)
    throw new Error(`rebuildTable(${table}): «columns» y «select» deben tener la misma longitud.`);
  const objects = sql => db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE ${sql} ORDER BY name`);
  const own = objects("tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL")
    .all(table)
    .filter(object => !skip.includes(object.name));
  // Las vistas y los disparadores de otras tablas pueden nombrar a ésta; SQLite los revisa al renombrar y fallaría
  // mientras la tabla no existe. Se retiran y se vuelven a crear tal cual, dentro de la misma transacción.
  const triggers = objects("type='trigger' AND tbl_name<>?").all(table);
  const views = objects("type='view'").all();
  for (const trigger of triggers) db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
  for (const view of views) db.exec(`DROP VIEW "${view.name}"`);
  const hasSequence = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get());
  const sequence = hasSequence ? db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table) : undefined;
  const count = () => db.prepare(`SELECT count(*) n FROM "${table}"`).get().n;
  const rows = count();
  db.exec(`CREATE TABLE "${table}__rebuild" (${definition})`);
  db.exec(`INSERT INTO "${table}__rebuild"(${columns.join(',')}) SELECT ${select.join(',')} FROM "${table}"`);
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${table}__rebuild" RENAME TO "${table}"`);
  for (const object of [...own.filter(o => o.type === 'index'), ...views, ...own.filter(o => o.type === 'trigger')])
    db.exec(object.sql);
  for (const trigger of triggers) db.exec(trigger.sql);
  if (sequence && /\bAUTOINCREMENT\b/i.test(definition)) {
    // Sin esto el contador retrocedería al mayor identificador copiado y podría repetirse uno ya usado y borrado.
    if (db.prepare('SELECT 1 FROM sqlite_sequence WHERE name=?').get(table))
      db.prepare('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?').run(sequence.seq, table);
    else db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(table, sequence.seq);
  }
  if (count() !== rows) throw new Error(`rebuildTable(${table}): se esperaban ${rows} filas y hay ${count()}.`);
  return { rows };
}
