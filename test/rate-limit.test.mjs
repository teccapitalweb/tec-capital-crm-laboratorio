import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../server/app/rate-limit.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const blocked = fn => assert.throws(fn, error => error.status === 429 && /Demasiados intentos/.test(error.message));

test('limitador: ventana fija por clave, y cada clave por separado', () => {
  let clock = 1000;
  const limiter = createRateLimiter({ fail, now: () => clock });
  for (let i = 0; i < 3; i++) limiter.rate('auth-user:ana', 3, 60000);
  blocked(() => limiter.rate('auth-user:ana', 3, 60000));
  limiter.rate('auth-user:luis', 3, 60000); // otra clave no se ve afectada
  clock += 59999;
  blocked(() => limiter.rate('auth-user:ana', 3, 60000));
  clock += 2; // terminó la ventana
  limiter.rate('auth-user:ana', 3, 60000);
  assert.equal(limiter.size, 2);
});

test('limitador lleno: no se borra ningún contador vivo; las claves nuevas se rechazan hasta que vence alguna', () => {
  let clock = 1000;
  const limiter = createRateLimiter({ fail, maxKeys: 5, now: () => clock });
  // La víctima agota sus intentos: queda bloqueada durante 15 minutos.
  for (let i = 0; i < 20; i++) limiter.rate('auth-user:victima', 20, 900000);
  blocked(() => limiter.rate('auth-user:victima', 20, 900000));
  // Alguien inunda el limitador con claves nuevas para intentar desalojar ese contador.
  for (let i = 0; i < 4; i++) limiter.rate('auth-user:relleno-' + i, 20, 900000);
  assert.equal(limiter.size, 5);
  for (let i = 0; i < 50; i++) blocked(() => limiter.rate('auth-user:otro-' + i, 20, 900000));
  assert.equal(limiter.size, 5, 'el tope se respeta');
  blocked(() => limiter.rate('auth-user:victima', 20, 900000)); // sigue bloqueada: su contador no se tocó
  limiter.rate('auth-user:relleno-0', 20, 900000); // quien ya tenía contador sigue contando con normalidad

  // Con claves de vida corta: cuando vencen, dejan sitio a las nuevas sin tocar las vivas.
  const mixed = createRateLimiter({ fail, maxKeys: 3, now: () => clock });
  mixed.rate('larga', 1, 900000);
  mixed.rate('corta-1', 1, 1000);
  mixed.rate('corta-2', 1, 1000);
  blocked(() => mixed.rate('nueva', 1, 1000));
  clock += 1500; // vencen las cortas
  mixed.rate('nueva', 1, 1000);
  assert.equal(mixed.size, 2, 'se retiraron las vencidas y entró la nueva');
  blocked(() => mixed.rate('larga', 1, 900000)); // la viva conserva su cuenta
  mixed.sweep(clock + 2000);
  assert.equal(mixed.size, 1);
});
