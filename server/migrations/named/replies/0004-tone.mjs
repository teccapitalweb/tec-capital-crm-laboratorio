// Tono de los mensajes del asistente, por marca (docs/PLAN_MENSAJES_VENDEDORA.md).
//
//   reply_settings.tone   'vendedor' = el estilo de las consultoras: título del curso con gancho, promoción con el precio
//                         anterior tachado, horario sesión por sesión, cupo cuando quedan pocos lugares y la frase de
//                         acción para asegurar el lugar; 'sereno' = el estilo anterior, sin urgencia. Vendedor por omisión.
// Aditiva: las filas existentes quedan en 'vendedor'; el código anterior la ignora.
import { addColumn } from '../../named.mjs';

export default {
  name: 'replies/0004-tone',
  after: [],
  up(db) {
    addColumn(db, 'reply_settings', 'tone', "TEXT NOT NULL DEFAULT 'vendedor'");
  },
};
