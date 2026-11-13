// Lleva una base, en cualquier versión publicada, al esquema que este código espera:
// respaldo previo (si hay algo pendiente y la base tiene usuarios) → escalera cerrada → migraciones con nombre.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { LADDER_VERSION, runLadder } from './ladder.mjs';
import { NAMED } from './registry.mjs';
import { applyNamed, formatSchemaId, pendingNamed, schemaId } from './named.mjs';

export { LADDER_VERSION, NAMED };

// La identidad que debe tener una base al día con este código (`npm run schema:id`; /api/health la devuelve en `schema`).
export const expectedSchemaId = (registry = NAMED) =>
  formatSchemaId(
    LADDER_VERSION,
    registry.map(m => m.name),
  );

export function migrate(db, { dataDir, registry = NAMED, backup = true, now = Date.now, log = () => {} } = {}) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > LADDER_VERSION)
    throw new Error(
      `La base está en la versión ${version}, posterior a la que este código conoce (${LADDER_VERSION}).`,
    );
  const waiting = pendingNamed(db, registry);
  let backupFile = null;
  if (backup && (version < LADDER_VERSION || waiting.length) && db.prepare('SELECT count(*) n FROM users').get().n) {
    if (!dataDir) throw new Error('migrate() necesita dataDir para el respaldo previo.');
    mkdirSync(resolve(dataDir, 'backups'), { recursive: true });
    const label = version < LADDER_VERSION ? `crm-v${LADDER_VERSION}` : waiting[0].name.replace(/[^a-z0-9]+/g, '-');
    backupFile = resolve(dataDir, 'backups', `before-${label}-${now()}.sqlite`);
    db.prepare('VACUUM INTO ?').run(backupFile);
  }
  runLadder(db);
  const named = applyNamed(db, registry, { now, log });
  return { ladder: LADDER_VERSION, ...named, backupFile, id: schemaId(db) };
}
