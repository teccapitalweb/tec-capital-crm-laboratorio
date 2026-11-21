// Textos de «Actividad del asistente» (docs/PLAN_MCP_CLAUDE.md). Todo sale de aquí o de las herramientas del conector
// (server/mcp.mjs → TOOLS): nunca de lo que mandó el asistente ni de lo que escribió un cliente.

// Lo que hizo cada herramienta, en pasado y en español llano. Una herramienta que no esté en la lista (por ejemplo una
// nueva) se describe con su título: «Consultó: …» si sólo lee, «Usó: …» si escribe.
export const TOOL_LABELS = Object.freeze({
  resumen: 'Consultó el resumen de la marca',
  listar_cursos: 'Consultó los cursos y aperturas',
  ver_curso: 'Consultó el detalle de un curso',
  listar_pedidos: 'Consultó los pedidos',
  buscar_contactos: 'Buscó contactos',
  listar_conversaciones: 'Consultó las conversaciones',
  ver_conversacion: 'Leyó los mensajes de una conversación',
  listar_conocimiento: 'Consultó el conocimiento del asistente',
  proponer_conocimiento: 'Propuso una respuesta al conocimiento (borrador)',
  actualizar_apertura: 'Modificó una apertura',
  actualizar_curso: 'Modificó un curso',
  guia_recorridos: 'Consultó la guía para armar recorridos',
  listas_de_la_marca: 'Consultó las listas de la marca para el editor',
  listar_recorridos: 'Consultó los recorridos',
  ver_recorrido: 'Consultó el detalle de un recorrido',
  crear_recorrido: 'Creó el borrador de un recorrido',
  actualizar_recorrido: 'Guardó el borrador de un recorrido',
  revisar_recorrido: 'Revisó un recorrido',
  probar_recorrido: 'Probó un recorrido en el simulador',
  listar_secuencias: 'Consultó las secuencias de seguimiento',
  ver_secuencia: 'Consultó el detalle de una secuencia',
  crear_secuencia: 'Creó una secuencia apagada',
  actualizar_secuencia: 'Modificó una secuencia apagada',
  listar_accesos: 'Consultó los mensajes de accesos',
  escribir_acceso: 'Escribió el mensaje de accesos de una apertura',
  cifras_ventas: 'Consultó cifras de ventas',
  cifras_atencion: 'Consultó cifras de embudo y atención',
  rendimiento_recorridos: 'Consultó el rendimiento de los recorridos',
  resultados_secuencias: 'Consultó los resultados de las secuencias',
  resultados_difusiones: 'Consultó los resultados de las difusiones',
  salud_whatsapp: 'Consultó la salud de WhatsApp',
  que_le_falta_a_la_marca: 'Consultó qué le falta a la marca',
  listar_borradores_catalogo: 'Consultó los borradores del catálogo',
  crear_apertura_borrador: 'Creó una apertura en borrador',
  actualizar_apertura_borrador: 'Guardó una apertura en borrador',
  crear_promocion_borrador: 'Creó una promoción en borrador',
  actualizar_promocion_borrador: 'Guardó una promoción en borrador',
  crear_texto_borrador: 'Creó un texto de contenido en borrador',
  actualizar_texto_borrador: 'Guardó un texto de contenido en borrador',
  probar_texto: 'Vio cómo queda un texto',
  listar_plantillas_whatsapp: 'Consultó las plantillas de WhatsApp',
  ver_plantilla_whatsapp: 'Consultó el detalle de una plantilla de WhatsApp',
  crear_plantilla_whatsapp: 'Creó una plantilla de WhatsApp en borrador',
  actualizar_plantilla_whatsapp: 'Guardó una plantilla de WhatsApp en borrador',
  revisar_plantilla_whatsapp: 'Revisó una plantilla de WhatsApp',
  opciones_difusion: 'Consultó las opciones para una difusión',
  listar_difusiones: 'Consultó las difusiones',
  crear_difusion_borrador: 'Creó una difusión en borrador',
  actualizar_difusion_borrador: 'Guardó una difusión en borrador',
  estimar_difusion: 'Estimó una difusión',
  listar_audiencias: 'Consultó las listas y segmentos',
  campos_de_segmento: 'Consultó los campos para un segmento',
  crear_segmento: 'Creó un segmento',
  contar_segmento: 'Contó un público',
  listas_de_reglas: 'Consultó las listas para el editor de reglas',
  listar_reglas: 'Consultó las reglas por mensaje',
  crear_regla: 'Creó una regla en borrador',
  actualizar_regla: 'Guardó una regla en borrador',
  probar_regla: 'Probó una regla',
  proponer_accion: 'Dejó una propuesta para que la apruebe una persona',
  listar_propuestas: 'Consultó sus propuestas',
  retirar_propuesta: 'Retiró una propuesta',
});

// Qué es la entidad que la herramienta audita (la parte central de la acción de auditoría: «mcp.flow.create» → flow).
export const ENTITY_LABELS = Object.freeze({
  knowledge: 'Respuesta del conocimiento',
  edition: 'Apertura',
  course: 'Curso',
  flow: 'Recorrido',
  sequence: 'Secuencia',
  access: 'Mensaje de accesos',
  promotion: 'Promoción',
  content: 'Texto de contenido',
  wa_template: 'Plantilla de WhatsApp',
  broadcast: 'Difusión',
  segment: 'Segmento',
  rule: 'Regla',
  proposal: 'Propuesta',
});

// Motivo de una llamada que no salió bien: clave cerrada → resultado y texto. «scope» lleva el nombre del permiso,
// que sale de la propia herramienta.
export const REASONS = Object.freeze({
  scope: { outcome: 'rejected', text: 'Rechazada: no tenía el permiso «{permiso}»' },
  forbidden: { outcome: 'rejected', text: 'Rechazada: el CRM no lo permitió a esta conexión' },
  not_found: { outcome: 'rejected', text: 'No se hizo: no encontró lo que pedía en esta marca' },
  conflict: { outcome: 'rejected', text: 'No se hizo: había un cambio más reciente o no se permite en ese estado' },
  rate: { outcome: 'rejected', text: 'No se hizo: demasiadas llamadas seguidas' },
  unavailable: { outcome: 'rejected', text: 'No se hizo: esa parte del CRM no estaba disponible' },
  rejected: { outcome: 'rejected', text: 'No se hizo: el CRM lo rechazó' },
  invalid: { outcome: 'invalid', text: 'No se hizo: los datos que mandó no eran válidos' },
  unknown_tool: { outcome: 'invalid', text: 'Pidió una herramienta que no existe' },
  internal: { outcome: 'error', text: 'Falló por un error interno del CRM' },
});

// De un error de una herramienta (con su código HTTP, o sin él si fue inesperado) a la clave cerrada del motivo.
export function reasonOf(status, { scope = false } = {}) {
  if (scope) return 'scope';
  if (!status) return 'internal';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate';
  if (status === 503) return 'unavailable';
  if (status === 400 || status === 413 || status === 422) return 'invalid';
  return status >= 500 ? 'internal' : 'rejected';
}
