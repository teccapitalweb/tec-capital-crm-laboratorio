import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { base32, unbase32, totp, stepAt, matchStep } from '../server/mfa.mjs';

test('TOTP: vectores oficiales del RFC 6238 (SHA-1) y base32', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(unbase32(secret).toString(), '12345678901234567890');
  for (const [seconds, code] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])
    assert.equal(totp(secret, stepAt(seconds * 1000), 8), code, String(seconds));
  assert.equal(totp(secret, stepAt(59000)), '287082');
  assert.throws(() => unbase32('!!!'), /Base32/);
});

test('TOTP: ventana de ±1 paso y rechazo de pasos ya usados', () => {
  const secret = base32(Buffer.from('abcdefghijklmnopqrst')),
    now = 1_700_000_000_000,
    s = stepAt(now);
  assert.equal(matchStep(secret, totp(secret, s), now, 0), s);
  assert.equal(matchStep(secret, totp(secret, s - 1), now, 0), s - 1);
  assert.equal(matchStep(secret, totp(secret, s + 1), now, 0), s + 1);
  assert.equal(matchStep(secret, totp(secret, s - 2), now, 0), null);
  assert.equal(matchStep(secret, totp(secret, s + 2), now, 0), null);
  assert.equal(matchStep(secret, totp(secret, s), now, s), null);
  assert.equal(matchStep(secret, totp(secret, s - 1), now, s), null);
  assert.equal(matchStep(secret, totp(secret, s + 1), now, s), s + 1);
});

async function boot(dir, env = {}) {
  let logs = '';
  const server = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir, APP_ORIGIN: '', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(logs)), 10000);
    server.stderr.on('data', b => (logs += b));
    server.stdout.on('data', b => {
      logs += b;
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
  return { server, origin, logs: () => logs };
}
const stop = async s => {
  if (s.exitCode === null)
    await new Promise(r => {
      s.once('exit', r);
      s.kill();
    });
};

test('verificación en dos pasos: activación, acceso con desafío, recuperación, desactivación y reinicios', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-mfa-')),
    adminCode = randomUUID(),
    password = 'Password-mfa-2026!';
  let app = await boot(dir, { ADMIN_INVITE_CODE: adminCode });
  t.after(async () => {
    await stop(app.server);
    await rm(dir, { recursive: true, force: true });
  });
  async function raw(path, cookie = '', body, method = body === undefined ? 'GET' : 'POST') {
    return fetch(app.origin + path, {
      method,
      headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function call(path, cookie = '', body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const r = await raw(path, cookie, body, method);
    const result = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(result));
    return { ...result, cookie: r.headers.get('set-cookie')?.split(';')[0], headers: r.headers };
  }
  const reg = (username, inviteCode) =>
    call('/api/auth/register', '', { username, name: 'Prueba ' + username, password, inviteCode });
  const admin = await reg('admin', adminCode),
    agent = await reg('asesor'),
    client = await reg('cliente');
  const inv = await call(
    '/api/team/invites',
    admin.cookie,
    { username: 'asesor', brandIds: ['globalvet'] },
    'POST',
    201,
  );
  await call('/api/team/accept', agent.cookie, { token: inv.token });
  const agentId = (await call('/api/bootstrap', agent.cookie)).user.id,
    code = (secret, offset = 0) => totp(secret, stepAt(Date.now()) + offset);

  // sólo el equipo; el cliente no puede configurarla
  assert.equal((await call('/api/mfa', client.cookie)).available, false);
  await call('/api/mfa/setup', client.cookie, {}, 'POST', 403);
  await call('/api/mfa', '', undefined, 'GET', 401);
  assert.deepEqual(await call('/api/mfa', agent.cookie).then(r => ({ a: r.available, e: r.enabled })), {
    a: true,
    e: false,
  });

  // activación: código incorrecto no activa; el correcto sí y devuelve 10 códigos de recuperación; cierra las otras sesiones
  const other = await call('/api/auth/login', '', { username: 'asesor', password });
  assert.ok(other.cookie);
  const setup = await call('/api/mfa/setup', agent.cookie, {}, 'POST');
  assert.match(setup.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.uri, /^otpauth:\/\/totp\/TEC%20Capital%3Aasesor\?secret=[A-Z2-7]{32}&issuer=TEC%20Capital/);
  await call('/api/mfa/enable', agent.cookie, { code: '000000' }, 'POST', 400);
  assert.equal((await call('/api/mfa', agent.cookie)).enabled, false);
  const enabled = await call('/api/mfa/enable', agent.cookie, { code: code(setup.secret) }, 'POST');
  assert.equal(enabled.recoveryCodes.length, 10);
  assert.ok(enabled.recoveryCodes.every(c => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c)));
  assert.deepEqual(await call('/api/mfa', agent.cookie).then(r => [r.enabled, r.recoveryRemaining]), [true, 10]);
  await call('/api/bootstrap', other.cookie, undefined, 'GET', 401); // la otra sesión se cerró
  await call('/api/mfa/setup', agent.cookie, {}, 'POST', 409);

  // el secreto no queda en claro en la base; la clave vive aparte
  const db = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT secret,recovery FROM user_mfa WHERE user_id=?').get(agentId);
    assert.ok(!row.secret.includes(setup.secret));
    assert.ok(!row.recovery.includes(enabled.recoveryCodes[0].replace('-', '')));
  } finally {
    db.close();
  }
  assert.match((await readFile(join(dir, 'mfa.key'), 'utf8')).trim(), /^[a-f0-9]{64}$/);

  // acceso: la contraseña sola ya no abre sesión
  const step1 = await call('/api/auth/login', '', { username: 'asesor', password });
  assert.equal(step1.mfaRequired, true);
  assert.ok(step1.challenge);
  assert.equal(step1.user, undefined);
  assert.equal(step1.headers.get('set-cookie'), null);
  await call('/api/bootstrap', '', undefined, 'GET', 401);
  await call('/api/auth/mfa', '', { challenge: step1.challenge, code: '123456' }, 'POST', 401);
  // El código se calcula una sola vez: si el paso de 30 s cambiara entre dos llamadas, «el mismo código» sería otro.
  const stepCode = code(setup.secret, 1);
  await call('/api/auth/mfa', '', { challenge: 'x'.repeat(64), code: stepCode }, 'POST', 401);
  await call('/api/auth/mfa', '', {}, 'POST', 401);
  const done = await call('/api/auth/mfa', '', { challenge: step1.challenge, code: stepCode });
  assert.ok(done.cookie);
  assert.equal(done.user.username, 'asesor');
  assert.equal(done.usedRecovery, false);
  await call('/api/bootstrap', done.cookie);
  await call('/api/auth/mfa', '', { challenge: step1.challenge, code: stepCode }, 'POST', 401); // el desafío se consume
  // el mismo código (mismo paso) no se puede reutilizar
  const again = await call('/api/auth/login', '', { username: 'asesor', password });
  await call('/api/auth/mfa', '', { challenge: again.challenge, code: stepCode }, 'POST', 401);

  // código de recuperación: un solo uso
  const rec = enabled.recoveryCodes[0],
    viaRecovery = await call('/api/auth/login', '', { username: 'asesor', password });
  const recovered = await call('/api/auth/mfa', '', { challenge: viaRecovery.challenge, code: rec.toUpperCase() });
  assert.equal(recovered.usedRecovery, true);
  assert.equal(recovered.recoveryLeft, 9);
  const reuse = await call('/api/auth/login', '', { username: 'asesor', password });
  await call('/api/auth/mfa', '', { challenge: reuse.challenge, code: rec }, 'POST', 401);

  // regenerar y desactivar exigen contraseña y código
  await call(
    '/api/mfa/recovery-codes',
    recovered.cookie,
    { password: 'incorrecta-123', code: code(setup.secret, 1) },
    'POST',
    401,
  );
  await call('/api/mfa/disable', recovered.cookie, { password, code: '111111' }, 'POST', 401);
  const fresh = await call(
    '/api/mfa/recovery-codes',
    recovered.cookie,
    { password, code: enabled.recoveryCodes[1] },
    'POST',
  );
  assert.equal(fresh.recoveryCodes.length, 10);
  const oldCodes = await call('/api/auth/login', '', { username: 'asesor', password });
  await call('/api/auth/mfa', '', { challenge: oldCodes.challenge, code: enabled.recoveryCodes[2] }, 'POST', 401); // los anteriores dejan de valer

  // administración: reinicio de otra persona (no el propio) y lista de quién la tiene
  assert.equal((await call('/api/mfa/members', admin.cookie)).members[agentId], true);
  await call('/api/mfa/members', agent.cookie, undefined, 'GET', 403);
  await call('/api/mfa/reset/' + agentId, agent.cookie, {}, 'POST', 403);
  const adminId = (await call('/api/bootstrap', admin.cookie)).user.id;
  await call('/api/mfa/reset/' + adminId, admin.cookie, {}, 'POST', 400);
  await call('/api/mfa/reset/' + agentId, admin.cookie, {}, 'POST');
  await call('/api/mfa/reset/' + agentId, admin.cookie, {}, 'POST', 404);
  await call('/api/bootstrap', recovered.cookie, undefined, 'GET', 401); // sus sesiones se cerraron
  assert.equal((await call('/api/auth/login', '', { username: 'asesor', password })).mfaRequired, undefined);

  // desactivación propia con contraseña + código
  const s2 = await call('/api/mfa/setup', admin.cookie, {}, 'POST');
  await call('/api/mfa/enable', admin.cookie, { code: code(s2.secret) }, 'POST');
  await call('/api/mfa/disable', admin.cookie, { password, code: code(s2.secret, 1) }, 'POST');
  assert.equal((await call('/api/mfa', admin.cookie)).enabled, false);

  // intentos limitados por desafío (5) y reinicio de emergencia con MFA_RESET_USER
  const s3 = await call('/api/mfa/setup', admin.cookie, {}, 'POST'),
    e3 = await call('/api/mfa/enable', admin.cookie, { code: code(s3.secret) }, 'POST');
  assert.equal(e3.recoveryCodes.length, 10);
  const ch = await call('/api/auth/login', '', { username: 'admin', password });
  for (let i = 0; i < 5; i++) await call('/api/auth/mfa', '', { challenge: ch.challenge, code: '000001' }, 'POST', 401);
  const burned = await raw('/api/auth/mfa', '', { challenge: ch.challenge, code: code(s3.secret, 1) });
  assert.equal(burned.status, 401);
  assert.match((await burned.json()).error, /venció|Demasiados|Vuelve/);
  await stop(app.server);
  app = await boot(dir, { ADMIN_INVITE_CODE: adminCode, MFA_RESET_USER: 'Admin' });
  assert.match(app.logs(), /MFA restablecido para @admin/);
  assert.equal((await call('/api/auth/login', '', { username: 'admin', password })).mfaRequired, undefined);
});
