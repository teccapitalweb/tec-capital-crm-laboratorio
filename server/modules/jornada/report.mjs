// Informe de la jornada (docs/PLAN_JORNADA_SIMULADA.md, «Informe»): los fallos agrupados con ejemplo y qué hacer, para
// convertirlos en conocimiento, en casos del banco de evaluación o en una corrección. Función pura sobre lo que la
// jornada ya tiene (alertas, conversaciones con su último mensaje, resultados por perfil del simulador).

const norm = v =>
  String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const ACTIONS = Object.freeze({
  knowledge: {
    label: 'Crear borrador de conocimiento',
    hint: 'Una respuesta por pregunta, para que una persona la complete y apruebe.',
  },
  evaluation: {
    label: 'Añadir al banco de evaluación',
    hint: 'Un caso con el mensaje del cliente y lo que debía pasar.',
  },
  review: { label: 'Revisar a mano', hint: 'Léelo en el chat y decide.' },
});

// alerts: [{kind, text, detail, conversationId, createdAt}]; conversations: [{id, name, persona, state, last}];
// byPersona: {persona: {total, done, waiting}} del simulador (opcional); stats: las cifras de la vista.
export function buildReport({ alerts = [], conversations = [], byPersona = {}, stats = {}, personaLabels = {} }) {
  const byConv = new Map(conversations.map(c => [c.id, c]));
  const groups = [];
  // 1) el asistente no supo: por pregunta (del detalle de la alerta sale la pregunta entre comillas)
  const noSupo = new Map();
  for (const a of alerts.filter(x => x.kind === 'no_supo')) {
    const q = /«(.+?)»/.exec(a.text)?.[1] || a.text;
    const key = norm(q);
    if (!noSupo.has(key)) noSupo.set(key, { question: q, examples: [] });
    noSupo
      .get(key)
      .examples.push({ conversationId: a.conversationId, name: byConv.get(a.conversationId)?.name || '', text: q });
  }
  for (const g of noSupo.values())
    groups.push({
      kind: 'no_supo',
      title: `«No la tengo a la mano» a: «${g.question}»`,
      count: g.examples.length,
      examples: g.examples.slice(0, 3),
      action: 'knowledge',
      payload: { question: g.question },
    });
  // 2) pasó a persona sin motivo claro: casos para el banco (debía contestar, no escalar)
  const paso = alerts.filter(x => x.kind === 'paso_sin_motivo');
  if (paso.length)
    groups.push({
      kind: 'paso_sin_motivo',
      title: 'Pasó a persona sin motivo claro',
      count: paso.length,
      examples: paso.slice(0, 3).map(a => ({
        conversationId: a.conversationId,
        name: byConv.get(a.conversationId)?.name || '',
        text: /después de «(.+?)»/.exec(a.detail)?.[1] || a.detail,
      })),
      action: 'evaluation',
      payload: {
        cases: paso.slice(0, 10).map(a => ({
          inputText: /después de «(.+?)»/.exec(a.detail)?.[1] || 'ok gracias',
          expectAction: 'replied',
          title: 'No pasar a persona por un «' + (/después de «(.+?)»/.exec(a.detail)?.[1] || 'ok') + '»',
        })),
      },
    });
  // 3) esperas: cuántas y la más larga
  const esperas = alerts.filter(x => ['sin_respuesta', 'persona_tarda'].includes(x.kind));
  if (esperas.length) {
    const mins = esperas.map(a => Number(/lleva (\d+) min/.exec(a.text)?.[1] || 0));
    groups.push({
      kind: 'esperas',
      title: `${esperas.length} ${esperas.length === 1 ? 'cliente esperó' : 'clientes esperaron'} más de la cuenta`,
      count: esperas.length,
      examples: esperas
        .slice(0, 3)
        .map(a => ({ conversationId: a.conversationId, name: byConv.get(a.conversationId)?.name || '', text: a.text })),
      action: 'review',
      detail: `La espera más larga fue de ${Math.max(0, ...mins)} min.`,
    });
  }
  // 4) molestos
  const molestos = alerts.filter(x => x.kind === 'molesto');
  if (molestos.length)
    groups.push({
      kind: 'molesto',
      title: 'Clientes molestos',
      count: molestos.length,
      examples: molestos.slice(0, 3).map(a => ({
        conversationId: a.conversationId,
        name: byConv.get(a.conversationId)?.name || '',
        text: a.detail,
      })),
      action: 'review',
    });
  // 5) terminaron sin respuesta (el último mensaje es del cliente y el chat no se cerró)
  const sinCerrar = conversations.filter(c => c.id && c.last?.kind === 'customer' && c.state !== 'closed');
  if (sinCerrar.length)
    groups.push({
      kind: 'sin_cerrar',
      title: 'Terminaron con un mensaje del cliente sin contestar',
      count: sinCerrar.length,
      examples: sinCerrar.slice(0, 3).map(c => ({ conversationId: c.id, name: c.name, text: c.last.text })),
      action: 'review',
    });
  // perfiles: cómo le fue a cada uno
  const personas = Object.entries(byPersona).map(([id, p]) => ({
    id,
    label: personaLabels[id] || id,
    total: p.total || 0,
    done: p.done || 0,
    waiting: p.waiting || 0,
  }));
  return {
    summary: {
      arrived: stats.arrived ?? 0,
      assistantOnly: stats.assistantOnly ?? 0,
      handled: stats.handled ?? 0,
      paid: stats.paid ?? 0,
      agentMedianMs: stats.agentMedianMs ?? null,
      alerts: alerts.length,
      problems: groups.reduce((n, g) => n + g.count, 0),
    },
    groups,
    personas,
    actions: ACTIONS,
  };
}
