/**
 * Estados normalizados (cargando, vacío, fallo) y el aviso breve.
 *
 * Por qué existe: cada pantalla actual redacta y maqueta a su manera «no hay nada», «cargando» y «falló».
 * Aquí son tres fragmentos con el mismo aspecto y los mismos papeles ARIA, para que quien usa un lector de
 * pantalla se entere igual en las cuarenta pantallas.
 */
import { html, when } from '../html.js';

/** Bloque «cargando». role="status" lo anuncia sin interrumpir. */
export function loading(text = 'Cargando…') {
  return html`<div class="k-state k-state--loading" role="status"><p>${text}</p></div>`;
}

/**
 * Bloque «vacío»: una frase que explica por qué no hay nada y, si la hay, la acción principal.
 * @param {{title?: string, text?: string, action?: unknown}} [options] `action` es un fragmento html`…`.
 */
export function empty({ title = 'Todavía no hay nada aquí', text = '', action } = {}) {
  return html`<div class="k-state k-state--empty">
    <p class="k-state__title">${title}</p>
    ${when(text, () => html`<p>${text}</p>`)} ${when(action, action)}
  </div>`;
}

/**
 * Bloque «falló», con botón para reintentar si se da el verbo (data-do) que lo atiende.
 * Muestra el mensaje del servidor cuando el error viene de la API (ya está en español); de cualquier
 * otro error no enseña el texto técnico.
 * @param {{title?: string, text?: string, error?: unknown, retry?: string, retryLabel?: string}} [options]
 */
export function failure({ title = 'No se pudo cargar', text, error, retry, retryLabel = 'Volver a intentar' } = {}) {
  const detail =
    text ?? (error?.name === 'ApiError' ? error.message : 'Algo falló al mostrar esta parte. Vuelve a intentarlo.');
  return html`<div class="k-state k-state--error" role="alert">
    <p class="k-state__title">${title}</p>
    <p>${detail}</p>
    ${when(retry, () => html`<button type="button" class="k-btn" data-do="${retry}">${retryLabel}</button>`)}
  </div>`;
}

let region = null;
let hideTimer = 0;

/**
 * Aviso breve que no bloquea. Dentro de la aplicación usa el aviso de siempre (un solo aspecto y un solo
 * sitio en pantalla); fuera de ella (pruebas, ejemplos) pinta uno propio equivalente.
 */
export function toast(text) {
  const message = String(text ?? '');
  const hostToast = globalThis.TC?.host?.toast;
  if (typeof hostToast === 'function') {
    hostToast(message);
    return;
  }
  const page = globalThis.document;
  if (!page?.body) return;
  if (!region?.isConnected) {
    region = page.createElement('div');
    region.className = 'k-toast';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('popover', 'manual');
    page.body.append(region);
  }
  clearTimeout(hideTimer);
  region.textContent = message;
  // Reabrirlo lo sube a la capa superior, por encima de una ventana abierta después.
  try {
    if (region.matches(':popover-open')) region.hidePopover();
    region.showPopover();
  } catch {}
  hideTimer = setTimeout(() => {
    region.textContent = '';
    try {
      region.hidePopover();
    } catch {}
  }, 4300);
}
