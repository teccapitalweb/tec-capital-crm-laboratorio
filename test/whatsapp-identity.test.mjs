// Identidad por identificador de usuario de WhatsApp (docs/PLAN_IDENTIDAD_SIN_TELEFONO.md, incremento I-2): quien
// escribe sin que Meta entregue su teléfono nace, conversa y recibe respuesta por su identificador; vuelve sin
// duplicarse; su teléfono aparece después y su contacto se completa o se fusiona; los conflictos quedan para revisión;
// dos marcas no se mezclan; la cuarentena se reprocesa; la ventana es por persona y número; una difusión llega por el
// identificador; permisos y enmascarado; y la migración con su relleno. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { metaChannel } from '../server/connectors.mjs';
import { backfillStep, displayOf, hint, isBsuid, peerOf, scopeOf } from '../server/lib/identity.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { PASSWORD, call, until, whatsappLab } from './helpers/crm.mjs';
import { NUMBER, WABA, metaBody, metaHook, metaInboundValue, metaStatus } from './helpers/fake-meta.mjs';

const MIGRATION = 'identity/0002-user-keys';
const NUMBER2 = '109000000000002';
const WABA2 = 'waba-2';
const B1 = 'MX.1001000000000001';
const P1 = '5215511110001';

// Un entrante de texto como lo manda Meta; `from` vacío: la persona no comparte su teléfono.
const inbound = (lab, from, id, body, { bsuid, username, name, entryId = WABA, to = NUMBER } = {}) =>
  metaHook(
    lab.origin(),
    metaInboundValue(from, id, { type: 'text', text: { body } }, { bsuid, username, to, ...(name ? { name } : {}) }),
    { entryId },
  );
const resultOf = response => response.body.results[0].result;
const keyOf = (db, kind, value) => db.prepare('SELECT * FROM identity_keys WHERE kind=? AND value=?').get(kind, value);
const userOf = (db, value) => keyOf(db, 'wa_bsuid', value)?.user_id;
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

test('funciones puras: forma del identificador, quién escribe, número visible y ámbito', () => {
  assert.equal(isBsuid(B1), true);
  assert.equal(isBsuid('US.13491208655302741918'), true);
  for (const bad of ['', 'mx.123', 'MX123', 'MX.', 'M.123', 'MX.a b', 'MX.' + 'x'.repeat(129), null, 5215511110001])
    assert.equal(isBsuid(bad), false, String(bad));
  assert.equal(hint(B1), '0001');
  assert.deepEqual(peerOf({ from: '', peer: { ids: [{ kind: 'wa_bsuid', value: B1 }], username: '@ana' } }), {
    phone: '',
    bsuid: B1,
    parent: '',
    username: 'ana',
    name: '',
  });
  assert.equal(peerOf({ from: P1, name: 'Ana <b>' }).phone, P1);
  assert.equal(peerOf({ from: P1, name: 'Ana <b>' }).name, 'Ana b');
  assert.equal(peerOf({ from: '12', peer: { ids: [{ kind: 'wa_bsuid', value: 'no válido' }] } }).bsuid, '');
  assert.equal(displayOf({ phone: P1 }), '+' + P1);
  assert.equal(displayOf({ username: 'ana', bsuid: B1 }), '@ana');
  assert.equal(displayOf({ bsuid: B1 }), 'Número oculto ··0001');
  assert.equal(scopeOf({ phone_number_id: NUMBER }), 'num:' + NUMBER);
  assert.equal(scopeOf({ phone_number_id: NUMBER, waba_id: '7' }), 'waba:7');
  assert.equal(scopeOf({ phone_number_id: NUMBER, waba_id: '7', business_id: '9' }), 'biz:9');
});

test('migración identity/0002 sobre una base publicada y relleno por trozos, idempotente', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-identidad-mig-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== MIGRATION)) });
  const T0 = Date.UTC(2026, 9, 1);
  const user = (id, n) =>
    db
      .prepare(
        "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,'sin-acceso','customer',?,?,?)",
      )
      .run(id, id, 'Cliente ' + id, n, T0, T0);
  const wa = (waId, userId) =>
    db
      .prepare('INSERT INTO wa_identities(wa_id,user_id,profile_name,created_at,last_seen) VALUES(?,?,?,?,?)')
      .run(waId, userId, '', T0, T0 + 1);
  user('u-a', 900001);
  user('u-b', 900002);
  user('u-c', 900003);
  wa('5215512340001', 'u-a');
  wa('525512340001', 'u-b'); // el mismo teléfono escrito de otra forma, en otro cliente
  wa('14155550100', 'u-c');
  db.prepare(
    "INSERT INTO wa_numbers(phone_number_id,brand_id,course_id,label,created_at,updated_at) VALUES(?,'globalvet','aves','Ventas',?,?)",
  ).run(NUMBER, T0, T0);
  db.prepare(
    "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at,wa_number,wa_peer) VALUES('c-a','u-a','globalvet','aves','whatsapp',?,?,?,?)",
  ).run(T0, T0, NUMBER, '5215512340001');
  db.prepare(
    "INSERT INTO messages(id,conversation_id,sender_id,sender_kind,text,client_ref,created_at) VALUES('m-a','c-a','u-a','customer','Hola','m-a',?)",
  ).run(T0 + 5);
  const before = {
    identities: db.prepare('SELECT * FROM wa_identities ORDER BY wa_id').all(),
    numbers: db.prepare('SELECT * FROM wa_numbers').all(),
  };

  const result = migrate(db, { backup: false });
  assert.deepEqual(result.applied, [MIGRATION]);
  assertSchemaCurrent(db);
  for (const table of ['identity_keys', 'identity_events', 'wa_peer_state'])
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  const columns = db
    .prepare('PRAGMA table_info(wa_numbers)')
    .all()
    .map(c => c.name);
  assert.ok(columns.includes('waba_id') && columns.includes('business_id'));
  assert.deepEqual(db.prepare('SELECT * FROM wa_identities ORDER BY wa_id').all(), before.identities, 'intacto');
  assert.equal(count(db, 'SELECT count(*) n FROM identity_keys'), 0, 'la migración sólo crea; el relleno va aparte');
  assert.deepEqual(migrate(db, { backup: false }).applied, [], 'una sola vez');

  // relleno por trozos de una fila
  const run = () => {
    let cursor = null,
      passes = 0;
    for (;;) {
      const out = backfillStep(db, cursor, 1, T0 + 100);
      cursor = out.cursor;
      passes++;
      if (out.finished) return passes;
      assert.ok(passes < 50, 'el relleno termina');
    }
  };
  assert.ok(run() >= 4, 'por trozos');
  const keys = () => db.prepare('SELECT kind,scope,value,user_id,wa_id,source FROM identity_keys ORDER BY value').all();
  const snapshot = keys();
  assert.deepEqual(
    snapshot.map(k => [k.value, k.user_id, k.wa_id, k.source]),
    [
      ['14155550100', 'u-c', '14155550100', 'backfill'],
      ['525512340001', 'u-a', '5215512340001', 'backfill'],
    ],
    'el teléfono repetido se queda con el más antiguo',
  );
  const plain = rows => rows.map(row => ({ ...row }));
  const conflicts = () =>
    plain(db.prepare("SELECT user_id,other_user_id,hint FROM identity_events WHERE action='conflict'").all());
  assert.deepEqual(conflicts(), [{ user_id: 'u-b', other_user_id: 'u-a', hint: '0001' }]);
  assert.deepEqual(plain(db.prepare('SELECT * FROM wa_peer_state').all()), [
    { phone_number_id: NUMBER, user_id: 'u-a', last_inbound_at: T0 + 5 },
  ]);
  // repetirlo no cambia nada
  run();
  assert.deepEqual(keys(), snapshot);
  assert.equal(conflicts().length, 1);
  assert.equal(count(db, 'SELECT count(*) n FROM wa_peer_state'), 1);
});

test('sin teléfono: nace, conversa y se le responde por su identificador; vuelve sin duplicarse; aparece su teléfono y se fusiona con el contacto importado; permisos y enmascarado', async t => {
  const lab = await whatsappLab(t);
  const { db, meta } = lab;
  const api = (path, { cookie = lab.admin, ...options } = {}) => call(lab.origin(), path, { cookie, ...options });

  // un contacto importado con el teléfono que la persona compartirá después, con una nota y su baja
  const imported = (
    await api('/api/crm/contacts', {
      body: { brandId: 'globalvet', name: 'Ana Importada', phone: '55 1111 0001' },
      expected: 201,
    })
  ).id;
  await api('/api/crm/contacts/' + imported + '/consent', {
    method: 'PUT',
    body: { status: 'opted_out', note: 'pidió la baja antes' },
  });
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  db.prepare('INSERT INTO internal_notes VALUES(?,?,?,?,?,?)').run(
    randomUUID(),
    imported,
    'globalvet',
    adminId,
    'Nota de la importación',
    Date.now(),
  );

  // 1) entrante sólo con identificador: cliente, contacto sin teléfono y conversación real
  const users0 = count(db, 'SELECT count(*) n FROM users');
  const first = await inbound(lab, '', 'wamid.id-1', 'Hola, quiero informes', { bsuid: B1, username: 'ana.prueba' });
  assert.match(resultOf(first), /^recibido: conversación nueva/);
  assert.equal(count(db, 'SELECT count(*) n FROM users'), users0 + 1);
  const key = keyOf(db, 'wa_bsuid', B1);
  assert.deepEqual([key.scope, key.username, key.source], ['waba:' + WABA, 'ana.prueba', 'webhook']);
  const userId = key.user_id;
  const conv = db.prepare('SELECT * FROM conversations WHERE customer_id=?').get(userId);
  assert.deepEqual([conv.wa_number, conv.wa_peer, conv.brand_id], [NUMBER, null, 'globalvet']);
  const contact = db.prepare('SELECT * FROM contacts WHERE source_user_id=?').get(userId);
  assert.deepEqual([contact.phone, contact.phone_key, contact.source], ['', '', 'whatsapp']);
  assert.equal(count(db, 'SELECT count(*) n FROM wa_identities WHERE user_id=?', userId), 0);
  assert.equal(db.prepare('SELECT waba_id FROM wa_numbers WHERE phone_number_id=?').get(NUMBER).waba_id, WABA);
  assert.ok(db.prepare('SELECT 1 FROM wa_peer_state WHERE phone_number_id=? AND user_id=?').get(NUMBER, userId));
  // el asistente responde y sale por el identificador, sin «to»
  const reply = await until(() => meta.sent.find(m => m.recipient === B1), 'la respuesta sale por el identificador');
  assert.equal(reply.to, undefined);
  const out = await until(
    () =>
      db
        .prepare(
          "SELECT * FROM messages WHERE conversation_id=? AND sender_kind!='customer' AND provider_ref LIKE 'wamid.out%'",
        )
        .get(conv.id),
    'el saliente guarda la referencia de Meta',
  );
  // ni la bitácora de conectores ni la de identidad guardan el identificador completo
  assert.equal(
    db.prepare('SELECT payload FROM connector_events WHERE event_id=?').get('wamid.id-1').payload.includes(B1),
    false,
  );
  const events = db.prepare('SELECT * FROM identity_events WHERE user_id=?').all(userId);
  assert.deepEqual(
    events.map(e => [e.kind, e.action, e.hint]),
    [['wa_bsuid', 'added', '0001']],
  );
  assert.equal(JSON.stringify(events).includes(B1), false);

  // 2) el estado se casa por la referencia del mensaje, también sin teléfono
  const status = await metaStatus(lab.origin(), out.provider_ref, 'delivered', { recipient: '', recipientUserId: B1 });
  assert.equal(resultOf(status), 'aplicado: mensaje delivered');
  assert.equal(db.prepare('SELECT delivery_state FROM messages WHERE id=?').get(out.id).delivery_state, 'delivered');
  assert.equal(
    db
      .prepare('SELECT payload FROM connector_events WHERE event_id=?')
      .get(out.provider_ref + ':delivered')
      .payload.includes(B1),
    false,
  );

  // 3) el mismo identificador vuelve: misma persona, misma conversación, nada duplicado
  const totals = () =>
    ['users', 'conversations', 'contacts', 'identity_keys'].map(table => count(db, `SELECT count(*) n FROM ${table}`));
  const before = totals();
  assert.match(
    resultOf(await inbound(lab, '', 'wamid.id-2', '¿Cuánto cuesta?', { bsuid: B1, username: 'ana.prueba' })),
    /^recibido: conversación existente/,
  );
  assert.deepEqual(totals(), before);
  // el mismo webhook otra vez no hace nada
  assert.match(resultOf(await inbound(lab, '', 'wamid.id-2', '¿Cuánto cuesta?', { bsuid: B1 })), /^duplicado/);

  // 4) número visible, conversación real, búsqueda y ventana por persona y número
  const seen = (await api('/api/conversations/' + conv.id)).conversation;
  assert.deepEqual([seen.real, seen.wa_display, seen.window.open], [true, '@ana.prueba', true]);
  const search = async q =>
    (await api('/api/conversations?q=' + encodeURIComponent(q))).conversations.some(c => c.id === conv.id);
  assert.equal(await search('ana.prueba'), true, 'por nombre de usuario');
  assert.equal(await search(B1.slice(-6)), true, 'por los últimos caracteres del identificador');
  db.prepare(
    "UPDATE messages SET created_at=created_at-25*3600000 WHERE conversation_id=? AND sender_kind='customer'",
  ).run(conv.id);
  assert.equal(
    (await api('/api/conversations/' + conv.id)).conversation.window.open,
    true,
    'el último mensaje de la persona a ese número (estado del par) mantiene la ventana',
  );
  db.prepare('UPDATE wa_peer_state SET last_inbound_at=last_inbound_at-25*3600000 WHERE user_id=?').run(userId);
  assert.equal((await api('/api/conversations/' + conv.id)).conversation.window.open, false);

  // 5) aparece su teléfono: el contacto se completa y se fusiona con el importado (nota y baja incluidas)
  assert.match(
    resultOf(await inbound(lab, P1, 'wamid.id-3', 'Les paso mi número', { bsuid: B1 })),
    /^recibido: conversación existente/,
  );
  assert.equal(keyOf(db, 'wa_phone', '525511110001').user_id, userId);
  const full = db.prepare('SELECT * FROM contacts WHERE source_user_id=?').get(userId);
  assert.deepEqual([full.id, full.phone, full.phone_key], [contact.id, '+525511110001', '525511110001']);
  assert.equal(db.prepare('SELECT 1 FROM contacts WHERE id=?').get(imported), undefined, 'el importado se fusionó');
  assert.ok(
    db.prepare('SELECT 1 FROM internal_notes WHERE contact_id=? AND text=?').get(contact.id, 'Nota de la importación'),
  );
  assert.equal(db.prepare('SELECT status FROM contact_consent WHERE contact_id=?').get(contact.id).status, 'opted_out');
  assert.equal(
    JSON.parse(
      db.prepare('SELECT moved FROM contact_merges WHERE kept_id=? AND merged_id=?').get(contact.id, imported).moved,
    ).reason,
    'identity',
  );
  assert.equal(db.prepare('SELECT wa_peer FROM conversations WHERE id=?').get(conv.id).wa_peer, P1);
  assert.deepEqual(
    db
      .prepare('SELECT action FROM identity_events WHERE user_id=? ORDER BY seq')
      .all(userId)
      .map(e => e.action),
    ['added', 'linked', 'merged'],
  );
  // desde ahora se le escribe por teléfono
  const replies = meta.sent.length;
  await until(() => meta.sent.slice(replies).some(m => m.to === P1 && !m.recipient), 'la respuesta sale con «to»');
  assert.equal((await api('/api/conversations/' + conv.id)).conversation.wa_display, '+' + P1);

  // 6) el teléfono pasa a otra cuenta de WhatsApp (otro identificador): cliente nuevo, el anterior conserva lo suyo
  const B2 = 'MX.1001000000000002',
    B3 = 'MX.1001000000000003',
    P2 = '5215522220002';
  await inbound(lab, P2, 'wamid.id-4', 'Hola', { bsuid: B2 });
  const old = userOf(db, B2);
  await inbound(lab, P2, 'wamid.id-5', 'Hola otra vez', { bsuid: B3 });
  const fresh = userOf(db, B3);
  assert.notEqual(fresh, old);
  assert.equal(keyOf(db, 'wa_phone', '525522220002').user_id, fresh, 'el teléfono es de quien lo usa ahora');
  assert.equal(
    db.prepare("SELECT other_user_id FROM identity_events WHERE user_id=? AND action='moved'").get(fresh).other_user_id,
    old,
  );
  assert.equal(
    db.prepare("SELECT wa_peer FROM conversations WHERE customer_id=? AND status!='resolved'").get(old).wa_peer,
    null,
    'al anterior ya no se le escribe a ese teléfono',
  );
  assert.equal(count(db, "SELECT count(*) n FROM messages WHERE sender_id=? AND sender_kind='customer'", old), 1);

  // 7) permisos y enmascarado: el bloque «WhatsApp» del contacto
  const register = async username =>
    (
      await call(lab.origin(), '/api/auth/register', {
        body: { username, name: 'Prueba ' + username, password: PASSWORD },
      })
    ).cookie;
  const agentOf = async (username, brandId) => {
    const cookie = await register(username);
    const id = db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
    db.prepare("UPDATE users SET role='agent' WHERE id=?").run(id);
    db.prepare('INSERT INTO brand_members VALUES(?,?)').run(id, brandId);
    return cookie;
  };
  const own = await agentOf('asesor-gv', 'globalvet');
  const other = await agentOf('asesor-od', 'odonteck');
  const customer = await register('cliente-x');
  const block = (await api('/api/identity/contacts/' + contact.id)).whatsapp;
  assert.deepEqual(
    [block.username, block.bsuidHint, block.bsuid, block.phone, block.real],
    ['ana.prueba', '0001', B1, '+525511110001', true],
    'administración ve el identificador completo',
  );
  const forAgent = (await api('/api/identity/contacts/' + contact.id, { cookie: own })).whatsapp;
  assert.equal('bsuid' in forAgent, false, 'el asesor sólo ve los últimos cuatro');
  assert.equal(forAgent.bsuidHint, '0001');
  await api('/api/identity/contacts/' + contact.id, { cookie: other, expected: 404 });
  await api('/api/identity/contacts/' + contact.id, { cookie: customer, expected: 403 });
  await api('/api/identity', { cookie: own, expected: 403 });
  const stats = (await api('/api/identity')).identity;
  assert.ok(stats.withPhone >= 2 && stats.linkedThisWeek >= 2);
  assert.equal(JSON.stringify(stats).includes(B1), false);
  // la búsqueda de un cliente no revela identificadores
  assert.equal(
    (await call(lab.origin(), '/api/conversations?q=' + B1.slice(-6), { cookie: customer })).conversations.length,
    0,
  );
});

test('identificador y teléfono de dos clientes: fusión segura o revisión; dos marcas no se mezclan', async t => {
  const lab = await whatsappLab(t);
  const { db } = lab;
  const api = (path, options = {}) => call(lab.origin(), path, { cookie: lab.admin, ...options });
  const phoneUser = waId => db.prepare('SELECT user_id FROM wa_identities WHERE wa_id=?').get(waId)?.user_id;

  // 0) el cliente de antes (sólo teléfono) recibe su identificador y sigue siendo uno; México: «52…» y «521…» son el
  // mismo teléfono y caen en la misma conversación
  const P10 = '5215510100010',
    B10 = 'MX.1001000000000011';
  await inbound(lab, P10, 'wamid.p-1', 'Hola', { name: 'Pablo Antes' });
  const u10 = phoneUser(P10);
  const c10 = db.prepare('SELECT id FROM conversations WHERE customer_id=?').get(u10).id;
  assert.match(resultOf(await inbound(lab, P10, 'wamid.p-2', 'Sigo aquí', { bsuid: B10 })), /conversación existente/);
  assert.equal(userOf(db, B10), u10);
  assert.equal(
    db.prepare("SELECT action FROM identity_events WHERE user_id=? AND kind='wa_bsuid'").get(u10).action,
    'linked',
  );
  assert.match(resultOf(await inbound(lab, '525510100010', 'wamid.p-3', 'Sin el uno')), /conversación existente/);
  assert.equal(
    db.prepare("SELECT conversation_id FROM messages WHERE client_ref='meta:wamid.p-3'").get().conversation_id,
    c10,
  );

  // a) no es seguro (los dos tienen abierta una conversación del mismo curso): entra con el identificador, el teléfono
  // se queda con quien lo tenía y queda una candidatura para revisión
  const P3 = '5215533330003',
    B4 = 'MX.1001000000000004';
  await inbound(lab, P3, 'wamid.c-1', 'Hola, soy cliente de antes', { name: 'Carla Antes' });
  const u3 = phoneUser(P3);
  await inbound(lab, '', 'wamid.c-2', 'Hola sin número', { bsuid: B4, name: 'Carla Usuario' });
  const w4 = userOf(db, B4);
  const candidates = count(db, 'SELECT count(*) n FROM person_candidates');
  assert.match(
    resultOf(await inbound(lab, P3, 'wamid.c-3', 'Ahora con número', { bsuid: B4 })),
    /^recibido: conversación existente/,
  );
  assert.equal(
    db
      .prepare(
        "SELECT customer_id FROM conversations c JOIN messages m ON m.conversation_id=c.id WHERE m.client_ref='meta:wamid.c-3'",
      )
      .get().customer_id,
    w4,
    'el identificador decide quién es',
  );
  assert.equal(keyOf(db, 'wa_phone', '525533330003').user_id, u3);
  assert.equal(db.prepare('SELECT phone FROM contacts WHERE source_user_id=?').get(w4).phone, '');
  const conflict = db.prepare("SELECT * FROM identity_events WHERE action='conflict' AND user_id=?").get(w4);
  assert.equal(conflict.other_user_id, u3);
  assert.equal(count(db, 'SELECT count(*) n FROM person_candidates'), candidates + 1);
  const personas = [u3, w4]
    .map(id => db.prepare('SELECT persona_id FROM contacts WHERE source_user_id=?').get(id).persona_id)
    .sort();
  assert.equal(
    db.prepare('SELECT reason FROM person_candidates WHERE person_a=? AND person_b=?').get(...personas).reason,
    'identity_conflict',
  );
  assert.equal(db.prepare('SELECT disabled FROM users WHERE id=?').get(w4).disabled, 0);

  // b) seguro (el de antes ya cerró su conversación y su interés): un solo cliente, el más antiguo
  const P5 = '5215555550005',
    B6 = 'MX.1001000000000006';
  await inbound(lab, P5, 'wamid.s-1', 'Hola');
  const u5 = phoneUser(P5);
  db.prepare("UPDATE conversations SET status='resolved' WHERE customer_id=?").run(u5);
  db.prepare(
    "UPDATE opportunities SET stage='perdida' WHERE contact_id IN (SELECT id FROM contacts WHERE source_user_id=?)",
  ).run(u5);
  await inbound(lab, '', 'wamid.s-2', 'Hola sin número', { bsuid: B6 });
  const w6 = userOf(db, B6);
  const w6conv = db.prepare('SELECT id FROM conversations WHERE customer_id=?').get(w6).id;
  assert.match(
    resultOf(await inbound(lab, P5, 'wamid.s-3', 'Ya con número', { bsuid: B6 })),
    /^recibido: conversación existente/,
  );
  assert.equal(userOf(db, B6), u5, 'el identificador pasa al cliente más antiguo');
  assert.equal(db.prepare('SELECT customer_id FROM conversations WHERE id=?').get(w6conv).customer_id, u5);
  assert.equal(db.prepare('SELECT disabled FROM users WHERE id=?').get(w6).disabled, 1);
  assert.equal(count(db, "SELECT count(*) n FROM contacts WHERE source_user_id=? AND brand_id='globalvet'", u5), 1);
  assert.equal(count(db, 'SELECT count(*) n FROM contacts WHERE source_user_id=?', w6), 0);
  assert.equal(count(db, "SELECT count(*) n FROM messages WHERE sender_id=? AND sender_kind='customer'", w6), 0);
  assert.ok(
    db.prepare("SELECT 1 FROM identity_events WHERE action='merged' AND user_id=? AND other_user_id=?").get(u5, w6),
  );

  // c) dos marcas: un número de odonteck en otra cuenta de Meta
  await api('/api/whatsapp/numbers/' + NUMBER2, {
    method: 'PUT',
    body: { brandId: 'odonteck', label: 'Odonteck', expectedRevision: 0 },
  });
  const odo = (
    await api('/api/crm/contacts', {
      body: { brandId: 'odonteck', name: 'Importada Odonteck', phone: '55 7777 0007' },
      expected: 201,
    })
  ).id;
  const B7 = 'MX.1001000000000007',
    P7 = '5215577770007';
  await inbound(lab, '', 'wamid.m-1', 'Hola', { bsuid: B7 });
  await inbound(lab, P7, 'wamid.m-2', 'Mi número', { bsuid: B7 });
  const g7 = userOf(db, B7);
  assert.equal(
    db.prepare("SELECT phone_key FROM contacts WHERE source_user_id=? AND brand_id='globalvet'").get(g7).phone_key,
    '525577770007',
  );
  const odoRow = db.prepare('SELECT source_user_id,phone_key FROM contacts WHERE id=?').get(odo);
  assert.deepEqual(
    { ...odoRow },
    { source_user_id: null, phone_key: '525577770007' },
    'el de la otra marca no se toca',
  );
  // el mismo texto de identificador en otra cuenta de Meta es otra persona (el identificador es por portafolio)
  assert.match(
    resultOf(await inbound(lab, '', 'wamid.m-3', 'Hola Odonteck', { bsuid: B7, entryId: WABA2, to: NUMBER2 })),
    /^recibido: conversación nueva/,
  );
  const scoped = db
    .prepare("SELECT user_id FROM identity_keys WHERE kind='wa_bsuid' AND value=? AND scope=?")
    .get(B7, 'waba:' + WABA2);
  assert.notEqual(scoped.user_id, g7);
  assert.equal(
    db.prepare('SELECT brand_id FROM conversations WHERE customer_id=?').get(scoped.user_id).brand_id,
    'odonteck',
  );
  assert.deepEqual(
    db
      .prepare('SELECT DISTINCT brand_id FROM conversations WHERE customer_id=?')
      .all(g7)
      .map(r => r.brand_id),
    ['globalvet'],
  );
});

test('cuarentena «no_phone» de la versión anterior: se reprocesa con el botón y al arrancar, y entra', async t => {
  const lab = await whatsappLab(t);
  const { db } = lab;
  const parse = metaChannel({ env: {} }).parseWebhook;
  // lo que la versión anterior dejó en la bandeja: fila fallida con su carga 1.1 completa
  const park = (id, value, error = 'no_phone') => {
    const [event] = parse(metaBody(value, { entryId: WABA }));
    const t0 = Date.now();
    db.prepare(
      "INSERT INTO webhook_inbox(kind,provider,event_id,type,lane,payload,state,attempts,next_attempt_at,error,received_at,updated_at) VALUES('channel','meta',?,?,?,?,'failed',1,?,?,?,?)",
    ).run(id, event.type, 'ev:meta:' + id, JSON.stringify({ v: '1.1', event }), t0, error, t0, t0);
  };
  const text = (from, id, body, options) => metaInboundValue(from, id, { type: 'text', text: { body } }, options);
  const entered = id => db.prepare('SELECT * FROM messages WHERE client_ref=?').get('meta:' + id);

  park('wamid.q-1', text('', 'wamid.q-1', 'Escribí sin número', { bsuid: 'MX.1001000000000008' }));
  park('wamid.q-2', text('', 'wamid.q-2', 'Sin nadie'), 'no_identifier');
  const api = (path, options = {}) => call(lab.origin(), path, { cookie: lab.admin, ...options });
  assert.equal((await api('/api/identity')).identity.quarantine.held, 2);
  const retried = await api('/api/identity/quarantine/retry', { body: {} });
  assert.equal(retried.retried, 2);
  await until(() => entered('wamid.q-1'), 'el entrante en cuarentena entra');
  await until(() => lab.inboxRow('wamid.q-2').state === 'failed', 'sin identificador vuelve a la cuarentena');
  await until(() => lab.inboxRow('wamid.q-1').state === 'done', 'y queda procesado');
  assert.equal(lab.inboxRow('wamid.q-2').error, 'no_identifier');
  assert.equal(entered('wamid.q-1').text, 'Escribí sin número');

  // al arrancar con WhatsApp real activo, lo que quedó «no_phone» se reprocesa solo
  await lab.state.server.stop();
  park('wamid.q-3', text('', 'wamid.q-3', 'Otra vez sin número', { bsuid: 'MX.1001000000000009' }));
  await lab.start();
  await until(() => entered('wamid.q-3'), 'se reprocesa al arrancar');
  assert.equal(userOf(db, 'MX.1001000000000009'), entered('wamid.q-3').sender_id);
});

// ---- difusión a quien sólo tiene identificador (conciliación, fila 37: wa_recipient; sin nada, «no_address»)
const FAST = {
  WA_BROADCAST_RATE_SCALE: '50',
  WA_BROADCAST_MAX_PER_SECOND: '1000',
  WA_BROADCAST_LEASE_MS: '4000',
  WA_BROADCAST_RECONCILE_MS: '5000',
};
test('difusión con plantilla: sale por el identificador de quien no tiene teléfono y su respuesta se atribuye', async t => {
  const lab = await whatsappLab(t, FAST);
  const { db, meta } = lab;
  const api = (path, { body, method, expected = 200 } = {}) =>
    call(lab.origin(), path, { cookie: lab.admin, body, method, expected });
  // la marca con difusiones y automatización encendidas, sin horario de silencio y con el nivel de Meta conocido
  const brand = await api('/api/campaigns/settings');
  const rev = (brand.settings || []).find?.(s => s.brand_id === 'globalvet')?.revision ?? 0;
  await api('/api/campaigns/settings/globalvet', {
    method: 'PATCH',
    body: { enabled: true, minGapHours: 0, expectedRevision: rev },
  });
  const auto = await api('/api/automation');
  const autoRev = auto.brands?.find?.(b => b.brandId === 'globalvet' || b.id === 'globalvet')?.revision ?? 0;
  await api('/api/automation/brands/globalvet', {
    method: 'PATCH',
    body: { enabled: true, expectedRevision: autoRev },
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
  const tpl = randomUUID();
  db.prepare(
    "INSERT INTO wa_templates(id,brand_id,waba_id,name,language,category,body,variables,components,status,revision,created_at,updated_at) VALUES(?,'globalvet','','difusion_identidad','es_MX','marketing',?,?,?,'approved',1,1,1)",
  ).run(
    tpl,
    'Hola {{1}}, abrimos inscripciones.',
    JSON.stringify(['nombre']),
    JSON.stringify({
      type: 'standard',
      header: { type: 'none' },
      body: { text: 'Hola {{1}}, abrimos inscripciones.', vars: [{ key: 'nombre', sample: 'Ana', fallback: null }] },
      footer: { text: 'Responde BAJA para no recibir más.' },
      buttons: [{ type: 'quick_reply', text: 'Me interesa' }],
    }),
  );

  // quien escribió sin teléfono (su contacto) y alguien sin teléfono ni identificador
  const B9 = 'MX.1001000000000010';
  await inbound(lab, '', 'wamid.d-1', 'Hola', { bsuid: B9 });
  const person = db.prepare('SELECT id FROM contacts WHERE source_user_id=?').get(userOf(db, B9)).id;
  db.prepare(
    "INSERT INTO contacts(id,brand_id,name,phone,phone_key,source,created_at,updated_at) VALUES('sin-nada','globalvet','Sin Nada','','','import',?,?)",
  ).run(t0, t0);
  for (const id of [person, 'sin-nada'])
    db.prepare(
      "INSERT INTO contact_consent(contact_id,brand_id,status,source,updated_at) VALUES(?,'globalvet','opted_in','prueba',?) ON CONFLICT(contact_id) DO UPDATE SET status='opted_in'",
    ).run(id, t0);
  const list = randomUUID();
  db.prepare(
    "INSERT INTO audiences(id,brand_id,kind,role,name,name_key,definition,member_count,created_at,updated_at) VALUES(?,'globalvet','list','audience','Sin número','sin número','{}',2,?,?)",
  ).run(list, t0, t0);
  for (const id of [person, 'sin-nada'])
    db.prepare("INSERT INTO audience_members(audience_id,contact_id,source,added_at) VALUES(?,?,'manual',?)").run(
      list,
      id,
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
        content: { context: { courseId: 'nutricion', editionId: 'edition-nutricion' } },
        clientRef: 'dif-' + randomUUID(),
      },
    })
  ).campaign;
  const { preview } = await api(`/api/broadcasts/${draft.id}/preview`, { body: {} });
  assert.deepEqual(
    [preview.eligible, Object.fromEntries(preview.excluded.map(e => [e.reason, e.count]))],
    [1, { no_address: 1 }],
  );
  await api(`/api/broadcasts/${draft.id}/schedule`, {
    body: { expectedRevision: draft.revision, confirmAudience: preview.willSend, acceptCost: true },
  });
  const sent = await until(
    () => meta.sent.find(m => m.type === 'template' && m.recipient === B9),
    'la plantilla sale por el identificador',
    { ms: 15000 },
  );
  assert.equal(sent.to, undefined);
  const row = db
    .prepare('SELECT * FROM campaign_recipients WHERE campaign_id=? AND contact_id=?')
    .get(draft.id, person);
  assert.deepEqual([row.wa_to, row.wa_recipient], [null, B9]);
  await until(
    () => db.prepare('SELECT state FROM campaign_recipients WHERE id=?').get(row.id).state === 'sent',
    'queda enviada',
  );
  assert.equal(
    db
      .prepare("SELECT skip_reason FROM campaign_recipients WHERE campaign_id=? AND contact_id='sin-nada'")
      .get(draft.id).skip_reason,
    'no_address',
  );
  // la lista de destinatarios no enseña el identificador
  const { recipients } = await api(`/api/broadcasts/${draft.id}/recipients`);
  assert.equal(JSON.stringify(recipients).includes(B9), false);
  // su respuesta se atribuye a la difusión por su identificador
  await inbound(lab, '', 'wamid.d-2', 'Me interesa', { bsuid: B9 });
  await until(
    () => db.prepare('SELECT replied_at FROM campaign_recipients WHERE id=?').get(row.id).replied_at,
    'la respuesta queda atribuida',
  );
});
