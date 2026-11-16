# Plan: envío de plantillas por API y capa de compatibilidad

Estado: **publicado en `main`** (15 nov 2026); la capa de compatibilidad, apagada. Incremento I-8 del plan maestro (diseño de identidad y API §4.8, §4.9 y §4.12; conciliación técnica, filas 13, 15, 37, 39 y 40). Migración con nombre `api/0002-send-lookup` (sólo un índice). Apagado en la práctica: nada sale sin una llave con el permiso de enviar, las difusiones y la automatización de la marca encendidas y WhatsApp real (`CHANNEL_CONNECTOR=meta`).

Para qué: que el sistema de recordatorios de clases y pagos **mande una plantilla aprobada a una persona** a través del CRM y consulte después qué pasó, cambiando lo mínimo gracias a la capa de compatibilidad.

## Llave

Permiso `messages_send_template` (escritura: caduca siempre, 180 días si no se dice). La llave gana dos ajustes (columnas que ya existían): **tope de envíos en 24 horas** (`daily_send_limit`, **1,000** por omisión, de 1 a 100,000; el diseño proponía 2,000) y **número por omisión** (`default_number_id`, uno de la marca; vacío = el único número activo). Se fijan al crearla, se cambian con `PATCH /api/integrations/keys/:id` (botón «Envíos») y pasan a la llave nueva al rotar. El tope se cuenta en `api_requests` (envíos aceptados, 24 horas corridas) y sobrevive a un reinicio.

## Rutas

| Método y ruta | Permiso | Idempotency-Key | Qué hace |
| --- | --- | --- | --- |
| `POST /api/v1/messages/template` | `messages_send_template` | **obligatoria** | `{to:{phone, countryCode?} o {contactId}, template:{name, language?} o {id}, parameters?:{nombre: valor} (o [{name, value}], hasta 10), label?, contact?:{name}, numberId?}` → 202 `{send:{id, status, label, template, numberId}}`; con el permiso `contacts`, además `contact:{id, created}`. |
| `GET /api/v1/messages/template/{id}` | `messages_send_template` | — | `{id, status, reason, failCode, sentAt, deliveredAt, readAt, failedAt, repliedAt}` (`contactId` con `contacts`). Sólo envíos de esa llave (o de la que rotó en ella); los demás, 404. |

Por teléfono se usa el contacto de la marca con esa clave o se crea uno (fuente `api`, por `applyRow`); uno existente no se toca. Todo pasa por **`broadcasts.sendOne`** con `strict` (campaña de origen API por etiqueta, plantilla, número y día; aparece en Difusiones con su costo y sus fallos) y en una transacción sin red: crear el contacto, encolar y registrar la petición son una sola cosa. No se crea conversación, interés ni tarea; si la persona responde, el mensaje entra a su conversación como cualquier difusión. Los parámetros llenan las variables `llamada.<nombre>` y, si se llaman igual, tienen prioridad sobre los datos del chat (`nombre`, `curso`, `edicion`, `marca`).

## Errores (formato único de la API)

400 `invalid_request`, `idempotency_key_required`; 401 `unauthorized`, `key_expired`; 403 `scope_missing`, `actor_inactive`; 404 `not_found` (plantilla, contacto o envío de otra marca o inexistentes); 409 `idempotency_key_reused`, `broadcasts_off` (difusiones o automatización de la marca apagadas), `number_unavailable` (número pausado, ajeno o con la salud en contra; `details.reason`), `number_listen_only`, `budget_exceeded`, `sending_stopped` (la campaña de la API de hoy está detenida o pausada en Difusiones), `already_sent_today` (misma plantilla y etiqueta a la misma persona el mismo día); 422 `phone_invalid`, `template_not_approved`, `template_category` (sólo utilidad o marketing), `template_params` (`details.missing` con los nombres que faltan), `template_too_long`, `number_required` (varios números y ninguno indicado), `recipient_no_address`, `recipient_unavailable` (baja **o** lista de exclusión: la misma respuesta), `consent_required` (marketing sin aceptación); 429 `rate_limited`, `daily_send_limit` (tope de la llave) y `messaging_limit_reached` (límite de 24 horas del número o la cuenta), con `Retry-After`; 503 `whatsapp_off`.

Consentimiento (fila 15): una plantilla de **utilidad** (un recordatorio) sale a quien no pidió la baja ni está en una lista de exclusión; una de **marketing** pide además la aceptación registrada.

## Lo que una llave que sólo envía puede deducir

- **No** sabe si un teléfono ya era contacto: el alta es silenciosa, la respuesta es la misma y el id del contacto y `created` sólo salen con `contacts`. Si la plantilla usa `nombre`, sin `contacts` hay que mandarlo (no se usa el nombre guardado, que distinguiría un contacto con nombre de uno nuevo).
- **No** sabe por qué alguien no puede recibir: baja y exclusión dan `recipient_unavailable`; en el estado, los motivos que hablan de la persona (baja, sin consentimiento, exclusión, otra difusión reciente, número repetido) se ven como `not_allowed`.
- **Sí** sabe, y el diseño lo acepta (§4.8 y §4.15.8), que esa persona no puede recibir mensajes de la marca, y con una plantilla de marketing que sí aceptó recibirlos. Recomendación: llaves de recordatorios con plantillas de utilidad. También ve `already_sent_today` si otra llave de la marca mandó hoy la misma plantilla con la misma etiqueta a esa persona.

## Eventos y rastro

`envio_api.aceptado` (`sendId, apiKeyId, template, language, category, label`) y `envio_api.estado` (`sendId, apiKeyId, state, failCode`; con los avisos de Meta de enviado, entregado, leído o fallido), entidad `api_send`, legibles por la API con `events` + `templates` y entregados a los webhooks de la marca. `api_requests` guarda la petición (ruta como patrón, resultado, `entity_kind='send'` y el id del envío) y la auditoría `api.message.template`. Ni la llave ni el teléfono quedan en registros, eventos, auditoría ni `api_requests`.

## Capa de compatibilidad

Sólo las dos formas de enviar una plantilla del proveedor anterior, traducidas a la ruta nativa con `integrations.invoke` (misma llave, permisos, límites, idempotencia y registro):

- `POST /api/compat[/<cuenta>]/api/v1/sendTemplateMessage?whatsappNumber=<teléfono>` con `{template_name, broadcast_name?, parameters:[{name, value}]}` → `{result:true, info, id, status}` o, con el código HTTP nativo, `{result:false, info, code}`.
- `POST /api/compat/api/ext/v3/messageTemplates/send` con `{template_name, broadcast_name?, recipients:[{phone_number, custom_params?, local_message_id?}]}` (hasta 100) → `{success, broadcast_id, recipients:[{phone_number, local_message_id, success, id?, status?, error?}]}`; una llave inválida, un permiso o un límite cortan los que faltan.

`broadcast_name` es la etiqueta. Sin idempotencia en el origen, la clave se deriva del contenido (ruta, teléfono, plantilla, parámetros, `broadcast_name`, `local_message_id`) y vale `API_COMPAT_DEDUPE_SECONDS` (600). **Apagada por omisión:** hace falta `API_COMPAT=1` y una llave con el permiso `compat` además de `messages_send_template`; apagada, 404. La ruta heredada lleva el teléfono en la dirección (queda en los registros del proxy): es un puente que se retira cuando deje de usarse. Lo demás (contactos, leer plantillas) se hace con las rutas nativas.

## Sin verificar contra Meta real

El envío y los estados se probaron con el Meta de mentira (`test/api-send.test.mjs`). Falta: un recordatorio real con el número de prueba; la forma exacta de las respuestas que espera el sistema de recordatorios; el modo escucha (I-11, otro frente): la ruta pregunta `listenOnly('wa:' + phone_number_id, phoneKey)` en `services.whatsapp` o en `channel-health` si existe y, si no, sigue.

## Preguntas abiertas para el responsable del sistema de recordatorios (§10.4)

1. ¿Qué llamadas hace hoy (método y ruta) y cada cuánto? Si usa altas de contacto o lectura de plantillas por la capa, se añaden después.
2. Plantillas y nombres de variables que manda (deben coincidir con `llamada.<nombre>` o con `nombre`).
3. ¿Manda el mismo recordatorio dos veces el mismo día a la misma persona con la misma `broadcast_name`? Hoy el motor lo rechaza (`already_sent_today`); si hace falta, cambia la etiqueta.
4. ¿Qué hace ante un 429 o un error? ¿Reintenta, cuántas veces?
5. Una respuesta real de cada llamada, sin datos personales, para copiar su forma exacta.
6. ¿Cuántos envíos al día por marca? (para el tope de su llave).

## Fuera de este incremento

Texto libre y archivos por API, lote nativo `messages/template/batch`, destinatario por BSUID, ritmo de 60 cada 10 segundos por llave (vale el de escritura, 300 por minuto), API de seguimiento (I-7b), OAuth, modo escucha y cambio de número.

## Archivos

`server/modules/api-write/send.mjs` (rutas de envío y estado, eventos), `server/modules/api-write/compat.mjs` (capa), `server/modules/api-write/module.mjs` y `repo.mjs`, `server/modules/broadcasts/module.mjs` (`sendOne` con `strict`; los valores de quien llama tienen prioridad), `server/integrations.mjs` (permisos, ajustes de la llave, `{ref}`, `invoke`), `server/migrations/named/api/0002-send-lookup.mjs`, `public/integrations.js`, `test/api-send.test.mjs`.
