// Apagado ordenado (docs/PLAN_RECEPCION_DURADERA.md). Tres pasos con un único plazo para todos (graceMs):
//   1) stopIntake()        dejar de aceptar trabajo: conexiones nuevas y relojes.
//   2) inFlight            esperar a que termine lo que ya estaba en vuelo (cada elemento, una función → promesa).
//   3) closeConnections()  cerrar lo que siga abierto y esperar a que se cierre; después finish() y exit(0).
// Nunca tarda más que el plazo, nunca se ejecuta dos veces y siempre termina saliendo, aunque un paso falle.

// SHUTDOWN_GRACE_MS: cuánto se espera, como mucho, a lo que está en vuelo. Por omisión 1 500 ms; tope, un minuto.
export function shutdownGraceMs(env = process.env) {
  const raw = String(env.SHUTDOWN_GRACE_MS ?? '').trim();
  const value = raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.min(60_000, value) : 1500;
}

// ¿La promesa terminó (bien o mal) antes de `ms`?
function within(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(
      () => true,
      () => true,
    ),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createShutdown({
  graceMs = 1500,
  stopIntake = () => {},
  inFlight = [],
  closeConnections = () => {},
  finish = () => {},
  exit = code => process.exit(code),
  now = Date.now,
  log = console,
}) {
  let running = null;
  async function run() {
    const deadline = now() + graceMs;
    const left = () => Math.max(0, deadline - now());
    const guarded = (name, work) => {
      try {
        return work();
      } catch (error) {
        log.error('Apagado: no se pudo ' + name + ':', error?.name ?? error);
        return undefined;
      }
    };
    guarded('dejar de aceptar trabajo', stopIntake);
    const drained = await within(
      guarded('esperar lo que estaba en vuelo', () => Promise.all(inFlight.map(wait => wait()))),
      left(),
    );
    if (!drained) log.warn('Apagado: quedó trabajo en vuelo al cumplirse el plazo de ' + graceMs + ' ms.');
    const closed = await within(guarded('cerrar las conexiones', closeConnections), left());
    guarded('cerrar', () => finish({ drained, closed }));
    exit(0);
    return { drained, closed };
  }
  // La segunda señal no empieza otro apagado: devuelve el que ya está en curso.
  return function shutdown() {
    running ??= run();
    return running;
  };
}
