# Importar contactos por CSV (incremento B-I4a)

Estado: **construido en la rama de integración, sin publicar**. Migraciones con nombre `jobs/0001-background-jobs` y `contact-import/0001-imports` (la escalera sigue en 41). La pantalla nace en vista previa (`SCREENS_PREVIEW=1`). Es la puerta de entrada de los contactos antes del cambio de número: cargar la exportación del proveedor anterior (unos 6 500 contactos) sin duplicar a quien ya escribe por WhatsApp.

## Cómo se usa

Gestión → **Importar contactos** (sólo administración, permiso `contacts.import`), un asistente de cuatro pasos:

1. **Archivo.** Un CSV con encabezados (coma, punto y coma o tabulador; UTF-8 con o sin BOM, UTF-16 o Windows-1252). Se guarda privado en `DATA_DIR/imports`. Si ese mismo archivo ya se importó en la marca, lo avisa.
2. **Columnas y permiso.** Cada columna va a Nombre, Teléfono, Código de país, Correo, Etiquetas (separadas por `;` o `,`), Consentimiento, Fecha de alta, un **dato de contacto** existente de la marca o «Ignorar». La sugerencia reconoce la **exportación del proveedor anterior** (`Name`, `CountryCode`, `Phone`, `Allow Campaign`, `Allow SMS` y, desde la sexta columna, datos de contacto con el mismo nombre o clave). Opciones: actualizar o dejar como están los contactos que ya existen; usar el teléfono como nombre si falta; declaración del origen del permiso.
3. **Vista previa (simulacro).** Corre como trabajo por trozos y **no escribe nada**: cada trozo se aplica dentro de un `SAVEPOINT` que se deshace, así que cuenta exactamente lo que haría la importación. Muestra nuevos, actualizados, sin cambios, omitidos y con error, el consentimiento resultante y cada fila con problema (línea, columna, motivo, valor), descargable en CSV.
4. **Importar.** Con la declaración confirmada (si la hay). Trabajo por trozos con progreso en vivo (`job.progress`), cancelable entre trozos (lo hecho se queda). Al terminar, el mismo informe y las filas con problema.

Repetir el mismo archivo deja **cero cambios** (puerta 2 del plan maestro): se reconoce a cada persona por su clave de teléfono y aplicar los mismos valores da «sin cambios».

## Reglas de cada fila (`applyRow`)

Una sola función, `applyRow(brandId, fila, opciones) → {action, contactId, reason, message, consent}` en `server/modules/contact-import/rows.mjs` (expuesta por el módulo como `applyRow`), componible y síncrona, para las demás puertas (lista de una audiencia, mudanza por API). `action`: `created`, `updated`, `unchanged`, `skipped` o `error`.

- Se reconoce al contacto por `phone_key` dentro de la marca y, sin teléfono, por el correo (índice nuevo `contacts_email_key`). Teléfonos en cualquier formato: 10 dígitos, `521…`, `+52 …`, con paréntesis, extranjeros sin «+», `55….0` de una hoja de cálculo; `CountryCode` hace de país por omisión. Un repetido dentro del archivo se omite y dice qué fila repite.
- Nunca se borra un dato con una celda vacía; el teléfono guardado no se reescribe (sólo se añade si faltaba). Las etiquetas sólo se añaden (se crean si faltan: hasta 12 por contacto y 100 por marca). Los datos de contacto se escriben con `attributes.set` (origen `import`, sin un evento por cambio); un valor que no cumple su tipo es error de la fila. Una lista acepta la opción por valor o etiqueta sin mayúsculas; una fecha, `DD/MM/AAAA`.
- Lo que empieza con `=`, `+`, `-` o `@` se guarda como texto (al exportarse se vuelve a neutralizar).
- Cada contacto nuevo pasa por `persons.attach(c, 'import', {candidates: false})`.
- Una fila con error no deja nada a medias (`SAVEPOINT` propio). No se publica un evento por contacto; al terminar, uno solo: `contactos.importados`.

## Consentimiento (conciliación técnica, fila 15)

- `FALSE` → **baja siempre** (nota «Importado de «archivo»»). Esa baja sí publica `baja.registrada` por persona, como cualquier baja, porque detiene automatizaciones en curso.
- `TRUE` → «acepta» **sólo** si administración declaró de dónde viene el permiso (10 a 200 caracteres) **y** el contacto está «sin registro». La declaración queda en la nota de cada persona, en las opciones de la importación junto con quién la confirmó y cuándo, y en la bitácora. Sin declaración, la persona queda **sin registro y no recibe promociones**.
- Una baja **nunca se levanta** («conservan su baja» en el informe). Sin columna o con la celda vacía, no se toca.
- El consentimiento es de la persona (bloque 2.2): se proyecta a sus contactos de otras marcas, como hoy.

## Permisos

Todas las rutas piden `contacts.import` sobre la marca (otra marca: 404). Al lanzar la vista previa y la importación se calculan los permisos de quien la lanza (`contacts.edit`, `contacts.tags.apply`, `contacts.consent`, `contacts.phone`) y se guardan en el trabajo: un destino sin permiso se **rechaza antes de lanzar** (400 `permission_denied`, con la columna) y cada fila los vuelve a respetar (un dato personal pide ver teléfono y correo completos). Hoy administración los tiene todos. La muestra del archivo y el valor de una fila con problema sólo se enseñan con `contacts.phone`.

## Rutas (módulo `server/modules/contact-import/`, prefijo `/api/contact-import`)

| Ruta | Respuesta |
| --- | --- |
| `GET /api/contact-import` · `?brand=` | marcas donde se puede importar · historial (20) y límites |
| `POST /api/contact-import/uploads?brand=&name=&clientRef=` (CSV crudo) | 201 `{import}` con encabezados, muestra de 20 filas, sugerencia, destinos y `previous` |
| `GET /api/contact-import/<id>` | `{import}` con informe y trabajo |
| `PUT …/<id>/mapping` `{expectedRevision, targets, options}` | `{import}`; sube la revisión y anula la vista previa |
| `POST …/<id>/validate` · `…/apply` `{expectedRevision, clientRef, confirmConsent?}` | 202 `{import}` |
| `POST …/<id>/cancel` | `{import}` |
| `GET …/<id>/rows?phase=preview\|apply&filter=errors\|skipped\|all…&after=` · `GET …/<id>/errors.csv?phase=` | filas de 50 en 50 · CSV con BOM |

Errores con `code`: `too_large`, `too_many_rows`, `too_many_columns`, `unclosed_quote`, `no_rows`, `mapping_invalid`, `consent_origin`, `consent_confirmation`, `preview_required`, `import_busy` (una importación en curso por marca), `import_state`, `import_purged`, `stale_record`, `permission_denied`.

## Trabajos por trozos (`background_jobs`)

Ejecutor común en `server/app/background-jobs.mjs` (uno por base: `sharedJobRunner(host)`), reloj y rutas `GET /api/jobs/<id>` y `POST /api/jobs/<id>/cancel` en el módulo `server/modules/jobs/`. Cada pasada (cada 2 s) **reclama** un trabajo con arrendamiento, procesa trozos de 100 filas, cada uno en una transacción que guarda también el cursor y el progreso, hasta 1 000 filas u 800 ms, y cede el hilo entre trozos. Tras un reinicio, el trabajo sigue en el último trozo confirmado sin repetir filas; un fallo pasajero se reintenta (3 intentos) y uno permanente lo marca fallido. Lo usarán también la edición en lote y las acciones masivas.

## Límites

- 8 MB y 100 columnas por archivo. Filas: **2 000 por omisión** hasta publicar la lista de contactos paginada (conciliación técnica, fila 14); `IMPORT_MAX_ROWS` lo sube hasta 50 000. **Para la lista real de 6 500, poner `IMPORT_MAX_ROWS=10000` en Railway.**
- El archivo y el valor de cada fila con problema se borran a los **7 días** de terminar (o de quedar a medias).
- Medido en local con el servidor real y 6 500 filas sintéticas con la forma de la exportación: unos 5 a 10 s de CPU por fase (vista previa e importación) en una máquina tranquila; la prueba admite hasta 120 s por fase. En producción, a una pasada cada 2 s, cuenta con menos de un minuto por fase.
- Para ganar velocidad, `persons`, `events` y `contacts` reutilizan sus sentencias preparadas (`server/lib/statement-cache.mjs`).

## Lo que falta

Audiencias y «Importar lista» (D-2, con `audiences.addContacts`), crear datos de contacto nuevos desde el mapeo (`attributes.ensure`), asesor de cabecera, idioma, `externalId` y BSUID (aún sin dónde guardarse), exportar y editar en lote (B-I4b), importador por API (I-10), pasos en «Preparar marca» y la prueba con la lista real antes del corte.
