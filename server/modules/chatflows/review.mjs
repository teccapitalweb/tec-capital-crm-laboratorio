// Revisión de un recorrido con IA («Sugerencias»; docs/PLAN_RECORRIDOS.md, «Evaluación»).
//
// Lo único que sale hacia la IA es lo que arma `outlineOf`: los pasos del recorrido (tipo, título, el texto que
// escribió el equipo y a dónde lleva cada salida) y las cifras agregadas de cada paso (cuántas conversaciones
// llegaron, cuántas siguieron, cuántas se fueron y la mediana de respuesta). Nunca nombres, teléfonos, correos,
// conversaciones ni lo que escribió una persona: la analítica no los tiene y, por si alguien escribió un correo o un
// teléfono dentro de un mensaje del recorrido, se tapan antes de mandar nada.
//
// Lo que devuelve la IA es texto: se recorta, se liga sólo a pasos que existen y la pantalla lo muestra escapado. Las
// sugerencias no cambian nada: la persona decide.
import { nodeName, portsOf, readingOrder, typeOf } from '../../../public/kit/shared/flow-model.js';

export const REVIEW_KINDS = Object.freeze({
  length: 'Mensaje largo',
  dead_end: 'Sin salida',
  drop: 'Se pierde gente',
  handoff: 'Pasar con una persona',
  tone: 'Tono',
  clarity: 'Claridad',
  other: 'Otra',
});
const LONG_TEXT = 600;

// Tapa lo que parezca un dato de contacto dentro de un texto del recorrido.
export const mask = value =>
  String(value ?? '')
    .replace(/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}/g, '[correo]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[número]')
    .slice(0, 1000);

// Textos que escribe el equipo en cada tipo de paso (lo que lee la persona que recibe el recorrido).
function textsOf(node) {
  const d = node.data || {};
  switch (node.type) {
    case 'message':
      return (d.parts || []).filter(p => p.kind === 'text').map(p => p.text);
    case 'buttons':
      return [d.text, ...(d.options || []).map(o => 'Botón: ' + o.label)];
    case 'question':
      return [d.text, d.errorText ? 'Si no es válida: ' + d.errorText : ''];
    default:
      return [d.text];
  }
}

// El recorrido en la forma que se manda: pasos numerados en orden de lectura con sus cifras.
export function outlineOf(graph, stats = {}) {
  const order = readingOrder(graph).filter(id => graph.nodes.some(n => n.id === id && n.type !== 'note'));
  const number = new Map(order.map((id, i) => [id, i + 1]));
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const out = new Map(graph.edges.map(e => [e.from + '\n' + e.port, e.to]));
  return order.map(id => {
    const node = byId.get(id);
    const def = typeOf(node.type);
    const s = stats[id];
    return {
      step: number.get(id),
      id,
      typeId: node.type,
      type: def?.label || node.type,
      title: mask(node.title || nodeName(node)),
      texts: textsOf(node)
        .filter(t => typeof t === 'string' && t.trim())
        .map(mask),
      exits: portsOf(node).map(p => ({ label: p.label, to: number.get(out.get(id + '\n' + p.id)) ?? null })),
      ...(s
        ? {
            stats: {
              entered: s.entered,
              continued: s.completed,
              left: s.lost,
              medianResponseSeconds: s.medianResponseMs === undefined ? null : Math.round(s.medianResponseMs / 1000),
            },
          }
        : {}),
    };
  });
}

// Revisión por reglas: lo que se puede decir sin IA. Siempre se muestra, haya IA o no.
export function ruleSuggestions(outline) {
  const out = [];
  for (const step of outline) {
    const longest = Math.max(0, ...step.texts.map(t => t.length));
    if (longest > LONG_TEXT)
      out.push({
        nodeId: step.id,
        kind: 'length',
        text: `El paso ${step.step} tiene un mensaje de ${longest} caracteres: en el teléfono se lee mejor partido en dos o más corto.`,
      });
    if (step.stats && step.stats.entered >= 5 && step.stats.left / step.stats.entered >= 0.4)
      out.push({
        nodeId: step.id,
        kind: 'drop',
        text: `En el paso ${step.step} se va el ${Math.round((step.stats.left / step.stats.entered) * 100)} % de quienes llegan: revisa si la pregunta es clara o si conviene ofrecer pasar con una persona.`,
      });
  }
  if (outline.length > 1 && !outline.some(s => s.typeId === 'handoff'))
    out.push({
      nodeId: null,
      kind: 'handoff',
      text: 'El recorrido no tiene ningún paso «Pasar con una persona»: quien se atore no tiene a quién pedir ayuda.',
    });
  return out;
}

// Limpia lo que contestó la IA: hasta 8 sugerencias, de texto, ligadas sólo a pasos del recorrido.
export function cleanSuggestions(list, outline) {
  const byStep = new Map(outline.map(s => [s.step, s.id]));
  const ids = new Set(outline.map(s => s.id));
  return (Array.isArray(list) ? list : [])
    .filter(x => x && typeof x.texto === 'string' && x.texto.trim())
    .slice(0, 8)
    .map(x => {
      const nodeId = Number.isInteger(x.paso) ? byStep.get(x.paso) : ids.has(x.paso) ? x.paso : null;
      return {
        nodeId: nodeId ?? null,
        kind: Object.hasOwn(REVIEW_KINDS, x.tipo) ? x.tipo : 'other',
        text: x.texto.replace(/\s+/g, ' ').trim().slice(0, 400),
      };
    });
}
