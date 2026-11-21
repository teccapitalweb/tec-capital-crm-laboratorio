// El margen tras un archivo (server/channel.mjs, docs/PLAN_WHATSAPP_REAL.md) frente a los envíos en duda y a un reloj
// atrasado, sin servidor: la base migrada, un conector de mentira y el reloj en la mano.
//  · Lo que sigue a un archivo en el mismo lote no pierde su marca de «envío en duda»: una plantilla en duda falla sin
//    llegar a Meta (no se repite) y un texto en duda conserva su marca y su intento y se reintenta una sola vez, con
//    un solo rastro «lease_expired».
//  · Un margen más lejano que ahora + el máximo (el reloj se atrasó) se da por vencido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { createChannel } from '../server/channel.mjs';
import { MEDIA_GAP_MAX_MS } from '../server/lib/media-gap.mjs';

const NUMBER = '109000000000001';
const GAP = 2500;

async function lab(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-margen-'));
  const db = openDatabase(dir);
  migrate(db, { backup: false });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const clock = { now: Date.now() };
  const user = randomUUID();
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,'customer',0,?,?)",
  ).run(user, 'margen-' + user.slice(0, 8), 'Persona de prueba', 'x', clock.now, clock.now);
  const conv = randomUUID();
  db.prepare(
    "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at,wa_number,wa_peer) VALUES(?,?,'globalvet','aves','whatsapp',?,?,?,?)",
  ).run(conv, user, clock.now, clock.now, NUMBER, '5215511111111');
  const add = (kind, extra = {}) => {
    const id = randomUUID();
    db.prepare(
      'INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at,wa_template,send_lease_until,send_attempts) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      conv,
      kind,
      extra.text ?? 'texto',
      'ref-' + id,
      clock.now,
      extra.template ?? null,
      extra.lease ?? null,
      extra.attempts ?? 0,
    );
    return id;
  };
  add('customer', { text: 'Hola' }); // la ventana de 24 h está abierta
  const sent = [];
  const channel = createChannel({
    db,
    crm: null,
    body: null,
    json: null,
    audit: () => {},
    broadcast: () => {},
    accessConversation: null,
    now: () => clock.now,
    mediaGap: GAP,
  });
  const media = new Set();
  channel.useOutbound(async m => ({ id: m.id, to: '5215511111111', from: NUMBER, text: 'x' }));
  channel.useConnector(() => ({
    send: async out => {
      sent.push(out.id);
      return {
        providerRef: 'wamid.' + out.id,
        state: 'sent',
        reason: null,
        ...(media.has(out.id) ? { media: true } : {}),
      };
    },
  }));
  const row = id => db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  const trail = id =>
    db
      .prepare('SELECT state FROM channel_events WHERE message_id=? ORDER BY seq')
      .all(id)
      .map(e => e.state);
  return { db, clock, add, sent, media, channel, row, trail };
}

test('lo que sigue a un archivo conserva su «envío en duda»: la plantilla no se repite y el texto se reintenta una vez', async t => {
  const L = await lab(t);
  const past = L.clock.now - 1000; // el proceso murió con estos dos en vuelo: su marca ya venció
  const a = L.add('automation', { text: 'ficha' });
  L.media.add(a);
  const b = L.add('automation', { template: JSON.stringify({ name: 'aviso' }), lease: past, attempts: 1 });
  const c = L.add('automation', { text: 'botones', lease: past, attempts: 1 });
  await L.channel.tick();
  assert.deepEqual(L.sent, [a], 'sólo salió el archivo');
  // la plantilla en duda falla sin llegar a Meta, con su motivo y un solo rastro
  const rb = L.row(b);
  assert.equal(rb.delivery_state, 'failed');
  assert.match(rb.failed_reason, /No se confirmó si este mensaje salió/);
  assert.deepEqual(L.trail(b), ['failed']);
  // el texto en duda conserva su marca (vencida) y su intento; todavía sin rastro
  const rc = L.row(c);
  assert.equal(rc.provider_ref, null);
  assert.ok(rc.send_lease_until !== null && rc.send_lease_until <= L.clock.now);
  assert.equal(rc.send_attempts, 2);
  assert.deepEqual(L.trail(c), []);
  // pasa el margen: el texto sale una sola vez, con un solo «lease_expired»; la plantilla nunca
  L.clock.now += GAP + 1;
  await L.channel.tick();
  await L.channel.tick();
  assert.deepEqual(L.sent, [a, c]);
  assert.deepEqual(L.trail(c), ['lease_expired', 'sent']);
  assert.equal(L.sent.filter(id => id === b).length, 0);
});

test('lo que sigue a un archivo, sin duda, se suelta sin contar el intento; un margen del futuro lejano se da por vencido', async t => {
  const L = await lab(t);
  const a = L.add('automation', { text: 'ficha' });
  L.media.add(a);
  const b = L.add('automation', { text: 'botones' });
  await L.channel.tick();
  assert.deepEqual(L.sent, [a]);
  assert.deepEqual([L.row(b).send_lease_until, L.row(b).send_attempts], [null, 0]);
  await L.channel.tick();
  assert.deepEqual(L.sent, [a], 'espera el margen');
  // el reloj se atrasó: el margen queda más lejos que ahora + el máximo → vencido
  L.db.prepare('UPDATE messages SET wa_gap_until=? WHERE id=?').run(L.clock.now + MEDIA_GAP_MAX_MS + 60_000, a);
  await L.channel.tick();
  assert.deepEqual(L.sent, [a, b]);
});
