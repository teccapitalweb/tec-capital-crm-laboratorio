// Redacción de datos personales en texto de clientes (server/lib/redact.mjs): correos, teléfonos, números largos y enlaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactContact, redactPersonal } from '../server/lib/redact.mjs';

test('redactPersonal: sustituye correos, teléfonos, números largos y enlaces; deja el resto del texto', () => {
  assert.equal(redactPersonal('mi correo es ana.secreta@example.com gracias'), 'mi correo es [correo] gracias');
  assert.equal(redactPersonal('mi tel es 55 1234 5678'), 'mi tel es [teléfono]');
  assert.equal(redactPersonal('llámame al +52 (55) 1234-5678 por favor'), 'llámame al [teléfono] por favor');
  assert.equal(redactPersonal('mi referencia es 4532015112830366'), 'mi referencia es [teléfono]');
  assert.equal(
    redactPersonal('lo vi en https://ejemplo.test/promo?x=1 y en www.otro.test'),
    'lo vi en [enlace] y en [enlace]',
  );
  // lo que no es dato personal se queda: años, cantidades cortas, horas
  assert.equal(
    redactPersonal('¿el curso de 2026 dura 8 sesiones de 2 horas?'),
    '¿el curso de 2026 dura 8 sesiones de 2 horas?',
  );
  assert.equal(redactPersonal('  varios   espacios \n y saltos '), 'varios espacios y saltos');
  assert.equal(redactPersonal(null), '');
  assert.equal(redactPersonal('x'.repeat(300), 50).length, 50);
});

test('redactContact: para la IA oculta correos, teléfonos y números largos, y conserva enlaces, espacios y longitud', () => {
  assert.equal(
    redactContact('escríbeme al 55 1234 5678 o a ana@example.com\n\nvi https://ejemplo.test/promo'),
    'escríbeme al [teléfono] o a [correo]\n\nvi https://ejemplo.test/promo',
  );
  assert.equal(redactContact('¿cuesta 599 y son 8 sesiones en 2026?'), '¿cuesta 599 y son 8 sesiones en 2026?');
  assert.equal(redactContact('x'.repeat(300)).length, 300);
  assert.equal(redactContact(undefined), '');
});
