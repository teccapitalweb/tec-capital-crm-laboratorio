import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { openDatabase, transaction } from '../server/database.mjs';
import { runLadder } from '../server/migrations/ladder.mjs';
import { migrate, NAMED } from '../server/migrations/index.mjs';
import { phoneKey } from '../server/lib/identity-keys.mjs';
import { searchKey, searchKeySql } from '../server/lib/search-key.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { openDb, until } from './helpers/crm.mjs';

// Contactos a escala (docs/PLAN_CONTACTOS_A_ESCALA.md): módulo `directory` (/api/contacts), migración
// contacts/0001-search y `parts=` en /api/crm. Todos los nombres, teléfonos y correos son inventados.

const MIGRATION = 'contacts/0001-search';
const T0 = Date.UTC(2026, 0, 1);
const PASSWORD = 'Password-contactos-2026!';
const PAGE_BUDGET_MS = 750; // holgado: una página de 50 sobre 5 000 contactos tarda unos pocos milisegundos
const rows = (db, sql, ...args) =>
  db
    .prepare(sql)
    .all(...args)
    .map(row => ({ ...row }));
const bytes = (a, b) => Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));

async function workspace(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const pending = [];
  t.after(async () => {
    for (const task of pending.reverse()) {
      try {
        await task();
      } catch {
        // ya estaba cerrado
      }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, later: task => pending.push(task) };
}

// ---------------------------------------------------------------------------------------------------------------
// A. La clave de búsqueda: la misma en SQL y en JavaScript
// ---------------------------------------------------------------------------------------------------------------

test('la clave de búsqueda es la misma en SQLite y en JavaScript', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const samples = [
      'José Ñúñez',
      'ÁNGEL Óscar',
      'Ünïcode Çedilla',
      'Renée Ålborg',
      'mezcla 123 @Correo.MX',
      '',
      '   ',
    ];
    for (const text of samples)
      assert.equal(db.prepare(`SELECT ${searchKeySql('x')} k FROM (SELECT ? x)`).get(text).k, searchKey(text), text);
    assert.equal(searchKey('José Ñúñez'), 'jose nunez');
    assert.throws(() => searchKeySql("x'); DROP TABLE y; --"), TypeError);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// B. La migración sobre una base publicada
// ---------------------------------------------------------------------------------------------------------------

// Una base como la de hoy (escalera 41, sin migraciones con nombre) con contactos, intereses y conversaciones.
function seedPublished(db) {
  db.prepare(
    'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
  ).run('u-cliente', 'cliente', 'Cliente', 'sin-acceso', 'customer', 700001, T0, T0);
  const contact = db.prepare(
    'INSERT INTO contacts(id,brand_id,source_user_id,name,phone,email,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
  );
  contact.run('c-1', 'globalvet', null, 'José Pérez', '5512345678', 'JOSE@correo.mx', 'manual', T0, T0 + 10);
  contact.run('c-2', 'globalvet', 'u-cliente', 'Ana Núñez', '', '', 'whatsapp', T0 + 1, T0 + 1);
  contact.run('c-3', 'odonteck', null, 'Óscar Ruiz', '', 'oscar@correo.mx', 'manual', T0 + 2, T0 + 2);
  db.prepare(
    'INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
  ).run('o-1', 'c-1', 'globalvet', 'aves', 'interesado', T0 + 5, T0 + 500);
  db.prepare(
    'INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
  ).run('v-1', 'u-cliente', 'globalvet', 'aves', 'whatsapp', T0 + 1, T0 + 900);
}

test('migración contacts/0001: una base poblada gana su tabla de búsqueda y repetir no cambia nada', async t => {
  const { dir, later } = await workspace(t, 'crm-directory-up-');
  const db = openDatabase(dir);
  later(() => db.close());
  runLadder(db);
  seedPublished(db);
  const before = rows(db, 'SELECT * FROM contacts ORDER BY id');

  const result = migrate(db, { backup: false });
  assert.ok(result.applied.includes(MIGRATION));
  assertSchemaCurrent(db);
  assert.deepEqual(
    rows(db, 'SELECT contact_id,brand_id,name_key,email_key,created_at,activity_at,rev FROM contact_search ORDER BY 1'),
    [
      // la actividad es la mayor fecha entre el contacto, sus intereses y sus conversaciones
      {
        contact_id: 'c-1',
        brand_id: 'globalvet',
        name_key: 'jose perez',
        email_key: 'jose@correo.mx',
        created_at: T0,
        activity_at: T0 + 500,
        rev: 0,
      },
      {
        contact_id: 'c-2',
        brand_id: 'globalvet',
        name_key: 'ana nunez',
        email_key: '',
        created_at: T0 + 1,
        activity_at: T0 + 900,
        rev: 0,
      },
      {
        contact_id: 'c-3',
        brand_id: 'odonteck',
        name_key: 'oscar ruiz',
        email_key: 'oscar@correo.mx',
        created_at: T0 + 2,
        activity_at: T0 + 2,
        rev: 0,
      },
    ],
  );
  // los contactos no cambian: sólo se añadió lo de al lado
  assert.deepEqual(
    rows(db, 'SELECT * FROM contacts ORDER BY id').map(c =>
      Object.fromEntries(Object.keys(before[0]).map(k => [k, c[k]])),
    ),
    before,
  );

  // segunda pasada: nada pendiente, mismos datos y mismo esquema
  const shape = schemaShape(db);
  const data = rows(db, 'SELECT * FROM contact_search ORDER BY contact_id');
  assert.deepEqual(migrate(db, { backup: false }).applied, []);
  assert.deepEqual(rows(db, 'SELECT * FROM contact_search ORDER BY contact_id'), data);
  assert.deepEqual(schemaShape(db), shape);

  // los disparadores la mantienen: alta, edición, etiqueta, interés, conversación y baja
  const revOf = id => db.prepare('SELECT rev FROM contact_search WHERE contact_id=?').get(id)?.rev;
  db.prepare(
    'INSERT INTO contacts(id,brand_id,name,phone,phone_key,email,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run('c-4', 'globalvet', 'Ínés Ñandú', '', '', '', T0 + 3, T0 + 3);
  assert.equal(db.prepare("SELECT name_key FROM contact_search WHERE contact_id='c-4'").get().name_key, 'ines nandu');
  const r1 = revOf('c-4');
  db.prepare("UPDATE contacts SET name='Inés Cambió', updated_at=? WHERE id='c-4'").run(T0 + 50);
  assert.equal(db.prepare("SELECT name_key FROM contact_search WHERE contact_id='c-4'").get().name_key, 'ines cambio');
  assert.ok(revOf('c-4') > r1, 'cada cambio sube el número de cambio');
  db.prepare(
    "INSERT INTO contact_tags(id,brand_id,name,name_key,created_at) VALUES('t-1','globalvet','VIP','vip',?)",
  ).run(T0);
  const r2 = revOf('c-4');
  db.prepare("INSERT INTO contact_tag_links(contact_id,tag_id,created_at) VALUES('c-4','t-1',?)").run(T0);
  assert.ok(revOf('c-4') > r2);
  db.prepare("UPDATE conversations SET updated_at=? WHERE id='v-1'").run(T0 + 5000);
  assert.equal(
    db.prepare("SELECT activity_at FROM contact_search WHERE contact_id='c-2'").get().activity_at,
    T0 + 5000,
  );
  db.prepare("UPDATE opportunities SET updated_at=? WHERE id='o-1'").run(T0 + 7000);
  assert.equal(
    db.prepare("SELECT activity_at FROM contact_search WHERE contact_id='c-1'").get().activity_at,
    T0 + 7000,
  );
  db.prepare("DELETE FROM contact_tag_links WHERE contact_id='c-4'").run();
  db.prepare("DELETE FROM contacts WHERE id='c-4'").run();
  assert.equal(revOf('c-4'), undefined, 'la baja quita su fila');

  // sólo aditiva: una sentencia del código anterior sigue funcionando y la fila nace igual
  db.prepare('INSERT INTO contacts(id,brand_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(
    'c-anterior',
    'globalvet',
    'Código Anterior',
    T0,
    T0,
  );
  assert.equal(revOf('c-anterior') > 0, true);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
});

test('una base nueva queda con el mismo esquema que una actualizada', async t => {
  const upgraded = await workspace(t, 'crm-directory-a-');
  const fresh = await workspace(t, 'crm-directory-b-');
  const a = openDatabase(upgraded.dir);
  upgraded.later(() => a.close());
  runLadder(a);
  seedPublished(a);
  migrate(a, { backup: false });
  const b = openDatabase(fresh.dir);
  fresh.later(() => b.close());
  migrate(b, { backup: false });
  assertSchemaCurrent(b);
  assert.deepEqual(schemaShape(b), schemaShape(a));
  assert.ok(NAMED.some(m => m.name === MIGRATION));
});

// ---------------------------------------------------------------------------------------------------------------
// C. El servidor real con 5 000 contactos
// ---------------------------------------------------------------------------------------------------------------

const FIRST = ['José', 'Ana', 'María', 'Óscar', 'Lucía', 'Ángel', 'Sofía', 'Martín', 'Renée', 'Iñaki', 'Héctor'];
const LAST = ['Pérez', 'Núñez', 'García', 'López', 'Hernández', 'Ruiz', 'Díaz', 'Muñoz', 'Álvarez', 'Gómez'];
const STAGES = ['nuevo', 'interesado', 'inscripcion', 'ganada', 'perdida'];
// Cinco formas de escribir el mismo tipo de número, y uno de cada cinco sin teléfono.
const phoneOf = i => {
  const eight = String(20_000_000 + i);
  const [a, b] = [eight.slice(0, 4), eight.slice(4)];
  return ['', `55${eight}`, `+52 55 ${a} ${b}`, `+52155${eight}`, `(55) ${a}-${b}`][i % 5];
};

// Siembra por SQL: 5 000 contactos de GlobalVet (con nombres repetidos a propósito, para probar el desempate), 200 de
// OdonTeck, etiquetas, consentimientos e intereses. Los disparadores llenan contact_search.
function seed(db, ownerId) {
  const contact = db.prepare(
    'INSERT INTO contacts(id,brand_id,name,phone,phone_key,email,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
  );
  const link = db.prepare('INSERT INTO contact_tag_links(contact_id,tag_id,created_at) VALUES(?,?,?)');
  const consent = db.prepare(
    "INSERT INTO contact_consent(contact_id,brand_id,status,source,note,updated_at) VALUES(?,?,?,'prueba','',?)",
  );
  const interest = db.prepare(
    'INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  );
  transaction(db, () => {
    db.prepare(
      "INSERT INTO contact_tags(id,brand_id,name,name_key,created_at) VALUES('tag-vip','globalvet','VIP','vip',?)",
    ).run(T0);
    for (let i = 0; i < 5000; i++) {
      const id = 'gv-' + String(i).padStart(5, '0');
      const phone = phoneOf(i);
      const at = T0 + i * 60_000;
      const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`;
      contact.run(
        id,
        'globalvet',
        name,
        phone,
        phoneKey(phone) ?? '',
        i % 3 ? `persona${i}@correo.mx` : '',
        'manual',
        at,
        at,
      );
      if (i % 10 === 0) link.run(id, 'tag-vip', at);
      if (i % 4 === 0) consent.run(id, 'globalvet', 'opted_in', at);
      else if (i % 13 === 0) consent.run(id, 'globalvet', 'opted_out', at);
      if (i % 25 === 0)
        interest.run('op-' + i, id, 'globalvet', 'aves', STAGES[(i / 25) % 5], i % 50 ? null : ownerId, at, at);
    }
    for (let i = 0; i < 200; i++) {
      const at = T0 + i * 60_000;
      contact.run('od-' + String(i).padStart(4, '0'), 'odonteck', `Paciente Odonto ${i}`, '', '', '', 'manual', at, at);
    }
    // una persona fácil de encontrar por teléfono, nombre y correo
    const phone = '+52 55 4321 9876';
    contact.run(
      'gv-buscada',
      'globalvet',
      'Fernanda Zúñiga',
      phone,
      phoneKey(phone),
      'fer.zuniga@correo.mx',
      'manual',
      T0,
      T0,
    );
  });
}

async function lab(t) {
  const { dir, later } = await workspace(t, 'crm-directory-');
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code } });
  later(() => server.stop());
  const origin = server.origin;
  async function call(path, cookie = '', { body, method, expected = 200 } = {}) {
    const response = await fetch(origin + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${path}: ${text.slice(0, 300)}`);
    assert.equal(text.includes('phone_key'), false, 'la clave de teléfono no sale del servidor');
    return { ...JSON.parse(text), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const admin = await call('/api/auth/register', '', {
    body: { username: 'admin', name: 'Administración', password: PASSWORD, inviteCode: code },
  });
  const agent = await call('/api/auth/register', '', {
    body: { username: 'asesora', name: 'Asesora', password: PASSWORD },
  });
  const invite = await call('/api/team/invites', admin.cookie, {
    body: { username: 'asesora', brandIds: ['globalvet'] },
    expected: 201,
  });
  await call('/api/team/accept', agent.cookie, { body: { token: invite.token } });
  const customer = await call('/api/auth/register', '', {
    body: { username: 'cliente', name: 'Cliente', password: PASSWORD },
  });
  const db = openDb(dir);
  later(() => db.close());
  assertSchemaCurrent(db);
  seed(db, agent.user.id);
  return {
    origin,
    server,
    db,
    call,
    admin: admin.cookie,
    agent: agent.cookie,
    agentId: agent.user.id,
    customer: customer.cookie,
  };
}

const list = (params = {}) => '/api/contacts?' + new URLSearchParams(params).toString();

// Recorre todas las páginas de una búsqueda y mide cuánto tarda cada una.
async function walk(call, cookie, params) {
  const ids = [];
  const times = [];
  let cursor = null;
  let total = null;
  for (let page = 0; page < 500; page++) {
    const started = performance.now();
    const result = await call(list({ ...params, ...(cursor ? { cursor } : {}) }), cookie);
    times.push(performance.now() - started);
    if (!cursor) total = result.total;
    else assert.equal(result.total, undefined, 'el total sólo va con la primera página');
    assert.ok(result.contacts.length <= 50);
    ids.push(...result.contacts.map(c => c.id));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return { ids, times, total };
}

test('lista de contactos a escala: permisos, alcance, paginación, búsqueda, filtros, orden, cursor y avisos', async t => {
  const env = await lab(t);
  const { call, db, admin, agent, customer } = env;

  await t.test('permisos y alcance por marca', async () => {
    await call(list({ brand: 'all' }), '', { expected: 401 });
    const denied = await call(list({ brand: 'all' }), customer, { expected: 403 });
    assert.equal(denied.code, 'permission_denied');
    assert.equal((await call('/api/contacts', admin, { expected: 400 })).field, 'brand', 'la marca es obligatoria');
    // la asesora sólo tiene GlobalVet: OdonTeck no existe para ella
    assert.equal((await call(list({ brand: 'odonteck' }), agent, { expected: 404 })).code, 'not_found');
    const mine = await call(list({ brand: 'all', limit: 50 }), agent);
    assert.equal(mine.total.n, 5001);
    assert.ok(mine.contacts.every(c => c.brandId === 'globalvet'));
    assert.equal((await call(list({ brand: 'all', q: 'Paciente Odonto' }), agent)).contacts.length, 0);
    await call('/api/contacts/od-0001', agent, { expected: 404 });
    await call('/api/contacts/od-0001?brand=globalvet', agent, { expected: 404 });
    assert.equal((await call('/api/contacts/od-0001', admin)).contact.brandId, 'odonteck');
    const options = await call('/api/contacts/filters?brand=all', agent);
    assert.deepEqual(
      options.brands.map(b => b.id),
      ['globalvet'],
    );
    assert.ok(options.courses.every(c => c.brandId === 'globalvet'));
    // administración ve las dos marcas
    assert.equal((await call(list({ brand: 'all' }), admin)).total.n, 5201);
    // sólo lectura: escribir aquí no existe
    await call('/api/contacts', admin, { body: { name: 'x' }, expected: 404 });
  });

  await t.test('paginación estable sobre 5 000 contactos, dentro del presupuesto de tiempo', async () => {
    const expected = rows(db, "SELECT id,name FROM contacts WHERE brand_id='globalvet'")
      .map(c => ({ id: c.id, key: searchKey(c.name) }))
      .sort((a, b) => bytes(a.key, b.key) || bytes(a.id, b.id))
      .map(c => c.id);
    const byName = await walk(call, agent, { brand: 'globalvet', sort: 'name', dir: 'asc' });
    assert.deepEqual(byName.total, { n: 5001, capped: false });
    assert.equal(new Set(byName.ids).size, byName.ids.length, 'ninguna fila se repite');
    assert.deepEqual(byName.ids, expected, 'el orden por nombre es el de la clave sin acentos, desempatado por id');
    const slowest = Math.max(...byName.times);
    assert.ok(slowest < PAGE_BUDGET_MS, `la página más lenta tardó ${Math.round(slowest)} ms`);

    // varias marcas a la vez: la mezcla respeta el orden y no pierde ni repite filas
    const created = await walk(call, admin, { brand: 'all', sort: 'created', dir: 'desc' });
    const all = rows(db, 'SELECT id,created_at FROM contacts')
      .sort((a, b) => b.created_at - a.created_at || bytes(b.id, a.id))
      .map(c => c.id);
    assert.deepEqual(created.ids, all);

    // una fila nueva mientras se recorre no repite ni salta las que ya estaban
    const first = await call(list({ brand: 'globalvet', sort: 'created', dir: 'asc' }), agent);
    await call('/api/crm/contacts', agent, {
      body: { brandId: 'globalvet', name: 'Alta Durante La Lectura' },
      expected: 201,
    });
    const rest = await walk(call, agent, { brand: 'globalvet', sort: 'created', dir: 'asc', cursor: first.nextCursor });
    const seen = [...first.contacts.map(c => c.id), ...rest.ids];
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, 5002);
  });

  await t.test('búsqueda por teléfono en varios formatos, por nombre sin acentos y por correo', async () => {
    const found = async q => (await call(list({ brand: 'all', q }), agent)).contacts.map(c => c.id);
    for (const q of ['5543219876', '+52 55 4321 9876', '+5215543219876', '55-4321-9876', '(55) 4321 9876', '4321 9876'])
      assert.deepEqual(await found(q), ['gv-buscada'], q);
    assert.deepEqual(await found('ZUÑIGA'), ['gv-buscada'], 'sin distinguir mayúsculas ni acentos');
    assert.deepEqual(await found('fernanda zuniga'), ['gv-buscada']);
    assert.deepEqual(await found('fer.zuniga@'), ['gv-buscada']);
    // el mismo número de la siembra escrito de dos formas distintas da el mismo contacto
    const i = 8; // índice con teléfono «+521…»
    assert.deepEqual(await found(phoneOf(i)), ['gv-' + String(i).padStart(5, '0')]);
    assert.deepEqual(await found('55' + String(20_000_000 + i)), ['gv-' + String(i).padStart(5, '0')]);
    // nombres repetidos: «josé pérez» encuentra a todos los que se llaman así
    const named = rows(db, "SELECT count(*) n FROM contacts WHERE brand_id='globalvet' AND name='José Pérez'")[0].n;
    assert.equal((await call(list({ brand: 'globalvet', q: 'jose perez' }), agent)).total.n, named);
    assert.equal((await call(list({ brand: 'globalvet', q: 'x'.repeat(101) }), agent, { expected: 400 })).field, 'q');
  });

  await t.test('filtros rápidos y avanzados con la gramática común', async () => {
    const count = async params => (await call(list({ brand: 'globalvet', ...params }), agent)).total.n;
    const sql = where => rows(db, `SELECT count(*) n FROM contacts c WHERE c.brand_id='globalvet' AND ${where}`)[0].n;
    assert.equal(await count({ quick: 'with_phone' }), sql("c.phone_key != ''"));
    assert.equal(
      await count({ quick: 'opted_in' }),
      sql("EXISTS (SELECT 1 FROM contact_consent k WHERE k.contact_id=c.id AND k.status='opted_in')"),
    );
    assert.equal(
      await count({ quick: 'active' }),
      sql("EXISTS (SELECT 1 FROM opportunities o WHERE o.contact_id=c.id AND o.stage NOT IN ('ganada','perdida'))"),
    );
    assert.equal(
      await count({ quick: 'mine' }),
      sql(`EXISTS (SELECT 1 FROM opportunities o WHERE o.contact_id=c.id AND o.owner_id='${env.agentId}')`),
    );
    assert.equal(
      await count({ quick: 'with_phone,opted_in' }),
      sql(
        "c.phone_key != '' AND EXISTS (SELECT 1 FROM contact_consent k WHERE k.contact_id=c.id AND k.status='opted_in')",
      ),
    );
    const filter = rules => JSON.stringify({ version: 1, match: 'all', groups: [{ match: 'all', rules }] });
    assert.equal(
      await count({ filter: filter([{ field: 'tag', op: 'any', value: ['tag-vip'] }]) }),
      sql("EXISTS (SELECT 1 FROM contact_tag_links l WHERE l.contact_id=c.id AND l.tag_id='tag-vip')"),
    );
    assert.equal(
      await count({ filter: filter([{ field: 'stage', op: 'any', value: ['ganada'] }]) }),
      sql("EXISTS (SELECT 1 FROM opportunities o WHERE o.contact_id=c.id AND o.stage='ganada')"),
    );
    assert.equal(
      await count({ filter: filter([{ field: 'consent', op: 'eq', value: 'unknown' }]) }),
      sql("NOT EXISTS (SELECT 1 FROM contact_consent k WHERE k.contact_id=c.id AND k.status != 'unknown')"),
    );
    assert.equal(
      await count({ filter: filter([{ field: 'created', op: 'before', value: T0 + 100 * 60_000 }]) }),
      sql(`c.created_at < ${T0 + 100 * 60_000}`),
    );
    assert.equal(
      await count({ filter: filter([{ field: 'has_phone', op: 'is', value: false }]), q: 'maria' }),
      rows(db, "SELECT name,phone_key FROM contacts WHERE brand_id='globalvet'").filter(
        c => c.phone_key === '' && searchKey(c.name).includes('maria'),
      ).length,
      'búsqueda y filtros se combinan',
    );
    // una condición mal formada o un filtro rápido desconocido se rechazan con su motivo
    const bad = await call(
      list({ brand: 'globalvet', filter: filter([{ field: 'nada', op: 'eq', value: 1 }]) }),
      agent,
      {
        expected: 400,
      },
    );
    assert.equal(bad.code, 'invalid_conditions');
    assert.ok(bad.details.problems.length >= 1);
    await call(list({ brand: 'globalvet', filter: '{no es json' }), agent, { expected: 400 });
    assert.equal((await call(list({ brand: 'globalvet', quick: 'todo' }), agent, { expected: 400 })).field, 'quick');
  });

  await t.test('orden por alta y por última actividad; la actividad sigue a intereses y conversaciones', async () => {
    const page = await call(list({ brand: 'globalvet', sort: 'created', dir: 'asc', limit: 3 }), agent);
    assert.deepEqual(
      page.contacts.map(c => c.id),
      ['gv-00000', 'gv-buscada', 'gv-00001'],
    );
    const before = await call(list({ brand: 'globalvet', sort: 'activity', limit: 1 }), agent);
    assert.equal(before.sort.dir, 'desc');
    // un interés nuevo en el contacto más antiguo lo sube al primer lugar
    db.prepare(
      'INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    ).run('op-nuevo', 'gv-00001', 'globalvet', 'nutricion', 'nuevo', Date.now(), Date.now() + 86_400_000);
    const after = await call(list({ brand: 'globalvet', sort: 'activity', limit: 1 }), agent);
    assert.equal(after.contacts[0].id, 'gv-00001');
    assert.equal(after.contacts[0].interests.active, 1);
    assert.equal((await call(list({ brand: 'globalvet', sort: 'otro' }), agent, { expected: 400 })).field, 'sort');
    await call(list({ brand: 'globalvet', limit: 51 }), agent, { expected: 400 });
  });

  await t.test('un cursor manipulado o de otra búsqueda se rechaza', async () => {
    const page = await call(list({ brand: 'globalvet', sort: 'name' }), agent);
    const cursor = page.nextCursor;
    assert.ok(cursor);
    const flip = cursor.slice(0, 5) + (cursor[5] === 'A' ? 'B' : 'A') + cursor.slice(6);
    const forged =
      Buffer.from(JSON.stringify({ v: 'a', i: 'gv-00001', f: 'x' })).toString('base64url') + '.' + 'A'.repeat(22);
    for (const [params, why] of [
      [{ sort: 'name', cursor: flip }, 'una letra cambiada'],
      [{ sort: 'name', cursor: forged }, 'uno escrito a mano'],
      [{ sort: 'name', cursor: 'basura' }, 'texto cualquiera'],
      [{ sort: 'created', cursor }, 'de otro orden'],
      [{ sort: 'name', q: 'ana', cursor }, 'de otra búsqueda'],
    ]) {
      const result = await call(list({ brand: 'globalvet', ...params }), agent, { expected: 400 });
      assert.equal(result.code, 'invalid_cursor', why);
    }
    // el bueno sigue funcionando
    assert.equal((await call(list({ brand: 'globalvet', sort: 'name', cursor }), agent)).contacts.length, 50);
  });

  await t.test('panel del contacto y filas por id para los avisos en vivo', async () => {
    const panel = await call('/api/contacts/gv-00000', agent);
    assert.equal(panel.contact.name, 'José Pérez');
    assert.deepEqual(
      panel.contact.tags.map(tag => tag.name),
      ['VIP'],
    );
    assert.equal(panel.consent.status, 'opted_in');
    assert.equal(panel.opportunities.length, 1);
    assert.equal(panel.opportunities[0].course, 'Plan sanitario para aves');
    assert.equal(panel.conversation, null);
    await call('/api/contacts/no-existe', agent, { expected: 404 });
    await call('/api/contacts/' + encodeURIComponent('../crm'), agent, { expected: 404 });

    const ids = 'gv-00000,gv-buscada,od-0001';
    const all = await call(list({ brand: 'all', ids }), agent);
    assert.deepEqual(all.contacts.map(c => c.id).sort(), ['gv-00000', 'gv-buscada'], 'nunca otra marca');
    const filtered = await call(list({ brand: 'all', ids, q: 'zuniga' }), agent);
    assert.deepEqual(
      filtered.contacts.map(c => c.id),
      ['gv-buscada'],
      'sólo las que siguen cumpliendo la búsqueda',
    );
    await call(list({ brand: 'all', ids: '' }), agent, { expected: 400 });
  });

  await t.test('aviso en vivo «contacts.changed» sólo a quien ve la marca, sin datos personales', async () => {
    const open = cookie =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(env.origin.replace('http', 'ws') + '/realtime', {
          headers: { Cookie: cookie, Origin: env.origin },
        });
        const events = [];
        ws.on('message', raw => events.push(JSON.parse(raw)));
        ws.once('open', () => resolve({ ws, events }));
        ws.once('error', reject);
      });
    const asesora = await open(agent);
    const direccion = await open(admin);
    t.after(() => {
      asesora.ws.close();
      direccion.ws.close();
    });
    db.prepare("UPDATE contacts SET name='Fernanda Zúñiga Cambio', updated_at=? WHERE id='gv-buscada'").run(Date.now());
    db.prepare("UPDATE contacts SET name='Paciente Cambio', updated_at=? WHERE id='od-0002'").run(Date.now());
    const changed = list => list.filter(e => e.v === 2 && e.type === 'contacts.changed');
    await until(
      () => changed(direccion.events).some(e => e.data.ids.includes('od-0002')),
      'administración recibe el cambio de OdonTeck',
    );
    await until(
      () => changed(asesora.events).some(e => e.data.ids.includes('gv-buscada')),
      'la asesora recibe el cambio de GlobalVet',
    );
    assert.equal(
      changed(asesora.events).some(e => e.brandId === 'odonteck'),
      false,
      'la asesora no recibe avisos de otra marca',
    );
    for (const event of changed(asesora.events)) assert.deepEqual(Object.keys(event.data), ['ids']);
  });

  await t.test('parts= en /api/crm: sin él responde lo de siempre; con él, sólo lo pedido', async () => {
    const full = await call('/api/crm', admin);
    assert.deepEqual(
      Object.keys(full).filter(k => k !== 'cookie'),
      ['contacts', 'opportunities', 'tasks', 'members', 'preferences'],
    );
    const some = await call('/api/crm?parts=opportunities,tasks', admin);
    assert.deepEqual(
      Object.keys(some).filter(k => k !== 'cookie'),
      ['opportunities', 'tasks'],
    );
    assert.deepEqual(some.opportunities, full.opportunities);
    assert.deepEqual(some.tasks, full.tasks);
    const bad = await call('/api/crm?parts=contacts,secretos', admin, { expected: 400 });
    assert.equal(bad.field, 'parts');
  });
});
