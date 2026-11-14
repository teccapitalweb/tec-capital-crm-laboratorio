/**
 * Tabla por páginas con cursor.
 *
 * Por qué existe: las listas actuales llegan enteras en /api/bootstrap o /api/crm y se filtran en el
 * navegador; con cien mil contactos eso no se sostiene. Esta tabla pide de cincuenta en cincuenta con un
 * cursor («Cargar más»), ordena y filtra en el servidor (ella sólo pasa el orden a `load`) y trae resueltos
 * los estados que toda lista tiene: cargando, vacía, fallo, recargando sin saltos, selección para acciones
 * en lote y elección de columnas. En celular se desplaza dentro de su caja o se vuelve tarjetas.
 */
import { attrs, html, render, when } from '../html.js';
import { listen } from '../events.js';
import { isAbort } from '../api.js';
import { glyph } from '../glyphs.js';
import { empty as emptyState, failure, loading } from './feedback.js';

/** Tope de filas por petición: ninguna lista nueva pide más (regla de las pantallas nuevas). */
export const PAGE_LIMIT = 50;

/**
 * El orden que resulta de pulsar una cabecera: la primera vez, el sentido natural de la columna;
 * después alterna.
 * @param {{by: string, dir: 'asc' | 'desc'} | null} sort
 */
export function nextSort(sort, columnId, firstDir = 'asc') {
  if (sort?.by !== columnId) return { by: columnId, dir: firstDir };
  return { by: columnId, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
}

/**
 * Columnas visibles tras marcar o desmarcar una: conserva el orden de la definición, nunca quita una
 * fija y no pasa del máximo.
 * @param {Array<{id: string, fixed?: boolean}>} columns
 * @param {string[]} visible
 */
export function toggleColumn(columns, visible, columnId, show, max = 12) {
  const column = columns.find(item => item.id === columnId);
  if (!column || column.fixed) return visible;
  const wanted = new Set(visible);
  if (show && wanted.size >= max && !wanted.has(columnId)) return visible;
  if (show) wanted.add(columnId);
  else wanted.delete(columnId);
  return columns.filter(item => item.fixed || wanted.has(item.id)).map(item => item.id);
}

/**
 * @typedef {object} Column
 * @property {string} id
 * @property {string} label
 * @property {(row: any) => unknown} cell Texto (se escapa) o fragmento html`…`.
 * @property {boolean | 'desc'} [sortable] 'desc' si lo natural es de mayor a menor (fechas, cifras).
 * @property {boolean} [numeric] Alinea a la derecha con cifras tabulares.
 * @property {boolean} [wrap] Deja que el texto ocupe varios renglones (una nota); lo normal es uno solo.
 * @property {boolean} [fixed] No se puede ocultar (el nombre).
 * @property {boolean} [hidden] Empieza oculta; se muestra desde «Columnas».
 */

/**
 * @param {HTMLElement} root
 * @param {object} options
 * @param {string} options.label Nombre de la tabla para lectores de pantalla.
 * @param {Column[]} options.columns
 * @param {(row: any) => string | number} options.rowKey
 * @param {(query: {cursor: string | null, sort: {by: string, dir: 'asc' | 'desc'} | null, limit: number, signal: AbortSignal}) => Promise<{rows: any[], next?: string | null}>} options.load
 *   Pide una página. `next` es el cursor de la siguiente; null o ausente, que no hay más.
 * @param {(row: any) => string} [options.rowLabel] Cómo nombrar la fila en voz alta («Seleccionar Ana Pérez»).
 * @param {{by: string, dir: 'asc' | 'desc'}} [options.sort] Orden inicial.
 * @param {number} [options.pageSize] Hasta 50.
 * @param {boolean} [options.selectable]
 * @param {(keys: string[]) => unknown} [options.actions] Botones de las acciones en lote (fragmento); sus data-do los atiende la pantalla.
 * @param {(row: any, opener: HTMLElement) => void} [options.onOpen] Si se da, la primera columna abre la fila.
 * @param {(keys: string[]) => void} [options.onSelect]
 * @param {string[]} [options.visible] Columnas visibles (lo guardado en preferencias).
 * @param {(ids: string[]) => void} [options.onColumns] Para guardar la elección de columnas.
 * @param {(sort: {by: string, dir: string}) => void} [options.onSort]
 * @param {number} [options.maxColumns]
 * @param {boolean} [options.chooser] false quita el selector de columnas.
 * @param {boolean} [options.cards] En celular, tarjetas en lugar de desplazamiento horizontal.
 * @param {{title?: string, text?: string, action?: unknown}} [options.empty]
 */
export function pagedTable(root, options) {
  const { label, columns, rowKey, load, onOpen, onSelect, onColumns, onSort, actions, empty: emptyOptions } = options;
  const limit = Math.min(PAGE_LIMIT, Math.max(1, options.pageSize ?? PAGE_LIMIT));
  const maxColumns = options.maxColumns ?? 12;
  const rowLabel = options.rowLabel ?? (row => String(rowKey(row)));
  const keyOf = row => String(rowKey(row));

  let rows = [];
  let next = null;
  let phase = 'loading'; // 'loading' | 'reloading' | 'ready' | 'error' (la primera página)
  let more = 'idle'; // 'idle' | 'loading' | 'error' (las siguientes)
  let error = null;
  let sort = options.sort ?? null;
  let visible = columns
    .filter(column => column.fixed || (options.visible ? options.visible.includes(column.id) : !column.hidden))
    .map(column => column.id);
  let selected = new Set();
  let serial = 0;
  let controller = null;
  let alive = true;

  const shown = () => columns.filter(column => visible.includes(column.id));

  function sortHeader(column) {
    if (!column.sortable) return html`${column.label}`;
    const active = sort?.by === column.id;
    const direction = active ? (sort.dir === 'asc' ? 'ascendente' : 'descendente') : '';
    return html`<button type="button" class="k-table__sort" data-do="k-sort" data-id="${column.id}">
      ${column.label}${glyph(active ? (sort.dir === 'asc' ? 'up' : 'down') : 'sort')}
      <span class="k-sr">${active ? `, orden ${direction}; pulsa para invertirlo` : ', pulsa para ordenar'}</span>
    </button>`;
  }

  function rowMarkup(row, list) {
    const key = keyOf(row);
    const isSelected = selected.has(key);
    return html`<tr data-key="${`fila-${key}`}" class="${isSelected && 'is-selected'}">
      ${when(
        options.selectable,
        () =>
          html`<td class="k-table__check">
            <label class="k-check">
              <input type="checkbox" data-do="k-row" value="${key}" aria-label="${`Seleccionar ${rowLabel(row)}`}" ${attrs({ checked: isSelected })} />
            </label>
          </td>`,
      )}
      ${list.map((column, index) => {
        const content = column.cell(row);
        const main = index === 0;
        return html`<td class="${[column.numeric && 'k-num', column.wrap && 'k-wrap', main && 'k-table__main']}" ${attrs({ 'data-label': main ? null : column.label })}>
          ${main && onOpen ? html`<button type="button" class="k-link" data-do="k-open" data-id="${key}">${content}</button>` : content}
        </td>`;
      })}
    </tr>`;
  }

  function chooser(list) {
    if (options.chooser === false || columns.filter(column => !column.fixed).length < 2) return null;
    const full = list.length >= maxColumns;
    return html`<details class="k-menu" data-key="k-columnas" data-do="k-menu">
      <summary class="k-btn">${glyph('columns')} Columnas</summary>
      <div class="k-menu__list" role="group" aria-label="Columnas visibles">
        ${columns.map(column => {
          const on = visible.includes(column.id);
          return html`<label class="k-check">
            <input type="checkbox" data-do="k-col" value="${column.id}" ${attrs({ checked: on, disabled: column.fixed === true || (full && !on) })} />
            <span>${column.label}</span>
          </label>`;
        })}
      </div>
    </details>`;
  }

  function draw() {
    if (!alive) return;
    const list = shown();
    const all = rows.length > 0 && rows.every(row => selected.has(keyOf(row)));
    const some = !all && rows.some(row => selected.has(keyOf(row)));
    const keys = [...selected];
    const summary =
      phase === 'loading' || phase === 'error'
        ? ''
        : `${rows.length} ${rows.length === 1 ? 'fila' : 'filas'}${next !== null ? ' · hay más' : ''}${keys.length ? ` · ${keys.length} ${keys.length === 1 ? 'seleccionada' : 'seleccionadas'}` : ''}`;
    const selectAll = text =>
      html`<label class="${['k-check', text && 'k-table__all']}">
        <input type="checkbox" data-do="k-all" aria-label="Seleccionar todas las filas cargadas" data-indeterminate="${some}" ${attrs({ checked: all })} />
        ${when(text, () => html`<span>${text}</span>`)}
      </label>`;

    render(
      root,
      html`<div class="k-table">
        <div class="k-table__bar">
          <p class="k-table__count" role="status">${summary}</p>
          ${when(options.selectable && options.cards && rows.length, () => selectAll('Seleccionar todas'))}
          ${when(keys.length, () => html`${when(actions, () => actions(keys))}<button type="button" class="k-btn k-btn--ghost" data-do="k-unselect">Quitar selección</button>`)}
          ${chooser(list)}
        </div>
        ${when(phase === 'loading', () => loading(`Cargando ${label.toLowerCase()}…`))}
        ${when(phase === 'error', () => failure({ title: `No se pudo cargar ${label.toLowerCase()}`, error, retry: 'k-retry' }))}
        ${when(phase === 'ready' && !rows.length, () => emptyState(emptyOptions))}
        ${when(
          rows.length,
          () =>
            html`<div class="k-table__scroll" role="region" aria-label="${label}" tabindex="0" aria-busy="${phase === 'reloading'}" data-key="k-rejilla">
              <table class="${['k-table__grid', options.cards && 'k-table__grid--cards']}">
                <caption class="k-sr">
                  ${label}
                </caption>
                <thead>
                  <tr>
                    ${when(options.selectable, () => html`<th scope="col" class="k-table__check">${selectAll('')}</th>`)}
                    ${list.map(
                      column =>
                        html`<th scope="col" class="${column.numeric && 'k-num'}" ${attrs({ 'aria-sort': sort?.by === column.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null })}>
                          ${sortHeader(column)}
                        </th>`,
                    )}
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(row => rowMarkup(row, list))}
                </tbody>
              </table>
            </div>`,
        )}
        ${when(more === 'error', () => failure({ title: 'No se pudieron cargar más filas', error, retry: 'k-retry' }))}
        ${when(
          rows.length && next !== null && more !== 'error',
          () =>
            html`<div class="k-table__foot">
              <button type="button" class="k-btn" data-do="k-more" aria-disabled="${more === 'loading'}">${more === 'loading' ? 'Cargando…' : 'Cargar más'}</button>
            </div>`,
        )}
      </div>`,
    );
  }

  /** Pide una página. Devuelve null si mientras tanto se pidió otra o se desmontó la tabla. */
  async function fetchPage(cursor) {
    const mine = ++serial;
    controller?.abort();
    controller = new AbortController();
    try {
      const page = await load({ cursor, sort, limit, signal: controller.signal });
      if (mine !== serial || !alive) return null;
      if (page.rows.length > PAGE_LIMIT)
        console.warn(
          `pagedTable: «${label}» recibió ${page.rows.length} filas; el tope por petición es ${PAGE_LIMIT}.`,
        );
      return page;
    } catch (failed) {
      if (mine !== serial || !alive || isAbort(failed)) return null;
      throw failed;
    }
  }

  function selectionChanged() {
    onSelect?.([...selected]);
    draw();
  }

  /** Vuelve a pedir la primera página (cambió un filtro, la búsqueda o el orden). */
  async function reload() {
    phase = rows.length ? 'reloading' : 'loading';
    more = 'idle';
    error = null;
    draw();
    try {
      const page = await fetchPage(null);
      if (!page) return;
      rows = page.rows;
      next = page.next ?? null;
      phase = 'ready';
      // Lo seleccionado que ya no está a la vista deja de estarlo: nada se aplica a filas que no se ven.
      const present = new Set(rows.map(keyOf));
      const kept = new Set([...selected].filter(key => present.has(key)));
      if (kept.size !== selected.size) {
        selected = kept;
        onSelect?.([...selected]);
      }
    } catch (failed) {
      error = failed;
      phase = 'error';
      rows = [];
      next = null;
    }
    draw();
  }

  async function loadMore() {
    // Mientras se recarga la primera página no se pide la siguiente: el cursor ya no vale.
    if (more === 'loading' || next === null || phase !== 'ready') return;
    more = 'loading';
    draw();
    try {
      const page = await fetchPage(next);
      if (!page) return;
      // Si entre dos páginas entró una fila nueva, el cursor puede repetir alguna: no se duplica.
      const present = new Set(rows.map(keyOf));
      rows = rows.concat(page.rows.filter(row => !present.has(keyOf(row))));
      next = page.next ?? null;
      more = 'idle';
    } catch (failed) {
      error = failed;
      more = 'error';
    }
    draw();
  }

  // El menú de columnas se cierra al pulsar fuera; el oyente sólo existe mientras está abierto.
  let closeMenu = null;
  function watchMenu(details) {
    closeMenu?.();
    closeMenu = null;
    if (!details.open) return;
    const page = details.ownerDocument;
    const onPointer = event => {
      if (!details.contains(event.target)) details.open = false;
    };
    page.addEventListener('pointerdown', onPointer, true);
    closeMenu = () => page.removeEventListener('pointerdown', onPointer, true);
  }
  const escapeMenu = event => {
    if (event.key !== 'Escape') return;
    const details = event.target.closest('details');
    if (!details?.open) return;
    event.preventDefault();
    details.open = false;
    details.querySelector('summary').focus();
  };

  const off = listen(
    root,
    {
      click: {
        'k-sort': (_event, button) => {
          const column = columns.find(item => item.id === button.getAttribute('data-id'));
          sort = nextSort(sort, column.id, column.sortable === 'desc' ? 'desc' : 'asc');
          onSort?.(sort);
          reload();
        },
        'k-more': loadMore,
        'k-retry': () => (phase === 'error' ? reload() : loadMore()),
        'k-open': (_event, button) => {
          const row = rows.find(item => keyOf(item) === button.getAttribute('data-id'));
          if (row) onOpen(row, button);
        },
        'k-unselect': () => {
          selected = new Set();
          selectionChanged();
        },
      },
      change: {
        'k-all': (_event, box) => {
          selected = box.checked ? new Set(rows.map(keyOf)) : new Set();
          selectionChanged();
        },
        'k-row': (_event, box) => {
          selected = new Set(selected);
          if (box.checked) selected.add(box.value);
          else selected.delete(box.value);
          selectionChanged();
        },
        'k-col': (_event, box) => {
          visible = toggleColumn(columns, visible, box.value, box.checked, maxColumns);
          onColumns?.([...visible]);
          draw();
        },
      },
      keydown: { 'k-menu': escapeMenu, 'k-col': escapeMenu },
      toggle: { 'k-menu': (_event, details) => watchMenu(details) },
    },
    { contain: false },
  );

  reload();

  return {
    reload,
    /** Las filas cargadas hasta ahora. */
    rows: () => rows,
    /** Las claves seleccionadas. */
    selection: () => [...selected],
    clearSelection() {
      if (!selected.size) return;
      selected = new Set();
      selectionChanged();
    },
    /** Columnas visibles, en orden. */
    columns: () => [...visible],
    /**
     * Pone al día una fila (o la añade arriba) sin volver a pedir la lista: es lo que hace `onEvent` de la
     * pantalla cuando llega un cambio en vivo.
     */
    upsert(row) {
      const key = keyOf(row);
      const at = rows.findIndex(item => keyOf(item) === key);
      rows = at === -1 ? [row, ...rows] : rows.map((item, index) => (index === at ? row : item));
      if (phase === 'ready' || phase === 'reloading') draw();
    },
    /** Quita una fila que dejó de pertenecer a la lista. */
    remove(key) {
      const text = String(key);
      const before = rows.length;
      rows = rows.filter(item => keyOf(item) !== text);
      if (rows.length === before) return;
      if (selected.delete(text)) onSelect?.([...selected]);
      draw();
    },
    /** Cancela lo que esté en vuelo y quita los oyentes. No toca el DOM: la raíz puede no existir ya. */
    destroy() {
      alive = false;
      controller?.abort();
      closeMenu?.();
      off();
    },
  };
}
