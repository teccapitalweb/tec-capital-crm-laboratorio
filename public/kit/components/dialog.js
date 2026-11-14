/**
 * Ventana y confirmación.
 *
 * Por qué no usa el <dialog id="modal"> de la aplicación: ése tiene oyentes del código actual (reparte sus
 * formularios por prefijo de id). Cada ventana del kit crea su propio <dialog> modal: el navegador atrapa
 * el foco dentro, deja inerte lo de atrás y cierra con Escape; aquí sólo se añade devolver el foco a quien
 * la abrió y entregar el resultado como una promesa.
 */
import { attrs, html, render } from '../html.js';
import { listen } from '../events.js';
import { nextId } from '../ids.js';
import { glyph } from '../glyphs.js';

/**
 * Abre una ventana modal y devuelve una promesa con el `id` de la acción elegida, o `null` si se cerró
 * con Escape o con el botón de cerrar.
 *
 *   const eleccion = await dialog({
 *     title: 'Cambiar fecha',
 *     content: html`<p>…</p>`,
 *     actions: [{ id: 'cancelar', label: 'Cancelar' }, { id: 'guardar', label: 'Guardar', primary: true }],
 *   });
 *
 * Para contenido vivo (un formulario del kit) se usa `mount(cuerpo, cerrar)`: pinta dentro de `cuerpo`,
 * llama a `cerrar(valor)` cuando termina y devuelve su función de limpieza.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {unknown} [options.content] Fragmento html`…`.
 * @param {Array<{id: string, label: string, primary?: boolean, danger?: boolean, autofocus?: boolean}>} [options.actions]
 * @param {(body: HTMLElement, close: (value?: unknown) => void) => (void | (() => void))} [options.mount]
 * @param {boolean} [options.wide]
 * @param {() => boolean} [options.canClose] Devuelve false para impedir el cierre (un borrador sin guardar).
 * @returns {Promise<any>}
 */
export function dialog({ title, content = html``, actions = [], mount, wide = false, canClose }) {
  const page = document;
  const opener = page.activeElement;
  const titleId = nextId('ventana');
  const element = page.createElement('dialog');
  element.className = wide ? 'k-dialog k-dialog--wide' : 'k-dialog';
  element.setAttribute('aria-labelledby', titleId);

  render(
    element,
    html`<header class="k-dialog__head">
        <h2 class="k-dialog__title" id="${titleId}">${title}</h2>
        <button type="button" class="k-btn k-btn--ghost k-btn--icon" data-do="k-close" aria-label="Cerrar">${glyph('x')}</button>
      </header>
      <div class="k-dialog__body" data-slot="cuerpo">${content}</div>
      <footer class="k-dialog__foot">
        ${actions.map(
          action =>
            html`<button
              type="button"
              class="${['k-btn', action.primary && 'k-btn--primary', action.danger && 'k-btn--danger']}"
              data-do="k-action"
              data-id="${action.id}"
              ${attrs({ autofocus: action.autofocus === true })}
            >
              ${action.label}
            </button>`,
        )}
      </footer>`,
  );
  page.body.append(element);

  return new Promise(resolve => {
    let settled = false;
    let unmount;

    const finish = value => {
      if (settled) return;
      settled = true;
      off();
      try {
        unmount?.();
      } catch (error) {
        console.error(error);
      }
      if (element.open) element.close();
      element.remove();
      // El navegador devuelve el foco al cerrar; se repite por si quien abrió se repintó mientras tanto.
      if (opener?.isConnected && page.activeElement !== opener) opener.focus?.({ preventScroll: true });
      resolve(value);
    };
    const dismiss = () => {
      if (!canClose || canClose()) finish(null);
    };

    const off = listen(element, {
      click: {
        'k-close': dismiss,
        'k-action': (_event, button) => finish(button.getAttribute('data-id')),
      },
    });
    // Escape: se decide aquí, no en el navegador, para poder conservar un borrador.
    element.addEventListener('cancel', event => {
      event.preventDefault();
      dismiss();
    });

    unmount = mount?.(element.querySelector('[data-slot="cuerpo"]'), finish);
    element.showModal();
    // El foco empieza donde la persona va a actuar: el botón marcado, el primer campo del contenido o la
    // acción principal. Por omisión el navegador lo pondría en «Cerrar», que es lo primero del marcado.
    const start =
      element.querySelector('[autofocus]') ??
      element.querySelector('.k-dialog__body :is(input, select, textarea, button, a[href]):not([disabled])') ??
      element.querySelector('.k-dialog__foot .k-btn--primary, .k-dialog__foot .k-btn');
    start?.focus();
  });
}

/**
 * Pregunta de sí o no. Devuelve true sólo si la persona confirma.
 * Con `danger` (borrar, cancelar un envío) el foco empieza en «Cancelar»: confirmar exige un gesto más.
 *
 * @param {{title: string, message?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean}} options
 * @returns {Promise<boolean>}
 */
export async function confirm({
  title,
  message = '',
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  danger = false,
}) {
  const choice = await dialog({
    title,
    content: html`<p>${message}</p>`,
    actions: [
      { id: 'no', label: cancelLabel, autofocus: danger },
      { id: 'si', label: confirmLabel, primary: !danger, danger, autofocus: !danger },
    ],
  });
  return choice === 'si';
}
