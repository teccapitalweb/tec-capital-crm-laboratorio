/**
 * Sesiones de trabajo del asistente (docs/PLAN_ASISTENTE_EN_VIVO.md). Puro, sin DOM: lo usan la pantalla
 * «Asistente en vivo» y las pruebas del servidor.
 *
 * Una fila de actividad es lo que devuelve GET /api/mcp-activity (id creciente, `at`, `brandId`, `source.id`…).
 * Dos filas seguidas de la misma conexión y la misma marca pertenecen a la misma sesión si entre ellas pasaron menos de
 * `gapMs` (15 minutos por omisión). Las sesiones salen de la más reciente a la más antigua y, dentro de cada una, las
 * filas también de la más reciente a la más antigua (así la nueva aparece arriba).
 */
export const GAP_MS = 15 * 60_000;

const KIND = row => (row.outcome !== 'ok' ? 'deny' : row.kind === 'read' ? 'read' : row.entity ? 'create' : 'write');
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Qué clase de acción es cada fila: lee, crea algo (escritura con entidad), escribe sin entidad o la rechazaron. */
export function kindOf(row) {
  if (!row || typeof row !== 'object') return 'write';
  if (row.entity?.type === 'proposal' && row.outcome === 'ok') return 'propose';
  return KIND(row);
}

export function groupSessions(rows, { gapMs = GAP_MS } = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object')
    .slice()
    .sort((a, b) => num(a.at) - num(b.at) || num(a.id) - num(b.id)); // antiguo → nuevo para cortar por huecos
  const open = new Map(); // clave de conexión+marca → sesión abierta
  const sessions = [];
  for (const row of list) {
    const key = `${row.brandId}|${row.source?.id ?? 'anon'}`;
    const at = num(row.at);
    let s = open.get(key);
    if (!s || at - s.endedAt > gapMs) {
      s = {
        key: `${key}|${row.id}`,
        brandId: row.brandId,
        brandName: row.brandName ?? row.brandId,
        source: row.source ?? null,
        userName: row.userName ?? null,
        startedAt: at,
        endedAt: at,
        items: [],
        counts: { read: 0, create: 0, write: 0, propose: 0, deny: 0 },
      };
      open.set(key, s);
      sessions.push(s);
    }
    s.endedAt = at;
    s.items.push(row);
    s.counts[kindOf(row)] += 1;
  }
  for (const s of sessions) s.items.reverse();
  return sessions.sort((a, b) => b.endedAt - a.endedAt || b.startedAt - a.startedAt);
}

/** Totales de una lista de filas por clase de acción (para las cifras). */
export function countKinds(rows) {
  const counts = { total: 0, read: 0, create: 0, write: 0, propose: 0, deny: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    counts.total += 1;
    counts[kindOf(row)] += 1;
  }
  return counts;
}
