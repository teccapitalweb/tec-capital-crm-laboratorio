// Despachador del mensaje entrante (diseño de automatización §3.2 y §3.3; conciliación, filas 33 y N-0).
//
// Decide, cuando la persona escribe, quién atiende ese mensaje ANTES de que conteste el asistente de siempre. Corre
// dentro de la primera transacción del trabajo del asistente (`processJob` en server/index.mjs), después de las guardas
// de siempre: si el trabajo llegó hasta aquí es porque el asistente está a cargo, nadie del equipo tomó el chat y la
// conversación está abierta (prioridades 2 y 3 de la tabla «quién gana» ya se resolvieron al guardar el mensaje).
//
// Cada motor se registra con `register(name, {order, inbound})`; `inbound(c, m)` es síncrono, sin red y sin abrir
// transacción, y devuelve:
//   null / undefined                 no es suyo: sigue el siguiente motor y, al final, el asistente
//   {done: true}                     lo atendió (o lo descartó a propósito): el asistente no contesta este mensaje
//   {planOptions, decorate, after}   que conteste el asistente, con opciones para su plan (por ejemplo {noFlow:true}),
//                                    una función que ajusta el plan (volver a ofrecer los botones) y otra que corre en
//                                    la segunda transacción con el resultado (contar un desvío)
//   {error}                          falló; ya registró lo suyo y pasó la conversación a una persona: no contesta nadie
//
// Un fallo de un motor nunca impide guardar el mensaje (ya se guardó antes) ni deja a la persona sin respuesta: lo que
// el motor escribió se deshace con un SAVEPOINT, se llama a su `onError` (que pasa la conversación a una persona) y, si
// también eso falla, contesta el asistente como hoy.
//
// Un motor que declara `passOnError: true` y no tiene `onError` cede el turno si falla: lo suyo se deshace y sigue el
// siguiente motor del orden (no salta directo al asistente).
//
// Sin motores registrados (o sin recorridos publicados) devuelve siempre {} y el asistente contesta exactamente igual
// que antes.
//
// ORDEN DE ATENCIÓN (diseño de automatización §3.3; conciliación, filas 33 y N-3). Antes del despachador ya se
// resolvieron la baja, el comprobante con pedido vigente y «una persona atiende la conversación» (el trabajo ni
// siquiera llega aquí). Después, en este orden:
//   1. un recorrido en curso consume el mensaje            (chatflows; las reglas le ceden el turno)
//   2. reglas por mensaje, en el orden de su lista          (rules, ORDER.rules)
//   3. un recorrido publicado que arranca con el mensaje   (chatflows, ORDER.chatflows)
//   4. el asistente de la marca                            (fuera del despachador: replies.plan)
// Los pasos 1 y 3 los atiende el mismo motor (chatflows); las reglas van antes que él y le ceden el turno cuando hay
// un recorrido en curso, para que el orden sea exactamente el de arriba.
export const ORDER = Object.freeze({ rules: 30, chatflows: 40 });

export function createDispatcher({ db, log = console } = {}) {
  const engines = [];

  function register(name, { order = 100, inbound, onError = null, passOnError = false } = {}) {
    if (typeof name !== 'string' || !name) throw new TypeError('El motor necesita un nombre.');
    if (typeof inbound !== 'function') throw new TypeError(`El motor «${name}» necesita su función inbound.`);
    if (engines.some(e => e.name === name)) throw new TypeError(`El motor «${name}» ya está registrado.`);
    engines.push({ name, order, inbound, onError, passOnError: passOnError === true });
    engines.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  // Corre `fn` en un SAVEPOINT: si lanza, se deshace sólo lo suyo y la transacción de afuera sigue viva.
  function guarded(label, fn) {
    db.exec('SAVEPOINT dispatch_engine');
    try {
      const out = fn();
      db.exec('RELEASE dispatch_engine');
      return { ok: true, out };
    } catch (error) {
      db.exec('ROLLBACK TO dispatch_engine');
      db.exec('RELEASE dispatch_engine');
      log.error('Dispatch ' + label + ' failed', error?.name, String(error?.message || '').slice(0, 160));
      return { ok: false, error };
    }
  }

  // Dentro de la transacción del trabajo. `c` es la conversación ya revalidada; `m`, el mensaje de la persona.
  function inbound(c, m) {
    for (const engine of engines) {
      const run = guarded(engine.name, () => engine.inbound(c, m));
      if (run.ok) {
        if (run.out) return run.out;
        continue;
      }
      if (engine.onError) {
        const handled = guarded(engine.name + ' onError', () => engine.onError(c, m, run.error));
        if (handled.ok && handled.out) return { done: true, error: true };
      } else if (engine.passOnError) continue; // cede el turno al siguiente motor del orden
      // Sin quién lo atienda: contesta el asistente de siempre (nunca se queda mudo).
      return { engineFailed: engine.name };
    }
    return {};
  }

  return { register, inbound, engines: () => engines.map(e => e.name) };
}
