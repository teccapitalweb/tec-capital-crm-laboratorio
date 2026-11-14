/**
 * Pestañas accesibles.
 *
 * Por qué existe: las pestañas actuales son botones sin papel ARIA; un lector de pantalla no sabe que son
 * pestañas ni cuál está elegida, y con el teclado hay que tabular por todas. Aquí siguen el patrón de
 * pestañas de WAI-ARIA: una sola parada de tabulación, flechas para moverse, Inicio y Fin.
 *
 * Regla de Niebla: como mucho unas cinco pestañas por área; si hay más, se agrupan antes por tarea.
 */
import { html, render, when } from '../html.js';
import { listen } from '../events.js';
import { nextId } from '../ids.js';

/**
 * @param {HTMLElement} root
 * @param {object} options
 * @param {Array<{id: string, label: string, count?: number | string, mount?: (panel: HTMLElement) => (void | (() => void))}>} options.items
 *   `mount` pinta el contenido de la pestaña y devuelve su limpieza; se llama cada vez que se elige.
 * @param {string} options.label Nombre del grupo de pestañas para lectores de pantalla.
 * @param {string} [options.selected]
 * @param {(id: string, panel: HTMLElement) => void} [options.onSelect] Sólo cuando la persona cambia de pestaña.
 * @param {string} [options.id]
 */
export function tabs(root, { items, label, selected, onSelect, id = nextId('pestanas') }) {
  let list = items;
  let current = list.some(item => item.id === selected) ? selected : list[0]?.id;
  let leave = null;

  const panel = () => root.querySelector('[data-slot="panel"]');
  const tabId = itemId => `${id}-${itemId}`;

  function draw() {
    render(
      root,
      html`<div class="k-tabs" role="tablist" aria-label="${label}">
          ${list.map(
            item =>
              html`<button
                type="button"
                role="tab"
                class="k-tab"
                id="${tabId(item.id)}"
                aria-selected="${item.id === current}"
                aria-controls="${id}-panel"
                tabindex="${item.id === current ? 0 : -1}"
                data-do="k-tab"
                data-id="${item.id}"
              >
                ${item.label}${when(item.count !== undefined && item.count !== null, () => html`<span class="k-tab__count">${item.count}</span>`)}
              </button>`,
          )}
        </div>
        <div class="k-tabpanel" role="tabpanel" id="${id}-panel" tabindex="0" data-slot="panel"></div>`,
    );
    // El panel es una ranura (su contenido es de la pantalla), así que render() no toca sus atributos.
    panel().setAttribute('aria-labelledby', tabId(current));
  }

  function enter() {
    leave = list.find(item => item.id === current)?.mount?.(panel()) ?? null;
  }

  function exit() {
    try {
      leave?.();
    } catch (error) {
      console.error(error);
    }
    leave = null;
    // Cada pestaña empieza en limpio: nada de la anterior se reutiliza para la siguiente.
    render(panel(), html``);
  }

  function select(next, { focus = false } = {}) {
    if (next === current || !list.some(item => item.id === next)) return;
    exit();
    current = next;
    draw();
    if (focus) root.querySelector(`[id="${tabId(current)}"]`)?.focus();
    enter();
    onSelect?.(current, panel());
  }

  const off = listen(
    root,
    {
      click: { 'k-tab': (_event, tab) => select(tab.getAttribute('data-id')) },
      keydown: {
        'k-tab': event => {
          const index = list.findIndex(item => item.id === current);
          const last = list.length - 1;
          let target = -1;
          if (event.key === 'ArrowRight') target = index === last ? 0 : index + 1;
          else if (event.key === 'ArrowLeft') target = index === 0 ? last : index - 1;
          else if (event.key === 'Home') target = 0;
          else if (event.key === 'End') target = last;
          if (target < 0) return;
          event.preventDefault();
          select(list[target].id, { focus: true });
        },
      },
    },
    { contain: false },
  );

  draw();
  enter();

  return {
    /** El panel donde la pantalla pinta el contenido de la pestaña elegida. */
    get panel() {
      return panel();
    },
    selected: () => current,
    select,
    /** Cambia rótulos o contadores sin tocar el contenido del panel. */
    setItems(next) {
      list = next;
      if (!list.some(item => item.id === current)) {
        exit();
        current = list[0]?.id;
        draw();
        enter();
      } else draw();
    },
    destroy() {
      off();
      try {
        leave?.();
      } catch (error) {
        console.error(error);
      }
      leave = null;
    },
  };
}
