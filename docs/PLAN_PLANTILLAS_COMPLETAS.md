# Plantillas completas de WhatsApp (D-3)

Estado: construido en la rama de integración, **sin publicar** y **sin esquema nuevo**. Continúa [PLAN_PLANTILLAS_WHATSAPP.md](PLAN_PLANTILLAS_WHATSAPP.md) (sólo cuerpo) sobre la tabla `wa_templates` que reconstruyó `broadcasts/0001-foundations` ([PLAN_CIMIENTOS_DIFUSIONES.md](PLAN_CIMIENTOS_DIFUSIONES.md)). Fuente: diseño de difusiones §6 adaptado a la conciliación técnica (filas 2, 3, 13, 28, 36, 38, 44, 45 y D-3), que manda.

## Qué hace

- **Plantilla completa**: encabezado (texto con un dato, imagen JPG/PNG o documento PDF), cuerpo con hasta 10 datos y su muestra y respaldo (`{{nombre|Hola}}`), pie y hasta 10 botones (respuesta rápida, enlace con un dato al final, teléfono). Validaciones de Meta (§6.4): longitudes, número y tipo de botones, respuestas rápidas juntas, datos consecutivos, ejemplos obligatorios al enviar, y avisos (utilidad con lenguaje promocional, marketing sin pie de baja, más de tres botones).
- **Enviar a aprobación**: la muestra del encabezado se sube a Meta por sesión (`META_APP_ID`) y viaja el JSON completo; una de sólo cuerpo viaja exactamente igual que antes. Una **rechazada** se corrige en el CRM y vuelve como corrección (`POST /{id}`), no como alta. Tope de 100 envíos por hora y límite de plantillas de la cuenta (`wa_account.template_limit`, 250 por omisión) en lugar del tope fijo de 200.
- **Sincronizar** lee **todas** las páginas de Meta (red fuera de la transacción) y después aplica estado, motivo, calidad y categoría en una sola transacción; lo que existe en Meta y el CRM no usa queda en `wa_account.remote_cache`.
- **Adopción por lote**: `POST …/adopt {brandId, items:[{name, language, variables?}]}` hasta 100 por vez; la lista remota se pide por páginas (`GET …/remote?offset&limit`). Idempotente: lo que ya está vuelve en `existing`, no se duplica. Lo que el CRM no puede enviar (autenticación, carrusel, oferta por tiempo, catálogo, ubicación) vuelve en `skipped` con su motivo. Una adoptada sin indicar qué dato llena cada variable queda «falta indicar sus datos» y no se ofrece en el chat hasta completarla (`PATCH {variables}`).
- **Por cuenta**: cada plantilla tiene su `waba_id`; la unicidad es `(waba_id, name, language)`. Las filas de antes (`waba_id=''`) cuentan como de la cuenta vigente hasta que la sincronización o el envío a revisión se la asignan. Dos cuentas con el mismo nombre no chocan.
- **Avisos de Meta** (`template.update`, oyente `connectors.on`): estado (`REINSTATED` → aprobada), calidad y cambio de categoría (con `prev_category` y «Enterado»). Eventos de dominio `plantilla.estado`, `plantilla.calidad`, `plantilla.categoria` y aviso en vivo `templates.changed`.
- **Editar** el contenido sólo de borradores y rechazadas (`expectedRevision`); en cualquier estado, el uso (manual o aviso) y la fuente, muestra y respaldo de cada dato. **Duplicar** (también a otra marca, sin el archivo de muestra), **dar de baja** (un borrador nunca enviado se borra; lo demás queda con `archived_at`), **restaurar**, y borrar también en Meta (`?meta=1`, administración).
- **Desde el chat**: «Enviar plantilla» ofrece las aprobadas de la marca cuyos datos puede llenar la conversación; sale con su imagen o documento (se sube al número al enviar), los datos del encabezado y del enlace, y una carga por cada respuesta rápida (`tpl:<id>:<n>`). La pulsación de la persona llega como `interaction` y queda en `messages.reply`.

## Piezas

| Pieza | Qué es |
| --- | --- |
| `server/modules/wa-templates/` | `module.mjs` (rutas, avisos, chat, adopción), `repo.mjs` (todo el SQL), `definition.mjs` (forma canónica, validación, conversión con Meta; sin base ni red) |
| `server/whatsapp.mjs` | Ya no lleva plantillas: delega `/api/whatsapp/templates*` y `/api/conversations/:id/wa-templates` en el módulo (`useTemplates`), y le pide lo que sale a Meta (`forSend`) y el aviso del negocio (`noticeFor`, `ensureNotice`) |
| `server/connectors.mjs` | Adaptador de Meta: envío con encabezado y botones, `listTemplatesPage`/`listTemplates` sin tope, `createTemplate` con encabezado, pie y botones, `editTemplate`, `deleteTemplate`, `uploadSample` |
| `server/lib/upload.mjs`, `media-sniff.mjs`, `media-limits.mjs` | Subida única (filas 44 y 45): tipo real por la firma del archivo, tamaño por clase y uso (encabezado 4 MB), nombre seguro, `DATA_DIR/library/<marca>/<uuid>.<ext>` y entrega con sesión (`nosniff`, `sandbox`). Imagen y documento |
| `public/screens/plantillas/` | Pantalla en vista previa (Gestión, `file-text`, orden 45, `templates.manage`): lista por páginas con estado, categoría, calidad e idioma; editor con vista previa en burbuja neutra; subir encabezado; sincronizar y adoptar; duplicar; baja y restaurar |

Forma canónica (`wa_templates.components`): `{type:'standard', header:{type:'none'|'text'|'image'|'document', text?, vars?, fileId?, filename?, mime?}, body:{text, vars:[{key, sample, fallback}]}, footer:{text}|null, buttons:[{type:'quick_reply', text} | {type:'url', text, url, var} | {type:'phone', text, phone} | {type:'copy_code', code} | {type:'flow', text}]}`. `body` y `variables` se siguen escribiendo para los lectores de antes. Fuentes de los datos: las del chat (`nombre`, `curso`, `edicion`, `marca`) y las propias (`fijo.<n>`, `llamada.<n>`, `cupon`), con la gramática y la numeración de `server/lib/variables.mjs`.

Rutas nuevas: `GET …/templates/:id`, `POST …/validate`, `…/:id/duplicate`, `…/:id/ack`, `…/:id/restore`, `GET …/remote`, `POST /api/wa-templates/files`, `GET /api/wa-templates/files/:id`. Las publicadas conservan su forma (la lista acepta además `brand, q, status, category, language, archived, limit, offset`).

## Decisiones donde el diseño era ambiguo

- **Módulo y rutas**: el diseño pedía `server/wa-templates.mjs` cableado en `index.mjs`; se hizo como módulo (`server/modules/wa-templates/`, fila 2). Como el módulo se crea después de `whatsapp`, éste lo recibe con `useTemplates()`; si el módulo no cargara, las rutas de plantillas responden 503 y lo demás de WhatsApp sigue.
- **Sin migración**: todo cabe en las columnas que ya creó D-1. No hay `wa_media_cache` (el archivo del encabezado se sube al número en cada envío del chat; la caché de 30 días es de D-5) ni columna de `clientRef`: altas, copias y subidas repetidas se reconocen en memoria (una instancia).
- **Adoptar con la forma de siempre** (una sola, con `variables`) sigue rechazando con 400 las que llevan archivo o datos fuera del cuerpo, como esperaba la prueba publicada: esa forma adopta para el chat. Las complejas se adoptan por lote.
- **Datos vacíos del chat** siguen saliendo como «—» (como antes); un dato propio sin valor ni respaldo impide ofrecer la plantilla en el chat.
- **El archivo de muestra** es un archivo de la biblioteca de la marca (`library_files`), así también se puede elegir uno que ya exista.
- `test/channel-contract.test.mjs`: cambia una expectativa a propósito; el aviso de plantilla ya no es «todavía nada lo atiende» sino «plantilla que el CRM no usa».

## Sin verificar contra Meta real (diseño §15)

1. Subida por sesión de la muestra (`/{META_APP_ID}/uploads` y el envío de bytes con `OAuth` y `file_offset`) — n.º 4.
2. Corrección de una rechazada con `POST /{id}` — n.º 5.
3. Borrado con `DELETE /{WABA}/message_templates?name=&hsm_id=` — n.º 6.
4. Forma exacta de `message_template_status_update`, `message_template_quality_update` y `template_category_update` (y que la app esté suscrita a esos campos) — n.º 7. Mientras tanto vale «Sincronizar con Meta».
5. Formato de `example` de un botón de enlace con dato — n.º 13.
6. Envío con encabezado de imagen o documento por identificador de archivo, parámetros de botón (`url`, `quick_reply` con carga) y que la carga vuelva en `button.payload` — n.º 3.
7. `quality_score` en la lista de plantillas y los nombres de los campos de paginación con cuentas grandes (124 plantillas reales).

Todo se probó con el Meta de mentira (`test/helpers/fake-meta.mjs`, ampliado con plantillas por cuenta, páginas, altas, correcciones, borrados y subidas).

## Pruebas

`test/wa-templates.test.mjs` (definición y validaciones; de punta a punta: subida y archivo falso, crear con imagen y botones, enviar a aprobación con la muestra, aprobación, rechazo, corrección, calidad, categoría y pausa por aviso, envío desde el chat con encabezado y botón, pulsación como `interaction`, 250 plantillas remotas adoptadas por páginas e idempotente, dos cuentas, permisos y alcance por marca, baja, restaurar, duplicar y borrar en Meta), `test/upload.test.mjs` y `test/ui/plantillas.spec.mjs` (escritorio y celular, Niebla sin línea base). `test/whatsapp-templates.test.mjs` pasa sin cambios.

## Para activarlo

`META_WABA_ID` (ya existía) y `META_APP_ID` para las plantillas con archivo; suscribir la app, en el panel de Meta, a `message_template_status_update`, `message_template_quality_update` y `template_category_update`; publicar la pantalla (`visibility: "live"`) cuando se decida.
