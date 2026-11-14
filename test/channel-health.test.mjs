// Salud del canal (X3, docs/PLAN_SALUD_NUMERO.md): estado, calidad y límite diario de cada número y de la cuenta de
// WhatsApp Business, los avisos de Meta, limitsOf y canSend para el motor de difusiones, el reloj de consultas,
// permisos y alcance por marca, y el apagado sin WhatsApp real. Todo contra el Meta de mentira
// (test/helpers/fake-meta.mjs): nada sale a internet y los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../server/database.mjs';
import { migrate, NAMED } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { fail } from '../server/app/http.mjs';
import healthModule, { qualityOf, statusOf, tierOf } from '../server/modules/channel-health/module.mjs';
import { PASSWORD, call, sleep, until, whatsappLab } from './helpers/crm.mjs';
import { NUMBER, WABA_ID, metaNotice, numberHealth } from './helpers/fake-meta.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';

const NUMBER_2 = '109000000000002';
const DISPLAY = '15550100000';
const DISPLAY_2 = '15550100002';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-health-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return db;
}

// ---------------------------------------------------------------------------------------------------------------
// Migración
// ---------------------------------------------------------------------------------------------------------------

test('migración channel-health/0001: una base que ya existía queda igual que una nueva y conserva su cuenta', async t => {
  const old = await workspace(t);
  migrate(old, { backup: false, registry: defineRegistry(NAMED.filter(m => !m.name.startsWith('channel-health/'))) });
  old
    .prepare(
      "INSERT INTO wa_account(waba_id,messaging_limit,limit_value,limit_source,created_at,updated_at) VALUES('local','TIER_2K',2000,'manual',1,1)",
    )
    .run();
  assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name='channel_health'").get(), undefined);
  migrate(old, { backup: false });
  assertSchemaCurrent(old);
  migrate(old, { backup: false });
  assertSchemaCurrent(old);
  const fresh = await workspace(t);
  migrate(fresh, { backup: false });
  assert.deepEqual(schemaShape(old), schemaShape(fresh));
  const acc = old.prepare("SELECT * FROM wa_account WHERE waba_id='local'").get();
  assert.equal(acc.messaging_limit, 'TIER_2K');
  assert.equal(acc.limit_source, 'manual');
  assert.equal(acc.health_error, '');
  assert.equal(acc.business_verification, null);
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Lógica del módulo (base temporal, adaptador de Meta simulado en memoria)
// ---------------------------------------------------------------------------------------------------------------

async function moduleWorld(t, { live = true } = {}) {
  const db = await workspace(t);
  migrate(db, { backup: false });
  const state = { live, calls: [], info: {}, account: null, delay: 0 };
  const listeners = {};
  const meta = {
    async numberInfo(id) {
      state.calls.push(id);
      if (state.delay) await sleep(state.delay);
      return {
        displayPhone: '+52 55 0000 ' + id.slice(-4),
        verifiedName: 'Prueba',
        quality: 'GREEN',
        status: 'CONNECTED',
        nameStatus: 'APPROVED',
        official: false,
        limitTier: '',
        ...state.info[id],
      };
    },
    async accountInfo() {
      state.calls.push('account');
      return state.account;
    },
  };
  const host = {
    db,
    transaction,
    fail,
    json: (res, status, data) => Object.assign(res, { status, data }),
    body: async req => req.body,
    rate() {},
    requireStaff() {},
    access: { can: () => true, require() {}, brandIds: () => ['globalvet', 'odonteck'] },
    realtime: { emit() {} },
    services: {
      events: { registerTypes() {}, publish() {} },
      connectors: {
        metaLive: () => state.live,
        adapters: { channel: { meta } },
        on(type, fn) {
          listeners[type] = fn;
        },
      },
    },
  };
  const api = healthModule.create(host);
  const number = (id, brand) =>
    db
      .prepare(
        'INSERT INTO wa_numbers(phone_number_id,brand_id,course_id,label,enabled,revision,created_at,updated_at) VALUES(?,?,NULL,?,1,1,1,1)',
      )
      .run(id, brand, 'Línea ' + brand);
  number('300000000201', 'globalvet');
  number('300000000202', 'odonteck');
  return { db, api, state, listeners };
}

test('lectura de los valores de Meta: calidad, estado y nivel de mensajes', () => {
  assert.deepEqual(['GREEN', 'yellow', 'Red', 'HIGH', 'x', ''].map(qualityOf), [
    'green',
    'yellow',
    'red',
    'green',
    'unknown',
    'unknown',
  ]);
  assert.deepEqual(
    ['CONNECTED', 'FLAGGED', 'RESTRICTED', 'BANNED', 'PENDING', 'DISCONNECTED', 'raro', ''].map(statusOf),
    ['connected', 'flagged', 'restricted', 'banned', 'pending', 'offline', 'unknown', 'unknown'],
  );
  assert.deepEqual(tierOf('TIER_250'), { tier: 'TIER_250', value: 250, unlimited: false });
  assert.deepEqual(tierOf('tier_10k'), { tier: 'TIER_10K', value: 10000, unlimited: false });
  assert.deepEqual(tierOf('TIER_100K').value, 100000);
  assert.deepEqual(tierOf('TIER_UNLIMITED'), { tier: 'TIER_UNLIMITED', value: null, unlimited: true });
  assert.equal(tierOf(''), null);
  assert.equal(tierOf('sin nivel'), null);
});

test('sin datos todavía: deja enviar con el tope más bajo (250) y lo dice; nada se consulta dentro de una transacción', async t => {
  const { db, api, state } = await moduleWorld(t);
  assert.deepEqual(api.limitsOf('wa:300000000201'), {
    limit: 250,
    used: 0,
    remaining: 250,
    tier: '',
    unlimited: false,
    estimated: true,
    source: 'default',
  });
  assert.deepEqual(api.canSend('wa:300000000201', 'marketing'), { ok: true, warning: 'no_data' });
  assert.deepEqual(api.canSend('300000000201', 'service'), { ok: true, warning: 'no_data' });
  assert.equal(api.canSend('wa:999999', 'utility').reason, 'unknown_number');
  assert.equal(api.canSend('wa:300000000201', 'promo').reason, 'invalid_category');
  assert.equal(api.limitsOf('wa:999999').remaining, 0);

  // dentro de una transacción no hay consulta a Meta: falla antes de llamar al adaptador
  db.exec('BEGIN');
  await assert.rejects(api.refresh('wa:300000000201'), /dentro de una transacción/);
  db.exec('ROLLBACK');
  assert.deepEqual(state.calls, []);
  await api.tick(); // el reloj tampoco corre si la conexión está en medio de una transacción
  assert.deepEqual(state.calls.sort(), ['300000000201', '300000000202', 'account']);

  // lo usado: personas distintas que recibieron una plantilla en 24 h, por chat o por difusión, sin repetir
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u-c','cliente','Cliente','x','customer',990009,1,1)",
  ).run();
  const conv = (id, peer, brand, course) =>
    db
      .prepare(
        "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at,wa_number,wa_peer) VALUES(?,'u-c',?,?,'whatsapp',1,1,?,?)",
      )
      .run(id, brand, course, brand === 'globalvet' ? '300000000201' : '300000000202', peer);
  const course = brand => db.prepare('SELECT id FROM courses WHERE brand_id=? LIMIT 1').get(brand).id;
  conv('c1', '5215500000001', 'globalvet', course('globalvet'));
  conv('c2', '5215500000002', 'odonteck', course('odonteck'));
  const msg = (id, c, at, template = '{"name":"aviso"}') =>
    db
      .prepare(
        "INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at,wa_template) VALUES(?,?,'agent','hola',?,?,?)",
      )
      .run(id, c, 'ref-' + id, at, template);
  const t0 = Date.now();
  msg('m1', 'c1', t0 - 1000);
  msg('m2', 'c1', t0 - 2000); // la misma persona: cuenta una vez
  msg('m3', 'c2', t0 - 3000); // otra marca, la misma cuenta: el límite es de la cuenta
  msg('m4', 'c2', t0 - 25 * 3_600_000); // fuera de las 24 h
  msg('m5', 'c2', t0, null); // no es plantilla
  await sleep(5100); // lo usado se guarda 5 s
  assert.equal(api.limitsOf('wa:300000000201').used, 2);
  assert.equal(api.limitsOf('wa:300000000202').remaining, 248);

  // con nivel de Meta: el tope sale de la cuenta; agotado, se frena todo menos el servicio
  db.prepare("UPDATE wa_account SET messaging_limit='TIER_2K',limit_value=2,limit_source='meta'").run();
  assert.deepEqual(api.limitsOf('wa:300000000201'), {
    limit: 2,
    used: 2,
    remaining: 0,
    tier: 'TIER_2K',
    unlimited: false,
    estimated: true,
    source: 'meta',
  });
  assert.equal(api.canSend('wa:300000000201', 'utility').reason, 'limit_reached');
  assert.deepEqual(api.canSend('wa:300000000201', 'service'), { ok: true });
  db.prepare("UPDATE wa_account SET messaging_limit='TIER_UNLIMITED',limit_value=NULL").run();
  assert.equal(api.limitsOf('wa:300000000201').unlimited, true);
  assert.equal(api.limitsOf('wa:300000000201').remaining, null);
  assert.deepEqual(api.canSend('wa:300000000201', 'marketing'), { ok: true });
});

test('reloj: no se pisa a sí mismo, respeta el mínimo entre consultas y relee antes los números con difusión en curso', async t => {
  const { db, api, state, listeners } = await moduleWorld(t);
  state.delay = 150;
  await Promise.all([api.tick(), api.tick(), api.tick()]);
  assert.equal(state.calls.filter(c => c === '300000000201').length, 1, 'tres pasadas a la vez consultan una sola vez');
  await api.tick();
  assert.equal(state.calls.length, 3, 'recién consultado: nada que releer');

  // un aviso pide releer, pero no antes del mínimo entre consultas (un minuto)
  state.delay = 0;
  db.prepare("UPDATE channel_health SET display='+52 55 0000 0201' WHERE account_ref='wa:300000000201'").run();
  listeners['account.update']({ field: 'name', value: 'approved', details: { displayPhone: '525500000201' } });
  assert.ok(db.prepare("SELECT refresh_due FROM channel_health WHERE account_ref='wa:300000000201'").get().refresh_due);
  await api.tick();
  assert.equal(state.calls.length, 3);
  db.prepare("UPDATE channel_health SET checked_at=checked_at-61000 WHERE account_ref='wa:300000000201'").run();
  await api.tick();
  assert.equal(state.calls.filter(c => c === '300000000201').length, 2, 'pasado el mínimo, se relee');
  assert.equal(
    db.prepare("SELECT refresh_due FROM channel_health WHERE account_ref='wa:300000000201'").get().refresh_due,
    null,
  );

  // 16 minutos sin consultar: sólo se relee el número con una difusión en curso (cada 15 min); el otro, cada 6 h
  db.prepare('UPDATE channel_health SET checked_at=? ').run(Date.now() - 16 * 60_000);
  db.prepare(
    "INSERT INTO campaigns(id,brand_id,kind,title,status,wa_number,created_at,updated_at) VALUES('camp-1','odonteck','template','Prueba','sending','300000000202',1,1)",
  ).run();
  const before = state.calls.length;
  await api.tick();
  assert.deepEqual(state.calls.slice(before), ['300000000202']);

  // apagado: el reloj no consulta y canSend no frena al laboratorio
  state.live = false;
  db.prepare('UPDATE channel_health SET checked_at=1').run();
  await api.tick();
  assert.deepEqual(state.calls.slice(before), ['300000000202']);
  assert.deepEqual(api.canSend('wa:300000000201', 'marketing'), { ok: true, warning: 'simulated' });
  assert.equal(api.limitsOf('wa:300000000201').source, 'simulated');
  assert.equal(listeners['account.update']({ field: 'quality', value: 'flagged' }), null);
});

// ---------------------------------------------------------------------------------------------------------------
// De punta a punta: servidor real contra el Meta de mentira
// ---------------------------------------------------------------------------------------------------------------

test('salud de punta a punta: consulta inicial, calidad, nivel, número restringido y recuperado, cuenta en revisión, dos marcas y permisos', async t => {
  const lab = await whatsappLab(t, { META_WABA_ID: WABA_ID, CHANNEL_HEALTH_MIN_GAP_MS: '700' });
  const { meta, db } = lab;
  const origin = () => lab.origin();
  const admin = lab.admin;
  const api = (path, options = {}) => call(origin(), path, { cookie: admin, ...options });
  const health = () => api('/api/whatsapp/health');
  const one = async (ref = 'wa:' + NUMBER) => (await health()).numbers.find(n => n.accountRef === ref);
  const callsTo = id => meta.health.calls.filter(c => c.id === id).length;
  assertSchemaCurrent(db);

  // 1) consulta inicial: el reloj lee el número y la cuenta sin que nadie lo pida
  const first = await until(async () => {
    const n = await one();
    return n?.checkedAt && n.status === 'connected' && (await health()).account?.checkedAt ? n : null;
  }, 'la primera consulta a Meta');
  assert.equal(first.quality, 'green');
  assert.equal(first.qualityLabel, 'Alta');
  assert.equal(first.display, '+1 555 010 0000');
  assert.equal(first.verifiedName, 'Test Number');
  assert.equal(first.nameStatus, 'approved');
  assert.equal(first.official, false);
  assert.equal(first.error, '');
  assert.deepEqual(first.limit, {
    limit: 1000,
    used: 0,
    remaining: 1000,
    tier: 'TIER_1K',
    unlimited: false,
    estimated: true,
    source: 'meta',
  });
  assert.deepEqual(first.sending.marketing, { ok: true });
  const snapshot = await health();
  assert.equal(snapshot.live, true);
  assert.equal(snapshot.account.reviewStatus, 'approved');
  assert.equal(snapshot.account.businessVerification, 'verified');
  assert.equal(snapshot.account.limit.limit, 1000);
  const text = JSON.stringify(snapshot);
  assert.doesNotMatch(text, new RegExp(WABA_ID), 'sin el identificador de la cuenta');
  assert.doesNotMatch(text, /EAAprueba/, 'sin el token');

  // el reloj no vuelve a preguntar mientras no toque (6 h sin difusiones)
  const counted = callsTo(NUMBER);
  await sleep(1200);
  assert.equal(callsTo(NUMBER), counted, 'sin consultas de más');

  // 2) dos marcas: un segundo número de OdonTeck con su propia salud
  meta.health.numbers.set(
    NUMBER_2,
    numberHealth({ display_phone_number: '+1 555 010 0002', verified_name: 'Línea OdonTeck', quality_rating: 'GREEN' }),
  );
  await api('/api/whatsapp/numbers/' + NUMBER_2, {
    method: 'PUT',
    body: { brandId: 'odonteck', label: 'Línea OdonTeck', expectedRevision: 0 },
  });
  await until(async () => (await one('wa:' + NUMBER_2))?.checkedAt, 'la consulta del segundo número');

  // 3) aviso de bajada de calidad: Meta marca el número; se aplica, se avisa y se relee (después del mínimo)
  Object.assign(meta.health.numbers.get(NUMBER), { quality_rating: 'RED', status: 'FLAGGED' });
  const before = callsTo(NUMBER);
  const flagged = await metaNotice(origin(), 'phone_number_quality_update', {
    display_phone_number: DISPLAY,
    event: 'FLAGGED',
    current_limit: 'TIER_1K',
  });
  assert.equal(flagged.status, 200);
  const red = await until(async () => {
    const n = await one();
    return n.quality === 'red' ? n : null;
  }, 'la calidad baja');
  assert.equal(red.status, 'flagged');
  assert.equal(red.sending.marketing.reason, 'quality_low');
  assert.deepEqual(red.sending.utility, { ok: true });
  await until(async () => callsTo(NUMBER) > before, 'la relectura que pidió el aviso');
  const other = await one('wa:' + NUMBER_2);
  assert.equal(other.quality, 'green', 'el número de la otra marca no cambia');
  assert.equal(other.status, 'connected');
  const notes = () =>
    db
      .prepare("SELECT title,brand_id FROM notifications WHERE kind='channel_health' ORDER BY created_at")
      .all()
      .map(n => n.title);
  assert.ok(
    notes().some(n => /Bajó la calidad de Número de prueba: Alta → Baja/.test(n)),
    notes().join(' | '),
  );
  const history = (await health()).history;
  assert.ok(history.some(h => h.text === 'Calidad: Alta → Baja' && h.source === 'webhook'));
  assert.equal(
    db.prepare("SELECT count(*) n FROM domain_events WHERE type='canal.calidad'").get().n >= 1,
    true,
    'evento de dominio',
  );

  // 4) cambio de nivel: el límite diario sube a 10,000 y se avisa
  // el límite es de la cuenta: Meta lo informa igual en todos sus números
  for (const id of [NUMBER, NUMBER_2])
    meta.health.numbers.get(id).whatsapp_business_manager_messaging_limit = 'TIER_10K';
  await metaNotice(origin(), 'phone_number_quality_update', {
    display_phone_number: DISPLAY,
    event: 'UPGRADE',
    current_limit: 'TIER_10K',
    old_limit: 'TIER_1K',
  });
  await until(async () => (await one()).limit.limit === 10000, 'el nuevo límite');
  assert.equal((await health()).account.limit.tier, 'TIER_10K');
  assert.ok(
    notes().some(n => /Cambió el límite diario de WhatsApp: 1,000 → 10,000/.test(n)),
    notes().join(' | '),
  );

  // 5) número restringido (consulta a mano) y recuperado (aviso y relectura)
  Object.assign(meta.health.numbers.get(NUMBER), { status: 'RESTRICTED' });
  await sleep(800); // «Consultar ahora» dentro del mínimo devuelve lo recién leído
  const refreshed = await api('/api/whatsapp/health/refresh', { body: { accountRef: 'wa:' + NUMBER } });
  const restricted = refreshed.numbers.find(n => n.accountRef === 'wa:' + NUMBER);
  assert.equal(restricted.status, 'restricted');
  assert.equal(restricted.statusLabel, 'Restringido');
  for (const category of ['marketing', 'utility', 'service'])
    assert.equal(restricted.sending[category].reason, 'number_restricted');
  assert.match(restricted.sending.utility.message, /restringió el número/);
  assert.equal(refreshed.numbers.find(n => n.accountRef === 'wa:' + NUMBER_2).status, 'connected');
  Object.assign(meta.health.numbers.get(NUMBER), { status: 'CONNECTED', quality_rating: 'GREEN' });
  await metaNotice(origin(), 'phone_number_quality_update', {
    display_phone_number: DISPLAY,
    event: 'UNFLAGGED',
    current_limit: 'TIER_10K',
  });
  const back = await until(async () => {
    const n = await one();
    return n.status === 'connected' && n.quality === 'green' ? n : null;
  }, 'el número recuperado');
  assert.deepEqual(back.sending.marketing, { ok: true });
  assert.ok(
    notes().some(n => /Número de prueba volvió a estar conectado/.test(n)),
    notes().join(' | '),
  );

  // 6) cuenta en revisión: se frena lo que inicia conversación; las respuestas (servicio) siguen
  meta.health.accounts.get(WABA_ID).account_review_status = 'PENDING';
  await metaNotice(origin(), 'account_review_update', { decision: 'PENDING' });
  const review = await until(async () => {
    const h = await health();
    return h.account.reviewStatus === 'pending' ? h : null;
  }, 'la cuenta en revisión');
  for (const n of review.numbers) {
    assert.equal(n.sending.marketing.reason, 'account_review');
    assert.equal(n.sending.utility.reason, 'account_review');
    assert.deepEqual(n.sending.service, { ok: true });
  }
  meta.health.accounts.get(WABA_ID).account_review_status = 'APPROVED';
  await metaNotice(origin(), 'account_review_update', { decision: 'APPROVED' });
  await until(async () => (await health()).account.reviewStatus === 'approved', 'la cuenta aprobada');

  // 7) restricción de la cuenta con fecha de fin: frena y termina sola
  await metaNotice(origin(), 'account_update', {
    event: 'ACCOUNT_RESTRICTION',
    restriction_info: [
      { restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: Math.floor(Date.now() / 1000) + 3 },
    ],
  });
  const restrictedAccount = await until(async () => {
    const h = await health();
    return h.account.restriction ? h : null;
  }, 'la cuenta restringida');
  assert.equal(restrictedAccount.numbers[0].sending.utility.reason, 'account_restricted');
  assert.deepEqual(restrictedAccount.numbers[0].sending.service, { ok: true });
  await until(() => notes().some(n => /Terminó la restricción/.test(n)), 'el fin de la restricción', { ms: 10000 });
  assert.equal((await health()).account.restriction, '');
  assert.deepEqual((await one()).sending.utility, { ok: true });

  // 8) permisos y alcance por marca: el equipo ve sólo los números de sus marcas, sin historial ni cuenta
  const register = async (username, name) =>
    (await call(origin(), '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  const agentGv = await register('asesor-gv', 'Asesor GlobalVet');
  const agentOt = await register('asesor-ot', 'Asesor OdonTeck');
  const customer = await register('clienta', 'Clienta curiosa');
  for (const [username, brand] of [
    ['asesor-gv', 'globalvet'],
    ['asesor-ot', 'odonteck'],
  ]) {
    const id = db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
    db.prepare("UPDATE users SET role='agent' WHERE id=?").run(id);
    db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(id, brand);
  }
  const gv = await call(origin(), '/api/whatsapp/health', { cookie: agentGv });
  assert.deepEqual(
    gv.numbers.map(n => n.accountRef),
    ['wa:' + NUMBER],
  );
  assert.equal(gv.account, null);
  assert.deepEqual(gv.history, []);
  assert.equal(gv.canRefresh, false);
  assert.equal('error' in gv.numbers[0], false);
  const ot = await call(origin(), '/api/whatsapp/health', { cookie: agentOt });
  assert.deepEqual(
    ot.numbers.map(n => n.accountRef),
    ['wa:' + NUMBER_2],
  );
  await call(origin(), '/api/whatsapp/health/refresh', { cookie: agentGv, body: {}, expected: 403 });
  await call(origin(), '/api/whatsapp/health/refresh', {
    cookie: agentOt,
    body: { accountRef: 'wa:' + NUMBER },
    expected: 403,
  });
  await call(origin(), '/api/whatsapp/health', { cookie: customer, expected: 403 });
  await api('/api/whatsapp/health/refresh', { body: { accountRef: 'wa:109999999999999' }, expected: 404 });
  await api('/api/whatsapp/health/refresh', { body: { accountRef: 'x' }, expected: 404 });
  await api('/api/whatsapp/health/nada', { expected: 404 });

  // un aviso de calidad del número de OdonTeck no toca al de GlobalVet
  Object.assign(meta.health.numbers.get(NUMBER_2), { quality_rating: 'RED', status: 'FLAGGED' });
  await metaNotice(origin(), 'phone_number_quality_update', { display_phone_number: DISPLAY_2, event: 'FLAGGED' });
  await until(async () => (await one('wa:' + NUMBER_2)).quality === 'red', 'la calidad del segundo número');
  assert.equal((await one()).quality, 'green');
  const otNotes = db
    .prepare("SELECT n.title FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.username='asesor-gv'")
    .all();
  assert.deepEqual(otNotes, [], 'los avisos de salud son para quien administra los números');

  // 9) refresco a mano: límite de frecuencia (6 por minuto por persona)
  let limited = false;
  for (let i = 0; i < 8 && !limited; i++) {
    const r = await fetch(origin() + '/api/whatsapp/health/refresh', {
      method: 'POST',
      headers: { Cookie: admin, Origin: origin(), 'Content-Type': 'application/json' },
      body: '{}',
    });
    limited = r.status === 429;
  }
  assert.equal(limited, true);
  assertSchemaCurrent(db);
});

test('Meta falla o no conoce un campo: lo demás se guarda y el error se explica sin secretos', async t => {
  const lab = await whatsappLab(t, { META_WABA_ID: WABA_ID, CHANNEL_HEALTH_MIN_GAP_MS: '300' });
  const { meta } = lab;
  const api = (path, options = {}) => call(lab.origin(), path, { cookie: lab.admin, ...options });
  meta.health.reject.add('name_status');
  meta.health.reject.add('whatsapp_business_manager_messaging_limit');
  meta.health.numbers.get(NUMBER).messaging_limit_tier = 'TIER_250';
  const n = await until(async () => {
    const x = (await api('/api/whatsapp/health')).numbers[0];
    return x?.checkedAt ? x : null;
  }, 'la primera consulta');
  assert.equal(n.nameStatus, '', 'sin dato');
  assert.equal(n.quality, 'green');
  assert.equal(n.limit.tier, 'TIER_250', 'el campo de respaldo');
  meta.health.failing = true;
  await sleep(400);
  const failed = (await api('/api/whatsapp/health/refresh', { body: { accountRef: 'wa:' + NUMBER } })).numbers[0];
  assert.match(failed.error, /Meta/);
  assert.doesNotMatch(failed.error, /EAAprueba/);
  assert.equal(failed.quality, 'green', 'lo último que se supo se conserva');
});

test('apagado sin CHANNEL_CONNECTOR=meta: no consulta, no aplica avisos y no frena al laboratorio', async t => {
  const lab = await whatsappLab(t, { CHANNEL_CONNECTOR: 'simulated', META_WABA_ID: WABA_ID });
  const { meta } = lab;
  const api = (path, options = {}) => call(lab.origin(), path, { cookie: lab.admin, ...options });
  await sleep(800);
  const h = await api('/api/whatsapp/health');
  assert.equal(h.live, false);
  assert.equal(h.canRefresh, false);
  assert.equal(h.numbers.length, 1);
  assert.equal(h.numbers[0].status, 'unknown');
  assert.equal(h.numbers[0].checkedAt, null);
  assert.deepEqual(h.numbers[0].sending.marketing, { ok: true, warning: 'simulated' });
  assert.equal(h.numbers[0].limit.source, 'simulated');
  const refused = await api('/api/whatsapp/health/refresh', { body: {}, expected: 409 });
  assert.equal(refused.code, 'channel_off');
  await metaNotice(lab.origin(), 'phone_number_quality_update', { display_phone_number: DISPLAY, event: 'FLAGGED' });
  await sleep(500);
  assert.equal((await api('/api/whatsapp/health')).numbers[0].quality, 'unknown');
  assert.deepEqual(meta.health.calls, [], 'nada se pidió a Meta');
});
