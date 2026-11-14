// Limitador de intentos en memoria: ventana fija por clave («auth:<dirección>», «auth-user:<usuario>»…).
//
// Tiene un tope de claves para que nadie pueda agotar la memoria generándolas. Al llegar al tope se retiran sólo
// las claves VENCIDAS; un contador vivo no se borra nunca, porque borrarlo sería regalarle intentos nuevos a quien
// ya agotó los suyos (bastaría inundar el limitador con claves para saltarse el límite de otra cuenta). Si después
// de retirar las vencidas no cabe una clave nueva, esa petición se rechaza: las que ya tienen contador siguen igual.
const MESSAGE = 'Demasiados intentos. Espera un momento y vuelve a probar.';

export function createRateLimiter({ fail, maxKeys = 100000, now = Date.now }) {
  const limits = new Map();
  let lastSweep = 0;

  // Retira las claves cuya ventana ya terminó.
  function sweep(at = now()) {
    lastSweep = at;
    for (const [key, item] of limits) if (item.end < at) limits.delete(key);
  }

  // Cuenta un intento de `key`; lanza 429 si supera `max` dentro de la ventana (en milisegundos).
  function rate(key, max, window = 60000) {
    const at = now();
    let item = limits.get(key);
    if (!item || item.end < at) {
      if (!item && limits.size >= maxKeys) {
        if (at - lastSweep >= 1000) sweep(at); // como mucho una pasada completa por segundo
        if (limits.size >= maxKeys) throw fail(429, MESSAGE);
      }
      item = { count: 0, end: at + window };
      limits.set(key, item);
    }
    if (++item.count > max) throw fail(429, MESSAGE);
  }

  return {
    rate,
    sweep,
    get size() {
      return limits.size;
    },
  };
}
