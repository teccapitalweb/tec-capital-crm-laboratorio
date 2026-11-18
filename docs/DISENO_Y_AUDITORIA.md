# Diseño Tinta: reglas y auditoría visual

**Tinta** es la identidad visual del CRM del equipo desde el 17 nov 2026. Sustituye a Niebla (blanco, gris y bordes finos), que se queda sólo en la experiencia del cliente. El dueño del producto la aprobó después de configurar un recorrido a mano en producción y encontrar el interior de los módulos «pobre y difícil de usar»: pidió **más color y más vida**, con dos reglas firmes:

1. **No es un cambio radical de lo que hace el producto.** Cambia el aspecto, no el funcionamiento.
2. **No se pierde ni se inventa ninguna opción.** Cada botón, filtro, campo y acción que existía sigue existiendo, con el mismo comportamiento.

Los bocetos aprobados son la especificación visual (fuera de Git, en `data/diseno-canvas/project/`: `FinalMenu`, `FinalMiDia`, `FinalConversaciones`, `FinalRecorridos` y `FinalEditor`). Este documento fija las reglas que los sostienen y la manera de **medir** que se cumplen.

## En una línea

Bloques de color en lugar de tarjetas blancas con borde, esquinas muy redondas, botones en píldora, **tinta negra como protagonista** con un **acento lima**, cifras enormes y Manrope en todo.

## Paleta

Todos los valores viven en `public/tokens.css` y **sólo ahí** (la prueba `test/kit-static.test.mjs` falla si otra hoja vuelve a declarar una variable en `:root`). Contraste medido con la fórmula de WCAG 2.

| Token | Valor | Uso |
| --- | --- | --- |
| `--ink` | `#16181d` | Texto principal, botón principal, menú oscuro, filtro o pestaña activa |
| `--ink-2` / `--ink-3` | `#23262d` / `#2a2d35` | Superficies y líneas sobre tinta (selector de marca, filas del menú oscuro) |
| `--on-ink` | `#fff` | Texto sobre tinta (17,8:1) |
| `--on-ink-text` | `#e6e8ee` | Filas del menú oscuro (14,5:1) |
| `--on-ink-soft` | `#c5c9d3` | Texto secundario sobre tinta (10,7:1; 8,3:1 sobre `--ink-3`) |
| `--on-ink-muted` | `#aab0bc` | Rótulos sobre tinta (8,2:1; 6,3:1 sobre `--ink-3`) |
| `--page` (= `--bg`) | `#eceef3` | Fondo de la página |
| `--surface` | `#fff` | Tarjeta blanca |
| `--soft` | `#f4f5f8` | Pieza hundida dentro de una tarjeta, botón secundario, buscador |
| `--line` | `#e3e5ec` | Borde de los campos y separadores |
| `--text-2` | `#3a3f4a` | Texto secundario |
| `--text-3` (= `--muted`) | `#4a505c` | Apoyo y metadatos |
| `--lime` | `#d9f24f` | Acento: llamada a la acción, elemento activo sobre tinta, selección |
| `--lilac` `--mint` `--sky` `--butter` `--peach` | `#e3dcff` `#d3f4e2` `#d6ebff` `#fff0b8` `#ffe0cf` | Bloques de color |
| `--rose` | `#f6d9ec` | Pastel de Instagram de los bocetos |
| `--ok` / `--warn` / `--bad` | `#256b4e` / `#7d5710` / `#a7433a` | Texto de estado; sus fondos son menta, mantequilla y durazno |
| `--wa` / `--ig` / `--fb` | sin cambios | Distintivos de canal: se reconocen igual que antes |

### Contraste de texto sobre cada fondo

AA exige 4,5:1 en texto normal y 3:1 en texto de 24 px o más (o de 18,66 px en negrita). Peor caso de cada color de texto:

| Texto | Blanco | `--soft` | `--page` | Lila | Menta | Cielo | Mantequilla | Durazno | Lima |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `--ink` | 17,76 | 16,29 | 15,30 | 13,49 | 15,06 | 14,53 | 15,57 | 14,22 | 14,18 |
| `--text-2` | 10,55 | 9,68 | 9,09 | 8,01 | 8,95 | 8,64 | 9,25 | 8,45 | 8,43 |
| `--text-3` | 8,10 | 7,43 | 6,98 | 6,15 | 6,87 | 6,63 | 7,10 | 6,48 | 6,46 |
| `--ok` | 6,38 | 5,85 | 5,50 | 4,84 | 5,41 | 5,22 | 5,59 | 5,11 | 5,09 |
| `--warn` | 6,48 | 5,94 | 5,58 | 4,92 | 5,49 | 5,30 | 5,68 | 5,19 | 5,17 |
| `--bad` | 5,99 | 5,49 | 5,16 | 4,55 | 5,08 | 4,90 | 5,25 | 4,79 | 4,78 |

Sobre tinta: blanco 17,76; `--on-ink-text` 14,50; `--on-ink-soft` 10,71; `--on-ink-muted` 8,16; lima 14,18. Todo pasa AA. Regla práctica: **sobre un pastel o sobre lima, el texto es siempre `--ink`** (los bocetos no ponen texto gris ni de color sobre pastel salvo `--bad` en avisos de error).

### Dónde se queda el azul petróleo (`#2f6f8f`)

- En la **paleta de gráficas** (`--ch-seq-4` y vecinos): se validó para daltonismo sobre blanco y Tinta no tocó las gráficas.
- En el **icono de la app y el favicon** (`favicon.svg`, `icon-192.png`, `icon-512.png`) y en la **pantalla de entrada** (la marca «tc» del panel izquierdo), que comparten clientes y equipo.
- En la **experiencia del cliente** (`.customer-skin`: el chat con aspecto de app de mensajería en `/`, también cuando el equipo entra en modo «Cliente»), que conserva los colores de Niebla a propósito: `tokens.css` §9 los vuelve a declarar sobre `.customer-skin`.
- En las **páginas públicas sin guiones** (certificados, encuestas, aviso de privacidad, formulario de aliados), que llevan su CSS en línea en `server/*.mjs` y no cargan `tokens.css`.

En el CRM del equipo ya no se usa: lo que antes era «acento» (`--accent`) ahora apunta a `--ink`, y el fondo del elemento activo (`--accent-soft`) a `--lime`.

## Formas, letra y profundidad

| Token | Valor | Uso |
| --- | --- | --- |
| `--radius-card` | 28 px | Tarjetas, paneles, menú, ventanas |
| `--radius-block-lg` / `--radius-block` | 22 / 20 px | Piezas dentro de una tarjeta (hilo, dato, aviso, tabla) |
| `--radius-control` | 16 px | Campos de texto y listas desplegables |
| `--radius-item` | 14 px | Filas del menú, selector de marca |
| `--radius-pill` | 999 px | Botones, fichas, pestañas, filtros |
| `--font-title` | 40 px (30 px en celular) | Título de la vista, peso 800, `letter-spacing: -0.03em` |
| `--font-display` | 56 px (44 px en celular) | Cifras grandes |
| `--font-2xl` / `--font-section` | 24 / 19 px | Título de tarjeta grande / de tarjeta |
| `--font-lead` | 15 px | Bajada bajo el título |
| `--font-lg` | 14 px | Botones, filas y cuerpo |
| `--font-min` | 11 px | Mínimo absoluto |
| `--weight-black` / `--weight-bold` | 800 / 700 | Títulos, rótulos y activos / botones |
| `--control` / `--control-lg` | 44 / 50 px | Alto de botones y campos / llamada a la acción de la página |
| `--shadow-card` | `none` | Tinta es plana: el color separa, no la sombra |
| `--shadow-lift`, `--shadow-dialog` | sombras | Sólo lo que flota: menús desplegables, avisos y ventanas |

La letra es **Manrope** (Google Fonts, pesos 400–800, cargada desde `styles.css`; la CSP ya permitía `fonts.googleapis.com` y `fonts.gstatic.com`, no hubo que cambiarla).

## Piezas

- **Botones** (`.btn` y `.k-btn`): píldora de 40 px (44 px en pantallas táctiles; 44 px siempre en el kit), sin borde ni sombra. **Principal** (`.btn.primary`, `.k-btn--primary`): tinta con texto blanco. **Llamada a la acción** (`.btn.accent`, `.k-btn--accent`): lima con texto tinta; una por vista, como mucho. **Secundario** (por omisión): `--soft` dentro de una tarjeta y blanco sobre la página gris (cabecera de la vista, barra superior y barras de herramientas). **Peligro** (`.k-btn--danger`): durazno con texto `--bad`.
- **Fichas** (`.pill`, `.k-chip`, `.t-chip`): píldora con texto tinta en negrita; el color de fondo dice el estado (menta bien, mantequilla alerta, durazno mal, lima activo, lila o cielo para categorías).
- **Pestañas y filtros**: píldoras; la activa en tinta con texto blanco, las demás blancas sobre la página o `--soft` dentro de una tarjeta.
- **Tarjetas**: bloques blancos de 28 px de radio, sin borde ni sombra, con 22 px de relleno. Sin la raya de acento que Niebla ponía delante de los títulos.
- **Campos**: borde de 2 px `--line`, radio de 16 px, 14 px de letra (16 px en celular dentro del kit, para que iOS no amplíe); al enfocar, borde tinta y anillo lima de 3 px. El buscador es una píldora `--soft`.
- **Tablas**: caja blanca redondeada, encabezado `--soft` con rótulos en `--text-2` y peso 800.
- **Ventanas**: radio de 28 px, sin borde, velo de tinta translúcida. **Avisos breves**: tinta con texto blanco, radio de 20 px.
- **Avisos dentro de la vista** (`.k-notice`, `.info-box`): bloque cielo (información), menta, mantequilla o durazno, sin borde, texto tinta.

## Menú lateral: oscuro y claro

El menú es un **panel flotante** (14 px de margen, 28 px de radio) sobre la página gris, en dos versiones que la persona elige:

- **Oscuro** (por omisión): fondo tinta, filas `--on-ink-text`, rótulos de grupo `--on-ink-muted` con una línea `--ink-3` entre grupos; la fila activa en **lima con texto tinta**; la marca «tc» lima con tinta.
- **Claro**: fondo blanco, filas tinta, rótulos `--text-2` con un **punto de color por grupo** (Atención naranja, Contactos violeta, Ventas ámbar, WhatsApp verde, Resultados azul, Ajustes y grupos nuevos gris; variables `--dot-*`); la fila activa en **tinta con texto blanco**; la marca tinta con «tc» lima.
- En los dos: contador de Operación en durazno con tinta; selector Cliente/Equipo en píldora; avatar lila.

**Dónde se cambia:** el botón redondo con el icono de sol y luna junto al selector **Cliente / Equipo**, abajo del menú (en celular, a la derecha de la barra de arriba). Es un interruptor (`aria-pressed`) con el nombre accesible «Menú claro». La elección se guarda en este navegador (`localStorage`, clave `tc-menu-theme`, valores `dark` o `light`, protegido con `try/catch`: sin almacenamiento el menú es oscuro). Sólo aparece en el modo Equipo; el modo Cliente no lo tiene.

Todo lo que el menú hacía sigue igual: los mismos seis grupos en el mismo orden, grupos plegables que se recuerdan (`tc-nav-groups`), la posición de desplazamiento al cambiar de pantalla, el contador, el selector de marca, Cliente/Equipo, la nota del laboratorio, la persona y «Cerrar sesión», el riel de iconos de 681 a 850 px y la barra de arriba en celular.

Los colores del menú son variables propias (`--m-bg`, `--m-text`, `--m-active-bg`…), declaradas en `public/tinta.css` sobre `.sidebar` según `data-menu` de `.workspace`: el tema del menú no cambia nada fuera del menú.

## Reglas medibles

- **Contraste de texto:** WCAG AA, 4,5:1 (3:1 en texto de 24 px o más, o 18,66 px en negrita), **también sobre cada pastel, sobre tinta y sobre lima** (tabla de arriba). No se escriben colores de texto a mano: se usa el token.
- **Tamaño mínimo de letra: 11 px.**
- **Excepciones permitidas a propósito:** iconos decorativos; la «f» de Facebook (glifo blanco sobre degradado, que la herramienta no sabe leer); precios tachados; tareas hechas; el texto de columnas vacías.
- **Áreas táctiles:** al menos 40 px en pantallas táctiles o de 680 px o menos (los bocetos usan 44 px: es el alto de `--control`). En texto-enlace se amplía el área con un pseudo-elemento sin mover la composición.
- **Foco de teclado:** siempre visible: anillo tinta de 2 px sobre fondos claros, lima sobre tinta (`--ring` cambia dentro del menú oscuro y de `.t-ink`); en los campos, anillo lima de 3 px.
- **Movimiento:** sólo al navegar entre vistas (`#page.enter`) y al abrir ventanas. Nunca en las actualizaciones en vivo. Respetar `prefers-reduced-motion`. Se permite la respuesta al cursor (160 ms de color, borde y sombra; nada se desplaza ni cambia de tamaño).
- **Números:** `font-variant-numeric: tabular-nums` en contadores, tablas y métricas.
- **Tamaños de ventana:** funciona a **375 × 812** y a **1366 × 800** (y en ventanas de más de 1800 px de ancho): sin desplazamiento horizontal de la página; las tablas anchas se desplazan dentro de su caja.

## Dónde vive

- `public/tokens.css`: todas las variables (paleta, radios, letra, sombras, alturas) y, en §9, los colores de Niebla que conserva la experiencia del cliente. Es la única hoja que declara variables.
- `public/tinta.css` (se carga **la última**): la capa transversal que reviste lo que comparten las pantallas de antes (marco, menú, botones, fichas, tarjetas, campos, pestañas, tablas, ventanas, avisos, estados vacíos) y las clases de ayuda `t-…`. Sólo variables de `tokens.css`; los selectores van envueltos en `:where(…)` para no ganar especificidad, así que la regla de una pantalla concreta sigue mandando sobre la pieza genérica. No toca `.customer-skin`.
- `public/kit/kit.css`: las mismas piezas para las pantallas nuevas (`public/screens/`).
- `public/styles.css`, `public/polish.css` y las hojas de cada módulo: el diseño de cada pantalla, sin variables propias en `:root`.

## Clases para rediseñar una pantalla por dentro

Para las pantallas de antes (`public/*.js`), en `public/tinta.css`:

| Clase | Qué es |
| --- | --- |
| `.t-block` | Bloque (tarjeta) de 28 px de radio y 22 px de relleno; blanco sin modificador |
| `.t-piece` | Pieza dentro de un bloque (20 px de radio); `--soft` sin modificador |
| `.t-lilac` `.t-mint` `.t-sky` `.t-butter` `.t-peach` `.t-lime` `.t-soft` `.t-white` | Color de un bloque, una pieza o una ficha (texto tinta) |
| `.t-ink` | Bloque en tinta: cambia `--text-2`, `--text-3`, `--soft`, `--line` y `--ring` para que lo de dentro se lea, y los enlaces pasan a lima |
| `.t-eyebrow`, `.t-title`, `.t-section`, `.t-lead` | Rótulo, título de la vista, título de bloque y bajada |
| `.t-figure` | Cifra grande (56 px, 44 px en celular) |
| `.t-label` | Rótulo de dato en mayúsculas (CÓMO EMPIEZA) |
| `.t-chip` | Ficha de estado en píldora; con `.t-mint`, `.t-peach`… |
| `.t-filters` | Fila de filtros en píldora; el activo con `aria-pressed="true"` o `.active` |
| `.t-grid` | Rejilla de bloques que se acomoda sola |
| `.btn.accent` | Botón lima de llamada a la acción |

Para las pantallas del kit: `.k-btn--accent` (lima), `.k-chip--lilac`, `.k-chip--sky`, `.k-chip--ink`, además de las piezas de siempre ya revestidas (`.k-card`, `.k-btn`, `.k-chip`, `.k-tab`, `.k-input`, `.k-notice`, `.k-table`, `.k-dialog`, `.k-tile`).

Desde el rediseño del interior de las pantallas del kit (17 nov 2026), en `public/kit/kit.css`, con su uso explicado en [GUIA_PANTALLAS.md](GUIA_PANTALLAS.md) («Una pantalla en Tinta»):

| Clase | Qué es |
| --- | --- |
| `.k-filterbar` | Barra de filtros sobre la página: rótulo y control en una fila, el control en píldora blanca |
| `.k-filter` | Filtro en píldora que se enciende (`aria-pressed="true"`: tinta) |
| `.k-figures` > `.k-figure` | Cifra grande en un bloque de color (`data-tone`), con `__label`, `__value` (56 px; 44 px en celular) y `__sub` |
| `.k-pieces` > `.k-piece` | Dato con rótulo en mayúsculas en una pieza redonda (`data-tone` opcional) |
| `.k-cards` > `.k-item` | Lista de tarjetas blancas redondas (`__head`, `__name`, `__title`) |
| `.k-tile--lilac` … `--lime` | Tarjeta de cifra en color (`tile({ tone })` en `charts.js`); su cifra va en la escala del título |
| `.k-chip--draft`, `.k-chip--wa`, `.k-chip--lg` | Ficha gris (borrador, archivado), ficha con el punto de WhatsApp y ficha suelta más grande |
| `--k-fill` | Relleno que heredan botones secundarios, pestañas y filtros según la caja: blanco sobre la página y los pasteles, `--soft` dentro de lo blanco |

La tabla de **colores de estado** (qué ficha para qué estado) está en GUIA_PANTALLAS.md y la pantalla `ejemplo` la enseña. Otras decisiones del kit: el botón desactivado ya no usa opacidad (relleno del sitio, borde `--line` y letra `--text-3`, 7:1 o más); el paso actual de un asistente va en tinta con su número en lima; `.k-hint` sube de 11 a 12 px.

Variables que el kit define por su cuenta y podrían pasar a `tokens.css` si las pantallas de antes las necesitan: ninguna de color; sólo `--k-fill`, que es de contexto (se declara en cada caja) y no un valor de la paleta.

**Cajas que se desplazan y `.k-sr`:** las etiquetas «sólo para lector de pantalla» son absolutas. Toda caja del kit que se desplaza (`.k-page`, `.k-table__scroll`, el cuerpo de una ventana y del panel) es `position: relative` para que una `.k-sr` dentro de una tabla ancha no se coloque respecto a la ventana y ensanche el documento (era el desbordamiento intermitente de 2–3 px de Contactos a 1366 px con un nombre largo; lo vigila `test/ui/contactos.spec.mjs`). Una caja propia que se desplace horizontalmente debe hacer lo mismo.

## Auditoría reproducible

La auditoría automática está en `test/ui/niebla-audit.mjs` (el nombre del archivo es de Niebla; mide reglas, no colores) y se ejecuta en las pruebas de navegador (`npm run test:ui`) a 1366 × 800 (`escritorio`) y 375 × 812 (`celular`):

- `expectNiebla(page, nombre, testInfo)` mide la vista (`#page`): textos de menos de 11 px (debe ser 0), desbordamiento horizontal (0), textos con contraste insuficiente y, en celular, controles de menos de 40 px (no pueden superar la línea base `test/ui/niebla-baseline.json`, que sólo puede bajar; una pantalla nueva no tiene línea base y su límite es cero).
- `test/ui/tinta.spec.mjs` comprueba el sistema: fondo de página `#eceef3`, Manrope, título de 40 px (30 px en celular) en peso 800, botón principal tinta en píldora de 40 px o más, campos de 16 px de radio y borde de 2 px, paneles de 28 px; el menú oscuro por omisión con la fila activa en lima, el cambio a claro (fila activa en tinta), que se recuerde al recargar y al cambiar de pantalla, y **la auditoría completa del menú en los dos temas con límite cero** (letra, contraste y, en celular, áreas táctiles); y que la experiencia del cliente conserve sus colores y no tenga el interruptor.
- `test/kit-static.test.mjs` comprueba sin navegador que `tokens.css` es la única hoja con variables en `:root`, que la paleta tiene los valores de los bocetos y que las hojas del kit y de las pantallas no escriben colores, sombras ni tamaños de letra a mano.

Para medir a mano una vista en el navegador, con sesión iniciada, pega en la consola:

```js
(() => {
  const parse=c=>{const m=c.match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(',').map(parseFloat);return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};};
  const lum=({r,g,b})=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(r)+.7152*f(g)+.0722*f(b);};
  const bgOf=el=>{let e=el,acc={r:255,g:255,b:255};const st=[];while(e&&e!==document.documentElement){const c=parse(getComputedStyle(e).backgroundColor);if(c&&c.a>0){st.push(c);if(c.a>=.99)break;}e=e.parentElement;}for(const c of st.reverse())acc={r:acc.r*(1-c.a)+c.r*c.a,g:acc.g*(1-c.a)+c.g*c.a,b:acc.b*(1-c.a)+c.b*c.a};return acc;};
  const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  let total=0,small=0;const fails=[];
  const w=document.createTreeWalker(document.querySelector('#app'),NodeFilter.SHOW_TEXT);
  while(w.nextNode()){const n=w.currentNode;if(!n.textContent.trim())continue;const el=n.parentElement,cs=getComputedStyle(el);if(!el.getClientRects().length||cs.visibility==='hidden')continue;total++;
    const fg=parse(cs.color),bg=bgOf(el),mix={r:fg.r*fg.a+bg.r*(1-fg.a),g:fg.g*fg.a+bg.g*(1-fg.a),b:fg.b*fg.a+bg.b*(1-fg.a)},cr=ratio(mix,bg),size=parseFloat(cs.fontSize),large=size>=18||(size>=14&&+cs.fontWeight>=700);
    if(size<11)small++;if(cr<(large?3:4.5))fails.push(cr.toFixed(2)+' · '+size+'px · '+n.textContent.trim().slice(0,30));}
  return {total,under11px:small,contrastFailures:fails.length,sample:fails.slice(0,8),overflowX:document.documentElement.scrollWidth-innerWidth};
})()
```

Criterios de aceptación de un cambio visual: **0 textos bajo 4,5:1** (salvo las excepciones), **0 textos bajo 11 px**, **0 px de desbordamiento** a 375 px y sin errores nuevos en la consola, en los **dos temas del menú**.

## Resultado de la base de Tinta (17 nov 2026)

Medido con la base de pruebas local (`npm run demo`) a 1366 × 800 y 375 × 812, con el menú oscuro y con el claro, en Mi día, Conversaciones con un chat abierto, Operación, Contactos, Tareas, Catálogo, Mi configuración, Analítica, Audiencias y Plantillas (pantallas del kit, con tabla), Automatización (lista, ventana «Nuevo recorrido» y editor), la ventana de perfil, la entrada y el chat del cliente: **0** textos de menos de 11 px, **0 px** de desbordamiento y **0** fallos de contraste fuera de las excepciones (sólo la «f» de Facebook sobre su degradado; antes también fallaba el «tc» del menú sobre su degradado, que ya no existe).

## Antes: Niebla (31 oct – 16 nov 2026)

Niebla era blanco y gris, transparencias discretas, bordes finos y composición compacta, con un acento sobrio azul petróleo (`#2f6f8f`) desde el 3 nov y un pulido de oficio el 12 nov. Sus reglas medibles (contraste AA, 11 px, 40 px, movimiento sólo al navegar) siguen vigentes en Tinta sin cambios de umbral; lo que cambió es la paleta, las formas y el peso visual. La experiencia del cliente la conserva.

## Ideas que se dejaron fuera a propósito

- **Modo oscuro de toda la aplicación:** sólo el menú tiene versión oscura. Un tema oscuro completo pide tokens por tema y una revisión de cada pantalla.
- **Rediseño del interior de Mi día, Conversaciones, la lista de recorridos y el editor:** lo hacen después otras personas sobre esta base; aquí sólo heredan las piezas y la paleta. (Hecho después; las pantallas del kit, `public/screens/`, se rediseñaron por dentro el 17 nov 2026 con las piezas descritas arriba.)
- **Pasar la experiencia del cliente y las páginas públicas a Tinta:** no forma parte de lo aprobado.
