// Puente de sólo lectura para el conector de Claude (server/lib/mcp-insights.mjs; docs/PLAN_MCP_CLAUDE.md).
//
// El conector se crea antes que los módulos y no recibe todos los servicios del servidor. La lista «Preparar marca»
// (server/readiness.mjs) que ve la pantalla incluye los pasos que registran los módulos (modo real, accesos del
// curso…), y esos sólo los tiene la instancia del servidor. Este módulo presta ESA lectura, y nada más: no tiene rutas
// propias (su prefijo /api/mcp-bridge no atiende nada) ni escribe.
export default {
  name: 'mcp-bridge',
  create(host) {
    return Object.freeze({
      // La tarjeta de «Preparar marca» de una marca ({id, name}), igual que GET /api/readiness.
      readiness(brand) {
        const service = host.services?.readiness;
        if (typeof service?.forBrand !== 'function') throw host.fail(503, 'Preparar marca no está disponible.');
        return service.forBrand(brand);
      },
    });
  },
};
