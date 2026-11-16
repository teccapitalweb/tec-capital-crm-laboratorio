// Plantilla de ejemplo «Venta de curso» para empezar un recorrido nuevo (docs/GUIA_RECORRIDOS.md).
//
// A diferencia de la biblioteca compartida (kit/shared/flow-templates.js), ésta usa sólo pasos que el servidor ya
// ejecuta, así que se puede revisar, probar y publicar sin cambiar nada. Sirve para todos los cursos de la marca: el
// curso es el de la conversación y su ficha, precio y fechas salen siempre del catálogo vigente.
import { applyLayout, layout } from '../../kit/shared/flow-model.js';

const node = (id, type, data = {}, title = '') => ({ id, type, title, x: 0, y: 0, data });
const edge = (from, port, to) => ({ from, port, to });

export function saleTemplate() {
  const graph = {
    v: 1,
    start: 's',
    variables: [{ name: 'correo', label: 'Correo', type: 'text' }],
    nodes: [
      node('s', 'start'),
      node(
        'm',
        'message',
        {
          parts: [
            {
              kind: 'text',
              text: 'Hola, {{nombre|qué gusto saludarte}}. Gracias por tu interés en {{curso|nuestros cursos}}.',
            },
          ],
        },
        'Saludo',
      ),
      node('f', 'course_card', { text: '', flyer: true }),
      node('d', 'delay', { seconds: 3 }),
      node(
        'b',
        'buttons',
        {
          header: { kind: 'none' },
          text: '¿Te gustaría conocer el proceso de inscripción?',
          footer: '',
          options: [
            { id: 'si', label: 'Sí, me interesa', do: { type: 'goto' } },
            { id: 'temario', label: 'Ver el temario', do: { type: 'intent', intent: 'syllabus', stay: true } },
            { id: 'persona', label: 'Hablar con alguien', do: { type: 'goto' } },
          ],
        },
        'Invitación a inscribirse',
      ),
      node('i', 'enroll'),
      node('q', 'question', {
        text: 'Para apartar tu lugar, ¿me compartes tu correo?',
        answer: { type: 'email' },
        saveTo: { kind: 'var', name: 'correo' },
        errorText: 'Ese correo no parece válido. ¿Lo revisas, por favor?',
        attempts: 2,
      }),
      node('h', 'handoff', { text: 'Gracias. Una persona del equipo te escribe en un momento.', to: 'queue' }),
      node('e', 'end', { text: '' }),
      node('t', 'end', { text: 'Aquí estaré cuando quieras seguir.' }),
    ],
    edges: [
      edge('s', 'next', 'm'),
      edge('m', 'next', 'f'),
      edge('f', 'next', 'd'),
      edge('d', 'next', 'b'),
      edge('b', 'opt:si', 'i'),
      edge('b', 'opt:persona', 'h'),
      edge('b', 'timeout', 't'),
      edge('i', 'order', 'e'),
      edge('i', 'manual', 'q'),
      edge('q', 'next', 'h'),
      edge('q', 'invalid', 'h'),
    ],
  };
  return {
    name: 'Venta de curso',
    description: 'Presenta el curso de la conversación con su ficha vigente y lleva a la inscripción.',
    graph: applyLayout(graph, layout(graph).positions),
    settings: { timeoutMinutes: 1440, onUnexpected: 'assistant', maxMisses: 2, reofferOnDetour: true },
    start: { type: 'first_message' },
  };
}
