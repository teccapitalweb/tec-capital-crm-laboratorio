// Envío de plantillas por la API v1 y capa de compatibilidad (docs/PLAN_API_ENVIO.md; incremento I-8). Servidor real
// y Meta de mentira. Todo es inventado: nombres, teléfonos (5555501xxx) y llaves (las crea cada prueba y se descartan
// con su base temporal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { call, openDb, until, whatsappLab } from './helpers/crm.mjs';
import { NUMBER, metaStatus } from './helpers/fake-meta.mjs';
import { startServer } from './helpers/server.mjs';

const BRAND = 'globalvet';
const DAY = 86_400_000;
const FAST = {
  WA_BROADCAST_RATE_SCALE: '50',
  WA_BROADCAST_MAX_PER_SECOND: '1000',
  WA_BROADCAST_LEASE_MS: '4000',
  WA_BROADCAST_RECONCILE_MS: '5000',
};
const REMINDER = 'Hola {{1}}, tu clase es el {{2}} a las {{3}}.';
const remove = dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

// ---- datos inventados
function seedTemplate(db, { brand = BRAND, name, category = 'utility', vars, body = REMINDER, status = 'approved' }) {
  const id = randomUUID();
  const components = {
    type: 'standard',
    header: { type: 'none' },
    body: { text: body, vars: vars.map(key => ({ key, sample: 'Muestra', fallback: null })) },
    footer: { text: '' },
    buttons: [],
  };
  db.prepare(
    "INSERT INTO wa_templates(id,brand_id,waba_id,name,language,category,body,variables,components,status,revision,created_at,updated_at) VALUES(?,?,'',?,'es_MX',?,?,?,?,?,1,1,1)",
  ).run(id, brand, name, category, body, JSON.stringify(vars), JSON.stringify(components), status);
  return id;
}
function seedContact(db, phoneKey, { name = 'Persona de Ejemplo', consent = null } = {}) {
  const id = randomUUID();
  const t = Date.now();
  db.prepare(
    "INSERT INTO contacts(id,brand_id,name,phone,phone_key,source,created_at,updated_at) VALUES(?,?,?,?,?,'import',?,?)",
  ).run(id, BRAND, name, '+' + phoneKey, phoneKey, t, t);
  if (consent)
    db.prepare(
      "INSERT INTO contact_consent(contact_id,brand_id,status,source,updated_at) VALUES(?,?,?,'prueba',?)",
    ).run(id, BRAND, consent, t);
  return id;
}
function seedSuppression(db, contactId) {
  const id = randomUUID();
  const t = Date.now();
  db.prepare(
    "INSERT INTO audiences(id,brand_id,kind,role,name,name_key,definition,member_count,created_at,updated_at) VALUES(?,?,'list','suppression','No escribir','no escribir','{}',1,?,?)",
  ).run(id, BRAND, t, t);
  db.prepare("INSERT INTO audience_members(audience_id,contact_id,source,added_at) VALUES(?,?,'manual',?)").run(
    id,
    contactId,
    t,
  );
}
function setMetaLimit(db, tier, value) {
  const t = Date.now();
  db.prepare(
    "INSERT INTO wa_account(waba_id,created_at,updated_at) VALUES('local',?,?) ON CONFLICT(waba_id) DO NOTHING",
  ).run(t, t);
  db.prepare('UPDATE wa_account SET messaging_limit=?,limit_value=?,limit_source=?').run(tier, value, 'meta');
}

// Difusiones y automatización de la marca encendidas (lo que administración haría en pantalla).
async function switchOn(origin, cookie) {
  const api = (path, { body, method } = {}) => call(origin, path, { cookie, body, method });
  const settings = await api('/api/campaigns/settings');
  const rev = (settings.settings || []).find?.(s => s.brand_id === BRAND)?.revision ?? 0;
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
    body: { quietStart: '00:00', quietEnd: '00:00', expectedRevision: s.revision },
  });
}

// Llamada con llave, sin sesión ni Origin, como un sistema externo.
function client(origin) {
  return async (method, path, token, { body, idem, expected } = {}) => {
    const headers = { ...(token ? { Authorization: 'Bearer ' + token } : {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idem) headers['Idempotency-Key'] = idem;
    const response = await fetch(origin + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (expected !== undefined) assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 400)}`);
    return { status: response.status, headers: response.headers, body: data };
  };
}
function assertError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.code, code, JSON.stringify(res.body));
  assert.match(res.body.requestId, /^req_[a-f0-9]{24}$/);
}

test('migración api/0002: una base que ya existía queda igual que una nueva, con el índice de envíos', async t => {
  const oldDir = await mkdtemp(join(tmpdir(), 'crm-api-send-old-'));
  const freshDir = await mkdtemp(join(tmpdir(), 'crm-api-send-new-'));
  const old = openDatabase(oldDir);
  const fresh = openDatabase(freshDir);
  t.after(async () => {
    old.close();
    fresh.close();
    await remove(oldDir);
    await remove(freshDir);
  });
  migrate(old, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== 'api/0002-send-lookup')) });
  old
    .prepare(
      "INSERT INTO api_keys(id,brand_id,name,prefix,key_hash,scopes,created_at) VALUES('k1','globalvet','Panel','tcw_abcdef','00','[\"contacts\"]',1)",
    )
    .run();
  old
    .prepare(
      "INSERT INTO api_requests(id,key_id,brand_id,method,route,status,created_at) VALUES('r1','k1','globalvet','POST','/api/v1/contacts',200,1)",
    )
    .run();
  migrate(old, { backup: false });
  assertSchemaCurrent(old);
  migrate(old, { backup: false });
  migrate(fresh, { backup: false });
  assert.deepEqual(schemaShape(old), schemaShape(fresh));
  assert.ok(old.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='api_requests_entity'").get());
  assert.equal(old.prepare('SELECT count(*) n FROM api_requests').get().n, 1);
  assert.equal(old.prepare("SELECT daily_send_limit FROM api_keys WHERE id='k1'").get().daily_send_limit, null);
});

test('envío por API de punta a punta: reglas, idempotencia, topes, estado, eventos, compatibilidad y sin rastros', async t => {
  const lab = await whatsappLab(t, { ...FAST, API_COMPAT: '1' });
  const db = lab.db;
  const origin = lab.origin();
  const api = client(origin);
  const admin = lab.admin;
  const mkKey = (scopes, over = {}, expected = 201) =>
    call(origin, '/api/integrations/keys', {
      cookie: admin,
      body: { brandId: BRAND, name: 'Recordatorios ' + scopes.join('+'), scopes, ...over },
      expected,
    });
  seedTemplate(db, { name: 'recordatorio_clase', vars: ['nombre', 'llamada.fecha', 'llamada.hora'] });
  seedTemplate(db, { name: 'promo_curso', category: 'marketing', vars: ['nombre'], body: 'Hola {{1}}, hay curso.' });
  seedTemplate(db, { name: 'en_revision', vars: [], body: 'Aviso.', status: 'pending' });
  const foreign = seedTemplate(db, { brand: 'odonteck', name: 'aviso_otra_marca', vars: [], body: 'Otra marca.' });
  setMetaLimit(db, 'TIER_10K', null);

  // ---- llaves: el permiso se da con caducidad, tope diario por omisión y número por omisión de la marca
  const send = await mkKey(['messages_send_template']);
  assert.equal(send.key.kind, 'write');
  assert.equal(send.key.expiresAt - send.key.createdAt, 180 * DAY);
  assert.equal(send.key.dailySendLimit, 1000);
  assert.equal(send.key.defaultNumberId, null);
  const full = await mkKey(['messages_send_template', 'contacts'], { defaultNumberId: NUMBER });
  assert.equal(full.key.defaultNumberId, NUMBER);
  const capped = await mkKey(['messages_send_template'], { dailySendLimit: 2 });
  const compat = await mkKey(['messages_send_template', 'compat']);
  const templatesOnly = await mkKey(['templates']);
  const other = await mkKey(['messages_send_template'], { brandId: 'odonteck' });
  await mkKey(['contacts'], { dailySendLimit: 5 }, 400); // el tope es de las llaves que envían
  await mkKey(['messages_send_template'], { defaultNumberId: '999999' }, 400); // número que no es de la marca
  await mkKey(['messages_send_template'], { dailySendLimit: 0 }, 400);
  const patched = await call(origin, '/api/integrations/keys/' + capped.key.id, {
    cookie: admin,
    method: 'PATCH',
    body: { dailySendLimit: 2, defaultNumberId: NUMBER },
  });
  assert.deepEqual([patched.key.dailySendLimit, patched.key.defaultNumberId], [2, NUMBER]);

  const body = (phone, values = { nombre: 'Ana', fecha: '20 de noviembre', hora: '19:00' }, extra = {}) => ({
    to: { phone },
    template: { name: 'recordatorio_clase', language: 'es_MX' },
    parameters: values,
    label: 'recordatorio-sesion-3',
    ...extra,
  });
  const post = (token, payload, idem, expected) =>
    api('POST', '/api/v1/messages/template', token, { body: payload, idem, expected });

  // ---- apagado: difusiones de la marca sin encender → 409 broadcasts_off, sin contacto nuevo
  const before = db.prepare('SELECT count(*) n FROM contacts').get().n;
  assertError(await post(send.token, body('+52 55 5550 1001'), 'apagado-0000001'), 409, 'broadcasts_off');
  assert.equal(db.prepare('SELECT count(*) n FROM contacts').get().n, before, 'el rechazo no deja contacto');
  await switchOn(origin, admin);

  // ---- permisos y llaves
  assertError(await post(templatesOnly.token, body('+52 55 5550 1001'), 'permiso-000001'), 403, 'scope_missing');
  assertError(await post(other.token, body('+52 55 5550 1001'), 'otra-marca-001'), 404, 'not_found');
  assertError(
    await post(send.token, { ...body('+52 55 5550 1001'), template: { id: foreign } }, 'otra-marca-002'),
    404,
    'not_found',
  );
  const expiring = await mkKey(['messages_send_template']);
  db.prepare('UPDATE api_keys SET expires_at=? WHERE id=?').run(Date.now() - 1000, expiring.key.id);
  assertError(await post(expiring.token, body('+52 55 5550 1001'), 'caducada-00001'), 401, 'key_expired');
  assertError(await post(send.token, body('+52 55 5550 1001')), 400, 'idempotency_key_required');

  // ---- plantilla y valores
  assertError(
    await post(send.token, { ...body('+52 55 5550 1001'), template: { name: 'en_revision' } }, 'revision-00001'),
    422,
    'template_not_approved',
  );
  const missing = await post(send.token, body('+52 55 5550 1001', { nombre: 'Ana', fecha: 'lunes' }), 'faltan-000001');
  assertError(missing, 422, 'template_params');
  assert.deepEqual(missing.body.details.missing, ['hora']);
  const noName = await post(send.token, body('+52 55 5550 1001', { fecha: 'lunes', hora: '19:00' }), 'sin-nombre-01');
  assertError(noName, 422, 'template_params');
  assert.deepEqual(noName.body.details.missing, ['nombre']);
  assertError(await post(send.token, body('12'), 'telefono-mal1'), 422, 'phone_invalid');
  assertError(
    await post(send.token, { ...body('+52 55 5550 1001'), extra: 1 }, 'campo-extra01'),
    400,
    'invalid_request',
  );

  // ---- envío correcto: 202, sale por Meta con los valores en su lugar, sin conversación ni interés
  const conversations = db.prepare('SELECT count(*) n FROM conversations').get().n;
  const ok = await post(send.token, body('+52 55 5550 1001'), 'recordatorio-ana-sesion-3', 202);
  const sendId = ok.body.send.id;
  assert.match(sendId, /^[0-9a-f]{32}$/);
  assert.equal(ok.body.send.status, 'queued');
  assert.equal(ok.body.contact, undefined, 'sin el permiso contacts no se dice nada del contacto');
  const out = await until(
    () => lab.meta.sent.find(m => m.type === 'template' && m.template?.name === 'recordatorio_clase'),
    'el recordatorio sale por Meta',
    { ms: 15000 },
  );
  assert.deepEqual(
    out.template.components.find(c => c.type === 'body').parameters.map(p => p.text),
    ['Ana', '20 de noviembre', '19:00'],
  );
  const status = id => api('GET', '/api/v1/messages/template/' + id, send.token, { expected: 200 });
  await until(async () => (await status(sendId)).body.status === 'sent', 'el estado dice enviado');
  const row = db.prepare('SELECT * FROM campaign_recipients WHERE id=?').get(sendId);
  await metaStatus(origin, row.provider_ref, 'delivered');
  await until(async () => (await status(sendId)).body.status === 'delivered', 'el estado dice entregado');
  await metaStatus(origin, row.provider_ref, 'read');
  const read = await until(async () => {
    const s = await status(sendId);
    return s.body.status === 'read' && s.body;
  }, 'el estado dice leído');
  assert.ok(read.deliveredAt && read.readAt && read.sentAt);
  assert.equal(read.contactId, undefined);
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, conversations, 'no se abre conversación');
  // otra llave (aunque sea de la marca) no ve ese envío
  assertError(await api('GET', '/api/v1/messages/template/' + sendId, full.token), 404, 'not_found');
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(row.campaign_id);
  assert.equal(JSON.parse(campaign.options).origin, 'api');
  assert.equal(
    db.prepare("SELECT source FROM contacts WHERE brand_id=? AND phone_key='525555501001'").get(BRAND).source,
    'api',
  );

  // ---- idempotencia: misma clave, mismo envío y un solo mensaje; otra petición con la misma clave, 409
  const replay = await post(send.token, body('+52 55 5550 1001'), 'recordatorio-ana-sesion-3', 202);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(replay.body.send.id, sendId);
  assertError(
    await post(send.token, body('+52 55 5550 1002'), 'recordatorio-ana-sesion-3'),
    409,
    'idempotency_key_reused',
  );
  const twice = await Promise.all([
    post(send.token, body('+52 55 5550 1003', { nombre: 'Eva', fecha: 'martes', hora: '18:00' }), 'a-la-vez-00001'),
    post(send.token, body('+52 55 5550 1003', { nombre: 'Eva', fecha: 'martes', hora: '18:00' }), 'a-la-vez-00001'),
  ]);
  assert.deepEqual(
    twice.map(r => r.status),
    [202, 202],
  );
  assert.equal(twice[0].body.send.id, twice[1].body.send.id);
  // la misma persona, misma plantilla y etiqueta el mismo día, con otra clave: el motor no lo repite
  assertError(await post(send.token, body('+52 55 5550 1001'), 'recordatorio-otra-clave'), 409, 'already_sent_today');
  await until(
    () => lab.meta.sent.filter(m => m.type === 'template' && m.to === '525555501003').length === 1,
    'Eva recibe un solo mensaje',
    { ms: 15000 },
  );
  assert.equal(lab.meta.sent.filter(m => m.type === 'template' && m.to === '525555501001').length, 1);

  // ---- baja, lista de exclusión y consentimiento: lo mismo para baja y exclusión
  seedContact(db, '525555501010', { consent: 'opted_out' });
  const excluded = seedContact(db, '525555501011');
  seedSuppression(db, excluded);
  const optedOut = await post(send.token, body('+52 55 5550 1010'), 'baja-000000001');
  const suppressed = await post(send.token, body('+52 55 5550 1011'), 'exclusion-0001');
  assertError(optedOut, 422, 'recipient_unavailable');
  assertError(suppressed, 422, 'recipient_unavailable');
  assert.equal(optedOut.body.error, suppressed.body.error);
  const promo = (phone, idem) =>
    post(send.token, { to: { phone }, template: { name: 'promo_curso' }, parameters: { nombre: 'Leo' } }, idem);
  assertError(await promo('+52 55 5550 1012', 'promo-nueva-01'), 422, 'consent_required');
  seedContact(db, '525555501013', { consent: 'opted_in' });
  const firstPromo = await promo('+52 55 5550 1013', 'promo-acepto-1');
  assert.equal(firstPromo.status, 202);
  await until(async () => (await status(firstPromo.body.send.id)).body.status === 'sent', 'la promoción sale', {
    ms: 15000,
  });
  // otra promoción a la misma persona dentro de la separación mínima: el motor la omite y, a quien sólo envía, el
  // estado no le dice por qué (recibió otra difusión): sólo que no se le pudo enviar
  const secondPromo = await post(
    send.token,
    {
      to: { phone: '+52 55 5550 1013' },
      template: { name: 'promo_curso' },
      parameters: { nombre: 'Leo' },
      label: 'otra',
    },
    'promo-acepto-2',
    202,
  );
  const skipped = await until(async () => {
    const s = await status(secondPromo.body.send.id);
    return s.body.status === 'skipped' && s.body;
  }, 'la segunda promoción se omite');
  assert.equal(skipped.reason, 'not_allowed');

  // ---- sin revelar existencia: un teléfono que ya era contacto y uno nuevo responden igual a quien sólo envía
  seedContact(db, '525555501020', { name: 'Ya Existía', consent: 'opted_in' });
  const known = await post(
    send.token,
    body('+52 55 5550 1020', { nombre: 'X', fecha: 'f', hora: 'h' }),
    'existia-00001',
  );
  const fresh = await post(
    send.token,
    body('+52 55 5550 1021', { nombre: 'X', fecha: 'f', hora: 'h' }),
    'nuevo-0000001',
  );
  assert.deepEqual([known.status, fresh.status], [202, 202]);
  assert.deepEqual(Object.keys(known.body).sort(), Object.keys(fresh.body).sort());
  assert.deepEqual(Object.keys(known.body.send).sort(), Object.keys(fresh.body.send).sort());
  // con el permiso contacts sí se dice el contacto y si se creó
  const withContacts = await post(full.token, body('+52 55 5550 1022'), 'con-contacts-1', 202);
  assert.equal(withContacts.body.contact.created, true);
  assert.match(withContacts.body.contact.id, /^[a-f0-9-]{36}$/);

  // ---- tope diario de la llave (cuenta en api_requests y sobrevive a un reinicio) y límite de la cuenta
  const v = n => ({ nombre: 'P' + n, fecha: 'f', hora: 'h' });
  await post(capped.token, body('+52 55 5550 1031', v(1)), 'tope-0000000001', 202);
  await post(capped.token, body('+52 55 5550 1032', v(2)), 'tope-0000000002', 202);
  const over = await post(capped.token, body('+52 55 5550 1033', v(3)), 'tope-0000000003');
  assertError(over, 429, 'daily_send_limit');
  assert.ok(Number(over.headers.get('retry-after')) > 0);
  // la cuenta con un límite de 1 persona en 24 horas, ya alcanzado con los envíos de arriba
  setMetaLimit(db, 'TIER_250', 1);
  assertError(
    await post(send.token, body('+52 55 5550 1040', v(4)), 'limite-cuenta-1'),
    429,
    'messaging_limit_reached',
  );
  setMetaLimit(db, 'TIER_10K', null);

  // ---- capa de compatibilidad: la forma de llamada del proveedor anterior
  const legacyPath = phone => `/api/compat/400123/api/v1/sendTemplateMessage?whatsappNumber=${phone}`;
  const legacyBody = {
    template_name: 'recordatorio_clase',
    broadcast_name: 'Recordatorio sesión 4',
    parameters: [
      { name: 'nombre', value: 'Luis' },
      { name: 'fecha', value: '21 de noviembre' },
      { name: 'hora', value: '20:00' },
    ],
  };
  const noCompat = await api('POST', legacyPath('5215555501050'), send.token, { body: legacyBody });
  assert.equal(noCompat.status, 403);
  assert.deepEqual([noCompat.body.result, noCompat.body.code], [false, 'scope_missing']);
  const legacy = await api('POST', legacyPath('5215555501050'), compat.token, { body: legacyBody, expected: 200 });
  assert.equal(legacy.body.result, true);
  assert.match(legacy.body.id, /^[0-9a-f]{32}$/);
  const again = await api('POST', legacyPath('5215555501050'), compat.token, { body: legacyBody, expected: 200 });
  assert.equal(again.body.id, legacy.body.id, 'un reintento idéntico no duplica');
  const recipientRow = db.prepare('SELECT * FROM campaign_recipients WHERE id=?').get(legacy.body.id);
  assert.equal(
    db.prepare('SELECT title FROM campaigns WHERE id=?').get(recipientRow.campaign_id).title.split(' · ')[1],
    'Recordatorio-sesion-4',
  );
  const bulk = await api('POST', '/api/compat/api/ext/v3/messageTemplates/send', compat.token, {
    expected: 200,
    body: {
      template_name: 'recordatorio_clase',
      broadcast_name: 'sesion_5',
      recipients: [
        {
          phone_number: '5215555501051',
          local_message_id: 'local-1',
          custom_params: [
            { name: 'nombre', value: 'Rosa' },
            { name: 'fecha', value: 'jueves' },
            { name: 'hora', value: '17:00' },
          ],
        },
        {
          phone_number: '5215555501052',
          local_message_id: 'local-2',
          custom_params: [{ name: 'nombre', value: 'Iván' }],
        },
      ],
    },
  });
  assert.equal(bulk.body.success, true);
  assert.equal(bulk.body.broadcast_id, 'sesion_5');
  assert.deepEqual(
    bulk.body.recipients.map(r => [r.local_message_id, r.success, r.error?.code ?? null]),
    [
      ['local-1', true, null],
      ['local-2', false, 'template_params'],
    ],
  );
  assert.match(bulk.body.recipients[0].id, /^[0-9a-f]{32}$/);
  assert.equal((await api('GET', '/api/compat/api/ext/v3/contacts', compat.token)).status, 404);

  // ---- eventos: el envío deja su rastro con la llave, sin teléfono
  const accepted = db
    .prepare("SELECT * FROM domain_events WHERE type='envio_api.aceptado' AND entity_id=?")
    .get(sendId);
  assert.equal(JSON.parse(accepted.payload).apiKeyId, send.key.id);
  const states = db
    .prepare("SELECT payload FROM domain_events WHERE type='envio_api.estado' AND entity_id=? ORDER BY seq")
    .all(sendId)
    .map(e => JSON.parse(e.payload).state);
  assert.ok(states.includes('delivered') && states.includes('read'), JSON.stringify(states));
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action='api.message.template' AND entity_id=?").get(sendId));
  const logged = db
    .prepare("SELECT * FROM api_requests WHERE route='/api/v1/messages/template' AND entity_id=?")
    .get(sendId);
  assert.deepEqual([logged.key_id, logged.entity_kind, logged.status], [send.key.id, 'send', 202]);

  // ---- ni la llave ni el teléfono quedan en registros, eventos, auditoría o el registro de la API
  const dump = table =>
    db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map(r => JSON.stringify(r))
      .join('\n');
  const traces = [dump('domain_events'), dump('audit'), dump('api_requests'), lab.state.server.logs()].join('\n');
  for (const token of [send.token, full.token, capped.token, compat.token]) assert.ok(!traces.includes(token));
  for (const digits of ['5555501001', '5555501050', '5555501020', '5555501021'])
    assert.ok(!traces.includes(digits), 'el teléfono no queda en los rastros: ' + digits);
});

test('sin WhatsApp real el envío responde whatsapp_off y la capa de compatibilidad apagada no existe', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-api-send-off-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code } });
  let db = null;
  t.after(async () => {
    db?.close();
    await server.stop();
    await remove(dir);
  });
  const admin = (
    await call(server.origin, '/api/auth/register', {
      body: { username: 'admin', name: 'Administración', password: 'Password-api-envio-2026!', inviteCode: code },
    })
  ).cookie;
  db = openDb(dir);
  assertSchemaCurrent(db);
  const t0 = Date.now();
  db.prepare(
    "INSERT INTO wa_numbers(phone_number_id,brand_id,course_id,label,created_at,updated_at) VALUES(?,?,'aves','Ventas',?,?)",
  ).run(NUMBER, BRAND, t0, t0);
  seedTemplate(db, { name: 'recordatorio_clase', vars: ['nombre', 'llamada.fecha', 'llamada.hora'] });
  await switchOn(server.origin, admin);
  const key = await call(server.origin, '/api/integrations/keys', {
    cookie: admin,
    body: { brandId: BRAND, name: 'Recordatorios', scopes: ['messages_send_template', 'compat'] },
    expected: 201,
  });
  const api = client(server.origin);
  const res = await api('POST', '/api/v1/messages/template', key.token, {
    idem: 'whatsapp-apagado-1',
    body: {
      to: { phone: '+52 55 5550 1060' },
      template: { name: 'recordatorio_clase' },
      parameters: { nombre: 'Ana', fecha: 'lunes', hora: '10:00' },
    },
  });
  assertError(res, 503, 'whatsapp_off');
  assert.equal(db.prepare("SELECT count(*) n FROM contacts WHERE phone_key='525555501060'").get().n, 0);
  const off = await api('POST', '/api/compat/api/ext/v3/messageTemplates/send', key.token, {
    body: { template_name: 'recordatorio_clase', recipients: [] },
  });
  assert.equal(off.status, 404);
});
