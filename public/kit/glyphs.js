/**
 * Los pocos iconos que el propio kit necesita (cerrar, ordenar, marcar, flechas).
 *
 * Por qué no usa la biblioteca de iconos de la aplicación: un control del kit debe verse completo aunque
 * la pantalla corra sin ella (pruebas, ejemplos, un fallo al cargarla). Las pantallas sí pueden usar
 * icon() de html.js para sus propios iconos. Todos son decorativos: el nombre del control va en su texto
 * o en su aria-label.
 */
import { raw } from './html.js';

const PATHS = {
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14M5 12h14',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  flat: 'M5 12h14',
  sort: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  columns: 'M4 5h16v14H4zM9.5 5v14M14.5 5v14',
};

/** Marcado SVG de un icono del kit, como texto (lo usa charts.js, que arma sus cadenas él mismo). */
export function glyphMarkup(name) {
  const path = PATHS[name];
  if (!path) throw new TypeError(`El kit no tiene el icono «${name}».`);
  return `<svg class="k-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}

/** Icono del kit listo para interpolar en html`…`. */
export const glyph = name => raw(glyphMarkup(name));
