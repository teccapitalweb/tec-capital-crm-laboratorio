import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { fail } from '../server/app/http.mjs';
import { phoneKey } from '../server/lib/identity-keys.mjs';
import directory from '../server/modules/directory/module.mjs';

// Quien no puede ver el teléfono y el correo completos (sin `contacts.phone`) tampoco puede adivinarlos: si buscara
// o filtrara por ellos, ver qué contactos aparecen le diría el dato oculto. Hoy los dos roles fijos tienen ese
// permiso; esta prueba simula a una persona sin él, como la tendrán los roles finos.
async function setup(t, { full }) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-directory-privacy-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  migrate(db, { dataDir: dir, backup: false });
  const insert = db.prepare(
    "INSERT INTO contacts(id,brand_id,name,phone,phone_key,email,source,created_at,updated_at) VALUES(?,?,?,?,?,?,'manual',1,1)",
  );
  insert.run(
    'gv-1',
    'globalvet',
    'Fernanda Zúñiga',
    '+52 55 4321 9876',
    phoneKey('+52 55 4321 9876'),
    'fer.secreta@correo.mx',
  );
  insert.run('gv-2', 'globalvet', 'Luis Pérez', '', '', 'luis@otro.mx');
  const access = {
    require() {},
    brandIds: () => ['globalvet'],
    can: (user, permission) => permission !== 'contacts.phone' || full,
    phone: (user, value) => (full ? value : value ? '•••• ' + String(value).slice(-4) : ''),
  };
  const api = directory.create({
    db,
    access,
    fail,
    json: (res, status, data) => (res.body = data),
    realtime: { emit() {} },
  });
  const get = async query => {
    const res = {};
    const url = new URL('http://localhost/api/contacts?' + new URLSearchParams({ brand: 'globalvet', ...query }));
    await api.handle({ method: 'GET' }, res, '/api/contacts', { id: 'u1', role: 'agent' }, url);
    return res.body.contacts.map(c => c.id);
  };
  return { get };
}

test('sin permiso para ver datos completos, la búsqueda y los filtros no delatan el correo ni el teléfono', async t => {
  const hidden = await setup(t, { full: false });
  // por nombre se sigue encontrando
  assert.deepEqual(await hidden.get({ q: 'zuniga' }), ['gv-1']);
  // por el correo, que se le muestra enmascarado, no: buscarlo no confirma nada
  assert.deepEqual(await hidden.get({ q: 'fer.secreta' }), []);
  assert.deepEqual(await hidden.get({ q: 'secreta' }), []);
  // por teléfono, sólo los cuatro últimos dígitos, que ya ve
  assert.deepEqual(await hidden.get({ q: '9876' }), ['gv-1']);
  assert.deepEqual(await hidden.get({ q: '5543219876' }), ['gv-1'], 'cuenta sólo lo que ya se ve: los 4 últimos');
  assert.deepEqual(await hidden.get({ q: '5543210000' }), [], 'un número distinto con otra terminación no aparece');
  // filtrar por lo que contiene el correo se rechaza; «tiene correo» o «no tiene» sí se permite
  const byEmail = op => ({
    filter: JSON.stringify({
      version: 1,
      match: 'all',
      groups: [{ match: 'all', rules: [{ field: 'email', op, value: op.endsWith('empty') ? undefined : 'secreta' }] }],
    }),
  });
  await assert.rejects(
    () => hidden.get(byEmail('contains')),
    error => error.status === 403,
  );
  await assert.rejects(
    () => hidden.get(byEmail('not_contains')),
    error => error.status === 403,
  );
  assert.deepEqual((await hidden.get(byEmail('not_empty'))).sort(), ['gv-1', 'gv-2']);

  // con el permiso, todo funciona como siempre
  const visible = await setup(t, { full: true });
  assert.deepEqual(await visible.get({ q: 'fer.secreta' }), ['gv-1']);
  assert.deepEqual(await visible.get(byEmail('contains')), ['gv-1']);
  assert.deepEqual(await visible.get({ q: '5543219876' }), ['gv-1']);
});
