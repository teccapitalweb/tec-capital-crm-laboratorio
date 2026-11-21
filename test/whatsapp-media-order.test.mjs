// Orden de los mensajes de WhatsApp real después de un archivo (docs/PLAN_WHATSAPP_REAL.md, «Orden de los mensajes»).
// Prueba real del 21 nov 2026: el recorrido dijo saludo → ficha (imagen con pie) → botones y en el teléfono llegaron
// el saludo, los botones y DESPUÉS la imagen. Tras aceptar Meta un archivo, el siguiente mensaje de esa conversación
// espera WA_MEDIA_GAP_MS (o el «entregado» del archivo, si llega antes); las demás conversaciones no esperan, y el
// margen vive en la base (sobrevive a un reinicio). Con el servidor real y el Meta de mentira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NUMBER, PNG, metaStatus, metaText, startFakeMeta } from './helpers/fake-meta.mjs';
import { call, crash, sleep, until, whatsappLab } from './helpers/crm.mjs';
import { mediaGapMs } from '../server/lib/media-gap.mjs';
import { buttonTitle, headerRefusal, metaChannel } from '../server/connectors.mjs';
import { BUTTONS_PROMPT } from '../server/reply-copy.mjs';

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
  // el margen es una marca interna: no sale por la API de mensajes (como send_lease_until)
  const served = (await api('/api/conversations/' + image.conversation_id + '/messages')).messages;
  assert.ok(served.some(m => m.id === image.id));
  for (const m of served) assert.equal('wa_gap_until' in m, false);
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

// Segunda prueba real (21 nov 2026): la ficha que manda el asistente por su cuenta llegó en dos mensajes, el texto con
// sus tres botones y DESPUÉS la imagen. Un archivo con botones ahora es UN mensaje interactivo con el archivo de
// encabezado; si el cuerpo no cabe (más de 1024), el archivo primero y el texto aparte, con el margen entre los dos.
test('adaptador de Meta: archivo con botones en un solo interactivo con encabezado; si no cabe, archivo y luego texto con margen', async t => {
  const meta = await startFakeMeta();
  t.after(() => meta.close());
  const GAP = 400;
  const adapter = metaChannel({ env: { ...meta.env, NODE_ENV: 'test', WA_MEDIA_GAP_MS: String(GAP) } });
  const to = '5215533333333';
  const sentTo = () => meta.sent.filter(m => m.to === to);
  // imagen + texto + botones → un solo mensaje
  let r = await adapter.send({
    to,
    from: NUMBER,
    text: 'Plan sanitario para aves · Noviembre\n• Inicio: lunes, 23 de noviembre de 2026',
    buttons: ['Precio', 'Temario', 'Fechas'],
    media: { buffer: PNG, mime: 'image/png', filename: 'ficha.png' },
  });
  assert.equal(sentTo().length, 1);
  const one = sentTo()[0];
  assert.equal(one.type, 'interactive');
  assert.equal(one.interactive.type, 'button');
  assert.equal(one.interactive.header.type, 'image');
  assert.match(one.interactive.header.image.id, /^media-/);
  assert.match(one.interactive.body.text, /^Plan sanitario para aves/);
  assert.deepEqual(
    one.interactive.action.buttons.map(b => b.reply.title),
    ['Precio', 'Temario', 'Fechas'],
  );
  assert.equal(r.media, true, 'cuenta como archivo para el margen del siguiente mensaje');
  // PDF, WebP o GIF con botones: nunca como encabezado; el camino de dos partes de siempre (archivo y luego los botones)
  for (const [mime, name] of [
    ['application/pdf', 'temario.pdf'],
    ['image/webp', 'ficha.webp'],
    ['image/gif', 'ficha.gif'],
  ]) {
    const from0 = meta.sent.length;
    await adapter.send({
      to,
      from: NUMBER,
      text: 'El temario',
      buttons: ['Sí'],
      media: { buffer: Buffer.from('x'), mime, filename: name },
    });
    const got = meta.sent.slice(from0);
    assert.deepEqual(
      got.map(m => m.type),
      ['document', 'interactive'],
      mime,
    );
    assert.equal(got[1].interactive.header, undefined, mime);
  }
  // cuerpo de más de 1024 con botones: imagen, después del margen el texto y al final los botones con un cuerpo breve
  const before = meta.sent.length;
  const times = [];
  const timer = setInterval(() => {
    while (times.length < meta.sent.length - before) times.push(Date.now());
  }, 5);
  r = await adapter.send({
    to,
    from: NUMBER,
    text: 'x'.repeat(1500),
    buttons: ['Precio', 'Temario'],
    media: { buffer: PNG, mime: 'image/png', filename: 'ficha.png' },
  });
  await sleep(20);
  clearInterval(timer);
  const split = meta.sent.slice(before);
  assert.deepEqual(
    split.map(m => m.type),
    ['image', 'text', 'interactive'],
  );
  assert.equal(split[0].image.caption, undefined);
  assert.equal(split[1].text.body.length, 1500);
  assert.equal(split[2].interactive.body.text, BUTTONS_PROMPT);
  assert.deepEqual(
    split[2].interactive.action.buttons.map(b => b.reply.title),
    ['Precio', 'Temario'],
  );
  assert.ok(times[1] - times[0] >= GAP - 30, 'el texto esperó el margen: ' + (times[1] - times[0]) + ' ms');
  assert.equal(r.media, undefined, 'lo último fueron los botones');
  // sin archivo y con texto largo, tampoco se pierden los botones
  const from1 = meta.sent.length;
  await adapter.send({ to, from: NUMBER, text: 'y'.repeat(1200), buttons: ['Sí'] });
  assert.deepEqual(
    meta.sent.slice(from1).map(m => m.type),
    ['text', 'interactive'],
  );
  // sin archivo, los botones de siempre (sin encabezado)
  await adapter.send({ to, from: NUMBER, text: '¿Te cuento más?', buttons: ['Sí', 'No'] });
  assert.equal(sentTo().at(-1).interactive.header, undefined);
  // títulos de botón: hasta 20, sin partir un emoji
  assert.equal(buttonTitle('Inscribirme ya mismo 🎓'), 'Inscribirme ya mismo');
  assert.equal(buttonTitle('Quiero inscribirme🎓🎓'), 'Quiero inscribirme🎓');
  assert.equal(buttonTitle('🎓'.repeat(11)), '🎓'.repeat(10));
  assert.ok(!/[\uD800-\uDBFF]$/.test(buttonTitle('Diecinueve letras 🎓x')));
});

// Plan B: si Meta rechaza el interactivo con la imagen de encabezado (y no por autenticación, ritmo ni ventana de 24
// horas), se manda una vez como antes: imagen y luego el texto con sus botones. Sin duplicar.
test('adaptador de Meta: plan B del interactivo con imagen de encabezado', async () => {
  const run = async refusal => {
    const calls = [];
    const adapter = metaChannel({
      env: {
        META_ACCESS_TOKEN: 'EAAprueba0000000000000000000000token',
        META_APP_SECRET: 's',
        META_VERIFY_TOKEN: 'v',
        META_PHONE_NUMBER_ID: NUMBER,
        NODE_ENV: 'test',
        WA_MEDIA_GAP_MS: '0',
      },
      fetchImpl: async (url, init) => {
        const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
        calls.push(body);
        if (String(url).endsWith('/media')) return { ok: true, status: 200, json: async () => ({ id: 'm1' }) };
        if (body?.interactive?.header)
          return {
            ok: false,
            status: refusal.status,
            json: async () => ({ error: { code: refusal.code, message: 'x' } }),
          };
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.' + calls.length }] }) };
      },
    });
    const out = await adapter
      .send({
        to: '15550001111', // sin el reintento de México (521…), que repetiría la petición
        text: 'Ficha del curso',
        buttons: ['Precio'],
        media: { buffer: PNG, mime: 'image/png', filename: 'ficha.png' },
      })
      .catch(e => ({ error: e }));
    return { out, types: calls.filter(Boolean).map(c => (c.interactive?.header ? 'header' : c.type)) };
  };
  // Meta no admite el encabezado (parámetro inválido): plan B, una sola vez
  let r = await run({ status: 400, code: 100 });
  assert.deepEqual(r.types, ['header', 'image', 'interactive']);
  assert.match(r.out.providerRef, /^wamid\./);
  // token vencido, ritmo o ventana de 24 horas: no hay plan B (fallaría igual) y el error sube
  for (const refusal of [
    { status: 401, code: 190 },
    { status: 429, code: 130429 },
    { status: 400, code: 131047 },
  ]) {
    r = await run(refusal);
    assert.deepEqual(r.types, ['header'], JSON.stringify(refusal));
    assert.ok(r.out.error, JSON.stringify(refusal));
  }
  assert.equal(headerRefusal({ network: true, status: 502 }), false, 'sin respuesta de Meta no se sabe si salió');
});

test('la ficha del asistente por WhatsApp real sale como un solo mensaje: imagen de encabezado, texto y botones', async t => {
  const W = await whatsappLab(t, { AI_PROVIDER: '', WA_MEDIA_GAP_MS: '0' });
  await metaText(W.origin(), ANA, 'wamid.ficha.1', 'Hola');
  const card = await until(
    () => W.meta.sent.find(m => m.to === ANA && m.type === 'interactive' && m.interactive?.header),
    'la ficha salió a Meta',
    { logs: W.state.server.logs },
  );
  await sleep(800);
  const mine = W.meta.sent.filter(m => m.to === ANA);
  assert.equal(mine.length, 1, 'un solo mensaje: ' + JSON.stringify(mine.map(m => m.type)));
  assert.equal(card.interactive.header.type, 'image');
  assert.deepEqual(
    card.interactive.action.buttons.map(b => b.reply.title),
    ['Precio', 'Temario', 'Fechas'],
  );
  assert.ok(card.interactive.body.text.length <= 1024);
  // en el CRM sigue siendo un solo mensaje con su ficha y sus botones
  const saved = W.db
    .prepare(
      "SELECT m.buttons,m.flyer_snapshot FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.wa_peer=? AND m.sender_kind='automation'",
    )
    .all(ANA);
  assert.equal(saved.length, 1);
  assert.ok(saved[0].flyer_snapshot);
  assert.deepEqual(JSON.parse(saved[0].buttons), ['Precio', 'Temario', 'Fechas']);
});
