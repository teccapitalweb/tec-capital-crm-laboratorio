// Actividad del asistente (docs/PLAN_MCP_CLAUDE.md, «Actividad del asistente»). Qué hizo cada asistente conectado al CRM:
//  · record(): el conector (server/mcp.mjs, en call()) deja UNA fila por cada herramienta que ejecuta, salga bien o no,
//    llegue con una llave de la API (tcw_) o con el permiso de un asistente conectado con OAuth. Sólo claves cerradas e
//    ids: ni los argumentos ni la respuesta, ni texto del asistente o de clientes. Si no puede escribir, lo dice en la
//    consola del servidor y la herramienta responde igual.
//  · GET /api/mcp-activity: con la sesión del equipo, sólo de las marcas donde la persona administra las llaves y los
//    asistentes (la misma regla que la lista de conexiones de mcp-oauth). El conector no tiene ninguna herramienta para
//    leer ni borrar este registro.
//  · Se purga a los 90 días, por trozos, con un reloj.
import { TOOLS } from '../../mcp.mjs';
import { SCOPES } from '../../integrations.mjs';
import { ENTITY_LABELS, REASONS, TOOL_LABELS, reasonOf } from '../../lib/mcp-activity-labels.mjs';
import { KEEP_MS, PAGE_MAX, createRepo } from './repo.mjs';

// Ver la actividad es de quien administra las llaves y los asistentes de esa marca.
const ADMIN_PERMISSION = 'developer.keys.manage';
const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const ACTION = /^mcp\.([a-z_]{2,30})\.[a-z_]{2,30}$/;

const toolLabel = tool =>
  TOOL_LABELS[tool.name] || (tool.annotations.readOnlyHint ? 'Consultó: ' : 'Usó: ') + tool.annotations.title;

export default {
  name: 'mcp-activity',
  timers: [{ name: 'purga', everyMs: 3_600_000, testEveryMs: 60_000, run: api => api.purge() }],
  create(host) {
    const { db, fail, json, access } = host;
    const repo = createRepo(db);
    const now = () => Date.now();

    // ---- registro (lo llama el conector)
    // key: la llave o el permiso con forma de llave; tool: la herramienta de TOOLS (null si no existe); error: el error
    // con su código HTTP (null si salió bien); scopeDenied: le faltaba el permiso de la herramienta; audited: las
    // acciones de auditoría [acción, id] que la herramienta dejó.
    function record({ key, tool = null, error = null, scopeDenied = false, audited = [] }) {
      try {
        const id = String(key?.id ?? '');
        const oauth = id.startsWith('oauth:');
        const known = tool && BY_NAME.get(tool.name) === tool ? tool : null;
        const reason = error ? reasonOf(error.status, { scope: scopeDenied }) : known ? null : 'unknown_tool';
        const entity = audited
          .map(([action, entityId]) => [ACTION.exec(String(action))?.[1], entityId])
          .find(([type, entityId]) => Object.hasOwn(ENTITY_LABELS, type ?? '') && ID.test(String(entityId ?? '')));
        repo.insert({
          brandId: key.brand_id,
          source: oauth ? 'oauth' : 'key',
          keyId: oauth ? null : id,
          grantId: oauth ? id.slice(6) : null,
          userId: key.created_by ?? null,
          tool: known?.name ?? null,
          kind: known ? (known.annotations.readOnlyHint ? 'read' : 'write') : 'unknown',
          outcome: reason ? REASONS[reason].outcome : 'ok',
          reason,
          entityType: entity?.[0] ?? null,
          entityId: entity ? String(entity[1]) : null,
          at: now(),
        });
      } catch (e) {
        console.error('mcp-activity: no se pudo registrar la llamada', e?.message);
      }
    }

    // ---- lectura (pantalla «Asistentes conectados» → Actividad)
    function textOf(row, tool) {
      if (!row.reason) return tool ? toolLabel(tool) : 'Usó una herramienta';
      const reason = REASONS[row.reason] || REASONS.rejected;
      return reason.text.replace('{permiso}', tool?.scope ? SCOPES[tool.scope] || tool.scope : 'necesario');
    }
    const view = row => {
      const tool = row.tool ? BY_NAME.get(row.tool) : null;
      return {
        id: row.id,
        at: row.created_at,
        brandId: row.brand_id,
        brandName: row.brand_name,
        source:
          row.source === 'oauth'
            ? {
                kind: 'oauth',
                id: 'oauth:' + row.grant_id,
                name: row.grant_name || 'Asistente conectado',
                active: Boolean(row.grant_name) && !row.grant_revoked_at,
              }
            : {
                kind: 'key',
                id: 'key:' + row.key_id,
                name: row.key_name || 'Llave de la API',
                active: row.key_status === 'active',
              },
        userName: row.user_name || null,
        tool: row.tool,
        kind: row.kind,
        outcome: row.outcome,
        reason: row.reason,
        text: textOf(row, tool),
        detail: row.reason && tool ? 'Herramienta: ' + tool.annotations.title : null,
        entity: row.entity_type
          ? { type: row.entity_type, label: ENTITY_LABELS[row.entity_type] || row.entity_type, id: row.entity_id }
          : null,
      };
    };
    const int = v => (v !== null && /^\d{1,15}$/.test(v) ? Number(v) : null);

    async function handle(req, res, path, user, url) {
      host.requireStaff(user);
      if (path !== '/api/mcp-activity') return false;
      if (req.method !== 'GET') throw fail(405, 'Método no permitido.');
      const allowed = access.brandIds(user, ADMIN_PERMISSION);
      const q = url.searchParams;
      const brandId = q.get('brand') || null;
      if (brandId && !allowed.includes(brandId)) throw fail(404, 'Marca no disponible.', { code: 'not_found' });
      const source = q.get('source') || '';
      const m = /^(key|oauth):([A-Za-z0-9_-]{1,80})$/.exec(source);
      if (source && !m) throw fail(400, 'Conexión no válida.', { code: 'invalid' });
      const limit = Math.min(PAGE_MAX, int(q.get('limit')) || 50);
      const rows = repo.list(allowed, {
        brandId,
        keyId: m?.[1] === 'key' ? m[2] : null,
        grantId: m?.[1] === 'oauth' ? m[2] : null,
        writes: q.get('writes') === '1',
        problems: q.get('problems') === '1',
        from: int(q.get('from')),
        to: int(q.get('to')),
        before: int(q.get('before')),
        limit,
      });
      const page = rows.slice(0, limit);
      const { keys, grants } = repo.sources(allowed);
      const names = Object.fromEntries(
        db
          .prepare('SELECT id,name FROM brands')
          .all()
          .map(b => [b.id, b.name]),
      );
      json(res, 200, {
        allowed: allowed.length > 0,
        retentionDays: Math.round(KEEP_MS / (24 * 3600_000)),
        brands: allowed.map(id => ({ id, name: names[id] || id })),
        sources: [
          ...grants.map(g => ({
            id: 'oauth:' + g.id,
            kind: 'oauth',
            name: g.name,
            brandId: g.brand_id,
            brandName: g.brand_name,
            active: !g.revoked_at,
          })),
          ...keys.map(k => ({
            id: 'key:' + k.id,
            kind: 'key',
            name: k.name,
            brandId: k.brand_id,
            brandName: k.brand_name,
            active: k.status === 'active',
          })),
        ],
        items: page.map(view),
        next: rows.length > limit ? page.at(-1).id : null,
      });
      return true;
    }

    const purge = () => repo.purge(now());
    return { handle, record, purge };
  },
};
