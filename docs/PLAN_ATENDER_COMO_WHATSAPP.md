# Atender como en WhatsApp: materiales a un toque, responder citando, menú plegable y velocidad

**Estado:** **publicado en `main` el 27 nov 2026** (commit `dfcf248`; comprobado sin sesión: la portada servida trae la hoja y los dos tramos con caché inmutable y gzip, `/crm` 200, `/` 200, `/mcp` 401, `/api/health` ok; falta probar la cita en WhatsApp real). Sin esquema, rutas ni permisos nuevos (el envío de mensajes acepta un campo más; la portada se sirve empaquetada).

## Por qué

El 26 nov 2026 una vendedora de una consultora usó el CRM para vender y contó qué le costó:

- **Compartir el temario, el precio o el flyer** llevaba demasiados pasos: tocar «Temario» abría la biblioteca, había que elegir en una lista desplegable, «Previsualizar antes de enviar» y después «Enviar material al chat». Cuando tocaba el botón «y no lo encontraba» se perdía.
- **Contestar a un mensaje concreto** como en WhatsApp (deslizar a un lado para responder citando) no existía: una conversación larga se volvía ambigua.
- **La página iba lenta** al abrir y al cambiar de pantalla.
- Quería **recoger el menú lateral** y dejar sólo los iconos para tener más espacio.
- Lo de **«Cobrar»** también lo quería distinto, pero todavía no dijo qué (pendiente de preguntar).

Reglas del dueño respetadas: **no se pierde ninguna opción y no se inventa ninguna**. La biblioteca completa sigue ahí («Elegir otro»), el precio y la vigencia se siguen comprobando al enviar, y «Fechas» sólo saca a la fila una opción que ya existía dentro de la biblioteca.

## Qué hace

### 1. Materiales a un toque

En el chat del equipo, los chips **Flyer · Temario · Precio · Fechas** piden la vista previa de ese material al instante y la pintan **debajo de las herramientas**, en una tarjeta del color del chip (ficha con imagen, temario, precio, fecha y docente), con el curso y la edición, el texto tal como saldrá, la imagen si la lleva (o «Abrir PDF adjunto») y un solo botón **Enviar**. «Elegir otro» abre la biblioteca de siempre con ese material preseleccionado (plantillas aprobadas y flyers vigentes), y «×» quita la tarjeta sin enviar. Es exactamente el previsualizar/enviar de la biblioteca (`/materials/preview` y `/materials/send`, con el mismo `previewToken`): si el precio o la vigencia cambian entre la vista previa y el envío, el envío se rechaza y la tarjeta lo dice. La tarjeta sobrevive a que el chat se repinte (llega un mensaje) y se va al cambiar de conversación o al enviar.

### 2. Responder citando

- **Computadora:** al pasar el cursor por un mensaje aparece el botón **Responder** al lado del globo (con el teclado, al enfocarlo).
- **Celular:** se **desliza el mensaje a la derecha**, como en la app de mensajería (72 px de recorrido, se dispara a partir de 56; un gesto vertical no cuenta).
- Arriba del cuadro de escribir queda la franja **«Respondiendo a …»** con el principio del mensaje y un «×» para quitarla. Al enviar, el globo lleva la **cita** arriba del texto (quién lo dijo y qué), y tocar la cita lleva al mensaje citado y lo resalta un momento (si no está cargado, lo dice).
- El cliente del laboratorio también ve la cita en su chat de prueba.
- **WhatsApp real:** la respuesta sale a Meta con `context.message_id` (la referencia del mensaje citado), así que la persona la ve citada en su teléfono; sólo cuando el CRM conoce esa referencia (un mensaje que entró o salió por Meta). Los mensajes que la persona cita ya se guardaban (`messages.reply_to_id`, contrato del canal 1.1) y ahora también se pintan.
- Sólo el equipo responde citando; un mensaje del sistema no se cita; una cita a un mensaje de otra conversación responde 400.

### 3. Menú plegable

Junto al botón del tema del menú hay uno nuevo para **plegar el menú a iconos** (y volver a abrirlo). Es el mismo menú de iconos que ya salía solo por debajo de 850 px: cada botón conserva su nombre en `title`, los grupos siguen abriendo y cerrando (su título queda como una línea corta) y el contador de Operación se monta sobre el icono. Se recuerda en el navegador (`tc-menu-compact`). En celular el botón no aparece.

### 4. Velocidad: un solo paquete

La portada cargaba **42 archivos de JavaScript y 13 hojas de estilo**, cada uno con su ida y vuelta al servidor y con `no-cache` (el navegador preguntaba por los 55 en cada carga). Desde México cada ida y vuelta cuesta entre 0,3 y 0,5 s, y el navegador sólo abre seis a la vez. Ahora `server/app/static.mjs` arma, a partir de las etiquetas de `public/index.html` (que sigue siendo la lista de verdad), **una sola hoja de estilos y el JavaScript en dos tramos** (los 41 archivos de antes del módulo del kit y `app.js`, que va después de él y lo necesita así), con el hash de su contenido en el nombre (`/paquete/estilos.<hash>.css`, `/paquete/app.<hash>.js`), caché larga e inmutable (`max-age` de un año) y gzip ya calculado. Tras un despliegue cambia el nombre, nunca el contenido de un nombre, así que no hay riesgo de quedarse con una versión vieja. El módulo ES del kit (`/kit/boot.js`) y lo que cargan las pantallas nuevas siguen aparte, con `no-cache` + ETag como antes. En desarrollo el paquete se rearma solo cuando cambia alguna parte. Se apaga con `STATIC_BUNDLE=0`.

Medido en local con un script que baja la portada y todo lo que enlaza, en serie, calentando primero (`scratchpad/medir-carga.mjs`, fuera del repo):

| | Peticiones | Tiempo en serie, local | Tiempo en serie con 120 ms de ida y vuelta por petición |
| --- | --- | --- | --- |
| Sin paquete | 56 | 0,72 s | 7,7 s |
| Con paquete | 5 | 0,05 s | 0,57 s |

Un navegador real baja seis a la vez, así que el tiempo que ve la persona es menor que el de la tabla, pero la proporción se mantiene. Los bytes son los mismos (1,7 MB sin comprimir; el JavaScript baja de 1,28 MB a 321 KB con gzip).

### De paso

La insignia de canal (`.provider`) tenía sólo un degradado como fondo; ahora lleva además un color sólido debajo, así la auditoría de contraste la mide y se ve igual sin imágenes. Era la falla de contraste tolerada en la línea base de `escritorio:inbox-chat`.

## Dónde vive

| Pieza | Archivo |
| --- | --- |
| Materiales a un toque (vista previa en línea, enviar, elegir otro) | `public/catalogue.js` (`quickMaterial`, `renderQuick`, acciones `cat-quick*`); el hueco `#conv-material` en el chat de `public/app.js` |
| Responder citando (franja, botón, deslizar, cita, ir al mensaje) | `public/app.js` (`replyDraft`, `quoteOf`, `replyBar`, `startReply`, acciones `msg-reply*`, `msg-jump`, los `touch*`) |
| Servidor: el campo `replyToId` y la cita en la lista | `server/index.mjs` (POST `/api/conversations/:id/messages`, `messageList` → `quoted`) |
| WhatsApp real: `context` de Meta | `server/whatsapp.mjs` (`outbound` → `replyTo`), `server/connectors.mjs` (`send` → `context.message_id` en la primera parte) |
| Menú plegable | `public/app.js` (`menuCompact`, `toggleMenuCompact`), `public/tinta-vistas.css` sección 14 |
| Estilos del chat | `public/tinta-atencion.css` (al final) y `public/styles.css` (la cita en el chat del cliente) |
| Paquete de la portada | `server/app/static.mjs` (`packaged`, rutas `/paquete/…`), `server/index.mjs` (`bundle`) |
| Pruebas | `test/static.test.mjs`, `test/whatsapp-real.test.mjs`, `test/ui/atender-whatsapp.spec.mjs`, `test/ui/atencion.spec.mjs` |

```text
POST /api/conversations/:id/messages   acepta replyToId (un mensaje de la misma conversación; si no, 400)
GET  /api/conversations/:id/messages   cada mensaje trae quoted: {id, text, senderKind, senderName} o null
GET  /paquete/app.<hash>.js            el JavaScript de la portada, inmutable, gzip si se acepta
GET  /paquete/estilos.<hash>.css       las hojas de estilo de la portada, igual
```

## Cuidados

- El texto citado que viaja en `quoted` es un resumen (240 caracteres) del mensaje tal como está en la conversación: nada que la persona no pudiera ver ya.
- El `context` sólo sale si el CRM tiene la referencia de Meta del mensaje citado; si no, el mensaje sale sin cita y no falla.
- El paquete concatena los scripts clásicos en el mismo orden de la portada, con `;` entre uno y otro; un `<script type="module">` parte el paquete en tramos y se queda en su sitio (así `app.js` sigue corriendo después de `kit/boot.js`, que crea `window.TC`). Hoistea los `@import` (la hoja de la fuente lleva `;` dentro de la URL: se toma la línea entera). Una ruta `/paquete/…` que no sea un paquete armado responde 404, aunque exista un archivo con ese nombre en `public/`.
- `STATIC_BUNDLE=0` deja la portada como está, por si hace falta comparar.

## Qué sigue

- **Cobrar:** preguntar a la vendedora qué le costó o qué querían cambiar antes de tocarlo.
- Repintar sólo el mensaje nuevo en Conversaciones en lugar de todo el chat cuando llega algo (hoy `renderChat` repinta el historial conservando desplazamiento y foco).
- Probar «Responder» con WhatsApp real: que la cita se vea en el teléfono.
