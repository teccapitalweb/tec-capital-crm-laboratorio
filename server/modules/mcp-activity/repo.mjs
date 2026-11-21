// SQL de «Actividad del asistente» (docs/PLAN_MCP_CLAUDE.md). Toda lectura lleva la lista de marcas permitidas como
// primer criterio. La tabla sólo tiene claves cerradas e ids: los nombres (llave, aplicación, persona, marca) se
// buscan al mostrarla.
const DAY = 24 * 3600_000;
export const KEEP_MS = 90 * DAY;
export const PAGE_MAX = 100;
// Purga: trozos de 500 filas, en bucle hasta que no quede nada vencido, con un tope por vuelta (trozos y tiempo) para
// no bloquear el servidor; lo que quede sale en la vuelta siguiente del reloj (cada hora). 200 trozos = 100 000 filas
// por vuelta, muy por encima de lo que deja entrar el límite de llamadas del conector.
export const PURGE = Object.freeze({ chunk: 500, maxChunks: 200, budgetMs: 250 });

export function createRepo(db) {
  const insert = db.prepare(
    'INSERT INTO mcp_activity(brand_id,source,key_id,grant_id,user_id,tool,kind,outcome,reason,entity_type,entity_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const purge = db.prepare(
    'DELETE FROM mcp_activity WHERE id IN (SELECT id FROM mcp_activity WHERE created_at<? ORDER BY created_at LIMIT ?)',
  );
  const marks = list => list.map(() => '?').join(',');
  return {
    insert: r =>
      insert.run(
        r.brandId,
        r.source,
        r.keyId,
        r.grantId,
        r.userId,
        r.tool,
        r.kind,
        r.outcome,
        r.reason,
        r.entityType,
        r.entityId,
        r.at,
      ),
    // Borra un trozo de lo de más de 90 días; devuelve cuántas filas borró.
    purge: (at, limit = PURGE.chunk) => purge.run(at - KEEP_MS, limit).changes,
    // Una página de la actividad de esas marcas, de la más reciente a la más antigua (cursor: el id).
    list(
      brandIds,
      {
        brandId = null,
        keyId = null,
        grantId = null,
        writes = false,
        problems = false,
        from = null,
        to = null,
        before = null,
        limit = 50,
      } = {},
    ) {
      if (!brandIds.length) return [];
      const where = [`a.brand_id IN (${marks(brandIds)})`],
        args = [...brandIds];
      const add = (sql, ...v) => {
        where.push(sql);
        args.push(...v);
      };
      if (brandId) add('a.brand_id=?', brandId);
      if (keyId) add('a.key_id=?', keyId);
      if (grantId) add('a.grant_id=?', grantId);
      if (writes) where.push("a.kind='write'");
      if (problems) where.push("a.outcome!='ok'");
      if (from !== null) add('a.created_at>=?', from);
      if (to !== null) add('a.created_at<?', to);
      if (before !== null) add('a.id<?', before);
      return db
        .prepare(
          `SELECT a.*,b.name brand_name,u.name user_name,k.name key_name,k.status key_status,g.client_name grant_name,g.revoked_at grant_revoked_at
           FROM mcp_activity a JOIN brands b ON b.id=a.brand_id LEFT JOIN users u ON u.id=a.user_id
           LEFT JOIN api_keys k ON k.id=a.key_id LEFT JOIN mcp_oauth_grants g ON g.id=a.grant_id
           WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`,
        )
        .all(...args, Math.min(PAGE_MAX, Math.max(1, limit)) + 1);
    },
    // Quiénes pueden aparecer en la actividad de esas marcas: sus llaves de la API y sus asistentes conectados.
    sources(brandIds) {
      if (!brandIds.length) return { keys: [], grants: [] };
      const keys = db
        .prepare(
          `SELECT k.id,k.name,k.brand_id,k.status,b.name brand_name FROM api_keys k JOIN brands b ON b.id=k.brand_id WHERE k.brand_id IN (${marks(brandIds)}) ORDER BY k.status='active' DESC,k.created_at DESC LIMIT 200`,
        )
        .all(...brandIds);
      const grants = db
        .prepare(
          `SELECT g.id,g.client_name name,g.brand_id,g.revoked_at,b.name brand_name FROM mcp_oauth_grants g JOIN brands b ON b.id=g.brand_id WHERE g.brand_id IN (${marks(brandIds)}) ORDER BY g.revoked_at IS NULL DESC,g.created_at DESC LIMIT 200`,
        )
        .all(...brandIds);
      return { keys, grants };
    },
  };
}
