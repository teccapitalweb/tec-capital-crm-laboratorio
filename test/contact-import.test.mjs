import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { phoneKey } from '../server/lib/identity-keys.mjs';
import { CSV_BOM, parseCsv } from '../server/lib/csv.mjs';
import { mapRow, suggestMapping } from '../server/modules/contact-import/mapping.mjs';
import { parseDate } from '../server/modules/contact-import/rows.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { crash, openDb, until } from './helpers/crm.mjs';

// Importar contactos por CSV (docs/PLAN_IMPORTAR_CONTACTOS.md): módulo contact-import con el ejecutor de trabajos por
// trozos. Todo lo de aquí es inventado: nombres, teléfonos, correos y el archivo con la forma de la exportación del
// proveedor anterior.

const PASSWORD = 'Password-importar-2026!';
const ROWS = 6500;
const BUDGET_MS = 120_000; // holgado: en una máquina tranquila, 6 500 filas tardan unos 5 a 10 s en cada fase
const ORIGIN = 'Aceptaron recibir promociones al inscribirse en el formulario del curso.';

// ---------------------------------------------------------------------------------------------------------------
// El archivo sintético
// ---------------------------------------------------------------------------------------------------------------

const FIRST = ['Ana', 'José', 'María', 'Íñigo', 'Lucía', 'Ñoño', 'Renée', 'Óscar', 'Ángel', 'Úrsula'];
const LAST = ['Pérez', 'Núñez', 'Gómez', 'Ibáñez', 'Martínez', 'Sánchez', 'Ordóñez'];
const quote = value => (/[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value);

// Una exportación con la forma de la del proveedor anterior: Name, CountryCode, Phone, Allow Campaign, Allow SMS y,
// desde la sexta columna, datos de contacto; además una columna de etiquetas. Con BOM y CRLF, como la guarda una hoja.
// Devuelve el texto y lo que se espera de cada fila.
function previousExport(rows = ROWS, { seed = 0 } = {}) {
  const lines = [['Name', 'CountryCode', 'Phone', 'Allow Campaign', 'Allow SMS', 'ciudad', 'seguimiento', 'Tags']];
  const expect = { valid: 0, invalid: 0, duplicates: 0, shape: 0, optedIn: 0, optedOut: 0 };
  const seen = [];
  for (let i = 1; i <= rows; i++) {
    const n = seed + i;
    const national = String(5510000000 + n); // diez dígitos de México
    let name = `${FIRST[n % FIRST.length]} ${LAST[n % LAST.length]} ${n}`;
    let cc = '52';
    let phone = national;
    const form = n % 8;
    if (form === 1) [cc, phone] = ['', '521' + national]; // como lo entrega WhatsApp
    if (form === 2) [cc, phone] = ['', `+52 ${national.slice(0, 2)} ${national.slice(2, 6)} ${national.slice(6)}`];
    if (form === 3) phone = `(${national.slice(0, 2)}) ${national.slice(2, 6)}-${national.slice(6)}`;
    if (form === 4) [cc, phone] = ['', String(14155000000 + n)]; // extranjero sin «+»
    if (form === 5) phone = national + '.0'; // la hoja lo guardó con decimales
    if (form === 6) [cc, phone] = ['1', String(4155000000 + n)];
    let consent = ['TRUE', 'FALSE', '', 'true'][n % 4];
    let extra = null;
    let kind = 'valid';
    if (i % 97 === 0 && seen.length) {
      // Repite a una persona anterior, con otro nombre.
      [cc, phone] = seen[(i * 7) % seen.length];
      name = 'Repetido ' + n;
      kind = 'duplicate';
    } else if (i % 211 === 0) {
      phone = 'sin teléfono';
      kind = 'invalid';
    } else if (i % 223 === 0) {
      phone = '';
      kind = 'invalid'; // ni teléfono ni correo
    } else if (i % 227 === 0) {
      extra = 'columna de más';
      kind = 'shape';
    }
    if (i % 50 === 0) name = ['=HYPERLINK("http://ejemplo.invalid","clic")', '@SUMA(1;2)', '-Pedro', '+Carla'][i % 4];
    if (kind === 'valid') seen.push([cc, phone]);
    expect[kind === 'shape' ? 'shape' : kind === 'duplicate' ? 'duplicates' : kind]++;
    if (kind === 'valid' && /^true$/i.test(consent)) expect.optedIn++;
    if (kind === 'valid' && consent === 'FALSE') expect.optedOut++;
    const city = n % 5 === 0 ? '' : ['Puebla', 'Mérida', 'León', 'Querétaro'][n % 4];
    const follow = ['PENDIENTE', 'pagado', '', 'Pendiente'][n % 4];
    const tags = n % 3 === 0 ? 'Curso aves; Webinar' : n % 3 === 1 ? 'Webinar' : '';
    const cells = [name, cc, phone, consent, n % 2 ? 'TRUE' : 'FALSE', city, follow, tags];
    if (extra) cells.push(extra);
    lines.push(cells);
  }
  return { text: CSV_BOM + lines.map(cells => cells.map(quote).join(',')).join('\r\n') + '\r\n', expect };
}

// ---------------------------------------------------------------------------------------------------------------
// Piezas puras
// ---------------------------------------------------------------------------------------------------------------

test('mapeo: la exportación del proveedor anterior se reconoce y cada columna va a su destino', () => {
  const header = ['Name', 'CountryCode', 'Phone', 'Allow Campaign', 'Allow SMS', 'Ciudad', 'curso', 'Tags', 'otra'];
  const suggestion = suggestMapping(header, [
    { key: 'ciudad', label: 'Ciudad' },
    { key: 'curso_origen', label: 'Curso' },
  ]);
  assert.equal(suggestion.template, 'previous-provider');
  assert.deepEqual(suggestion.targets, [
    'name',
    'countryCode',
    'phone',
    'consent',
    'ignore',
    'attr:ciudad',
    'attr:curso_origen',
    'ignore', // desde la sexta columna sólo datos de contacto, como exporta esa herramienta
    'ignore',
  ]);
  const generic = suggestMapping(['Nombre', 'Teléfono', 'Correo', 'Etiquetas'], []);
  assert.deepEqual(generic.targets, ['name', 'phone', 'email', 'tags']);

  const { row, problems } = mapRow(
    ["'=SUMA(1)", ' 52 ', '55 1234 5678', 'sí', 'x', 'Puebla', 'A; B ;a ; ', 'B'],
    ['name', 'countryCode', 'phone', 'consent', 'ignore', 'attr:ciudad', 'tags', 'tags'],
  );
  assert.deepEqual(problems, []);
  assert.equal(row.name, '=SUMA(1)', 'se deshace la protección de una exportación del CRM y se guarda como texto');
  assert.equal(row.consent, true);
  assert.deepEqual(row.tags, ['A', 'B', 'a']);
  assert.deepEqual(row.attrs, { ciudad: 'Puebla' });
  assert.equal(mapRow(['quizá'], ['consent']).problems[0].code, 'consent_invalid');
  assert.equal(mapRow([''], ['consent']).row.consent, null, 'una celda vacía no dice nada del consentimiento');
  assert.equal(parseDate('13/11/2026'), Date.UTC(2026, 10, 13));
  assert.equal(parseDate('31/02/2026'), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Con el servidor real
// ---------------------------------------------------------------------------------------------------------------

async function lab(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-import-'));
  const code = randomUUID();
  const settings = { ADMIN_INVITE_CODE: code, IMPORT_MAX_ROWS: '10000', JOBS_LEASE_MS: '1500', ...env };
  let server = await startServer({ dir, env: settings });
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
      headers: {
        Cookie: cookie ?? '',
        Origin: server.origin,
        'Content-Type': raw ? 'text/csv' : 'application/json',
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await response.text();
    const data = response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : { text };
    assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 400)}`);
    return { ...data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const reg = (username, inviteCode) =>
    call('/api/auth/register', '', { username, name: 'Prueba ' + username, password: PASSWORD, inviteCode });
  const admin = await reg('admin', code);
  const restart = async () => {
    await crash(server);
    server = await startServer({ dir, env: settings });
  };
  const database = () => (db ??= openDb(dir));
  return { dir, call, reg, admin: admin.cookie, restart, db: database, logs: () => server.logs() };
}

// Sube un archivo, guarda el mapeo y espera la vista previa.
async function uploadAndPreview(
  call,
  cookie,
  text,
  { brand = 'globalvet', name = 'exportacion.csv', options, targets } = {},
) {
  const ref = randomUUID();
  const uploaded = (
    await call(`/api/contact-import/uploads?brand=${brand}&name=${name}&clientRef=${ref}`, cookie, text, 'POST', 201)
  ).import;
  const mapped = (
    await call(
      `/api/contact-import/${uploaded.id}/mapping`,
      cookie,
      { expectedRevision: uploaded.revision, targets: targets ?? uploaded.suggested.targets, options },
      'PUT',
    )
  ).import;
  await call(
    `/api/contact-import/${uploaded.id}/validate`,
    cookie,
    { expectedRevision: mapped.revision, clientRef: randomUUID() },
    'POST',
    202,
  );
  const started = Date.now();
  const validated = await until(
    async () => {
      const current = (await call(`/api/contact-import/${uploaded.id}`, cookie)).import;
      return current.state === 'validated' ? current : null;
    },
    'la vista previa termina',
    { ms: BUDGET_MS },
  );
  return { uploaded, validated, ms: Date.now() - started };
}

async function applyAndWait(call, cookie, imported, body = {}) {
  const started = Date.now();
  await call(
    `/api/contact-import/${imported.id}/apply`,
    cookie,
    { expectedRevision: imported.revision, clientRef: randomUUID(), ...body },
    'POST',
    202,
  );
  const done = await until(
    async () => {
      const current = (await call(`/api/contact-import/${imported.id}`, cookie)).import;
      return current.state === 'done' ? current : null;
    },
    'la importación termina',
    { ms: BUDGET_MS },
  );
  return { done, ms: Date.now() - started };
}

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

test('6 500 filas de la exportación anterior: vista previa sin escribir, importación, segunda corrida sin cambios', async t => {
  const { call, admin, db: labDb } = await lab(t);
  // Datos de contacto de la marca (la importación sólo usa los que existen).
  await call(
    '/api/attributes',
    admin,
    { brandId: 'globalvet', key: 'ciudad', label: 'Ciudad', type: 'text' },
    'POST',
    201,
  );
  await call(
    '/api/attributes',
    admin,
    {
      brandId: 'globalvet',
      key: 'seguimiento',
      label: 'Seguimiento',
      type: 'select',
      options: ['PENDIENTE', 'PAGADO'],
    },
    'POST',
    201,
  );
  // Quien ya escribía por WhatsApp (se guarda con el «1» de WhatsApp), quien pidió la baja y el mismo número en otra
  // marca. Las filas 8 y 16 del archivo son esas dos personas.
  const db = labDb();
  const whatsappPhone = '+521' + String(5510000000 + 8);
  db.prepare(
    "INSERT INTO contacts(id,brand_id,name,phone,phone_key,email,source,created_at,updated_at) VALUES('c-wa','globalvet','Cliente WhatsApp',?,?,'','whatsapp',1,1)",
  ).run(whatsappPhone, phoneKey(whatsappPhone));
  const optedOut = (
    await call(
      '/api/crm/contacts',
      admin,
      { brandId: 'globalvet', name: 'Dio de baja', phone: String(5510000000 + 16) },
      'POST',
      201,
    )
  ).id;
  await call(`/api/crm/contacts/${optedOut}/consent`, admin, { status: 'opted_out', note: 'Pidió la baja' }, 'PUT');
  const other = (
    await call(
      '/api/crm/contacts',
      admin,
      { brandId: 'odonteck', name: 'Otra marca', phone: String(5510000000 + 8) },
      'POST',
      201,
    )
  ).id;
  const before = {
    contacts: count(db, "SELECT count(*) n FROM contacts WHERE brand_id='globalvet'"),
    persons: count(db, 'SELECT count(*) n FROM persons'),
    tags: count(db, "SELECT count(*) n FROM contact_tags WHERE brand_id='globalvet'"),
    values: count(db, 'SELECT count(*) n FROM contact_attribute_values'),
    consent: count(db, 'SELECT count(*) n FROM contact_consent_events'),
  };

  const { text, expect } = previousExport();
  const tagsColumn = 7;
  const preview = await uploadAndPreview(call, admin, text, {
    options: { consent: { mode: 'declared', origin: ORIGIN } },
    targets: ['name', 'countryCode', 'phone', 'consent', 'ignore', 'attr:ciudad', 'attr:seguimiento', 'tags'],
  });
  const { uploaded, validated } = preview;
  assert.equal(uploaded.rows, ROWS);
  assert.equal(uploaded.encoding, 'utf-8');
  assert.deepEqual(uploaded.header.slice(0, 3), ['Name', 'CountryCode', 'Phone'], 'el BOM no entra en el encabezado');
  assert.equal(uploaded.templates[0].detected, true);
  assert.equal(uploaded.suggested.targets[tagsColumn], 'ignore');
  assert.equal(uploaded.sample.length, 20);

  // El simulacro no escribe nada fuera de su propio informe.
  assert.deepEqual(
    {
      contacts: count(db, "SELECT count(*) n FROM contacts WHERE brand_id='globalvet'"),
      persons: count(db, 'SELECT count(*) n FROM persons'),
      tags: count(db, "SELECT count(*) n FROM contact_tags WHERE brand_id='globalvet'"),
      values: count(db, 'SELECT count(*) n FROM contact_attribute_values'),
      consent: count(db, 'SELECT count(*) n FROM contact_consent_events'),
    },
    before,
  );
  const p = validated.report;
  assert.equal(p.totals.rows, ROWS);
  assert.equal(p.totals.errors, expect.invalid + expect.shape);
  assert.equal(p.totals.skipped, expect.duplicates);
  assert.equal(p.totals.updated, 2, 'el cliente de WhatsApp y quien dio de baja se reconocen');
  assert.equal(p.totals.created, expect.valid - 2);
  assert.equal(p.problems.row_shape, expect.shape);
  assert.equal(p.problems.duplicate_in_file, expect.duplicates);
  assert.equal(p.consent.keptOptOut, 1, 'una baja nunca se levanta');
  assert.equal(p.consent.optedIn, expect.optedIn - 1);
  console.log(`vista previa de ${ROWS} filas: ${preview.ms} ms`);

  // Filas con problema, de 50 en 50, y su CSV.
  const errors = await call(`/api/contact-import/${uploaded.id}/rows?phase=preview&filter=errors`, admin);
  assert.equal(errors.rows.length, Math.min(50, expect.invalid + expect.shape));
  assert.ok(errors.rows.every(r => r.action === 'error' && r.message && r.line > 1));
  const phoneProblem = errors.rows.find(r => r.problem === 'phone_invalid');
  assert.equal(phoneProblem.column, 'Phone');
  assert.equal(phoneProblem.value, 'sin teléfono');
  const csv = await call(`/api/contact-import/${uploaded.id}/errors.csv?phase=preview`, admin);
  const table = parseCsv(csv.text);
  assert.deepEqual(table[0].cells, ['fila', 'linea', 'resultado', 'columna', 'problema', 'valor']);
  assert.equal(table.length - 1, expect.invalid + expect.shape + expect.duplicates);

  // Importar exige confirmar la declaración del origen del permiso.
  await call(
    `/api/contact-import/${uploaded.id}/apply`,
    admin,
    { expectedRevision: validated.revision, clientRef: randomUUID() },
    'POST',
    400,
  );
  const applied = await applyAndWait(call, admin, validated, { confirmConsent: true });
  console.log(`importación de ${ROWS} filas: ${applied.ms} ms`);
  const r = applied.done.report;
  assert.deepEqual(r.totals, p.totals, 'la importación hace exactamente lo que anunció la vista previa');
  assert.deepEqual(r.consent, p.consent);
  assert.equal(applied.done.options.consent.confirmedBy !== undefined, true);

  // Quien escribía por WhatsApp no se duplicó y recibió nombre, datos y etiquetas; la otra marca no se tocó.
  assert.equal(
    count(db, "SELECT count(*) n FROM contacts WHERE brand_id='globalvet' AND phone_key=?", phoneKey(whatsappPhone)),
    1,
  );
  const wa = db.prepare("SELECT * FROM contacts WHERE id='c-wa'").get();
  assert.equal(wa.phone, whatsappPhone, 'el teléfono guardado no se reescribe');
  assert.equal(wa.name, 'Ángel Núñez 8');
  assert.equal(db.prepare('SELECT name,updated_at FROM contacts WHERE id=?').get(other).name, 'Otra marca');
  assert.equal(count(db, 'SELECT count(*) n FROM contact_import_rows WHERE contact_id=?', other), 0);
  // La baja se conservó; los «TRUE» declarados quedaron como «acepta» con origen import y la declaración en la nota.
  assert.equal(db.prepare('SELECT status FROM contact_consent WHERE contact_id=?').get(optedOut).status, 'opted_out');
  const accepted = db
    .prepare(
      "SELECT k.status,k.source,k.note FROM contact_consent k JOIN contacts c ON c.id=k.contact_id WHERE c.brand_id='globalvet' AND k.status='opted_in'",
    )
    .all();
  assert.equal(accepted.length, expect.optedIn - 1);
  assert.ok(accepted.every(k => k.source === 'import' && k.note.includes(ORIGIN)));
  assert.equal(
    count(
      db,
      "SELECT count(*) n FROM contact_consent k JOIN contacts c ON c.id=k.contact_id WHERE c.brand_id='globalvet' AND k.status='opted_out' AND k.source='import'",
    ),
    expect.optedOut,
  );
  // Fórmulas guardadas como texto, acentos intactos, datos de lista por su opción y etiquetas creadas una vez.
  assert.ok(
    count(db, "SELECT count(*) n FROM contacts WHERE brand_id='globalvet' AND name LIKE '=HYPERLINK(%'") > 0,
    'una fórmula se guarda como texto',
  );
  assert.ok(count(db, "SELECT count(*) n FROM contacts WHERE brand_id='globalvet' AND name LIKE 'Íñigo Ibáñez%'") > 0);
  assert.deepEqual(
    db
      .prepare(
        "SELECT DISTINCT v.value FROM contact_attribute_values v JOIN contact_attributes a ON a.id=v.attribute_id WHERE a.key='seguimiento' ORDER BY 1",
      )
      .all()
      .map(x => x.value),
    ['PAGADO', 'PENDIENTE'],
  );
  assert.equal(count(db, "SELECT count(*) n FROM contact_tags WHERE brand_id='globalvet'"), 2);
  assert.equal(count(db, "SELECT count(*) n FROM contact_attribute_events WHERE source='import'") > 0, true);
  assert.equal(
    count(db, "SELECT count(*) n FROM domain_events WHERE type='contacto.atributo_cambiado'"),
    0,
    'sin un evento por contacto',
  );
  assert.equal(count(db, "SELECT count(*) n FROM domain_events WHERE type='contactos.importados'"), 1);
  // Cada contacto nuevo tiene su persona.
  assert.equal(
    count(db, "SELECT count(*) n FROM contacts WHERE brand_id='globalvet' AND source='import' AND persona_id IS NULL"),
    0,
  );
  assertSchemaCurrent(db);

  // Segunda corrida con el mismo archivo: avisa que ya se importó y no cambia nada (puerta 2).
  const again = await uploadAndPreview(call, admin, text, {
    options: { consent: { mode: 'declared', origin: ORIGIN } },
    targets: ['name', 'countryCode', 'phone', 'consent', 'ignore', 'attr:ciudad', 'attr:seguimiento', 'tags'],
  });
  assert.equal(again.uploaded.previous.id, uploaded.id);
  const snapshot = () => ({
    contacts: count(db, "SELECT count(*) n FROM contacts WHERE brand_id='globalvet'"),
    updated: count(db, "SELECT max(updated_at) n FROM contacts WHERE brand_id='globalvet'"),
    consent: count(db, 'SELECT count(*) n FROM contact_consent_events'),
    values: count(db, 'SELECT count(*) n FROM contact_attribute_events'),
    links: count(db, 'SELECT count(*) n FROM contact_tag_links'),
  });
  const beforeSecond = snapshot();
  const second = await applyAndWait(call, admin, again.validated, { confirmConsent: true });
  const s = second.done.report.totals;
  assert.equal(s.created, 0);
  assert.equal(s.updated, 0);
  assert.equal(s.unchanged, p.totals.created + p.totals.updated);
  assert.deepEqual(snapshot(), beforeSecond, 'la segunda corrida no cambió nada');
});

test('consentimiento sin declaración: TRUE queda «sin registro», FALSE registra la baja', async t => {
  const { call, admin, db: labDb } = await lab(t);
  const db = labDb();
  const text =
    'Nombre,Teléfono,Acepta promociones\nUno Prueba,5520000001,TRUE\nDos Prueba,5520000002,FALSE\nTres Prueba,5520000003,\n';
  const { validated } = await uploadAndPreview(call, admin, text, { targets: ['name', 'phone', 'consent'] });
  assert.deepEqual(validated.report.consent, { optedIn: 0, optedOut: 1, keptOptOut: 0, notRecorded: 1 });
  const { done } = await applyAndWait(call, admin, validated);
  assert.equal(done.report.totals.created, 3);
  const status = phone =>
    db
      .prepare('SELECT k.status FROM contacts c LEFT JOIN contact_consent k ON k.contact_id=c.id WHERE c.phone_key=?')
      .get(phoneKey(phone))?.status ?? 'unknown';
  assert.equal(status('5520000001'), 'unknown');
  assert.equal(status('5520000002'), 'opted_out');
  assert.equal(status('5520000003'), 'unknown');
  // Una declaración demasiado corta no se acepta.
  const short = (await call(`/api/contact-import/uploads?brand=globalvet&name=b.csv`, admin, text, 'POST', 201)).import;
  const response = await call(
    `/api/contact-import/${short.id}/mapping`,
    admin,
    {
      expectedRevision: short.revision,
      targets: ['name', 'phone', 'consent'],
      options: { consent: { mode: 'declared', origin: 'corto' } },
    },
    'PUT',
    400,
  );
  assert.equal(response.code, 'consent_origin');
});

test('permisos, alcance por marca, límites y limpieza del archivo', async t => {
  const { dir, call, reg, admin, db: labDb } = await lab(t, { IMPORT_MAX_ROWS: '5' });
  const a = await reg('asesor.a');
  const b = await reg('asesor.b');
  for (const [user, username, brandIds] of [
    [a, 'asesor.a', ['globalvet']],
    [b, 'asesor.b', ['odonteck']],
  ]) {
    const invite = await call('/api/team/invites', admin, { username, brandIds }, 'POST', 201);
    await call('/api/team/accept', user.cookie, { token: invite.token });
  }
  const text = 'Name,Phone\nUno,5530000001\nDos,5530000002\n';
  const created = (await call('/api/contact-import/uploads?brand=globalvet&name=a.csv', admin, text, 'POST', 201))
    .import;
  // Asesoría no importa (403), ni en su marca ni en otra; lo que no existe, 404.
  await call('/api/contact-import/uploads?brand=globalvet', a.cookie, text, 'POST', 403);
  await call(`/api/contact-import/${created.id}`, a.cookie, undefined, 'GET', 403);
  await call(`/api/contact-import/${created.id}/rows`, b.cookie, undefined, 'GET', 403);
  await call('/api/contact-import?brand=odonteck', b.cookie, undefined, 'GET', 403);
  await call(`/api/contact-import/${randomUUID()}`, admin, undefined, 'GET', 404);
  await call('/api/contact-import?brand=no-existe', admin, undefined, 'GET', 404);
  await call(`/api/jobs/${randomUUID()}`, admin, undefined, 'GET', 404);
  // Límites: filas (IMPORT_MAX_ROWS=5 aquí), columnas, comillas sin cerrar y archivo vacío.
  const many = 'Name,Phone\n' + Array.from({ length: 6 }, (_, i) => `N${i},55300000${10 + i}`).join('\n');
  assert.equal(
    (await call('/api/contact-import/uploads?brand=globalvet', admin, many, 'POST', 413)).code,
    'too_many_rows',
  );
  const wide = Array.from({ length: 101 }, (_, i) => 'c' + i).join(',') + '\n1\n';
  assert.equal(
    (await call('/api/contact-import/uploads?brand=globalvet', admin, wide, 'POST', 400)).code,
    'too_many_columns',
  );
  const broken = 'Name,Phone\n"Sin cerrar,5530000001\n';
  assert.equal(
    (await call('/api/contact-import/uploads?brand=globalvet', admin, broken, 'POST', 400)).code,
    'unclosed_quote',
  );
  assert.equal(
    (await call('/api/contact-import/uploads?brand=globalvet', admin, 'Name,Phone\n', 'POST', 400)).code,
    'no_rows',
  );
  // El mismo clientRef no sube dos veces; un mapeo sin teléfono ni correo no vale; una revisión vieja, 409.
  const ref = randomUUID();
  const one = (await call(`/api/contact-import/uploads?brand=globalvet&clientRef=${ref}`, admin, text, 'POST', 201))
    .import;
  assert.equal(
    (await call(`/api/contact-import/uploads?brand=globalvet&clientRef=${ref}`, admin, text, 'POST', 200)).import.id,
    one.id,
  );
  const bad = { expectedRevision: one.revision, targets: ['name', 'ignore'] };
  assert.equal((await call(`/api/contact-import/${one.id}/mapping`, admin, bad, 'PUT', 400)).code, 'mapping_invalid');
  await call(
    `/api/contact-import/${one.id}/mapping`,
    admin,
    { expectedRevision: one.revision, targets: ['name', 'phone'] },
    'PUT',
  );
  const stale = await call(
    `/api/contact-import/${one.id}/validate`,
    admin,
    { expectedRevision: one.revision },
    'POST',
    409,
  );
  assert.equal(stale.code, 'stale_record');
  // Importar sin vista previa no se puede.
  assert.equal(
    (await call(`/api/contact-import/${one.id}/apply`, admin, { expectedRevision: one.revision + 1 }, 'POST', 409))
      .code,
    'preview_required',
  );
  // Cancelar una importación sin empezar la descarta.
  assert.equal((await call(`/api/contact-import/${one.id}/cancel`, admin, {}, 'POST')).import.state, 'cancelled');

  // A los 7 días de terminar se borra el archivo y el detalle de las filas.
  const db = labDb();
  const file = join(dir, 'imports', `${created.id}.csv`);
  assert.ok(existsSync(file));
  db.prepare('UPDATE contact_imports SET updated_at=1 WHERE id=?').run(created.id);
  await until(
    () => db.prepare('SELECT purged_at FROM contact_imports WHERE id=?').get(created.id).purged_at,
    'la limpieza borra el archivo',
  );
  assert.equal(existsSync(file), false);
  assert.equal((await call(`/api/contact-import/${created.id}`, admin)).import.purged, true);
});

test('un reinicio a mitad de la importación continúa sin duplicar', async t => {
  const { call, admin, restart, db: labDb } = await lab(t, { JOBS_ROWS_PER_PASS: '100' });
  const db = labDb();
  const { text } = previousExport(3000, { seed: 100_000 });
  const { validated } = await uploadAndPreview(call, admin, text);
  const expected = validated.report.totals;
  await call(
    `/api/contact-import/${validated.id}/apply`,
    admin,
    { expectedRevision: validated.revision, clientRef: randomUUID() },
    'POST',
    202,
  );
  await until(
    () => {
      const job = db.prepare("SELECT done FROM background_jobs WHERE kind='contact-import.apply'").get();
      return job && job.done >= 500 && job.done < 2500;
    },
    'la importación va a la mitad',
    { ms: 30_000 },
  );
  await restart(); // muerte brusca: lo que estuviera a medias se deshace
  const half = db.prepare("SELECT done,state FROM background_jobs WHERE kind='contact-import.apply'").get();
  assert.equal(half.state, 'running');
  const done = await until(
    async () => {
      const current = (await call(`/api/contact-import/${validated.id}`, admin)).import;
      return current.state === 'done' ? current : null;
    },
    'la importación termina tras el reinicio',
    { ms: BUDGET_MS },
  );
  assert.deepEqual(done.report.totals, expected);
  assert.equal(
    count(db, "SELECT count(*) n FROM contact_import_rows WHERE import_id=? AND phase='apply'", validated.id),
    3000,
  );
  assert.equal(
    count(
      db,
      "SELECT count(*) n FROM (SELECT phone_key FROM contacts WHERE brand_id='globalvet' AND phone_key!='' GROUP BY phone_key HAVING count(*)>1)",
    ),
    0,
    'ningún teléfono quedó repetido',
  );
  assert.equal(
    count(db, "SELECT count(*) n FROM contacts WHERE brand_id='globalvet' AND source='import'"),
    expected.created,
  );
});
