// Propuestas del asistente (docs/PLAN_MCP_CLAUDE.md, «Propuestas que aprueba una persona»): el conector de Claude deja
// una propuesta de una acción de una lista cerrada (publicar un recorrido, encender una secuencia…) y una persona del
// equipo la aprueba o la rechaza con un botón.
//
//   mcp_proposals   una propuesta: marca, acción, entidad (tipo e id) y su revisión en el momento de proponer, la nota
//                   del asistente (texto plano, sólo para mostrar), de dónde vino (llave de la API u OAuth, con su
//                   nombre y la persona dueña) y su estado. Una sola pendiente por acción y entidad (índice parcial).
//
// No guarda llaves, fichas ni datos de clientes: sólo el id de la llave o del permiso y su nombre visible. Índices para
// las consultas de server/modules/mcp-proposals/repo.mjs: pendientes por marca, historial por marca y fecha, lo de cada
// origen (lo que ve y retira el conector, y su tope), el vencimiento y la purga de las decididas a los 90 días.
export default {
  name: 'mcp-proposals/0001-proposals',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE mcp_proposals(
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_revision INTEGER NOT NULL,
        entity_name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        source_kind TEXT NOT NULL CHECK(source_kind IN ('key','oauth')),
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL DEFAULT '',
        proposed_by TEXT REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','approving','approved','rejected','withdrawn','expired','stale','failed')),
        error TEXT,
        decided_by TEXT REFERENCES users(id),
        decided_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX mcp_proposals_brand ON mcp_proposals(brand_id, status, created_at);
      CREATE UNIQUE INDEX mcp_proposals_one_open ON mcp_proposals(brand_id, action, entity_id)
        WHERE status IN ('pending','approving');
      CREATE INDEX mcp_proposals_history ON mcp_proposals(brand_id, updated_at);
      CREATE INDEX mcp_proposals_source ON mcp_proposals(brand_id, source_kind, source_id, created_at);
      CREATE INDEX mcp_proposals_due ON mcp_proposals(status, expires_at);
      CREATE INDEX mcp_proposals_decided ON mcp_proposals(updated_at)
        WHERE status NOT IN ('pending','approving');
    `);
  },
};
