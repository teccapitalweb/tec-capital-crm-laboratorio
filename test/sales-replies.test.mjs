// Respuestas de venta y posventa (docs/PLAN_RESPUESTAS_DE_VENTA.md): el pago partido en lo que de verdad se pregunta, los
// datos para la constancia, «Sí, me interesa» fuera de la ficha, reglas que no gastan IA, el conocimiento chico que ya no
// se manda completo, recomendar con el catálogo, reenviar accesos y el acuse mientras se espera a una persona. Cada caso
// lleva al lado uno vecino que NO debe cambiar. Frases y cursos inventados (veterinaria ficticia), sin datos de nadie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from '../server/ai-provider.mjs';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import {
  certData,
  certDataSignal,
  claimsPaid,
  isAccess,
  isValidity,
  paymentKind,
  recommend,
  weakCertData,
  wantsCourses,
} from '../server/lib/sales-replies.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';

const plain = raw => normalize(raw).replace(/\s+/g, ' ').trim();
const PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
]).toString('base64');

test('lectura fina: pago, datos para la constancia, accesos, validez y recomendación', () => {
  const kinds = {
    'como puedo pagar': 'methods',
    'aceptan tarjeta?': 'methods',
    'cuanto tiempo tengo para pagar': 'methods',
    'listo ya hice la transferencia': 'paid',
    'ya deposite, aqui el comprobante': 'paid',
    'ya pague los dos lugares': 'paid',
    'mañana hago el deposito': 'later',
    'en la quincena pago, me lo apartan?': 'later',
    'ahorita le mando el pago': 'later',
    'ya pudieron verificar mi pago?': 'status',
    'mande mi comprobante desde ayer y nada': 'status',
    'dan factura?': 'invoice',
    'el precio incluye iva?': 'invoice',
    'tienen meses sin intereses?': 'installments',
    'lo puedo pagar en 2 partes?': 'installments',
    'puedo pagar el de 2 personas en un solo deposito?': 'group',
    'me pasa el numero de cuenta': 'account',
    'el pago lo hago a nombre de quien': 'account',
  };
  for (const [text, kind] of Object.entries(kinds)) assert.equal(paymentKind(plain(text)), kind, text);
  assert.ok(claimsPaid(plain('ya hice el pago')));
  assert.ok(!claimsPaid(plain('como hago el pago')), 'preguntar cómo pagar no es avisar que ya pagó');

  assert.deepEqual(certData('mi nombre completo para la constancia es ANA EJEMPLO PRUEBA'), {
    name: 'ANA EJEMPLO PRUEBA',
    email: '',
    phone: '',
  });
  assert.deepEqual(certData('mi correo es ana@correo.test y mi cel 55 1234 5678'), {
    name: '',
    email: 'ana@correo.test',
    phone: '5512345678',
  });
  const strong = t => certDataSignal(plain(t), t);
  assert.ok(strong('Mi nombre es María José Ejemplo, para la constancia'));
  assert.ok(strong('les paso mi correo y mi cel para el registro'), 'ofrecer los datos también cuenta');
  assert.ok(strong('el nombre va con mayusculas?'));
  assert.ok(!strong('necesito factura a nombre de la clinica'), 'una factura no es la constancia');
  assert.ok(!strong('¿tiene constancia?'), 'preguntar por la constancia no son datos');
  assert.ok(weakCertData(plain('ANA EJEMPLO PRUEBA'), 'ANA EJEMPLO PRUEBA'));
  assert.ok(!weakCertData(plain('mi nombre es Ana, quiero informes'), 'mi nombre es Ana, quiero informes'));

  for (const t of [
    'me pasan el link de la clase de hoy',
    'todavia no me agregan al grupo',
    'no me llegó el enlace, ¿dónde entro a la clase?',
    'despues del pago como ingreso a las clases',
  ])
    assert.ok(isAccess(plain(t)), t);
  assert.ok(!isAccess(plain('donde me conecto')), '«¿dónde me conecto?» antes de pagar sigue siendo modalidad');

  assert.ok(isValidity(plain('el certificado tiene validez oficial?')));
  assert.ok(isValidity(plain('es valido ante la sep?')));
  assert.ok(isValidity(plain('tiene valor curricular')));
  assert.ok(!isValidity(plain('¿Me dan un certificado con validez?')), 'la pregunta general sigue con su respuesta');
  assert.ok(!isValidity(plain('tienen pagina oficial?')), '«oficial» sin certificado no es validez');

  const list = [
    { id: 'a', title: 'Bovinos de leche: manejo sanitario', syllabus: 'Mastitis\nCalendario de vacunación' },
    { id: 'b', title: 'Reptiles en cautiverio', syllabus: 'Tortugas e iguanas' },
    { id: 'c', title: 'Cirugía básica en perros y gatos', syllabus: 'Esterilización' },
  ];
  assert.deepEqual(
    recommend('tengo un rancho con vacas, cual me conviene', list).map(k => k.id),
    ['a'],
  );
  assert.deepEqual(
    recommend('tienen algo de exoticos?', list).map(k => k.id),
    ['b'],
  );
  assert.deepEqual(
    recommend('¿tienen algo de esterilización?', list).map(k => k.id),
    ['c'],
  );
  assert.deepEqual(recommend('¿cuál me recomiendas?', list), [], 'sin especie ni tema no se adivina');
  assert.ok(wantsCourses(plain('¿cuál me recomiendas?')));
  assert.ok(wantsCourses(plain('trabajo en una clinica de perros')));
  assert.ok(
    !wantsCourses(plain('¿Sirve si trabajo en otro estado de la república y viajo mucho?')),
    'decir dónde trabaja no es pedir una recomendación',
  );
});

test('migración replies/0001: tabla propia sobre una base ya publicada', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-ventas-mig-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const name = 'replies/0001-certificate-details';
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== name)) });
  assert.deepEqual(migrate(db, { backup: false }).applied, [name]);
  assertSchemaCurrent(db);
  assert.equal(db.prepare('SELECT count(*) n FROM certificate_details').get().n, 0);
  assert.deepEqual(migrate(db, { backup: false }).applied, [], 'una sola vez');
});

test('respuestas de venta de punta a punta', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-ventas-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code, AI_PROVIDER: '' } });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { origin } = server;
  const admin = await registerAdmin(origin, code);
  const register = async (username, name) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  await call(origin, '/api/payments/brands/globalvet', {
    cookie: admin,
    method: 'PATCH',
    body: { enabled: true, linkHours: 48, expectedRevision: 0 },
  });
  const day = 24 * 3600e3,
    edition = db.prepare("SELECT id FROM editions WHERE course_id='aves' AND status='published' LIMIT 1").get().id;
  db.prepare('UPDATE editions SET starts_at=?,ends_at=?,timezone=?,capacity=30,available_seats=NULL WHERE id=?').run(
    Date.now() + 10 * day,
    Date.now() + 15 * day,
    'America/Mexico_City',
    edition,
  );
  const sim = async (text, courseId = 'aves') =>
    (await call(origin, '/api/replies/test', { cookie: admin, body: { brandId: 'globalvet', text, courseId } })).result;

  // ---- 1. el pago partido: antes todo recibía «Puedes pagar con…»
  const how = await sim('como puedo pagar');
  assert.equal(how.intent, 'payment');
  assert.equal(how.handoff, false, 'la pregunta de siempre sigue igual');
  const paid = await sim('listo ya hice la transferencia');
  assert.equal(paid.handoff, true);
  assert.match(paid.reply, /revisará tu pago/);
  assert.match(paid.reply, /no confirmamos pagos de forma automática/);
  assert.doesNotMatch(paid.reply, /Puedes pagar con/);
  const later = await sim('mañana hago el deposito');
  assert.equal(later.handoff, false, 'pagar después no pasa a una persona');
  assert.match(later.reply, /sin prisa/);
  assert.doesNotMatch(later.reply, /Puedes pagar con/);
  const hold = await sim('en la quincena pago, me lo apartan?');
  assert.match(hold.reply, /El lugar queda asegurado cuando se confirma el pago/);
  assert.doesNotMatch(hold.reply, /te (lo )?aparto|apartado para ti/i, 'no promete apartar sin pago');
  const status = await sim('ya pudieron verificar mi pago?');
  assert.equal(status.handoff, true);
  assert.match(status.reply, /No encuentro un pedido en este chat/);
  for (const [text, re] of [
    ['dan factura?', /factura/],
    ['tienen meses sin intereses?', /en partes o a meses/],
    ['puedo pagar el de 2 personas en un solo deposito?', /varias personas/],
    ['me pasa el numero de cuenta', /datos para depositar o transferir/],
  ]) {
    const r = await sim(text);
    assert.equal(r.intent, 'payment', text);
    assert.equal(r.handoff, true, text + ': sin respuesta aprobada, una persona');
    assert.match(r.reply, re, text);
    assert.doesNotMatch(r.reply, /Puedes pagar con/, text);
  }

  // ---- 4. reglas que no gastan IA
  const intents = {
    'buen dia': 'greeting',
    'cual es el proceso de inscripcion?': 'enroll',
    'si quiero apartar mi lugar': 'enroll',
    'lo tomo': 'enroll',
    'cuanto cuesta la inscripcion?': 'price', // vecino: preguntar el costo no crea un pedido
    'me puede llamar una persona?': 'human',
    'quedan espacios?': 'seats',
    'manejan diplomados?': 'courses', // antes «diploma» → certificado
    'no tengo tiempo en esas fechas': 'objection',
    '¿a qué hora es? salgo tarde de la clínica': 'schedule', // vecino: pregunta la hora
    'busco trabajo, tienen vacante?': 'help',
    '¿hay cupo?': 'seats',
  };
  for (const [text, intent] of Object.entries(intents)) assert.equal((await sim(text)).intent, intent, text);
  const deadline = await sim('hasta que dia me puedo registrar');
  assert.equal(deadline.intent, 'schedule');
  assert.equal(deadline.stage, null, 'preguntar el plazo no crea un pedido');
  assert.match(deadline.reply, /Las inscripciones siguen abiertas/);
  for (const text of ['el certificado tiene validez oficial?', 'es valido ante la sep?', 'sirve para mi cedula?']) {
    const r = await sim(text);
    assert.equal(r.intent, 'certificate', text);
    assert.doesNotMatch(r.reply, /^Sí/, text + ': nunca «Sí» a una validez oficial');
    assert.match(r.reply, /no te puedo confirmar nada por aquí/, text);
    assert.match(r.reply, /folio y un código QR/, text);
  }
  const cert = await sim('¿Entregan certificado?');
  assert.ok(
    cert.sources.some(s => s.type === 'knowledge'),
    'vecino: la pregunta general sigue con su respuesta aprobada',
  );
  assert.match((await sim('quedan espacios?')).reply, /el grupo es de 30 lugares/);
  db.prepare('UPDATE editions SET available_seats=3 WHERE id=?').run(edition);
  assert.match(
    (await sim('quedan espacios?')).reply,
    /quedan 3 lugares/,
    'vecino: con lugares contados se dice la cifra',
  );
  db.prepare('UPDATE editions SET available_seats=NULL WHERE id=?').run(edition);
  const length = await sim('cuanto dura el curso');
  assert.equal(length.intent, 'duration');
  assert.match(length.reply, /• Termina: /);
  assert.doesNotMatch(length.reply, /qué edición te interesa/, 'ya sabe la apertura de la conversación');
  assert.match((await sim('busco trabajo, tienen vacante?')).reply, /no manejo vacantes/);

  // ---- 6. recomendar sin IA con el catálogo de la marca
  const now = Date.now();
  for (const [id, title, syllabus, price] of [
    ['bovinos-ficticio', 'Bovinos de leche: manejo sanitario', 'Mastitis\nCalendario de vacunación', 48000],
    ['reptiles-ficticio', 'Reptiles en cautiverio', 'Tortugas e iguanas\nTerrarios', 52000],
  ]) {
    db.prepare(
      "INSERT INTO courses(id,brand_id,title,price_cents,date_label,syllabus,welcome,updated_at) VALUES(?,'globalvet',?,?,'',?,'Hola {{nombre}}',?)",
    ).run(id, title, price, syllabus, now);
    db.prepare(
      "INSERT INTO editions(id,brand_id,course_id,name,starts_at,ends_at,timezone,modality,price_cents,currency,status,created_at,updated_at) VALUES(?,'globalvet',?,'Edición ficticia',?,?,'America/Mexico_City','online',?,'MXN','published',?,?)",
    ).run(id + '-e1', id, now + 20 * day, now + 25 * day, price, now, now);
  }
  const cows = await sim('tengo un rancho con vacas, cual me conviene');
  assert.equal(cows.intent, 'courses');
  assert.match(cows.reply, /Bovinos de leche: manejo sanitario — inicia .+ · \$480\.00 MXN/);
  assert.doesNotMatch(cows.reply, /Reptiles en cautiverio/);
  assert.equal(cows.provider.used, false);
  const exotic = await sim('¿tienen algo de exóticos?');
  assert.match(exotic.reply, /Reptiles en cautiverio/);
  const open = await sim('¿cuál me recomiendas?');
  assert.match(open.reply, /¿Con qué especie o tema trabajas/);
  assert.doesNotMatch(open.reply, /Bovinos|Reptiles/, 'sin tema no suelta la lista completa');
  assert.match((await sim('¿qué otros cursos tienen?')).reply, /también tenemos/, 'vecino: la lista de siempre');

  // ---- 5. con pocas respuestas aprobadas, lo que no se parece a nada ya no va a la IA
  const rs = (await call(origin, '/api/replies/settings', { cookie: admin })).settings.find(
    x => x.brand_id === 'globalvet',
  );
  await call(origin, '/api/replies/brands/globalvet', {
    cookie: admin,
    method: 'PATCH',
    body: { mode: 'autonomous', providerEnabled: true, expectedRevision: rs.revision },
  });
  assert.equal(
    db.prepare("SELECT count(*) n FROM knowledge_entries WHERE brand_id='globalvet' AND status='approved'").get().n <=
      6,
    true,
  );
  const unrelated = await sim('¿me recomiendas una película para el fin?');
  assert.equal(unrelated.provider.used, false, 'nada se parece: no se llama a la IA');
  assert.deepEqual(unrelated.context.knowledge, []);
  const related = await sim('¿necesito computadora o laptop especial?');
  assert.equal(related.intent, 'unknown');
  assert.equal(related.provider.used, true, 'vecino: lo que sí se parece sigue llegando a la IA');
  assert.ok(related.context.knowledge.length >= 1 && related.context.knowledge.length < 6, 'sólo lo parecido');
  await call(origin, '/api/replies/brands/globalvet', {
    cookie: admin,
    method: 'PATCH',
    body: { mode: 'templates', providerEnabled: false, expectedRevision: rs.revision + 1 },
  });

  // una respuesta aprobada que de verdad habla de factura sí contesta (y no pasa a una persona)
  const entry = (
    await call(origin, '/api/replies/knowledge', {
      cookie: admin,
      body: {
        brandId: 'globalvet',
        topic: 'payment',
        question: '¿Dan factura?',
        answer: 'Sí emitimos factura electrónica: pídela al equipo con tus datos fiscales antes de pagar.',
        variants: ['facturan', 'necesito factura'],
      },
      expected: 201,
    })
  ).entry;
  await call(origin, '/api/replies/knowledge/' + entry.id + '/approve', {
    cookie: admin,
    body: { expectedRevision: entry.revision },
  });
  const invoice = await sim('dan factura?');
  assert.equal(invoice.handoff, false);
  assert.ok(invoice.sources.some(s => s.type === 'knowledge' && s.id === entry.id));

  // ---- conversación real: «Sí, me interesa», pagar después, estado, datos para la constancia
  const texts = id =>
    db
      .prepare("SELECT text,client_ref FROM messages WHERE conversation_id=? AND sender_kind='automation' ORDER BY seq")
      .all(id);
  const chat = async (cookie, courseId = 'aves') => {
    const id = (await call(origin, '/api/conversations', { cookie, body: { courseId, channel: 'whatsapp' } }))
      .conversation.id;
    const post = (text, extra = {}) =>
      call(origin, '/api/conversations/' + id + '/messages', {
        cookie,
        body: { text, clientRef: randomUUID(), ...extra },
        expected: 201,
      });
    const say = async text => {
      const n = db.prepare('SELECT count(*) n FROM reply_log WHERE conversation_id=?').get(id).n;
      await post(text);
      await until(
        () => db.prepare('SELECT count(*) n FROM reply_log WHERE conversation_id=?').get(id).n > n,
        'respuesta a «' + text + '»',
        { logs: server.logs },
      );
      const log = db
        .prepare('SELECT * FROM reply_log WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
        .get(id);
      return { log, text: texts(id).at(-1)?.text || '' };
    };
    const orders = () => db.prepare('SELECT * FROM orders WHERE conversation_id=? ORDER BY created_at').all(id);
    const state = () => ({ ...db.prepare('SELECT bot_enabled,status FROM conversations WHERE id=?').get(id) });
    return { id, post, say, orders, state };
  };
  const ana = await chat(await register('ana', 'Ana Ejemplo'));
  await ana.say('Hola');
  const afterCard = await ana.say('si me interesa');
  assert.equal(afterCard.log.intent, 'greeting', 'justo después de la ficha sigue como siempre');
  assert.equal(ana.orders().length, 0);
  assert.equal((await ana.say('¿Entregan certificado?')).log.intent, 'certificate');
  const yes = await ana.say('Sí, me interesa');
  assert.equal(yes.log.intent, 'enroll', '«Sí, me interesa» fuera de la ficha sigue a la inscripción');
  assert.equal(ana.orders().length, 1);
  const ref = ana.orders()[0].reference;
  const pay = await ana.say('en la quincena pago, me lo apartan?');
  assert.ok(pay.text.includes('Tu pedido ' + ref + ' sigue vigente hasta el '), pay.text);
  assert.match(pay.text, /El lugar queda asegurado cuando se confirma el pago/);
  assert.equal(ana.orders().length, 1, 'no se crea otro pedido');
  const check = await ana.say('ya pudieron verificar mi pago?');
  assert.match(check.text, /Todavía no veo un comprobante en tu pedido/);
  assert.equal(check.log.action, 'replied');
  assert.deepEqual(ana.state(), { bot_enabled: 1, status: 'open' });
  const data = await ana.say('mi nombre completo para la constancia es ANA EJEMPLO PRUEBA');
  assert.equal(data.log.intent, 'cert_data');
  assert.match(data.text, /Anoté tu nombre «ANA EJEMPLO PRUEBA» para tu certificado/);
  assert.doesNotMatch(data.text, /Al terminar el curso|Ya tengo listo tu pedido/);
  assert.equal(ana.orders().length, 1, 'los datos no crean otro pedido');
  const mail = await ana.say('ana.ejemplo@correo.test 55 1234 5678');
  assert.equal(mail.log.intent, 'cert_data', 'con un pedido, un correo suelto son datos para la constancia');
  assert.deepEqual(
    { ...db.prepare('SELECT full_name,email,phone FROM certificate_details WHERE conversation_id=?').get(ana.id) },
    { full_name: 'ANA EJEMPLO PRUEBA', email: 'ana.ejemplo@correo.test', phone: '5512345678' },
  );
  const luis = await chat(await register('luis', 'Luis Ejemplo'));
  await luis.say('Hola');
  assert.notEqual(
    (await luis.say('luis.ejemplo@correo.test')).log.intent,
    'cert_data',
    'vecino: sin pedido, un correo suelto no se guarda como dato de constancia',
  );

  // ---- 7. posventa: comprobante validado, accesos y reenvío
  const BODY =
    '¡Te damos la bienvenida, {{nombre}}! Ya tienes tu lugar en {{curso}}.\nEnlace de las clases: https://clases.example.test/aves-ficticio';
  await call(origin, '/api/course-access/editions/' + edition, {
    cookie: admin,
    method: 'PUT',
    body: { enabled: true, body: BODY, expectedRevision: 0 },
  });
  await ana.post('', { attachment: { name: 'comprobante.png', type: 'image/png', base64: PNG } });
  const receipt = await until(
    () => db.prepare("SELECT id FROM receipts WHERE conversation_id=? AND status='pending'").get(ana.id),
    'el comprobante por revisar',
  );
  await call(origin, '/api/payments/receipts/' + receipt.id + '/accept', { cookie: admin, body: { note: 'Visto' } });
  await until(
    () => db.prepare("SELECT 1 FROM course_access_deliveries WHERE conversation_id=? AND kind='auto'").get(ana.id),
    'la entrega automática de accesos',
  );
  db.prepare("UPDATE conversations SET bot_enabled=1,status='open',assigned_to=NULL WHERE id=?").run(ana.id); // el chat vuelve con el asistente
  const thanks = await ana.say('gracias!');
  assert.match(thanks.text, /Aquí estoy si necesitas algo más/);
  assert.doesNotMatch(thanks.text, /inscribirte/, 'a quien ya pagó no se le ofrece inscribirse');
  const again = await ana.say('no me llegó el enlace, ¿dónde entro a la clase?');
  assert.equal(again.log.intent, 'access');
  assert.match(again.text, /aquí tienes de nuevo tus accesos/);
  assert.ok(again.text.includes('https://clases.example.test/aves-ficticio'));
  const resent = db
    .prepare("SELECT * FROM course_access_deliveries WHERE conversation_id=? AND kind='manual'")
    .all(ana.id);
  assert.equal(resent.length, 1);
  assert.equal(resent[0].sent_by, null, 'lo reenvió el asistente');
  assert.equal(resent[0].status, 'sent');
  const broken = await ana.say('el link no abre');
  assert.equal(broken.log.action, 'escalated', 'vecino: una falla la revisa una persona');
  const outsider = await chat(await register('eva', 'Eva Ejemplo'));
  await outsider.say('Hola');
  const noEnrollment = await outsider.say('¿dónde entro a la clase? no me llega el link');
  assert.equal(noEnrollment.log.action, 'escalated', 'sin inscripción no hay accesos que reenviar');
  assert.match(noEnrollment.text, /No encuentro una inscripción activa/);

  // el nombre que dio para la constancia es el del certificado
  db.prepare("UPDATE editions SET run_status='running' WHERE id=?").run(edition);
  const session = randomUUID(),
    enrollment = db.prepare('SELECT id FROM enrollments WHERE edition_id=?').get(edition).id;
  db.prepare(
    "INSERT INTO edition_sessions(id,edition_id,brand_id,number,title,starts_at,status,created_at,updated_at) VALUES(?,?,'globalvet',1,'Sesión 1',?,'done',?,?)",
  ).run(session, edition, Date.now() - day, Date.now(), Date.now());
  db.prepare("INSERT INTO attendance(session_id,enrollment_id,status,marked_at) VALUES(?,?,'present',?)").run(
    session,
    enrollment,
    Date.now(),
  );
  const issued = await call(origin, '/api/certificates/editions/' + edition + '/issue', {
    cookie: admin,
    body: { enrollmentIds: [enrollment] },
  });
  assert.equal(
    db.prepare('SELECT holder_name FROM certificates WHERE enrollment_id=?').get(enrollment).holder_name,
    'ANA EJEMPLO PRUEBA',
    JSON.stringify(issued).slice(0, 300),
  );

  // ---- 8. después de pasar a una persona: un acuse por espera, sin retomar la conversación
  const sara = await chat(await register('sara', 'Sara Ejemplo'));
  await sara.say('Hola');
  assert.equal((await sara.say('quiero hablar con un asesor')).log.action, 'escalated');
  const acks = () => texts(sara.id).filter(m => /^wait-ack:/.test(m.client_ref || ''));
  await sara.post('¿ya verificaron mi pago?');
  assert.equal(acks().length, 1);
  assert.match(acks()[0].text, /Ya le avisé al equipo; en cuanto una persona esté disponible te contesta por aquí/);
  await sara.post('nadie me contesta');
  assert.equal(acks().length, 1, 'una sola vez por espera');
  assert.deepEqual(sara.state(), { bot_enabled: 0, status: 'waiting' }, 'el asistente no retoma la conversación');
  await sara.post('mi nombre completo para la constancia es SARA EJEMPLO LUNA');
  assert.equal(
    db.prepare('SELECT full_name FROM certificate_details WHERE conversation_id=?').get(sara.id).full_name,
    'SARA EJEMPLO LUNA',
    'los datos para la constancia se guardan aunque espere a una persona',
  );
  assert.match(texts(sara.id).at(-1).text, /Anoté tu nombre «SARA EJEMPLO LUNA»/);
  await call(origin, '/api/conversations/' + sara.id + '/messages', {
    cookie: admin,
    body: { text: 'Hola, ya te atiendo.', clientRef: randomUUID(), asAgent: true },
    expected: 201,
  });
  const before = texts(sara.id).length;
  await sara.post('gracias, aquí espero');
  assert.equal(texts(sara.id).length, before, 'con una persona a cargo, el asistente no dice nada');
  // vecino: en «Sugerir» el asistente nunca escribe, tampoco el acuse
  const rs2 = (await call(origin, '/api/replies/settings', { cookie: admin })).settings.find(
    x => x.brand_id === 'globalvet',
  );
  await call(origin, '/api/replies/brands/globalvet', {
    cookie: admin,
    method: 'PATCH',
    body: { mode: 'suggest', expectedRevision: rs2.revision },
  });
  const tom = await chat(await register('tom', 'Tom Ejemplo'));
  await tom.say('Hola');
  await tom.post('¿siguen ahí?');
  assert.equal(texts(tom.id).length, 0);
});
