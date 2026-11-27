import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { createStatic } from '../server/app/static.mjs';
import { startServer } from './helpers/server.mjs';

const HOME =
  '<html><head><link rel="manifest" href="/manifest.webmanifest"><meta name="apple-mobile-web-app-title" content="TEC Capital"></head><body>portada</body></html>';

// Petición sin normalizar la ruta (fetch la normaliza antes de enviarla).
const request = (origin, path, { method = 'GET', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(origin);
    const req = http.request({ hostname, port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

// Un sitio de mentira servido sólo por createStatic, con el mismo trato de errores que el servidor real.
async function site(t, files, generated = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'crm-static-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const statics = createStatic({ root, fail, generated, ...options });
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store'); // como security(res) en el servidor real
      await statics.serve(req, res, new URL(req.url, 'http://localhost').pathname);
    } catch (error) {
      res.writeHead(error.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, origin: 'http://127.0.0.1:' + server.address().port };
}

const FILES = {
  'public/index.html': HOME,
  'public/app.js': 'console.log("app")',
  'public/styles.css': 'body{}',
  'public/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'public/icon-192.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'public/manifest.webmanifest': '{}',
  'public/datos.json': '{"a":1}',
  'public/letra.woff2': Buffer.from([1, 2, 3]),
  'public/sw.js': 'self.addEventListener("push",()=>{})',
  'public/kit/kit.css': '.k-page{}',
  'public/kit/shared/flow-model.js': 'export const x=1',
  'public/screens/ejemplo/index.js': 'export default {}',
  'public/flyers/aves.png': Buffer.from([9]),
  'public/notas.txt': 'no',
  'public/secreto.mjs': 'no',
  'public/mapa.js.map': 'no',
  'public/.oculto.js': 'no',
  'public/Mayus.js': 'no',
  'public/carpeta.js/dentro.txt': 'no',
  'node_modules/lucide/dist/umd/lucide.min.js': 'window.lucide={}',
  'server/index.mjs': 'no',
};

test('estáticos por carpeta: sirve lo que está en la lista de tipos, también en subcarpetas, y nada más', async t => {
  const { origin } = await site(t, FILES);
  const types = {
    '/app.js': 'text/javascript; charset=utf-8',
    '/styles.css': 'text/css; charset=utf-8',
    '/favicon.svg': 'image/svg+xml',
    '/icon-192.png': 'image/png',
    '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
    '/datos.json': 'application/json; charset=utf-8',
    '/letra.woff2': 'font/woff2',
    '/kit/kit.css': 'text/css; charset=utf-8',
    '/kit/shared/flow-model.js': 'text/javascript; charset=utf-8',
    '/screens/ejemplo/index.js': 'text/javascript; charset=utf-8',
    '/vendor/lucide.js': 'text/javascript; charset=utf-8',
  };
  for (const [path, type] of Object.entries(types)) {
    const res = await request(origin, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['content-type'], type, path);
    assert.equal(res.headers['cache-control'], 'no-cache', path);
    assert.match(res.headers.etag, /^"[0-9a-f]{32}"$/, path);
    assert.equal(Number(res.headers['content-length']), res.body.length, path);
  }
  assert.equal((await request(origin, '/vendor/lucide.js')).body.toString(), 'window.lucide={}');
  for (const path of [
    '/flyers/aves.png', // se sirven con sesión por la API
    '/index.html', // la portada sólo por rutas sin punto
    '/notas.txt', // extensión fuera de la lista
    '/secreto.mjs',
    '/mapa.js.map',
    '/.oculto.js', // segmento que empieza por punto
    '/Mayus.js', // sólo minúsculas
    '/APP.JS',
    '/carpeta.js', // es una carpeta, no un archivo
    '/no-existe.js',
    '/kit/no-existe.css',
    '/kit//kit.css', // barra doble
    '/kit/%2e%2e/%2e%2e/server/index.mjs',
    '/%2e%2e/server/index.mjs',
    '/..%2fserver%2findex.mjs',
    '/kit/kit.css%00.js',
    '/vendor/otro.js',
  ]) {
    const res = await request(origin, path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(JSON.parse(res.body.toString()), { error: 'No encontrado.' }, path);
    assert.equal(res.headers.etag, undefined, path);
    assert.equal(res.headers['cache-control'], 'no-store', path + ': un error no se guarda');
  }
});

test('la portada: cualquier ruta sin punto, con la variante del cliente fuera de /crm y su propia etiqueta', async t => {
  const { origin } = await site(t, FILES);
  const team = await request(origin, '/crm');
  const customer = await request(origin, '/');
  for (const res of [team, customer]) {
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-cache');
  }
  assert.equal(team.body.toString(), HOME);
  assert.match(customer.body.toString(), /href="\/manifest-cliente\.webmanifest"/);
  assert.match(customer.body.toString(), /apple-mobile-web-app-title" content="Chat de prueba"/);
  assert.notEqual(team.headers.etag, customer.headers.etag);
  assert.equal((await request(origin, '/crm/lo/que/sea')).headers.etag, team.headers.etag);
  assert.equal((await request(origin, '/cualquier/ruta/sin/punto')).headers.etag, customer.headers.etag);
});

test('revalidación: etiqueta estable, 304 sin cuerpo, HEAD sin cuerpo, y contenido nuevo en cuanto cambia el archivo', async t => {
  const { origin, root } = await site(t, FILES);
  const first = await request(origin, '/app.js');
  const second = await request(origin, '/app.js');
  assert.equal(first.headers.etag, second.headers.etag);
  for (const value of [first.headers.etag, 'W/' + first.headers.etag, '"otra", ' + first.headers.etag, '*']) {
    const cached = await request(origin, '/app.js', { headers: { 'If-None-Match': value } });
    assert.equal(cached.status, 304, value);
    assert.equal(cached.body.length, 0);
    assert.equal(cached.headers.etag, first.headers.etag);
    assert.equal(cached.headers['cache-control'], 'no-cache');
  }
  assert.equal((await request(origin, '/app.js', { headers: { 'If-None-Match': '"otra"' } })).status, 200);
  const head = await request(origin, '/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers.etag, first.headers.etag);
  assert.equal(Number(head.headers['content-length']), first.body.length);

  await writeFile(join(root, 'public/app.js'), 'console.log("una versión nueva")');
  const changed = await request(origin, '/app.js', { headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(changed.status, 200, 'la copia vieja ya no vale');
  assert.equal(changed.body.toString(), 'console.log("una versión nueva")');
  assert.notEqual(changed.headers.etag, first.headers.etag);

  // el service worker no se guarda nunca
  const sw = await request(origin, '/sw.js');
  assert.equal(sw.status, 200);
  assert.equal(sw.headers['cache-control'], 'no-store');
  assert.equal(sw.headers.etag, undefined);
});

test('contenido generado (la lista de pantallas) con las mismas reglas de caché', async t => {
  const bytes = Buffer.from('{"screens":[]}');
  const { origin } = await site(t, FILES, {
    '/screens/index.json': { bytes, type: 'application/json; charset=utf-8' },
  });
  const res = await request(origin, '/screens/index.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.body.toString(), '{"screens":[]}');
  assert.equal(
    (await request(origin, '/screens/index.json', { headers: { 'If-None-Match': res.headers.etag } })).status,
    304,
  );
});

test('un enlace simbólico no puede sacar de public/', async t => {
  const { origin, root } = await site(t, { ...FILES, 'fuera/secreto.js': 'SECRETO' });
  // Una carpeta enlazada (en Windows, una unión, que no pide privilegios) y, donde el sistema lo permite, un archivo enlazado.
  const paths = ['/puerta/secreto.js'];
  await symlink(join(root, 'fuera'), join(root, 'public', 'puerta'), 'junction');
  try {
    await symlink(join(root, 'fuera', 'secreto.js'), join(root, 'public', 'enlace.js'), 'file');
    paths.push('/enlace.js');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }
  for (const path of paths) {
    const res = await request(origin, path);
    assert.equal(res.status, 404, path);
    assert.equal(res.body.toString().includes('SECRETO'), false);
  }
});

// Paquete de la portada (docs/PLAN_ATENDER_COMO_WHATSAPP.md, «Velocidad»): las etiquetas de index.html se convierten en
// un solo CSS y un solo JS con el hash del contenido en el nombre, caché inmutable y gzip; el módulo ES y lo demás
// siguen aparte; cambia una parte y cambia el nombre, y el nombre anterior se sigue sirviendo.
const PORTADA = `<html><head><link rel="manifest" href="/manifest.webmanifest">
  <link rel="stylesheet" href="/tokens.css">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/kit/kit.css">
  <script defer src="/vendor/lucide.js"></script>
  <script defer src="/crm.js"></script>
  <script type="module" src="/kit/boot.js"></script>
  <script defer src="/app.js"></script>
</head><body>portada</body></html>`;
const PARTES = {
  'public/index.html': PORTADA,
  'public/tokens.css': ':root{--a:1}',
  'public/styles.css':
    "@import url('https://fonts.example/css2?family=M:wght@400;700&display=swap');\nbody{color:var(--a)}",
  'public/kit/kit.css': '.k{}',
  'public/crm.js': 'const crm = 1;',
  'public/app.js': 'console.log(crm)',
  'public/kit/boot.js': 'export {}',
  'public/manifest.webmanifest': '{}',
  'node_modules/lucide/dist/umd/lucide.min.js': 'window.lucide={}',
};
const packOf = html => ({
  css: html.match(/href="(\/paquete\/estilos\.[0-9a-f]{16}\.css)"/)?.[1],
  js: html.match(/src="(\/paquete\/app\.[0-9a-f]{16}\.js)"/)?.[1],
});

test('paquete de la portada: un CSS y un JS con nombre por contenido, caché inmutable, gzip, y rearmado al cambiar una parte', async t => {
  const { root, origin } = await site(t, PARTES);
  const home = (await request(origin, '/crm')).body.toString();
  const { css, js } = packOf(home);
  assert.ok(css && js, home);
  assert.equal((home.match(/<link rel="stylesheet"/g) || []).length, 1, 'una sola hoja');
  // el módulo ES parte el paquete en dos tramos y se queda en su sitio: todo corre en el mismo orden que en la portada
  assert.equal((home.match(/<script defer/g) || []).length, 2, 'un script clásico por tramo');
  const order = [...home.matchAll(/<script (?:defer |type="module" )src="([^"]+)"/g)].map(m => m[1]);
  assert.equal(order[1], '/kit/boot.js', 'el módulo ES sigue aparte, entre los dos tramos');
  assert.ok(order[0].startsWith('/paquete/app.') && order[2].startsWith('/paquete/app.') && order[0] !== order[2]);
  const tail = (await request(origin, order[2])).body.toString();
  assert.match(tail, /console\.log\(crm\)/, 'app.js va en el tramo de después del módulo');
  assert.doesNotMatch(tail, /const crm = 1/);
  assert.match(home, /href="\/manifest\.webmanifest"/);
  // la hoja: en el orden de la portada, con el @import (que lleva «;» dentro) hoisteado al principio y una sola vez
  const sheet = await request(origin, css);
  assert.equal(sheet.status, 200);
  assert.equal(sheet.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(sheet.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(sheet.headers.etag, /^"[0-9a-f]{32}"$/);
  const cssText = sheet.body.toString();
  assert.ok(
    cssText.startsWith("@import url('https://fonts.example/css2?family=M:wght@400;700&display=swap');"),
    cssText,
  );
  assert.equal((cssText.match(/@import/g) || []).length, 1);
  assert.ok(cssText.indexOf(':root{--a:1}') < cssText.indexOf('body{color:var(--a)}'), 'tokens antes que styles');
  assert.ok(cssText.indexOf('body{color:var(--a)}') < cssText.indexOf('.k{}'), 'styles antes que el kit');
  // el script: en el orden de la portada, sin el módulo
  const script = await request(origin, js);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(script.headers['cache-control'], 'public, max-age=31536000, immutable');
  const jsText = script.body.toString();
  assert.ok(jsText.indexOf('window.lucide={}') < jsText.indexOf('const crm = 1;'), 'lucide primero');
  assert.doesNotMatch(jsText, /export \{\}/);
  // gzip ya calculado, sólo para quien lo acepta; 304 con la etiqueta
  const zipped = await request(origin, js, { headers: { 'Accept-Encoding': 'gzip, br' } });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.headers.vary, 'Accept-Encoding');
  assert.equal(gunzipSync(zipped.body).toString(), jsText);
  assert.equal(script.headers['content-encoding'], undefined);
  assert.equal((await request(origin, js, { headers: { 'If-None-Match': script.headers.etag } })).status, 304);
  // sólo los paquetes armados aquí: otro nombre, 404 (aunque exista un archivo así en public/paquete/)
  assert.equal((await request(origin, '/paquete/app.0000000000000000.js')).status, 404);
  await mkdir(join(root, 'public', 'paquete'), { recursive: true });
  await writeFile(join(root, 'public', 'paquete', 'suelto.js'), 'no');
  assert.equal((await request(origin, '/paquete/suelto.js')).status, 404);
  // la portada del cliente también va empaquetada
  const customer = (await request(origin, '/')).body.toString();
  assert.match(customer, /manifest-cliente/);
  assert.equal(packOf(customer).js, js);
  // cambia una parte: nombre nuevo con el contenido nuevo; el anterior se sigue sirviendo a una pestaña ya abierta
  await writeFile(join(root, 'public', 'app.js'), 'console.log(crm, 2)');
  const againHtml = (await request(origin, '/crm')).body.toString();
  const again = packOf(againHtml),
    againTail = [...againHtml.matchAll(/<script defer src="([^"]+)"/g)].map(m => m[1])[1];
  assert.equal(again.js, js, 'el tramo de antes del módulo no cambió');
  assert.equal(again.css, css, 'la hoja no cambió');
  assert.notEqual(againTail, order[2], 'el tramo con app.js tiene nombre nuevo');
  assert.match((await request(origin, againTail)).body.toString(), /console\.log\(crm, 2\)/);
  assert.equal((await request(origin, order[2])).status, 200, 'el tramo anterior se sigue sirviendo');
  // apagado (STATIC_BUNDLE=0): la portada sale tal cual
  const off = await site(t, PARTES, {}, { bundle: false });
  const plain = (await request(off.origin, '/crm')).body.toString();
  assert.doesNotMatch(plain, /paquete/);
  assert.equal((plain.match(/<script defer/g) || []).length, 3);
});

test('el servidor real sirve todo public/ con su tipo y su etiqueta, y sigue sin servir la portada por nombre ni los flyers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-static-real-'));
  const server = await startServer({ dir });
  t.after(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const TYPES = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
  };
  const all = (await readdir('public', { recursive: true })).map(file => file.replaceAll('\\', '/'));
  const served = all.filter(file => TYPES[extname(file)] && !file.startsWith('flyers/') && file !== 'index.html');
  assert.ok(served.length >= 53, 'los 53 archivos de la raíz de public/ (todos menos la portada) siguen ahí');
  for (const file of served) {
    const res = await request(server.origin, '/' + file);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers['content-type'], TYPES[extname(file)], file);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', file);
    if (file === 'sw.js') assert.equal(res.headers['cache-control'], 'no-store');
    else assert.match(res.headers.etag, /^"[0-9a-f]{32}"$/, file);
  }
  const home = await request(server.origin, '/crm');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-security-policy'], /script-src 'self'/);
  // la portada real sale empaquetada: una hoja, un script clásico y el módulo del kit; el paquete es JavaScript válido
  const real = home.body.toString();
  const realPack = packOf(real);
  assert.ok(realPack.css && realPack.js, 'la portada real lleva el paquete');
  assert.equal((real.match(/<link rel="stylesheet"/g) || []).length, 1);
  const realOrder = [...real.matchAll(/<script (?:defer |type="module" )src="([^"]+)"/g)].map(m => m[1]);
  assert.equal(realOrder.length, 3, 'un tramo, el módulo del kit y el tramo de app.js');
  assert.equal(realOrder[1], '/kit/boot.js');
  let realBytes = 0;
  for (const path of [realOrder[0], realOrder[2]]) {
    const realJs = await request(server.origin, path);
    assert.equal(realJs.status, 200, path);
    assert.doesNotThrow(() => new Function(realJs.body.toString()), 'el paquete de JavaScript se analiza entero');
    realBytes += realJs.body.length;
  }
  assert.ok(realBytes > 500_000, 'trae los 42 archivos');
  assert.equal((await request(server.origin, '/crm', { headers: { 'If-None-Match': home.headers.etag } })).status, 304);
  assert.equal((await request(server.origin, '/index.html')).status, 404);
  const flyer = all.find(file => file.startsWith('flyers/') && file.endsWith('.png'));
  if (flyer) assert.equal((await request(server.origin, '/' + flyer)).status, 404, flyer);
  assert.equal(
    (await request(server.origin, '/app.js', { method: 'POST' })).status,
    403,
    'POST sin Origin sigue rechazado',
  );
  // la API no cambia: sin guardar y sin etiqueta
  const health = await request(server.origin, '/api/health');
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers.etag, undefined);
  // la lista de pantallas existe aunque todavía no haya ninguna publicada
  const screens = await request(server.origin, '/screens/index.json');
  assert.equal(screens.status, 200);
  assert.ok(Array.isArray(JSON.parse(screens.body.toString()).screens));
});
