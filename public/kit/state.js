/**
 * Almacén mínimo, uno por pantalla (o por componente).
 *
 * Por qué existe: las pantallas actuales comparten un objeto `state` global que cualquiera modifica y
 * vuelven a pintar a mano en cada sitio. Aquí el estado es de la pantalla, se cambia sólo con set() y
 * quien pinta se entera una vez por tanda de cambios, no una vez por cambio.
 *
 * No toca el DOM: se puede usar y probar en Node.
 */

/**
 * @template {object} T
 * @param {T} initial
 */
export function createStore(initial) {
  let state = Object.freeze({ ...initial });
  let notified = state; // el estado que vieron los suscriptores la última vez
  let scheduled = false;
  let destroyed = false;
  const listeners = new Set();

  function flush() {
    scheduled = false;
    if (destroyed || state === notified) return;
    const before = notified;
    notified = state;
    for (const listener of [...listeners]) {
      try {
        listener(state, before);
      } catch (error) {
        // Un suscriptor roto no deja a los demás sin pintar.
        console.error(error);
      }
    }
  }

  return {
    /** El estado actual. Está congelado: se cambia con set(), nunca asignando sus propiedades. */
    get: () => state,

    /**
     * Mezcla `patch` (un objeto o una función que lo calcula a partir del estado). Varias llamadas seguidas
     * avisan una sola vez, al terminar la tarea en curso; si nada cambió de verdad, no avisa.
     * @param {Partial<T> | ((state: T) => Partial<T> | null | undefined)} patch
     */
    set(patch) {
      if (destroyed) return;
      const change = typeof patch === 'function' ? patch(state) : patch;
      if (!change) return;
      if (Object.keys(change).every(key => Object.is(state[key], change[key]))) return;
      state = Object.freeze({ ...state, ...change });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },

    /**
     * Avisa a `listener(estado, anterior)` tras cada tanda de cambios. Con `{now: true}` lo llama además de
     * inmediato, para el primer pintado. Devuelve la función que cancela la suscripción.
     * @param {(state: T, previous: T) => void} listener
     */
    subscribe(listener, { now = false } = {}) {
      listeners.add(listener);
      if (now) listener(state, state);
      return () => listeners.delete(listener);
    },

    /** Avisa ya de los cambios pendientes, sin esperar (para pruebas o antes de medir el DOM). */
    flush,

    /** Deja de avisar y suelta a los suscriptores. Se llama al salir de la pantalla. */
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  };
}
