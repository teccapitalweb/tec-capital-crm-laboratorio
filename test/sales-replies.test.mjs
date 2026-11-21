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
  isAccess,
  isValidity,
  notCovered,
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

test('migraciones replies/0001 y 0002: sobre una base ya publicada queda sólo la propuesta por pedido', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-ventas-mig-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const names = ['replies/0001-certificate-details', 'replies/0002-certificate-name-requests'];
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => !names.includes(m.name))) });
  assert.deepEqual(migrate(db, { backup: false }).applied, names);
  assertSchemaCurrent(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map(r => r.name);
  assert.ok(tables.includes('certificate_name_requests'));
  assert.ok(!tables.includes('certificate_details'), 'la tabla por conversación (nunca publicada) ya no existe');
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

  // ---- reglas que no gastan IA
  const intents = {
    'buen dia': 'greeting',
    'cual es el proceso de inscripcion?': 'enroll',
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
  assert.match(enrolled.text, /ya está activa: no hace falta otro pedido/, 'punto 2: ya inscrita, sin otro pedido');
  assert.equal(ana.orders().length, 1);
  const resends = () =>
    db.prepare("SELECT * FROM course_access_deliveries WHERE conversation_id=? AND kind='manual'").all(ana.id);
  const thanks = await ana.say('gracias!');
  assert.doesNotMatch(thanks.text, /inscribirte/, 'a quien ya pagó no se le ofrece inscribirse');
  const again = await ana.say('no me llegó el enlace, ¿dónde entro a la clase?');
  assert.equal(again.log.intent, 'access');
  assert.match(again.text, /aquí tienes de nuevo tus accesos/);
  assert.ok(again.text.includes('https://clases.example.test/aves-ficticio'));
  // tope: 2 reenvíos del asistente por inscripción y día (el de «ya está activa» fue el primero)
  assert.equal(resends().length, 2);
  const third = await ana.say('¿me pasan el link de la clase?');
  assert.equal(third.log.action, 'escalated', 'punto 4: el tercer reenvío del día lo hace una persona');
  assert.equal(resends().length, 2);
  assert.equal(
    db.prepare("SELECT count(*) n FROM audit WHERE action='course_access.resend_assistant'").get().n,
    2,
    'cada reenvío queda auditado',
  );
  db.prepare("DELETE FROM course_access_deliveries WHERE client_ref LIKE 'assistant:%'").run();
  ana.reopen();
  // texto cambiado después de entregarlo: no se reenvía el nuevo sin que lo vea una persona
  const edited = await call(origin, '/api/course-access/editions/' + edition, {
    cookie: admin,
    method: 'PUT',
    body: {
      enabled: true,
      body: BODY + '\nMaterial nuevo: https://clases.example.test/extra',
      expectedRevision: access.edition.access.revision,
    },
  });
  assert.equal((await ana.say('¿me pasan el link de la clase?')).log.action, 'escalated', 'punto 4: texto cambiado');
  ana.reopen();
  await call(origin, '/api/course-access/editions/' + edition, {
    cookie: admin,
    method: 'PUT',
    body: { enabled: false, expectedRevision: edited.edition.access.revision },
  });
  assert.equal((await ana.say('¿me pasan el link de la clase?')).log.action, 'escalated', 'punto 4: entrega apagada');
  assert.equal(resends().length, 0);
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
  await call(origin, '/api/certificates/enrollments/' + enrollment + '/holder-name', {
    cookie: admin,
    body: { name: 'Ana María Ejemplo Prueba' },
  });
  await call(origin, '/api/certificates/editions/' + edition + '/issue', {
    cookie: admin,
    body: { enrollmentIds: [enrollment] },
  });
  assert.equal(
    db.prepare('SELECT holder_name FROM certificates WHERE enrollment_id=?').get(enrollment).holder_name,
    'Ana María Ejemplo Prueba',
    'con el nombre que confirmó el equipo',
  );
  // punto 7: dada de baja, no se dice «activa»
  db.prepare("UPDATE enrollments SET status='cancelled' WHERE id=?").run(enrollment);
  const cancelled = await ana.say('ya pudieron verificar mi pago?');
  assert.match(cancelled.text, /tu inscripción no está activa/);
  assert.doesNotMatch(cancelled.text, /tu inscripción a .+ está activa/);
  assert.equal(cancelled.log.action, 'escalated');

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
  await carla.post('mi nombre completo para la constancia es CARLA EJEMPLO RUIZ');
  await carla.post('mi correo es carla@correo.test');
  await carla.post('mi numero es 5512345678 llamenme');
  assert.equal(automatic().length, 1, 'tres mensajes con datos: una sola respuesta automática en la espera');
  assert.doesNotMatch(texts(carla.id).at(-1).text, /Anoté tu teléfono/);
  assert.equal(request(carlaOrder.id).requested_name, 'CARLA EJEMPLO RUIZ', 'los datos sí se guardan');
  assert.equal(request(carlaOrder.id).phone, '', 'un mensaje que pide algo no se toma como dato');
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
