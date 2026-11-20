// Lo que el motor del servidor todavía no ejecuta (docs/PLAN_RECORRIDOS.md, «Rechazados al publicar»).
//
// Una sola lista para el servidor y la pantalla: el servidor rechaza con ella al publicar (server/modules/chatflows/
// engine.mjs la reexporta) y el editor avisa con ella mientras se arma el recorrido y marca en la paleta los tipos de
// paso que todavía no están disponibles. Sin DOM ni red: se prueba con node --test.
import { typeOf } from './flow-model.js';

// ---- Tipos de paso que el motor del servidor sabe ejecutar. Lo demás se rechaza al publicar con un motivo claro.
//
// `ctx` (opcional) es el contexto de validación del modelo: con `settings.channels` se avisa que una Plantilla de
// WhatsApp no sale por otros canales, y con `realWhatsApp: false` (lo manda el servidor) que la marca no tiene un número
// real de WhatsApp por donde enviarla. Sin `ctx` (el editor sin conexión) esas dos comprobaciones no se hacen.
export const NOT_YET = 'todavía no lo ejecuta el servidor';
export function unsupportedProblems(graph, ctx = {}) {
  const out = [];
  const push = (node, message) => out.push({ code: 'unsupported', nodeId: node.id, message });
  const channels = Array.isArray(ctx?.settings?.channels) ? ctx.settings.channels : [];
  for (const node of graph.nodes) {
    const def = typeOf(node.type);
    if (!def) continue;
    const d = def.clean(node.data);
    const name = node.title || def.label;
    switch (node.type) {
      case 'template':
        // Una plantilla sólo existe en WhatsApp real: en otro canal no se manda «otra cosa» en su lugar.
        if (channels.some(c => c !== 'whatsapp'))
          push(
            node,
            `«${name}»: una Plantilla de WhatsApp sólo sale por WhatsApp; quita Instagram y Facebook de los canales del recorrido o usa un Mensaje.`,
          );
        if (ctx?.realWhatsApp === false)
          push(
            node,
            `«${name}»: la marca no tiene un número real de WhatsApp conectado, y una Plantilla de WhatsApp no se puede enviar en el laboratorio.`,
          );
        break;
      case 'consent':
        push(node, `«${name}»: Suscribir o dar de baja ${NOT_YET}; la baja la registra el asistente cuando la piden.`);
        break;
      case 'webhook':
        push(node, `«${name}»: un recorrido no llama a servicios externos por ahora.`);
        break;
      case 'assistant':
        if (d.mode !== 'handover')
          push(
            node,
            `«${name}»: el Asistente sólo puede «seguir él» (terminar el recorrido); «contestar y seguir» y «recolectar un dato» ${NOT_YET}.`,
          );
        break;
      case 'status':
        if (d.status !== 'resolved')
          push(
            node,
            `«${name}»: «Esperando» ${NOT_YET}; para dejar la conversación al equipo usa Pasar con una persona.`,
          );
        break;
      case 'message':
        d.parts.forEach((p, i) => {
          if (p.kind === 'slot')
            push(
              node,
              `«${name}», parte ${i + 1}: el material por espacio ${NOT_YET} (los materiales todavía no tienen espacio); usa un material aprobado o un archivo.`,
            );
        });
        break;
      case 'question':
        if (d.answer.type === 'media' || d.answer.type === 'location')
          push(node, `«${name}»: una pregunta que espera un archivo o una ubicación ${NOT_YET}.`);
        if (d.saveTo.kind === 'attribute' && SYSTEM_KEYS.has(d.saveTo.key))
          push(node, `«${name}»: guardar en «${d.saveTo.key}» ${NOT_YET}; guárdalo en un dato propio de la marca.`);
        break;
      case 'set_attribute':
        if (SYSTEM_KEYS.has(d.key))
          push(node, `«${name}»: escribir «${d.key}» ${NOT_YET}; usa un dato propio de la marca.`);
        break;
      case 'schedule':
        if (d.sessions) push(node, `«${name}»: la lista de sesiones de la apertura ${NOT_YET}; desmárcala.`);
        break;
      case 'handoff':
        if (d.to === 'last')
          push(node, `«${name}»: pasar con «la última persona que atendió» ${NOT_YET}; usa la cola o una persona.`);
        break;
      default:
        break;
    }
  }
  return out;
}
export const SYSTEM_KEYS = new Set([
  'nombre',
  'nombre_completo',
  'telefono',
  'correo',
  'origen',
  'consentimiento',
  'etiquetas',
  'etapa',
  'curso_interes',
  'edicion',
  'estado_pago',
  'inscrito',
  'responsable',
  'estado_chat',
  'canal',
  'anuncio',
  'ultimo_mensaje',
  'creado',
  'cx_score_latest',
]);

// Tipos de archivo que un recorrido puede enviar (Mensaje con archivo y encabezado de Botones): los que salen por
// WhatsApp real y se ven en el chat del laboratorio. La misma lista filtra la biblioteca de la marca en el editor y se
// vuelve a comprobar al enviar (server/modules/chatflows/runtime.mjs).
export const FLOW_FILE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'application/pdf']);

// Tipos de paso que no se pueden publicar en ningún caso, con su motivo en palabras de quien arma el recorrido. Los
// demás se pueden usar; algunas de sus opciones se rechazan y lo dice unsupportedProblems en cuanto se eligen.
export const UNAVAILABLE_TYPES = Object.freeze({
  consent: 'Suscribir o dar de baja todavía no está disponible; la baja la registra el asistente cuando la piden.',
  webhook: 'Un recorrido todavía no llama a servicios externos.',
});
