// Página de demostración del lienzo: lo monta con la plantilla «Venta de curso» y datos inventados, para revisarlo en
// un navegador sin servidor de la aplicación ni base de datos. No se publica en el menú: es una herramienta de revisión.
//
// La dirección admite parámetros para ver los demás casos:
//   ?recorrido=inscripcion | bienvenida_con_menu | venta_de_curso (por omisión)
//   ?lectura=1        monta el lienzo en sólo lectura
//   ?cifras=0         sin cifras de rendimiento

import { instantiateTemplate, templateByKey } from '../../../kit/shared/flow-templates.js';
import { DEMO_CATALOGUE, DEMO_STATS } from './demo-data.js';
import { mountCanvas } from './index.js';

const params = new URLSearchParams(window.location.search);
const key = templateByKey(params.get('recorrido')) ? params.get('recorrido') : 'venta_de_curso';

// Los marcadores de la plantilla se resuelven contra los datos de ejemplo, como lo haría el servidor con los de la marca.
const flow = instantiateTemplate(key, link => {
  const list = DEMO_CATALOGUE[link.source] || [];
  const found = list.find(item => item.name === link.name);
  return found ? found.id : '';
});

const status = document.querySelector('[data-demo="estado"]');
document.querySelector('[data-demo="titulo"]').textContent = flow.name;

const canvas = mountCanvas(document.querySelector('[data-demo="lienzo"]'), {
  graph: flow.graph,
  settings: flow.settings,
  catalogue: DEMO_CATALOGUE,
  readOnly: params.get('lectura') === '1',
  stats: key === 'venta_de_curso' && params.get('cifras') !== '0' ? DEMO_STATS : null,
  onChange(graph, info) {
    status.textContent = `${graph.nodes.length} pasos · ${info.errors} errores · ${info.warnings} avisos${info.dirty ? ' · sin guardar' : ''}`;
  },
  // Aquí «guardar» sólo espera un momento: la pantalla real envía el borrador al servidor.
  onSave: graph =>
    new Promise(resolve => {
      window.setTimeout(() => {
        status.textContent = `Guardado de ejemplo: ${graph.nodes.length} pasos`;
        resolve();
      }, 400);
    }),
});

status.textContent = `${canvas.getGraph().nodes.length} pasos`;
