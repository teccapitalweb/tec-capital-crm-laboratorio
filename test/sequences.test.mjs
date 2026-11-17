// Secuencias de seguimiento de punta a punta con el servidor real (docs/PLAN_SECUENCIAS.md): rutas, permisos y
// alcance por marca, revisión y reintentos sin duplicar, inscripción a mano en una conversación del laboratorio, el
// envío por la única puerta de salida, la vista previa que no envía, los resultados y el alto manual. La lógica de
// tiempos, topes y reglas de alto se prueba con reloj inyectado en test/sequences-engine.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';

const ref = () => randomUUID();
const step = (amount, unit, text) => ({ timing: { base: 'enrolled', amount, unit }, send: { kind: 'text', text } });

async function lab(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-secuencias-http-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code, AI_PROVIDER: '', CHANNEL_CONNECTOR: '' } });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const admin = await registerAdmin(server.origin, code);
  assertSchemaCurrent(db);
  const as =
    cookie =>
    (path, options = {}) =>
      call(server.origin, path, { cookie, ...options });
  const api = as(admin);
  // Asesora de GlobalVet (sin permiso de automatización).
  const agent = (
    await call(server.origin, '/api/auth/register', {
      body: { username: 'asesora', name: 'Asesora', password: PASSWORD },
    })
  ).cookie;
  const inv = await api('/api/team/invites', { body: { username: 'asesora', brandIds: ['globalvet'] }, expected: 201 });
  await call(server.origin, '/api/team/accept', { cookie: agent, body: { token: inv.token } });
  const outsider = (
    await call(server.origin, '/api/auth/register', { body: { username: 'otra', name: 'Otra', password: PASSWORD } })
  ).cookie;
  const inv2 = await api('/api/team/invites', { body: { username: 'otra', brandIds: ['odonteck'] }, expected: 201 });
  await call(server.origin, '/api/team/accept', { cookie: outsider, body: { token: inv2.token } });
  async function customer(name) {
    const u = await call(server.origin, '/api/auth/register', {
      body: { username: 'cli' + randomUUID().slice(0, 8), name, password: PASSWORD },
    });
    const conv = (
      await call(server.origin, '/api/conversations', {
        cookie: u.cookie,
        body: { courseId: 'aves', channel: 'whatsapp' },
      })
    ).conversation.id;
    return { conv, cookie: u.cookie };
  }
  async function speak() {
    const a = (await api('/api/automation')).brands.find(b => b.id === 'globalvet');
    await api('/api/automation/brands/globalvet', {
      method: 'PATCH',
      body: { enabled: true, expectedRevision: a.revision },
    });
    const rs = (await api('/api/replies/settings')).settings.find(x => x.brand_id === 'globalvet');
    await api('/api/replies/brands/globalvet', {
      method: 'PATCH',
      body: { mode: 'templates', expectedRevision: rs.revision },
    });
  }
  const outgoing = conv =>
    db.prepare("SELECT * FROM messages WHERE conversation_id=? AND client_ref LIKE 'seq:%' ORDER BY seq").all(conv);
  return { server, db, api, agent: as(agent), outsider: as(outsider), customer, speak, outgoing };
}

test('secuencias por HTTP: permisos, marca, revisión, inscripción, envío, vista previa, resultados y alto', async t => {
  const L = await lab(t);
  const clientRef = ref();
  const body = {
    brandId: 'globalvet',
    title: 'Seguimiento de aves',
    courseId: 'aves',
    steps: [
      step(0, 'minutes', 'Hola {{nombre}}, ¿pudiste ver la ficha?'),
      step(1, 'days', 'Mañana cerramos inscripciones'),
    ],
    settings: { sendHours: 'daytime' },
    clientRef,
  };
  // Validación: sin pasos, con un curso de otra marca o con una plantilla que no es de la marca.
  await L.api('/api/sequences', { body: { ...body, steps: [], clientRef: ref() }, expected: 400 });
  await L.api('/api/sequences', { body: { ...body, courseId: 'odontologia', clientRef: ref() }, expected: 400 });
  const bad = await L.api('/api/sequences', {
    body: {
      ...body,
      steps: [
        { timing: { base: 'enrolled', amount: 1, unit: 'days' }, send: { kind: 'template', templateId: 'no-existe' } },
      ],
      clientRef: ref(),
    },
    expected: 400,
  });
  assert.equal(bad.code, 'sequence_invalid');
  // La asesora no crea; la de otra marca no ve.
  await L.agent('/api/sequences', { body: { ...body, clientRef: ref() }, expected: 403 });
  const created = await L.api('/api/sequences', { body, expected: 201 });
  const again = await L.api('/api/sequences', { body, expected: 200 });
  assert.equal(again.sequence.id, created.sequence.id, 'reintento con el mismo clientRef no duplica');
  let seq = created.sequence;
  assert.equal(seq.enabled, false, 'nace apagada');
  assert.equal(seq.steps[1].when, '1 día después de inscribirse');
  const read = await L.agent('/api/sequences/' + seq.id);
  assert.equal(read.canManage, false);
  await L.outsider('/api/sequences/' + seq.id, { expected: 404 });
  assert.equal((await L.outsider('/api/sequences?brand=odonteck')).sequences.length, 0);
  await L.outsider('/api/sequences?brand=globalvet', { expected: 404 });

  // Revisión: un cambio con la revisión vieja responde 409.
  const edited = await L.api('/api/sequences/' + seq.id, {
    method: 'PUT',
    body: { expectedRevision: seq.revision, title: 'Seguimiento de aves (v2)' },
  });
  await L.api('/api/sequences/' + seq.id, {
    method: 'PUT',
    body: { expectedRevision: seq.revision, title: 'x' },
    expected: 409,
  });
  seq = edited.sequence;

  // Apagada o con la marca sin automatización: no se puede inscribir.
  const ana = await L.customer('Ana Pérez');
  await L.agent('/api/sequences/conversations/' + ana.conv, {
    body: { sequenceId: seq.id, clientRef: ref() },
    expected: 409,
  });
  seq = (await L.api('/api/sequences/' + seq.id + '/enable', { body: { expectedRevision: seq.revision } })).sequence;
  assert.equal(seq.enabled, true);
  const off = await L.agent('/api/sequences/conversations/' + ana.conv, {
    body: { sequenceId: seq.id, clientRef: ref() },
    expected: 409,
  });
  assert.equal(off.code, 'automation_off');
  await L.speak();
  // «De día» sin horario de silencio (inicio = fin): la prueba no depende de la hora real a la que corre.
  L.db
    .prepare(
      "INSERT INTO campaign_settings(brand_id,quiet_start,quiet_end,updated_at) VALUES('globalvet','00:00','00:00',?) ON CONFLICT(brand_id) DO UPDATE SET quiet_start='00:00',quiet_end='00:00'",
    )
    .run(Date.now());

  // Vista previa: no envía ni escribe.
  const count = () => L.db.prepare('SELECT count(*) n FROM messages').get().n;
  const before = count();
  const preview = (await L.agent('/api/sequences/' + seq.id + '/preview', { body: {} })).preview;
  assert.equal(count(), before);
  assert.deepEqual(preview.due, []);

  // Inscripción a mano (la asesora puede responder en la marca); el reintento devuelve la misma.
  const enrollRef = ref();
  const enrolled = await L.agent('/api/sequences/conversations/' + ana.conv, {
    body: { sequenceId: seq.id, clientRef: enrollRef },
    expected: 201,
  });
  const repeat = await L.agent('/api/sequences/conversations/' + ana.conv, {
    body: { sequenceId: seq.id, clientRef: enrollRef },
    expected: 200,
  });
  assert.equal(repeat.enrollment.id, enrolled.enrollment.id);
  const dup = await L.agent('/api/sequences/conversations/' + ana.conv, {
    body: { sequenceId: seq.id, clientRef: ref() },
    expected: 409,
  });
  assert.equal(dup.code, 'already_enrolled');
  // La otra marca no puede inscribir ni ver.
  await L.outsider('/api/sequences/conversations/' + ana.conv, { expected: 404 });

  // El primer paso (al inscribirse) sale por la puerta de salida de siempre, como mensaje de la automatización.
  const sent = await until(() => L.outgoing(ana.conv)[0], 'el primer paso de la secuencia', { logs: L.server.logs });
  assert.equal(sent.sender_kind, 'automation');
  assert.equal(sent.text, 'Hola Ana, ¿pudiste ver la ficha?');
  assert.equal(sent.client_ref, `seq:${enrolled.enrollment.id}:0`);
  assert.equal(sent.category, 'service');

  const view = await L.agent('/api/sequences/conversations/' + ana.conv);
  assert.equal(view.enrollments.length, 1);
  assert.equal(view.enrollments[0].state, 'active');
  assert.equal(view.enrollments[0].nextIndex, 1);
  const detail = await L.agent('/api/sequences/enrollments/' + enrolled.enrollment.id);
  assert.deepEqual(
    detail.events.map(e => e.event),
    ['enrolled', 'sent'],
  );
  const results = (await L.agent('/api/sequences/' + seq.id + '/results')).results;
  assert.equal(results.enrolled, 1);
  assert.equal(results.steps[0].sent, 1);
  assert.equal(results.byState.active, 1);

  // Alto manual: queda detenida con su motivo y su paso pendiente se cancela.
  const stopped = await L.agent('/api/sequences/enrollments/' + enrolled.enrollment.id + '/stop', { body: {} });
  assert.equal(stopped.enrollment.state, 'stopped');
  assert.equal(stopped.enrollment.reason, 'manual');
  assert.equal(
    L.db
      .prepare("SELECT count(*) n FROM automation_steps WHERE dedupe_key LIKE ? AND state='pending'")
      .get(`seq:${enrolled.enrollment.id}:%`).n,
    0,
  );
  await L.outsider('/api/sequences/enrollments/' + enrolled.enrollment.id, { expected: 404 });

  // Apagar la secuencia detiene en el acto lo vivo.
  const beto = await L.customer('Beto Ruiz');
  await L.api('/api/sequences/conversations/' + beto.conv, {
    body: { sequenceId: seq.id, clientRef: ref() },
    expected: 201,
  });
  seq = (await L.api('/api/sequences/' + seq.id)).sequence;
  const disabled = await L.api('/api/sequences/' + seq.id + '/disable', { body: { expectedRevision: seq.revision } });
  assert.equal(disabled.stopped, 1);
  const list = await L.agent('/api/sequences?brand=globalvet');
  assert.equal(list.sequences[0].enabled, false);
  assert.ok(list.labels.reasons.sequence_off);
});
