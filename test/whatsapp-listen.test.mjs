// Cambio de número de WhatsApp (I-11, docs/PLAN_CAMBIO_DE_NUMERO.md): modo escucha, abrir conversaciones recientes y
// registrar el número. Con el servidor real y el Meta de mentira: en escucha llega un mensaje y no queda su texto, ni
// conversación, ni respuesta, ni tarea, ni evento; los contadores suben; un teléfono de la lista de prueba sí conversa;
// nada más sale (chat, asistente, plantilla, difusión, programado); pasar a activo y abrir las recientes sin duplicar
// ni enviar; volver a escucha; registrar con PIN sin que el PIN quede en ningún lado; permisos, dos marcas y la
// migración. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { createListen, dayOf, normalizeAllow } from '../server/lib/wa-listen.mjs';
import { phoneKey } from '../server/lib/identity-keys.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { PASSWORD, call, until } from './helpers/crm.mjs';
import { whatsappLab } from './helpers/crm.mjs';
import { NUMBER, metaHook, metaInboundValue, metaStatus } from './helpers/fake-meta.mjs';

const MIGRATION = 'wa-cutover/0001-listen-mode';
const NUMBER2 = '109000000000002';
const PA = '5215511110001'; // escribió antes de la escucha y tiene conversación abierta
const PB = '5215511110002';
const PC = '5215511110003';
const PT = '5215511110009'; // teléfono del equipo, en la lista de prueba
const PD = '5215511110004'; // escribe al número de la otra marca
const PIN = '480913';
const FAST = {
  WA_BROADCAST_RATE_SCALE: '50',
  WA_BROADCAST_MAX_PER_SECOND: '1000',
  WA_BROADCAST_LEASE_MS: '4000',
  WA_BROADCAST_RECONCILE_MS: '5000',
};

const text = (lab, from, id, body, { to = NUMBER, bsuid } = {}) =>
  metaHook(lab.origin(), metaInboundValue(from, id, { type: 'text', text: { body } }, { to, bsuid }));
const resultOf = response => response.body.results[0].result;
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
// Toda celda de texto de cualquier tabla que contenga `needle`: [[tabla, valor]].
function cellsWith(db, needle) {
  const found = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all())
      for (const value of Object.values(row))
        if (typeof value === 'string' && value.includes(needle)) found.push([name, value]);
  return found;
}
const userOfPhone = (db, phone) =>
  db.prepare("SELECT user_id FROM identity_keys WHERE kind='wa_phone' AND wa_id=?").get(phone)?.user_id;

test('funciones puras: lista de prueba y día de los contadores', () => {
  assert.deepEqual(normalizeAllow(['+52 55 1111 0009', '5215511110009', '52 55 1111 0008']), {
    keys: ['525511110009', '525511110008'],
  });
  assert.match(normalizeAllow(['hola']).error, /no es válido/);
  assert.match(normalizeAllow('5215511110009').error, /lista/);
  assert.match(
    normalizeAllow(Array.from({ length: 11 }, (_, i) => '+52 55 1111 00' + String(10 + i))).error,
    /hasta 10/,
  );
  assert.equal(dayOf(Date.UTC(2026, 10, 15, 5, 30)), '2026-11-14', 'el día es el de la Ciudad de México');
});

test('migración wa-cutover/0001: los números que ya existen quedan activos, igual que hoy', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-escucha-mig-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== MIGRATION)) });
  db.prepare(
    "INSERT INTO wa_numbers(phone_number_id,brand_id,course_id,label,created_at,updated_at) VALUES(?,'globalvet','aves','Ventas',1,1)",
  ).run(NUMBER);
  const before = db.prepare('SELECT * FROM wa_numbers').get();
  assert.deepEqual(migrate(db, { backup: false }).applied, [MIGRATION]);
  assertSchemaCurrent(db);
  const after = db.prepare('SELECT * FROM wa_numbers').get();
  assert.deepEqual(
    [after.mode, after.listen_allow, after.mode_changed_at, after.registered_at],
    ['live', '[]', null, null],
  );
  for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, k);
  assert.throws(() => db.prepare("UPDATE wa_numbers SET mode='otro'").run(), /CHECK/);
  // la puerta deja salir todo de un número activo y de uno que no existe
  const listen = createListen({ db });
  assert.deepEqual(listen.canSendFrom(NUMBER, { to: PA }), { ok: true });
  assert.deepEqual(listen.canSendFrom('999', { to: PA }), { ok: true });
  db.prepare("UPDATE wa_numbers SET mode='listen',listen_allow=? WHERE phone_number_id=?").run(
    JSON.stringify(['525511110009']),
    NUMBER,
  );
  assert.deepEqual(listen.canSendFrom(NUMBER, { to: PT }), { ok: true, test: true });
  assert.equal(listen.canSendFrom(NUMBER, { to: PA }).code, 'number_listen_only');
  assert.equal(listen.canSendFrom(NUMBER, { recipient: 'MX.1001000000000001' }).ok, false);
  assert.throws(
    () => listen.gate({ from: NUMBER, to: PA }),
    e => e.status === 409 && e.code === 'number_listen_only',
  );
  // contrato con la API de envío: listenOnly('wa:' + phone_number_id, clave de teléfono | null) → ¿NO debe salir?
  assert.equal(listen.listenOnly('wa:' + NUMBER, phoneKey(PA, { international: true })), true);
  assert.equal(listen.listenOnly('wa:' + NUMBER, phoneKey(PT, { international: true })), false, 'lista de prueba');
  assert.equal(listen.listenOnly('wa:' + NUMBER, null), true, 'sin teléfono no hay lista de prueba');
  assert.equal(listen.listenOnly('wa:999', null), false, 'número desconocido');
  db.prepare("UPDATE wa_numbers SET mode='live' WHERE phone_number_id=?").run(NUMBER);
  assert.equal(listen.listenOnly('wa:' + NUMBER, null), false, 'activo');
  db.prepare("UPDATE wa_numbers SET mode='listen' WHERE phone_number_id=?").run(NUMBER);
  assert.deepEqual(migrate(db, { backup: false }).applied, [], 'una sola vez');
});

test('escucha de punta a punta: cuenta sin guardar, nada sale salvo a la lista de prueba, abrir recientes, volver a escucha, registrar con PIN, permisos y dos marcas', async t => {
  const lab = await whatsappLab(t, FAST);
  const { db, meta } = lab;
  const api = (path, { cookie = lab.admin, ...options } = {}) => call(lab.origin(), path, { cookie, ...options });
  const cutover = async () => (await api('/api/whatsapp/cutover')).numbers.find(n => n.id === NUMBER);
  const sentTo = phone => meta.sent.filter(m => m.to === phone && !m.refused);

  // 0) antes de la escucha: A escribe, nace su conversación y el asistente le contesta
  assert.match(resultOf(await text(lab, PA, 'wamid.a-0', 'Hola, quiero informes')), /^recibido: conversación nueva/);
  await until(() => sentTo(PA).length, 'el asistente contesta a A');
  const userA = userOfPhone(db, PA);
  const convA = db.prepare('SELECT * FROM conversations WHERE customer_id=?').get(userA);
  const first = await cutover();
  assert.deepEqual([first.mode, first.listenAllow, first.registeredAt], ['live', [], null]);

  // 1) a escucha: con revisión, lista de prueba válida, y un reintento no repite el cambio
  await api('/api/whatsapp/numbers/' + NUMBER + '/mode', {
    body: { mode: 'listen', expectedRevision: first.revision + 5 },
    expected: 409,
  });
  await api('/api/whatsapp/numbers/' + NUMBER + '/mode', {
    body: { mode: 'listen', listenAllow: ['no es un teléfono'], expectedRevision: first.revision },
    expected: 400,
  });
  const ref = 'modo-' + randomUUID();
  const toListen = {
    mode: 'listen',
    listenAllow: ['+52 55 1111 0009'],
    expectedRevision: first.revision,
    clientRef: ref,
  };
  const listening = (await api('/api/whatsapp/numbers/' + NUMBER + '/mode', { body: toListen })).number;
  assert.deepEqual([listening.mode, listening.listenAllow], ['listen', ['525511110009']]);
  assert.equal(
    (await api('/api/whatsapp/numbers/' + NUMBER + '/mode', { body: toListen })).number.revision,
    listening.revision,
    'el reintento devuelve lo mismo',
  );
  assert.equal(count(db, "SELECT count(*) n FROM wa_number_log WHERE action='listen'"), 1);
  assert.equal(count(db, "SELECT count(*) n FROM audit WHERE action='whatsapp.number.listen'"), 1);
  await api('/api/whatsapp/numbers/' + NUMBER + '/open-recent', { body: {}, expected: 409 });

  // 2) entrantes en escucha: B (nuevo) dos veces, C (nuevo), A (con conversación abierta) y un estado ajeno
  const tables = ['conversations', 'messages', 'jobs', 'tasks', 'contacts', 'opportunities', 'attachments'];
  const snapshot = () => Object.fromEntries(tables.map(name => [name, count(db, `SELECT count(*) n FROM ${name}`)]));
  const events0 = count(db, 'SELECT count(*) n FROM domain_events');
  const before = snapshot();
  const secret = 'Mi clave secreta es Ballena-7';
  assert.match(resultOf(await text(lab, PB, 'wamid.l-1', secret)), /^escucha: mensaje contado/);
  assert.match(resultOf(await text(lab, PB, 'wamid.l-2', 'otra vez')), /^escucha/);
  assert.match(resultOf(await text(lab, PC, 'wamid.l-3', 'hola')), /^escucha/);
  assert.match(resultOf(await text(lab, PA, 'wamid.l-4', secret)), /^escucha/);
  // una imagen: no se descarga
  await metaHook(
    lab.origin(),
    metaInboundValue(PC, 'wamid.l-5', { type: 'image', image: { id: '777000111', mime_type: 'image/png' } }),
  );
  const alien = await metaStatus(lab.origin(), 'wamid.del-proveedor-anterior', 'delivered', { recipient: PB });
  assert.match(resultOf(alien), /escucha: estado de un mensaje del proveedor anterior/);
  // alguien sin teléfono ni identificador: a la cuarentena, y se cuenta como «sin identidad»
  await text(lab, '', 'wamid.l-6', 'sin remitente');
  assert.equal(lab.inboxRow('wamid.l-6').state, 'failed');

  assert.deepEqual(snapshot(), before, 'ni conversación, ni mensaje, ni trabajo, ni tarea, ni contacto');
  assert.equal(count(db, 'SELECT count(*) n FROM domain_events'), events0, 'ningún evento de negocio');
  assert.equal(meta.downloads.length, 0, 'el archivo no se descarga');
  for (const id of ['wamid.l-1', 'wamid.l-4'])
    assert.equal(lab.inboxRow(id).payload, null, 'la bandeja no guarda la carga');
  const userB = userOfPhone(db, PB),
    userC = userOfPhone(db, PC);
  assert.ok(userB && userC, 'la identidad se resuelve');
  for (const u of [userA, userB, userC])
    assert.ok(db.prepare('SELECT 1 FROM wa_peer_state WHERE phone_number_id=? AND user_id=?').get(NUMBER, u));
  assert.deepEqual(cellsWith(db, 'Ballena-7'), [], 'el texto no queda en ninguna tabla');
  await new Promise(done => setTimeout(done, 1200)); // el asistente tendría tiempo de contestar (trabajo a 700 ms)
  assert.equal(sentTo(PB).length + sentTo(PC).length, 0, 'nadie contestó');

  const listenStats = (await cutover()).listen;
  assert.deepEqual(
    [
      listenStats.days[0].received,
      listenStats.days[0].people,
      listenStats.days[0].statuses,
      listenStats.days[0].errors,
    ],
    [5, 3, 1, 0],
  );
  assert.deepEqual([listenStats.quarantine, listenStats.days[0].unidentified], [1, 1]);

  // 3) nada sale por el número en escucha: chat, plantilla, asistente (mensaje automático), programado y difusión
  const sent0 = meta.sent.length;
  const failedReason = id =>
    db.prepare("SELECT failed_reason FROM messages WHERE id=? AND delivery_state='failed'").get(id)?.failed_reason;
  const chat = await api('/api/conversations/' + convA.id + '/messages', {
    body: { text: 'Te escribo desde el CRM', clientRef: 'chat-' + randomUUID() },
    expected: 201,
  });
  assert.match(await until(() => failedReason(chat.id), 'el chat no sale'), /modo escucha/);
  const tpl = randomUUID();
  db.prepare(
    "INSERT INTO wa_templates(id,brand_id,waba_id,name,language,category,body,variables,components,status,revision,created_at,updated_at) VALUES(?,'globalvet','','aviso_escucha','es_MX','utility',?,'[]',?,'approved',1,1,1)",
  ).run(
    tpl,
    'Te escribimos de la escuela.',
    JSON.stringify({
      type: 'standard',
      header: { type: 'none' },
      body: { text: 'Te escribimos de la escuela.', vars: [] },
      footer: { text: '' },
      buttons: [],
    }),
  );
  const sentTpl = await api('/api/conversations/' + convA.id + '/wa-templates', {
    body: { templateId: tpl, clientRef: 'tpl-' + randomUUID() },
    expected: 201,
  });
  assert.match(await until(() => failedReason(sentTpl.id), 'la plantilla no sale'), /modo escucha/);
  const auto = randomUUID();
  db.prepare(
    "INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at,category) VALUES(?,?,'automation','Respuesta del asistente',?,?,'service')",
  ).run(auto, convA.id, 'auto-' + auto, Date.now());
  assert.match(await until(() => failedReason(auto), 'el asistente no sale'), /modo escucha/);
  const scheduled = (
    await api('/api/conversations/' + convA.id + '/scheduled', {
      body: { text: 'Recordatorio programado', sendAt: Date.now() + 120_000, clientRef: 'prog-' + randomUUID() },
      expected: 201,
    })
  ).item;
  await api('/api/scheduled/' + scheduled.id + '/send-now', { body: {} });
  const scheduledMessage = await until(
    () => db.prepare("SELECT id FROM messages WHERE text='Recordatorio programado'").get()?.id,
    'el programado se guarda',
  );
  assert.match(await until(() => failedReason(scheduledMessage), 'el programado no sale'), /modo escucha/);
  // difusión con plantilla a la lista que incluye a A (difusiones y automatización encendidas en la marca)
  const brand = await api('/api/campaigns/settings');
  await api('/api/campaigns/settings/globalvet', {
    method: 'PATCH',
    body: {
      enabled: true,
      minGapHours: 0,
      expectedRevision: (brand.settings || []).find?.(x => x.brand_id === 'globalvet')?.revision ?? 0,
    },
  });
  const automation = await api('/api/automation');
  await api('/api/automation/brands/globalvet', {
    method: 'PATCH',
    body: {
      enabled: true,
      expectedRevision:
        automation.brands?.find?.(b => b.brandId === 'globalvet' || b.id === 'globalvet')?.revision ?? 0,
    },
  });
  const s = (await api('/api/broadcasts/settings?brand=globalvet')).settings;
  await api('/api/broadcasts/settings/globalvet', {
    method: 'PATCH',
    body: { quietStart: '00:00', quietEnd: '00:00', dailyCap: 100, expectedRevision: s.revision },
  });
  const t0 = Date.now();
  db.prepare(
    "INSERT INTO wa_account(waba_id,created_at,updated_at) VALUES('local',?,?) ON CONFLICT(waba_id) DO NOTHING",
  ).run(t0, t0);
  db.prepare("UPDATE wa_account SET messaging_limit='TIER_10K',limit_value=NULL,limit_source='meta'").run();
  db.prepare("UPDATE wa_templates SET category='marketing' WHERE id=?").run(tpl);
  const contactA = db.prepare('SELECT id FROM contacts WHERE source_user_id=?').get(userA).id;
  db.prepare(
    "INSERT INTO contact_consent(contact_id,brand_id,status,source,updated_at) VALUES(?,'globalvet','opted_in','prueba',?) ON CONFLICT(contact_id) DO UPDATE SET status='opted_in'",
  ).run(contactA, t0);
  const list = randomUUID();
  db.prepare(
    "INSERT INTO audiences(id,brand_id,kind,role,name,name_key,definition,member_count,created_at,updated_at) VALUES(?,'globalvet','list','audience','Escucha','escucha','{}',1,?,?)",
  ).run(list, t0, t0);
  db.prepare("INSERT INTO audience_members(audience_id,contact_id,source,added_at) VALUES(?,?,'manual',?)").run(
    list,
    contactA,
    t0,
  );
  const draft = (
    await api('/api/broadcasts', {
      expected: 201,
      body: {
        brandId: 'globalvet',
        waNumber: NUMBER,
        waTemplateId: tpl,
        segment: { audienceId: list },
        content: { context: { courseId: 'aves' } },
        clientRef: 'dif-' + randomUUID(),
      },
    })
  ).campaign;
  const { preview } = await api(`/api/broadcasts/${draft.id}/preview`, { body: {} });
  assert.equal(preview.eligible, 1);
  assert.ok(
    preview.blockers.some(b => b.code === 'number_listen_only'),
    'la vista previa avisa que el número está en escucha',
  );
  const blocked = await api(`/api/broadcasts/${draft.id}/schedule`, {
    body: { expectedRevision: draft.revision, confirmAudience: preview.willSend, acceptCost: true },
    expected: 409,
  });
  assert.equal(blocked.code, 'blocked', 'una difusión real no se programa por un número en escucha');
  assert.equal(
    db.prepare('SELECT count(*) n FROM campaign_recipients WHERE campaign_id=?').get(draft.id).n,
    0,
    'no se reserva ningún destinatario',
  );
  assert.equal(meta.sent.length, sent0, 'a Meta no llegó ningún envío');

  // 4) el teléfono de la lista de prueba sí conversa: entra normal, el asistente le contesta y el equipo le escribe
  assert.match(resultOf(await text(lab, PT, 'wamid.t-1', 'Prueba del equipo')), /^recibido: conversación nueva/);
  await until(() => sentTo(PT).length, 'el asistente contesta al teléfono de prueba');
  const convT = db.prepare('SELECT * FROM conversations WHERE customer_id=?').get(userOfPhone(db, PT));
  const manual = await api('/api/conversations/' + convT.id + '/messages', {
    body: { text: 'Envío manual de prueba', clientRef: 'man-' + randomUUID() },
    expected: 201,
  });
  await until(
    () => meta.sent.some(m => m.to === PT && m.text?.body === 'Envío manual de prueba'),
    'el envío manual sale',
  );
  assert.equal(failedReason(manual.id), undefined);
  assert.equal((await cutover()).listen.days[0].received, 5, 'lo de la lista de prueba no se cuenta como escucha');

  // 5) otra marca: su número sigue activo y no se mezcla
  await api('/api/whatsapp/numbers/' + NUMBER2, {
    method: 'PUT',
    body: { brandId: 'odonteck', label: 'Línea OdonTeck', expectedRevision: 0 },
  });
  assert.match(resultOf(await text(lab, PD, 'wamid.o-1', 'Hola OdonTeck', { to: NUMBER2 })), /^recibido/);
  const other = (await api('/api/whatsapp/cutover')).numbers.find(n => n.id === NUMBER2);
  assert.deepEqual([other.brandId, other.mode, other.listen.days[0].received], ['odonteck', 'live', 0]);

  // 6) a activo y «Abrir conversaciones recientes»: vista previa, sin duplicar, en espera, sin asistente y sin enviar
  const sent1 = meta.sent.length;
  const live = (
    await api('/api/whatsapp/numbers/' + NUMBER + '/mode', {
      body: { mode: 'live', expectedRevision: (await cutover()).revision },
    })
  ).number;
  assert.equal(live.mode, 'live');
  assert.ok(live.rollbackRehearsedAt, 'escucha → activo cuenta como vuelta ensayada');
  await api('/api/whatsapp/numbers/' + NUMBER + '/open-recent', { body: { hours: 30 }, expected: 400 });
  const look = await api('/api/whatsapp/numbers/' + NUMBER + '/open-recent', { body: { preview: true } });
  // A, B, C y el teléfono de prueba escribieron; A y el de prueba ya tienen conversación abierta. D escribió a otra marca.
  assert.deepEqual([look.eligible, look.existing, look.toOpen], [4, 2, 2]);
  assert.equal(
    count(db, 'SELECT count(*) n FROM conversations'),
    before.conversations + 2,
    'la vista previa no escribe',
  );
  const opened = await api('/api/whatsapp/numbers/' + NUMBER + '/open-recent', { body: {} });
  assert.deepEqual([opened.opened, opened.existing], [2, 2]);
  for (const u of [userB, userC]) {
    const c = db.prepare('SELECT * FROM conversations WHERE customer_id=?').get(u);
    assert.deepEqual(
      [c.status, c.bot_enabled, c.wa_number, c.brand_id],
      ['waiting', 0, NUMBER, 'globalvet'],
      'en espera de una persona',
    );
    assert.equal(c.wa_peer, u === userB ? PB : PC);
    const msgs = db.prepare('SELECT sender_kind,text FROM messages WHERE conversation_id=?').all(c.id);
    assert.deepEqual(
      msgs.map(m => m.sender_kind),
      ['system'],
    );
    assert.equal(msgs[0].text.includes('Ballena'), false);
    assert.ok(db.prepare('SELECT 1 FROM contacts WHERE source_user_id=? AND brand_id=?').get(u, 'globalvet'));
  }
  assert.equal(count(db, "SELECT count(*) n FROM conversations WHERE brand_id='odonteck'"), 1, 'D no se toca');
  const again = await api('/api/whatsapp/numbers/' + NUMBER + '/open-recent', { body: {} });
  assert.deepEqual([again.opened, again.existing], [0, 4], 'repetirla no duplica');
  // cerrada por el equipo, tampoco se vuelve a abrir en este mismo cambio
  db.prepare("UPDATE conversations SET status='resolved' WHERE customer_id=?").run(userB);
  assert.equal((await api('/api/whatsapp/numbers/' + NUMBER + '/open-recent', { body: {} })).opened, 0);
  await new Promise(done => setTimeout(done, 1000));
  assert.equal(meta.sent.length, sent1, 'abrir recientes no envía nada');
  assert.equal(count(db, "SELECT count(*) n FROM wa_number_log WHERE action='open_recent'"), 3);

  // 7) vuelta atrás: de activo otra vez a escucha
  const back = (
    await api('/api/whatsapp/numbers/' + NUMBER + '/mode', {
      body: { mode: 'listen', expectedRevision: (await cutover()).revision },
    })
  ).number;
  assert.deepEqual([back.mode, back.listenAllow], ['listen', ['525511110009']], 'la lista de prueba se conserva');
  assert.deepEqual(
    back.history.slice(0, 3).map(h => h.action),
    ['listen', 'open_recent', 'open_recent'],
  );

  // 8) registrar con PIN: llega a Meta y no queda en la base, la bitácora, la auditoría ni la salida del servidor
  const register = (body, expected = 200, cookie = lab.admin) =>
    api('/api/whatsapp/numbers/' + NUMBER + '/register', { cookie, body, expected });
  const done = await register({ pin: PIN });
  assert.deepEqual([done.ok, done.simulated], [true, false]);
  assert.deepEqual(meta.registration.calls, [{ id: NUMBER, messaging_product: 'whatsapp', pin: PIN }]);
  assert.ok((await cutover()).registeredAt);
  meta.registration.fail = { code: 136025, message: 'El PIN {pin} no coincide' };
  const refused = await register({ pin: PIN }, 400);
  assert.equal(JSON.stringify(refused).includes(PIN), false, 'el error no repite el PIN');
  assert.match(refused.error, /······/);
  await register({ pin: '12' }, 400);
  await register({ pin: PIN }, 429); // tres intentos por hora por número
  assert.equal(meta.registration.calls.length, 2);
  // como valor, entre comillas (JSON) o junto a la palabra «pin»; una marca de tiempo con esos dígitos no cuenta
  assert.deepEqual(
    cellsWith(db, PIN).filter(([, v]) => v === PIN || v.includes('"' + PIN + '"') || /pin/i.test(v)),
    [],
    'el PIN no queda en la base',
  );
  assert.equal(count(db, "SELECT count(*) n FROM audit WHERE action='whatsapp.number.registered'"), 1);
  // ni siquiera en las páginas del archivo (lo que nunca se escribió no puede quedar como resto)
  for (const file of ['laboratorio.sqlite', 'laboratorio.sqlite-wal']) {
    const bytes = await readFile(join(lab.dir, file)).catch(() => Buffer.alloc(0));
    assert.equal(bytes.toString('latin1').includes('"' + PIN + '"'), false, file);
  }
  assert.equal(lab.state.server.logs().includes(PIN), false, 'ni en la salida del servidor');

  // 9) permisos: el equipo sin channels.whatsapp.connect no ve ni cambia nada
  const agent = (
    await call(lab.origin(), '/api/auth/register', {
      body: { username: 'asesor-gv', name: 'Asesor GlobalVet', password: PASSWORD },
    })
  ).cookie;
  const agentId = db.prepare("SELECT id FROM users WHERE username='asesor-gv'").get().id;
  db.prepare("UPDATE users SET role='agent' WHERE id=?").run(agentId);
  db.prepare("INSERT INTO brand_members(user_id,brand_id) VALUES(?,'globalvet')").run(agentId);
  await api('/api/whatsapp/cutover', { cookie: agent, expected: 403 });
  await api('/api/whatsapp/numbers/' + NUMBER + '/mode', {
    cookie: agent,
    body: { mode: 'live', expectedRevision: back.revision },
    expected: 403,
  });
  await api('/api/whatsapp/numbers/' + NUMBER + '/open-recent', {
    cookie: agent,
    body: { preview: true },
    expected: 403,
  });
  await register({ pin: PIN }, 403, agent);
  assert.equal((await cutover()).mode, 'listen');
});

test('registrar el número con WhatsApp simulado responde bien sin llamar a nadie', async t => {
  const lab = await whatsappLab(t, { CHANNEL_CONNECTOR: 'simulated' });
  const out = await call(lab.origin(), '/api/whatsapp/numbers/' + NUMBER + '/register', {
    cookie: lab.admin,
    body: { pin: PIN },
  });
  assert.deepEqual([out.ok, out.simulated], [true, true]);
  assert.equal(lab.meta.registration.calls.length, 0);
  assert.equal(lab.db.prepare("SELECT detail FROM wa_number_log WHERE action='register'").get().detail, 'simulado');
});
