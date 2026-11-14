import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { clientAddress, limitKey, proxyConfig } from '../server/app/client-address.mjs';
import { startServer } from './helpers/server.mjs';

const req = (remoteAddress, forwarded) => ({
  socket: { remoteAddress },
  headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
});

test('dirección del cliente: sólo se cree la parte de la cabecera que añadieron los proxies propios', () => {
  const cases = [
    // [dirección del socket, X-Forwarded-For, saltos, resultado]
    ['10.0.0.5', '198.51.100.7', 0, '10.0.0.5'], // por omisión no se mira ninguna cabecera
    ['10.0.0.5', '198.51.100.7', 1, '198.51.100.7'],
    ['10.0.0.5', '1.2.3.4, 198.51.100.7', 1, '198.51.100.7'], // lo de la izquierda lo escribió el cliente
    ['10.0.0.5', '1.2.3.4, 198.51.100.7, 172.16.0.9', 2, '198.51.100.7'],
    ['10.0.0.5', undefined, 1, '10.0.0.5'], // sin cabecera
    ['10.0.0.5', '198.51.100.7', 2, '10.0.0.5'], // más corta que los saltos
    ['10.0.0.5', 'no-es-una-ip', 1, '10.0.0.5'],
    ['10.0.0.5', '', 1, '10.0.0.5'],
    ['::ffff:10.0.0.5', '198.51.100.7:51234', 1, '198.51.100.7'], // IPv4 dentro de IPv6 y con puerto
    ['::ffff:10.0.0.5', undefined, 0, '10.0.0.5'],
    ['10.0.0.5', '[2001:db8:1:2:3:4:5:6]:443', 1, '2001:db8:1:2:3:4:5:6'],
    ['10.0.0.5', ['1.2.3.4', '198.51.100.7'], 1, '198.51.100.7'], // la cabecera repetida llega como lista
    [undefined, undefined, 0, 'unknown'],
    [undefined, '198.51.100.7', 1, '198.51.100.7'],
  ];
  for (const [remote, forwarded, hops, expected] of cases)
    assert.equal(clientAddress(req(remote, forwarded), hops), expected, JSON.stringify([remote, forwarded, hops]));

  // con rangos de confianza, la cabecera sólo vale si quien conecta es nuestro proxy
  const { trusted } = proxyConfig({
    TRUSTED_PROXY_HOPS: '1',
    TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 2001:db8::/32, 192.0.2.9',
  });
  assert.equal(clientAddress(req('10.0.0.5', '198.51.100.7'), 1, trusted), '198.51.100.7');
  assert.equal(clientAddress(req('192.0.2.9', '198.51.100.7'), 1, trusted), '198.51.100.7');
  assert.equal(clientAddress(req('2001:db8::1', '198.51.100.7'), 1, trusted), '198.51.100.7');
  assert.equal(clientAddress(req('203.0.113.1', '198.51.100.7'), 1, trusted), '203.0.113.1', 'no es nuestro proxy');
});

test('clave para limitar: IPv4 tal cual e IPv6 por su prefijo /64', () => {
  assert.equal(limitKey('198.51.100.7'), '198.51.100.7');
  assert.equal(limitKey('unknown'), 'unknown');
  assert.equal(limitKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(limitKey('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64', 'misma red, misma clave');
  assert.notEqual(limitKey('2001:db8:1:3::1'), limitKey('2001:db8:1:2::1'));
  assert.equal(limitKey('2001:0db8:0001:0002::1'), '2001:db8:1:2::/64', 'los ceros a la izquierda no cambian la clave');
  assert.equal(limitKey('::1'), '0:0:0:0::/64');
  assert.equal(limitKey('2001:db8::'), '2001:db8:0:0::/64');
});

test('configuración del proxy: por omisión nada; valores raros cuentan como «sin proxy»', () => {
  assert.deepEqual(proxyConfig({}), { hops: 0, trusted: null });
  assert.equal(proxyConfig({ TRUSTED_PROXY_HOPS: '1' }).hops, 1);
  assert.equal(proxyConfig({ TRUSTED_PROXY_HOPS: '2' }).hops, 2);
  for (const value of ['', '0', '-1', 'uno', '99'])
    assert.equal(proxyConfig({ TRUSTED_PROXY_HOPS: value }).hops, 0, value);
  assert.throws(() => proxyConfig({ TRUSTED_PROXY_CIDRS: 'no-es-un-rango/8' }), /TRUSTED_PROXY_CIDRS/);
});

// GET /api/verify/<folio> tiene un límite de 60 por minuto y dirección, y responde 404 con un folio inexistente.
const hit = (origin, forwarded) =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(origin);
    http
      .get({ hostname, port, path: '/api/verify/NO-EXISTE-1', headers: { 'X-Forwarded-For': forwarded } }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });

test('límites por dirección con el servidor real: sin la variable la cabecera se ignora; con un salto cuenta la de la derecha', async t => {
  const dirs = [];
  const servers = [];
  t.after(async () => {
    for (const server of servers) await server.stop();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const boot = async env => {
    const dir = await mkdtemp(join(tmpdir(), 'crm-proxy-'));
    dirs.push(dir);
    const server = await startServer({ dir, env: { TRUSTED_PROXY_HOPS: '', TRUSTED_PROXY_CIDRS: '', ...env } });
    servers.push(server);
    return server.origin;
  };

  // Por omisión nada cambia: todas las peticiones cuentan para la dirección del socket, diga lo que diga la cabecera.
  const plain = await boot({});
  for (let i = 0; i < 60; i++) assert.equal(await hit(plain, '198.51.100.7'), 404, 'petición ' + (i + 1));
  assert.equal(await hit(plain, '198.51.100.8'), 429, 'otra dirección en la cabecera no abre otro cupo');

  // Con un proxy propio delante, cada dirección real tiene su cupo.
  const proxied = await boot({ TRUSTED_PROXY_HOPS: '1' });
  for (let i = 0; i < 60; i++) assert.equal(await hit(proxied, '198.51.100.7'), 404, 'petición ' + (i + 1));
  assert.equal(await hit(proxied, '198.51.100.7'), 429, 'la 61.ª de la misma dirección');
  assert.equal(await hit(proxied, '198.51.100.8'), 404, 'otra dirección tiene su propio cupo');
  assert.equal(
    await hit(proxied, '198.51.100.8, 198.51.100.7'),
    429,
    'cuenta la de la derecha, no la que escribe el cliente',
  );
  assert.equal(await hit(proxied, '198.51.100.7, 198.51.100.9'), 404);
});
