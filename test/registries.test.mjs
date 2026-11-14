import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { createCRM } from '../server/crm.mjs';
import { createEvents, EVENT_TYPES, ENTITY_KINDS } from '../server/events.mjs';
import { createIntegrations, EVENT_NEEDS, SUBSCRIBER } from '../server/integrations.mjs';
import { createReadiness, BUILT_IN_STEPS } from '../server/readiness.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';

const quiet = { error() {} };
const BUILT_IN_TYPES = Object.keys(EVENT_TYPES);
const BROADCAST = { title: 'Difusión enviada', entity: 'campaign', payload: 'name, recipients' };

// Base real con el esquema completo y los servicios de verdad, como los crea server/index.mjs.
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-registries-'));
  const db = openDatabase(dir);
  migrate(db, { backup: false });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const sent = [];
  let input = {};
  const json = (res, status, data) => sent.push({ status, data: JSON.parse(JSON.stringify(data)) });
  const body = async () => input;
  const crm = createCRM({
    db,
    body,
    json,
    audit() {},
    passwordHash: async () => '',
    checkPassword: async () => false,
    rate() {},
    disconnect() {},
    broadcast() {},
  });
  db.prepare(
    'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
  ).run('u-admin', 'admin', 'Administración', 'sal:hash', 'admin', 100301, 1, 1);
  const admin = db.prepare('SELECT * FROM users WHERE id=?').get('u-admin');
  const events = createEvents({ db, crm, body, json, log: quiet });
  // Una petición con sesión o con llave, sin red: se llama al manejador y se recoge lo que respondería.
  const request = async (handler, method, path, { data = {}, headers = {} } = {}) => {
    input = data;
    const url = new URL('http://localhost' + path);
    sent.length = 0;
    try {
      assert.equal(await handler({ method, url: path, headers }, {}, url.pathname, url), true, path);
      return sent.pop();
    } catch (error) {
      if (!error.status) throw error;
      return { status: error.status, data: { error: error.message } };
    }
  };
  return { db, crm, events, admin, json, body, request };
}
const status = fn => {
  try {
    fn();
  } catch (error) {
    return [error.status, error.message];
  }
  return [null, ''];
};

test('events.registerTypes: un módulo da de alta sus tipos y entidades; lo repetido o mal formado se rechaza', async t => {
  const { db, events, admin, request } = await setup(t);
  assertSchemaCurrent(db);
  assert.deepEqual(
    events.types().map(type => type.type),
    BUILT_IN_TYPES,
  );
  assert.deepEqual([events.hasType('pago.confirmado'), events.hasType('difusion.enviada')], [true, false]);
  for (const odd of ['constructor', 'toString', '__proto__', '', null, undefined, 7, ['pago.confirmado']])
    assert.equal(events.hasType(odd), false, String(odd));
  const publishOne = (type, entityId, extra = {}) =>
    events.publish({ type, brandId: 'globalvet', entityId, payload: { name: 'Noviembre' }, source: 'test', ...extra });
  assert.throws(() => publishOne('difusion.enviada', 'b-0'), /no registrado/);

  // Como hoy: el núcleo compartido y los webhooks se suscriben a todos los tipos; finanzas, sólo a los suyos.
  const got = { core: [], finance: [], audit: [], stats: [] };
  const deliver = event => got.core.push(event.type);
  for (const type of BUILT_IN_TYPES) events.subscribe(type, 'core.outbox', deliver);
  events.subscribe('pago.confirmado', 'finance', event => got.finance.push(event.type));
  // Está en todos los tipos, pero con una función distinta en cada uno: no es «un suscriptor de todo».
  for (const type of BUILT_IN_TYPES) events.subscribe(type, 'audit.by-type', event => got.audit.push(event.type));

  assert.deepEqual(
    events.registerTypes(
      { 'difusion.enviada': BROADCAST, 'contacto.creado': { title: '  Contacto creado ', entity: 'contact' } },
      { entities: { campaign: 'Difusión' } },
    ),
    ['difusion.enviada', 'contacto.creado'],
  );
  assert.deepEqual([events.hasType('difusion.enviada'), events.hasType('contacto.creado')], [true, true]);
  const listed = events.types();
  assert.deepEqual(
    listed.map(type => type.type),
    [...BUILT_IN_TYPES, 'difusion.enviada', 'contacto.creado'],
    'los de siempre no cambian de lugar y los nuevos van al final',
  );
  assert.deepEqual(listed.at(-2), { type: 'difusion.enviada', ...BROADCAST, subscribers: ['core.outbox'] });
  assert.deepEqual(listed.at(-1), {
    type: 'contacto.creado',
    title: 'Contacto creado',
    entity: 'contact',
    payload: '',
    subscribers: ['core.outbox'],
  });
  assert.deepEqual(listed.find(type => type.type === 'pago.confirmado').subscribers, [
    'core.outbox',
    'finance',
    'audit.by-type',
  ]);

  // Un tipo registrado se publica, se entrega y se consulta como cualquier otro.
  const first = publishOne('difusion.enviada', 'b-1');
  assert.equal(first.duplicate, false);
  assert.equal(publishOne('difusion.enviada', 'b-1').duplicate, true);
  assert.equal(events.get(first.seq).entity_kind, 'campaign', 'la entidad sale de su definición');
  assert.deepEqual(
    events.deliveriesOf(first.seq).map(delivery => delivery.subscriber),
    ['core.outbox'],
  );
  assert.equal(await events.tick(), 1);
  assert.deepEqual(got, { core: ['difusion.enviada'], finance: [], audit: [], stats: [] });
  // Suscribirse a él, y reproducir el historial para quien recibe todo.
  events.subscribe('difusion.enviada', 'stats', event => got.stats.push(event.entity_id));
  publishOne('difusion.enviada', 'b-2');
  assert.equal(await events.tick(), 2);
  assert.deepEqual(got, { core: ['difusion.enviada', 'difusion.enviada'], finance: [], audit: [], stats: ['b-2'] });
  db.prepare('DELETE FROM domain_deliveries').run();
  assert.equal(events.replay('core.outbox'), 2, 'la reproducción incluye los tipos registrados');
  assert.equal(events.replay('stats'), 2);
  // Los filtros de la bitácora conocen el tipo y la entidad registrados (uno que no existe se ignora, como siempre).
  events.publish({ type: 'pedido.creado', brandId: 'globalvet', entityId: 'o-1', source: 'test' });
  assert.equal(events.list(['globalvet']).length, 3);
  assert.equal(events.list(['globalvet'], { type: 'difusion.enviada' }).length, 2);
  assert.equal(events.list(['globalvet'], { entityKind: 'campaign' }).length, 2);
  assert.equal(events.list(['globalvet'], { entityKind: 'order' }).length, 1);
  assert.equal(events.list(['globalvet'], { type: 'no.existe', entityKind: 'no_existe' }).length, 3);
  assert.equal(events.list(['odonteck'], { type: 'difusion.enviada' }).length, 0);
  const catalogue = await request((req, res, path) => events.handle(req, res, path, admin), 'GET', '/api/events/types');
  assert.equal(catalogue.status, 200);
  assert.equal(catalogue.data.entities.campaign, 'Difusión');
  assert.equal(catalogue.data.entities.order, 'Pedido');
  assert.deepEqual(catalogue.data.types.at(-2), {
    type: 'difusion.enviada',
    ...BROADCAST,
    subscribers: ['core.outbox', 'stats'],
  });

  // Un suscriptor de todo que llega después de un registro también recibe lo que se registre más tarde.
  const late = event => got.audit.push('late:' + event.type);
  for (const { type } of events.types()) events.subscribe(type, 'late.all', late);
  assert.deepEqual(events.registerTypes({ 'difusion.pausada': { title: 'Difusión pausada', entity: 'campaign' } }), [
    'difusion.pausada',
  ]);
  assert.deepEqual(events.types().at(-1).subscribers, ['core.outbox', 'late.all']);

  // Repetidos: el mismo tipo dos veces, uno de los de siempre, una entidad con otro nombre.
  assert.deepEqual(
    status(() => events.registerTypes({ 'difusion.enviada': BROADCAST })),
    [409, 'Tipo de evento repetido: difusion.enviada'],
  );
  assert.deepEqual(
    status(() => events.registerTypes({ 'pago.confirmado': { title: 'Otro', entity: 'order' } })),
    [409, 'Tipo de evento repetido: pago.confirmado'],
  );
  assert.deepEqual(
    status(() => events.registerTypes({}, { entities: { campaign: 'Campaña' } })),
    [409, 'Entidad de evento repetida con otro nombre: campaign'],
  );
  assert.equal(status(() => events.registerTypes({}, { entities: { order: 'Compra' } }))[0], 409);
  // Declarar otra vez una entidad con el mismo nombre no estorba: dos módulos pueden necesitar la misma.
  assert.deepEqual(events.registerTypes({}, { entities: { campaign: 'Difusión', order: 'Pedido' } }), []);

  // Todo o nada: si un tipo de la lista no vale, no se registra ninguno, ni su entidad.
  const before = events.types().length;
  assert.equal(
    status(() =>
      events.registerTypes(
        { 'plantilla.aprobada': { title: 'Plantilla aprobada', entity: 'template' }, 'pago.confirmado': BROADCAST },
        { entities: { template: 'Plantilla' } },
      ),
    )[0],
    409,
  );
  assert.deepEqual([events.hasType('plantilla.aprobada'), events.types().length], [false, before]);
  assert.match(
    status(() =>
      events.registerTypes({ 'plantilla.aprobada': { title: 'Plantilla aprobada', entity: 'template' } }),
    )[1],
    /entidad sin registrar: template/,
  );

  // Mal formados.
  for (const type of ['Contacto.creado', 'contacto', 'contacto creado', 'contacto.', '.creado', 'a..b', '*', 'a-b.c'])
    assert.match(status(() => events.registerTypes({ [type]: BROADCAST }))[1], /Tipo de evento no válido/, type);
  assert.equal(status(() => events.registerTypes({ ['a'.repeat(58) + '.xy']: BROADCAST }))[0], 400);
  for (const definition of [
    null,
    'texto',
    {},
    { entity: 'order' },
    { title: '   ', entity: 'order' },
    { title: 7, entity: 'order' },
    { title: 'x'.repeat(81), entity: 'order' },
    { title: 'Algo' },
    { title: 'Algo', entity: 'no_existe' },
    { title: 'Algo', entity: 'constructor' },
    { title: 'Algo', entity: 7 },
    { title: 'Algo', entity: 'order', payload: 7 },
    { title: 'Algo', entity: 'order', payload: 'x'.repeat(301) },
  ])
    assert.equal(status(() => events.registerTypes({ 'algo.nuevo': definition }))[0], 400, JSON.stringify(definition));
  for (const entities of [
    { Campaign: 'x' },
    { 'mi-entidad': 'x' },
    { lista: '' },
    { lista: 7 },
    { lista: 'x'.repeat(61) },
  ])
    assert.equal(status(() => events.registerTypes({}, { entities }))[0], 400, JSON.stringify(entities));
  for (const bad of [null, undefined, 'difusion.enviada', ['a.b'], 7])
    assert.equal(status(() => events.registerTypes(bad))[0], 400, String(bad));
  assert.equal(status(() => events.registerTypes({}, { entities: ['campaign'] }))[0], 400);
  assert.equal(events.hasType('algo.nuevo'), false);

  // Cada instancia tiene su catálogo: otra no conoce lo registrado aquí, y las listas del archivo no cambian.
  const other = createEvents({ db, log: quiet });
  assert.equal(other.hasType('difusion.enviada'), false);
  assert.deepEqual(other.registerTypes({ 'difusion.enviada': BROADCAST }, { entities: { campaign: 'Difusión' } }), [
    'difusion.enviada',
  ]);
  assert.deepEqual(other.types().at(-1).subscribers, [], 'sin suscriptores de todo no se suscribe a nadie');
  assert.deepEqual(Object.keys(EVENT_TYPES), BUILT_IN_TYPES);
  assert.equal(EVENT_TYPES['difusion.enviada'], undefined);
  assert.equal(ENTITY_KINDS.campaign, undefined);
});

test('integrations.registerNeeds: el permiso que deja leer un tipo registrado; sin él, se entrega sin datos', async t => {
  const { db, crm, events, admin, json, body, request } = await setup(t);
  const integrations = createIntegrations({
    db,
    crm,
    events,
    body,
    json,
    audit() {},
    rate() {},
    env: { WEBHOOK_ALLOW_PRIVATE: '1' },
    log: quiet,
  });
  const session = (req, res, path) => integrations.handle(req, res, path, admin);
  const open = (req, res, path, url) => integrations.handlePublic(req, res, path, url, '127.0.0.1');
  const key = scopes => integrations.createKey(admin, { brandId: 'globalvet', name: 'Prueba', scopes }).token;
  const read = (token, path) => request(open, 'GET', path, { headers: { authorization: 'Bearer ' + token } });

  // Lo de siempre ya está clasificado y no se puede volver a clasificar; un tipo que no existe, tampoco.
  assert.deepEqual(
    status(() => integrations.registerNeeds({ 'pago.confirmado': 'contacts' })),
    [409, 'El tipo de evento pago.confirmado ya tiene su permiso de lectura.'],
  );
  assert.deepEqual(
    status(() => integrations.registerNeeds({ 'difusion.enviada': 'contacts' })),
    [400, 'Tipo de evento no registrado: difusion.enviada'],
  );

  events.registerTypes(
    { 'difusion.enviada': BROADCAST, 'difusion.pausada': { title: 'Difusión pausada', entity: 'campaign' } },
    { entities: { campaign: 'Difusión' } },
  );
  // Permisos que no valen: `events` (ya hace falta siempre), uno que no existe, otro tipo de dato. Todo o nada.
  for (const scope of ['events', 'no_existe', 'toString', '', 7, null, ['contacts']])
    assert.equal(status(() => integrations.registerNeeds({ 'difusion.enviada': scope }))[0], 400, String(scope));
  assert.equal(
    status(() => integrations.registerNeeds({ 'difusion.enviada': 'contacts', 'difusion.pausada': 'no_existe' }))[0],
    400,
  );
  for (const bad of [null, undefined, 'difusion.enviada', ['difusion.enviada'], 7])
    assert.equal(status(() => integrations.registerNeeds(bad))[0], 400, String(bad));

  const reader = key(['events']);
  events.publish({
    type: 'difusion.enviada',
    brandId: 'globalvet',
    entityId: 'b-1',
    payload: { name: 'Noviembre', recipients: 40 },
    source: 'test',
  });
  events.publish({
    type: 'difusion.pausada',
    brandId: 'globalvet',
    entityId: 'b-1',
    payload: { by: 'x' },
    source: 't',
  });
  const redacted = (await read(reader, '/api/v1/events')).data.events;
  assert.deepEqual(
    redacted.map(event => [event.type, event.data, event.redacted, event.requires]),
    [
      ['difusion.enviada', {}, true, null],
      ['difusion.pausada', {}, true, null],
    ],
    'un tipo registrado y sin clasificar no enseña su contenido',
  );

  assert.deepEqual(integrations.registerNeeds({ 'difusion.enviada': 'contacts' }), ['difusion.enviada']);
  assert.deepEqual(
    status(() => integrations.registerNeeds({ 'difusion.enviada': 'orders' })),
    [409, 'El tipo de evento difusion.enviada ya tiene su permiso de lectura.'],
  );
  const me = (await read(reader, '/api/v1/me')).data;
  assert.deepEqual(me.eventTypes, [...BUILT_IN_TYPES, 'difusion.enviada', 'difusion.pausada']);
  assert.deepEqual(me.eventScopes, { ...EVENT_NEEDS, 'difusion.enviada': 'contacts' });
  assert.deepEqual(
    (await read(reader, '/api/v1/events')).data.events.map(event => [event.type, event.redacted, event.requires]),
    [
      ['difusion.enviada', true, 'contacts'],
      ['difusion.pausada', true, null],
    ],
  );
  const full = (await read(key(['events', 'contacts']), '/api/v1/events')).data.events;
  assert.deepEqual(
    full.map(event => [event.type, event.data, event.redacted]),
    [
      ['difusion.enviada', { name: 'Noviembre', recipients: 40 }, undefined],
      ['difusion.pausada', {}, true],
    ],
  );
  assert.equal(full[0].entity.kind, 'campaign');
  assert.equal((await read(reader, '/api/v1/events?type=difusion.pausada')).data.events.length, 1);
  assert.deepEqual(await read(reader, '/api/v1/events?type=no.existe'), {
    status: 400,
    data: { error: 'Tipo de evento no existe.' },
  });
  assert.equal((await read(reader, '/api/v1/events?type=constructor')).status, 400);

  // Administración ve los tipos registrados y puede filtrar un webhook por ellos; los webhooks los reciben.
  const admins = (await request(session, 'GET', '/api/integrations')).data;
  assert.deepEqual(admins.eventTypes.at(-2), {
    type: 'difusion.enviada',
    title: 'Difusión enviada',
    entity: 'campaign',
  });
  assert.equal(admins.eventTypes.length, BUILT_IN_TYPES.length + 2);
  const hook = filter =>
    request(session, 'POST', '/api/integrations/webhooks', {
      data: { brandId: 'globalvet', url: 'http://127.0.0.1:9/hook', events: filter },
    });
  assert.deepEqual(await hook(['no.existe']), { status: 400, data: { error: 'Algún tipo de evento no existe.' } });
  assert.equal((await hook(['toString'])).status, 400);
  await events.tick(); // lo publicado hasta aquí ya se repartió: el destino nuevo sólo recibe lo que venga después
  const made = await hook(['difusion.enviada']);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.deepEqual(made.data.endpoint.events, ['difusion.enviada']);
  assert.ok(
    events.types().at(-1).subscribers.includes(SUBSCRIBER),
    'los webhooks salientes se suscriben solos a lo registrado',
  );
  const deliveries = () =>
    db
      .prepare(
        'SELECT e.type FROM webhook_deliveries d JOIN domain_events e ON e.seq=d.event_seq WHERE d.endpoint_id=? ORDER BY e.seq',
      )
      .all(made.data.endpoint.id)
      .map(row => row.type);
  events.publish({ type: 'difusion.enviada', brandId: 'globalvet', entityId: 'b-2', source: 'test' });
  events.publish({ type: 'difusion.pausada', brandId: 'globalvet', entityId: 'b-2', source: 'test' });
  events.publish({ type: 'difusion.enviada', brandId: 'odonteck', entityId: 'b-3', source: 'test' });
  await events.tick();
  assert.deepEqual(deliveries(), ['difusion.enviada'], 'sólo el tipo pedido, sólo de su marca');

  // Cada instancia tiene su clasificación y la lista del archivo no cambia.
  assert.equal(EVENT_NEEDS['difusion.enviada'], undefined);
  assert.deepEqual(
    BUILT_IN_TYPES.filter(type => !EVENT_NEEDS[type]),
    [],
  );
});

test('readiness.register: un módulo añade su paso a «Preparar marca»; lo repetido o mal formado se rechaza', async t => {
  const { db, crm, admin, json, request } = await setup(t);
  const errors = [];
  const readiness = createReadiness({ db, crm, json, log: { error: (...args) => errors.push(args.join(' ')) } });
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get('globalvet');
  const base = readiness.forBrand(brand);
  assert.deepEqual(
    base.steps.map(step => step.id),
    [...BUILT_IN_STEPS],
    'BUILT_IN_STEPS sigue al día con la lista de forBrand',
  );

  const seen = [];
  let audiences = 0;
  assert.equal(
    readiness.register({
      id: 'audiencia',
      group: 'Extras',
      title: ' Tiene una audiencia lista ',
      view: 'difusiones',
      label: 'Ir a Difusiones',
      check(marca) {
        seen.push(marca);
        return audiences
          ? { done: true, detail: audiences + ' audiencia lista.' }
          : { done: false, detail: 'Sin audiencias no hay a quién enviar una difusión.' };
      },
    }),
    'audiencia',
  );
  readiness.register({
    id: 'numero-whatsapp',
    group: 'Canal',
    title: 'Tiene un número de WhatsApp conectado',
    required: true,
    view: 'operations',
    tab: 'connectors',
    label: 'Ir a Conectores',
    check: () => ({ done: false }),
  });

  const first = readiness.forBrand(brand);
  assert.deepEqual(
    first.steps.map(step => step.id),
    [...BUILT_IN_STEPS, 'audiencia', 'numero-whatsapp'],
  );
  assert.deepEqual(first.steps.slice(0, BUILT_IN_STEPS.length), base.steps, 'los pasos de siempre no cambian');
  assert.deepEqual(first.steps.at(-2), {
    id: 'audiencia',
    group: 'Extras',
    title: 'Tiene una audiencia lista',
    done: false,
    required: false,
    detail: 'Sin audiencias no hay a quién enviar una difusión.',
    view: 'difusiones',
    label: 'Ir a Difusiones',
  });
  assert.deepEqual(first.steps.at(-1), {
    id: 'numero-whatsapp',
    group: 'Canal',
    title: 'Tiene un número de WhatsApp conectado',
    done: false,
    required: true,
    detail: 'Pendiente.',
    view: 'operations',
    tab: 'connectors',
    label: 'Ir a Conectores',
  });
  assert.deepEqual(seen, [{ id: 'globalvet', name: brand.name }]);
  assert.ok(Object.isFrozen(seen[0]), 'la función del paso no puede cambiar la marca');
  // Cuenta como los demás: un esencial más y un extra más.
  assert.deepEqual(first.essentials, { done: base.essentials.done, total: base.essentials.total + 1 });
  assert.deepEqual(first.extras, { done: base.extras.done, total: base.extras.total + 1 });
  assert.equal(first.ready, false);
  audiences = 1;
  const second = readiness.forBrand(brand);
  assert.deepEqual([second.steps.at(-2).done, second.steps.at(-2).detail], [true, '1 audiencia lista.']);
  assert.equal(second.extras.done, base.extras.done + 1);

  // Repetidos: un id de los de siempre o uno ya registrado.
  const step = (extra = {}) => ({
    id: 'paso-nuevo',
    group: 'Extras',
    title: 'Un paso',
    view: 'operations',
    label: 'Ir',
    check: () => ({ done: true }),
    ...extra,
  });
  for (const id of ['course', 'campaigns', 'audiencia', 'numero-whatsapp'])
    assert.deepEqual(
      status(() => readiness.register(step({ id }))),
      [409, 'Paso de preparación repetido: ' + id],
    );
  // Mal formados.
  for (const extra of [
    { id: 'Paso' },
    { id: 'paso nuevo' },
    { id: 'p' },
    { id: 7 },
    { id: undefined },
    { group: '' },
    { group: 7 },
    { title: '   ' },
    { title: 'x'.repeat(121) },
    { label: undefined },
    { label: 'x'.repeat(41) },
    { view: undefined },
    { view: 'Operations' },
    { view: 'a/b' },
    { tab: 7 },
    { tab: 'Mi pestaña' },
    { required: 'sí' },
    { required: 1 },
    { check: undefined },
    { check: 'done' },
  ])
    assert.equal(status(() => readiness.register(step(extra)))[0], 400, JSON.stringify(extra));
  for (const bad of [null, undefined, 'paso', ['paso'], 7])
    assert.equal(status(() => readiness.register(bad))[0], 400, String(bad));
  assert.equal(readiness.forBrand(brand).steps.length, BUILT_IN_STEPS.length + 2, 'nada de lo rechazado quedó');

  // Un paso cuya función falla (o que no es síncrona) queda pendiente y no tumba la lista.
  readiness.register(
    step({
      id: 'roto',
      required: true,
      check() {
        throw new Error('no such table: audiences');
      },
    }),
  );
  readiness.register(step({ id: 'asincrono', check: async () => ({ done: true, detail: 'x' }) }));
  readiness.register(step({ id: 'tarde', check: () => Promise.reject(new Error('falló después')) }));
  readiness.register(step({ id: 'sin-detalle', check: () => ({ done: true, detail: 7 }) }));
  readiness.register(step({ id: 'raro', check: () => 'listo' }));
  const third = readiness.forBrand(brand);
  const byId = Object.fromEntries(third.steps.map(item => [item.id, item]));
  for (const id of ['roto', 'asincrono', 'tarde'])
    assert.deepEqual([byId[id].done, byId[id].detail], [false, 'No se pudo revisar este paso.'], id);
  assert.deepEqual([byId['sin-detalle'].done, byId['sin-detalle'].detail], [true, 'Listo.']);
  assert.deepEqual([byId.raro.done, byId.raro.detail], [false, 'Pendiente.']);
  assert.equal(byId.course.done, true, 'los demás pasos se siguen viendo');
  assert.equal(errors.length, 3, 'cada fallo se anota en el registro');
  assert.ok(errors[0].includes('roto'), errors[0]);
  for (const item of third.steps) assert.ok(item.title && item.detail && item.view && item.label, item.id);
  await new Promise(done => setTimeout(done, 10)); // la promesa rechazada del paso «tarde» no queda sin atender

  // Por la ruta de siempre, para administración; otra instancia no hereda los pasos registrados.
  const response = await request((req, res, path) => readiness.handle(req, res, path, admin), 'GET', '/api/readiness');
  assert.equal(response.status, 200);
  assert.equal(response.data.brands.length, 3);
  for (const item of response.data.brands)
    assert.deepEqual(item.steps.map(one => one.id).slice(BUILT_IN_STEPS.length, BUILT_IN_STEPS.length + 2), [
      'audiencia',
      'numero-whatsapp',
    ]);
  const fresh = createReadiness({ db, crm, json });
  assert.equal(fresh.forBrand(brand).steps.length, BUILT_IN_STEPS.length);
  assert.equal(fresh.register(step({ id: 'audiencia' })), 'audiencia');
});
