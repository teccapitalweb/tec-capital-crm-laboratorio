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
  const card = copy.card(full);
  assert.match(card, /^Nutrición en perros y gatos · Edición general\n/);
  assert.match(card, /• Inicio: martes, 1 de diciembre de 2026, 7:00 p\.m\. \(hora del centro de México\)/);
  assert.match(card, /• Docente: MVZ Laura Ríos/);
  assert.match(card, /• Modalidad: En línea · Google Meet/);
  assert.match(card, /• Precio: \$449\.00 MXN/);
  assert.match(card, /Chat de prueba/);
  assert.doesNotMatch(card, /America\/Mexico_City/, 'la zona se dice en palabras');
  // sin datos: nada de «Por confirmar» sueltos ni renglones vacíos
  const empty = copy.card(bare);
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
  const p = copy.price(full);
  assert.match(p, /^El precio de Nutrición en perros y gatos · Edición general es de \$449\.00 MXN\./);
  assert.match(p, /«Quiero inscribirme»/);
  assert.match(p, /precio de ejemplo/i);
  assert.doesNotMatch(p, /promoci/i);
  assert.match(copy.price(promo), /\$399\.00 MXN con la promoción «Pronto pago», vigente hasta el 20 de noviembre\./);
  // temario en viñetas, respetando las que ya traía
  const s = copy.syllabus(full);
  assert.match(
    s,
    /^Esto es lo que verás en Nutrición en perros y gatos:\n\n• Etapas de vida\n• Evaluación nutricional\n- Casos de estudio\n\n/,
  );
  assert.match(s, /¿Te cuento el precio o las fechas\?$/);
  // fechas: con fecha invita a inscribirse; sin fecha lo dice y ofrece otra cosa
  const sch = copy.schedule(full);
  assert.match(sch, /• Inicio: martes, 1 de diciembre/);
  assert.match(sch, /• Docente: MVZ Laura Ríos/);
  assert.doesNotMatch(sch, /Precio/);
  assert.match(sch, /«Quiero inscribirme»\.$/);
  const sch0 = copy.schedule(bare);
  assert.match(sch0, /• Inicio: fecha por confirmar\n• Docente: por confirmar\n/);
  assert.match(sch0, /En cuanto se confirme la fecha te avisamos/);
  assert.doesNotMatch(sch0, /Quiero inscribirme/);
  // inscripción, pedido y pago
  assert.equal(copy.enrollWithOrder(full, 'Ana Pérez'), '¡Qué gusto, Ana! Ya tengo listo tu pedido:\n\n{{pedido}}');
  assert.match(copy.enrollWithAdvisor(full, ''), /^¡Qué gusto! Anoté tu interés en .+ Un asesor te escribe por aquí/);
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
    copy.thanks('Ana'),
    '¡Con gusto, Ana! Aquí sigo por si quieres ver el precio, las fechas o inscribirte.',
  );
  assert.match(copy.fallback(full), /precio, el temario o las fechas de Nutrición en perros y gatos\. .*«asesor»/);
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
