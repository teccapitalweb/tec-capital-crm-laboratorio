// SQL de «Conectar un asistente con un clic» (docs/PLAN_MCP_OAUTH.md). Sólo huellas: ninguna ficha ni código en claro.
// Las consultas de permisos concedidos llevan la marca como primer criterio cuando hay marca.
export function createRepo(db) {
  const q = {
    clientById: db.prepare('SELECT * FROM mcp_oauth_clients WHERE id=?'),
    clientCount: db.prepare('SELECT count(*) n FROM mcp_oauth_clients'),
    clientInsert: db.prepare('INSERT INTO mcp_oauth_clients(id,name,uri,redirect_uris,created_at) VALUES(?,?,?,?,?)'),
    clientUsed: db.prepare('UPDATE mcp_oauth_clients SET last_used_at=? WHERE id=?'),
    requestInsert: db.prepare(
      'INSERT INTO mcp_oauth_requests(id,csrf_hash,user_id,client_id,client_kind,client_name,client_host,redirect_uri,code_challenge,state,resource,requested_scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ),
    requestById: db.prepare('SELECT * FROM mcp_oauth_requests WHERE id=?'),
    requestDelete: db.prepare('DELETE FROM mcp_oauth_requests WHERE id=?'),
    requestTrim: db.prepare(
      'DELETE FROM mcp_oauth_requests WHERE user_id=? AND id NOT IN (SELECT id FROM mcp_oauth_requests WHERE user_id=? ORDER BY created_at DESC LIMIT ?)',
    ),
    grantInsert: db.prepare(
      'INSERT INTO mcp_oauth_grants(id,client_id,client_kind,client_name,client_host,redirect_uri,user_id,brand_id,scopes,resource,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ),
    grantById: db.prepare('SELECT * FROM mcp_oauth_grants WHERE id=?'),
    grantsActiveOfUser: db.prepare('SELECT count(*) n FROM mcp_oauth_grants WHERE user_id=? AND revoked_at IS NULL'),
    grantRevoke: db.prepare(
      'UPDATE mcp_oauth_grants SET revoked_at=?,revoked_by=?,revoked_reason=? WHERE id=? AND revoked_at IS NULL',
    ),
    grantUsed: db.prepare('UPDATE mcp_oauth_grants SET last_used_at=? WHERE id=?'),
    tokensOfGrantDelete: db.prepare('DELETE FROM mcp_oauth_tokens WHERE grant_id=?'),
    codesOfGrantSpend: db.prepare('UPDATE mcp_oauth_codes SET used_at=coalesce(used_at,?) WHERE grant_id=?'),
    codeInsert: db.prepare(
      'INSERT INTO mcp_oauth_codes(code_hash,grant_id,client_id,redirect_uri,code_challenge,resource,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
    ),
    codeByHash: db.prepare('SELECT * FROM mcp_oauth_codes WHERE code_hash=?'),
    codeSpend: db.prepare('UPDATE mcp_oauth_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL'),
    tokenInsert: db.prepare(
      'INSERT INTO mcp_oauth_tokens(token_hash,grant_id,kind,created_at,expires_at) VALUES(?,?,?,?,?)',
    ),
    tokenByHash: db.prepare('SELECT * FROM mcp_oauth_tokens WHERE token_hash=?'),
    tokenSpend: db.prepare('UPDATE mcp_oauth_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL'),
  };
  const sweeps = {
    requests: db.prepare(
      'DELETE FROM mcp_oauth_requests WHERE id IN (SELECT id FROM mcp_oauth_requests WHERE expires_at<? LIMIT 500)',
    ),
    codes: db.prepare(
      'DELETE FROM mcp_oauth_codes WHERE code_hash IN (SELECT code_hash FROM mcp_oauth_codes WHERE expires_at<? LIMIT 500)',
    ),
    tokens: db.prepare(
      'DELETE FROM mcp_oauth_tokens WHERE token_hash IN (SELECT token_hash FROM mcp_oauth_tokens WHERE expires_at<? LIMIT 500)',
    ),
    // Aplicaciones registradas que nunca obtuvieron un permiso: se van al día.
    clients: db.prepare(
      'DELETE FROM mcp_oauth_clients WHERE id IN (SELECT c.id FROM mcp_oauth_clients c WHERE c.created_at<? AND NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id=c.id) AND NOT EXISTS (SELECT 1 FROM mcp_oauth_requests r WHERE r.client_id=c.id) LIMIT 500)',
    ),
  };
  const LIST =
    'SELECT g.*,u.name user_name,b.name brand_name FROM mcp_oauth_grants g JOIN users u ON u.id=g.user_id JOIN brands b ON b.id=g.brand_id WHERE g.revoked_at IS NULL';
  return {
    ...q,
    // Conexiones vivas de esas marcas (administración) o sólo las propias (los demás).
    listForBrands(brandIds) {
      if (!brandIds.length) return [];
      return db
        .prepare(
          LIST + ` AND g.brand_id IN (${brandIds.map(() => '?').join(',')}) ORDER BY g.created_at DESC LIMIT 200`,
        )
        .all(...brandIds);
    },
    listForUser(userId) {
      return db.prepare(LIST + ' AND g.user_id=? ORDER BY g.created_at DESC LIMIT 200').all(userId);
    },
    sweep(at, { requestsBefore, codesBefore, tokensBefore, clientsBefore }) {
      return (
        sweeps.requests.run(requestsBefore ?? at).changes +
        sweeps.codes.run(codesBefore ?? at).changes +
        sweeps.tokens.run(tokensBefore ?? at).changes +
        sweeps.clients.run(clientsBefore).changes
      );
    },
  };
}
