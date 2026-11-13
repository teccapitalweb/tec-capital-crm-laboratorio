import assert from 'node:assert/strict';
import { LADDER_VERSION, NAMED } from '../../server/migrations/index.mjs';

// La base quedó migrada por completo: escalera cerrada y exactamente las migraciones con nombre del registro.
// Las pruebas no afirman un número de esquema: así no hay que tocarlas cada vez que llega una migración.
export function assertSchemaCurrent(db) {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, LADDER_VERSION, 'versión de la escalera');
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  const names = table
    ? db
        .prepare('SELECT name FROM schema_migrations ORDER BY name')
        .all()
        .map(row => row.name)
    : [];
  assert.deepEqual(names, NAMED.map(m => m.name).sort(), 'migraciones con nombre aplicadas');
}

// Forma completa del esquema (tablas, índices, disparadores y vistas), para comparar dos bases entre sí.
export const schemaShape = db =>
  db
    .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all()
    .map(row => ({ ...row }));
