// Ayudas de las pruebas de punta a punta que arrancan el servidor real (startServer de ./server.mjs): llamadas con
// sesión, espera de un efecto, muerte brusca del proceso y la preparación mínima de WhatsApp real con el Meta de mentira.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { NUMBER } from './fake-meta.mjs';

export const PASSWORD = 'Password-duradero-2026!';
export const sleep = ms => new Promise(done => setTimeout(done, ms));

// Espera a que `check` devuelva algo; si no ocurre a tiempo, la prueba falla diciendo qué se esperaba.
export async function until(check, what, { ms = 8000, logs = () => '' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail('no ocurrió: ' + what + '\n' + logs());
    await sleep(60);
  }
}

// Petición JSON con sesión y Origin; comprueba el código esperado y devuelve el cuerpo (más la cookie, si la hay).
export async function call(origin, path, { cookie = '', body, method, expected = 200 } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, expected, path + ': ' + JSON.stringify(result));
  return { ...result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

export const openDb = dir => new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });

// Muerte brusca del proceso, igual en cualquier sistema: sin apagado ordenado, como una caída o un corte.
export const crash = server =>
  server.child.exitCode !== null || server.child.signalCode !== null
    ? Promise.resolve()
    : new Promise(done => {
        server.child.once('exit', done);
        server.child.kill('SIGKILL');
      });

export async function registerAdmin(origin, inviteCode) {
  const admin = await call(origin, '/api/auth/register', {
    body: { username: 'admin', name: 'Administración', password: PASSWORD, inviteCode },
  });
  return admin.cookie;
}
export const login = async (origin, username = 'admin') =>
  (await call(origin, '/api/auth/login', { body: { username, password: PASSWORD } })).cookie;

// El número del Meta de mentira atiende a GlobalVet, con el curso de aves por omisión.
export const assignNumber = (origin, cookie) =>
  call(origin, '/api/whatsapp/numbers/' + NUMBER, {
    cookie,
    method: 'PUT',
    body: { brandId: 'globalvet', courseId: 'aves', label: 'Número de prueba', expectedRevision: 0 },
  });
