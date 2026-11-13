import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, copyFile, readdir, truncate } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/database.mjs';
import { migrateCRM } from '../server/crm.mjs';
import { migrateFollowup } from '../server/followup.mjs';
import { migrateCatalogue } from '../server/catalogue-schema.mjs';
import { migrateOperations } from '../server/operations-schema.mjs';
import { migrateAutomation, migrateRecipes } from '../server/automation-schema.mjs';
import { createBackups, verifyBackup } from '../server/backup.mjs';

const HOUR = 3_600_000,
  quiet = { error() {} };
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-backup-')),
    db = openDatabase(dir);
  for (const m of [migrateCRM, migrateFollowup, migrateCatalogue, migrateOperations, migrateAutomation, migrateRecipes])
    m(db);
  t.after(async () => {
    try {
      db.close();
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  const t0 = Date.now();
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u1','cliente','Cliente','x','customer',1,?,?)",
  ).run(t0, t0);
  await mkdir(join(dir, 'uploads'), { recursive: true });
  await mkdir(join(dir, 'library'), { recursive: true });
  await writeFile(join(dir, 'uploads', 'a.png'), Buffer.alloc(100, 1));
  await writeFile(join(dir, 'library', 'b.pdf'), Buffer.alloc(50, 2));
  const c = { t: Date.UTC(2026, 9, 31, 12, 0, 0), now: () => c.t };
  const backups = createBackups({
    db,
    dataDir: dir,
    version: 'test',
    intervalMs: 24 * HOUR,
    keep: 3,
    now: c.now,
    log: quiet,
  });
  return { dir, db, c, backups };
}

test('respaldo: copia consistente con manifiesto, verificable y con retención', async t => {
  const { dir, backups, c } = await setup(t);
  const b = backups.run();
  assert.match(b.name, /^auto-20261031T120000Z$/);
  assert.equal(b.schema, 8);
  assert.equal(b.counts.users, 1);
  const report = verifyBackup(join(backups.root, b.name), dir);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(backups.run().name, b.name); // mismo instante: no duplica
  for (let i = 1; i <= 4; i++) {
    c.t += HOUR * 25;
    backups.run();
  }
  assert.equal(backups.list().length, 3);
  assert.ok(backups.list().every(x => x.createdAt));
  assert.ok(!(await readdir(backups.root)).some(n => n.endsWith('.partial')));
});

test('programación: sólo respalda cuando venció el intervalo y se puede desactivar', async t => {
  const { db, dir, backups, c } = await setup(t);
  assert.equal(backups.due(), true);
  assert.ok(backups.tick());
  assert.equal(backups.due(), false);
  assert.equal(backups.tick(), null);
  c.t += 23 * HOUR;
  assert.equal(backups.tick(), null);
  c.t += 2 * HOUR;
  assert.ok(backups.tick());
  const off = createBackups({ db, dataDir: dir, version: 't', intervalMs: 0, now: c.now, log: quiet });
  assert.equal(off.tick(), null);
});

test('verificación detecta adjuntos perdidos o alterados, base dañada y conteos distintos', async t => {
  const { dir, backups, db } = await setup(t);
  const b = backups.run(),
    path = join(backups.root, b.name);
  await rm(join(dir, 'uploads', 'a.png'));
  let r = verifyBackup(path, dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /Falta uploads\/a.png/);
  await writeFile(join(dir, 'uploads', 'a.png'), Buffer.alloc(7));
  await writeFile(join(dir, 'library', 'b.pdf'), Buffer.alloc(51));
  r = verifyBackup(path, dir);
  assert.match(r.problems.join(), /Tamaño distinto en uploads\/a.png/);
  assert.match(r.problems.join(), /library\/b.pdf/);
  assert.equal(verifyBackup(path, null).ok, true); // sin directorio de datos sólo se valida la base
  await rm(join(path, 'manifest.json'));
  assert.match(verifyBackup(path).problems.join(), /manifest/);
  assert.equal(verifyBackup(join(dir, 'inexistente')).ok, false);
  void db;
});

test('ensayo de restauración: la copia abre en un directorio nuevo con sus datos y migraciones al día', async t => {
  const { dir, backups, db } = await setup(t);
  db.prepare("INSERT INTO brands(id,name,description,created_at) VALUES('nueva','Nueva','x',?)").run(Date.now());
  const b = backups.run(),
    target = await mkdtemp(join(tmpdir(), 'crm-restore-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await copyFile(join(backups.root, b.name, 'laboratorio.sqlite'), join(target, 'laboratorio.sqlite'));
  for (const f of ['uploads', 'library']) await mkdir(join(target, f), { recursive: true });
  await copyFile(join(dir, 'uploads', 'a.png'), join(target, 'uploads', 'a.png'));
  await copyFile(join(dir, 'library', 'b.pdf'), join(target, 'library', 'b.pdf'));
  const restored = openDatabase(target);
  try {
    for (const m of [
      migrateCRM,
      migrateFollowup,
      migrateCatalogue,
      migrateOperations,
      migrateAutomation,
      migrateRecipes,
    ])
      m(restored);
    assert.equal(restored.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(restored.prepare("SELECT name FROM brands WHERE id='nueva'").get().name, 'Nueva');
    assert.equal(restored.prepare('SELECT count(*) n FROM users').get().n, 1);
  } finally {
    restored.close();
  }
  assert.equal(verifyBackup(join(backups.root, b.name), target).ok, true);
  const cli = spawnSync(process.execPath, ['server/verify-backup.mjs', join(backups.root, b.name), target], {
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  await truncate(join(backups.root, b.name, 'laboratorio.sqlite'), 2048);
  assert.equal(
    spawnSync(process.execPath, ['server/verify-backup.mjs', join(backups.root, b.name)], { encoding: 'utf8' }).status,
    1,
  );
});

test('rutas /api/backups: sólo administración; el respaldo manual aparece en la lista', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-backup-http-')),
    code = randomUUID(),
    password = 'Password-backup-2026!';
  let logs = '';
  const server = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dir,
      ADMIN_INVITE_CODE: code,
      APP_ORIGIN: '',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(logs)), 10000);
    server.stderr.on('data', b => (logs += b));
    server.stdout.on('data', b => {
      const m = String(b).match(/http:\/\/127.0.0.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(Error(logs));
    });
  });
  t.after(async () => {
    if (server.exitCode === null)
      await new Promise(r => {
        server.once('exit', r);
        server.kill();
      });
    await rm(dir, { recursive: true, force: true });
  });
  async function call(path, cookie = '', body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const r = await fetch(origin + path, {
      method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(result));
    return { ...result, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const admin = await call('/api/auth/register', '', {
      username: 'admin',
      name: 'Administración',
      password,
      inviteCode: code,
    }),
    client = await call('/api/auth/register', '', { username: 'cliente', name: 'Cliente', password });
  await call('/api/backups', '', undefined, 'GET', 401);
  await call('/api/backups', client.cookie, undefined, 'GET', 403);
  await call('/api/backups/run', client.cookie, {}, 'POST', 403);
  assert.deepEqual((await call('/api/backups', admin.cookie)).backups, []); // en pruebas no hay respaldos automáticos
  const made = (await call('/api/backups/run', admin.cookie, {}, 'POST', 201)).backup;
  assert.match(made.name, /^auto-/);
  assert.equal(made.counts.users, 2);
  assert.equal((await call('/api/backups', admin.cookie)).backups[0].name, made.name);
  assert.ok(existsSync(join(dir, 'backups', made.name, 'laboratorio.sqlite')));
});
