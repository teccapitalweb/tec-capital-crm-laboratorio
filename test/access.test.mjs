import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { createCRM } from '../server/crm.mjs';
import { createAccess } from '../server/lib/access.mjs';
import { PERMISSIONS, ROLE_PERMISSIONS, isPermission, isRole, roleHas } from '../server/lib/permissions.mjs';
import { errorBody } from '../server/app/http.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';

// Lo que hoy puede hacer un asesor, clave por clave. Si esta lista cambia, cambia lo que puede hacer el equipo.
const AGENT = [
  'contacts.consent',
  'contacts.create',
  'contacts.edit',
  'contacts.phone',
  'contacts.tags.apply',
  'contacts.view',
  'inbox.assistant',
  'inbox.block',
  'inbox.note',
  'inbox.priority',
  'inbox.reply',
  'inbox.resolve',
  'inbox.take',
  'inbox.view',
  'sales.charge',
  'sales.opportunities',
  'team.view',
];
// El catálogo completo. Una clave publicada no cambia de nombre: quitar o renombrar una debe hacer fallar esto.
const CATALOGUE = [
  ...AGENT,
  'analytics.export',
  'analytics.view',
  'audiences.edit',
  'audit.export',
  'audit.view',
  'automation.manage',
  'backups.view',
  'campaigns.edit',
  'campaigns.export',
  'campaigns.send',
  'campaigns.view',
  'channels.whatsapp.connect',
  'company.data.delete',
  'company.data.export',
  'company.profile.edit',
  'company.security.policies',
  'company.sso.configure',
  'company.support.authorize',
  'company.usage.view',
  'company.users.manage',
  'connections.manage',
  'contacts.archive',
  'contacts.attributes.manage',
  'contacts.bulk',
  'contacts.consent.reactivate',
  'contacts.erase',
  'contacts.export',
  'contacts.import',
  'contacts.merge',
  'contacts.tags.manage',
  'cx.review',
  'developer.keys.manage',
  'inbox.assign',
  'inbox.bulk',
  'inbox.export',
  'inbox.manage_others',
  'inbox.start',
  'inbox.unblock',
  'inbox.views.share',
  'privacy.person.erase',
  'privacy.person.export',
  'security.manage',
  'settings.costs',
  'settings.hours',
  'settings.inbox',
  'settings.library',
  'settings.quickreplies',
  'settings.routing',
  'team.availability',
  'team.manage',
  'team.roles',
  'team.sessions',
  'templates.manage',
].sort();

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-access-'));
  const db = openDatabase(dir);
  migrate(db, { backup: false });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const crm = createCRM({
    db,
    body: async () => ({}),
    json() {},
    audit() {},
    passwordHash: async () => '',
    checkPassword: async () => false,
    rate() {},
    disconnect() {},
    broadcast() {},
  });
  let number = 100100;
  const user = (id, role, { brands = [], disabled = 0 } = {}) => {
    db.prepare(
      'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen,disabled) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, id, 'Prueba ' + id, 'sal:hash', role, ++number, 1, 1, disabled);
    for (const brand of brands) db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(id, brand);
    return { id };
  };
  const people = {
    admin: user('u-admin', 'admin'),
    vet: user('u-vet', 'agent', { brands: ['globalvet'] }),
    both: user('u-both', 'agent', { brands: ['globalvet', 'odonteck'] }),
    dental: user('u-dental', 'agent', { brands: ['odonteck'] }),
    loose: user('u-loose', 'agent'), // asesor al que le quitaron todas las marcas
    suspended: user('u-suspended', 'agent', { brands: ['globalvet'], disabled: 1 }),
    customer: user('u-customer', 'customer'),
    ghost: { id: 'u-no-existe' },
  };
  return { db, crm, access: createAccess({ db, crm }), people };
}
const thrown = fn => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

test('catálogo de permisos: claves en inglés con etiqueta en español y los dos conjuntos fijos de hoy', () => {
  assert.deepEqual(Object.keys(PERMISSIONS).sort(), CATALOGUE);
  for (const [key, entry] of Object.entries(PERMISSIONS)) {
    assert.match(key, /^[a-z]+(\.[a-z_]+)+$/, key);
    assert.ok(typeof entry.label === 'string' && entry.label.length >= 8 && entry.label.length <= 80, key);
    assert.ok(/^[A-ZÁÉÍÓÚ]/.test(entry.label) && !/[.«»()]/.test(entry.label), 'etiqueta de ' + key);
    assert.ok(typeof entry.group === 'string' && entry.group.length >= 5, key);
    assert.ok(Object.isFrozen(entry));
  }
  assert.equal(new Set(Object.values(PERMISSIONS).map(entry => entry.label)).size, CATALOGUE.length);
  assert.ok(Object.isFrozen(PERMISSIONS) && Object.isFrozen(ROLE_PERMISSIONS));

  // Administración lo tiene todo; el asesor, exactamente lo de hoy; un cliente, nada.
  assert.deepEqual([...ROLE_PERMISSIONS.admin].sort(), CATALOGUE);
  assert.deepEqual([...ROLE_PERMISSIONS.agent].sort(), AGENT);
  assert.deepEqual(Object.keys(ROLE_PERMISSIONS), ['admin', 'agent']);
  assert.ok(Object.isFrozen(ROLE_PERMISSIONS.admin) && Object.isFrozen(ROLE_PERMISSIONS.agent));
  // Lo que hoy exige administración no está al alcance de un asesor.
  for (const key of [
    'inbox.assign',
    'inbox.manage_others',
    'contacts.export',
    'contacts.merge',
    'contacts.tags.manage',
    'contacts.consent.reactivate',
    'settings.hours',
    'settings.quickreplies',
    'campaigns.send',
    'automation.manage',
    'analytics.view',
    'team.manage',
    'developer.keys.manage',
  ]) {
    assert.equal(roleHas('agent', key), false, key);
    assert.equal(roleHas('admin', key), true, key);
  }
  for (const key of AGENT) assert.equal(roleHas('agent', key), true, key);
  for (const role of ['customer', 'owner', '', null, undefined, 'constructor'])
    assert.equal(roleHas(role, 'inbox.view'), false, String(role));
  assert.equal(roleHas('admin', 'no.existe'), false);
  assert.deepEqual(
    [isRole('admin'), isRole('agent'), isRole('customer'), isRole('toString')],
    [true, true, false, false],
  );
  assert.deepEqual(
    [isPermission('inbox.view'), isPermission('inbox'), isPermission('toString'), isPermission(null)],
    [true, false, false, false],
  );
});

test('access.can: los dos roles, y una marca autorizada no da acceso a otra', async t => {
  const { db, crm, access, people } = await setup(t);
  assertSchemaCurrent(db);
  const { admin, vet, both, dental, loose, suspended, customer, ghost } = people;

  // Administración: todo, en cualquier marca y en toda la empresa.
  for (const perm of CATALOGUE) {
    assert.equal(access.can(admin, perm, 'globalvet'), true, perm);
    assert.equal(access.can(admin, perm, { company: true }), true, perm);
    assert.equal(access.can(admin, perm), true, perm);
  }
  // Asesor: sus permisos, sólo en sus marcas.
  for (const perm of CATALOGUE) {
    const mine = AGENT.includes(perm);
    assert.equal(access.can(vet, perm, 'globalvet'), mine, perm);
    assert.equal(access.can(vet, perm, 'odonteck'), false, perm + ' en una marca que no es suya');
    assert.equal(access.can(vet, perm, 'dermalysse'), false, perm);
    assert.equal(access.can(vet, perm, { company: true }), false, perm + ' en toda la empresa');
    assert.equal(access.can(vet, perm), mine, perm + ' en alguna marca');
  }
  assert.equal(access.can(dental, 'inbox.reply', 'odonteck'), true);
  assert.equal(access.can(dental, 'inbox.reply', 'globalvet'), false);
  assert.deepEqual(
    ['globalvet', 'odonteck', 'dermalysse'].map(brand => access.can(both, 'contacts.edit', brand)),
    [true, true, false],
  );
  assert.equal(access.can(vet, 'inbox.view', { brandId: 'globalvet' }), true, 'la marca también como { brandId }');
  assert.equal(access.can(vet, 'inbox.view', { brandId: 'odonteck' }), false);

  // Quien no es del equipo, está suspendido, se quedó sin marcas o no existe: nada.
  for (const person of [customer, suspended, ghost, null, undefined, {}, { id: 7 }]) {
    assert.equal(access.can(person, 'inbox.view', 'globalvet'), false);
    assert.equal(access.can(person, 'inbox.view'), false);
    assert.equal(access.can(person, 'inbox.view', { company: true }), false);
  }
  assert.equal(access.can(loose, 'inbox.view'), false, 'sin marcas no hay «alguna marca»');
  assert.equal(access.can(loose, 'inbox.view', 'globalvet'), false);

  // Una marca que no existe o un alcance mal formado se niegan, también a administración.
  for (const scope of ['no-existe', '', null, 0, 7, false, true, {}, { company: 'sí' }, { brandId: '' }, ['globalvet']])
    for (const person of [admin, vet])
      assert.equal(access.can(person, 'inbox.view', scope), false, JSON.stringify(scope));

  // El rol que cuenta es el de la base ahora mismo, no el del objeto que trae la sesión.
  assert.equal(access.can({ id: customer.id, role: 'admin' }, 'inbox.view', 'globalvet'), false);
  assert.equal(access.can({ id: admin.id, role: 'customer', disabled: 1 }, 'team.roles', 'globalvet'), true);

  // Los cambios de acceso valen en el acto: quitar la marca, suspender, volver a dar.
  db.prepare('DELETE FROM brand_members WHERE user_id=? AND brand_id=?').run(both.id, 'globalvet');
  assert.equal(access.can(both, 'contacts.edit', 'globalvet'), false);
  assert.equal(access.can(both, 'contacts.edit', 'odonteck'), true);
  db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(dental.id);
  assert.equal(access.can(dental, 'inbox.reply', 'odonteck'), false);
  db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(dental.id);
  assert.equal(access.can(dental, 'inbox.reply', 'odonteck'), true);
  db.prepare("UPDATE users SET role='customer' WHERE id=?").run(admin.id);
  assert.equal(access.can(admin, 'inbox.view', 'globalvet'), false);
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);

  // Mismo veredicto que el CRM de hoy para cada persona y cada marca.
  const brands = db
    .prepare('SELECT id FROM brands')
    .all()
    .map(row => row.id);
  assert.equal(brands.length, 3);
  for (const person of [admin, vet, both, dental, loose, suspended, customer, ghost])
    for (const brand of brands)
      assert.equal(
        access.can(person, 'inbox.view', brand),
        Boolean(crm.canBrand(person, brand)),
        person.id + ' en ' + brand,
      );

  // Un permiso que no está en el catálogo es un error de quien programa, no un «no» silencioso.
  for (const perm of ['inbox.ver', 'inbox', '', 'toString', null, undefined])
    assert.throws(() => access.can(admin, perm, 'globalvet'), /Permiso desconocido/, String(perm));
  assert.throws(() => createAccess({ db }), /necesita/);
  assert.throws(() => createAccess({ crm }), /necesita/);
});

test('access.require: 403 con code si falta el permiso y 404 si la marca no es suya', async t => {
  const { access, people } = await setup(t);
  const { admin, vet, loose, suspended, customer } = people;

  assert.equal(access.require(vet, 'contacts.edit', 'globalvet'), undefined);
  assert.equal(access.require(admin, 'contacts.export', 'odonteck'), undefined);
  assert.equal(access.require(admin, 'company.profile.edit', { company: true }), undefined);
  assert.equal(access.require(vet, 'inbox.view'), undefined);

  // Le falta el permiso: 403, con el code y la clave que falta.
  const denied = thrown(() => access.require(vet, 'contacts.export', 'globalvet'));
  assert.deepEqual(
    [denied.status, errorBody(denied)],
    [
      403,
      {
        error: 'Tu acceso no incluye «Exportar contactos».',
        code: 'permission_denied',
        details: { permission: 'contacts.export' },
      },
    ],
  );
  // Aunque la marca no sea suya: lo que le falta es el permiso, y eso no revela nada de la marca.
  assert.equal(thrown(() => access.require(vet, 'contacts.export', 'odonteck')).status, 403);
  // Tiene el permiso, pero no en toda la empresa ni en ninguna marca.
  for (const [person, scope] of [
    [vet, { company: true }],
    [loose, undefined],
  ]) {
    const error = thrown(() => access.require(person, 'contacts.view', scope));
    assert.deepEqual([error.status, error.code], [403, 'permission_denied']);
  }

  // Tiene el permiso, pero la marca no es suya, no existe o no viene: el 404 de siempre, sin distinguir.
  for (const [person, scope] of [
    [vet, 'odonteck'],
    [vet, 'no-existe'],
    [vet, null],
    [vet, ''],
    [loose, 'globalvet'],
    [admin, 'no-existe'],
    [admin, null],
  ]) {
    const error = thrown(() => access.require(person, 'contacts.view', scope));
    assert.deepEqual(
      [error.status, errorBody(error)],
      [404, { error: 'Marca o registro no disponible.', code: 'not_found' }],
      person.id + ' ' + JSON.stringify(scope),
    );
  }

  // Quien no es del equipo recibe el texto de siempre, sin detalles.
  for (const person of [customer, suspended, null]) {
    const error = thrown(() => access.require(person, 'inbox.view', 'globalvet'));
    assert.deepEqual(
      [error.status, errorBody(error)],
      [403, { error: 'Esta acción es para el equipo de atención.', code: 'permission_denied' }],
    );
  }
  assert.throws(() => access.require(admin, 'inbox.ver', 'globalvet'), /Permiso desconocido/);
});

test('access.brandIds y access.scopeSql: toda consulta se acota a las marcas de la persona', async t => {
  const { db, crm, access, people } = await setup(t);
  const { admin, vet, both, loose, suspended, customer, ghost } = people;
  const all = ['dermalysse', 'globalvet', 'odonteck'];

  assert.deepEqual(access.brandIds(admin), all);
  assert.deepEqual(access.brandIds(vet), ['globalvet']);
  assert.deepEqual(access.brandIds(both), ['globalvet', 'odonteck']);
  for (const person of [loose, suspended, customer, ghost, null]) assert.deepEqual(access.brandIds(person), []);
  // Con permiso: sólo si su conjunto lo incluye.
  assert.deepEqual(access.brandIds(both, 'contacts.view'), ['globalvet', 'odonteck']);
  assert.deepEqual(access.brandIds(both, 'contacts.export'), []);
  assert.deepEqual(access.brandIds(admin, 'contacts.export'), all);
  assert.throws(() => access.brandIds(admin, 'no.existe'), /Permiso desconocido/);
  // Es la misma lista que autoriza el CRM de hoy, y la misma que usa can().
  for (const person of [admin, vet, both, loose, suspended, customer, ghost])
    for (const brand of all) {
      const allowed = Boolean(crm.canBrand(person, brand));
      assert.equal(access.brandIds(person).includes(brand), allowed, person.id + ' ' + brand);
      assert.equal(access.brandIds(person, 'inbox.view').includes(brand), access.can(person, 'inbox.view', brand));
    }
  // Una marca nueva la ve administración y nadie más hasta que se la asignen.
  db.prepare('INSERT INTO brands(id,name,description,created_at) VALUES(?,?,?,?)').run('zeta', 'Zeta', 'Prueba', 9e12);
  assert.deepEqual(access.brandIds(admin), [...all, 'zeta']);
  assert.deepEqual(access.brandIds(both), ['globalvet', 'odonteck']);
  assert.equal(access.can(admin, 'inbox.view', 'zeta'), true);
  assert.equal(access.can(both, 'inbox.view', 'zeta'), false);

  // scopeSql devuelve un predicado con sus argumentos; el alias es el de la tabla que lleva brand_id.
  assert.deepEqual(access.scopeSql(vet, 'c'), { sql: 'c.brand_id IN (?)', args: ['globalvet'] });
  assert.deepEqual(access.scopeSql(both, 'conv'), { sql: 'conv.brand_id IN (?,?)', args: ['globalvet', 'odonteck'] });
  assert.deepEqual(access.scopeSql(both), { sql: 'brand_id IN (?,?)', args: ['globalvet', 'odonteck'] });
  assert.deepEqual(access.scopeSql(admin, 'k').args, [...all, 'zeta']);
  for (const person of [loose, suspended, customer, ghost, null])
    assert.deepEqual(access.scopeSql(person, 'c'), { sql: '0=1', args: [] });
  for (const alias of ['c; DROP TABLE users', 'c.x', 'c d', '1c', 'c-', 7, null, {}])
    assert.throws(() => access.scopeSql(admin, alias), /alias/, String(alias));

  // En una consulta real (los seis cursos de demostración, dos por marca): cada quien ve sólo lo suyo.
  const courses = person => {
    const scope = access.scopeSql(person, 'k');
    return db
      .prepare(`SELECT k.id,k.brand_id FROM courses k WHERE ${scope.sql} AND k.active=1 ORDER BY k.id`)
      .all(...scope.args);
  };
  const total = db.prepare('SELECT count(*) n FROM courses').get().n;
  assert.equal(total, 6);
  assert.equal(courses(admin).length, total);
  assert.deepEqual([...new Set(courses(vet).map(row => row.brand_id))], ['globalvet']);
  assert.equal(courses(vet).length, 2);
  assert.deepEqual([...new Set(courses(both).map(row => row.brand_id))].sort(), ['globalvet', 'odonteck']);
  for (const person of [loose, suspended, customer, ghost]) assert.deepEqual(courses(person), []);
  const own = access.scopeSql(vet);
  assert.equal(db.prepare(`SELECT count(*) n FROM courses WHERE ${own.sql}`).get(...own.args).n, 2);
});

test('access.phone: completo para quien puede verlo y enmascarado en el servidor para los demás', async t => {
  const { access, people } = await setup(t);
  const { admin, vet, loose, suspended, customer } = people;
  const full = '+52 55 1234 5678';

  assert.equal(access.phone(admin, full), full);
  assert.equal(access.phone(vet, full), full);
  assert.equal(access.phone(vet, full, 'globalvet'), full);
  assert.equal(access.phone(vet, '5215512345678'), '5215512345678', 'a quien puede verlo se le entrega tal cual');
  // Sin el permiso, o con él pero en una marca ajena: tres primeros y cuatro últimos dígitos.
  for (const [person, scope] of [
    [customer, undefined],
    [suspended, undefined],
    [loose, undefined],
    [null, undefined],
    [vet, 'odonteck'],
    [vet, null],
    [vet, { company: true }],
  ]) {
    const masked = access.phone(person, full, scope);
    assert.equal(masked, '+525 ••••• 5678', JSON.stringify(scope));
    assert.ok(!masked.includes('1234'));
  }
  assert.equal(access.phone(customer, 5512345678), '+55 ••••• 5678');
  assert.equal(access.phone(customer, 'sin teléfono'), '', 'lo que no es un número no se devuelve');
  // Nada que ocultar: vacío se queda como venía. El número de prueba del laboratorio no es de nadie.
  for (const empty of ['', null, undefined]) {
    assert.equal(access.phone(customer, empty), empty);
    assert.equal(access.phone(admin, empty), empty);
  }
  assert.equal(access.phone(customer, '#100123'), '#100123');
  assert.equal(access.phone(customer, '#100123 y 5512345678'), '+100 ••••• 5678', 'sólo el número de prueba solo');
});
