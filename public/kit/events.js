/**
 * Eventos delegados dentro de la raíz de una pantalla.
 *
 * Por qué existe: hoy public/app.js escucha en `document` y reparte los clics por catorce atributos
 * data-… y los formularios por prefijo de id; un formulario con el prefijo equivocado lo recibe otro
 * módulo y no hace nada. Una pantalla nueva escucha sólo dentro de su raíz, por el atributo
 * data-do="<verbo>", y lo que pasa dentro no sale hacia esos oyentes globales.
 */

/** Atributo que nombra la acción de un elemento: <button type="button" data-do="guardar">. */
export const ACTION = 'data-do';

/** Lo que una pantalla nunca deja subir hasta los oyentes globales de public/app.js. */
const CONTAINED = ['click', 'submit', 'change', 'input', 'keydown'];

/** Eventos que no burbujean: se escuchan en la fase de captura y nunca se detienen. */
const CAPTURED = new Set(['focus', 'blur', 'toggle', 'scroll', 'load', 'error', 'cancel', 'close']);

const isAbort = error => error?.name === 'AbortError';
const report = error => console.error(error);

/** El elemento con data-do más cercano al origen del evento, sin salir de la raíz. */
function actionElement(start, root) {
  for (let node = start; node; node = node.parentNode) {
    if (node.nodeType === 1 && node.hasAttribute(ACTION)) return node;
    if (node === root) return null;
  }
  return null;
}

/**
 * Valores de un formulario como objeto plano, con formas previsibles:
 * una casilla sola → booleano; varias casillas con el mismo nombre → lista de las marcadas;
 * botones de opción → el valor elegido o ''; selección múltiple → lista; archivo → lista de File;
 * lo demás → texto. Los controles deshabilitados o sin nombre no cuentan.
 */
export function formValues(form) {
  const groups = new Map();
  for (const control of form.elements) {
    const type = control.type;
    if (
      !control.name ||
      control.disabled ||
      type === 'submit' ||
      type === 'button' ||
      type === 'reset' ||
      type === 'fieldset'
    )
      continue;
    if (!groups.has(control.name)) groups.set(control.name, []);
    groups.get(control.name).push(control);
  }
  const values = {};
  for (const [name, controls] of groups) {
    const type = controls[0].type;
    if (type === 'checkbox') {
      values[name] = controls.length === 1 ? controls[0].checked : controls.filter(c => c.checked).map(c => c.value);
    } else if (type === 'radio') values[name] = controls.find(c => c.checked)?.value ?? '';
    else if (type === 'select-multiple') values[name] = Array.from(controls[0].selectedOptions, option => option.value);
    else if (type === 'file') values[name] = Array.from(controls[0].files ?? []);
    else values[name] = controls.length === 1 ? controls[0].value : controls.map(c => c.value);
  }
  return values;
}

/**
 * Escucha dentro de `root` y reparte por data-do.
 *
 *   const off = listen(root, {
 *     click: { nueva: (event, boton) => … },
 *     submit: { guardar: (event, formulario, valores) => … },   // valores = formValues(formulario)
 *     input: { buscar: (event, campo) => … },
 *   });
 *
 * Reglas:
 * - Decide el elemento con data-do más cercano al origen del evento. Si no declara ese tipo de evento no
 *   pasa nada (un clic en una casilla con data-do no abre la fila que la contiene).
 * - Todo `submit` lleva preventDefault(): ninguna pantalla nueva navega al enviar un formulario. Mientras
 *   el manejador de un envío no termina, un segundo envío del mismo formulario se ignora.
 * - Un <button> con data-do y manejador de clic nunca envía su formulario por accidente; el botón que
 *   envía lleva type="submit" y el data-do va en el <form>.
 * - Un manejador puede ser asíncrono: sus errores llegan a `onError` (por omisión, a la consola) y las
 *   peticiones abortadas al salir de la pantalla se ignoran.
 *
 * `contain` (por omisión, sí) detiene en la raíz click, submit, change, input y keydown, se atiendan o no:
 * es lo que aísla a la pantalla de los oyentes globales. Los componentes del kit escuchan en su propia
 * raíz con `contain: false`, que no detiene nada: sus verbos empiezan por «k-» y lo que ellos no atienden
 * (un botón que la pantalla puso dentro de una celda) sigue subiendo hasta el listen() de la pantalla.
 *
 * Devuelve la función que quita todos los oyentes; hay que llamarla al salir de la pantalla.
 */
export function listen(root, handlers, { contain = true, onError = report } = {}) {
  const types = new Set(Object.keys(handlers));
  if (contain) for (const type of CONTAINED) types.add(type);
  const sending = new WeakSet();

  const fail = error => {
    if (!isAbort(error)) onError(error);
  };

  const dispatch = event => {
    const type = event.type;
    const captured = CAPTURED.has(type);
    if (contain && !captured) event.stopPropagation();
    if (type === 'submit') event.preventDefault();

    const map = handlers[type];
    if (!map) return;
    const element = actionElement(event.target, root);
    const handler = element ? map[element.getAttribute(ACTION)] : null;
    if (typeof handler !== 'function') return;

    if (type === 'click' && element.nodeName === 'BUTTON' && element.getAttribute('type') !== 'submit')
      event.preventDefault();

    const form = type === 'submit' ? event.target : null;
    if (form && sending.has(form)) return;
    try {
      const result = form ? handler(event, element, formValues(form)) : handler(event, element);
      if (result && typeof result.then === 'function') {
        if (form) sending.add(form);
        result.then(undefined, fail).finally(() => form && sending.delete(form));
      }
    } catch (error) {
      fail(error);
    }
  };

  // El último evento que entró por la raíz (se anota al bajar, antes de que nadie de dentro lo atienda).
  let entered = null;
  const note = event => {
    entered = event;
  };

  for (const type of types) root.addEventListener(type, dispatch, CAPTURED.has(type));
  if (contain) for (const type of CONTAINED) root.addEventListener(type, note, true);

  const remove = () => {
    for (const type of types) root.removeEventListener(type, dispatch, CAPTURED.has(type));
    if (contain) for (const type of CONTAINED) root.removeEventListener(type, note, true);
  };
  return () => {
    // Si un manejador de más adentro cierra o desmonta esto a mitad de un evento (el botón «Cancelar» de un
    // formulario dentro de una ventana), la raíz sigue conteniéndolo hasta que termina de subir.
    if (contain && entered?.eventPhase > 0) setTimeout(remove, 0);
    else remove();
  };
}
