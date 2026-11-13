import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, existsSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { appliedNames, schemaId } from './migrations/named.mjs';

const MEDIA = ['uploads', 'library'];
const stamp = t =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

function mediaList(dataDir) {
  const out = {};
  for (const folder of MEDIA) {
    const dir = resolve(dataDir, folder);
    out[folder] = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter(f => f.isFile())
          .map(f => ({ name: f.name, size: statSync(join(dir, f.name)).size }))
      : [];
  }
  return out;
}
const count = (db, table) => {
  try {
    return db.prepare('SELECT count(*) n FROM ' + table).get().n;
  } catch {
    return null;
  }
};

// Comprueba un respaldo: integridad de SQLite, esquema (versión de la escalera e identidad con las migraciones con nombre,
// si el manifiesto la trae), claves foráneas y, si se indica un directorio de datos,
// que cada adjunto de la lista exista con el mismo tamaño. No modifica nada.
export function verifyBackup(backupDir, dataDir = null) {
  const problems = [],
    file = join(backupDir, 'laboratorio.sqlite'),
    manifestFile = join(backupDir, 'manifest.json');
  if (!existsSync(file)) return { ok: false, problems: ['Falta laboratorio.sqlite'] };
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch {
    problems.push('Falta o no se puede leer manifest.json');
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') problems.push('integrity_check: ' + integrity);
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) problems.push(fk.length + ' violaciones de claves foráneas');
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    if (manifest && manifest.schema !== schema) problems.push('Esquema distinto al del manifiesto');
    // Los manifiestos anteriores a las migraciones con nombre no traen schemaId y siguen valiendo.
    if (manifest?.schemaId && manifest.schemaId !== schemaId(db))
      problems.push('Migraciones distintas a las del manifiesto');
    const counts = {
      users: count(db, 'users'),
      conversations: count(db, 'conversations'),
      messages: count(db, 'messages'),
    };
    if (manifest)
      for (const k of Object.keys(counts))
        if (counts[k] !== manifest.counts?.[k]) problems.push('Conteo distinto en ' + k);
    if (manifest && dataDir)
      for (const folder of MEDIA)
        for (const f of manifest.media?.[folder] || []) {
          const path = join(dataDir, folder, f.name);
          if (!existsSync(path)) problems.push('Falta ' + folder + '/' + f.name);
          else if (statSync(path).size !== f.size) problems.push('Tamaño distinto en ' + folder + '/' + f.name);
        }
    return { ok: problems.length === 0, schema, counts, problems };
  } finally {
    db.close();
  }
}

// Copias consistentes de SQLite (VACUUM INTO) con manifiesto de adjuntos. Los adjuntos y archivos de biblioteca son inmutables
// (nombre UUID), así que el manifiesto basta para detectar pérdidas; copiarlos a otro volumen sigue siendo una tarea externa.
export function createBackups({ db, dataDir, version, intervalMs, keep = 7, now = Date.now, log = console }) {
  const root = resolve(dataDir, 'backups');
  let running = false;
  const names = () =>
    existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory() && /^auto-\d{8}T\d{6}Z$/.test(d.name))
          .map(d => d.name)
          .sort()
      : [];
  function list() {
    return names()
      .reverse()
      .map(name => {
        let manifest = null;
        try {
          manifest = JSON.parse(readFileSync(join(root, name, 'manifest.json'), 'utf8'));
        } catch {}
        return {
          name,
          createdAt: manifest?.createdAt || null,
          schema: manifest?.schema ?? null,
          schemaId: manifest?.schemaId ?? null,
          counts: manifest?.counts || null,
          bytes: existsSync(join(root, name, 'laboratorio.sqlite'))
            ? statSync(join(root, name, 'laboratorio.sqlite')).size
            : 0,
        };
      });
  }
  function run() {
    if (running) throw Object.assign(new Error('Ya hay un respaldo en curso.'), { status: 409 });
    running = true;
    try {
      mkdirSync(root, { recursive: true });
      const t = now(),
        name = 'auto-' + stamp(t),
        partial = join(root, name + '.partial'),
        final = join(root, name);
      if (existsSync(final)) return list().find(b => b.name === name);
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(partial);
      db.prepare('VACUUM INTO ?').run(join(partial, 'laboratorio.sqlite'));
      const snap = new DatabaseSync(join(partial, 'laboratorio.sqlite'), { readOnly: true });
      let manifest;
      try {
        manifest = {
          createdAt: t,
          version,
          schema: snap.prepare('PRAGMA user_version').get().user_version,
          schemaId: schemaId(snap),
          migrations: appliedNames(snap),
          counts: {
            users: count(snap, 'users'),
            conversations: count(snap, 'conversations'),
            messages: count(snap, 'messages'),
          },
          media: mediaList(dataDir),
        };
      } finally {
        snap.close();
      }
      writeFileSync(join(partial, 'manifest.json'), JSON.stringify(manifest, null, 1));
      const check = verifyBackup(partial, null);
      if (!check.ok) {
        rmSync(partial, { recursive: true, force: true });
        throw new Error('El respaldo no pasó la verificación: ' + check.problems.join('; '));
      }
      renameSync(partial, final);
      for (const old of names().slice(0, Math.max(0, names().length - keep)))
        rmSync(join(root, old), { recursive: true, force: true });
      return list().find(b => b.name === name);
    } finally {
      running = false;
    }
  }
  function due() {
    const newest = list()[0];
    return !newest || !newest.createdAt || now() - newest.createdAt >= intervalMs;
  }
  function tick() {
    if (!intervalMs || running || !due()) return null;
    try {
      return run();
    } catch (e) {
      log.error('Backup failed:', String(e.message).slice(0, 200));
      return null;
    }
  }
  return { list, run, tick, due, root };
}

export function backupRoutes(backups) {
  return async function handle(req, res, path, user, { json, audit }) {
    if (path !== '/api/backups' && path !== '/api/backups/run') return false;
    if (user.role !== 'admin')
      throw Object.assign(new Error('Los respaldos los administra un administrador.'), { status: 403 });
    if (req.method === 'GET' && path === '/api/backups') {
      json(res, 200, {
        backups: backups.list(),
        root: 'backups/',
        external: 'Copia estos respaldos y los adjuntos (uploads/, library/) fuera del volumen.',
      });
      return true;
    }
    if (req.method === 'POST' && path === '/api/backups/run') {
      const b = backups.run();
      audit(user, 'backup.run', b.name);
      json(res, 201, { backup: b });
      return true;
    }
    throw Object.assign(new Error('Método no permitido.'), { status: 405 });
  };
}
