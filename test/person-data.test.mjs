// Registro de tablas ligadas a la persona y fusión interna de contactos (docs/PLAN_FUSION_Y_DATOS_DE_PERSONA.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { loadModules } from '../server/app/modules.mjs';
import { createContacts } from '../server/contacts.mjs';
import {
  createPersonData,
  registerExistingTables,
  EXEMPT,
  SUBJECT_COLUMNS,
  moveRows,
} from '../server/lib/person-data.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-person-data-'));
  const db = openDatabase(dir);
  migrate(db, { backup: false });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

// Algo que se puede llamar o leer a cualquier profundidad sin hacer nada: lo que los módulos piden a `host` al crearse
// y que esta prueba no necesita (eventos, permisos, tiempo real…).
const inert = new Proxy(function () {}, {
  get: (_, key) => (key === 'then' ? undefined : inert),
  apply: () => inert,
});

// El registro completo, como lo arma el servidor: servicios actuales, contactos y los módulos nuevos de
// server/modules (cada uno registra sus tablas al crearse con host.personData).
async function fullRegistry(db) {
  const personData = createPersonData({ db });
  registerExistingTables(personData, db);
  const contacts = createContacts({
    db,
    crm: inert,
    body: inert,
    json: inert,
    audit: inert,
    broadcast: () => {},
    personData,
  });
  await loadModules({
    dir: resolve('server', 'modules'),
    strict: true,
    test: true,
    log: { error() {} },
    host: {
      db,
      transaction,
      personData,
      fail: (status, message) => Object.assign(new Error(message), { status }),
      access: inert,
      realtime: inert,
      services: inert,
      json: inert,
      body: inert,
      audit: inert,
      broadcast: inert,
      clean: inert,
      rate: inert,
    },
  });
  return { personData, contacts };
}

test('registro: valida nombre, tablas, dueño único y funciones', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const registry = createPersonData({ db });
  const merge = () => ({});
  assert.deepEqual(registry.register({ name: 'uno', tables: ['a_contacts'], merge }), ['a_contacts']);
  assert.throws(() => registry.register({ name: 'uno', tables: ['b'], merge }), /ya registró/);
  assert.throws(() => registry.register({ name: 'dos', tables: ['a_contacts'], merge }), /ya es de «uno»/);
  assert.throws(() => registry.register({ name: 'Mal', tables: ['x'], merge }), /minúsculas/);
  assert.throws(() => registry.register({ name: 'tres', tables: [], merge }), /al menos una tabla/);
  assert.throws(() => registry.register({ name: 'tres', tables: ['x', 'x'], merge }), /dos veces/);
  assert.throws(() => registry.register({ name: 'tres', tables: ['x;drop'], merge }), /no válido/);
  assert.throws(() => registry.register({ name: 'tres', tables: ['otra'] }), /falta merge/);
  assert.throws(() => registry.register({ name: 'tres', tables: ['otra'], merge, erase: 'no' }), /función/);
  assert.equal(registry.owner('a_contacts'), 'uno');
  // El candado ve una tabla con columna de persona que nadie registró, y no ve las demás.
  db.exec('CREATE TABLE a_contacts(contact_id TEXT); CREATE TABLE b_rows(person_id TEXT); CREATE TABLE c_rows(x TEXT)');
  assert.deepEqual(registry.unregistered(), [{ table: 'b_rows', columns: ['person_id'] }]);
  assert.throws(() => moveRows(db, 'x; DROP', 'contact_id', 'a', 'b'), /no válida/);
  assert.throws(() => moveRows(db, 'x', 'name', 'a', 'b'), /no válida/);
});

test('candado: toda tabla con contact_id o person_id tiene dueño en el registro (o un motivo para no tenerlo)', async t => {
  const db = await workspace(t);
  assertSchemaCurrent(db);
  const { personData } = await fullRegistry(db);
  assert.deepEqual(
    personData.unregistered(),
    [],
    'Estas tablas guardan datos de una persona y nadie las registró en personData: una fusión las dejaría huérfanas',
  );
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(row => row.name),
  );
  for (const [table, reason] of Object.entries(EXEMPT)) {
    assert.ok(tables.has(table), `la excepción ${table} ya no existe en el esquema`);
    assert.ok(typeof reason === 'string' && reason.length >= 20, `la excepción ${table} necesita su motivo`);
    assert.equal(personData.owner(table), null, `${table} está registrada y además exceptuada`);
  }
  // Toda tabla registrada existe y tiene alguna columna de persona.
  for (const { name, tables: own } of personData.list())
    for (const table of own) {
      assert.ok(tables.has(table), `«${name}» registró ${table}, que no existe`);
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(c => c.name);
      assert.ok(
        SUBJECT_COLUMNS.some(column => columns.includes(column)),
        `${table} no tiene columna de persona`,
      );
    }
});

// Una fila de cada tabla registrada para un contacto. Se insertan con las claves foráneas apagadas: las demás
// referencias (cursos, conversaciones…) pueden ser inventadas, porque la fusión sólo cambia contact_id y person_id.
// Una tabla nueva registrada con contact_id debe añadir aquí su fila (la prueba lo exige).
const SEEDS = {
  opportunities: (db, c, s) =>
    db
      .prepare(
        "INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,created_at,updated_at) VALUES(?,?,?,?,'nuevo',1,1)",
      )
      .run(randomUUID(), c.id, c.brand, 'curso-' + s),
  internal_notes: (db, c, s) =>
    db
      .prepare('INSERT INTO internal_notes(id,contact_id,brand_id,author_id,text,created_at) VALUES(?,?,?,?,?,1)')
      .run(randomUUID(), c.id, c.brand, 'u-admin', 'Nota ' + s),
  contact_tag_links: (db, c, s) => {
    const link = db.prepare('INSERT INTO contact_tag_links(contact_id,tag_id,created_at) VALUES(?,?,1)');
    link.run(c.id, 'tag-compartida');
    link.run(c.id, 'tag-' + s);
  },
  contact_consent: (db, c, s) =>
    db
      .prepare('INSERT INTO contact_consent(contact_id,brand_id,status,source,updated_at) VALUES(?,?,?,?,1)')
      .run(c.id, c.brand, s === 'merged' ? 'opted_out' : 'opted_in', 'staff'),
  contact_consent_events: (db, c, s) =>
    db
      .prepare('INSERT INTO contact_consent_events(contact_id,brand_id,status,source,created_at) VALUES(?,?,?,?,1)')
      .run(c.id, c.brand, s === 'merged' ? 'opted_out' : 'opted_in', 'staff'),
  orders: (db, c, s) =>
    db
      .prepare(
        "INSERT INTO orders(id,reference,brand_id,contact_id,opportunity_id,conversation_id,course_id,edition_id,amount_cents,currency,status,source,expires_at,created_at,updated_at) VALUES(?,?,?,?,'o','cv','k','e',100,'MXN','paid','agent',1,1,1)",
      )
      .run('order-' + s, 'REF-' + s, c.brand, c.id),
  enrollments: (db, c, s) =>
    db
      .prepare(
        "INSERT INTO enrollments(id,order_id,brand_id,contact_id,opportunity_id,course_id,edition_id,status,created_at) VALUES(?,?,?,?,'o','k','e','enrolled',1)",
      )
      .run('enr-' + s, 'order-' + s, c.brand, c.id),
  ledger_entries: (db, c, s) =>
    db
      .prepare(
        "INSERT INTO ledger_entries(id,kind,brand_id,contact_id,amount_cents,currency,occurred_at,period_day,dedupe_key,created_at) VALUES(?,'sale',?,?,100,'MXN',1,'2026-11-13',?,1)",
      )
      .run(randomUUID(), c.brand, c.id, 'ledger-' + s),
  certificates: (db, c, s) =>
    db
      .prepare(
        "INSERT INTO certificates(id,folio,verify_code,brand_id,enrollment_id,person_id,contact_id,course_id,edition_id,holder_name,course_title,edition_name,brand_name,sessions_held,sessions_attended,attendance_pct,issued_at,source,status,created_at) VALUES(?,?,'v',?,?,?,?,'k','e','N','C','E','M',1,1,100,1,'manual','issued',1)",
      )
      .run(randomUUID(), 'FOLIO-' + s, c.brand, 'enr-' + s, c.person, c.id),
  legacy_records: (db, c, s) =>
    db
      .prepare(
        "INSERT INTO legacy_records(id,batch_id,brand_id,kind,external_id,person_id,contact_id,created_at) VALUES(?,'b',?,'alumno',?,?,?,1)",
      )
      .run(randomUUID(), c.brand, 'ext-' + s, c.person, c.id),
  survey_invites: (db, c, s) =>
    db
      .prepare(
        'INSERT INTO survey_invites(token,survey_id,brand_id,enrollment_id,contact_id,sent_at) VALUES(?,?,?,?,?,1)',
      )
      .run(randomUUID(), 'survey', c.brand, 'enr-' + s, c.id),
  campaign_recipients: (db, c, s) => {
    const add = db.prepare(
      "INSERT INTO campaign_recipients(campaign_id,contact_id,conversation_id,step_id,created_at) VALUES(?,?,'cv',?,1)",
    );
    add.run('campaign-shared', c.id, 'step-shared-' + s);
    add.run('campaign-' + s, c.id, 'step-' + s);
  },
  // Atributos: los dos tienen «ciudad» (gana la del que queda) y sólo el absorbido tiene «curso_origen» (se hereda).
  contact_attribute_values: (db, c, s) => {
    const attribute = key =>
      db.prepare('SELECT id FROM contact_attributes WHERE brand_id=? AND key=?').get(c.brand, key).id;
    const set = db.prepare(
      "INSERT INTO contact_attribute_values(contact_id,attribute_id,brand_id,value,source,updated_at) VALUES(?,?,?,?,'staff',1)",
    );
    set.run(c.id, attribute('ciudad'), c.brand, s === 'keep' ? 'Puebla' : 'Toluca');
    if (s === 'merged') set.run(c.id, attribute('curso_origen'), c.brand, 'Aves');
  },
  contact_attribute_events: (db, c, s) =>
    db
      .prepare(
        "INSERT INTO contact_attribute_events(brand_id,contact_id,key,new_value,source,created_at) VALUES(?,?,'ciudad',?,'staff',1)",
      )
      .run(c.brand, c.id, s),
  contact_attribute_requests: (db, c, s) =>
    db
      .prepare(
        "INSERT INTO contact_attribute_requests(client_ref,brand_id,contact_id,response,created_at) VALUES(?,?,?,'{}',1)",
      )
      .run('ref-' + s, c.brand, c.id),
  // Audiencias: los dos están en una lista compartida (queda una sola fila) y cada uno en la suya.
  audience_members: (db, c, s) => {
    const list = db.prepare(
      "INSERT OR IGNORE INTO audiences(id,brand_id,kind,name,name_key,created_at,updated_at) VALUES(?,?,'list',?,?,1,1)",
    );
    list.run('aud-shared', c.brand, 'Compartida', 'compartida');
    list.run('aud-' + s, c.brand, 'Lista ' + s, 'lista ' + s);
    const add = db.prepare('INSERT INTO audience_members(audience_id,contact_id,added_at) VALUES(?,?,1)');
    add.run('aud-shared', c.id);
    add.run('aud-' + s, c.id);
  },
  // Importación de contactos: el resultado de la fila que creó o actualizó a cada uno.
  contact_import_rows: (db, c, s) => {
    db.prepare(
      "INSERT OR IGNORE INTO contact_imports(id,brand_id,filename,sha256,storage_name,size,encoding,delimiter,created_at,updated_at) VALUES('import-1',?,'contactos.csv','x','import-1.csv',1,'utf-8',',',1,1)",
    ).run(c.brand);
    db.prepare(
      "INSERT INTO contact_import_rows(import_id,phase,row,line,action,contact_id) VALUES('import-1','apply',?,?,'created',?)",
    ).run(s === 'keep' ? 1 : 2, s === 'keep' ? 2 : 3, c.id);
  },
};

function seedWorld(db, personData) {
  const brand = 'globalvet';
  const contact = (name, person) => {
    const id = randomUUID();
    db.prepare('INSERT INTO persons(id,name,created_at,updated_at) VALUES(?,?,1,1)').run(person, name);
    db.prepare(
      'INSERT INTO contacts(id,brand_id,name,phone,email,created_at,updated_at,persona_id) VALUES(?,?,?,?,?,1,1,?)',
    ).run(id, brand, name, name === 'Absorbido' ? '+525512345678' : '', '', person);
    return { id, brand, person };
  };
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u-admin','admin.prueba','Admin','x','admin',990001,1,1)",
  ).run();
  for (const tag of ['tag-compartida', 'tag-keep', 'tag-merged'])
    db.prepare('INSERT INTO contact_tags(id,brand_id,name,name_key,created_at) VALUES(?,?,?,?,1)').run(
      tag,
      brand,
      tag,
      tag,
    );
  for (const key of ['ciudad', 'curso_origen'])
    db.prepare(
      "INSERT INTO contact_attributes(id,brand_id,key,label,type,created_at,updated_at) VALUES(?,?,?,?,'text',1,1)",
    ).run(randomUUID(), brand, key, key);
  db.exec('PRAGMA foreign_keys=OFF');
  const keep = contact('Principal', 'person-keep');
  const merged = contact('Absorbido', 'person-merged');
  const seeded = new Set();
  for (const { tables } of personData.list())
    for (const table of tables) {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(c => c.name);
      if (!columns.includes('contact_id')) continue;
      assert.ok(SEEDS[table], `Falta la fila de ejemplo de ${table} en SEEDS (test/person-data.test.mjs)`);
      SEEDS[table](db, keep, 'keep');
      SEEDS[table](db, merged, 'merged');
      seeded.add(table);
    }
  db.exec('PRAGMA foreign_keys=ON');
  return { keep, merged, seeded };
}

// Violaciones de claves foráneas que apuntan a contactos o personas (las demás referencias de las filas de ejemplo
// son inventadas a propósito).
const brokenLinks = db =>
  db
    .prepare('PRAGMA foreign_key_check')
    .all()
    .filter(row => row.parent === 'contacts' || row.parent === 'persons');

test('fusión interna: mueve las filas de TODAS las tablas registradas, sin huérfanos, y se puede repetir', async t => {
  const db = await workspace(t);
  const { personData, contacts } = await fullRegistry(db);
  const { keep, merged, seeded } = seedWorld(db, personData);
  assert.ok(seeded.size >= 12, 'se sembraron filas en cada tabla registrada con contact_id');
  const before = personData.count(merged.id);
  assert.deepEqual(Object.keys(before).sort(), [...seeded].sort());

  const admin = { id: 'u-admin' };
  const result = transaction(db, () => contacts.mergeInternal(keep.id, merged.id, { user: admin }));
  assert.equal(result.keepId, keep.id);
  assert.deepEqual(personData.count(merged.id), {}, 'ninguna tabla registrada señala al contacto absorbido');
  assert.equal(db.prepare('SELECT 1 FROM contacts WHERE id=?').get(merged.id), undefined);
  assert.deepEqual(brokenLinks(db), []);
  for (const table of seeded)
    if (table !== 'contact_consent' && table !== 'contact_attribute_values')
      assert.ok(personData.count(keep.id)[table] >= 2, `${table} quedó con las filas de los dos`);
  // Reglas propias: etiquetas sin repetir, consentimiento más restrictivo, una fila por campaña, teléfono heredado.
  assert.equal(db.prepare('SELECT count(*) n FROM contact_tag_links WHERE contact_id=?').get(keep.id).n, 3);
  assert.equal(db.prepare('SELECT status FROM contact_consent WHERE contact_id=?').get(keep.id).status, 'opted_out');
  assert.deepEqual(
    db
      .prepare('SELECT campaign_id FROM campaign_recipients WHERE contact_id=? ORDER BY campaign_id')
      .all(keep.id)
      .map(r => r.campaign_id),
    ['campaign-keep', 'campaign-merged', 'campaign-shared'],
  );
  // Atributos: gana el valor del que queda y lo que le faltaba llega del absorbido.
  assert.deepEqual(
    db
      .prepare(
        'SELECT a.key,v.value FROM contact_attribute_values v JOIN contact_attributes a ON a.id=v.attribute_id WHERE v.contact_id=? ORDER BY a.key',
      )
      .all(keep.id)
      .map(row => `${row.key}=${row.value}`),
    ['ciudad=Puebla', 'curso_origen=Aves'],
  );
  assert.equal(db.prepare('SELECT phone FROM contacts WHERE id=?').get(keep.id).phone, '+525512345678');
  const snapshot = db
    .prepare('SELECT moved FROM contact_merges WHERE kept_id=? AND merged_id=?')
    .all(keep.id, merged.id);
  assert.equal(snapshot.length, 1);
  assert.equal(JSON.parse(snapshot[0].moved).linked.payments.orders, 1);
  assert.ok(
    db.prepare("SELECT 1 FROM internal_notes WHERE contact_id=? AND text LIKE 'Fusión de contactos%'").get(keep.id),
  );

  // Repetir con el contacto ya absorbido devuelve la fusión anterior y no escribe nada.
  const again = transaction(db, () => contacts.mergeInternal(keep.id, merged.id, { user: admin }));
  assert.equal(again.repeated, true);
  assert.deepEqual(again.moved, result.moved);
  assert.equal(
    db.prepare('SELECT count(*) n FROM contact_merges WHERE kept_id=? AND merged_id=?').get(keep.id, merged.id).n,
    1,
  );

  // Fusión de personas: certificados e históricos pasan a la persona que queda y nada señala a la absorbida.
  db.prepare('INSERT INTO persons(id,name,created_at,updated_at) VALUES(?,?,1,1)').run('person-extra', 'Extra');
  db.prepare('UPDATE certificates SET person_id=? WHERE person_id=?').run('person-extra', 'person-merged');
  db.prepare('UPDATE legacy_records SET person_id=? WHERE person_id=?').run('person-extra', 'person-merged');
  const people = transaction(db, () => personData.mergePersons('person-keep', 'person-extra'));
  assert.deepEqual(people, { certificates: { certificates: 1 }, legacy: { legacy_records: 1 } });
  assert.deepEqual(personData.count('person-extra', 'person_id'), {});
});

test('fusión interna: misma marca, contactos distintos, reglas de seguridad y nada a medias', async t => {
  const db = await workspace(t);
  const { personData, contacts } = await fullRegistry(db);
  const { keep, merged } = seedWorld(db, personData);
  const other = randomUUID();
  db.prepare("INSERT INTO contacts(id,brand_id,name,created_at,updated_at) VALUES(?,'odonteck','Otra marca',1,1)").run(
    other,
  );
  const attempt = (a, b) => () => transaction(db, () => contacts.mergeInternal(a, b, { user: { id: 'u-admin' } }));
  assert.throws(attempt(keep.id, other), error => error.status === 400 && /misma marca/.test(error.message));
  assert.throws(attempt(keep.id, keep.id), error => error.status === 400);
  assert.throws(attempt(keep.id, 'no-existe'), error => error.status === 404);
  // Interés activo en el mismo curso: no se fusiona y nada cambia.
  db.exec('PRAGMA foreign_keys=OFF');
  for (const c of [keep, merged])
    db.prepare(
      "INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,created_at,updated_at) VALUES(?,?,?,'mismo','nuevo',1,1)",
    ).run(randomUUID(), c.id, c.brand);
  db.exec('PRAGMA foreign_keys=ON');
  const before = personData.count(merged.id);
  assert.throws(attempt(keep.id, merged.id), error => error.status === 409 && /mismo curso/.test(error.message));
  assert.deepEqual(personData.count(merged.id), before);
  assert.ok(db.prepare('SELECT 1 FROM contacts WHERE id=?').get(merged.id));

  // Una tabla registrada cuyo módulo no mueve sus filas: la fusión se deshace en lugar de dejar huérfanos.
  db.prepare("DELETE FROM opportunities WHERE course_id='mismo'").run();
  const base = personData.count(merged.id);
  db.exec('CREATE TABLE stray_rows(contact_id TEXT)');
  db.prepare('INSERT INTO stray_rows VALUES(?)').run(merged.id);
  personData.register({ name: 'olvidadizo', tables: ['stray_rows'], merge: () => ({}) });
  assert.throws(
    attempt(keep.id, merged.id),
    error => error.code === 'merge_incomplete' && /stray_rows/.test(error.message),
  );
  assert.ok(db.prepare('SELECT 1 FROM contacts WHERE id=?').get(merged.id), 'la transacción se deshizo');
  assert.deepEqual(personData.count(merged.id), { ...base, stray_rows: 1 });
});

test('fusión manual por la API: usa la fusión interna y la vista previa cuenta lo que se moverá', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-person-data-http-'));
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
    assert.equal(response.status, expected, path + ': ' + JSON.stringify(data));
    return { ...data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const admin = await call('/api/auth/register', '', {
    username: 'admin',
    name: 'Admin Prueba',
    password: 'Password-person-data-2026!',
    inviteCode: code,
  });
  const contact = async name =>
    (await call('/api/crm/contacts', admin.cookie, { brandId: 'globalvet', name }, 'POST', 201)).id;
  const keep = await contact('Fusión API Principal');
  const dup = await contact('Fusión API Duplicado');
  const db = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  db.exec('PRAGMA foreign_keys=OFF');
  db.prepare(
    "INSERT INTO legacy_records(id,batch_id,brand_id,kind,external_id,contact_id,created_at) VALUES(?,'lote','globalvet','alumno','api-1',?,1)",
  ).run(randomUUID(), dup);
  db.close();
  const preview = (await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: keep, mergeId: dup })).plan;
  assert.equal(preview.linked.legacy_records, 1);
  await call('/api/crm/contacts/merge', admin.cookie, {
    keepId: keep,
    mergeId: dup,
    previewToken: preview.previewToken,
  });
  const check = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  try {
    assert.equal(
      check.prepare('SELECT contact_id FROM legacy_records WHERE external_id=?').get('api-1').contact_id,
      keep,
    );
  } finally {
    check.close();
  }
});
