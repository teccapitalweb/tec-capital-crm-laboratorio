// «Lo que se enviará a los clientes» en la tarjeta de una propuesta (docs/PLAN_MCP_CLAUDE.md, «Propuestas que aprueba
// una persona»). Lo arma el servidor desde la base, nunca desde lo que mande el asistente: los mensajes de cada paso de un
// recorrido (el borrador que se publicaría o la versión que se activaría), los pasos de una secuencia con su espera y lo
// que hace una regla con sus textos. Esos textos pudo escribirlos el asistente: por eso se muestran completos (hasta un
// tope) antes de aprobar. Funciones puras: los nombres de lo que se nombra (archivo, plantilla, secuencia…) los da
// `names`, que el repositorio busca dentro de la marca. Todo sale como texto plano: la pantalla lo escapa.
import { NODE_TYPES } from '../../../public/kit/shared/flow-model.js';
import { timingLabel } from '../sequences/model.mjs';
import { ACTIONS as RULE_ACTIONS, LIMIT_KINDS, MODES, STATUS_TARGETS } from '../rules/definition.mjs';

export const PREVIEW = Object.freeze({ items: 12, chars: 300 });
export const SENDS_TITLE = 'Lo que se enviará a los clientes';
export const SENDS_NOTE =
  'Estos textos pudo escribirlos el asistente. Léelos completos antes de aprobar: es lo que recibirán los clientes.';

// Caracteres de control (salvo el salto de línea) e invisibles o de dirección del texto, por su código.
const HIDDEN = new RegExp(
  '[' +
    [
      [0x00, 0x09],
      [0x0b, 0x1f],
      [0x7f, 0x9f],
      [0x200b, 0x200f],
      [0x202a, 0x202e],
      [0x2066, 0x2069],
      [0xfeff, 0xfeff],
    ]
      .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b))
      .join('') +
    ']',
  'g',
);
// Texto plano de una línea o varias, sin invisibles, recortado con «…».
export function plain(value, max = PREVIEW.chars) {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(HIDDEN, '').trim() : '';
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}
const arr = v => (Array.isArray(v) ? v : []);
const parse = (raw, fallback) => {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const q = name => '«' + plain(name || 'sin nombre', 80) + '»';
const join = parts => parts.filter(Boolean).join('\n');

// Recorta la lista al tope y dice cuántos quedaron fuera. Un elemento puede pedir un tope de caracteres propio (`max`).
export function sendsOf(items) {
  const list = items.filter(x => x && x.value);
  return {
    title: SENDS_TITLE,
    note: SENDS_NOTE,
    items: list
      .slice(0, PREVIEW.items)
      .map(x => ({ label: plain(x.label, 80), value: plain(x.value, x.max ?? PREVIEW.chars) })),
    more: Math.max(0, list.length - PREVIEW.items),
  };
}

// ---- recorridos
const INTENT = {
  price: 'el precio vigente',
  syllabus: 'el temario',
  schedule: 'fechas y horario',
  enroll: 'la inscripción',
  human: 'pasar con una persona',
};
function optionLine(o) {
  const label = plain(o?.label || o?.title || '', 80) || 'sin texto';
  return o?.do?.type === 'intent' && INTENT[o.do.intent] ? `${label} (responde con ${INTENT[o.do.intent]})` : label;
}
function nodeText(node, names) {
  const d = node.data && typeof node.data === 'object' ? node.data : {};
  switch (node.type) {
    case 'message':
      return join(
        arr(d.parts).map(p => {
          if (p?.kind === 'media')
            return `[Archivo ${q(names.file(p.fileId))}]` + (p.caption ? ' ' + plain(p.caption) : '');
          if (p?.kind === 'material') return `[Material aprobado ${q(names.material(p.templateId))}]`;
          if (p?.kind === 'slot') return '[Material según el curso de la conversación]';
          return plain(p?.text);
        }),
      );
    case 'buttons':
      return join([
        d.header?.kind === 'text' ? plain(d.header.text) : '',
        d.header?.kind === 'media' ? `[Archivo ${q(names.file(d.header.fileId))}]` : '',
        d.header?.kind === 'course_flyer' ? '[Ficha vigente del curso]' : '',
        plain(d.text),
        plain(d.footer),
        'Botones: ' + arr(d.options).map(optionLine).join(' · '),
      ]);
    case 'list':
      return join([
        plain(d.header),
        plain(d.text),
        plain(d.footer),
        `Lista «${plain(d.button, 40)}»: ` +
          arr(d.sections)
            .flatMap(s => arr(s?.rows))
            .map(optionLine)
            .join(' · '),
      ]);
    case 'question':
      return join([plain(d.text), d.errorText ? 'Si la respuesta no sirve: ' + plain(d.errorText) : '']);
    case 'template':
      return `Envía la plantilla de WhatsApp ${q(names.template(d.waTemplateId))}`;
    case 'sequence':
      return `Inscribe a la persona en la secuencia ${q(names.sequence(d.sequenceId))} (que le enviará sus propios pasos)`;
    case 'handoff':
      return join([plain(d.text), 'Pasa la conversación a una persona del equipo']);
    case 'end':
      return join([plain(d.text), 'Termina el recorrido']);
    case 'course_card':
      return join([
        plain(d.text),
        '[Ficha del curso con datos vigentes del catálogo' + (d.flyer ? ' y su flyer]' : ']'),
      ]);
    case 'price':
    case 'syllabus':
    case 'schedule':
    case 'enroll':
    case 'choose_course':
      return `${NODE_TYPES[node.type].label} (con los datos vigentes del catálogo)`;
    case 'goto_flow':
      return `Pasa al recorrido ${q(names.flow(d.flowId))}`;
    case 'assistant':
      return 'Contesta el asistente con el conocimiento aprobado';
    case 'delay':
      return `Espera ${Number(d.seconds) || 0} segundos`;
    default:
      return '';
  }
}
// Pasos en el orden en que se recorren desde el Inicio (los que no se alcanzan no se ejecutan).
export function flowSends(graphRaw, names) {
  const graph = parse(graphRaw, {});
  const nodes = new Map(arr(graph.nodes).map(n => [n?.id, n]));
  const edges = arr(graph.edges);
  const order = [];
  const seen = new Set();
  const queue = [graph.start ?? arr(graph.nodes).find(n => n?.type === 'start')?.id];
  while (queue.length) {
    const id = queue.shift();
    if (!nodes.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(nodes.get(id));
    for (const e of edges) if (e?.from === id) queue.push(e.to);
  }
  let n = 0;
  return sendsOf(
    order
      .filter(node => node.type !== 'start' && node.type !== 'note')
      .map(node => {
        const value = nodeText(node, names);
        if (!value) return null;
        n += 1;
        const kind = NODE_TYPES[node.type]?.label || node.type;
        return { label: `${n}. ${plain(node.title, 60) || kind}`, value };
      }),
  );
}

// ---- secuencias
export function sequenceSends(stepsRaw, names) {
  return sendsOf(
    arr(parse(stepsRaw, [])).map((s, i) => {
      const when = s?.timing ? timingLabel(s.timing) : '';
      const send = s?.send || {};
      const what =
        send.kind === 'template'
          ? `Plantilla de WhatsApp ${q(names.template(send.templateId))}`
          : send.kind === 'material'
            ? `Material aprobado ${q(names.material(send.materialId))}`
            : plain(send.text);
      return { label: `Paso ${i + 1} · ${when}`, value: what || 'Sin mensaje' };
    }),
  );
}

// ---- reglas: cuándo se dispara (una frase) y qué hace, con sus textos
export function ruleSends(definitionRaw, names) {
  const def = parse(definitionRaw, {});
  const t = def.trigger || {};
  const words = arr(t.words)
    .map(w => '«' + plain(w, 60) + '»')
    .join(', ');
  const trigger =
    t.type === 'any_message' ? 'Con cualquier mensaje' : `${MODES[t.mode] || 'Contiene la palabra'}: ${words}`;
  const conditions = arr(def.conditions?.groups).length ? ' (y sólo si cumple sus condiciones)' : '';
  const limit = LIMIT_KINDS[def.options?.limit] ? ' · ' + LIMIT_KINDS[def.options.limit] : '';
  const items = [{ label: 'Cuándo se dispara', value: trigger + conditions + limit }];
  for (const [i, a] of arr(def.actions).entries()) {
    const label = `Acción ${i + 1} · ${RULE_ACTIONS[a?.type]?.label || 'Acción'}`;
    let value;
    if (a?.type === 'send_text') value = plain(a.text);
    else if (a?.type === 'send_material') value = `Material aprobado ${q(names.material(a.materialId))}`;
    else if (a?.type === 'start_flow') value = `Inicia el recorrido ${q(names.flow(a.flowId))}`;
    else if (a?.type === 'add_tag' || a?.type === 'remove_tag')
      value = `Etiqueta ${q(names.tag(a.tagId))} (no envía mensaje)`;
    else if (a?.type === 'handoff')
      value = join([
        a.to === 'user' ? `A ${q(names.user(a.userId))}` : 'A la cola del equipo',
        a.text ? 'Aviso: ' + plain(a.text) : '',
      ]);
    else if (a?.type === 'set_status') value = `Estado: ${STATUS_TARGETS[a.status] || a.status} (no envía mensaje)`;
    else value = 'Acción no reconocida';
    items.push({ label, value });
  }
  return sendsOf(items);
}
