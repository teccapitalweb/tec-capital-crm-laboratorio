/**
 * Pantalla «Automatización», en vista previa: el editor de recorridos (lienzo y esquema) con datos de ejemplo.
 *
 * Todavía no existe la API de recorridos, así que aquí no se pide ni se guarda nada: el recorrido sale de la
 * plantilla «Venta de curso» de la biblioteca y las listas de la marca (cursos, materiales, etiquetas…) de
 * lienzo/demo-data.js. Por eso la pantalla lo dice a la vista («Datos de ejemplo») y no ofrece «Guardar».
 * Cuando exista la API: el grafo y las listas llegarán por ctx.api, `onSave` enviará el borrador con su
 * expectedRevision y este archivo dejará de importar demo-data.js.
 *
 * Lo que sobrevive a un remontaje (cambiar de vista y volver) es el estado del editor entero: el grafo con sus
 * cambios, el historial de deshacer y la selección. Vive en ctx.keep, nunca en variables de este módulo.
 */
import { html, render } from '../../kit/html.js';
import { instantiateTemplate } from '../../kit/shared/flow-templates.js';
import { DEMO_CATALOGUE, DEMO_STATS } from './lienzo/demo-data.js';
import { mountCanvas } from './lienzo/index.js';
import { createStore } from './lienzo/store.js';

const TEMPLATE = 'venta_de_curso';

// Los marcadores de la plantilla se resuelven contra los datos de ejemplo, como lo hará el servidor con los de la marca.
const exampleFlow = () =>
  instantiateTemplate(TEMPLATE, link => {
    const found = (DEMO_CATALOGUE[link.source] || []).find(item => item.name === link.name);
    return found ? found.id : '';
  });

export default {
  mount(root, ctx) {
    const flow = exampleFlow();
    render(
      root,
      html`<section class="k-page au-page">
        <header class="k-head au-head">
          <div>
            <span class="k-eyebrow">Recorrido</span>
            <h1>${flow.name}</h1>
          </div>
          <span class="k-chip k-chip--warn">Datos de ejemplo</span>
        </header>
        <p class="k-lead au-lead">
          Vista previa del editor de recorridos. Los cursos, precios y cifras son inventados; aquí no se guarda ni se envía
          nada.
        </p>
        <div class="au-editor" data-slot="editor"></div>
      </section>`,
    );

    let store = ctx.keep.get('store');
    if (!store) {
      store = createStore({ graph: flow.graph });
      ctx.keep.set('store', store);
    }
    const canvas = mountCanvas(root.querySelector('[data-slot="editor"]'), {
      store,
      settings: flow.settings,
      catalogue: DEMO_CATALOGUE,
      stats: DEMO_STATS,
      uid: ctx.uid,
    });
    ctx.onUnmount(canvas.destroy);
  },

  // Sin API de recorridos no hay nada que poner al día con un evento en vivo.
  onEvent() {},
};
