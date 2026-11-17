// Índices de la bandeja nueva (docs/PLAN_BANDEJA_VISTAS.md, «Contadores y cómo se midieron»). Sólo los que el banco
// sintético mostró necesarios, con nombre propio para no chocar con los de rendimiento de la Fase 0 (conciliación,
// fila 9b).
//
//   messages_unread_customer      mensajes de la persona sin leer por el equipo. Parcial: sólo guarda las filas sin
//                                 leer, así que «No leídas», su contador y el número de cada fila consultan unas pocas
//                                 entradas por conversación en lugar de recorrer todos sus mensajes (6,000
//                                 conversaciones y 48,000 mensajes: el contador pasó de 60 ms a 2 ms).
//   conversations_inbox_handler   (marca, estado, asistente, responsable): «Mías», «Sin asignar» y «Con el asistente»
//                                 se cuentan sin leer la tabla (30,000 conversaciones: de 30 ms a 1 ms cada una).
export default {
  name: 'conversations/0002-inbox-indexes',
  after: ['lifecycle/0001-lifecycle'], // usa conversations.state; messages es de la escalera
  up(db) {
    db.exec(`
      CREATE INDEX messages_unread_customer ON messages(conversation_id) WHERE read_at IS NULL AND sender_kind = 'customer';
      CREATE INDEX conversations_inbox_handler ON conversations(brand_id, state, bot_enabled, assigned_to);
    `);
  },
};
