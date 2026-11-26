// «Asistente en vivo» (docs/PLAN_ASISTENTE_EN_VIVO.md): la pantalla que muestra, al instante y ordenado por sesiones de
// trabajo, lo que hace el asistente conectado por el conector (qué leyó, qué dejó en borrador, qué propuso), con la
// tarjeta de lo que dejó y los botones de Propuestas a un toque. No guarda nada propio: lee la actividad
// (server/modules/mcp-activity) y las propuestas (server/modules/mcp-proposals) con la misma persona y las mismas reglas
// de marca, y la entidad real de cada acción (./preview.mjs). Aprobar o rechazar sigue siendo la ruta de Propuestas.
//
// Rutas (sólo con sesión del equipo; ver la actividad pide administrar las llaves de la marca, como «Asistentes conectados»):
//   GET /api/mcp-live?brand=&after=&limit=       actividad (plana; la pantalla la agrupa en sesiones con
//                                                public/kit/shared/live-sessions.js), cifras de las últimas 24 horas,
//                                                marcas, conexiones y propuestas (pendientes e historial)
//   GET /api/mcp-live/created?brand=              lo que dejó el asistente y sigue existiendo (una entrada por entidad)
//   GET /api/mcp-live/proposals?brand=            sólo las propuestas (tras un aviso mcp_proposals.changed)
//   GET /api/mcp-live/entity/:type/:id?brand=     lo que dejó una acción, leído de la base (404 si ya no existe)
// En vivo: mcp-activity emite «mcp_activity.recorded» {id} por cada herramienta que ejecuta el conector; la pantalla
// pide entonces sólo lo más nuevo (`after`).
import { createPreview } from './preview.mjs';

const DAY = 24 * 3600_000;
const TYPE = /^[a-z_]{2,30}$/;
const ENTITY = /^\/api\/mcp-live\/entity\/([a-z_]{2,30})\/([A-Za-z0-9_.:-]{1,100})$/;

export default {
  name: 'mcp-live',
  create(host) {
    const { db, fail, json, access } = host;
    const previews = createPreview(db);
    const activity = () => host.module('mcp-activity');
    const proposals = () => host.module('mcp-proposals');
    const brandOf = (user, url) => {
      const b = url?.searchParams.get('brand') || '';
      return b && b !== 'all' ? b : null;
    };

    // Cifras de las últimas 24 horas (no «hoy»: así no dependen de la zona horaria de cada marca).
    function summary(user, brand) {
      const a = activity();
      if (!a) return { allowed: false, items: [], next: null, brands: [], sources: [], last24h: null };
      const page = a.query(user, { brand, limit: '100', from: String(Date.now() - DAY) });
      // Lo de las últimas 24 h puede pasar de una página: se cuenta aparte, por páginas, con tope.
      let rows = page.items;
      let next = page.next;
      for (let i = 0; i < 9 && next; i++) {
        const more = a.query(user, { brand, limit: '100', from: String(Date.now() - DAY), before: String(next) });
        rows = rows.concat(more.items);
        next = more.next;
      }
      const last24h = { actions: rows.length, reads: 0, creates: 0, proposes: 0, denied: 0 };
      for (const r of rows) {
        if (r.outcome !== 'ok') last24h.denied++;
        else if (r.entity?.type === 'proposal') last24h.proposes++;
        else if (r.kind === 'read') last24h.reads++;
        else if (r.entity) last24h.creates++;
      }
      return { ...page, last24h };
    }

    async function handle(req, res, path, user, url) {
      // Sólo personas desde el CRM: una petición con llave o ficha no entra, aunque trajera cookie.
      if (req.headers?.authorization)
        throw fail(403, 'Esta pantalla sólo la ve una persona desde el CRM.', { code: 'session_required' });
      host.requireStaff(user);
      if (req.method !== 'GET') throw fail(405, 'Método no permitido.');
      const brand = brandOf(user, url);
      if (path === '/api/mcp-live') {
        const after = url.searchParams.get('after');
        const a = activity();
        if (after !== null) {
          if (!/^\d{1,15}$/.test(after)) throw fail(400, 'Cursor no válido.', { code: 'invalid' });
          const page = a ? a.query(user, { brand, after, limit: '100' }) : { allowed: false, items: [] };
          json(res, 200, { items: page.items, allowed: page.allowed });
          return true;
        }
        const base = summary(user, brand);
        let pending = [];
        let history = [];
        if (base.allowed && proposals()) {
          const o = await proposals().overview(user, brand);
          pending = o.pending;
          history = o.history;
        }
        json(res, 200, { ...base, proposals: { pending, history } });
        return true;
      }
      if (path === '/api/mcp-live/created') {
        const a = activity();
        const rows = a ? a.created(user, { brand, limit: 60 }) : [];
        const pending = proposals() ? (await proposals().overview(user, brand)).pending : [];
        const items = [];
        for (const r of rows) {
          const e = previews.preview(r.brand_id, r.entity_type, r.entity_id);
          if (!e) continue; // ya no existe o no se muestra
          const p = pending.find(x => x.entity?.id === r.entity_id && x.entity?.type !== 'proposal');
          items.push({
            brandId: r.brand_id,
            type: r.entity_type,
            id: r.entity_id,
            label: e.label,
            title: e.title,
            status: e.status,
            lastAt: r.last_at,
            touches: r.touches,
            screen: e.screen,
            proposalId: p?.id ?? null,
          });
        }
        json(res, 200, { items });
        return true;
      }
      if (path === '/api/mcp-live/proposals') {
        const o = proposals() ? await proposals().overview(user, brand) : { pending: [], history: [] };
        json(res, 200, { pending: o.pending, history: o.history });
        return true;
      }
      const m = ENTITY.exec(path);
      if (m) {
        if (!brand) throw fail(400, 'Falta la marca.', { code: 'invalid' });
        const allowed = access.brandIds(user, 'developer.keys.manage');
        if (!allowed.includes(brand)) throw fail(404, 'Marca no disponible.', { code: 'not_found' });
        if (!TYPE.test(m[1])) throw fail(400, 'Tipo no válido.', { code: 'invalid' });
        const found = previews.preview(brand, m[1], m[2]);
        if (!found) throw fail(404, 'Ya no existe en esta marca o no se puede mostrar.', { code: 'not_found' });
        json(res, 200, { entity: found });
        return true;
      }
      return false;
    }
    return { handle, preview: previews.preview };
  },
};
