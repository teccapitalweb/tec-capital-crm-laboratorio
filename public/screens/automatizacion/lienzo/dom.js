// Ayudantes del lienzo que el kit de pantallas no trae. El marcado se pinta con `html` y `render` de
// public/kit/html.js y los eventos se reparten con `listen` de public/kit/events.js; aquí sólo queda lo que es
// propio de un lienzo: elementos SVG que se actualizan decenas de veces por segundo y oyentes directos para los
// gestos del puntero, que no pasan por data-do.

const SVG = 'http://www.w3.org/2000/svg';

// Elemento SVG con sus atributos. Las conexiones se crean así, y no con plantillas, porque al arrastrar sólo se les
// cambia el atributo `d`: conciliar un marcado entero en cada movimiento sería trabajo de más.
export function svgEl(doc, tag, attributes = {}) {
  const el = doc.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, String(value));
  return el;
}

// Oyente directo sobre un elemento; devuelve cómo quitarlo.
export function on(el, type, handler, options) {
  el.addEventListener(type, handler, options);
  return () => el.removeEventListener(type, handler, options);
}
