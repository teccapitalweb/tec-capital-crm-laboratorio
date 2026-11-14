// Huella con llave de quien escribe (server/lib/peer-key.mjs): el carril de la bandeja de webhooks y los ids de
// eventos que dependen de una persona ya no son el SHA-256 simple de su teléfono (reversible probando todos los
// números) y siguen siendo estables tras reiniciar el servidor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneOf, metaChannel } from '../server/connectors.mjs';
import { PEER_KEY_FILE, createPeerHash, loadPeerKey } from '../server/lib/peer-key.mjs';
import { metaBody, metaNotice, metaText } from './helpers/fake-meta.mjs';
import { crash, sleep, whatsappLab } from './helpers/crm.mjs';

const PHONE = '5215512345678';
const plain = v => createHash('sha256').update(v).digest('hex').slice(0, 16);
const preference = (phone = PHONE) => ({
  messaging_product: 'whatsapp',
  user_preferences: [{ wa_id: phone, category: 'marketing_messages', value: 'stop', timestamp: 1795000000 }],
});

test('la llave de la instalación: archivo propio en DATA_DIR, estable, o de PEER_HASH_KEY', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-peer-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = loadPeerKey({ env: {}, dataDir: dir });
  assert.equal(first.length, 32);
  assert.deepEqual(loadPeerKey({ env: {}, dataDir: dir }), first, 'la segunda vez lee la misma');
  assert.match((await readFile(join(dir, PEER_KEY_FILE), 'utf8')).trim(), /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, PEER_KEY_FILE))).mode & 0o777, 0o600);
  const fromEnv = loadPeerKey({ env: { PEER_HASH_KEY: 'llave de prueba' }, dataDir: dir });
  assert.notDeepEqual(fromEnv, first, 'la variable de entorno manda sobre el archivo');
  assert.deepEqual(loadPeerKey({ env: { PEER_HASH_KEY: 'llave de prueba' } }), fromEnv);
  const hash = createPeerHash(first);
  assert.match(hash(PHONE), /^[0-9a-f]{16}$/);
  assert.equal(hash(PHONE), createPeerHash(loadPeerKey({ env: {}, dataDir: dir }))(PHONE));
  assert.notEqual(hash(PHONE), plain(PHONE), 'no es el SHA-256 simple');
  assert.notEqual(hash(PHONE), createPeerHash(fromEnv)(PHONE), 'otra llave, otra huella');
  assert.throws(() => laneOf('channel', 'meta', { id: 'w', type: 'message.inbound', data: { from: PHONE } }));
  // ids de preferencias: con la huella con llave, nunca con el teléfono ni con su SHA-256 simple
  const [pref] = metaChannel({ env: {}, peerHash: hash }).parseWebhook(
    metaBody(preference(), { field: 'user_preferences', time: 1795000000 }),
  );
  assert.equal(pref.id.includes(hash(PHONE)), true);
  assert.equal(pref.id.includes(plain(PHONE)) || pref.id.includes(PHONE), false);
});

test('carril e id de preferencias estables tras reiniciar; un carril guardado sin llave se recalcula al arrancar', async t => {
  const lab = await whatsappLab(t, { WEBHOOK_INBOX_WAIT_MS: '0', WEBHOOK_INBOX_PAUSED: '1' });
  const { db, inboxRow } = lab;
  const key = await readFile(join(lab.dir, PEER_KEY_FILE), 'utf8');
  await metaText(lab.origin(), PHONE, 'wamid.k-1', 'Hola');
  await metaNotice(lab.origin(), 'user_preferences', preference(), { time: 1795000000 });
  await sleep(300);
  const lane = inboxRow('wamid.k-1').lane;
  assert.match(lane, /^in:meta:\d+:[0-9a-f]{16}$/);
  assert.equal(lane.endsWith(plain(PHONE)), false, 'el carril no es el SHA-256 simple del teléfono');
  const prefs = () => db.prepare("SELECT event_id,lane FROM webhook_inbox WHERE type='user.preference'").all();
  assert.equal(prefs().length, 1);
  const prefId = prefs()[0].event_id;
  assert.equal(prefId.includes(plain(PHONE)) || prefId.includes(PHONE), false);

  // un evento guardado por la versión anterior (carril con SHA-256 simple) y uno ya terminado con huella
  db.prepare(
    "INSERT INTO webhook_inbox(kind,provider,event_id,type,lane,payload,next_attempt_at,received_at,updated_at) VALUES('channel','meta','wamid.viejo','message.inbound',?,?,0,0,0)",
  ).run(
    lane.replace(/[0-9a-f]{16}$/, plain(PHONE)),
    JSON.stringify({
      v: '1.0',
      event: { id: 'wamid.viejo', type: 'message.inbound', data: { from: PHONE, to: lane.split(':')[2] } },
    }),
  );
  db.prepare(
    "INSERT INTO webhook_inbox(kind,provider,event_id,type,lane,payload,state,next_attempt_at,received_at,updated_at) VALUES('channel','meta','wamid.hecho','message.inbound',?,NULL,'done',0,0,0)",
  ).run(lane.replace(/[0-9a-f]{16}$/, plain(PHONE)));

  await crash(lab.state.server);
  await lab.start();
  assert.equal(await readFile(join(lab.dir, PEER_KEY_FILE), 'utf8'), key, 'la llave persiste');
  assert.equal(inboxRow('wamid.viejo').lane, lane, 'el pendiente sin llave queda en el carril de la persona');
  assert.equal(inboxRow('wamid.hecho').lane, 'ev:meta:wamid.hecho', 'el terminado pierde la huella');
  assert.equal(inboxRow('wamid.k-1').lane, lane, 'el pendiente con llave no cambia');
  await metaText(lab.origin(), PHONE, 'wamid.k-2', 'Sigo aquí');
  await metaNotice(lab.origin(), 'user_preferences', preference(), { time: 1795000000 });
  await sleep(300);
  assert.equal(inboxRow('wamid.k-2').lane, lane, 'la misma persona, el mismo carril tras reiniciar');
  assert.deepEqual(
    prefs().map(row => row.event_id),
    [prefId],
    'el mismo aviso de Meta tras reiniciar tiene el mismo id: no se duplica',
  );
});
