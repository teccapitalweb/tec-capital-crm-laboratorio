// Conectar un asistente con un clic (docs/PLAN_MCP_OAUTH.md): el CRM es su propio servidor de autorización OAuth 2.1
// para el conector MCP (/mcp).
//
//   mcp_oauth_clients   aplicaciones que se registraron solas (registro dinámico, RFC 7591). Sin secreto: son clientes
//                       públicos y prueban quiénes son con PKCE. Las que se presentan con su documento de metadatos no
//                       se guardan aquí (se descargan y se guardan en memoria).
//   mcp_oauth_requests  la pantalla de permiso abierta por una persona: a qué aplicación, a dónde regresa, el reto PKCE y la
//                       huella del código contra falsificación de la página (CSRF). Dura diez minutos.
//   mcp_oauth_grants    lo que la persona permitió: UNA marca, los permisos marcados, la aplicación y el recurso (/mcp).
//                       «Desconectar» la revoca. Es la fila que ve «Asistentes conectados».
//   mcp_oauth_codes     el código de un solo uso (60 segundos) que se canjea por las fichas; sólo su huella.
//   mcp_oauth_tokens    fichas de acceso (una hora) y de renovación (rotan en cada uso); sólo su huella.
//
// Ninguna tabla guarda una ficha, un código ni un secreto en claro, ni datos de clientes del negocio.
export default {
  name: 'mcp-oauth/0001-tables',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE mcp_oauth_clients(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        uri TEXT,
        redirect_uris TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE mcp_oauth_requests(
        id TEXT PRIMARY KEY,
        csrf_hash TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        client_id TEXT NOT NULL,
        client_kind TEXT NOT NULL CHECK(client_kind IN ('registered','document')),
        client_name TEXT NOT NULL,
        client_host TEXT,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        state TEXT,
        resource TEXT NOT NULL,
        requested_scope TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX mcp_oauth_requests_user ON mcp_oauth_requests(user_id, created_at);
      CREATE TABLE mcp_oauth_grants(
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        client_kind TEXT NOT NULL CHECK(client_kind IN ('registered','document')),
        client_name TEXT NOT NULL,
        client_host TEXT,
        redirect_uri TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        brand_id TEXT NOT NULL REFERENCES brands(id),
        scopes TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        revoked_by TEXT REFERENCES users(id),
        revoked_reason TEXT
      );
      CREATE INDEX mcp_oauth_grants_brand ON mcp_oauth_grants(brand_id, revoked_at);
      CREATE INDEX mcp_oauth_grants_user ON mcp_oauth_grants(user_id, revoked_at);
      CREATE INDEX mcp_oauth_grants_client ON mcp_oauth_grants(client_id);
      CREATE TABLE mcp_oauth_codes(
        code_hash TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id),
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE mcp_oauth_tokens(
        token_hash TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id),
        kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX mcp_oauth_tokens_grant ON mcp_oauth_tokens(grant_id);
      CREATE INDEX mcp_oauth_tokens_expiry ON mcp_oauth_tokens(expires_at);
    `);
  },
};
