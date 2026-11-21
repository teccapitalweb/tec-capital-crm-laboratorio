// Subir la imagen de un curso desde el conector de Claude (docs/PLAN_MCP_CLAUDE.md, «Subir la imagen de un curso»).
// Un modelo no puede mandar los bytes de una imagen en los argumentos de una herramienta: la herramienta
// preparar_subida_imagen deja una dirección de subida de UN solo uso y de corta vida, y la imagen llega después por esa
// dirección (server/modules/mcp-uploads).
//
//   mcp_upload_tokens   una dirección de subida: marca, apertura, de dónde vino (llave de la API u OAuth) y quién la
//                       firmó, la HUELLA de la ficha (nunca la ficha), cuándo vence, su estado (abierta → usada → lista
//                       o fallida) y, al terminar, el archivo y la imagen (flyer) en borrador que dejó. Con eso un
//                       borrador nuevo de la misma apertura sustituye al anterior del conector en lugar de apilarlos.
//
// No guarda la ficha, llaves ni datos de clientes. Índices para las consultas de server/modules/mcp-uploads/repo.mjs:
// la huella (única), las abiertas por origen y por marca (sus topes), las de una apertura (para sustituir el borrador),
// las subidas del día por marca (su tope) y la limpieza de las viejas.
export default {
  name: 'mcp-uploads/0001-upload-tokens',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE mcp_upload_tokens(
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        -- la apertura a la que va la imagen; vacía si va a un curso en borrador del conector (0002, course_draft_id)
        edition_id TEXT REFERENCES editions(id),
        token_hash TEXT NOT NULL UNIQUE,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('key','oauth')),
        source_id TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','used','done','failed')),
        error TEXT,
        file_id TEXT,
        flyer_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX mcp_upload_tokens_source ON mcp_upload_tokens(source_kind, source_id, status, expires_at);
      CREATE INDEX mcp_upload_tokens_brand ON mcp_upload_tokens(brand_id, status, expires_at);
      CREATE INDEX mcp_upload_tokens_edition ON mcp_upload_tokens(edition_id, status);
      CREATE INDEX mcp_upload_tokens_used ON mcp_upload_tokens(brand_id, used_at);
      CREATE INDEX mcp_upload_tokens_age ON mcp_upload_tokens(created_at);
    `);
  },
};
