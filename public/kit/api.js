/**
 * Peticiones a la API del CRM.
 *
 * Mismo contrato que api() de public/app.js (JSON de ida y vuelta, cookie de sesión del mismo origen y un
 * error con `status` y `code` cuando el servidor responde {error, code}), más tres cosas que las pantallas
 * nuevas necesitan y hoy se hacen a mano o no se hacen:
 * - abortar lo que está en vuelo al salir de la pantalla;
 * - una referencia de cliente (clientRef) por acción, que se reutiliza si se reintenta;
 * - enviar la revisión esperada (expectedRevision) al editar algo que otra persona pudo cambiar.
 *
 * No usa el DOM: se puede probar en Node con un fetch de mentira.
 */

/** Error de la API. `message` es el texto del servidor, ya en español y listo para mostrarse. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, data?: any, requestId?: string}} [details]
   */
  constructor(message, { status = 0, code = '', data = null, requestId = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    /** Estado HTTP; 0 si la petición no llegó al servidor. */
    this.status = status;
    /** Código estable para decidir en código: 'STALE_RECORD', 'DUPLICATE'… ('' si no hay). */
    this.code = code;
    /** El cuerpo completo de la respuesta, por si trae más datos (el registro actual, un id…). */
    this.data = data;
    this.requestId = requestId;
  }
}

/** ¿La petición se canceló (por ejemplo, al salir de la pantalla)? Eso no es un fallo que mostrar. */
export const isAbort = error => error?.name === 'AbortError';

/** ¿Otra persona cambió el registro desde que se cargó? Hay que recargarlo sin tirar el borrador. */
export const isStale = error => error instanceof ApiError && error.status === 409 && error.code === 'STALE_RECORD';

/** Referencia única de una acción (un clic en «Guardar»). El servidor la usa para no repetir el cambio. */
export const newClientRef = () => globalThis.crypto.randomUUID();

/**
 * Añade la revisión esperada a los cambios de un registro con `revision`.
 *   api.patch(`/api/contacts/${id}`, withRevision({ name }, contacto))
 * @param {object} changes
 * @param {number | {revision: number}} record
 */
export function withRevision(changes, record) {
  const revision = typeof record === 'object' && record !== null ? record.revision : record;
  if (!Number.isSafeInteger(revision))
    throw new TypeError('withRevision() necesita la revisión del registro que se editó.');
  return { ...changes, expectedRevision: revision };
}

/** Una señal que se aborta cuando lo hace cualquiera de las dadas. */
function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (list.length <= 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function withQuery(path, query) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    // Listas como «a,b» (columnas) y objetos como JSON (filtros): las dos formas que ya usa la API.
    if (Array.isArray(value)) params.set(name, value.join(','));
    else params.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const text = params.toString();
  return text ? `${path}${path.includes('?') ? '&' : '?'}${text}` : path;
}

/** Cuerpos que se envían tal cual (un CSV, un archivo); todo lo demás viaja como JSON. */
const isRawBody = body =>
  typeof body === 'string' ||
  (typeof Blob === 'function' && body instanceof Blob) ||
  (typeof FormData === 'function' && body instanceof FormData) ||
  body instanceof ArrayBuffer ||
  ArrayBuffer.isView(body);

/**
 * Crea un cliente de la API con su propia señal de cancelación.
 *
 *   const api = createApi();
 *   const { contacts, nextCursor } = await api.get('/api/contacts', { brand, cursor });
 *   await api.patch(`/api/contacts/${id}`, withRevision({ name }, contacto));
 *   api.abort();   // al salir de la pantalla: cancela lo que esté en vuelo
 *
 * En una pantalla no hace falta crearlo: `ctx.api` ya es uno, y se aborta solo al desmontarla.
 *
 * @param {{fetch?: typeof fetch}} [options] `fetch` permite pruebas y pantallas de ejemplo sin servidor.
 */
export function createApi({ fetch: customFetch } = {}) {
  const controller = new AbortController();

  /**
   * @param {string} path Ruta del mismo origen: '/api/…'.
   * @param {{method?: string, body?: any, query?: object, headers?: object, signal?: AbortSignal}} [options]
   */
  async function api(path, { method = 'GET', body, query, headers = {}, signal } = {}) {
    const raw = body !== undefined && isRawBody(body);
    const init = {
      method,
      credentials: 'same-origin',
      headers: raw || body === undefined ? { ...headers } : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: anySignal([controller.signal, signal]),
    };
    // Con la señal ya abortada (se salió de la pantalla) ni siquiera se intenta.
    init.signal.throwIfAborted();

    let response;
    try {
      response = await (customFetch ?? globalThis.fetch)(withQuery(path, query), init);
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiError('No hay conexión con el servidor. Revisa tu red y vuelve a intentarlo.', { code: 'NETWORK' });
    }

    const text = response.status === 204 ? '' : await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Una respuesta que no es JSON (por ejemplo, la página de error de un proxy) se trata como fallo sin detalle.
      }
    }
    if (!response.ok) {
      throw new ApiError(data?.error || 'Ocurrió un error.', {
        status: response.status,
        code: data?.code || '',
        data,
        requestId: data?.requestId || response.headers?.get?.('x-request-id') || '',
      });
    }
    return data;
  }

  api.get = (path, query, options) => api(path, { ...options, query });
  api.post = (path, body, options) => api(path, { ...options, method: 'POST', body });
  api.put = (path, body, options) => api(path, { ...options, method: 'PUT', body });
  api.patch = (path, body, options) => api(path, { ...options, method: 'PATCH', body });
  api.delete = (path, body, options) => api(path, { ...options, method: 'DELETE', body });
  /** Cancela lo que esté en vuelo y rechaza lo que se pida después. */
  api.abort = () => controller.abort();
  /** Señal del cliente, para atar a ella otras esperas (temporizadores, suscripciones). */
  api.signal = controller.signal;
  return api;
}

/**
 * Envoltura de una acción que cambia datos. Le da un clientRef y lo REUTILIZA mientras el intento no
 * termine bien y los datos sean los mismos: si la respuesta se perdió y la persona vuelve a pulsar, el
 * servidor reconoce la misma acción y no la repite. Con datos distintos es otra acción y lleva otra
 * referencia. Un segundo clic mientras el primero sigue en vuelo recibe la misma promesa.
 *
 *   const guardar = mutation((clientRef, cambios) => api.post('/api/contacts', { ...cambios, clientRef }));
 *   await guardar.run({ name, phone });
 *
 * @template T
 * @param {(clientRef: string, ...args: any[]) => Promise<T>} send
 */
export function mutation(send) {
  let ref = null;
  let fingerprint = null;
  let flight = null;

  return {
    /** ¿Hay un envío en curso? */
    get pending() {
      return flight !== null;
    },
    /** La referencia del intento pendiente de confirmar, o null. */
    get clientRef() {
      return ref;
    },
    /** @returns {Promise<T>} */
    run(...args) {
      if (flight) return flight;
      const print = JSON.stringify(args);
      if (ref === null || print !== fingerprint) {
        ref = newClientRef();
        fingerprint = print;
      }
      const mine = ref;
      flight = (async () => {
        try {
          const result = await send(mine, ...args);
          if (ref === mine) ref = null; // confirmado: la siguiente acción es otra
          return result;
        } finally {
          flight = null;
        }
      })();
      return flight;
    },
    /** Olvida la referencia (la persona descartó el intento). */
    reset() {
      ref = null;
      fingerprint = null;
    },
  };
}
