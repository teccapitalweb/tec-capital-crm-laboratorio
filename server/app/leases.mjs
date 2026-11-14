// Piezas comunes de las colas con arrendamiento (docs/PLAN_RECEPCION_DURADERA.md).
//
// El patrón, igual en todas: una fila pendiente se RECLAMA antes de trabajarla (dueño y vencimiento); mientras el
// arrendamiento está vigente nadie más la toma, y el resultado sólo lo anota quien lo conserva. Si el proceso muere a
// la mitad, el arrendamiento vence y la fila vuelve a estar disponible.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ¿La tabla ya tiene esa columna? Para el código que debe funcionar también sobre una base sin las columnas de
// arrendamiento (pruebas que construyen sólo una parte del esquema).
export function hasColumn(db, table, column) {
  if (!IDENTIFIER.test(table) || !IDENTIFIER.test(column)) throw new Error(`Nombre no válido: ${table}.${column}`);
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some(info => info.name === column);
}

// Texto de un error apto para guardarse o registrarse: una línea, sin caracteres de control, acotado.
export const safeError = error =>
  String(error?.message || error)
    .replace(/[\x00-\x1f]+/g, ' ')
    .slice(0, 200);

// Espera el resultado de una promesa como mucho `ms`. Al vencer rechaza con un error transitorio; el trabajo de fondo
// no se puede cancelar, así que quien llama debe tolerar que termine después (por eso todo efecto es idempotente).
// El temporizador no mantiene vivo al proceso por sí solo.
export function withTimeout(promise, ms, message = 'Tiempo de espera agotado.') {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { transient: true })), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}
