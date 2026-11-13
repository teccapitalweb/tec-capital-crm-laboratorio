import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isPrivateAddress, assertPublicUrl, signWebhook, verifyWebhook, EVENT_NEEDS } from '../server/integrations.mjs';
import { EVENT_TYPES } from '../server/events.mjs';

test('destinos de webhooks: se rechazan las redes privadas e internas, y la firma se verifica con tolerancia de tiempo', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '198.18.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'ff02::1',
    'no-es-ip',
    // IPv6: se niega por omisión todo lo que no sea unicast global (2000::/3) y las formas que incrustan un IPv4 o son de documentación
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    '64:ff9b::808:808',
    '2002:7f00:1::1',
    '2002:a9fe:a9fe::1',
    '2002:c0a8:101::1',
    '2001:db8::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:1::1',
    '100::1',
    'fec0::1',
    '::127.0.0.1',
    '::10.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '3fff::1',
    '0:0:0:0:0:ffff:7f00:1',
    '[::1]'.slice(1, -1),
    'fe80::1%eth0',
    'febf::1',
    'fc00::',
    'fdff:ffff::1',
    '1::1',
    '4000::1',
    '8000::1',
    'c000::1',
    'e000::1',
  ])
    assert.equal(isPrivateAddress(ip), true, ip + ' debe ser privada');
  for (const ip of [
    '93.184.216.34',
    '8.8.8.8',
    '172.32.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    '2a00:1450:4001:81a::200e',
    '2001:4860:4860::8888',
    '2002:808:808::1',
    '2620:fe::fe',
    '2400:cb00::1',
  ])
    assert.equal(isPrivateAddress(ip), false, ip + ' es pública');
  const pub = async () => [{ address: '93.184.216.34' }],
    priv = async () => [{ address: '10.0.0.8' }],
    mixed = async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }],
    gone = async () => {
      throw Error('ENOTFOUND');
    };
  assert.equal(await assertPublicUrl('https://hooks.ejemplo.com/in', { lookup: pub }), 'https://hooks.ejemplo.com/in');
  for (const [url, opts, re] of [
    ['no es una url', { lookup: pub }, /no es válida/],
    ['http://hooks.ejemplo.com/in', { lookup: pub }, /HTTPS/],
    ['https://usuario:clave@hooks.ejemplo.com/in', { lookup: pub }, /usuario ni contraseña/],
    ['https://localhost/in', { lookup: pub }, /red interna/],
    ['https://servicio.internal/in', { lookup: pub }, /red interna/],
    ['https://impresora.local/in', { lookup: pub }, /red interna/],
    ['https://127.0.0.1/in', { lookup: pub }, /red privada/],
    ['https://169.254.169.254/latest/meta-data', { lookup: pub }, /red privada/],
    ['https://[::1]/in', { lookup: pub }, /red privada/],
    ['https://10.0.0.5/in', { lookup: pub }, /red privada/],
    ['https://hooks.ejemplo.com/in', { lookup: priv }, /red privada/],
    ['https://hooks.ejemplo.com/in', { lookup: mixed }, /red privada/],
    ['https://no-existe.ejemplo.com/in', { lookup: gone }, /No se pudo resolver/],
    ['https://hooks.ejemplo.com/' + 'a'.repeat(600), { lookup: pub }, /demasiado larga/],
  ])
    await assert.rejects(assertPublicUrl(url, opts), e => e.status === 400 && re.test(e.message), url);
  assert.deepEqual(
    Object.keys(EVENT_TYPES).filter(t => !EVENT_NEEDS[t]),
    [],
    'todo tipo de evento está clasificado para la API de lectura',
  );
  assert.ok(Object.values(EVENT_NEEDS).every(s => ['orders', 'contacts', 'editions'].includes(s)));
  assert.equal(
    await assertPublicUrl('http://127.0.0.1:4000/in', { allowPrivate: true, allowInsecure: true }),
    'http://127.0.0.1:4000/in',
    'sólo con el permiso explícito de pruebas',
  );
  // firma
  const raw = '{"id":"evt_1"}',
    t = String(Math.floor(Date.now() / 1000)),
    sig = 't=' + t + ',v1=' + signWebhook('whsec_x', t, raw);
  assert.equal(verifyWebhook('whsec_x', sig, raw), true);
  assert.equal(verifyWebhook('whsec_otro', sig, raw), false);
  assert.equal(verifyWebhook('whsec_x', sig, raw + ' '), false);
  assert.equal(
    verifyWebhook(
      'whsec_x',
      't=' + (Number(t) - 3600) + ',v1=' + signWebhook('whsec_x', String(Number(t) - 3600), raw),
      raw,
    ),
    false,
    'firma vieja',
  );
  assert.equal(verifyWebhook('whsec_x', 'basura', raw), false);
  assert.equal(verifyWebhook('', sig, raw), false);
});

test('API pública y webhooks: llaves por marca con permisos, lectura paginada, entrega firmada con reintento, destino pausado, desactivación y alcance', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-integ-')),
    code = randomUUID(),
    password = 'Password-integ-2026!';
  let logs = '';
  const server = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dir,
      ADMIN_INVITE_CODE: code,
      APP_ORIGIN: '',
      NODE_ENV: 'test',
      WEBHOOK_ALLOW_PRIVATE: '1',
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
  // receptor de webhooks en este proceso
  const hits = [];
  let respond = () => 200;
  const rx = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      const status = respond(req, b);
      hits.push({ url: req.url, headers: req.headers, body: b, status });
      res.statusCode = status;
      res.end('ok');
    });
  });
  await new Promise(r => rx.listen(0, '127.0.0.1', r));
  const hook = 'http://127.0.0.1:' + rx.address().port + '/hook';
  t.after(async () => {
    rx.close();
    if (server.exitCode === null)
      await new Promise(r => {
        server.once('exit', r);
        server.kill();
      });
    await rm(dir, { recursive: true, force: true });
  });
  async function call(
    path,
    cookie = '',
    body,
    method = body === undefined ? 'GET' : 'POST',
    expected = 200,
    headers = {},
  ) {
    const r = await fetch(origin + path, {
      method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(result));
    return { ...result, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function until(fn, tries = 40) {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (v) return v;
      await sleep(150);
    }
    return v;
  }
  const db = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  const admin = await call('/api/auth/register', '', {
    username: 'admin',
    name: 'Administración',
    password,
    inviteCode: code,
  });
  const colega = await (async () => {
    const u = await call('/api/auth/register', '', { username: 'colega', name: 'Colega', password });
    const inv = await call(
      '/api/team/invites',
      admin.cookie,
      { username: 'colega', brandIds: ['globalvet'] },
      'POST',
      201,
    );
    await call('/api/team/accept', u.cookie, { token: inv.token });
    return u;
  })();
  const ana = await call('/api/auth/register', '', { username: 'ana', name: 'Ana Pérez', password });
  await call(
    '/api/payments/brands/globalvet',
    admin.cookie,
    { enabled: true, linkHours: 48, expectedRevision: 0 },
    'PATCH',
  );
  const bearer = token => ({ Authorization: 'Bearer ' + token });
  const api = (path, token, expected = 200) => call(path, '', undefined, 'GET', expected, token ? bearer(token) : {});

  // administración: sólo administración
  await call('/api/integrations', '', undefined, 'GET', 401);
  await call('/api/integrations', ana.cookie, undefined, 'GET', 403);
  await call('/api/integrations', colega.cookie, undefined, 'GET', 403);
  await call(
    '/api/integrations/keys',
    colega.cookie,
    { brandId: 'globalvet', name: 'x', scopes: ['events'] },
    'POST',
    403,
  );
  await call('/api/integrations/webhooks', colega.cookie, { brandId: 'globalvet', url: hook }, 'POST', 403);
  // llaves: validación, el valor completo sólo se muestra al crear
  const mkKey = (over = {}, expected = 201) =>
    call(
      '/api/integrations/keys',
      admin.cookie,
      { brandId: 'globalvet', name: 'Panel interno', scopes: ['events', 'orders', 'contacts', 'editions'], ...over },
      'POST',
      expected,
    );
  await mkKey({ name: ' ' }, 400);
  await mkKey({ scopes: [] }, 400);
  await mkKey({ scopes: ['todo'] }, 400);
  await mkKey({ scopes: 'events' }, 400);
  await mkKey({ brandId: 'no-existe' }, 400);
  const full = await mkKey();
  assert.match(full.token, /^tcw_[A-Za-z0-9_-]{32}$/);
  assert.equal(full.key.prefix, full.token.slice(0, 10));
  assert.deepEqual(full.key.scopes, ['events', 'orders', 'contacts', 'editions']);
  const listing = JSON.stringify(await call('/api/integrations', admin.cookie));
  assert.ok(!listing.includes(full.token), 'el valor de la llave no vuelve a mostrarse');
  assert.ok(!listing.includes('key_hash'));
  assert.ok(
    !JSON.stringify(db.prepare('SELECT * FROM api_keys').all()).includes(full.token),
    'en la base sólo queda el hash',
  );
  const onlyEvents = await mkKey({ name: 'Sólo eventos', scopes: ['events'] });
  const otherBrand = await mkKey({ brandId: 'odonteck', name: 'Otra marca' });

  // API v1: sin llave, llave mala, método, permisos, marca
  await api('/api/v1/me', '', 401);
  await api('/api/v1/me', 'tcw_noexiste1234567890123456789012', 401);
  await call('/api/v1/me', '', undefined, 'GET', 401, { Authorization: 'Basic abc' });
  await call('/api/v1/events', '', {}, 'POST', 405, bearer(full.token));
  const me = await api('/api/v1/me', full.token);
  assert.equal(me.brand.id, 'globalvet');
  assert.equal(me.key.prefix, full.key.prefix);
  assert.ok(me.eventTypes.includes('pago.confirmado'));
  assert.equal(me.eventScopes['pago.confirmado'], 'orders');
  await api('/api/v1/orders', onlyEvents.token, 403);
  await api('/api/v1/contacts', onlyEvents.token, 403);
  await api('/api/v1/editions', onlyEvents.token, 403);
  await api('/api/v1/nada', full.token, 404);
  assert.ok(
    db.prepare('SELECT last_used_at FROM api_keys WHERE id=?').get(full.key.id).last_used_at,
    'se registra el último uso',
  );

  // eventos: una conversación nueva publica un hecho de la marca; la API lo entrega con paginación, filtro y aislamiento por marca
  const conv = (await call('/api/conversations', ana.cookie, { courseId: 'aves', channel: 'whatsapp' })).conversation;
  await call(
    '/api/conversations/' + conv.id + '/messages',
    ana.cookie,
    { text: 'Hola, quiero informes', clientRef: randomUUID() },
    'POST',
    201,
  );
  const ev1 = await api('/api/v1/events', full.token);
  const opened = ev1.events.find(e => e.type === 'conversacion.abierta');
  assert.ok(opened, 'evento de conversación abierta');
  assert.equal(opened.brandId, 'globalvet');
  assert.equal(opened.id, 'evt_' + opened.seq);
  assert.equal(opened.apiVersion, '1');
  assert.equal(opened.entity.kind, 'conversation');
  assert.ok(new Date(opened.createdAt).getTime() > 0);
  assert.equal(opened.data.courseId, 'aves');
  const p1 = await api('/api/v1/events?limit=1', full.token);
  assert.equal(p1.events.length, 1);
  assert.equal(p1.hasMore, true);
  const p2 = await api('/api/v1/events?limit=1&after=' + p1.next, full.token);
  assert.ok(p2.events.length === 0 || p2.events[0].seq > p1.events[0].seq);
  assert.ok(
    (await api('/api/v1/events?type=conversacion.abierta', full.token)).events.every(
      e => e.type === 'conversacion.abierta',
    ),
  );
  await api('/api/v1/events?type=inventado', full.token, 400);
  assert.equal(
    (await api('/api/v1/events', otherBrand.token)).events.length,
    0,
    'otra marca no ve los eventos de GlobalVet',
  );
  // permisos: con sólo «events» se ve el sobre, pero el contenido de un tipo exige además su permiso (contacts, orders o editions)
  const slim = (await api('/api/v1/events', onlyEvents.token)).events.find(e => e.type === 'conversacion.abierta');
  assert.ok(slim, 've que ocurrió');
  assert.deepEqual(slim.data, {});
  assert.equal(slim.redacted, true);
  assert.equal(slim.requires, 'contacts');
  assert.equal(slim.brandId, 'globalvet');
  assert.ok(
    !JSON.stringify(slim).includes('courseId') && !JSON.stringify(slim).includes('aves'),
    'no se filtra el contenido',
  );
  assert.equal(opened.redacted, undefined, 'con el permiso se ve completo');
  const withContacts = await mkKey({ name: 'Eventos y contactos', scopes: ['events', 'contacts'] });
  assert.equal(
    (await api('/api/v1/events', withContacts.token)).events.find(e => e.type === 'conversacion.abierta').data.courseId,
    'aves',
  );
  assert.equal((await api('/api/v1/events?after=' + ev1.next, full.token)).events.length, 0);

  // contactos, aperturas y pedidos
  const contacts = await api('/api/v1/contacts', full.token);
  assert.ok(
    contacts.contacts.some(c => c.name === 'Ana Pérez'),
    'contacto de la marca',
  );
  assert.equal((await api('/api/v1/contacts', otherBrand.token)).contacts.length, 0);
  const eds = await api('/api/v1/editions', full.token);
  assert.ok(eds.editions.length >= 1 && eds.editions.every(e => e.courseId && e.priceCents >= 0 && e.currency));
  assert.ok(!JSON.stringify(eds).includes('draft'));
  assert.equal(
    (await api('/api/v1/editions', otherBrand.token)).editions.every(e => e.courseId !== 'aves'),
    true,
  );
  assert.deepEqual((await api('/api/v1/orders', full.token)).orders, []);
  await api('/api/v1/orders?status=raro', full.token, 400);

  // destinos de webhooks: validación y secreto mostrado una vez
  const mkHook = (over = {}, expected = 201) =>
    call(
      '/api/integrations/webhooks',
      admin.cookie,
      {
        brandId: 'globalvet',
        url: hook,
        description: 'Receptor de pruebas',
        events: ['pedido.creado', 'pago.confirmado'],
        ...over,
      },
      'POST',
      expected,
    );
  await mkHook({ url: 'no-url' }, 400);
  await mkHook({ events: ['evento.inventado'] }, 400);
  await mkHook({ brandId: 'no-existe' }, 400);
  await mkHook({ url: 'https://usuario:clave@ejemplo.com/in' }, 400);
  const wh = await mkHook();
  assert.match(wh.secret, /^whsec_[A-Za-z0-9_-]{32}$/);
  assert.equal(wh.endpoint.status, 'active');
  assert.deepEqual(wh.endpoint.events, ['pedido.creado', 'pago.confirmado']);
  assert.equal(wh.endpoint.secretHint, '…' + wh.secret.slice(-4));
  assert.ok(
    !JSON.stringify(await call('/api/integrations?brand=globalvet', admin.cookie)).includes(wh.secret),
    'el secreto no vuelve a mostrarse',
  );

  // un evento suscrito llega firmado; uno no suscrito no llega
  const o1 = (await call('/api/conversations/' + conv.id + '/orders', admin.cookie, {}, 'POST', 201)).order;
  {
    const ordersEv = (await api('/api/v1/events?type=pedido.creado', onlyEvents.token)).events;
    assert.ok(
      ordersEv.length >= 1 &&
        ordersEv.every(
          e =>
            e.redacted &&
            e.requires === 'orders' &&
            Object.keys(e.data).length === 0 &&
            !JSON.stringify(e).includes(o1.reference),
        ),
      'los pedidos no salen por una llave sin permiso de pedidos',
    );
    assert.equal((await api('/api/v1/events?type=pedido.creado', full.token)).events[0].data.reference, o1.reference);
  }
  const got = await until(() => hits.find(h => h.headers['tc-event'] === 'pedido.creado'));
  assert.ok(got, 'llegó pedido.creado');
  assert.equal(got.url, '/hook');
  assert.match(got.headers['tc-delivery'], /^[a-f0-9-]{36}$/);
  assert.equal(got.headers['user-agent'], 'TEC-Capital-Webhooks/1');
  assert.match(got.headers['content-type'], /application\/json/);
  assert.equal(
    verifyWebhook(wh.secret, got.headers['tc-signature'], got.body),
    true,
    'la firma verifica con el secreto',
  );
  assert.equal(verifyWebhook('whsec_otro', got.headers['tc-signature'], got.body), false);
  const payload = JSON.parse(got.body);
  assert.equal(payload.type, 'pedido.creado');
  assert.equal(payload.brandId, 'globalvet');
  assert.equal(payload.entity.kind, 'order');
  assert.equal(payload.entity.id, o1.id);
  assert.equal(payload.data.reference, o1.reference);
  assert.equal(payload.data.amountCents, 37900);
  assert.match(payload.id, /^evt_\d+$/);
  assert.ok(
    !hits.some(h => h.headers['tc-event'] === 'conversacion.abierta'),
    'los eventos fuera del filtro no se envían',
  );
  const orders = await api('/api/v1/orders', full.token);
  assert.equal(orders.orders.length, 1);
  assert.equal(orders.orders[0].reference, o1.reference);
  assert.equal(orders.orders[0].amountCents, 37900);
  assert.equal(orders.orders[0].status, 'pending');
  assert.ok(!('provider_ref' in orders.orders[0]));
  assert.equal((await api('/api/v1/orders?status=paid', full.token)).orders.length, 0);
  assert.equal((await api('/api/v1/orders', otherBrand.token)).orders.length, 0);
  const afterNext = await api('/api/v1/orders?after=' + encodeURIComponent(orders.next), full.token);
  assert.equal(afterNext.orders.length, 0, 'el cursor no repite');

  // reintentos: el destino falla dos veces y luego responde; es la misma entrega (mismo TC-Delivery) y queda hecha con 3 intentos
  let fails = 2;
  respond = () => (fails-- > 0 ? 500 : 200);
  const before = hits.length;
  assert.equal(
    (await call('/api/payments/orders/' + o1.id + '/pay', ana.cookie, { method: 'card' })).order.status,
    'paid',
  );
  const delivered = await until(
    () =>
      db
        .prepare(
          "SELECT d.* FROM webhook_deliveries d JOIN domain_events e ON e.seq=d.event_seq WHERE e.type='pago.confirmado' AND d.state='done'",
        )
        .get(),
    60,
  );
  assert.ok(delivered, 'la entrega termina bien tras reintentar');
  assert.equal(delivered.attempts, 3);
  assert.equal(delivered.last_status, 200);
  const paidHits = hits.slice(before).filter(h => h.headers['tc-event'] === 'pago.confirmado');
  assert.equal(paidHits.length, 3);
  assert.equal(new Set(paidHits.map(h => h.headers['tc-delivery'])).size, 1, 'misma entrega en cada intento');
  assert.deepEqual(
    paidHits.map(h => h.status),
    [500, 500, 200],
  );
  respond = () => 200;
  assert.equal((await api('/api/v1/orders?status=paid', full.token)).orders.length, 1);

  // prueba de conexión y entregas
  const hitsBefore = hits.length;
  const ping = await call('/api/integrations/webhooks/' + wh.endpoint.id + '/test', admin.cookie, {}, 'POST');
  assert.equal(ping.ok, true);
  assert.equal(ping.status, 200);
  const pingHit = hits.at(-1);
  assert.equal(hits.length, hitsBefore + 1);
  assert.equal(pingHit.headers['tc-event'], 'webhook.test');
  assert.equal(verifyWebhook(wh.secret, pingHit.headers['tc-signature'], pingHit.body), true);
  respond = () => 503;
  const bad = await call('/api/integrations/webhooks/' + wh.endpoint.id + '/test', admin.cookie, {}, 'POST');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /503/);
  respond = () => 200;
  const dl = (await call('/api/integrations/webhooks/' + wh.endpoint.id + '/deliveries', admin.cookie)).deliveries;
  assert.ok(dl.length >= 2 && dl.every(d => d.type && d.state));
  await call('/api/integrations/webhooks/' + wh.endpoint.id + '/deliveries', colega.cookie, undefined, 'GET', 403);

  // fallo definitivo: tras 6 intentos queda «failed» con el último código; reintentar manualmente la entrega la rehace
  respond = () => 500;
  const o2conv = (
    await call(
      '/api/conversations',
      (await call('/api/auth/register', '', { username: 'beto', name: 'Beto', password })).cookie,
      { courseId: 'aves', channel: 'whatsapp' },
    )
  ).conversation;
  const o2 = (await call('/api/conversations/' + o2conv.id + '/orders', admin.cookie, {}, 'POST', 201)).order;
  const failed = await until(
    () =>
      db
        .prepare(
          "SELECT d.* FROM webhook_deliveries d JOIN domain_events e ON e.seq=d.event_seq WHERE e.entity_id=? AND d.state='failed'",
        )
        .get(o2.id),
    80,
  );
  assert.ok(failed, 'tras agotar los intentos queda fallida');
  assert.equal(failed.attempts, 6);
  assert.equal(failed.last_status, 500);
  assert.match(failed.error, /500/);
  assert.equal(
    db.prepare('SELECT failure_count FROM webhook_endpoints WHERE id=?').get(wh.endpoint.id).failure_count,
    1,
  );
  respond = () => 200;
  await call('/api/integrations/deliveries/' + failed.id + '/retry', admin.cookie, {}, 'POST');
  assert.ok(
    await until(() => db.prepare('SELECT state FROM webhook_deliveries WHERE id=?').get(failed.id).state === 'done'),
    'el reintento manual la entrega',
  );
  assert.equal(
    db.prepare('SELECT failure_count FROM webhook_endpoints WHERE id=?').get(wh.endpoint.id).failure_count,
    0,
    'una entrega buena reinicia el conteo',
  );
  await call('/api/integrations/deliveries/' + failed.id + '/retry', admin.cookie, {}, 'POST', 409);

  // pausar: los eventos nuevos no se encolan; reanudar los vuelve a enviar
  const cur = () =>
    call('/api/integrations?brand=globalvet', admin.cookie).then(r => r.endpoints.find(e => e.id === wh.endpoint.id));
  await call(
    '/api/integrations/webhooks/' + wh.endpoint.id,
    admin.cookie,
    { status: 'paused', expectedRevision: (await cur()).revision - 1 },
    'PATCH',
    409,
  );
  const paused = (
    await call(
      '/api/integrations/webhooks/' + wh.endpoint.id,
      admin.cookie,
      { status: 'paused', expectedRevision: (await cur()).revision },
      'PATCH',
    )
  ).endpoint;
  assert.equal(paused.status, 'paused');
  const n = hits.length,
    c3 = (
      await call(
        '/api/conversations',
        (await call('/api/auth/register', '', { username: 'cara', name: 'Cara', password })).cookie,
        { courseId: 'aves', channel: 'whatsapp' },
      )
    ).conversation;
  await call('/api/conversations/' + c3.id + '/orders', admin.cookie, {}, 'POST', 201);
  await sleep(900);
  assert.equal(hits.length, n, 'un destino pausado no recibe nada');
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM webhook_deliveries WHERE endpoint_id=? AND created_at>?')
      .get(wh.endpoint.id, Date.now() - 800).n,
    0,
    'ni se encola',
  );
  await call(
    '/api/integrations/webhooks/' + wh.endpoint.id,
    admin.cookie,
    { status: 'bogus', expectedRevision: paused.revision },
    'PATCH',
    400,
  );
  await call(
    '/api/integrations/webhooks/' + wh.endpoint.id,
    admin.cookie,
    { status: 'active', description: 'Receptor reanudado', expectedRevision: paused.revision },
    'PATCH',
  );

  // desactivación automática tras demasiadas fallas seguidas; reactivar la rehabilita
  db.prepare('UPDATE webhook_endpoints SET failure_count=14 WHERE id=?').run(wh.endpoint.id);
  respond = () => 500;
  const c4 = (
    await call(
      '/api/conversations',
      (await call('/api/auth/register', '', { username: 'dani', name: 'Dani', password })).cookie,
      { courseId: 'aves', channel: 'whatsapp' },
    )
  ).conversation;
  await call('/api/conversations/' + c4.id + '/orders', admin.cookie, {}, 'POST', 201);
  assert.ok(
    await until(
      () => db.prepare('SELECT status FROM webhook_endpoints WHERE id=?').get(wh.endpoint.id).status === 'disabled',
      80,
    ),
    'se desactiva solo',
  );
  assert.match((await cur()).disabledReason, /se desactivó tras 15/i);
  respond = () => 200;
  const back = (
    await call(
      '/api/integrations/webhooks/' + wh.endpoint.id,
      admin.cookie,
      { status: 'active', expectedRevision: (await cur()).revision },
      'PATCH',
    )
  ).endpoint;
  assert.equal(back.status, 'active');
  assert.equal(back.failureCount, 0);
  assert.equal(back.disabledReason, null);

  // rotar el secreto: lo nuevo se firma con el nuevo; el anterior ya no verifica
  const rot = await call('/api/integrations/webhooks/' + wh.endpoint.id + '/rotate', admin.cookie, {}, 'POST');
  assert.notEqual(rot.secret, wh.secret);
  const h0 = hits.length;
  const ping2 = await call('/api/integrations/webhooks/' + wh.endpoint.id + '/test', admin.cookie, {}, 'POST');
  assert.equal(ping2.ok, true);
  const sig = hits.at(h0);
  assert.equal(verifyWebhook(rot.secret, sig.headers['tc-signature'], sig.body), true);
  assert.equal(verifyWebhook(wh.secret, sig.headers['tc-signature'], sig.body), false);

  // revocar una llave y borrar un destino
  await call('/api/integrations/keys/' + onlyEvents.key.id + '/revoke', admin.cookie, {}, 'POST');
  await api('/api/v1/me', onlyEvents.token, 401);
  await call('/api/integrations/keys/' + onlyEvents.key.id + '/revoke', admin.cookie, {}, 'POST', 409);
  await call('/api/integrations/webhooks/' + wh.endpoint.id, admin.cookie, undefined, 'DELETE');
  assert.equal(db.prepare('SELECT count(*) n FROM webhook_deliveries WHERE endpoint_id=?').get(wh.endpoint.id).n, 0);
  await call('/api/integrations/webhooks/' + wh.endpoint.id + '/test', admin.cookie, {}, 'POST', 404);
  // otra marca no recibe los hechos de esta: un destino de OdonTeck no se encola con eventos de GlobalVet
  const od = await mkHook({ brandId: 'odonteck', events: ['*'] });
  const hh = hits.length;
  const c5 = (
    await call(
      '/api/conversations',
      (await call('/api/auth/register', '', { username: 'eli', name: 'Eli', password })).cookie,
      { courseId: 'aves', channel: 'whatsapp' },
    )
  ).conversation;
  await call('/api/conversations/' + c5.id + '/orders', admin.cookie, {}, 'POST', 201);
  await sleep(800);
  assert.equal(hits.length, hh);
  // llaves malas repetidas se frenan por IP
  let limited = false;
  for (let i = 0; i < 40 && !limited; i++) {
    const r = await fetch(origin + '/api/v1/me', { headers: bearer('tcw_' + 'x'.repeat(32)) });
    if (r.status === 429) limited = true;
  }
  assert.equal(limited, true, 'frena los intentos con llaves falsas');
  assert.ok(
    db.prepare("SELECT count(*) n FROM audit WHERE action LIKE 'apikey.%' OR action LIKE 'webhook.%'").get().n >= 8,
    'auditoría',
  );
  db.close();
});
