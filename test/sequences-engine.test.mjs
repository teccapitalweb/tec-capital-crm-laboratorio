// Motor de las secuencias de seguimiento (docs/PLAN_SECUENCIAS.md) con una base real migrada, la cola de
// automatización real (server/automation.mjs) y un reloj inyectado: ninguna prueba depende de que el reloj real avance.
// Lo que el motor pide al resto del servidor (ventana, plantillas, modo escucha, salida) son dobles que se controlan
// desde cada prueba; las pruebas de punta a punta (test/sequences.test.mjs) usan los de verdad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../server/database.mjs';
import { migrate, NAMED } from '../server/migrations/index.mjs';
import { createAutomation, cancelConversationSteps, onConversationCancel } from '../server/automation.mjs';
import { createRepo } from '../server/modules/sequences/repo.mjs';
import { STEP_KIND, createEngine } from '../server/modules/sequences/engine.mjs';
import {
  DAY,
  HOUR,
  MINUTE,
  normalizeDefinition,
  stepTiming,
  zonedInstant,
} from '../server/modules/sequences/model.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';

const ZONE = 'America/Mexico_City';
// Lunes 16 de noviembre de 2026, 10:00 en Ciudad de México.
const T0 = zonedInstant({ year: 2026, month: 11, day: 16 }, 10, 0, ZONE);
const ALWAYS = [0, 1, 2, 3, 4, 5, 6].map(() => [0, 1440]);
const quiet = { error() {}, warn() {}, log() {} };

async function lab(t, { hours = ALWAYS } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-secuencias-'));
  const db = openDatabase(dir);
  migrate(db, { backup: false });
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  assertSchemaCurrent(db);
  const clock = { t: T0 };
  const now = () => clock.t;
  const state = {
    mode: { globalvet: true, odonteck: true },
    window: true,
    listen: false,
    suppressed: new Set(),
    templates: {
      'tpl-mkt': { text: 'Cerramos inscripciones', category: 'marketing' },
      'tpl-util': { text: 'Tu curso empieza pronto', category: 'utility' },
    },
    hours,
    flows: new Set(), // conversaciones con un recorrido en curso
  };
  const sent = [];
  const makeAutomation = () => createAutomation({ db, now, leaseMs: 60_000, baseDelayMs: 1000, log: quiet });
  let automation = makeAutomation();
  const repo = createRepo(db);
  const deps = {
    speaks: b => automation.enabledFor(b) && state.mode[b] !== false,
    policy: () => ({ timezone: ZONE, hours: state.hours, holidays: [] }),
    suppressed: (b, contactId) => state.suppressed.has(contactId),
    isOptOutText: text => /\bbaja\b/i.test(text || ''),
    realText: (b, text) => text,
    windowOpen: () => state.window,
    canSend: () => (state.listen ? { ok: false, code: 'number_listen_only' } : { ok: true }),
    flowActive: c => state.flows.has(c.id),
    template: (c, id) =>
      state.templates[id]
        ? { ...state.templates[id], template: { name: id, language: 'es_MX' }, buttons: ['Sí, deseo inscribirme'] }
        : { reason: 'La plantilla de WhatsApp ya no está aprobada para esta marca' },
    material: (c, id) => (id === 'mat-1' ? { text: 'Temario del curso', prepared: null } : { reason: 'No existe' }),
    conditionRecord: (c, contactId) => ({
      attr: {},
      tags: contactId ? [] : [],
      course: c.course_id,
      channel: c.channel,
    }),
    insertMessage(c, plan, ref) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at,category,wa_template) VALUES(?,?,'automation',?,?,?,?,?)",
      ).run(id, c.id, plan.text, ref, now(), plan.category, plan.template ? JSON.stringify(plan.template) : null);
      sent.push({ conversationId: c.id, text: plan.text, kind: plan.kind, category: plan.category, ref });
      return id;
    },
    enqueueInTx: input => automation.enqueueInTx(input),
  };
  const engine = createEngine({ db, repo, deps, now, log: quiet });
  const wire = a => a.register(STEP_KIND, engine.handler);
  wire(automation);
  onConversationCancel(db, engine.onCancel);
  automation.setBrand('globalvet', true, 0, null);
  automation.setBrand('odonteck', true, 0, null);

  let n = 0;
  function person(
    brandId = 'globalvet',
    courseId = brandId === 'globalvet' ? 'aves' : 'odontologia',
    name = 'Ana Pérez',
  ) {
    const k = ++n;
    const user = randomUUID();
    db.prepare(
      "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,'x','customer',?,?,?)",
    ).run(user, 'sec' + k + randomUUID().slice(0, 6), name, 900000 + k + Math.floor(Math.random() * 90000), T0, T0);
    const conv = randomUUID();
    db.prepare(
      "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES(?,?,?,?,'whatsapp',?,?)",
    ).run(conv, user, brandId, courseId, T0, T0);
    const contact = randomUUID();
    db.prepare('INSERT INTO contacts(id,brand_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(
      contact,
      brandId,
      name,
      T0,
      T0,
    );
    const opp = randomUUID();
    db.prepare(
      "INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,created_at,updated_at) VALUES(?,?,?,?,'interesado',?,?)",
    ).run(opp, contact, brandId, courseId, T0, T0);
    db.prepare('INSERT INTO conversation_opportunities(conversation_id,opportunity_id) VALUES(?,?)').run(conv, opp);
    return { conv, contact, opp, brandId, courseId };
  }
  const says = (conv, text) => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at) VALUES(?,?,'customer',?,?,?)",
    ).run(id, conv, text, 'c-' + id, now());
    return id;
  };
  function sequence(brandId, { steps, settings = {}, courseId = null, enabled = true, title = 'Seguimiento' }) {
    const def = normalizeDefinition({ steps, settings });
    assert.deepEqual(def.problems, [], 'definición válida');
    const id = randomUUID();
    repo.insertSequence({
      id,
      brandId,
      title,
      description: '',
      courseId,
      steps: def.steps,
      settings: def.settings,
      clientRef: null,
      userId: null,
      at: now(),
    });
    if (enabled)
      repo.setEnabled(brandId, id, 1, { enabled: true, enabledAt: now(), cursor: repo.maxMessageSeq() }, null, now());
    return repo.sequence(brandId, id);
  }
  const conversation = p => repo.conversation(p.brandId, p.conv);
  const enroll = (p, seq, extra = {}) =>
    transaction(db, () => engine.enrollInTx(conversation(p), repo.sequence(seq.brand_id, seq.id), extra));
  const enrollment = r => repo.enrollment(r.enrollment.brand_id, r.enrollment.id);
  async function run() {
    for (let i = 0; i < 20; i++) if (!(await automation.tick())) break;
  }
  const at = async ms => {
    clock.t = ms;
    await run();
  };
  const sweep = () => engine.sweep(fn => transaction(db, fn));
  const messagesOf = conv =>
    db.prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_kind='automation' ORDER BY seq").all(conv);
  const events = id =>
    db
      .prepare('SELECT event,detail,step_index FROM sequence_events WHERE enrollment_id=? ORDER BY seq')
      .all(id)
      .map(r => ({ ...r }));
  return {
    db,
    clock,
    state,
    sent,
    repo,
    engine,
    person,
    says,
    sequence,
    enroll,
    enrollment,
    run,
    at,
    sweep,
    messagesOf,
    events,
    conversation,
    get automation() {
      return automation;
    },
    restart() {
      automation = makeAutomation();
      wire(automation);
      return automation;
    },
  };
}

const text = (amount, unit = 'days', body = 'Hola {{nombre}}, ¿sigues interesada?') => ({
  timing: { base: 'enrolled', amount, unit },
  send: { kind: 'text', text: body },
});

test('momento de los pasos: relativos a la inscripción, en orden y sin salir antes de tiempo', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', { steps: [text(1), text(3, 'days', 'Último aviso')] });
  const p = L.person();
  const r = L.enroll(p, seq);
  assert.ok(r.enrollment, 'inscrita');
  assert.equal(r.enrollment.next_due_at, T0 + DAY);
  await L.at(T0 + DAY - MINUTE);
  assert.equal(L.messagesOf(p.conv).length, 0, 'un minuto antes no sale nada');
  await L.at(T0 + DAY);
  const first = L.messagesOf(p.conv);
  assert.equal(first.length, 1);
  assert.equal(first[0].text, 'Hola Ana, ¿sigues interesada?');
  assert.equal(first[0].client_ref, `seq:${r.enrollment.id}:0`);
  assert.equal(first[0].category, 'service');
  await L.at(T0 + 3 * DAY - MINUTE);
  assert.equal(L.messagesOf(p.conv).length, 1);
  await L.at(T0 + 3 * DAY);
  assert.equal(L.messagesOf(p.conv).length, 2);
  const e = L.enrollment(r);
  assert.equal(e.state, 'completed');
  assert.equal(e.reason, 'completed');
  assert.deepEqual(
    L.events(e.id).map(x => x.event),
    ['enrolled', 'sent', 'sent', 'completed'],
  );
});

test('momento de los pasos: relativos al inicio de la edición del catálogo (dos días antes y el mismo día)', async t => {
  const L = await lab(t);
  // La edición empieza el sábado 21 a las 18:00 (hora de la marca): la fecha sale del catálogo.
  const start = zonedInstant({ year: 2026, month: 11, day: 21 }, 18, 0, ZONE);
  L.db.prepare("UPDATE editions SET starts_at=?, status='published' WHERE id='edition-aves'").run(start);
  const seq = L.sequence('globalvet', {
    steps: [
      text(1),
      {
        timing: { base: 'edition_start', daysBefore: 2, at: '10:00' },
        send: { kind: 'text', text: 'Faltan dos días' },
      },
      { timing: { base: 'edition_start', daysBefore: 0, at: '09:00' }, send: { kind: 'text', text: 'Hoy empezamos' } },
    ],
  });
  const p = L.person();
  const r = L.enroll(p, seq);
  assert.equal(r.enrollment.edition_id, 'edition-aves');
  await L.at(T0 + DAY);
  const twoBefore = zonedInstant({ year: 2026, month: 11, day: 19 }, 10, 0, ZONE);
  assert.equal(L.enrollment(r).next_due_at, twoBefore);
  await L.at(twoBefore - MINUTE);
  assert.equal(L.messagesOf(p.conv).length, 1);
  await L.at(twoBefore);
  assert.equal(L.messagesOf(p.conv).at(-1).text, 'Faltan dos días');
  const sameDay = zonedInstant({ year: 2026, month: 11, day: 21 }, 9, 0, ZONE);
  assert.equal(L.enrollment(r).next_due_at, sameDay);
  await L.at(sameDay);
  assert.equal(L.messagesOf(p.conv).at(-1).text, 'Hoy empezamos');
  assert.equal(L.enrollment(r).state, 'completed');

  // Quien se inscribe un día antes del inicio no recibe el «dos días antes» (ya pasó su momento): al día siguiente
  // recibe el de la inscripción y el del mismo día de inicio.
  const late = L.person();
  L.clock.t = zonedInstant({ year: 2026, month: 11, day: 20 }, 12, 0, ZONE);
  const r2 = L.enroll(late, seq);
  await L.at(zonedInstant({ year: 2026, month: 11, day: 21 }, 12, 0, ZONE));
  const ev = L.events(r2.enrollment.id);
  assert.ok(ev.some(x => x.event === 'skipped' && x.detail === 'too_late' && x.step_index === 1));
  assert.deepEqual(
    L.messagesOf(late.conv).map(m => m.text),
    ['Hola Ana, ¿sigues interesada?', 'Hoy empezamos'],
  );

  // Sin fecha de inicio en el catálogo, los pasos relativos al inicio se omiten con su motivo.
  L.db.prepare('UPDATE editions SET starts_at=NULL').run();
  const nodate = L.sequence('globalvet', {
    steps: [{ timing: { base: 'edition_start', daysBefore: 1, at: '10:00' }, send: { kind: 'text', text: 'x' } }],
  });
  const r3 = L.enroll(L.person(), nodate);
  assert.equal(L.enrollment(r3).state, 'completed');
  assert.ok(L.events(r3.enrollment.id).some(x => x.detail === 'no_edition_date'));

  // stepTiming: el «mismo día» no puede salir después de que termina el día de inicio.
  const timing = stepTiming(
    { timing: { base: 'edition_start', daysBefore: 0, at: '23:30' } },
    { startedAt: T0, edition: { starts_at: start }, timeZone: ZONE },
  );
  assert.ok(timing.latest <= zonedInstant({ year: 2026, month: 11, day: 22 }, 0, 0, ZONE) - 1);
});

test('el curso ya empezó o terminó: la secuencia se detiene sola', async t => {
  const L = await lab(t);
  const start = T0 + 2 * DAY;
  L.db
    .prepare("UPDATE editions SET starts_at=?, ends_at=?, status='published' WHERE id='edition-aves'")
    .run(start, start + 10 * DAY);
  const seq = L.sequence('globalvet', { steps: [text(5)] });
  const p = L.person();
  const r = L.enroll(p, seq);
  await L.at(T0 + 5 * DAY);
  assert.equal(L.messagesOf(p.conv).length, 0);
  assert.equal(L.enrollment(r).state, 'stopped');
  assert.equal(L.enrollment(r).reason, 'edition_started');
});

test('ventana de 24 horas: plantilla sale cerrada; texto con respaldo de plantilla, omitir o detener', async t => {
  const L = await lab(t);
  L.state.window = false;
  const real = p => L.db.prepare("UPDATE conversations SET wa_number='109000000000001' WHERE id=?").run(p.conv);
  const optIn = p =>
    L.db
      .prepare(
        "INSERT INTO contact_consent(contact_id,brand_id,status,source,updated_at) VALUES(?,?,'opted_in','prueba',?)",
      )
      .run(p.contact, p.brandId, T0);

  // Plantilla de utilidad: sale aunque la ventana esté cerrada, con su categoría de costo.
  const tpl = L.sequence('globalvet', {
    steps: [
      { timing: { base: 'enrolled', amount: 1, unit: 'hours' }, send: { kind: 'template', templateId: 'tpl-util' } },
    ],
  });
  const a = L.person();
  real(a);
  L.enroll(a, tpl);
  await L.at(T0 + HOUR);
  assert.equal(L.messagesOf(a.conv).length, 1);
  assert.equal(L.messagesOf(a.conv)[0].category, 'utility');
  assert.ok(L.messagesOf(a.conv)[0].wa_template);

  // Texto con respaldo de plantilla de marketing: sin consentimiento no sale; con consentimiento, sí.
  const fallback = L.sequence('globalvet', {
    steps: [{ ...text(1, 'hours'), whenClosed: 'template', fallbackTemplateId: 'tpl-mkt' }],
  });
  const b = L.person();
  real(b);
  const rb = L.enroll(b, fallback);
  L.clock.t = T0;
  const c = L.person();
  real(c);
  optIn(c);
  const rc = L.enroll(c, fallback);
  await L.at(T0 + 2 * HOUR);
  assert.equal(L.messagesOf(b.conv).length, 0);
  assert.ok(L.events(rb.enrollment.id).some(x => x.event === 'skipped' && x.detail === 'no_consent'));
  assert.equal(L.messagesOf(c.conv).length, 1);
  assert.equal(L.messagesOf(c.conv)[0].category, 'marketing');
  assert.equal(L.enrollment(rc).state, 'completed');

  // Omitir y detener.
  L.clock.t = T0 + 3 * HOUR;
  const skip = L.sequence('globalvet', { steps: [{ ...text(1, 'hours'), whenClosed: 'skip' }, text(2, 'hours')] });
  const stop = L.sequence('globalvet', { steps: [{ ...text(1, 'hours'), whenClosed: 'stop' }, text(2, 'hours')] });
  const d = L.person();
  const e = L.person();
  const rd = L.enroll(d, skip);
  const re = L.enroll(e, stop);
  await L.at(T0 + 4 * HOUR);
  assert.ok(L.events(rd.enrollment.id).some(x => x.event === 'skipped' && x.detail === 'window_closed'));
  assert.equal(L.enrollment(rd).state, 'active', 'omitir sigue con el paso siguiente');
  assert.equal(L.enrollment(re).state, 'stopped');
  assert.equal(L.enrollment(re).reason, 'window_closed');
  // Con la ventana abierta, el texto sale tal cual.
  L.state.window = true;
  await L.at(T0 + 5 * HOUR);
  assert.equal(L.messagesOf(d.conv).length, 1);

  // Una plantilla en una conversación del laboratorio (sin número real) se omite con su motivo.
  L.clock.t = T0 + 6 * HOUR;
  const labTpl = L.person();
  const rl = L.enroll(labTpl, tpl);
  await L.at(T0 + 7 * HOUR);
  assert.ok(L.events(rl.enrollment.id).some(x => x.detail === 'template_unavailable'));
  assert.equal(L.messagesOf(labTpl.conv).length, 0);
});

test('cada regla de alto se vuelve a mirar justo antes de enviar (cambió entre programar y enviar)', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', { steps: [text(1, 'hours'), text(2, 'hours')] });
  const cases = {
    enrolled_order(p) {
      L.db
        .prepare(
          "INSERT INTO orders(id,reference,brand_id,contact_id,opportunity_id,conversation_id,course_id,edition_id,amount_cents,currency,status,source,expires_at,paid_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'edition-aves',100,'MXN','paid','agent',?,?,?,?)",
        )
        .run(
          randomUUID(),
          'REF-' + randomUUID().slice(0, 8),
          p.brandId,
          p.contact,
          p.opp,
          p.conv,
          p.courseId,
          T0,
          T0,
          T0,
          T0,
        );
      return 'enrolled';
    },
    enrolled_won(p) {
      L.db.prepare("UPDATE opportunities SET stage='ganada',updated_at=? WHERE id=?").run(T0, p.opp);
      return 'enrolled';
    },
    opt_out(p) {
      L.db
        .prepare(
          "INSERT INTO contact_consent(contact_id,brand_id,status,source,updated_at) VALUES(?,?,'opted_out','prueba',?)",
        )
        .run(p.contact, p.brandId, T0);
      return 'opt_out';
    },
    suppressed(p) {
      L.state.suppressed.add(p.contact);
      return 'suppressed';
    },
    blocked(p) {
      L.db.prepare("UPDATE conversations SET state='blocked' WHERE id=?").run(p.conv);
      return 'blocked';
    },
    closed(p) {
      L.db.prepare("UPDATE conversations SET status='resolved' WHERE id=?").run(p.conv);
      return 'closed';
    },
    listen_only(p) {
      L.db.prepare("UPDATE conversations SET wa_number='109000000000001' WHERE id=?").run(p.conv);
      L.state.listen = true;
      return 'listen_only';
    },
    edition_ended(p) {
      // La edición que eligió al inscribirse cambió de fechas en el catálogo y ya terminó.
      L.db.prepare('UPDATE conversations SET edition_id=? WHERE id=?').run('edition-aves', p.conv);
      L.db
        .prepare('UPDATE editions SET starts_at=?, ends_at=? WHERE id=?')
        .run(T0 - 10 * DAY, T0 + 30 * MINUTE, 'edition-aves');
      return 'edition_ended';
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    L.clock.t = T0;
    L.state.listen = false;
    L.db.prepare('UPDATE editions SET starts_at=NULL, ends_at=NULL').run();
    const p = L.person();
    if (name === 'edition_ended')
      L.db.prepare('UPDATE conversations SET edition_id=? WHERE id=?').run('edition-aves', p.conv);
    const r = L.enroll(p, seq);
    assert.ok(r.enrollment, name + ': inscrita');
    const why = change(p);
    await L.at(T0 + HOUR);
    const e = L.enrollment(r);
    assert.equal(L.messagesOf(p.conv).length, 0, name + ': no sale nada');
    assert.equal(e.state, 'stopped', name);
    assert.equal(e.reason, why, name);
    assert.equal(
      L.db
        .prepare("SELECT count(*) n FROM automation_steps WHERE dedupe_key LIKE ? AND state='pending'")
        .get(`seq:${e.id}:%`).n,
      0,
      name + ': no queda ningún paso pendiente',
    );
  }
  L.state.listen = false;
  L.db.prepare('UPDATE editions SET starts_at=NULL, ends_at=NULL').run();

  // La secuencia se apagó entre programar y enviar.
  L.clock.t = T0;
  const p = L.person();
  const r = L.enroll(p, seq);
  L.repo.setEnabled(
    'globalvet',
    seq.id,
    L.repo.sequence('globalvet', seq.id).revision,
    { enabled: false, enabledAt: T0, cursor: 0 },
    null,
    T0,
  );
  await L.at(T0 + HOUR);
  assert.equal(L.enrollment(r).reason, 'sequence_off');
  assert.equal(L.messagesOf(p.conv).length, 0);
});

test('automatización de la marca apagada o asistente que no responde solo: se detiene y no envía', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', { steps: [text(1, 'hours')] });
  // El asistente pasa a «Sugerir»: el paso, al despertar, se detiene.
  const a = L.person();
  const ra = L.enroll(a, seq);
  L.state.mode.globalvet = false;
  await L.at(T0 + HOUR);
  assert.equal(L.enrollment(ra).reason, 'automation_off');
  assert.equal(L.messagesOf(a.conv).length, 0);
  // No se puede inscribir con la marca apagada.
  assert.equal(L.enroll(L.person(), seq).refused, 'automation_off');
  L.state.mode.globalvet = true;
  // La automatización de la marca se apaga: la cola ni siquiera toma el paso; el barrido detiene la inscripción.
  L.clock.t = T0 + 2 * HOUR;
  const b = L.person();
  const rb = L.enroll(b, seq);
  L.automation.setBrand('globalvet', false, 1, null);
  await L.at(T0 + 4 * HOUR);
  assert.equal(L.enrollment(rb).state, 'active', 'la cola no toma pasos de una marca apagada');
  L.sweep();
  assert.equal(L.enrollment(rb).state, 'stopped');
  assert.equal(L.enrollment(rb).reason, 'automation_off');
  assert.equal(L.messagesOf(b.conv).length, 0);
});

test('una persona del equipo toma la conversación: pausa (o alto) y se reanuda sola al volver a la automatización', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', {
    steps: [text(1, 'hours'), text(2, 'days', 'Segundo')],
    settings: { resumeAfterHours: 24 },
  });
  const p = L.person();
  const r = L.enroll(p, seq);
  await L.at(T0 + HOUR);
  assert.equal(L.messagesOf(p.conv).length, 1);
  // Toma humana: el gancho de cancelación pausa al instante y cancela su paso durable.
  L.db
    .prepare('UPDATE conversations SET assigned_to=(SELECT id FROM users LIMIT 1), bot_enabled=0 WHERE id=?')
    .run(p.conv);
  transaction(L.db, () => cancelConversationSteps(L.db, p.conv, 'human_takeover', L.clock.t));
  assert.equal(L.enrollment(r).state, 'paused');
  assert.equal(L.enrollment(r).reason, 'human_takeover');
  await L.at(T0 + 2 * DAY);
  assert.equal(L.messagesOf(p.conv).length, 1, 'en pausa no sale nada');
  // Sigue con la persona del equipo: el barrido no la reanuda.
  L.sweep();
  assert.equal(L.enrollment(r).state, 'paused');
  // Vuelve a la automatización y la persona lleva un día sin escribir: se reanuda; el paso que ya pasó su momento se omite
  // y, si no, sale.
  L.db.prepare('UPDATE conversations SET assigned_to=NULL, bot_enabled=1 WHERE id=?').run(p.conv);
  L.clock.t = T0 + HOUR + 2 * DAY - HOUR;
  L.sweep();
  assert.equal(L.enrollment(r).state, 'active');
  await L.at(T0 + HOUR + 2 * DAY);
  assert.equal(L.messagesOf(p.conv).length, 2);

  // Con «detener» al tomar: el paso, al despertar, se detiene (aunque nadie haya cancelado nada).
  const stopper = L.sequence('globalvet', { steps: [text(1, 'hours')], settings: { onTakeover: 'stop' } });
  L.clock.t = T0 + 10 * DAY;
  const q = L.person();
  const rq = L.enroll(q, stopper);
  L.db.prepare('UPDATE conversations SET assigned_to=(SELECT id FROM users LIMIT 1) WHERE id=?').run(q.conv);
  await L.at(T0 + 10 * DAY + HOUR);
  assert.equal(L.enrollment(rq).state, 'stopped');
  assert.equal(L.enrollment(rq).reason, 'human_takeover');
  assert.equal(L.messagesOf(q.conv).length, 0);
});

test('respuestas: pausa o alto, «sí» y «no por el momento», y la baja por mensaje', async t => {
  const L = await lab(t);
  const pausing = L.sequence('globalvet', { steps: [text(1, 'hours'), text(1, 'days')] });
  const stopping = L.sequence('globalvet', {
    steps: [text(1, 'hours'), text(1, 'days')],
    settings: { onReply: 'stop' },
  });
  const people = Array.from({ length: 5 }, () => L.person());
  // Lo que escribe antes del primer paso no es una respuesta.
  L.says(people[0].conv, 'Hola, quiero información');
  const rs = [
    L.enroll(people[0], pausing),
    L.enroll(people[1], pausing),
    L.enroll(people[2], pausing),
    L.enroll(people[3], stopping),
    L.enroll(people[4], pausing),
  ];
  L.says(people[1].conv, 'antes de empezar');
  await L.at(T0 + HOUR);
  for (const p of people) assert.equal(L.messagesOf(p.conv).length, 1);
  L.clock.t = T0 + 2 * HOUR;
  L.says(people[0].conv, '¿A qué hora es la clase?');
  L.says(people[1].conv, 'No, por el momento');
  L.says(people[2].conv, 'Sí, deseo inscribirme');
  L.says(people[3].conv, 'gracias');
  L.says(people[4].conv, 'denme de baja');
  L.sweep();
  const states = rs.map(r => [L.enrollment(r).state, L.enrollment(r).reason]);
  assert.deepEqual(states, [
    ['paused', 'replied'],
    ['stopped', 'said_no'],
    ['paused', 'replied'],
    ['stopped', 'replied'],
    ['stopped', 'opt_out'],
  ]);
  assert.ok(L.events(rs[2].enrollment.id).some(x => x.event === 'said_yes' && x.step_index === 0));
  assert.ok(L.events(rs[1].enrollment.id).some(x => x.event === 'said_no' && x.step_index === 0));
  // Nada sale después.
  await L.at(T0 + 3 * DAY);
  for (const p of people) assert.equal(L.messagesOf(p.conv).length, 1);

  // Pull sin barrido: la respuesta se ve también al despertar el paso siguiente.
  const q = L.person();
  L.clock.t = T0 + 4 * DAY;
  const rq = L.enroll(q, pausing);
  await L.at(T0 + 4 * DAY + HOUR);
  L.clock.t += MINUTE;
  L.says(q.conv, 'no me interesa');
  await L.at(T0 + 5 * DAY + HOUR);
  assert.equal(L.enrollment(rq).reason, 'said_no');
  assert.equal(L.messagesOf(q.conv).length, 1);
});

test('horario: espera la apertura de la marca o el fin del horario de silencio', async t => {
  // Horario de lunes a viernes de 9:00 a 18:00.
  const L = await lab(t, { hours: [null, [540, 1080], [540, 1080], [540, 1080], [540, 1080], [540, 1080], null] });
  const seq = L.sequence('globalvet', { steps: [text(10, 'hours')] }); // lunes 20:00: fuera de horario
  const p = L.person();
  const r = L.enroll(p, seq);
  await L.at(T0 + 10 * HOUR);
  assert.equal(L.messagesOf(p.conv).length, 0);
  const tuesday9 = zonedInstant({ year: 2026, month: 11, day: 17 }, 9, 0, ZONE);
  assert.equal(L.enrollment(r).next_due_at, tuesday9);
  assert.ok(L.events(r.enrollment.id).some(x => x.event === 'waiting' && x.detail === 'outside_hours'));
  await L.at(tuesday9);
  assert.equal(L.messagesOf(p.conv).length, 1);

  // «De día»: el horario de silencio de las difusiones de la marca (aquí 21:00 a 08:00).
  L.db
    .prepare(
      "INSERT INTO campaign_settings(brand_id,quiet_start,quiet_end,updated_at) VALUES('globalvet','21:00','08:00',?)",
    )
    .run(T0);
  L.clock.t = T0 + 2 * DAY;
  const night = L.sequence('globalvet', { steps: [text(12, 'hours')], settings: { sendHours: 'daytime' } });
  const q = L.person();
  const rq = L.enroll(q, night);
  await L.at(T0 + 2 * DAY + 12 * HOUR); // miércoles 22:00
  assert.equal(L.messagesOf(q.conv).length, 0);
  const thursday8 = zonedInstant({ year: 2026, month: 11, day: 19 }, 8, 0, ZONE);
  assert.equal(L.enrollment(rq).next_due_at, thursday8);
  await L.at(thursday8);
  assert.equal(L.messagesOf(q.conv).length, 1);
});

test('topes: por persona entre secuencias y difusiones, y del mes por secuencia', async t => {
  const L = await lab(t);
  const s1 = L.sequence('globalvet', { steps: [text(1, 'hours', 'Uno')] });
  const s2 = L.sequence('globalvet', { steps: [text(1, 'hours', 'Dos')] });
  const s3 = L.sequence('globalvet', { steps: [text(1, 'hours', 'Tres')] });
  const p = L.person();
  L.enroll(p, s1);
  L.enroll(p, s2);
  const r3 = L.enroll(p, s3);
  await L.at(T0 + HOUR);
  assert.equal(L.messagesOf(p.conv).length, 2, 'dos al día como mucho');
  assert.ok(L.events(r3.enrollment.id).some(x => x.event === 'waiting' && x.detail === 'frequency_cap'));
  const due = L.enrollment(r3).next_due_at;
  assert.ok(due > T0 + DAY && due <= T0 + DAY + HOUR + 2 * MINUTE, 'espera a que se libere el día');
  await L.at(due);
  assert.equal(L.messagesOf(p.conv).length, 3);

  // Una difusión enviada a la persona cuenta para el mismo tope.
  const q = L.person();
  L.clock.t = T0 + 5 * DAY;
  const tpl = L.db.prepare("SELECT id FROM content_templates WHERE brand_id='globalvet' LIMIT 1").get();
  for (const k of [1, 2]) {
    const camp = randomUUID();
    L.db
      .prepare(
        "INSERT INTO campaigns(id,brand_id,title,template_id,status,revision,created_at,updated_at) VALUES(?, 'globalvet','Difusión',?,'sending',1,?,?)",
      )
      .run(camp, tpl?.id ?? null, L.clock.t, L.clock.t);
    L.db
      .prepare(
        "INSERT INTO campaign_recipients(id,campaign_id,contact_id,conversation_id,state,sent_at,created_at,updated_at) VALUES(?,?,?,?,'sent',?,?,?)",
      )
      .run(randomUUID(), camp, q.contact, q.conv, L.clock.t - k * MINUTE, L.clock.t, L.clock.t);
  }
  const rq = L.enroll(q, s1);
  await L.at(T0 + 5 * DAY + HOUR);
  assert.equal(L.messagesOf(q.conv).length, 0);
  assert.ok(L.events(rq.enrollment.id).some(x => x.detail === 'frequency_cap'));

  // Tope del mes de la secuencia: 1 envío.
  const capped = L.sequence('globalvet', { steps: [text(1, 'hours')], settings: { monthlyCap: 1 } });
  L.clock.t = T0 + 6 * DAY;
  const a = L.person();
  const b = L.person();
  L.enroll(a, capped);
  const rb = L.enroll(b, capped);
  await L.at(T0 + 6 * DAY + HOUR);
  assert.equal(L.messagesOf(a.conv).length + L.messagesOf(b.conv).length, 1);
  assert.ok(L.events(rb.enrollment.id).some(x => x.detail === 'monthly_cap'));
});

test('reinicio y arrendamiento vencido: el paso no se envía dos veces', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', { steps: [text(1, 'hours'), text(2, 'hours')] });
  const p = L.person();
  const r = L.enroll(p, seq);
  L.clock.t = T0 + HOUR;
  // Un ejecutor toma el paso y «muere» sin terminarlo.
  const claimed = L.automation.claim();
  assert.equal(claimed.length, 1);
  // Otro proceso (reinicio) con otra identidad: hasta que vence el arrendamiento no lo toca.
  const b = L.restart();
  await b.tick();
  assert.equal(L.messagesOf(p.conv).length, 0);
  // Vence el arrendamiento: se reintenta y sale una vez.
  L.clock.t = T0 + HOUR + 61_000;
  await b.tick();
  L.clock.t += 10_000;
  await b.tick();
  assert.equal(L.messagesOf(p.conv).length, 1);
  // Si el mensaje ya existe (se insertó y el paso no alcanzó a marcarse), el paso no lo repite.
  L.db
    .prepare(
      "INSERT INTO messages(id,conversation_id,sender_kind,text,client_ref,created_at) VALUES(?,?,'automation','ya enviado',?,?)",
    )
    .run(randomUUID(), p.conv, `seq:${r.enrollment.id}:1`, L.clock.t);
  await L.at(T0 + 2 * HOUR + 2 * MINUTE);
  assert.equal(L.messagesOf(p.conv).length, 2, 'el segundo paso no duplicó el mensaje existente');
  assert.equal(L.enrollment(r).state, 'completed');
  assert.equal(
    L.db.prepare("SELECT count(*) n FROM sequence_events WHERE enrollment_id=? AND event='sent'").get(r.enrollment.id)
      .n,
    2,
  );
  // Un paso durable viejo (de otra programación) no hace nada.
  assert.deepEqual(
    L.engine.handler.check({ brand_id: 'globalvet', payload: { enrollmentId: r.enrollment.id, seq: 1, index: 0 } }),
    {
      cancel: 'enrollment_completed',
    },
  );
});

test('alcance por marca: una secuencia de A no toca ni muestra nada de B', async t => {
  const L = await lab(t);
  const a = L.sequence('globalvet', { steps: [text(1, 'hours')] });
  L.sequence('odonteck', { steps: [text(1, 'hours')] });
  const other = L.person('odonteck');
  assert.equal(L.repo.sequence('odonteck', a.id), null);
  assert.equal(L.enroll(other, a).refused, 'not_found');
  assert.deepEqual(
    L.repo.sequences(['odonteck']).map(s => s.brand_id),
    ['odonteck'],
  );
  // La entrada automática de A no mira conversaciones de B.
  const card = L.sequence('globalvet', { steps: [text(1, 'hours')], settings: { trigger: 'course_card' } });
  L.db
    .prepare(
      "INSERT INTO messages(id,conversation_id,sender_kind,text,flyer_course_id,client_ref,created_at) VALUES(?,?,'automation','Ficha','odontologia',?,?)",
    )
    .run(randomUUID(), other.conv, 'f-' + randomUUID(), T0);
  L.sweep();
  assert.equal(L.db.prepare('SELECT count(*) n FROM sequence_enrollments WHERE sequence_id=?').get(card.id).n, 0);
  assert.equal(L.repo.enrollment('odonteck', 'x'), null);
});

test('entrada automática: recibió la ficha del curso desde que se encendió, una sola vez', async t => {
  const L = await lab(t);
  const old = L.person();
  L.db
    .prepare(
      "INSERT INTO messages(id,conversation_id,sender_kind,text,flyer_course_id,client_ref,created_at) VALUES(?,?,'automation','Ficha','aves',?,?)",
    )
    .run(randomUUID(), old.conv, 'f-' + randomUUID(), T0);
  const seq = L.sequence('globalvet', { steps: [text(1, 'days')], settings: { trigger: 'course_card' } });
  const p = L.person();
  const card = () =>
    L.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,sender_kind,text,flyer_course_id,client_ref,created_at) VALUES(?,?,'automation','Ficha','aves',?,?)",
      )
      .run(randomUUID(), p.conv, 'f-' + randomUUID(), T0);
  card();
  // Quien ya pagó no entra.
  const paid = L.person();
  L.db.prepare("UPDATE opportunities SET stage='ganada' WHERE id=?").run(paid.opp);
  L.db
    .prepare(
      "INSERT INTO messages(id,conversation_id,sender_kind,text,flyer_course_id,client_ref,created_at) VALUES(?,?,'automation','Ficha','aves',?,?)",
    )
    .run(randomUUID(), paid.conv, 'f-' + randomUUID(), T0);
  assert.equal(L.sweep().enrolled, 1);
  const rows = L.db.prepare('SELECT conversation_id,source FROM sequence_enrollments WHERE sequence_id=?').all(seq.id);
  assert.deepEqual(
    rows.map(r => [r.conversation_id, r.source]),
    [[p.conv, 'trigger']],
    'sólo la nueva; ni la anterior a encenderla ni la que ya pagó',
  );
  // Detenida, una ficha nueva no la vuelve a inscribir.
  const e = L.repo.live('globalvet', seq.id, p.conv);
  transaction(L.db, () => L.engine.stop(e, L.clock.t));
  card();
  L.sweep();
  assert.equal(L.db.prepare('SELECT count(*) n FROM sequence_enrollments WHERE sequence_id=?').get(seq.id).n, 1);
});

test('vista previa: quién entraría y quién recibiría su paso ahora, sin enviar ni escribir nada', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', {
    steps: [text(1, 'hours'), text(1, 'days')],
    settings: { trigger: 'course_card' },
  });
  const p = L.person();
  const q = L.person();
  L.enroll(p, seq);
  const rq = L.enroll(q, seq);
  L.db.prepare('UPDATE conversations SET assigned_to=(SELECT id FROM users LIMIT 1) WHERE id=?').run(q.conv);
  const fresh = L.person();
  L.db
    .prepare(
      "INSERT INTO messages(id,conversation_id,sender_kind,text,flyer_course_id,client_ref,created_at) VALUES(?,?,'agent','Ficha','aves',?,?)",
    )
    .run(randomUUID(), fresh.conv, 'f-' + randomUUID(), T0);
  L.clock.t = T0 + HOUR;
  const count = () =>
    ['messages', 'sequence_events', 'sequence_enrollments', 'automation_steps', 'automation_events'].map(
      table => L.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
    );
  const before = count();
  const steps = L.db.prepare('SELECT id,state,updated_at FROM automation_steps ORDER BY id').all();
  const preview = L.engine.preview(L.repo.sequence('globalvet', seq.id));
  assert.deepEqual(count(), before, 'no escribió nada');
  assert.deepEqual(L.db.prepare('SELECT id,state,updated_at FROM automation_steps ORDER BY id').all(), steps);
  assert.equal(L.sent.length, 0, 'no envió nada');
  assert.equal(preview.enter.count, 1);
  assert.equal(preview.enter.sample[0].conversationId, fresh.conv);
  const byConv = Object.fromEntries(preview.due.map(d => [d.conversationId, d]));
  assert.equal(byConv[p.conv].outcome, 'send');
  assert.equal(byConv[q.conv].outcome, 'pause');
  assert.equal(byConv[q.conv].reason, 'human_takeover');
  assert.equal(L.enrollment(rq).state, 'active', 'la vista previa no pausó a nadie');
});

test('resultados: inscritas, enviados, respuestas, sí y no, motivos de alto e inscritos tras el paso', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', { steps: [text(1, 'hours'), text(2, 'days')] });
  const [a, b, c, d] = [L.person(), L.person(), L.person(), L.person()];
  for (const p of [a, b, c, d]) L.enroll(p, seq);
  await L.at(T0 + HOUR);
  L.clock.t = T0 + 2 * HOUR;
  L.says(a.conv, 'Sí, deseo inscribirme');
  L.says(b.conv, 'No, por el momento');
  // c se inscribe dos días después del primer paso: cuenta como «inscrito tras el paso 1» y su secuencia se detiene.
  L.db.prepare("UPDATE opportunities SET stage='ganada',updated_at=? WHERE id=?").run(T0 + 2 * DAY, c.opp);
  L.sweep();
  await L.at(T0 + 2 * DAY + HOUR);
  const results = (() => {
    const counts = L.repo.stepCounts('globalvet', seq.id);
    const conv = L.repo.convertedByStep('globalvet', seq.id, 7 * DAY);
    return { counts, conv };
  })();
  const n = (ev, step) =>
    results.counts
      .filter(r => r.event === ev && (step === undefined || r.step_index === step))
      .reduce((s, r) => s + r.n, 0);
  assert.equal(n('enrolled'), 4);
  assert.equal(n('sent', 0), 4);
  assert.equal(n('sent', 1), 1, 'sólo d llega al segundo paso');
  assert.equal(n('replied', 0), 2);
  assert.equal(n('said_yes', 0), 1);
  assert.equal(n('said_no', 0), 1);
  assert.deepEqual(
    results.conv.map(r => [r.step_index, r.n]),
    [[0, 1]],
  );
  const states = Object.fromEntries(L.repo.stateCounts('globalvet', seq.id).map(r => [r.state + ':' + r.reason, r.n]));
  assert.deepEqual(states, {
    'paused:replied': 1,
    'stopped:said_no': 1,
    'stopped:enrolled': 1,
    'completed:completed': 1,
  });
});

test('migración: una base anterior se actualiza conservando sus datos y repetirla no cambia nada', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-secuencias-mig-'));
  const db = openDatabase(dir);
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const before = NAMED.filter(m => !m.name.startsWith('sequences/'));
  migrate(db, { backup: false, registry: before });
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sequences'").get(), undefined);
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u-1','anterior','Anterior','x','customer',777001,1,1)",
  ).run();
  const users = db.prepare('SELECT count(*) n FROM users').get().n;
  const out = migrate(db, { backup: false });
  assert.deepEqual(out.applied, ['sequences/0001-sequences']);
  assertSchemaCurrent(db);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, users);
  const shape = schemaShape(db);
  assert.deepEqual(migrate(db, { backup: false }).applied, []);
  assert.deepEqual(schemaShape(db), shape);
  // Persistencia: se escribe, se cierra y se vuelve a abrir.
  db.prepare(
    "INSERT INTO sequences(id,brand_id,title,steps,settings,created_at,updated_at) VALUES('s-1','globalvet','Prueba','[]','{}',1,1)",
  ).run();
  db.close();
  const again = openDatabase(dir);
  try {
    assert.equal(again.prepare("SELECT title FROM sequences WHERE id='s-1'").get().title, 'Prueba');
    assert.equal(again.prepare("SELECT enabled FROM sequences WHERE id='s-1'").get().enabled, 0, 'nace apagada');
    assert.equal(again.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    again.close();
  }
});

test('el ejemplo de la guía: día siguiente, a los tres días, dos días antes y el mismo día (sábado, «De día»)', async t => {
  // Horario de atención de lunes a viernes; la secuencia envía «De día» para alcanzar el sábado.
  const L = await lab(t, { hours: [null, [540, 1080], [540, 1080], [540, 1080], [540, 1080], [540, 1080], null] });
  const start = zonedInstant({ year: 2026, month: 11, day: 21 }, 18, 0, ZONE);
  L.db.prepare("UPDATE editions SET starts_at=?, status='published' WHERE id='edition-aves'").run(start);
  const seq = L.sequence('globalvet', {
    steps: [
      text(1, 'days', 'Uno'),
      text(3, 'days', 'Dos'),
      { timing: { base: 'edition_start', daysBefore: 2, at: '10:00' }, send: { kind: 'text', text: 'Tres' } },
      { timing: { base: 'edition_start', daysBefore: 0, at: '09:00' }, send: { kind: 'text', text: 'Cuatro' } },
    ],
    settings: { sendHours: 'daytime' },
  });
  const p = L.person();
  L.enroll(p, seq);
  // El reloj avanza de media en media hora hasta el sábado por la noche.
  const end = zonedInstant({ year: 2026, month: 11, day: 21 }, 23, 0, ZONE);
  for (let x = T0; x <= end; x += 30 * MINUTE) await L.at(x);
  const when = m =>
    new Intl.DateTimeFormat('es-MX', { timeZone: ZONE, weekday: 'long', hour: 'numeric', hourCycle: 'h23' }).format(
      m.created_at,
    );
  assert.deepEqual(
    L.messagesOf(p.conv).map(m => [m.text, when(m)]),
    [
      ['Uno', 'martes, 10'],
      ['Dos', 'jueves, 10'],
      ['Tres', 'jueves, 10'],
      ['Cuatro', 'sábado, 09'],
    ],
  );
});

test('entrada automática: un archivo que mandó un recorrido no cuenta como ficha del curso', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', { steps: [text(1, 'days')], settings: { trigger: 'course_card' } });
  const p = L.person();
  const message = (label, snapshot) =>
    L.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,sender_kind,text,flyer_course_id,flyer_snapshot,client_ref,created_at) VALUES(?,?,'automation',?,'aves',?,?,?)",
      )
      .run(randomUUID(), p.conv, label, JSON.stringify(snapshot), 'f-' + randomUUID(), T0);
  const enrolled = () => L.db.prepare('SELECT count(*) n FROM sequence_enrollments WHERE sequence_id=?').get(seq.id).n;
  // Un PDF cualquiera de la biblioteca viaja en la misma columna que la ficha, con `file: true`.
  message('El reglamento', { libraryFileId: randomUUID(), file: true });
  assert.equal(L.sweep().enrolled, 0);
  assert.equal(enrolled(), 0, 'no entra por un archivo');
  assert.equal(L.engine.preview(seq).enter.count, 0, 'y la vista previa tampoco la cuenta');
  // La ficha de verdad sí la inscribe.
  message('Ficha', { courseId: 'aves', title: 'Plan sanitario para aves' });
  assert.equal(L.sweep().enrolled, 1);
  assert.equal(enrolled(), 1);
});

test('antes del primer paso: quien dice que no o pide la baja no recibe ni el primer mensaje', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', { steps: [text(1, 'hours'), text(1, 'days')] });
  const [no, out, other] = [L.person(), L.person(), L.person()];
  const rs = [no, out, other].map(p => L.enroll(p, seq));
  L.says(no.conv, 'No, por el momento');
  L.says(out.conv, 'Quiero la baja');
  L.says(other.conv, '¿A qué hora es la clase?');
  await L.at(T0 + HOUR);
  assert.equal(L.messagesOf(no.conv).length, 0);
  assert.equal(L.messagesOf(out.conv).length, 0);
  assert.equal(L.messagesOf(other.conv).length, 1, 'una pregunta cualquiera no detiene nada');
  assert.deepEqual(
    rs.map(r => [L.enrollment(r).state, L.enrollment(r).reason]),
    [
      ['stopped', 'said_no'],
      ['stopped', 'opt_out'],
      ['active', null],
    ],
  );
});

// Un recorrido que inscribe en una secuencia y sigue conversando: la secuencia no habla a la vez. Su paso espera a que
// el recorrido termine (la espera se anota una sola vez) y lo que la persona contesta al recorrido antes del primer
// paso no cuenta como respuesta a la secuencia (sólo una baja o una frase de alto).
test('un recorrido atiende la conversación: el paso espera a que termine y la espera se anota una vez', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', { steps: [text(0, 'minutes', 'Hola {{nombre}}, te dejo el temario')] });
  const p = L.person();
  L.state.flows.add(p.conv);
  const r = L.enroll(p, seq, { source: 'flow', clientRef: 'flow:sesion:n3' });
  await L.run();
  assert.equal(L.messagesOf(p.conv).length, 0, 'no habla en medio del recorrido');
  await L.at(T0 + 10 * MINUTE + 1);
  await L.at(T0 + 20 * MINUTE + 2);
  assert.equal(L.messagesOf(p.conv).length, 0);
  assert.equal(L.events(r.enrollment.id).filter(e => e.detail === 'flow_active').length, 1, 'la espera, una vez');
  assert.equal(L.enrollment(r).state, 'active');
  // Contesta los botones del recorrido: no es una respuesta a la secuencia.
  L.says(p.conv, 'Sí, me interesa');
  L.sweep();
  assert.equal(L.enrollment(r).state, 'active');
  // El recorrido terminó: el paso sale en su siguiente vuelta.
  L.state.flows.delete(p.conv);
  await L.at(T0 + 30 * MINUTE + 3);
  const out = L.messagesOf(p.conv);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /te dejo el temario/);
  assert.equal(L.enrollment(r).state, 'completed');
  // Con el mismo clientRef no se inscribe otra vez (un reintento del recorrido).
  assert.equal(L.enroll(p, seq, { source: 'flow', clientRef: 'flow:sesion:n3' }).duplicate, true);
});

test('un paso que agotó sus intentos detiene la inscripción en lugar de reprogramarse sin fin', async t => {
  const L = await lab(t);
  const seq = L.sequence('globalvet', { steps: [text(1, 'hours')] });
  const r = L.enroll(L.person(), seq);
  const e = L.enrollment(r);
  const key = `seq:${e.id}:${e.next_index}:${e.schedule_seq}`;
  const steps = () =>
    L.db.prepare("SELECT count(*) n FROM automation_steps WHERE dedupe_key LIKE 'seq:' || ? || ':%'").get(e.id).n;
  assert.equal(steps(), 1);
  L.db.prepare("UPDATE automation_steps SET state='failed',error='prueba' WHERE dedupe_key=?").run(key);
  assert.equal(L.sweep().stopped, 1);
  assert.deepEqual([L.enrollment(r).state, L.enrollment(r).reason], ['stopped', 'step_failed']);
  L.sweep();
  L.sweep();
  assert.equal(steps(), 1, 'no se programó ningún paso más');
  assert.equal(L.sent.length, 0);
});
