// Estilo de los mensajes del asistente por marca (docs/PLAN_MENSAJES_AMABLES.md, «Estilo»).
//
//   reply_settings.emojis   1 = los textos fijos del asistente llevan emojis en los renglones de datos, negritas de
//                           WhatsApp en el nombre del curso y en lo que la persona debe escribir, y un solo siguiente
//                           paso; 0 = viñetas y texto plano. Encendido por omisión. Nunca afecta a los mensajes serios
//                           (pago en revisión, queja, baja, pasar con una persona), que no llevan emojis en ningún caso.
// Aditiva: las filas existentes quedan con 1; el código anterior la ignora.
import { addColumn } from '../../named.mjs';

export default {
  name: 'replies/0002-message-style',
  after: [],
  up(db) {
    addColumn(db, 'reply_settings', 'emojis', 'INTEGER NOT NULL DEFAULT 1');
  },
};
