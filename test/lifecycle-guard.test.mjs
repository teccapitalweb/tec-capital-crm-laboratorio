// El ciclo de vida corre con cada mensaje (server/index.mjs, insertMessage). Si falla, lo suyo se deshace y el mensaje
// se guarda igual: un fallo ahí no puede dejar a nadie sin poder escribir (docs/PLAN_CICLO_DE_VIDA.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, until } from './helpers/crm.mjs';

test('si el ciclo de vida falla al llegar un mensaje, el mensaje se guarda igual y el fallo queda en el registro', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-ciclo-guarda-'));
  const server = await startServer({ dir, env: { AI_PROVIDER: '' } });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const customer = await call(server.origin, '/api/auth/register', {
    body: { username: 'cliente', name: 'Cliente de prueba', password: PASSWORD },
  });
  const conversation = (
    await call(server.origin, '/api/conversations', {
      cookie: customer.cookie,
      body: { courseId: 'aves', channel: 'whatsapp' },
    })
  ).conversation;
  const send = text =>
    call(server.origin, '/api/conversations/' + conversation.id + '/messages', {
      cookie: customer.cookie,
      body: { text, clientRef: randomUUID() },
      expected: 201,
    });
  const saved = id => db.prepare('SELECT text FROM messages WHERE id=?').get(id)?.text;

  // con el ciclo de vida sano, el primer mensaje abre su ciclo
  const first = await send('Hola, quiero información');
  assert.equal(saved(first.id), 'Hola, quiero información');
  await until(
    () => db.prepare('SELECT count(*) n FROM conversation_cycles WHERE conversation_id=?').get(conversation.id).n === 1,
    'el primer mensaje abre un ciclo',
    { logs: server.logs },
  );

  // se rompe su tabla (como haría un defecto del módulo): el siguiente mensaje entra de todos modos
  db.exec('ALTER TABLE conversation_cycles RENAME TO conversation_cycles_rota');
  const second = await send('¿Sigue ahí?');
  assert.equal(saved(second.id), '¿Sigue ahí?', 'el mensaje quedó guardado');
  await until(
    () => server.logs().includes('Lifecycle onMessage failed'),
    'el fallo queda en el registro del servidor',
    {
      logs: server.logs,
    },
  );
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM messages WHERE conversation_id=? AND sender_kind=?')
      .get(conversation.id, 'customer').n,
    2,
    'los dos mensajes de la persona están en el hilo',
  );
});
