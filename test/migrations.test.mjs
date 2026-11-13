import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../server/database.mjs';
import { LADDER, LADDER_VERSION, runLadder } from '../server/migrations/ladder.mjs';
import { NAMED } from '../server/migrations/registry.mjs';
import { migrate, expectedSchemaId } from '../server/migrations/index.mjs';
import {
  defineRegistry,
  applyNamed,
  pendingNamed,
  appliedNames,
  schemaId,
  formatSchemaId,
  addColumn,
  rebuildTable,
} from '../server/migrations/named.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';

const memory = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  return db;
};
const version = db => db.prepare('PRAGMA user_version').get().user_version;
const exists = (db, name) => Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
// Carpeta temporal. Al terminar la prueba se ejecuta lo apuntado con `later` (en orden inverso: primero se cierran
// las bases y el servidor) y al final se borra la carpeta.
async function workspace(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const pending = [];
  t.after(async () => {
    for (const task of pending.reverse()) {
      try {
        await task();
      } catch {
        // ya estaba cerrado
      }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, later: task => pending.push(task) };
}
const addUser = db =>
  db
    .prepare(
      'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run('old-user', 'old', 'Anterior', 'unused', 'customer', 800000, 1, 1);

// ---------------------------------------------------------------------------------------------------------------
// A. El ejecutor, sin servidor
// ---------------------------------------------------------------------------------------------------------------

test('el ejecutor aplica en el orden del registro, anota cada migración y no repite ninguna', () => {
  const db = memory();
  const order = [];
  const registry = defineRegistry([
    {
      name: 'uno/0001-base',
      up(d) {
        order.push('uno/0001');
        d.exec('CREATE TABLE a(id INTEGER PRIMARY KEY)');
      },
    },
    {
      name: 'uno/0002-columna',
      after: ['uno/0001-base'],
      up(d) {
        order.push('uno/0002');
        assert.equal(addColumn(d, 'a', 'nota', "TEXT NOT NULL DEFAULT ''"), true);
        assert.equal(addColumn(d, 'a', 'nota', "TEXT NOT NULL DEFAULT ''"), false, 'la columna no se añade dos veces');
      },
    },
    {
      name: 'dos/0001-otra',
      after: ['uno/0001-base'],
      up(d) {
        order.push('dos/0001');
        d.exec('CREATE TABLE b(id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id))');
      },
    },
  ]);
  assert.equal(pendingNamed(db, registry).length, 3, 'sin tabla de anotaciones todo está pendiente');
  let clock = 1000;
  const logged = [];
  const first = applyNamed(db, registry, { now: () => clock++, log: name => logged.push(name) });
  const names = ['uno/0001-base', 'uno/0002-columna', 'dos/0001-otra'];
  assert.deepEqual(first, { applied: names, unknown: [] });
  assert.deepEqual(order, ['uno/0001', 'uno/0002', 'dos/0001']);
  assert.deepEqual(logged, names);
  assert.deepEqual(appliedNames(db), [...names].sort());
  const rows = () =>
    db
      .prepare('SELECT name,applied_at,duration_ms FROM schema_migrations ORDER BY name')
      .all()
      .map(row => ({ ...row }));
  const before = rows();
  assert.ok(before.every(row => row.applied_at >= 1000 && row.duration_ms >= 0));
  db.prepare("INSERT INTO a(id,nota) VALUES(1,'x')").run();
  const second = applyNamed(db, registry, { now: () => clock++ });
  assert.deepEqual(second, { applied: [], unknown: [] });
  assert.deepEqual(rows(), before, 'una segunda pasada no cambia las anotaciones');
  assert.deepEqual(order.length, 3, 'ni vuelve a ejecutar ningún cuerpo');
  assert.equal(pendingNamed(db, registry).length, 0);
  assert.throws(() => addColumn(db, 'a; DROP TABLE a', 'x', 'TEXT'), /no válido/);
});

test('una migración que falla a la mitad no deja ni su tabla ni su anotación; las anteriores quedan', () => {
  const db = memory();
  const good = {
    name: 'x/0001-bien',
    up: d => d.exec('CREATE TABLE bien(id INTEGER PRIMARY KEY)'),
  };
  const broken = defineRegistry([
    good,
    {
      name: 'x/0002-mal',
      up(d) {
        d.exec('CREATE TABLE mal(id INTEGER PRIMARY KEY)');
        d.exec('INSERT INTO mal VALUES(1)');
        throw new Error('fallo a propósito');
      },
    },
    { name: 'x/0003-despues', up: d => d.exec('CREATE TABLE despues(id INTEGER PRIMARY KEY)') },
  ]);
  assert.throws(() => applyNamed(db, broken), /fallo a propósito/);
  assert.equal(exists(db, 'bien'), true);
  assert.equal(exists(db, 'mal'), false, 'la tabla de la migración fallida no queda');
  assert.equal(exists(db, 'despues'), false, 'el ejecutor se detiene en el primer fallo');
  assert.deepEqual(appliedNames(db), ['x/0001-bien']);
  // Con el archivo corregido (todavía sin publicar), el siguiente arranque continúa donde se quedó.
  const fixed = defineRegistry([
    good,
    { name: 'x/0002-mal', up: d => d.exec('CREATE TABLE mal(id INTEGER PRIMARY KEY)') },
    broken[2],
  ]);
  assert.deepEqual(applyNamed(db, fixed).applied, ['x/0002-mal', 'x/0003-despues']);
  assert.equal(exists(db, 'mal') && exists(db, 'despues'), true);
});

test('el registro rechaza nombres mal formados o repetidos, numeración que no crece, cuerpos asíncronos y dependencias mal puestas', () => {
  const up = () => {};
  for (const name of ['Perf/0001-x', 'perf/1-x', 'perf/0001_x', '0001-x', 'perf/0001-', 'perf/0001-X', undefined])
    assert.throws(() => defineRegistry([{ name, up }]), /no válido/, String(name));
  assert.throws(
    () =>
      defineRegistry([
        { name: 'a/0001-x', up },
        { name: 'a/0001-x', up },
      ]),
    /repetida/,
  );
  assert.throws(() => defineRegistry([{ name: 'a/0001-x' }]), /no tiene up/);
  assert.throws(() => defineRegistry([{ name: 'a/0001-x', up: async () => {} }]), /síncrona/);
  assert.throws(
    () =>
      defineRegistry([
        { name: 'a/0002-x', up },
        { name: 'a/0001-y', up },
      ]),
    /debe crecer/,
  );
  assert.throws(
    () =>
      defineRegistry([
        { name: 'a/0001-x', up },
        { name: 'a/0001-y', up },
      ]),
    /debe crecer/,
  );
  assert.throws(() => defineRegistry([{ name: 'a/0001-x', up, after: 'b/0001-y' }]), /lista/);
  assert.throws(() => defineRegistry([{ name: 'a/0001-x', up, after: ['b/0001-y'] }]), /no aparece antes/);
  assert.throws(
    () =>
      defineRegistry([
        { name: 'a/0001-x', up, after: ['b/0001-y'] },
        { name: 'b/0001-y', up },
      ]),
    /no aparece antes/,
    'una dependencia no puede ir después de quien la pide',
  );
  const ok = defineRegistry([
    { name: 'a/0001-x', up },
    { name: 'b/0001-y', up, after: ['a/0001-x'] },
    { name: 'a/0002-z', up, after: ['b/0001-y'] },
  ]);
  assert.equal(ok.length, 3);
  assert.equal(Object.isFrozen(ok), true);
});

test('una anotación que el código no conoce aparece en «unknown» y no impide arrancar', () => {
  const db = memory();
  const registry = defineRegistry([{ name: 'a/0001-x', up: d => d.exec('CREATE TABLE x(id INTEGER PRIMARY KEY)') }]);
  applyNamed(db, registry);
  db.prepare("INSERT INTO schema_migrations(name,applied_at) VALUES('z/0009-del-futuro',5)").run();
  const again = applyNamed(db, registry);
  assert.deepEqual(again, { applied: [], unknown: ['z/0009-del-futuro'] });
  assert.notEqual(schemaId(db), formatSchemaId(0, ['a/0001-x']), 'la identidad delata que la base es más nueva');
});

test('la identidad del esquema no depende del orden de aplicación y coincide con la esperada', () => {
  const a = { name: 'a/0001-x', up: d => d.exec('CREATE TABLE x(id INTEGER PRIMARY KEY)') };
  const b = { name: 'b/0001-y', up: d => d.exec('CREATE TABLE y(id INTEGER PRIMARY KEY)') };
  const one = memory();
  const two = memory();
  for (const db of [one, two]) db.exec('PRAGMA user_version=' + LADDER_VERSION);
  assert.equal(schemaId(one), String(LADDER_VERSION), 'sin migraciones con nombre es sólo la versión de la escalera');
  applyNamed(one, defineRegistry([a, b]));
  applyNamed(two, defineRegistry([b, a]));
  assert.equal(schemaId(one), schemaId(two));
  assert.equal(schemaId(one), expectedSchemaId(defineRegistry([a, b])));
  assert.match(schemaId(one), new RegExp('^' + LADDER_VERSION + '\\+2\\.[0-9a-f]{8}$'));
  assert.notEqual(schemaId(one), expectedSchemaId(defineRegistry([a])));
  assert.equal(expectedSchemaId(defineRegistry([])), String(LADDER_VERSION));
  assert.equal(formatSchemaId(41, ['b', 'a']), formatSchemaId(41, ['a', 'b']));
});

test('una migración con nombre no puede cambiar user_version ni devolver una promesa', () => {
  const db = memory();
  db.exec('PRAGMA user_version=41');
  const sneaky = defineRegistry([
    {
      name: 'a/0001-sube',
      up(d) {
        d.exec('CREATE TABLE sube(id INTEGER PRIMARY KEY); PRAGMA user_version=42');
      },
    },
  ]);
  assert.throws(() => applyNamed(db, sneaky), /no cambia user_version/);
  assert.equal(version(db), 41, 'la versión vuelve a su valor');
  assert.equal(exists(db, 'sube'), false);
  const later = defineRegistry([
    {
      name: 'a/0001-promesa',
      up(d) {
        d.exec('CREATE TABLE promesa(id INTEGER PRIMARY KEY)');
        return Promise.resolve();
      },
    },
  ]);
  assert.throws(() => applyNamed(db, later), /síncrona/);
  assert.equal(exists(db, 'promesa'), false);
  assert.deepEqual(appliedNames(db), []);
});

test('reconstruir una tabla conserva filas, índices, disparadores, vistas, contador y claves foráneas', () => {
  const db = memory();
  db.exec(`
    CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX parent_name ON parent(name);
    CREATE INDEX parent_old ON parent(hits);
    CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));
    CREATE TABLE log(what TEXT NOT NULL);
    CREATE TRIGGER parent_renamed AFTER UPDATE OF name ON parent BEGIN INSERT INTO log VALUES('renombrado ' || NEW.id); END;
    CREATE TRIGGER child_added AFTER INSERT ON child BEGIN UPDATE parent SET hits=hits+1 WHERE id=NEW.parent_id; END;
    CREATE VIEW parent_names AS SELECT id,name FROM parent;
    CREATE VIEW child_view AS SELECT id,parent_id FROM child;
    CREATE TRIGGER child_view_insert INSTEAD OF INSERT ON child_view BEGIN INSERT INTO child(id,parent_id) VALUES(NEW.id,NEW.parent_id); END;
    INSERT INTO parent(name) VALUES('uno'),('dos'),('tres');
    INSERT INTO child VALUES(10,1),(11,2);
    DELETE FROM parent WHERE id=3;
  `);
  const shapeOf = name => db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql;
  const others = ['parent_name', 'parent_renamed', 'child_added', 'parent_names', 'child_view', 'child_view_insert'];
  const before = Object.fromEntries(others.map(name => [name, shapeOf(name)]));

  // Fuera de una migración marcada, el ayudante se niega.
  const unmarked = defineRegistry([
    {
      name: 'r/0001-sin-marca',
      up: d => rebuildTable(d, 'parent', { definition: 'id INTEGER PRIMARY KEY', columns: ['id'] }),
    },
  ]);
  assert.throws(() => applyNamed(db, unmarked), /rebuild:true/);
  assert.equal(db.prepare('SELECT count(*) n FROM parent').get().n, 2);

  const registry = defineRegistry([
    {
      name: 'r/0001-reconstruir',
      rebuild: true,
      up(d) {
        assert.equal(d.prepare('PRAGMA foreign_keys').get().foreign_keys, 0, 'claves foráneas apagadas durante up');
        const result = rebuildTable(d, 'parent', {
          definition:
            "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'x' CHECK(kind IN ('x','y')), hits INTEGER NOT NULL DEFAULT 0",
          columns: ['id', 'name', 'hits'],
          select: ['id', 'upper(name)', 'hits'],
          skip: ['parent_old'],
        });
        assert.deepEqual(result, { rows: 2 });
      },
    },
  ]);
  assert.deepEqual(applyNamed(db, registry).applied, ['r/0001-reconstruir']);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'las claves foráneas vuelven a estar activas');
  assert.deepEqual(
    db
      .prepare('SELECT id,name,kind,hits FROM parent ORDER BY id')
      .all()
      .map(row => ({ ...row })),
    [
      { id: 1, name: 'UNO', kind: 'x', hits: 1 },
      { id: 2, name: 'DOS', kind: 'x', hits: 1 },
    ],
  );
  for (const name of others) assert.equal(shapeOf(name), before[name], name + ' se conserva tal cual');
  assert.equal(shapeOf('parent_old'), undefined, 'lo que se pide omitir no se vuelve a crear');
  assert.equal(exists(db, 'parent__rebuild'), false);
  assert.match(shapeOf('parent'), /kind TEXT NOT NULL DEFAULT 'x'/);
  // el disparador de la propia tabla, el de otra tabla que la nombra, la vista y el disparador sobre una vista siguen vivos
  db.prepare("UPDATE parent SET name='Uno' WHERE id=1").run();
  assert.equal(db.prepare('SELECT what FROM log').get().what, 'renombrado 1');
  db.prepare('INSERT INTO child_view(id,parent_id) VALUES(12,1)').run();
  assert.equal(db.prepare('SELECT hits FROM parent WHERE id=1').get().hits, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM parent_names').get().n, 2);
  // la restricción nueva y las claves foráneas se aplican
  assert.throws(() => db.prepare("INSERT INTO parent(name,kind) VALUES('x','z')").run(), /CHECK/);
  assert.throws(() => db.prepare('INSERT INTO child VALUES(13,99)').run(), /FOREIGN KEY/);
  // el contador no retrocede: el 3 ya se usó y se borró
  assert.equal(Number(db.prepare("INSERT INTO parent(name) VALUES('cuatro')").run().lastInsertRowid), 4);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

  // Una reconstrucción que deja referencias rotas se rechaza entera y las claves foráneas vuelven a quedar activas.
  const breaking = defineRegistry([
    registry[0],
    {
      name: 'r/0002-rompe',
      rebuild: true,
      up(d) {
        d.exec('DELETE FROM parent WHERE id=2');
      },
    },
  ]);
  assert.throws(() => applyNamed(db, breaking), /referencias rotas \(child\)/);
  assert.equal(db.prepare('SELECT count(*) n FROM parent WHERE id=2').get().n, 1, 'la fila borrada vuelve');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(appliedNames(db), ['r/0001-reconstruir']);
});

test('migrate(): un respaldo previo sólo si hay algo pendiente y la base tiene usuarios, tomado antes de migrar', async t => {
  const { dir, later } = await workspace(t, 'crm-migrate-');
  const db = openDatabase(dir);
  later(() => db.close());
  runLadder(db);
  assert.equal(version(db), LADDER_VERSION);
  const registry = defineRegistry([
    { name: 'prueba/0001-tabla', up: d => d.exec('CREATE TABLE prueba_tabla(id INTEGER PRIMARY KEY)') },
    { name: 'prueba/0002-indice', up: d => d.exec('CREATE INDEX prueba_tabla_id ON prueba_tabla(id)') },
  ]);
  const backups = async () => (existsSync(join(dir, 'backups')) ? (await readdir(join(dir, 'backups'))).sort() : []);

  // sin usuarios no hay nada que proteger
  const empty = migrate(db, { dataDir: dir, registry: defineRegistry([registry[0]]), now: () => 111 });
  assert.equal(empty.backupFile, null);
  assert.deepEqual(empty.applied, ['prueba/0001-tabla']);
  assert.deepEqual(await backups(), []);

  addUser(db);
  let clock = 5000;
  const first = migrate(db, { dataDir: dir, registry, now: () => clock++ });
  assert.deepEqual(first.applied, ['prueba/0002-indice']);
  assert.deepEqual(first.unknown, []);
  assert.equal(first.ladder, LADDER_VERSION);
  assert.equal(first.id, expectedSchemaId(registry));
  assert.equal(basename(first.backupFile), 'before-prueba-0002-indice-5000.sqlite');
  assert.deepEqual(await backups(), ['before-prueba-0002-indice-5000.sqlite']);
  const copy = new DatabaseSync(first.backupFile, { readOnly: true });
  try {
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(copy.prepare("SELECT name FROM users WHERE id='old-user'").get().name, 'Anterior');
    assert.deepEqual(appliedNames(copy), ['prueba/0001-tabla'], 'la copia es de ANTES de migrar');
    assert.equal(exists(copy, 'prueba_tabla_id'), false);
  } finally {
    copy.close();
  }

  // nada pendiente: ni respaldo ni cambios
  const second = migrate(db, { dataDir: dir, registry, now: () => clock++ });
  assert.deepEqual({ applied: second.applied, backupFile: second.backupFile }, { applied: [], backupFile: null });
  assert.deepEqual(await backups(), ['before-prueba-0002-indice-5000.sqlite']);

  // se puede pedir que no respalde (pruebas y herramientas), y sin directorio de datos no se respalda a ciegas
  const more = defineRegistry([...registry, { name: 'prueba/0003-otra', up: d => d.exec('CREATE TABLE otra(id)') }]);
  assert.throws(() => migrate(db, { registry: more }), /dataDir/);
  assert.equal(exists(db, 'otra'), false);
  assert.equal(migrate(db, { registry: more, backup: false }).backupFile, null);
  assert.equal(exists(db, 'otra'), true);
  assert.equal((await backups()).length, 1);

  // una base de una versión posterior a la que el código conoce no se toca
  db.exec('PRAGMA user_version=' + (LADDER_VERSION + 1));
  assert.throws(() => migrate(db, { dataDir: dir, registry: more }), /posterior a la que este código conoce/);
  db.exec('PRAGMA user_version=' + LADDER_VERSION);
});

test('la escalera publicada: 39 peldaños del 3 al 41, cada uno deja la versión que declara y repetirla no cambia nada', async t => {
  const { dir, later } = await workspace(t, 'crm-ladder-');
  const db = openDatabase(dir);
  later(() => db.close());
  assert.equal(version(db), 2, 'openDatabase crea las versiones 1 y 2');
  assert.deepEqual(
    LADDER.map(([number]) => number),
    Array.from({ length: 39 }, (_, i) => i + 3),
  );
  assert.equal(LADDER_VERSION, 41);
  assert.equal(new Set(LADDER.map(([, run]) => run)).size, 39, 'ninguna función aparece dos veces');
  for (const [number, run] of LADDER) {
    run(db);
    assert.equal(version(db), number, run.name);
  }
  const shape = schemaShape(db);
  runLadder(db);
  assert.equal(version(db), LADDER_VERSION);
  assert.deepEqual(schemaShape(db), shape);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('la escalera está cerrada: en el servidor nadie fija user_version fuera de las 41 versiones publicadas', async () => {
  const found = [];
  for (const file of await readdir('server', { recursive: true })) {
    if (!file.endsWith('.mjs')) continue;
    const source = await readFile(join('server', file), 'utf8');
    for (const [, number] of source.matchAll(/user_version\s*=\s*(\d+)/g)) found.push(Number(number));
    // «user_version=» seguido de algo que no es un número (y que no es una comparación) sería un valor calculado
    assert.equal(
      /user_version\s*=(?!=)(?!\s*\d)/.test(source),
      false,
      file + ' fija user_version con un valor calculado',
    );
  }
  assert.deepEqual(
    found.sort((a, b) => a - b),
    Array.from({ length: 41 }, (_, i) => i + 1),
    'lo nuevo va en server/migrations/named/, no en la escalera',
  );
});

test('estructura de server/migrations/named: nombre igual a la ruta, sin huérfanos, sin user_version y sin objetos repetidos', async () => {
  const root = 'server/migrations/named';
  const all = existsSync(root)
    ? (await readdir(root, { recursive: true })).map(file => file.replaceAll('\\', '/'))
    : [];
  const files = all.filter(file => /^[a-z][a-z0-9-]*\/\d{4}-[a-z0-9-]+\.mjs$/.test(file));
  const stray = all.filter(
    file => file.endsWith('.mjs') && !files.includes(file) && !/^[a-z][a-z0-9-]*\/index\.mjs$/.test(file),
  );
  assert.deepEqual(stray, [], 'archivos con un nombre que el registro no admite');
  const registered = new Set(NAMED.map(m => m.name));
  const created = new Map();
  for (const file of files) {
    const name = file.replace(/\.mjs$/, '');
    const module = await import(pathToFileURL(resolve(root, file)).href);
    assert.equal(module.default?.name, name, file + ' debe exportar un nombre igual a su ruta');
    assert.ok(registered.has(name), file + ' no está en el registro (server/migrations/registry.mjs)');
    assert.ok(existsSync(join(root, name.split('/')[0], 'index.mjs')), 'falta el índice del área de ' + file);
    const source = await readFile(join(root, file), 'utf8');
    assert.equal(/user_version/i.test(source), false, file + ' no debe tocar user_version');
    assert.equal(
      /\bBEGIN\s+(?:IMMEDIATE|EXCLUSIVE|DEFERRED|TRANSACTION)\b|\b(?:BEGIN|COMMIT)\s*[;'"`]|\bSAVEPOINT\b/i.test(
        source,
      ),
      false,
      file + ' no abre ni cierra transacciones: las pone el ejecutor',
    );
    assert.equal(
      /CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|TRIGGER)\s+IF\s+NOT\s+EXISTS/i.test(source),
      false,
      file + ': tablas y disparadores se crean sin IF NOT EXISTS (el ejecutor ya garantiza una sola pasada)',
    );
    for (const [, object] of source.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi,
    )) {
      const key = object.toLowerCase();
      assert.equal(created.has(key), false, `${object} lo crean ${created.get(key)} y ${name}`);
      created.set(key, name);
    }
  }
  assert.deepEqual(
    [...registered].sort(),
    files.map(file => file.replace(/\.mjs$/, '')).sort(),
    'registro y archivos coinciden',
  );
});

// ---------------------------------------------------------------------------------------------------------------
// B. Actualización de una base ya publicada, con el servidor real
// ---------------------------------------------------------------------------------------------------------------

test('una base en la escalera 41 recibe las migraciones con nombre una sola vez, con un único respaldo previo, y queda igual que una instalación nueva', async t => {
  const { dir, later } = await workspace(t, 'crm-named-');
  let db = openDatabase(dir);
  runLadder(db); // exactamente como queda hoy una base publicada
  assert.equal(version(db), LADDER_VERSION);
  assert.equal(exists(db, 'schema_migrations'), false);
  addUser(db);
  db.close();

  const backups = async () => (existsSync(join(dir, 'backups')) ? await readdir(join(dir, 'backups')) : []);
  let server = await startServer({ dir });
  later(() => server.stop());
  db = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  later(() => db.close());
  assertSchemaCurrent(db);
  assert.equal(db.prepare("SELECT name FROM users WHERE id='old-user'").get().name, 'Anterior');
  const taken = await backups();
  assert.equal(taken.length, NAMED.length ? 1 : 0, 'un solo respaldo, y sólo si había algo pendiente');
  if (NAMED.length) {
    assert.match(taken[0], /^before-[a-z0-9-]+-\d+\.sqlite$/);
    const copy = new DatabaseSync(join(dir, 'backups', taken[0]), { readOnly: true });
    try {
      assert.equal(version(copy), LADDER_VERSION);
      assert.equal(exists(copy, 'schema_migrations'), false, 'tomado ANTES de migrar');
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      copy.close();
    }
  }
  const annotations = () =>
    db
      .prepare('SELECT name,applied_at FROM schema_migrations ORDER BY name')
      .all()
      .map(row => ({ ...row }));
  const first = annotations();
  const health = await (await fetch(server.origin + '/api/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.schema, expectedSchemaId());
  assert.equal(health.schema, schemaId(db));
  assert.equal(health.version, JSON.parse(await readFile('package.json', 'utf8')).version);
  const shape = schemaShape(db);

  // segundo arranque: nada pendiente
  await server.stop();
  server = await startServer({ dir });
  assert.deepEqual(annotations(), first);
  assert.equal((await backups()).length, taken.length);
  assert.deepEqual(schemaShape(db), shape, 'arrancar otra vez no cambia el esquema');
  assert.equal((await (await fetch(server.origin + '/api/health')).json()).schema, expectedSchemaId());
  await server.stop();

  // mismo esquema que una instalación nueva
  const { dir: freshDir } = await workspace(t, 'crm-fresh-');
  const fresh = openDatabase(freshDir);
  try {
    const result = migrate(fresh, { dataDir: freshDir });
    assert.equal(result.backupFile, null, 'una base sin usuarios no se respalda');
    assert.equal(result.id, expectedSchemaId());
    assertSchemaCurrent(fresh);
    assert.deepEqual(schemaShape(fresh), shape);
  } finally {
    fresh.close();
  }
});
