// Mensajes interactivos salientes (docs/PLAN_RECORRIDOS.md; diseño de automatización §8.1; conciliación, filas 34 y
// N-4: «interactive» es una columna canónica de `messages` que añade su dueño en su área).
//
//   messages.interactive   JSON de lo que el mensaje ofrece además de su texto cuando el canal lo puede mostrar. Hoy
//                          sólo la Lista de un recorrido: {type:'list', header, body, footer, button,
//                          sections:[{title, rows:[{id, title, description}]}]}. WhatsApp real la envía como lista;
//                          el laboratorio y el CRM muestran el texto del mensaje, que ya trae las filas numeradas.
// Aditiva: admite NULL y ninguna fila existente cambia; el código anterior la ignora.
import { addColumn } from '../../named.mjs';

export default {
  name: 'chatflows/0002-message-interactive',
  after: ['messages/0001-channel-contract'],
  up(db) {
    addColumn(db, 'messages', 'interactive', 'TEXT');
  },
};
