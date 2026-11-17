// Bandeja nueva, incremento 2 (docs/PLAN_BANDEJA_VISTAS.md): vistas del sistema, contadores, filtros con la gramática
// común, vistas guardadas, búsqueda y paginación, siempre dentro de las marcas de quien consulta. Servidor real; los
// estados se fijan en la base de la prueba para que cada vista tenga un caso conocido. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { createRepo, SYSTEM_VIEWS } from '../server/modules/inbox/repo.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, until } from './helpers/crm.mjs';

const MIGRATIONS = ['conversations/0001-inbox-views', 'conversations/0002-inbox-indexes'];

async function lab(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-bandeja-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code } });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = server.origin;
  const reg = async (username, name, inviteCode) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD, inviteCode } })).cookie;
  const admin = await reg('admin', 'Administración Prueba', code);
  const id = username => db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
  const staff = async (username, brandIds) => {
    const cookie = await reg(username, 'Asesor ' + username);
    const invite = await call(origin, '/api/team/invites', {
      cookie: admin,
      body: { username, brandIds },
      expected: 201,
    });
    await call(origin, '/api/team/accept', { cookie, body: { token: invite.token } });
    return { cookie, id: id(username) };
  };
  // Una persona que escribe por el laboratorio: su conversación y su primer mensaje.
  const customer = async (username, name, courseId, text, channel = 'whatsapp') => {
    const cookie = await reg(username, name);
    const { conversation } = await call(origin, '/api/conversations', { cookie, body: { courseId, channel } });
    await call(origin, `/api/conversations/${conversation.id}/messages`, {
      cookie,
      body: { text, clientRef: randomUUID() },
      expected: 201,
    });
    return conversation.id;
  };
  const get = (cookie, path, params = {}, expected = 200) =>
    call(origin, path + '?' + new URLSearchParams(params), { cookie, expected });
  return { dir, db, origin, admin, staff, customer, get, id };
}

const ids = list => list.map(row => row.id ?? row.conversation.id).sort();

test('vistas del sistema, contadores, filtros, orden, paginación y búsqueda, sin salir de las marcas de cada quien', async t => {
  const { db, admin, staff, customer, get, id } = await lab(t);
  const ana = await staff('ana', ['globalvet']);
  const beto = await staff('beto', ['odonteck']);
  // Seis conversaciones de GlobalVet y tres de OdonTeck.
  const g = {};
  g.mia = await customer('gv1', 'Ramón Pérez Prueba', 'aves', 'Hola, quiero informes del módulo Ñandú');
  g.espera = await customer('gv2', 'Lucía Gómez Prueba', 'aves', 'Necesito el temario completo');
  g.cola = await customer('gv3', 'Marta Ruiz Prueba', 'aves', 'Hola');
  g.pendiente = await customer('gv4', 'Jorge Díaz Prueba', 'aves', 'Envío mis datos mañana');
  g.resuelta = await customer('gv5', 'Sofía Luna Prueba', 'aves', 'Gracias por todo');
  g.perdida = await customer('gv6', 'Tomás Vega Prueba', 'aves', 'Sigo esperando respuesta');
  const o = {};
  o.uno = await customer('od1', 'Ramona Odón Prueba', 'odontologia', 'Hola, informes del módulo ñandu dental');
  o.dos = await customer('od2', 'Elena Odón Prueba', 'odontologia', 'Precio por favor');
  o.tres = await customer('od3', 'Iván Odón Prueba', 'odontologia', 'Hola');
  // Que el asistente termine de contestar antes de fijar los estados.
  const all = [...Object.values(g), ...Object.values(o)];
  await until(
    () =>
      all.every(c =>
        db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='automation' LIMIT 1").get(c),
      ),
    'el asistente contesta las nueve conversaciones',
  );
  const set = (c, columns) => {
    const keys = Object.keys(columns);
    db.prepare(`UPDATE conversations SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(
      ...keys.map(k => columns[k]),
      c,
    );
  };
  const t0 = Date.now() - 3600_000;
  // Todo en una transacción: el reparto de fondo (operations.reconcile) nunca ve un estado a medias. Y coherente con
  // él: una conversación fuera del asistente cuyo último mensaje de la persona no tiene respuesta de alguien del equipo
  // vuelve a quedar «esperando», así que todas menos `g.espera` llevan una respuesta del equipo.
  db.exec('BEGIN IMMEDIATE');
  // Todas fuera del asistente y sin responsable, con actividad en orden conocido (la más reciente, la primera).
  all.forEach((c, i) => set(c, { bot_enabled: 0, assigned_to: null, updated_at: t0 + (all.length - i) * 1000 }));
  for (const c of all.filter(c => c !== g.espera))
    db.prepare(
      "INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at,read_at) VALUES(?,?,'agent','Con gusto te ayudo',?,?,?)",
    ).run(randomUUID(), c, randomUUID(), t0, t0);
  db.prepare("UPDATE messages SET read_at=? WHERE sender_kind='customer'").run(t0);
  db.prepare('UPDATE service_state SET waiting_since=NULL,due_at=NULL').run();
  set(g.mia, { assigned_to: ana.id });
  db.prepare('UPDATE messages SET read_at=NULL WHERE conversation_id=? AND sender_kind=?').run(g.mia, 'customer');
  db.prepare('UPDATE service_state SET waiting_since=? WHERE conversation_id=?').run(t0, g.espera);
  set(g.cola, { bot_enabled: 1 });
  set(g.pendiente, { state: 'pending', assigned_to: ana.id });
  set(g.resuelta, { state: 'solved', status: 'resolved' });
  set(g.perdida, { state: 'expired' });
  db.prepare('UPDATE conversation_cycles SET closed_at=?,close_kind=?,missed=1 WHERE conversation_id=?').run(
    t0,
    'expired',
    g.perdida,
  );
  set(o.dos, { state: 'solved', status: 'resolved' });
  db.exec('COMMIT');

  const list = async (cookie, params, expected) =>
    (await get(cookie, '/api/inbox/conversations', { brand: 'all', ...params }, expected)).conversations;

  // ---- Cada vista del sistema, vista por administración en todas las marcas
  const expected = {
    mine: [g.mia, g.pendiente], // para Ana
    unreplied: [g.espera],
    unassigned: [g.espera, o.uno, o.tres], // activas, fuera del asistente, sin responsable
    unread: [g.mia],
    assistant: [g.cola],
    active: [g.mia, g.espera, g.cola, g.pendiente, o.uno, o.tres],
    pending: [g.pendiente],
    solved: [g.resuelta, o.dos],
    expired: [g.perdida],
    lost: [g.perdida],
    all,
  };
  for (const view of SYSTEM_VIEWS) {
    const who = view.key === 'mine' ? ana.cookie : admin;
    const brand = view.key === 'mine' ? 'globalvet' : 'all';
    const rows = await list(who, { view: view.key, brand });
    assert.deepEqual(ids(rows), [...expected[view.key]].sort(), 'vista ' + view.key);
  }
  const counts = (await get(admin, '/api/inbox/counts', { brand: 'all' })).counts;
  for (const view of SYSTEM_VIEWS.filter(v => v.key !== 'mine'))
    assert.deepEqual(counts[view.key], { n: expected[view.key].length, capped: false }, 'contador ' + view.key);
  assert.deepEqual((await get(ana.cookie, '/api/inbox/counts', { brand: 'globalvet', views: 'mine' })).counts, {
    mine: { n: 2, capped: false },
  });

  // ---- Una fila trae lo que la bandeja muestra
  const [fila] = await list(ana.cookie, { view: 'unread', brand: 'globalvet' });
  assert.equal(fila.customer.name, 'Ramón Pérez Prueba');
  assert.equal(fila.course.title, 'Plan sanitario para aves');
  assert.equal(fila.assignee.id, ana.id);
  assert.equal(fila.handler, 'person');
  assert.equal(fila.unread, 1);
  assert.equal(fila.state, 'open');
  assert.ok(fila.preview.length > 0);

  // ---- Alcance: Beto (OdonTeck) nunca ve ni cuenta GlobalVet, y Ana nunca ve OdonTeck
  assert.deepEqual(ids(await list(beto.cookie, { view: 'all' })), [o.uno, o.dos, o.tres].sort());
  assert.deepEqual(ids(await list(ana.cookie, { view: 'all' })), Object.values(g).sort());
  const betoCounts = (await get(beto.cookie, '/api/inbox/counts', { brand: 'all' })).counts;
  assert.equal(betoCounts.all.n, 3);
  assert.equal(betoCounts.unread.n, 0);
  assert.equal(betoCounts.lost.n, 0);
  await get(beto.cookie, '/api/inbox/conversations', { brand: 'globalvet', view: 'all' }, 404);
  await get(beto.cookie, '/api/inbox/counts', { brand: 'globalvet' }, 404);
  await get(beto.cookie, '/api/inbox/search', { brand: 'globalvet', q: 'Ramón' }, 404);
  // Un filtro por la marca de otro no abre nada.
  const otra = JSON.stringify({ groups: [{ rules: [{ field: 'brand', op: 'in', value: ['globalvet'] }] }] });
  assert.deepEqual(await list(beto.cookie, { view: 'all', filter: otra }), []);
  // Sin sesión, nada.
  await get('', '/api/inbox/conversations', { brand: 'all' }, 401);

  // ---- Filtros con la gramática común y sus rechazos
  const filtro = rules => JSON.stringify({ version: 1, match: 'any', groups: [{ match: 'all', rules }] });
  assert.deepEqual(
    ids(
      await list(admin, { view: 'all', filter: filtro([{ field: 'state', op: 'in', value: ['solved', 'expired'] }]) }),
    ),
    [g.resuelta, g.perdida, o.dos].sort(),
  );
  assert.deepEqual(
    ids(await list(ana.cookie, { view: 'all', filter: filtro([{ field: 'assignee', op: 'eq', value: 'me' }]) })),
    [g.mia, g.pendiente].sort(),
  );
  assert.deepEqual(
    ids(
      await list(admin, {
        view: 'active',
        filter: filtro([
          { field: 'handler', op: 'eq', value: 'queue' },
          { field: 'course', op: 'in', value: ['odontologia'] },
        ]),
      }),
    ),
    [o.uno, o.tres].sort(),
  );
  const rechazo = async (params, code) => {
    const response = await get(admin, '/api/inbox/conversations', { brand: 'all', view: 'all', ...params }, 400);
    assert.equal(response.code, code, JSON.stringify(response));
  };
  await rechazo({ filter: filtro([{ field: 'telefono', op: 'eq', value: '1' }]) }, 'invalid_conditions');
  await rechazo({ filter: filtro([{ field: 'state', op: 'contains', value: 'open' }]) }, 'invalid_conditions');
  await rechazo({ filter: filtro([{ field: 'state', op: 'in', value: ['cerrada'] }]) }, 'invalid_conditions');
  await rechazo({ filter: '{no es json' }, 'invalid_conditions');
  await rechazo({ view: 'favoritas' }, 'invalid_view');
  await rechazo({ sort: 'waiting' }, 'invalid_input');
  await rechazo({ sort: 'nombre' }, 'invalid_input');
  await rechazo({ limit: '0' }, 'invalid_input');
  await get(admin, '/api/inbox/conversations', { view: 'all' }, 400); // sin marca
  // Etiqueta del contacto (EXISTS sobre contact_tag_links por el contacto de la marca).
  const tag = randomUUID();
  db.prepare("INSERT INTO contact_tags(id,brand_id,name,name_key,created_at) VALUES(?,'globalvet','VIP','vip',?)").run(
    tag,
    t0,
  );
  db.prepare(
    "INSERT INTO contact_tag_links(contact_id,tag_id,created_at) SELECT id,?,? FROM contacts WHERE brand_id='globalvet' AND source_user_id=?",
  ).run(tag, t0, id('gv2'));
  const vip = await list(admin, { view: 'all', filter: filtro([{ field: 'tag', op: 'any', value: [tag] }]) });
  assert.deepEqual(ids(vip), [g.espera]);
  assert.deepEqual(
    vip[0].tags.map(x => x.name),
    ['VIP'],
  );

  // ---- Orden y paginación: de dos en dos, sin repetir ni saltar, con el total en la primera página
  const visto = [];
  let cursor = null;
  let total = null;
  do {
    const page = await get(admin, '/api/inbox/conversations', {
      brand: 'all',
      view: 'all',
      limit: '2',
      ...(cursor ? { cursor } : {}),
    });
    if (!cursor) total = page.total;
    else assert.equal(page.total, undefined);
    visto.push(...page.conversations.map(c => c.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(visto, all, 'la más reciente primero, en el orden de actividad');
  assert.deepEqual(total, { n: 9, capped: false });
  const viejas = await list(admin, { view: 'all', sort: 'oldest' });
  assert.deepEqual(
    viejas.map(c => c.id),
    [...all].reverse(),
  );
  // Un cursor de otra vista, o escrito a mano, se rechaza.
  const primera = await get(admin, '/api/inbox/conversations', { brand: 'all', view: 'all', limit: '2' });
  await rechazo({ view: 'active', limit: '2', cursor: primera.nextCursor }, 'invalid_cursor');
  await rechazo({ cursor: 'eyJ2IjoxfQ.AAAAAAAAAAAAAAAAAAAAAA' }, 'invalid_cursor');

  // ---- Búsqueda: personas (sin acentos), cursos y mensajes; nunca de otra marca
  const busca = async (cookie, q, brand = 'all') => (await get(cookie, '/api/inbox/search', { brand, q })).results;
  const ramon = await busca(admin, 'ramon');
  assert.deepEqual(ids(ramon), [g.mia, o.uno].sort());
  assert.ok(ramon.every(r => r.match.kind === 'contact'));
  assert.deepEqual(ids(await busca(ana.cookie, 'RAMÓN')), [g.mia]);
  assert.deepEqual(ids(await busca(beto.cookie, 'ramon')), [o.uno]);
  const temario = await busca(admin, 'temario completo');
  assert.deepEqual(ids(temario), [g.espera]);
  assert.equal(temario[0].match.kind, 'message');
  assert.match(temario[0].match.text, /temario completo/);
  assert.deepEqual(ids(await busca(beto.cookie, 'temario completo')), []);
  const curso = await busca(beto.cookie, 'odontologia');
  assert.deepEqual(ids(curso), [o.uno, o.dos, o.tres].sort());
  assert.equal(curso[0].match.kind, 'course');
  const vacuna = await busca(admin, 'nandu');
  assert.deepEqual(ids(vacuna), [g.mia, o.uno].sort(), 'mensajes con «Ñandú», sin acento');
  await get(admin, '/api/inbox/search', { brand: 'all', q: 'x' }, 400);

  // ---- Opciones de filtro: sólo de las marcas propias
  const opciones = await get(beto.cookie, '/api/inbox/filters', { brand: 'all' });
  assert.deepEqual(
    opciones.brands.map(b => b.id),
    ['odonteck'],
  );
  assert.ok(opciones.courses.every(c => c.brandId === 'odonteck'));
});

test('vistas guardadas: personales y compartidas, permiso para compartir, revisión, reintentos sin duplicar y topes', async t => {
  const { admin, staff, customer, get, origin } = await lab(t);
  const ana = await staff('ana', ['globalvet']);
  const beto = await staff('beto', ['odonteck']);
  await customer('gv1', 'Ramón Pérez Prueba', 'aves', 'Hola');
  const send = (cookie, method, path, body, expected) => call(origin, path, { cookie, method, body, expected });
  const filtroAbiertas = {
    version: 1,
    match: 'any',
    groups: [{ match: 'all', rules: [{ field: 'state', op: 'in', value: ['open'] }] }],
  };

  // Personal de Ana, con reintento: la misma clientRef devuelve la misma vista
  const ref = randomUUID();
  const nueva = { name: 'Mis abiertas', base: 'all', filter: filtroAbiertas, visibility: 'me', clientRef: ref };
  const creada = (await send(ana.cookie, 'POST', '/api/inbox/views', nueva, 201)).view;
  assert.equal(creada.revision, 1);
  assert.equal(creada.mine, true);
  assert.equal(creada.editable, true);
  const repetida = await send(ana.cookie, 'POST', '/api/inbox/views', nueva, 200);
  assert.equal(repetida.duplicate, true);
  assert.equal(repetida.view.id, creada.id);
  const vistasAna = await get(ana.cookie, '/api/inbox/views', { brand: 'all' });
  assert.deepEqual(
    vistasAna.saved.map(v => v.id),
    [creada.id],
  );
  assert.ok(vistasAna.system.some(v => v.key === 'unreplied'));
  assert.deepEqual(vistasAna.shareBrands, []);
  assert.ok(vistasAna.fields.some(f => f.field === 'state'));
  // Usarla: lista y contador
  const lista = await get(ana.cookie, '/api/inbox/conversations', { brand: 'all', view: 'saved:' + creada.id });
  assert.equal(lista.conversations.length, 1);
  const cuenta = await get(ana.cookie, '/api/inbox/counts', { brand: 'all', views: 'saved:' + creada.id });
  assert.deepEqual(cuenta.counts['saved:' + creada.id], { n: 1, capped: false });
  // Nadie más la ve, ni administración
  await get(admin, '/api/inbox/conversations', { brand: 'all', view: 'saved:' + creada.id }, 404);
  assert.deepEqual((await get(admin, '/api/inbox/views', { brand: 'all' })).saved, []);
  await send(admin, 'PATCH', '/api/inbox/views/' + creada.id, { expectedRevision: 1, name: 'x' }, 404);

  // Una persona asesora no puede compartir
  const compartir = {
    name: 'Abiertas de GlobalVet',
    brandId: 'globalvet',
    base: 'active',
    filter: filtroAbiertas,
    visibility: 'all',
    clientRef: randomUUID(),
  };
  const sinPermiso = await send(ana.cookie, 'POST', '/api/inbox/views', compartir, 403);
  assert.equal(sinPermiso.code, 'permission_denied');
  await send(
    ana.cookie,
    'PATCH',
    '/api/inbox/views/' + creada.id,
    {
      expectedRevision: 1,
      visibility: 'all',
      brandId: 'globalvet',
    },
    403,
  );
  // Compartir sin marca no se puede
  await send(admin, 'POST', '/api/inbox/views', { ...compartir, brandId: null, clientRef: randomUUID() }, 400);
  // Administración comparte con GlobalVet: Ana la ve (sin poder editarla); Beto, de OdonTeck, no
  const compartida = (await send(admin, 'POST', '/api/inbox/views', compartir, 201)).view;
  const paraAna = (await get(ana.cookie, '/api/inbox/views', { brand: 'all' })).saved.find(v => v.id === compartida.id);
  assert.equal(paraAna.editable, false);
  assert.equal(paraAna.mine, false);
  assert.equal(paraAna.ownerName, 'Administración Prueba');
  assert.equal(
    (await get(ana.cookie, '/api/inbox/conversations', { brand: 'all', view: 'saved:' + compartida.id })).conversations
      .length,
    1,
  );
  assert.deepEqual((await get(beto.cookie, '/api/inbox/views', { brand: 'all' })).saved, []);
  await get(beto.cookie, '/api/inbox/conversations', { brand: 'all', view: 'saved:' + compartida.id }, 404);
  await get(beto.cookie, '/api/inbox/counts', { brand: 'all', views: 'saved:' + compartida.id }, 404);
  await send(ana.cookie, 'PATCH', '/api/inbox/views/' + compartida.id, { expectedRevision: 1, name: 'Otra' }, 403);
  await send(ana.cookie, 'DELETE', '/api/inbox/views/' + compartida.id, { expectedRevision: 1 }, 403);

  // Revisión: un cambio con la revisión vieja es 409; el reintento del mismo cambio no choca
  const cambio = { expectedRevision: 1, name: 'Abiertas (equipo)', clientRef: randomUUID() };
  const cambiada = (await send(admin, 'PATCH', '/api/inbox/views/' + compartida.id, cambio, 200)).view;
  assert.equal(cambiada.revision, 2);
  assert.equal(cambiada.name, 'Abiertas (equipo)');
  const reintento = await send(admin, 'PATCH', '/api/inbox/views/' + compartida.id, cambio, 200);
  assert.equal(reintento.duplicate, true);
  assert.equal(reintento.view.revision, 2);
  const vieja = await send(
    admin,
    'PATCH',
    '/api/inbox/views/' + compartida.id,
    { expectedRevision: 1, name: 'Z' },
    409,
  );
  assert.equal(vieja.code, 'stale_record');
  await send(admin, 'PATCH', '/api/inbox/views/' + compartida.id, { name: 'Sin revisión' }, 400);

  // Validación: filtro desconocido, vista de partida inexistente, orden imposible, sin clientRef
  const malo = async (body, code) => {
    const r = await send(
      ana.cookie,
      'POST',
      '/api/inbox/views',
      { name: 'Mala', clientRef: randomUUID(), ...body },
      400,
    );
    assert.equal(r.code, code, JSON.stringify(r));
  };
  await malo({ filter: { groups: [{ rules: [{ field: 'secreto', op: 'eq', value: 'x' }] }] } }, 'invalid_conditions');
  await malo({ base: 'favoritas' }, 'invalid_view');
  await malo({ base: 'all', sort: 'waiting' }, 'invalid_input');
  await malo({ name: '' }, 'invalid_input');
  await malo({ visibility: 'selected' }, 'invalid_input');
  await send(ana.cookie, 'POST', '/api/inbox/views', { name: 'Sin ref' }, 400);
  await send(
    ana.cookie,
    'POST',
    '/api/inbox/views',
    { name: 'Ajena', brandId: 'odonteck', clientRef: randomUUID() },
    404,
  );

  // Borrar (archivar): con revisión; repetir el borrado no falla; ya no se ve
  await send(ana.cookie, 'DELETE', '/api/inbox/views/' + creada.id, { expectedRevision: 9 }, 409);
  assert.deepEqual(await send(ana.cookie, 'DELETE', '/api/inbox/views/' + creada.id, { expectedRevision: 1 }, 200), {
    archived: true,
    cookie: undefined,
  });
  assert.equal(
    (await send(ana.cookie, 'DELETE', '/api/inbox/views/' + creada.id, { expectedRevision: 1 }, 200)).duplicate,
    true,
  );
  await get(ana.cookie, '/api/inbox/conversations', { brand: 'all', view: 'saved:' + creada.id }, 404);
  assert.deepEqual(
    (await get(ana.cookie, '/api/inbox/views', { brand: 'all' })).saved.map(v => v.id),
    [compartida.id],
  );

  // Tope de vistas personales (30)
  for (let i = 0; i < 30; i++)
    await send(ana.cookie, 'POST', '/api/inbox/views', { name: 'Vista ' + i, clientRef: randomUUID() }, 201);
  const tope = await send(ana.cookie, 'POST', '/api/inbox/views', { name: 'Una más', clientRef: randomUUID() }, 409);
  assert.equal(tope.code, 'limit_reached');
});

test('migración conversations/0001 y 0002 sobre una base ya publicada: una sola vez, sin tocar lo que había, y la vista persiste', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-bandeja-mig-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let db = openDatabase(dir);
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => !MIGRATIONS.includes(m.name))) });
  const t0 = Date.now() - 86_400_000;
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u-mig','cliente.mig','Cliente','x','customer',990201,?,?)",
  ).run(t0, t0);
  db.prepare(
    "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,status,created_at,updated_at) VALUES('cv-mig','u-mig','globalvet','aves','whatsapp','open',?,?)",
  ).run(t0, t0);
  db.prepare(
    "INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at) VALUES(?,'cv-mig','customer','hola',?,?)",
  ).run(randomUUID(), randomUUID(), t0);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='inbox_views'").get(), undefined);

  assert.deepEqual(migrate(db, { backup: false }).applied, MIGRATIONS);
  assertSchemaCurrent(db);
  assert.deepEqual(migrate(db, { backup: false }).applied, []);
  for (const name of ['inbox_views', 'messages_unread_customer', 'conversations_inbox_handler'])
    assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name), name);
  assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, 1);

  // Lo existente se lista sin más: la conversación vieja aparece en «No leídas» por el índice nuevo.
  const repo = createRepo(db);
  const unread = SYSTEM_VIEWS.find(v => v.key === 'unread').sql('nadie');
  assert.deepEqual(repo.page(['globalvet'], { limit: 10, partsFor: () => [unread] }).ids, ['cv-mig']);
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM conversations c WHERE c.brand_id = ? AND (${unread.sql})`)
    .all('globalvet', ...unread.params)
    .map(row => row.detail)
    .join(' | ');
  assert.match(plan, /messages_unread_customer/, plan);

  // Una vista guardada sobrevive a cerrar y abrir la base
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u-ag','asesor.mig','Asesor','x','agent',990202,?,?)",
  ).run(t0, t0);
  const viewId = repo.createView(
    null,
    'u-ag',
    {
      name: 'Persistente',
      base: 'unread',
      filter: { version: 1, match: 'any', groups: [] },
      sort: 'recent',
      visibility: 'me',
      clientRef: 'ref-persistente',
    },
    t0,
  );
  db.close();
  db = openDatabase(dir);
  migrate(db, { backup: false });
  const again = createRepo(db).viewById(['globalvet'], viewId);
  assert.equal(again.name, 'Persistente');
  assert.equal(again.revision, 1);
  assert.equal(createRepo(db).viewByRef('u-ag', 'ref-persistente').id, viewId);
  db.close();
});

test('la lista y los contadores llevan tope por persona: repetirlos en bucle responde 429 y no afecta a otra persona', async t => {
  const L = await lab(t);
  const other = await L.staff('tope.otra', ['globalvet']);
  for (const path of ['/api/inbox/counts', '/api/inbox/conversations']) {
    for (let i = 0; i < 120; i++) await L.get(L.admin, path, { brand: 'all' });
    const blocked = await fetch(L.origin + path + '?brand=all', { headers: { Cookie: L.admin, Origin: L.origin } });
    assert.equal(blocked.status, 429, path + ' se limita');
    await L.get(other.cookie, path, { brand: 'all' }); // el tope es de cada persona
  }
});
