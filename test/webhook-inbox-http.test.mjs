import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneOf, peerIdentifier, inboxWaitMs } from '../server/connectors.mjs';
import { startServer } from './helpers/server.mjs';
import { metaHook, metaInbound, metaText, NUMBER, SECRET } from './helpers/fake-meta.mjs';
import { PASSWORD, call, crash, openDb, sleep, until, whatsappLab as lab } from './helpers/crm.mjs';

const MARIA = '5215512345678';
const LUIS = '5215500000001';
const ANA = '5215500000002';
const QUEUED = 'en cola: se procesa en segundo plano';

test('carril de cada evento, identificador de quien escribe y espera de la petición', () => {
  const inbound = (from, to = '1090') => ({ id: 'w1', type: 'message.inbound', data: { from, to } });
  const lane = laneOf('channel', 'meta', inbound(MARIA));
  assert.match(lane, /^in:meta:1090:[0-9a-f]{16}$/);
  assert.equal(lane.includes('5512345678'), false, 'el carril no guarda el teléfono en claro');
  assert.equal(laneOf('channel', 'meta', inbound(MARIA)), lane, 'misma persona y mismo número: mismo carril');
  assert.notEqual(laneOf('channel', 'meta', inbound(LUIS)), lane);
  assert.notEqual(laneOf('channel', 'meta', inbound(MARIA, '2090')), lane, 'otro número que recibe: otra conversación');
  // contrato 1.1: el primer identificador de peer.ids, sea teléfono o identificador de usuario
  const v11 = ids => ({
    id: 'w2',
    type: 'message.inbound',
    data: { account: { provider: 'meta-whatsapp', externalId: '1090' }, peer: { ids } },
  });
  assert.equal(
    laneOf(
      'channel',
      'meta',
      v11([
        { kind: 'wa_phone', value: MARIA },
        { kind: 'wa_bsuid', value: 'MX.abc' },
      ]),
    ),
    lane,
  );
  const byUser = laneOf('channel', 'meta', v11([{ kind: 'wa_bsuid', value: 'MX.abc' }]));
  assert.match(byUser, /^in:meta:1090:[0-9a-f]{16}$/);
  assert.notEqual(byUser, lane);
  assert.equal(peerIdentifier({}), '');
  assert.equal(peerIdentifier(null), '');
  assert.equal(peerIdentifier({ peer: { ids: [] }, from: MARIA }), MARIA);
  assert.equal(peerIdentifier({ peer: { ids: [{ kind: 'wa_bsuid', value: ' MX.1 ' }] }, from: MARIA }), 'MX.1');
  assert.equal(peerIdentifier({ peer: { ids: [{ kind: 'wa_phone', value: '' }, 'MX.2'] } }), 'MX.2');
  // sin identificador no hay conversación a la que guardar el orden: carril propio, no detiene a nadie
  assert.equal(laneOf('channel', 'meta', { id: 'w9', type: 'message.inbound', data: { to: '1090' } }), 'ev:meta:w9');
  // estados, pagos y lo demás
  assert.equal(
    laneOf('channel', 'meta', { id: 'wamid.1:read', type: 'message.status', data: { providerRef: 'wamid.1' } }),
    'st:meta:wamid.1',
  );
  const pay = data => laneOf('payment', 'stripe', { id: 'evt_1', type: 'payment.succeeded', data });
  assert.equal(pay({ orderId: 'o1', reference: 'TC-AAA111' }), 'pay:stripe:o1');
  assert.equal(pay({ reference: 'TC-AAA111' }), 'pay:stripe:TC-AAA111');
  assert.equal(pay({}), 'pay:stripe:evt_1');
  assert.equal(laneOf('channel', 'simulated', { id: 'x1', type: 'otro', data: {} }), 'ev:simulated:x1');
  assert.equal(laneOf('channel', 'simulated', { id: 'x2', type: 'message.status' }), 'ev:simulated:x2');
  // espera de la petición: 3 s; 8 s en pruebas; lo que diga la variable, siempre por debajo de los 10 s del botón de prueba
  assert.equal(inboxWaitMs({}), 3000);
  assert.equal(inboxWaitMs({ NODE_ENV: 'test' }), 8000);
  assert.equal(inboxWaitMs({ NODE_ENV: 'test', WEBHOOK_INBOX_WAIT_MS: '0' }), 0);
  assert.equal(inboxWaitMs({ WEBHOOK_INBOX_WAIT_MS: '1500' }), 1500);
  assert.equal(inboxWaitMs({ WEBHOOK_INBOX_WAIT_MS: '60000' }), 9000);
  for (const bad of ['', '  ', 'abc', '-5', 'NaN'])
    assert.equal(inboxWaitMs({ WEBHOOK_INBOX_WAIT_MS: bad }), 3000, bad);
});

test('con espera 0 el webhook responde «en cola» y el mensaje entra después; cada persona conserva su orden y otra no espera', async t => {
  const { meta, db, inboxRow, origin, state } = await lab(t, { WEBHOOK_INBOX_WAIT_MS: '0' });
  const queued = (response, id) => {
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      received: 1,
      results: [{ id, type: 'message.inbound', result: QUEUED, queued: true }],
    });
  };
  // el archivo del primer mensaje de María tarda en bajar todo lo que la prueba quiera
  meta.hold('download');
  const image = { type: 'image', image: { id: '7001', mime_type: 'image/png', caption: 'Mi comprobante' } };
  queued(await metaInbound(origin(), MARIA, 'wamid.maria-1', image, { name: 'María López' }), 'wamid.maria-1');
  queued(await metaText(origin(), MARIA, 'wamid.maria-2', 'Y otra pregunta', { name: 'María López' }), 'wamid.maria-2');
  queued(await metaText(origin(), LUIS, 'wamid.luis-1', 'Hola, soy Luis', { name: 'Luis' }), 'wamid.luis-1');

  const mine = prefix =>
    db
      .prepare('SELECT client_ref,text,attachment_id FROM messages WHERE client_ref LIKE ? ORDER BY seq')
      .all('meta:wamid.' + prefix + '-%');
  await until(() => mine('luis').length === 1, 'el mensaje de Luis entra sin esperar a María', {
    logs: state.server.logs,
  });
  await until(() => meta.waiting('download') === 1, 'la descarga del archivo de María sigue en curso');
  assert.equal(mine('maria').length, 0, 'ningún mensaje de María entra antes que el primero');
  assert.equal(inboxRow('wamid.luis-1').state, 'done');
  assert.equal(inboxRow('wamid.maria-1').state, 'reserved');
  assert.equal(inboxRow('wamid.maria-2').state, 'pending', 'el segundo espera al primero de su carril');
  assert.equal(inboxRow('wamid.maria-1').lane, inboxRow('wamid.maria-2').lane);
  assert.notEqual(inboxRow('wamid.maria-1').lane, inboxRow('wamid.luis-1').lane);
  assert.equal(inboxRow('wamid.maria-1').lane.includes('5512345678'), false);
  assert.ok(JSON.parse(inboxRow('wamid.maria-2').payload).event.data.text, 'mientras espera conserva su carga');
  assert.equal(JSON.parse(inboxRow('wamid.maria-2').payload).v, '1.0', 'con la versión del contrato con la que llegó');

  meta.release('download');
  await until(() => mine('maria').length === 2, 'entran los dos mensajes de María', { logs: state.server.logs });
  const maria = mine('maria');
  assert.deepEqual(
    maria.map(m => m.client_ref),
    ['meta:wamid.maria-1', 'meta:wamid.maria-2'],
    'en el orden en que llegaron',
  );
  assert.equal(maria[0].text, 'Mi comprobante');
  assert.ok(maria[0].attachment_id, 'el primero con su archivo');
  assert.equal(maria[1].text, 'Y otra pregunta');
  await until(() => inboxRow('wamid.maria-2').state === 'done', 'la bandeja anota el segundo');
  const rows = db
    .prepare('SELECT event_id,state,result,payload,attempts,lease_owner FROM webhook_inbox ORDER BY seq')
    .all();
  assert.deepEqual(
    rows.map(row => [row.event_id, row.state, row.attempts, row.payload, row.lease_owner]),
    [
      ['wamid.maria-1', 'done', 1, null, null],
      ['wamid.maria-2', 'done', 1, null, null],
      ['wamid.luis-1', 'done', 1, null, null],
    ],
    'al terminar no queda la carga (texto y número) en la bandeja',
  );
  assert.match(rows[0].result, /^recibido: conversación nueva · con archivo/);
  assert.match(rows[1].result, /^recibido: conversación existente/);
  assert.match(rows[2].result, /^recibido: conversación nueva/);
  // la bitácora de conectores sigue siendo la misma: un evento por id, sin texto ni número completo
  const logged = db.prepare("SELECT event_id,payload FROM connector_events WHERE provider='meta' ORDER BY seq").all();
  assert.equal(logged.length, 3);
  for (const event of logged) {
    assert.equal(event.payload.includes('pregunta'), false);
    assert.equal(event.payload.includes(MARIA), false);
  }
  // Meta repite un aviso ya procesado: se contesta al momento, sin volver a guardarlo
  const again = await metaText(origin(), MARIA, 'wamid.maria-2', 'Y otra pregunta', { name: 'María López' });
  assert.deepEqual(again.body.results, [
    { id: 'wamid.maria-2', type: 'message.inbound', result: 'duplicado: ya se había procesado', duplicate: true },
  ]);
  assert.equal(db.prepare('SELECT count(*) n FROM webhook_inbox').get().n, 3);
  assert.equal(mine('maria').length, 2);
  assert.equal(state.server.logs().includes('failed'), false, state.server.logs());
});

test('lo guardado sobrevive a la muerte del proceso: al arrancar hay un mensaje, un trabajo y la fila terminada', async t => {
  const { db, inboxRow, origin, state, start } = await lab(t, {
    WEBHOOK_INBOX_WAIT_MS: '0',
    WEBHOOK_INBOX_PAUSED: '1',
  });
  const received = await metaText(origin(), ANA, 'wamid.ana-1', 'Hola, ¿cuánto cuesta el curso?', { name: 'Ana' });
  assert.equal(received.status, 200);
  assert.equal(received.body.results[0].queued, true);
  await sleep(700); // varias pasadas del reloj de la bandeja: en pausa no procesa
  const saved = inboxRow('wamid.ana-1');
  assert.deepEqual([saved.state, saved.attempts, saved.kind, saved.provider], ['pending', 0, 'channel', 'meta']);
  assert.equal(JSON.parse(saved.payload).event.data.text, 'Hola, ¿cuánto cuesta el curso?');
  const messages = () => db.prepare("SELECT * FROM messages WHERE client_ref='meta:wamid.ana-1'").all();
  assert.equal(messages().length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM wa_identities').get().n, 0);

  await crash(state.server); // el proceso muere con el evento guardado y sin procesar
  await start({ WEBHOOK_INBOX_PAUSED: '' });
  await until(() => inboxRow('wamid.ana-1').state === 'done', 'el arranque siguiente procesa lo guardado', {
    logs: state.server.logs,
  });
  let row = inboxRow('wamid.ana-1');
  assert.match(row.result, /^recibido: conversación nueva/);
  assert.equal(row.payload, null);
  assert.equal(row.attempts, 1);
  assert.equal(messages().length, 1);
  const conversation = messages()[0].conversation_id;
  const jobs = () => db.prepare('SELECT count(*) n FROM jobs WHERE conversation_id=?').get(conversation).n;
  assert.equal(jobs(), 1);
  assert.equal(db.prepare("SELECT count(*) n FROM connector_events WHERE event_id='wamid.ana-1'").get().n, 1);

  // Como si el proceso hubiera muerto DESPUÉS de guardar el mensaje y ANTES de anotarlo: la bandeja lo vuelve a
  // pasar, el mensaje ya está en la conversación y no se duplica ni él ni su trabajo de respuesta.
  db.prepare("DELETE FROM connector_events WHERE event_id='wamid.ana-1'").run();
  db.prepare(
    "UPDATE webhook_inbox SET state='pending',payload=?,result=NULL,done_at=NULL,next_attempt_at=0 WHERE seq=?",
  ).run(saved.payload, saved.seq);
  await until(() => inboxRow('wamid.ana-1').state === 'done', 'la segunda pasada termina', { logs: state.server.logs });
  row = inboxRow('wamid.ana-1');
  assert.equal(row.result, 'duplicado: el mensaje ya estaba en la conversación');
  assert.equal(row.attempts, 2);
  assert.equal(messages().length, 1, 'un solo mensaje');
  assert.equal(jobs(), 1, 'un solo trabajo de respuesta');
  assert.equal(db.prepare('SELECT count(*) n FROM wa_identities').get().n, 1);
});

test('un entrante sin identificador queda en cuarentena («no_identifier»); administración lo ve y lo reprocesa', async t => {
  const { db, inboxRow, origin, admin, state } = await lab(t);
  const stranger = (
    await call(origin(), '/api/auth/register', {
      body: { username: 'curiosa', name: 'Persona curiosa', password: PASSWORD },
    })
  ).cookie;
  const secret = 'Texto que no debe salir de la bandeja';
  const lost = await metaInbound(origin(), '', 'wamid.sin-remitente', { type: 'text', text: { body: secret } });
  assert.equal(lost.status, 200, 'Meta no debe reintentarlo: ya está guardado');
  assert.deepEqual(lost.body.results, [
    { id: 'wamid.sin-remitente', type: 'message.inbound', result: 'error: no_identifier' },
  ]);
  let row = inboxRow('wamid.sin-remitente');
  assert.deepEqual(
    [row.state, row.error, row.attempts, row.lane],
    ['failed', 'no_identifier', 1, 'ev:meta:wamid.sin-remitente'],
  );
  assert.equal(JSON.parse(row.payload).event.data.text, secret, 'conserva su carga para poder reprocesarlo');
  assert.equal(db.prepare("SELECT count(*) n FROM connector_events WHERE event_id='wamid.sin-remitente'").get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM wa_identities').get().n, 0);
  // Meta lo repite: sigue habiendo una sola fila y no se vuelve a intentar sola
  const again = await metaInbound(origin(), '', 'wamid.sin-remitente', { type: 'text', text: { body: secret } });
  assert.equal(again.body.results[0].result, 'error: no_identifier');
  assert.equal(db.prepare('SELECT count(*) n FROM webhook_inbox').get().n, 1);
  assert.equal(inboxRow('wamid.sin-remitente').attempts, 1);
  // lo demás sigue entrando con normalidad
  const fine = await metaText(origin(), MARIA, 'wamid.bien', 'Hola', { name: 'María López' });
  assert.match(fine.body.results[0].result, /^recibido: conversación nueva/);

  // administración: ver
  await call(origin(), '/api/connectors/inbox', { expected: 401 });
  await call(origin(), '/api/connectors/inbox', { cookie: stranger, expected: 403 });
  const view = await call(origin(), '/api/connectors/inbox', { cookie: admin });
  assert.deepEqual(view.stats, {
    pending: 0,
    reserved: 0,
    failed: 1,
    oldestPendingSec: null,
    inFlight: 0,
    paused: false,
  });
  assert.equal(view.items.length, 1);
  assert.deepEqual(
    [view.items[0].seq, view.items[0].eventId, view.items[0].state, view.items[0].error, view.items[0].hasPayload],
    [row.seq, 'wamid.sin-remitente', 'failed', 'no_identifier', true],
  );
  assert.equal(JSON.stringify(view).includes(secret), false, 'la carga nunca sale por la API');
  const done = await call(origin(), '/api/connectors/inbox?state=done&limit=5', { cookie: admin });
  assert.deepEqual(
    done.items.map(item => [item.eventId, item.state, item.hasPayload]),
    [['wamid.bien', 'done', false]],
  );
  assert.match(done.items[0].result, /^recibido: conversación nueva/);
  // administración: reprocesar
  const retry = (seq, options) =>
    call(origin(), '/api/connectors/inbox/' + seq + '/retry', { method: 'POST', body: {}, ...options });
  await retry(row.seq, { cookie: stranger, expected: 403 });
  await retry(999999, { cookie: admin, expected: 404 });
  assert.match((await retry(done.items[0].seq, { cookie: admin, expected: 409 })).error, /fallido/);
  await call(origin(), '/api/connectors/inbox/abc/retry', { cookie: admin, method: 'POST', body: {}, expected: 404 });
  const back = await retry(row.seq, { cookie: admin });
  assert.deepEqual([back.item.state, back.item.attempts, back.item.error], ['pending', 0, null]);
  await until(() => inboxRow('wamid.sin-remitente').state === 'failed', 'el reproceso vuelve a dejarlo en cuarentena');
  row = inboxRow('wamid.sin-remitente');
  assert.deepEqual([row.error, row.attempts], ['no_identifier', 1], 'mientras no se sepa leer su identificador');
  assert.ok(row.payload);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM audit WHERE action='connectors.inbox.retry' AND entity_id=?")
      .get(String(row.seq)).n,
    1,
    'el reproceso queda en la auditoría',
  );
  // cada intento queda en el registro del servidor (que llega a la prueba con un instante de retraso), sin datos de la persona
  const logged = () =>
    state.server
      .logs()
      .split('\n')
      .filter(line => line.includes('Webhook inbox item failed: message.inbound no_identifier')).length;
  await until(() => logged() === 2, 'los dos intentos quedan en el registro', { logs: state.server.logs });
  assert.equal(state.server.logs().includes(secret), false);
});

test('WhatsApp real elegido pero incompleto: el entrante no se guarda (503) y lo anterior de la petición sí', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-inbox-http-'));
  const server = await startServer({
    dir,
    env: { CHANNEL_CONNECTOR: 'meta', META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'verifica-123' },
  });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const mixed = await metaHook(server.origin, {
    metadata: { phone_number_id: NUMBER },
    statuses: [{ id: 'wamid.estado', status: 'delivered', timestamp: '1700000000' }],
    messages: [{ id: 'wamid.entrante', from: MARIA, type: 'text', text: { body: 'Hola' } }],
  });
  assert.equal(mixed.status, 503);
  assert.match(mixed.body.error, /le faltan datos \(META_ACCESS_TOKEN, META_PHONE_NUMBER_ID\); Meta reintentará/);
  const row = id => db.prepare('SELECT state,result FROM webhook_inbox WHERE event_id=?').get(id);
  assert.equal(row('wamid.entrante'), undefined, 'el entrante no queda guardado: lo reintentará Meta');
  await until(() => row('wamid.estado:delivered')?.state === 'done', 'el estado que venía antes sí se procesa');
  assert.match(row('wamid.estado:delivered').result, /^ignorado: no hay mensaje/);
  assert.equal(db.prepare('SELECT count(*) n FROM connector_events').get().n, 1);
});
