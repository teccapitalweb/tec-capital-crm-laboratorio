// Llamar a una ruta del CRM en el mismo proceso, como lo haría la pantalla, desde el conector de Claude
// (server/lib/mcp-insights.mjs y server/lib/mcp-config.mjs). Sólo las rutas de una lista CERRADA: lo que no está en
// ella no se puede pedir, aunque una herramienta lo intentara. La entrada la arma cada herramienta campo por campo.
//
// `services` son los servicios del servidor actual que el conector ya recibe (hoy, sólo el catálogo) y se tratan como
// un módulo más por su nombre; `module(name)` devuelve la API de un módulo nuevo (server/modules/) al usarla.
import { Readable } from 'node:stream';
import { fail } from '../app/http.mjs';
import { markConnector } from './connector-call.mjs';

export const FEW = 'menos de 3';
// Regla de «menos de 3»: una cifra de personas (o de cosas que equivalen a personas: pedidos, ventas, conversaciones)
// que en un desglose por algo que no sea el tiempo describe a 1 o 2 se devuelve como «menos de 3». Cero se muestra.
export const people = n => (Number.isFinite(n) && n > 0 && n < 3 ? FEW : n);
export const few = n => Number.isFinite(n) && n > 0 && n < 3;

export function createRouteCaller({ routes, module, services = {} }) {
  const allowed = (name, method, path) =>
    typeof path === 'string' && routes.some(([n, m, re]) => n === name && m === method && re.test(path));
  const api = name => {
    const found = Object.hasOwn(services, name) ? services[name] : typeof module === 'function' ? module(name) : null;
    if (!found || typeof found.handle !== 'function')
      throw fail(503, 'Esa parte del CRM no está disponible ahora. Inténtalo más tarde.');
    return found;
  };
  async function call(user, name, method, path, input, query = null) {
    if (!allowed(name, method, path)) throw fail(403, 'Esa acción no está disponible desde el conector.');
    const chunks = input === undefined ? [] : [Buffer.from(JSON.stringify(input))];
    const url = new URL('http://mcp.local' + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    // Marcada como del conector (server/lib/connector-call.mjs): el módulo sabe que no debe consultar a la IA de pago.
    const req = markConnector(
      Object.assign(Readable.from(chunks), { method, url: url.pathname + url.search, headers: {} }),
    );
    let status = 0,
      payload = null;
    const res = {
      setHeader() {},
      writeHead(s) {
        status = s;
      },
      end(d) {
        payload = d ? JSON.parse(d) : null;
      },
    };
    const handled = await api(name).handle(req, res, path, user, url);
    if (handled === false) throw fail(404, 'Esa acción no está disponible.');
    if (status >= 400)
      throw fail(
        status,
        payload?.error || 'El CRM rechazó la petición.',
        payload?.details ? { details: payload.details } : undefined,
      );
    return payload;
  }
  return { call, allowed, api };
}
