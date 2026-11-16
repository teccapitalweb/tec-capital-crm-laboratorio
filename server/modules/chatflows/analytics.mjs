// Rendimiento de un recorrido paso a paso (diseño de automatización §6.8; docs/PLAN_RECORRIDOS.md, «Evaluación»).
//
// Todo sale de lo que el motor ya anota: `chatflow_sessions` (cómo terminó cada conversación y en qué paso) y
// `chatflow_events` (cada paso al que entró y por qué salida siguió, cuándo se quedó esperando y cuándo contestó la
// persona). No hace falta registrar nada más. Sólo devuelve cifras agregadas por paso: ningún nombre, teléfono,
// conversación ni texto de lo que escribió alguien. Cada consulta lleva la marca primero.
import { flowResult } from '../../../public/kit/shared/flow-model.js';

const DAY = 86_400_000;
// Cómo terminó una conversación, en las cinco formas que pidió el dueño más «otro».
const ENDINGS = Object.freeze({
  completed: 'completed',
  assistant: 'completed',
  replaced: 'completed',
  handoff: 'handoff',
  human_takeover: 'human_takeover',
  closed: 'human_takeover',
  timeout: 'stopped_replying',
  window_closed: 'stopped_replying',
  left: 'left',
  opt_out: 'opt_out',
  error: 'error',
});
export const ENDING_LABELS = Object.freeze({
  completed: 'Terminó el recorrido',
  handoff: 'Pasó con una persona',
  human_takeover: 'Una persona tomó el chat',
  stopped_replying: 'Dejó de contestar',
  left: 'Escribió otra cosa y siguió el asistente',
  opt_out: 'Pidió no recibir más mensajes',
  error: 'Error',
  other: 'Otro (recorrido pausado, archivado o automatización apagada)',
});
// Terminar en un paso por estas razones es «irse ahí»: es lo que el resumen ordena de más débil a más fuerte.
const LOST = new Set(['timeout', 'window_closed', 'left', 'opt_out']);

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

// Periodo pedido: `days` (1 a 366) hasta `to`, o `from`/`to` en milisegundos. Por omisión, los últimos 30 días.
export function periodOf({ from, to, days }, now) {
  const end = Number.isFinite(to) && to > 0 ? to : now;
  const span = Number.isInteger(days) && days >= 1 && days <= 366 ? days * DAY : 30 * DAY;
  const start = Number.isFinite(from) && from >= 0 && from < end ? from : end - span;
  return { from: Math.max(start, end - 366 * DAY), to: end };
}

export function createAnalytics(db) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  // Filtro común: sesiones de ese recorrido que empezaron en el periodo y, si se pidió, de esa versión.
  const SCOPE =
    's.brand_id=? AND s.flow_id=? AND s.started_at>=? AND s.started_at<? AND (? IS NULL OR s.flow_version=?)';
  const args = (brandId, flowId, p, version) => [brandId, flowId, p.from, p.to, version, version];

  function compute(brandId, flowId, { version = null, period }) {
    const a = args(brandId, flowId, period, version);
    const nodes = {};
    const at = id => (nodes[id] ??= { entered: 0, completed: 0, dropped: 0, left: 0, handoff: 0, lost: 0, ports: {} });

    // Cómo terminaron, y dónde.
    const results = { completed: 0, handoff: 0, left: 0, dropped: 0, excluded: 0, inProgress: 0 };
    const endings = Object.fromEntries(Object.keys(ENDING_LABELS).map(k => [k, 0]));
    let started = 0;
    for (const row of all(
      `SELECT s.state,s.outcome,COALESCE(s.end_node_id,s.node_id) node,count(*) n FROM chatflow_sessions s WHERE ${SCOPE} GROUP BY 1,2,3`,
      ...a,
    )) {
      started += row.n;
      const result = row.state === 'ended' ? flowResult(row.outcome) : 'inProgress';
      results[result] += row.n;
      if (row.state !== 'ended') continue;
      endings[ENDINGS[row.outcome] || 'other'] += row.n;
      if (!row.node) continue;
      const n = at(row.node);
      if (result === 'dropped') n.dropped += row.n;
      if (result === 'left') n.left += row.n;
      if (result === 'handoff') n.handoff += row.n;
      if (LOST.has(row.outcome)) n.lost += row.n;
    }

    // Cuántas conversaciones llegaron a cada paso y cuántas siguieron (personas distintas, no repeticiones).
    for (const row of all(
      `SELECT e.node_id node,e.event,count(DISTINCT e.session_id) n FROM chatflow_events e JOIN chatflow_sessions s ON s.id=e.session_id
       WHERE e.brand_id=? AND e.flow_id=? AND e.event IN ('enter','exit') AND e.node_id IS NOT NULL AND ${SCOPE} GROUP BY 1,2`,
      brandId,
      flowId,
      ...a,
    )) {
      at(row.node)[row.event === 'enter' ? 'entered' : 'completed'] = row.n;
    }
    // Por qué salida siguió cada una (veces).
    for (const row of all(
      `SELECT e.node_id node,e.port,count(*) n FROM chatflow_events e JOIN chatflow_sessions s ON s.id=e.session_id
       WHERE e.brand_id=? AND e.flow_id=? AND e.event='exit' AND e.node_id IS NOT NULL AND e.port IS NOT NULL AND ${SCOPE} GROUP BY 1,2`,
      brandId,
      flowId,
      ...a,
    )) {
      at(row.node).ports[row.port] = row.n;
    }

    // Cuánto tarda la persona en contestar una pregunta o unos botones: del «se quedó esperando» a lo siguiente que
    // escribió en ese mismo paso (una respuesta válida o no). Las esperas de tiempo no cuentan.
    const waits = new Map();
    for (const row of all(
      `WITH ev AS (
         SELECT e.node_id node,e.event,e.created_at at,
           lag(e.event) OVER w prev_event,lag(e.node_id) OVER w prev_node,lag(e.created_at) OVER w prev_at,lag(e.detail) OVER w prev_detail
         FROM chatflow_events e JOIN chatflow_sessions s ON s.id=e.session_id
         WHERE e.brand_id=? AND e.flow_id=? AND e.event IN ('wait','input','miss') AND ${SCOPE}
         WINDOW w AS (PARTITION BY e.session_id ORDER BY e.seq))
       SELECT node,at-prev_at ms FROM ev
       WHERE event IN ('input','miss') AND prev_event='wait' AND prev_node=node AND prev_detail IN ('choice','question')
       LIMIT 20000`,
      brandId,
      flowId,
      ...a,
    )) {
      if (!waits.has(row.node)) waits.set(row.node, []);
      waits.get(row.node).push(Math.max(0, row.ms));
    }
    for (const [node, list] of waits) {
      const n = at(node);
      n.responses = list.length;
      n.medianResponseMs = median(list);
    }

    // Lo más débil primero: dónde se va más gente, en proporción a la que llegó.
    const weakest = Object.entries(nodes)
      .filter(([, n]) => n.lost > 0 && n.entered > 0)
      .map(([nodeId, n]) => ({ nodeId, lost: n.lost, entered: n.entered, rate: Math.min(1, n.lost / n.entered) }))
      .sort((x, y) => y.rate - x.rate || y.lost - x.lost || x.nodeId.localeCompare(y.nodeId))
      .slice(0, 5);

    return {
      version,
      period,
      sessions: { started, ...results },
      endings: Object.entries(endings).map(([key, n]) => ({ key, label: ENDING_LABELS[key], n })),
      nodes,
      weakest,
    };
  }

  // Versiones con sesiones en el recorrido (para elegir), de la más nueva a la más vieja.
  const versions = (brandId, flowId) =>
    all(
      'SELECT flow_version version,count(*) n FROM chatflow_sessions WHERE brand_id=? AND flow_id=? GROUP BY 1 ORDER BY 1 DESC',
      brandId,
      flowId,
    );

  return { compute, versions };
}
