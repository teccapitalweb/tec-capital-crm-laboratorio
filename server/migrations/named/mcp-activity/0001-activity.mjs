// Actividad del asistente (docs/PLAN_MCP_CLAUDE.md, «Actividad del asistente»): una fila por cada herramienta que el
// conector (/mcp) ejecutó, llegue con una llave de la API o con el permiso de un asistente conectado con OAuth.
//
//   mcp_activity   marca; quién llamó (la llave o el permiso, por su id; el nombre se busca al mostrarla) y la persona
//                  que creó la llave o autorizó al asistente; la herramienta (null si pidió una que no existe), si
//                  consulta o escribe, el resultado (ok, rechazada, inválida, error) con una clave cerrada del motivo,
//                  la entidad que la propia herramienta audita (tipo e id) y la fecha.
//
// Nunca guarda los argumentos ni la respuesta de la herramienta, ni texto que venga del asistente o de clientes: sólo
// claves cerradas e ids. Se purga a los 90 días. Índices para las consultas de server/modules/mcp-activity/repo.mjs:
// por marca, por conexión (llave o permiso), «sólo escrituras», «sólo rechazadas» y la purga por fecha.
export default {
  name: 'mcp-activity/0001-activity',
  after: [], // tabla propia; sólo referencia tablas de la escalera
  up(db) {
    db.exec(`
      CREATE TABLE mcp_activity(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        source TEXT NOT NULL CHECK(source IN ('key','oauth')),
        key_id TEXT,
        grant_id TEXT,
        user_id TEXT,
        tool TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('read','write','unknown')),
        outcome TEXT NOT NULL CHECK(outcome IN ('ok','rejected','invalid','error')),
        reason TEXT,
        entity_type TEXT,
        entity_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX mcp_activity_brand ON mcp_activity(brand_id,id);
      CREATE INDEX mcp_activity_key ON mcp_activity(key_id,id) WHERE key_id IS NOT NULL;
      CREATE INDEX mcp_activity_grant ON mcp_activity(grant_id,id) WHERE grant_id IS NOT NULL;
      CREATE INDEX mcp_activity_created ON mcp_activity(created_at);
      CREATE INDEX mcp_activity_writes ON mcp_activity(brand_id,id) WHERE kind='write';
      CREATE INDEX mcp_activity_problems ON mcp_activity(brand_id,id) WHERE outcome!='ok';`);
  },
};
