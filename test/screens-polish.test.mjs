// Pulido de las pantallas nuevas (Contactos, Audiencias, Difusiones): el filtro «Sin teléfono» y el distintivo
// «sin número», añadir contactos a una lista, buscar dentro de los miembros y exportarlos a CSV. Todo lo de aquí es
// inventado: nombres, teléfonos, correos e identificadores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { fail } from '../server/app/http.mjs';
import { createPersonData } from '../server/lib/person-data.mjs';
import { phoneKey } from '../server/lib/identity-keys.mjs';
import { CSV_BOM, parseCsv, stripBom } from '../server/lib/csv.mjs';
import attributesModule from '../server/modules/attributes/module.mjs';
import audiencesModule, { LIMITS, exportFilename } from '../server/modules/audiences/module.mjs';
import directoryModule from '../server/modules/directory/module.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';

const BRAND = 'globalvet';
const OTHER = 'odonteck';
const BSUID = 'MX.9f3c2b7a6d5e4f10a1b2';
const ALL = ['contacts.view', 'contacts.phone', 'campaigns.view', 'audiences.edit', 'contacts.export'];

// Una base migrada con contactos de dos marcas: con teléfono, sin teléfono y que conversa por WhatsApp real sólo con
// su identificador de usuario («sin número»), y uno de otra marca igual.
async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-screens-polish-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  migrate(db, { dataDir: dir, backup: false });
  assertSchemaCurrent(db);
  const user = db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,'x',?,?,1,1)",
  );
  user.run('u-admin', 'admin.pulido', 'Administración', 'admin', 990101);
  user.run('cli-wa', 'cliente.wa', 'Cliente sin número', 'customer', 990102);
  user.run('cli-od', 'cliente.od', 'Cliente otra marca', 'customer', 990103);
  const contact = db.prepare(
    "INSERT INTO contacts(id,brand_id,name,phone,phone_key,email,source,source_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'manual',?,1,1)",
  );
  const phone = '+52 55 4321 9876';
  contact.run('gv-tel', BRAND, 'Fernanda Zúñiga', phone, phoneKey(phone), 'fer.secreta@correo.invalid', null);
  contact.run('gv-wa', BRAND, 'Julián Sin Número', '', '', '', 'cli-wa');
  contact.run('gv-nada', BRAND, 'Rosa Sin Datos', '', '', '', null);
  contact.run('gv-formula', BRAND, '=HIPERVINCULO("http://x")', '', '', '', null);
  contact.run('od-wa', OTHER, 'Otra Marca Sin Número', '', '', '', 'cli-od');
  const conversation = db.prepare(
    "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at,wa_number) VALUES(?,?,?,?,'whatsapp',1,1,?)",
  );
  conversation.run('cv-wa', 'cli-wa', BRAND, 'aves', 'num-prueba');
  conversation.run('cv-od', 'cli-od', OTHER, 'odontologia', 'num-otro');
  db.prepare(
    "INSERT INTO identity_keys(kind,scope,value,user_id,username,source,first_seen,last_seen) VALUES('wa_bsuid','waba:prueba',?,'cli-wa','julian.prueba','webhook',1,1)",
  ).run(BSUID);
  return db;
}

// `access` de mentira: los permisos que se le den, sólo en la marca BRAND (la otra, 404 como en el servidor).
function accessFor(perms) {
  const has = new Set(perms);
  return {
    require(_user, permission, brand) {
      if (brand !== undefined && brand !== BRAND) throw fail(404, 'Marca o registro no disponible.');
      if (!has.has(permission)) throw fail(403, 'Sin permiso.', { code: 'permission_denied' });
    },
    can: (_user, permission, brand) => has.has(permission) && (brand === undefined || brand === BRAND),
    brandIds: (_user, permission) => (has.has(permission) ? [BRAND] : []),
    phone: (_user, value) => (has.has('contacts.phone') || !value ? value : '•••• ' + String(value).slice(-4)),
  };
}

function directoryApi(db, perms) {
  const api = directoryModule.create({
    db,
    access: accessFor(perms),
    fail,
    json: (res, status, data) => Object.assign(res, { status, data }),
    realtime: { emit() {} },
  });
  return async query => {
    const res = {};
    const url = new URL('http://localhost/api/contacts?' + new URLSearchParams({ brand: BRAND, ...query }));
    await api.handle({ method: 'GET' }, res, '/api/contacts', { id: 'u-admin' }, url);
    return res.data;
  };
}

function audiencesApi(db, perms) {
  const audits = [];
  const hits = new Map();
  const modules = {};
  const host = {
    db,
    transaction,
    fail,
    personData: createPersonData({ db }),
    services: { events: { registerTypes() {}, publish() {} } },
    access: accessFor(perms),
    realtime: { emit() {} },
    body: async req => req.body,
    json: (res, status, data) => Object.assign(res, { status, data }),
    audit: (user, action, id) => audits.push({ user: user.id, action, id }),
    // Límite de frecuencia como el del servidor: más de `max` en la ventana responde 429.
    rate(key, max) {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      if (n > max) throw fail(429, 'Demasiadas solicitudes.', { code: 'rate_limited' });
    },
    module(name) {
      if (!modules[name]) throw new Error('sin módulo ' + name);
      return modules[name];
    },
  };
  modules.attributes = attributesModule.create(host);
  modules.audiences = audiencesModule.create(host);
  const call = async (method, path, body, query = {}) => {
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      end(text) {
        this.text = text;
      },
    };
    const url = new URL('http://localhost' + path + '?' + new URLSearchParams(query));
    await modules.audiences.handle({ method, body }, res, path, { id: 'u-admin' }, url);
    return res;
  };
  return { api: modules.audiences, call, audits, hits };
}

const rejects = (promise, status) => assert.rejects(promise, error => error.status === status);
const csvRows = text => parseCsv(stripBom(text), { delimiter: ',' }).map(row => row.cells);

// ---------------------------------------------------------------------------------------------------------------
// Contactos: «Sin teléfono» y «sin número»
// ---------------------------------------------------------------------------------------------------------------

test('contactos: el filtro «Sin teléfono» y el distintivo «sin número» sólo dicen eso, en su marca', async t => {
  const db = await world(t);
  const get = directoryApi(db, ALL);
  const sinTelefono = await get({ quick: 'no_phone', sort: 'name', dir: 'asc' });
  assert.deepEqual(sinTelefono.contacts.map(c => c.id).sort(), ['gv-formula', 'gv-nada', 'gv-wa']);
  assert.equal(sinTelefono.total.n, 3);
  const porId = Object.fromEntries(sinTelefono.contacts.map(c => [c.id, c]));
  assert.equal(porId['gv-wa'].noNumber, true, 'conversa por WhatsApp real sin teléfono');
  assert.equal(porId['gv-nada'].noNumber, false, 'sin teléfono y sin WhatsApp real: no es «sin número»');
  // Con teléfono nunca es «sin número»; «Con teléfono» y «Sin teléfono» no se pisan.
  const conTelefono = await get({ quick: 'with_phone' });
  assert.deepEqual(
    conTelefono.contacts.map(c => [c.id, c.noNumber]),
    [['gv-tel', false]],
  );
  assert.equal((await get({ quick: 'with_phone,no_phone' })).contacts.length, 0);
  // La otra marca no aparece aunque tenga un «sin número».
  assert.ok(!sinTelefono.contacts.some(c => c.brandId === OTHER));
});

test('contactos: sin ver datos completos, «Sin teléfono» no deja adivinar un teléfono ni un identificador', async t => {
  const db = await world(t);
  const hidden = directoryApi(db, ['contacts.view']);
  const full = directoryApi(db, ALL);
  // El mismo resultado con y sin el permiso: el filtro no depende de lo que se oculta.
  const ids = async get => (await get({ quick: 'no_phone' })).contacts.map(c => c.id).sort();
  assert.deepEqual(await ids(hidden), await ids(full));
  const page = await hidden({ quick: 'no_phone' });
  const text = JSON.stringify(page);
  assert.ok(!text.includes(BSUID) && !text.includes(BSUID.slice(-4)), 'ni el identificador ni sus últimos dígitos');
  assert.ok(!text.includes('julian.prueba'), 'ni el usuario de WhatsApp');
  assert.ok(!/bsuid|username/i.test(text));
  // Buscar por el identificador o por sus dígitos no encuentra a nadie (la búsqueda no mira las llaves de WhatsApp).
  for (const q of [BSUID, '9f3c2b7a', '10a1b2', 'a1b2'])
    assert.deepEqual((await hidden({ q })).contacts, [], `buscar ${q}`);
  for (const q of [BSUID, '9f3c2b7a']) assert.deepEqual((await full({ q })).contacts, [], `buscar ${q} con permiso`);
  // Con el filtro, el teléfono de quien sí lo tiene sigue enmascarado.
  const masked = (await hidden({ quick: 'with_phone' })).contacts[0];
  assert.equal(masked.phone, '•••• 9876');
  assert.equal(masked.phoneMasked, true);
  assert.ok(!masked.email.includes('secreta'));
});

// ---------------------------------------------------------------------------------------------------------------
// Añadir a una lista desde Contactos
// ---------------------------------------------------------------------------------------------------------------

test('añadir a una lista: nueva o existente, idempotente, sin contactos de otra marca y con permiso', async t => {
  const db = await world(t);
  const { call, api } = audiencesApi(db, ALL);
  // Lista nueva con la selección; repetir con el mismo clientRef devuelve la misma lista sin duplicar.
  const body = { brandId: BRAND, kind: 'list', name: 'Desde contactos', contactIds: ['gv-tel', 'gv-wa', 'od-wa'] };
  const first = await call('POST', '/api/audiences', { ...body, clientRef: 'sel-1' });
  assert.equal(first.status, 201);
  assert.equal(first.data.audience.memberCount, 2, 'el de otra marca se ignora');
  const again = await call('POST', '/api/audiences', { ...body, clientRef: 'sel-1' });
  assert.equal(again.status, 200);
  assert.equal(again.data.audience.id, first.data.audience.id);
  assert.equal(again.data.audience.memberCount, 2);
  // Lista existente: añadir dos veces la misma selección no repite a nadie.
  const id = first.data.audience.id;
  const add = await call('POST', `/api/audiences/${id}/members`, { add: ['gv-tel', 'gv-nada', 'od-wa'] });
  assert.equal(add.data.added, 1);
  assert.equal(add.data.audience.memberCount, 3);
  const repeat = await call('POST', `/api/audiences/${id}/members`, { add: ['gv-tel', 'gv-nada', 'od-wa'] });
  assert.equal(repeat.data.added, 0);
  assert.equal(repeat.data.audience.memberCount, 3);
  const members = db.prepare('SELECT contact_id FROM audience_members WHERE audience_id=? ORDER BY 1').all(id);
  assert.deepEqual(
    members.map(m => m.contact_id),
    ['gv-nada', 'gv-tel', 'gv-wa'],
  );
  // La función para otros módulos también es idempotente e ignora la otra marca.
  assert.deepEqual(
    transaction(db, () => api.addContacts(BRAND, id, ['gv-tel', 'gv-formula', 'od-wa'])),
    { added: 1, refused: 1 },
  );
  assert.equal(transaction(db, () => api.addContacts(BRAND, id, ['gv-formula'])).added, 0);
  // Tope por llamada.
  const many = Array.from({ length: LIMITS.perCall + 1 }, (_, i) => `gv-x${i}`);
  await rejects(call('POST', `/api/audiences/${id}/members`, { add: many }), 400);
  // Sin `audiences.edit` no se cambia ninguna lista; una lista de otra marca no existe para esta persona.
  const viewer = audiencesApi(db, ['contacts.view', 'campaigns.view']);
  await rejects(viewer.call('POST', `/api/audiences/${id}/members`, { add: ['gv-formula'] }), 403);
  await rejects(viewer.call('POST', '/api/audiences', { ...body, clientRef: 'sel-2', name: 'Otra' }), 403);
  const ajena = await call('POST', '/api/audiences', { brandId: OTHER, kind: 'list', name: 'Ajena' }).catch(e => e);
  assert.equal(ajena.status, 404);
});

// ---------------------------------------------------------------------------------------------------------------
// Audiencias: buscar dentro de los miembros y exportar
// ---------------------------------------------------------------------------------------------------------------

test('miembros: se busca por nombre sin acentos, sólo dentro de la audiencia', async t => {
  const db = await world(t);
  const { call } = audiencesApi(db, ALL);
  const list = (
    await call('POST', '/api/audiences', {
      brandId: BRAND,
      kind: 'list',
      name: 'Búsqueda',
      contactIds: ['gv-tel', 'gv-wa'],
      clientRef: 'busca',
    })
  ).data.audience;
  const find = async q => (await call('GET', `/api/audiences/${list.id}/members`, null, { q })).data.members;
  assert.deepEqual(
    (await find('ZUNIGA')).map(m => m.contactId),
    ['gv-tel'],
  );
  assert.deepEqual(
    (await find('julián número')).map(m => m.contactId),
    ['gv-wa'],
  );
  assert.deepEqual(await find('Rosa'), [], 'Rosa existe en la marca pero no está en la lista');
  assert.equal((await find('')).length, 2);
  await rejects(call('GET', `/api/audiences/${list.id}/members`, null, { q: 'x'.repeat(101) }), 400);
});

test('exportar miembros: permisos, columnas según el acceso, fórmulas, marca, auditoría y frecuencia', async t => {
  const db = await world(t);
  const admin = audiencesApi(db, ALL);
  const list = (
    await admin.call('POST', '/api/audiences', {
      brandId: BRAND,
      kind: 'list',
      name: 'Exportar «prueba» / ñandú',
      contactIds: ['gv-tel', 'gv-wa', 'gv-formula'],
      clientRef: 'exporta',
    })
  ).data.audience;
  const path = `/api/audiences/${list.id}/export`;

  // Con todo el acceso: teléfono y correo completos; la celda que parece fórmula va neutralizada.
  const res = await admin.call('GET', path);
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /^text\/csv/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.match(
    res.headers['Content-Disposition'],
    /^attachment; filename="audiencia-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv"$/,
  );
  assert.equal(res.headers['X-Export-Rows'], '3');
  assert.equal(res.headers['X-Export-Truncated'], '0');
  assert.ok(res.text.startsWith(CSV_BOM));
  const rows = csvRows(res.text);
  assert.deepEqual(rows[0], ['nombre', 'telefono', 'correo', 'consentimiento', 'estado']);
  assert.ok(res.text.includes(`"'=HIPERVINCULO(""http://x"")"`), 'la fórmula sale con apóstrofo delante');
  assert.ok(!/\r\n=/.test(res.text) && !/,=/.test(res.text), 'ninguna celda empieza con =');
  assert.ok(res.text.includes('fer.secreta@correo.invalid'));
  assert.ok(res.text.includes("'+52 55 4321 9876"), 'el teléfono también va protegido (empieza con +)');
  assert.ok(!res.text.includes(BSUID), 'el identificador de usuario nunca se exporta');
  assert.deepEqual(admin.audits.at(-1), { user: 'u-admin', action: 'audience.exported', id: `${list.id}:3` });

  // Sin `contacts.phone`: sin columnas de teléfono ni correo, y nada de esos datos en el archivo.
  const limited = audiencesApi(db, ['contacts.view', 'campaigns.view', 'contacts.export']);
  const masked = await limited.call('GET', path);
  assert.deepEqual(csvRows(masked.text)[0], ['nombre', 'consentimiento', 'estado']);
  assert.ok(!masked.text.includes('9876') && !masked.text.includes('correo.invalid'));

  // Sin `contacts.export` (aunque vea la audiencia) o sin `campaigns.view`: 403. Otra marca: 404.
  await rejects(audiencesApi(db, ['contacts.view', 'campaigns.view', 'contacts.phone']).call('GET', path), 403);
  await rejects(audiencesApi(db, ['contacts.view', 'contacts.export']).call('GET', path), 403);
  db.prepare('UPDATE audiences SET brand_id=? WHERE id=?').run(OTHER, list.id);
  await rejects(admin.call('GET', path), 404);
  db.prepare('UPDATE audiences SET brand_id=? WHERE id=?').run(BRAND, list.id);

  // Estado inválido: 400. Límite de frecuencia por persona.
  await rejects(admin.call('GET', path, null, { status: 'todos' }), 400);
  const fresh = audiencesApi(db, ALL);
  for (let i = 0; i < LIMITS.exportsPerMinute; i++) assert.equal((await fresh.call('GET', path)).status, 200);
  await rejects(fresh.call('GET', path), 429);
  assert.equal(fresh.audits.length, LIMITS.exportsPerMinute, 'lo rechazado no queda como exportado');
});

test('exportar miembros: tope de filas con aviso y nombre de archivo seguro', async t => {
  const db = await world(t);
  const extra = LIMITS.exportRows + 5;
  const insert = db.prepare(
    "INSERT INTO contacts(id,brand_id,name,phone,phone_key,source,created_at,updated_at) VALUES(?,?,?,?,?,'import',1,1)",
  );
  db.exec('BEGIN');
  for (let i = 0; i < extra; i++) {
    const phone = '+52 1 55 ' + String(20000000 + i);
    insert.run(`gv-n${i}`, BRAND, `Persona Tope ${i}`, phone, phoneKey(phone));
  }
  db.exec('COMMIT');
  const { call, audits } = audiencesApi(db, ALL);
  const segment = (
    await call('POST', '/api/audiences', {
      brandId: BRAND,
      kind: 'segment',
      name: 'Toda la marca',
      definition: { version: 1, match: 'all', groups: [] },
      clientRef: 'tope',
    })
  ).data.audience;
  assert.ok(segment.memberCount > LIMITS.exportRows);
  const res = await call('GET', `/api/audiences/${segment.id}/export`);
  assert.equal(res.headers['X-Export-Rows'], String(LIMITS.exportRows));
  assert.equal(res.headers['X-Export-Truncated'], '1');
  assert.equal(csvRows(res.text).filter(row => row.length > 1).length, LIMITS.exportRows + 1, 'cabecera + tope');
  assert.equal(audits.at(-1).id, `${segment.id}:${LIMITS.exportRows}`);
  // El nombre del archivo nunca lleva comillas, barras ni datos de contacto.
  const at = Date.UTC(2026, 10, 15);
  assert.equal(exportFilename('Exportar «prueba» / ñandú', at), 'audiencia-exportar-prueba-nandu-2026-11-15.csv');
  assert.equal(exportFilename('"; rm -rf /', at), 'audiencia-rm-rf-2026-11-15.csv');
  assert.equal(exportFilename('', at), 'audiencia-audiencia-2026-11-15.csv');
});
