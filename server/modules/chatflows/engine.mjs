// Motor de los recorridos (docs/PLAN_RECORRIDOS.md; diseño de automatización §6.3 a §6.5).
//
// Este archivo NO toca la base de datos ni la red: recibe una sesión (objeto) y un entorno (`env`) con una única
// puerta de salida (`env.io`) y la hace avanzar paso a paso hasta el siguiente punto de espera. El servidor le da un
// `io` que escribe (runtime.mjs: mensajes por el camino normal de envío, datos del contacto, pase a una persona…) y el
// simulador uno que sólo anota. Así lo que se prueba en el simulador es exactamente lo que corre de verdad.
//
// El grafo y sus tipos de paso son los del modelo compartido (public/kit/shared/flow-model.js): el servidor valida y
// limpia con ese mismo archivo, no con una copia.
import { defineFields, evaluate, normalizeText } from '../../lib/conditions.mjs';
import {
  matchesPattern,
  safePattern,
  normalizeGraph,
  normalizeSettings,
  tokensIn,
  typeOf,
} from '../../../public/kit/shared/flow-model.js';

// ---- Topes (sin bucles y sin ráfagas)
export const CAPS = Object.freeze({
  perAdvance: 25, // pasos seguidos en un mismo avance; al llegar, el motor cede el turno y sigue en un segundo
  perSession: 200, // pasos en toda la sesión: un recorrido que da vueltas sin fin se detiene
  unanswered: 12, // mensajes seguidos sin que la persona conteste
});

// Resultado de una sesión → categoría de las estadísticas (flowResult del modelo). Los propios de este motor:
//   automation_off   la marca apagó la automatización o su asistente ya no responde solo
//   stopped          alguien del equipo detuvo la sesión o pausó el recorrido con «detener las conversaciones»
//   restarted        la persona escribió otra vez la palabra clave mientras se esperaba su respuesta: empezó de nuevo
export const OUTCOMES = Object.freeze([
  'completed',
  'assistant',
  'replaced',
  'handoff',
  'human_takeover',
  'closed',
  'left',
  'timeout',
  'opt_out',
  'window_closed',
  'flow_archived',
  'error',
  'automation_off',
  'stopped',
  'restarted',
]);

// ---- Tipos de paso que el motor del servidor sabe ejecutar: la lista vive en el modelo compartido (flow-support.js)
// para que el editor avise antes de publicar. Lo demás se rechaza al publicar con un motivo claro.
export { unsupportedProblems } from '../../../public/kit/shared/flow-support.js';

// ---- Datos en los textos: {{dato}}, {{contacto.clave}}, {{var.nombre}} y {{dato|respaldo}}
export function renderText(body, env, s) {
  const text = String(body ?? '');
  const tokens = tokensIn(text);
  if (!tokens.length) return text;
  const values = env.io.values();
  let out = '';
  let at = 0;
  for (const t of tokens) {
    out += text.slice(at, t.index);
    let value = '';
    if (t.kind === 'var') value = s.vars?.[t.key];
    else if (t.kind === 'contact') value = values.contacto?.[t.key];
    else if (t.kind === 'base') value = values.base?.[t.key];
    value = value === null || value === undefined ? '' : String(value);
    out += value.trim() ? value : (t.fallback ?? '');
    at = t.index + t.raw.length;
  }
  return (out + text.slice(at)).replace(/[ \t]{2,}/g, ' ');
}

// ---- Condiciones: la forma del paso «Condición» del modelo, evaluada con la biblioteca común (server/lib/conditions.mjs)
const num = v => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null;
};
function compare(op, raw, expected) {
  const blank = raw === null || raw === undefined || (Array.isArray(raw) ? !raw.length : !String(raw).trim());
  if (op === 'empty') return blank;
  if (op === 'not_empty') return !blank;
  const value = Array.isArray(raw) ? raw.join(' ') : raw;
  const a = normalizeText(value);
  const b = normalizeText(expected);
  if (op === 'neq') return blank || a !== b;
  if (op === 'not_contains') return blank || !a.includes(b);
  if (blank) return false;
  if (op === 'eq') return a === b;
  if (op === 'contains') return a.includes(b);
  if (op === 'starts') return a.startsWith(b);
  const x = num(value);
  const y = num(expected);
  if (x === null || y === null) return false;
  if (op === 'gt') return x > y;
  if (op === 'gte') return x >= y;
  if (op === 'lt') return x < y;
  if (op === 'lte') return x <= y;
  return false;
}
const ATTR_OPS = ['eq', 'neq', 'contains', 'not_contains', 'starts', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'];
const CLOCK = /^(\d{2}):(\d{2})$/;
const minutes = v => {
  const m = CLOCK.exec(String(v ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const CONDITION_FIELDS = defineFields([
  {
    key: 'attr',
    members: key => ({
      type: 'custom',
      ops: ATTR_OPS,
      read: record => record?.attr?.[key],
      test: (rule, record) => compare(rule.op, record?.attr?.[key], rule.value),
    }),
  },
  { key: 'tags', type: 'list', ops: ['any', 'none'] },
  { key: 'course', type: 'choice', ops: ['in'] },
  { key: 'channel', type: 'choice', ops: ['in'] },
  {
    key: 'hours',
    type: 'custom',
    ops: ['is'],
    test: (rule, record) => (rule.value === 'open') === Boolean(record.open),
  },
  {
    key: 'clock',
    type: 'custom',
    ops: ['in'],
    test: (rule, record) => {
      const from = minutes(rule.value?.from);
      const to = minutes(rule.value?.to);
      if (from === null || to === null || !record.clock) return false;
      const { day, minutes: at } = record.clock;
      if (!rule.value.days.includes(String(day))) return false;
      return from <= to ? at >= from && at < to : at >= from || at < to;
    },
  },
]);
// {mode, groups:[{mode, items:[{f,…}]}]} del modelo → forma canónica {version, match, groups:[{match, rules}]}.
export function toCanonical(when) {
  const rule = item => {
    if (item.f === 'tag') return { field: 'tags', op: item.op === 'has_not' ? 'none' : 'any', value: [item.tagId] };
    if (item.f === 'hours') return { field: 'hours', op: 'is', value: item.is };
    if (item.f === 'clock')
      return { field: 'clock', op: 'in', value: { days: item.days, from: item.from, to: item.to } };
    if (item.f === 'course') return { field: 'course', op: 'in', value: item.in };
    if (item.f === 'channel') return { field: 'channel', op: 'in', value: item.in };
    return { field: 'attr', key: item.key, op: item.op, value: item.value ?? '' };
  };
  return {
    version: 1,
    match: when.mode === 'any' ? 'any' : 'all',
    groups: when.groups.map(g => ({ match: g.mode === 'any' ? 'any' : 'all', rules: g.items.map(rule) })),
  };
}
function conditionRecord(env, s) {
  const record = env.io.conditionRecord();
  const attr = { ...record.attr };
  for (const [k, v] of Object.entries(s.vars || {})) attr['var.' + k] = v;
  return { ...record, attr };
}

// ---- Respuestas de una Pregunta
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
function validDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
function parseDate(text) {
  let m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  let y, mo, d;
  if (m) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text))) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else return null;
  if (!validDate(y, mo, d)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
// Una Pregunta «formato propio» usa la regla única del modelo compartido (patternProblem / matchesPattern): un
// subconjunto de expresiones que no puede tardar de más y sólo los primeros 200 caracteres. Nunca lanza.
export { safePattern };

// Devuelve el valor que se guarda o null si la respuesta no vale.
export function checkAnswer(answer, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  switch (answer.type) {
    case 'text': {
      const min = answer.min ?? 1;
      const max = Math.min(answer.max ?? 1000, 1000);
      return text.length >= min && text.length <= max ? text : null;
    }
    case 'number': {
      const n = num(text.replace(/\s/g, ''));
      if (n === null) return null;
      if (answer.min !== undefined && n < answer.min) return null;
      if (answer.max !== undefined && n > answer.max) return null;
      return String(n);
    }
    case 'email':
      return EMAIL.test(text) ? text.toLowerCase() : null;
    case 'phone': {
      const digits = text.replace(/[\s().-]/g, '');
      return /^\+?\d{8,15}$/.test(digits) ? digits : null;
    }
    case 'date':
      return parseDate(text);
    case 'time':
      return parseTime(text);
    case 'datetime': {
      const [d, t, ...rest] = text.split(/\s+/);
      const date = parseDate(d || '');
      const time = parseTime(t || '');
      return !rest.length && date && time ? `${date} ${time}` : null;
    }
    case 'regex':
      return matchesPattern(answer.pattern, text) ? text : null;
    default:
      return null;
  }
}

// ---- Sesión
export function newSession({ id, flowId, version, graph, now, vars = {} }) {
  return {
    id,
    flowId,
    version,
    state: 'running',
    nodeId: graph.start,
    seq: 0,
    vars: { ...vars },
    waiting: null,
    steps: 0,
    unanswered: 0,
    expiresAt: null,
    outcome: null,
    endNodeId: null,
    startedAt: now,
  };
}

// Entorno de un avance: el grafo ya limpio, cómo encontrar el destino de una salida y la puerta de salida `io`.
export function makeEnv({ graph, settings, io, now }) {
  const canonical = normalizeGraph(graph);
  const byId = new Map(canonical.nodes.map(n => [n.id, n]));
  const out = new Map(canonical.edges.map(e => [e.from + '\n' + e.port, e.to]));
  return {
    graph: canonical,
    settings: normalizeSettings(settings),
    byId,
    target: (id, port) => out.get(id + '\n' + port) ?? null,
    io,
    now,
  };
}

class LoopStop extends Error {}

function end(s, env, outcome, nodeId = s.nodeId) {
  s.state = 'ended';
  s.outcome = outcome;
  s.endNodeId = nodeId;
  s.waiting = null;
  s.expiresAt = null;
  env.io.log('end', { nodeId, detail: outcome });
  return s;
}

// Envía un mensaje de la sesión; cuenta los mensajes seguidos sin respuesta (tope contra ráfagas y bucles).
function say(env, s, payload) {
  s.unanswered += 1;
  if (s.unanswered > CAPS.unanswered) throw new LoopStop('Demasiados mensajes seguidos sin respuesta de la persona.');
  return env.io.send(payload);
}

// Una salida «No disponible» sin conectar hace lo mismo que el asistente: explica el motivo y pasa a una persona.
function unavailable(node, env, s, reason) {
  if (env.target(node.id, 'unavailable')) return { next: 'unavailable' };
  say(env, s, { text: env.io.copy.unavailable(reason) });
  return { end: 'handoff', handoff: { to: 'queue' } };
}

// Un archivo o una plantilla que no se pueden enviar (de otra marca, borrados, sin número real, número en escucha…):
// no se manda otra cosa en su lugar. Queda anotado el motivo y la conversación pasa a una persona con el aviso de
// siempre (no el de «edición no disponible», que habla del curso).
function cannotSend(node, env, s, reason) {
  env.io.log('error', { nodeId: node.id, detail: 'No se envió: ' + reason });
  return { end: 'handoff', handoff: { to: 'queue', notice: true } };
}

// Lo que espera un paso de Botones, Lista, Plantilla con botones o Pregunta, armado SIEMPRE desde el nodo del grafo ya
// limpio (clean del modelo): el simulador lo reconstruye así en lugar de confiar en un estado que manda el navegador.
// Una Lista espera como unos Botones con más opciones (sus filas, en orden) y `list: true`: sus opciones no se vuelven
// a ofrecer como botones (WhatsApp admite 3), sino como lista o como texto numerado.
export function waitOf(node, env, { misses = 0, tries = 0 } = {}) {
  const def = typeOf(node?.type);
  if (!def || !['buttons', 'list', 'template', 'question'].includes(node.type)) return null;
  const d = def.clean(node.data);
  if (node.type === 'buttons')
    return {
      kind: 'choice',
      nodeId: node.id,
      options: d.options.map(o => ({ id: o.id, label: o.label, do: o.do })),
      onUnexpected: d.onUnexpected || env.settings.onUnexpected,
      ...(d.saveAs ? { saveAs: d.saveAs } : {}),
      misses,
    };
  if (node.type === 'list')
    return {
      kind: 'choice',
      list: true,
      nodeId: node.id,
      options: d.sections.flatMap(s => s.rows).map(r => ({ id: r.id, label: r.title, do: r.do })),
      onUnexpected: d.onUnexpected || env.settings.onUnexpected,
      ...(d.saveAs ? { saveAs: d.saveAs } : {}),
      misses,
    };
  if (node.type === 'template') {
    if (!d.wait || !d.buttons.length) return null;
    return {
      kind: 'choice',
      nodeId: node.id,
      options: d.buttons.map((label, i) => ({ id: String(i + 1), label, do: { type: 'goto' } })),
      onUnexpected: env.settings.onUnexpected,
      misses,
    };
  }
  return {
    kind: 'question',
    nodeId: node.id,
    answer: d.answer,
    saveTo: d.saveTo,
    errorText: d.errorText,
    attempts: Math.min(Math.max(d.attempts || 2, 1), 3),
    tries,
  };
}

// Las opciones numeradas, una por renglón: así se ven una Lista en el chat del laboratorio y en el CRM, y así se
// ofrecen de nuevo en un canal que no muestra listas. La persona contesta con el número o con el nombre.
export const numberedOptions = options => options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');

// Una Lista lista para enviar: el texto con encabezado y pie (como en Botones) y la lista interactiva de WhatsApp. El id
// de cada fila lleva el del paso (`<paso>:<fila>`): al pulsarla, la respuesta se reconoce aunque dos listas compartan
// ids de fila.
export function listMessage(node, d, env, s) {
  const header = d.header.trim() ? renderText(d.header, env, s) : '';
  const body = renderText(d.text, env, s);
  const footer = d.footer.trim() ? renderText(d.footer, env, s) : '';
  return {
    text: [header, body, footer].filter(Boolean).join('\n\n'),
    list: {
      header,
      body,
      footer,
      button: d.button,
      sections: d.sections.map(sec => ({
        title: sec.title,
        rows: sec.rows.map(r => ({ id: node.id + ':' + r.id, title: r.title, description: r.description })),
      })),
      options: d.sections.flatMap(sec => sec.rows).map(r => ({ label: r.title })),
    },
  };
}

// Qué hace cada tipo de paso. Devuelve {next: salida} | {wait} | {delay: ms} | {end: resultado, …acciones finales}.
const EXEC = {
  start: () => ({ next: 'next' }),
  note: () => ({ end: 'completed' }),
  message(node, d, env, s) {
    for (const part of d.parts) {
      if (part.kind === 'text') say(env, s, { text: renderText(part.text, env, s) });
      else if (part.kind === 'material') {
        const material = env.io.material(part.templateId);
        if (material.reason) return unavailable(node, env, s, material.reason);
        say(env, s, { text: material.text, prepared: material.prepared });
      } else if (part.kind === 'media') {
        // Un archivo de la biblioteca de la MARCA: se vuelve a comprobar al enviar (la marca, que exista y su tipo).
        const file = env.io.file(part.fileId);
        if (file.reason) return cannotSend(node, env, s, file.reason);
        say(env, s, { text: renderText(part.caption, env, s), file });
      }
    }
    return { next: 'next' };
  },
  buttons(node, d, env, s) {
    let text = renderText(d.text, env, s);
    let prepared = null;
    let file = null;
    if (d.header.kind === 'text') text = renderText(d.header.text, env, s) + '\n\n' + text;
    if (d.header.kind === 'course_flyer') {
      const card = env.io.catalogue('flyer');
      if (!card.reason) prepared = card.prepared;
    }
    if (d.header.kind === 'media') {
      // Sin el archivo los botones salen igual (la persona puede elegir) y queda anotado por qué.
      const found = env.io.file(d.header.fileId);
      if (found.reason) env.io.log('error', { nodeId: node.id, detail: 'Encabezado sin archivo: ' + found.reason });
      else file = found;
    }
    if (d.footer) text += '\n\n' + renderText(d.footer, env, s);
    say(env, s, { text, buttons: d.options.map(o => o.label), prepared, file });
    return { wait: waitOf(node, env) };
  },
  list(node, d, env, s) {
    say(env, s, listMessage(node, d, env, s));
    return { wait: waitOf(node, env) };
  },
  // Una plantilla aprobada por Meta, por el mismo camino que la envía el equipo desde el chat (módulo wa-templates):
  // sólo por un número real, de la marca, aprobada, con sus datos y su categoría de costo. Es el único paso que habla
  // con la ventana de 24 horas cerrada.
  template(node, d, env, s) {
    const template = env.io.template(d.waTemplateId);
    if (template.reason) return cannotSend(node, env, s, template.reason);
    say(env, s, { template });
    const wait = waitOf(node, env);
    return wait ? { wait } : { next: 'next' };
  },
  question(node, d, env, s) {
    say(env, s, { text: renderText(d.text, env, s) });
    return { wait: waitOf(node, env) };
  },
  condition(node, d, env, s) {
    const record = conditionRecord(env, s);
    for (const c of d.cases)
      if (evaluate(toCanonical(c.when), record, CONDITION_FIELDS, env.now)) return { next: 'case:' + c.id };
    return { next: 'else' };
  },
  delay: (node, d) => ({ delay: Math.min(Math.max(d.seconds, 1), 600) * 1000 }),
  set_attribute(node, d, env, s) {
    const v = d.value;
    const value =
      v.from === 'fixed'
        ? renderText(v.text, env, s)
        : v.from === 'var'
          ? (s.vars[v.name] ?? '')
          : env.io.lastMessageText();
    env.io.setAttribute(d.key, value);
    return { next: 'next' };
  },
  tags(node, d, env) {
    env.io.tags(d.add, d.remove);
    return { next: 'next' };
  },
  // Inscribe en una secuencia de seguimiento y sigue SIEMPRE por «Sigue»: una negativa (ya está en ella, ya pagó,
  // pidió la baja, secuencia apagada…) no detiene el recorrido. Cómo salió queda en el detalle de la salida del paso:
  // `enrolled`, `duplicate` (esta misma sesión ya la inscribió en este paso) o `refused:<motivo>`.
  sequence(node, d, env) {
    const r = env.io.sequence(d.sequenceId, node.id);
    const detail = r.refused ? 'refused:' + r.refused : r.duplicate ? 'duplicate' : 'enrolled';
    return { next: 'next', detail };
  },
  handoff(node, d, env, s) {
    if (d.text.trim()) say(env, s, { text: renderText(d.text, env, s) });
    return { end: 'handoff', handoff: { to: d.to, userId: d.userId || null } };
  },
  status: () => ({ end: 'completed', resolve: true }),
  assistant: () => ({ end: 'assistant' }),
  goto_flow: (node, d, env, s) => ({ end: 'replaced', goto: { flowId: d.flowId, vars: d.passVars ? s.vars : {} } }),
  end(node, d, env, s) {
    if (d.text.trim()) say(env, s, { text: renderText(d.text, env, s) });
    return { end: 'completed' };
  },
  course_card(node, d, env, s) {
    const card = env.io.catalogue('flyer');
    if (card.reason) return unavailable(node, env, s, card.reason);
    const text = d.text.trim() ? renderText(d.text, env, s) : env.io.copy.card(card.ctx);
    say(env, s, { text, prepared: d.flyer ? card.prepared : null });
    return { next: 'next' };
  },
  price(node, d, env, s) {
    if (d.templateId) {
      const material = env.io.material(d.templateId);
      if (material.reason) return unavailable(node, env, s, material.reason);
      say(env, s, { text: material.text, prepared: material.prepared });
    } else {
      const card = env.io.catalogue('price');
      if (card.reason) return unavailable(node, env, s, card.reason);
      const text = d.body === 'full' ? env.io.copy.price(card.ctx) : env.io.copy.priceBody(card.ctx);
      say(env, s, { text, prepared: card.prepared });
    }
    env.io.stage('interesado'); // como el asistente: preguntar el precio avanza la etapa
    return { next: 'next' };
  },
  syllabus(node, d, env, s) {
    const card = env.io.catalogue('syllabus');
    if (card.reason) return unavailable(node, env, s, card.reason);
    const text = d.body === 'full' ? env.io.copy.syllabus(card.ctx) : env.io.copy.syllabusBody(card.ctx);
    say(env, s, { text, prepared: card.prepared });
    return { next: 'next' };
  },
  schedule(node, d, env, s) {
    const card = env.io.catalogue('schedule');
    if (card.reason) return unavailable(node, env, s, card.reason);
    let text = env.io.copy.scheduleBody(card.ctx);
    if (d.seats) {
      const seats = env.io.copy.seats(card.ctx);
      if (seats) text += '\n' + seats;
    }
    say(env, s, { text, prepared: card.prepared });
    return { next: 'next' };
  },
  // Pedido y enlace de pago, por el mismo camino que el asistente. NUNCA confirma un pago ni marca nada como pagado:
  // un pago lo confirma la pasarela o una persona (payments.confirm), nunca un recorrido.
  enroll(node, d, env, s) {
    const r = env.io.enroll();
    if (r.reason) return unavailable(node, env, s, r.reason);
    env.io.stage('inscripcion');
    if (r.kind === 'order' || r.kind === 'reminder') {
      say(env, s, { text: r.text, order: r.kind === 'order' });
      return { next: 'order' };
    }
    if (env.target(node.id, 'manual')) return { next: 'manual' };
    say(env, s, { text: r.text });
    return { end: 'handoff', handoff: { to: 'queue' } };
  },
};

// Avanza la sesión hasta el siguiente punto de espera (o el final). Dentro de una transacción: todo lo que hace
// `io` es síncrono y sin red. Devuelve la sesión (mutada) y la lista de acciones finales que el llamador ejecuta
// DESPUÉS de guardarla (pasar a una persona, resolver, ir a otro recorrido).
export function advance(s, env) {
  const visited = new Set();
  const finals = {};
  try {
    for (let n = 0; ; n += 1) {
      if (s.state === 'ended') break;
      const why = env.io.stop();
      if (why) {
        end(s, env, why);
        break;
      }
      if (n >= CAPS.perAdvance) {
        // Cede el turno: sigue en un segundo con un paso durable (corta ráfagas largas sin perder el lugar).
        s.state = 'delayed';
        env.io.schedule('yield', env.now + 1000);
        env.io.log('wait', { nodeId: s.nodeId, detail: 'yield' });
        break;
      }
      if (s.steps >= CAPS.perSession) throw new LoopStop('El recorrido superó el tope de pasos de una sesión.');
      const node = env.byId.get(s.nodeId);
      if (!node) {
        end(s, env, 'completed');
        break;
      }
      if (visited.has(node.id)) throw new LoopStop('El recorrido volvió a un paso sin esperar a la persona.');
      visited.add(node.id);
      const def = typeOf(node.type);
      const d = def.clean(node.data);
      s.seq += 1;
      s.steps += 1;
      s.state = 'running';
      env.io.log('enter', { nodeId: node.id, nodeType: node.type });
      // La plantilla de WhatsApp es lo único que sale con la ventana cerrada (la regla es de Meta).
      if (def.speaks(d) && node.type !== 'template' && !env.io.windowOpen()) {
        end(s, env, 'window_closed', node.id);
        break;
      }
      const r = EXEC[node.type](node, d, env, s);
      if (r.wait) {
        s.state = 'waiting';
        s.waiting = r.wait;
        s.expiresAt = env.now + env.settings.timeoutMinutes * 60_000;
        env.io.schedule('timeout', s.expiresAt);
        if (env.settings.reminder?.text && env.settings.reminder.afterMinutes < env.settings.timeoutMinutes)
          env.io.schedule('reminder', env.now + env.settings.reminder.afterMinutes * 60_000);
        env.io.log('wait', { nodeId: node.id, nodeType: node.type, detail: r.wait.kind });
        break;
      }
      if (r.delay) {
        s.state = 'delayed';
        s.waiting = { kind: 'delay', nodeId: node.id };
        env.io.schedule('delay', env.now + r.delay);
        env.io.log('wait', { nodeId: node.id, nodeType: node.type, detail: 'delay ' + r.delay / 1000 + ' s' });
        break;
      }
      if (r.end) {
        Object.assign(finals, { handoff: r.handoff, resolve: r.resolve, goto: r.goto });
        end(s, env, r.end, node.id);
        break;
      }
      env.io.log('exit', { nodeId: node.id, nodeType: node.type, port: r.next, detail: r.detail ?? null });
      const to = env.target(node.id, r.next);
      if (!to) {
        end(s, env, 'completed', node.id);
        break;
      }
      s.nodeId = to;
    }
  } catch (error) {
    if (!(error instanceof LoopStop)) throw error;
    env.io.log('error', { nodeId: s.nodeId, detail: error.message });
    end(s, env, 'error');
    finals.handoff = { to: 'queue', notice: true };
  }
  return finals;
}

// Sigue desde el paso actual por una salida (la del botón elegido, «Sin respuesta», «No válida»…).
export function follow(s, env, port) {
  const node = env.byId.get(s.nodeId);
  env.io.log('exit', { nodeId: s.nodeId, nodeType: node?.type, port });
  s.waiting = null;
  s.expiresAt = null;
  const to = node ? env.target(node.id, port) : null;
  if (!to) {
    end(s, env, 'completed');
    return {};
  }
  s.nodeId = to;
  s.state = 'running';
  return advance(s, env);
}

// La opción que la persona pulsó, si el canal lo dijo (contrato 1.1: `messages.reply` = {kind, id, title, payload}).
// Una fila de lista llega con el id que se le puso al enviarla (`<paso>:<fila>`). Un botón (normal o de plantilla)
// llega con un id o una carga que no nombra la opción del recorrido y se reconoce por su texto, como siempre.
function pressed(w, message) {
  let reply = message?.reply;
  if (typeof reply === 'string') {
    try {
      reply = JSON.parse(reply);
    } catch {
      reply = null;
    }
  }
  if (!reply || typeof reply !== 'object') return null;
  if (w.list && reply.kind === 'list' && typeof reply.id === 'string') {
    const at = reply.id.indexOf(':');
    if (at > 0 && reply.id.slice(0, at) === w.nodeId)
      return w.options.find(o => o.id === reply.id.slice(at + 1)) || null;
  }
  return null;
}

const INTERRUPT = ['human', 'refund'];
const PAID = /comprobante|pague|ya pague|transferi|deposite/;

// Qué hacer con un mensaje de la persona mientras la sesión espera (sólo lectura). Tabla del diseño §3.4:
//   {kind:'consume', port}          la respuesta esperada: sigue por esa salida
//   {kind:'answer', value}          respuesta válida de una Pregunta
//   {kind:'invalid'}                respuesta no válida de una Pregunta
//   {kind:'interrupt'}              pide una persona, se queja, pide reembolso o avisa que ya pagó
//   {kind:'intent', stay}           pulsó una opción que contesta el asistente
//   {kind:'detour'} {kind:'repeat'} {kind:'default'}   escribió otra cosa (según «si escribe otra cosa»)
//   {kind:'during_delay'}           llegó mientras el recorrido espera unos segundos
//   {kind:'expired'}
export function route(s, env, message, classify) {
  if (s.expiresAt !== null && s.expiresAt <= env.now) return { kind: 'expired' };
  const w = s.waiting;
  if (s.state === 'delayed' || !w || (w.kind !== 'choice' && w.kind !== 'question')) return { kind: 'during_delay' };
  const text = String(message.text ?? '');
  const key = normalizeText(text);
  if (w.kind === 'question') {
    const value = checkAnswer(w.answer, text);
    return value === null ? { kind: 'invalid' } : { kind: 'answer', value };
  }
  const index = /^\d{1,2}$/.test(key) ? Number(key) - 1 : -1;
  const option = pressed(w, message) || w.options.find(o => normalizeText(o.label) === key) || w.options[index] || null;
  if (option) {
    if (option.do?.type === 'intent') return { kind: 'intent', option, stay: option.do.stay !== false };
    return { kind: 'consume', port: 'opt:' + option.id, option };
  }
  const cls = classify(text);
  if (INTERRUPT.includes(cls.intent) || (cls.intent === 'payment' && PAID.test(key))) return { kind: 'interrupt' };
  if (w.onUnexpected === 'repeat') return { kind: 'repeat' };
  if (w.onUnexpected === 'default') return { kind: 'default' };
  return { kind: 'detour' };
}

// Aplica una entrada ya clasificada por route(). Devuelve las acciones finales de advance().
export function input(s, env, r) {
  s.unanswered = 0;
  const w = s.waiting;
  env.io.log('input', { nodeId: s.nodeId, detail: r.kind });
  if (r.kind === 'consume') {
    rememberChoice(s, w, r.option);
    return follow(s, env, r.port);
  }
  if (r.kind === 'default') return follow(s, env, 'default');
  if (r.kind === 'answer') {
    if (w.saveTo.kind === 'attribute') env.io.setAttribute(w.saveTo.key, r.value);
    else s.vars[w.saveTo.name] = r.value;
    return follow(s, env, 'next');
  }
  if (r.kind === 'invalid') {
    w.tries += 1;
    if (w.tries >= w.attempts) return follow(s, env, 'invalid');
    say(env, s, { text: w.errorText ? renderText(w.errorText, env, s) : env.io.copy.invalidAnswer });
    env.io.log('miss', { nodeId: s.nodeId, detail: 'invalid' });
    return {};
  }
  if (r.kind === 'repeat') {
    w.misses += 1;
    env.io.log('miss', { nodeId: s.nodeId, detail: 'repeat' });
    if (w.misses >= env.settings.maxMisses) {
      if (env.target(s.nodeId, 'default')) return follow(s, env, 'default');
      end(s, env, 'left');
      return {};
    }
    const fallback = renderText(env.settings.fallbackText, env, s);
    // Una lista no cabe en 3 botones: se repite como texto numerado (y se acepta el número o el nombre).
    if (w.list) say(env, s, { text: fallback + '\n\n' + numberedOptions(w.options) });
    else say(env, s, { text: fallback, buttons: w.options.map(o => o.label) });
    return {};
  }
  return {};
}

// «Guardar la opción elegida en la variable» de Botones y Lista: guarda el texto de la opción, tal como se ofreció.
export function rememberChoice(s, w, option) {
  if (w?.saveAs && option) s.vars[w.saveAs] = option.label;
}
