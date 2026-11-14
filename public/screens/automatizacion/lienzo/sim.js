// Panel «Probar»: recorre el grafo con entradas de prueba y muestra lo que recibiría la persona.
//
// Es una vista previa local, para ver la forma del recorrido mientras se arma: usa los datos de ejemplo que recibe el
// lienzo (`catalogue`) y nunca envía ni guarda nada. El simulador que publica el servidor usa los mismos pasos con el
// catálogo real y con el asistente de verdad; aquí, donde contestaría el asistente, se deja una nota que lo dice.
//
// La primera mitad del archivo es el recorrido en sí, sin DOM (simulationEnv, simStart, simInput): se prueba con
// `node --test`. La segunda es el panel.

import {
  CHANNELS,
  FLOW_RESULTS,
  INTENTS,
  SYSTEM_ATTRIBUTES,
  findRef,
  flowResult,
  norm,
  normalizeGraph,
  normalizeSettings,
  refName,
  tokensIn,
} from '../../../kit/shared/flow-model.js';
import { html, render } from './dom.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------------------------------------------------------------
// Recorrido de prueba (sin DOM)
// ---------------------------------------------------------------------------------------------------------------------

// Tope de pasos seguidos sin esperar a la persona. El motor real cede el turno cada 25 pasos; aquí basta con no
// colgar el navegador si el recorrido tiene un ciclo que nunca espera.
const STEP_CAP = 200;
const clone = value => JSON.parse(JSON.stringify(value));

// Prepara lo que no cambia durante una prueba. `now` es {day: 0-6 (0 = domingo), minutes} u omitido; `open` dice si la
// marca está en horario. Se reciben como datos para que el mismo guion dé siempre el mismo resultado.
export function simulationEnv({
  graph,
  settings,
  catalogue,
  courseId = null,
  channel = 'whatsapp',
  now = null,
  open = true,
} = {}) {
  const canonical = normalizeGraph(graph);
  const byId = new Map(canonical.nodes.map(n => [n.id, n]));
  const out = new Map(canonical.edges.map(e => [e.from + '\n' + e.port, e.to]));
  return {
    graph: canonical,
    settings: normalizeSettings(settings),
    catalogue: catalogue || {},
    courseId,
    channel,
    now,
    open,
    byId,
    target: (id, port) => out.get(id + '\n' + port) ?? null,
  };
}

const courseOf = (env, s) => (env.catalogue.courses || []).find(c => c.id === s.courseId) || null;
const say = (s, node, entry) => s.transcript.push({ who: 'out', nodeId: node.id, ...entry });
const note = (s, node, text) => s.transcript.push({ who: 'note', nodeId: node ? node.id : null, text });

function finish(s, node, outcome) {
  s.status = 'ended';
  s.outcome = outcome;
  s.waiting = null;
  s.trace.push({ nodeId: node ? node.id : null, event: 'end', outcome });
}

function hold(s, node, waiting) {
  s.status = 'waiting';
  s.waiting = { nodeId: node.id, misses: 0, attempts: 0, ...waiting };
  s.trace.push({ nodeId: node.id, event: 'wait' });
}

// Sigue por una salida. Una salida sin conectar termina el recorrido; si era «sin respuesta» cuenta como abandono y
// si era «si no elige», como que la persona salió escribiendo.
function go(env, s, node, port) {
  s.trace.push({ nodeId: node.id, event: 'exit', port });
  const to = env.target(node.id, port);
  if (to) {
    s.status = 'running';
    s.waiting = null;
    s.nodeId = to;
    return;
  }
  finish(s, node, port === 'timeout' ? 'timeout' : port === 'default' ? 'left' : 'completed');
}

// Valores de los datos {{…}} para la persona y el curso de la prueba. Lo que el ejemplo no trae se muestra entre
// corchetes, para que quien prueba vea qué dato va ahí; el nombre vacío se quita con su coma, como al enviar de verdad.
function valuesFor(env, s) {
  const course = courseOf(env, s);
  const e = course?.edition || {};
  const contact = env.catalogue.contact || {};
  const name = String(contact.name || '').trim();
  const base = {
    nombre: name.split(/\s+/)[0] || '',
    nombre_completo: name,
    curso: course?.title,
    edicion: e.name,
    marca: env.catalogue.brand?.name,
    docente: e.instructor,
    modalidad: e.modality,
    temario: course?.syllabus,
    incluye: course?.highlights,
    duracion: course?.duration,
    sesiones: Array.isArray(e.sessions) ? e.sessions.join('\n') : e.sessions,
    fecha: e.starts,
    precio: e.price,
    precio_regular: e.regularPrice,
    promocion: e.promotion,
    vigencia: e.validUntil,
    vigencia_corta: e.validShort,
    ahorro: e.saving,
    cupo: e.seats,
    enlace: e.link,
  };
  return token => {
    if (token.kind === 'var') return s.vars[token.key] ?? '';
    if (token.kind === 'contact') return s.attrs[token.key] ?? base[token.key] ?? '';
    if (token.kind !== 'base') return token.raw;
    const value = base[token.name];
    if (value !== undefined && value !== null && value !== '') return value;
    return token.name.startsWith('nombre') ? '' : `[${token.name}]`;
  };
}

// Sustituye los datos de un texto. Un dato vacío sin respaldo desaparece junto con la coma que lo precede.
export function fill(env, s, body) {
  const value = valuesFor(env, s);
  return String(body ?? '')
    .replace(/(,\s*)?(\{\{[^{}]*\}\})/g, (whole, comma, raw) => {
      const token = tokensIn(raw)[0];
      const found = String(value(token) ?? '');
      const shown = found !== '' ? found : (token.fallback ?? '');
      return shown ? (comma || '') + shown : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Material aprobado más específico de un espacio: el de la edición, luego el del curso, luego el general de la marca.
function slotMaterial(env, s, slot) {
  const course = courseOf(env, s);
  const ready = (env.catalogue.materials || []).filter(m => m.slot === slot && (!m.status || m.status === 'approved'));
  return (
    ready.find(m => m.editionId && m.editionId === course?.edition?.id) ||
    ready.find(m => !m.editionId && m.courseId && m.courseId === course?.id) ||
    ready.find(m => !m.editionId && !m.courseId) ||
    null
  );
}

function sendMaterial(env, s, node, material) {
  if (!material) return note(s, node, 'Aquí se enviaría el material elegido (no está entre los datos de ejemplo).');
  const body = fill(env, s, material.text || '');
  if (!body && !material.media) return note(s, node, `Aquí se enviaría el material «${material.name}».`);
  return say(s, node, { label: 'Material: ' + material.name, media: material.media || '', text: body });
}

// La edición del curso de la prueba, o null si no se puede vender (sin curso, sin edición o marcada como no disponible).
function editionOf(env, s) {
  const course = courseOf(env, s);
  return course?.edition && course.edition.available !== false ? course.edition : null;
}

// Regla común de los pasos de catálogo: si la edición no está disponible y la salida «No disponible» no está
// conectada, el recorrido hace lo mismo que el asistente: lo dice y pasa con una persona.
function unavailable(env, s, node) {
  if (env.target(node.id, 'unavailable')) return go(env, s, node, 'unavailable');
  say(s, node, {
    text: 'Por ahora esta edición no está disponible. Ya le avisé a un asesor para que te proponga otra opción.',
  });
  note(s, node, 'La salida «No disponible» no está conectada: la conversación pasaría con una persona.');
  return finish(s, node, 'handoff');
}

const shown = (value, what) => (value !== undefined && value !== null && value !== '' ? String(value) : `[${what}]`);

function cardText(course, e) {
  const lines = [`${course.title} · ${shown(e.name, 'edición')}`, `• Inicio: ${shown(e.starts, 'fecha')}`];
  if (e.instructor) lines.push(`• Docente: ${e.instructor}`);
  if (e.modality) lines.push(`• Modalidad: ${e.modality}${e.location ? ' · ' + e.location : ''}`);
  lines.push(`• Precio: ${priceText(e)}`);
  return lines.join('\n');
}

function priceText(e) {
  const promo = e.promotion
    ? ` con la promoción «${e.promotion}»${e.validUntil ? ', vigente hasta el ' + e.validUntil : ''}`
    : '';
  return shown(e.price, 'precio') + promo;
}

// Envía el mensaje de un paso que ofrece opciones (también al repetirlas) y devuelve esas opciones.
function offer(env, s, node) {
  const d = node.data;
  // Una plantilla de WhatsApp no se reenvía: sus botones siguen valiendo tal como están.
  if (node.type === 'template') return s.waiting ? s.waiting.options : [];
  if (node.type === 'buttons') {
    const head = d.header.kind === 'text' ? fill(env, s, d.header.text) : '';
    const media = d.header.kind === 'media' ? refName(env.catalogue, 'files', d.header.fileId) || 'archivo' : '';
    say(s, node, {
      flyer: d.header.kind === 'course_flyer',
      media,
      header: head,
      text: fill(env, s, d.text),
      footer: d.footer,
      options: d.options.map(o => o.label),
    });
    return d.options.map(o => ({ id: o.id, title: o.label, do: o.do }));
  }
  const rows = d.sections.flatMap(section => section.rows);
  // Los canales sin listas la reciben como texto numerado y aceptan el número.
  const numbered = env.channel !== 'whatsapp';
  const body = fill(env, s, d.text);
  say(s, node, {
    header: d.header,
    text: numbered ? `${body}\n\n${rows.map((r, i) => `${i + 1}. ${r.title}`).join('\n')}` : body,
    footer: d.footer,
    options: numbered ? [] : rows.map(r => r.title),
    listButton: numbered ? '' : d.button,
  });
  return rows.map(r => ({ id: r.id, title: r.title, do: r.do }));
}

const RUN = {
  start: (env, s, node) => go(env, s, node, 'next'),

  message(env, s, node) {
    for (const p of node.data.parts) {
      if (p.kind === 'text') say(s, node, { text: fill(env, s, p.text) });
      else if (p.kind === 'media') {
        say(s, node, { media: refName(env.catalogue, 'files', p.fileId) || 'archivo', text: fill(env, s, p.caption) });
      } else if (p.kind === 'material') sendMaterial(env, s, node, findRef(env.catalogue, 'materials', p.templateId));
      else {
        const material = slotMaterial(env, s, p.slot);
        if (material) sendMaterial(env, s, node, material);
        else if (p.ifMissing === 'stop') {
          note(
            s,
            node,
            `No hay un material aprobado en el espacio «${p.slot}» para este curso: el recorrido se detendría aquí.`,
          );
          return finish(s, node, 'error');
        } else note(s, node, `Sin material aprobado en el espacio «${p.slot}» para este curso: esta parte se salta.`);
      }
    }
    return go(env, s, node, 'next');
  },

  buttons(env, s, node) {
    hold(s, node, { kind: 'options', options: offer(env, s, node), numbered: env.channel !== 'whatsapp' });
  },

  list(env, s, node) {
    hold(s, node, { kind: 'options', options: offer(env, s, node), numbered: true });
  },

  question(env, s, node) {
    say(s, node, { text: fill(env, s, node.data.text) });
    hold(s, node, { kind: 'answer' });
  },

  template(env, s, node) {
    const d = node.data;
    const tpl = findRef(env.catalogue, 'waTemplates', d.waTemplateId);
    say(s, node, {
      label: 'Plantilla de WhatsApp' + (tpl ? ': ' + tpl.name : ''),
      text: tpl?.text ? fill(env, s, tpl.text) : '',
      options: d.buttons,
    });
    if (!d.wait || !d.buttons.length) return go(env, s, node, 'next');
    const options = d.buttons.map((title, i) => ({ id: String(i + 1), title, do: { type: 'goto' } }));
    return hold(s, node, { kind: 'options', options, numbered: env.channel !== 'whatsapp' });
  },

  condition(env, s, node) {
    const hit = node.data.cases.find(c => matchesWhen(env, s, c.when));
    note(
      s,
      node,
      hit
        ? `Condición: se cumple «${hit.label || 'el caso'}».`
        : 'Condición: no se cumple ningún caso; sigue por «Si no».',
    );
    go(env, s, node, hit ? 'case:' + hit.id : 'else');
  },

  delay(env, s, node) {
    const n = node.data.seconds;
    note(s, node, `Esperaría ${n} ${n === 1 ? 'segundo' : 'segundos'} (en la prueba no se espera).`);
    go(env, s, node, 'next');
  },

  set_attribute(env, s, node) {
    const d = node.data;
    const value =
      d.value.from === 'fixed'
        ? fill(env, s, d.value.text)
        : d.value.from === 'var'
          ? String(s.vars[d.value.name] ?? '')
          : s.lastText;
    const label = refName(env.catalogue, 'attributes', d.key) || SYSTEM_ATTRIBUTES[d.key]?.label || d.key;
    s.attrs[d.key] = value;
    note(s, node, `Guardaría el dato «${label}» con el valor «${value}».`);
    go(env, s, node, 'next');
  },

  tags(env, s, node) {
    const d = node.data;
    const names = list => list.map(id => '«' + (refName(env.catalogue, 'tags', id) || id) + '»').join(', ');
    s.tags = [...s.tags.filter(id => !d.remove.includes(id) && !d.add.includes(id)), ...d.add];
    const parts = [];
    if (d.add.length) parts.push('pondría ' + names(d.add));
    if (d.remove.length) parts.push('quitaría ' + names(d.remove));
    note(s, node, 'Etiquetas: ' + (parts.join(' y ') || 'ninguna') + '.');
    go(env, s, node, 'next');
  },

  consent(env, s, node) {
    const subscribe = node.data.action === 'subscribe';
    note(
      s,
      node,
      subscribe ? 'Registraría que la persona quiere recibir novedades.' : 'Registraría la baja de novedades.',
    );
    go(env, s, node, 'next');
  },

  handoff(env, s, node) {
    const d = node.data;
    if (d.text.trim()) say(s, node, { text: fill(env, s, d.text) });
    const who =
      d.to === 'queue'
        ? 'a la cola del equipo'
        : d.to === 'last'
          ? 'a quien atendió la última vez'
          : 'a ' + (refName(env.catalogue, 'users', d.userId) || 'la persona elegida');
    note(s, node, `La conversación pasaría con una persona (${who}).`);
    finish(s, node, 'handoff');
  },

  status(env, s, node) {
    if (node.data.status === 'resolved') {
      note(s, node, 'Daría la conversación por resuelta.');
      return finish(s, node, 'completed');
    }
    note(s, node, 'Dejaría la conversación en espera.');
    return go(env, s, node, 'next');
  },

  assistant(env, s, node) {
    const d = node.data;
    if (d.mode === 'handover') {
      note(s, node, 'A partir de aquí seguiría el asistente con la persona.');
      return finish(s, node, 'assistant');
    }
    if (d.mode === 'collect') {
      note(s, node, `El asistente pediría con sus palabras: ${d.prompt || 'el dato'}.`);
      return hold(s, node, { kind: 'collect' });
    }
    note(
      s,
      node,
      s.lastText
        ? `El asistente contestaría el último mensaje («${s.lastText}»).`
        : 'El asistente contestaría el último mensaje de la persona.',
    );
    return go(env, s, node, 'next');
  },

  goto_flow(env, s, node) {
    const name = refName(env.catalogue, 'flows', node.data.flowId);
    note(s, node, name ? `Aquí empezaría el recorrido «${name}».` : 'Aquí empezaría el otro recorrido.');
    finish(s, node, 'replaced');
  },

  webhook(env, s, node) {
    const d = node.data;
    let sample = null;
    try {
      sample = d.sample.trim() ? JSON.parse(d.sample) : null;
    } catch {
      sample = null;
    }
    note(
      s,
      node,
      sample === null
        ? 'No se llama al servicio en la prueba, y el paso no tiene una respuesta de ejemplo: los datos quedan vacíos.'
        : 'No se llama al servicio en la prueba: se usa la respuesta de ejemplo del paso.',
    );
    for (const m of d.map) {
      const found = sample === null ? undefined : readPath(sample, m.path);
      save(
        s,
        m.saveTo,
        found === undefined || found === null ? '' : typeof found === 'object' ? JSON.stringify(found) : String(found),
      );
    }
    go(env, s, node, 'success');
  },

  end(env, s, node) {
    if (node.data.text.trim()) say(s, node, { text: fill(env, s, node.data.text) });
    finish(s, node, 'completed');
  },

  course_card(env, s, node) {
    const course = courseOf(env, s);
    const e = editionOf(env, s);
    if (!course || !e) return unavailable(env, s, node);
    const d = node.data;
    say(s, node, { flyer: d.flyer, text: d.text.trim() ? fill(env, s, d.text) : cardText(course, e) });
    return go(env, s, node, 'next');
  },

  price(env, s, node) {
    const course = courseOf(env, s);
    const e = editionOf(env, s);
    if (!course || !e) return unavailable(env, s, node);
    const d = node.data;
    if (d.templateId) sendMaterial(env, s, node, findRef(env.catalogue, 'materials', d.templateId));
    else {
      say(s, node, { text: `El precio de ${course.title} · ${shown(e.name, 'edición')} es de ${priceText(e)}.` });
      if (d.body === 'full') note(s, node, 'Además enviaría la invitación a inscribirse del asistente.');
    }
    return go(env, s, node, 'next');
  },

  syllabus(env, s, node) {
    const course = courseOf(env, s);
    const items = String(course?.syllabus || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => (/^([•\-–*]|\d+[.)])\s/.test(line) ? line : '• ' + line));
    say(s, node, {
      text: `Esto es lo que verás en ${shown(course?.title, 'curso')}:\n\n${items.length ? items.join('\n') : '[temario]'}`,
    });
    if (node.data.body === 'full') note(s, node, 'Además enviaría la invitación a ver el precio o las fechas.');
    go(env, s, node, 'next');
  },

  schedule(env, s, node) {
    const course = courseOf(env, s);
    const e = editionOf(env, s);
    if (!course || !e) return unavailable(env, s, node);
    const d = node.data;
    const lines = [
      `${course.title} · ${shown(e.name, 'edición')}`,
      `• Inicio: ${shown(e.starts, 'fecha')}`,
      `• Docente: ${e.instructor || 'por confirmar'}`,
    ];
    if (e.modality) lines.push(`• Modalidad: ${e.modality}${e.location ? ' · ' + e.location : ''}`);
    if (d.seats) lines.push(`• Lugares disponibles: ${shown(e.seats, 'cupo')}`);
    if (d.sessions)
      lines.push(
        '',
        'Sesiones:',
        ...(Array.isArray(e.sessions) && e.sessions.length ? e.sessions.map(x => '• ' + x) : ['[sesiones]']),
      );
    say(s, node, { text: lines.join('\n') });
    return go(env, s, node, 'next');
  },

  enroll(env, s, node) {
    const e = editionOf(env, s);
    if (!courseOf(env, s) || !e) return unavailable(env, s, node);
    if (e.saleEnabled === false) {
      note(s, node, 'La venta en línea está apagada para esta marca: sale por «Pago manual».');
      return go(env, s, node, 'manual');
    }
    say(s, node, { text: '[Aquí iría el pedido con su enlace de pago]' });
    return go(env, s, node, 'order');
  },

  choose_course(env, s, node) {
    const d = node.data;
    const courses = env.catalogue.courses || [];
    const known = courseOf(env, s);
    if (d.skipIfKnown && known) {
      note(s, node, `La conversación ya tiene curso («${known.title}»): pasa de largo.`);
      return go(env, s, node, 'next');
    }
    if (!courses.length) {
      note(s, node, 'No hay cursos entre los datos de ejemplo: el paso sigue sin preguntar.');
      return go(env, s, node, 'next');
    }
    say(s, node, { text: askCourse(env, courses, false) });
    return hold(s, node, { kind: 'course' });
  },
};

const askCourse = (env, courses, again) =>
  (again
    ? 'Para darte la información correcta necesito saber qué curso te interesa:'
    : `¿Sobre qué curso de ${shown(env.catalogue.brand?.name, 'marca')} te gustaría información?`) +
  '\n\n' +
  courses.map((c, i) => `${i + 1}. ${c.title}`).join('\n') +
  '\n\nResponde con el número o el nombre del curso.';

function readPath(value, path) {
  let at = value;
  for (const key of String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')) {
    if (at === null || typeof at !== 'object') return undefined;
    at = at[key];
  }
  return at;
}

function save(s, saveTo, value) {
  if (saveTo.kind === 'attribute') {
    if (saveTo.key) s.attrs[saveTo.key] = value;
  } else if (saveTo.name) s.vars[saveTo.name] = value;
}

// ---- Condiciones -----------------------------------------------------------------------------------------------------

function attrValue(env, s, key) {
  if (key.startsWith('var.')) return s.vars[key.slice(4)];
  if (s.attrs[key] !== undefined) return s.attrs[key];
  const contact = env.catalogue.contact || {};
  if (key === 'nombre')
    return String(contact.name || '')
      .trim()
      .split(/\s+/)[0];
  if (key === 'nombre_completo') return contact.name;
  if (key === 'canal') return env.channel;
  if (key === 'curso_interes') return s.courseId;
  if (key === 'estado_pago') return 'sin_pedido';
  return undefined;
}

function compare(actual, op, expected) {
  const a = norm(actual);
  const b = norm(expected);
  const numbers = [actual, expected].map(v => Number(String(v ?? '').replace(',', '.')));
  switch (op) {
    case 'eq':
      return a === b;
    case 'neq':
      return a !== b;
    case 'contains':
      return b !== '' && a.includes(b);
    case 'not_contains':
      return b === '' || !a.includes(b);
    case 'starts':
      return b !== '' && a.startsWith(b);
    case 'gt':
      return numbers[0] > numbers[1];
    case 'gte':
      return numbers[0] >= numbers[1];
    case 'lt':
      return numbers[0] < numbers[1];
    case 'lte':
      return numbers[0] <= numbers[1];
    case 'empty':
      return String(actual ?? '').trim() === '';
    case 'not_empty':
      return String(actual ?? '').trim() !== '';
    default:
      return false;
  }
}

const minutesOf = clock => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

function holds(env, s, item) {
  if (item.f === 'tag') return s.tags.includes(item.tagId) === (item.op === 'has');
  if (item.f === 'hours') return (env.open ? 'open' : 'closed') === item.is;
  if (item.f === 'course') return item.in.includes(s.courseId);
  if (item.f === 'channel') return item.in.includes(env.channel);
  if (item.f === 'clock') {
    if (!env.now || !item.days.includes(String(env.now.day))) return false;
    const from = minutesOf(item.from);
    const to = minutesOf(item.to);
    const at = env.now.minutes;
    // Un horario que cruza la medianoche (22:00 a 06:00) se cumple en sus dos tramos.
    return from <= to ? at >= from && at < to : at >= from || at < to;
  }
  return compare(attrValue(env, s, item.key), item.op, item.value);
}

export function matchesWhen(env, s, when) {
  const groups = when.groups.filter(g => g.items.length);
  if (!groups.length) return false;
  const results = groups.map(g =>
    g.mode === 'any' ? g.items.some(i => holds(env, s, i)) : g.items.every(i => holds(env, s, i)),
  );
  return when.mode === 'any' ? results.some(Boolean) : results.every(Boolean);
}

// ---- Respuestas ------------------------------------------------------------------------------------------------------

function parseDate(input) {
  const m = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/) || null;
  const iso = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const [year, month, day] = m
    ? [Number(m[3]), Number(m[2]), Number(m[1])]
    : iso
      ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      : [0, 0, 0];
  if (!year || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseTime(input) {
  const m = input.match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// Valida una respuesta según lo que espera la pregunta. Devuelve {ok, value}; `value` es lo que se guardaría.
export function checkAnswer(answer, input) {
  const typed = String(input.text ?? '').trim();
  const bad = { ok: false, value: '' };
  const inRange = n => (answer.min === undefined || n >= answer.min) && (answer.max === undefined || n <= answer.max);
  switch (answer.type) {
    case 'media': {
      const kinds = answer.mediaKinds || [];
      return input.media && (!kinds.length || kinds.includes(input.media))
        ? { ok: true, value: `[${input.media}]` }
        : bad;
    }
    case 'location':
      return input.location ? { ok: true, value: String(input.location) } : bad;
    case 'number': {
      const n = Number(typed.replace(',', '.'));
      return typed !== '' && Number.isFinite(n) && inRange(n) ? { ok: true, value: String(n) } : bad;
    }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(typed) ? { ok: true, value: typed.toLowerCase() } : bad;
    case 'phone': {
      const digits = typed.replace(/\D/g, '');
      return digits.length >= 8 && digits.length <= 15 ? { ok: true, value: digits } : bad;
    }
    case 'date': {
      const date = parseDate(typed);
      return date ? { ok: true, value: date } : bad;
    }
    case 'time': {
      const time = parseTime(typed);
      return time ? { ok: true, value: time } : bad;
    }
    case 'datetime': {
      const [first, second] = typed.split(/\s+/);
      const date = parseDate(first || '');
      const time = parseTime(second || '');
      return date && time ? { ok: true, value: `${date} ${time}` } : bad;
    }
    case 'regex':
      try {
        return new RegExp(answer.pattern).test(typed.slice(0, 200)) ? { ok: true, value: typed } : bad;
      } catch {
        return bad;
      }
    default:
      return typed !== '' && inRange(typed.length) ? { ok: true, value: typed } : bad;
  }
}

// Una opción se reconoce por el id de la pulsación, por el texto igual a su título (sin mayúsculas ni acentos) o, en
// una lista o texto numerado, por su número.
function pickOption(waiting, input) {
  if (input.optionId !== undefined && input.optionId !== null)
    return waiting.options.find(o => o.id === input.optionId) || null;
  const key = norm(input.text);
  if (!key) return null;
  const byTitle = waiting.options.find(o => norm(o.title) === key);
  if (byTitle) return byTitle;
  return waiting.numbered && /^\d+$/.test(key) ? waiting.options[Number(key) - 1] || null : null;
}

function pickCourse(courses, typed) {
  const key = norm(typed);
  if (!key) return null;
  if (/^\d+$/.test(key)) return courses[Number(key) - 1] || null;
  const exact = courses.find(c => norm(c.title) === key);
  if (exact) return exact;
  // «el de aves»: basta una palabra propia del título, si sólo un curso la lleva. El servidor usa además las palabras
  // clave de cada curso; aquí alcanza para probar el camino.
  const words = key.split(' ').filter(word => word.length >= 4);
  const hits = courses.filter(c => {
    const title = ' ' + norm(c.title) + ' ';
    return words.some(word => title.includes(' ' + word + ' '));
  });
  return hits.length === 1 ? hits[0] : null;
}

// La persona escribió algo que no es una opción. Por omisión contesta el asistente y cuenta como fallo; al agotarlos
// el recorrido termina («salió escribiendo»). Con «repetir» se manda el mensaje de reserva y se repiten las opciones.
function unexpected(env, s, node) {
  const w = s.waiting;
  const mode = node.data.onUnexpected || env.settings.onUnexpected;
  const max = env.settings.maxMisses;
  if (mode === 'default') {
    note(s, node, 'No es una de las opciones: sigue por «Si no elige».');
    return go(env, s, node, 'default');
  }
  w.misses += 1;
  s.trace.push({ nodeId: node.id, event: 'miss' });
  if (mode === 'repeat') {
    if (w.misses >= max) {
      note(s, node, `Van ${w.misses} mensajes fuera de las opciones: sale por «Si no elige».`);
      return go(env, s, node, 'default');
    }
    say(s, node, { text: fill(env, s, env.settings.fallbackText) || 'Elige una de las opciones, por favor.' });
    w.options = offer(env, s, node);
    return null;
  }
  note(s, node, 'No es una de las opciones: contestaría el asistente.');
  if (w.misses >= max) {
    note(s, node, `Van ${w.misses} mensajes fuera de las opciones: el recorrido termina y sigue el asistente.`);
    return finish(s, node, 'left');
  }
  if (env.settings.reofferOnDetour) note(s, node, 'Su respuesta volvería a ofrecer las opciones.');
  return null;
}

function advance(env, s) {
  let steps = 0;
  while (s.status === 'running') {
    const node = env.byId.get(s.nodeId);
    if (!node) {
      finish(s, null, 'completed');
      break;
    }
    steps += 1;
    if (steps > STEP_CAP) {
      note(
        s,
        node,
        `El recorrido dio más de ${STEP_CAP} pasos seguidos sin esperar a la persona: la prueba se detuvo aquí.`,
      );
      finish(s, node, 'error');
      break;
    }
    s.trace.push({ nodeId: node.id, event: 'enter' });
    const run = RUN[node.type];
    if (!run) {
      note(s, node, 'Este tipo de paso no existe en esta versión: el recorrido se detendría aquí.');
      finish(s, node, 'error');
      break;
    }
    run(env, s, node);
  }
  return s;
}

// Empieza una prueba. El estado que devuelve es un objeto simple: la conversación (`transcript`), la traza por paso
// (`trace`), en qué espera (`waiting`) y, al terminar, el resultado (`outcome`).
export function simStart(env) {
  const contact = env.catalogue.contact || {};
  return advance(env, {
    status: 'running',
    outcome: null,
    nodeId: env.graph.start,
    waiting: null,
    vars: {},
    attrs: { ...(contact.attributes || {}) },
    tags: [...(contact.tags || [])],
    courseId: env.courseId,
    lastText: '',
    transcript: [],
    trace: [],
  });
}

// Aplica una entrada de la persona: {text}, {optionId}, {media}, {location} o {timeout: true}. No cambia el estado
// recibido: devuelve uno nuevo.
export function simInput(env, state, input = {}) {
  if (state.status !== 'waiting') return state;
  const s = clone(state);
  const w = s.waiting;
  const node = env.byId.get(w.nodeId);
  if (!node) {
    finish(s, null, 'error');
    return s;
  }

  if (input.timeout) {
    const hours = env.settings.timeoutMinutes / 60;
    note(
      s,
      node,
      `La persona no responde en ${Number.isInteger(hours) ? hours + ' h' : env.settings.timeoutMinutes + ' min'}.`,
    );
    s.trace.push({ nodeId: node.id, event: 'timeout' });
    if (w.kind === 'collect') go(env, s, node, 'failure');
    else {
      if (!env.target(node.id, 'timeout') && env.settings.exitText)
        note(
          s,
          node,
          `Si la ventana de 24 horas sigue abierta enviaría el mensaje de salida: «${env.settings.exitText}».`,
        );
      go(env, s, node, 'timeout');
    }
    return advance(env, s);
  }

  const typed = String(input.text ?? '').trim();
  const sent = input.media ? `[${input.media}]` : input.location ? '[ubicación]' : typed;
  s.trace.push({ nodeId: node.id, event: 'input' });

  if (w.kind === 'options') {
    const choice = pickOption(w, input);
    s.transcript.push({ who: 'in', text: choice ? choice.title : sent });
    s.lastText = choice ? choice.title : sent;
    if (!choice) {
      unexpected(env, s, node);
      return advance(env, s);
    }
    if (node.data.saveAs) s.vars[node.data.saveAs] = choice.title;
    if (choice.do.type === 'intent') {
      note(
        s,
        node,
        `Respondería el asistente: ${INTENTS[choice.do.intent].toLowerCase()}.` +
          (choice.do.stay ? ' Las opciones siguen a la vista.' : ''),
      );
      if (!choice.do.stay) finish(s, node, choice.do.intent === 'human' ? 'handoff' : 'assistant');
      return s;
    }
    go(env, s, node, 'opt:' + choice.id);
    return advance(env, s);
  }

  s.transcript.push({ who: 'in', text: sent });
  s.lastText = sent;

  if (w.kind === 'course') {
    const courses = env.catalogue.courses || [];
    const course = pickCourse(courses, typed);
    if (course) {
      s.courseId = course.id;
      note(s, node, `La conversación queda en el curso «${course.title}».`);
      go(env, s, node, 'next');
      return advance(env, s);
    }
    w.attempts += 1;
    if (w.attempts >= node.data.attempts) {
      note(s, node, 'No se reconoció ningún curso: sale por «Ninguno».');
      go(env, s, node, 'none');
      return advance(env, s);
    }
    say(s, node, { text: askCourse(env, courses, true) });
    return s;
  }

  if (w.kind === 'collect') {
    save(s, node.data.saveTo, sent);
    note(s, node, 'El asistente tomaría el dato de esa respuesta y lo guardaría.');
    go(env, s, node, 'success');
    return advance(env, s);
  }

  const checked = checkAnswer(node.data.answer, input);
  if (checked.ok) {
    save(s, node.data.saveTo, checked.value);
    go(env, s, node, 'next');
    return advance(env, s);
  }
  w.attempts += 1;
  if (w.attempts >= node.data.attempts) {
    note(s, node, 'Se agotaron los intentos: sale por «No válida».');
    go(env, s, node, 'invalid');
    return advance(env, s);
  }
  say(s, node, { text: fill(env, s, node.data.errorText) || 'No pude tomar esa respuesta. ¿Me la escribes de nuevo?' });
  return s;
}

// Pasos por los que ya pasó la prueba, sin repetir y en orden: es lo que el lienzo resalta.
export const simTrail = state => [...new Set(state.trace.map(t => t.nodeId).filter(Boolean))];

// En qué paso está la prueba: donde espera o donde terminó.
export function simNode(state) {
  if (state.waiting) return state.waiting.nodeId;
  const last = [...state.trace].reverse().find(t => t.nodeId);
  return last ? last.nodeId : null;
}

const OUTCOMES = {
  completed: 'el recorrido llegó a su fin',
  assistant: 'el asistente sigue con la persona',
  replaced: 'continúa en otro recorrido',
  handoff: 'pasó con una persona del equipo',
  left: 'la persona escribió otra cosa y sigue el asistente',
  timeout: 'la persona no respondió',
  error: 'el recorrido no pudo seguir',
};

export const outcomeText = outcome => `${FLOW_RESULTS[flowResult(outcome)]}: ${OUTCOMES[outcome] || outcome}.`;

// ---------------------------------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------------------------------

const MEDIA_LABELS = { image: 'una imagen', document: 'un documento', video: 'un video', audio: 'un audio' };

const bubble = e => {
  if (e.who === 'note') return html`<p class="lz-chat-note">${icon('spark')}<span>${e.text}</span></p>`;
  if (e.who === 'in')
    return html`<div class="lz-bubble" data-who="in"><span class="lz-sr">La persona: </span>${e.text}</div>`;
  return html`<div class="lz-bubble" data-who="out">
    <span class="lz-sr">El recorrido: </span>
    ${e.label ? html`<span class="lz-bubble-tag">${e.label}</span>` : ''}
    ${e.flyer ? html`<span class="lz-bubble-media">${icon('image')} Ficha vigente del curso</span>` : ''}
    ${e.media ? html`<span class="lz-bubble-media">${icon('file')} ${e.media}</span>` : ''}
    ${e.header ? html`<strong class="lz-bubble-head">${e.header}</strong>` : ''}
    ${e.text ? html`<span class="lz-bubble-text">${e.text}</span>` : ''}
    ${e.footer ? html`<span class="lz-bubble-foot">${e.footer}</span>` : ''}
    ${e.listButton ? html`<span class="lz-bubble-opt">${icon('list')} ${e.listButton}</span>` : ''}
    ${e.options && e.options.length ? html`<span class="lz-bubble-opts">${e.options.map(o => html`<span class="lz-bubble-opt">${o}</span>`)}</span>` : ''}
  </div>`;
};

// Monta el panel de pruebas dentro de `container`. `options.catalogue()` devuelve los datos de ejemplo vigentes,
// `options.settings()` los ajustes del recorrido y `options.onClose()` avisa que la persona cerró la prueba.
export function createSimulator(container, store, options) {
  const uid = options.uid;
  const fieldIds = { course: uid('prueba-curso'), channel: uid('prueba-canal'), text: uid('prueba-texto') };
  let env = null;
  let state = null;
  let shownCount = 0;
  let stale = false;
  let courseId = null;
  let channel = 'whatsapp';
  let active = false;

  const doc = container.ownerDocument;
  const slot = name => container.querySelector(`[data-slot="${name}"]`);

  function shell() {
    const courses = options.catalogue().courses || [];
    render(
      container,
      html`<div class="lz-panel-head">
          <span class="lz-pill" data-group="atencion">${icon('test')}</span>
          <div class="lz-panel-names">
            <h2 class="lz-panel-title">Probar el recorrido</h2>
            <p class="lz-hint">Vista previa con datos de ejemplo: no se envía ni se guarda nada.</p>
          </div>
          <button type="button" class="lz-icon-btn" data-k="prueba-cerrar" aria-label="Cerrar la prueba">${icon('close')}</button>
        </div>
        <div class="lz-sim-setup">
          <div class="lz-field">
            <label for="${fieldIds.course}">Curso de la conversación</label>
            <select id="${fieldIds.course}" data-k="prueba-curso">
              <option value="">Sin curso (como un chat nuevo)</option>
              ${courses.map(c => html`<option value="${c.id}" ${c.id === courseId ? html`selected` : ''}>${c.title}</option>`)}
            </select>
          </div>
          <div class="lz-field">
            <label for="${fieldIds.channel}">Canal</label>
            <select id="${fieldIds.channel}" data-k="prueba-canal">
              ${CHANNELS.map(([id, label]) => html`<option value="${id}" ${id === channel ? html`selected` : ''}>${label}</option>`)}
            </select>
          </div>
          <button type="button" class="lz-btn" data-k="prueba-reiniciar">${icon('restart')} Empezar de nuevo</button>
        </div>
        <div data-slot="aviso"></div>
        <div class="lz-chat" role="log" aria-label="Conversación de prueba" tabindex="0" data-slot="chat"></div>
        <div class="lz-sim-controls" data-slot="controles"></div>`,
    );
  }

  function controls() {
    if (!state) return html``;
    if (state.status === 'ended') {
      return html`<p class="lz-sim-end" role="status">${icon('flag')}<span>Fin de la prueba. ${outcomeText(state.outcome)}</span></p>`;
    }
    const w = state.waiting;
    const node = env.byId.get(w.nodeId);
    const answer = w.kind === 'answer' ? node.data.answer : null;
    const kinds =
      answer?.type === 'media' ? (answer.mediaKinds.length ? answer.mediaKinds : Object.keys(MEDIA_LABELS)) : [];
    return html`${
      w.kind === 'options'
        ? html`<div class="lz-sim-options" role="group" aria-label="Opciones que ve la persona">
            ${w.options.map(o => html`<button type="button" class="lz-sim-option" data-k="prueba-opcion" data-id="${o.id}">${o.title || '(sin texto)'}</button>`)}
          </div>`
        : ''
    }
      ${
        kinds.length
          ? html`<div class="lz-sim-options">
            ${kinds.map(k => html`<button type="button" class="lz-sim-option" data-k="prueba-archivo" data-kind="${k}">Enviar ${MEDIA_LABELS[k]} de ejemplo</button>`)}
          </div>`
          : ''
      }
      ${answer?.type === 'location' ? html`<div class="lz-sim-options"><button type="button" class="lz-sim-option" data-k="prueba-ubicacion">Enviar una ubicación de ejemplo</button></div>` : ''}
      <form class="lz-sim-form" data-k="prueba-form">
        <label class="lz-sr" for="${fieldIds.text}">Escribe como si fueras la persona</label>
        <input id="${fieldIds.text}" type="text" name="texto" autocomplete="off" placeholder="Escribe como la persona…" />
        <button type="submit" class="lz-btn" aria-label="Enviar el mensaje de prueba">${icon('send')}</button>
      </form>
      <button type="button" class="lz-link" data-k="prueba-silencio">Simular que no responde</button>`;
  }

  // Sólo se agregan los mensajes nuevos: un lector de pantalla anuncia lo que llega, no toda la conversación otra vez.
  function sync(keepFocus) {
    const chat = slot('chat');
    if (!chat || !state) return;
    const fresh = state.transcript.slice(shownCount);
    if (fresh.length) {
      const holder = doc.createElement('div');
      render(holder, html`${fresh.map(bubble)}`);
      chat.append(...holder.childNodes);
      shownCount = state.transcript.length;
      chat.scrollTop = chat.scrollHeight;
    }
    render(
      slot('aviso'),
      stale
        ? html`<p class="lz-banner" role="status">El recorrido cambió desde que empezó esta prueba. <button type="button" class="lz-link" data-k="prueba-reiniciar">Probar la versión actual</button></p>`
        : html``,
    );
    render(slot('controles'), controls());
    if (keepFocus) (slot('controles').querySelector('input, button') || chat).focus();
    store.setOverlay({ simNode: simNode(state), simTrail: simTrail(state) });
    options.onStep(simNode(state));
  }

  function restart(keepFocus = false) {
    const date = new Date();
    env = simulationEnv({
      graph: store.graph,
      settings: options.settings(),
      catalogue: options.catalogue(),
      courseId,
      channel,
      now: { day: date.getDay(), minutes: date.getHours() * 60 + date.getMinutes() },
    });
    state = simStart(env);
    shownCount = 0;
    stale = false;
    const chat = slot('chat');
    if (chat) chat.replaceChildren();
    sync(keepFocus);
  }

  function step(input) {
    if (!state || state.status !== 'waiting') return;
    state = simInput(env, state, input);
    sync(true);
  }

  // Los eventos los reparte el lienzo desde su raíz (un solo `listen`): aquí sólo se declara qué hace cada verbo.
  const handlers = {
    click: {
      'prueba-cerrar': () => options.onClose(),
      'prueba-reiniciar': () => restart(true),
      'prueba-opcion': (event, el) => step({ optionId: el.dataset.id }),
      'prueba-archivo': (event, el) => step({ media: el.dataset.kind }),
      'prueba-ubicacion': () => step({ location: '19.4326,-99.1332' }),
      'prueba-silencio': () => step({ timeout: true }),
    },
    change: {
      'prueba-curso': (event, el) => {
        courseId = el.value || null;
        restart();
      },
      'prueba-canal': (event, el) => {
        channel = el.value;
        restart();
      },
    },
    submit: {
      'prueba-form': (event, el) => {
        const input = el.elements.texto;
        const typed = input.value.trim();
        if (!typed) return;
        input.value = '';
        step({ text: typed });
      },
    },
  };

  return {
    handlers,
    open() {
      active = true;
      shell();
      restart();
    },
    close() {
      active = false;
      env = null;
      state = null;
      container.replaceChildren();
      store.setOverlay({ simNode: null, simTrail: [] });
    },
    // Si el grafo cambia a media prueba, se avisa en lugar de reiniciar: la conversación ya escrita no se pierde.
    update(change) {
      if (!active || !change.graph || stale) return;
      stale = true;
      sync(false);
    },
    get active() {
      return active;
    },
    destroy() {
      container.replaceChildren();
    },
  };
}
