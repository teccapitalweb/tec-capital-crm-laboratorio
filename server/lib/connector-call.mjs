// Marca de una petición que hace el conector de Claude a una ruta del CRM en el mismo proceso
// (server/lib/mcp-call.mjs y server/lib/mcp-drafts.mjs; docs/PLAN_MCP_CLAUDE.md).
//
// La marca va en el objeto de la petición con un Symbol propio de este archivo: no se puede escribir desde un JSON, así
// que ni el cuerpo ni la URL ni las cabeceras de quien llama la ponen o la quitan, y una petición que llega por HTTP
// nunca la trae. Un módulo la lee con fromConnector(req) para no hacer lo que el conector no debe provocar; hoy, que el
// simulador de recorridos consulte a la IA de pago (gastaría el tope mensual de todo el CRM).
const CONNECTOR = Symbol('petición del conector de Claude');

export function markConnector(req) {
  Object.defineProperty(req, CONNECTOR, { value: true });
  return req;
}

export const fromConnector = req => Boolean(req) && req[CONNECTOR] === true;
