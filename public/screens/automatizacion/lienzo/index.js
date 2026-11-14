// Lienzo de recorridos: punto de entrada.
//
//   const lienzo = mountCanvas(raíz, {graph, catalogue, settings, onChange, onSave, readOnly, stats});
//   lienzo.getGraph()   copia del grafo actual, en su forma canónica
//   lienzo.setStats(s)  cifras por paso para la capa «Rendimiento»: {nodes: {<id>: {entered, completed, dropped, left?, ports?}}}
//   lienzo.destroy()    quita todo lo que montó
//
// `catalogue` son las listas de la marca y los datos de ejemplo para probar: {brand, contact, courses, materials,
// files, tags, waTemplates, flows, users, attributes}; lo que no llegue, el lienzo no lo valida ni lo ofrece.
// `onChange(grafo, {dirty, errors, warnings})` se llama en cada edición con el grafo congelado (no se debe alterar).
// `onSave(grafo)` puede devolver una promesa; al cumplirse, el lienzo da el grafo por guardado.
//
// Es una isla: no usa nada de la aplicación salvo las variables de color de Niebla, no deja oyentes en `document` ni
// globales en `window`, y todos sus eventos se quedan dentro de su raíz. La pantalla que lo aloja se desmonta y se
// vuelve a montar a menudo: para no perder el historial ni lo que no se ha guardado, guarda `lienzo.store` (por ejemplo
// en `ctx.keep`) y vuelve a pasarlo en `store` al montar de nuevo.

import { GEOMETRY, PALETTE, nodeName, portsOf, typeOf } from '../../../kit/shared/flow-model.js';
import { html, ids, listen, on, render } from './dom.js';
import { icon } from './icons.js';
import { attachInteractions } from './interact.js';
import { createMinimap } from './minimap.js';
import { createOutline } from './outline.js';
import { createPanel } from './panel.js';
import { createSimulator } from './sim.js';
import { createStore } from './store.js';
import { createView } from './view.js';

// Por debajo de este ancho (el del contenedor, no el de la ventana) el editor pasa a una columna y abre en el esquema.
const NARROW = 850;
const clone = value => JSON.parse(JSON.stringify(value));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const closest = (target, selector) =>
  target && typeof target.closest === 'function' ? target.closest(selector) : null;

// La hoja de estilos vive junto al módulo. Si la pantalla anfitriona ya la cargó (por su screen.json), no se repite.
function ensureStyles(doc) {
  const href = new URL('./lienzo.css', import.meta.url).href;
  if ([...doc.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === href)) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  doc.head.append(link);
}

const shell = hasSave => html`<div class="lz-bar" role="toolbar" aria-label="Herramientas del recorrido">
    <div class="lz-seg" role="group" aria-label="Cómo ver el recorrido">
      <button type="button" class="lz-tool" data-k="ver" data-pane="outline" aria-pressed="false">${icon('list')}<span>Esquema</span></button>
      <button type="button" class="lz-tool" data-k="ver" data-pane="canvas" aria-pressed="true">${icon('canvas')}<span>Lienzo</span></button>
    </div>
    <button type="button" class="lz-tool lz-narrow-only" data-k="paleta" aria-expanded="false" aria-label="Agregar paso">${icon('plus')}<span>Agregar</span></button>
    <span class="lz-sep" aria-hidden="true"></span>
    <button type="button" class="lz-tool lz-tool-icon" data-k="deshacer" aria-label="Deshacer" title="Deshacer (Ctrl+Z)">${icon('undo')}</button>
    <button type="button" class="lz-tool lz-tool-icon" data-k="rehacer" aria-label="Rehacer" title="Rehacer (Ctrl+Mayús+Z)">${icon('redo')}</button>
    <button type="button" class="lz-tool" data-k="acomodar" title="Acomoda los pasos por capas desde el Inicio">${icon('tidy')}<span>Acomodar</span></button>
    <div class="lz-zoom lz-canvas-only" role="group" aria-label="Acercamiento">
      <span class="lz-sep" aria-hidden="true"></span>
      <button type="button" class="lz-tool lz-tool-icon" data-k="alejar" aria-label="Alejar" title="Alejar (−)">${icon('minus')}</button>
      <output class="lz-zoom-n" data-slot="zoom" aria-label="Acercamiento">100 %</output>
      <button type="button" class="lz-tool lz-tool-icon" data-k="acercar" aria-label="Acercar" title="Acercar (+)">${icon('plus')}</button>
      <button type="button" class="lz-tool" data-k="ajustar" title="Ajustar a la vista (0)">${icon('fit')}<span>Ajustar</span></button>
    </div>
    <span class="lz-grow"></span>
    <button type="button" class="lz-tool lz-chip" data-k="problemas" data-slot="problemas" data-level=""></button>
    <button type="button" class="lz-tool" data-k="rendimiento" aria-pressed="false" title="Cifras por paso: cuántas personas entraron, completaron y se quedaron">${icon('chart')}<span>Rendimiento</span></button>
    <button type="button" class="lz-tool" data-k="probar" aria-pressed="false" title="Probar el recorrido sin enviar nada">${icon('test')}<span>Probar</span></button>
    <span class="lz-state" data-slot="estado" role="status"></span>
    ${hasSave ? html`<button type="button" class="lz-tool lz-primary" data-k="guardar">${icon('save')}<span>Guardar</span></button>` : ''}
  </div>
  <div class="lz-body">
    <nav class="lz-palette" data-slot="paleta" aria-label="Pasos que se pueden agregar">
      <div class="lz-palette-head">
        <h2 class="lz-palette-title">Agregar paso</h2>
        <button type="button" class="lz-icon-btn lz-narrow-only" data-k="paleta" aria-label="Cerrar la lista de pasos">${icon('close')}</button>
      </div>
      <p class="lz-hint lz-wide-only">Clic: lo agrega después del paso seleccionado. También se puede arrastrar al lienzo.</p>
      ${PALETTE.map(
        group => html`<section class="lz-palette-group" data-group="${group.id}">
          <h3>${group.label}</h3>
          <ul>
            ${group.types.map(type => {
              const def = typeOf(type);
              return html`<li>
                <button type="button" class="lz-pal" data-k="paleta-tipo" data-type="${type}" title="${def.hint}">
                  <span class="lz-pill">${icon(def.icon)}</span><span>${def.label}</span>
                </button>
              </li>`;
            })}
          </ul>
        </section>`,
      )}
    </nav>
    <div class="lz-stage">
      <div class="lz-canvas" data-slot="lienzo" tabindex="0" role="group" aria-label="Lienzo del recorrido. El tabulador recorre los pasos; las flechas mueven la vista."></div>
      <div class="lz-minimap" data-slot="minimapa"></div>
      <p class="lz-tip lz-wide-only" aria-hidden="true">Arrastra el fondo para moverte · Ctrl + rueda para acercar · Mayús + arrastrar para marcar varios</p>
      <div class="lz-outline" data-slot="esquema" hidden></div>
    </div>
    <aside class="lz-side" data-slot="lado" aria-label="Detalle del paso o del recorrido">
      <div class="lz-side-pane" data-slot="panel" tabindex="-1"></div>
      <div class="lz-side-pane" data-slot="prueba" tabindex="-1" hidden></div>
    </aside>
  </div>
  <div class="lz-ghost" data-slot="fantasma" hidden></div>
  <p class="lz-flash" data-slot="aviso" role="status" hidden></p>
  <p class="lz-sr" data-slot="voz" aria-live="polite"></p>`;

export function mountCanvas(root, options = {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  ensureStyles(doc);
  const uid = ids();
  const pinned = Boolean(options.readOnly);
  let catalogue = options.catalogue || {};
  let settings = options.settings || {};
  const context = () => ({ ...catalogue, settings });

  const store = options.store || createStore({ graph: options.graph, readOnly: pinned, context: context() });
  if (options.store) store.setContext(context());
  if (options.stats) store.setOverlay({ stats: options.stats });

  // Lo que es de la interfaz y no del recorrido: qué vista se ve, qué hoja está abierta en celular, cómo va el guardado.
  const ui = {
    pane: 'canvas',
    picked: false,
    narrow: false,
    side: 'edit',
    sheet: '',
    saving: 'idle',
    fitted: false,
    skipClick: false,
    flashTimer: 0,
    voiceTimer: 0,
  };

  root.classList.add('lz');
  render(root, shell(typeof options.onSave === 'function'));
  const slot = name => root.querySelector(`[data-slot="${name}"]`);
  const canvas = slot('lienzo');
  const outlineEl = slot('esquema');
  const paletteEl = slot('paleta');
  const panelEl = slot('panel');
  const simEl = slot('prueba');
  const ghost = slot('fantasma');
  const flashEl = slot('aviso');
  const voice = slot('voz');
  const tool = name => root.querySelector(`.lz-bar [data-k="${name}"]`);

  // ---- Avisos -----------------------------------------------------------------------------------------------------------

  // Para lector de pantalla: se vacía y se vuelve a escribir, porque repetir el mismo texto no se anunciaría.
  function announce(text) {
    voice.textContent = '';
    win.clearTimeout(ui.voiceTimer);
    ui.voiceTimer = win.setTimeout(() => {
      voice.textContent = text;
    }, 40);
  }

  // A la vista de todos: por qué no se pudo hacer algo.
  function flash(text) {
    flashEl.textContent = text;
    flashEl.hidden = false;
    win.clearTimeout(ui.flashTimer);
    ui.flashTimer = win.setTimeout(() => {
      flashEl.hidden = true;
    }, 6000);
  }

  // Resultado de una petición al store: si se rechazó, se dice por qué; si cambió algo, se anuncia.
  function report(result, done) {
    if (!result) return;
    if (result.ok === false) flash(result.message);
    else if (done && result.changed !== false) announce(done);
  }

  // ---- Piezas -----------------------------------------------------------------------------------------------------------

  const view = createView(canvas, store);
  const minimap = createMinimap(slot('minimapa'), store, view);

  function setSheet(name) {
    ui.sheet = name;
    root.dataset.sheet = name;
    tool('paleta').setAttribute('aria-expanded', name === 'paleta' ? 'true' : 'false');
  }

  function setSide(side) {
    if (ui.side === side) return;
    ui.side = side;
    panelEl.hidden = side !== 'edit';
    simEl.hidden = side !== 'sim';
    if (side === 'sim') sim.open();
    else sim.close();
    syncBar();
  }

  // Abre los ajustes de un paso: en pantalla angosta el panel es una hoja que cubre la vista.
  function openPanel() {
    setSide('edit');
    if (ui.narrow) setSheet('panel');
  }

  function goTo(id) {
    if (!store.node(id)) return;
    store.select(id);
    if (ui.narrow) setSheet('');
    if (ui.pane === 'canvas') view.focusNode(id);
    else outline.focusRow(id);
  }

  // Lo que hace una lista «a dónde lleva esta salida» (del panel o del esquema): conectar, desconectar o crear un paso ahí.
  function onConnect(id, port, value) {
    if (!value) return report(store.disconnect(id, port), 'La salida quedó sin conectar.');
    if (!value.startsWith('new:')) return report(store.connect(id, port, value), 'Pasos conectados.');
    const from = store.node(id);
    const row = Math.max(
      0,
      portsOf(from).findIndex(p => p.id === port),
    );
    const added = store.addNode(value.slice(4), {
      x: from.x + GEOMETRY.width + GEOMETRY.gapX,
      y: from.y + row * GEOMETRY.port,
      connect: { from: id, port },
    });
    report(added, 'Paso agregado y conectado.');
    if (added.ok) afterAdd(added.id);
    return undefined;
  }

  // Un paso recién agregado queda a la vista; en el esquema, además, con el foco para seguir desde ahí.
  function afterAdd(id) {
    if (ui.pane === 'canvas') store.reveal(id, view.size());
    else if (!ui.narrow) outline.focusRow(id);
    if (ui.narrow) openPanel();
  }

  const panel = createPanel(panelEl, store, {
    uid,
    catalogue: () => catalogue,
    onConnect,
    onGo: goTo,
    onClose: () => setSheet(''),
    report,
  });

  const outline = createOutline(outlineEl, store, {
    onOpen: () => openPanel(),
    onConnect,
  });

  const sim = createSimulator(simEl, store, {
    uid,
    catalogue: () => catalogue,
    settings: () => settings,
    onClose: () => {
      setSide('edit');
      setSheet('');
    },
    // El paso en el que va la prueba queda a la vista en el lienzo.
    onStep: id => {
      if (id && ui.pane === 'canvas' && !ui.narrow) store.reveal(id, view.size());
    },
  });

  const detach = attachInteractions({
    canvas,
    view,
    store,
    actions: {
      report,
      announce,
      edit() {
        openPanel();
        panel.focusFirst();
      },
      connect() {
        openPanel();
        panel.focusPorts();
      },
      // En pantalla angosta, tocar un paso ya seleccionado abre sus ajustes (el primer toque sólo lo selecciona).
      tapped(id, wasSelected) {
        if (ui.narrow && wasSelected) openPanel();
      },
    },
  });

  // ---- Barra ------------------------------------------------------------------------------------------------------------

  function setPane(pane, picked = true) {
    ui.pane = pane;
    if (picked) ui.picked = true;
    root.dataset.pane = pane;
    canvas.hidden = pane !== 'canvas';
    slot('minimapa').hidden = pane !== 'canvas';
    outlineEl.hidden = pane !== 'outline';
    for (const button of root.querySelectorAll('.lz-bar [data-k="ver"]'))
      button.setAttribute('aria-pressed', button.dataset.pane === pane ? 'true' : 'false');
    if (pane === 'outline') outline.refresh();
    else fitOnce();
  }

  // La primera vez que el lienzo tiene tamaño, el recorrido se ajusta a la vista.
  function fitOnce() {
    const size = view.size();
    if (ui.fitted || !size.width || !size.height) return;
    ui.fitted = true;
    store.fit(size);
  }

  const disable = (name, off) => {
    const button = tool(name);
    // `aria-disabled` y no `disabled`: un botón que se desactiva teniendo el foco lo perdería (pasa al deshacer lo último).
    if (button) button.setAttribute('aria-disabled', off ? 'true' : 'false');
  };
  const off = name => tool(name).getAttribute('aria-disabled') === 'true';

  function syncBar() {
    const issues = store.issues();
    const errors = issues.errors.length;
    const warnings = issues.warnings.length;
    disable('deshacer', !store.canUndo() || store.readOnly);
    disable('rehacer', !store.canRedo() || store.readOnly);
    disable('acomodar', store.readOnly);
    disable('rendimiento', !store.overlay.stats);
    tool('deshacer').title = store.canUndo() ? `Deshacer: ${store.undoLabel()} (Ctrl+Z)` : 'Deshacer (Ctrl+Z)';
    tool('rehacer').title = store.canRedo() ? `Rehacer: ${store.redoLabel()} (Ctrl+Mayús+Z)` : 'Rehacer (Ctrl+Mayús+Z)';
    tool('rendimiento').setAttribute('aria-pressed', store.overlay.showStats ? 'true' : 'false');
    tool('probar').setAttribute('aria-pressed', ui.side === 'sim' ? 'true' : 'false');
    slot('zoom').textContent = `${Math.round(store.viewport.zoom * 100)} %`;
    const chip = slot('problemas');
    chip.dataset.level = errors ? 'error' : warnings ? 'warn' : 'ok';
    render(
      chip,
      errors
        ? html`${icon('error')}<span>${plural(errors, 'error', 'errores')}</span>`
        : warnings
          ? html`${icon('warn')}<span>${plural(warnings, 'aviso', 'avisos')}</span>`
          : html`${icon('check')}<span>Sin problemas</span>`,
    );
    const state = slot('estado');
    const text = store.overlay.showStats
      ? 'Sólo lectura'
      : pinned
        ? 'Sólo lectura'
        : ui.saving === 'saving'
          ? 'Guardando…'
          : ui.saving === 'error'
            ? 'No se guardó'
            : store.isDirty()
              ? 'Sin guardar'
              : ui.saving === 'saved'
                ? 'Guardado'
                : '';
    if (state.textContent !== text) state.textContent = text;
    state.dataset.level = ui.saving === 'error' ? 'error' : store.isDirty() && !pinned ? 'warn' : '';
    const saveButton = tool('guardar');
    if (saveButton)
      saveButton.setAttribute('aria-disabled', pinned || ui.saving === 'saving' || !store.isDirty() ? 'true' : 'false');
    root.dataset.readonly = store.readOnly ? 'true' : 'false';
  }

  function save() {
    if (typeof options.onSave !== 'function' || pinned || ui.saving === 'saving' || !store.isDirty()) return;
    const sent = store.graph;
    ui.saving = 'saving';
    syncBar();
    Promise.resolve()
      .then(() => options.onSave(clone(sent)))
      .then(
        () => {
          // Se marca como guardado lo que se envió: si mientras tanto hubo más cambios, siguen pendientes.
          store.markSaved(sent);
          ui.saving = 'saved';
          syncBar();
          announce('Recorrido guardado.');
        },
        error => {
          ui.saving = 'error';
          syncBar();
          flash(
            'No se pudo guardar el recorrido' +
              (error && error.message ? `: ${error.message}` : '. Inténtalo de nuevo.'),
          );
        },
      );
  }

  function undo(again) {
    const result = again ? store.redo() : store.undo();
    if (result.ok) announce(`${again ? 'Rehecho' : 'Deshecho'}: ${result.label}.`);
    else if (result.reason !== 'undo' && result.reason !== 'redo') flash(result.message);
  }

  const centre = () => {
    const size = view.size();
    return { x: size.width / 2, y: size.height / 2 };
  };

  // ---- Paleta -----------------------------------------------------------------------------------------------------------

  function addFromPalette(type) {
    if (ui.skipClick) return;
    const anchor = store.selection.nodes[store.selection.nodes.length - 1];
    const added = store.addNodeNear(type, { at: store.toWorld(centre()) });
    if (!added.ok) return report(added);
    const label = typeOf(type).label;
    announce(
      added.connected
        ? `Se agregó «${label}» después de «${nodeName(store.node(anchor), store.context)}», ya conectado.`
        : `Se agregó «${label}», sin conectar.`,
    );
    if (ui.narrow) setSheet('');
    return afterAdd(added.id);
  }

  // Arrastrar un tipo de paso de la paleta al lienzo: cae donde se suelta.
  let carry = null;
  const paletteDrag = [
    on(paletteEl, 'pointerdown', event => {
      const button = closest(event.target, '[data-k="paleta-tipo"]');
      if (!button || store.readOnly || (event.pointerType === 'mouse' && event.button !== 0)) return;
      carry = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        type: button.dataset.type,
        button,
        active: false,
      };
      // Capturado en el propio botón: su clic no cambia, y el arrastre sigue aunque el puntero salga de la paleta.
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Sin captura el arrastre termina al salir de la paleta: se puede seguir agregando con un clic.
      }
    }),
    on(paletteEl, 'pointermove', event => {
      if (!carry || carry.id !== event.pointerId) return;
      if (!carry.active) {
        if (Math.hypot(event.clientX - carry.x, event.clientY - carry.y) < 6) return;
        carry.active = true;
        ghost.textContent = typeOf(carry.type).label;
        ghost.hidden = false;
      }
      ghost.style.left = `${event.clientX}px`;
      ghost.style.top = `${event.clientY}px`;
    }),
    on(paletteEl, 'pointerup', event => {
      if (!carry || carry.id !== event.pointerId) return;
      const dropped = carry;
      carry = null;
      ghost.hidden = true;
      if (!dropped.active) return;
      // El clic que sigue a un arrastre no debe agregar otro paso.
      ui.skipClick = true;
      win.setTimeout(() => {
        ui.skipClick = false;
      }, 0);
      const rect = canvas.getBoundingClientRect();
      const inside =
        !canvas.hidden &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) return;
      const at = view.toWorld(event.clientX, event.clientY);
      const added = store.addNode(dropped.type, {
        x: at.x - GEOMETRY.width / 2,
        y: at.y - GEOMETRY.head / 2,
        exact: true,
      });
      report(added, `Se agregó «${typeOf(dropped.type).label}».`);
    }),
    on(paletteEl, 'pointercancel', () => {
      carry = null;
      ghost.hidden = true;
    }),
  ];

  // ---- Eventos ----------------------------------------------------------------------------------------------------------

  const own = {
    click: {
      ver: (event, el) => setPane(el.dataset.pane),
      paleta: () => setSheet(ui.sheet === 'paleta' ? '' : 'paleta'),
      'paleta-tipo': (event, el) => addFromPalette(el.dataset.type),
      deshacer: () => !off('deshacer') && undo(false),
      rehacer: () => !off('rehacer') && undo(true),
      acomodar() {
        if (off('acomodar')) return;
        const result = store.autoLayout();
        report(result, 'Recorrido acomodado.');
        if (result.ok) store.fit(view.size());
      },
      alejar: () => store.zoomBy(-1, centre()),
      acercar: () => store.zoomBy(1, centre()),
      ajustar: () => store.fit(view.size()),
      problemas() {
        store.clearSelection();
        openPanel();
        panelEl.focus({ preventScroll: true });
      },
      rendimiento() {
        if (off('rendimiento')) return flash('Todavía no hay cifras de este recorrido.');
        const show = !store.overlay.showStats;
        store.setOverlay({ showStats: show });
        // Con las cifras a la vista el lienzo es de sólo lectura: las cifras son de la versión publicada.
        store.setReadOnly(pinned || show);
        return announce(show ? 'Viendo el rendimiento por paso.' : 'Se ocultó el rendimiento.');
      },
      probar() {
        if (ui.side === 'sim') {
          setSide('edit');
          setSheet('');
        } else {
          setSide('sim');
          if (ui.narrow) setSheet('panel');
          simEl.focus({ preventScroll: true });
        }
      },
      guardar: () => save(),
      'nodo-borrar': (event, el) =>
        report(store.deleteNodes([closest(el, '.lz-node').dataset.node]), 'Paso eliminado.'),
      arista: (event, el) => store.selectEdge({ from: el.dataset.from, port: el.dataset.port }),
      'arista-quitar': () => report(store.deleteSelection(), 'Conexión quitada.'),
    },
  };

  const merged = {};
  for (const table of [own, panel.handlers, outline.handlers, sim.handlers]) {
    for (const [type, verbs] of Object.entries(table)) merged[type] = { ...merged[type], ...verbs };
  }
  const unlisten = listen(root, merged);

  // Atajos que valen en todo el editor. Dentro de un campo de texto, Ctrl+Z es del campo.
  const offKeys = on(root, 'keydown', event => {
    if (event.key === 'Escape' && ui.sheet) {
      setSheet('');
      event.preventDefault();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const letter = event.key.toLowerCase();
    if (letter === 's') {
      event.preventDefault();
      save();
    } else if ((letter === 'z' || letter === 'y') && !closest(event.target, 'input, textarea, select')) {
      event.preventDefault();
      undo(letter === 'y' || event.shiftKey);
    }
  });

  const unsubscribe = store.subscribe(change => {
    if (change.graph && ui.saving !== 'saving') ui.saving = 'idle';
    view.update(change);
    minimap.update(change);
    outline.update(change);
    panel.update(change);
    sim.update(change);
    // Al desplazar la vista llegan decenas de avisos por segundo: de la barra sólo cambia la cifra del acercamiento.
    if (change.viewport) slot('zoom').textContent = `${Math.round(store.viewport.zoom * 100)} %`;
    if (change.graph || change.history || change.mode || change.overlay || change.context) syncBar();
    if (change.graph && typeof options.onChange === 'function') {
      const issues = store.issues();
      options.onChange(store.graph, {
        dirty: store.isDirty(),
        errors: issues.errors.length,
        warnings: issues.warnings.length,
      });
    }
  });

  // El ancho que cuenta es el del contenedor: el lienzo puede vivir en una columna de una pantalla ancha.
  function measure() {
    const width = root.getBoundingClientRect().width;
    const narrow = width < NARROW;
    // Con menos de este ancho la barra completa ya no cabe en un renglón: algunos botones quedan sólo con su icono.
    root.dataset.bar = width < 1320 ? 'tight' : 'full';
    if (narrow !== ui.narrow || !root.dataset.layout) {
      ui.narrow = narrow;
      root.dataset.layout = narrow ? 'narrow' : 'wide';
      if (!narrow) setSheet('');
      // Hasta que la persona elija, en angosto se abre el esquema y en ancho el lienzo.
      if (!ui.picked) setPane(narrow ? 'outline' : 'canvas', false);
    }
    fitOnce();
    minimap.update({ resize: true });
  }
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(measure) : null;
  if (observer) {
    observer.observe(root);
    observer.observe(canvas);
  }

  setSheet('');
  setPane('canvas', false);
  measure();
  syncBar();

  return {
    getGraph: () => clone(store.graph),
    setStats(stats) {
      const next = stats || null;
      store.setOverlay({ stats: next, showStats: next ? store.overlay.showStats : false });
      if (!next) store.setReadOnly(pinned);
    },
    destroy() {
      unsubscribe();
      unlisten();
      offKeys();
      detach();
      for (const stop of paletteDrag) stop();
      if (observer) observer.disconnect();
      win.clearTimeout(ui.flashTimer);
      win.clearTimeout(ui.voiceTimer);
      sim.destroy();
      panel.destroy();
      outline.destroy();
      minimap.destroy();
      view.destroy();
      store.setOverlay({ simNode: null, simTrail: [] });
      root.replaceChildren();
      root.classList.remove('lz');
      for (const name of ['pane', 'layout', 'sheet', 'readonly', 'bar']) delete root.dataset[name];
    },
    // Lo que sigue no lo exige el contrato, pero la pantalla anfitriona lo necesita para guardar y para sobrevivir a
    // que la desmonten.
    store,
    isDirty: () => store.isDirty(),
    markSaved: () => store.markSaved(),
    getIssues() {
      const { errors, warnings } = store.issues();
      return { errors: clone(errors), warnings: clone(warnings) };
    },
    setGraph: graph => store.setGraph(graph),
    setCatalogue(next) {
      catalogue = next || {};
      store.setContext(context());
    },
    setSettings(next) {
      settings = next || {};
      store.setContext(context());
    },
    showPane: pane => setPane(pane === 'outline' ? 'outline' : 'canvas'),
    focusNode: goTo,
  };
}
