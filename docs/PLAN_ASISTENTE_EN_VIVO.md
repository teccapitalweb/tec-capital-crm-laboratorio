# Asistente en vivo

Pantalla **Ajustes → Asistente en vivo**: lo que hace el asistente conectado por el conector (Claude), al instante y ordenado por sesiones de trabajo, con la tarjeta de lo que dejó y las propuestas para aprobar a un toque. Pedida por el dueño el 26 nov 2026 («ver en tiempo real las creaciones, en un apartado independiente, de manera ordenada»); maqueta aprobada el mismo día y, sobre la primera versión, dos pedidos más: ver cómo se arma un recorrido de forma visual y tener a un lado lo que ya está creado.

## Qué muestra

- **Cifras de las últimas 24 horas**: acciones del asistente, consultas (sólo lectura), creado (escrituras que dejaron algo: borradores y cambios) y propuestas pendientes. Son 24 horas y no «hoy» para no depender de la zona horaria de cada marca.
- **Filtros**: por marca (si la persona administra varias) y por clase de acción: Lee, Crea, Propone, Rechazadas.
- **Línea de tiempo por sesiones**: dos acciones seguidas de la misma conexión y la misma marca son de la misma sesión si entre ellas pasaron menos de 15 minutos. Cada sesión dice cuándo empezó, la marca, cuántas consultas, cambios, propuestas y rechazadas tuvo, si sigue activa y qué conexión (llave o asistente conectado) y persona la hizo. Cada acción lleva su ícono por clase, el texto de siempre de «Actividad», la herramienta, la entidad y la hora; una propuesta lleva su estado (Pendiente, Aprobada, Rechazada…).
- **Tarjeta de lo que dejó** (a la derecha; en celular, una hoja que sube desde abajo): la entidad real leída de la base por su tipo y su id, siempre dentro de la marca:
  - una **propuesta**: la misma tarjeta de «Propuestas del asistente» (acción, nombre, qué pasará, «Lo que se enviará a los clientes», avisos, problemas, la nota del asistente rotulada y escapada) con **Aprobar** y **Rechazar**;
  - un **recorrido**, una **secuencia** o una **regla**: sus pasos o lo que hace, con los mismos textos que «Propuestas» (`server/modules/mcp-proposals/preview.mjs`);
  - una **respuesta del conocimiento**: pregunta, variantes, respuesta, tema y curso;
  - una **apertura**, un **curso**, una **promoción**, un **texto**, una **plantilla de WhatsApp**, una **difusión**, un **segmento**, el **mensaje de accesos**, un **curso en borrador** o una **imagen**: sus datos tal como quedaron (y la imagen, servida con sesión desde la biblioteca de la marca);
  - una **consulta** o una **acción rechazada**: qué pasó y por qué, sin más (una consulta no cambia nada).
  - Si lo que dejó tiene una propuesta pendiente, la tarjeta lo dice y la abre con un botón. «Abrir en …» lleva a su pantalla.
- **Creado por el asistente** (a un lado, arriba de la tarjeta; en celular va primero y plegado): una entrada por cada cosa que el asistente dejó y sigue existiendo (recorridos, secuencias, reglas, respuestas, cursos en borrador, textos…), agrupadas por tipo, con su estado, cuándo la tocó por última vez y si tiene una propuesta pendiente. Tocar una abre su tarjeta. Sale de `mcp_activity`: cada entidad distinta de las escrituras que salieron bien (`GET /api/mcp-live/created`).
- **El recorrido como diagrama**: la tarjeta de un recorrido dibuja sus pasos en columnas por profundidad desde el Inicio, con el tipo, el título y un texto corto de cada uno y las flechas con el nombre de la salida («Sí, inscribirme», «Ninguno»…), en los colores de Tinta por clase de paso; «Ver grande» lo abre en una ventana ancha. Cuando el asistente vuelve a guardar el recorrido que está abierto, la tarjeta se redibuja sola y los pasos nuevos entran resaltados: así se ve armarse. Sólo los pasos que se alcanzan desde el Inicio; un grafo de más de 60 pasos se recorta y lo dice. Función pura `flowDiagram` en `server/modules/mcp-live/preview.mjs`.
- **En vivo**: por cada herramienta que ejecuta el conector, `mcp-activity` emite `mcp_activity.recorded` (sólo a quien puede ver esa marca; carga: el id de la fila). La pantalla pide sólo lo más nuevo (`after=<id>`) y lo pone arriba con una entrada animada; suma a las cifras. Un cambio de propuestas (`mcp_proposals.changed`) recarga sólo las propuestas.
- **Pausar** retiene lo nuevo (se cuenta: «3 acciones nuevas retenidas · Reanudar») hasta reanudar.
- **Proyectar**: la página en tinta, a pantalla completa, sin cifras ni filtros y con letra más grande, para enseñarla en una demo (se sale con el botón o con Escape).

## Dónde vive

| Pieza | Archivo |
| --- | --- |
| Módulo del servidor | `server/modules/mcp-live/module.mjs` (rutas) y `preview.mjs` (lectura de cada entidad) |
| Agrupar en sesiones y contar por clase (puro, compartido) | `public/kit/shared/live-sessions.js` |
| Pantalla | `public/screens/asistente-en-vivo/` (`screen.json`, `index.js`, `screen.css`, prefijo `av-`) |
| Aviso en vivo y lectura reusable de la actividad | `server/modules/mcp-activity/module.mjs` (`record()` emite; `query()` es la misma lectura que `GET /api/mcp-activity`, con `after`) |
| Propuestas reusables | `server/modules/mcp-proposals/module.mjs` expone `overview` |
| Pruebas | `test/mcp-live.test.mjs` (sesiones, aviso en vivo, punta a punta) y `test/ui/asistente-en-vivo.spec.mjs` (computadora y celular, Niebla) |

Rutas, sólo con sesión del equipo (ver la actividad pide administrar las llaves de la marca, como «Asistentes conectados»; una petición con llave o ficha responde 403):

```text
GET /api/mcp-live?brand=&after=&limit=     actividad plana (la pantalla la agrupa), cifras de 24 h, marcas, conexiones, propuestas
GET /api/mcp-live/created?brand=            lo que dejó el asistente y sigue existiendo (una entrada por entidad)
GET /api/mcp-live/proposals?brand=          sólo las propuestas (pendientes e historial)
GET /api/mcp-live/entity/:type/:id?brand=   lo que dejó una acción (404 si ya no existe o no se puede mostrar)
```

Sin esquema nuevo: todo sale de `mcp_activity`, `mcp_proposals` y las tablas de cada módulo.

## Cuidados

- **El conector no puede aprobar ni leer esta pantalla.** No hay ninguna herramienta para ello; las rutas rechazan llaves y fichas; aprobar y rechazar siguen siendo `POST /api/mcp-proposals/:id/approve|reject`, con los permisos de quien aprueba y los avisos que vio (`warningsSeen`).
- **La actividad sigue sin guardar argumentos ni texto libre.** La tarjeta se arma leyendo la entidad resultante, nunca lo que el asistente escribió en su conversación. Todo lo que se muestra es texto plano y la plantilla lo escapa: los textos de un recorrido, una respuesta o una nota pudo escribirlos el asistente y son datos, no instrucciones.
- **Alcance por marca** en cada ruta: otra marca responde 404; la asesora de otra marca no ve nada.
- Las dos reglas del dueño: no se perdió ninguna opción (Actividad y Propuestas siguen donde estaban; aquí se juntan) y no se inventó ninguna (sólo se muestra lo que ya existe).

## Qué sigue

- Avisar con un punto en el menú cuando llega una propuesta nueva mientras se está en otra pantalla.
- Un resumen por sesión en palabras («Claude revisó el catálogo y dejó 3 borradores de conocimiento»), armado por reglas con los mismos textos.
- Probarlo en producción con la aplicación real de Claude (OAuth): la actividad por OAuth ya sale con el nombre de la aplicación.
