// Errores HTTP: un solo constructor (`fail`) y una sola forma de respuesta para toda la aplicación.
//
//   { "error": "Texto claro para la persona", "code": "stale_record", "field": "phone", "details": { "limit": 500 } }
//
// `error` va siempre. Lo demás, sólo cuando quien lanza el error lo declara:
//   - code:    clave estable para que el programa que llama decida qué hacer, en minúsculas con guion bajo
//              (stale_record, not_found, window_closed). El texto de `error` puede cambiar de redacción; el `code` no.
//   - field:   el dato de la entrada que causó el error («phone», «to.phone»).
//   - details: datos breves que ayudan a resolverlo. Nunca secretos, datos personales ni texto de mensajes.
//
//   throw fail(409, 'Otra persona cambió este contacto. Vuelve a abrirlo.', { code: 'stale_record' });
//
// Lo que se lanza sin `status` es un fallo inesperado: responde 500 con un texto fijo y no revela qué ocurrió.

const CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const EXTRAS = ['code', 'field', 'details'];
const UNEXPECTED = 'No se pudo completar la operación. Vuelve a intentarlo.';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Copia que seguro se puede escribir como JSON, o `null` si el valor no lo permite (referencias circulares, BigInt).
function jsonCopy(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

// Error previsto, con su código HTTP. Un `code`, `field` o `details` mal escrito es un fallo de quien programa y
// lanza un TypeError en el acto, para que lo descubra la primera prueba y no un cliente.
export function fail(status, message, extra) {
  const error = Object.assign(new Error(message), { status });
  if (extra === undefined || extra === null) return error;
  if (!isObject(extra)) throw new TypeError('fail(): el tercer parámetro es { code, field, details }.');
  const unknown = Object.keys(extra).find(key => !EXTRAS.includes(key));
  if (unknown) throw new TypeError(`fail(): «${unknown}» no se admite; lo que no sea code ni field va en details.`);
  const { code, field, details } = extra;
  if (code !== undefined) {
    if (typeof code !== 'string' || code.length > 60 || !CODE.test(code))
      throw new TypeError('fail(): «code» va en minúsculas con guion bajo, por ejemplo stale_record.');
    error.code = code;
  }
  if (field !== undefined) {
    if (typeof field !== 'string' || !field || field.length > 100)
      throw new TypeError('fail(): «field» es el nombre del dato de entrada que causó el error.');
    error.field = field;
  }
  if (details !== undefined) {
    if (!isObject(details) || !jsonCopy(details))
      throw new TypeError('fail(): «details» debe ser un objeto que se pueda escribir como JSON.');
    error.details = details;
  }
  return error;
}

// Cuerpo JSON de la respuesta de un error, lo lance quien lo lance. `activeOpportunityId` es un campo que el CRM
// ya devolvía antes de existir `details` y se conserva tal cual.
export function errorBody(error) {
  if (!error?.status) return { error: UNEXPECTED };
  const details = isObject(error.details) ? jsonCopy(error.details) : null;
  return {
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(typeof error.field === 'string' && error.field ? { field: error.field } : {}),
    ...(details ? { details } : {}),
    ...(error.activeOpportunityId ? { activeOpportunityId: error.activeOpportunityId } : {}),
  };
}
