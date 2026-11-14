/**
 * Identificadores para el DOM de las pantallas nuevas.
 *
 * Por qué existe: en el código actual varios módulos reclaman los formularios por prefijo de id (pay-,
 * co-, ct-…), y un id con el prefijo equivocado acaba en el módulo que no es. Las pantallas nuevas no
 * usan el id para repartir eventos (eso es data-do); el id sólo une una etiqueta con su campo o un texto
 * de ayuda con aria-describedby. El prefijo «k-» no lo reclama ningún módulo.
 */

const clean = text =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Fábrica de ids de una pantalla: ids('difusiones')('nombre') → 'k-difusiones-nombre'.
 * Es lo que la pantalla recibe como `ctx.uid`.
 */
export const ids = screen => name => `k-${clean(screen)}-${clean(name)}`;

let counter = 0;

/**
 * Un id único para un componente que no tiene nombre propio (un diálogo, un grupo de pestañas).
 * Se pide una vez al crear el componente y se guarda: no cambia entre repintados.
 */
export const nextId = (kind = 'id') => `k-${clean(kind)}-${++counter}`;
