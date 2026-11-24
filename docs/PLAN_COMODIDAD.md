# Comodidad: no perder el lugar, ventanas iguales y saber dónde se está

**Estado:** **publicado en `main` el 23 nov 2026** (commit `e00e82e`); sólo interfaz, sin esquema, rutas ni permisos nuevos.

## Por qué

El 23 nov 2026 el dueño, al aprobar plantillas y pegar enlaces de grupo en Coordinación, pidió dos cosas: que las ventanas emergentes sean más cómodas, y que al guardar o cerrar una «la página no haga como que refresca y me mande hasta arriba». Y, más en general, que el diseño ayude a no perderse: más organizado y fácil de usar.

Inventario antes de tocar nada: **102** lugares en 13 pantallas devolvían `'reload'` tras guardar (connectors 20, coordination 15, payments 10, flows 8, finance 8, certificates 7, integrations 6, simulator 5, recipes 5, legacy 5, campaigns 5, allies 4, ads 4), y el repintado de cada pantalla del equipo reemplazaba todo `#page` desde cero. **28** pantallas abren ventanas con `showModal`, todas con el mismo esqueleto (`#modal > #modal-content > .modal-inner > .modal-head + contenido`) pero el contenido se desplazaba junto con el título y los botones.

Reglas del dueño respetadas: **no se pierde ninguna opción y no se inventa ninguna**. Nada cambia de sitio dentro de una ventana ni en las pantallas; sólo cómo se desplazan y qué se recuerda.

## Pieza 1: no perder el lugar

- `swapPage(html)` en `public/app.js`: repinta `#page` conservando el desplazamiento de `.content-page` (y de `#page` y `.main`, por si en celular desplaza otro), el campo con foco (por `id` o `name` dentro de su formulario) y la posición del cursor dentro de él. Lo reciben por sus dependencias las pantallas que repintan desde cero: Catálogo, CRM (Mi día, Contactos, Oportunidades, Tareas, Equipo, Mi configuración), Operación, Analítica, Portal de resultados, Agenda y Presentación; también está en `window.TC.host` para el kit.
- Las pantallas que devuelven `'reload'` no cambian: su repintado pasa por `render()` de Operación o de Catálogo, que ahora usa `swapPage`. Los estados de carga y de error siguen reemplazando la página (no hay lugar que conservar).
- El kit de pantallas nuevas (`public/kit/html.js`, `render()` con `morph`) ya conservaba el lugar: no se tocó.

## Pieza 2: ventanas iguales y cómodas

Sección 12 de `public/tinta-vistas.css`, sólo para `#modal` del equipo (la página de pago del cliente, `#modal.pay-page`, y los diálogos del kit, `.k-dialog`/`.k-side`, no cambian):

- La ventana es una columna: el contenido (`.modal-inner`) se desplaza por dentro; el título y el botón «cerrar» (`.modal-head`) quedan fijos arriba.
- La acción principal queda fija abajo: **sólo** el último bloque de botones de la ventana (`form > .actions:last-child`, `.modal-inner > .actions:last-child` o el botón primario final de un `form-grid`). Las fichas con varias secciones (apertura en Coordinación, contacto, pedido) tienen botones por sección y ésos no se fijan: se verían encimados.
- Ancho: 600 px en computadora (antes 550) y 780 px para las fichas con secciones (`.ops-detail`, `.co-section`).
- Celular (≤ 680 px): la ventana ocupa toda la pantalla, sin esquinas, con el mismo título fijo.
- Escape y el clic fuera cerraban ya (diálogo nativo); no cambia.

## Pieza 3: saber dónde se está

- Rastro en la cabecera: Operación escribe «Operación · Atención · Coordinación» (área y pestaña) y Catálogo «Catálogo · Plantillas» en `#breadcrumb-title`, en lugar del título genérico.
- Última pestaña recordada en este navegador (`localStorage`: `tc-ops-tab`, `tc-cat-tab`): al volver a Operación o a Catálogo, o al recargar, la persona sigue en la pestaña que tenía. Si la pestaña guardada ya no está disponible para esa persona (una de administración para un asesor), Operación abre la cola de atención y Catálogo los cursos. Un enlace directo a una pestaña (`go(view, tab)`, `openTab`) sigue mandando.
- Las fichas siguen abriéndose en ventana, con su «cerrar» arriba siempre visible (pieza 2); no se añadió un «Volver» aparte para no inventar un control.

## Pieza 4: buscador de aperturas en Coordinación (23 nov 2026)

El dueño, al pegar enlaces de grupo, dijo que le costaba encontrar cada apertura entre las tarjetas. Coordinación gana un cuadro de búsqueda encima de la lista: filtra lo ya cargado (sin otra llamada) por **curso, nombre de la apertura, docente, responsable o marca**, sin distinguir acentos ni mayúsculas y con varias palabras («clinico veterinario»). Al escribir se repinta sólo la lista (`#co-results`), así el campo conserva el foco y la página no se mueve; un contador dice «3 de 18 aperturas» y, sin coincidencias, «Nada coincide con «…»». La búsqueda se conserva mientras se abre y se guarda una ficha (`query` en `public/coordination.js`; estilos `.co-search` y `.co-count` en `public/operations.css`). Las tarjetas de estado (Todas, Planeadas…) siguen igual y se combinan con la búsqueda.

## Verificado

- Navegador (demo local, administración): Catálogo → Plantillas desplazado hasta el final (2 494 px), abrir una plantilla, guardar borrador y cerrar: el desplazamiento se conserva (2 494 px) y la pestaña sigue activa. Operación → Coordinación desplazado a 400 px, abrir una apertura, guardar: 400 px. Ventana de plantilla: título fijo arriba y «Guardar borrador» fijo abajo con el contenido desplazado; en celular (375 × 812) la ventana ocupa la pantalla y nada desborda a lo ancho. Tras recargar, Operación vuelve a Coordinación y Catálogo a Plantillas, con su rastro en la cabecera.
- Buscador: en la demo local, «GERIATRIA» encuentra «Geriatría en mascotas» (1 de 10), «clinico veterinario» encuentra «Laboratorio clínico veterinario», «zzzz» muestra el aviso de sin coincidencias, el campo conserva el foco al escribir y la búsqueda sigue tras abrir una apertura y guardarla.
- `npm run check` (0 errores; los avisos no suben), suite de servidor (820) y pruebas de navegador (`npm run test:ui`, 95). De paso se corrigió un fallo de contraste que ya existía en `main`: los ↑/↓ del «Resumen de la semana» usaban los tonos de borde (`--ok-line`, `--warn-line`, 1,4:1 sobre blanco); ahora usan los de texto (`--ok`, `--warn`) en `public/analytics.css`.

## Pieza 5: formularios largos por secciones (24 nov 2026)

El dueño eligió seguir con esto: los formularios largos cansan porque muestran muchos campos a la vez. Ahora se agrupan en **secciones plegables**, con lo que más se edita arriba y lo secundario a un clic. **Ningún campo se pierde ni se inventa**: sólo se ven menos a la vez.

- Ayudante `section(title, inner, open)` en `public/catalogue.js` (un `<details class="form-section">` con su `<summary>`); estilos en la sección 13 de `public/tinta-vistas.css` (cabecera de sección con flecha, cuerpo en rejilla), sólo para las ventanas del equipo.
- **Editor de plantillas** (Catálogo → Plantillas): «Mensaje» (nombre y texto, con las variables) abierto; «Dónde y cuándo se usa» (marca, escenario, canal, curso, edición, flyer) plegado en una plantilla que ya existe y abierto al crear una nueva.
- **Editor de edición** (Catálogo → Ediciones): «Datos de la edición» (nombre, fechas, zona, docente, modalidad, moneda, precios, estado) abierto; «Lugar, cupo y enlace» plegado. Las parejas de campos en columna no se separan.
- **Seguridad:** si un campo obligatorio vacío queda dentro de una sección cerrada, el navegador no puede mostrar su aviso; un manejador global del evento `invalid` (en captura, en `public/app.js`) abre la sección que lo contiene antes de que el navegador intente enfocarlo. En estos dos formularios los campos obligatorios están en la sección abierta, pero el manejador vale para cualquier formulario.

Verificado en la demo local: las dos secciones aparecen, el texto y las variables funcionan, abrir la sección plegada muestra sus campos, guardar sigue igual, y la prueba sintética confirma que una sección cerrada con un campo obligatorio vacío se abre sola al validar. Pruebas de navegador y de servidor: ver [CONTINUIDAD.md](CONTINUIDAD.md).

## Lo que sigue (no incluido)

- Extender las secciones a los formularios de conocimiento, casos de evaluación y la ficha de apertura en Coordinación (el ayudante y los estilos ya son generales).
- Repintar sólo la tarjeta afectada en lugar de toda la vista (hoy se conserva el lugar, pero se repinta todo).
- Recordar también filtro y búsqueda de Operación entre recargas (dentro de la sesión ya se conservan).
