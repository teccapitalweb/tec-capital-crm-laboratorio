// «Así lo ve la persona» (vista Pasos): un teléfono con la conversación hasta el paso elegido, armada en el navegador
// con lo mismo que usa la prueba local (sim.js → previewTo). No llama al servidor ni envía nada: se vuelve a pintar
// con cada cambio del recorrido y de la selección. Lo que no se puede mostrar fielmente (el catálogo, que se arma al
// enviar con los datos vigentes del curso, y los pasos que no escriben) se dice en texto plano.

import { nodeName } from '../../../kit/shared/flow-model.js';
import { html, render } from '../../../kit/html.js';
import { icon } from './icons.js';
import { previewTo, simulationEnv } from './sim.js';

const bubble = e => {
  if (e.who === 'note')
    return html`<p class="lz-ph-note" data-current="${e.current ? 'true' : 'false'}">${icon('spark')}<span>${e.text}</span></p>`;
  if (e.who === 'in')
    return html`<div class="lz-ph-bubble" data-who="in"><span class="lz-sr">La persona: </span>${e.text}</div>`;
  return html`<div class="lz-ph-bubble" data-who="out" data-current="${e.current ? 'true' : 'false'}">
    <span class="lz-sr">${e.current ? 'El paso elegido: ' : 'El recorrido: '}</span>
    ${e.label ? html`<span class="lz-ph-tag">${e.label}</span>` : ''}
    ${e.flyer ? html`<span class="lz-ph-media">${icon('image')} Ficha vigente del curso</span>` : ''}
    ${e.media ? html`<span class="lz-ph-media">${icon('file')} ${e.media}</span>` : ''}
    ${e.header ? html`<strong class="lz-ph-head">${e.header}</strong>` : ''}
    ${e.text ? html`<span class="lz-ph-text">${e.text}</span>` : ''}
    ${e.footer ? html`<span class="lz-ph-foot">${e.footer}</span>` : ''}
    ${e.note ? html`<span class="lz-ph-foot">${e.note}</span>` : ''}
    ${e.listButton ? html`<span class="lz-ph-opt">${icon('list')} ${e.listButton}</span>` : ''}
    ${e.listButton && e.options?.length ? html`<span class="lz-ph-rows" aria-label="Filas de la lista">${e.options.map(o => html`<span class="lz-ph-row">${o || '(fila sin texto)'}</span>`)}</span>` : ''}
    ${!e.listButton && e.options?.length ? html`<span class="lz-ph-opts">${e.options.map(o => html`<span class="lz-ph-opt">${o || '(botón sin texto)'}</span>`)}</span>` : ''}
  </div>`;
};

// `options.catalogue()` y `options.settings()` dan las listas de la marca y los ajustes del recorrido; `onClose()` la
// cierra en pantalla angosta, donde la vista previa es una hoja aparte.
export function createPreview(container, store, options) {
  let active = false;

  function draw() {
    const env = simulationEnv({
      graph: store.graph,
      settings: options.settings(),
      catalogue: options.catalogue(),
    });
    const picked = store.selection.nodes.length === 1 ? store.node(store.selection.nodes[0]) : null;
    const target = picked && picked.type !== 'note' && picked.type !== 'start' ? picked : null;
    const { entries, reached } = previewTo(env, target ? target.id : null);
    const index = target ? store.order().indexOf(target.id) + 1 : 0;
    render(
      container,
      html`<div class="lz-preview-head">
          <h2 class="lz-preview-title">Así lo ve la persona</h2>
          <button type="button" class="lz-icon-btn lz-narrow-only" data-do="vista-cerrar" aria-label="Volver al paso">${icon('close')}</button>
        </div>
        <p class="lz-hint">${target ? `Hasta el paso ${index}, «${nodeName(target, store.context)}».` : 'El camino principal, del Inicio al final.'}</p>
        ${
          target && !reached
            ? html`<p class="lz-preview-warn" role="status">${icon('warn')}<span>Ningún camino llega a este paso: así se vería, pero nadie lo recibirá hasta que lo conectes.</span></p>`
            : ''
        }
        <div class="lz-phone">
          <div class="lz-phone-screen" role="log" aria-label="Vista previa de la conversación" tabindex="0">
            ${entries.length ? entries.map(bubble) : html`<p class="lz-ph-note">${icon('spark')}<span>Todavía no hay mensajes: agrega un paso que le escriba a la persona.</span></p>`}
          </div>
        </div>
        <p class="lz-hint">Vista previa con lo que hay en pantalla, aunque no esté guardado; los datos del curso se ponen al enviar. «Probar» la recorre con el servidor.</p>`,
    );
    // Lo elegido queda a la vista dentro del teléfono.
    const screen = container.querySelector('.lz-phone-screen');
    const first = screen.querySelector('[data-current="true"]');
    if (first) screen.scrollTop = Math.max(0, first.offsetTop - screen.offsetTop - 12);
    else screen.scrollTop = screen.scrollHeight;
  }

  return {
    handlers: { click: { 'vista-cerrar': () => options.onClose() } },
    open() {
      active = true;
      draw();
    },
    close() {
      active = false;
    },
    update(change) {
      if (active && (change.graph || change.selection || change.context || change.reset)) draw();
    },
    destroy() {
      container.replaceChildren();
    },
  };
}
