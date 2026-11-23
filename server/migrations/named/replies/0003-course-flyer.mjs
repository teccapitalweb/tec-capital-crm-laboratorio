// Flyer del curso al informar, por marca (docs/PLAN_MENSAJES_AMABLES.md, «Flyer del curso»).
//
//   reply_settings.flyer   1 = la primera respuesta concreta sobre un curso en la conversación (precio, temario, fechas,
//                          duración, o un curso recomendado) acompaña el texto con el flyer aprobado de ese curso, una sola
//                          vez por conversación; 0 = sólo texto. Encendido por omisión. Cae a texto si el curso no tiene
//                          flyer vigente, y en modo real nunca sale un flyer de demostración.
// Aditiva: las filas existentes quedan con 1; el código anterior la ignora.
import { addColumn } from '../../named.mjs';

export default {
  name: 'replies/0003-course-flyer',
  after: [],
  up(db) {
    addColumn(db, 'reply_settings', 'flyer', 'INTEGER NOT NULL DEFAULT 1');
  },
};
