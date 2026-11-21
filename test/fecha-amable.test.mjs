// {{fecha}} y las demás fechas que lee el cliente (segunda prueba real del 21 nov 2026): salían como
// «23 nov 2026, 7:00 p.m. · America/Mexico_City». Ahora usan la redacción de la ficha del asistente
// (server/reply-copy.mjs: whenText), con la zona en palabras y sin hora si sólo se sabe el día. Sin servidor: la
// interpolación de recorridos, reglas, accesos y textos de Contenido pasa por templateValues (server/catalogue.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillTemplate, shortTimeText, templateValues } from '../server/catalogue.mjs';
import { startText, whenText, zoneWords } from '../server/reply-copy.mjs';

const seven = Date.UTC(2026, 10, 24, 1, 0); // lunes 23 nov 2026, 7:00 p.m. en Ciudad de México
const midnight = Date.UTC(2026, 10, 23, 6, 0); // lunes 23 nov 2026, 00:00 en Ciudad de México
const ctx = (over = {}) => ({
  course: { title: 'Plan sanitario para aves', syllabus: 'Temario' },
  edition: {
    name: 'Noviembre',
    starts_at: seven,
    timezone: 'America/Mexico_City',
    instructor: 'MVZ de prueba',
    modality: 'online',
    currency: 'MXN',
    price_cents: 120000,
    available_seats: 10,
    info_url: '',
    ...over.edition,
  },
  promotion: over.promotion ?? null,
  brand: { name: 'GlobalVet' },
  priceCents: 120000,
  currency: 'MXN',
  dateLabel: over.dateLabel ?? 'sin usar',
});

test('{{fecha}} y {{vigencia}} con la redacción de la ficha del asistente, nunca con la zona técnica', () => {
  const v = templateValues(ctx(), 'Ana');
  assert.equal(v.fecha, 'lunes, 23 de noviembre de 2026, 7:00 p.m. (hora del centro de México)');
  assert.equal(v.fecha, startText(ctx().edition), 'la misma que la ficha del asistente');
  assert.doesNotMatch(v.fecha, /America\//);
  assert.equal(
    fillTemplate('Empieza el {{fecha}}.', v),
    'Empieza el lunes, 23 de noviembre de 2026, 7:00 p.m. (hora del centro de México).',
  );
  // sólo se sabe el día: sin «12:00 a.m.» y sin zona
  assert.equal(
    templateValues(ctx({ edition: { starts_at: midnight } }), 'Ana').fecha,
    'lunes, 23 de noviembre de 2026',
  );
  // sin fecha: lo de siempre
  assert.equal(
    templateValues(ctx({ edition: { starts_at: null }, dateLabel: 'Por confirmar' }), 'Ana').fecha,
    'Por confirmar',
  );
  // vigencia de una promoción, igual de amable
  const promo = templateValues(ctx({ promotion: { name: 'Preventa', ends_at: seven } }), 'Ana');
  assert.equal(promo.vigencia, 'lunes, 23 de noviembre de 2026, 7:00 p.m. (hora del centro de México)');
  // una zona fuera de la lista se dice por su ciudad, no con su identificador
  assert.equal(zoneWords('America/Guatemala'), 'hora de Guatemala');
  assert.equal(zoneWords('America/Argentina/Buenos_Aires'), 'hora de Buenos Aires');
  assert.match(whenText(seven, 'America/Guatemala'), /\(hora de Guatemala\)$/);
  // el flyer generado usa la versión corta, también sin la zona técnica
  assert.match(
    shortTimeText(seven, 'America/Mexico_City'),
    /^23 nov 2026, 7:00 p\.\s?m\. \(hora del centro de México\)$/,
  );
  assert.doesNotMatch(shortTimeText(seven, 'America/Mexico_City'), /America\//);
});

test('zonas UTC y Etc/* con su desfase real; una zona o una fecha no válidas no tumban la respuesta', () => {
  // en «Etc/GMT+6» el signo va al revés (POSIX): es UTC−6
  assert.equal(zoneWords('Etc/GMT+6'), 'UTC−6');
  assert.equal(zoneWords('Etc/GMT-3'), 'UTC+3');
  assert.equal(zoneWords('UTC'), 'UTC');
  assert.equal(zoneWords('Etc/UTC'), 'UTC');
  assert.equal(zoneWords('GMT'), 'UTC');
  assert.match(whenText(seven, 'Etc/GMT+6'), /, 7:00 p\.\s?m\. \(UTC−6\)$/);
  // zona que no existe: se dice en UTC, sin lanzar
  assert.match(whenText(seven, 'Marte/Olimpo'), /\(UTC\)$/);
  assert.match(templateValues(ctx({ edition: { timezone: 'Marte/Olimpo' } }), 'Ana').fecha, /\(UTC\)$/);
  assert.equal(shortTimeText(seven, 'Marte/Olimpo'), 'Por confirmar');
  // fecha no válida: «Por confirmar» (o sin fecha en la ficha), sin lanzar
  assert.equal(whenText(Number.NaN, 'America/Mexico_City'), null);
  assert.equal(whenText(8.64e15 + 1, 'America/Mexico_City'), null);
  assert.equal(templateValues(ctx({ edition: { starts_at: 'no-es-fecha' } }), 'Ana').fecha, 'Por confirmar');
  assert.equal(startText({ starts_at: Number.NaN, timezone: 'America/Mexico_City' }), null);
  assert.equal(shortTimeText('x', 'America/Mexico_City'), 'Por confirmar');
});
