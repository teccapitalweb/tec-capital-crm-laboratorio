// Orden de los mensajes de WhatsApp real después de un archivo (docs/PLAN_WHATSAPP_REAL.md, «Orden de los mensajes»).
// Prueba real del 21 nov 2026: el recorrido dijo saludo → ficha (imagen con pie) → botones y en el teléfono llegaron
// el saludo, los botones y DESPUÉS la imagen. Tras aceptar Meta un archivo, el siguiente mensaje de esa conversación
// espera WA_MEDIA_GAP_MS (o el «entregado» del archivo, si llega antes); las demás conversaciones no esperan, y el
// margen vive en la base (sobrevive a un reinicio). Con el servidor real y el Meta de mentira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PNG, metaStatus, metaText } from './helpers/fake-meta.mjs';
import { call, crash, sleep, until, whatsappLab } from './helpers/crm.mjs';
import { mediaGapMs } from '../server/lib/media-gap.mjs';

const ref = () => randomUUID();
const node = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data });
const ANA = '5215511111111';
const BETO = '5215522222222';

// Saludo (texto) → Ficha del curso (imagen con pie) → Botones, como el recorrido de la prueba real.
async function saleFlow(api) {
  const current = (await api('/api/automation')).brands.find(b => b.id === 'globalvet');
  await api('/api/automation/brands/globalvet', {
    method: 'PATCH',
    body: { enabled: true, expectedRevision: current.revision },
  });
  const file = (
    await api('/api/chatflows/files', {
      body: {
        brandId: 'globalvet',
        clientRef: ref(),
        file: { name: 'ficha.png', type: 'image/png', base64: PNG.toString('base64') },
      },
      expected: 201,
    })
  ).file;
  const graph = {
    v: 1,
    start: 'n1',
    variables: [],
    nodes: [
      node('n1', 'start'),
      node('m1', 'message', { parts: [{ kind: 'text', text: '¡Hola! Gracias por escribir.' }] }),
      node('m2', 'message', { parts: [{ kind: 'media', fileId: file.id, caption: 'Ficha del curso' }] }),
      node('b', 'buttons', {
        header: { kind: 'none' },
        text: '¿Te gustaría apartar tu lugar?',
        footer: '',
        options: [
          { id: 'si', label: 'Sí', do: { type: 'goto' } },
          { id: 'no', label: 'Ahora no', do: { type: 'goto' } },
        ],
      }),
    ],
    edges: [
      { from: 'n1', port: 'next', to: 'm1' },
      { from: 'm1', port: 'next', to: 'm2' },
      { from: 'm2', port: 'next', to: 'b' },
    ],
  };
  const flow = (
    await api('/api/chatflows', {
      body: {
        brandId: 'globalvet',
        name: 'Orden ' + ref().slice(0, 6),
        graph,
        start: { type: 'first_message' },
        clientRef: ref(),
      },
      expected: 201,
    })
  ).flow;
  const published = await api('/api/chatflows/' + flow.id + '/publish', { body: { expectedRevision: flow.revision } });
  await api('/api/chatflows/' + flow.id + '/activate', { body: { expectedRevision: published.flow.revision } });
}

// Lo que recibe una persona, en el orden en que Meta lo aceptó: «text», «image» o «interactive».
const kindsTo = (meta, to) => meta.sent.filter(m => m.to === to && !m.refused).map(m => m.type);

// Anota a qué hora llega a Meta cada mensaje (por su posición en meta.sent).
function clock(meta) {
  const at = [];
  const timer = setInterval(() => {
    while (at.length < meta.sent.length) at.push(Date.now());
  }, 5);
  return { at, stop: () => clearInterval(timer) };
}

test('margen tras un archivo: por omisión 2,5 s, 0 en pruebas, y la variable lo cambia dentro de sus límites', () => {
  assert.equal(mediaGapMs({}), 2500);
  assert.equal(mediaGapMs({ NODE_ENV: 'test' }), 0);
  assert.equal(mediaGapMs({ NODE_ENV: 'test', WA_MEDIA_GAP_MS: '1800' }), 1800);
  assert.equal(mediaGapMs({ WA_MEDIA_GAP_MS: '0' }), 0);
  assert.equal(mediaGapMs({ WA_MEDIA_GAP_MS: '-5' }), 0);
  assert.equal(mediaGapMs({ WA_MEDIA_GAP_MS: '999999' }), 30000);
  assert.equal(mediaGapMs({ WA_MEDIA_GAP_MS: 'mucho' }), 2500);
});

test('texto, imagen y botones llegan a Meta en ese orden; los botones esperan el margen y otra conversación no espera', async t => {
  const GAP = 2500;
  const W = await whatsappLab(t, { AI_PROVIDER: '', WA_MEDIA_GAP_MS: String(GAP) });
  const origin = W.origin();
  const api = (path, options = {}) => call(origin, path, { cookie: W.admin, ...options });
  await saleFlow(api);
  const times = clock(W.meta);
  t.after(times.stop);

  await metaText(origin, ANA, 'wamid.orden.ana', 'Hola');
  await until(() => kindsTo(W.meta, ANA).includes('image'), 'la imagen de Ana salió a Meta');
  // Mientras corre el margen de Ana escribe Beto: su saludo sale enseguida, sin esperar a nadie.
  const betoWrote = Date.now();
  await metaText(origin, BETO, 'wamid.orden.beto', 'Hola');
  await until(() => kindsTo(W.meta, BETO).includes('text'), 'el saludo de Beto salió a Meta');
  const betoText = times.at[W.meta.sent.findIndex(m => m.to === BETO)] ?? Date.now();
  assert.ok(betoText - betoWrote < GAP, 'la otra conversación no espera el margen de Ana');
  assert.deepEqual(kindsTo(W.meta, ANA), ['text', 'image'], 'los botones de Ana todavía no salen');

  await until(() => kindsTo(W.meta, ANA).length === 3, 'los botones de Ana salieron', { ms: 10_000 });
  assert.deepEqual(kindsTo(W.meta, ANA), ['text', 'image', 'interactive'], 'el orden en que lo dijo el recorrido');
  const image = W.db
    .prepare(
      "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.wa_peer=? AND json_extract(m.flyer_snapshot,'$.libraryFileId') IS NOT NULL",
    )
    .get(ANA);
  assert.ok(image.wa_gap_until, 'el margen quedó en la base');
  const buttonsIndex = W.meta.sent.findIndex(m => m.to === ANA && m.type === 'interactive');
  await until(() => times.at[buttonsIndex], 'se anotó la hora de los botones');
  const imageAccepted = image.wa_gap_until - GAP;
  assert.ok(
    times.at[buttonsIndex] >= imageAccepted + GAP - 20,
    'los botones salieron ' +
      (times.at[buttonsIndex] - imageAccepted) +
      ' ms después de la imagen (margen ' +
      GAP +
      ')',
  );
  // Ningún mensaje quedó como envío en duda ni con un intento de más por haberse soltado (Meta anota el envío antes
  // de responder: se espera a que el CRM guarde su referencia).
  const outgoing = () =>
    W.db
      .prepare(
        "SELECT m.provider_ref,m.send_attempts,m.send_lease_until,m.delivery_state FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.wa_peer=? AND m.sender_kind='automation'",
      )
      .all(ANA);
  await until(() => outgoing().every(r => r.provider_ref), 'el CRM guardó la referencia de los tres');
  const rows = outgoing();
  assert.equal(rows.length, 3);
  for (const r of rows) assert.deepEqual([r.send_attempts, r.send_lease_until, r.delivery_state], [0, null, 'sent']);
  assert.equal(
    W.db.prepare("SELECT count(*) n FROM channel_events WHERE state='lease_expired'").get().n,
    0,
    'soltar lo que sigue no deja envíos en duda',
  );
});

test('tras un reinicio el margen sigue en la base: los botones no se adelantan y salen en cuanto la imagen se entrega', async t => {
  // Un margen largo: lo que libera los botones es el «entregado» de la imagen, no el reloj.
  const W = await whatsappLab(t, { AI_PROVIDER: '', WA_MEDIA_GAP_MS: '30000' });
  const api = (path, options = {}) => call(W.origin(), path, { cookie: W.admin, ...options });
  await saleFlow(api);
  await metaText(W.origin(), ANA, 'wamid.orden.reinicio', 'Hola');
  const imageRow = () =>
    W.db
      .prepare(
        "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.wa_peer=? AND json_extract(m.flyer_snapshot,'$.libraryFileId') IS NOT NULL",
      )
      .get(ANA);
  // Meta ya aceptó la imagen y el CRM guardó su referencia y su margen: el proceso muere justo ahí.
  await until(() => imageRow()?.wa_gap_until, 'la imagen salió y su margen quedó en la base');
  await crash(W.state.server);
  assert.deepEqual(kindsTo(W.meta, ANA), ['text', 'image']);
  await W.start();
  await sleep(1500); // tres pasadas del reloj del canal
  assert.deepEqual(kindsTo(W.meta, ANA), ['text', 'image'], 'al arrancar no se adelantan los botones');
  const image = imageRow();
  assert.ok(image.provider_ref && image.wa_gap_until > Date.now());
  await metaStatus(W.origin(), image.provider_ref, 'delivered', { recipient: ANA });
  await until(() => kindsTo(W.meta, ANA).length === 3, 'con la imagen entregada salen los botones', {
    logs: W.state.server.logs,
  });
  assert.deepEqual(kindsTo(W.meta, ANA), ['text', 'image', 'interactive']);
  await sleep(1000);
  assert.equal(kindsTo(W.meta, ANA).length, 3, 'una sola vez');
});
