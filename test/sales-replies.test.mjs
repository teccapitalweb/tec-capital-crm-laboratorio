// Respuestas de venta y posventa (docs/PLAN_RESPUESTAS_DE_VENTA.md): el pago partido en lo que de verdad se pregunta, los
// datos para la constancia (una propuesta que confirma el equipo), «Sí, me interesa» fuera de la ficha, reglas que no
// gastan IA, recomendar con el catálogo de la marca, reenviar accesos y una sola respuesta automática mientras se espera a
// una persona. Incluye cada hallazgo de la revisión independiente con su frase exacta y, al lado, un caso vecino que NO
// debe cambiar. Frases y cursos inventados (veterinaria ficticia), sin datos de nadie.
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
  durationFacts,
  isAccess,
  isValidity,
  notCovered,
  paymentKind,
  recommend,
  weakCertData,
  wantsCourses,
} from '../server/lib/sales-replies.mjs';
import { ASSISTANT_RESENDS_PER_DAY, assistantResends } from '../server/modules/course-access/module.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';

const plain = raw => normalize(raw).replace(/\s+/g, ' ').trim();
const PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
]).toString('base64');
const REQUIREMENTS = /No se requieren conocimientos previos/;

test('lectura fina: pago, datos para la constancia, accesos, validez y recomendación', () => {
  const kinds = {
    'como puedo pagar': 'methods',
    'aceptan tarjeta?': 'methods',
    'cuanto tiempo tengo para pagar': 'methods',
    'listo ya hice la transferencia': 'paid',
    'ya deposite, aqui el comprobante': 'paid',
    'ya pague los dos lugares': 'paid',
    'ya les mandé la captura': 'paid',
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
  assert.ok(claimsPaid(plain('Ya realicé el pago de mi inscripción')));
  assert.ok(!claimsPaid(plain('como hago el pago')), 'preguntar cómo pagar no es avisar que ya pagó');

  // un nombre sólo con señal explícita (revisión, punto 1)
  assert.equal(certData('mi nombre completo para la constancia es ANA EJEMPLO PRUEBA').name, 'ANA EJEMPLO PRUEBA');
  assert.equal(certData('Nombre para la constancia: María de la Luz Ejemplo').name, 'María de la Luz Ejemplo');
  assert.equal(certData('Luis Ejemplo Mora\nCurso: aves\n5512345678').name, 'Luis Ejemplo Mora', 'ficha de datos');
  for (const t of [
    'HOLA BUENAS TARDES',
    'MUCHAS GRACIAS',
    'LO VEO CON MI ESPOSO',
    'NADIE ME CONTESTA',
    'el deposito lo hice a nombre de Juan Perez Lopez',
    'mi nombre es Ana, quiero informes',
  ])
    assert.equal(certData(t).name, '', t + ': no es un nombre para la constancia');
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
  const weak = t => weakCertData(plain(t), t);
  assert.ok(!weak('ANA EJEMPLO PRUEBA'), 'un texto en mayúsculas ya no es un nombre');
  assert.ok(weak('ana@correo.test'));
  assert.ok(!weak('mi numero es 5512345678 llamenme'), 'pide algo: no es sólo un dato (punto 5)');

  // la posventa no se queda con lo que pide un prospecto (punto 3)
  for (const t of [
    'me pasan el link de la clase de hoy',
    'todavia no me agregan al grupo',
    'no me llegó el enlace, ¿dónde entro a la clase?',
    'despues del pago como ingreso a las clases',
  ])
    assert.ok(isAccess(plain(t)), t);
  for (const t of [
    '¿me pasas el link para pagar?',
    '¿me mandas el link de pago?',
    'no me llegó el enlace de pago',
    '¿me mandan información del curso?',
    '¿me pasas el temario del curso?',
    '¿me pasan los datos del curso?',
    'el curso ya empezó?',
    'donde me conecto',
  ])
    assert.ok(!isAccess(plain(t)), t);

  assert.ok(isValidity(plain('el certificado tiene validez oficial?')));
  assert.ok(isValidity(plain('es valido ante la sep?')));
  assert.ok(isValidity(plain('tiene valor curricular')));
  assert.ok(!isValidity(plain('¿Me dan un certificado con validez?')), 'la pregunta general sigue con su respuesta');
  assert.ok(!isValidity(plain('tienen pagina oficial?')), '«oficial» sin certificado no es validez');

  // recomendar sólo con el catálogo, con palabras completas (punto 10)
  const list = [
    { id: 'a', title: 'Bovinos de leche: manejo sanitario', syllabus: 'Mastitis\nCalendario de vacunación' },
    { id: 'b', title: 'Reptiles en cautiverio', syllabus: 'Tortugas e iguanas' },
    { id: 'c', title: 'Cirugía básica en perros y gatos', syllabus: 'Esterilización' },
    { id: 'd', title: 'Plan sanitario para aves', syllabus: 'Bioseguridad en la granja' },
  ];
  const ids = t => recommend(t, list).map(k => k.id);
  assert.deepEqual(ids('tengo un rancho de bovinos, ¿cuál me conviene?'), ['a']);
  assert.deepEqual(ids('¿tienen algo de reptiles?'), ['b']);
  assert.deepEqual(ids('¿tienen algo de cirugía?'), ['c']);
  assert.deepEqual(
    ids('tengo una granja de cerdos, ¿me sirve este curso?'),
    [],
    'una sola palabra del temario no basta',
  );
  assert.deepEqual(ids('soy auxiliar, ¿cuál me recomiendas?'), [], 'ni «auxiliar» es urgencias ni nada del ramo');
  assert.deepEqual(ids('¿cuál me recomiendas?'), [], 'sin tema no se adivina');
  assert.ok(wantsCourses(plain('¿cuál me recomiendas?')));
  assert.ok(
    !wantsCourses(plain('¿Sirve si trabajo en otro estado de la república y viajo mucho?')),
    'decir dónde trabaja no es pedir una recomendación',
  );
  // temas que el curso de la conversación no cubre (punto 6)
  const aves = list[3];
  assert.ok(notCovered('Soy Ana y trabajo con ganado, ¿este curso aplica para bovinos también?', aves).length);
  assert.ok(notCovered('tengo una granja de cerdos, ¿me sirve este curso?', aves).length);
  assert.deepEqual(notCovered('¿me sirve este curso si no tengo conocimientos previos?', aves), []);
});

test('migración replies/0001: sobre una base sin el área «replies» (como la de main) crea la propuesta y su historial', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-ventas-mig-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  // main no tiene ninguna migración del área «replies» (ninguna se publicó): la base de partida es el registro sin ella
  const name = 'replies/0001-certificate-name-requests';
  assert.deepEqual(
    NAMED.filter(m => m.name.startsWith('replies/')).map(m => m.name),
    [name],
    'una sola migración del área',
  );
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => !m.name.startsWith('replies/'))) });
  assert.deepEqual(migrate(db, { backup: false }).applied, [name]);
  assertSchemaCurrent(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map(r => r.name);
  assert.ok(tables.includes('certificate_name_requests') && tables.includes('certificate_name_events'));
  assert.ok(!tables.includes('certificate_details'), 'la tabla por conversación ya no existe ni se crea');
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
  const setMode = async body => {
    const rs = (await call(origin, '/api/replies/settings', { cookie: admin })).settings.find(
      x => x.brand_id === 'globalvet',
    );
    await call(origin, '/api/replies/brands/globalvet', {
      cookie: admin,
      method: 'PATCH',
      body: { ...body, expectedRevision: rs.revision },
    });
  };

  // ---- el pago partido: antes todo recibía «Puedes pagar con…»
  const how = await sim('como puedo pagar');
  assert.equal(how.intent, 'payment');
  assert.equal(how.handoff, false, 'la pregunta de siempre sigue igual');
  const paid = await sim('listo ya hice la transferencia');
  assert.equal(paid.handoff, true);
  assert.match(paid.reply, /revisará tu pago/);
  assert.doesNotMatch(paid.reply, /Puedes pagar con/);
  const later = await sim('mañana hago el deposito');
  assert.equal(later.handoff, false, 'pagar después no pasa a una persona');
  assert.match(later.reply, /sin prisa/);
  const hold = await sim('en la quincena pago, me lo apartan?');
  assert.match(hold.reply, /El lugar queda asegurado cuando se confirma el pago/);
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
  }
  // punto 2: «ya pagué» gana a la inscripción; «incluye» y «en cuenta» no son inscripción
  const paidEnroll = await sim('Ya realicé el pago de mi inscripción');
  assert.equal(paidEnroll.intent, 'payment');
  assert.doesNotMatch(paidEnroll.reply, /Ya tengo listo tu pedido/);
  for (const text of [
    'gracias, lo tomo en cuenta',
    '¿qué incluye la inscripción?',
    '¿la inscripción incluye material?',
  ])
    assert.notEqual((await sim(text)).intent, 'enroll', text);
  // punto 3: lo que pide un prospecto no es posventa
  for (const text of [
    '¿me pasas el link para pagar?',
    '¿me mandas el link de pago?',
    'no me llegó el enlace de pago',
    '¿me mandan información del curso?',
    '¿me pasas el temario del curso?',
    '¿me pasan los datos del curso?',
    'el curso ya empezó?',
  ]) {
    const r = await sim(text);
    assert.notEqual(r.intent, 'access', text);
    assert.doesNotMatch(r.reply, /No encuentro una inscripción activa/, text);
    assert.equal(r.handoff, false, text);
  }

  // ---- segunda revisión: frases exactas y sus negativos
  // M1: preguntas que mencionan la inscripción no crean un pedido
  for (const text of ['¿la inscripcion es en linea?', 'si lo tomo me dan constancia?', '¿Ya quedó mi inscripción?']) {
    const r = await sim(text);
    assert.notEqual(r.intent, 'enroll', text);
    assert.doesNotMatch(r.reply, /Ya tengo listo tu pedido/, text);
  }
  assert.equal((await sim('si lo tomo me dan constancia?')).intent, 'certificate');
  assert.equal((await sim('lo tomo')).intent, 'enroll', 'vecino: la decisión sin pregunta sí');
  // M2: «todavía no pagué» no es «ya pagué»
  for (const text of ['todavia no pague', 'todavia no pague, lo hago mañana', 'aun no deposite, me pasas la cuenta?']) {
    const r = await sim(text);
    assert.doesNotMatch(r.reply, /revisará tu pago/, text);
    assert.equal(r.handoff, false, text);
  }
  assert.match((await sim('aun no deposite, me pasas la cuenta?')).reply, /Puedes pagar con|Al inscribirte te mando/);
  const missing = await sim('nunca me llego el comprobante de pago');
  assert.equal(missing.handoff, true);
  assert.doesNotMatch(missing.reply, /revisará tu pago/);
  assert.match((await sim('pague pero no me llego nada')).reply, /revisará tu pago/, 'vecino: sí avisa un pago');
  // M3: «vacantes» del curso son cupo; buscar trabajo, no
  for (const text of ['aun hay vacantes?', 'quedan vacantes para el curso?'])
    assert.equal((await sim(text)).intent, 'seats', text);
  assert.equal((await sim('busco trabajo de auxiliar, tienen vacante?')).intent, 'help');
  // M4: datos para la factura o para inscribirse no son datos del certificado; pedir información tampoco
  assert.doesNotMatch((await sim('les paso mis datos para la factura')).reply, /certificado/);
  assert.doesNotMatch((await sim('te mando mis datos para inscribirme')).reply, /certificado/);
  const info = await sim('Hola mi nombre es Juan Perez y quiero informacion del registro');
  assert.equal(info.intent, 'greeting', 'pide información: la ficha, ni datos ni pedido');
  // M6: sin ajustes de certificados de la marca no se afirma emisor ni formato
  const noIssuer = await sim('tiene validez ante la SEP?');
  assert.doesNotMatch(noIssuer.reply, /lo emite|digital|folio/);
  assert.match(noIssuer.reply, /no te puedo confirmar nada por aquí/);
  db.prepare(
    "INSERT INTO certificate_settings(brand_id,issuer_name,updated_at) VALUES('globalvet','Emisor Ejemplo',?)",
  ).run(Date.now());
  assert.match((await sim('tiene validez ante la SEP?')).reply, /lo emite Emisor Ejemplo, lleva folio/);
  // B3
  assert.equal((await sim('q dias son las clases y a q hora')).intent, 'schedule');
  const cash = await sim('hay descuento si pago de contado?');
  assert.equal(cash.intent, 'price');
  assert.match(cash.reply, /promoción vigente/);
  const broken = await sim('el link para pagar no abre');
  assert.equal(broken.handoff, true);
  assert.doesNotMatch(broken.reply, /Puedes pagar con/);
  const both = await sim('cuanto cuesta y tienen meses sin intereses?');
  assert.match(both.reply, /\$379\.00 MXN/, 'no pierde el precio');
  assert.match(both.reply, /meses/);
  const two = await sim('mi esposa tambien quiere el curso, cuanto seria por los dos');
  assert.equal(two.handoff, true);
  assert.match(two.reply, /varias personas/);
  assert.equal((await sim('¿hay espacio para estacionarse?')).intent !== 'seats', true);
  db.prepare(
    "INSERT INTO coupons(id,brand_id,code,name,kind,value,customer_entry,status,created_at,updated_at) VALUES('cupon-ficticio','globalvet','EJEMPLO10','Cupón ejemplo','percent',10,1,'active',?,?)",
  ).run(Date.now(), Date.now());
  const withCoupon = await sim('¿tienen descuento?');
  assert.doesNotMatch(
    withCoupon.reply,
    /no hay una promoción vigente/,
    'con cupones que el cliente escribe no se niega',
  );
  assert.match(withCoupon.reply, /cupón/);
  db.prepare("DELETE FROM coupons WHERE id='cupon-ficticio'").run();

  // frases vecinas nuevas (sonda propia tras la segunda revisión)
  assert.equal((await sim('¿si lo pago hoy me llega la constancia?')).intent, 'certificate');
  assert.equal((await sim('aun no me inscribo, hay cupo?')).intent, 'seats');
  assert.notEqual((await sim('si me inscribo hoy ¿me dan descuento?')).intent, 'enroll');
  assert.equal((await sim('no lo voy a tomar, cancelen mi pedido')).handoff, true);
  assert.match((await sim('¿me reenvias el enlace para pagar?')).reply, /te mando tu enlace de pago/);
  assert.equal((await sim('el link de pago no me abre')).handoff, true);
  assert.match((await sim('no he podido pagar, ¿me guardan el lugar?')).reply, /asegurado cuando se confirma el pago/);
  assert.match((await sim('ya casi pago, ¿cual es el ultimo dia?')).reply, /fecha de vencimiento/);
  assert.equal((await sim('¿ya quedo mi lugar?')).intent, 'payment');

  // ---- reglas que no gastan IA
  const intents = {
    'buen dia': 'greeting',
    'quiero apartar mi lugar': 'enroll',
    'si quiero apartar mi lugar': 'enroll',
    'lo tomo': 'enroll',
    'cuanto cuesta la inscripcion?': 'price', // vecino: preguntar el costo no crea un pedido
    'me puede llamar una persona?': 'human',
    'quedan espacios?': 'seats',
    'manejan diplomados?': 'courses',
    'no tengo tiempo en esas fechas': 'objection',
    '¿a qué hora es? salgo tarde de la clínica': 'schedule',
    'busco trabajo, tienen vacante?': 'help',
    '¿hay cupo?': 'seats',
  };
  for (const [text, intent] of Object.entries(intents)) assert.equal((await sim(text)).intent, intent, text);
  assert.notEqual((await sim('¿hay espacio para estacionarse?')).intent, 'seats', 'punto 12: no es cupo');
  const deadline = await sim('hasta que dia me puedo registrar');
  assert.equal(deadline.intent, 'schedule');
  assert.equal(deadline.stage, null, 'preguntar el plazo no crea un pedido');
  assert.match(deadline.reply, /Por ahora las inscripciones están abiertas/);
  assert.doesNotMatch(deadline.reply, /hasta que empiece/, 'punto 12: nada que no salga del estado real');
  for (const text of ['el certificado tiene validez oficial?', 'es valido ante la sep?', 'sirve para mi cedula?']) {
    const r = await sim(text);
    assert.equal(r.intent, 'certificate', text);
    assert.doesNotMatch(r.reply, /^Sí/, text + ': nunca «Sí» a una validez oficial');
    assert.match(r.reply, /no te puedo confirmar nada por aquí/, text);
  }
  assert.ok((await sim('¿Entregan certificado?')).sources.some(s => s.type === 'knowledge'));
  assert.match((await sim('quedan espacios?')).reply, /el grupo es de 30 lugares/);
  const length = await sim('cuanto dura el curso');
  assert.match(length.reply, /• Termina: /);
  assert.doesNotMatch(length.reply, /qué edición te interesa/);
  // Duración con conocimiento propio: «¿cuánto dura cada clase?» (visto en WhatsApp real: recibía sólo las fechas) pone
  // primero lo que la respuesta aprobada añade y debajo el calendario; la frase que remite a la ficha sobra.
  const addEntry = async (topic, question, answer, variants) => {
    const made = (
      await call(origin, '/api/replies/knowledge', {
        cookie: admin,
        body: { brandId: 'globalvet', topic, question, answer, variants },
        expected: 201,
      })
    ).entry;
    await call(origin, '/api/replies/knowledge/' + made.id + '/approve', {
      cookie: admin,
      body: { expectedRevision: made.revision },
    });
    return made;
  };
  const perClass = await addEntry(
    'duration',
    '¿Cuánto dura cada clase?',
    'Cada sesión en vivo dura alrededor de dos horas. Los días y el horario exactos de tu curso vienen en su ficha: escribe «fechas» y te la vuelvo a mandar.',
    ['cuanto dura cada clase', 'cuantas horas es cada sesion', 'cuanto tiempo dura la clase'],
  );
  const perClassReply = await sim('Cuánto dura cada clase');
  assert.match(perClassReply.reply, /^Cada sesión en vivo dura alrededor de dos horas\.\n\n/);
  assert.match(perClassReply.reply, /• Termina: /);
  assert.doesNotMatch(perClassReply.reply, /vienen en su ficha/, 'la frase que remite a la ficha sobra');
  assert.ok(perClassReply.sources.some(s => s.type === 'knowledge' && s.id === perClass.id));
  // «¿cuánto dura el curso?» sigue igual: la respuesta de ejemplo («dime qué edición») no añade nada y la de cada clase no se parece lo bastante
  const lengthAgain = await sim('cuanto dura el curso');
  assert.doesNotMatch(lengthAgain.reply, /dos horas|qué edición/);
  assert.match(lengthAgain.reply, /• Termina: /);
  assert.equal(
    durationFacts({
      answer:
        'La duración aparece en la ficha de cada edición. Si me dices qué edición te interesa, te comparto el calendario completo.',
    }),
    null,
  );
  assert.equal(
    durationFacts({ answer: 'Son seis sesiones de dos horas. El calendario viene en la ficha.' }),
    'Son seis sesiones de dos horas.',
  );
  // Dos respuestas de pago aprobadas, la de «¿dónde deposito?» aprobada al final: «¿puedo pagar por OXXO?» (visto en WhatsApp
  // real) ya no recibe la última tocada, sino la que comparte palabras con la pregunta.
  const payA = await addEntry(
    'payment',
    '¿Aceptan tarjeta, OXXO o transferencia?',
    'Desde tu enlace de pago puedes pagar con tarjeta de crédito o débito, transferencia (SPEI) o en efectivo en OXXO. Por ahora no manejamos PayPal.',
    ['aceptan tarjeta', 'se puede pagar en oxxo', 'puede ser transferencia', 'aceptan efectivo', 'pago con paypal'],
  );
  const payB = await addEntry(
    'payment',
    '¿Dónde deposito o hago la transferencia?',
    'El pago se hace desde tu enlace de pago: ahí eliges tarjeta, transferencia (SPEI) u OXXO y te muestra los datos.',
    ['donde deposito', 'a donde transfiero', 'datos para depositar', 'a que cuenta deposito'],
  );
  const oxxo = await sim('Y puedo pagar por Oxxo o algo asi');
  assert.equal(oxxo.intent, 'payment');
  assert.match(oxxo.reply, /OXXO/);
  assert.doesNotMatch(oxxo.reply, /ahí eliges/, 'no la última aprobada del tema, sino la que se parece');
  assert.match((await sim('donde deposito?')).reply, /ahí eliges/);
  // se retiran: el resto de la prueba cuenta con las 6 respuestas de ejemplo de la marca
  for (const e of [perClass, payA, payB]) {
    const now = (await call(origin, '/api/replies/knowledge?brand=globalvet', { cookie: admin })).entries.find(
      x => x.id === e.id,
    );
    await call(origin, '/api/replies/knowledge/' + e.id + '/archive', {
      cookie: admin,
      body: { expectedRevision: now.revision },
    });
  }
  const promo = await sim('¿tienen descuento?');
  assert.match(promo.reply, /no hay una promoción vigente/);
  assert.doesNotMatch(promo.reply, /estudiante/, 'punto 12: no sugiere un precio especial por ser estudiante');
  // punto 11: hasta cuándo la promoción y el último día para pagar
  assert.match((await sim('¿hasta cuándo es la promoción?')).reply, /no hay una promoción vigente/);
  db.prepare(
    "INSERT INTO promotions(id,brand_id,edition_id,name,price_cents,starts_at,ends_at,status,created_at,updated_at) VALUES('promo-ficticia','globalvet',?,'Preventa ficticia',1000,?,?,'published',?,?)",
  ).run(edition, Date.now() - day, Date.now() + 3 * day, Date.now(), Date.now());
  assert.match((await sim('¿hasta cuándo es la promoción?')).reply, /Preventa ficticia», vigente hasta el /);
  db.prepare("DELETE FROM promotions WHERE id='promo-ficticia'").run();
  assert.match((await sim('¿cuál es el último día para pagar?')).reply, /fecha de vencimiento/);

  // ---- recomendar sin IA con el catálogo de la marca (punto 10)
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
  const cows = await sim('tengo un rancho de bovinos, ¿cuál me conviene?');
  assert.equal(cows.intent, 'courses');
  assert.match(cows.reply, /Bovinos de leche: manejo sanitario — inicia .+ · \$480\.00 MXN/);
  assert.doesNotMatch(cows.reply, /Reptiles en cautiverio/);
  assert.match((await sim('¿tienen algo de reptiles?')).reply, /Reptiles en cautiverio/);
  const open = await sim('¿cuál me recomiendas?');
  assert.match(open.reply, /¿Qué tema te interesa\?/);
  assert.doesNotMatch(open.reply, /especie|Bovinos|Reptiles/);
  assert.match((await sim('¿tienen algo de cirugía?')).reply, /No encontré un curso con ese tema/);
  assert.doesNotMatch(
    (await sim('no soy veterinario, soy tecnico, puedo tomarlo?')).reply,
    / — inicia /,
    'pregunta por ESTE curso: no se le suelta una lista',
  );
  assert.match((await sim('¿qué otros cursos tienen?')).reply, /también tenemos/, 'vecino: la lista de siempre');
  // punto 6: temas que el curso no cubre no reciben requisitos ni el curso por una palabra del temario
  const bovine = await sim('Soy Ana y trabajo con ganado, ¿este curso aplica para bovinos también?');
  assert.doesNotMatch(bovine.reply, REQUIREMENTS);
  const pigs = await sim('tengo una granja de cerdos, ¿me sirve este curso?');
  assert.doesNotMatch(pigs.reply, REQUIREMENTS);
  assert.doesNotMatch(pigs.reply, /Plan sanitario para aves —/);
  assert.match((await sim('soy estudiante, ¿me sirve este curso?')).reply, REQUIREMENTS, 'vecino: sí le cubre');

  // ---- punto 8: con pocas respuestas aprobadas, una pregunta real sigue llegando a la IA; un saludo, no
  await setMode({ mode: 'autonomous', providerEnabled: true });
  const real = await sim('¿Sirve si trabajo en otro estado de la república y viajo mucho?');
  assert.equal(real.provider.used, true, 'una pregunta real va a la IA');
  assert.equal((await sim('buen día')).provider.used, false, 'un saludo tiene su regla');
  assert.equal((await sim('me gusta el futbol')).provider.used, false, 'un mensaje corto que no pregunta, no');
  await setMode({ mode: 'templates', providerEnabled: false });

  // ---- conversación real
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
    const reopen = () =>
      db.prepare("UPDATE conversations SET bot_enabled=1,status='open',assigned_to=NULL WHERE id=?").run(id);
    return { id, post, say, orders, state, reopen };
  };
  const request = orderId => db.prepare('SELECT * FROM certificate_name_requests WHERE order_id=?').get(orderId);

  const ana = await chat(await register('ana', 'Ana Ejemplo'));
  await ana.say('Hola');
  assert.equal((await ana.say('si me interesa')).log.intent, 'greeting', 'justo después de la ficha sigue igual');
  assert.equal((await ana.say('¿Entregan certificado?')).log.intent, 'certificate');
  assert.equal((await ana.say('Sí, me interesa')).log.intent, 'enroll');
  assert.equal(ana.orders().length, 1);
  const order = ana.orders()[0];
  const pay = await ana.say('en la quincena pago, me lo apartan?');
  assert.ok(pay.text.includes('Tu pedido ' + order.reference + ' sigue vigente hasta el '), pay.text);
  assert.match((await ana.say('¿cuál es el último día para pagar?')).text, new RegExp(order.reference + ' vence el '));
  for (const text of [
    'gracias, lo tomo en cuenta',
    '¿qué incluye la inscripción?',
    '¿la inscripción incluye material?',
  ])
    await ana.say(text);
  assert.equal(ana.orders().length, 1, 'punto 2: no crean otro pedido');
  const check = await ana.say('ya pudieron verificar mi pago?');
  assert.match(check.text, /Todavía no veo un comprobante en tu pedido/);
  // datos para la constancia: una propuesta ligada al pedido
  const data = await ana.say('mi nombre completo para la constancia es ANA EJEMPLO PRUEBA');
  assert.equal(data.log.intent, 'cert_data');
  assert.match(data.text, /Anoté tu nombre «ANA EJEMPLO PRUEBA» para tu certificado/);
  assert.match(data.text, /El equipo lo revisa antes de emitir/);
  assert.equal(request(order.id).status, 'pending');
  // punto 1: un saludo, un agradecimiento o una queja en mayúsculas no reemplazan el nombre
  for (const text of ['HOLA BUENAS TARDES', 'MUCHAS GRACIAS', 'LO VEO CON MI ESPOSO', 'NADIE ME CONTESTA']) {
    const r = await ana.say(text);
    assert.doesNotMatch(r.text, /Anoté tu nombre/, text);
    if (!ana.state().bot_enabled) ana.reopen();
  }
  assert.equal(request(order.id).requested_name, 'ANA EJEMPLO PRUEBA');
  const mail = await ana.say('ana.ejemplo@correo.test 55 1234 5678');
  assert.equal(mail.log.intent, 'cert_data', 'con un pedido, un correo suelto es un dato');
  assert.equal(request(order.id).requested_name, 'ANA EJEMPLO PRUEBA', 'una señal débil no pisa el nombre');
  // M4: datos de otra persona no se guardan como suyos
  const sisterPhone = await ana.say('el numero de mi hermana es 5598765432');
  assert.notEqual(sisterPhone.log.intent, 'cert_data');
  await ana.say('mi correo es otra@correo.test, y el de mi hermana luisa@correo.test');
  assert.equal(request(order.id).email, 'ana.ejemplo@correo.test');
  assert.equal(request(order.id).phone, '5512345678');
  // B3: con pedido pendiente, «¿cómo entro a la clase?» dice que los accesos llegan al confirmarse el pago
  const howIn = await ana.say('¿cómo entro a la clase?');
  assert.match(howIn.text, /llegan por este chat cuando tu pago queda confirmado/);
  assert.equal(howIn.log.action, 'replied');
  const renamed = await ana.say('mi nombre completo es ANA MARIA EJEMPLO PRUEBA');
  assert.match(renamed.text, /Cambié el nombre de tu certificado de «ANA EJEMPLO PRUEBA» a «ANA MARIA EJEMPLO PRUEBA»/);
  assert.deepEqual(
    {
      ...db
        .prepare('SELECT requested_name,email,phone,contact_id FROM certificate_name_requests WHERE order_id=?')
        .get(order.id),
    },
    {
      requested_name: 'ANA MARIA EJEMPLO PRUEBA',
      email: 'ana.ejemplo@correo.test',
      phone: '5512345678',
      contact_id: order.contact_id,
    },
  );
  assert.equal(ana.orders().length, 1, 'los datos no crean otro pedido');
  const luis = await chat(await register('luis', 'Luis Ejemplo'));
  await luis.say('Hola');
  const noOrder = await luis.say('mi nombre completo para la constancia es LUIS EJEMPLO');
  assert.doesNotMatch(noOrder.text, /Anoté/, 'sin pedido no se guarda nada');
  assert.equal((await luis.say('Ya realicé el pago de mi inscripción')).log.intent, 'payment');
  assert.equal(luis.orders().length, 0, 'punto 2: avisar de un pago no crea un pedido');
  const sister = await chat(await register('rosa', 'Rosa Ejemplo'));
  await sister.say('Hola');
  const group = await sister.say('mi hermana también quiere inscribirse');
  assert.equal(group.log.action, 'escalated', 'punto 12: varias personas, una persona del equipo');
  assert.equal(sister.orders().length, 0);

  // ---- posventa: comprobante validado, accesos y reenvío (puntos 2, 4 y 7)
  const BODY =
    '¡Te damos la bienvenida, {{nombre}}! Ya tienes tu lugar en {{curso}}.\nEnlace de las clases: https://clases.example.test/aves-ficticio';
  const access = await call(origin, '/api/course-access/editions/' + edition, {
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
  ana.reopen();
  const enrolled = await ana.say('quiero inscribirme');
  assert.match(
    enrolled.text,
    /ya está activa: no hace falta otro pedido/,
    'ya inscrita en este curso, sin otro pedido',
  );
  assert.doesNotMatch(enrolled.text, /clases\.example\.test/, 'A1: una petición de inscripción no trae accesos');
  assert.equal(ana.orders().length, 1);
  // A1: otro curso o alguien más no son «ya está activa»
  const other = await ana.say('quiero inscribirme a otro curso también');
  assert.doesNotMatch(other.text, /ya está activa/);
  assert.match(other.text, /también tenemos|es el curso que tenemos abierto/);
  const spouse = await ana.say('mi esposa también quiere inscribirse');
  assert.doesNotMatch(spouse.text, /ya está activa/);
  assert.equal(spouse.log.action, 'escalated', 'A1: el aviso de grupo llega al equipo');
  ana.reopen();
  const resends = () =>
    db.prepare("SELECT * FROM course_access_deliveries WHERE conversation_id=? AND kind='manual'").all(ana.id);
  assert.equal(resends().length, 0);
  const thanks = await ana.say('gracias!');
  assert.doesNotMatch(thanks.text, /inscribirte/, 'a quien ya pagó no se le ofrece inscribirse');
  // B3: con inscripción activa, el descuento no invita a inscribirse otra vez
  assert.doesNotMatch((await ana.say('hay descuento para la siguiente?')).text, /Quiero inscribirme/);
  const again = await ana.say('no me llegó el enlace, ¿dónde entro a la clase?');
  assert.equal(again.log.intent, 'access');
  assert.match(again.text, /aquí tienes de nuevo tus accesos/);
  assert.ok(again.text.includes('https://clases.example.test/aves-ficticio'));
  assert.equal((await ana.say('¿me pasan el link de la clase?')).log.action, 'replied');
  assert.equal(resends().length, 2);
  // tope: 2 reenvíos del asistente por inscripción y día; el tercero lo ve una persona, con su propio texto (M5)
  const third = await ana.say('¿me pasan el link de la clase?');
  assert.equal(third.log.action, 'escalated', 'punto 4: el tercer reenvío del día lo hace una persona');
  assert.match(third.text, /Ya te reenvié tus accesos hace un rato/);
  assert.doesNotMatch(third.text, /todavía no están listos/);
  assert.equal(resends().length, 2);
  assert.equal(
    db.prepare("SELECT count(*) n FROM audit WHERE action='course_access.resend_assistant'").get().n,
    2,
    'cada reenvío queda auditado',
  );
  ana.reopen();
  // texto cambiado después de entregarlo: no se reenvía el nuevo sin que lo vea una persona (gana sobre el tope)
  const edited = await call(origin, '/api/course-access/editions/' + edition, {
    cookie: admin,
    method: 'PUT',
    body: {
      enabled: true,
      body: BODY + '\nMaterial nuevo: https://clases.example.test/extra',
      expectedRevision: access.edition.access.revision,
    },
  });
  const changed = await ana.say('¿me pasan el link de la clase?');
  assert.equal(changed.log.action, 'escalated', 'punto 4: texto cambiado');
  assert.match(changed.text, /se actualizaron después de que te los enviamos/);
  ana.reopen();
  await call(origin, '/api/course-access/editions/' + edition, {
    cookie: admin,
    method: 'PUT',
    body: { enabled: false, expectedRevision: edited.edition.access.revision },
  });
  assert.equal((await ana.say('¿me pasan el link de la clase?')).log.action, 'escalated', 'punto 4: entrega apagada');
  assert.equal(resends().length, 2, 'ninguno más');
  ana.reopen();
  assert.equal((await ana.say('el link no abre')).log.action, 'escalated', 'una falla la revisa una persona');
  ana.reopen();

  // ---- el nombre pedido es una propuesta: el certificado sale con él sólo si el equipo lo confirma (punto 1)
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
  const view = await call(origin, '/api/certificates/editions/' + edition, { cookie: admin });
  const row = view.enrollments.find(r => r.enrollmentId === enrollment);
  assert.deepEqual(row.requestedName, { name: 'ANA MARIA EJEMPLO PRUEBA', status: 'pending', confirmedName: null });
  assert.equal(row.holderName, 'Ana Ejemplo', 'sin confirmar, el certificado sale con el nombre de siempre');
  // B1: autorización, nombre válido y control de concurrencia
  const holderName = (cookie, body, expected = 200) =>
    call(origin, '/api/certificates/enrollments/' + enrollment + '/holder-name', { cookie, body, expected });
  const staff = async (username, brand) => {
    const cookie = await register(username, 'Equipo ' + username);
    const id = db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
    db.prepare("UPDATE users SET role='agent' WHERE id=?").run(id);
    db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(id, brand);
    return cookie;
  };
  await holderName(await staff('asesor-otra', 'odonteck'), { name: 'Ana María Ejemplo Prueba' }, 404);
  await holderName(await staff('asesor-gv', 'globalvet'), { name: 'Ana María Ejemplo Prueba' }, 403);
  await holderName(admin, { name: 'Ana' }, 400);
  await holderName(admin, { name: 'Ana <b>Ejemplo</b>' }, 400);
  const stale = await holderName(
    admin,
    { name: 'Ana María Ejemplo Prueba', expectedRequestedName: 'ANA EJEMPLO PRUEBA' },
    409,
  );
  assert.equal(stale.code, 'stale_record', 'pidió otro nombre mientras tanto');
  await holderName(admin, { name: 'Ana María Ejemplo Prueba', expectedRequestedName: 'ANA MARIA EJEMPLO PRUEBA' });
  assert.deepEqual(
    { ...db.prepare('SELECT from_name,to_name FROM certificate_name_events WHERE order_id=?').get(order.id) },
    { from_name: 'Ana Ejemplo', to_name: 'Ana María Ejemplo Prueba' },
    'la corrección queda con el nombre anterior y el nuevo',
  );
  const confirmedView = (
    await call(origin, '/api/certificates/editions/' + edition, { cookie: admin })
  ).enrollments.find(r => r.enrollmentId === enrollment);
  await call(origin, '/api/certificates/editions/' + edition + '/issue', {
    cookie: admin,
    body: { enrollmentIds: [enrollment] },
  });
  const issuedName = db
    .prepare('SELECT holder_name FROM certificates WHERE enrollment_id=?')
    .get(enrollment).holder_name;
  assert.equal(issuedName, 'Ana María Ejemplo Prueba', 'con el nombre que confirmó el equipo');
  assert.equal(confirmedView.holderName, issuedName, '«hoy saldría como…» es el mismo nombre que sale al emitir');
  await holderName(admin, { name: 'Otro Nombre Ejemplo' }, 409); // ya certificada
  // punto 7: dada de baja, no se dice «activa»
  db.prepare("UPDATE enrollments SET status='cancelled' WHERE id=?").run(enrollment);
  const cancelled = await ana.say('ya pudieron verificar mi pago?');
  assert.match(cancelled.text, /tu inscripción no está activa/);
  assert.doesNotMatch(cancelled.text, /tu inscripción a .+ está activa/);
  assert.equal(cancelled.log.action, 'escalated');
  ana.reopen();
  // A1: dada de baja y pide inscribirse: no «ya está activa», lo revisa una persona
  const reEnroll = await ana.say('quiero inscribirme');
  assert.doesNotMatch(reEnroll.text, /ya está activa/);
  assert.match(reEnroll.text, /revise tu inscripción/);
  assert.equal(reEnroll.log.action, 'escalated');
  assert.equal(ana.orders().length, 1, 'tampoco intenta otro pedido');
  // A1: oportunidad «ganada» a mano, sin pedido ni pago
  const won = await chat(await register('gana', 'Gana Ejemplo'));
  await won.say('Hola');
  db.prepare(
    "UPDATE opportunities SET stage='ganada' WHERE id=(SELECT opportunity_id FROM conversation_opportunities WHERE conversation_id=?)",
  ).run(won.id);
  const wonReply = await won.say('quiero inscribirme');
  assert.doesNotMatch(wonReply.text, /ya está activa/);
  assert.equal(wonReply.log.action, 'escalated');
  assert.equal(won.orders().length, 0);

  // ---- después de pasar a una persona: UNA respuesta automática por espera (puntos 5 y 1)
  const carla = await chat(await register('carla', 'Carla Ejemplo'));
  await carla.say('Hola');
  await carla.say('Quiero inscribirme');
  const carlaOrder = carla.orders()[0];
  assert.equal((await carla.say('ya pague')).log.action, 'escalated');
  const automatic = () => texts(carla.id).filter(m => /^wait-(ack|data):/.test(m.client_ref || ''));
  await carla.post('el deposito lo hice a nombre de Juan Perez Lopez');
  assert.equal(automatic().length, 1);
  assert.match(automatic()[0].text, /Ya le avisé al equipo/);
  assert.ok(!request(carlaOrder.id)?.requested_name, 'quien depositó no es el nombre del certificado');
  // B4: el equipo ya había confirmado un nombre; uno nuevo que llega en la espera queda pendiente y visible
  db.prepare(
    "INSERT INTO certificate_name_requests(id,brand_id,contact_id,order_id,conversation_id,requested_name,status,confirmed_name,created_at,updated_at) VALUES(?,'globalvet',?,?,?,'CARLA EJEMPLO','confirmed','Carla Confirmada Ejemplo',1,1)",
  ).run(randomUUID(), carlaOrder.contact_id, carlaOrder.id, carla.id);
  await carla.post('mi nombre completo para la constancia es CARLA EJEMPLO RUIZ');
  await carla.post('mi correo es carla@correo.test');
  await carla.post('mi numero es 5512345678 llamenme');
  await carla.post('el numero de mi hermana es 5598765432');
  assert.equal(automatic().length, 1, 'mensajes con datos: una sola respuesta automática en la espera');
  assert.doesNotMatch(texts(carla.id).at(-1).text, /Anoté tu teléfono/);
  assert.deepEqual(
    {
      ...db
        .prepare(
          'SELECT requested_name,status,confirmed_name,email,phone FROM certificate_name_requests WHERE order_id=?',
        )
        .get(carlaOrder.id),
    },
    {
      requested_name: 'CARLA EJEMPLO RUIZ',
      status: 'pending',
      confirmed_name: 'Carla Confirmada Ejemplo',
      email: 'carla@correo.test',
      phone: '',
    },
    'el confirmado sigue; lo nuevo queda pendiente; ni «llámenme» ni el teléfono de su hermana son sus datos',
  );
  assert.deepEqual(carla.state(), { bot_enabled: 0, status: 'waiting' }, 'el asistente no retoma la conversación');
  // primera respuesta de la espera con datos: el acuse de los datos
  const dani = await chat(await register('dani', 'Dani Ejemplo'));
  await dani.say('Hola');
  await dani.say('Quiero inscribirme');
  await dani.say('ya pague');
  await dani.post('mi nombre completo para la constancia es DANI EJEMPLO SOL');
  assert.match(texts(dani.id).at(-1).text, /Anoté tu nombre «DANI EJEMPLO SOL»/);
  await call(origin, '/api/conversations/' + dani.id + '/messages', {
    cookie: admin,
    body: { text: 'Hola, ya te atiendo.', clientRef: randomUUID(), asAgent: true },
    expected: 201,
  });
  const before = texts(dani.id).length;
  await dani.post('gracias, aquí espero');
  assert.equal(texts(dani.id).length, before, 'con una persona a cargo, el asistente no dice nada');
  // vecino: en «Sugerir» el asistente nunca escribe, tampoco el acuse
  await setMode({ mode: 'suggest' });
  const tom = await chat(await register('tom', 'Tom Ejemplo'));
  await tom.say('Hola');
  await tom.post('¿siguen ahí?');
  assert.equal(texts(tom.id).length, 0);
});

test('tope de reenvíos del asistente: cuenta las últimas 24 horas con el reloj que se le da (B6)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-ventas-tope-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  migrate(db, { backup: false });
  db.exec('PRAGMA foreign_keys=OFF');
  const hour = 3600e3,
    base = Date.UTC(2026, 10, 21, 12);
  const add = (at, ref) =>
    db
      .prepare(
        "INSERT INTO course_access_deliveries(id,brand_id,edition_id,enrollment_id,conversation_id,kind,status,client_ref,created_at) VALUES(?,'globalvet','e1','n1','c1','manual','sent',?,?)",
      )
      .run(randomUUID(), ref, at);
  add(base, 'assistant:m1');
  add(base + hour, 'assistant:m2');
  add(base + 2 * hour, 'persona:m3'); // un reenvío de una persona no cuenta para el tope del asistente
  assert.equal(ASSISTANT_RESENDS_PER_DAY, 2);
  assert.equal(assistantResends(db, 'n1', base + 2 * hour), 2, 'dentro del día: tope alcanzado');
  assert.equal(assistantResends(db, 'n1', base + 24 * hour + 1), 1, 'pasadas 24 horas del primero, sólo cuenta uno');
  assert.equal(assistantResends(db, 'n1', base + 26 * hour), 0, 'al día siguiente se puede de nuevo');
  assert.equal(assistantResends(db, 'otra', base + hour), 0, 'por inscripción');
});
