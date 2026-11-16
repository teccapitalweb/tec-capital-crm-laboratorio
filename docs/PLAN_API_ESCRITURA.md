# Plan: API v1 de escritura (llaves de escritura y API de contactos)

Estado: rama de integración `chore/f0-01-codificacion`, **sin publicar**. Incrementos I-6 e I-7a del plan maestro (diseño de identidad y API §4.1–§4.7; conciliación técnica, filas 14, 15, 17 y 47). Migración con nombre `api/0001-write-keys`. Apagado en la práctica: nada se escribe hasta que administración cree una llave con un permiso de escritura.

Para qué: que un sistema de la empresa (inscripciones, recordatorios) **cree o actualice contactos** de una marca sin entrar al CRM, sin duplicar y sin saltarse las reglas de consentimiento.

## Llaves y permisos

Se administran donde siempre: *Operación → Sistema → API y webhooks → Llaves de la API* (`public/integrations.js`, cambio mínimo: permisos en dos grupos, caducidad, estado y botón «Rotar»). La llave se muestra una sola vez; sólo se guarda su huella, que se compara en tiempo constante.

| Permiso | Tipo | Qué permite |
| --- | --- | --- |
| `events`, `orders`, `contacts`, `editions` | lectura | Lo de siempre ([PLAN_API_PUBLICA.md](PLAN_API_PUBLICA.md)). `contacts` es el único que ve teléfonos, correos y datos personales. |
| `templates` | lectura | Plantillas de WhatsApp aprobadas de la marca y sus datos. |
| `contacts_write` | escritura | Alta o cambio de contactos, datos propios, etiquetas, añadir a listas y registrar bajas. |
| `consent_write` | escritura | Registrar que una persona **aceptó** mensajes, siempre con su origen. |
| `messages_send_template` | declarado | Todavía no se puede dar: llega con el envío de plantillas por API (I-8). |

- **Caducidad** (`expires_at`): obligatoria si la llave escribe (180 días si no se dice, 365 como máximo); opcional si sólo lee. Vencida responde 401 `key_expired`. Cada respuesta lleva `X-Key-Expires`.
- **Rotar** crea una llave nueva con los mismos permisos (a nombre de quien rota, `rotated_from` apunta a la anterior) y deja la anterior **72 horas** en convivencia; después caduca. Una llave se rota una sola vez.
- **Revocar** corta al instante (401 `unauthorized`). Se registra el último uso.
- **Actuar a nombre de alguien:** una escritura firma como quien creó (o rotó) la llave, que debe seguir administrando la marca; si no, 403 `actor_inactive` (la llave sólo lee). `/me` lo dice en `actorActive`.
- Las llaves que ya existían no ganan permisos ni caducidad al migrar. Las columnas `daily_send_limit`, `default_number_id` y `webhook_endpoints.api_key_id` quedan creadas, sin uso, para I-8 y los webhooks por API.
- **La marca la decide la llave.** Un contacto o una lista de otra marca responde 404, igual que uno que no existe.

## Rutas

| Método y ruta | Permiso | Idempotency-Key | Qué hace |
| --- | --- | --- | --- |
| `GET /api/v1/me` | cualquiera | — | Añade `key.expiresAt`, `permissions:[{name, kind}]`, `limits` y `actorActive`. |
| `GET /api/v1/templates` | `templates` | — | Aprobadas (y marcadas) de la marca: nombre, idioma, categoría, cuerpo, `parameters`, encabezado y botones. |
| `GET /api/v1/contacts/{id}` | `contacts` | — | Un contacto con etiquetas, datos propios y consentimiento. |
| `POST /api/v1/contacts/lookup` | `contacts` | — | `{phone, countryCode?}` o `{email}` → `{contact}` o 404. Es POST para que el dato no viaje en la dirección. |
| `GET /api/v1/lists` | `contacts` | — | Listas (no segmentos) de la marca. |
| `POST /api/v1/contacts` | `contacts_write` | opcional | **Alta o actualización por teléfono** en una llamada: `{phone, countryCode?, name?, email?, attributes?, tags?, consent?, overwriteName?}` → 201 o 200 `{contact:{id, created, updatedAt}, result, consent, warnings}`. |
| `POST /api/v1/contacts/batch` | `contacts_write` | **obligatoria** | `{contacts:[… hasta 100]}` → `{results:[{index, id, created, result} o {index, error}]}`. Cada fila es independiente. |
| `PATCH /api/v1/contacts/{id}` | `contacts_write` | opcional | `{name?, email?, phone?, attributes?, expectedUpdatedAt?}`; 409 `stale_revision` si la fecha no coincide. |
| `POST /api/v1/contacts/{id}/tags` | `contacts_write` | opcional | `{add:[nombres], remove:[nombres]}` → `{tags}`. Una etiqueta que no existe se crea (100 por marca, 12 por contacto, 30 caracteres). |
| `PUT /api/v1/contacts/{id}/consent` | `contacts_write` (baja) o `consent_write` (aceptación) | opcional | `{status:'opted_in'\|'opted_out', source, evidence?}` → `{consent}`. |
| `POST /api/v1/lists/{id}/contacts` | `contacts_write` | opcional | `{contactIds:[… hasta 100]}` → `{added, refused, unknown}`. |

Reglas del alta: el contacto se reconoce por la **clave de teléfono** (`5512345678`, `+52 55 1234 5678` y `5215512345678` son el mismo); todo pasa por la tubería única de la importación (`applyRow` con `source:'api'`) y por las funciones componibles de etiquetas, datos propios y listas: la API no tiene otro camino para escribir contactos. El nombre de un contacto existente sólo se cambia con `overwriteName:true` (en PATCH, si se manda). El teléfono de un contacto existente nunca se reescribe (aviso `phone_kept`); uno que ya es de otro contacto responde 409 `phone_in_use`. Datos propios: valor vacío o `null` lo borra; clave inexistente 422 `attribute_unknown`; dato del sistema 422 `attribute_read_only`; valor que no cumple el tipo 422 `attribute_invalid`; un dato personal sólo lo escribe una llave con `contacts`. Cada cambio de dato publica su evento, como en pantalla. Las respuestas de escritura no traen teléfono ni correo.

## Consentimiento

- Registrar una **baja** se puede siempre con `contacts_write`.
- Registrar una **aceptación** pide `consent_write` y `consent.source` de 10 a 200 caracteres (de dónde viene el permiso; `evidence` opcional). Sólo se aplica sobre «sin registro». Queda con fuente `api` y el nombre de la llave.
- **Una baja nunca se levanta por API**: `PUT …/consent` responde 409 `consent_locked`; en el alta, el resto se guarda y llega el aviso `consent_locked`.

## Idempotencia

Cabecera `Idempotency-Key` (8 a 128 caracteres `A-Z a-z 0-9 . _ : -`) en toda escritura; obligatoria en el lote. Se guarda **por llave** en `api_requests` con la huella del método, la ruta y el cuerpo. Misma clave y mismo cuerpo: la misma respuesta con `Idempotent-Replayed: true`, sin repetir el efecto. Misma clave y otro cuerpo: 409 `idempotency_key_reused`. Vale **7 días**; después la clave se libera. La operación y su registro van en **una transacción síncrona**, así que dos peticiones simultáneas con la misma clave hacen un solo efecto. Segunda barrera sin clave: un contacto por teléfono y marca. `api_requests` guarda ruta (como patrón), resultado, entidad y una respuesta mínima (ids y estados), nunca la llave, cuerpos ni datos personales; se purga a los 90 días. Cada escritura deja además su entrada `api.*` en la auditoría a nombre de quien creó la llave.

## Errores y límites

Toda respuesta de `/api/v1` lleva `X-Request-Id`. Formato único: `{error, code, status, requestId, field?, details?}` (sólo los filtros de las rutas de lectura publicadas antes, `?type=` y `?status=`, conservan su `{error}` de siempre). Códigos: 400 `invalid_request`, `invalid_json`, `idempotency_key_required`; 401 `unauthorized`, `key_expired`; 403 `scope_missing`, `actor_inactive`, `permission_denied`; 404 `not_found`; 405 `method_not_allowed` (con `Allow`); 409 `idempotency_key_reused`, `stale_revision`, `consent_locked`, `phone_in_use`; 413 `payload_too_large` (cuerpo de más de 256 KB); 415 `unsupported_media_type` (no es `application/json`); 422 los de la fila (`phone_invalid`, `email_invalid`, `name_invalid`, `tag_invalid`, `tag_limit`, `attribute_*`); 429 `rate_limited` con `Retry-After`.

Límites por omisión: lectura **120** por minuto por llave, escritura **300** por minuto por llave (cuentas separadas), **600** por minuto por dirección real (la que resuelve `client-address` tras el proxy) y el freno de siempre a llaves falsas por dirección. Cabeceras `RateLimit-Limit`, `RateLimit-Remaining` y `RateLimit-Reset` en toda respuesta autenticada. Los contadores viven en memoria.

## Lo que NO entra

Envío de plantillas y texto por API, tope diario de envíos y número por omisión (I-8); la capa de compatibilidad; notas, tareas y etapa (I-7b); `externalId`, BSUID y `external_refs`; `createMissingAttributes`; webhooks creados por API; `openapi.json`; salud del número; enlace `wa.me`; OAuth; importar el histórico; la pantalla de «Actividad de la llave» y «Primeros pasos». El conector de Claude sigue igual (sólo gana la comprobación de caducidad al autenticar).

## Archivos

`server/modules/api-write/` (rutas, idempotencia, contactos), `server/integrations.mjs` (permisos, caducidad, rotación, autenticación, enrutado, límites y errores de `/api/v1`; `useWriter`), `server/app/rate-limit.mjs` (`consume`), `server/modules/contact-import/rows.mjs` (`applyRow` admite `source`, `contactId`, `keepName` y `attributeEvents`), `server/migrations/named/api/`, `public/integrations.js`, `test/api-write.test.mjs`.
