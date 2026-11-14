/**
 * Registro de pantallas nuevas: las conoce por su descriptor (screen.json), las importa la primera vez
 * que se abren, las monta, las desmonta y les pasa los eventos en vivo.
 *
 * Por qué existe: dar de alta una pantalla hoy exige tocar public/index.html, public/app.js y el
 * servidor. Con el registro basta una carpeta public/screens/<id>/ con su screen.json: el servidor
 * publica la lista en /screens/index.json y la aplicación pregunta aquí.
 *
 * Este archivo no toca `window` ni la red por su cuenta (eso lo hace boot.js): recibe cómo cargar la
 * lista, cómo importar un módulo y cómo añadir estilos, y por eso se puede probar en Node.
 *
 * Tres cosas que salen de cómo pinta la aplicación actual y que este registro garantiza:
 * 1. `ready` nunca se rechaza: si la lista no carga, vale [] y la aplicación arranca como siempre.
 * 2. Una pantalla se desmonta y se vuelve a montar a menudo (al cambiar de vista, de marca o de modo), y
 *    su raíz puede haber desaparecido ya. Lo que deba sobrevivir vive en `ctx.keep`.
 * 3. mount() nunca lanza: si la pantalla no se puede abrir, pinta el fallo con «Volver a intentar».
 */
import { createApi } from './api.js';
import { listen } from './events.js';
import { html, render } from './html.js';
import { ids } from './ids.js';
import { failure, loading, toast } from './components/feedback.js';

const SCREEN_ID = /^[a-z][a-z0-9-]{2,30}$/;
const FILE = /^[a-z0-9][a-z0-9._-]*$/;
const isFile = (name, extension) =>
  typeof name === 'string' && FILE.test(name) && name.endsWith(extension) && !name.includes('..');

/**
 * @typedef {object} ScreenDescriptor Una pantalla tal como la publica GET /screens/index.json.
 * @property {string} id Igual al nombre de la carpeta.
 * @property {string} title Título de la página.
 * @property {'preview' | 'live'} [visibility] 'preview' sólo se publica con SCREENS_PREVIEW=1.
 * @property {{group: string, icon: string, label?: string, order: number} | null} [nav]
 *   Dónde aparece en el menú. null: no sale en el menú, pero se puede montar.
 * @property {Array<'admin' | 'agent'>} roles Quién la ve en el menú. El permiso real lo impone cada API.
 * @property {string | null} [permission] Clave del catálogo de permisos, cuando exista.
 * @property {string} entry Módulo de entrada, dentro de su carpeta.
 * @property {string[]} [styles] Hojas de estilo, dentro de su carpeta.
 */

/**
 * Los descriptores que el navegador puede montar, en el orden en que llegan (el servidor ya los ordena
 * por nav.order). Acepta {screens: […]} o la lista suelta. El servidor valida cada screen.json al
 * arrancar; aquí sólo se descarta lo que llevaría a importar algo fuera de la carpeta de la pantalla.
 * @returns {ScreenDescriptor[]}
 */
export function validScreens(list) {
  const items = Array.isArray(list) ? list : Array.isArray(list?.screens) ? list.screens : [];
  const seen = new Set();
  return items.filter(item => {
    const ok =
      item &&
      typeof item.id === 'string' &&
      SCREEN_ID.test(item.id) &&
      !seen.has(item.id) &&
      typeof item.title === 'string' &&
      isFile(item.entry, '.js') &&
      (item.styles === undefined || (Array.isArray(item.styles) && item.styles.every(file => isFile(file, '.css'))));
    if (ok) seen.add(item.id);
    else console.warn('Descriptor de pantalla no válido; se ignora.', item?.id ?? item);
    return ok;
  });
}

/**
 * @param {object} deps
 * @param {() => Promise<unknown>} deps.loadIndex Trae la lista publicada por el servidor.
 * @param {(screen: ScreenDescriptor) => Promise<{default: {mount: Function, onEvent?: Function}}>} deps.importScreen
 * @param {(screen: ScreenDescriptor) => Promise<unknown>} [deps.addStyles] Añade sus hojas una sola vez.
 * @param {() => any} [deps.host] Lo que la aplicación presta a las pantallas (window.TC.host).
 */
export function createScreens({
  loadIndex,
  importScreen,
  addStyles = async () => {},
  host = () => globalThis.TC?.host,
}) {
  /** @type {Map<string, ScreenDescriptor>} */
  const byId = new Map();
  const keeps = new Map();
  let mounted = null;

  const ready = (async () => {
    try {
      const list = validScreens(await loadIndex());
      for (const screen of list) byId.set(screen.id, screen);
      return list;
    } catch (error) {
      console.warn('No se pudo cargar la lista de pantallas nuevas; la aplicación sigue como hasta ahora.', error);
      return [];
    }
  })();

  function keepOf(id) {
    if (!keeps.has(id)) keeps.set(id, new Map());
    return keeps.get(id);
  }

  /** Deshace lo registrado, lo último primero. Una limpieza que falla no impide las demás. */
  function runCleanups(cleanups) {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.error(error);
      }
    }
  }

  function unmount() {
    const current = mounted;
    if (!current) return;
    mounted = null;
    current.api.abort();
    runCleanups(current.cleanups);
  }

  /**
   * Monta la pantalla `id` en `root`. Devuelve true si quedó montada; nunca lanza.
   * @param {string} id
   * @param {HTMLElement} root El #page recién creado.
   */
  async function mount(id, root) {
    unmount();
    const screen = byId.get(id);
    if (!screen) return false;

    const api = createApi();
    const cleanups = [];
    const current = (mounted = { screen, root, api, cleanups, module: null, ctx: null });
    // La raíz empieza vacía: nada de lo que hubiera antes se mezcla con la pantalla.
    root.replaceChildren();
    render(root, html`<section class="k-page">${loading(`Abriendo ${screen.title}…`)}</section>`);

    try {
      const [module] = await Promise.all([importScreen(screen), addStyles(screen)]);
      if (mounted !== current) return false; // se cambió de vista mientras cargaba
      const definition = module?.default;
      if (typeof definition?.mount !== 'function')
        throw new TypeError(`La pantalla «${id}» no exporta por omisión un objeto con mount().`);

      const app = host();
      const ctx = {
        /** Quién está usando la aplicación ({id, name, role…}). */
        user: app?.state?.user ?? null,
        /** La marca elegida en la barra lateral ('all' o su id). El alcance real lo impone el servidor. */
        brand: app?.state?.brand ?? 'all',
        /** Cliente de la API; lo que esté en vuelo se cancela solo al salir. */
        api,
        toast,
        /** Navega a otra vista de la aplicación. */
        go: view => app?.setView?.(view),
        /** Ids para el DOM de esta pantalla: uid('nombre') → 'k-<pantalla>-nombre'. */
        uid: ids(id),
        /** Lo que debe sobrevivir a un remontaje (un borrador, el paso de un asistente). Nunca localStorage. */
        keep: keepOf(id),
        /** Registra algo que hay que deshacer al salir (un temporizador, una suscripción). */
        onUnmount: cleanup => cleanups.push(cleanup),
      };
      current.module = definition;
      current.ctx = ctx;
      root.replaceChildren();
      const off = definition.mount(root, ctx);
      if (typeof off === 'function') cleanups.push(off);
      return true;
    } catch (error) {
      if (mounted !== current) return false;
      console.error(error);
      // Si mount() falló a medias, lo que alcanzó a registrar se deshace ya.
      runCleanups(cleanups);
      root.replaceChildren();
      render(
        root,
        html`<section class="k-page">
          ${failure({ title: `No se pudo abrir «${screen.title}»`, text: 'Revisa tu conexión y vuelve a intentarlo.', retry: 'k-reabrir' })}
        </section>`,
      );
      cleanups.push(listen(root, { click: { 'k-reabrir': () => mount(id, root) } }));
      return false;
    }
  }

  return {
    /** Promesa de la lista de pantallas. Nunca se rechaza. */
    ready,
    /** El descriptor de una pantalla registrada, o undefined. */
    get: id => byId.get(id),
    /** Las pantallas registradas (las de un rol, si se da), en el orden del servidor. */
    list(role) {
      return [...byId.values()].filter(screen => !role || screen.roles?.includes(role));
    },
    /** Las que van en el menú de un rol: las que tienen `nav`. Las demás sólo se abren con mount(). */
    menu(role) {
      return [...byId.values()].filter(screen => screen.nav && screen.roles?.includes(role));
    },
    mount,
    unmount,
    /** La pantalla montada, o null. */
    current: () => mounted?.screen.id ?? null,
    /** Pasa un evento en vivo a la pantalla montada. Ella pide sólo lo que cambió; nunca recarga todo. */
    notify(event) {
      const current = mounted;
      if (typeof current?.module?.onEvent !== 'function') return;
      const report = error => {
        if (error?.name !== 'AbortError') console.error(error);
      };
      try {
        // onEvent puede ser asíncrono (pide lo que cambió): su fallo tampoco tumba a quien avisa.
        const result = current.module.onEvent(event, current.ctx);
        if (result && typeof result.then === 'function') result.then(undefined, report);
      } catch (error) {
        report(error);
      }
    },
  };
}
