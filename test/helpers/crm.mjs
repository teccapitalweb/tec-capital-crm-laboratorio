// Ayudas de las pruebas de punta a punta que arrancan el servidor real: llamadas con sesión, espera de un efecto,
// muerte brusca y apagado ordenado del proceso, y el laboratorio de WhatsApp real contra el Meta de mentira.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertSchemaCurrent } from './schema.mjs';
import { startServer } from './server.mjs';
import { startFakeMeta, NUMBER } from './fake-meta.mjs';

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

const exited = child => child.exitCode !== null || child.signalCode !== null;
// Muerte brusca del proceso, igual en cualquier sistema: sin apagado ordenado, como una caída o un corte.
export const crash = server =>
  exited(server.child)
    ? Promise.resolve()
    : new Promise(done => {
        server.child.once('exit', done);
        server.child.kill('SIGKILL');
      });

// Arranca el servidor real de forma que se le pueda pedir un APAGADO ORDENADO en cualquier sistema. En Windows
// child.kill() termina el proceso sin avisar, así que una carga previa (./sigterm-on-stdin.mjs) entrega SIGTERM al
// propio proceso cuando recibe una línea por su entrada: el servidor ejecuta entonces su apagado de verdad.
// Devuelve lo mismo que startServer más shutdown() → { code, ms }.
export async function startStoppable({ dir, env = {}, timeoutMs = 15000 }) {
  let logs = '';
  const child = spawn(process.execPath, ['--import', './test/helpers/sigterm-on-stdin.mjs', 'server/index.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir, APP_ORIGIN: '', NODE_ENV: 'test', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', chunk => (logs += chunk));
  child.stdin.on('error', () => {}); // el proceso pudo terminar antes de leer
  const gone = new Promise(done => child.once('exit', code => done(code)));
  const stop = () => {
    if (!exited(child)) child.kill('SIGKILL');
    return gone;
  };
  const shutdown = async () => {
    const started = Date.now();
    child.stdin.write('apagar\n');
    const code = await gone;
    return { code, ms: Date.now() - started };
  };
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('El servidor no arrancó a tiempo.\n' + logs)), timeoutMs);
      let out = '';
      child.stdout.on('data', chunk => {
        out += chunk;
        const found = out.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (found) {
          clearTimeout(timer);
          resolve(found[0]);
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(Error('El servidor terminó al arrancar.\n' + logs));
      });
    });
    return { origin, child, logs: () => logs, stop, shutdown };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function registerAdmin(origin, inviteCode) {
  const admin = await call(origin, '/api/auth/register', {
    body: { username: 'admin', name: 'Administración', password: PASSWORD, inviteCode },
  });
  return admin.cookie;
}

// El número del Meta de mentira atiende a GlobalVet, con el curso de aves por omisión.
export const assignNumber = (origin, cookie) =>
  call(origin, '/api/whatsapp/numbers/' + NUMBER, {
    cookie,
    method: 'PUT',
    body: { brandId: 'globalvet', courseId: 'aves', label: 'Número de prueba', expectedRevision: 0 },
  });

// Laboratorio de WhatsApp real: un Meta de mentira y un servidor real completo contra él, con administración
// registrada y el número asignado. start(extra) vuelve a arrancar el servidor sobre los mismos datos (tras una
// muerte o un apagado), con otras variables si hace falta; origin() es la dirección del servidor vigente.
export async function whatsappLab(t, env = {}, { launch = startServer } = {}) {
  const meta = await startFakeMeta();
  const dir = await mkdtemp(join(tmpdir(), 'crm-duradero-'));
  const code = randomUUID();
  const state = { server: null, db: null };
  t.after(async () => {
    try {
      state.db?.close();
    } catch {
      // ya estaba cerrada
    }
    await state.server?.stop();
    await meta.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const start = async extra => {
    state.server = await launch({ dir, env: { ...meta.env, ADMIN_INVITE_CODE: code, ...env, ...extra } });
    return state.server;
  };
  const server = await start();
  const admin = await registerAdmin(server.origin, code);
  await assignNumber(server.origin, admin);
  state.db = openDb(dir);
  assertSchemaCurrent(state.db);
  const inboxRow = id => state.db.prepare('SELECT * FROM webhook_inbox WHERE event_id=?').get(id);
  return { meta, dir, state, start, admin, db: state.db, inboxRow, origin: () => state.server.origin };
}
