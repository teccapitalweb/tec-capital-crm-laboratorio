/**
 * Arranque del kit en la página: crea window.TC, el único global de las pantallas nuevas.
 *
 *   window.TC.host     lo que public/app.js presta ({state, api, icons, toast, setView…}); lo asigna él.
 *   window.TC.screens  el registro de pantallas (ver screens.js): ready, get, list, mount, unmount, notify.
 *
 * Se carga como módulo antes de app.js. Con la carpeta public/screens/ vacía no cambia nada: la lista
 * llega vacía y ninguna vista es de una pantalla nueva.
 */
import { createScreens } from './screens.js';

// Todo se resuelve respecto de este archivo: funciona se sirva public/ en la raíz o bajo otra ruta.
const SCREENS = new URL('../screens/', import.meta.url);
const loadedStyles = new Set();

/** Añade una hoja de estilos una sola vez y espera a que cargue, para que la pantalla no parpadee sin estilo. */
function addStyle(href, screenId) {
  if (loadedStyles.has(href)) return Promise.resolve();
  loadedStyles.add(href);
  return new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-k-screen', screenId);
    link.addEventListener('load', resolve, { once: true });
    // Sin su hoja la pantalla se ve peor, pero se puede usar: no se bloquea por eso.
    link.addEventListener(
      'error',
      () => {
        console.warn(`No se pudo cargar la hoja de estilos ${href}.`);
        loadedStyles.delete(href);
        resolve();
      },
      { once: true },
    );
    document.head.append(link);
  });
}

const TC = (window.TC ??= {});
TC.host ??= null;
TC.screens = createScreens({
  async loadIndex() {
    const response = await fetch(new URL('index.json', SCREENS), { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`La lista de pantallas respondió ${response.status}.`);
    return response.json();
  },
  importScreen: screen => import(new URL(`${screen.id}/${screen.entry}`, SCREENS).href),
  addStyles: screen =>
    Promise.all((screen.styles ?? []).map(file => addStyle(new URL(`${screen.id}/${file}`, SCREENS).href, screen.id))),
});
