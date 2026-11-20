// Accesos del curso (docs/PLAN_CIERRE_DE_VENTA.md): apagado, todo igual que hoy; con el texto escrito y encendido, quien
// paga recibe solo sus accesos cuando una persona valida su comprobante; un pago de prueba no los entrega salvo que la
// apertura lo permita; un reintento no repite el mensaje; el reenvío lo hace el equipo de la marca; escribir los accesos
// pide administración, revisión y un texto que se pueda enviar tal cual; la migración se aplica sobre una base ya
// publicada. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { SUGGESTION, VARIABLES, problemsOf } from '../server/modules/course-access/module.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';

const MIGRATION = 'course-access/0001-course-access';
const PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
]).toString('base64');
const BODY =
  '¡Te damos la bienvenida, {{nombre}}! Ya tienes tu lugar en {{curso}} · {{edicion}}.\n' +
  'Pedido {{pedido}}. Enlace de las clases: https://clases.example.test/aves\nGuarda este mensaje.';

test('texto de accesos: qué le falta para poder enviarse', () => {
  assert.deepEqual(problemsOf('', {}), ['Escribe el mensaje con los accesos.']);
  assert.match(problemsOf(SUGGESTION, {})[0], /pega aquí/);
  assert.match(problemsOf('Hola {{nombre}}, tu clave es {{clave}} y ya.', {})[0], /\{\{clave\}\}/);
  assert.match(problemsOf('Hola {{nombre, aquí van tus accesos del curso.', {})[0], /sin cerrar/);
  assert.match(problemsOf('Corto {{nombre}}', {})[0], /muy corto/);
  assert.match(problemsOf('Hola {{nombre}}, entra al grupo: {{grupo}}', { group_url: '' })[0], /enlace de grupo/);
  assert.deepEqual(
    problemsOf('Hola {{nombre}}, entra al grupo: {{grupo}}', { group_url: 'https://g.example.test' }),
    [],
  );
  assert.deepEqual(problemsOf(BODY, {}), []);
  for (const v of VARIABLES)
    assert.deepEqual(problemsOf('Dato del curso para ti: {{' + v.key + '}} y listo.', { group_url: 'x' }), []);
});

test('migración course-access/0001: sobre una base ya publicada, ninguna apertura entrega accesos', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-accesos-mig-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== MIGRATION)) });
  assert.ok(db.prepare('SELECT count(*) n FROM editions').get().n >= 1);
  assert.deepEqual(migrate(db, { backup: false }).applied, [MIGRATION]);
  assertSchemaCurrent(db);
  assert.equal(db.prepare('SELECT count(*) n FROM course_access').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM course_access_deliveries').get().n, 0);
  const e = db.prepare('SELECT id,brand_id FROM editions LIMIT 1').get();
  assert.throws(
    () => db.prepare('INSERT INTO course_access(edition_id,brand_id,enabled) VALUES(?,?,2)').run(e.id, e.brand_id),
    /CHECK/,
  );
  assert.deepEqual(migrate(db, { backup: false }).applied, [], 'una sola vez');
});

test('accesos de punta a punta: comprobante validado, entrega automática, pago de prueba, reenvío, permisos y Preparar marca', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-accesos-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code } });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { origin } = server;
  const admin = await registerAdmin(origin, code);
  const register = async (username, name) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  const ana = await register('ana', 'Ana Ruiz');
  const luis = await register('luis', 'Luis Mora');
  const eva = await register('eva', 'Eva Solís');
  const agent = await register('asesor-gv', 'Asesor GlobalVet');
  const outsider = await register('asesor-od', 'Asesor OdonTeck');
  const staff = (username, brand) => {
    const id = db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
    db.prepare("UPDATE users SET role='agent' WHERE id=?").run(id);
    db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(id, brand);
  };
  staff('asesor-gv', 'globalvet');
  staff('asesor-od', 'odonteck');
  for (const brand of ['globalvet', 'odonteck'])
    await call(origin, '/api/payments/brands/' + brand, {
      cookie: admin,
      method: 'PATCH',
      body: { enabled: true, linkHours: 48, expectedRevision: 0 },
    });
  const texts = conversationId =>
    db
      .prepare("SELECT text FROM messages WHERE conversation_id=? AND sender_kind='automation' ORDER BY seq")
      .all(conversationId)
      .map(m => m.text);
  const deliveries = conversationId =>
    db
      .prepare('SELECT * FROM course_access_deliveries WHERE conversation_id=? ORDER BY created_at,rowid')
      .all(conversationId);
  // conversación de un cliente con su pedido creado por el equipo
  const sale = async (cookie, courseId) => {
    const conv = (await call(origin, '/api/conversations', { cookie, body: { courseId, channel: 'whatsapp' } }))
      .conversation;
    const order = (
      await call(origin, '/api/conversations/' + conv.id + '/orders', { cookie: admin, body: {}, expected: 201 })
    ).order;
    return { conv, order };
  };
  const payTest = (cookie, order) =>
    call(origin, '/api/payments/orders/' + order.id + '/pay', { cookie, body: { method: 'card' } });
  const put = (cookie, editionId, body, expected = 200) =>
    call(origin, '/api/course-access/editions/' + editionId, { cookie, method: 'PUT', body, expected });
  const chat = (cookie, conversationId, expected = 200) =>
    call(origin, '/api/course-access/conversations/' + conversationId, { cookie, expected });

  // ---- apagado por omisión: la lista muestra la apertura sin accesos y nadie ha recibido nada
  const first = await sale(ana, 'aves');
  const editionId = first.order.edition_id;
  let view = await call(origin, '/api/course-access?brand=globalvet', { cookie: admin });
  let card = view.editions.find(e => e.editionId === editionId);
  assert.equal(view.canManage, true);
  assert.equal(card.access.state, 'empty');
  assert.equal(card.access.revision, 0);
  assert.equal(view.deliveries.length, 0);
  assert.equal(view.suggestion, SUGGESTION);
  const asAgent = await call(origin, '/api/course-access?brand=globalvet', { cookie: agent });
  assert.equal(asAgent.canManage, false, 'el asesor ve, no escribe');
  assert.equal(asAgent.canSend, true);
  assert.deepEqual((await call(origin, '/api/course-access/brands', { cookie: agent })).brands, [
    { id: 'globalvet', name: 'GlobalVet' },
  ]);
  await call(origin, '/api/course-access/brands', { cookie: ana, expected: 403 });
  await call(origin, '/api/course-access?brand=globalvet', { cookie: outsider, expected: 404 });
  await call(origin, '/api/course-access?brand=globalvet', { cookie: ana, expected: 403 });

  // ---- escribir los accesos: administración, revisión y un texto que se pueda enviar tal cual
  await put(agent, editionId, { enabled: false, body: BODY, expectedRevision: 0 }, 403);
  await put(outsider, editionId, { enabled: false, body: BODY, expectedRevision: 0 }, 404);
  const notReady = await put(admin, editionId, { enabled: true, body: SUGGESTION, expectedRevision: 0 }, 400);
  assert.equal(notReady.code, 'not_ready');
  await put(
    admin,
    editionId,
    { enabled: false, body: 'Hola {{nombre}}, tu clave es {{clave}} y ya.', expectedRevision: 0 },
    400,
  );
  await put(admin, editionId, { enabled: 'sí', body: BODY, expectedRevision: 0 }, 400);
  card = (await put(admin, editionId, { enabled: false, body: SUGGESTION, expectedRevision: 0 })).edition;
  assert.equal(card.access.state, 'off', 'un borrador se guarda como esté');
  assert.match(card.access.problems[0], /pega aquí/);
  await put(admin, editionId, { enabled: true, body: BODY, expectedRevision: 0 }, 409);
  card = (await put(admin, editionId, { enabled: true, body: BODY, expectedRevision: 1 })).edition;
  assert.equal(card.access.state, 'ready');
  assert.equal(card.access.revision, 2);
  assert.deepEqual(card.access.problems, []);
  const same = (await put(admin, editionId, { enabled: true, body: BODY, expectedRevision: 2 })).edition;
  assert.equal(same.access.revision, 2, 'guardar sin cambios no mueve la revisión');
  const preview = await call(origin, '/api/course-access/editions/' + editionId + '/preview', {
    cookie: agent,
    body: { body: BODY },
  });
  assert.match(preview.text, /bienvenida, Ana!/);
  assert.match(preview.text, /TC-EJEMPLO/);
  assert.doesNotMatch(preview.text, /\{\{/);
  assert.deepEqual(preview.problems, []);
  // la fecha de inicio sale como la dice el asistente, sin el nombre técnico de la zona horaria
  db.prepare('UPDATE editions SET starts_at=?,timezone=? WHERE id=?').run(
    Date.UTC(2026, 10, 23, 23, 0),
    'America/Mexico_City',
    editionId,
  );
  const dated = await call(origin, '/api/course-access/editions/' + editionId + '/preview', {
    cookie: agent,
    body: { body: 'Hola {{nombre}}, tu curso empieza: {{fecha}}' },
  });
  assert.ok(
    dated.text.endsWith('empieza: lunes, 23 de noviembre de 2026, 5:00 p.m. (hora del centro de México)'),
    dated.text,
  );
  assert.doesNotMatch(dated.text, /America/);
  db.prepare('UPDATE editions SET starts_at=NULL WHERE id=?').run(editionId);

  // ---- el cliente manda su comprobante: el chat del equipo lo muestra por revisar
  assert.equal((await chat(agent, first.conv.id)).receipt, null);
  await call(origin, '/api/conversations/' + first.conv.id + '/messages', {
    cookie: ana,
    body: {
      text: '',
      clientRef: randomUUID(),
      attachment: { name: 'comprobante.png', type: 'image/png', base64: PNG },
    },
    expected: 201,
  });
  let state = await until(
    async () => {
      const s = await chat(agent, first.conv.id);
      return s.receipt ? s : null;
    },
    'el comprobante por revisar aparece en el chat',
    { logs: server.logs },
  );
  assert.equal(state.order.status, 'review');
  assert.equal(state.order.reference, first.order.reference);
  assert.ok(state.receipt.url.startsWith('/api/files/'));
  assert.equal(state.enrollment, null);
  assert.equal(state.access.state, 'ready');
  await chat(ana, first.conv.id, 403);
  await chat(outsider, first.conv.id, 404);
  assert.equal(deliveries(first.conv.id).length, 0, 'sin pago confirmado no sale ningún acceso');

  // ---- una persona valida el comprobante: confirmación y, enseguida, los accesos
  await call(origin, '/api/payments/receipts/' + state.receipt.id + '/accept', {
    cookie: agent,
    body: { note: 'Transferencia vista' },
  });
  await until(() => deliveries(first.conv.id).length === 1, 'la entrega automática de accesos', { logs: server.logs });
  let rows = deliveries(first.conv.id);
  assert.equal(rows[0].kind, 'auto');
  assert.equal(rows[0].status, 'sent');
  assert.equal(rows[0].access_revision, 2);
  let sent = texts(first.conv.id);
  assert.match(sent.at(-2), /Pago confirmado/, 'primero la confirmación del pago');
  assert.match(sent.at(-2), /Enseguida te mando por aquí tus accesos/, 'la confirmación anuncia lo que sí va a llegar');
  assert.match(sent.at(-1), /bienvenida, Ana! Ya tienes tu lugar en /);
  assert.ok(sent.at(-1).includes('Pedido ' + first.order.reference));
  assert.ok(sent.at(-1).includes('https://clases.example.test/aves'));
  assert.doesNotMatch(sent.at(-1), /\{\{/);
  state = await chat(agent, first.conv.id);
  assert.equal(state.order.status, 'paid');
  assert.equal(state.receipt, null);
  assert.equal(state.access.sent, true);
  assert.equal(state.access.last.kind, 'auto');
  assert.equal(state.access.canSend, true);
  assert.equal(state.access.canManage, false);

  // ---- reenvío: lo pide el equipo de la marca, y un reintento con el mismo clientRef no repite el mensaje
  const enrollmentId = state.enrollment.id;
  const send = (cookie, id, body, expected = 200) =>
    call(origin, '/api/course-access/enrollments/' + id + '/send', { cookie, body, expected });
  await send(agent, enrollmentId, {}, 400);
  await send(outsider, enrollmentId, { clientRef: randomUUID() }, 404);
  await send(ana, enrollmentId, { clientRef: randomUUID() }, 403);
  const ref = randomUUID();
  const again = await send(agent, enrollmentId, { clientRef: ref });
  const retry = await send(agent, enrollmentId, { clientRef: ref });
  assert.equal(again.delivery.id, retry.delivery.id);
  assert.equal(again.sale.access.last.kind, 'manual');
  rows = deliveries(first.conv.id);
  assert.equal(rows.length, 2);
  assert.equal(texts(first.conv.id).filter(x => /bienvenida, Ana!/.test(x)).length, 2);

  // ---- pago de prueba (nadie del equipo confirmó): no entrega accesos; el equipo puede enviarlos a mano
  const second = await sale(luis, 'aves');
  await payTest(luis, second.order);
  await until(() => deliveries(second.conv.id).length === 1, 'constancia de la entrega omitida', { logs: server.logs });
  rows = deliveries(second.conv.id);
  assert.equal(rows[0].status, 'skipped');
  assert.equal(rows[0].reason, 'test_payment');
  assert.equal(rows[0].message_id, null);
  assert.equal(texts(second.conv.id).filter(x => /bienvenida, Luis!/.test(x)).length, 0);
  assert.match(
    texts(second.conv.id).find(x => /Pago confirmado/.test(x)),
    /El equipo coordinador te enviará por aquí los accesos/,
    'sin entrega automática, la confirmación no promete accesos inmediatos',
  );
  state = await chat(agent, second.conv.id);
  assert.equal(state.access.sent, false);
  assert.match(state.access.last.reasonLabel, /pago fue de prueba/);
  await send(agent, state.enrollment.id, { clientRef: randomUUID() });
  assert.equal(texts(second.conv.id).filter(x => /bienvenida, Luis!/.test(x)).length, 1);

  // ---- la apertura puede permitir la entrega con pagos de prueba (para presentar el recorrido completo)
  card = (await put(admin, editionId, { onTestPayment: true, expectedRevision: 2 })).edition;
  assert.equal(card.access.onTestPayment, true);
  const third = await sale(eva, 'aves');
  await payTest(eva, third.order);
  await until(() => deliveries(third.conv.id).length === 1, 'entrega con pago de prueba permitido', {
    logs: server.logs,
  });
  assert.equal(deliveries(third.conv.id)[0].status, 'sent');
  assert.equal(texts(third.conv.id).filter(x => /bienvenida, Eva!/.test(x)).length, 1);

  // ---- otra marca sin accesos escritos: paga, no recibe nada, y al escribirlos se envían a quienes faltan
  const other = await sale(ana, 'odontologia');
  await payTest(ana, other.order);
  await until(() => deliveries(other.conv.id).length === 1, 'constancia sin accesos escritos', { logs: server.logs });
  assert.equal(deliveries(other.conv.id)[0].reason, 'empty');
  const otherEdition = other.order.edition_id;
  const pending = (cookie, body, expected = 200) =>
    call(origin, '/api/course-access/editions/' + otherEdition + '/send-pending', { cookie, body, expected });
  await pending(admin, { clientRef: randomUUID() }, 409);
  await put(admin, otherEdition, { enabled: false, body: BODY, expectedRevision: 0 });
  await pending(outsider, { clientRef: randomUUID() }, 403);
  await pending(agent, { clientRef: randomUUID() }, 404);
  const bulkRef = randomUUID();
  const bulk = await pending(admin, { clientRef: bulkRef });
  assert.equal(bulk.sent, 1);
  assert.equal(bulk.left, 0);
  assert.equal(bulk.edition.delivered, 1);
  assert.equal((await pending(admin, { clientRef: bulkRef })).sent, 0, 'el reintento no repite');
  assert.equal(texts(other.conv.id).filter(x => /bienvenida, Ana!/.test(x)).length, 1);

  // ---- la pantalla lista las entregas de su marca y nada de la otra
  view = await call(origin, '/api/course-access?brand=globalvet', { cookie: agent });
  card = view.editions.find(e => e.editionId === editionId);
  assert.equal(card.enrolled, 3);
  assert.equal(card.delivered, 3);
  assert.equal(view.deliveries.length, 5);
  assert.ok(view.deliveries.every(d => d.editionId === editionId));
  assert.ok(view.deliveries.some(d => d.status === 'skipped' && /pago fue de prueba/.test(d.reasonLabel)));
  assert.ok(view.deliveries.some(d => d.kind === 'manual' && d.sentByName === 'Asesor GlobalVet'));

  // ---- Preparar marca avisa de las aperturas por empezar que todavía no entregan accesos
  const step = (await call(origin, '/api/readiness', { cookie: admin })).brands
    .find(b => b.id === 'odonteck')
    .steps.find(s => s.id === 'course-access');
  assert.equal(step.done, false);
  assert.equal(step.required, false);
  assert.match(step.detail, /por entregar accesos|No hay aperturas/);
});
