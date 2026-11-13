import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadModules, RESERVED } from '../server/app/modules.mjs';
import { startServer } from './helpers/server.mjs';

async function folder(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-modules-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}
const quiet = { error() {} };
const ALPHA = `
export default {
  name: 'alpha',
  create(host) {
    return {
      async handle(req, res, path, user, url) {
        if (path === '/api/alpha/ping') { host.json(res, 200, { pong: true, user: user.id, q: url.searchParams.get('q'), beta: host.module('beta').count() }); return true; }
        return false;
      },
    };
  },
};`;
const BETA = `
let ticks = 0;
export default {
  name: 'beta',
  create: () => ({ count: () => ticks, tick() { ticks++; if (ticks === 2) throw new Error('un fallo del reloj'); }, async slow() { throw new Error('fallo asíncrono'); } }),
  timers: [
    { name: 'cuenta', everyMs: 60000, testEveryMs: 20, run: api => api.tick() },
    { name: 'lento', everyMs: 60000, testEveryMs: 20, run: api => api.slow() },
  ],
};`;

test('módulos nuevos: se descubren por carpeta, atienden sólo su prefijo, se hablan entre sí y sus relojes no tumban nada', async t => {
  const dir = await folder(t, {
    'alpha/module.mjs': ALPHA,
    'beta/module.mjs': BETA,
    '_shared/util.mjs': 'export const x = 1;', // código compartido: no es un módulo
    'suelto.mjs': 'export default {};', // un archivo suelto tampoco
  });
  const sent = [];
  const errors = [];
  const modules = await loadModules({
    dir,
    test: true,
    strict: true,
    log: { error: (...args) => errors.push(args.join(' ')) },
    host: { json: (res, status, data) => sent.push({ status, data }) },
  });
  assert.deepEqual(modules.names, ['alpha', 'beta']);
  assert.deepEqual(modules.failed, []);
  assert.equal(typeof modules.get('beta').count, 'function');
  assert.equal(modules.get('no-existe'), null);

  const url = new URL('http://localhost/api/alpha/ping?q=hola');
  assert.equal(await modules.handle({}, {}, '/api/alpha/ping', { id: 'u1' }, url), true);
  assert.deepEqual(sent, [{ status: 200, data: { pong: true, user: 'u1', q: 'hola', beta: 0 } }]);
  for (const path of ['/api/alpha/otra', '/api/alphabet/ping', '/api/gamma', '/api/', '/alpha/ping', '/api/beta/x'])
    assert.equal(await modules.handle({}, {}, path, { id: 'u1' }, url), false, path);
  assert.equal(sent.length, 1, 'un módulo no ve las rutas de otro');

  modules.startTimers();
  modules.startTimers(); // repetir no duplica relojes
  await new Promise(done => setTimeout(done, 200));
  modules.stopTimers();
  const count = modules.get('beta').count();
  assert.ok(count >= 3, 'el reloj sigue después de un fallo: ' + count);
  await new Promise(done => setTimeout(done, 80));
  assert.equal(modules.get('beta').count(), count, 'al detenerlos ya no corren');
  assert.ok(errors.some(line => line.includes('beta/cuenta')));
  assert.ok(
    errors.some(line => line.includes('beta/lento')),
    'también se recoge el fallo de un reloj asíncrono',
  );

  // sin carpeta de módulos no pasa nada
  const none = await loadModules({ dir: join(dir, 'no-existe'), strict: true });
  assert.deepEqual([none.names, none.failed], [[], []]);
  assert.equal(await none.handle({}, {}, '/api/alpha/ping', {}, url), false);
});

test('un módulo mal declarado se rechaza en las pruebas y se omite, con aviso, en el servidor', async t => {
  const cases = {
    'otro-nombre': ["export default { name: 'distinto', create() {} };", /igual al nombre de la carpeta/],
    crm: ["export default { name: 'crm', create() {} };", /ya lo atiende el servidor actual/],
    'sin-crear': ["export default { name: 'sin-crear' };", /falta create/],
    'reloj-rapido': [
      "export default { name: 'reloj-rapido', create: () => ({}), timers: [{ everyMs: 5, run() {} }] };",
      /everyMs de al menos 100/,
    ],
    'sin-objeto': ['export const nada = 1;', /debe exportar por omisión un objeto/],
    rompe: ["throw new Error('no importa');", /no importa/],
    'falla-al-crear': [
      "export default { name: 'falla-al-crear', create() { throw new Error('sin base'); } };",
      /sin base/,
    ],
    vacia: [null, /falta module\.mjs/],
  };
  for (const [name, [source, pattern]] of Object.entries(cases)) {
    const dir = await folder(t, source === null ? { [name + '/notas.txt']: '' } : { [name + '/module.mjs']: source });
    await assert.rejects(() => loadModules({ dir, strict: true, log: quiet }), pattern, name);
  }
  // En el servidor: los que están bien se montan y los rotos quedan anotados.
  const dir = await folder(t, {
    'alpha/module.mjs': ALPHA,
    'rompe/module.mjs': "throw new Error('no importa');",
    'crm/module.mjs': "export default { name: 'crm', create() {} };",
  });
  const lines = [];
  const modules = await loadModules({ dir, log: { error: (...args) => lines.push(args.join(' ')) } });
  assert.deepEqual(modules.names, ['alpha']);
  assert.deepEqual(
    modules.failed.map(m => m.name),
    ['crm', 'rompe'],
  );
  assert.equal(lines.length, 2);
  assert.equal(await modules.handle({}, {}, '/api/crm/tags', {}, new URL('http://localhost/')), false);
});

test('la lista de prefijos reservados sigue al día con las rutas del servidor actual', async () => {
  const used = new Set();
  for (const file of await readdir('server')) {
    if (!file.endsWith('.mjs')) continue;
    const source = await readFile(join('server', file), 'utf8');
    for (const [, segment] of source.matchAll(/\/api\/([a-z0-9][a-z0-9-]*)/g)) used.add(segment);
  }
  assert.deepEqual([...RESERVED], [...used].sort(), 'actualiza RESERVED en server/app/modules.mjs');
});

test('el servidor real arranca con todos sus módulos y una ruta desconocida sigue respondiendo lo de siempre', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-modules-real-'));
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: 'codigo-de-prueba-modulos' } });
  t.after(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const health = await (await fetch(server.origin + '/api/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.modulesFailed, undefined, 'ningún módulo quedó sin cargar\n' + server.logs());
  assert.equal(
    (await fetch(server.origin + '/api/zzz-no-existe')).status,
    401,
    'sin sesión no se llega a ningún módulo',
  );
  const registered = await fetch(server.origin + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: server.origin },
    body: JSON.stringify({
      username: 'admin',
      name: 'Administración',
      password: 'Password-modulos-2026!',
      inviteCode: 'codigo-de-prueba-modulos',
    }),
  });
  assert.equal(registered.status, 200);
  const cookie = registered.headers.get('set-cookie').split(';')[0];
  const unknown = await fetch(server.origin + '/api/zzz-no-existe', { headers: { Cookie: cookie } });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'Ruta no disponible.' });
});
