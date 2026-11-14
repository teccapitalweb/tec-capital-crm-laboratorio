/**
 * Panel de detalle: columna a la derecha en computadora, hoja a pantalla completa en celular.
 *
 * Por qué es un <dialog>: en celular el panel tapa la pantalla y debe comportarse como una ventana (foco
 * atrapado, lo de atrás inerte, el botón «atrás» del teléfono lo cierra), y eso el navegador ya lo hace
 * con showModal(). En computadora es el mismo elemento abierto sin modo modal: una columna más de la
 * rejilla .k-split que no impide seguir usando la lista. Escape lo cierra en los dos casos y el foco
 * vuelve a quien lo abrió.
 */
import { html, render } from '../html.js';
import { listen } from '../events.js';
import { nextId } from '../ids.js';
import { glyph } from '../glyphs.js';

const PHONE = '(max-width: 680px)';

/**
 * @param {HTMLElement} slot Ranura de la pantalla, hija directa de un .k-split.
 * @param {{onClose?: () => void}} [options]
 */
export function detailPanel(slot, { onClose } = {}) {
  const page = slot.ownerDocument;
  const view = page.defaultView;
  const titleId = nextId('detalle');
  const element = page.createElement('dialog');
  element.className = 'k-side';
  element.setAttribute('aria-labelledby', titleId);
  render(
    element,
    html`<header class="k-side__head">
        <h2 class="k-side__title" id="${titleId}" tabindex="-1"></h2>
        <button type="button" class="k-btn k-btn--ghost k-btn--icon" data-do="k-side-close" aria-label="Cerrar el detalle">${glyph('x')}</button>
      </header>
      <div class="k-side__body" data-slot="cuerpo"></div>`,
  );
  slot.replaceChildren(element);
  slot.hidden = true;

  const title = element.querySelector('.k-side__title');
  const body = element.querySelector('[data-slot="cuerpo"]');
  const phone = view.matchMedia(PHONE);
  let opener = null;
  let unmount = null;

  function show() {
    if (element.open) element.close();
    if (phone.matches) element.showModal();
    else element.show();
  }

  function clear() {
    try {
      unmount?.();
    } catch (error) {
      console.error(error);
    }
    unmount = null;
    render(body, html``);
  }

  function close() {
    if (!element.open) return;
    clear();
    element.close();
    slot.hidden = true;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
    onClose?.();
  }

  // Al girar el teléfono o cambiar el ancho de la ventana, el panel abierto pasa de columna a hoja o al revés.
  const onResize = () => element.open && show();
  phone.addEventListener('change', onResize);

  // Escape en una ventana modal llega como `cancel`; sin modo modal es una tecla más.
  const onCancel = event => {
    event.preventDefault();
    close();
  };
  const onKey = event => {
    if (event.key === 'Escape' && !event.defaultPrevented) close();
  };
  element.addEventListener('cancel', onCancel);
  element.addEventListener('keydown', onKey);
  const off = listen(element, { click: { 'k-side-close': close } }, { contain: false });

  return {
    /** El cuerpo del panel, por si la pantalla quiere pintar en él directamente. */
    body,
    isOpen: () => element.open,
    /**
     * Abre el panel (o cambia su contenido si ya estaba abierto) y lleva el foco a su título.
     * @param {object} options
     * @param {string} options.title
     * @param {unknown} [options.content] Fragmento html`…` para contenido fijo.
     * @param {(body: HTMLElement) => (void | (() => void))} [options.mount] Para contenido vivo; devuelve su limpieza.
     * @param {HTMLElement} [options.opener] A quién vuelve el foco al cerrar (por omisión, quien lo tenía).
     */
    open({ title: text, content, mount, opener: from }) {
      const active = page.activeElement;
      if (!element.open || from) opener = from ?? (active && active !== page.body ? active : null);
      clear();
      title.textContent = text;
      if (content) render(body, content);
      unmount = mount?.(body) ?? null;
      slot.hidden = false;
      if (!element.open) show();
      title.focus({ preventScroll: true });
    },
    close,
    destroy() {
      off();
      phone.removeEventListener('change', onResize);
      element.removeEventListener('cancel', onCancel);
      element.removeEventListener('keydown', onKey);
      try {
        unmount?.();
      } catch (error) {
        console.error(error);
      }
      unmount = null;
    },
  };
}
