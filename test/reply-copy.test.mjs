import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as copy from '../server/reply-copy.mjs';

// Los textos del asistente son funciones puras (server/reply-copy.mjs): se prueban sin servidor.
const start = Date.UTC(2026, 11, 2, 1, 0); // 1 dic 2026, 7:00 p.m. en Ciudad de México
const full = {
  course: {
    title: 'Nutrición en perros y gatos',
    welcome:
      'Hola, {{nombre}}. Te comparto la información de {{curso}}. ¿Quieres conocer el temario, el precio o cómo inscribirte?',
    syllabus: 'Etapas de vida\nEvaluación nutricional\n- Casos de estudio',
  },
  edition: {
    name: 'Edición general',
    starts_at: start,
    timezone: 'America/Mexico_City',
    instructor: 'MVZ Laura Ríos',
    modality: 'online',
    location: 'Google Meet',
    currency: 'MXN',
  },
  promotion: null,
  priceCents: 44900,
  currency: 'MXN',
  dateLabel: '1 dic 2026, 7:00 p.m. · America/Mexico_City',
};
const bare = {
  ...full,
  edition: {
    name: 'Edición general',
    starts_at: null,
    timezone: 'America/Mexico_City',
    instructor: '',
    modality: 'online',
    location: '',
    currency: 'MXN',
  },
  dateLabel: 'Fecha de práctica por confirmar',
};
const promo = {
  ...full,
  promotion: { name: 'Pronto pago', ends_at: Date.UTC(2026, 10, 21, 5, 59) },
  priceCents: 39900,
};
// Texto plano (Operación → Seguimientos → «Mensajes con emojis» apagado): viñetas, sin negritas ni emojis.
const plain = ctx => ({ ...ctx, style: { emojis: false } });
const all = ctx => [
  copy.card(ctx),
  copy.welcome(ctx, 'Ana Pérez'),
  copy.price(ctx),
  copy.syllabus(ctx),
  copy.schedule(ctx),
  copy.enrollWithOrder(ctx, 'Ana'),
  copy.enrollWithAdvisor(ctx, 'Ana'),
  copy.fallback(ctx),
];

test('textos del asistente: datos del catálogo, lo desconocido se dice claro y cada mensaje lleva al siguiente paso', () => {
  // ficha completa: fecha legible con su zona, docente, modalidad y precio
  const card = copy.card(plain(full));
  assert.match(card, /^Nutrición en perros y gatos · Edición general\n/);
  assert.match(card, /• Inicio: martes, 1 de diciembre de 2026, 7:00 p\.m\. \(hora del centro de México\)/);
  assert.match(card, /• Docente: MVZ Laura Ríos/);
  assert.match(card, /• Modalidad: En línea · Google Meet/);
  assert.match(card, /• Precio: \$449\.00 MXN/);
  assert.match(card, /Chat de prueba/);
  assert.doesNotMatch(card, /America\/Mexico_City/, 'la zona se dice en palabras');
  // sin datos: nada de «Por confirmar» sueltos ni renglones vacíos
  const empty = copy.card(plain(bare));
  assert.match(empty, /• Inicio: fecha por confirmar/);
  assert.doesNotMatch(empty, /Docente|Fecha de práctica|undefined|null|· $/m);
  assert.match(empty, /• Modalidad: En línea\n/);
  // bienvenida: el saludo guardado del curso + la ficha, sin repetir la misma frase
  const w = copy.welcome(full, 'Ana Pérez');
  assert.match(w, /^Hola, Ana\. Te comparto la información de Nutrición en perros y gatos\./);
  assert.equal(w.match(/Te comparto la información/g).length, 1);
  assert.ok(w.endsWith(copy.LAB_NOTE));
  assert.match(copy.welcome(full, 'miguel.admin2'), /^Hola, qué tal\./, 'un alias no se usa como nombre');
  // precio: cifra del catálogo, promoción sólo si existe y siguiente paso
  const p = copy.price(plain(full));
  assert.match(p, /^El precio de Nutrición en perros y gatos · Edición general es de \$449\.00 MXN\./);
  assert.match(p, /«Quiero inscribirme»/);
  assert.match(p, /precio de ejemplo/i);
  assert.doesNotMatch(p, /promoci/i);
  assert.match(copy.price(promo), /\$399\.00 MXN con la promoción «Pronto pago», vigente hasta el 20 de noviembre\./);
  // temario en viñetas, respetando las que ya traía
  const s = copy.syllabus(plain(full));
  assert.match(
    s,
    /^Esto es lo que verás en Nutrición en perros y gatos:\n\n• Etapas de vida\n• Evaluación nutricional\n- Casos de estudio\n\n/,
  );
  assert.match(s, /¿Te cuento el precio o las fechas\?$/);
  // fechas: con fecha invita a inscribirse; sin fecha lo dice y ofrece otra cosa
  const sch = copy.schedule(plain(full));
  assert.match(sch, /• Inicio: martes, 1 de diciembre/);
  assert.match(sch, /• Docente: MVZ Laura Ríos/);
  assert.doesNotMatch(sch, /Precio/);
  assert.match(sch, /«Quiero inscribirme»\.$/);
  const sch0 = copy.schedule(plain(bare));
  assert.match(sch0, /• Inicio: fecha por confirmar\n• Docente: por confirmar\n/);
  assert.match(sch0, /En cuanto se confirme la fecha te avisamos/);
  assert.doesNotMatch(sch0, /Quiero inscribirme/);
  // inscripción, pedido y pago
  assert.equal(
    copy.enrollWithOrder(plain(full), 'Ana Pérez'),
    '¡Qué gusto, Ana! Ya tengo listo tu pedido:\n\n{{pedido}}',
  );
  assert.equal(copy.enrollWithOrder(full, 'Ana Pérez'), '¡Qué gusto, Ana! 🎉 Ya tengo listo tu pedido:\n\n{{pedido}}');
  assert.match(
    copy.enrollWithAdvisor(plain(full), ''),
    /^¡Qué gusto! Anoté tu interés en .+ Un asesor te escribe por aquí/,
  );
  const link = copy.orderLink({
    reference: 'TC-AB12CD',
    course: 'Nutrición en perros y gatos',
    edition: 'Edición general',
    amount: '$449.00',
    link: 'https://ejemplo.test/?pay=1afa5c80-3856-410e-95c2-dda4300a3140',
    until: '13 nov 2026, 10:30 a.m.',
    coupon: ' Incluye tu cupón AMIGA (−$50.00).',
  });
  assert.match(
    link,
    /^Pedido TC-AB12CD\nNutrición en perros y gatos · Edición general — \$449\.00\. Incluye tu cupón AMIGA/,
  );
  assert.match(
    link,
    /\nPaga aquí: https:\/\/ejemplo\.test\/\?pay=1afa5c80-3856-410e-95c2-dda4300a3140\n/,
    'el enlace conserva la forma que la app reconoce',
  );
  assert.match(link, /El enlace vence el 13 nov 2026, 10:30 a\.m\.\n/);
  assert.doesNotMatch(link, /\.\.\n/, 'sin punto doble');
  assert.match(link, /Pago de prueba: no se cobra nada real\.$/);
  const ok = copy.paymentConfirmed({
    name: 'Ana Pérez',
    reference: 'TC-AB12CD',
    course: 'Nutrición en perros y gatos',
    edition: 'Edición general',
  });
  assert.match(
    ok,
    /^✅ ¡Pago confirmado, Ana! Tu inscripción a Nutrición en perros y gatos · Edición general quedó lista\. Pedido TC-AB12CD\./,
  );
  assert.match(ok, /no se realizó ningún cobro real\.$/);
  assert.doesNotMatch(ok, /inscrito|inscrita/, 'sin suponer el género de la persona');
  assert.match(
    copy.paymentConfirmed({ name: '', reference: 'TC-1', course: 'C', edition: 'E', perSession: true }),
    /^✅ ¡Pago confirmado! .+ con plan por sesión: este pago cubre tu primera sesión/,
  );
  // lo demás
  assert.equal(
    copy.thanks('Ana', plain(full)),
    '¡Con gusto, Ana! Aquí sigo por si quieres ver el precio, las fechas o inscribirte.',
  );
  assert.match(
    copy.fallback(full),
    /precio, el temario o las fechas de Nutrición en perros y gatos\.\n\nSi prefieres que te responda una persona, escribe «asesor»/,
  );
  assert.match(copy.human('Ana'), /^¡Claro, Ana! Ya le avisé al equipo/);
  assert.match(copy.refund(''), /^Lamento mucho la molestia\. Ya pasé tu caso/);
  assert.match(copy.unavailable('Sin cupo disponible'), /no está disponible \(sin cupo disponible\)\./);
  // ninguno promete lo que el sistema no hace ni deja huecos de datos
  for (const ctx of [full, bare, promo])
    for (const t of all(ctx)) {
      assert.doesNotMatch(t, /undefined|null|NaN|\{\{(?!pedido)/, t);
      assert.doesNotMatch(t, /aparté tu lugar|lugar asegurado|pago recibido|garantiz/i, t);
      assert.ok(t.length < 900, t);
    }
});

// Estilo con emojis (docs/PLAN_MENSAJES_AMABLES.md, «Estilo»): por omisión, cada dato en su renglón con un emoji y su
// etiqueta, negritas de WhatsApp en el nombre del curso y en lo que hay que escribir, un solo siguiente paso; nunca más
// de un emoji por renglón, y ninguno en los mensajes serios.
test('estilo de los mensajes: con emojis por omisión, texto plano al apagarlo, y nunca en los mensajes serios', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  const card = copy.card(full);
  assert.match(card, /^\*Nutrición en perros y gatos · Edición general\*\n📅 Inicio: martes, 1 de diciembre/);
  assert.match(card, /\n🧑 Docente: MVZ Laura Ríos\n💻 Modalidad: En línea · Google Meet\n💳 Precio: \$449\.00 MXN\n/);
  for (const line of card.split('\n'))
    assert.ok((line.match(/\p{Extended_Pictographic}/gu) || []).length <= 1, 'un emoji por renglón: ' + line);
  const p = copy.price(full);
  assert.match(
    p,
    /^💳 El precio de \*Nutrición en perros y gatos · Edición general\* es de \$449\.00 MXN\.\n\n👉 Si quieres apartar tu lugar, escribe \*Quiero inscribirme\* y te mando tu enlace de pago\./,
  );
  assert.match(
    copy.syllabus(full),
    /^📚 Esto es lo que verás en \*Nutrición en perros y gatos\*:\n\n• Etapas de vida\n/,
  );
  assert.match(copy.schedule(full), /\n\n👉 ¿Quieres apartar tu lugar\? Escribe \*Quiero inscribirme\*\.$/);
  assert.match(copy.affirm(full), /^¡Perfecto! 👍 ¿Qué te cuento de \*Nutrición en perros y gatos\*\?$/);
  assert.match(copy.thanks('Ana', full), /^¡Con gusto, Ana! 😊 /);
  // cada parte en su párrafo: la pregunta del saludo, la ficha, el siguiente paso y la nota van separados por un renglón en blanco
  assert.match(
    copy.welcome(full, 'Ana Pérez'),
    /gatos\.\n\n¿Quieres conocer el temario, el precio o cómo inscribirte\?\n\n\*Nutrición en perros y gatos · Edición general\*\n📅 /,
  );
  assert.match(copy.price(full), /enlace de pago\.\n\n\(Precio de ejemplo/);
  assert.match(copy.fallback(full), /a la mano\.\n\nLo que sí puedo contarte[^\n]+\.\n\nSi prefieres/);
  assert.match(
    copy.thinking(full, 'Ana'),
    /tómate tu tiempo! 🙂\n\nSólo para que lo tengas en cuenta: [^\n]+\.\n\nSi te queda alguna duda[^\n]+\.\n\n👉 Cuando quieras seguir, escribe \*Quiero inscribirme\*\.$/,
  );
  assert.doesNotMatch(
    copy.welcome(
      { ...full, course: { ...full.course, welcome: 'Hola.\nBienvenida, {{nombre}}. ¿Vemos el curso?' } },
      'Ana',
    ),
    /\?\n\n\n/,
    'un saludo con sus propios saltos no se toca',
  );
  // apagado: viñetas, comillas y ningún emoji; el mismo contenido
  for (const t of [
    copy.card(plain(full)),
    copy.price(plain(full)),
    copy.syllabus(plain(full)),
    copy.schedule(plain(full)),
    copy.affirm(plain(full)),
    copy.thanks('Ana', plain(full)),
  ]) {
    assert.doesNotMatch(t, emoji, t);
    assert.doesNotMatch(t, /\*/, t);
  }
  assert.match(copy.price(plain(full)), /«Quiero inscribirme»/);
  // los mensajes serios no llevan emojis en ningún estilo
  for (const t of [
    copy.paidAck({ reference: 'TC-1', status: 'review' }),
    copy.payStatus('pending', { reference: 'TC-1' }),
    copy.refund('Ana'),
    copy.human('Ana'),
    copy.escalate,
    copy.offerHuman,
    copy.unavailable('Sin cupo'),
    copy.payLinkProblem('Ana'),
  ])
    assert.doesNotMatch(t, emoji, t);
});

// Tono vendedor (docs/PLAN_MENSAJES_VENDEDORA.md): el estilo de las consultoras, sólo con datos del catálogo y de
// Coordinación. Sin esos datos (sin sesiones, sin promoción, con cupo amplio) no inventa ningún renglón.
test('tono vendedor: gancho, promoción tachada, horario por sesión, cupo y «para asegurar tu lugar», sólo con datos', () => {
  const mx = (m, d, h) => Date.UTC(2026, m, d, h + 6, 0); // hora del centro de México
  const seller = {
    ...full,
    edition: { ...full.edition, available_seats: 3, price_cents: 44900, starts_at: mx(10, 30, 19) },
    promotion: { name: 'Pronto pago', ends_at: mx(10, 29, 23), price_cents: 37900 },
    priceCents: 37900,
    regularPriceCents: 44900,
    brand: { name: 'GlobalVet' },
    sessions: [
      { number: 1, starts_at: mx(10, 30, 19), duration_min: 120 },
      { number: 2, starts_at: mx(11, 1, 19), duration_min: 120 },
      { number: 3, starts_at: mx(11, 2, 19), duration_min: 120 },
    ],
    style: { emojis: true, tone: 'vendedor' },
  };
  const card = copy.card(seller);
  assert.match(card, /^🎓 \*¡NUTRICIÓN EN PERROS Y GATOS · EDICIÓN GENERAL!\*\n📅 Inicio: lunes, 30 de noviembre/);
  assert.match(card, /\n🔥 Precio promocional: \*\$379\.00 MXN\* ~\$449\.00 MXN~ · hasta el 29 de noviembre\n/);
  assert.match(
    card,
    /\n🗓️ Horario:\n• Lunes 30 de noviembre: 7:00 p\.m\. a 9:00 p\.m\.\n• Martes 1 de diciembre: 7:00 p\.m\. a 9:00 p\.m\.\n• Miércoles 2 de diciembre: 7:00 p\.m\. a 9:00 p\.m\.\n/,
  );
  assert.match(
    card,
    /\n\n🎈 Cupo limitado: quedan 3 lugares\.\n✅ ¡Estamos cerrando inscripciones!\n\n👉 Responde \*Quiero inscribirme\* para asegurar tu lugar\.\n\n/,
  );
  assert.ok(card.endsWith(copy.LAB_NOTE));
  // precio con promoción: bloque con el «antes» tachado, la vigencia y lo que incluye
  const p = copy.price(seller);
  assert.match(
    p,
    /^🔥 Promoción «Pronto pago»: \*\$379\.00 MXN\*\n~Antes: \$449\.00 MXN~\n⏳ Vigente hasta el 29 de noviembre\n\nIncluye 3 sesiones en vivo por Google Meet\.\n\n🎈 Cupo limitado/,
  );
  assert.match(p, /👉 Responde \*Quiero inscribirme\* para asegurar tu lugar y te mando tu enlace de pago\./);
  // temario numerado, fechas con el horario, «lo pienso» con cada dato en su renglón
  assert.match(copy.syllabus(seller), /\n\n1️⃣ Etapas de vida\n2️⃣ Evaluación nutricional\n- Casos de estudio\n/);
  assert.match(copy.schedule(seller), /\n🗓️ Horario:\n• Lunes 30 de noviembre/);
  assert.match(
    copy.thinking(seller, 'Ana', { seats: 3 }),
    /\n\nSólo para que lo tengas en cuenta:\n🔥 La promoción «Pronto pago» \(\$379\.00 MXN\) está vigente hasta el 29 de noviembre\n🎈 Quedan 3 lugares al momento de responderte\n\n/,
  );
  assert.match(
    copy.objection(seller, { sessions: 3 }),
    /\n~Antes: \$449\.00 MXN~\nLo que incluye ese precio: 3 sesiones/,
  );
  assert.match(copy.certDataAsk(seller), /^📝 Claro\. Escríbeme en un solo mensaje:\n✅ Tu nombre completo/);
  assert.match(copy.fallback(seller), /^🤔 Esa pregunta/);
  assert.match(
    copy.recommend(seller, [{ title: 'Aves', start: 'el 8 de diciembre', price: '$599.00 MXN' }], { multi: true }),
    /\n1️⃣ \*Aves\*\n {3}📅 Inicia el 8 de diciembre · 💳 \$599\.00 MXN\n/,
  );
  // sin datos no hay renglones: ni horario, ni cupo, ni «antes», ni cierre
  const thin = {
    ...full,
    edition: { ...full.edition, available_seats: 40 },
    sessions: [],
    style: { emojis: true, tone: 'vendedor' },
  };
  const bare = copy.card(thin);
  assert.doesNotMatch(bare, /Horario|Cupo|cerrando|Antes|~/);
  assert.match(bare, /^🎓 \*¡NUTRICIÓN EN PERROS Y GATOS · EDICIÓN GENERAL!\*\n📅 Inicio/);
  assert.match(bare, /\n💳 Precio: \$449\.00 MXN\n\n👉 Responde \*Quiero inscribirme\* para asegurar tu lugar\./);
  assert.doesNotMatch(copy.price(thin), /Incluye|~/);
  // con más de ocho sesiones se resume; el tono sereno no cambia nada de lo de antes
  const many = {
    ...seller,
    sessions: Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      starts_at: mx(10, 30 + i, 19),
      duration_min: 60,
    })),
  };
  assert.match(copy.schedule(many), /\n🗓️ Sesiones: 12, del lunes 30 de noviembre al viernes 11 de diciembre\n/);
  assert.doesNotMatch(copy.schedule(many), /Horario:/);
  const calm = { ...seller, style: { emojis: true, tone: 'sereno' } };
  assert.match(copy.card(calm), /^\*Nutrición en perros y gatos · Edición general\*\n📅 /);
  assert.doesNotMatch(copy.card(calm), /Cupo|cerrando|🎓 \*¡/);
  assert.match(copy.card(calm), /\n🗓️ Horario:\n/, 'el horario es dato: sale en los dos tonos');
  assert.match(
    copy.price(calm),
    /^💳 El precio de \*Nutrición[^\n]+\$379\.00 MXN con la promoción «Pronto pago», vigente hasta el 29 de noviembre\.\n~Antes: \$449\.00 MXN~\n\n👉 Si quieres apartar tu lugar/,
  );
  // texto plano en tono vendedor: sin emojis, sin negritas ni tachado, mismo contenido
  const plainSeller = { ...seller, style: { emojis: false, tone: 'vendedor' } };
  for (const t of [
    copy.card(plainSeller),
    copy.price(plainSeller),
    copy.syllabus(plainSeller),
    copy.thinking(plainSeller, 'Ana', { seats: 3 }),
  ]) {
    assert.doesNotMatch(t, /\p{Extended_Pictographic}/u, t);
    assert.doesNotMatch(t, /[*~]/, t);
  }
  assert.match(copy.card(plainSeller), /^¡NUTRICIÓN EN PERROS Y GATOS · EDICIÓN GENERAL!\n• Inicio/);
  assert.match(
    copy.card(plainSeller),
    /\n• Precio promocional: \$379\.00 MXN \$449\.00 MXN · hasta el 29 de noviembre\n/,
  );
  // un emoji por renglón también aquí
  for (const t of [card, p, copy.schedule(seller)])
    for (const line of t.split('\n'))
      assert.ok((line.match(/\p{Extended_Pictographic}/gu) || []).length <= 1, 'un emoji por renglón: ' + line);
});
