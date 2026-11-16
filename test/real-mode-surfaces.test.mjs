// Modo real por marca (docs/PLAN_MODO_REAL.md), superficies que quedaban pendientes: certificado (SVG y página pública
// de verificación), página pública de encuestas, recordatorio de clase sin enlace simulado, flyers de demostración y los
// textos de cobro del equipo. En laboratorio todo sigue igual; un certificado conserva lo que decía al emitirse.
// Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';

// Cualquier rastro de laboratorio en lo que ve una persona real.
const LAB = /de prueba|de ejemplo|simulad|de práctica|laboratorio|no se cobra|cobros? reales?|ningún cobro/i;
const SIMULATED_MEET = 'https://meet.simulado.tec-capital.test/abc-defg-hij';

test('modo real: certificados, páginas públicas, recordatorio de clase, flyers de demostración y textos de cobro', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-modo-real-sup-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code } });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const { origin } = server;
  const page = async path => {
    const r = await fetch(origin + path);
    return { status: r.status, text: await r.text() };
  };
  const admin = await registerAdmin(origin, code);
  const register = async (username, name) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  const ana = await register('ana', 'Ana Ruiz');
  const luis = await register('luis', 'Luis Mora');
  for (const brand of ['globalvet', 'odonteck'])
    await call(origin, '/api/payments/brands/' + brand, {
      cookie: admin,
      method: 'PATCH',
      body: { enabled: true, linkHours: 48, expectedRevision: 0 },
    });
  await call(origin, '/api/coordination/brands/globalvet', {
    cookie: admin,
    method: 'PATCH',
    body: { enabled: true, reminderHours: 24, expectedRevision: 0 },
  });
  const conversation = async (cookie, courseId) =>
    (await call(origin, '/api/conversations', { cookie, body: { courseId, channel: 'whatsapp' } })).conversation;
  const newOrder = async conv =>
    (await call(origin, '/api/conversations/' + conv.id + '/orders', { cookie: admin, body: {}, expected: 201 })).order;
  const texts = conv =>
    db
      .prepare("SELECT text FROM messages WHERE conversation_id=? AND sender_kind!='customer' ORDER BY seq")
      .all(conv.id)
      .map(m => m.text);
  const certOf = enrollmentId => db.prepare('SELECT * FROM certificates WHERE enrollment_id=?').get(enrollmentId);
  const turn = async (enabled, expectedRevision) =>
    call(origin, '/api/real-mode/brands/globalvet', {
      cookie: admin,
      method: 'PATCH',
      body: { enabled, expectedRevision, confirm: true },
    });

  // ---- laboratorio: Ana compra con el pago simulado, asiste y recibe su certificado de práctica
  const anaConv = await conversation(ana, 'aves');
  const labPreview = await call(origin, '/api/conversations/' + anaConv.id + '/orders/preview', { cookie: admin });
  assert.equal(labPreview.realMode, false, 'en laboratorio la ventana «Cobrar» sigue diciendo «de prueba»');
  const anaOrder = await newOrder(anaConv);
  await call(origin, '/api/payments/orders/' + anaOrder.id + '/pay', { cookie: ana, body: { method: 'card' } });
  const anaEnrollment = db.prepare('SELECT * FROM enrollments WHERE order_id=?').get(anaOrder.id);
  const editionId = anaEnrollment.edition_id;
  db.prepare("UPDATE editions SET run_status='running' WHERE id=?").run(editionId);
  const sessionId = randomUUID(),
    past = Date.now() - 86400000;
  db.prepare(
    "INSERT INTO edition_sessions(id,edition_id,brand_id,number,title,starts_at,duration_min,status,created_at,updated_at) VALUES(?,?,'globalvet',1,'Sesión inicial',?,90,'done',?,?)",
  ).run(sessionId, editionId, past, past, past);
  const attend = enrollmentId =>
    db
      .prepare("INSERT INTO attendance(session_id,enrollment_id,status,marked_at) VALUES(?,?,'present',?)")
      .run(sessionId, enrollmentId, past);
  attend(anaEnrollment.id);
  await call(origin, '/api/certificates/editions/' + editionId + '/issue', { cookie: admin, body: {} });
  const labCert = certOf(anaEnrollment.id);
  assert.ok(labCert, 'certificado de laboratorio emitido');
  assert.equal(JSON.parse(labCert.snapshot).realMode, undefined, 'el de laboratorio no lleva la marca de modo real');
  const labVerify = '/verificar/' + labCert.folio + '/' + labCert.verify_code;
  assert.match((await page(labVerify)).text, /certificado de práctica, sin validez oficial/);
  assert.match((await page(labVerify + '.svg')).text, /certificado de práctica, sin validez oficial/);
  assert.match((await page('/verificar/IPCI-2026-99999')).text, /emitido por este laboratorio/);
  assert.match(
    texts(anaConv).find(m => /certificado/.test(m)),
    /Laboratorio: certificado de práctica\./,
    'el aviso al alumno sigue igual en laboratorio',
  );
  // encuesta de la apertura (en curso): la página pública dice que es de práctica
  await call(origin, '/api/coordination/editions/' + editionId + '/surveys', {
    cookie: admin,
    body: { kind: 'edition' },
  });
  const anaToken = db.prepare('SELECT token FROM survey_invites WHERE enrollment_id=?').get(anaEnrollment.id).token;
  assert.match((await page('/encuesta/' + anaToken)).text, /encuesta de práctica/);
  assert.match((await page('/encuesta/' + 'f'.repeat(32))).text, /encuesta de este laboratorio/);
  // flyer de demostración: en laboratorio se envía como siempre
  const flyerOf = conv =>
    JSON.parse(
      db
        .prepare(
          "SELECT flyer_snapshot FROM messages WHERE conversation_id=? AND sender_kind='agent' ORDER BY seq DESC",
        )
        .get(conv.id).flyer_snapshot || 'null',
    );
  await call(origin, '/api/conversations/' + anaConv.id + '/template', {
    cookie: admin,
    body: { kind: 'flyer', clientRef: randomUUID() },
  });
  const demoSnapshot = flyerOf(anaConv);
  assert.ok(demoSnapshot?.libraryFileId, 'el laboratorio manda el flyer de demostración del curso');
  assert.ok(
    db.prepare('SELECT builtin_id FROM library_files WHERE id=?').get(demoSnapshot.libraryFileId).builtin_id,
    'y es uno de los artes incluidos',
  );
  assert.equal((await fetch(origin + '/api/courses/aves/flyer', { headers: { Cookie: admin } })).status, 200);

  // ---- se enciende el modo real en GlobalVet
  assert.equal((await turn(true, 0)).brand.enabled, true);

  // lo ya emitido no se reescribe: el certificado de Ana sigue diciendo lo que decía
  assert.match((await page(labVerify)).text, /certificado de práctica, sin validez oficial/);
  assert.match((await page(labVerify + '.svg')).text, /certificado de práctica, sin validez oficial/);
  // la encuesta es una página viva de la marca: ya no dice «de práctica»; un enlace o folio inexistente, tampoco
  const survey = await page('/encuesta/' + anaToken);
  assert.equal(survey.status, 200);
  assert.doesNotMatch(survey.text, LAB);
  assert.match(survey.text, /Consulta del /);
  assert.doesNotMatch((await page('/encuesta/' + 'f'.repeat(32))).text, LAB);
  const missingFolio = await page('/verificar/IPCI-2026-99999');
  assert.doesNotMatch(missingFolio.text, LAB);
  assert.match(missingFolio.text, /no corresponde a ningún certificado emitido\./);

  // ---- textos de cobro del equipo: la marca real dice «enlace de pago», la de laboratorio sigue igual
  const luisConv = await conversation(luis, 'aves');
  const realPreview = await call(origin, '/api/conversations/' + luisConv.id + '/orders/preview', { cookie: admin });
  assert.equal(realPreview.realMode, true);
  const odonConv = await conversation(luis, 'odontologia');
  assert.equal(
    (await call(origin, '/api/conversations/' + odonConv.id + '/orders/preview', { cookie: admin })).realMode,
    false,
  );
  const brands = (await call(origin, '/api/bootstrap', { cookie: admin })).brands;
  assert.equal(brands.find(b => b.id === 'globalvet').realMode, true);
  assert.equal('realMode' in brands.find(b => b.id === 'odonteck'), false, 'la marca de laboratorio sale igual');

  // ---- Luis paga de verdad (lo registra el equipo) y su certificado sale sin avisos de prueba
  const luisOrder = await newOrder(luisConv);
  assert.equal(luisOrder.realMode, true);
  await call(origin, '/api/real-mode/orders/' + luisOrder.id + '/paid', {
    cookie: admin,
    body: { how: 'transfer', reference: 'OP-7788', expectedRevision: luisOrder.revision },
  });
  const luisEnrollment = db.prepare('SELECT * FROM enrollments WHERE order_id=?').get(luisOrder.id);
  attend(luisEnrollment.id);
  await call(origin, '/api/certificates/editions/' + editionId + '/issue', { cookie: admin, body: {} });
  const realCert = certOf(luisEnrollment.id);
  assert.equal(JSON.parse(realCert.snapshot).realMode, true, 'se anota el modo al emitir');
  const realVerify = '/verificar/' + realCert.folio + '/' + realCert.verify_code;
  const checkRealCert = async () => {
    const html = (await page(realVerify)).text,
      svg = (await page(realVerify + '.svg')).text;
    assert.doesNotMatch(html, LAB);
    assert.match(html, /Certificado vigente/);
    assert.doesNotMatch(svg, LAB);
    assert.match(svg, /Luis Mora/);
    assert.doesNotMatch((await page('/verificar/' + realCert.folio)).text, LAB);
  };
  await checkRealCert();
  for (const m of texts(luisConv)) assert.doesNotMatch(m, LAB, 'mensaje del sistema a Luis:\n' + m);

  // ---- recordatorio de clase: la marca real no recibe ni manda enlaces del calendario simulado
  const soon = Date.now() + 3 * 86400000;
  const refused = await call(origin, '/api/coordination/editions/' + editionId + '/sessions', {
    cookie: admin,
    body: { startsAt: soon, title: 'Sesión dos', createMeet: true },
    expected: 409,
  });
  assert.equal(refused.code, 'real_mode');
  const second = (
    await call(origin, '/api/coordination/editions/' + editionId + '/sessions', {
      cookie: admin,
      body: { startsAt: soon, title: 'Sesión dos' },
      expected: 201,
    })
  ).session;
  assert.equal(
    (
      await call(origin, '/api/coordination/sessions/' + second.id + '/meet', {
        cookie: admin,
        body: {},
        expected: 409,
      })
    ).code,
    'real_mode',
  );
  // un enlace simulado que la sesión traía de cuando la marca estaba en laboratorio
  db.prepare("UPDATE edition_sessions SET meet_url=?,meet_provider='simulated' WHERE id=?").run(
    SIMULATED_MEET,
    second.id,
  );
  const revision = db.prepare('SELECT revision FROM edition_sessions WHERE id=?').get(second.id).revision;
  await call(origin, '/api/coordination/sessions/' + second.id, {
    cookie: admin,
    method: 'PATCH',
    body: { startsAt: Date.now() + 2 * 3600000, expectedRevision: revision },
  });
  const reminderOf = conv => texts(conv).find(m => /Sesión dos/.test(m));
  for (const conv of [anaConv, luisConv]) {
    const reminder = await until(() => reminderOf(conv), 'recordatorio de clase', { logs: server.logs });
    assert.ok(!reminder.includes('meet.simulado'), 'sin enlace simulado:\n' + reminder);
    assert.doesNotMatch(reminder, LAB);
    assert.match(reminder, /El enlace de la videollamada se enviará por aquí\./);
  }

  // ---- flyers de demostración: no salen a una marca real
  await call(origin, '/api/conversations/' + luisConv.id + '/template', {
    cookie: admin,
    body: { kind: 'flyer', clientRef: randomUUID() },
  });
  assert.equal(flyerOf(luisConv), null, 'el material sale sin el arte de demostración');
  assert.doesNotMatch(texts(luisConv).at(-1), LAB);
  const demoFlyer = db
    .prepare(
      "SELECT f.id FROM flyers f JOIN library_files l ON l.id=f.file_id WHERE f.brand_id='globalvet' AND f.course_id='aves' AND l.builtin_id IS NOT NULL",
    )
    .get();
  const chosen = await call(origin, '/api/conversations/' + luisConv.id + '/template', {
    cookie: admin,
    body: { kind: 'flyer', flyerId: demoFlyer.id, clientRef: randomUUID() },
    expected: 409,
  });
  assert.equal(chosen.code, 'demo_flyer');
  assert.match(chosen.error, /flyer de demostración/);
  assert.equal((await fetch(origin + '/api/courses/aves/flyer', { headers: { Cookie: admin } })).status, 404);
  assert.equal(
    (await fetch(origin + '/api/courses/odontologia/flyer', { headers: { Cookie: admin } })).status,
    200,
    'la marca de laboratorio conserva su arte',
  );
  const card = (await call(origin, '/api/real-mode', { cookie: admin })).brands.find(b => b.brandId === 'globalvet');
  assert.ok(card.demoFlyerCourses.length >= 1);
  assert.ok(
    card.missing.some(m => /flyer de demostración/.test(m)),
    'Preparar marca lo lista entre lo que falta',
  );
  const step = (await call(origin, '/api/readiness', { cookie: admin })).brands
    .find(b => b.id === 'globalvet')
    .steps.find(s => s.id === 'real-mode');
  assert.match(step.detail, /cursos? con flyer de demostración/);

  // ---- al volver al laboratorio, cada certificado conserva lo que decía al emitirse
  await turn(false, 1);
  await checkRealCert();
  assert.match((await page(labVerify)).text, /certificado de práctica, sin validez oficial/);
  assert.match((await page('/encuesta/' + anaToken)).text, /encuesta de práctica/);
  assertSchemaCurrent(db);
});
