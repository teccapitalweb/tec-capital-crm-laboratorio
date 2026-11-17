// Definición de una regla por mensaje (docs/PLAN_REGLAS.md; diseño de automatización §5.2 a §5.5).
//
// Funciones puras: sin base de datos, sin red y sin reloj propio. El módulo las usa para validar lo que se guarda, para
// decidir si un mensaje coincide y para explicar en palabras lo que haría una regla.
//
// Forma (versión 1):
//   {
//     "v": 1,
//     "trigger": {"type": "keyword", "mode": "contains", "words": ["precio", "costo"]}   (o {"type": "any_message"})
//     "conditions": {"version": 1, "match": "all", "groups": [{"match": "all", "rules": [
//        {"field": "channel", "op": "in", "value": ["whatsapp"]},
//        {"field": "hours", "op": "eq", "value": "closed"}]}]},                              (opcional; la gramática común
//                                                                                          de server/lib/conditions.mjs)
//     "actions": [{"type": "add_tag", "tagId": "…"}, {"type": "send_text", "text": "Hola, {{nombre}}…"}],
//     "options": {"stop": false, "limit": "always", "cooldownMinutes": 0}
//   }
//
// Las palabras clave se comparan sin mayúsculas, acentos ni signos (`keywordMatch`): «contiene» busca palabras completas,
// «exacto» exige el mensaje entero, «empieza con» mira las primeras palabras y «parecido» tolera erratas. Lo que escribe
// una persona nunca se compila como expresión regular.
import {
  LIMITS as CONDITION_LIMITS,
  defineFields,
  keywordMatch,
  normalize,
  normalizeText,
} from '../../lib/conditions.mjs';
import { hasWrittenAmount } from '../../lib/variables.mjs';
import { tokensIn } from '../../../public/kit/shared/flow-model.js';

export const LIMITS = Object.freeze({
  title: 80,
  words: CONDITION_LIMITS.maxWords,
  wordLength: CONDITION_LIMITS.maxWordLength,
  actions: 8,
  text: 4096,
  bytes: 16_384,
  rulesPerBrand: 100,
  cooldownMinutes: 10_080, // una semana
  maxConsecutive: 20,
});

export const TRIGGERS = Object.freeze({
  keyword: 'El mensaje tiene una palabra clave',
  any_message: 'Cualquier mensaje',
});
export const MODES = Object.freeze({
  contains: 'Contiene la palabra',
  exact: 'Es exactamente',
  starts_with: 'Empieza con',
  fuzzy: 'Se parece (tolera erratas)',
});
export const LIMIT_KINDS = Object.freeze({
  always: 'Cada vez que coincide',
  once_conversation: 'Una sola vez por conversación',
  cooldown: 'Con un descanso entre una vez y otra',
});
export const CHANNELS = Object.freeze({ whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook' });
export const STATUS_TARGETS = Object.freeze({ pending: 'Pendiente', solved: 'Resuelta' });

// Clases de acción (diseño §5.5): «silenciosa» no escribe a la persona ni cambia quién atiende; «voz» le escribe;
// «control» cambia quién atiende o el estado. Dentro de una regla corren en ese orden; entre reglas, sólo la primera
// que coincide con voz o control las ejecuta (las silenciosas de todas las que coinciden sí corren).
export const ACTIONS = Object.freeze({
  add_tag: { kind: 'silent', label: 'Agregar etiqueta' },
  remove_tag: { kind: 'silent', label: 'Quitar etiqueta' },
  send_text: { kind: 'voice', label: 'Responder con un texto' },
  send_material: { kind: 'voice', label: 'Enviar un material aprobado' },
  start_flow: { kind: 'voice', label: 'Iniciar un recorrido' },
  handoff: { kind: 'control', label: 'Pasar con una persona' },
  set_status: { kind: 'control', label: 'Cambiar el estado de la conversación' },
});
const CLASS_ORDER = { silent: 0, voice: 1, control: 2 };
export const kindOf = action => ACTIONS[action?.type]?.kind ?? null;
export const ordered = actions =>
  actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => CLASS_ORDER[kindOf(x.a)] - CLASS_ORDER[kindOf(y.a)] || x.i - y.i)
    .map(x => x.a);
export const speaks = definition => definition.actions.some(a => kindOf(a) !== 'silent');

// Campos de las condiciones «sólo si» (ámbito del mensaje). El registro lee de un objeto que arma quien evalúa.
export const FIELDS = defineFields([
  { key: 'channel', label: 'Canal', type: 'choice', options: Object.keys(CHANNELS), ops: ['in', 'not_in'] },
  { key: 'course', label: 'Curso', type: 'choice', ops: ['in', 'not_in'] },
  { key: 'hours', label: 'Horario de atención', type: 'choice', options: ['open', 'closed'], ops: ['eq'] },
  { key: 'tags', label: 'Etiquetas del contacto', type: 'list', ops: ['any', 'all', 'none'] },
  { key: 'first_message', label: 'Primer mensaje de la conversación', type: 'boolean', ops: ['is'] },
]);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = (v, max) =>
  typeof v === 'string'
    ? v
        .replace(/[^\P{Cc}\t\n\r]/gu, '')
        .trim()
        .slice(0, max + 1)
    : '';
const id = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : '');

function invalid(problems) {
  const more = problems.length > 1 ? ` (y ${problems.length - 1} más)` : '';
  return Object.assign(new Error(problems[0] + more), {
    status: 400,
    code: 'rule_invalid',
    details: { problems },
  });
}

// Texto que escribe la marca: sus datos {{…}} deben existir, sin variables de recorrido y sin importes tecleados
// (el precio sólo sale del catálogo, con {{precio}}).
export function textProblems(text, what = 'El texto') {
  const out = [];
  if (!text) return [what + ' está vacío.'];
  if (text.length > LIMITS.text) out.push(`${what} es demasiado largo: ${text.length} de ${LIMITS.text} caracteres.`);
  for (const t of tokensIn(text)) {
    if (t.kind === 'unknown') out.push(`${what} usa un dato que no existe: ${t.raw}.`);
    else if (t.kind === 'var') out.push(`${what} usa ${t.raw}: las variables de un recorrido no existen en una regla.`);
  }
  const bare = text.replace(/\{\{[^{}]*\}\}/g, ' ');
  if (bare.includes('{{') || bare.includes('}}')) out.push(`${what} tiene llaves {{ }} sin cerrar.`);
  if (hasWrittenAmount(bare))
    out.push(`${what} lleva un importe escrito a mano: usa {{precio}}, que sale del catálogo.`);
  return out;
}

function normalizeTrigger(value, problems) {
  const type = Object.hasOwn(TRIGGERS, value?.type) ? value.type : null;
  if (!type) {
    problems.push('Elige cuándo se activa la regla: con una palabra clave o con cualquier mensaje.');
    return { type: 'keyword', mode: 'contains', words: [] };
  }
  if (type === 'any_message') return { type };
  const mode = Object.hasOwn(MODES, value.mode) ? value.mode : 'contains';
  const raw = Array.isArray(value.words) ? value.words : [];
  const words = [];
  const seen = new Set();
  for (const w of raw) {
    const word = clean(w, LIMITS.wordLength).replace(/\s+/g, ' ');
    if (!word) continue;
    if (word.length > LIMITS.wordLength) {
      problems.push(`La palabra clave «${word.slice(0, 20)}…» pasa de ${LIMITS.wordLength} caracteres.`);
      continue;
    }
    const key = normalizeText(word);
    if (!key) {
      problems.push(`La palabra clave «${word}» necesita al menos una letra o un número.`);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  if (!words.length) problems.push('Escribe al menos una palabra clave.');
  if (words.length > LIMITS.words) problems.push(`Una regla admite hasta ${LIMITS.words} palabras clave.`);
  const out = { type, mode, words: words.slice(0, LIMITS.words) };
  if (mode === 'fuzzy') {
    const t = value.threshold ?? CONDITION_LIMITS.defaultThreshold;
    if (!Number.isInteger(t) || t < CONDITION_LIMITS.minThreshold || t > CONDITION_LIMITS.maxThreshold)
      problems.push(
        `El parecido debe ser un número entero entre ${CONDITION_LIMITS.minThreshold} y ${CONDITION_LIMITS.maxThreshold}.`,
      );
    out.threshold = Number.isInteger(t) ? t : CONDITION_LIMITS.defaultThreshold;
  }
  return out;
}

function normalizeAction(a, n, problems) {
  const where = `Acción ${n}`;
  if (!isObject(a) || !Object.hasOwn(ACTIONS, a.type)) {
    problems.push(`${where}: elige qué hace.`);
    return null;
  }
  const { type } = a;
  if (type === 'send_text') {
    const text = typeof a.text === 'string' ? a.text.replace(/[^\P{Cc}\t\n\r]/gu, '').trim() : '';
    problems.push(...textProblems(text, `${where} (texto)`));
    return { type, text };
  }
  if (type === 'send_material') {
    const materialId = id(a.materialId);
    if (!materialId) problems.push(`${where}: elige el material aprobado que se envía.`);
    return { type, materialId };
  }
  if (type === 'start_flow') {
    const flowId = id(a.flowId);
    if (!flowId) problems.push(`${where}: elige el recorrido que inicia.`);
    return { type, flowId };
  }
  if (type === 'add_tag' || type === 'remove_tag') {
    const tagId = id(a.tagId);
    if (!tagId) problems.push(`${where}: elige la etiqueta.`);
    return { type, tagId };
  }
  if (type === 'handoff') {
    const to = a.to === 'user' ? 'user' : 'queue';
    const out = { type, to };
    if (to === 'user') {
      out.userId = id(a.userId);
      if (!out.userId) problems.push(`${where}: elige a la persona del equipo.`);
    }
    const text = typeof a.text === 'string' ? a.text.replace(/[^\P{Cc}\t\n\r]/gu, '').trim() : '';
    if (text) {
      problems.push(...textProblems(text, `${where} (aviso a la persona)`));
      out.text = text;
    }
    return out;
  }
  // set_status
  if (!Object.hasOwn(STATUS_TARGETS, a.status)) {
    problems.push(`${where}: elige el estado (Pendiente o Resuelta).`);
    return { type, status: 'pending' };
  }
  return { type, status: a.status };
}

function normalizeOptions(o, problems) {
  const limit = Object.hasOwn(LIMIT_KINDS, o?.limit) ? o.limit : 'always';
  const out = { stop: o?.stop === true, limit };
  if (limit === 'cooldown') {
    const m = o.cooldownMinutes;
    if (!Number.isInteger(m) || m < 1 || m > LIMITS.cooldownMinutes)
      problems.push(`El descanso debe ser de 1 a ${LIMITS.cooldownMinutes} minutos.`);
    out.cooldownMinutes = Number.isInteger(m) ? Math.min(Math.max(m, 1), LIMITS.cooldownMinutes) : 60;
  }
  return out;
}

// Deja la definición en su forma canónica o lanza un error 400 con la lista de problemas, en palabras de quien arma la
// regla. Sólo revisa la forma; que los materiales, recorridos, etiquetas y personas existan lo revisa `referenceIssues`.
export function normalizeDefinition(input) {
  const problems = [];
  if (!isObject(input)) throw invalid(['La regla no es válida.']);
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  } catch {
    throw invalid(['La regla no se puede guardar: no son datos simples.']);
  }
  if (bytes > LIMITS.bytes) throw invalid([`La regla ocupa demasiado: el máximo es ${LIMITS.bytes / 1024} KB.`]);
  const trigger = normalizeTrigger(input.trigger, problems);
  let conditions = null;
  if (input.conditions !== undefined && input.conditions !== null) {
    try {
      conditions = normalize(input.conditions, FIELDS);
      if (!conditions.groups.length) conditions = null;
    } catch (error) {
      problems.push(...(error.problems ?? [error.message]));
    }
  }
  const raw = Array.isArray(input.actions) ? input.actions : [];
  if (!raw.length) problems.push('Agrega al menos una acción: qué hace la regla cuando coincide.');
  if (raw.length > LIMITS.actions) problems.push(`Una regla admite hasta ${LIMITS.actions} acciones.`);
  const actions = raw
    .slice(0, LIMITS.actions)
    .map((a, i) => normalizeAction(a, i + 1, problems))
    .filter(Boolean);
  const count = type => actions.filter(a => a.type === type).length;
  if (count('start_flow') > 1) problems.push('Una regla inicia como mucho un recorrido.');
  if (actions.filter(a => kindOf(a) === 'control').length > 1)
    problems.push('Una regla puede pasar con una persona o cambiar el estado, pero no las dos cosas.');
  if (count('start_flow') && actions.some(a => kindOf(a) === 'control'))
    problems.push(
      'Un recorrido que empieza no puede terminar en la misma regla: quita «Pasar con una persona» o «Estado».',
    );
  if (count('start_flow') && actions.some(a => a.type === 'send_text' || a.type === 'send_material'))
    problems.push(
      'Si la regla inicia un recorrido, los mensajes los manda el recorrido: quita los textos y materiales.',
    );
  const tags = actions.filter(a => a.type === 'add_tag' || a.type === 'remove_tag').map(a => a.tagId);
  if (new Set(tags).size !== tags.length) problems.push('Cada etiqueta va en una sola acción.');
  const options = normalizeOptions(input.options, problems);
  if (problems.length) throw invalid(problems);
  return { v: 1, trigger, conditions, actions, options };
}

// Referencias que deben existir en la marca para que la regla pueda encenderse (y que se vuelven a revisar al correr):
// materiales aprobados, recorridos publicados y activos, etiquetas, personas del equipo y cursos de las condiciones.
export function referenceIssues(definition, lists) {
  const out = [];
  const has = (items, value) => items.some(x => x.id === value);
  for (const [i, a] of definition.actions.entries()) {
    const where = `Acción ${i + 1}`;
    if (a.type === 'send_material' && !lists.materials.some(m => m.id === a.materialId && m.status === 'approved'))
      out.push(`${where}: el material no existe en esta marca o no está aprobado.`);
    if (a.type === 'start_flow' && !lists.flows.some(f => f.id === a.flowId && f.active))
      out.push(`${where}: el recorrido no está publicado y activo.`);
    if ((a.type === 'add_tag' || a.type === 'remove_tag') && !has(lists.tags, a.tagId))
      out.push(`${where}: la etiqueta no existe en esta marca.`);
    if (a.type === 'handoff' && a.to === 'user' && !lists.users.some(u => u.id === a.userId && u.active))
      out.push(`${where}: la persona elegida no está activa en esta marca.`);
  }
  for (const group of definition.conditions?.groups ?? [])
    for (const r of group.rules) {
      if (r.field === 'course')
        for (const c of r.value)
          if (!has(lists.courses, c)) out.push(`Condición: el curso «${c}» no es de esta marca.`);
      if (r.field === 'tags')
        for (const t of r.value)
          if (!has(lists.tags, t)) out.push('Condición: una etiqueta ya no existe en esta marca.');
    }
  return [...new Set(out)];
}

// ¿El texto coincide con el disparador? Devuelve `{word, mode}` (la palabra que coincidió) o `null`. Con «cualquier
// mensaje», cualquier texto con letras o números coincide; un archivo sin texto nunca.
export function triggerMatch(trigger, text) {
  const haystack = normalizeText(text);
  if (!haystack) return null;
  if (trigger.type === 'any_message') return { word: null, mode: 'any_message' };
  if (trigger.mode === 'starts_with') {
    for (const word of trigger.words) {
      const needle = normalizeText(word);
      if (needle && (haystack + ' ').startsWith(needle + ' ')) return { word, mode: 'starts_with' };
    }
    return null;
  }
  const hit = keywordMatch(text, trigger.words, { mode: trigger.mode, threshold: trigger.threshold });
  return hit ? { word: hit.word, mode: hit.mode } : null;
}

// Resumen corto de una regla para la lista: «Cuando dice “precio” → Responder con un texto, Agregar etiqueta».
export function summary(definition) {
  const t = definition.trigger;
  const when =
    t.type === 'any_message' ? 'Cualquier mensaje' : MODES[t.mode] + ': ' + t.words.map(w => '«' + w + '»').join(', ');
  const what = definition.actions.map(a => ACTIONS[a.type]?.label ?? a.type).join(' · ');
  return { when, what };
}
