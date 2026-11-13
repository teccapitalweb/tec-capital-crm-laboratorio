import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

// Un destino de petición que `new URL` no puede leer (por ejemplo `//`) no debe detener el proceso:
// responde 400 y el servidor sigue atendiendo. Se escribe por socket porque `fetch` normaliza la dirección antes de enviarla.
const raw = (port, target) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Error('sin respuesta para ' + target));
    }, 5000);
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.write('GET ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'),
    );
    socket.on('data', chunk => {
      data += chunk;
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });

test('un destino de petición mal formado responde 400 y el servidor sigue en pie', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-url-'));
  let logs = '';
  const server = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dir,
      ADMIN_INVITE_CODE: 'codigo-de-prueba-url',
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
  const port = Number(origin.split(':').pop());
  for (const target of ['//', '//%', '//[::1', '//x:99999/']) {
    const answer = await raw(port, target);
    assert.match(answer, /^HTTP\/1\.1 400 /, '400 para ' + target);
    assert.equal(server.exitCode, null, 'el proceso sigue vivo tras ' + target + '\n' + logs);
    assert.equal((await fetch(origin + '/api/health')).status, 200, 'sigue atendiendo tras ' + target);
  }
  const answer = await raw(port, '//');
  assert.ok(answer.includes('{"error":"Solicitud no válida."}'), 'el error llega como JSON con su mensaje');
  assert.match(answer, /x-content-type-options: nosniff/i, 'la respuesta conserva las cabeceras de seguridad');
  // Lo demás no cambia: una ruta desconocida de la API sigue pidiendo sesión y la portada sigue respondiendo.
  assert.equal((await fetch(origin + '/api/bootstrap')).status, 401);
  assert.equal((await fetch(origin + '/')).status, 200);
  assert.equal(logs.includes('Request failed'), false, 'un destino mal formado no se registra como fallo interno');
});
