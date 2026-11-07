# Diseño Niebla: reglas y auditoría visual

Niebla es la identidad del producto: blanco y gris, transparencias discretas, bordes finos, composición compacta y distintivos de canal reconocibles (WhatsApp, Instagram, Facebook). Desde el 3 nov 2026 lleva además un **acento sobrio** (azul petróleo) y tres tonos de estado; ver la paleta al final. Este documento fija las reglas que la sostienen y la manera de **medir** que se cumplen, para refinar el diseño sin discutir de gusto.

## Reglas

- **Contraste de texto:** WCAG AA, mínimo 4,5:1 (3:1 en texto grande). Los grises de texto son dos tokens: `--text-2` (`#4b515c`, cuerpo secundario) y `--text-3` / `--muted` (`#636977`, apoyo y metadatos; 5,5:1 sobre blanco, 4,97:1 sobre el fondo `--bg` y 4,77:1 sobre `--accent-soft`, el fondo tintado más oscuro donde se permite texto gris). No escribir grises de texto a mano en las hojas: usar el token. Sobre fondos tintados más oscuros (columnas del tablero, chips) usar `--text-2` o el color del propio estado.
- **Tamaño mínimo de letra: 11 px.** No usar 9 ni 10 px.
- **Excepciones permitidas a propósito (siguen suaves):** iconos decorativos, la casilla de tarea, precios tachados, tareas hechas y el texto de columnas vacías.
- **Áreas táctiles:** al menos 40 px de alto en pantallas táctiles o de 680 px o menos; en texto-enlace se amplía el área con un pseudo-elemento sin mover la composición.
- **Foco de teclado:** siempre visible (anillo de 2 px), nunca eliminado.
- **Movimiento:** sólo al navegar entre vistas (`#page.enter`) y al abrir diálogos. **Nunca** animar en las actualizaciones en vivo (el contenido se vuelve a dibujar cada pocos segundos y parpadearía). Respetar `prefers-reduced-motion`.
- **Números:** `font-variant-numeric: tabular-nums` en contadores, tablas y métricas.
- **Escritorio ancho:** el espacio de trabajo ocupa todo el ancho de la ventana (sin tope de 1800 px).
- **Móvil (390 px):** sin desplazamiento horizontal de la página; tablas anchas se desplazan dentro de su contenedor.

## Dónde vive

- `public/styles.css` define las variables (`--ink`, `--muted`, `--text-2`, `--text-3`, `--line`, `--bg`, los tokens de acento y de estado, colores de canal).
- `public/polish.css` se carga **al final** y concentra el pulido transversal: selección y barras de desplazamiento, tipografía, transiciones, estados al pasar el cursor y presionar, foco, animación de entrada, bloque de usuario del menú y áreas táctiles. Para ajustes de una pantalla concreta se sigue usando su hoja.

## Auditoría reproducible

Medir antes de cambiar y después. En el navegador, con sesión iniciada y datos de práctica variados, pega este código en la consola de cada vista (Mi día, Contactos, Oportunidades, Tareas, Operación, Analítica, Catálogo, Actividad, Mi configuración):

```js
(() => {
  const parse=c=>{const m=c.match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(',').map(parseFloat);return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};};
  const lum=({r,g,b})=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(r)+.7152*f(g)+.0722*f(b);};
  const bgOf=el=>{let e=el,acc={r:255,g:255,b:255};const st=[];while(e&&e!==document.documentElement){const c=parse(getComputedStyle(e).backgroundColor);if(c&&c.a>0){st.push(c);if(c.a>=.99)break;}e=e.parentElement;}for(const c of st.reverse())acc={r:acc.r*(1-c.a)+c.r*c.a,g:acc.g*(1-c.a)+c.g*c.a,b:acc.b*(1-c.a)+c.b*c.a};return acc;};
  const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  let total=0,small=0;const fails=[];
  const w=document.createTreeWalker(document.querySelector('#page'),NodeFilter.SHOW_TEXT);
  while(w.nextNode()){const n=w.currentNode;if(!n.textContent.trim())continue;const el=n.parentElement,cs=getComputedStyle(el);if(!el.getClientRects().length||cs.visibility==='hidden')continue;total++;
    const fg=parse(cs.color),bg=bgOf(el),mix={r:fg.r*fg.a+bg.r*(1-fg.a),g:fg.g*fg.a+bg.g*(1-fg.a),b:fg.b*fg.a+bg.b*(1-fg.a)},cr=ratio(mix,bg),size=parseFloat(cs.fontSize),large=size>=18||(size>=14&&+cs.fontWeight>=700);
    if(size<11)small++;if(cr<(large?3:4.5))fails.push(cr.toFixed(2)+' · '+size+'px · '+n.textContent.trim().slice(0,30));}
  return {total,under11px:small,contrastFailures:fails.length,sample:fails.slice(0,8)};
})()
```

Criterios de aceptación de un cambio visual: **0 textos bajo 4,5:1** (salvo las excepciones de arriba), **0 textos bajo 11 px**, **sin desplazamiento horizontal a 390 px** (`document.documentElement.scrollWidth - innerWidth === 0`) y sin errores nuevos en la consola. Revisar siempre escritorio (incluida una ventana de más de 1800 px) y celular.

## Resultado del refinamiento (31 oct 2026)

Antes: más de 290 textos con contraste de entre 2,6:1 y 4,4:1 (entre ellos encabezados de tabla, subtítulos, avisos y etiquetas de pestañas) y 140 textos de 9–10 px. Después, en las nueve vistas auditadas: **0 y 0**, con la misma identidad visual.

## Paleta de acento sobrio (3 nov 2026)

El usuario pidió «un poco de color, normalito, obvio pero no colorido». La respuesta es un único acento y tres estados, siempre como tokens de `public/styles.css`; `public/polish.css` lleva al final la capa transversal «Acento sobrio» que los aplica a lo que debe reconocerse de un vistazo.

| Token | Valor | Uso | Contraste medido |
| --- | --- | --- | --- |
| `--bg` | `#f1f4f6` | Fondo general y de las páginas de contenido (con un degradado radial muy suave); los paneles y el chat siguen en blanco | `--text-3` 4,97:1 |
| `--line` | `#e1e6ea` | Bordes (antes `#e9e9ef`) | — |
| `--soft` | `#f4f6f8` | Superficies hundidas: buscador, encabezados de tabla, contexto del chat | `--text-3` 5,08:1 |
| `--accent` | `#2f6f8f` | Botón primario, eyebrows, enlaces, contador, barras y gráfica, progresos, foco de teclado, marca «tc» y favicon (degradado `#3a7fa0` → `#255a75`) | blanco 5,56:1 · sobre `--bg` 5,02:1 |
| `--accent-strong` | `#255a75` | Texto del elemento activo (menú, pestañas, filtros, selector Cliente/Equipo) y hover del botón primario | sobre `--accent-soft` 6,5:1 |
| `--accent-soft` / `--accent-tint` | `#e8f0f4` / `#f1f6f9` | Fondo del elemento activo, pestaña de canal activa, hilo seleccionado, aviso superior, sugerencia de respuesta | — |
| `--accent-line` | `#cddbe3` | Borde del elemento activo y del compositor enfocado | — |
| `--ok` / `--ok-soft` / `--ok-line` | `#256b4e` / `#e7f4ed` / `#cfe6d9` | Bueno: chips `good`/`ok`, insignia `ready`, sesión pagada, progreso terminado, tarea hecha | 5,66:1 |
| `--warn` / `--warn-soft` / `--warn-line` | `#7d5710` / `#fcf3df` / `#efdfb8` | Alerta: chips `high`/`warn`, etiqueta ámbar, ventana de servicio cerrada | 5,86:1 |
| `--bad` / `--bad-soft` / `--bad-line` | `#a7433a` / `#fcecea` / `#f2d2ce` | Urgente: chip `urgent`, etiqueta roja, errores de formulario e importación, vencidas, envíos fallidos | 5,18:1 |

Las páginas públicas sin scripts (`/verificar/<folio>`, `/encuesta/<token>`) no cargan las hojas de `public/`: llevan los mismos valores escritos en su CSS en línea (`server/certificates.mjs`, `server/surveys.mjs`). Si cambia un token, cambiarlo también ahí.

Lo que **no** cambia: los colores y degradados de canal (`--wa`, `--ig`, `--fb`), la tinta de títulos y cuerpo, la composición y las reglas medibles de arriba. Única excepción medida: el **texto** del nombre del canal en el encabezado del chat (`WhatsApp`) usa `#04794a`, un tono más oscuro del verde del distintivo, porque `#06985c` sobre blanco da 3,7:1; el distintivo no cambia. Burbujas salientes del chat: degradado `#eef5f8` → `#e3eef3` (tinta negra, sin texto gris encima).

**Resultado (3 nov 2026):** auditoría en escritorio (1366 px) y celular (375 px) sobre entrada, Mi día, Conversaciones con chat abierto, Contactos, Oportunidades, Tareas, Equipo, Mi configuración, Operación (Cola, Coordinación, Finanzas, Conectores), Analítica, Presentación, Actividad, Catálogo y la experiencia del cliente: **0** textos bajo 11 px (se corrigieron dos de 8 px en celular: selector Cliente/Equipo e insignia «Curso activo»), **0** fallos de contraste fuera de las excepciones (la herramienta no lee degradados: el «tc» de la marca y la «f» de Facebook son glifos blancos sobre degradado; las columnas vacías del tablero siguen siendo una excepción declarada) y **0 px** de desbordamiento horizontal. Los encabezados del tablero de Oportunidades pasaron a `--text-2` para mantener AA sobre la columna tintada.

## Menú por grupos y Operación por áreas (6 nov 2026)

Cuando una lista de navegación pasa de ~8 elementos se agrupa por tarea, no se deja plana ni se esconde tras un desplazamiento horizontal. Reglas que quedaron: **grupos con título de 11 px** en la barra lateral (en el riel de 70 px el título se oculta y queda una línea divisoria; en celular los grupos se aplanan en la barra de iconos); **máximo ~5 pestañas por área** en Operación; un área sin pestañas visibles para ese rol no se dibuja; la fila de áreas mide 40 px de alto y el área táctil de las filas del menú es de 40 px aunque la fila mida 32–36 (pseudo-elemento, como en las pestañas). Si se agrega una pestaña nueva a Operación, se coloca en el área que corresponde en `opsTabs()` (`public/operations.js`), no al final de una fila.

## Auditoría de celular, ronda 3 (7 nov 2026)

Se recorrieron **todas** las pantallas del equipo (12 vistas y las 4 áreas de Operación con todas sus pestañas) a 375 px y a escritorio con un guion que mide, por pantalla: desbordamiento horizontal de la página, letra menor de 11 px, controles de menos de 36 px de alto y elementos que se salen de su contenedor sin desplazamiento propio. **Escritorio: sin hallazgos.** **Celular, hallazgos corregidos** (sólo CSS, en `public/polish.css`): tachar tarea (26 px), botones de ícono (34 px), casillas y campos de horas de «Horarios y reparto» (19–32 px), resúmenes desplegables de Conectores (22 px) y la tabla de Históricos, que se salía de su panel. Las tablas de datos anchas (Mis resultados, Finanzas, Históricos) se **desplazan dentro de su panel** por diseño. Para repetir la auditoría: mismo guion en la consola del navegador con el viewport en 375×812 y en escritorio.

## Ideas de diseño que se dejaron fuera a propósito

- **Modo oscuro:** cambia la identidad Niebla; se haría como decisión explícita (tokens de color por tema), no como pulido.
- **Rediseño de componentes o de la composición:** el diseño compacto ya está validado; los cambios grandes requieren la aprobación visual del usuario.
