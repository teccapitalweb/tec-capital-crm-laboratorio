/**
 * Plantillas HTML que escapan solas y un render() que no destruye lo que ya está pintado.
 *
 * Por qué existe: las pantallas actuales arman cadenas y las asignan a innerHTML escapando a mano con
 * esc(); basta olvidar un esc() para tener una inyección. Aquí es al revés: todo lo que se interpola
 * en html`…` se escapa, y lo único que pasa sin escapar es otro fragmento hecho con html`…` (o con raw(),
 * que se escribe a propósito y se puede buscar). render() es el único sitio del kit que toca innerHTML.
 *
 * La plantilla además sabe DÓNDE cae cada interpolación (texto, valor de atributo, dentro de una
 * etiqueta…) y se niega a pintar lo que el escape no puede proteger: atributos sin comillas, nombres de
 * atributo o de etiqueta, <script>, <style>, manejadores on…, style="…" y direcciones peligrosas.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapa un valor para texto o para un atributo entre comillas (misma tabla que public/app.js). */
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ENTITIES[c]);

/**
 * Marca de «esto ya es seguro». El texto vive en un campo privado: ningún objeto que llegue de la API o
 * de JSON.parse puede hacerse pasar por un fragmento, ni siquiera copiando sus propiedades.
 */
class Safe {
  #text;
  #kind;

  constructor(text, kind) {
    this.#text = text;
    this.#kind = kind;
    Object.freeze(this);
  }

  /** El marcado como texto (útil en pruebas). Volver a interpolarlo lo escapa: no es una puerta trasera. */
  toString() {
    return this.#text;
  }

  /** Devuelve el texto si `value` es un fragmento de esa clase; si no, null. */
  static unwrap(value, kind) {
    return typeof value === 'object' && value !== null && #text in value && value.#kind === kind ? value.#text : null;
  }
}

const MARKUP = 'html';
const ATTRS = 'attrs';

/** ¿Es un fragmento hecho con html`…` o raw()? */
export const isSafe = value => Safe.unwrap(value, MARKUP) !== null;

/**
 * Marca como seguro un texto que YA es HTML de confianza (por ejemplo, el SVG que arma charts.js
 * escapando él mismo). Nunca se usa con datos de una persona o de la API: para eso está html`…`.
 * Las pantallas no lo necesitan; test/kit-static.test.mjs sólo lo permite dentro del kit.
 */
export const raw = text => new Safe(String(text ?? ''), MARKUP);

// ---------------------------------------------------------------------------------------------------
// Direcciones
// ---------------------------------------------------------------------------------------------------

const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'cite', 'ping', 'xlink:href']);
/** Atributos que el escape no puede volver seguros: nunca llevan datos interpolados. */
const FORBIDDEN_ATTRIBUTES = new Set(['style', 'srcdoc', 'srcset']);

/**
 * La dirección como la lee un navegador: sin tabuladores ni saltos de línea en ningún sitio y sin espacios
 * ni caracteres de control en los extremos. Se hace por código de carácter para no escribir caracteres
 * invisibles en este archivo.
 */
function asBrowsersRead(text) {
  let out = '';
  for (const c of text) {
    const code = c.charCodeAt(0);
    if (code !== 9 && code !== 10 && code !== 13) out += c;
  }
  let start = 0;
  let end = out.length;
  while (start < end && out.charCodeAt(start) <= 32) start++;
  while (end > start && out.charCodeAt(end - 1) <= 32) end--;
  return out.slice(start, end);
}

/** Sin ningún espacio ni carácter de control (códigos 0 a 32 y 127): la versión más estricta, para comprobar. */
function withoutControls(text) {
  let out = '';
  for (const c of text) {
    const code = c.charCodeAt(0);
    if (code > 32 && code !== 127) out += c;
  }
  return out;
}

/**
 * Devuelve la dirección sólo si es del mismo origen (relativa) o https:; si no, «#».
 * Cierra javascript:, data:, las relativas al protocolo (//otro.sitio) y sus variantes con barras
 * invertidas o con caracteres de control intercalados, que los navegadores toleran.
 */
export function url(value) {
  const text = asBrowsersRead(String(value ?? ''));
  const probe = withoutControls(text);
  if (probe === '') return '';
  if (/^[/\\]{2}/.test(probe)) return '#';
  if (/^https:\/\//i.test(probe)) return text;
  // Sin esquema: no hay «:» antes de la primera «/», «?» o «#».
  return /^[^:/?#]*(?:[/?#]|$)/.test(probe) ? text : '#';
}

// ---------------------------------------------------------------------------------------------------
// attrs(): atributos opcionales y booleanos
// ---------------------------------------------------------------------------------------------------

const ATTRIBUTE_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

function checkAttributeName(name) {
  const lower = name.toLowerCase();
  if (!ATTRIBUTE_NAME.test(name)) throw new TypeError(`Nombre de atributo no válido: «${name}».`);
  if (lower.startsWith('on'))
    throw new TypeError(`«${name}»: los manejadores en línea no se usan; los eventos van con data-do y listen().`);
  if (FORBIDDEN_ATTRIBUTES.has(lower))
    throw new TypeError(`«${name}» no admite datos interpolados; usa una clase de la hoja de estilos.`);
  return lower;
}

/**
 * Atributos cuyo valor es la palabra «true» o «false»: en ellos un booleano se escribe tal cual
 * (aria-expanded="${abierto}"). En los demás un booleano no pinta nada, para que
 * class="${activa && 'is-active'}" no acabe diciendo class="false".
 */
const spellsBooleans = name =>
  name.startsWith('aria-') ||
  name.startsWith('data-') ||
  name === 'draggable' ||
  name === 'spellcheck' ||
  name === 'contenteditable';

/** Valor de un atributo. Las listas se unen con espacios descartando lo vacío (clases condicionales). */
function attributeText(value, literal = false) {
  if (value === null || value === undefined) return '';
  if (value === true || value === false) return literal ? String(value) : '';
  if (Array.isArray(value))
    return value.filter(v => v !== null && v !== undefined && v !== false && v !== true && v !== '').join(' ');
  return String(value);
}

/**
 * Atributos a partir de un objeto, para interpolar DENTRO de una etiqueta: html`<input ${attrs({…})}>`.
 * `true` escribe el atributo sin valor (checked, disabled…); `false`, `null` y `undefined` lo omiten.
 * Para un valor ARIA que deba decir «false» se pasa el texto: {'aria-expanded': String(abierto)}.
 */
export function attrs(map) {
  const parts = [];
  for (const [name, value] of Object.entries(map ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    const lower = checkAttributeName(name);
    if (value === true) {
      parts.push(name);
      continue;
    }
    const text = attributeText(value);
    parts.push(`${name}="${esc(URL_ATTRIBUTES.has(lower) ? url(text) : text)}"`);
  }
  return new Safe(parts.join(' '), ATTRS);
}

// ---------------------------------------------------------------------------------------------------
// html`…`: en qué contexto cae cada interpolación
// ---------------------------------------------------------------------------------------------------

const TEXT = 0;
const TAG_NAME = 1;
const IN_TAG = 2;
const ATTR_NAME = 3;
const AFTER_NAME = 4;
const BEFORE_VALUE = 5;
const VALUE_DQ = 6;
const VALUE_SQ = 7;
const VALUE_BARE = 8;
const COMMENT = 9;
const CLOSE_TAG = 10;
const RAW_TEXT = 11;

const IN_TEXT = { kind: 'text' };
const refuse = message => ({ kind: 'error', message });
const SPACE = /\s/;

/**
 * Recorre las partes fijas de una plantilla como lo haría el analizador de HTML y anota, para cada hueco,
 * dónde cae. Se hace una vez por plantilla (las partes fijas son el mismo objeto en cada llamada).
 */
function scan(strings) {
  const holes = [];
  let state = TEXT;
  let tag = '';
  let attribute = '';
  let valueIsEmpty = true; // ¿el valor del atributo no tiene todavía nada fijo ni interpolado?
  let rawEnd = '';

  const endTag = () => {
    const name = tag.toLowerCase();
    if (name === 'script' || name === 'style') {
      rawEnd = `</${name}`;
      state = RAW_TEXT;
    } else state = TEXT;
  };

  for (let part = 0; part < strings.length; part++) {
    const text = strings[part];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      switch (state) {
        case TEXT:
          if (c !== '<') break;
          if (text.startsWith('!--', i + 1)) state = COMMENT;
          else if (text[i + 1] === '/') state = CLOSE_TAG;
          else if (i + 1 === text.length || /[a-zA-Z]/.test(text[i + 1])) {
            // Un «<» justo antes de un hueco también abre etiqueta: lo interpolado sería su nombre.
            state = TAG_NAME;
            tag = '';
          }
          break;
        case TAG_NAME:
          if (SPACE.test(c) || c === '/') state = IN_TAG;
          else if (c === '>') endTag();
          else tag += c;
          break;
        case IN_TAG:
        case AFTER_NAME:
          if (c === '>') endTag();
          else if (c === '=' && state === AFTER_NAME) state = BEFORE_VALUE;
          else if (!SPACE.test(c) && c !== '/') {
            state = ATTR_NAME;
            attribute = c;
          }
          break;
        case ATTR_NAME:
          if (c === '=') state = BEFORE_VALUE;
          else if (c === '>') endTag();
          else if (SPACE.test(c)) state = AFTER_NAME;
          else if (c === '/') state = IN_TAG;
          else attribute += c;
          break;
        case BEFORE_VALUE:
          if (c === '"' || c === "'") {
            state = c === '"' ? VALUE_DQ : VALUE_SQ;
            valueIsEmpty = true;
          } else if (c === '>') endTag();
          else if (!SPACE.test(c)) state = VALUE_BARE;
          break;
        case VALUE_DQ:
        case VALUE_SQ:
          if (c === (state === VALUE_DQ ? '"' : "'")) state = IN_TAG;
          else valueIsEmpty = false;
          break;
        case VALUE_BARE:
          if (SPACE.test(c)) state = IN_TAG;
          else if (c === '>') endTag();
          break;
        case COMMENT:
          if (c === '>' && text.slice(Math.max(0, i - 2), i) === '--') state = TEXT;
          break;
        case CLOSE_TAG:
          if (c === '>') state = TEXT;
          break;
        default: // RAW_TEXT
          if (c === '<' && text.slice(i, i + rawEnd.length).toLowerCase() === rawEnd) state = CLOSE_TAG;
      }
    }
    if (part === strings.length - 1) break;

    // Hay un hueco justo aquí.
    if (state === TEXT) holes.push(IN_TEXT);
    else if (state === IN_TAG || state === AFTER_NAME) {
      // Si lo anterior no acaba en espacio (unas comillas, otro hueco), los atributos necesitan uno delante.
      holes.push({ kind: 'tag', glue: !SPACE.test(text.slice(-1) || 'x') });
      state = IN_TAG;
    } else if (state === VALUE_DQ || state === VALUE_SQ) {
      const name = attribute.toLowerCase();
      if (name.startsWith('on'))
        holes.push(
          refuse(`«${attribute}»: los manejadores en línea no se usan; los eventos van con data-do y listen().`),
        );
      else if (FORBIDDEN_ATTRIBUTES.has(name))
        holes.push(refuse(`«${attribute}» no admite datos interpolados; usa una clase de la hoja de estilos.`));
      else if (URL_ATTRIBUTES.has(name)) {
        // Una dirección sólo se puede comprobar entera: el hueco debe ser todo el valor.
        const quote = state === VALUE_DQ ? '"' : "'";
        const whole = valueIsEmpty && strings[part + 1].startsWith(quote);
        holes.push(
          whole
            ? { kind: 'url' }
            : refuse(
                `«${attribute}»: arma la dirección completa en una variable y ponla sola: ${attribute}="\${direccion}".`,
              ),
        );
      } else holes.push({ kind: 'value', literal: spellsBooleans(name) });
      valueIsEmpty = false;
    } else if (state === BEFORE_VALUE || state === VALUE_BARE)
      holes.push(refuse(`«${attribute}»: los atributos van siempre entre comillas dobles.`));
    else if (state === RAW_TEXT) holes.push(refuse(`Nada se interpola dentro de <${tag.toLowerCase()}>.`));
    else if (state === COMMENT) holes.push(refuse('Nada se interpola dentro de un comentario.'));
    else
      holes.push(
        refuse('Los nombres de etiqueta y de atributo no se interpolan; para atributos opcionales usa attrs().'),
      );
  }
  if (state !== TEXT)
    throw new TypeError(
      'La plantilla termina a medias de una etiqueta o de un comentario: cada html`…` debe ser un fragmento completo.',
    );
  return holes;
}

const SCANNED = new WeakMap();

function textPart(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (typeof value === 'object') {
    const safe = Safe.unwrap(value, MARKUP);
    if (safe !== null) return safe;
    if (Safe.unwrap(value, ATTRS) !== null)
      throw new TypeError('attrs() sólo se interpola dentro de una etiqueta: <input ${attrs({…})}>.');
    if (typeof value[Symbol.iterator] === 'function') {
      let out = '';
      for (const item of value) out += textPart(item);
      return out;
    }
  }
  return esc(value);
}

function fill(value, hole) {
  switch (hole.kind) {
    case 'text':
      return textPart(value);
    case 'value':
      // Un fragmento aquí se escapa como cualquier texto: dentro de un atributo no hay marcado.
      return esc(attributeText(value, hole.literal));
    case 'url':
      return esc(url(attributeText(value)));
    case 'tag': {
      if (value === null || value === undefined || value === false || value === '') return '';
      const safe = Safe.unwrap(value, ATTRS);
      if (safe === null)
        throw new TypeError(
          'Dentro de una etiqueta sólo se interpola attrs({…}); un valor va entre comillas: nombre="${valor}".',
        );
      return safe && hole.glue ? ` ${safe}` : safe;
    }
    default:
      throw new TypeError(hole.message);
  }
}

/**
 * Plantilla etiquetada. Escapa toda interpolación; un fragmento interpolado en texto pasa tal cual; una
 * lista se une; null, undefined y los booleanos no pintan nada (salvo en aria-… y data-…, donde true y
 * false se escriben, que es lo que esos atributos esperan).
 *
 *   html`<li class="${['k-row', activa && 'is-active']}" aria-current="${activa}">
 *     ${nombre} ${activa && html`<b>ahora</b>`}
 *   </li>`
 */
export function html(strings, ...values) {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw) || !Object.isFrozen(strings)) {
    throw new TypeError(
      'html es una plantilla etiquetada: html`…`. Para marcado de confianza del propio kit existe raw().',
    );
  }
  let holes = SCANNED.get(strings);
  if (!holes) {
    holes = scan(strings);
    SCANNED.set(strings, holes);
  }
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += fill(values[i], holes[i]) + strings[i + 1];
  return new Safe(out, MARKUP);
}

// ---------------------------------------------------------------------------------------------------
// Ayudas para listas y partes condicionales
// ---------------------------------------------------------------------------------------------------

const NOTHING = new Safe('', MARKUP);

/**
 * Parte condicional sin la trampa de `0 && …` (que pintaría un «0»): evalúa perezosamente una rama.
 *   ${when(filas.length, () => html`<table>…</table>`, () => html`<p>Sin resultados.</p>`)}
 */
export function when(condition, then, otherwise) {
  const branch = condition ? then : otherwise;
  const value = typeof branch === 'function' ? branch() : branch;
  return value === undefined || value === null ? NOTHING : html`${value}`;
}

/**
 * Lista: pinta cada elemento con `row(item, índice)`; si no hay ninguno pinta `empty`.
 * Cada fila debería llevar data-key para que render() la reconozca al reordenar.
 */
export function each(items, row, empty) {
  const list = Array.isArray(items) ? items : Array.from(items ?? []);
  if (!list.length) return when(true, empty);
  return html`${list.map(row)}`;
}

/** Une fragmentos o textos con un separador (texto o fragmento). */
export function join(parts, separator = ', ') {
  const list = Array.from(parts ?? []).filter(
    part => part !== null && part !== undefined && part !== false && part !== '',
  );
  return html`${list.map((part, index) => (index ? html`${separator}${part}` : part))}`;
}

const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Icono de Lucide, igual que icon() de public/app.js: deja la marca y la aplicación la convierte en SVG.
 * Siempre decorativo (aria-hidden): el significado va en el texto o en el aria-label del control.
 */
export function icon(name) {
  if (!ICON_NAME.test(String(name))) throw new TypeError(`Nombre de icono no válido: «${name}».`);
  return new Safe(`<i data-lucide="${name}" aria-hidden="true"></i>`, MARKUP);
}

// ---------------------------------------------------------------------------------------------------
// render(): pinta sin destruir
// ---------------------------------------------------------------------------------------------------

const ELEMENT = 1;
const KEY = 'data-key';
const SLOT = 'data-slot';

/** Identidad de un nodo entre dos pintados: data-key, id o el nombre de la ranura. */
function keyOf(node) {
  if (node.nodeType !== ELEMENT) return null;
  const key = node.getAttribute(KEY) ?? node.getAttribute('id');
  if (key !== null) return key;
  const slot = node.getAttribute(SLOT);
  return slot === null ? null : `slot:${slot}`;
}

/** La aplicación cambia <i data-lucide="x"> por un <svg data-lucide="x">: es el mismo icono y no se toca. */
function sameIcon(current, next) {
  const name = next.getAttribute('data-lucide');
  return (
    name !== null &&
    current.nodeName.toLowerCase() === 'svg' &&
    next.nodeName === 'I' &&
    current.getAttribute('data-lucide') === name
  );
}

function reusable(current, next) {
  if (current.nodeType !== next.nodeType) return false;
  if (current.nodeType !== ELEMENT) return true;
  if (sameIcon(current, next)) return true;
  if (current.nodeName !== next.nodeName) return false;
  return current.nodeName !== 'INPUT' || current.getAttribute('type') === next.getAttribute('type');
}

/** `open` lo pone la persona (o showModal): un repintado no pliega un <details> ni cierra un <dialog>. */
const keepsAttribute = (node, name) => name === 'open' && (node.nodeName === 'DETAILS' || node.nodeName === 'DIALOG');

function patch(current, next) {
  if (current.nodeType !== ELEMENT) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  if (sameIcon(current, next)) return;
  // Una ranura es de quien pinta dentro de ella (una tabla, un formulario): ni su contenido ni sus
  // atributos se tocan desde fuera.
  if (current.hasAttribute(SLOT)) return;

  // Estado vivo de los campos, antes de tocar atributos (el atributo guarda lo que se pintó la vez anterior).
  const name = current.nodeName;
  if (name === 'INPUT') {
    const type = current.getAttribute('type');
    if (type === 'checkbox' || type === 'radio') {
      // Lo marcado se pinta desde el estado: si el estado rechaza un clic, la casilla vuelve a su sitio.
      const checked = next.hasAttribute('checked');
      if (current.checked !== checked) current.checked = checked;
    } else if (type !== 'file') {
      // El texto sólo se escribe si el marcado cambió: así no se pisa lo que la persona está tecleando
      // (ni una tilde a medio componer) y un campo se puede vaciar desde el estado.
      const value = next.getAttribute('value') ?? '';
      if (value !== (current.getAttribute('value') ?? '') && current.value !== value) current.value = value;
    }
  } else if (name === 'TEXTAREA') {
    const value = next.textContent;
    if (value !== current.textContent && current.value !== value) current.value = value;
  } else if (name === 'OPTION') {
    const selected = next.hasAttribute('selected');
    if (current.selected !== selected) current.selected = selected;
  }

  for (const attribute of next.getAttributeNames()) {
    const value = next.getAttribute(attribute);
    if (current.getAttribute(attribute) !== value && !keepsAttribute(current, attribute))
      current.setAttribute(attribute, value);
  }
  for (const attribute of current.getAttributeNames()) {
    if (!next.hasAttribute(attribute) && !keepsAttribute(current, attribute)) current.removeAttribute(attribute);
  }
  morph(current, next);
}

/**
 * Deja los hijos de `parent` iguales a los de `source` reutilizando los nodos que ya existen. Así un
 * repintado conserva el foco, el cursor, el desplazamiento y los <details> abiertos, y no parpadea
 * (regla de Niebla: nada se anima ni salta en las actualizaciones en vivo).
 * Se exporta para poder probarlo; las pantallas usan render().
 */
export function morph(parent, source) {
  let keyed = null;
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    const key = keyOf(node);
    if (key !== null && !(keyed ??= new Map()).has(key)) keyed.set(key, node);
  }

  let current = parent.firstChild;
  let next = source.firstChild;
  while (next) {
    const following = next.nextSibling;
    const key = keyOf(next);
    let match = null;
    if (key !== null) {
      const candidate = keyed?.get(key);
      if (candidate && reusable(candidate, next)) {
        match = candidate;
        keyed.delete(key); // una clave repetida en el marcado nuevo no reutiliza dos veces el mismo nodo
      }
    } else if (current && keyOf(current) === null && reusable(current, next)) match = current;

    if (!match) parent.insertBefore(next, current);
    else {
      if (match === current) current = current.nextSibling;
      else parent.insertBefore(match, current);
      patch(match, next);
    }
    next = following;
  }
  while (current) {
    const following = current.nextSibling;
    parent.removeChild(current);
    current = following;
  }
}

/**
 * Pinta `content` dentro de `target`. Sólo acepta el resultado de html`…`: una cadena suelta lanza.
 * La primera vez asigna el marcado; después lo concilia con lo que ya hay (ver morph).
 * Es el ÚNICO sitio de public/kit y public/screens que toca innerHTML.
 */
export function render(target, content) {
  const text = Safe.unwrap(content, MARKUP);
  if (text === null) throw new TypeError('render() sólo acepta el resultado de html`…`.');

  if (!target.firstChild) target.innerHTML = text;
  else {
    const page = target.ownerDocument;
    const focused = page.activeElement && target.contains(page.activeElement) ? page.activeElement : null;
    // Un clon vacío del destino analiza el marcado en su mismo contexto (tbody, select, svg…).
    const next = target.cloneNode(false);
    next.innerHTML = text;
    morph(target, next);
    // Mover un nodo con clave le quita el foco: se le devuelve si sigue en la página.
    if (focused && focused.isConnected && page.activeElement !== focused) focused.focus({ preventScroll: true });
  }

  // Lo que el marcado no puede expresar.
  for (const box of target.querySelectorAll('input[data-indeterminate]')) {
    box.indeterminate = box.getAttribute('data-indeterminate') === 'true';
  }
  if (target.querySelector('i[data-lucide]')) globalThis.TC?.host?.icons?.();
}
