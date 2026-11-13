import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/database.mjs';
import { migrateCRM } from '../server/crm.mjs';
import { migrateFollowup } from '../server/followup.mjs';
import { migrateCatalogue } from '../server/catalogue-schema.mjs';
import { migrateOperations } from '../server/operations-schema.mjs';
import { migrateAutomation, migrateRecipes } from '../server/automation-schema.mjs';
import { migrateContacts, migrateConsent } from '../server/contacts-schema.mjs';
import { createAutomation } from '../server/automation.mjs';
import { createRecipes } from '../server/recipes.mjs';
import { createContacts } from '../server/contacts.mjs';

const MIN = 60_000,
  HOUR = 3_600_000,
  quiet = { error() {} };

test('detección de baja: frases claras y cortas, sin falsos positivos en textos largos', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-optout-')),
    db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { isOptOutText: is } = createContacts({ db, crm: {}, body() {}, json() {}, audit() {}, broadcast() {} });
  for (const yes of [
    'BAJA',
    'baja.',
    'STOP',
    'Stop!',
    'unsubscribe',
    'No más mensajes',
    'quiero darme de baja',
    'Dame de baja por favor',
    'no quiero recibir más mensajes',
    'No quiero recibir promociones',
    'deja de escribirme',
    'dejen de mandarme mensajes',
    'no me escriban más',
    'No me contacten',
  ])
    assert.equal(is(yes), true, yes);
  for (const no of [
    '¿Cuánto cuesta la baja de un curso?',
    'quiero dar de baja mi curso',
    'hola',
    'precio',
    'cancelar',
    'no me ha llegado el flyer',
    'Gracias, no quiero el curso de aves pero sí el de nutrición',
    'x'.repeat(130) + ' darme de baja',
    '',
    null,
    undefined,
  ])
    assert.equal(is(no), false, String(no));
});

test('recetas: baja y consentimiento bloquean el envío; tope de frecuencia; la baja cancela pasos pendientes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-consent-r-')),
    db = openDatabase(dir);
  for (const m of [
    migrateCRM,
    migrateFollowup,
    migrateCatalogue,
    migrateOperations,
    migrateAutomation,
    migrateRecipes,
    migrateContacts,
    migrateConsent,
  ])
    m(db);
  t.after(async () => {
    try {
      db.close();
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  const c = { t: Date.now(), now: () => c.t },
    t0 = c.t;
  for (const [id, role, n] of [
    ['u1', 'customer', 1],
    ['adm', 'admin', 2],
  ])
    db.prepare(
      'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
    ).run(id, id, 'P ' + id, 'x', role, n, t0, t0);
  const course = db.prepare('SELECT id,brand_id FROM courses ORDER BY id LIMIT 1').get(),
    brand = course.brand_id;
  const conversation = id => {
    db.prepare(
      "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES(?,?,?,?,'whatsapp',?,?)",
    ).run(id, 'u1', brand, course.id, t0, t0);
    db.prepare('INSERT INTO contacts(id,brand_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(
      'ct-' + id,
      brand,
      'C ' + id,
      t0,
      t0,
    );
    db.prepare(
      'INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    ).run('op-' + id, 'ct-' + id, brand, course.id, 'interesado', t0, t0);
    db.prepare('INSERT INTO conversation_opportunities VALUES(?,?)').run(id, 'op-' + id);
  };
  const msg = (id, kind, at = c.t, ref = randomUUID()) => {
    const m = randomUUID();
    db.prepare(
      'INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at) VALUES(?,?,?,?,?,?)',
    ).run(m, id, kind, 'x', ref, at);
    return m;
  };
  const catalogue = {
    prepare() {
      return { text: 'Seguimiento', flyerSnapshot: null };
    },
  };
  const automation = createAutomation({ db, now: c.now, log: quiet, baseDelayMs: 1000 }),
    insertMessage = (conv, u, text, kind, ref) => msg(conv.id, kind, c.t, ref);
  const recipes = createRecipes({
    db,
    catalogue,
    automation,
    insertMessage,
    broadcast() {},
    body() {},
    json() {},
    audit() {},
    now: c.now,
  });
  const contacts = createContacts({
    db,
    crm: { requireBrand() {}, brandsFor: () => [{ id: brand }] },
    body() {},
    json() {},
    audit() {},
    broadcast() {},
    now: c.now,
  });
  const template = db
    .prepare("SELECT id FROM content_templates WHERE brand_id=? AND status='approved' LIMIT 1")
    .get(brand).id;
  const def = (extra = {}) => ({
    trigger: { type: 'silence', minutes: 30 },
    conditions: extra,
    actions: [
      { type: 'template', templateId: template },
      { type: 'task', title: 'Llamar', delayMinutes: 60 },
    ],
  });
  const publish = d => {
    const r = recipes.create({ brandId: brand, title: 'R', definition: d }, { id: 'adm' });
    return recipes.publish(r.id, { expectedRevision: r.revision }, { id: 'adm' });
  };
  const conv = id => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  const why = (recipe, id) => recipes.simulate(recipes.get(recipe.id), null, conv(id));
  conversation('a');
  msg('a', 'agent', c.t - HOUR);
  const recipe = publish(def());
  assert.equal(why(recipe, 'a').matches, true);
  db.prepare(
    "INSERT INTO contact_consent(contact_id,brand_id,status,source,updated_at) VALUES('ct-a',?,'opted_out','staff',?)",
  ).run(brand, c.t);
  let s = why(recipe, 'a');
  assert.equal(s.matches, false);
  assert.equal(s.reason, 'contact_opted_out');
  db.prepare("UPDATE contact_consent SET status='unknown' WHERE contact_id='ct-a'").run();
  assert.equal(why(recipe, 'a').matches, true);
  const strict = publish(def({ requireConsent: true }));
  s = why(strict, 'a');
  assert.equal(s.matches, false);
  assert.equal(s.reason, 'no_consent');
  db.prepare("UPDATE contact_consent SET status='opted_in' WHERE contact_id='ct-a'").run();
  assert.equal(why(strict, 'a').matches, true);
  db.prepare("UPDATE contact_consent SET status='unknown' WHERE contact_id='ct-a'").run();
  // tope de frecuencia: dos mensajes de receta en 24 h
  msg('a', 'automation', c.t - 2 * HOUR, 'recipe:uno');
  msg('a', 'automation', c.t - 3 * HOUR, 'recipe:dos');
  s = why(recipe, 'a');
  assert.equal(s.matches, false);
  assert.equal(s.reason, 'frequency_limit');
  db.prepare("UPDATE messages SET created_at=? WHERE client_ref='recipe:dos'").run(c.t - 30 * HOUR);
  assert.equal(why(recipe, 'a').matches, true);
  // una baja registrada cancela los pasos pendientes de las recetas
  conversation('b');
  automation.setBrand(brand, true, 0, 'adm');
  c.t += 1000;
  msg('b', 'agent', c.t);
  c.t += 6000;
  const made = recipes.scan();
  assert.ok(made.length >= 1);
  const step = automation.get(made[0]);
  assert.equal(step.state, 'pending');
  contacts.setConsent({ id: 'adm' }, 'ct-b', { status: 'opted_out', note: 'Pidió la baja por teléfono' });
  assert.equal(automation.get(step.id).state, 'cancelled');
  assert.equal(automation.get(step.id).cancel_reason, 'contact_opted_out');
  c.t += 40 * MIN;
  await automation.tick();
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE client_ref LIKE 'recipe:'||?||'%'").get(step.id).n, 0);
});

test('consentimiento por API: permisos, reactivación sólo por administración, baja del cliente, fusión y exportación', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-consent-')),
    code = randomUUID(),
    password = 'Password-consent-2026!';
  let logs = '';
  const server = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dir,
      ADMIN_INVITE_CODE: code,
      APP_ORIGIN: '',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(logs)), 10000);
    server.stderr.on('data', b => (logs += b));
    server.stdout.on('data', b => {
      const m = String(b).match(/http:\/\/127.0.0.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(Error(logs));
    });
  });
  t.after(async () => {
    if (server.exitCode === null)
      await new Promise(r => {
        server.once('exit', r);
        server.kill();
      });
    await rm(dir, { recursive: true, force: true });
  });
  async function raw(path, cookie = '', body, method = body === undefined ? 'GET' : 'POST') {
    return fetch(origin + path, {
      method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function call(path, cookie = '', body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const r = await raw(path, cookie, body, method);
    const result = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(result));
    return { ...result, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const reg = (username, inviteCode) =>
    call('/api/auth/register', '', { username, name: 'Prueba ' + username, password, inviteCode });
  const admin = await reg('admin', code),
    a = await reg('asesor.a'),
    b = await reg('asesor.b'),
    client = await reg('cliente');
  for (const [u, name, brandIds] of [
    [a, 'asesor.a', ['globalvet']],
    [b, 'asesor.b', ['odonteck']],
  ]) {
    const inv = await call('/api/team/invites', admin.cookie, { username: name, brandIds }, 'POST', 201);
    await call('/api/team/accept', u.cookie, { token: inv.token });
  }
  const contact = async (name, phone = '') =>
    (await call('/api/crm/contacts', admin.cookie, { brandId: 'globalvet', name, phone }, 'POST', 201)).id;
  const consent = (id, cookie = a.cookie) => call('/api/crm/contacts/' + id + '/consent', cookie);

  const c1 = await contact('Con Consentimiento');
  assert.equal((await consent(c1)).consent.status, 'unknown');
  await call('/api/crm/contacts/' + c1 + '/consent', client.cookie, { status: 'opted_in' }, 'PUT', 403);
  await call('/api/crm/contacts/' + c1 + '/consent', b.cookie, { status: 'opted_in' }, 'PUT', 404);
  await consent(c1, b.cookie).catch(() => {});
  await call('/api/crm/contacts/' + c1 + '/consent', a.cookie, { status: 'quizá' }, 'PUT', 400);
  assert.equal(
    (
      await call(
        '/api/crm/contacts/' + c1 + '/consent',
        a.cookie,
        { status: 'opted_in', note: 'Aceptó por llamada' },
        'PUT',
      )
    ).consent.status,
    'opted_in',
  );
  await call('/api/crm/contacts/' + c1 + '/consent', a.cookie, { status: 'opted_out', note: 'Pidió la baja' }, 'PUT');
  await call(
    '/api/crm/contacts/' + c1 + '/consent',
    a.cookie,
    { status: 'opted_in', note: 'Quiere volver' },
    'PUT',
    403,
  ); // una baja no la revierte un asesor
  await call('/api/crm/contacts/' + c1 + '/consent', admin.cookie, { status: 'opted_in', note: 'ok' }, 'PUT', 400); // administración debe explicar el motivo
  assert.equal(
    (
      await call(
        '/api/crm/contacts/' + c1 + '/consent',
        admin.cookie,
        { status: 'opted_in', note: 'El cliente escribió para volver' },
        'PUT',
      )
    ).consent.status,
    'opted_in',
  );
  const hist = (await consent(c1)).history;
  assert.deepEqual(
    hist.map(h => h.status),
    ['opted_in', 'opted_out', 'opted_in'],
  );
  assert.ok(hist.every(h => h.source === 'staff' && h.actor_name));

  // el cliente pide la baja por mensaje: se registra y se confirma una sola vez
  const conv = (await call('/api/conversations', client.cookie, { courseId: 'aves', channel: 'whatsapp' }))
    .conversation;
  const link = (await call('/api/crm', admin.cookie)).contacts.find(
    c => c.source_user_id && c.brand_id === 'globalvet',
  );
  assert.equal((await consent(link.id)).consent.status, 'unknown');
  await call(
    '/api/conversations/' + conv.id + '/messages',
    client.cookie,
    { text: '¿Cuánto cuesta la baja de un curso?', clientRef: randomUUID() },
    'POST',
    201,
  );
  assert.equal((await consent(link.id)).consent.status, 'unknown');
  await call(
    '/api/conversations/' + conv.id + '/messages',
    client.cookie,
    { text: 'BAJA', clientRef: randomUUID() },
    'POST',
    201,
  );
  const after = await consent(link.id);
  assert.equal(after.consent.status, 'opted_out');
  assert.equal(after.consent.source, 'customer_message');
  assert.match(after.consent.note, /BAJA/);
  assert.equal(after.history.length, 1);
  let said = false;
  for (let i = 0; i < 20 && !said; i++) {
    await new Promise(r => setTimeout(r, 250));
    said = (await call('/api/conversations/' + conv.id + '/messages', client.cookie)).messages.some(
      m => m.sender_kind === 'automation' && /no volveremos a enviarte/.test(m.text),
    );
  }
  assert.ok(said, 'el sistema confirma la baja');
  await call(
    '/api/conversations/' + conv.id + '/messages',
    client.cookie,
    { text: 'stop', clientRef: randomUUID() },
    'POST',
    201,
  );
  assert.equal((await consent(link.id)).history.length, 1); // no duplica el registro

  // fusión: la ficha principal hereda la baja
  const dup = await contact('Duplicado Con Baja');
  await call(
    '/api/crm/contacts/' + dup + '/consent',
    a.cookie,
    { status: 'opted_out', note: 'Baja registrada' },
    'PUT',
  );
  const keep = await contact('Principal Sin Registro');
  const plan = (await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: keep, mergeId: dup }, 'POST'))
    .plan;
  await call(
    '/api/crm/contacts/merge',
    admin.cookie,
    { keepId: keep, mergeId: dup, previewToken: plan.previewToken },
    'POST',
  );
  const merged = await consent(keep);
  assert.equal(merged.consent.status, 'opted_out');
  assert.ok(merged.history.some(h => h.source === 'merge') && merged.history.some(h => h.note === 'Baja registrada'));
  await call('/api/crm/contacts/' + dup + '/consent', a.cookie, undefined, 'GET', 404);

  // exportación
  const csv = await (await raw('/api/crm/export/contacts.csv?brand=globalvet', admin.cookie)).text();
  assert.match(csv.split('\r\n')[0], /,consentimiento,persona$/);
  assert.ok(
    csv.split('\r\n').some(l => l.startsWith('GlobalVet,Principal Sin Registro') && /,no_desea,[a-f0-9-]{36}$/.test(l)),
  );
  assert.ok(
    csv.split('\r\n').some(l => l.startsWith('GlobalVet,Con Consentimiento') && /,acepta,[a-f0-9-]{36}$/.test(l)),
  );
  const d = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  try {
    assert.equal(d.prepare('SELECT count(*) n FROM contact_consent WHERE contact_id=?').get(dup).n, 0);
  } finally {
    d.close();
  }
});
