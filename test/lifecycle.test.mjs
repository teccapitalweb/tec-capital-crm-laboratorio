// Ciclo de vida de la conversación (docs/PLAN_CICLO_DE_VIDA.md): estado propio (Abierta, Pendiente, Resuelta, Expirada)
// separado de «quién atiende», ciclos de atención, expiración por marca (apagada por omisión) y «perdido». Servidor real;
// para simular el paso del tiempo se mueven hacia atrás TODAS las marcas de tiempo de la conversación (rewind), nunca
// se espera a que el reloj avance. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, until, whatsappLab } from './helpers/crm.mjs';
import { NUMBER, metaInbound } from './helpers/fake-meta.mjs';

const MIGRATION = 'lifecycle/0001-lifecycle';
const DAY = 24 * 3600000;

// Mueve hacia atrás `ms` todo lo que tiene fecha en una conversación: mensajes, columnas de la ventana, ciclo abierto,
// objetivo de respuesta y la ventana por persona de WhatsApp real.
function rewind(db, id, ms) {
  db.prepare('UPDATE messages SET created_at=created_at-? WHERE conversation_id=?').run(ms, id);
  db.prepare(
    `UPDATE conversations SET created_at=created_at-?,last_customer_at=last_customer_at-?,last_outbound_at=last_outbound_at-?,
      window_until=window_until-?,state_since=state_since-?,last_campaign_at=last_campaign_at-? WHERE id=?`,
  ).run(ms, ms, ms, ms, ms, ms, id);
  db.prepare(
    'UPDATE conversation_cycles SET opened_at=opened_at-?,pending_since=pending_since-?,first_response_at=first_response_at-?,first_human_at=first_human_at-? WHERE conversation_id=? AND closed_at IS NULL',
  ).run(ms, ms, ms, ms, id);
  db.prepare(
    'UPDATE service_state SET waiting_since=waiting_since-?,due_at=due_at-?,queued_since=queued_since-? WHERE conversation_id=?',
  ).run(ms, ms, ms, id);
  db.prepare(
    'UPDATE wa_peer_state SET last_inbound_at=last_inbound_at-? WHERE (phone_number_id,user_id)=(SELECT wa_number,customer_id FROM conversations WHERE id=?)',
  ).run(ms, id);
}

async function lab(t, { prefix = 'crm-ciclo-' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code } });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = server.origin;
  const reg = async (username, inviteCode) =>
    (
      await call(origin, '/api/auth/register', {
        body: { username, name: 'Prueba ' + username, password: PASSWORD, inviteCode },
      })
    ).cookie;
  const admin = await reg('admin', code);
  const staff = async (username, brandIds) => {
    const cookie = await reg(username);
    const invite = await call(origin, '/api/team/invites', {
      cookie: admin,
      body: { username, brandIds },
      expected: 201,
    });
    await call(origin, '/api/team/accept', { cookie, body: { token: invite.token } });
    return { cookie, id: db.prepare('SELECT id FROM users WHERE username=?').get(username).id };
  };
  const conv = id => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  const cycles = id => db.prepare('SELECT * FROM conversation_cycles WHERE conversation_id=? ORDER BY number').all(id);
  const start = async (cookie, courseId = 'aves') =>
    (await call(origin, '/api/conversations', { cookie, body: { courseId, channel: 'whatsapp' } })).conversation.id;
  const say = (cookie, id, text, extra = {}) =>
    call(origin, `/api/conversations/${id}/messages`, {
      cookie,
      body: { text, clientRef: randomUUID(), ...extra },
      expected: extra.expected ?? 201,
    });
  const rev = id => db.prepare('SELECT revision FROM service_state WHERE conversation_id=?').get(id)?.revision ?? 1;
  const move = (cookie, id, to, extra = {}) =>
    call(origin, `/api/lifecycle/conversations/${id}/state`, {
      cookie,
      body: { to, expectedRevision: rev(id), clientRef: randomUUID(), ...extra },
      expected: extra.expected ?? 200,
    });
  const events = (type, id) =>
    db
      .prepare('SELECT payload FROM domain_events WHERE type=? AND entity_id=? ORDER BY seq')
      .all(type, id)
      .map(e => JSON.parse(e.payload));
  const who = id => {
    const c = conv(id);
    return { status: c.status, bot: c.bot_enabled, assigned: c.assigned_to };
  };
  return { dir, db, origin, admin, staff, reg, conv, cycles, start, say, move, rev, events, who, logs: server.logs };
}

test('migración lifecycle/0001 sobre una base ya publicada: estado y origen al migrar, ciclos por trozos al arrancar, una sola vez', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-ciclo-mig-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let db = openDatabase(dir);
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== MIGRATION)) });
  const t0 = Date.now() - 3 * DAY;
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u-mig','cliente.mig','Cliente','x','customer',990101,?,?)",
  ).run(t0, t0);
  const add = (id, status, referral = null, course = 'aves') =>
    db
      .prepare(
        "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,status,created_at,updated_at,edition_id,referral) VALUES(?,'u-mig',(SELECT brand_id FROM courses WHERE id=?),?,'whatsapp',?,?,?,?,?)",
      )
      .run(id, course, course, status, t0, t0 + 5000, 'edition-' + course, referral);
  add('cv-resuelta', 'resolved', null, 'nutricion');
  add('cv-abierta', 'open');
  add('cv-anuncio', 'waiting', JSON.stringify({ source: 'ad', ad: 'Anuncio', adId: 'ad-77' }), 'odontologia');
  const msg = (cid, kind, at) =>
    db
      .prepare('INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), cid, kind, 'hola', randomUUID(), at);
  msg('cv-abierta', 'customer', t0 + 1000);
  msg('cv-abierta', 'automation', t0 + 2000);
  msg('cv-abierta', 'customer', t0 + 3000);
  msg('cv-resuelta', 'customer', t0 + 1000);
  msg('cv-resuelta', 'agent', t0 + 4000);
  db.prepare(
    "INSERT INTO operation_events(brand_id,conversation_id,actor_id,kind,details,created_at) VALUES('globalvet','cv-resuelta',NULL,'resolved','{}',?)",
  ).run(t0 + 6000);
  assert.deepEqual(migrate(db, { backup: false }).applied, [MIGRATION]);
  assertSchemaCurrent(db);
  const row = id =>
    db.prepare('SELECT state,origin,origin_ref,resolved_by,cycle_count FROM conversations WHERE id=?').get(id);
  assert.deepEqual(
    { ...row('cv-resuelta') },
    { state: 'solved', origin: 'lab', origin_ref: null, resolved_by: 'agent', cycle_count: 0 },
  );
  assert.deepEqual(
    { ...row('cv-abierta') },
    { state: 'open', origin: 'lab', origin_ref: null, resolved_by: null, cycle_count: 0 },
  );
  assert.equal(row('cv-anuncio').origin, 'ad');
  assert.equal(row('cv-anuncio').origin_ref, 'ad-77');
  assert.equal(
    db.prepare('SELECT count(*) n FROM conversation_cycles').get().n,
    0,
    'los ciclos no se calculan al migrar',
  );
  // una base nueva y una actualizada quedan con el mismo esquema
  const fresh = await mkdtemp(join(tmpdir(), 'crm-ciclo-nueva-'));
  t.after(() => rm(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const other = openDatabase(fresh);
  migrate(other, { backup: false });
  assert.deepEqual(schemaShape(db), schemaShape(other));
  other.close();
  db.close();

  // al arrancar, el trabajo de relleno crea un ciclo por conversación (backfilled) y llena la ventana
  for (const round of [1, 2]) {
    const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: randomUUID() } });
    db = openDb(dir);
    try {
      await until(
        () => db.prepare("SELECT state FROM background_jobs WHERE kind='lifecycle.backfill'").get()?.state === 'done',
        'relleno terminado',
        { logs: server.logs },
      );
      const cycles = db.prepare('SELECT * FROM conversation_cycles ORDER BY conversation_id').all();
      assert.equal(cycles.length, 3, 'ronda ' + round + ': un ciclo por conversación, sin duplicar');
      const by = id => cycles.find(c => c.conversation_id === id);
      assert.equal(by('cv-resuelta').close_kind, 'solved_agent');
      assert.equal(by('cv-resuelta').closed_at, t0 + 6000, 'cerrado cuando se resolvió');
      assert.equal(by('cv-resuelta').first_response_by, 'agent');
      assert.equal(by('cv-abierta').closed_at, null);
      assert.equal(by('cv-abierta').customer_messages, 2);
      assert.equal(by('cv-abierta').automation_messages, 1);
      assert.equal(by('cv-abierta').first_response_by, 'automation');
      assert.equal(by('cv-anuncio').origin, 'ad');
      for (const c of cycles) assert.equal(c.backfilled, 1);
      const open = db.prepare("SELECT * FROM conversations WHERE id='cv-abierta'").get();
      assert.equal(open.cycle_id, by('cv-abierta').id);
      assert.equal(open.last_customer_at, t0 + 3000);
      assert.equal(open.window_until, t0 + 3000 + DAY);
      assert.equal(db.prepare("SELECT cycle_id FROM conversations WHERE id='cv-resuelta'").get().cycle_id, null);
      // migrar no expira nada y no publica eventos
      assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE state='expired'").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM domain_events WHERE type LIKE 'conversacion.%'").get().n, 0);
    } finally {
      db.close();
      await server.stop();
    }
  }
});

test('transiciones a mano: pendiente y su salida, resolver y reabrir, con permisos, revisión y clientRef; quién atiende no cambia', async t => {
  const L = await lab(t);
  const a = await L.staff('asesora.a', ['globalvet']),
    b = await L.staff('asesora.b', ['globalvet']),
    other = await L.staff('asesora.otra', ['odonteck']),
    client = await L.reg('cliente.uno');

  // T1: la persona escribe por primera vez → Abierta con el ciclo 1
  const id = await L.start(client);
  assert.equal(L.conv(id).state, 'open');
  assert.equal(L.cycles(id).length, 0, 'sin mensajes de la persona no hay atención que contar');
  await L.say(client, id, 'Hola');
  let [cycle] = L.cycles(id);
  assert.equal(cycle.number, 1);
  assert.equal(cycle.opened_by, 'customer');
  assert.equal(cycle.origin, 'lab');
  assert.equal(L.conv(id).cycle_id, cycle.id);
  assert.equal(L.conv(id).origin, 'lab');
  await until(
    () => L.db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='automation'").get(id),
    'responde el asistente',
  );
  assert.equal(L.cycles(id)[0].first_response_by, 'automation');
  assert.deepEqual(L.who(id), { status: 'open', bot: 1, assigned: null }, 'como hoy: lo lleva el asistente');

  // el chip consulta su estado; un cliente no usa estas rutas; otra marca no la ve
  const v = await call(L.origin, '/api/lifecycle/conversations/' + id, { cookie: a.cookie });
  assert.equal(v.state, 'open');
  assert.deepEqual(v.actions, ['pending', 'solved']);
  await L.move(client, id, 'pending', { expected: 403 });
  await L.move(other.cookie, id, 'pending', { expected: 404 });

  // T4 con revisión vieja → 409; con la buena → Pendiente; el mismo clientRef no repite nada
  await L.move(a.cookie, id, 'pending', { expectedRevision: L.rev(id) - 1, expected: 409 });
  const before = L.who(id);
  const ref = randomUUID();
  const pend = await L.move(a.cookie, id, 'pending', { clientRef: ref });
  assert.equal(pend.conversation.state, 'pending');
  assert.equal(L.conv(id).state, 'pending');
  assert.ok(L.cycles(id)[0].pending_since);
  assert.deepEqual(L.who(id), before, 'pendiente no toca status, bot_enabled ni assigned_to');
  const again = await L.move(a.cookie, id, 'pending', { clientRef: ref, expectedRevision: 0 });
  assert.equal(again.duplicate, true);
  assert.equal(L.events('conversacion.estado', id).length, 1);

  // un mensaje del equipo no cambia el estado (y toma el chat, como hoy)
  await L.say(a.cookie, id, 'Te espero con el comprobante', { asAgent: true });
  assert.equal(L.conv(id).state, 'pending');
  assert.deepEqual(L.who(id), { status: 'open', bot: 0, assigned: a.id });
  assert.ok(L.cycles(id)[0].first_human_at);

  // T5: escribe la persona → Abierta y el tiempo en pendiente se suma (5 s simulados)
  L.db.prepare('UPDATE conversation_cycles SET pending_since=pending_since-5000 WHERE id=?').run(cycle.id);
  await L.say(client, id, 'Ya lo tengo');
  assert.equal(L.conv(id).state, 'open');
  cycle = L.cycles(id)[0];
  assert.equal(cycle.pending_since, null);
  assert.ok(cycle.pending_ms >= 5000, 'pendiente suma ' + cycle.pending_ms);
  assert.equal(cycle.customer_messages, 2);

  // T4 y T5 a mano
  await L.move(a.cookie, id, 'pending');
  await L.move(a.cookie, id, 'open');
  assert.equal(L.conv(id).state, 'open');
  await L.move(a.cookie, id, 'open', { expected: 409 }); // ya está abierta

  // colisión: otra asesora no resuelve el chat de A; administración sí podría
  await L.move(b.cookie, id, 'solved', { expected: 409 });

  // T6: resolver cierra el ciclo y deja status como la acción de siempre
  const sent = L.db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get(id).n;
  const res = await L.move(a.cookie, id, 'solved');
  assert.equal(res.conversation.state, 'solved');
  assert.deepEqual(L.who(id), { status: 'resolved', bot: 0, assigned: a.id });
  cycle = L.cycles(id)[0];
  assert.equal(cycle.close_kind, 'solved_agent');
  assert.equal(cycle.closed_by, a.id);
  assert.equal(cycle.handler_at_close, 'agent');
  assert.equal(L.conv(id).cycle_id, null);
  assert.equal(L.conv(id).resolved_by, 'agent');
  assert.equal(L.events('conversacion.resuelta', id).length, 1);
  assert.ok(
    L.db.prepare("SELECT 1 FROM operation_events WHERE conversation_id=? AND kind='state'").get(id),
    'queda en la bitácora de Operación',
  );
  assert.equal(
    L.db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get(id).n,
    sent,
    'nada se envía',
  );

  // T9: reabrir con la ventana abierta → ciclo 2; quien reabre la toma
  const reo = await L.move(b.cookie, id, 'open', { expected: 409 }); // sigue siendo de A
  assert.equal(reo.code, 'collision');
  await L.move(a.cookie, id, 'open');
  assert.equal(L.conv(id).state, 'open');
  assert.deepEqual(L.who(id), { status: 'open', bot: 0, assigned: a.id });
  assert.equal(L.cycles(id).length, 2);
  assert.equal(L.cycles(id)[1].opened_by, 'agent');
  assert.equal(L.events('conversacion.reabierta', id).length, 1);

  // la acción «resolve» de siempre también deja la conversación Resuelta
  await call(L.origin, `/api/conversations/${id}/action`, { cookie: a.cookie, body: { action: 'resolve' } });
  assert.equal(L.conv(id).state, 'solved');
  assert.equal(L.cycles(id)[1].close_kind, 'solved_agent');

  // hilo por episodios (como hoy): la persona no escribe en una resuelta; una nueva apunta a la anterior
  await L.say(client, id, 'Hola otra vez', { expected: 409 });
  const id2 = await L.start(client);
  assert.notEqual(id2, id);
  await L.say(client, id2, 'Otra pregunta');
  assert.equal(L.conv(id2).previous_id, id);
  // reabrir la vieja ya no se puede: hay una más reciente viva
  const newer = await L.move(a.cookie, id, 'open', { expected: 409 });
  assert.equal(newer.code, 'newer_thread');
  assert.equal(newer.details.conversationId, id2);

  // T10: reabrir con la ventana cerrada → Expirada (sólo plantilla en WhatsApp real), sin ciclo
  await call(L.origin, `/api/conversations/${id2}/action`, { cookie: a.cookie, body: { action: 'resolve' } });
  rewind(L.db, id2, 2 * DAY);
  await L.move(a.cookie, id2, 'open');
  assert.equal(L.conv(id2).state, 'expired');
  assert.equal(L.conv(id2).status, 'open');
  const count = L.cycles(id2).length;
  // T11: resolver una expirada la archiva sin tocar su ciclo ya cerrado
  await L.move(a.cookie, id2, 'solved');
  assert.equal(L.conv(id2).state, 'solved');
  assert.equal(L.cycles(id2).length, count);
  assert.equal(L.conv(id2).status, 'resolved');
  // un estado que no existe
  await L.move(a.cookie, id2, 'blocked', { expected: 400 });
});

test('expiración por marca y «perdido»: apagada por omisión, cada caso, aviso, regreso de la persona, encendido silencioso y reparación', async t => {
  const L = await lab(t, { prefix: 'crm-ciclo-expira-' });
  const a = await L.staff('asesora.exp', ['globalvet']);
  const agent2 = await L.staff('asesora.otra', ['globalvet']);
  const clients = {};
  for (const n of ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis']) clients[n] = await L.reg('cliente.' + n);

  // ajustes: valores por omisión, sólo administración cambia, con revisión
  const s0 = await call(L.origin, '/api/lifecycle/settings/globalvet', { cookie: a.cookie });
  assert.equal(s0.settings.autoExpire, false);
  assert.equal(s0.settings.revision, 0);
  assert.equal(s0.settings.canEdit, false);
  const patch = (cookie, brand, body, expected = 200) =>
    call(L.origin, '/api/lifecycle/settings/' + brand, { cookie, method: 'PATCH', body, expected });
  await patch(a.cookie, 'globalvet', { expectedRevision: 0, autoExpire: true }, 403);
  await patch(L.admin, 'globalvet', { expectedRevision: 3, autoExpire: true }, 409);
  await patch(L.admin, 'globalvet', { expectedRevision: 0, attributionDays: 99 }, 400);

  // (agent) la atiende una persona y la persona volvió a escribir sin respuesta
  const A = await L.start(clients.uno);
  await L.say(clients.uno, A, 'Hola');
  await L.say(a.cookie, A, 'Hola, te ayudo', { asAgent: true });
  await L.say(clients.uno, A, '¿Sigues ahí?');
  // (queue) en la cola, sin asistente ni responsable, y nadie contestó nunca
  const B = await L.start(clients.dos);
  L.db.prepare("UPDATE conversations SET bot_enabled=0,status='waiting' WHERE id=?").run(B);
  await L.say(clients.dos, B, 'Necesito ayuda');
  // (automation) la lleva el asistente y su último mensaje quedó sin respuesta (el trabajo no llega a responder)
  const C = await L.start(clients.tres);
  L.db.prepare("UPDATE conversations SET status='waiting' WHERE id=?").run(C);
  await L.say(clients.tres, C, 'Hola');
  // (pendiente) el equipo esperaba algo de la persona
  const D = await L.start(clients.cuatro);
  await L.say(clients.cuatro, D, 'Hola');
  await L.say(a.cookie, D, 'Mándame tu comprobante', { asAgent: true });
  await L.move(a.cookie, D, 'pending');
  // otra marca, con la expiración apagada
  const E = await L.start(clients.cinco, 'odontologia');
  await L.say(clients.cinco, E, 'Hola');

  const snapshot = Object.fromEntries([A, B, C, D, E].map(id => [id, L.who(id)]));
  // se enciende en globalvet ANTES de que venzan (lo que ya estaba vencido al encender expira en silencio);
  // odonteck queda apagada, como por omisión
  const on = await patch(L.admin, 'globalvet', { expectedRevision: 0, autoExpire: true });
  assert.equal(on.settings.autoExpire, true);
  assert.equal(on.settings.revision, 1);
  // el interruptor se enciende «antes» de que venzan: se mueve también su marca de tiempo
  L.db.prepare("UPDATE inbox_settings SET auto_expire_at=auto_expire_at-? WHERE brand_id='globalvet'").run(2 * DAY);
  for (const id of [A, B, C, D, E]) rewind(L.db, id, DAY + 60_000);

  await until(
    () => [A, B, C, D].every(id => L.conv(id).state === 'expired'),
    'expiran las cuatro de la marca con el interruptor',
    { logs: L.logs },
  );
  // el mismo paso del reloj vio a la otra marca: sigue abierta
  assert.equal(L.conv(E).state, 'open');
  const last = id => L.cycles(id).at(-1);
  assert.deepEqual(
    [A, B, C, D].map(id => {
      const y = last(id);
      return [y.close_kind, y.handler_at_close, y.missed, y.missed_strict, y.expired_while_pending];
    }),
    [
      ['expired', 'agent', 1, 0, 0],
      ['expired', 'queue', 1, 1, 0],
      ['expired', 'automation', 1, 1, 0],
      ['expired', 'agent', 0, 0, 1],
    ],
  );
  // expirar no cambia quién atiende
  for (const id of [A, B, C, D]) assert.deepEqual(L.who(id), snapshot[id], 'quién atiende en ' + id);
  // un evento por ciclo, aunque el reloj siga corriendo (no se pisa a sí mismo)
  for (const id of [A, B, C, D]) {
    const ev = L.events('conversacion.expirada', id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].cycleId, last(id).id);
  }
  assert.equal(L.events('conversacion.expirada', A)[0].missed, true);
  // aviso de perdido al responsable y a administración, no a otra asesora
  const notes = L.db.prepare("SELECT user_id FROM notifications WHERE kind='missed' AND conversation_id=?").all(A);
  assert.ok(notes.some(n => n.user_id === a.id));
  assert.ok(!notes.some(n => n.user_id === agent2.id));
  assert.equal(notes.length, 2);
  assert.equal(
    L.db.prepare("SELECT count(*) n FROM notifications WHERE kind='missed' AND conversation_id=?").get(D).n,
    0,
  );
  assert.equal(
    L.db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=? AND created_at>?').get(A, Date.now() - 60_000)
      .n,
    0,
    'expirar no envía nada',
  );

  // T8: la persona vuelve → Abierta en la misma conversación, ciclo 2, origen por campaña reciente sin nadie después
  L.db
    .prepare('UPDATE conversations SET last_campaign_id=?,last_campaign_at=? WHERE id=?')
    .run('camp-1', Date.now() - DAY, B);
  await L.say(clients.dos, B, 'Sigo interesada');
  assert.equal(L.conv(B).state, 'open');
  assert.equal(L.cycles(B).length, 2);
  assert.equal(last(B).origin, 'broadcast');
  assert.equal(last(B).origin_ref, 'camp-1');
  assert.equal(L.events('conversacion.reabierta', B).length, 1);
  assert.equal(L.conv(A).status, 'open', 'A sigue viva: la persona puede volver');

  // encendido silencioso: otra marca con un chat ya vencido al encender → expira sin aviso ni evento
  const F = await L.start(clients.seis, 'estetica');
  await L.say(clients.seis, F, 'Hola');
  rewind(L.db, F, 3 * DAY);
  const so = (await call(L.origin, '/api/lifecycle/settings/odonteck', { cookie: L.admin })).settings;
  await patch(L.admin, 'odonteck', { expectedRevision: so.revision, autoExpire: true });
  await until(() => L.conv(F).state === 'expired' && L.conv(E).state === 'expired', 'expiran las de la otra marca');
  assert.equal(last(F).backfilled, 1);
  assert.equal(L.events('conversacion.expirada', F).length, 0);
  assert.equal(
    L.db.prepare("SELECT count(*) n FROM notifications WHERE kind='missed' AND conversation_id=?").get(F).n,
    0,
  );

  // reparación: alguien escribe status='resolved' por SQL → el reloj la deja Resuelta, ciclo cerrado como reparación
  const G = await L.start(clients.uno, 'nutricion');
  await L.say(clients.uno, G, 'Hola');
  L.db.prepare("UPDATE conversations SET status='resolved' WHERE id=?").run(G);
  await until(() => L.conv(G).state === 'solved', 'reparación');
  assert.equal(last(G).close_kind, 'repair');
  assert.equal(L.events('conversacion.resuelta', G).length, 0);
});

test('WhatsApp real: el anuncio fija el origen del ciclo y la ventana por persona decide la expiración', async t => {
  const L = await whatsappLab(t);
  const origin = L.origin();
  await call(origin, '/api/lifecycle/settings/globalvet', {
    cookie: L.admin,
    method: 'PATCH',
    body: { expectedRevision: 0, autoExpire: true },
  });
  L.db.prepare("UPDATE inbox_settings SET auto_expire_at=auto_expire_at-? WHERE brand_id='globalvet'").run(5 * DAY);
  const ad = {
    source_type: 'ad',
    source_id: '120210000000999',
    source_url: 'https://fb.me/x',
    headline: 'Curso',
    body: 'Aves',
  };
  await metaInbound(origin, '5215511112222', 'wamid.ciclo1', { type: 'text', text: { body: 'Hola' }, referral: ad });
  const c = await until(
    () => L.db.prepare('SELECT * FROM conversations WHERE wa_number=? AND cycle_id IS NOT NULL').get(NUMBER),
    'conversación real con ciclo',
  );
  const cycle = L.db.prepare('SELECT * FROM conversation_cycles WHERE id=?').get(c.cycle_id);
  assert.equal(cycle.origin, 'ad');
  assert.equal(cycle.origin_ref, '120210000000999');
  assert.equal(c.origin, 'ad');
  // los mensajes de la conversación son viejos, pero la persona escribió hace poco a ese número: no expira
  const peer = L.db
    .prepare('SELECT last_inbound_at FROM wa_peer_state WHERE user_id=?')
    .get(c.customer_id).last_inbound_at;
  rewind(L.db, c.id, 2 * DAY);
  L.db.prepare('UPDATE wa_peer_state SET last_inbound_at=? WHERE user_id=?').run(peer, c.customer_id);
  await until(
    () => L.db.prepare('SELECT window_until FROM conversations WHERE id=?').get(c.id).window_until === peer + DAY,
    'el reloj corrige la ventana con la de la persona',
  );
  assert.equal(L.db.prepare('SELECT state FROM conversations WHERE id=?').get(c.id).state, 'open');
  // sin mensaje reciente de la persona, expira
  L.db
    .prepare('UPDATE wa_peer_state SET last_inbound_at=last_inbound_at-? WHERE user_id=?')
    .run(2 * DAY, c.customer_id);
  L.db.prepare('UPDATE conversations SET window_until=window_until-? WHERE id=?').run(2 * DAY, c.id);
  await until(() => L.db.prepare('SELECT state FROM conversations WHERE id=?').get(c.id).state === 'expired', 'expira');
});
