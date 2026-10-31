# Diseño Niebla: reglas y auditoría visual

Niebla es la identidad del producto: blanco y gris, transparencias discretas, bordes finos, composición compacta y distintivos de canal reconocibles (WhatsApp, Instagram, Facebook). Este documento fija las reglas que la sostienen y la manera de **medir** que se cumplen, para refinar el diseño sin discutir de gusto.

## Reglas

- **Contraste de texto:** WCAG AA, mínimo 4,5:1 (3:1 en texto grande). Los grises de texto son dos tokens: `--text-2` (`#4b515c`, cuerpo secundario) y `--text-3` / `--muted` (`#636977`, apoyo y metadatos; 5,5:1 sobre blanco). No escribir grises de texto a mano en las hojas: usar el token.
- **Tamaño mínimo de letra: 11 px.** No usar 9 ni 10 px.
- **Excepciones permitidas a propósito (siguen suaves):** iconos decorativos, la casilla de tarea, precios tachados, tareas hechas y el texto de columnas vacías.
- **Áreas táctiles:** al menos 40 px de alto en pantallas táctiles o de 680 px o menos; en texto-enlace se amplía el área con un pseudo-elemento sin mover la composición.
- **Foco de teclado:** siempre visible (anillo de 2 px), nunca eliminado.
- **Movimiento:** sólo al navegar entre vistas (`#page.enter`) y al abrir diálogos. **Nunca** animar en las actualizaciones en vivo (el contenido se vuelve a dibujar cada pocos segundos y parpadearía). Respetar `prefers-reduced-motion`.
- **Números:** `font-variant-numeric: tabular-nums` en contadores, tablas y métricas.
- **Escritorio ancho:** el espacio de trabajo ocupa todo el ancho de la ventana (sin tope de 1800 px).
- **Móvil (390 px):** sin desplazamiento horizontal de la página; tablas anchas se desplazan dentro de su contenedor.

## Dónde vive

- `public/styles.css` define las variables (`--ink`, `--muted`, `--text-2`, `--text-3`, `--line`, colores de canal).
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

## Ideas de diseño que se dejaron fuera a propósito

- **Modo oscuro:** cambia la identidad Niebla; se haría como decisión explícita (tokens de color por tema), no como pulido.
- **Rediseño de componentes o de la composición:** el diseño compacto ya está validado; los cambios grandes requieren la aprobación visual del usuario.
