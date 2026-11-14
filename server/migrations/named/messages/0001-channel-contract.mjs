// Columnas canónicas de `messages` que llena el contrato de canal 1.1 (docs/PLAN_CONTRATO_CANAL.md). Todas admiten NULL
// o traen DEFAULT: el código anterior sigue funcionando sobre una base ya migrada, y una fila antigua se lee como antes.
//
//   content_kind   tipo de contenido de un entrante: text, image, audio, video, document, sticker, location, contacts,
//                  interactive (botón, lista o botón de plantilla pulsado), order, unsupported… Por omisión 'text'.
//   reply          JSON de la pulsación: {kind:'button'|'list'|'template_button', id, title, payload, description}.
//   reply_to_id    mensaje del CRM que la persona citó al responder (si el CRM lo conoce por su referencia).
//   forwarded      1 si WhatsApp lo marcó como reenviado.
//   fail_code      código numérico del fallo que informó el proveedor (p. ej. 131049).
//   wa_pricing     JSON de la tarificación que Meta informó en el estado: {billable, category, type, model}.
//   channel_meta   JSON con lo demás del canal que no tiene columna propia: mensaje citado sin copia en el CRM,
//                  ubicación, contactos compartidos, datos del archivo, aviso de sistema.
// Otras columnas canónicas de la conciliación (interactive, media_state, cycle_id) las añade su dueño en su área.
import { addColumn } from '../../named.mjs';

export default {
  name: 'messages/0001-channel-contract',
  after: [],
  up(db) {
    addColumn(db, 'messages', 'content_kind', "TEXT NOT NULL DEFAULT 'text'");
    addColumn(db, 'messages', 'reply', 'TEXT');
    addColumn(db, 'messages', 'reply_to_id', 'TEXT');
    addColumn(db, 'messages', 'forwarded', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'messages', 'fail_code', 'INTEGER');
    addColumn(db, 'messages', 'wa_pricing', 'TEXT');
    addColumn(db, 'messages', 'channel_meta', 'TEXT');
  },
};
