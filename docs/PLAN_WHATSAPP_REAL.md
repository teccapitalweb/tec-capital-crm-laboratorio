# WhatsApp real · Meta Cloud API (11 nov 2026)

**Esquema 38.** Publicado en `main` (apagado hasta poner las variables de Meta en Railway). Guía para encenderlo: [ACTIVAR_WHATSAPP_REAL.md](ACTIVAR_WHATSAPP_REAL.md).

## Para qué

Hasta ahora WhatsApp era un canal simulado: sólo escribían perfiles de prueba creados en la app. Con este bloque, lo que una persona escribe a un **número real de WhatsApp** de la empresa entra a la Bandeja como una conversación más, el asistente (reglas → conocimiento → Claude) o el equipo le responden por la **API de Meta**, y puede terminar su compra con la pasarela de prueba sin crear un perfil.

Está **apagado por omisión**. Se enciende con `CHANNEL_CONNECTOR=meta` y las variables de Meta en el entorno; sin ellas todo sigue como antes.

## Cómo conviven lo real y el laboratorio

Una conversación es **real** cuando tiene `wa_number` (el número de la empresa que recibió el mensaje) y `wa_peer` (el WhatsApp de la persona). Las demás son del laboratorio.

| | Conversación del laboratorio | Conversación real |
| --- | --- | --- |
| Quién escribe | Un perfil de prueba, desde la app | Una persona, desde su WhatsApp |
| Salida de mensajes | Simulada (canal simulado de la marca) | API de Meta, siempre |
| Estados | Simulados | Los que avisa Meta: enviado, entregado, leído, no entregado |
| Ventana de 24 h | Sólo si la marca enciende el canal simulado | Siempre (es regla de Meta) |
| Pago | Con sesión | Sin sesión, sólo su pedido |

Aunque Meta esté activo, **ningún mensaje del laboratorio viaja a Meta**. Y una conversación real con Meta apagado o incompleto **falla con un motivo claro**: nunca se marca «entregado» de mentira.

## Qué hace

**Entrantes** (`POST /api/webhooks/channel/meta`, firma `X-Hub-Signature-256`):

1. El número que recibió el mensaje decide la **marca** (`wa_numbers`). Un número sin marca asignada se ignora y la bitácora lo dice.
2. La persona (`wa_id`) se convierte en **cliente** (`wa_identities` → `users`). Es el mismo cliente aunque escriba a varias marcas; cada marca tiene su propio contacto, con el teléfono.
3. Continúa su conversación abierta con ese número o se abre una nueva en el **curso por omisión** del número (si no tiene fechas disponibles, el primero de la marca que sí).
4. El mensaje entra por el mismo camino que el de un perfil de prueba: respuestas automáticas, comprobante si hay un pedido vigente, memoria, resumen, seguimiento.
5. Imágenes (PNG, JPG, WEBP) y PDF se descargan de Meta y quedan como adjuntos privados del chat. Audios, videos y stickers todavía no se abren: queda una nota para el equipo y el asistente pide que lo escriban (texto fijo, sin gastar una consulta).

**Salientes**: cada mensaje del asistente o del equipo en una conversación real sale por `POST /{número}/messages`: texto, hasta tres botones de respuesta, imagen o documento (se sube primero a Meta). Los mensajes de una misma conversación salen **en orden** y nunca dos veces.

**Orden de los mensajes después de un archivo** (21 nov 2026). En una prueba real con un teléfono, un recorrido dijo saludo → ficha del curso (imagen con pie) → botones, y llegaron el saludo, los botones y **después** la imagen: Meta aceptó los tres en orden (salen en serie, esperando su respuesta, y la imagen se sube antes de enviarse), pero WhatsApp entrega más tarde un mensaje con archivo que uno de texto enviado justo detrás. Regla: el orden en que el recorrido o el asistente dicen las cosas es el orden en que deben llegar. Por eso, cuando Meta acepta un mensaje cuyo último envío fue un archivo (imagen o documento, también el encabezado con archivo de una plantilla), el canal anota en ese mensaje `messages.wa_gap_until` (migración con nombre `messages/0002-media-gap`) y el siguiente mensaje de **esa** conversación no sale hasta que pase el margen o hasta que llegue el estado «entregado» (o leído, o no entregado) del archivo, lo que ocurra antes. Lo que ya estaba tomado en el mismo lote se suelta sin enviarse (sin contarlo como intento); un envío en duda conserva su marca: el que no se repite (una plantilla) queda no entregado sin llamar a Meta, y el que se reintenta guarda su marca vencida y su intento, y deja su único rastro «lease_expired» cuando de verdad se reenvía y lo vuelve a tomar el reloj del canal (cada 0,5 s). No se duerme en ninguna transacción ni se detiene a las demás conversaciones; y como el margen vive en la base, se respeta tras un reinicio. Un mismo mensaje del CRM que Meta recibe en dos partes (archivo y, aparte, su texto largo o sus botones) espera el mismo margen entre las dos partes dentro del envío. Un margen más lejano que ahora más el máximo (el reloj del servidor se atrasó) se da por vencido, y `wa_gap_until` no sale por la API de mensajes. Variable `WA_MEDIA_GAP_MS` (milisegundos, de 0 a 30000; por omisión **2500**; con `NODE_ENV=test`, 0). El canal simulado del laboratorio no cambia. Pruebas: `test/whatsapp-media-order.test.mjs`.

**Archivo con botones en un solo mensaje** (21 nov 2026, segunda prueba real). La ficha que manda el asistente por su cuenta (al reconocer o cambiar el curso: texto, imagen aprobada del curso y los botones Precio, Temario y Fechas) es **un** mensaje del CRM, pero el adaptador de Meta lo partía en dos: la imagen sin pie y, justo después, el texto con sus botones, y en el teléfono llegó primero el texto. Ahora, cuando un mensaje lleva una imagen JPEG o PNG y botones y el texto cabe en el cuerpo de un interactivo (hasta 1024 caracteres), sale como **un solo mensaje interactivo con la imagen de encabezado** (`interactive.header` de tipo `image`). Vale igual para el paso Botones de un recorrido con encabezado de imagen o con la ficha vigente del curso. Si Meta rechaza ese interactivo por otra cosa que la autenticación, un permiso, el ritmo o la ventana de 24 horas (y no un error de red, en el que no se sabe si salió), se manda **una vez** como antes: la imagen y, tras el margen, el texto con sus botones. Un PDF, WebP, GIF u otro tipo nunca va de encabezado: sale en dos partes como siempre. Si el texto pasa de 1024 caracteres, sale el archivo, el texto y al final un interactivo corto con los botones y el cuerpo fijo «¿Qué te gustaría hacer?» (`BUTTONS_PROMPT` de `server/reply-copy.mjs`): antes los botones se perdían sin aviso; lo mismo sin archivo. Los títulos de botón se recortan a 20 sin partir un emoji. El CRM guarda lo mismo de siempre (un mensaje con su ficha y sus botones) y el laboratorio no cambia de aspecto. Pruebas: el adaptador y la ficha del asistente de punta a punta con el Meta de mentira, en `test/whatsapp-media-order.test.mjs`.

**Estados**: Meta avisa entregado, leído o no entregado y el mensaje avanza. Los rechazos se explican en español (`explainMeta`): token vencido, número fuera de la lista de prueba, ventana de 24 h, cuenta sin método de pago, etcétera.

**Pago sin sesión**: el enlace `/?pay=<pedido>` de un pedido de una conversación real abre la pasarela de prueba sin pedir perfil (`/api/pay/<pedido>/customer` y `/pay`). Sólo ese pedido; los del laboratorio siguen pidiendo sesión. La confirmación del pago sale por WhatsApp.

**Administración** (Operación → Sistema → Conectores → «WhatsApp real · Meta», sólo administración): estado, qué falta, **Probar conexión con Meta** (lee el número sin enviar nada), la URL del webhook y los **números por marca** (asignar, editar, pausar). En el chat, la conversación real muestra el número de la persona y «número real», y se puede buscar por teléfono.

## Datos (esquema 38)

- `wa_numbers(phone_number_id, brand_id, course_id, label, enabled, revision…)`: número → marca y curso por omisión. Sin secretos.
- `wa_identities(wa_id, user_id, profile_name…)`: persona → cliente.
- `conversations.wa_number`, `conversations.wa_peer`.
- En mensajes reales, `provider_ref` es la referencia de Meta (`wamid…`); `provider_ref IS NULL` significa «todavía no ha salido».

Las tres quedan vacías hasta que alguien escribe a un número real: migrar no cambia ningún dato existente.

## Variables de entorno

| Variable | Obligatoria | Para qué |
| --- | --- | --- |
| `CHANNEL_CONNECTOR=meta` | Sí | Enciende WhatsApp real |
| `META_ACCESS_TOKEN` | Sí | Token de Meta (secreto) |
| `META_APP_SECRET` | Sí | Verifica la firma de los webhooks (secreto) |
| `META_VERIFY_TOKEN` | Sí | Palabra que elegimos; Meta la repite al registrar el webhook |
| `META_PHONE_NUMBER_ID` | Sí | Identificador del primer número |
| `META_WABA_ID` | No | Hará falta para las plantillas aprobadas |
| `META_GRAPH_VERSION` | No | Versión de la API; por omisión `v25.0` |
| `WA_MEDIA_GAP_MS` | No | Margen tras un archivo antes del siguiente mensaje de la conversación; por omisión `2500`, `0` lo apaga |

`META_GRAPH_URL` sólo existe para las pruebas (un Meta de mentira) y **se ignora en producción**: el token únicamente viaja a `graph.facebook.com`, y los archivos sólo se descargan de servidores de Meta. «Producción» es `NODE_ENV=production`, que ya fija el `Dockerfile`; no hay que cambiarlo en Railway.

## Cuidados

- **Secretos**: el token y el secreto de la app viven sólo en el entorno. Ninguna pantalla ni respuesta los muestra; los errores de red no los repiten; un token con espacios u otra variable pegada se rechaza antes de salir.
- **Firma**: todo webhook se verifica con el cuerpo crudo antes de leerlo. Sin firma válida, 401.
- **Sin duplicados**: cada evento se aplica una vez por identificador, y el mensaje lleva `client_ref = meta:<wamid>` como segunda barrera. Si un entrante falla por un error inesperado **no** se marca como procesado y Meta lo reintenta.
- **Datos personales**: la bitácora de conectores guarda sólo metadatos del entrante (ni el texto ni el número completo). El usuario interno del cliente no lleva el teléfono; vive en el contacto de la marca y en la conversación. La persona no puede iniciar sesión: su contraseña es aleatoria y no la conoce nadie.
- **Alcance por marca**: el número decide la marca; los archivos sólo los ve el equipo de esa marca.
- **Red fuera de transacciones**: descargas, subidas y envíos ocurren fuera de la transacción de SQLite.
- **Límites detrás del proxy**: en Railway todas las peticiones llegan desde la misma IP, así que el webhook se limita por proveedor **después** de comprobar la firma (una avalancha sin firma no bloquea a Meta) y el pago sin sesión se limita por pedido.
- **Entrantes que no pueden entrar**: con `CHANNEL_CONNECTOR=meta` pero faltando datos, el webhook responde 503 y Meta reintenta. Con WhatsApp real apagado, el mensaje sólo se anota (sin texto ni número) y no entra.
- **Envío en dos partes** (archivo + texto de más de 1024 caracteres): si el archivo salió y el texto no, el mensaje queda enviado con la nota en su historial de entrega; no se marca fallido porque reintentarlo duplicaría el archivo.
- **Cambiar un número de marca**: no se permite mientras tenga conversaciones abiertas; y un entrante sólo continúa una conversación de la marca del número.
- **Persona única**: el teléfono del contacto pasa por el mismo enlace de persona que una edición desde el CRM.
- **México**: Meta entrega `521XXXXXXXXXX`; si al responder dice «no está en la lista de destinatarios» (número de prueba), se reintenta una sola vez como `52XXXXXXXXXX`.

## Lo que se aprendió al conectar con Meta de verdad (12 nov 2026)

- Una app **sin publicar** sólo recibe los webhooks de prueba del panel de Meta. Publicarla pide una URL de política de privacidad ([PLAN_AVISO_PRIVACIDAD.md](PLAN_AVISO_PRIVACIDAD.md)).
- Aun publicada y con el webhook verificado, Meta **no entrega** los mensajes reales si la app no está suscrita a la cuenta de WhatsApp Business (`POST /<WABA>/subscribed_apps`). Se detectó en los registros HTTP de Railway: Meta mostraba los mensajes en su panel y el servidor no recibía ninguna llamada. El botón **Recibir mensajes reales** de Conectores hace esa suscripción, y «Probar conexión con Meta» informa si existe.
- Los webhooks llegan en la versión v27.0 y ya contemplan personas con nombre de usuario y sin teléfono visible (BSUID); el CRM identifica por número y habrá que adaptarlo.

## Límites de esta primera versión

- **Fuera de las 24 horas sólo salen plantillas aprobadas por Meta** ([PLAN_PLANTILLAS_WHATSAPP.md](PLAN_PLANTILLAS_WHATSAPP.md), publicado). Con la ventana cerrada, el texto libre del equipo se rechaza al momento (409) y el chat ofrece «Enviar plantilla». Los avisos del negocio (confirmación de pago, certificado, recordatorio, seguimiento, campaña) **sí se guardan** —un pago nunca falla por esto—: con una plantilla de aviso aprobada quedan en espera hasta que la persona responde; sin ella, «no entregados» con el motivo.
- Sólo WhatsApp. Instagram y Messenger siguen simulados.
- Un solo token para todos los números. Consultoras con cuentas de Meta distintas necesitarán un token por cuenta.
- Audios, videos y stickers no se abren en el CRM. Las reacciones se ignoran.
- No se marca «leído» en el WhatsApp de la persona cuando el equipo lee.
- Los flyers generados como SVG no se envían como imagen (sólo su texto); los PNG y JPG sí.
- El pago sigue siendo la pasarela de prueba: no se cobra nada.
- **No se ha probado contra Meta de verdad.** Todo se verificó con una API de Meta simulada; falta la prueba con un número de prueba real.

## Verificación

- `test/whatsapp-real.test.mjs` (3 pruebas), con un Meta de mentira: errores en español, token mal pegado, texto/botones/archivos; flujo completo (número sin marca, asignación, cliente y conversación nuevos, respuesta del asistente por la API, estados, duplicados, firma falsa, audio, imagen descargada, respuesta del equipo con archivo, rechazo y reintento, ventana de 24 h, reintento de México, venta con pago sin sesión, laboratorio intacto, segunda marca, pausa); y apagado por omisión.
- Suite completa: 202 pruebas.
- Revisión independiente del código (seguridad, entrega, integridad): cuatro fallos corregidos (límites detrás del proxy, entrantes perdidos con Meta incompleto, duplicado al reintentar un envío parcial, número que cambia de marca con conversaciones abiertas) y uno probable (teléfono sin enlace de persona). Cada uno con su prueba.
- En el navegador, con servidor local y Meta simulado: panel de Conectores (prueba de conexión y asignación), conversación real en la Bandeja, y pago sin sesión a tamaño de celular.

## Pendiente

1. Probar con el número de prueba de Meta en producción ([guía](ACTIVAR_WHATSAPP_REAL.md)).
2. Plantillas aprobadas por Meta: publicadas; falta probarlas con Meta.
3. Audios (reproducirlos o transcribirlos).
4. Instagram y Messenger.
5. Token por cuenta de Meta cuando haya consultoras con Business Manager propio.
