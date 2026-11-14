import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { WebSocketServer, WebSocket } from 'ws';
import { openDatabase } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { createCRM } from '../server/crm.mjs';
import { createAccess } from '../server/lib/access.mjs';
import { createRealtime } from '../server/app/realtime.mjs';
import { fail, errorBody } from '../server/app/http.mjs';
import { loadModules } from '../server/app/modules.mjs';

const AT = 1_767_225_600_000;

// Base real con el esquema completo, el CRM de verdad (para `canBrand`) y la regla de visibilidad del servidor.
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-realtime-'));
  const db = openDatabase(dir);
  migrate(db, { backup: false });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const crm = createCRM({
    db,
    body: async () => ({}),
    json() {},
    audit() {},
    passwordHash: async () => '',
    checkPassword: async () => false,
    rate() {},
    disconnect() {},
    broadcast() {},
  });
  let number = 100200;
  const user = (id, role, brands = []) => {
    db.prepare(
      'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
    ).run(id, id, 'Prueba ' + id, 'sal:hash', role, ++number, 1, 1);
    for (const brand of brands) db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(id, brand);
    return db.prepare('SELECT * FROM users WHERE id=?').get(id);
  };
  const people = {
    admin: user('u-admin', 'admin'),
    vet: user('u-vet', 'agent', ['globalvet']),
    dental: user('u-dental', 'agent', ['odonteck']),
    ana: user('u-ana', 'customer'), // la persona que escribe en la conversación de prueba
    luis: user('u-luis', 'customer'), // otra persona, sin relación con esa conversación
  };
  db.prepare(
    'INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
  ).run('c-aves', people.ana.id, 'globalvet', 'aves', 'whatsapp', 1, 1);
  // La misma regla que canSee() de server/index.mjs.
  const canSee = (c, person) => !person.disabled && (c.customer_id === person.id || crm.canBrand(person, c.brand_id));
  return { db, crm, canSee, people };
}

test('realtime.emit: sobre v2 exacto, y sin marca ni conversación válidas no se envía a nadie', async t => {
  const { db, crm, canSee, people } = await setup(t);
  const sessions = new Map();
  const tab = (person, extra = {}) => {
    const socket = { readyState: 1, got: [], send: text => socket.got.push(text), ...extra };
    sessions.set(socket, { ...person, expires_at: AT + 60_000 });
    return socket;
  };
  const admin = tab(people.admin);
  const realtime = createRealtime({ db, crm, sessions, canSee, now: () => AT });

  assert.equal(realtime.emit('campaign.progress', { brandId: 'globalvet', data: { sent: 120, total: 400 } }), 1);
  assert.equal(admin.got.length, 1);
  assert.equal(typeof admin.got[0], 'string');
  const envelope = JSON.parse(admin.got[0]);
  assert.deepEqual(envelope, {
    v: 2,
    type: 'campaign.progress',
    at: AT,
    brandId: 'globalvet',
    conversationId: null,
    data: { sent: 120, total: 400 },
  });
  assert.deepEqual(Object.keys(envelope), ['v', 'type', 'at', 'brandId', 'conversationId', 'data']);

  // Con conversación: el sobre lleva su marca aunque no se diga; sin `data`, un objeto vacío.
  assert.equal(realtime.emit('thread.note', { conversationId: 'c-aves' }), 1);
  assert.deepEqual(JSON.parse(admin.got[1]), {
    v: 2,
    type: 'thread.note',
    at: AT,
    brandId: 'globalvet',
    conversationId: 'c-aves',
    data: {},
  });
  assert.equal(realtime.emit('thread.note', { conversationId: 'c-aves', brandId: 'globalvet', data: { a: 1 } }), 1);
  for (const type of ['read', 'inbox.upsert', 'job.progress', 'a_b.c_d1.e'])
    assert.equal(realtime.emit(type, { brandId: 'globalvet' }), 1, type);
  admin.got.length = 0;

  // No hay a quién: falta el alcance, la marca o la conversación no existen, o no se corresponden.
  for (const target of [
    undefined,
    null,
    {},
    { data: { a: 1 } },
    { brandId: '' },
    { brandId: 7 },
    { brandId: 'no-existe' },
    { conversationId: 'c-no-existe' },
    { conversationId: 7 },
    { conversationId: {} },
    { conversationId: '', brandId: 'globalvet' },
    { conversationId: 'c-aves', brandId: 'odonteck' },
    { conversationId: 'c-no-existe', brandId: 'globalvet' },
  ])
    assert.equal(realtime.emit('campaign.progress', target), 0, JSON.stringify(target));
  assert.deepEqual(admin.got, []);

  // Un tipo o una carga mal formados son un error de quien programa.
  for (const type of ['', 'Campaign.progress', 'campaign progress', 'campaign-progress', '.x', 'x.', 'x..y', '1x'])
    assert.throws(() => realtime.emit(type, { brandId: 'globalvet' }), /minúsculas con puntos/, type);
  for (const type of [7, null, undefined, ['x'], 'a'.repeat(61)])
    assert.throws(() => realtime.emit(type, { brandId: 'globalvet' }), TypeError);
  for (const data of [null, 'texto', 5, ['a']])
    assert.throws(() => realtime.emit('x.y', { brandId: 'globalvet', data }), /debe ser un objeto/);
  const loop = {};
  loop.self = loop;
  for (const data of [loop, { big: 10n }])
    assert.throws(() => realtime.emit('x.y', { brandId: 'globalvet', data }), /escribirse como JSON/);
  assert.deepEqual(admin.got, []);
  for (const missing of [
    { db, crm, sessions },
    { db, crm, canSee },
    { db, sessions, canSee },
    { crm, sessions, canSee },
  ])
    assert.throws(() => createRealtime(missing), /necesita/);

  // Sockets que no cuentan: cerrados, de una sesión vencida, de una cuenta suspendida o borrada, o que fallan al enviar.
  const closing = tab(people.admin, { readyState: 2 });
  const closed = tab(people.admin, { readyState: 3 });
  const expired = tab(people.admin);
  sessions.get(expired).expires_at = AT - 1;
  let attempts = 0;
  tab(people.vet, {
    send() {
      attempts++;
      throw new Error('socket cerrado');
    },
  });
  const second = tab(people.vet); // va después del que falla: tiene que recibir igual
  const gone = tab({ ...people.vet, id: 'u-borrada' });
  assert.equal(realtime.emit('x.y', { brandId: 'globalvet' }), 2, 'administración y la segunda pestaña del asesor');
  assert.deepEqual(
    [admin, closing, closed, expired, second, gone].map(socket => socket.got.length),
    [1, 0, 0, 0, 1, 0],
  );
  assert.equal(attempts, 1, 'al socket que falla se le intentó enviar y no cuenta como entregado');
  db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(people.vet.id);
  assert.equal(realtime.emit('x.y', { brandId: 'globalvet' }), 1, 'la suspensión vale aunque el socket siga abierto');
  assert.deepEqual([second.got.length, attempts], [1, 1]);

  // Una cuenta suspendida o borrada no recibe ni aunque la regla de visibilidad que se le pase dijera que sí.
  const lax = createRealtime({ db, crm, sessions, canSee: () => true, now: () => AT });
  const ana = tab(people.ana);
  const erased = tab({ ...people.ana, id: 'u-borrada' });
  const toAll = () => lax.emit('thread.message', { conversationId: 'c-aves', includeCustomer: true });
  assert.equal(toAll(), 2, 'administración y la persona que escribe');
  db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(people.ana.id);
  assert.equal(toAll(), 1);
  assert.deepEqual([ana.got.length, erased.got.length, gone.got.length, second.got.length], [1, 0, 0, 1]);
});

test('realtime.emit con sockets reales: sólo llega a quien puede ver esa marca o esa conversación', async t => {
  const { db, crm, canSee, people } = await setup(t);
  const sessions = new Map();
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const id = new URL(req.url, 'http://localhost').searchParams.get('user');
    wss.handleUpgrade(req, socket, head, ws => {
      sessions.set(ws, { ...db.prepare('SELECT * FROM users WHERE id=?').get(id), expires_at: Date.now() + 60_000 });
      ws.on('close', () => sessions.delete(ws));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.ws.terminate();
    wss.close();
    await new Promise(done => server.close(done));
  });
  const connect = async person => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/realtime?user=${person.id}`);
    const client = { ws, inbox: [], waiting: new Map() };
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.mark === undefined) return client.inbox.push(message);
      client.waiting.get(message.mark)?.();
    });
    await once(ws, 'open');
    clients.push(client);
    return client;
  };
  // Tras emitir, el servidor manda una marca a cada socket: al recibirla, el cliente ya tiene todo lo anterior.
  let marks = 0;
  const settle = async () => {
    const mark = ++marks;
    const done = clients.map(client => new Promise(resolve => client.waiting.set(mark, resolve)));
    for (const ws of sessions.keys()) ws.send(JSON.stringify({ mark }));
    await Promise.all(done);
  };
  const types = client => client.inbox.map(message => message.type);

  const admin = await connect(people.admin);
  const vet = await connect(people.vet);
  const vetOtherTab = await connect(people.vet);
  const dental = await connect(people.dental);
  const ana = await connect(people.ana);
  const luis = await connect(people.luis);
  assert.equal(sessions.size, 6);
  const realtime = createRealtime({ db, crm, sessions, canSee });

  // Una marca: su equipo y administración. Ni el equipo de otra marca ni ningún cliente.
  const before = Date.now();
  assert.equal(realtime.emit('campaign.progress', { brandId: 'globalvet', data: { sent: 1, total: 9 } }), 3);
  assert.equal(realtime.emit('channel.health', { brandId: 'odonteck', data: { quality: 'green' } }), 2);
  await settle();
  assert.deepEqual(types(admin), ['campaign.progress', 'channel.health']);
  assert.deepEqual(types(vet), ['campaign.progress']);
  assert.deepEqual(types(vetOtherTab), ['campaign.progress']);
  assert.deepEqual(types(dental), ['channel.health']);
  assert.deepEqual([types(ana), types(luis)], [[], []]);
  const got = vet.inbox[0];
  assert.deepEqual(
    { ...got, at: 0 },
    { v: 2, type: 'campaign.progress', at: 0, brandId: 'globalvet', conversationId: null, data: { sent: 1, total: 9 } },
  );
  assert.ok(got.at >= before && got.at <= Date.now());

  // Una conversación: el equipo que la ve. La persona que escribe, sólo si el módulo lo pide; otra persona, nunca.
  for (const client of clients) client.inbox.length = 0;
  assert.equal(realtime.emit('thread.note', { conversationId: 'c-aves', data: { noteId: 'n1' } }), 3);
  await settle();
  assert.deepEqual([admin, vet, vetOtherTab].map(types), [['thread.note'], ['thread.note'], ['thread.note']]);
  assert.deepEqual([dental, ana, luis].map(types), [[], [], []]);
  assert.equal(vet.inbox[0].brandId, 'globalvet');
  assert.equal(vet.inbox[0].conversationId, 'c-aves');
  assert.equal(
    realtime.emit('thread.message', { conversationId: 'c-aves', data: { seq: 7 }, includeCustomer: true }),
    4,
  );
  await settle();
  assert.deepEqual(types(ana), ['thread.message']);
  assert.deepEqual(types(vet), ['thread.note', 'thread.message']);
  assert.deepEqual([types(dental), types(luis)], [[], []]);

  // El acceso se decide al emitir: quitarle la marca al asesor lo deja fuera sin que tenga que reconectarse.
  for (const client of clients) client.inbox.length = 0;
  db.prepare('DELETE FROM brand_members WHERE user_id=?').run(people.vet.id);
  db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(people.dental.id, 'globalvet');
  assert.equal(realtime.emit('campaign.progress', { brandId: 'globalvet' }), 2);
  assert.equal(realtime.emit('thread.note', { conversationId: 'c-aves' }), 2);
  await settle();
  assert.deepEqual(types(admin), ['campaign.progress', 'thread.note']);
  assert.deepEqual(types(dental), ['campaign.progress', 'thread.note']);
  assert.deepEqual([vet, vetOtherTab, ana, luis].map(types), [[], [], [], []]);

  // Un socket que se cierra deja de contar.
  dental.ws.close();
  await once(dental.ws, 'close');
  while (sessions.size > 5) await new Promise(done => setTimeout(done, 5));
  clients.splice(clients.indexOf(dental), 1);
  assert.equal(realtime.emit('campaign.progress', { brandId: 'globalvet' }), 1);
});

test('la interfaz actual ignora los sobres v2 y sigue recargando con los avisos de siempre', async () => {
  // Se ejecuta el oyente real de public/app.js con dobles de lo que usa (no hay navegador en las pruebas).
  const source = await readFile('public/app.js', 'utf8');
  const from = source.indexOf('thisSocket.onmessage = ');
  const to = source.indexOf('thisSocket.onclose');
  assert.ok(from > 0 && to > from, 'el oyente de WebSocket sigue en public/app.js');
  // El texto que se evalúa es el de este repositorio (el mismo que corre en el navegador), en un contexto aparte
  // que sólo tiene lo que el oyente usa.
  const code = source
    .slice(from + 'thisSocket.onmessage = '.length, to)
    .trim()
    .replace(/;$/, '');
  const calls = { refresh: 0, typing: 0, notified: [] };
  const state = { user: { id: 'yo' }, typing: {} };
  const live = {};
  const handler = (window, socket = live) =>
    runInNewContext('(' + code + ')', {
      socket,
      thisSocket: live,
      state,
      updateTyping: () => calls.typing++,
      scheduleRefresh: () => calls.refresh++,
      window,
    });
  const say = (onmessage, event) => onmessage({ data: typeof event === 'string' ? event : JSON.stringify(event) });
  const plain = value => JSON.parse(JSON.stringify(value)); // lo creado dentro del contexto, como objetos de aquí
  const v2 = { v: 2, type: 'campaign.progress', at: AT, brandId: 'globalvet', conversationId: null, data: { sent: 1 } };

  // Sin pantallas nuevas cargadas: un sobre v2 no hace nada. Antes, cualquier mensaje recargaba todo.
  const classic = handler({});
  say(classic, v2);
  say(classic, { ...v2, type: 'crm' });
  say(classic, { ...v2, type: 'typing', userId: 'otra', conversationId: 'c1' });
  assert.deepEqual([calls.refresh, calls.typing, plain(state.typing)], [0, 0, {}]);

  // Con el registro de pantallas: se le entrega el sobre tal cual, y tampoco se recarga.
  const screens = handler({ TC: { screens: { notify: event => calls.notified.push(event) } } });
  say(screens, v2);
  assert.deepEqual(plain(calls.notified), [v2]);
  assert.equal(calls.refresh, 0);
  for (const window of [{ TC: {} }, { TC: { screens: {} } }, { TC: { screens: { notify: null } } }])
    say(handler(window), v2);
  const failing = handler({
    TC: {
      screens: {
        notify() {
          throw new Error('pantalla rota');
        },
      },
    },
  });
  say(failing, v2);
  assert.equal(calls.refresh, 0, 'una pantalla que falla no provoca una recarga');

  // Los avisos de siempre siguen igual.
  for (const type of ['conversation', 'crm', 'catalog', 'presence', 'read'])
    say(classic, { type, conversationId: null });
  assert.equal(calls.refresh, 5);
  say(classic, { type: 'connected', user: { id: 'yo' } });
  assert.equal(calls.refresh, 5);
  say(classic, { type: 'typing', userId: 'otra', conversationId: 'c1', name: 'Ana', expiresAt: 99 });
  say(classic, { type: 'typing', userId: 'yo', conversationId: 'c2', name: 'Yo', expiresAt: 99 });
  assert.deepEqual([calls.refresh, calls.typing, plain(state.typing)], [5, 1, { c1: { name: 'Ana', until: 99 } }]);
  say(classic, '{no es json');
  say(handler({}, {}), { type: 'crm' }); // un socket anterior ya sustituido no cuenta
  assert.equal(calls.refresh, 5);
  assert.deepEqual(plain(calls.notified), [v2]);
});

test('un módulo usa access, realtime y fail tal como se los presta el servidor', async t => {
  const { db, crm, canSee, people } = await setup(t);
  const sessions = new Map();
  const tab = person => {
    const socket = { readyState: 1, got: [], send: text => socket.got.push(JSON.parse(text)) };
    sessions.set(socket, { ...person, expires_at: Date.now() + 60_000 });
    return socket;
  };
  const sockets = { admin: tab(people.admin), vet: tab(people.vet), dental: tab(people.dental), ana: tab(people.ana) };
  const dir = await mkdtemp(join(tmpdir(), 'crm-realtime-module-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(join(dir, 'avisos'));
  await writeFile(
    join(dir, 'avisos', 'module.mjs'),
    `export default {
  name: 'avisos',
  create(host) {
    return {
      async handle(req, res, path, user, url) {
        const brandId = url.searchParams.get('brand');
        if (path === '/api/avisos/progreso') {
          host.access.require(user, 'campaigns.send', brandId);
          const sockets = host.realtime.emit('campaign.progress', { brandId, data: { sent: 3, total: 9 } });
          host.json(res, 200, { sockets });
          return true;
        }
        if (path === '/api/avisos/contactos') {
          host.access.require(user, 'contacts.view', brandId);
          const scope = host.access.scopeSql(user, 'k');
          const rows = host.db.prepare('SELECT k.id FROM courses k WHERE ' + scope.sql + ' ORDER BY k.id').all(...scope.args);
          host.json(res, 200, { courses: rows.map(row => row.id), phone: host.access.phone(user, '+52 55 1234 5678', brandId) });
          return true;
        }
        if (path === '/api/avisos/guardar')
          throw host.fail(409, 'Otra persona cambió esta difusión. Vuelve a abrirla.', {
            code: 'stale_record',
            field: 'expectedRevision',
            details: { revision: 4 },
          });
        return false;
      },
    };
  },
};
`,
  );
  const replies = [];
  const modules = await loadModules({
    dir,
    strict: true,
    test: true,
    host: {
      db,
      fail,
      json: (res, status, data) => replies.push({ status, ...data }),
      access: createAccess({ db, crm }),
      realtime: createRealtime({ db, crm, sessions, canSee }),
      services: { crm },
    },
  });
  // Lo que hace el servidor con cada petición: llama al módulo y, si lanza, responde con errorBody.
  const call = async (path, person) => {
    try {
      const url = new URL('http://localhost' + path);
      assert.equal(await modules.handle({ method: 'GET' }, {}, url.pathname, person, url), true, path);
      return replies.pop();
    } catch (error) {
      return { status: error.status ?? 500, ...errorBody(error) };
    }
  };

  // Administración puede enviar la difusión: el aviso llega al equipo de esa marca y a nadie más.
  assert.deepEqual(await call('/api/avisos/progreso?brand=globalvet', people.admin), { status: 200, sockets: 2 });
  assert.deepEqual(
    Object.fromEntries(Object.entries(sockets).map(([name, socket]) => [name, socket.got.map(event => event.type)])),
    { admin: ['campaign.progress'], vet: ['campaign.progress'], dental: [], ana: [] },
  );
  assert.deepEqual(sockets.vet.got[0].data, { sent: 3, total: 9 });
  // El asesor no tiene ese permiso; y sin marca, o con una ajena, no hay acceso ni para lo que sí puede hacer.
  assert.deepEqual(await call('/api/avisos/progreso?brand=globalvet', people.vet), {
    status: 403,
    error: 'Tu acceso no incluye «Programar, pausar, reanudar y cancelar difusiones».',
    code: 'permission_denied',
    details: { permission: 'campaigns.send' },
  });
  for (const path of ['/api/avisos/contactos?brand=odonteck', '/api/avisos/contactos'])
    assert.deepEqual(await call(path, people.vet), {
      status: 404,
      error: 'Marca o registro no disponible.',
      code: 'not_found',
    });
  assert.equal(sockets.vet.got.length, 1, 'una petición rechazada no emite nada');
  assert.deepEqual(await call('/api/avisos/contactos?brand=globalvet', people.vet), {
    status: 200,
    courses: ['aves', 'nutricion'],
    phone: '+52 55 1234 5678',
  });
  assert.deepEqual(await call('/api/avisos/contactos?brand=globalvet', people.ana), {
    status: 403,
    error: 'Esta acción es para el equipo de atención.',
    code: 'permission_denied',
  });
  // fail con code, field y details llega completo a la respuesta.
  assert.deepEqual(await call('/api/avisos/guardar', people.admin), {
    status: 409,
    error: 'Otra persona cambió esta difusión. Vuelve a abrirla.',
    code: 'stale_record',
    field: 'expectedRevision',
    details: { revision: 4 },
  });

  // El servidor de verdad presta estas mismas piezas (server/index.mjs).
  const entry = await readFile('server/index.mjs', 'utf8');
  const lent = entry.slice(entry.indexOf('  host: {'), entry.indexOf('    services: {'));
  for (const name of ['fail', 'access', 'realtime', 'broadcast', 'json', 'db'])
    assert.match(lent, new RegExp('^\\s+' + name + ',$', 'm'), name + ' en el host de los módulos');
  assert.match(entry, /^import \{ fail, errorBody \} from '\.\/app\/http\.mjs';$/m);
  assert.doesNotMatch(entry, /^const fail\b/m, 'fail ya no se define en server/index.mjs');
  assert.match(entry, /^const access = createAccess\(\{ db, crm \}\);$/m);
  assert.match(entry, /^const realtime = createRealtime\(\{ db, crm, sessions, canSee \}\);$/m);
});
