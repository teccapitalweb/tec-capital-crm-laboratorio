// Guía para que un asistente arme un recorrido válido (docs/PLAN_MCP_CLAUDE.md, «Armar recorridos en borrador»).
//
// Todo lo que dice sale del modelo compartido (public/kit/shared/flow-model.js) y de la lista de lo que el servidor
// todavía no ejecuta (flow-support.js): tipos de paso, sus datos, sus salidas, los límites y los ajustes. Así la guía no
// puede quedarse atrás del editor. Sin base de datos, sin red y sin reloj: la misma entrada da siempre la misma guía.
import {
  CHANNELS,
  DEFAULT_SETTINGS,
  GRAPH_VERSION,
  GROUPS,
  ID_RE,
  INTENTS,
  LIMITS,
  NODE_TYPES,
  TOKENS,
  VARIABLE_RE,
  VARIABLE_TYPES,
} from '../../public/kit/shared/flow-model.js';
import { SYSTEM_KEYS, UNAVAILABLE_TYPES, unsupportedProblems } from '../../public/kit/shared/flow-support.js';

const KINDS = {
  text: 'texto corto',
  area: 'texto largo',
  number: 'número entero',
  check: 'sí o no',
  choice: 'uno de los valores',
  multi: 'lista de valores',
  time: 'hora HH:MM',
  ref: 'id de una lista de la marca',
  refs: 'lista de ids de una lista de la marca',
  list: 'lista de elementos',
};
// De dónde sale cada id: la clave en «listas_de_la_marca» (las mismas listas que recibe el editor).
const SOURCES = {
  files: 'files',
  materials: 'materials',
  tags: 'tags',
  users: 'users',
  flows: 'flows',
  sequences: 'sequences',
  waTemplates: 'waTemplates',
  courses: 'courses',
  attributes: 'attributes',
  attributesAndVariables: 'attributes (o «var.<variable>» para una variable del recorrido)',
};

const pairs = options =>
  Array.isArray(options) && options.every(o => Array.isArray(o) && o.length === 2)
    ? Object.fromEntries(options.map(([value, label]) => [value === '' ? '(vacío)' : value, label]))
    : undefined;

function fieldView(f) {
  if (!f || f.kind === 'info') return null;
  const out = { campo: f.key, tipo: KINDS[f.kind] || f.kind };
  if (f.label) out.etiqueta = f.label;
  const options = pairs(f.options);
  if (options) out.valores = options;
  if (f.min !== undefined) out.min = f.min;
  if (f.max !== undefined) out.max = f.max;
  if (f.source) out.idsDe = SOURCES[f.source] || f.source;
  if (f.when) out.soloSi = { campo: f.when.key, es: f.when.is };
  if (f.tokens) out.admiteDatos = true;
  if (f.kind === 'list' && Array.isArray(f.fields)) out.cadaElemento = f.fields.map(fieldView).filter(Boolean);
  return out;
}

const clone = v => JSON.parse(JSON.stringify(v));
function setPath(root, path, value) {
  const keys = path.split('.');
  let at = root;
  for (const key of keys.slice(0, -1)) {
    if (at[key] === undefined || at[key] === null || typeof at[key] !== 'object') at[key] = {};
    at = at[key];
  }
  at[keys[keys.length - 1]] = value;
}

// Valores de una opción que el servidor todavía no ejecuta. Se averigua probando cada valor con la misma función que
// usa publicar (unsupportedProblems), sin escribirlo a mano: si mañana el servidor aprende a ejecutarlo, deja de salir.
function unsupportedValues(type, def) {
  const found = [];
  const probe = (fields, prefix) => {
    for (const f of fields || []) {
      if (f.kind === 'list') {
        probe(f.fields, prefix + f.key + '.0.');
        continue;
      }
      const values = f.kind === 'check' ? [true, false] : f.kind === 'choice' ? (f.options || []).map(o => o[0]) : [];
      const bad = [];
      for (const value of values) {
        const data = clone(def.defaults());
        setPath(data, prefix + f.key, value);
        const node = { id: 'n1', type, x: 0, y: 0, data: def.clean(data) };
        if (unsupportedProblems({ nodes: [node] }, { settings: { channels: ['whatsapp'] } }).length) bad.push(value);
      }
      if (bad.length && bad.length < values.length) found.push({ campo: prefix + f.key, valores: bad });
    }
  };
  probe(def.fields, '');
  return found;
}

function typeView(type, def) {
  const defaults = def.defaults();
  const ports = def.ports(defaults);
  const out = {
    tipo: type,
    nombre: def.label,
    grupo: GROUPS.find(g => g.id === def.group)?.label || def.group,
    hace: def.hint,
    // `waits` y `ports` sin parámetro no dependen de los datos del paso; con parámetro, sí.
    esperaRespuesta: def.waits.length ? 'según sus datos' : def.waits(defaults),
    datosPorOmision: defaults,
    salidas: ports.map(p => ({ id: p.id, etiqueta: p.label, ...(p.optional ? { opcional: true } : {}) })),
    ...(def.ports.length ? { salidasSegunDatos: true } : {}),
    ...(ports.length ? {} : { termina: type !== 'note' }),
    campos: (def.fields || []).map(fieldView).filter(Boolean),
  };
  if (Object.hasOwn(UNAVAILABLE_TYPES, type)) out.noDisponible = UNAVAILABLE_TYPES[type];
  const partial = Object.hasOwn(UNAVAILABLE_TYPES, type) ? [] : unsupportedValues(type, def);
  if (partial.length) out.valoresQueElServidorNoEjecuta = partial;
  if (type === 'start') out.nota = 'Hay exactamente uno y no recibe conexiones; su salida «next» lleva al primer paso.';
  if (type === 'note') out.nota = 'Sólo un comentario para el equipo: no se ejecuta ni se conecta.';
  return out;
}

// Recorrido de ejemplo: saluda, pregunta el curso, manda la ficha, ofrece inscribirse con botones y termina en la
// inscripción con enlace de pago o con una persona del equipo. Pasa la revisión sin errores en cualquier marca con
// cursos (no apunta a nada propio de una marca). test/mcp-recorridos.test.mjs lo comprueba.
export const EXAMPLE_GRAPH = Object.freeze({
  v: GRAPH_VERSION,
  start: 'n1',
  variables: [],
  nodes: [
    { id: 'n1', type: 'start', data: {} },
    {
      id: 'n2',
      type: 'message',
      title: 'Saludo',
      data: { parts: [{ kind: 'text', text: '¡Hola! Gracias por escribirnos a {{marca}}.' }] },
    },
    { id: 'n3', type: 'choose_course', data: { skipIfKnown: true, useMessage: true, attempts: 2 } },
    { id: 'n4', type: 'course_card', data: { text: '', flyer: true } },
    {
      id: 'n5',
      type: 'buttons',
      title: 'Invitación a inscribirse',
      data: {
        text: '¿Te gustaría inscribirte?',
        options: [
          { id: 'si', label: 'Sí, inscribirme', do: { type: 'goto' } },
          { id: 'temario', label: 'Ver el temario', do: { type: 'intent', intent: 'syllabus', stay: true } },
          { id: 'asesor', label: 'Hablar con alguien', do: { type: 'goto' } },
        ],
      },
    },
    { id: 'n6', type: 'enroll', data: {} },
    { id: 'n7', type: 'end', data: { text: '' } },
    { id: 'n8', type: 'handoff', data: { text: 'Te comunico con una persona del equipo.', to: 'queue' } },
  ],
  edges: [
    { from: 'n1', port: 'next', to: 'n2' },
    { from: 'n2', port: 'next', to: 'n3' },
    { from: 'n3', port: 'next', to: 'n4' },
    { from: 'n3', port: 'none', to: 'n8' },
    { from: 'n4', port: 'next', to: 'n5' },
    { from: 'n4', port: 'unavailable', to: 'n8' },
    { from: 'n5', port: 'opt:si', to: 'n6' },
    { from: 'n5', port: 'opt:asesor', to: 'n8' },
    { from: 'n6', port: 'order', to: 'n7' },
    { from: 'n6', port: 'manual', to: 'n8' },
    { from: 'n6', port: 'unavailable', to: 'n8' },
  ],
});

// La guía completa. `startTypes` y `keywordModes` son los del módulo de recorridos (los mismos que acepta al guardar).
// Con `tipos` sólo trae el detalle de esos tipos de paso (los demás, en una línea).
export function flowGuide({ startTypes = {}, keywordModes = [], tipos = null } = {}) {
  const wanted = Array.isArray(tipos) && tipos.length ? new Set(tipos) : null;
  const types = Object.entries(NODE_TYPES).map(([type, def]) =>
    !wanted || wanted.has(type)
      ? typeView(type, def)
      : { tipo: type, nombre: def.label, hace: def.hint, ...(UNAVAILABLE_TYPES[type] ? { noDisponible: true } : {}) },
  );
  return {
    queEs:
      'Un recorrido es una conversación guiada: pasos (nodes) unidos por conexiones (edges). Se guarda como BORRADOR; una persona lo revisa, lo publica y lo activa en el CRM (Automatización). Desde aquí nunca se publica ni se activa.',
    forma: {
      grafo: '{ "v": 1, "start": "<id del Inicio>", "variables": [], "nodes": [...], "edges": [...] }',
      paso: '{ "id": "n2", "type": "<tipo>", "title": "opcional, hasta ' + LIMITS.title + ' caracteres", "data": {…} }',
      conexion: '{ "from": "<id del paso>", "port": "<id de una de sus salidas>", "to": "<id de otro paso>" }',
      variable:
        '{ "name": "<nombre>", "label": "opcional", "type": "' + VARIABLE_TYPES.map(t => t[0]).join('|') + '" }',
      reglas: [
        `Ids de paso: ${ID_RE.source} (minúsculas y números, únicos).`,
        `Nombres de variable: ${VARIABLE_RE.source}.`,
        'Un solo paso de tipo «start»; «start» del grafo apunta a él.',
        'Cada salida de un paso lleva como mucho una conexión; varias salidas pueden ir al mismo paso. Al Inicio no llega ninguna y las notas no se conectan.',
        'Las salidas marcadas «opcional» pueden quedar sin conectar (el recorrido termina o contesta el asistente).',
        'Salidas que dependen de los datos: «opt:<id>» por cada botón o fila con do.type «goto» (en una Plantilla de WhatsApp, «opt:1», «opt:2»… por botón) y «case:<id>» por cada caso de una Condición.',
        'En «data» manda los campos del tipo; lo que falte toma el valor de «datosPorOmision». Un campo que no existe se descarta.',
        'Las posiciones x, y son opcionales: si ningún paso las trae, el conector los acomoda como el botón «Acomodar».',
        'No escribas precios, fechas ni cupos a mano: los pasos del catálogo (Ficha del curso, Precio, Fechas y cupo, Inscripción) los toman vigentes del CRM.',
        `No escribas datos del sistema con Guardar dato o Pregunta: ${[...SYSTEM_KEYS].join(', ')}.`,
      ],
      datosEnTextos: {
        delCatalogoYLaPersona: TOKENS.map(t => '{{' + t.name + '}}'),
        delContacto: '{{contacto.<clave>}} (las claves de «attributes»)',
        deVariables: '{{var.<nombre>}}',
        conRespaldo: '{{dato|texto si falta}}',
      },
      intencionesDeUnBoton: INTENTS,
    },
    inicio: {
      tipos: startTypes,
      palabraClave: { keywords: 'hasta 30 palabras de hasta 60 caracteres', mode: keywordModes },
      nota: 'El inicio decide cuándo empieza el recorrido una vez publicado y activo.',
    },
    ajustes: {
      porOmision: DEFAULT_SETTINGS,
      valores: {
        onUnexpected: {
          assistant: 'contesta el asistente',
          repeat: 'repite las opciones',
          default: 'sigue por «Si no elige»',
        },
        reentry: '"always" | "once_conversation" | { "cooldownMinutes": 1…43200 }',
        channels: Object.fromEntries(CHANNELS),
        timeoutMinutes: '5…1440',
        maxMisses: '1…3',
        reminder: 'null o { "afterMinutes": n, "text": "…" }',
      },
    },
    limites: LIMITS,
    tiposNoDisponibles: UNAVAILABLE_TYPES,
    tiposDePaso: types,
    ejemplo: {
      descripcion:
        'Saluda, pregunta el curso, manda la ficha vigente, ofrece inscribirse con botones y termina en la inscripción con enlace de pago o con una persona del equipo.',
      inicio: { type: 'first_message' },
      grafo: EXAMPLE_GRAPH,
    },
    pasos: [
      '1. listas_de_la_marca: ids reales de cursos, materiales, etiquetas, personas, plantillas y secuencias.',
      '2. crear_recorrido con un clientRef nuevo (o actualizar_recorrido con la revisión vigente).',
      '3. revisar_recorrido: corrige hasta que no haya errores; muestra los avisos a la persona.',
      '4. probar_recorrido con respuestas de ejemplo: muestra a la persona lo que vería el cliente.',
      '5. Dile a la persona que el recorrido quedó en BORRADOR y que publicarlo y activarlo lo hace ella en el CRM.',
    ],
  };
}
