// Iconos del lienzo: trazos propios, sencillos, en una cuadrícula de 24. Son del lienzo y no de la aplicación porque
// la isla se carga sola, sin la biblioteca de iconos de la portada, y porque cada tipo de paso necesita el suyo.
// Cada icono es una lista de trazos (el atributo `d` de un <path>); el color lo pone quien lo usa con `currentColor`.

import { html } from '../../../kit/html.js';

const CIRCLE = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z';

const ICONS = {
  // Tipos de paso
  play: ['M8 5.5v13l10-6.5z'],
  message: [
    'M5 6h14a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 19 16h-7.5L7 19.5V16H5a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 5 6z',
  ],
  buttons: [
    'M5 5h14a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
    'M5 14h14a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z',
  ],
  list: ['M9 7h10M9 12h10M9 17h10', 'M5 7h.01M5 12h.01M5 17h.01'],
  question: [CIRCLE, 'M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.2 1-1.2 1.8', 'M12 16.6h.01'],
  template: ['M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 6.5 20V4a.5.5 0 0 1 .5-.5z', 'M9.5 13.5l2 2 3.5-4'],
  branch: ['M6 4v16', 'M6 10a4 4 0 0 0 4 4h8', 'M15 11l3 3-3 3'],
  clock: [CIRCLE, 'M12 7.5V12l3 2'],
  save: ['M5 4h11l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M8 4v5h7V4', 'M8 20v-6h8v6'],
  tag: [
    'M4 5a1 1 0 0 1 1-1h6.2a1 1 0 0 1 .7.3l7.5 7.5a1 1 0 0 1 0 1.4l-6.2 6.2a1 1 0 0 1-1.4 0L4.3 11.9a1 1 0 0 1-.3-.7z',
    'M8.5 8.5h.01',
  ],
  bell: ['M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z', 'M10 20.5a2 2 0 0 0 4 0'],
  person: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  flag: ['M6 21V4', 'M6 5h11l-2.5 4 2.5 4H6'],
  spark: ['M11 4l1.7 4.8 4.8 1.7-4.8 1.7L11 17l-1.7-4.8-4.8-1.7 4.8-1.7z', 'M18 15.5v4M16 17.5h4'],
  jump: ['M4 12h12', 'M12 7l5 5-5 5', 'M20 5v14'],
  plug: ['M9 3.5v5M15 3.5v5', 'M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0z', 'M12 17v3.5'],
  stop: ['M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z'],
  card: [
    'M4.5 5h15a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
    'M3.5 15.5l4.5-4 4 3.5 3-2.5 5.5 4.5',
    'M15.5 9h.01',
  ],
  price: [
    CIRCLE,
    'M14.6 9.6C14.2 8.6 13.3 8 12 8c-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2 2.6.9 2.6 2-1.1 2-2.6 2c-1.3 0-2.3-.6-2.7-1.6',
    'M12 6.3V8M12 16v1.7',
  ],
  book: ['M5 4.5h10.5A2.5 2.5 0 0 1 18 7v12.5H7.5A2.5 2.5 0 0 1 5 17z', 'M5 17a2.5 2.5 0 0 1 2.5-2.5H18', 'M9 8.5h5'],
  calendar: ['M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', 'M4 10.5h16M8 3.5v4M16 3.5v4'],
  cart: ['M3.5 4.5h2.2L8 14.5h9.5l2-7H7', 'M9.5 19h.01M16.5 19h.01'],
  compass: [CIRCLE, 'M15.5 8.5l-2 5-5 2 2-5z'],
  note: ['M6 4h12a1 1 0 0 1 1 1v9l-5 6H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M14 20v-5a1 1 0 0 1 1-1h4'],
  unknown: [CIRCLE, 'M9 9l6 6M15 9l-6 6'],
  // Herramientas
  undo: ['M8.5 6.5L4 11l4.5 4.5', 'M4 11h10a5 5 0 0 1 0 10h-3'],
  redo: ['M15.5 6.5L20 11l-4.5 4.5', 'M20 11H10a5 5 0 0 0 0 10h3'],
  tidy: ['M4 5h6v5H4zM14 5h6v5h-6zM9 15h6v5H9z', 'M7 10v2.5h10V10M12 12.5V15'],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  fit: ['M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4'],
  trash: ['M5 7h14M10 7V4.5h4V7', 'M7 7l.8 12.5h8.4L17 7'],
  copy: ['M9 9h10v11H9z', 'M5 15V4h10'],
  close: ['M6 6l12 12M18 6L6 18'],
  chart: ['M5 20V10M12 20V4M19 20v-7'],
  test: [CIRCLE, 'M10 8.5v7l6-3.5z'],
  warn: ['M12 4l9 15.5H3z', 'M12 10v4.5M12 17.2h.01'],
  error: [CIRCLE, 'M12 7.5V13M12 16.2h.01'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  canvas: ['M4 5h6v5H4zM14 14h6v5h-6z', 'M10 7.5h3a3 3 0 0 1 3 3V14'],
  arrow: ['M5 12h14M13 6l6 6-6 6'],
  restart: ['M5 12a7 7 0 1 1 2.2 5.1', 'M4.5 19v-4.5H9'],
  send: ['M4 12l16-7-6 16-3-6.5z'],
  up: ['M6 14l6-6 6 6'],
  down: ['M6 10l6 6 6-6'],
  image: [
    'M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
    'M4 16l4.5-4.5 3.5 3.5 3-3 5 5',
    'M15 9h.01',
  ],
  file: ['M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 6.5 20V4a.5.5 0 0 1 .5-.5z', 'M14 3.5V8h4'],
};

// Devuelve el <svg> de un icono como plantilla segura. Es decorativo: el texto de al lado dice lo mismo.
export function icon(name) {
  const strokes = ICONS[name] || ICONS.unknown;
  return html`<svg class="lz-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${strokes.map(d => html`<path d="${d}"></path>`)}</svg>`;
}

export const hasIcon = name => Object.hasOwn(ICONS, name);
