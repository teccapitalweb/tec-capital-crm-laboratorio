// Audiencias: listas y segmentos para difundir (docs/PLAN_AUDIENCIAS.md). Todo lo de aquí es inventado: nombres,
// teléfonos y correos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, transaction } from '../server/database.mjs';
import { migrate, NAMED } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { fail } from '../server/app/http.mjs';
import { createPersonData } from '../server/lib/person-data.mjs';
import { matcher } from '../server/lib/conditions.mjs';
import { phoneKey } from '../server/lib/identity-keys.mjs';
import { CSV_BOM } from '../server/lib/csv.mjs';
import attributesModule from '../server/modules/attributes/module.mjs';
import audiencesModule from '../server/modules/audiences/module.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { openDb, until } from './helpers/crm.mjs';

const BRAND = 'globalvet';
const OTHER = 'odonteck';
const N = 6500;
const BUDGET_MS = 5000; // holgado: contar y recorrer 6 500 tarda decenas o pocos cientos de milisegundos
const HOUR = 3_600_000;
const PASSWORD = 'Password-audiencias-2026!';

async function workspace(t, prefix = 'crm-audiences-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, db };
}

// ---------------------------------------------------------------------------------------------------------------
// Datos sembrados: 6 500 contactos de la marca con cada caso de exclusión, más unos de otra marca con los mismos
// teléfonos. Devuelve lo que se espera de cada uno.
// ---------------------------------------------------------------------------------------------------------------

function seed(db, { n = N, base = Date.now() } = {}) {
  const tag = (id, brand, name) =>
    db
      .prepare('INSERT INTO contact_tags(id,brand_id,name,name_key,created_at) VALUES(?,?,?,?,1)')
      .run(id, brand, name, name.toLowerCase());
  tag('tag-aves', BRAND, 'Curso aves');
  tag('tag-webinar', BRAND, 'Webinar');
  tag('tag-otra', OTHER, 'Otra marca');
  const attribute = (key, personal) => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO contact_attributes(id,brand_id,key,label,type,personal,created_at,updated_at) VALUES(?,?,?,?,'text',?,1,1)",
    ).run(id, BRAND, key, key, personal ? 1 : 0);
    return id;
  };
  const city = attribute('ciudad', false);
  const curp = attribute('curp', true);
  const insert = db.prepare(
    "INSERT INTO contacts(id,brand_id,name,phone,phone_key,email,source,created_at,updated_at) VALUES(?,?,?,?,?,?,'import',?,?)",
  );
  const consent = db.prepare(
    "INSERT INTO contact_consent(contact_id,brand_id,status,source,updated_at) VALUES(?,?,?,'import',1)",
  );
  const link = db.prepare('INSERT INTO contact_tag_links(contact_id,tag_id,created_at) VALUES(?,?,1)');
  const value = db.prepare(
    "INSERT INTO contact_attribute_values(contact_id,attribute_id,brand_id,value,source,updated_at) VALUES(?,?,?,?,'staff',1)",
  );
  const FIRST = ['Ana', 'José', 'María', 'Lucía', 'Óscar', 'Úrsula', 'Renée'];
  const people = [];
  db.exec('BEGIN');
  for (let i = 1; i <= n; i++) {
    const id = `gv-${String(i).padStart(5, '0')}`;
    let phone = '+52 1 55 ' + String(10000000 + i);
    if (i % 50 === 0) phone = '';
    if (i % 97 === 0) phone = people[i - 2].phone; // el mismo teléfono que el contacto anterior
    const key = phone ? phoneKey(phone) : '';
    const status = i % 7 === 0 ? 'opted_out' : i % 3 === 0 ? 'opted_in' : null;
    const created = base - i * HOUR;
    insert.run(
      id,
      BRAND,
      `${FIRST[i % FIRST.length]} Prueba ${i}`,
      phone,
      key,
      i % 2 ? `persona${i}@correo.invalid` : '',
      created,
      created,
    );
    if (status) consent.run(id, BRAND, status);
    const tags = [...(i % 4 === 0 ? ['tag-aves'] : []), ...(i % 5 === 0 ? ['tag-webinar'] : [])];
    for (const t of tags) link.run(id, t);
    if (i % 3 === 1) value.run(id, city, BRAND, ['Puebla', 'Mérida', 'León'][i % 3 === 1 ? (i % 9 === 1 ? 0 : 1) : 2]);
    if (i % 11 === 0) value.run(id, curp, BRAND, 'CURP' + i);
    people.push({ id, i, phone, key, consent: status ?? 'unknown', tags, created });
  }
  for (let i = 1; i <= 40; i++)
    insert.run(`od-${i}`, OTHER, `Otra Marca ${i}`, people[i].phone, people[i].key, '', base, base);
  db.exec('COMMIT');
  return people;
}

// El módulo sobre una base temporal, con un `host` mínimo. `full` simula el permiso contacts.phone.
async function moduleWorld(t, { full = true, people = true } = {}) {
  const { db } = await workspace(t);
  migrate(db, { backup: false });
  const modules = {};
  const host = {
    db,
    transaction,
    fail,
    personData: createPersonData({ db }),
    services: { events: { registerTypes() {}, publish() {} } },
    access: {
      require() {},
      can: (_user, permission) => permission !== 'contacts.phone' || full,
      phone: (_user, value) => (full || !value ? value : '•••• ' + String(value).slice(-4)),
      brandIds: () => [BRAND],
    },
    realtime: { emit() {} },
    body: async req => req.body,
    json: (res, status, data) => Object.assign(res, { status, data }),
    audit() {},
    rate() {},
    module(name) {
      if (!modules[name]) throw new Error('sin módulo ' + name);
      return modules[name];
    },
  };
  modules.attributes = attributesModule.create(host);
  modules.audiences = audiencesModule.create(host);
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u-1','admin.prueba','Admin','x','admin',990001,1,1)",
  ).run();
  const seeded = people ? seed(db) : [];
  const call = async (method, path, body, query = {}) => {
    const res = {};
    const url = new URL('http://localhost' + path + '?' + new URLSearchParams(query));
    await modules.audiences.handle({ method, body }, res, path, { id: 'u-1' }, url);
    return res.data;
  };
  return { db, api: modules.audiences, people: seeded, call };
}

const def = (...rules) => ({ version: 1, match: 'all', groups: [{ match: 'all', rules }] });

// Todos los ids de un público, de página en página (orden por id), comprobando que no se repite ninguno.
function walk(api, spec, { status = 'all', limit = 700 } = {}) {
  const seen = new Set();
  const order = [];
  let after = null;
  for (let pages = 0; pages < 100; pages++) {
    const page = api.members(BRAND, spec, { after, limit, status });
    for (const row of page.rows) {
      assert.ok(!seen.has(row.contactId), `${row.contactId} se repite entre páginas`);
      seen.add(row.contactId);
      order.push(row);
    }
    if (!page.next) return order;
    after = page.next;
  }
  assert.fail('demasiadas páginas');
}

// ---------------------------------------------------------------------------------------------------------------
// Migración
// ---------------------------------------------------------------------------------------------------------------

test('migración audiences/0001: una base que ya existía queda igual que una nueva y conserva sus datos', async t => {
  const { db: old } = await workspace(t);
  migrate(old, { backup: false, registry: defineRegistry(NAMED.filter(m => !m.name.startsWith('audiences/'))) });
  old
    .prepare("INSERT INTO contacts(id,brand_id,name,created_at,updated_at) VALUES('c-antes','globalvet','Antes',1,1)")
    .run();
  assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name='audiences'").get(), undefined);
  migrate(old, { backup: false });
  assertSchemaCurrent(old);
  migrate(old, { backup: false });
  assertSchemaCurrent(old);
  const { db: fresh } = await workspace(t);
  migrate(fresh, { backup: false });
  assert.deepEqual(schemaShape(old), schemaShape(fresh));
  assert.equal(old.prepare("SELECT name FROM contacts WHERE id='c-antes'").get().name, 'Antes');
  assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Lógica del módulo (base temporal)
// ---------------------------------------------------------------------------------------------------------------

test('segmentos y listas: el mismo resultado en memoria y en SQL, páginas estables y sin repetidos', async t => {
  const { api, people, call } = await moduleWorld(t);
  // Una lista con los contactos múltiplos de 13 (se crea por la ruta, en tandas de hasta 500).
  const listIds = people.filter(p => p.i % 13 === 0).map(p => p.id);
  const list = (await call('POST', '/api/audiences', { brandId: BRAND, kind: 'list', name: 'Lista de prueba' }))
    .audience;
  for (let i = 0; i < listIds.length; i += 500)
    await call('POST', `/api/audiences/${list.id}/members`, { add: listIds.slice(i, i + 500) });
  const fields = api.fieldsFor(BRAND);
  const records = new Map(people.map(p => [p.id, api.recordOf(BRAND, p.id)]));
  const definitions = [
    def({ field: 'tag', op: 'any', value: ['tag-aves'] }, { field: 'consent', op: 'eq', value: 'opted_in' }),
    {
      version: 1,
      match: 'any',
      groups: [
        { match: 'all', rules: [{ field: 'has_phone', op: 'is', value: false }] },
        { match: 'all', rules: [{ field: 'tag', op: 'all', value: ['tag-aves', 'tag-webinar'] }] },
      ],
    },
    def({ field: 'created', op: 'in_last_days', value: 100 }, { field: 'consent', op: 'neq', value: 'opted_out' }),
    def({ field: 'list', op: 'any', value: [list.id] }),
    def({ field: 'list', op: 'none', value: [list.id] }, { field: 'email', op: 'not_empty' }),
    def({ field: 'attr', key: 'ciudad', op: 'eq', value: 'puebla' }),
    def({ field: 'name', op: 'contains', value: 'maria' }),
    def({ field: 'phone', op: 'starts_with', value: people[0].key.slice(0, 10) }),
    def(
      { field: 'last_inbound', op: 'not_in_last_days', value: 90 },
      { field: 'enrolled', op: 'is', value: false },
      { field: 'tag', op: 'none', value: ['tag-webinar'] },
    ),
  ];
  for (const [index, definition] of definitions.entries()) {
    const test = matcher(definition, fields);
    const now = Date.now();
    const memory = people.filter(p => test(records.get(p.id), now)).map(p => p.id);
    const sql = walk(api, { definition }).map(r => r.contactId);
    assert.deepEqual(sql, [...memory].sort(), `definición ${index + 1}: memoria y SQL coinciden`);
    assert.ok(memory.length > 0 && memory.length < people.length, `definición ${index + 1} separa algo`);
  }
  // La lista entrega exactamente sus miembros y su conteo es exacto.
  assert.deepEqual(
    walk(api, { audienceId: list.id }).map(r => r.contactId),
    [...listIds].sort(),
  );
  assert.equal((await call('GET', `/api/audiences/${list.id}`)).audience.memberCount, listIds.length);
  // Un segmento guardado con la misma condición que «está en la lista» da el mismo público.
  const segment = (
    await call('POST', '/api/audiences', {
      brandId: BRAND,
      kind: 'segment',
      name: 'Igual que la lista',
      definition: def({ field: 'list', op: 'any', value: [list.id] }),
    })
  ).audience;
  assert.equal(segment.memberCount, listIds.length);
  assert.deepEqual(walk(api, { audienceId: segment.id }), walk(api, { audienceId: list.id }));
  // Dos recorridos con otro tamaño de página dan el mismo orden.
  const all = { definition: def() };
  assert.deepEqual(
    walk(api, all, { limit: 333 }).map(r => r.contactId),
    walk(api, all, { limit: 1000 }).map(r => r.contactId),
  );
  assert.equal(walk(api, all).length, N, 'sólo los contactos de la marca');
});

test('vista previa: conteo y motivo de cada exclusión, lista de exclusión y exclusiones de la difusión', async t => {
  const { api, people, call } = await moduleWorld(t);
  // Lista de exclusión de la marca con 25 contactos (algunos ya tenían otro motivo).
  const suppressedIds = people.filter(p => p.i % 260 === 1).map(p => p.id);
  const suppression = (
    await call('POST', '/api/audiences', {
      brandId: BRAND,
      kind: 'list',
      role: 'suppression',
      name: 'No contactar',
      contactIds: suppressedIds,
    })
  ).audience;
  assert.equal(suppression.memberCount, suppressedIds.length);
  // Lo que se espera, calculado aquí en JavaScript con las mismas reglas y el mismo orden de motivos.
  const expectFor = (members, { requireConsent = true, excluded = new Set() } = {}) => {
    const out = { total: 0, eligible: 0, excluded: {} };
    const seenPhones = new Set();
    for (const p of [...members].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      out.total++;
      let reason = null;
      if (excluded.has(p.id)) reason = 'excluded';
      else if (!p.key) reason = 'no_phone';
      else if (suppressedIds.includes(p.id)) reason = 'suppressed';
      else if (p.consent === 'opted_out') reason = 'opted_out';
      else if (requireConsent && p.consent !== 'opted_in') reason = 'no_consent';
      else if (seenPhones.has(p.key)) reason = 'duplicate';
      if (!reason) seenPhones.add(p.key);
      if (reason) out.excluded[reason] = (out.excluded[reason] ?? 0) + 1;
      else out.eligible++;
    }
    return out;
  };
  const everyone = { definition: def() };
  assert.deepEqual(api.summary(BRAND, everyone), expectFor(people));
  assert.deepEqual(
    api.summary(BRAND, everyone, { requireConsent: false }),
    expectFor(people, { requireConsent: false }),
  );
  const totals = api.summary(BRAND, everyone, { requireConsent: false });
  for (const reason of ['no_phone', 'suppressed', 'opted_out', 'duplicate'])
    assert.ok(totals.excluded[reason] > 0, `hay contactos excluidos por ${reason}`);
  assert.ok(api.summary(BRAND, everyone).excluded.no_consent > 0);

  // Público de una difusión: dos audiencias unidas menos otra.
  const aves = (
    await call('POST', '/api/audiences', {
      brandId: BRAND,
      kind: 'segment',
      name: 'Aves',
      definition: def({ field: 'tag', op: 'any', value: ['tag-aves'] }),
    })
  ).audience;
  const webinar = (
    await call('POST', '/api/audiences', {
      brandId: BRAND,
      kind: 'segment',
      name: 'Webinar',
      definition: def({ field: 'tag', op: 'any', value: ['tag-webinar'] }),
    })
  ).audience;
  const vip = people.filter(p => p.i % 40 === 0).map(p => p.id);
  const vipList = (await call('POST', '/api/audiences', { brandId: BRAND, kind: 'list', name: 'VIP', contactIds: vip }))
    .audience;
  const spec = {
    version: 2,
    include: [{ audienceId: aves.id }, { audienceId: webinar.id }],
    exclude: [{ audienceId: vipList.id }],
  };
  const union = people.filter(p => p.tags.length);
  assert.deepEqual(api.summary(BRAND, spec), expectFor(union, { excluded: new Set(vip) }));
  const eligible = walk(api, spec, { status: 'eligible' });
  assert.equal(eligible.length, expectFor(union, { excluded: new Set(vip) }).eligible);
  assert.ok(eligible.every(row => row.reason === null && row.phoneKey));
  const selected = api.selectSql(BRAND, spec);
  assert.ok(!selected.sql.includes('tag-aves'), 'los valores viajan como parámetros');

  // La ruta de vista previa: conteo, motivos con su texto y muestras de quién entra y quién no.
  const preview = await call('POST', '/api/audiences/preview', { brandId: BRAND, audienceId: aves.id });
  const expected = expectFor(people.filter(p => p.tags.includes('tag-aves')));
  assert.equal(preview.total, expected.total);
  assert.equal(preview.eligible, expected.eligible);
  assert.deepEqual(Object.fromEntries(preview.excluded.map(e => [e.reason, e.count])), expected.excluded);
  assert.ok(preview.excluded.every(e => e.label));
  assert.equal(preview.sample.eligible.length, 5);
  assert.ok(preview.sample.excluded.every(m => m.reasonLabel));
  // Miembros de la lista de exclusión, con su motivo, de página en página por nombre.
  const page = await call('GET', `/api/audiences/${suppression.id}/members`, undefined, { limit: '10' });
  assert.equal(page.summary.total, suppressedIds.length);
  assert.equal(page.members.length, 10);
  const next = await call('GET', `/api/audiences/${suppression.id}/members`, undefined, {
    limit: '10',
    cursor: page.next,
  });
  assert.ok(next.members.every(m => !page.members.some(x => x.contactId === m.contactId)));
});

test('privacidad: sin ver datos completos no se filtra por teléfono, correo ni datos personales', async t => {
  const { call } = await moduleWorld(t, { full: false });
  const preview = definition => call('POST', '/api/audiences/preview', { brandId: BRAND, definition });
  for (const rule of [
    { field: 'phone', op: 'starts_with', value: '5215510' },
    { field: 'email', op: 'contains', value: 'persona12' },
    { field: 'attr', key: 'curp', op: 'eq', value: 'CURP11' },
    { field: 'attr', key: 'correo', op: 'contains', value: 'persona' },
  ]) {
    await assert.rejects(
      () => preview(def(rule)),
      error => error.status === 403 && error.code === 'permission_denied',
      JSON.stringify(rule),
    );
    await assert.rejects(
      () =>
        call('POST', '/api/audiences', { brandId: BRAND, kind: 'segment', name: 'Adivinar', definition: def(rule) }),
      error => error.status === 403,
    );
  }
  // Lo que ya se ve sí: tener o no tener correo, un dato que no es personal.
  assert.ok((await preview(def({ field: 'email', op: 'not_empty' }))).total > 0);
  assert.ok((await preview(def({ field: 'attr', key: 'ciudad', op: 'eq', value: 'Puebla' }))).total > 0);
  const { fields } = await call('GET', '/api/audiences/fields', undefined, { brand: BRAND });
  assert.ok(!fields.some(f => f.name === 'phone'), 'no se ofrece el teléfono');
  assert.ok(!fields.some(f => f.key === 'curp'), 'no se ofrece el dato personal');
  assert.ok(!fields.find(f => f.name === 'email').ops.includes('contains'));
  // El teléfono de cada miembro sale enmascarado.
  const sample = (await preview(def({ field: 'has_phone', op: 'is', value: true }))).sample.eligible;
  assert.ok(sample.every(m => m.phone.startsWith('••••')));
});

// ---------------------------------------------------------------------------------------------------------------
// Con el servidor real
// ---------------------------------------------------------------------------------------------------------------

async function lab(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-audiences-lab-'));
  const code = randomUUID();
  const server = await startServer({
    dir,
    env: { ADMIN_INVITE_CODE: code, IMPORT_MAX_ROWS: '10000', JOBS_LEASE_MS: '1500', ...env },
  });
  let db = null;
  t.after(async () => {
    db?.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const call = async (path, cookie, body, method = body === undefined ? 'GET' : 'POST', expected = 200) => {
    const raw = typeof body === 'string';
    const response = await fetch(server.origin + path, {
      method,
      headers: { Cookie: cookie ?? '', Origin: server.origin, 'Content-Type': raw ? 'text/csv' : 'application/json' },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await response.text();
    const data = response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : { text };
    assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 400)}`);
    return { ...data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const reg = (username, inviteCode) =>
    call('/api/auth/register', '', { username, name: 'Prueba ' + username, password: PASSWORD, inviteCode });
  const admin = (await reg('admin', code)).cookie;
  return { call, reg, admin, db: () => (db ??= openDb(dir)), logs: () => server.logs() };
}

test('servidor real: 6 500 contactos, listas, segmentos, conteo, páginas, permisos, alcance y fusión', async t => {
  const { call, reg, admin, db } = await lab(t);
  const people = seed(db());
  const timings = {};
  const timed = async (name, fn) => {
    const started = Date.now();
    const out = await fn();
    timings[name] = Date.now() - started;
    assert.ok(timings[name] < BUDGET_MS, `${name}: ${timings[name]} ms`);
    return out;
  };

  // Permisos: un cliente no ve audiencias; una marca ajena o inexistente responde 404.
  const customer = (await reg('cliente1')).cookie;
  await call('/api/audiences?brand=globalvet', customer, undefined, 'GET', 403);
  await call('/api/audiences?brand=no-existe', admin, undefined, 'GET', 404);

  // Al listar se crean los prediseñados de la marca (una sola vez).
  const first = await call('/api/audiences?brand=globalvet', admin);
  assert.equal(first.audiences.filter(a => a.preset).length, 6);
  assert.equal((await call('/api/audiences?brand=globalvet', admin)).audiences.filter(a => a.preset).length, 6);
  const allValid = first.audiences.find(a => a.preset === 'all_valid');
  await call(
    `/api/audiences/${allValid.id}`,
    admin,
    { name: 'Cambiar', expectedRevision: allValid.revision },
    'PATCH',
    400,
  );

  // Segmento de toda la marca: conteo y recorrido completo por páginas de 50, sin repetidos.
  const everyone = (
    await call(
      '/api/audiences',
      admin,
      { brandId: BRAND, kind: 'segment', name: 'Toda la marca', definition: def(), clientRef: 'seg-todos' },
      'POST',
      201,
    )
  ).audience;
  assert.equal(everyone.memberCount, N);
  // Repetir el alta con el mismo clientRef devuelve la misma audiencia.
  assert.equal(
    (await call('/api/audiences', admin, { brandId: BRAND, kind: 'segment', name: 'Otra', clientRef: 'seg-todos' }))
      .audience.id,
    everyone.id,
  );
  const preview = await timed('vista previa de 6 500', () =>
    call('/api/audiences/preview', admin, { brandId: BRAND, audienceId: everyone.id }),
  );
  assert.equal(preview.total, N);
  const seen = new Set();
  await timed('recorrer 6 500 de 50 en 50', async () => {
    let cursor = null;
    let summary = null;
    for (;;) {
      const page = await call(
        `/api/audiences/${everyone.id}/members?limit=50${cursor ? '&cursor=' + cursor : ''}`,
        admin,
      );
      summary ??= page.summary;
      for (const m of page.members) {
        assert.ok(!seen.has(m.contactId));
        seen.add(m.contactId);
      }
      if (!page.next) break;
      cursor = page.next;
    }
    assert.equal(summary.total, N);
  });
  assert.equal(seen.size, N);
  await timed('volver a contar', () => call(`/api/audiences/${everyone.id}/recount`, admin, {}));

  // Lista: alta con contactos, más contactos por tandas (los de otra marca se ignoran), quitar, nombre repetido.
  const odonteck = (await call('/api/audiences?brand=odonteck', admin)).audiences;
  assert.ok(odonteck.every(a => a.brandId === OTHER));
  const ids = people.slice(0, 1200).map(p => p.id);
  const list = (
    await call(
      '/api/audiences',
      admin,
      { brandId: BRAND, kind: 'list', name: 'Primeros', contactIds: ids.slice(0, 500) },
      'POST',
      201,
    )
  ).audience;
  await call('/api/audiences', admin, { brandId: BRAND, kind: 'list', name: 'primeros' }, 'POST', 409);
  await call(`/api/audiences/${list.id}/members`, admin, { add: ids.slice(0, 501) }, 'POST', 400);
  let edit = await call(`/api/audiences/${list.id}/members`, admin, { add: [...ids.slice(400, 900)] });
  assert.equal(edit.added, 400);
  edit = await call(`/api/audiences/${list.id}/members`, admin, {
    add: [...ids.slice(900, 1200), 'od-1', 'od-2'],
    remove: ids.slice(0, 10),
  });
  assert.equal(edit.added, 300);
  assert.equal(edit.removed, 10);
  assert.equal(edit.audience.memberCount, 1190);
  // Una lista de otra marca no se puede citar en un segmento de ésta.
  const foreign = (
    await call('/api/audiences', admin, { brandId: OTHER, kind: 'list', name: 'De otra marca' }, 'POST', 201)
  ).audience;
  await call(
    '/api/audiences',
    admin,
    {
      brandId: BRAND,
      kind: 'segment',
      name: 'Ajena',
      definition: def({ field: 'list', op: 'any', value: [foreign.id] }),
    },
    'POST',
    400,
  );
  // Editar con la revisión vieja falla; con la buena, cambia el nombre.
  const segment = (
    await call(
      '/api/audiences',
      admin,
      {
        brandId: BRAND,
        kind: 'segment',
        name: 'Aves con permiso',
        definition: def(
          { field: 'tag', op: 'any', value: ['tag-aves'] },
          { field: 'consent', op: 'eq', value: 'opted_in' },
        ),
      },
      'POST',
      201,
    )
  ).audience;
  const expectedAves = people.filter(p => p.tags.includes('tag-aves') && p.consent === 'opted_in').length;
  assert.equal(segment.memberCount, expectedAves);
  await call(`/api/audiences/${segment.id}`, admin, { name: 'X', expectedRevision: 99 }, 'PATCH', 409);
  const renamed = (
    await call(`/api/audiences/${segment.id}`, admin, { name: 'Aves (permiso)', expectedRevision: 1 }, 'PATCH')
  ).audience;
  assert.equal(renamed.revision, 2);

  // Archivar: no con una campaña programada que la usa; sí cuando ya no.
  db()
    .prepare(
      "INSERT INTO campaigns(id,brand_id,kind,title,segment,status,created_at,updated_at) VALUES('camp-1',?,'template','Prueba','{}','scheduled',1,1)",
    )
    .run(BRAND);
  db()
    .prepare('UPDATE campaigns SET segment=? WHERE id=?')
    .run(JSON.stringify({ audienceId: list.id }), 'camp-1');
  const blocked = await call(`/api/audiences/${list.id}/archive`, admin, { expectedRevision: 1 }, 'POST', 409);
  assert.equal(blocked.code, 'audience_in_use');
  assert.equal(blocked.details.campaigns[0].id, 'camp-1');
  db().prepare("UPDATE campaigns SET status='completed' WHERE id='camp-1'").run();
  const archived = (await call(`/api/audiences/${list.id}/archive`, admin, { expectedRevision: 1 })).audience;
  assert.equal(archived.archived, true);
  assert.equal(archived.memberCount, 1190, 'archivar no borra miembros');
  await call(`/api/audiences/${list.id}/members`, admin, { add: [ids[0]] }, 'POST', 409);
  const restored = (await call(`/api/audiences/${list.id}/restore`, admin, { expectedRevision: archived.revision }))
    .audience;
  assert.equal(restored.archived, false);

  // Fusión de dos contactos de la lista: queda uno, sin duplicar, y el conteo baja en uno.
  const [keepId, mergeId] = [ids[20], ids[21]];
  const extra = (
    await call(
      '/api/audiences',
      admin,
      { brandId: BRAND, kind: 'list', name: 'Sólo el absorbido', contactIds: [mergeId] },
      'POST',
      201,
    )
  ).audience;
  const { plan } = await call('/api/crm/contacts/merge-preview', admin, { keepId, mergeId });
  await call('/api/crm/contacts/merge', admin, { keepId, mergeId, previewToken: plan.previewToken });
  const count = (sql, ...a) =>
    db()
      .prepare(sql)
      .get(...a).n;
  assert.equal(count('SELECT count(*) n FROM audience_members WHERE contact_id=?', mergeId), 0);
  assert.equal(
    count('SELECT count(*) n FROM audience_members WHERE audience_id=? AND contact_id=?', list.id, keepId),
    1,
  );
  assert.equal(
    count('SELECT count(*) n FROM audience_members WHERE audience_id=? AND contact_id=?', extra.id, keepId),
    1,
  );
  assert.equal((await call(`/api/audiences/${list.id}`, admin)).audience.memberCount, 1189);
  assert.equal((await call(`/api/audiences/${extra.id}`, admin)).audience.memberCount, 1);

  // Segmento con datos propios de contacto (atributos).
  const city = (
    await call(
      '/api/audiences',
      admin,
      {
        brandId: BRAND,
        kind: 'segment',
        name: 'De Puebla',
        definition: def({ field: 'attr', key: 'ciudad', op: 'eq', value: 'Puebla' }),
      },
      'POST',
      201,
    )
  ).audience;
  assert.equal(
    city.memberCount,
    count(
      "SELECT count(*) n FROM contact_attribute_values v JOIN contact_attributes a ON a.id=v.attribute_id WHERE a.key='ciudad' AND v.value='Puebla'",
    ),
  );
  const fields = (await call('/api/audiences/fields?brand=globalvet', admin)).fields;
  assert.ok(fields.some(f => f.name === 'attr' && f.key === 'ciudad'));
  t.diagnostic(`tiempos con ${N} contactos: ${JSON.stringify(timings)}`);
});

test('servidor real: importar a una lista dos veces no duplica, y una campaña toma la audiencia como público', async t => {
  const { call, reg, admin, db } = await lab(t);
  const rows = 300;
  const lines = [['Name', 'CountryCode', 'Phone']];
  for (let i = 1; i <= rows; i++) lines.push([`Persona ${i}`, '52', String(5520000000 + i)]);
  const csv = CSV_BOM + lines.map(cells => cells.join(',')).join('\r\n') + '\r\n';

  const importOnce = async list => {
    const uploaded = (
      await call(
        `/api/contact-import/uploads?brand=globalvet&name=lista.csv&clientRef=${randomUUID()}`,
        admin,
        csv,
        'POST',
        201,
      )
    ).import;
    assert.ok(Array.isArray(uploaded.lists), 'el asistente ofrece las listas');
    const mapped = (
      await call(
        `/api/contact-import/${uploaded.id}/mapping`,
        admin,
        { expectedRevision: uploaded.revision, targets: uploaded.suggested.targets, options: { list } },
        'PUT',
      )
    ).import;
    assert.ok(mapped.options.list);
    await call(
      `/api/contact-import/${uploaded.id}/validate`,
      admin,
      { expectedRevision: mapped.revision, clientRef: randomUUID() },
      'POST',
      202,
    );
    await until(
      async () => (await call(`/api/contact-import/${uploaded.id}`, admin)).import.state === 'validated',
      'vista previa',
      { ms: 60_000 },
    );
    await call(
      `/api/contact-import/${uploaded.id}/apply`,
      admin,
      { expectedRevision: mapped.revision, clientRef: randomUUID() },
      'POST',
      202,
    );
    return until(
      async () => {
        const current = (await call(`/api/contact-import/${uploaded.id}`, admin)).import;
        return current.state === 'done' ? current : null;
      },
      'importación',
      { ms: 60_000 },
    );
  };
  // Una lista nueva que se crea al importar.
  const first = await importOnce({ name: 'Importados de prueba' });
  assert.equal(first.report.totals.created, rows);
  assert.equal(first.report.list.memberCount, rows);
  const listId = first.report.list.audienceId;
  const list = (await call(`/api/audiences/${listId}`, admin)).audience;
  assert.equal(list.source, 'import');
  assert.equal(list.memberCount, rows);
  // Otra vez el mismo archivo a la misma lista: cero cambios y nadie repetido.
  const second = await importOnce({ audienceId: listId });
  assert.equal(second.report.totals.unchanged, rows);
  assert.equal((await call(`/api/audiences/${listId}`, admin)).audience.memberCount, rows);
  assert.equal(db().prepare('SELECT count(*) n FROM audience_members WHERE audience_id=?').get(listId).n, rows);
  // Un nombre ya usado, un nombre vacío o una lista de otra marca se rechazan al guardar el mapeo.
  const other = (
    await call(
      `/api/contact-import/uploads?brand=globalvet&name=otra.csv&clientRef=${randomUUID()}`,
      admin,
      csv,
      'POST',
      201,
    )
  ).import;
  const foreign = (await call('/api/audiences', admin, { brandId: OTHER, kind: 'list', name: 'Ajena' }, 'POST', 201))
    .audience;
  for (const [list, status] of [
    [{ name: 'importados de prueba' }, 409],
    [{ name: '   ' }, 400],
    [{ audienceId: foreign.id }, 404],
  ])
    await call(
      `/api/contact-import/${other.id}/mapping`,
      admin,
      { expectedRevision: other.revision, targets: other.suggested.targets, options: { list } },
      'PUT',
      status,
    );

  // Campañas de catálogo: una audiencia como público, y la lista de exclusión se resta siempre.
  const people = {};
  for (const u of ['ana', 'beto', 'carla']) {
    people[u] = (await reg(u)).cookie;
    await call('/api/conversations', people[u], { courseId: 'aves', channel: 'whatsapp' });
  }
  const contactOf = u =>
    db()
      .prepare(
        "SELECT c.id FROM contacts c JOIN users x ON x.id=c.source_user_id WHERE x.username=? AND c.brand_id='globalvet'",
      )
      .get(u).id;
  for (const u of ['ana', 'beto'])
    await call(
      `/api/crm/contacts/${contactOf(u)}/consent`,
      admin,
      { status: 'opted_in', note: 'prueba de audiencias' },
      'PUT',
    );
  const target = (
    await call(
      '/api/audiences',
      admin,
      { brandId: BRAND, kind: 'list', name: 'Público de campaña', contactIds: [contactOf('ana'), contactOf('beto')] },
      'POST',
      201,
    )
  ).audience;
  const template = (await call('/api/catalogue', admin)).templates.find(
    x => x.brand_id === BRAND && x.status === 'approved' && (!x.course_id || x.course_id === 'aves') && !x.edition_id,
  );
  await call(
    '/api/campaigns',
    admin,
    { brandId: BRAND, title: 'Con audiencia', templateId: template.id, segment: { audienceId: randomUUID() } },
    'POST',
    404,
  );
  const campaign = (
    await call(
      '/api/campaigns',
      admin,
      { brandId: BRAND, title: 'Con audiencia', templateId: template.id, segment: { audienceId: target.id } },
      'POST',
      201,
    )
  ).campaign;
  let p = (await call(`/api/campaigns/${campaign.id}/preview`, admin, {})).preview;
  assert.equal(p.total, 2, 'sólo los de la audiencia (carla no está)');
  assert.equal(p.eligible, 2);
  await call(
    '/api/audiences',
    admin,
    { brandId: BRAND, kind: 'list', role: 'suppression', name: 'No molestar', contactIds: [contactOf('beto')] },
    'POST',
    201,
  );
  p = (await call(`/api/campaigns/${campaign.id}/preview`, admin, {})).preview;
  assert.equal(p.eligible, 1);
  assert.deepEqual(Object.fromEntries(p.excluded.map(e => [e.reason, e.count])), { suppressed: 1 });
  // El público queda guardado en la campaña como audiencia.
  assert.equal(
    db().prepare("SELECT json_extract(segment,'$.audienceId') a FROM campaigns WHERE id=?").get(campaign.id).a,
    target.id,
  );
});
