import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadModules, RESERVED, PUBLIC_RESERVED } from '../server/app/modules.mjs';
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
const wait = ms => new Promise(done => setTimeout(done, ms));
const here = new URL('http://localhost/');

// alpha: rutas con sesión bajo su nombre y una ruta pública; habla con beta al atender.
const ALPHA = `
export default {
  name: 'alpha',
  create(host) {
    return {
      async handle(req, res, path, user, url) {
        if (path === '/api/alpha/ping') { host.json(res, 200, { pong: true, user: user.id, q: url.searchParams.get('q'), beta: host.module('beta').count() }); return true; }
        return false;
      },
      open(req, res, path, url, ip) { host.json(res, 200, { open: path, ip }); return true; },
    };
  },
  public: { prefixes: ['/api/compat/alpha', '/baja'], handle: (api, req, res, path, url, ip) => api.open(req, res, path, url, ip) },
};`;
// beta: reclama un prefijo distinto de su nombre y trae tres relojes (uno falla a veces, otro falla siempre, otro es lento).
const BETA = `
let ticks = 0, slow = 0, together = 0, most = 0;
export default {
  name: 'beta',
  prefixes: ['/api/directorio', '/api/beta'],
  create: host => ({
    count: () => ticks, slowRuns: () => slow, most: () => most,
    handle(req, res, path) { host.json(res, 200, { beta: path }); return true; },
    tick() { ticks++; if (ticks === 2) throw new Error('un fallo del reloj'); },
    async broken() { throw new Error('fallo asíncrono'); },
    async slow() { together++; most = Math.max(most, together); await new Promise(done => setTimeout(done, 90)); slow++; together--; },
  }),
  timers: [
    { name: 'cuenta', everyMs: 60000, testEveryMs: 20, run: api => api.tick() },
    { name: 'roto', everyMs: 60000, testEveryMs: 20, run: api => api.broken() },
    { name: 'lento', everyMs: 500, fast: true, testEveryMs: 20, run: api => api.slow() },
  ],
};`;

test('módulos nuevos: se descubren por carpeta, atienden sólo sus prefijos (con y sin sesión) y se hablan entre sí', async t => {
  const dir = await folder(t, {
    'alpha/module.mjs': ALPHA,
    'beta/module.mjs': BETA,
    '_shared/util.mjs': 'export const x = 1;', // código compartido: no es un módulo
    'suelto.mjs': 'export default {};', // un archivo suelto tampoco
  });
  const sent = [];
  const modules = await loadModules({
    dir,
    test: true,
    strict: true,
    log: quiet,
    host: { json: (res, status, data) => sent.push(data), services: { crm: {}, catalogueImport: {} } },
  });
  assert.deepEqual(modules.names, ['alpha', 'beta']);
  assert.deepEqual(modules.failed, []);
  assert.equal(typeof modules.get('beta').count, 'function');
  assert.equal(modules.get('no-existe'), null);

  const url = new URL('http://localhost/api/alpha/ping?q=hola');
  assert.equal(await modules.handle({}, {}, '/api/alpha/ping', { id: 'u1' }, url), true);
  assert.deepEqual(sent.pop(), { pong: true, user: 'u1', q: 'hola', beta: 0 });
  assert.equal(await modules.handle({}, {}, '/api/directorio/contactos/7', { id: 'u1' }, here), true);
  assert.deepEqual(sent.pop(), { beta: '/api/directorio/contactos/7' });
  assert.equal(await modules.handle({}, {}, '/api/beta', { id: 'u1' }, here), true);
  sent.length = 0;
  for (const path of [
    '/api/alpha/otra', // el módulo dice que no es suya
    '/api/alphabet/ping', // un prefijo no es «empieza por»: es el segmento entero
    '/api/directorios',
    '/api/gamma',
    '/api/',
    '/alpha/ping',
    '/api/compat/alpha', // es pública: no entra por la puerta con sesión
  ])
    assert.equal(await modules.handle({}, {}, path, { id: 'u1' }, here), false, path);
  assert.deepEqual(sent, [], 'un módulo no ve las rutas de otro');

  // rutas sin sesión
  assert.equal(await modules.handlePublic({}, {}, '/api/compat/alpha/v1/send', here, '10.0.0.1'), true);
  assert.deepEqual(sent.pop(), { open: '/api/compat/alpha/v1/send', ip: '10.0.0.1' });
  assert.equal(await modules.handlePublic({}, {}, '/baja', here, '10.0.0.1'), true);
  sent.length = 0;
  for (const path of ['/api/alpha/ping', '/api/compat', '/bajas', '/api/directorio', '/'])
    assert.equal(await modules.handlePublic({}, {}, path, here, '10.0.0.1'), false, path);
  assert.deepEqual(sent, []);

  // sin carpeta de módulos no pasa nada
  const none = await loadModules({ dir: join(dir, 'no-existe'), strict: true });
  assert.deepEqual([none.names, none.failed, none.timerStats()], [[], [], []]);
  assert.equal(await none.handle({}, {}, '/api/alpha/ping', {}, url), false);
  assert.equal(await none.handlePublic({}, {}, '/baja', here, 'x'), false);
});

test('los relojes de un módulo no se pisan, siguen tras un fallo y se pueden detener', async t => {
  const dir = await folder(t, { 'beta/module.mjs': BETA });
  const errors = [];
  const modules = await loadModules({
    dir,
    test: true,
    strict: true,
    log: { error: (...args) => errors.push(args.join(' ')) },
    host: { json() {} },
  });
  modules.startTimers();
  modules.startTimers(); // repetir no duplica relojes
  await wait(330);
  modules.stopTimers();
  await wait(120); // deja terminar la pasada lenta que estuviera en curso
  const beta = modules.get('beta');
  const count = beta.count();
  assert.ok(count >= 5, 'el reloj sigue después de un fallo: ' + count);
  assert.equal(beta.most(), 1, 'una pasada lenta nunca se solapa con la siguiente');
  assert.ok(beta.slowRuns() >= 2 && beta.slowRuns() <= 5, 'el reloj lento corre a su ritmo: ' + beta.slowRuns());
  await wait(80);
  assert.equal(beta.count(), count, 'al detenerlos ya no corren');
  assert.ok(errors.some(line => line.includes('beta/cuenta') && line.includes('un fallo del reloj')));
  assert.ok(
    errors.some(line => line.includes('beta/roto')),
    'también se recoge el fallo de un reloj asíncrono',
  );
  const stats = Object.fromEntries(modules.timerStats().map(timer => [timer.name, timer]));
  assert.equal(stats.cuenta.failures, 1);
  assert.equal(stats.cuenta.runs, count);
  assert.equal(stats.roto.failures, stats.roto.runs);
  assert.ok(stats.lento.lastMs >= 80, 'se mide cuánto tarda cada pasada');
  assert.equal(stats.lento.everyMs, 500);
});

test('un módulo mal declarado se rechaza en las pruebas y se omite, con aviso, en el servidor', async t => {
  const mod = (name, extra = '') => `export default { name: '${name}', create: () => ({}), ${extra} };`;
  const cases = {
    'otro-nombre': [mod('distinto'), /igual al nombre de la carpeta/],
    crm: [mod('crm'), /ya es un servicio del servidor actual/],
    'catalogue-import': [mod('catalogue-import'), /ya es un servicio del servidor actual/],
    metrics: [mod('metrics'), /\/api\/metrics ya lo atiende el servidor actual/],
    'bajo-otro': [mod('bajo-otro', "prefixes: ['/api/conversations/extra']"), /ya lo atiende el servidor actual/],
    'fuera-de-api': [mod('fuera-de-api', "prefixes: ['/otra']"), /prefijo no válido/],
    'sin-prefijos': [mod('sin-prefijos', 'prefixes: []'), /al menos una ruta/],
    'sin-crear': ["export default { name: 'sin-crear' };", /falta create/],
    'reloj-rapido': [mod('reloj-rapido', 'timers: [{ everyMs: 500, run() {} }]'), /una vez por segundo/],
    'reloj-rapidisimo': [mod('reloj-rapidisimo', 'timers: [{ everyMs: 100, fast: true, run() {} }]'), /250 ms/],
    'reloj-sin-run': [mod('reloj-sin-run', 'timers: [{ everyMs: 1000 }]'), /necesita run/],
    'publica-sin-handle': [mod('publica-sin-handle', "public: { prefixes: ['/x'] }"), /necesita handle/],
    'publica-webhooks': [
      mod('publica-webhooks', "public: { prefixes: ['/api/webhooks/x'], handle() {} }"),
      /choca con \/api\/webhooks/,
    ],
    'publica-auth': [
      mod('publica-auth', "public: { prefixes: ['/api/auth'], handle() {} }"),
      /choca con \/api\/auth\/login/,
    ],
    'publica-api': [mod('publica-api', "public: { prefixes: ['/api'], handle() {} }"), /choca con/],
    'publica-crm': [mod('publica-crm', "public: { prefixes: ['/crm/x'], handle() {} }"), /choca con \/crm/],
    'publica-y-privada': [
      mod('publica-y-privada', "public: { prefixes: ['/api/publica-y-privada/abierta'], handle() {} }"),
      /no puede ser pública y con sesión/,
    ],
    'sin-objeto': ['export const nada = 1;', /debe exportar por omisión un objeto/],
    rompe: ["throw new Error('no importa');", /no importa/],
    'falla-al-crear': [
      "export default { name: 'falla-al-crear', create() { throw new Error('sin base'); } };",
      /sin base/,
    ],
    vacia: [null, /falta module\.mjs/],
  };
  const host = { services: { crm: {}, catalogueImport: {}, whatsapp: {} } };
  for (const [name, [source, pattern]] of Object.entries(cases)) {
    const dir = await folder(t, source === null ? { [name + '/notas.txt']: '' } : { [name + '/module.mjs']: source });
    await assert.rejects(() => loadModules({ dir, host, strict: true, log: quiet }), pattern, name);
  }
  // lo que sí vale: una ruta pública bajo /api/auth que no es ninguna de las actuales, y un reloj rápido declarado
  const fine = await folder(t, {
    'oidc/module.mjs': mod(
      'oidc',
      "public: { prefixes: ['/api/auth/oidc'], handle: () => true }, timers: [{ everyMs: 250, fast: true, run() {} }]",
    ),
  });
  assert.deepEqual((await loadModules({ dir: fine, host, strict: true })).names, ['oidc']);

  // dos módulos no pueden reclamar la misma ruta, ni una por encima de la otra
  const clash = await folder(t, {
    'uno/module.mjs': mod('uno', "prefixes: ['/api/compartida']"),
    'zeta/module.mjs': mod('zeta', "prefixes: ['/api/compartida/dentro']"),
  });
  await assert.rejects(
    () => loadModules({ dir: clash, strict: true }),
    /choca con \/api\/compartida, del módulo «uno»/,
  );

  // En el servidor: los que están bien se montan y los rotos quedan anotados.
  const dir = await folder(t, {
    'alpha/module.mjs': ALPHA,
    'beta/module.mjs': BETA,
    'rompe/module.mjs': "throw new Error('no importa');",
    'whatsapp/module.mjs': mod('whatsapp'),
  });
  const lines = [];
  const modules = await loadModules({
    dir,
    host: { json() {} },
    log: { error: (...args) => lines.push(args.join(' ')) },
  });
  assert.deepEqual(modules.names, ['alpha', 'beta']);
  assert.deepEqual(
    modules.failed.map(m => m.name),
    ['rompe', 'whatsapp'],
  );
  assert.equal(lines.length, 2);
  assert.equal(await modules.handle({}, {}, '/api/whatsapp/numbers', {}, here), false);
});

test('las listas de rutas reservadas siguen al día con el servidor actual', async () => {
  const used = new Set();
  let entry = '';
  for (const file of await readdir('server')) {
    if (!file.endsWith('.mjs')) continue;
    const source = await readFile(join('server', file), 'utf8');
    if (file === 'index.mjs') entry = source;
    for (const [, segment] of source.matchAll(/\/api\/([a-z0-9][a-z0-9-]*)/g)) used.add(segment);
  }
  assert.deepEqual([...RESERVED], [...used].sort(), 'actualiza RESERVED en server/app/modules.mjs');
  // Los manejadores sin sesión del servidor actual, en su orden; los módulos nuevos van al final y cada ruta
  // pública que ya existe está en la lista de reservadas.
  const open = entry.slice(entry.indexOf("path === '/api/health'"), entry.indexOf("'Origen no permitido.'"));
  assert.deepEqual(
    [...open.matchAll(/await (\w+)\.handle/g)].map(match => match[1]),
    ['connectors', 'privacy', 'payments', 'certificates', 'mcp', 'integrations', 'allies', 'surveys', 'modules'],
  );
  for (const route of [
    '/api/webhooks',
    '/privacidad',
    '/api/pay',
    '/verificar',
    '/api/verify',
    '/mcp',
    '/api/v1',
    '/aliados',
    '/encuesta',
    '/api/survey',
  ])
    assert.ok(PUBLIC_RESERVED.includes(route), route);
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
