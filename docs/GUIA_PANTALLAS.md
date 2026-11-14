# Guía de pantallas nuevas

Cómo se hace una pantalla nueva del CRM. Las cuarenta pantallas actuales (`public/*.js`) siguen como están; lo nuevo son **módulos ES nativos**, sin compilar y sin dependencias, sobre un kit compartido (`public/kit/`) y una sola hoja de variables de diseño (`public/tokens.css`).

La plantilla para copiar es **`public/screens/ejemplo/`**: usa todas las piezas del kit con datos de mentira. Sólo se publica con `SCREENS_PREVIEW=1` (su `screen.json` dice `"visibility": "preview"`).

## Crear una pantalla en cinco pasos

1. **Copia la carpeta** `public/screens/ejemplo/` a `public/screens/<id>/`. El `id` va en minúsculas (`^[a-z][a-z0-9-]{2,30}$`) y no puede ser el de una vista actual (`inbox`, `contacts`, `team`, `settings`, `analytics`, `operations`…): la bandeja nueva es `bandeja`, los contactos `contactos`.
2. **Edita `screen.json`**: `id` (igual a la carpeta), `title`, `nav` (`group`, `icon` de Lucide, `label`, `order`; o sin `nav` si no va en el menú), `roles`, `entry`, `styles` y `visibility` (`preview` mientras se construye; `live` al publicar). No se toca `index.html`, `app.js` ni el servidor: el servidor publica la lista en `/screens/index.json`.
3. **Escribe `index.js`**: exporta por omisión `{ mount(root, ctx), onEvent(evento, ctx) }`. En `mount` pinta el esqueleto una vez con `render()` y la plantilla `html`, monta los componentes en sus ranuras (`data-slot`) y registra lo que hay que deshacer con `ctx.onUnmount(…)`. Cambia la API de mentira por `ctx.api` y borra `datos.js`.
4. **Estilos**: lo que el kit no traiga va en `screen.css`, con un prefijo propio (`ej-`, `dif-`…) y sólo con variables de `tokens.css`.
5. **Comprueba**: `node --test test/kit-*.test.mjs` (las reglas de esta guía se revisan solas), abre la pantalla con `SCREENS_PREVIEW=1` en computadora y a 375 px, y repasa la lista del final.

## El contrato de una pantalla

```js
import { html, render } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { pagedTable } from '../../kit/components/table.js';

export default {
  mount(root, ctx) {
    render(root, html`<section class="k-page">
      <header class="k-head"><h1>Difusiones</h1>
        <button type="button" class="k-btn k-btn--primary" data-do="nueva">Nueva difusión</button></header>
      <div class="k-card" data-slot="lista"></div>
    </section>`);
    const tabla = pagedTable(root.querySelector('[data-slot="lista"]'), { /* columnas, load… */ });
    ctx.onUnmount(tabla.destroy);
    ctx.onUnmount(listen(root, { click: { nueva: () => { /* … */ } } }));
  },
  onEvent(evento, ctx) { /* pedir o aplicar SÓLO lo que cambió */ },
};
```

`ctx` trae: `user`, `brand` (la marca elegida; el alcance real lo impone el servidor), `api` (se cancela solo al salir), `toast(texto)`, `go(vista)`, `uid(nombre)` (ids `k-<pantalla>-<nombre>` para unir una etiqueta con su campo), `keep` (un `Map` que sobrevive a los remontajes) y `onUnmount(fn)`.

Tres cosas que no hay que olvidar:

- **La pantalla se desmonta y se vuelve a montar a menudo** (al cambiar de vista, de marca o de modo), siempre con un `root` nuevo. Lo que deba sobrevivir (un borrador, la pestaña, el paso de un asistente) va en `ctx.keep`; nunca en variables del módulo ni en `localStorage`.
- **Un evento en vivo no recarga la pantalla**: `onEvent` pone al día la fila (`tabla.upsert(fila)`) o la ficha (`ficha.refresh(…)`, que no pisa un borrador a medias).
- **Los permisos los impone el servidor** en cada API. `roles` sólo decide quién ve la entrada del menú.

## Las piezas del kit

| Archivo (`public/kit/`) | Exporta | Para qué |
| --- | --- | --- |
| `html.js` | `html`, `render`, `raw`, `attrs`, `when`, `each`, `join`, `icon`, `url`, `esc`, `isSafe` | Plantilla que escapa sola y pintado que no destruye lo que ya hay |
| `events.js` | `listen`, `formValues`, `ACTION` | Eventos delegados dentro de la raíz, por `data-do` |
| `state.js` | `createStore` | Estado de la pantalla: `get`, `set`, `subscribe`; avisa una vez por tanda |
| `api.js` | `createApi`, `ApiError`, `mutation`, `withRevision`, `newClientRef`, `isAbort`, `isStale` | Peticiones con los errores `{error, code}` del servidor, `clientRef` y `expectedRevision` |
| `ids.js` | `ids`, `nextId` | Ids `k-…` (sólo para accesibilidad, no para repartir eventos) |
| `components/table.js` | `pagedTable` | Tabla con cursor («Cargar más», 50 por petición), orden, columnas, selección y sus estados |
| `components/form.js` | `form`, `field`, `fieldError`, `validateFields`, `coerce` | Campos con validación y un formulario que guarda bien (borrador, conflicto 409) |
| `components/dialog.js` | `dialog`, `confirm` | Ventana modal y confirmación: foco atrapado, Escape, foco de vuelta |
| `components/feedback.js` | `toast`, `loading`, `empty`, `failure` | Aviso breve y estados normalizados |
| `components/tabs.js` | `tabs` | Pestañas accesibles (flechas, Inicio, Fin) |
| `components/conditions.js` | `conditionsBuilder`, `describeConditions`, `normalizeConditions`, `conditionProblems`… | Constructor de filtros con la gramática común (`y` dentro de un grupo, `o` entre grupos) |
| `components/wizard.js` | `wizard` | Asistente por pasos |
| `components/panel.js` | `detailPanel` | Panel de detalle: columna en computadora, hoja completa en celular |
| `charts.js` | `tile`, `line`, `sparkline`, `columns`, `bars`, `segments`, `funnel`, `heat`, `meter`, `table`, `figure`, `bind`, `responsive` | Gráficas en SVG con su tabla gemela |
| `kit.css` | clases `k-…` | Los estilos de todo lo anterior, sólo con variables de `tokens.css` |
| `screens.js`, `boot.js` | `createScreens`; `window.TC` | Registro de pantallas (lo usa la aplicación, no las pantallas) |

Cada archivo empieza con un comentario que explica por qué existe y cómo se usa.

## Reglas

1. **Nunca `innerHTML` con datos.** El HTML se pinta sólo con `render()` y la plantilla etiquetada `html` (como en el ejemplo de arriba). Nada de `innerHTML`, `outerHTML`, `insertAdjacentHTML` ni `document.write`; tampoco `raw()` en una pantalla. Todo lo que se interpola en la plantilla se escapa; lo único que pasa tal cual es otro fragmento hecho con ella.
2. **Los atributos, siempre entre comillas dobles.** La plantilla lanza un `TypeError` si se interpola donde el escape no protege: un atributo sin comillas, el nombre de una etiqueta o de un atributo, `<script>`, `<style>`, `style="…"`, un manejador `on…` o un trozo de dirección (`href="/c/${id}"`: arma la dirección entera en una variable). Los atributos opcionales o booleanos van con `attrs({ checked: marcada, disabled: sinPermiso })`.
3. **Sin ids globales ni oyentes globales.** Los eventos van por `data-do="<verbo>"` y un `listen(root, …)` en la raíz; nada escucha en `document` ni reparte por prefijo de `id`. No se usan los atributos `data-action`, `data-view`… del código actual, ni globales en `window`.
4. **Sólo variables de `tokens.css`.** Ningún color, sombra ni tamaño de letra escritos a mano; letra de 11 px o más; lo que se toca mide 40 px o más en pantallas táctiles; sin `!important`. Nada se anima al actualizar en vivo.
5. **Listas por páginas**: `pagedTable`, 50 filas por petición como mucho; ordenar, buscar y filtrar es trabajo del servidor.
6. **Toda acción que cambia datos lleva `clientRef`** (`mutation` o `form` lo ponen y lo reutilizan al reintentar) y, si edita algo con revisión, `expectedRevision`. Un evento en vivo nunca pisa un formulario con cambios.
7. **Precios, fechas, cupos y textos comerciales salen de la API**, nunca del código.
8. **Nada en `localStorage`** ni en cookies desde una pantalla. Sin sintaxis que haya que compilar ni dependencias de npm en el navegador; las importaciones son relativas (`../../kit/…`).
9. **Toda gráfica va con su tabla** (`figure` la pone detrás de «Ver tabla») y dentro de un panel blanco (`.k-card`). Un color nunca es la única forma de decir un estado: lleva texto.

## Pintar y repintar

`render()` no borra y vuelve a crear: **concilia** el marcado nuevo con lo que ya hay. Por eso un repintado conserva el foco, el cursor, el desplazamiento y los `<details>` abiertos, y no parpadea. Dos atributos lo guían:

- `data-key="…"` (o un `id`) en lo que se repite o cambia de orden (filas, fichas): así se reconoce el mismo nodo aunque cambie de sitio.
- `data-slot="…"` en la caja donde pinta un componente (una tabla, un formulario, una gráfica): al repintar el esqueleto, lo que hay dentro de una ranura no se toca.

Los campos se pintan desde el estado: una casilla marcada vuelve a lo que diga el marcado; el texto de un campo sólo se reescribe si el marcado cambió, para no pisar lo que la persona está tecleando.

## Gráficas

```js
import { bind, figure, line, responsive } from '../../kit/charts.js';

const caja = root.querySelector('[data-slot="tendencia"]');
ctx.onUnmount(responsive(caja, ancho => render(caja, html`${figure({
  title: 'Mensajes por día',
  chart: line({ label: 'Mensajes por día', labels: dias, series: [{ name: 'Recibidos', values, color: 1 }], width: ancho }),
})}`)));
ctx.onUnmount(bind(root)); // una vez por pantalla: el globo de datos y el recorrido con las flechas
```

Un SVG del kit **no se escala** (la letra bajaría de 11 px): se pinta al ancho que se le da y `responsive()` lo repinta cuando la caja cambia. El color sigue a la entidad, no al orden: cada serie declara su número de 1 a 6 (`--ch-1` … `--ch-6`).

## Lista de comprobación

- [ ] `node --test test/kit-*.test.mjs` y la suite completa pasan.
- [ ] La pantalla se abre con `SCREENS_PREVIEW=1`, en computadora y a 375 px, sin errores en la consola.
- [ ] A 375 px no hay desplazamiento horizontal de la página (las tablas y las gráficas se desplazan dentro de su caja), ninguna letra baja de 11 px y todo lo que se toca mide 40 px o más.
- [ ] Todo se puede hacer con el teclado: el foco siempre se ve, una ventana lo atrapa y lo devuelve al cerrar, Escape cierra.
- [ ] Cada campo tiene su etiqueta; cada botón de sólo icono, su `aria-label`; cada estado, texto además de color.
- [ ] Los estados cargando, vacío y fallo (con «Volver a intentar») existen y explican qué pasa.
- [ ] Salir y volver a entrar no pierde un borrador (`ctx.keep`) ni deja temporizadores ni peticiones vivas (`ctx.onUnmount`).
- [ ] Un evento en vivo actualiza sólo lo que cambió y no pisa un formulario a medias.
- [ ] Reintentar una acción no la repite (`clientRef`); editar algo que otra persona cambió avisa del conflicto (409).
- [ ] La pantalla trae su prueba de humo de interfaz en los dos tamaños (cuando exista `test/ui/`).

## Puente

Lo que une el kit con la aplicación actual. Lo conecta quien integra; **las pantallas no tocan nada de esto**.

**`public/index.html`, tres líneas:** `<link rel="stylesheet" href="/tokens.css">` antes de `/styles.css`; `<link rel="stylesheet" href="/kit/kit.css">` después de `/checkout.css`; y `<script type="module" src="/kit/boot.js"></script>` antes de `<script defer src="/app.js">`.

**Lo que hace `boot.js`:** crea `window.TC = { host: null, screens }` (el único global nuevo) y pide `GET /screens/index.json`, que responde `{"screens":[…]}`. Importa cada pantalla de `/screens/<id>/<entry>` y añade sus hojas `/screens/<id>/<hoja>` una sola vez. No hace nada más: con la lista vacía, la aplicación no cambia.

**Lo que `app.js` debe asignar**, después de crear sus módulos: `window.TC.host = { state, api, esc, icon, icons, toast, showModal, setView, refresh }`. El kit usa hoy cuatro cosas de ahí:

| De `TC.host` | Cuándo |
| --- | --- |
| `state.user`, `state.brand` | Al montar una pantalla (son `ctx.user` y `ctx.brand`) |
| `icons()` | Tras un `render()` que deja marcas `<i data-lucide>` nuevas |
| `toast(texto)` | `ctx.toast` y los avisos del kit |
| `setView(vista)` | `ctx.go(vista)` |

**Lo que `app.js` puede llamar de `TC.screens`:**

| Miembro | Devuelve | Notas |
| --- | --- | --- |
| `ready` | Promesa de la lista | **Nunca se rechaza**: si la lista no carga vale `[]` y deja un `console.warn`. `load()` la espera tras `Object.assign(state, data)` |
| `get(id)` | El descriptor o `undefined` | Para `pageTitle()` (`.title`) y para decidir en `renderPage()` |
| `menu(rol)` | Las pantallas con `nav` de ese rol, en el orden del servidor | Para `sideNav()`: `btn(s.id, s.nav.icon, s.title, s.nav.label)` en el grupo `s.nav.group` |
| `list(rol)` | Todas las de ese rol, tengan o no `nav` | |
| `mount(id, root)` | Promesa de `true` si quedó montada | **Nunca lanza.** Vacía `root` (el `#page` recién creado) y pinta dentro; si la pantalla no carga, pinta el fallo con «Volver a intentar» |
| `unmount()` | — | Primera línea de `renderPage()`; se puede llamar sin nada montado y no supone que la raíz siga en el documento |
| `notify(evento)` | — | En el oyente del WebSocket; pasa el evento tal cual a `onEvent` de la pantalla montada |
| `current()` | El `id` montado o `null` | |

En `renderPage()`: `window.TC?.screens.unmount();` al empezar y, tras la comprobación de acceso, `const s = agentMode() && window.TC?.screens.get(state.view); if (s) return window.TC.screens.mount(s.id, $('#page'));`. La raíz debe ser el `#page` de siempre (`.page-slot`, una caja flexible en columna): `.k-page` ocupa su alto y es la que se desplaza.

## Lo que todavía no cubre

- Las pruebas de humo de interfaz (`test/ui/`, Playwright) son otro incremento; hasta entonces lo que depende del navegador se comprueba a mano.
- La vista de teléfono (`phone.js`) que usarán plantillas y flujos se añadirá al kit con su primer consumidor.
- `tabla.upsert(fila)` no sabe si la fila cumple el filtro activo: quien la llama decide si la pone, la quita (`remove`) o recarga.
