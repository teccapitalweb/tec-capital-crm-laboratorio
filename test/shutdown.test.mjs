import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown, shutdownGraceMs } from '../server/app/shutdown.mjs';
import { metaInbound, metaText } from './helpers/fake-meta.mjs';
import { sleep, startStoppable, until, whatsappLab } from './helpers/crm.mjs';

const MARIA = '5215512345678';
const LUIS = '5215500000001';
const deferred = () => {
  let resolve;
  const promise = new Promise(ok => (resolve = ok));
  return { promise, resolve };
};
const flush = () => new Promise(done => setImmediate(done));
const recorder = () => {
  const lines = [];
  const add = (...args) => lines.push(args.join(' '));
  return { lines, error: add, warn: add };
};

test('plazo del apagado: 1,5 s por omisión, lo que diga SHUTDOWN_GRACE_MS, con tope de un minuto', () => {
  assert.equal(shutdownGraceMs({}), 1500);
  assert.equal(shutdownGraceMs({ SHUTDOWN_GRACE_MS: '10000' }), 10_000);
  assert.equal(shutdownGraceMs({ SHUTDOWN_GRACE_MS: '0' }), 0);
  assert.equal(shutdownGraceMs({ SHUTDOWN_GRACE_MS: '999999' }), 60_000);
  for (const bad of ['', '  ', 'abc', '-1', 'NaN'])
    assert.equal(shutdownGraceMs({ SHUTDOWN_GRACE_MS: bad }), 1500, bad);
});

test('apagado ordenado: deja de aceptar, espera a lo que está en vuelo, cierra y sale; una segunda señal no lo repite', async () => {
  const order = [];
  const flight = deferred();
  const log = recorder();
  const shutdown = createShutdown({
    graceMs: 5000,
    stopIntake: () => order.push('deja de aceptar'),
    inFlight: [() => flight.promise.then(() => order.push('terminó lo que estaba en vuelo')), () => Promise.resolve()],
    closeConnections: () => order.push('cierra conexiones'),
    finish: info => order.push('cierra la base ' + JSON.stringify(info)),
    exit: code => order.push('sale con ' + code),
    log,
  });
  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second, 'SIGTERM y SIGINT seguidos son un solo apagado');
  await flush();
  assert.deepEqual(order, ['deja de aceptar'], 'no cierra nada mientras haya trabajo en vuelo');
  flight.resolve();
  assert.deepEqual(await first, { drained: true, closed: true });
  assert.deepEqual(order, [
    'deja de aceptar',
    'terminó lo que estaba en vuelo',
    'cierra conexiones',
    'cierra la base {"drained":true,"closed":true}',
    'sale con 0',
  ]);
  assert.deepEqual(log.lines, []);
});

test('apagado ordenado: nunca espera más que el plazo, para lo que está en vuelo y para las conexiones juntos', async () => {
  const order = [];
  const log = recorder();
  const started = Date.now();
  const result = await createShutdown({
    graceMs: 150,
    stopIntake: () => order.push('deja de aceptar'),
    inFlight: [() => new Promise(() => {})], // algo que no termina
    closeConnections: () => new Promise(() => {}), // ni las conexiones se cierran
    finish: info => order.push('cierra la base ' + JSON.stringify(info)),
    exit: code => order.push('sale con ' + code),
    log,
  })();
  const waited = Date.now() - started;
  assert.ok(waited >= 120 && waited < 4000, 'esperó ' + waited + ' ms');
  assert.deepEqual(result, { drained: false, closed: false });
  assert.deepEqual(order, ['deja de aceptar', 'cierra la base {"drained":false,"closed":false}', 'sale con 0']);
  assert.deepEqual(log.lines, ['Apagado: quedó trabajo en vuelo al cumplirse el plazo de 150 ms.']);
  // lo que está en vuelo termina a tiempo, pero las conexiones no: el plazo es uno solo
  const again = Date.now();
  const partial = await createShutdown({
    graceMs: 200,
    inFlight: [() => sleep(60)],
    closeConnections: () => new Promise(() => {}),
    exit: () => {},
    log,
  })();
  assert.deepEqual(partial, { drained: true, closed: false });
  const total = Date.now() - again;
  assert.ok(total >= 170 && total < 4000, 'tardó ' + total + ' ms');
});

test('apagado ordenado: aunque un paso falle, sigue con los demás y termina saliendo', async () => {
  const order = [];
  const log = recorder();
  const result = await createShutdown({
    graceMs: 1000,
    stopIntake: () => {
      throw new TypeError('relojes');
    },
    inFlight: [
      () => {
        throw new RangeError('cola');
      },
    ],
    closeConnections: () => Promise.reject(new Error('sockets')),
    finish: () => {
      order.push('cierra la base');
      throw new Error('base');
    },
    exit: code => order.push('sale con ' + code),
    log,
  })();
  assert.deepEqual(order, ['cierra la base', 'sale con 0']);
  assert.deepEqual(result, { drained: true, closed: true });
  assert.deepEqual(log.lines, [
    'Apagado: no se pudo dejar de aceptar trabajo: TypeError',
    'Apagado: no se pudo esperar lo que estaba en vuelo: RangeError',
    'Apagado: no se pudo cerrar: Error',
  ]);
});

test('apagado ordenado de punta a punta: espera al envío de WhatsApp en vuelo, lo anota y el arranque siguiente no lo repite', async t => {
  const lab = await whatsappLab(t, { SHUTDOWN_GRACE_MS: '10000' }, { launch: startStoppable });
  const { meta, db, origin, state, start } = lab;
  meta.hold('send');
  await metaText(origin(), MARIA, 'wamid.maria-1', 'Hola, ¿cuánto cuesta el curso?', { name: 'María López' });
  await until(() => meta.waiting('send') === 1, 'la respuesta del asistente va camino de Meta', {
    logs: state.server.logs,
  });
  const reply = db
    .prepare(
      "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.wa_peer=? AND m.sender_kind='automation'",
    )
    .get(MARIA);
  assert.equal(reply.provider_ref, null);
  // llega la señal de apagado con el envío en vuelo
  const address = origin();
  let exit = null;
  const stopping = state.server.shutdown().then(result => (exit = result));
  await sleep(500);
  assert.equal(exit, null, 'el proceso sigue vivo: espera al envío');
  await assert.rejects(fetch(address + '/api/health'), 'durante el apagado ya no acepta conexiones nuevas');
  meta.release('send'); // Meta contesta
  await stopping;
  assert.equal(exit.code, 0);
  assert.ok(exit.ms < 9000, 'sale en cuanto termina lo que estaba en vuelo, sin agotar el plazo (' + exit.ms + ' ms)');
  const saved = db.prepare('SELECT * FROM messages WHERE id=?').get(reply.id);
  assert.match(saved.provider_ref, /^wamid\.out/, 'la respuesta de Meta quedó anotada antes de salir');
  assert.deepEqual([saved.send_lease_until, saved.send_attempts, saved.delivery_state], [null, 0, 'sent']);
  assert.deepEqual(
    db
      .prepare('SELECT state FROM channel_events WHERE message_id=? ORDER BY seq')
      .all(reply.id)
      .map(event => event.state),
    ['sent'],
  );
  // el arranque siguiente no tiene nada que repetir
  await start();
  await sleep(1600);
  assert.equal(meta.sent.length, 1, 'un solo envío a Meta');
});

test('apagado con el plazo agotado: sale igualmente; el entrante a medias vuelve a la cola y el envío en vuelo conserva su marca', async t => {
  const lab = await whatsappLab(t, { SHUTDOWN_GRACE_MS: '400' }, { launch: startStoppable });
  const { meta, db, origin, state, start, inboxRow } = lab;
  // un envío en vuelo hacia Meta…
  meta.hold('send');
  await metaText(origin(), MARIA, 'wamid.maria-1', 'Hola, ¿cuánto cuesta el curso?', { name: 'María López' });
  await until(() => meta.waiting('send') === 1, 'la respuesta a María va camino de Meta', { logs: state.server.logs });
  // …y un entrante cuyo archivo todavía se está descargando
  meta.hold('download');
  const image = { type: 'image', image: { id: '7002', mime_type: 'image/png', caption: 'Mi comprobante' } };
  metaInbound(origin(), LUIS, 'wamid.luis-1', image, { name: 'Luis' }).catch(() => {}); // su respuesta ya no llegará
  await until(() => meta.waiting('download') === 1, 'la descarga del archivo de Luis está en curso');
  assert.equal(inboxRow('wamid.luis-1').state, 'reserved');
  const exit = await state.server.shutdown();
  assert.equal(exit.code, 0);
  assert.ok(exit.ms >= 300 && exit.ms < 5000, 'espera el plazo y sale (' + exit.ms + ' ms)');
  const row = inboxRow('wamid.luis-1');
  assert.deepEqual(
    [row.state, row.attempts, row.lease_owner, row.lease_until],
    ['pending', 0, null, null],
    'el entrante a medias queda pendiente, sin gastar un intento',
  );
  assert.ok(row.payload);
  const reply = db
    .prepare(
      "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.wa_peer=? AND m.sender_kind='automation'",
    )
    .get(MARIA);
  assert.deepEqual([reply.provider_ref, reply.send_attempts], [null, 1]);
  assert.ok(reply.send_lease_until > Date.now(), 'el envío en vuelo conserva su marca: su resultado se desconoce');
  // arranque siguiente: el entrante se procesa de inmediato (no espera a ningún arrendamiento); el envío en duda, no
  meta.release('send');
  meta.release('download');
  await start();
  await until(() => inboxRow('wamid.luis-1').state === 'done', 'el entrante de Luis entra al arrancar', {
    ms: 6000,
    logs: state.server.logs,
  });
  assert.match(inboxRow('wamid.luis-1').result, /^recibido: conversación nueva · con archivo/);
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE client_ref='meta:wamid.luis-1'").get().n, 1);
  assert.equal(db.prepare('SELECT provider_ref FROM messages WHERE id=?').get(reply.id).provider_ref, null);
  assert.equal(meta.sent.filter(message => message.to === MARIA).length, 1, 'a María no se le repite el envío');
});
