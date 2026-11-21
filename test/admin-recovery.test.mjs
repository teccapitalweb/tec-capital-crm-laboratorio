import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers/server.mjs';
import { call, openDb, PASSWORD, registerAdmin } from './helpers/crm.mjs';
import { openDatabase, transaction } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { armAdminRecovery, RECOVERY_VALID_MS } from '../server/modules/admin-recovery/module.mjs';

// Recuperar la cuenta de administración (server/modules/admin-recovery): quien controla el entorno del servidor pone
// ADMIN_RECOVERY_CODE y el CRM arma, al arrancar, un código de un solo uso y 30 minutos para la única cuenta de
// administración, que se usa en la pantalla y la ruta de recuperación de siempre.
const INVITE = 'invitacion-de-prueba-para-el-primer-administrador';
const CODE = 'codigo-de-recuperacion-de-prueba-2026';
const NEW_PASSWORD = 'Otra-contrasena-duradera-2027!';

const workspace = async (t, prefix) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const parts = { dir, servers: [] };
  t.after(async () => {
    try {
      parts.db?.close();
    } catch {}
    for (const server of parts.servers) await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  parts.start = async (env = {}) => {
    const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: INVITE, ...env } });
    parts.servers.push(server);
    return server;
  };
  return parts;
};
const login = (origin, password, expected = 200) =>
  call(origin, '/api/auth/login', { body: { username: 'admin', password }, expected });
const recover = (origin, body, expected = 200) => call(origin, '/api/auth/recover', { body, expected });
const tokens = dir => {
  const db = openDb(dir);
  try {
    return db.prepare('SELECT user_id,created_by,expires_at,used_at FROM recovery_tokens ORDER BY rowid').all();
  } finally {
    db.close();
  }
};

test('con ADMIN_RECOVERY_CODE la administración pone una contraseña nueva, una sola vez', async t => {
  const ws = await workspace(t, 'crm-recuperar-');
  // Instalación normal: se crea la administración y una asesora NO puede recuperarla desde el CRM.
  let server = await ws.start();
  const cookie = await registerAdmin(server.origin, INVITE);
  await call(server.origin, '/api/team/recovery', { cookie, body: { username: 'admin' }, expected: 400 });
  assert.deepEqual(tokens(ws.dir), [], 'sin la variable no se arma nada');
  await recover(server.origin, { username: 'admin', token: CODE, password: NEW_PASSWORD }, 400);
  await server.stop();

  // Se pone la variable y se reinicia: el código queda armado para la única cuenta de administración.
  const before = Date.now();
  server = await ws.start({ ADMIN_RECOVERY_CODE: CODE });
  const [armed] = tokens(ws.dir);
  assert.equal(tokens(ws.dir).length, 1);
  assert.equal(armed.used_at, null);
  assert.equal(armed.user_id, armed.created_by);
  assert.ok(
    armed.expires_at >= before + RECOVERY_VALID_MS - 1000 && armed.expires_at <= Date.now() + RECOVERY_VALID_MS,
  );
  // La sesión abierta sigue valiendo hasta que se usa el código.
  await call(server.origin, '/api/bootstrap', { cookie });
  // Con otro usuario, otro código o una contraseña corta, no.
  await recover(server.origin, { username: 'otra', token: CODE, password: NEW_PASSWORD }, 400);
  await recover(server.origin, { username: 'admin', token: CODE + 'x', password: NEW_PASSWORD }, 400);
  await recover(server.origin, { username: 'admin', token: CODE, password: 'corta' }, 400);
  await login(server.origin, PASSWORD);

  await recover(server.origin, { username: 'admin', token: CODE, password: NEW_PASSWORD });
  await login(server.origin, PASSWORD, 401);
  const again = await login(server.origin, NEW_PASSWORD);
  assert.ok(again.cookie, 'entra con la contraseña nueva');
  await call(server.origin, '/api/bootstrap', { cookie, expected: 401 }); // las sesiones anteriores se cerraron
  // El mismo código no sirve dos veces…
  await recover(server.origin, { username: 'admin', token: CODE, password: PASSWORD }, 400);
  await server.stop();

  // …ni se vuelve a armar si la variable se queda puesta y el servidor reinicia.
  server = await ws.start({ ADMIN_RECOVERY_CODE: CODE });
  assert.equal(tokens(ws.dir).length, 1);
  assert.ok(tokens(ws.dir)[0].used_at);
  await recover(server.origin, { username: 'admin', token: CODE, password: PASSWORD }, 400);
  await login(server.origin, NEW_PASSWORD);
  const db = (ws.db = openDb(ws.dir));
  const actions = db
    .prepare("SELECT user_id,action FROM audit WHERE action LIKE 'recovery.%' ORDER BY id")
    .all()
    .map(a => (a.user_id ? 'persona:' : 'sistema:') + a.action);
  assert.deepEqual(actions, ['sistema:recovery.armed', 'sistema:recovery.completed']);
});

test('un código vencido no se alarga con otro reinicio, y uno demasiado corto no arma nada', async t => {
  const ws = await workspace(t, 'crm-recuperar-vence-');
  let server = await ws.start();
  await registerAdmin(server.origin, INVITE);
  await server.stop();

  server = await ws.start({ ADMIN_RECOVERY_CODE: 'corto-123' });
  assert.deepEqual(tokens(ws.dir), []);
  await recover(server.origin, { username: 'admin', token: 'corto-123', password: NEW_PASSWORD }, 400);
  await server.stop();

  server = await ws.start({ ADMIN_RECOVERY_CODE: CODE });
  assert.equal(tokens(ws.dir).length, 1);
  await server.stop();
  let db = openDb(ws.dir);
  db.prepare('UPDATE recovery_tokens SET expires_at=?').run(Date.now() - 1);
  db.close();
  server = await ws.start({ ADMIN_RECOVERY_CODE: CODE });
  assert.equal(tokens(ws.dir).length, 1, 'no se arma otra vez');
  assert.ok(tokens(ws.dir)[0].expires_at < Date.now());
  await recover(server.origin, { username: 'admin', token: CODE, password: NEW_PASSWORD }, 400);
  await login(server.origin, PASSWORD);
  await server.stop();

  // Un código NUEVO sí arma, y retira el anterior que quedara sin usar.
  db = openDb(ws.dir);
  db.prepare('UPDATE recovery_tokens SET expires_at=?').run(Date.now() + 60_000);
  db.close();
  const OTHER = CODE + '-segundo';
  server = await ws.start({ ADMIN_RECOVERY_CODE: OTHER });
  const rows = tokens(ws.dir);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].used_at, 'el anterior queda retirado');
  await recover(server.origin, { username: 'admin', token: CODE, password: NEW_PASSWORD }, 400);
  await recover(server.origin, { username: 'admin', token: OTHER, password: NEW_PASSWORD });
  await login(server.origin, NEW_PASSWORD);
});

test('sin una única cuenta de administración activa no se arma nada, y el mensaje nunca lleva el código', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-recuperar-unidad-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  migrate(db, { log: () => {} });
  const audited = [];
  const host = { db, transaction, audit: (user, action, id) => audited.push([user, action, id]), now: () => 1000 };
  const user = (id, role, disabled = 0) =>
    db
      .prepare(
        'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen,disabled) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(id, id, id, 'x:y', role, 100000 + db.prepare('SELECT count(*) n FROM users').get().n + 1, 1, 1, disabled);
  const count = () => db.prepare('SELECT count(*) n FROM recovery_tokens').get().n;

  assert.equal(armAdminRecovery(host, undefined), null);
  assert.equal(armAdminRecovery(host, '   '), null);
  assert.equal(armAdminRecovery(host, CODE).state, 'no_admin', 'instalación vacía');
  user('asesora', 'agent');
  assert.equal(armAdminRecovery(host, CODE).state, 'no_admin', 'sólo hay una asesora');
  user('jefa', 'admin', 1);
  assert.equal(armAdminRecovery(host, CODE).state, 'no_admin', 'la administración está dada de baja');
  assert.equal(count(), 0);
  db.prepare("UPDATE users SET disabled=0 WHERE id='jefa'").run();
  // dos cuentas de administración activas: no se elige una por adivinación
  user('otra-jefa', 'admin');
  assert.equal(armAdminRecovery(host, CODE).state, 'no_admin', 'hay dos administraciones');
  assert.equal(count(), 0);
  db.prepare("DELETE FROM users WHERE id='otra-jefa'").run();
  for (const bad of [
    'corto',
    'a'.repeat(30),
    'abc123abc123abc123abc123abc123', // largo pero repetitivo: sólo 6 caracteres distintos
    'solo-letras-sin-ningun-numero-aqui',
    '123456789012345678901234567890',
    'con espacios en medio del codigo largo',
    'ñandú-con-acentos-y-símbolos-raros!!',
    'a'.repeat(201),
  ])
    assert.equal(armAdminRecovery(host, bad).state, 'invalid', bad.slice(0, 20));
  assert.equal(count(), 0);

  const armed = armAdminRecovery(host, '  ' + CODE + '\n');
  assert.equal(armed.state, 'armed');
  assert.match(armed.message, /@jefa/);
  const row = db.prepare('SELECT * FROM recovery_tokens').get();
  assert.equal(row.user_id, 'jefa');
  assert.equal(row.expires_at, 1000 + RECOVERY_VALID_MS);
  assert.notEqual(row.token_hash, CODE);
  assert.deepEqual(audited, [[null, 'recovery.armed', 'jefa']]);
  const spent = armAdminRecovery(host, CODE);
  assert.equal(spent.state, 'spent');
  assert.equal(count(), 1);
  for (const result of [armed, spent, armAdminRecovery(host, 'corto')])
    assert.ok(!result.message.includes(CODE) && !result.message.includes('corto'), 'el mensaje no repite el código');
});
