// Ayudantes mínimos del lienzo para pintar y escuchar. `html`, `render`, `esc` y `listen` tienen la misma firma y el
// mismo comportamiento que el kit de pantallas (public/kit/html.js y public/kit/events.js), que se construye en
// paralelo: cuando exista, basta con reexportarlos desde aquí y borrar estas copias. Lo demás (`svgEl`, `on`, `ids`)
// es propio del lienzo.
//
// Regla: todo lo que viene del grafo o de la persona entra al documento por una interpolación de `html`, que lo
// escapa. Ningún archivo del lienzo asigna innerHTML.

const TABLE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => TABLE[c]);

class SafeHtml {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

const part = v => {
  if (v instanceof SafeHtml) return v.text;
  if (Array.isArray(v)) return v.map(part).join('');
  return v === null || v === undefined || v === false ? '' : esc(v);
};

// Plantilla etiquetada que escapa toda interpolación. Un resultado de `html` interpolado pasa tal cual, una lista se
// une, y null, undefined y false dan vacío. Los atributos van siempre entre comillas dobles.
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += part(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

// Sustituye el contenido de un elemento por el de una plantilla. Sólo acepta el resultado de `html`: una cadena
// suelta no puede llegar al documento por descuido.
export function render(el, content) {
  if (!(content instanceof SafeHtml)) throw new TypeError('render() sólo acepta el resultado de html`…`.');
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  el.replaceChildren(range.createContextualFragment(content.text));
}

// Lo que el kit detiene en la raíz de la pantalla, para que nada llegue a los oyentes globales de la aplicación.
const CONTAINED = ['click', 'submit', 'change', 'input', 'keydown'];

// Delegación de eventos dentro de una raíz, por el atributo data-k="<verbo>" del elemento más cercano al origen.
// `handlers` es {tipoDeEvento: {verbo: (evento, elemento) => …}}. Devuelve la función que quita todos los oyentes.
export function listen(root, handlers) {
  const offs = [];
  for (const type of new Set([...CONTAINED, ...Object.keys(handlers)])) {
    const table = handlers[type] || {};
    const listener = event => {
      if (CONTAINED.includes(type)) event.stopPropagation();
      if (type === 'submit') event.preventDefault();
      const origin = event.target;
      const el = origin && typeof origin.closest === 'function' ? origin.closest('[data-k]') : null;
      if (!el || !root.contains(el)) return;
      const handler = table[el.dataset.k];
      if (handler) handler(event, el);
    };
    root.addEventListener(type, listener);
    offs.push(() => root.removeEventListener(type, listener));
  }
  return () => {
    for (const off of offs) off();
  };
}

// ---- Propios del lienzo ----------------------------------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';

// Elemento SVG con sus atributos. Las conexiones se crean así, y no con plantillas, porque se actualizan decenas de
// veces por segundo al arrastrar: sólo se les cambia el atributo `d`.
export function svgEl(doc, tag, attrs = {}) {
  const el = doc.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

// Oyente directo sobre un elemento; devuelve cómo quitarlo.
export function on(el, type, handler, options) {
  el.addEventListener(type, handler, options);
  return () => el.removeEventListener(type, handler, options);
}

// Identificadores para `label for` y `aria-describedby`. El prefijo «k-» no lo reclama ningún módulo de la aplicación
// y el contador evita choques si hay dos lienzos en la misma página.
let mounted = 0;
export function ids() {
  mounted += 1;
  const base = `k-lienzo-${mounted}`;
  let serial = 0;
  return name => {
    serial += 1;
    return `${base}-${String(name).replace(/[^a-zA-Z0-9]+/g, '-')}-${serial}`;
  };
}

// Atributo booleano dentro de una plantilla: html`<button ${flag('disabled', bloqueado)}>`. Sólo admite estos nombres:
// así no sirve para colar texto sin escapar.
const FLAGS = new Set(['disabled', 'checked', 'selected', 'hidden', 'open']);
export function flag(name, active) {
  if (!FLAGS.has(name)) throw new TypeError('Atributo booleano no admitido: ' + name);
  return active ? new SafeHtml(name) : '';
}
