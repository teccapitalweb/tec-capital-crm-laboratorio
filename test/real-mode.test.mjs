// Modo real por marca (docs/PLAN_MODO_REAL.md): apagado, todo igual que hoy; encendido, ningún texto armado por el sistema
// dice que es una prueba y la página de pago no ofrece ni acepta métodos simulados; sólo el equipo con permiso marca
// pagado un pedido, con cómo y con qué referencia; otra marca sigue en laboratorio; el interruptor pide administración,
// revisión y confirmación; la migración se aplica sobre una base ya publicada. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import * as copy from '../server/reply-copy.mjs';
import { LAB_WORDING, forBrand, isRealBrand, realText } from '../server/lib/real-mode.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';

const MIGRATION = 'real-mode/0001-brand-real-mode';
// Más amplio que LAB_WORDING (que es lo que el modo real quita): cualquier rastro de laboratorio en un texto para el cliente.
const LAB = /de prueba|de ejemplo|simulad|de práctica|laboratorio|no se cobra|cobros? reales?|ningún cobro/i;
const clean = (text, what) => assert.doesNotMatch(String(text), LAB, what + ':\n' + text);

// Contexto de catálogo inventado, sin palabras de laboratorio, para armar cada texto fijo del asistente.
const ctx = {
  course: { title: 'Nutrición de aves', welcome: 'Hola, {{nombre}}. Te cuento de {{curso}}.', syllabus: 'Uno\nDos' },
  edition: {
    name: 'Edición de diciembre',
    starts_at: Date.UTC(2026, 11, 2, 1, 0),
    timezone: 'America/Mexico_City',
    instructor: 'Dra. Paz',
    modality: 'online',
    currency: 'MXN',
    available_seats: 4,
  },
  brand: { name: 'Marca Uno' },
  priceCents: 189000,
  currency: 'MXN',
  promotion: { name: 'Preventa', ends_at: Date.UTC(2026, 10, 30, 6) },
  dateLabel: '',
};
const ORDER = {
  reference: 'TC-ABC123',
  course: 'Nutrición de aves',
  edition: 'Edición de diciembre',
  amount: '$1,890.00',
  link: 'https://crm.example.test/?pay=1',
  until: '30 nov 2026',
};
// Cada exportación de texto de reply-copy con sus argumentos. Una exportación nueva sin entrada aquí hace fallar la prueba:
// así nadie añade un texto sin comprobar su versión real.
const TEXTS = {
  LAB_NOTE: () => copy.LAB_NOTE,
  card: () => copy.card(ctx),
  welcome: () => copy.welcome(ctx, 'Ana Ruiz'),
  priceBody: () => copy.priceBody(ctx),
  price: () => copy.price(ctx),
  syllabusBody: () => copy.syllabusBody(ctx),
  syllabus: () => copy.syllabus(ctx),
  scheduleBody: () => copy.scheduleBody(ctx),
  schedule: () => copy.schedule(ctx),
  several: () => copy.several(['a', 'b'], { price: true }) + '\n' + copy.several(['a']),
  enrollWithOrder: () => copy.enrollWithOrder(ctx, 'Ana'),
  orderReminder: () => copy.orderReminder(),
  enrollWithAdvisor: () => copy.enrollWithAdvisor(ctx, 'Ana'),
  paymentMethods: () => copy.paymentMethods,
  paymentWithAdvisor: () => copy.paymentWithAdvisor,
  thanks: () => copy.thanks('Ana'),
  thanksAgain: () => copy.thanksAgain,
  affirm: () => copy.affirm(ctx),
  decline: () => copy.decline('Ana'),
  later: () => copy.later('Ana'),
  bye: () => copy.bye('Ana'),
  help: () => copy.help(ctx),
  menu: () => copy.menu(ctx),
  identity: () => copy.identity(ctx),
  seats: () =>
    [4, 30, 0, null].map(n => copy.seats({ ...ctx, edition: { ...ctx.edition, available_seats: n } })).join('\n'),
  courses: () => copy.courses(ctx, ['Otro curso']) + '\n' + copy.courses(ctx, []),
  chooseCourse: () =>
    copy.chooseCourse('Marca Uno', ['A', 'B']) + copy.chooseCourse('Marca Uno', ['A'], { again: true }),
  courseMenu: () => copy.courseMenu(ctx, ['A', 'B']),
  whichCourse: () => copy.whichCourse(['A', 'B']),
  switchBlocked: () => copy.switchBlocked(ctx, 'Otro'),
  objection: () => copy.objection(ctx),
  fallback: () => copy.fallback(ctx),
  offerHuman: () => copy.offerHuman,
  escalate: () => copy.escalate,
  human: () => copy.human('Ana'),
  unsupportedMedia: () => copy.unsupportedMedia('audios'),
  refund: () => copy.refund('Ana'),
  unavailable: () => copy.unavailable('Sin cupo'),
  orderLink: () => copy.orderLink(ORDER) + '\n' + copy.orderLink({ ...ORDER, coupon: ' Incluye tu cupón X.' }),
  paymentConfirmed: () =>
    copy.paymentConfirmed({ name: 'Ana', ...ORDER }) +
    copy.paymentConfirmed({ name: 'Ana', ...ORDER, perSession: true }),
  REAL_PAYMENT_METHODS: () => copy.REAL_PAYMENT_METHODS,
  BUTTONS_PROMPT: () => copy.BUTTONS_PROMPT,
};
const NOT_TEXT = ['firstName', 'noHour', 'startText', 'whenText', 'zoneWords', 'priceText', 'facts', 'LAB_SWAPS'];

test('textos fijos del asistente: en modo real ninguno dice prueba, ejemplo ni simulado; el precio y la fecha siguen', () => {
  assert.deepEqual(
    Object.keys(copy)
      .filter(k => !NOT_TEXT.includes(k))
      .sort(),
    Object.keys(TEXTS).sort(),
    'cada texto de reply-copy tiene su comprobación en modo real',
  );
  for (const [name, build] of Object.entries(TEXTS)) {
    const lab = build(),
      real = realText(lab);
    clean(real, name);
    // el aviso suelto desaparece; todo lo demás conserva su contenido
    if (name === 'LAB_NOTE') assert.equal(real, '');
    else assert.ok(real.trim().length > 0, name + ' no queda vacío');
  }
  // el dato del catálogo no se toca
  assert.match(realText(copy.price(ctx)), /\$1,890\.00 MXN con la promoción «Preventa»/);
  assert.match(realText(copy.welcome(ctx, 'Ana')), /Inicio: martes, 1 de diciembre de 2026/);
  assert.match(realText(copy.orderLink(ORDER)), /Cómo pagar: https:\/\/crm\.example\.test\/\?pay=1/);
  assert.equal(realText(copy.paymentMethods), copy.REAL_PAYMENT_METHODS);
  assert.doesNotMatch(copy.REAL_PAYMENT_METHODS, /tarjeta|OXXO/i, 'en modo real no se ofrecen métodos simulados');
  // un curso real que se llama «laboratorio» o habla de práctica simulada no pierde su nombre
  assert.equal(
    realText('Bioseguridad en el laboratorio · práctica simulada con casos'),
    'Bioseguridad en el laboratorio · práctica simulada con casos',
  );
  // y el laboratorio no cambia: los textos siguen diciendo que es una prueba
  assert.match(copy.welcome(ctx, 'Ana'), /Chat de prueba: los precios y las fechas son de ejemplo\./);
});

// Recorrido de los archivos que arman mensajes para el cliente: cada cadena con palabras de laboratorio debe quedar limpia
// en modo real, salvo las que nunca llegan a un cliente por un mensaje (anotadas con su motivo).
const CUSTOMER_FILES = [
  'server/reply-copy.mjs',
  'server/replies.mjs',
  'server/payments.mjs',
  'server/catalogue.mjs',
  'server/catalogue-schema.mjs',
  'server/replies-schema.mjs',
  'server/content.mjs',
  'server/content-schema.mjs',
  'server/certificates.mjs',
  'server/surveys.mjs',
  'server/coordination.mjs',
  'server/flows.mjs',
  'server/flows-schema.mjs',
  'server/quickreplies.mjs',
  'server/scheduled.mjs',
  'server/appointments.mjs',
  'server/whatsapp.mjs',
  'server/campaigns.mjs',
  'server/service-hours.mjs',
];
const NOT_FOR_CUSTOMERS = [
  ['simulada', 'estado interno de la prelectura del comprobante (lo ve el equipo)'],
  ['no acepta pagos del proveedor simulado', 'resultado de un webhook en la bitácora de conectores'],
  ['Cliente de prueba', 'nombre de ejemplo en la vista previa de una plantilla (lo ve el equipo)'],
  [
    'meet.simulado',
    'enlace del calendario simulado: en una marca real no se genera ni sale en el recordatorio (real-mode-surfaces)',
  ],
];
test('recorrido de las cadenas de los archivos que hablan con el cliente', async () => {
  const left = [];
  for (const file of CUSTOMER_FILES) {
    const source = (await readFile(file, 'utf8'))
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
    for (const literal of source.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || []) {
      const s = literal
        .slice(1, -1)
        .replace(/\$\{[^}]*\}/g, 'X')
        .replace(/\\n/g, '\n');
      if (!LAB.test(s) || !LAB.test(realText(s))) continue;
      if (!NOT_FOR_CUSTOMERS.some(([needle]) => s.includes(needle))) left.push(file + ': ' + s.slice(0, 120));
    }
  }
  assert.deepEqual(left, [], 'cadenas que seguirían diciendo «prueba» a un cliente real');
});

test('migración real-mode/0001: sobre una base ya publicada, todas las marcas quedan en laboratorio', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-modo-real-mig-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== MIGRATION)) });
  const brands = db.prepare('SELECT id FROM brands ORDER BY id').all();
  assert.ok(brands.length >= 2);
  assert.equal(isRealBrand(db, 'globalvet'), false, 'sin la tabla, la marca sigue en laboratorio');
  assert.deepEqual(migrate(db, { backup: false }).applied, [MIGRATION]);
  assertSchemaCurrent(db);
  assert.equal(db.prepare('SELECT count(*) n FROM brand_real_mode').get().n, 0);
  for (const { id } of brands) assert.equal(isRealBrand(db, id), false);
  assert.equal(forBrand(db, 'globalvet', copy.price(ctx)), copy.price(ctx), 'apagado: el texto no cambia');
  assert.throws(() => db.prepare("INSERT INTO brand_real_mode(brand_id,enabled) VALUES('globalvet',2)").run(), /CHECK/);
  db.prepare("INSERT INTO brand_real_mode(brand_id,enabled,revision) VALUES('globalvet',1,1)").run();
  assert.equal(isRealBrand(db, 'globalvet'), true);
  assert.equal(isRealBrand(db, 'odonteck'), false);
  assert.doesNotMatch(forBrand(db, 'globalvet', copy.price(ctx)), LAB_WORDING);
  assert.deepEqual(migrate(db, { backup: false }).applied, [], 'una sola vez');
});

test('modo real de punta a punta: interruptor, respuestas, página de pago, pago registrado por el equipo y otra marca en laboratorio', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-modo-real-'));
  const code = randomUUID();
  const server = await startServer({
    dir,
    env: { ADMIN_INVITE_CODE: code, CONNECTOR_WEBHOOK_SECRET: 'secreto-ensayo' },
  });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const { origin } = server;
  const admin = await registerAdmin(origin, code);
  const register = async (username, name) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  const ana = await register('ana', 'Ana Ruiz');
  const luis = await register('luis', 'Luis Mora');
  const agent = await register('asesor-gv', 'Asesor GlobalVet');
  {
    const id = db.prepare("SELECT id FROM users WHERE username='asesor-gv'").get().id;
    db.prepare("UPDATE users SET role='agent' WHERE id=?").run(id);
    db.prepare("INSERT INTO brand_members(user_id,brand_id) VALUES(?,'globalvet')").run(id);
  }
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  for (const brand of ['globalvet', 'odonteck'])
    await call(origin, '/api/payments/brands/' + brand, {
      cookie: admin,
      method: 'PATCH',
      body: { enabled: true, linkHours: 48, expectedRevision: 0 },
    });
  const sim = async (brandId, text) =>
    (await call(origin, '/api/replies/test', { cookie: admin, body: { brandId, text } })).result.reply;
  const PHRASES = [
    'Hola',
    '¿Cuánto cuesta?',
    '¿Qué temas incluye?',
    '¿Cuándo empieza?',
    '¿Cuáles son las formas de pago?',
    'Quiero inscribirme',
    'Está muy caro',
    '¿Quedan lugares?',
    '¿Qué otros cursos tienen?',
    '¿Eres un bot?',
    'gracias',
    'ayuda',
    '¿Qué temas incluye y cuánto cuesta?',
    '¿Me dan un certificado con validez?',
    '¿dónde me estaciono si voy?',
    'quiero un reembolso',
  ];

  // ---- apagado: todo como hoy (la marca dice que es una prueba y la página ofrece los métodos simulados)
  const before = await call(origin, '/api/real-mode', { cookie: admin });
  const gv0 = before.brands.find(b => b.brandId === 'globalvet');
  assert.equal(gv0.enabled, false);
  assert.equal(gv0.revision, 0);
  assert.ok(gv0.missing.includes('instrucciones de pago'));
  assert.ok(gv0.missing.some(m => /WhatsApp real/.test(m)));
  assert.match(await sim('globalvet', '¿Cuánto cuesta?'), /Precio de ejemplo: este es un chat de prueba/);

  // ---- el interruptor: sólo administración, con revisión y confirmación
  const patch = (cookie, body, expected = 200) =>
    call(origin, '/api/real-mode/brands/globalvet', { cookie, method: 'PATCH', body, expected });
  await call(origin, '/api/real-mode', { cookie: ana, expected: 403 });
  await patch(ana, { enabled: true, expectedRevision: 0, confirm: true }, 403);
  await patch(agent, { enabled: true, expectedRevision: 0, confirm: true }, 403);
  await patch(admin, { enabled: true, confirm: true }, 409);
  await patch(admin, { enabled: true, expectedRevision: 5, confirm: true }, 409);
  assert.equal((await patch(admin, { enabled: true, expectedRevision: 0 }, 400)).code, 'confirm_required');
  await patch(admin, { paymentInstructions: 'Pago de prueba con tarjeta', expectedRevision: 0 }, 400);
  await call(origin, '/api/real-mode/brands/no-existe', {
    cookie: admin,
    method: 'PATCH',
    body: { enabled: true, expectedRevision: 0, confirm: true },
    expected: 404,
  });
  const ref = randomUUID();
  const on = (await patch(admin, { enabled: true, expectedRevision: 0, confirm: true, clientRef: ref })).brand;
  assert.equal(on.enabled, true);
  assert.equal(on.revision, 1);
  assert.equal(on.updatedByName, 'Administración');
  assert.equal(
    (await patch(admin, { enabled: true, expectedRevision: 0, confirm: true, clientRef: ref })).brand.revision,
    1,
    'un reintento con el mismo clientRef no repite el cambio',
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM audit WHERE action='real_mode.on' AND entity_id='globalvet'").get().n,
    1,
  );
  assert.equal(isRealBrand(db, 'globalvet'), true);
  assert.equal(isRealBrand(db, 'odonteck'), false);

  // ---- respuestas del asistente: ninguna dice prueba en la marca real; la otra marca sigue igual
  for (const text of PHRASES) {
    clean(await sim('globalvet', text), 'GlobalVet en modo real · «' + text + '»');
    const other = await sim('odonteck', text);
    assert.equal(typeof other, 'string');
  }
  assert.match(await sim('odonteck', '¿Cuánto cuesta?'), /Precio de ejemplo: este es un chat de prueba/);
  assert.match(await sim('globalvet', '¿Cuánto cuesta?'), /es de \$449\.00 MXN\./, 'el precio sale del catálogo');

  // ---- conversación real: bienvenida, preguntas e inscripción con pedido; todos los mensajes del sistema, limpios
  const conv = (
    await call(origin, '/api/conversations', { cookie: ana, body: { courseId: 'aves', channel: 'whatsapp' } })
  ).conversation;
  const auto = () =>
    db
      .prepare("SELECT text FROM messages WHERE conversation_id=? AND sender_kind!='customer' ORDER BY seq")
      .all(conv.id)
      .map(m => m.text);
  for (const text of ['Hola', '¿Cuánto cuesta?', '¿Cuáles son las formas de pago?', 'Quiero inscribirme']) {
    const n = auto().length;
    await call(origin, '/api/conversations/' + conv.id + '/messages', {
      cookie: ana,
      body: { text, clientRef: randomUUID() },
      expected: 201,
    });
    await until(() => auto().length > n, 'respuesta a «' + text + '»', { logs: server.logs });
  }
  for (const m of auto()) clean(m, 'mensaje del sistema en la conversación real');
  const order = db.prepare('SELECT * FROM orders WHERE conversation_id=?').get(conv.id);
  assert.equal(order.status, 'pending');
  assert.match(auto().at(-1), /Cómo pagar: .*\/\?pay=/);

  // ---- página de pago: sin métodos simulados; sin instrucciones dice que un asesor dará los datos
  let view = (await call(origin, '/api/payments/orders/' + order.id + '/customer', { cookie: ana })).order;
  assert.equal(view.realMode, true);
  assert.deepEqual(view.methods, []);
  assert.equal(view.paymentInstructions, null);
  await patch(admin, { paymentInstructions: 'Transferencia a la cuenta 0000 de la marca.', expectedRevision: 1 });
  view = (await call(origin, '/api/payments/orders/' + order.id + '/customer', { cookie: ana })).order;
  assert.equal(view.paymentInstructions, 'Transferencia a la cuenta 0000 de la marca.');

  // ---- forzar un método simulado: error claro y el pedido sigue pendiente (también por el webhook de ensayo)
  for (const body of [{ method: 'card' }, { method: 'oxxo' }, { method: 'card', outcome: 'approved' }]) {
    const r = await call(origin, '/api/payments/orders/' + order.id + '/pay', { cookie: ana, body, expected: 409 });
    assert.equal(r.code, 'real_mode');
    assert.match(r.error, /no acepta pagos simulados/);
  }
  const hook = await call(origin, '/api/connectors/test', {
    cookie: admin,
    body: { kind: 'payment', order: order.reference, type: 'payment.succeeded', method: 'card' },
  });
  assert.match(hook.response.results[0].result, /^rechazado: la marca atiende clientes reales/);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'pending');
  assert.equal(db.prepare('SELECT count(*) n FROM enrollments WHERE order_id=?').get(order.id).n, 0);

  // ---- materiales del catálogo enviados por el equipo: ni «precio de ejemplo» ni «laboratorio»
  for (const kind of ['price', 'flyer', 'syllabus'])
    await call(origin, '/api/conversations/' + conv.id + '/template', {
      cookie: admin,
      body: { kind, clientRef: randomUUID() },
    });
  // las plantillas aprobadas de la marca (las de demostración dicen «Precio de ejemplo» y «En este laboratorio…»)
  const templates = db
    .prepare(
      "SELECT id FROM content_templates WHERE brand_id='globalvet' AND status='approved' AND (course_id IS NULL OR course_id='aves') AND channel IN ('all','whatsapp') AND edition_id IS NULL",
    )
    .all();
  assert.ok(templates.length >= 5);
  for (const tpl of templates)
    await call(origin, '/api/conversations/' + conv.id + '/template', {
      cookie: admin,
      body: { kind: 'price', templateId: tpl.id, clientRef: randomUUID() },
    });
  for (const m of auto()) clean(m, 'material del catálogo en modo real');
  assert.ok(
    (await call(origin, '/api/real-mode', { cookie: admin })).brands
      .find(b => b.brandId === 'globalvet')
      .labTexts.some(x => x.kind === 'Plantilla'),
    'Preparar marca señala las plantillas propias que todavía avisan de la prueba',
  );
  assert.ok(
    auto().some(m => /^Precio: \$379\.00 MXN\./.test(m)),
    'el material de precio dice «Precio:» con el del catálogo',
  );

  // ---- marcar pagado: sólo con permiso, con cómo y referencia, una sola vez
  const paid = (cookie, body, expected = 200) =>
    call(origin, '/api/real-mode/orders/' + order.id + '/paid', { cookie, body, expected });
  const revision = db.prepare('SELECT revision FROM orders WHERE id=?').get(order.id).revision;
  await paid(ana, { how: 'transfer', reference: 'OP-1234', expectedRevision: revision }, 403);
  await paid(agent, { how: 'transfer', reference: 'OP-1234', expectedRevision: revision }, 403);
  await paid(admin, { how: 'bitcoin', reference: 'OP-1234', expectedRevision: revision }, 400);
  await paid(admin, { how: 'deposit', reference: '', expectedRevision: revision }, 400);
  await paid(admin, { how: 'deposit', reference: 'OP-1234', expectedRevision: revision + 7 }, 409);
  const payRef = randomUUID();
  const done = (
    await paid(admin, {
      how: 'deposit',
      reference: 'OP-1234',
      note: 'Sucursal centro',
      expectedRevision: revision,
      clientRef: payRef,
    })
  ).order;
  assert.equal(done.status, 'paid');
  assert.equal(done.confirmed_by, adminId);
  assert.equal(done.method, 'transfer');
  assert.equal(
    (await paid(admin, { how: 'deposit', reference: 'OP-1234', expectedRevision: revision, clientRef: payRef })).order
      .id,
    order.id,
    'un reintento no registra dos veces',
  );
  await paid(admin, { how: 'deposit', reference: 'OP-1234', expectedRevision: done.revision }, 409);
  const manual = db
    .prepare("SELECT details,actor_id FROM payment_events WHERE order_id=? AND kind='manual.recorded'")
    .all(order.id);
  assert.equal(manual.length, 1);
  assert.equal(manual[0].actor_id, adminId);
  assert.deepEqual((({ how, reference, comment }) => ({ how, reference, comment }))(JSON.parse(manual[0].details)), {
    how: 'deposit',
    reference: 'OP-1234',
    comment: 'Sucursal centro',
  });
  assert.equal(db.prepare('SELECT count(*) n FROM enrollments WHERE order_id=?').get(order.id).n, 1);
  assert.equal(
    db.prepare("SELECT count(*) n FROM audit WHERE action='payment.order.mark_paid' AND entity_id=?").get(order.id).n,
    1,
  );
  for (const m of auto()) clean(m, 'confirmación del pago en modo real');
  assert.match(auto().at(-1), /Pago confirmado/);
  view = (await call(origin, '/api/payments/orders/' + order.id + '/customer', { cookie: ana })).order;
  assert.equal(view.status, 'paid');

  // ---- la otra marca sigue en laboratorio y no se mezcla
  const lab = (
    await call(origin, '/api/conversations', { cookie: luis, body: { courseId: 'odontologia', channel: 'whatsapp' } })
  ).conversation;
  const labOrder = (
    await call(origin, '/api/conversations/' + lab.id + '/orders', { cookie: admin, body: {}, expected: 201 })
  ).order;
  const labLink = db
    .prepare("SELECT text FROM messages WHERE conversation_id=? AND sender_kind='agent' ORDER BY seq DESC")
    .get(lab.id).text;
  assert.match(labLink, /Pago de prueba: no se cobra nada real\./);
  const labView = (await call(origin, '/api/payments/orders/' + labOrder.id + '/customer', { cookie: luis })).order;
  assert.equal(labView.realMode, false);
  assert.deepEqual(
    labView.methods.map(m => m.id),
    ['card', 'oxxo', 'transfer'],
  );
  assert.equal(
    (
      await call(origin, '/api/real-mode/orders/' + labOrder.id + '/paid', {
        cookie: admin,
        body: { how: 'transfer', reference: 'OP-9', expectedRevision: labOrder.revision },
        expected: 409,
      })
    ).code,
    'not_real_mode',
  );
  assert.equal(
    (await call(origin, '/api/payments/orders/' + labOrder.id + '/pay', { cookie: luis, body: { method: 'card' } }))
      .order.status,
    'paid',
    'en el laboratorio el pago simulado funciona como siempre',
  );

  // ---- Preparar marca muestra el estado y lo que falta
  const steps = async brand =>
    (await call(origin, '/api/readiness', { cookie: admin })).brands.find(b => b.id === brand).steps;
  const gvStep = (await steps('globalvet')).find(s => s.id === 'real-mode');
  assert.equal(gvStep.done, false);
  assert.match(gvStep.detail, /^Encendido, pero falta: .*WhatsApp real/);
  assert.doesNotMatch(gvStep.detail, /instrucciones de pago/);
  assert.match((await steps('odonteck')).find(s => s.id === 'real-mode').detail, /^Apagado \(laboratorio\)/);

  // ---- apagar exige confirmación y devuelve la marca al laboratorio
  await patch(admin, { enabled: false, expectedRevision: 2 }, 400);
  assert.equal((await patch(admin, { enabled: false, expectedRevision: 2, confirm: true })).brand.enabled, false);
  assert.match(await sim('globalvet', '¿Cuánto cuesta?'), /Precio de ejemplo: este es un chat de prueba/);
  assertSchemaCurrent(db);
});
