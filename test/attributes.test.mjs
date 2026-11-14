// Atributos de contacto (docs/PLAN_ATRIBUTOS_CONTACTO.md): migración, módulo con el servidor real y bibliotecas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../server/database.mjs';
import { migrate, NAMED } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { fail } from '../server/app/http.mjs';
import { createPersonData } from '../server/lib/person-data.mjs';
import { compile, defineFields, evaluate } from '../server/lib/conditions.mjs';
import { render, validate } from '../server/lib/variables.mjs';
import attributesModule from '../server/modules/attributes/module.mjs';
import { createRepo } from '../server/modules/attributes/repo.mjs';
import { canonical } from '../server/modules/attributes/model.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';

async function workspace(t, prefix = 'crm-attributes-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

test('migración attributes/0001: una base que ya existía queda igual que una nueva y conserva sus datos', async t => {
  const old = await workspace(t);
  migrate(old, { backup: false, registry: defineRegistry(NAMED.filter(m => !m.name.startsWith('attributes/'))) });
  old
    .prepare("INSERT INTO contacts(id,brand_id,name,created_at,updated_at) VALUES('c-antes','globalvet','Antes',1,1)")
    .run();
  assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name='contact_attributes'").get(), undefined);
  migrate(old, { backup: false });
  assertSchemaCurrent(old);
  migrate(old, { backup: false }); // una segunda pasada no hace nada
  assertSchemaCurrent(old);
  const fresh = await workspace(t);
  migrate(fresh, { backup: false });
  assert.deepEqual(schemaShape(old), schemaShape(fresh));
  assert.equal(old.prepare("SELECT name FROM contacts WHERE id='c-antes'").get().name, 'Antes');
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
});

test('tipos: forma canónica y valores no válidos', () => {
  const def = (type, options = []) => ({ key: 'x', label: 'Dato', type, options });
  assert.deepEqual(canonical(def('text'), '  Puebla '), { value: 'Puebla', valueNum: null });
  assert.equal(canonical(def('text'), '   '), null);
  assert.throws(() => canonical(def('text'), 'a'.repeat(501)), /500/);
  assert.deepEqual(canonical(def('number'), '12,5'), { value: '12.5', valueNum: 12.5 });
  assert.deepEqual(canonical(def('number'), 7), { value: '7', valueNum: 7 });
  assert.throws(
    () => canonical(def('number'), '12a'),
    error => error.code === 'attribute_invalid',
  );
  assert.deepEqual(canonical(def('date'), '2026-02-28'), { value: '2026-02-28', valueNum: Date.UTC(2026, 1, 28) });
  assert.throws(() => canonical(def('date'), '2026-02-30'), /AAAA-MM-DD/);
  assert.deepEqual(canonical(def('boolean'), 'Sí'), { value: 'true', valueNum: 1 });
  assert.deepEqual(canonical(def('boolean'), false), { value: 'false', valueNum: 0 });
  assert.throws(() => canonical(def('boolean'), 'quizá'), /sí o no/);
  const list = def('select', [{ value: 'premium', label: 'Premium' }]);
  assert.deepEqual(canonical(list, 'premium'), { value: 'premium', valueNum: null });
  assert.throws(() => canonical(list, 'Premium'), /opciones/);
});

// El módulo sobre una base temporal, con un `host` mínimo: lo justo para probar condiciones y variables.
async function moduleWorld(t) {
  const db = await workspace(t);
  migrate(db, { backup: false });
  const personData = createPersonData({ db });
  const published = [];
  const api = attributesModule.create({
    db,
    transaction,
    fail,
    personData,
    services: { events: { registerTypes() {}, publish: event => published.push(event) } },
    access: { require() {}, can: () => true, phone: (_user, value) => value, brandIds: () => [] },
    realtime: { emit() {} },
  });
  const repo = createRepo(db);
  const brand = 'globalvet';
  const define = (key, type, options = []) =>
    repo.insertDefinition(brand, {
      id: randomUUID(),
      key,
      label: key,
      type,
      options,
      description: '',
      personal: false,
      searchable: false,
      showInChat: true,
      position: 0,
      origin: 'custom',
      clientRef: null,
      createdBy: null,
      at: 1,
    });
  define('ciudad', 'text');
  define('edad', 'number');
  define('alta', 'date');
  define('vip', 'boolean');
  define('plan', 'select', [
    { value: 'basico', label: 'Básico' },
    { value: 'premium', label: 'Premium' },
  ]);
  const contact = (name, values) => {
    const id = randomUUID();
    db.prepare('INSERT INTO contacts(id,brand_id,name,email,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(
      id,
      brand,
      name,
      name.toLowerCase() + '@correo.test',
      Date.UTC(2026, 0, 1),
      1,
    );
    const changes = Object.entries(values).map(([key, value]) => ({ key, value }));
    if (changes.length) transaction(db, () => api.set(brand, id, changes, { source: 'import' }));
    return id;
  };
  const ids = {
    ana: contact('Ana', { ciudad: 'Puebla', edad: 30, alta: '2026-03-01', vip: true, plan: 'premium' }),
    beto: contact('Beto', { ciudad: 'Ciudad de México', edad: 17, plan: 'basico' }),
    caro: contact('Caro', { ciudad: 'puébla', vip: false, alta: '2025-12-31' }),
    dani: contact('Dani', {}),
  };
  // Otra marca con un atributo del mismo nombre: nunca entra en las consultas de globalvet.
  repo.insertDefinition('odonteck', {
    id: randomUUID(),
    key: 'ciudad',
    label: 'Ciudad',
    type: 'text',
    options: [],
    description: '',
    personal: false,
    searchable: false,
    showInChat: true,
    position: 0,
    origin: 'custom',
    clientRef: null,
    createdBy: null,
    at: 1,
  });
  return { db, api, brand, ids, published };
}

test('condiciones: un atributo da el mismo resultado en memoria y en SQL', async t => {
  const { db, api, brand, ids } = await moduleWorld(t);
  const fields = defineFields(api.conditionFields(brand));
  const now = Date.UTC(2026, 3, 1);
  const rule = (key, op, value) => ({
    version: 1,
    match: 'all',
    groups: [{ match: 'all', rules: [{ field: 'attr', key, op, ...(value === undefined ? {} : { value }) }] }],
  });
  const cases = [
    [rule('ciudad', 'eq', 'Puebla'), ['ana', 'caro']],
    [rule('ciudad', 'contains', 'mexico'), ['beto']],
    [rule('ciudad', 'empty'), ['dani']],
    [rule('ciudad', 'neq', 'puebla'), ['beto', 'dani']],
    [rule('edad', 'gte', 18), ['ana']],
    [rule('edad', 'empty'), ['caro', 'dani']],
    [rule('alta', 'after', '2026-01-01'), ['ana']],
    [rule('alta', 'in_last_days', 60), ['ana']],
    [rule('vip', 'is', true), ['ana']],
    [rule('vip', 'is', false), ['caro']],
    [rule('vip', 'empty'), ['beto', 'dani']],
    [rule('plan', 'in', ['premium', 'basico']), ['ana', 'beto']],
    [rule('plan', 'neq', 'premium'), ['beto', 'caro', 'dani']],
    [rule('nombre', 'starts_with', 'an'), ['ana']],
    [rule('consentimiento', 'eq', 'unknown'), ['ana', 'beto', 'caro', 'dani']],
    [rule('creado', 'before', '2026-02-01'), ['ana', 'beto', 'caro', 'dani']],
    [
      {
        version: 1,
        match: 'any',
        groups: [
          { match: 'all', rules: [{ field: 'attr', key: 'edad', op: 'lt', value: 18 }] },
          {
            match: 'all',
            rules: [
              { field: 'attr', key: 'vip', op: 'is', value: false },
              { field: 'attr', key: 'ciudad', op: 'eq', value: 'Puebla' },
            ],
          },
        ],
      },
      ['beto', 'caro'],
    ],
  ];
  const name = Object.fromEntries(Object.entries(ids).map(([key, id]) => [id, key]));
  for (const [definition, expected] of cases) {
    const { sql, params } = compile(definition, fields, { now });
    const bySql = db
      .prepare(`SELECT c.id FROM contacts c WHERE c.brand_id=? AND ${sql}`)
      .all(brand, ...params)
      .map(row => name[row.id])
      .sort();
    const inMemory = Object.values(ids)
      .filter(id => evaluate(definition, api.record(brand, id), fields, now))
      .map(id => name[id])
      .sort();
    assert.deepEqual(bySql, expected, JSON.stringify(definition));
    assert.deepEqual(inMemory, bySql, 'memoria y SQL coinciden: ' + JSON.stringify(definition));
  }
  // Un atributo que no existe en la marca no es una condición válida.
  assert.throws(
    () => compile(rule('talla', 'eq', 'M'), fields),
    error => error.problems?.length > 0,
  );
});

test('variables: {{contacto.<clave>}} sale de los atributos y de los datos de sistema', async t => {
  const { api, brand, ids } = await moduleWorld(t);
  const catalogue = api.variableCatalogue(brand);
  assert.ok(catalogue.has('contacto.ciudad') && catalogue.has('contacto.nombre'));
  assert.deepEqual(validate('Hola {{contacto.nombre}}, ¿sigues en {{contacto.ciudad}}?', catalogue), []);
  assert.equal(validate('{{contacto.talla}}', catalogue).length, 1);
  const out = render(
    'Hola {{contacto.nombre}}: plan {{contacto.plan}}, VIP {{contacto.vip}}, alta {{contacto.alta}}.',
    api.variableValues(brand, ids.ana),
    { catalogue },
  );
  assert.equal(out.text, 'Hola Ana: plan Premium, VIP Sí, alta 01/03/2026.');
  const empty = render(
    'Hola {{contacto.nombre}}, de {{contacto.ciudad|tu ciudad}}.',
    api.variableValues(brand, ids.dani),
    {
      catalogue,
    },
  );
  assert.equal(empty.text, 'Hola Dani, de tu ciudad.');
  assert.deepEqual(empty.defaulted, ['contacto.ciudad']);
});

test('valores: escribir es componible, valida, no repite lo igual y publica un evento sin datos personales', async t => {
  const { db, api, brand, ids, published } = await moduleWorld(t);
  const before = published.length;
  const result = transaction(db, () =>
    api.set(brand, ids.dani, [
      { key: 'ciudad', value: 'Toluca' },
      { key: 'edad', value: '' },
    ]),
  );
  assert.deepEqual(result.changed, [{ key: 'ciudad', from: null, to: 'Toluca' }]);
  assert.deepEqual(transaction(db, () => api.set(brand, ids.dani, [{ key: 'ciudad', value: ' Toluca ' }])).changed, []);
  assert.equal(published.length, before + 1);
  assert.equal(published.at(-1).type, 'contacto.atributo_cambiado');
  assert.equal(published.at(-1).payload.to, 'Toluca');
  assert.throws(
    () => transaction(db, () => api.set(brand, ids.dani, [{ key: 'nombre', value: 'X' }])),
    error => error.code === 'attribute_read_only',
  );
  assert.throws(
    () => transaction(db, () => api.set('odonteck', ids.dani, [{ key: 'ciudad', value: 'X' }])),
    error => error.status === 404,
    'un contacto de otra marca no existe para esta marca',
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Con el servidor real
// ---------------------------------------------------------------------------------------------------------------

test('atributos por la API: permisos y alcance, tipos, revisión, clientRef, archivo, límites y fusión', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-attributes-http-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code } });
  t.after(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (path, cookie, body, method = body === undefined ? 'GET' : 'POST', expected = 200) => {
    const response = await fetch(server.origin + path, {
      method,
      headers: { Cookie: cookie ?? '', Origin: server.origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    return { ...data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const password = 'Password-atributos-2026!';
  const reg = (username, inviteCode) =>
    call('/api/auth/register', '', { username, name: 'Prueba ' + username, password, inviteCode });
  const admin = await reg('admin', code);
  const a = await reg('asesor.a');
  const b = await reg('asesor.b');
  const client = await reg('cliente');
  for (const [user, username, brandIds] of [
    [a, 'asesor.a', ['globalvet']],
    [b, 'asesor.b', ['odonteck']],
  ]) {
    const invite = await call('/api/team/invites', admin.cookie, { username, brandIds }, 'POST', 201);
    await call('/api/team/accept', user.cookie, { token: invite.token });
  }
  const contact = async (name, brandId = 'globalvet') =>
    (await call('/api/crm/contacts', admin.cookie, { brandId, name }, 'POST', 201)).id;
  const defineAttr = (input, cookie = admin.cookie, expected = 201) =>
    call('/api/attributes', cookie, { brandId: 'globalvet', ...input }, 'POST', expected);

  // Permisos: leer pide contacts.view; definir pide contacts.attributes.manage (sólo administración).
  await call('/api/attributes', '', undefined, 'GET', 401);
  await call('/api/attributes', client.cookie, undefined, 'GET', 403);
  await defineAttr({ key: 'ciudad', label: 'Ciudad', type: 'text' }, a.cookie, 403);
  const ciudad = (await defineAttr({ key: 'ciudad', label: 'Ciudad', type: 'text', clientRef: 'def-ciudad' }))
    .definition;
  assert.equal(ciudad.revision, 1);
  const replay = await defineAttr(
    { key: 'ciudad', label: 'Ciudad', type: 'text', clientRef: 'def-ciudad' },
    undefined,
    200,
  );
  assert.equal(replay.definition.id, ciudad.id);
  assert.equal(replay.replayed, true);
  const plan = (
    await defineAttr({
      key: 'plan',
      label: 'Plan',
      type: 'select',
      options: [{ value: 'basico', label: 'Básico' }, 'premium'],
    })
  ).definition;
  const edad = (await defineAttr({ key: 'edad', label: 'Edad', type: 'number' })).definition;
  await defineAttr({ key: 'curp', label: 'CURP', type: 'text', personal: true, searchable: true });
  await defineAttr({ key: 'ciudad', label: 'Otra', type: 'text' }, undefined, 409);
  await defineAttr({ key: 'nombre', label: 'Nombre', type: 'text' }, undefined, 409);
  await defineAttr({ key: 'Mal Clave', label: 'X', type: 'text' }, undefined, 400);
  await defineAttr({ key: 'lista_vacia', label: 'X', type: 'select' }, undefined, 400);
  await defineAttr({ key: 'raro', label: 'X', type: 'color' }, undefined, 400);
  await defineAttr({ key: 'sin_nombre', label: ' ', type: 'text' }, undefined, 400);
  await call('/api/attributes', b.cookie, { brandId: 'globalvet', key: 'x1', label: 'X', type: 'text' }, 'POST', 403);

  // Alcance por marca: cada quien ve sólo sus marcas.
  const seenByA = await call('/api/attributes', a.cookie);
  assert.deepEqual(
    seenByA.brands.map(item => item.brandId),
    ['globalvet'],
  );
  assert.equal(seenByA.brands[0].canManage, false);
  assert.ok(seenByA.brands[0].definitions.some(d => d.key === 'ciudad'));
  assert.ok(seenByA.system.some(item => item.key === 'etapa' && item.readOnly));
  assert.ok(
    (await call('/api/attributes', b.cookie)).brands.every(
      item => item.brandId !== 'globalvet' && item.definitions.length === 0,
    ),
  );
  await call('/api/attributes?brand=globalvet', b.cookie, undefined, 'GET', 404);
  await call('/api/attributes/' + ciudad.id, b.cookie, undefined, 'GET', 404);
  assert.equal(
    (await call('/api/attributes', admin.cookie)).brands.find(x => x.brandId === 'globalvet').canManage,
    true,
  );

  // Edición con revisión: la clave y el tipo no cambian; una revisión vieja es un conflicto.
  const edited = (
    await call(
      '/api/attributes/' + ciudad.id,
      admin.cookie,
      { label: 'Ciudad de residencia', expectedRevision: 1 },
      'PATCH',
    )
  ).definition;
  assert.equal(edited.revision, 2);
  const stale = await call(
    '/api/attributes/' + ciudad.id,
    admin.cookie,
    { label: 'Otra', expectedRevision: 1 },
    'PATCH',
    409,
  );
  assert.equal(stale.code, 'stale_record');
  await call('/api/attributes/' + ciudad.id, admin.cookie, { type: 'number', expectedRevision: 2 }, 'PATCH', 400);
  await call('/api/attributes/' + ciudad.id, admin.cookie, { key: 'otra', expectedRevision: 2 }, 'PATCH', 400);
  await call('/api/attributes/' + ciudad.id, a.cookie, { label: 'X', expectedRevision: 2 }, 'PATCH', 403);

  // Valores: el equipo de la marca los escribe; reintentar con el mismo clientRef no repite nada.
  const ana = await contact('Ana Atributos');
  const put = (contactId, body, cookie = a.cookie, expected = 200) =>
    call('/api/attributes/contacts/' + contactId, cookie, body, 'PUT', expected);
  const first = await put(ana, {
    changes: [
      { key: 'ciudad', value: 'Puebla' },
      { key: 'edad', value: '31' },
      { key: 'plan', value: 'premium' },
      { key: 'curp', value: 'XAXX010101HDFRRR01' },
    ],
    clientRef: 'valores-1',
  });
  assert.deepEqual(first.changed.sort(), ['ciudad', 'curp', 'edad', 'plan']);
  assert.equal(first.values.edad.value, '31');
  assert.equal(first.values.plan.display, 'premium');
  const again = await put(ana, { changes: [{ key: 'ciudad', value: 'Otra cosa' }], clientRef: 'valores-1' });
  assert.equal(again.replayed, true);
  assert.equal(again.values.ciudad.value, 'Puebla');
  await put(ana, { changes: [{ key: 'ciudad', value: 'X' }], clientRef: 'valores-1' }, admin.cookie, 409);
  assert.equal(
    (await put(ana, { changes: [{ key: 'edad', value: 'treinta' }] }, a.cookie, 400)).code,
    'attribute_invalid',
  );
  assert.equal((await put(ana, { changes: [{ key: 'talla', value: 'M' }] }, a.cookie, 400)).code, 'attribute_unknown');
  assert.equal(
    (await put(ana, { changes: [{ key: 'etapa', value: 'ganada' }] }, a.cookie, 400)).code,
    'attribute_read_only',
  );
  assert.equal(
    (await put(ana, { changes: [{ key: 'ciudad', value: 'x'.repeat(501) }] }, a.cookie, 400)).code,
    'attribute_invalid',
  );
  await put(ana, { changes: [{ key: 'ciudad', value: 'X' }] }, b.cookie, 404);
  await put(ana, { changes: [{ key: 'ciudad', value: 'X' }] }, client.cookie, 403);
  await put(ana, { changes: [] }, a.cookie, 400);
  const conflict = await put(
    ana,
    { changes: [{ key: 'ciudad', value: 'Toluca', expected: 'Cholula' }] },
    a.cookie,
    409,
  );
  assert.equal(conflict.details.current, 'Puebla');
  await put(ana, { changes: [{ key: 'ciudad', value: 'Toluca', expected: 'Puebla' }] });
  const read = await call('/api/attributes/contacts/' + ana, a.cookie);
  assert.equal(read.values.ciudad.value, 'Toluca');
  assert.equal(read.system.nombre.value, 'Ana Atributos');
  assert.equal(read.system.consentimiento.value, 'unknown');
  assert.deepEqual(
    read.history.map(item => item.key),
    ['ciudad', 'curp', 'plan', 'edad', 'ciudad'],
  );
  await call('/api/attributes/contacts/' + ana, b.cookie, undefined, 'GET', 404);

  // Una opción en uso no se quita; archivar conserva los valores y deja de aceptar escrituras.
  const removing = await call(
    '/api/attributes/' + plan.id,
    admin.cookie,
    { options: [{ value: 'basico', label: 'Básico' }], expectedRevision: 1 },
    'PATCH',
    409,
  );
  assert.equal(removing.code, 'attribute_option_in_use');
  const archived = (await call('/api/attributes/' + edad.id + '/archive', admin.cookie, { expectedRevision: 1 }))
    .definition;
  assert.equal(archived.status, 'archived');
  assert.equal(
    (await call('/api/attributes/' + edad.id + '/archive', admin.cookie, { expectedRevision: 1 })).unchanged,
    true,
  );
  assert.equal((await put(ana, { changes: [{ key: 'edad', value: '40' }] }, a.cookie, 400)).code, 'attribute_unknown');
  const kept = await call('/api/attributes/contacts/' + ana, a.cookie);
  assert.equal(kept.values.edad.value, '31');
  assert.equal(kept.values.edad.status, 'archived');
  assert.ok(
    !(await call('/api/attributes?brand=globalvet', a.cookie)).brands[0].definitions.some(d => d.key === 'edad'),
  );
  assert.ok(
    (await call('/api/attributes?brand=globalvet&archived=1', a.cookie)).brands[0].definitions.some(
      d => d.key === 'edad',
    ),
  );
  await call('/api/attributes/' + edad.id + '/restore', admin.cookie, { expectedRevision: archived.revision });

  // Límite de definiciones activas por marca.
  const active = (await call('/api/attributes?brand=globalvet', admin.cookie)).brands[0].active;
  for (let i = active; i < 60; i++) await defineAttr({ key: 'extra_' + i, label: 'Extra ' + i, type: 'text' });
  assert.equal(
    (await defineAttr({ key: 'uno_mas', label: 'Uno más', type: 'text' }, undefined, 409)).code,
    'attribute_limit',
  );

  // Fusión: gana el valor del contacto que queda; lo que le falta se llena con el del absorbido; el historial pasa.
  const dup = await contact('Ana Duplicada');
  await put(dup, {
    changes: [
      { key: 'ciudad', value: 'Cholula' },
      { key: 'plan', value: 'basico' },
    ],
  });
  await put(ana, { changes: [{ key: 'plan', value: '' }] });
  const preview = (await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: ana, mergeId: dup })).plan;
  assert.equal(preview.linked.contact_attribute_values, 2);
  await call('/api/crm/contacts/merge', admin.cookie, {
    keepId: ana,
    mergeId: dup,
    previewToken: preview.previewToken,
  });
  const merged = await call('/api/attributes/contacts/' + ana, admin.cookie);
  assert.equal(merged.values.ciudad.value, 'Toluca');
  assert.equal(merged.values.plan.value, 'basico');
  await call('/api/attributes/contacts/' + dup, admin.cookie, undefined, 'GET', 404);

  const db = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  try {
    assert.equal(
      db.prepare('SELECT count(*) n FROM contact_attribute_values WHERE contact_id=?').get(dup).n +
        db.prepare('SELECT count(*) n FROM contact_attribute_events WHERE contact_id=?').get(dup).n,
      0,
    );
    // Un evento de dominio por cambio; el de un dato personal no lleva el valor.
    const events = db
      .prepare("SELECT payload FROM domain_events WHERE type='contacto.atributo_cambiado' AND entity_id=?")
      .all(ana)
      .map(row => JSON.parse(row.payload));
    const curp = events.find(event => event.key === 'curp');
    assert.equal(curp.redacted, true);
    assert.equal(curp.to, undefined);
    assert.equal(events.find(event => event.key === 'edad').to, '31');
  } finally {
    db.close();
  }
});
