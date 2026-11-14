import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { fail } from '../server/app/http.mjs';
import { createPersonData } from '../server/lib/person-data.mjs';
import { createContacts } from '../server/contacts.mjs';
import attributesModule from '../server/modules/attributes/module.mjs';
import importModule from '../server/modules/contact-import/module.mjs';

// La importación respeta los permisos de quien la lanza (docs/PLAN_IMPORTAR_CONTACTOS.md). Hoy administración tiene
// todos; esta prueba simula a alguien con `contacts.import` y sin otros permisos, como lo permitirán los roles finos:
// el mapeo a un destino sin permiso se rechaza ANTES de lanzar (400 con la columna y el motivo) y la función por fila
// tampoco escribe lo que no le toca, ni siquiera llamada directamente.

const inert = new Proxy(function () {}, {
  get: (_, key) => (key === 'then' ? undefined : inert),
  apply: () => inert,
});

async function setup(t, granted) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-import-access-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  migrate(db, { dataDir: dir, backup: false });
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u1','importa','Importa','x','admin',990001,1,1)",
  ).run();
  for (const [key, personal] of [
    ['ciudad', 0],
    ['curp', 1],
  ])
    db.prepare(
      "INSERT INTO contact_attributes(id,brand_id,key,label,type,personal,created_at,updated_at) VALUES(?,'globalvet',?,?,'text',?,1,1)",
    ).run('a-' + key, key, key.toUpperCase(), personal);
  const personData = createPersonData({ db });
  const contacts = createContacts({
    db,
    crm: inert,
    body: inert,
    json: inert,
    audit: inert,
    broadcast: () => {},
    personData,
  });
  const modules = new Map();
  const access = {
    can: (user, permission) => granted.has(permission),
    require(user, permission) {
      if (!granted.has(permission)) throw fail(403, 'Sin permiso.', { code: 'permission_denied' });
    },
    brandIds: () => ['globalvet'],
  };
  const host = {
    db,
    transaction,
    fail,
    access,
    personData,
    dataDir: dir,
    realtime: { emit() {} },
    services: { contacts, events: { registerTypes() {}, publish() {} }, crm: { brandsFor: () => [] } },
    module: name => modules.get(name),
    json: (res, status, data) => Object.assign(res, { status, body: data }),
    body: async req => req.payload,
    audit() {},
    requireStaff() {},
  };
  modules.set('attributes', attributesModule.create(host));
  const api = importModule.create(host);
  const user = { id: 'u1', role: 'admin' };
  const call = async (method, path, payload, query = '') => {
    const res = {};
    const req = {
      method,
      payload,
      async *[Symbol.asyncIterator]() {
        if (typeof payload === 'string') yield Buffer.from(payload);
      },
    };
    try {
      await api.handle(req, res, path, user, new URL('http://localhost' + path + query));
    } catch (error) {
      return { status: error.status, body: { code: error.code, field: error.field, details: error.details } };
    }
    return res;
  };
  return { db, api, call };
}

const CSV = 'Name,Phone,Tags,Allow Campaign,Ciudad,Curp\nAna Prueba,5540000001,Webinar,TRUE,Puebla,XXXX000000\n';

async function mapped(call, targets, options = {}) {
  const uploaded = (await call('POST', '/api/contact-import/uploads', CSV, '?brand=globalvet&name=a.csv')).body.import;
  const body = (
    await call('PUT', `/api/contact-import/${uploaded.id}/mapping`, {
      expectedRevision: uploaded.revision,
      targets,
      options,
    })
  ).body.import;
  return body;
}

const ALL = ['name', 'phone', 'tags', 'consent', 'attr:ciudad', 'attr:curp'];

test('sin permiso para un destino, la vista previa se rechaza antes de lanzar con la columna y el motivo', async t => {
  const { call } = await setup(t, new Set(['contacts.import', 'contacts.edit']));
  const preview = async (targets, options) => {
    const record = await mapped(call, targets, options);
    return call('POST', `/api/contact-import/${record.id}/validate`, { expectedRevision: record.revision });
  };
  let response = await preview(ALL);
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'permission_denied');
  assert.equal(response.body.field, 'targets.2');
  assert.deepEqual(response.body.details, { column: 'Tags', target: 'tags', permission: 'contacts.tags.apply' });
  response = await preview(['name', 'phone', 'ignore', 'consent', 'attr:ciudad', 'ignore']);
  assert.equal(response.body.details.permission, 'contacts.consent');
  // Un dato personal pide además ver teléfono y correo completos.
  response = await preview(['name', 'phone', 'ignore', 'ignore', 'attr:ciudad', 'attr:curp']);
  assert.equal(response.body.field, 'targets.5');
  assert.equal(response.body.details.permission, 'contacts.phone');
  // Lo que sí puede hacer se lanza.
  response = await preview(['name', 'phone', 'ignore', 'ignore', 'attr:ciudad', 'ignore']);
  assert.equal(response.status, 202);
  assert.deepEqual(response.body.import.job.state, 'queued');
});

test('sin editar contactos: hay que dejar como están los existentes y no se escriben datos de contacto', async t => {
  const { call } = await setup(t, new Set(['contacts.import']));
  const record = await mapped(call, ['name', 'phone', 'ignore', 'ignore', 'attr:ciudad', 'ignore'], {
    onExisting: 'skip',
  });
  let response = await call('POST', `/api/contact-import/${record.id}/validate`, { expectedRevision: record.revision });
  assert.equal(response.body.details.permission, 'contacts.edit');
  assert.equal(response.body.field, 'targets.4');
  const other = await mapped(call, ['name', 'phone', 'ignore', 'ignore', 'ignore', 'ignore']);
  response = await call('POST', `/api/contact-import/${other.id}/validate`, { expectedRevision: other.revision });
  assert.equal(response.body.field, 'options.onExisting');
});

test('la función por fila tampoco escribe lo que no permite su `allow`', async t => {
  const { db, api } = await setup(t, new Set(['contacts.import']));
  const row = (extra = {}) => ({
    name: 'Bea Prueba',
    phone: '5540000002',
    tags: [],
    consent: null,
    attrs: {},
    ...extra,
  });
  const apply = (r, allow) => transaction(db, () => api.applyRow('globalvet', r, { allow }));
  assert.equal(apply(row({ tags: ['Webinar'] }), { tags: false }).reason, 'permission_denied');
  assert.equal(apply(row({ consent: false }), { consent: false }).reason, 'permission_denied');
  assert.equal(apply(row({ attrs: { ciudad: 'Puebla' } }), { edit: false }).reason, 'permission_denied');
  const personal = apply(row({ attrs: { curp: 'XXXX000000' } }), { phone: false });
  assert.equal(personal.action, 'error');
  assert.equal(personal.reason, 'permission_denied');
  assert.equal(personal.field, 'attr:curp');
  assert.equal(db.prepare('SELECT count(*) n FROM contacts').get().n, 0, 'una fila rechazada no deja nada');
  assert.equal(db.prepare('SELECT count(*) n FROM contact_tags').get().n, 0);
  // Un contacto que ya existe no se toca sin permiso de edición.
  assert.equal(apply(row(), {}).action, 'created');
  const again = apply(row({ name: 'Otro nombre' }), { edit: false });
  assert.equal(again.reason, 'permission_denied');
  assert.equal(db.prepare('SELECT name FROM contacts').get().name, 'Bea Prueba');
  // Con permiso, igual que siempre.
  assert.equal(apply(row({ attrs: { curp: 'XXXX000000' }, tags: ['Webinar'] }), {}).action, 'updated');
});
