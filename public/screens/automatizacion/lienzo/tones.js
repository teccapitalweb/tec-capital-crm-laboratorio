// Color de cada tipo de paso (diseño Tinta, bocetos «FinalEditor»). Se define una sola vez, aquí, y lo usan la lista de
// pasos, la paleta «Agregar paso», el panel, las salidas («a dónde sigue») y las tarjetas del lienzo: un color dice
// siempre la misma clase de paso.
//
//   cielo     un mensaje que se envía (Mensaje)
//   menta     botones
//   lila      una lista
//   durazno   la persona: una pregunta que contesta ella, o pasarla con una persona del equipo
//   mantequilla  el catálogo (ficha, precio, temario, fechas, elegir curso)
//   lima      la venta: inscripción con enlace de pago
//   blanco    lo demás: Inicio, lógica, contacto, estado, asistente, plantilla, servicio externo y notas
//
// El color nunca es la única pista: cada tarjeta lleva además el nombre del tipo de paso en texto.

import { NODE_TYPES } from '../../../kit/shared/flow-model.js';

const BY_TYPE = Object.freeze({
  message: 'sky',
  buttons: 'mint',
  list: 'lilac',
  question: 'peach',
  handoff: 'peach',
  course_card: 'butter',
  price: 'butter',
  syllabus: 'butter',
  schedule: 'butter',
  choose_course: 'butter',
  enroll: 'lime',
});

export const TONES = Object.freeze(['sky', 'mint', 'lilac', 'peach', 'butter', 'lime', 'white']);

/** Color de un tipo de paso: uno de TONES. Un tipo desconocido (o sin color propio) es blanco. */
export const toneOf = type => BY_TYPE[type] || 'white';

/** Todos los tipos con su color, para comprobar que ninguno se queda sin uno. */
export const toneTable = () => Object.fromEntries(Object.keys(NODE_TYPES).map(type => [type, toneOf(type)]));
