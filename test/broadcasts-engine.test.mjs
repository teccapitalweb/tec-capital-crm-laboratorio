// Motor de difusiones con plantilla (docs/PLAN_MOTOR_DIFUSIONES.md): reglas puras, la unión con la salud del número
// (con un doble), el envío suelto y el «nunca reenviar a ciegas» dentro del proceso, y de punta a punta con el
// servidor real y el Meta de mentira: exclusiones por motivo, costo contra el libro, estados por aviso, detención
// automática, pausa, reanudación, cancelación, tope diario, reinicio a medias, ensayo, programada, respuesta y botón
// atribuidos, permisos, alcance por marca y apagado por omisión. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import broadcastsModule from '../server/modules/broadcasts/module.mjs';
import { createSendGate } from '../server/modules/broadcasts/gate.mjs';
import * as model from '../server/modules/broadcasts/model.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { PASSWORD, call, crash, openDb, sleep, until, whatsappLab } from './helpers/crm.mjs';
import { NUMBER, metaInbound, metaPricing, metaStatus, metaText } from './helpers/fake-meta.mjs';
import { startServer } from './helpers/server.mjs';

const BRAND = 'globalvet';
const COURSE = 'nutricion';
const EDITION = 'edition-nutricion';
const BODY = 'Hola {{1}}, abrimos inscripciones de {{2}}.';
const FAST = {
  WA_BROADCAST_RATE_SCALE: '50',
  WA_BROADCAST_MAX_PER_SECOND: '1000',
  WA_BROADCAST_LEASE_MS: '4000',
  WA_BROADCAST_RECONCILE_MS: '5000',
};

// ---- datos inventados
function seedTemplate(
  db,
  { category = 'marketing', vars = ['nombre', 'curso'], body = BODY, status = 'approved' } = {},
) {
  const id = randomUUID();
  const components = {
    type: 'standard',
    header: { type: 'none' },
    body: { text: body, vars: vars.map(key => ({ key, sample: 'Muestra', fallback: null })) },
    footer: { text: 'Responde BAJA para no recibir más.' },
    buttons: [
      { type: 'quick_reply', text: 'Me interesa' },
      { type: 'quick_reply', text: 'No, gracias' },
    ],
  };
  db.prepare(
    "INSERT INTO wa_templates(id,brand_id,waba_id,name,language,category,body,variables,components,status,revision,created_at,updated_at) VALUES(?,?,'',?,'es_MX',?,?,?,?,?,1,1,1)",
  ).run(
    id,
    BRAND,
    'difusion_' + id.slice(0, 8),
    category,
    body,
    JSON.stringify(vars),
    JSON.stringify(components),
    status,
  );
  return id;
}
let phoneSeq = 5500000000;
function seedContacts(db, n, { prefix = 'bc', consent = 'opted_in' } = {}) {
  const t = Date.now();
  const ids = [];
  const contact = db.prepare(
    'INSERT INTO contacts(id,brand_id,name,phone,phone_key,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  );
  const agree = db.prepare(
    "INSERT INTO contact_consent(contact_id,brand_id,status,source,updated_at) VALUES(?,?,?,'prueba',?)",
  );
  for (let i = 0; i < n; i++) {
    const id = `${prefix}-${String(i).padStart(3, '0')}`;
    const key = '52' + phoneSeq++;
    contact.run(id, BRAND, 'Persona ' + prefix + i, '+' + key, key, 'import', t, t);
    if (consent) agree.run(id, BRAND, consent, t);
    ids.push(id);
  }
  return ids;
}
function seedList(db, contactIds, { role = 'audience', name = 'Lista ' + randomUUID().slice(0, 6) } = {}) {
  const id = randomUUID();
  const t = Date.now();
  db.prepare(
    "INSERT INTO audiences(id,brand_id,kind,role,name,name_key,definition,member_count,created_at,updated_at) VALUES(?,?,'list',?,?,?,'{}',?,?,?)",
  ).run(id, BRAND, role, name, name.toLowerCase(), contactIds.length, t, t);
  const member = db.prepare(
    "INSERT INTO audience_members(audience_id,contact_id,source,added_at) VALUES(?,?,'manual',?)",
  );
  for (const c of contactIds) member.run(id, c, t);
  return id;
}

// ---- migración
test('broadcasts/0002: se aplica sobre una base con ajustes y destinatarios, aditiva y una sola vez', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-motor-mig-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== 'broadcasts/0002-engine')) });
  db.prepare(
    'INSERT INTO campaign_settings(brand_id,enabled,min_gap_hours,pace_seconds,max_audience,revision,updated_at) VALUES(?,1,24,3,900,4,1)',
  ).run(BRAND);
  const before = { ...db.prepare('SELECT * FROM campaign_settings WHERE brand_id=?').get(BRAND) };
  const result = migrate(db, { backup: false });
  assert.deepEqual(result.applied, ['broadcasts/0002-engine']);
  assertSchemaCurrent(db);
  const after = db.prepare('SELECT * FROM campaign_settings WHERE brand_id=?').get(BRAND);
  for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, k);
  assert.deepEqual(
    [
      after.rate_per_minute,
      after.daily_cap,
      after.quiet_start,
      after.quiet_end,
      after.monthly_budget_cents,
      after.fail_stop_pct,
    ],
    [60, 250, '21:00', '08:00', 0, 50],
  );
  assert.ok(
    db
      .prepare('PRAGMA table_info(campaign_recipients)')
      .all()
      .some(c => c.name === 'client_ref'),
  );
  assert.deepEqual(migrate(db, { backup: false }).applied, [], 'segunda pasada sin cambios');
});

// ---- reglas puras
test('reglas: códigos de Meta, horario de silencio, ritmo, tasa de fallos, cargas y opciones', () => {
  assert.equal(model.classifyMetaError(131049).recipient, 'cap');
  assert.equal(model.classifyMetaError(132015).stop, 'template_paused');
  assert.equal(model.classifyMetaError(131048).stop, 'number_restricted');
  assert.equal(model.classifyMetaError(190).stop, 'token_invalid');
  assert.equal(model.classifyMetaError(131000).backoff, true);
  assert.deepEqual(
    [model.classifyMetaError(999).recipient, model.classifyMetaError(999, 'algo').label],
    ['failed', 'algo'],
  );
  // 21:00–08:00 en Ciudad de México (UTC-6): 03:00 UTC son las 21:00; 15:00 UTC son las 09:00
  const tz = 'America/Mexico_City';
  assert.equal(model.inQuietHours(Date.UTC(2026, 10, 14, 3, 0), tz, '21:00', '08:00'), true);
  assert.equal(model.inQuietHours(Date.UTC(2026, 10, 14, 15, 0), tz, '21:00', '08:00'), false);
  assert.equal(model.inQuietHours(Date.UTC(2026, 10, 14, 3, 0), tz, '00:00', '00:00'), false, 'iguales: sin silencio');
  // 60 por minuto: uno por segundo, sin ráfagas
  const bucket = model.createBucket(60, 0);
  assert.equal(bucket.available(0), 1);
  bucket.take(1);
  assert.equal(bucket.available(500), 0);
  assert.equal(bucket.available(1000), 1);
  bucket.take(1);
  assert.equal(bucket.available(10_000), 1, 'la ráfaga no pasa de un segundo');
  const fast = model.createBucket(600, 0);
  assert.equal(fast.available(0), 10);
  // tasa de fallos: más de la mitad de los últimos 50, con al menos 10
  assert.equal(model.tooManyFailures(Array(9).fill(true)), false);
  assert.equal(model.tooManyFailures(Array(10).fill(true)), true);
  assert.equal(model.tooManyFailures([...Array(5).fill(true), ...Array(5).fill(false)]), false);
  const rid = 'a'.repeat(32);
  assert.deepEqual(model.parsePayload(model.buttonPayload(rid, 1)), { recipientId: rid, index: 1 });
  assert.equal(model.parsePayload('tpl:abc:0'), null);
  assert.deepEqual(model.parseCallback(model.callbackOf(rid, 2)), { recipientId: rid, attempt: 2 });
  assert.equal(model.maskDigits('+525512345678'), '••••78');
  assert.equal(model.normalizeOptions({ ratePerMinute: 5 }).problems[0][0], 'ratePerMinute');
  assert.equal(model.normalizeOptions({ batchSize: 100 }).problems[0][0], 'batchSize');
  assert.equal(model.normalizeOptions({ sendHours: 'any' }).problems[0][0], 'sendHours');
  assert.equal(model.normalizeOptions({ sendHours: 'any' }, {}, { admin: true }).problems.length, 0);
  assert.equal(model.normalizeOptions({ mode: 'rehearsal' }).options.mode, 'rehearsal');
});

test('salud del número: manda channel-health si está cargado; si no, el tope conservador', () => {
  const quiet = { error() {} };
  const fallback = { fallbackLimit: () => 250, usedToday: () => 240, log: quiet };
  const none = createSendGate({
    health: () => {
      throw new Error('No hay un módulo «channel-health».');
    },
    ...fallback,
  });
  assert.deepEqual(none.check('109', 'marketing', BRAND), {
    ok: true,
    reason: null,
    limit: 250,
    used: 240,
    remaining: 10,
    source: 'fallback',
  });
  const calls = [];
  const double = {
    canSend: (ref, category) => (
      calls.push([ref, category]),
      category === 'marketing' ? { ok: false, reason: 'quality_low' } : { ok: true }
    ),
    limitsOf: () => ({ limit: 1000, used: 10, remaining: 990 }),
  };
  const withHealth = createSendGate({ health: () => double, ...fallback });
  assert.deepEqual(withHealth.check('109', 'marketing', BRAND), {
    ok: false,
    reason: 'quality_low',
    limit: 1000,
    used: 10,
    remaining: 990,
    source: 'channel-health',
  });
  assert.equal(withHealth.check('109', 'utility', BRAND).ok, true);
  assert.deepEqual(calls[0], ['109', 'marketing']);
  // un módulo que falla no detiene el envío a ciegas: cae al tope conservador
  const broken = createSendGate({
    health: () => ({
      canSend: () => {
        throw new Error('sin datos');
      },
      limitsOf: () => ({}),
    }),
    ...fallback,
  });
  assert.equal(broken.check('109', 'marketing', BRAND).source, 'fallback');
});

// ---- dentro del proceso: envío suelto, idempotencia, envío en duda y atribución
async function inProcess(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-motor-'));
  const db = openDatabase(dir);
  migrate(db, { backup: false });
  assertSchemaCurrent(db);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  db.prepare(
    "INSERT INTO wa_numbers(phone_number_id,brand_id,course_id,label,created_at,updated_at) VALUES(?,?,'aves','Ventas',1,1)",
  ).run(NUMBER, BRAND);
  db.prepare(
    'INSERT INTO campaign_settings(brand_id,enabled,min_gap_hours,pace_seconds,max_audience,revision,updated_at) VALUES(?,1,0,2,5000,1,1)',
  ).run(BRAND);
  const sent = [];
  const published = [];
  const listeners = [];
  const failure = Object.assign;
  const make = sender => {
    const host = {
      db,
      fail: (status, message, extra = {}) => failure(new Error(message), { status, ...extra }),
      access: { can: () => true, require() {}, brandIds: () => [BRAND], phone: v => v },
      audit() {},
      realtime: { emit() {} },
      insertMessage: () => randomUUID(),
      services: {
        events: { registerTypes() {}, publish: e => published.push(e) },
        automation: { enabledFor: () => true },
        connectors: {
          on: (type, fn) => listeners.push(fn),
          metaLive: () => true,
          adapters: { channel: { meta: { send: m => (sent.push(m), sender(m)) } } },
        },
      },
      module(name) {
        if (name === 'wa-templates')
          return {
            // doble mínimo de resolve: nombre y llamada.<n>; lo demás, como falta
            resolve(row, { values = {}, overrides = {} }) {
              const def = JSON.parse(row.components);
              const missing = [];
              const params = def.body.vars.map(v => {
                const value = v.key.startsWith('llamada.') ? overrides[v.key.slice(8)] : values[v.key];
                if (!value) missing.push(v.key);
                return value ?? '';
              });
              return {
                params,
                header: null,
                buttons: def.buttons.map((b, index) => ({ index, subType: 'quick_reply', payload: 'x' })),
                text: def.body.text.replace(/\{\{(\d+)\}\}/g, (_, n) => params[n - 1]),
                missing,
                quickReplies: def.buttons.map(b => b.text),
              };
            },
            forSend: async tpl => tpl,
          };
        if (name === 'audiences') return { suppressed: () => false };
        throw new Error('No hay un módulo «' + name + '».');
      },
    };
    return broadcastsModule.create(host);
  };
  return { db, sent, published, listeners, make };
}

test('envío suelto: idempotente, sale una vez, su estado, y en duda nunca se reenvía a ciegas', async t => {
  let mode = 'timeout';
  const env = await inProcess(t);
  const sender = async () => {
    if (mode === 'timeout')
      throw Object.assign(new Error('tiempo de espera agotado'), { network: true, timeout: true });
    return { providerRef: 'wamid.p' + env.sent.length, state: 'sent', reason: null, waId: null };
  };
  const { db, sent } = env;
  const tpl = seedTemplate(db, {
    category: 'utility',
    vars: ['nombre', 'llamada.hora'],
    body: 'Hola {{1}}, tu clase es a las {{2}}.',
  });
  const [contact, other] = seedContacts(db, 2, { prefix: 'one', consent: null });
  const first = env.make(sender);
  const input = {
    brandId: BRAND,
    contactId: contact,
    waTemplateId: tpl,
    values: { hora: '10:00' },
    label: 'recordatorio',
    clientRef: 'recordatorio-0000000001',
  };
  const a = first.sendOne(input);
  assert.equal(a.state, 'queued');
  assert.equal(a.duplicate, false);
  const again = first.sendOne(input);
  assert.deepEqual([again.id, again.duplicate], [a.id, true], 'misma referencia, mismo envío');
  assert.throws(
    () => first.sendOne({ ...input, clientRef: 'recordatorio-0000000002' }),
    e => e.status === 409 && e.code === 'already_sent_today',
  );
  assert.throws(
    () => first.sendOne({ ...input, clientRef: 'corta' }),
    e => e.status === 400,
  );
  // el envío pasa por el emisor: Meta no contesta (tiempo de espera) → queda en duda
  await first.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].callback, model.callbackOf(a.id, 1));
  assert.deepEqual(sent[0].template.params, ['Persona', '10:00'], 'datos del contacto y de quien llama');
  assert.equal(first.sendStatus(BRAND, a.id).state, 'sending');
  // «reinicio»: otra instancia del motor (otro dueño); pasa el arrendamiento y el emisor NO lo vuelve a enviar
  mode = 'ok';
  const second = env.make(sender);
  db.prepare('UPDATE campaign_recipients SET lease_until=? WHERE id=?').run(Date.now() - 1, a.id);
  await second.tick();
  await second.tick();
  assert.equal(sent.length, 1, 'un destinatario, un mensaje');
  // el aviso de Meta con el dato de vuelta lo resuelve
  assert.match(
    second.applyStatus({ providerRef: 'wamid.recuperado', state: 'delivered', callback: model.callbackOf(a.id, 1) }),
    /entregado|delivered/,
  );
  const status = second.sendStatus(BRAND, a.id);
  assert.deepEqual([status.state, typeof status.deliveredAt], ['delivered', 'number']);
  assert.throws(
    () => second.sendStatus('otra-marca', a.id),
    e => e.status === 404,
    'alcance por marca',
  );
  // sin aviso: pasado el plazo queda fallido «sin confirmar» y no se reintenta
  const b = second.sendOne({ ...input, contactId: other, clientRef: 'recordatorio-0000000003' });
  mode = 'timeout';
  await second.tick();
  assert.equal(sent.length, 2);
  db.prepare('UPDATE campaign_recipients SET lease_until=?,updated_at=? WHERE id=?').run(1, 1, b.id);
  mode = 'ok';
  await second.tick();
  const lost = second.sendStatus(BRAND, b.id);
  assert.equal(lost.state, 'failed');
  assert.match(lost.failReason, /No se reintentó/);
  assert.equal(sent.length, 2, 'nunca se reenvía a ciegas');
  // atribución: la respuesta del contacto se reconoce por su número (aproximada) y por el botón (exacta)
  const key = db.prepare('SELECT wa_to FROM campaign_recipients WHERE id=?').get(a.id).wa_to;
  db.prepare(
    "UPDATE campaign_recipients SET params=json_set(params,'$.quickReplies',json('[\"Confirmo\"]')) WHERE id=?",
  ).run(a.id);
  const approx = second.attribute({ waId: '521' + key.slice(2), numberId: NUMBER });
  assert.deepEqual([approx.recipient.id, approx.exact], [a.id, false]);
  const exact = second.attribute({
    waId: '521' + key.slice(2),
    numberId: NUMBER,
    payload: model.buttonPayload(a.id, 0),
  });
  assert.deepEqual([exact.exact, exact.button], [true, { index: 0, label: 'Confirmo' }]);
  // otra persona (B) que manda la carga del botón de A o cita su mensaje no queda atribuida a A
  const keyB = db.prepare('SELECT wa_to FROM campaign_recipients WHERE id=?').get(b.id).wa_to;
  const ref = db.prepare('SELECT provider_ref FROM campaign_recipients WHERE id=?').get(a.id).provider_ref;
  for (const forged of [{ payload: model.buttonPayload(a.id, 0) }, { contextRef: ref }])
    assert.equal(second.attribute({ waId: '521' + keyB.slice(2), numberId: NUMBER, ...forged }), null, 'no es suya');
  assert.equal(second.attribute({ waId: '000', numberId: NUMBER, payload: model.buttonPayload(a.id, 0) }), null);
  assert.equal(second.attribute({ waId: '521' + key.slice(2), numberId: '999' }), null, 'otro número: no es suya');
});

// ---- de punta a punta
async function setup(lab, { dailyCap = 5000 } = {}) {
  const admin = lab.admin;
  const api = (path, { body, method, expected = 200 } = {}) =>
    call(lab.origin(), path, { cookie: admin, body, method, expected });
  const brand = await api('/api/campaigns/settings');
  const rev = (brand.settings || []).find?.(s => s.brand_id === BRAND)?.revision ?? 0;
  await api('/api/campaigns/settings/' + BRAND, {
    method: 'PATCH',
    body: { enabled: true, minGapHours: 72, expectedRevision: rev },
  });
  const auto = await api('/api/automation');
  const autoRev =
    auto.brands?.find?.(b => b.brandId === BRAND || b.brand_id === BRAND || b.id === BRAND)?.revision ?? 0;
  await api('/api/automation/brands/' + BRAND, { method: 'PATCH', body: { enabled: true, expectedRevision: autoRev } });
  const s = (await api('/api/broadcasts/settings?brand=' + BRAND)).settings;
  await api('/api/broadcasts/settings/' + BRAND, {
    method: 'PATCH',
    body: { quietStart: '00:00', quietEnd: '00:00', dailyCap, expectedRevision: s.revision },
  });
  return api;
}
const createBroadcast = (api, body) =>
  api('/api/broadcasts', {
    expected: 201,
    body: {
      brandId: BRAND,
      waNumber: NUMBER,
      content: { context: { courseId: COURSE, editionId: EDITION } },
      clientRef: 'dif-' + randomUUID(),
      ...body,
    },
  }).then(r => r.campaign);
async function launchNow(api, campaign, extra = {}) {
  const { preview } = await api(`/api/broadcasts/${campaign.id}/preview`, { body: {} });
  const out = await api(`/api/broadcasts/${campaign.id}/schedule`, {
    body: { expectedRevision: campaign.revision, confirmAudience: preview.willSend, acceptCost: true, ...extra },
  });
  return { preview, campaign: out.campaign };
}
const stateOf = (db, id) => db.prepare('SELECT status,status_reason FROM campaigns WHERE id=?').get(id);
const counts = (db, id) =>
  Object.fromEntries(
    db
      .prepare('SELECT state,count(*) n FROM campaign_recipients WHERE campaign_id=? GROUP BY state')
      .all(id)
      .map(r => [r.state, r.n]),
  );
// Envíos que Meta aceptó, por destinatario: «un destinatario, un mensaje».
const acceptedPerRecipient = meta => {
  const out = new Map();
  for (const m of meta.sent) if (m.type === 'template' && !m.refused) out.set(m.to, (out.get(m.to) ?? 0) + 1);
  return out;
};

test('de punta a punta: 300 contactos, cada motivo de exclusión, costo, estados, respuesta y botón atribuidos', async t => {
  const lab = await whatsappLab(t, FAST);
  const db = lab.db;
  const api = await setup(lab);
  const tpl = seedTemplate(db);
  const ids = seedContacts(db, 300);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  for (const id of ids.slice(0, 5)) run("UPDATE contact_consent SET status='opted_out' WHERE contact_id=?", id);
  for (const id of ids.slice(5, 10)) run('DELETE FROM contact_consent WHERE contact_id=?', id);
  for (const id of ids.slice(10, 15)) run("UPDATE contacts SET phone='',phone_key='' WHERE id=?", id);
  const suppression = seedList(db, ids.slice(15, 20), { role: 'suppression', name: 'No escribir' });
  for (let i = 25; i < 30; i++)
    run(
      'UPDATE contacts SET phone=(SELECT phone FROM contacts WHERE id=?),phone_key=(SELECT phone_key FROM contacts WHERE id=?) WHERE id=?',
      ids[i - 5],
      ids[i - 5],
      ids[i],
    );
  const excluded = seedList(db, ids.slice(30, 35), { name: 'Excluir' });
  for (const id of ids.slice(35, 40)) run("UPDATE contacts SET name='' WHERE id=?", id);
  // tres recibieron otra difusión hace una hora (separación mínima de 72 h)
  const old = randomUUID();
  run(
    "INSERT INTO campaigns(id,brand_id,kind,title,wa_template_id,wa_number,status,created_at,updated_at) VALUES(?,?,'template','Anterior',?,?,'completed',1,1)",
    old,
    BRAND,
    tpl,
    NUMBER,
  );
  for (const id of ids.slice(40, 43))
    run(
      "INSERT INTO campaign_recipients(campaign_id,contact_id,state,wa_to,sent_at,created_at) VALUES(?,?,'sent',(SELECT phone_key FROM contacts WHERE id=?),?,?)",
      old,
      id,
      id,
      Date.now() - 3_600_000,
      Date.now(),
    );
  const everyone = seedList(db, ids, { name: 'Todos' });
  assert.ok(suppression);

  const segment = { version: 2, include: [{ audienceId: everyone }], exclude: [{ audienceId: excluded }] };
  const draft = await createBroadcast(api, { waTemplateId: tpl, segment, options: { ratePerMinute: 600 } });
  assert.equal(draft.status, 'draft');
  // repetir el alta con la misma referencia devuelve la misma
  const repeat = await api('/api/broadcasts', {
    body: { brandId: BRAND, waTemplateId: tpl, segment, clientRef: 'dif-repetida-0000001' },
    expected: 201,
  });
  const repeated = await api('/api/broadcasts', {
    body: { brandId: BRAND, waTemplateId: tpl, segment, clientRef: 'dif-repetida-0000001' },
  });
  assert.equal(repeated.campaign.id, repeat.campaign.id);
  // un importe escrito a mano no entra como texto fijo
  await api(`/api/broadcasts/${draft.id}`, {
    method: 'PATCH',
    body: { expectedRevision: draft.revision, content: { fixed: { promo: '$379 de descuento' } } },
    expected: 400,
  });

  const { preview } = await api(`/api/broadcasts/${draft.id}/preview`, { body: {} });
  const reasons = Object.fromEntries(preview.excluded.map(e => [e.reason, e.count]));
  assert.deepEqual(reasons, {
    opted_out: 5,
    no_consent: 5,
    no_address: 5,
    suppressed: 5,
    duplicate: 5,
    excluded: 5,
    missing_variable: 5,
    recent_campaign: 3,
  });
  assert.equal(preview.eligible, 262);
  assert.equal(preview.willSend, 262);
  assert.deepEqual(preview.blockers, []);
  // costo: el del motor de costos, con la tarifa vigente de México para marketing
  const { rates } = await api('/api/wa-costs/rates');
  const mx = rates
    .filter(r => r.market === 'MX' && r.category === 'marketing' && r.effective_from <= Date.now())
    .sort((a, b) => b.effective_from - a.effective_from)[0];
  assert.equal(preview.cost.max.micros, 262 * mx.rate_micros);
  assert.deepEqual(
    preview.cost.byMarket.map(m => [m.market, m.count]),
    [['MX', 262]],
  );
  assert.equal(preview.sample[0].rendered, 'Hola Persona, abrimos inscripciones de Nutrición en perros y gatos.');

  // programar: exige el público confirmado y aceptar el costo
  await api(`/api/broadcasts/${draft.id}/schedule`, {
    body: { expectedRevision: draft.revision, confirmAudience: 261, acceptCost: true },
    expected: 409,
  });
  await api(`/api/broadcasts/${draft.id}/schedule`, {
    body: { expectedRevision: draft.revision, confirmAudience: 262 },
    expected: 400,
  });
  await launchNow(api, draft);
  await until(() => stateOf(db, draft.id).status === 'completed', 'la difusión termina', { ms: 30000 });
  assert.deepEqual(counts(db, draft.id), { sent: 262, skipped: 38 });
  const accepted = acceptedPerRecipient(lab.meta);
  assert.equal(accepted.size, 262);
  assert.ok(
    [...accepted.values()].every(n => n === 1),
    'un destinatario, un mensaje',
  );
  const one = lab.meta.sent.find(m => m.type === 'template');
  assert.match(one.biz_opaque_callback_data, /^tc:[0-9a-f]{32}:1$/);
  const body = one.template.components.find(c => c.type === 'body').parameters.map(p => p.text);
  assert.equal(body[1], 'Nutrición en perros y gatos');
  assert.match(one.template.components.find(c => c.type === 'button').parameters[0].payload, /^c:[0-9a-f]{32}:0$/);

  // estados por aviso de Meta: entregado, leído y fallido; el entregado entra al libro de costos
  const rows = db
    .prepare(
      "SELECT * FROM campaign_recipients WHERE campaign_id=? AND state='sent' ORDER BY position LIMIT 5 OFFSET 10",
    ) // lejos de los números repetidos a propósito
    .all(draft.id);
  await metaStatus(lab.origin(), rows[0].provider_ref, 'delivered', { pricing: metaPricing('marketing') });
  await metaStatus(lab.origin(), rows[1].provider_ref, 'read');
  await metaStatus(lab.origin(), rows[2].provider_ref, 'failed', {
    error: { code: 131026, title: 'Message undeliverable', message: 'Message undeliverable' },
  });
  await until(
    () => db.prepare('SELECT state FROM campaign_recipients WHERE id=?').get(rows[2].id).state === 'failed',
    'el fallo llega',
  );
  const state = id => db.prepare('SELECT * FROM campaign_recipients WHERE id=?').get(id);
  assert.equal(state(rows[0].id).state, 'delivered');
  assert.equal(state(rows[1].id).state, 'read');
  assert.equal(state(rows[2].id).fail_code, 131026);
  await metaStatus(lab.origin(), rows[0].provider_ref, 'sent'); // un aviso viejo no hace retroceder
  assert.equal(state(rows[0].id).state, 'delivered');
  const ledger = db.prepare('SELECT * FROM wa_message_costs WHERE provider_ref=?').get(rows[0].provider_ref);
  assert.deepEqual([ledger.origin, ledger.campaign_id, ledger.category], ['campaign', draft.id, 'marketing']);

  // responde tocando «Me interesa»: atribución exacta; la conversación nace en el curso de la difusión, con el mismo
  // contacto de la lista y el mensaje de la difusión antes del suyo
  const r4 = rows[3];
  const waId = '521' + r4.wa_to.slice(2);
  await metaInbound(lab.origin(), waId, 'wamid.in-boton', {
    type: 'button',
    button: { text: 'Me interesa', payload: model.buttonPayload(r4.id, 0) },
  });
  const written = await until(
    () => db.prepare('SELECT * FROM messages WHERE client_ref=?').get('campaign:' + r4.id),
    'el mensaje de la difusión queda en la conversación',
  );
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(written.conversation_id);
  assert.deepEqual([conv.course_id, conv.edition_id], [COURSE, EDITION]);
  const theirs = db.prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_kind='customer'").get(conv.id);
  assert.ok(written.seq < theirs.seq, 'la difusión va antes de la respuesta');
  assert.equal(written.provider_ref, r4.provider_ref);
  const replied = state(r4.id);
  assert.deepEqual(
    [replied.reply_kind, replied.click_label, replied.conversation_id],
    ['button', 'Me interesa', conv.id],
  );
  assert.equal(
    db.prepare('SELECT source_user_id FROM contacts WHERE id=?').get(r4.contact_id).source_user_id,
    conv.customer_id,
  );
  assert.equal(
    db.prepare('SELECT count(*) n FROM contacts WHERE brand_id=? AND phone_key=?').get(BRAND, r4.wa_to).n,
    1,
    'no nace otro contacto: es el de la lista',
  );
  // responde con texto, sin citar: atribución aproximada (la última difusión que recibió)
  const r5 = rows[4];
  await metaText(lab.origin(), '521' + r5.wa_to.slice(2), 'wamid.in-texto', '¿Cuánto cuesta?');
  await until(() => state(r5.id).replied_at, 'la respuesta de texto se atribuye');
  assert.equal(state(r5.id).reply_kind, 'text');
  // otra persona manda la carga del botón de rows[1]: no se le atribuye ni le suma respuesta ni clic a rows[1]
  await metaInbound(lab.origin(), '521' + rows[0].wa_to.slice(2), 'wamid.in-falsa', {
    type: 'button',
    button: { text: 'Me interesa', payload: model.buttonPayload(rows[1].id, 0) },
  });
  await until(() => state(rows[0].id).replied_at, 'la respuesta queda en su propia difusión');
  assert.deepEqual([state(rows[1].id).replied_at, state(rows[1].id).clicked_at], [null, null]);
  assert.equal(state(rows[0].id).reply_kind, 'text', 'sin botón válido: aproximada, sin clic');
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE client_ref=?').get('campaign:' + r5.id));
  const events = db.prepare("SELECT count(*) n FROM domain_events WHERE type='difusion.respondida'").get().n;
  assert.equal(events, 3);

  // contadores y detalle
  const detail = (await api('/api/broadcasts/' + draft.id)).campaign;
  assert.equal(detail.status, 'completed');
  assert.deepEqual(
    [detail.stats.replied, detail.stats.clicked, detail.stats.read, detail.stats.failed, detail.stats.skipped],
    [3, 1, 1, 1, 38],
  );
  const page = await api(`/api/broadcasts/${draft.id}/recipients?state=skipped&limit=50`);
  assert.equal(page.total, 38);
  assert.ok(page.reasons.some(r => r.reason === 'suppressed' && r.count === 5));
  const list = await api('/api/broadcasts?brand=' + BRAND);
  assert.ok(list.broadcasts.some(b => b.id === draft.id && b.stats.sentTotal === 261));
});

test('detención automática, pausa, reanudación, cancelación, tope diario, programada y reinicio a medias', async t => {
  const lab = await whatsappLab(t, FAST);
  const db = lab.db;
  const api = await setup(lab);
  const settingsRev = async () => (await api('/api/broadcasts/settings?brand=' + BRAND)).settings.revision;
  const tpl = seedTemplate(db);
  const campaignWith = async (n, options, prefix) => {
    const ids = seedContacts(db, n, { prefix });
    const list = seedList(db, ids);
    return createBroadcast(api, { waTemplateId: tpl, segment: { audienceId: list }, options });
  };

  // 1) tasa de fallos: Meta rechaza todo → se detiene sola antes de terminar
  lab.meta.refuse.set('*', { code: 100, message: 'Parámetro no válido' });
  const c1 = await campaignWith(40, { ratePerMinute: 12 }, 'f1');
  await launchNow(api, c1);
  await until(() => stateOf(db, c1.id).status === 'stopped', 'se detiene por fallos');
  assert.equal(stateOf(db, c1.id).status_reason, 'high_failure_rate');
  await until(() => !counts(db, c1.id).sending, 'lo que estaba en vuelo termina');
  const stopped = counts(db, c1.id);
  assert.ok(stopped.failed >= 10 && stopped.queued > 0, JSON.stringify(stopped));
  lab.meta.refuse.clear();
  let fresh = (await api('/api/broadcasts/' + c1.id)).campaign;
  await api(`/api/broadcasts/${c1.id}/resume`, { body: { expectedRevision: fresh.revision } });
  await until(() => stateOf(db, c1.id).status === 'completed', 'termina tras reanudar');
  assert.equal(counts(db, c1.id).sent, 40 - stopped.failed, 'los fallidos no se reintentan solos');

  // 2) Meta pausó la plantilla (132015 al enviar): se detiene y nadie pierde su turno
  lab.meta.refuse.set('*', { code: 132015, message: 'Template paused' });
  const c2 = await campaignWith(30, { ratePerMinute: 12 }, 'f2');
  await launchNow(api, c2);
  await until(() => stateOf(db, c2.id).status === 'stopped', 'se detiene por plantilla pausada');
  assert.equal(stateOf(db, c2.id).status_reason, 'template_paused');
  await until(() => !counts(db, c2.id).sending, 'lo que estaba en vuelo termina');
  assert.deepEqual(counts(db, c2.id), { queued: 30 }, 'vuelven a la cola sin gastar el intento');
  assert.equal(db.prepare('SELECT max(attempts) n FROM campaign_recipients WHERE campaign_id=?').get(c2.id).n, 0);
  // con la plantilla pausada en el CRM no se reanuda
  db.prepare("UPDATE wa_templates SET status='paused' WHERE id=?").run(tpl);
  fresh = (await api('/api/broadcasts/' + c2.id)).campaign;
  await api(`/api/broadcasts/${c2.id}/resume`, { body: { expectedRevision: fresh.revision }, expected: 409 });
  db.prepare("UPDATE wa_templates SET status='approved' WHERE id=?").run(tpl);
  lab.meta.refuse.clear();
  await api(`/api/broadcasts/${c2.id}/resume`, { body: { expectedRevision: fresh.revision } });
  await until(() => stateOf(db, c2.id).status === 'completed', 'termina tras reanudar');
  assert.deepEqual(counts(db, c2.id), { sent: 30 });

  // 3) la plantilla se pausa mientras envía (aviso de Meta aplicado por el módulo de plantillas)
  const c3 = await campaignWith(40, { ratePerMinute: 12 }, 'f3');
  await launchNow(api, c3);
  await until(() => (counts(db, c3.id).sent ?? 0) > 0, 'empieza a enviar');
  db.prepare("UPDATE wa_templates SET status='paused' WHERE id=?").run(tpl);
  await until(() => stateOf(db, c3.id).status === 'stopped', 'se detiene sola');
  assert.equal(stateOf(db, c3.id).status_reason, 'template_paused');
  assert.ok(counts(db, c3.id).sent < 40);
  db.prepare("UPDATE wa_templates SET status='approved' WHERE id=?").run(tpl);
  fresh = (await api('/api/broadcasts/' + c3.id)).campaign;
  await api(`/api/broadcasts/${c3.id}/cancel`, { body: { expectedRevision: fresh.revision } });
  await api(`/api/broadcasts/${c3.id}/cancel`, { body: { expectedRevision: fresh.revision } }); // inocuo
  const cancelled = counts(db, c3.id);
  assert.equal(cancelled.queued, undefined);
  assert.equal(cancelled.cancelled + cancelled.sent, 40);

  // 4) pausa y reanudación: en pausa no sale nada nuevo
  const c4 = await campaignWith(40, { ratePerMinute: 12 }, 'f4');
  await launchNow(api, c4);
  await until(() => (counts(db, c4.id).sent ?? 0) >= 5, 'empieza a enviar');
  fresh = (await api('/api/broadcasts/' + c4.id)).campaign;
  await api(`/api/broadcasts/${c4.id}/pause`, { body: { expectedRevision: fresh.revision } });
  await sleep(300);
  const paused = counts(db, c4.id).sent;
  await sleep(800);
  assert.equal(counts(db, c4.id).sent, paused, 'en pausa no sale nada');
  assert.ok(paused < 40);
  fresh = (await api('/api/broadcasts/' + c4.id)).campaign;
  await api(`/api/broadcasts/${c4.id}/pause`, { body: { expectedRevision: fresh.revision }, expected: 409 });
  await api(`/api/broadcasts/${c4.id}/resume`, { body: { expectedRevision: fresh.revision } });
  await until(() => stateOf(db, c4.id).status === 'completed', 'termina tras reanudar');

  // 5) tope diario: con el tope del número casi lleno, sale lo que cabe y espera
  const used = db
    .prepare(
      'SELECT count(DISTINCT r.wa_to) n FROM campaign_recipients r JOIN campaigns c ON c.id=r.campaign_id WHERE c.wa_number=? AND r.sent_at IS NOT NULL',
    )
    .get(NUMBER).n;
  await api('/api/broadcasts/settings/' + BRAND, {
    method: 'PATCH',
    body: { dailyCap: used + 5, expectedRevision: await settingsRev() },
  });
  const c5 = await campaignWith(20, { ratePerMinute: 600 }, 'f5');
  const { preview } = await launchNow(api, c5);
  assert.equal(preview.limits.remaining, 5);
  assert.equal(preview.limits.source, 'fallback', 'sin el módulo de salud: el tope conservador');
  await until(() => stateOf(db, c5.id).status_reason === 'daily_limit', 'espera por el tope diario');
  assert.equal(counts(db, c5.id).sent, 5);
  assert.equal(stateOf(db, c5.id).status, 'sending');
  await api('/api/broadcasts/settings/' + BRAND, {
    method: 'PATCH',
    body: { dailyCap: 5000, expectedRevision: await settingsRev() },
  });
  await until(() => stateOf(db, c5.id).status === 'completed', 'termina con tope libre');

  // 6) programada: sale a su hora, no antes
  const c6 = await campaignWith(5, { ratePerMinute: 600 }, 'f6');
  await launchNow(api, c6, { scheduledAt: Date.now() + 2500 });
  await sleep(800);
  assert.equal(stateOf(db, c6.id).status, 'scheduled');
  await until(() => stateOf(db, c6.id).status === 'completed', 'sale a su hora', { ms: 10000 });

  // 7) reinicio a medias: cinco envíos en vuelo cuando el proceso muere. Ninguno se reenvía: dos se resuelven por el
  // aviso de Meta (dato de vuelta) y tres quedan «sin confirmar»; los demás salen una sola vez al volver.
  lab.meta.hold('send');
  const c7 = await campaignWith(20, { ratePerMinute: 6 }, 'f7');
  await launchNow(api, c7);
  await until(() => lab.meta.waiting('send') === 5, 'cinco envíos en vuelo');
  await crash(lab.state.server);
  lab.meta.release('send');
  await lab.start();
  const held = lab.meta.sent.filter(m => m.biz_opaque_callback_data && counts(db, c7.id) && m.to.startsWith('52'));
  const inDoubt = db
    .prepare("SELECT id,attempts FROM campaign_recipients WHERE campaign_id=? AND state='sending'")
    .all(c7.id);
  assert.equal(inDoubt.length, 5);
  for (const [i, r] of inDoubt.slice(0, 2).entries())
    await metaStatus(lab.origin(), 'wamid.recuperado-' + i, 'delivered', {
      callback: model.callbackOf(r.id, r.attempts),
    });
  await until(() => stateOf(db, c7.id).status === 'completed', 'termina tras el reinicio', { ms: 20000 });
  const final = counts(db, c7.id);
  assert.deepEqual(final, { sent: 15, delivered: 2, failed: 3 });
  assert.equal(
    db.prepare("SELECT count(*) n FROM campaign_recipients WHERE campaign_id=? AND fail_kind='unconfirmed'").get(c7.id)
      .n,
    3,
  );
  assert.ok(held.length > 0);
  const per = acceptedPerRecipient(lab.meta);
  const c7to = db
    .prepare('SELECT wa_to FROM campaign_recipients WHERE campaign_id=?')
    .all(c7.id)
    .map(r => r.wa_to);
  assert.ok(
    c7to.every(to => per.get(to) === 1),
    'un destinatario, un mensaje, aunque el proceso murió',
  );
});

test('apagado por omisión, sólo ensayo sin WhatsApp real, permisos y alcance por marca', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-motor-off-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code, ...FAST } });
  let db = null;
  t.after(async () => {
    db?.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const reg = async (username, inviteCode) =>
    (
      await call(server.origin, '/api/auth/register', {
        body: { username, name: 'Prueba ' + username, password: PASSWORD, ...(inviteCode ? { inviteCode } : {}) },
      })
    ).cookie;
  const admin = await reg('admin', code);
  const api = (path, { body, method, expected = 200, cookie = admin } = {}) =>
    call(server.origin, path, { cookie, body, method, expected });
  db = openDb(dir);
  assertSchemaCurrent(db);
  const customer = await reg('cliente1');
  await api('/api/broadcasts?brand=' + BRAND, { cookie: customer, expected: 403 });
  const agent = await reg('asesor1');
  db.prepare("UPDATE users SET role='agent' WHERE username='asesor1'").run();
  await api('/api/broadcasts?brand=' + BRAND, { cookie: agent, expected: 403 });
  await api('/api/broadcasts?brand=no-existe', { expected: 404 });
  await api('/api/broadcasts/settings/' + BRAND, { cookie: agent, method: 'PATCH', body: {}, expected: 403 });

  const tpl = seedTemplate(db);
  const ids = seedContacts(db, 12, { prefix: 'off' });
  const list = seedList(db, ids);
  const before = db.prepare('SELECT count(*) n FROM conversations').get().n;
  const draft = (
    await api('/api/broadcasts', {
      expected: 201,
      body: {
        brandId: BRAND,
        waTemplateId: tpl,
        segment: { audienceId: list },
        content: { context: { courseId: COURSE } },
        clientRef: 'dif-' + randomUUID(),
      },
    })
  ).campaign;
  await api('/api/broadcasts/' + draft.id, { cookie: agent, expected: 403 });
  // todo nace apagado: la marca, la automatización y WhatsApp real
  let { preview } = await api(`/api/broadcasts/${draft.id}/preview`, { body: {} });
  assert.deepEqual(
    preview.blockers.map(b => b.code),
    ['campaigns_off', 'automation_off', 'whatsapp_off', 'no_number'],
  );
  await api(`/api/broadcasts/${draft.id}/schedule`, {
    body: { expectedRevision: draft.revision, confirmAudience: preview.willSend, acceptCost: true },
    expected: 409,
  });
  const lab = { admin, origin: () => server.origin };
  await setup(lab);
  ({ preview } = await api(`/api/broadcasts/${draft.id}/preview`, { body: {} }));
  assert.deepEqual(
    preview.blockers.map(b => b.code),
    ['whatsapp_off', 'no_number'],
    'sin WhatsApp real no se programa un envío real',
  );
  // modo ensayo: recorre todo sin enviar nada
  const rehearsal = (
    await api('/api/broadcasts/' + draft.id, {
      method: 'PATCH',
      body: { expectedRevision: draft.revision, options: { mode: 'rehearsal', ratePerMinute: 600 } },
    })
  ).campaign;
  const out = await launchNow(api, rehearsal);
  assert.deepEqual(out.preview.blockers, []);
  assert.equal(out.preview.rehearsal, true);
  await until(() => stateOf(db, draft.id).status === 'completed', 'el ensayo termina', { ms: 15000 });
  await until(
    () => (counts(db, draft.id).delivered ?? 0) + (counts(db, draft.id).read ?? 0) === 12,
    'entregas simuladas',
    {
      ms: 10000,
    },
  );
  const refs = db.prepare('SELECT provider_ref FROM campaign_recipients WHERE campaign_id=?').all(draft.id);
  assert.ok(refs.every(r => r.provider_ref.startsWith('sim_')));
  assert.equal(db.prepare('SELECT count(*) n FROM wa_message_costs WHERE campaign_id=?').get(draft.id).n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, before, 'el ensayo no crea conversaciones');
  const events = (await api(`/api/broadcasts/${draft.id}/events`)).events.map(e => e.kind);
  assert.deepEqual(events.slice(0, 1), ['completed']);
  assert.ok(events.includes('launched') && events.includes('scheduled'));
});
