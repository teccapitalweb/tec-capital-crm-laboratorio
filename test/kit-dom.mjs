// Doble mínimo del DOM para las pruebas del kit (no es una prueba: no termina en .test.mjs).
//
// Por qué existe: el kit se prueba en Node sin jsdom. Casi todo lo que hay que probar es puro, pero dos
// piezas recorren nodos: morph() (qué nodos se reutilizan al repintar) y listen() (a quién le toca un
// evento). Para ellas basta un árbol con lo justo: hijos, atributos, propiedades de campo y eventos que
// burbujean. Lo que depende de un navegador de verdad (foco, estilos, <dialog>) no se prueba aquí.

export class FakeNode {
  constructor(nodeType, nodeName, nodeValue = null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.nodeValue = nodeValue;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = [];
    // Propiedades vivas de los campos, independientes de sus atributos (como en el navegador).
    this.value = '';
    this.checked = false;
    this.selected = false;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get textContent() {
    return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(child => child.textContent).join('');
  }

  insertBefore(node, reference) {
    node.parentNode?.removeChild(node);
    const at = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }

  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }

  removeChild(node) {
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  getAttributeNames() {
    return [...this.attributes.keys()];
  }

  addEventListener(type, handler, capture = false) {
    this.listeners.push({ type, handler, capture: Boolean(capture) });
  }

  removeEventListener(type, handler, capture = false) {
    this.listeners = this.listeners.filter(
      item => !(item.type === type && item.handler === handler && item.capture === Boolean(capture)),
    );
  }

  /** Lanza un evento desde este nodo: fase de captura hacia abajo y burbujeo hacia arriba. */
  dispatch(type, extra = {}) {
    const event = {
      type,
      target: this,
      eventPhase: 0, // 0: no se está repartiendo; 1: bajando (captura); 3: subiendo (burbujeo)
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      ...extra,
    };
    // El camino se fija al lanzar: aunque un manejador quite nodos, el evento sigue por donde iba.
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    const run = (node, capture) => {
      // Un oyente quitado antes de que le toque ya no se llama, como en el navegador.
      for (const item of [...node.listeners]) {
        if (item.type === type && item.capture === capture && node.listeners.includes(item)) item.handler(event);
      }
    };
    event.eventPhase = 1;
    for (const node of [...path].reverse()) {
      if (event.stopped) break;
      run(node, true);
    }
    event.eventPhase = 3;
    for (const node of path) {
      if (event.stopped) break;
      run(node, false);
    }
    event.eventPhase = 0;
    return event;
  }
}

/** Elemento: h('li', {class: 'k-row', 'data-key': 'a'}, 'texto', h('b')). */
export function h(name, attributes = {}, ...children) {
  const node = new FakeNode(1, name === 'svg' ? 'svg' : name.toUpperCase());
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'value' || key === 'checked' || key === 'selected') node[key] = value;
    if (value === true) node.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) node.append(typeof child === 'string' ? text(child) : child);
  return node;
}

export const text = value => new FakeNode(3, '#text', value);

/** El árbol como texto, para comparar con lo esperado. */
export function serialize(node) {
  if (node.nodeType === 3) return node.nodeValue;
  const attributes = node.getAttributeNames().map(name => ` ${name}="${node.getAttribute(name)}"`);
  return `<${node.nodeName.toLowerCase()}${attributes.join('')}>${node.childNodes.map(serialize).join('')}</${node.nodeName.toLowerCase()}>`;
}

export const children = node => node.childNodes.map(serialize).join('');
