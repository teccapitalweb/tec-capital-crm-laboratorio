import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../server/database.mjs';
import { runLadder } from '../server/migrations/ladder.mjs';
import { migrate, expectedSchemaId, NAMED } from '../server/migrations/index.mjs';
import { phoneKey } from '../server/lib/identity-keys.mjs';
import { normalizePhone } from '../server/persons-schema.mjs';
import { hmacHex } from '../server/connectors.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';

// Teléfono canónico (docs/PLAN_TELEFONO_CANONICO.md). Todos los teléfonos de este archivo son inventados.

const MIGRATION = 'identity/0001-phone-key';
const T0 = Date.UTC(2026, 9, 1); // los datos «de antes» llevan una fecha fija: así se nota si la migración los toca
const INDEX_SQL = "CREATE INDEX contacts_phone_key ON contacts(brand_id, phone_key) WHERE phone_key != ''";

// Carpeta temporal. Al terminar se ejecuta lo apuntado con `later` (primero lo último: bases y servidores) y se borra.
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
const rows = (db, sql, ...args) =>
  db
    .prepare(sql)
    .all(...args)
    .map(row => ({ ...row }));
// Todo lo que la migración puede tocar, para comparar un antes y un después.
const dataOf = db => ({
  contacts: rows(db, 'SELECT * FROM contacts ORDER BY id'),
  persons: rows(db, 'SELECT * FROM persons ORDER BY id'),
  identities: rows(db, 'SELECT * FROM person_identities ORDER BY kind,value'),
  candidates: rows(db, 'SELECT * FROM person_candidates ORDER BY person_a,person_b'),
});
const keyOf = (db, id) => db.prepare('SELECT phone_key FROM contacts WHERE id=?').get(id).phone_key;
// La regla que debe cumplir cualquier base: la clave guardada es la del teléfono guardado.
function assertKeysInSync(db) {
  const all = rows(db, 'SELECT id,phone,phone_key FROM contacts');
  for (const c of all) assert.equal(c.phone_key, phoneKey(c.phone) ?? '', `clave del contacto ${c.id} («${c.phone}»)`);
  return all.length;
}

// Cada fila: contacto, teléfono tal como se capturó, clave que debe quedar y por qué está en la lista. Son los
// formatos del hallazgo 2 del diseño de identidad: diez dígitos, «+52…», «521…», «52…», extranjero sin «+» y basura.
const FORMATS = [
  ['c-diez', '5512345678', '525512345678', 'diez dígitos capturados a mano'],
  ['c-mas52', '+52 55 2345 6789', '525523456789', 'internacional con espacios'],
  ['c-521', '5215534567890', '525534567890', 'identificador de WhatsApp sin «+»'],
  ['c-mas521', '+5215545678901', '525545678901', 'lo que guardaba el entrante real de WhatsApp'],
  ['c-52', '525556789012', '525556789012', 'con país y sin «+»'],
  ['c-eua', '14155552671', '14155552671', 'extranjero sin «+», como lo exporta el proveedor actual'],
  ['c-eua-mas', '+1 (415) 555-2672', '14155552672', 'extranjero con «+»'],
  ['c-esp', '34612345678', '34612345678', 'otro extranjero sin «+»'],
  ['c-parentesis', '(55) 6789-0123', '525567890123', 'paréntesis y guion'],
  ['c-044', '044 55 7890 1234', '525578901234', 'marcación anterior a 2019'],
  ['c-texto', 'prueba', '', 'texto en el campo de teléfono'],
  ['c-corto', '123', '', 'faltan dígitos'],
  ['c-extension', '55 1234 5678 ext 12', '', 'lleva una extensión escrita'],
  ['c-pais', '+999 123456789', '', 'código de país que no existe'],
  ['c-cero', '0123456789', '', 'diez dígitos que empiezan con 0'],
  ['c-vacio', '', '', 'sin teléfono'],
];

// Una base tal como la dejó el código publicado en la escalera 41: contactos en todos los formatos y personas con la
// identidad de teléfono que escribía la normalización anterior («+521…» cuando el número llegó de WhatsApp).
function seedV41(db) {
  const user = (id, number) =>
    db
      .prepare(
        'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(id, id, 'Cliente ' + id, 'sin-acceso', 'customer', number, T0, T0);
  const person = (id, name, phone, userId = null) =>
    db
      .prepare('INSERT INTO persons(id,name,phone,email,source_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, name, phone, '', userId, T0, T0);
  const contact = (id, brand, name, phone, { personId = null, userId = null } = {}) =>
    db
      .prepare(
        'INSERT INTO contacts(id,brand_id,source_user_id,name,phone,email,source,created_at,updated_at,persona_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(id, brand, userId, name, phone, '', userId ? 'whatsapp' : 'manual', T0, T0, personId);
  const identity = (kind, value, personId) =>
    db
      .prepare('INSERT INTO person_identities(kind,value,person_id,source,created_at) VALUES(?,?,?,?,?)')
      .run(kind, value, personId, 'contact', T0);
  ['u-wa', 'u-wa2', 'u-vista'].forEach((id, i) => user(id, 800001 + i));

  // Persona de un alta manual: su identidad ya era canónica.
  person('p-diez', 'Persona Diez', '+525512345678');
  identity('phone', '+525512345678', 'p-diez');
  // Persona que entró por WhatsApp: la identidad conserva el 1 y nadie más tiene ese número.
  person('p-wa', 'Persona WhatsApp', '+5215545678901', 'u-wa');
  identity('profile', 'u-wa', 'p-wa');
  identity('phone', '+5215545678901', 'p-wa');
  for (const [id, phone, , why] of FORMATS)
    contact(id, 'globalvet', 'Contacto ' + why, phone, {
      personId: { 'c-diez': 'p-diez', 'c-mas521': 'p-wa' }[id] ?? null,
      userId: id === 'c-mas521' ? 'u-wa' : null,
    });
  contact('c-otra-marca', 'odonteck', 'Mismo número en otra marca', '55 1234 5678');

  // La misma persona dos veces: capturada a mano con diez dígitos y, aparte, escribiendo por WhatsApp.
  person('p-manual', 'Rosa Manual', '+525566667777');
  identity('phone', '+525566667777', 'p-manual');
  contact('c-manual', 'globalvet', 'Rosa Manual', '5566667777', { personId: 'p-manual' });
  person('p-wa2', 'Rosa por WhatsApp', '+5215566667777', 'u-wa2');
  identity('profile', 'u-wa2', 'p-wa2');
  identity('phone', '+5215566667777', 'p-wa2');
  contact('c-wa2', 'globalvet', 'Rosa por WhatsApp', '+5215566667777', { personId: 'p-wa2', userId: 'u-wa2' });

  // Una persona que ya tenía las dos formas del mismo número.
  person('p-ambas', 'Persona Ambas', '+5215577778888');
  identity('phone', '+525577778888', 'p-ambas');
  identity('phone', '+5215577778888', 'p-ambas');
  contact('c-ambas', 'globalvet', 'Persona Ambas', '5577778888', { personId: 'p-ambas' });

  // Una identidad con la forma anterior que la regla nueva no reconoce como teléfono (después del 1 van diez dígitos
  // que empiezan con 0): se queda como está.
  person('p-rara', 'Persona Rara', '+5210123456789');
  identity('phone', '+5210123456789', 'p-rara');
  contact('c-rara', 'globalvet', 'Persona Rara', '+5210123456789', { personId: 'p-rara' });

  // Dos personas con el mismo número sobre las que administración ya había decidido («no son la misma»).
  person('p-vista-a', 'Luz Vista', '+525588889999');
  identity('phone', '+525588889999', 'p-vista-a');
  contact('c-vista-a', 'globalvet', 'Luz Vista', '5588889999', { personId: 'p-vista-a' });
  person('p-vista-b', 'Luz Vista', '+5215588889999', 'u-vista');
  identity('profile', 'u-vista', 'p-vista-b');
  identity('phone', '+5215588889999', 'p-vista-b');
  contact('c-vista-b', 'globalvet', 'Luz Vista', '+5215588889999', { personId: 'p-vista-b', userId: 'u-vista' });
  db.prepare(
    "INSERT INTO person_candidates(id,person_a,person_b,reason,detail,status,decided_at,created_at) VALUES('cand-vista','p-vista-a','p-vista-b','name','Mismo nombre «Luz Vista»','dismissed',?,?)",
  ).run(T0, T0);
}

// Lo que debe quedar, en una base migrada, de las personas sembradas por seedV41.
function assertPersonsFixed(db, before) {
  const after = dataOf(db);
  const phoneOf = id => after.persons.find(p => p.id === id).phone;
  const ownerOf = value => after.identities.find(i => i.kind === 'phone' && i.value === value)?.person_id ?? null;
  // sin conflicto: la identidad y el teléfono de la persona pasan a la forma nueva
  assert.equal(ownerOf('+525545678901'), 'p-wa');
  assert.equal(ownerOf('+5215545678901'), null, 'la forma anterior ya no existe');
  assert.equal(phoneOf('p-wa'), '+525545678901');
  // el número ya era de otra persona: la identidad no se mueve y queda una candidatura para administración
  assert.equal(ownerOf('+525566667777'), 'p-manual');
  assert.equal(ownerOf('+5215566667777'), 'p-wa2', 'la identidad en conflicto no se toca');
  assert.equal(phoneOf('p-wa2'), '+525566667777', 'el teléfono de la persona sí queda en la forma nueva');
  const conflict = after.candidates.filter(c => c.person_a === 'p-manual' && c.person_b === 'p-wa2');
  assert.equal(conflict.length, 1);
  assert.deepEqual(
    { reason: conflict[0].reason, detail: conflict[0].detail, status: conflict[0].status },
    { reason: 'identity_conflict', detail: 'Mismo teléfono +525566667777', status: 'pending' },
  );
  // la misma persona ya tenía la forma nueva: no se borra nada ni se crea candidatura
  assert.equal(ownerOf('+525577778888'), 'p-ambas');
  assert.equal(ownerOf('+5215577778888'), 'p-ambas');
  assert.equal(phoneOf('p-ambas'), '+525577778888');
  // lo que la biblioteca no reconoce se queda como estaba
  assert.equal(ownerOf('+5210123456789'), 'p-rara');
  assert.equal(phoneOf('p-rara'), '+5210123456789');
  // una decisión anterior de administración no se reabre
  assert.equal(ownerOf('+5215588889999'), 'p-vista-b');
  assert.equal(phoneOf('p-vista-b'), '+525588889999');
  assert.deepEqual(
    after.candidates.filter(c => c.person_a === 'p-vista-a'),
    before.candidates.filter(c => c.person_a === 'p-vista-a'),
  );
  assert.equal(after.candidates.length, before.candidates.length + 1, 'una sola candidatura nueva');
  assert.equal(after.identities.length, before.identities.length, 'ninguna identidad se crea ni se borra');
  // de la persona sólo cambia el teléfono: ni la revisión ni las fechas
  const rest = list => list.map(({ phone, ...other }) => other);
  assert.deepEqual(rest(after.persons), rest(before.persons));
  assert.deepEqual(
    after.persons.filter((p, i) => p.phone !== before.persons[i].phone).map(p => p.id),
    ['p-ambas', 'p-vista-b', 'p-wa', 'p-wa2'],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A. Una sola función
// ---------------------------------------------------------------------------------------------------------------

// La normalización publicada hasta la v0.34.0, copiada tal cual. Sólo vive aquí, para dejar comprobado en qué cambia
// la salida de normalizePhone ahora que delega en server/lib/identity-keys.mjs.
function previousNormalizePhone(raw, country = '52') {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const plus = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);
  if (plus) return d.length >= 8 && d.length <= 15 ? '+' + d : '';
  if (d.length === 10) return '+' + country + d;
  if (country === '52') {
    if (d.length === 12 && d.startsWith('52')) return '+' + d;
    if (d.length === 13 && d.startsWith('521')) return '+52' + d.slice(3);
    if (d.length === 13 && (d.startsWith('044') || d.startsWith('045'))) return '+52' + d.slice(3);
  }
  if (d.length >= 11 && d.length <= 15 && d.startsWith(country)) return '+' + d;
  return '';
}

test('normalizePhone delega en la biblioteca: un teléfono bien escrito da lo mismo que antes y las diferencias son las documentadas', () => {
  // 1) Bien escrito: mismo resultado que la versión anterior, forma por forma.
  let seed = 20261113;
  const digit = (from, to) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return String(from + (seed % (to - from + 1)));
  };
  for (let round = 0; round < 200; round++) {
    let national = digit(2, 9);
    while (national.length < 10) national += digit(0, 9);
    const [a, b, c] = [national.slice(0, 2), national.slice(2, 6), national.slice(6)];
    const same = [
      national,
      `${a} ${b} ${c}`,
      `(${a}) ${b}-${c}`,
      '52' + national,
      `52 ${a} ${b} ${c}`,
      '521' + national,
      `521 ${a} ${b} ${c}`,
      '+52' + national,
      `+52 ${a} ${b} ${c}`,
      `0052 ${a} ${b} ${c}`,
      `044 ${a} ${b} ${c}`,
      `045 ${a} ${b} ${c}`,
    ];
    for (const form of same) {
      assert.equal(normalizePhone(form), '+52' + national, form);
      assert.equal(previousNormalizePhone(form), '+52' + national, form + ' (versión anterior)');
    }
    // La diferencia buscada: el identificador de WhatsApp con «+» conservaba el 1.
    for (const form of ['+521' + national, `+52 1 ${a} ${b} ${c}`, `00 52 1 ${a} ${b} ${c}`]) {
      assert.equal(previousNormalizePhone(form), '+521' + national, form + ' (versión anterior)');
      assert.equal(normalizePhone(form), '+52' + national, form);
    }
    // El valor que devuelve es «+» más la clave canónica, la que guarda contacts.phone_key.
    assert.equal(normalizePhone(national), '+' + phoneKey(national));
  }
  for (const [form, want] of [
    ['+1 (415) 555-2671', '+14155552671'],
    ['+34 612 345 678', '+34612345678'],
    ['+502 5555 1234', '+50255551234'],
    ['0034 612 345 678', '+34612345678'],
    ['', ''],
    [null, ''],
    [undefined, ''],
    ['123', ''],
    ['abc', ''],
    ['+1', ''],
  ]) {
    assert.equal(normalizePhone(form), want, String(form));
    assert.equal(previousNormalizePhone(form), want, String(form) + ' (versión anterior)');
  }
  // Misma firma: el segundo argumento sigue siendo el país por omisión.
  assert.equal(normalizePhone('3001234567', '57'), '+573001234567');
  assert.equal(previousNormalizePhone('3001234567', '57'), '+573001234567');

  // 2) Todo lo que cambia. Cada fila: entrada, salida anterior, salida de ahora.
  const changes = [
    // el 1 de WhatsApp
    ['+5215512345678', '+5215512345678', '+525512345678'],
    ['00 52 1 55 1234 5678', '+5215512345678', '+525512345678'],
    // ahora se reconocen
    ['14155552671', '', '+14155552671'],
    ['34612345678', '', '+34612345678'],
    ['01 55 1234 5678', '', '+525512345678'],
    ['5512345678.0', '', '+525512345678'],
    // dejan de aceptarse: no son un teléfono
    ['tel:5512345678', '+525512345678', ''],
    ['55 1234 5678 (casa)', '+525512345678', ''],
    ['+999 123456789', '+999123456789', ''],
    ['1234567890', '+521234567890', ''],
    ['0123456789', '+520123456789', ''],
    ['52551234567', '+52551234567', ''],
    ['+52 55 1234 567', '+52551234567', ''],
    ['+52 1 55 1234 567', '+521551234567', ''],
    ['+1 415 555 26711', '+141555526711', ''],
  ];
  for (const [form, was, now] of changes) {
    assert.equal(previousNormalizePhone(form), was, form + ' (versión anterior)');
    assert.equal(normalizePhone(form), now, form);
    assert.notEqual(was, now, form);
  }
  // Nunca devuelve otra cosa que '' o un E.164 que la biblioteca vuelve a leer igual.
  for (const [form] of changes) {
    const out = normalizePhone(form);
    if (out) assert.equal(normalizePhone(out), out, form);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// B. La migración sobre una base poblada en la escalera 41
// ---------------------------------------------------------------------------------------------------------------

test('migración identity/0001: una base poblada en la 41 gana la clave de cada contacto sin tocar lo demás, corrige las identidades «+521…» y repetirla no cambia nada', async t => {
  const { dir, later } = await workspace(t, 'crm-phone-key-');
  const db = openDatabase(dir);
  later(() => db.close());
  runLadder(db); // exactamente como queda hoy una base publicada
  seedV41(db);
  const before = dataOf(db);
  assert.equal(
    before.contacts.some(c => 'phone_key' in c),
    false,
    'la base de partida todavía no tiene la columna',
  );

  const result = migrate(db, { backup: false });
  assert.ok(result.applied.includes(MIGRATION));
  assert.equal(result.id, expectedSchemaId());
  assertSchemaCurrent(db);

  // la columna y su índice
  const column = rows(db, 'PRAGMA table_info(contacts)').find(info => info.name === 'phone_key');
  assert.deepEqual(
    { type: column.type, notnull: column.notnull, dflt_value: column.dflt_value },
    { type: 'TEXT', notnull: 1, dflt_value: "''" },
  );
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='contacts_phone_key'").get().sql, INDEX_SQL);

  // la clave de cada formato
  for (const [id, phone, key, why] of FORMATS) assert.equal(keyOf(db, id), key, `${why}: «${phone}»`);
  assert.equal(keyOf(db, 'c-otra-marca'), '525512345678');
  assert.equal(keyOf(db, 'c-manual'), '525566667777');
  assert.equal(keyOf(db, 'c-wa2'), '525566667777', 'capturado a mano y por WhatsApp: la misma clave');
  assert.equal(keyOf(db, 'c-rara'), '', 'lo que no se reconoce queda sin clave');
  assert.equal(assertKeysInSync(db), before.contacts.length);

  // los datos originales, intactos: del contacto sólo cambia la columna nueva (ni el teléfono ni las fechas)
  const after = dataOf(db);
  assert.deepEqual(
    after.contacts.map(({ phone_key, ...original }) => original),
    before.contacts,
  );
  assertPersonsFixed(db, before);

  // el índice sirve para «contacto de esta marca con esta clave» (parcial: la consulta excluye la clave vacía)
  const lookup = "SELECT id FROM contacts WHERE brand_id=? AND phone_key=? AND phone_key!=''";
  assert.match(
    rows(db, 'EXPLAIN QUERY PLAN ' + lookup, 'globalvet', '525566667777')
      .map(step => step.detail)
      .join(' '),
    /contacts_phone_key/,
  );
  assert.deepEqual(
    rows(db, lookup + ' ORDER BY id', 'globalvet', '525566667777').map(c => c.id),
    ['c-manual', 'c-wa2'],
  );
  assert.deepEqual(
    rows(db, lookup, 'odonteck', '525512345678').map(c => c.id),
    ['c-otra-marca'],
    'la búsqueda es por marca',
  );

  // aplicarla otra vez no cambia nada: ni por el ejecutor ni repitiendo el cuerpo
  const shape = schemaShape(db);
  const notes = () => rows(db, 'SELECT name,applied_at FROM schema_migrations ORDER BY name');
  const annotated = notes();
  assert.deepEqual(migrate(db, { backup: false }).applied, []);
  assert.deepEqual(dataOf(db), after);
  const migration = NAMED.find(m => m.name === MIGRATION);
  transaction(db, () => migration.up(db));
  transaction(db, () => migration.up(db));
  assert.deepEqual(dataOf(db), after, 'repetir el cuerpo deja los mismos datos');
  assert.deepEqual(schemaShape(db), shape, 'y el mismo esquema');
  assert.deepEqual(notes(), annotated);

  // si alguien deja una clave que no corresponde a su teléfono, repetir el cuerpo la corrige (y sólo ésa)
  db.prepare("UPDATE contacts SET phone_key='5200000000' WHERE id='c-diez'").run();
  db.prepare("UPDATE contacts SET phone_key='' WHERE id='c-52'").run();
  db.prepare("UPDATE contacts SET phone_key='525500000000' WHERE id='c-vacio'").run();
  transaction(db, () => migration.up(db));
  assert.deepEqual(dataOf(db), after);

  // sólo aditivo: una sentencia del código anterior (que no conoce la columna) sigue funcionando
  db.prepare('INSERT INTO contacts(id,brand_id,name,phone,email,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(
    'c-codigo-anterior',
    'globalvet',
    'Alta con el código anterior',
    '5512340000',
    '',
    T0,
    T0,
  );
  assert.equal(keyOf(db, 'c-codigo-anterior'), '');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
});

test('una base nueva queda con el mismo esquema que una actualizada desde la 41', async t => {
  const upgraded = await workspace(t, 'crm-phone-up-');
  const fresh = await workspace(t, 'crm-phone-new-');
  const a = openDatabase(upgraded.dir);
  upgraded.later(() => a.close());
  runLadder(a);
  seedV41(a);
  migrate(a, { backup: false });
  const b = openDatabase(fresh.dir);
  fresh.later(() => b.close());
  migrate(b, { backup: false });
  assertSchemaCurrent(b);
  assert.deepEqual(schemaShape(b), schemaShape(a));
});

// ---------------------------------------------------------------------------------------------------------------
// C. El arranque real sobre una base publicada
// ---------------------------------------------------------------------------------------------------------------

const PASSWORD = 'Password-telefono-2026!';
// Cliente HTTP mínimo contra el servidor de la prueba: comprueba el estado y devuelve el cuerpo y la galleta de sesión.
const client = origin =>
  async function call(path, cookie = '', body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const response = await fetch(origin + path, {
      method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, path + ': ' + JSON.stringify(result));
    return { ...result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };

test('arranque real: el servidor migra una base poblada en la 41 con un respaldo previo, y duplicados, candidaturas y búsqueda ya comparan por la clave', async t => {
  const { dir, later } = await workspace(t, 'crm-phone-boot-');
  let db = openDatabase(dir);
  runLadder(db);
  seedV41(db);
  const before = dataOf(db);
  db.close();

  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code } });
  later(() => server.stop());
  db = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  later(() => db.close());
  assertSchemaCurrent(db);
  const health = await (await fetch(server.origin + '/api/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.schema, expectedSchemaId());

  // un solo respaldo, tomado ANTES de migrar: la copia todavía no tiene la columna y conserva los teléfonos
  const backups = await readdir(join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^before-[a-z0-9-]+-\d+\.sqlite$/);
  const copy = new DatabaseSync(join(dir, 'backups', backups[0]), { readOnly: true });
  try {
    assert.deepEqual(rows(copy, 'SELECT * FROM contacts ORDER BY id'), before.contacts);
    assert.deepEqual(rows(copy, 'SELECT * FROM person_identities ORDER BY kind,value'), before.identities);
  } finally {
    copy.close();
  }

  // la base viva: claves, datos originales y personas
  for (const [id, phone, key, why] of FORMATS) assert.equal(keyOf(db, id), key, `${why}: «${phone}»`);
  assert.deepEqual(
    dataOf(db).contacts.map(({ phone_key, ...original }) => original),
    before.contacts,
  );
  assertPersonsFixed(db, before);
  assertKeysInSync(db);

  // con el servidor ya arrancado: lo que ve administración
  const call = client(server.origin);
  const admin = await call('/api/auth/register', '', {
    username: 'admin',
    name: 'Administración',
    password: PASSWORD,
    inviteCode: code,
  });
  const { groups } = await call('/api/crm/duplicates?brand=globalvet', admin.cookie);
  const byPhone = groups.filter(g => g.reason === 'phone').map(g => g.contacts.map(c => c.id).sort());
  assert.ok(
    byPhone.some(ids => ids.join() === 'c-manual,c-wa2'),
    'diez dígitos y «+521…» del mismo número aparecen como duplicados',
  );
  assert.ok(byPhone.some(ids => ids.join() === 'c-vista-a,c-vista-b'));
  assert.equal(
    byPhone.flat().some(id => ['c-diez', 'c-otra-marca', 'c-texto', 'c-corto', 'c-rara'].includes(id)),
    false,
    'ni el mismo número en otra marca ni lo que no tiene clave',
  );
  const { candidates } = await call('/api/persons/candidates', admin.cookie);
  const found = candidates.find(c => c.person_a === 'p-manual' && c.person_b === 'p-wa2');
  assert.equal(found.reason, 'identity_conflict');
  assert.equal(found.detail, 'Mismo teléfono +525566667777');
  assert.deepEqual([found.phone_a, found.phone_b], ['+525566667777', '+525566667777']);
  // buscar el número como lo enseña la cabecera del chat («+521…») encuentra a las dos personas
  for (const q of ['+5215566667777', '5215566667777', '55 6666 7777', '+52 55 6666 7777']) {
    const { persons } = await call('/api/persons?brand=globalvet&q=' + encodeURIComponent(q), admin.cookie);
    assert.deepEqual(persons.map(p => p.id).sort(), ['p-manual', 'p-wa2'], q);
  }

  // segundo arranque: nada pendiente, ningún respaldo más y los mismos datos
  const settled = dataOf(db);
  await server.stop();
  const again = await startServer({ dir, env: { ADMIN_INVITE_CODE: code } });
  later(() => again.stop());
  assert.equal((await readdir(join(dir, 'backups'))).length, 1);
  assert.deepEqual(dataOf(db), settled);
  assertSchemaCurrent(db);
});

// ---------------------------------------------------------------------------------------------------------------
// D. Lo que escribe el servidor: alta, edición, fusión, históricos y el entrante real de WhatsApp
// ---------------------------------------------------------------------------------------------------------------

const TOKEN = 'EAAprueba0000000000000000000000token',
  SECRET = 'app-secret-prueba',
  NUMBER = '109000000000001';

test('alta, edición, fusión e históricos mantienen la clave; quien se capturó a mano con diez dígitos y escribe por WhatsApp real queda con la misma clave', async t => {
  // ---- Meta de mentira: sólo lo que este recorrido necesita (recibir los mensajes que salen)
  const sent = [];
  const stub = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const send = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.headers.authorization !== 'Bearer ' + TOKEN)
        return send(401, { error: { code: 190, message: 'Invalid OAuth access token' } });
      const found = new URL(req.url, 'http://x').pathname.match(/^\/v25\.0\/(\d+)\/messages$/);
      if (!found || req.method !== 'POST') return send(404, { error: { code: 100, message: 'ruta desconocida' } });
      const message = JSON.parse(Buffer.concat(chunks).toString());
      sent.push({ from: found[1], ...message });
      send(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: message.to, wa_id: message.to }],
        messages: [{ id: 'wamid.out' + sent.length }],
      });
    });
  });
  await new Promise(done => stub.listen(0, '127.0.0.1', done));
  const { dir, later } = await workspace(t, 'crm-phone-api-');
  later(() => new Promise(done => stub.close(done)));
  const code = randomUUID();
  const server = await startServer({
    dir,
    env: {
      ADMIN_INVITE_CODE: code,
      AI_PROVIDER: '',
      CHANNEL_CONNECTOR: 'meta',
      META_ACCESS_TOKEN: TOKEN,
      META_APP_SECRET: SECRET,
      META_VERIFY_TOKEN: 'verifica-123',
      META_PHONE_NUMBER_ID: NUMBER,
      META_GRAPH_URL: 'http://127.0.0.1:' + stub.address().port,
      META_GRAPH_VERSION: '',
    },
  });
  later(() => server.stop());
  const call = client(server.origin);
  const until = async (probe, what, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > end) assert.fail('no ocurrió: ' + what + '\n' + server.logs());
      await new Promise(done => setTimeout(done, 100));
    }
  };
  const admin = await call('/api/auth/register', '', {
    username: 'admin',
    name: 'Administración',
    password: PASSWORD,
    inviteCode: code,
  });
  const db = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  later(() => db.close());
  assertSchemaCurrent(db);
  const row = id => ({ ...db.prepare('SELECT * FROM contacts WHERE id=?').get(id) });
  const create = async (name, phone, brandId = 'globalvet') =>
    (await call('/api/crm/contacts', admin.cookie, { brandId, name, phone }, 'POST', 201)).id;
  const edit = (id, name, phone) => call('/api/crm/contacts/' + id, admin.cookie, { name, phone, email: '' }, 'PATCH');

  // ---- alta: el teléfono se guarda como se escribió y la clave es la canónica
  const ana = await create('Ana Alta', '55 1234 0001');
  assert.deepEqual([row(ana).phone, row(ana).phone_key], ['55 1234 0001', '525512340001']);
  const person = db.prepare('SELECT phone FROM persons WHERE id=?').get(row(ana).persona_id);
  assert.equal(person.phone, '+' + row(ana).phone_key, 'la persona usa el mismo número: «+» y la clave');
  assert.equal(row(await create('Sin Teléfono', '')).phone_key, '');
  assert.equal(row(await create('Texto En Teléfono', 'pendiente')).phone_key, '');
  assert.equal(row(await create('Con Extranjero', '+1 (415) 555-2671')).phone_key, '14155552671');
  assert.equal((await call('/api/crm/contacts/' + ana, admin.cookie)).contact.phone, '55 1234 0001');

  // ---- edición: la clave sigue al teléfono en cada cambio
  await edit(ana, 'Ana Alta', '+52 1 55 1234 0002');
  assert.deepEqual([row(ana).phone, row(ana).phone_key], ['+52 1 55 1234 0002', '525512340002']);
  await edit(ana, 'Ana Alta', 'no tiene');
  assert.deepEqual([row(ana).phone, row(ana).phone_key], ['no tiene', '']);
  await edit(ana, 'Ana Alta', '5512340003');
  assert.equal(row(ana).phone_key, '525512340003');
  await edit(ana, 'Ana Alta', '');
  assert.deepEqual([row(ana).phone, row(ana).phone_key], ['', '']);
  await edit(ana, 'Ana Editada', '(55) 1234-0004');
  assert.deepEqual([row(ana).name, row(ana).phone_key], ['Ana Editada', '525512340004']);

  // ---- duplicados: el mismo número escrito de cuatro formas; un número de otro país con los mismos diez dígitos no
  const same = [];
  for (const [name, phone] of [
    ['Dup Uno', '+52 55 1234 9999'],
    ['Dup Dos', '(55) 1234-9999'],
    ['Dup Tres', '521 55 1234 9999'],
    ['Dup Cuatro', '0052 1 55 1234 9999'],
  ])
    same.push(await create(name, phone));
  const mx = await create('Mismos Diez Mx', '+52 415 555 2671'),
    us = await create('Mismos Diez Eua', '+1 415 555 2671');
  const other = await create('Dup Otra Marca', '55 1234 9999', 'odonteck');
  let groups = (await call('/api/crm/duplicates?brand=globalvet', admin.cookie)).groups.filter(
    g => g.reason === 'phone',
  );
  const ids = g => g.contacts.map(c => c.id).sort();
  assert.ok(groups.some(g => ids(g).join() === [...same].sort().join()));
  assert.equal(
    groups.some(g => ids(g).includes(mx) && ids(g).includes(us)),
    false,
    'México y Estados Unidos con los mismos diez dígitos no son el mismo teléfono',
  );
  assert.equal(
    groups.some(g => ids(g).includes(other)),
    false,
    'los duplicados son por marca',
  );

  // ---- fusión: el teléfono que se hereda llega con su clave; el que ya se tenía no cambia
  const keep = await create('Principal Sin Teléfono', ''),
    dup = await create('Duplicado Con Teléfono', '55 9988 7766');
  const merge = async (keepId, mergeId) => {
    const { plan } = await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId, mergeId });
    assert.equal(plan.canMerge, true, plan.problems.join());
    return call('/api/crm/contacts/merge', admin.cookie, { keepId, mergeId, previewToken: plan.previewToken });
  };
  await merge(keep, dup);
  assert.deepEqual([row(keep).phone, row(keep).phone_key], ['55 9988 7766', '525599887766']);
  const second = await create('Otro Duplicado', '55 1111 2222');
  await merge(keep, second);
  assert.deepEqual([row(keep).phone, row(keep).phone_key], ['55 9988 7766', '525599887766']);

  // ---- históricos: el contacto que nace de una importación también lleva su clave
  const applied = await call(
    '/api/legacy/apply',
    admin.cookie,
    {
      brandId: 'globalvet',
      format: 'json',
      content: JSON.stringify({ alumnos: [{ id: 'h1', nombre: 'Histórico Uno', telefono: '55 4321 0987' }] }),
    },
    'POST',
    201,
  );
  assert.equal(applied.counts.alumno, 1);
  const imported = { ...db.prepare("SELECT phone,phone_key FROM contacts WHERE source='ipcil'").get() };
  assert.deepEqual(imported, { phone: '+525543210987', phone_key: '525543210987' });

  // ---- WhatsApp real: la misma persona capturada a mano (diez dígitos) y escribiendo desde 521…
  await call(
    '/api/whatsapp/numbers/' + NUMBER,
    admin.cookie,
    { brandId: 'globalvet', courseId: 'aves', label: 'Número de prueba', expectedRevision: 0 },
    'PUT',
  );
  const manual = await create('María López Captura', '55 1234 5678');
  let wid = 0;
  const textIn = async (from, text, name) => {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550100000', phone_number_id: NUMBER },
                contacts: [{ profile: { name }, wa_id: from }],
                messages: [
                  {
                    from,
                    id: 'wamid.tel' + ++wid,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const response = await fetch(server.origin + '/api/webhooks/channel/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + hmacHex(SECRET, raw) },
      body: raw,
    });
    assert.equal(response.status, 200);
    return (await response.json()).results[0].result;
  };
  const waContact = from => ({
    ...db
      .prepare(
        'SELECT c.* FROM wa_identities i JOIN contacts c ON c.source_user_id=i.user_id WHERE i.wa_id=? AND c.brand_id=?',
      )
      .get(from, 'globalvet'),
  });
  assert.match(
    await textIn('5215512345678', 'Hola, ¿cuánto cuesta el curso?', 'Mary'),
    /^recibido: conversación nueva/,
  );
  const wa = waContact('5215512345678');
  assert.equal(wa.source, 'whatsapp');
  assert.equal(wa.phone, '+525512345678', 'el entrante guarda el teléfono canónico, sin el 1');
  assert.equal(wa.phone_key, '525512345678');
  assert.equal(wa.phone_key, row(manual).phone_key, 'la misma clave que la persona capturada a mano');
  assert.notEqual(wa.id, manual);
  // el identificador tal como llegó sigue siendo el destino: la respuesta sale a 521…
  const conversation = db.prepare('SELECT wa_peer FROM conversations WHERE customer_id=?').get(wa.source_user_id);
  assert.equal(conversation.wa_peer, '5215512345678');
  await until(
    () => sent.some(m => m.to === '5215512345678'),
    'la respuesta del asistente sale por Meta al mismo número',
  );
  // se reconocen como la misma: duplicados de la marca y candidatura de persona, las dos por la clave canónica
  groups = (await call('/api/crm/duplicates?brand=globalvet', admin.cookie)).groups.filter(g => g.reason === 'phone');
  assert.ok(groups.some(g => ids(g).join() === [manual, wa.id].sort().join()));
  const { candidates } = await call('/api/persons/candidates', admin.cookie);
  const pair = [row(manual).persona_id, wa.persona_id].sort();
  const candidate = candidates.find(c => c.person_a === pair[0] && c.person_b === pair[1]);
  assert.ok(candidate, 'queda una candidatura entre las dos personas');
  assert.deepEqual(
    { reason: candidate.reason, detail: candidate.detail },
    { reason: 'identity_conflict', detail: 'Mismo teléfono +525512345678' },
  );
  assert.equal(db.prepare('SELECT phone FROM persons WHERE id=?').get(wa.persona_id).phone, '+525512345678');
  // un segundo mensaje no cambia el contacto ni crea otro
  assert.match(await textIn('5215512345678', 'Gracias', 'Mary'), /^recibido: conversación existente/);
  assert.deepEqual(waContact('5215512345678'), wa);
  // otro país: el identificador ya es el número completo
  await textIn('14155552671', 'Hello', 'John');
  assert.deepEqual(
    [waContact('14155552671').phone, waContact('14155552671').phone_key],
    ['+14155552671', '14155552671'],
  );
  // un identificador que no se reconoce como teléfono: se conserva tal como llegó y queda sin clave
  await textIn('99912345678', 'Hola', 'Desconocido');
  assert.deepEqual([waContact('99912345678').phone, waContact('99912345678').phone_key], ['+99912345678', '']);
  // al revés: primero escribe por WhatsApp y después se captura a mano en otra marca. La identidad de teléfono es la
  // misma, así que el contacto nuevo cuelga solo de la persona que ya existía (antes, «521…» y diez dígitos no se unían,
  // y un extranjero sin «+» no tenía identidad de teléfono).
  await textIn('5215500000009', 'Hola', 'Nueve');
  const later9 = await create('Captura Posterior', '55 0000 0009', 'odonteck');
  assert.equal(row(later9).phone_key, waContact('5215500000009').phone_key);
  assert.equal(row(later9).persona_id, waContact('5215500000009').persona_id);
  await textIn('14155550109', 'Hello', 'Nine');
  const foreign = await create('Captura Extranjera', '1 (415) 555-0109', 'dermalysse');
  assert.equal(row(foreign).phone_key, '14155550109');
  assert.equal(row(foreign).persona_id, waContact('14155550109').persona_id);

  // ---- al final, ningún contacto tiene una clave distinta de la de su teléfono
  assert.ok(assertKeysInSync(db) >= 15);
});

// ---------------------------------------------------------------------------------------------------------------
// E. Candado para lo que venga después
// ---------------------------------------------------------------------------------------------------------------

test('candado: toda sentencia del servidor que escribe contacts.phone escribe también phone_key', async () => {
  const assigns = (list, column) => new RegExp('(?:^|,)\\s*' + column + '\\s*=').test(list);
  const offenders = [];
  let writers = 0;
  for (const file of await readdir('server', { recursive: true })) {
    if (!file.endsWith('.mjs')) continue;
    const source = await readFile(join('server', file), 'utf8');
    for (const [statement, columns] of source.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+contacts\s*\(([^)]*)\)/gi)) {
      const list = columns.split(',').map(column => column.trim());
      if (!list.includes('phone')) continue;
      writers++;
      if (!list.includes('phone_key')) offenders.push(file + ': ' + statement);
    }
    for (const [statement, rest] of source.matchAll(/UPDATE\s+contacts\s+SET\s+(.*)/gi)) {
      const set = rest.split(/\sWHERE\s/i)[0];
      if (!assigns(set, 'phone')) continue;
      writers++;
      if (!assigns(set, 'phone_key')) offenders.push(file + ': ' + statement.slice(0, 120));
    }
  }
  assert.deepEqual(offenders, [], 'estas sentencias dejarían la clave sin actualizar');
  assert.ok(
    writers >= 5,
    'el candado sigue encontrando las sentencias que escriben el teléfono (halló ' + writers + ')',
  );
});
