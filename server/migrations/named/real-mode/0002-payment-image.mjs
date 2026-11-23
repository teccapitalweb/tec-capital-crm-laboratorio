// Imagen «Datos de pago» por marca (docs/PLAN_MODO_REAL.md, «Datos de pago»).
//
//   brand_real_mode.payment_image_file_id   id de un archivo de la biblioteca de la marca (library_files, fuera de Git)
//                                           con las cuentas para depositar o transferir, tal como la consultora se la
//                                           manda hoy al cliente. El asistente la adjunta cuando preguntan cómo o dónde
//                                           pagar. NULL = sin imagen (sólo texto, como antes).
// Aditiva: las filas existentes quedan sin imagen; el código anterior la ignora. Ningún dato de cuenta vive en el código.
import { addColumn } from '../../named.mjs';

export default {
  name: 'real-mode/0002-payment-image',
  after: [],
  up(db) {
    addColumn(db, 'brand_real_mode', 'payment_image_file_id', 'TEXT');
  },
};
