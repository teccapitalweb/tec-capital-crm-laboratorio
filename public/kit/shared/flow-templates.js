// Plantillas de la biblioteca de recorridos. Son datos: el servidor crea un recorrido a partir de una y el editor las
// ofrece al crear uno nuevo. Ninguna lleva textos de precio, fecha ni cupo: eso lo ponen los pasos de catálogo al enviar.
//
// Una plantilla no puede saber los ids de la marca donde se usará. Lo que apunta a otra cosa (otro recorrido, un
// material) viaja como un marcador `tpl:<clave>` y se describe en `links`; quien crea el recorrido lo sustituye con
// instantiateTemplate(). Lo que la marca debe tener listo para que la plantilla funcione está en `requires`.

import { applyLayout, layout, normalizeGraph, normalizeSettings } from './flow-model.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) freeze(inner);
  }
  return value;
};

// Las posiciones salen del acomodo automático: así una plantilla nunca queda desalineada respecto de lo que el botón
// «Acomodar» haría con ella.
function template({ graph, settings, ...rest }) {
  const canonical = normalizeGraph({ v: 1, variables: [], ...graph });
  return freeze({
    ...rest,
    graph: applyLayout(canonical, layout(canonical).positions),
    settings: normalizeSettings(settings),
  });
}

const goto = { type: 'goto' };
const intent = (name, stay) => ({ type: 'intent', intent: name, stay });

// Un recorrido para todos los cursos: el curso es un dato de la conversación, no del recorrido.
const ventaDeCurso = template({
  key: 'venta_de_curso',
  name: 'Venta de curso',
  description:
    'Presenta el curso de la conversación con su ficha vigente y lleva a la inscripción. Sirve para todos los cursos de la marca: lo propio de cada uno sale del catálogo.',
  graph: {
    start: 's',
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'c', type: 'choose_course', data: { skipIfKnown: true, useMessage: true, attempts: 2 } },
      {
        id: 'm1',
        type: 'message',
        title: 'Saludo y presentación',
        data: {
          parts: [
            { kind: 'text', text: 'Hola, {{nombre}}. Gracias por tu interés en {{curso}}.' },
            { kind: 'slot', slot: 'presentacion', ifMissing: 'skip' },
          ],
        },
      },
      { id: 'd1', type: 'delay', data: { seconds: 3 } },
      { id: 'f', type: 'course_card', data: { text: '', flyer: true } },
      {
        id: 'm2',
        type: 'message',
        title: 'Imagen del temario',
        data: { parts: [{ kind: 'slot', slot: 'temario_imagen', ifMissing: 'skip' }] },
      },
      { id: 'd2', type: 'delay', data: { seconds: 3 } },
      {
        id: 'b',
        type: 'buttons',
        title: 'Invitación a inscribirse',
        data: {
          text: '¿Te gustaría conocer el proceso de inscripción?',
          options: [
            { id: 'si', label: 'Sí, me interesa', do: goto },
            { id: 'temario', label: 'Ver el temario', do: intent('syllabus', true) },
          ],
        },
      },
      { id: 'g', type: 'goto_flow', title: 'Inscripción', data: { flowId: 'tpl:inscripcion', passVars: false } },
      {
        id: 'h',
        type: 'handoff',
        data: { text: 'Con gusto te ayuda una persona del equipo a encontrar el curso que buscas.', to: 'queue' },
      },
      { id: 'e', type: 'end', data: {} },
    ],
    edges: [
      { from: 's', port: 'next', to: 'c' },
      { from: 'c', port: 'next', to: 'm1' },
      { from: 'c', port: 'none', to: 'h' },
      { from: 'm1', port: 'next', to: 'd1' },
      { from: 'd1', port: 'next', to: 'f' },
      { from: 'f', port: 'next', to: 'm2' },
      { from: 'm2', port: 'next', to: 'd2' },
      { from: 'd2', port: 'next', to: 'b' },
      { from: 'b', port: 'opt:si', to: 'g' },
      // 24 horas sin respuesta: termina; el seguimiento lo hace la receta de silencio, no el recorrido.
      { from: 'b', port: 'timeout', to: 'e' },
    ],
  },
  settings: { timeoutMinutes: 1440, onUnexpected: 'assistant', maxMisses: 2, reofferOnDetour: true },
  links: [{ nodeId: 'g', path: 'flowId', source: 'flows', template: 'inscripcion', name: 'Inscripción' }],
  requires: {
    slots: [
      { slot: 'presentacion', label: 'Presentación del curso', optional: true },
      { slot: 'temario_imagen', label: 'Imagen del temario', optional: true },
    ],
    attributes: [],
  },
  // Las tres reglas que lo acompañan (nacen apagadas). `flowId` lleva el marcador de la plantilla que inician.
  rules: [
    {
      name: 'Chat nuevo',
      definition: {
        v: 1,
        trigger: { type: 'chat_started', channels: ['whatsapp'] },
        filters: {
          mode: 'all',
          groups: [{ mode: 'all', items: [{ f: 'attr', key: 'estado_pago', op: 'neq', value: 'pagado' }] }],
        },
        actions: [{ type: 'start_flow', flowId: 'tpl:venta_de_curso', course: 'keep', firstMessage: 'start' }],
        options: { stop: false, limit: 'once_conversation' },
      },
    },
    {
      name: 'Nombra un curso',
      definition: {
        v: 1,
        trigger: { type: 'message_in', channels: ['whatsapp'] },
        filters: { mode: 'all', groups: [{ mode: 'all', items: [{ f: 'course_named' }] }] },
        actions: [{ type: 'start_flow', flowId: 'tpl:venta_de_curso', course: 'matched', firstMessage: 'start' }],
        options: { stop: false, limit: 'always' },
      },
    },
  ],
});

// El mismo grafo del Apéndice B del diseño. También lo inicia el botón «Sí, deseo inscribirme» de la plantilla de oferta.
const inscripcion = template({
  key: 'inscripcion',
  name: 'Inscripción',
  description:
    'Da el precio vigente y crea el pedido con su enlace de pago. Si la venta en línea está apagada, envía las instrucciones de pago, pide los datos de la constancia y pasa con una persona.',
  graph: {
    start: 'a',
    nodes: [
      { id: 'a', type: 'start', data: {} },
      { id: 'b', type: 'price', data: { body: 'data', templateId: 'tpl:precio_promocional' } },
      { id: 'c', type: 'enroll', data: {} },
      {
        id: 'd',
        type: 'message',
        title: 'Instrucciones de pago',
        data: { parts: [{ kind: 'slot', slot: 'instrucciones_pago', ifMissing: 'stop' }] },
      },
      {
        id: 'e',
        type: 'question',
        title: 'Nombre para la constancia',
        data: {
          text: 'Para tu constancia, ¿me escribes tu nombre completo?',
          answer: { type: 'text', min: 5, max: 80 },
          saveTo: { kind: 'attribute', key: 'nombre_constancia' },
          errorText: 'Necesito tu nombre y apellidos, por favor.',
          attempts: 2,
        },
      },
      {
        id: 'f',
        type: 'question',
        title: 'Correo',
        data: {
          text: '¿A qué correo te enviamos los accesos?',
          answer: { type: 'email' },
          saveTo: { kind: 'attribute', key: 'correo' },
          errorText: 'Ese correo no parece válido. ¿Me lo escribes de nuevo?',
          attempts: 2,
        },
      },
      {
        id: 'g',
        type: 'handoff',
        data: {
          text: '¡Gracias, {{nombre}}! Envía tu comprobante por aquí y una persona del equipo lo valida.',
          to: 'queue',
        },
      },
      { id: 'h', type: 'end', data: {} },
    ],
    edges: [
      { from: 'a', port: 'next', to: 'b' },
      { from: 'b', port: 'next', to: 'c' },
      // El mensaje de pago confirmado lo envía el módulo de pagos; aquí el recorrido sólo termina.
      { from: 'c', port: 'order', to: 'h' },
      { from: 'c', port: 'manual', to: 'd' },
      { from: 'd', port: 'next', to: 'e' },
      { from: 'e', port: 'next', to: 'f' },
      { from: 'e', port: 'invalid', to: 'g' },
      { from: 'f', port: 'next', to: 'g' },
      { from: 'f', port: 'invalid', to: 'g' },
    ],
  },
  settings: { timeoutMinutes: 1440, onUnexpected: 'assistant', maxMisses: 2, reofferOnDetour: true },
  links: [
    {
      nodeId: 'b',
      path: 'templateId',
      source: 'materials',
      slot: 'precio_promocional',
      name: 'Precio promocional vigente',
      optional: true,
    },
  ],
  requires: {
    slots: [{ slot: 'instrucciones_pago', label: 'Instrucciones de pago de la marca', optional: false }],
    attributes: [{ key: 'nombre_constancia', label: 'Nombre para la constancia', type: 'text' }],
  },
  rules: [
    {
      name: 'Botón de la plantilla de oferta',
      definition: {
        v: 1,
        trigger: { type: 'button', source: 'wa_template:tpl:oferta', match: 'Sí, deseo inscribirme' },
        filters: { mode: 'all', groups: [] },
        actions: [
          { type: 'start_flow', flowId: 'tpl:inscripcion', course: 'keep', firstMessage: 'start', replace: true },
        ],
        options: { stop: false, limit: 'always' },
      },
    },
  ],
});

// El menú del flujo de bienvenida de fábrica (server/flows.mjs, DEFAULT_STEPS) como recorrido: es exactamente lo que
// produce fromWelcomeFlow() con esos pasos, y una prueba lo comprueba.
const bienvenidaConMenu = template({
  key: 'bienvenida_con_menu',
  name: 'Bienvenida con menú',
  description:
    'El saludo con la ficha del curso y un menú de botones: precio, temario, fechas, inscribirse o hablar con una persona. Si la persona escribe otra cosa, contesta el asistente.',
  graph: {
    start: 'start',
    nodes: [
      { id: 'start', type: 'start', data: {} },
      {
        id: 'inicio',
        type: 'buttons',
        data: {
          header: { kind: 'course_flyer' },
          text: '¡Hola, {{nombre}}! Soy el asistente de {{marca}}. ¿Qué te gustaría saber de {{curso}}?',
          options: [
            { id: 'o1', label: 'Precio', do: intent('price', true) },
            { id: 'o2', label: 'Temario', do: intent('syllabus', true) },
            { id: 'o3', label: 'Más opciones', do: goto },
          ],
        },
      },
      {
        id: 'mas',
        type: 'buttons',
        data: {
          text: 'Claro. ¿Con qué te ayudo?',
          options: [
            { id: 'o1', label: 'Fechas y horario', do: intent('schedule', true) },
            { id: 'o2', label: 'Inscribirme', do: intent('enroll', false) },
            { id: 'o3', label: 'Hablar con asesor', do: intent('human', false) },
          ],
        },
      },
    ],
    edges: [
      { from: 'start', port: 'next', to: 'inicio' },
      { from: 'inicio', port: 'opt:o3', to: 'mas' },
    ],
  },
  // Lo que el flujo anterior hacía: recordar el paso 24 horas y terminar al segundo mensaje que no es un botón.
  settings: { timeoutMinutes: 1440, onUnexpected: 'assistant', maxMisses: 2, reofferOnDetour: false },
  links: [],
  requires: { slots: [], attributes: [] },
  rules: [
    {
      name: 'Chat nuevo',
      definition: {
        v: 1,
        trigger: { type: 'chat_started', channels: ['whatsapp'] },
        filters: { mode: 'all', groups: [] },
        actions: [
          { type: 'start_flow', flowId: 'tpl:bienvenida_con_menu', course: 'keep', firstMessage: 'answer_and_menu' },
        ],
        options: { stop: false, limit: 'once_conversation' },
      },
    },
  ],
});

export const FLOW_TEMPLATES = Object.freeze([ventaDeCurso, inscripcion, bienvenidaConMenu]);

export const templateByKey = key => FLOW_TEMPLATES.find(t => t.key === key) || null;

const clone = value => JSON.parse(JSON.stringify(value));

// Copia editable de una plantilla, con sus marcadores `tpl:` sustituidos. `resolve(link)` devuelve el id que le
// corresponde en la marca (o nada). Lo que no se resuelve queda vacío y se devuelve en `unresolved`: la validación lo
// señalará en su paso, que es donde la persona puede elegirlo.
export function instantiateTemplate(key, resolve) {
  const tpl = templateByKey(key);
  if (!tpl) return null;
  const graph = clone(tpl.graph);
  const unresolved = [];
  for (const link of tpl.links) {
    const id = typeof resolve === 'function' ? resolve(link) : '';
    const node = graph.nodes.find(n => n.id === link.nodeId);
    node.data[link.path] = typeof id === 'string' ? id : '';
    if (!node.data[link.path]) unresolved.push({ ...link });
  }
  return {
    key: tpl.key,
    name: tpl.name,
    description: tpl.description,
    graph,
    settings: clone(tpl.settings),
    rules: clone(tpl.rules),
    requires: clone(tpl.requires),
    unresolved,
  };
}
