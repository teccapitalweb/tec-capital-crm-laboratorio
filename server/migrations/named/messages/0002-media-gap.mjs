// Orden de los mensajes de WhatsApp real después de un archivo (docs/PLAN_WHATSAPP_REAL.md, «Orden de los mensajes»).
//
//   messages.wa_gap_until   hora (ms) antes de la cual no sale el siguiente mensaje de la misma conversación. La pone
//                           el envío de un mensaje con archivo en cuanto Meta lo acepta (WA_MEDIA_GAP_MS después) y
//                           deja de contar cuando ese archivo pasa de «enviado» (entregado, leído o fallido). Vive en
//                           la base para que el orden se conserve tras un reinicio.
// Aditiva: admite NULL y ninguna fila existente cambia; el código anterior la ignora.
import { addColumn } from '../../named.mjs';

export default {
  name: 'messages/0002-media-gap',
  after: [],
  up(db) {
    addColumn(db, 'messages', 'wa_gap_until', 'INTEGER');
    // Sólo los archivos con margen: casi siempre, ninguno vigente.
    db.exec(
      'CREATE INDEX IF NOT EXISTS messages_wa_gap ON messages(conversation_id,seq) WHERE wa_gap_until IS NOT NULL',
    );
  },
};
