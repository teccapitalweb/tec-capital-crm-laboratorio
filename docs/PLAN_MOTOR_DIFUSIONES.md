# Motor y asistente de difusiones (D-5)

Estado: **publicado en `main`** (15 nov 2026), apagado por marca. Migración con nombre `broadcasts/0002-engine` (aditiva; la escalera sigue en 41). La pantalla nace en vista previa (`SCREENS_PREVIEW=1`). Fuente: diseño de difusiones §5 adaptado a la conciliación técnica (filas 13, 15, 16, 25, 28, 37, 39, 40 y 41; hallazgos F-4 y F-19), que manda.

## Qué hace

Una difusión manda una plantilla aprobada por Meta a cada persona de una audiencia, por tandas y a un ritmo, y sigue cada envío por los avisos de Meta. Une lo que ya existía: plantillas (`wa-templates`: `resolve`, `forSend`), audiencias (`audiences`: `members`, `summary`, `suppressed`), costos (`wa-costs`: `estimate`, `monthSpend`) y la cola por destinatario de `campaign_recipients`.

- **Módulo** `server/modules/broadcasts/`: `model.mjs` (reglas puras: códigos de Meta, horario de silencio, cubeta de ritmo, tasa de fallos, cargas), `gate.mjs` (unión con la salud del número), `repo.mjs` (todo el SQL) y `module.mjs` (rutas, emisor, avisos, atribución, envío suelto).
- **Ciclo**: borrador → programada → enviando → completada; pausada (una persona), detenida (el sistema) y cancelada. Esperas sin cambiar de estado (`status_reason`): marca apagada, plantilla en revisión, fuera de horario, límite diario, pausa entre tandas.
- **Elegibilidad** (vista previa, lanzamiento y antes de cada envío): los motivos de la audiencia (sin WhatsApp → `no_address`, lista de exclusión, baja, sin consentimiento, excluido por la campaña, número repetido) y los del motor (`recent_campaign` por la separación mínima de la marca, `missing_variable`, `too_long`, `over_limit`). La baja y la exclusión se vuelven a mirar dentro de la transacción que reserva el envío.
- **Valores**: los da `wa-templates.resolve` con `values` (primer nombre del contacto, curso y edición de la campaña, marca), `fixed` (textos fijos sin importes), cupón y `llamada.<n>` (envío suelto), en modo estricto: un dato vacío sin respaldo omite a esa persona.
- **Costo**: `wa-costs.estimate` con los elegibles por mercado; presupuesto mensual de la marca (`monthSpend`). Programar exige `confirmAudience` igual a los elegibles y `acceptCost` cuando cuesta.
- **Emisor** (`tick`, reloj `emisor` cada segundo): reconcilia dudas, lanza las programadas, y por campaña reserva (transacción, sin red) hasta lo que permiten el ritmo, el tope por número por segundo, el límite diario y las tandas; envía fuera de transacción con 10 llamadas a la vez como mucho; asienta cada resultado en su transacción. Un destinatario reservado de una campaña que se detuvo mientras esperaba vuelve a la cola sin salir.
- **Estados** por aviso de Meta (oyente `connectors.on('message.status')`, `order: 200`, entre el canal y los costos): enviado → entregado → leído, sin retroceder; un fallo tardío tras entregado se ignora. Fallos clasificados por el apéndice B (vuelve a la cola sin gastar intento, fallido, 131049 diferido sólo con reintento activo).
- **Detención automática**: plantilla pausada, desactivada, rechazada o inexistente (por estado en el CRM o por código al enviar), número restringido o en pausa, token, pago, encabezado, WhatsApp apagado, presupuesto agotado, y tasa de fallos (más del 50 % de los últimos 50, con al menos 10, contados desde el último lanzamiento o reanudación). Reanudar comprueba que la causa ya no existe (409 si sigue).
- **Respuesta y botones** (fila 25: manda `attribute`): el entrante de WhatsApp pregunta antes de buscar la conversación. Exacta por la carga del botón (`c:<destinatario>:<índice>`) o por el mensaje citado; aproximada por el último destinatario del remitente en los días de atribución (`inbox_settings.attribution_days` si existe; si no, 7). **Sólo cuenta si el destinatario es quien escribe** (su clave de teléfono o el `wa_id` devuelto por Meta) y la difusión salió por el número por el que entró el mensaje: una carga o una cita ajena no marca respuestas, clics ni conversaciones de otra persona. Con atribución exacta la conversación nace (o se mueve, sin pedido vigente) en el curso y la edición de la campaña; el contacto de la lista pasa a ser el de la persona; el mensaje de la difusión queda escrito antes del suyo con su `provider_ref`; contesta el asistente (acción `default`). Evento `difusion.respondida`.
- **Envío suelto** (fila 37, para la futura API I-8; sin rutas públicas): `sendOne({brandId, contactId | phone, waTemplateId, waNumber?, values?, label?, clientRef, actorId?})` → `{id, campaignId, state, …, duplicate}` y `sendStatus(brandId, id)`. Una campaña de origen API por etiqueta, plantilla, número y día local; un envío por contacto en ella; la misma `clientRef` devuelve el mismo destinatario. Sale por el mismo emisor y las mismas reglas.
- **Ensayo** (`options.mode='rehearsal'`): recorre todo sin llamar a Meta (`sim_…`, entregado a los 2 s y 4 de cada 10 leídos a los 5 s, falla con la tasa del canal simulado de la marca). No escribe costos, conversaciones ni cuenta para el límite diario ni para la separación mínima.

## Un destinatario, un mensaje (también tras un reinicio)

Una fila por (campaña, contacto) y por (campaña, número). Antes de llamar a Meta la fila pasa a `sending` con su intento y un arrendamiento, en una transacción; el envío lleva `tc:<destinatario>:<intento>` como `biz_opaque_callback_data`. Si Meta no contesta a tiempo o el proceso muere, la fila se queda `sending` (**en duda**) y el emisor **nunca la reenvía**: la resuelve un aviso de Meta que traiga ese dato (se adopta su `wamid`) o, pasado `WA_BROADCAST_RECONCILE_MS` sin aviso, queda fallida `unconfirmed` («No se pudo confirmar si salió. No se reintentó para no duplicarlo.»). Sólo se reintenta sola una fila cuya conexión ni se abrió (`beforeSend`: nombre no resuelto o conexión rechazada) o que Meta rechazó con un código que dice «vuelve a la cola». Probado matando el proceso con cinco envíos en vuelo.

## Salud del número (`channel-health`, otro frente)

`gate.mjs` es la única unión: si `host.module('channel-health')` existe, mandan `canSend('wa:'+phone_number_id, categoría)` y `limitsOf(…)`; si no existe o falla, un tope conservador: `campaign_settings.daily_cap` (250 por omisión) o `wa_account.limit_value`. En los dos casos lo usado es el mayor entre lo que dice la salud y lo que el motor contó (personas distintas a las que el número escribió con difusiones reales en 24 h), para que la caché de 5 s de la salud no deje pasar de largo el límite. `limit_reached` no detiene: la campaña espera (`daily_limit`); `number_disabled` → `number_paused`, `payment_missing` → `payment_problem`, `quality_low` → `quality_low` y lo demás → `number_restricted`. Probado con un doble y, de punta a punta, con el módulo real. Pendiente del otro frente: su conteo de lo usado (`usedSince`) incluye los destinatarios de los ensayos; debería filtrar `options.mode='rehearsal'`.

## Interruptores y valores por omisión

| Qué | Dónde | Por omisión |
| --- | --- | --- |
| Difusiones de la marca | `campaign_settings.enabled` (`PATCH /api/campaigns/settings/:marca`) | apagado |
| Automatización de la marca y pausa global | `/api/automation` | apagado |
| WhatsApp real | `CHANNEL_CONNECTOR=meta` | apagado: sólo ensayo |
| Ritmo, tope diario, horario de silencio, presupuesto, % de fallos | `PATCH /api/broadcasts/settings/:marca` (administración) | 60/min, 250, 21:00–08:00 (marketing), sin tope, 50 % |
| Separación mínima y público máximo | ajustes de campañas de siempre | 72 h, 5,000 |
| Tope por número por segundo | `WA_BROADCAST_MAX_PER_SECOND` | 10 |
| Arrendamiento y plazo de duda | `WA_BROADCAST_LEASE_MS`, `WA_BROADCAST_RECONCILE_MS` | 120 s, 10 min |
| Espera del reintento por 131049 | `WA_RETRY_AFTER_MS` (reintento apagado por campaña) | 24 h |

Permisos: ver `campaigns.view`, editar `campaigns.edit`, programar/pausar/reanudar/cancelar `campaigns.send`, en la marca (hoy sólo administración). Enviar sin consentimiento, `sendHours: 'any'` y los ajustes, sólo administración. Teléfonos completos sólo con `contacts.phone`.

## Rutas

`GET /api/broadcasts?brand&status&limit&offset` · `GET /api/broadcasts/options?brand` · `GET /api/broadcasts/settings?brand` · `PATCH /api/broadcasts/settings/:brandId` · `POST /api/broadcasts` · `GET|PATCH /api/broadcasts/:id` · `POST /api/broadcasts/:id/preview|schedule|unschedule|pause|resume|cancel` · `GET /api/broadcasts/:id/recipients?state&limit&offset` · `GET /api/broadcasts/:id/events`. Aviso en vivo `broadcasts.changed` (como mucho uno por campaña y pasada).

## Pantalla

`public/screens/difusiones/` (Gestión, `megaphone`, orden 50, `campaigns.view`): lista con estado y contadores; asistente con el `wizard` del kit (plantilla y número, curso, modo; audiencia a incluir y a quitar; fuente de cada dato, textos fijos, ritmo y cuándo; revisar con los excluidos por motivo, el costo, el límite diario y los bloqueos); detalle con avance en vivo, pausar, reanudar, cancelar y destinatarios por estado. Vista de teléfono neutra. Prueba: `test/ui/difusiones.spec.mjs`.

## Archivos existentes tocados

`server/whatsapp.mjs` (paso con nombre `attributionOf` y `useBroadcasts`; curso de la difusión al crear o mover la conversación; `onReply` antes del mensaje de la persona), `server/connectors.mjs` (sólo el envío de plantilla: `biz_opaque_callback_data`, `waId` y `mediaId` en la respuesta; errores de red con `timeout` o `beforeSend`), `server/modules/wa-templates/module.mjs` (`resolve` acepta `values` y `strict`), `test/helpers/fake-meta.mjs` (`refuse`: rechazos por destinatario). `server/campaigns.mjs` y `server/channel.mjs` no hizo falta tocarlos: las campañas de catálogo siguen igual (`test/campaigns.test.mjs` sin cambios) y el envío no pasa por `channel.tick`.

## Lo que NO entra

Tablero, calendario y exportación (D-6); reorientar, duplicar, «continuar con otra plantilla» y pruebas A/B (D-7); vista «Difusiones» de la bandeja y la insignia «Difusión» en el chat de `public/app.js` (el mensaje ya lleva `client_ref` `campaign:<destinatario>` para pintarla); API pública de envío (I-8: usará `sendOne`/`sendStatus`); salud del número (`channel-health`); identidad sin teléfono (I-2: `wa_recipient` y `no_address` quedan listos, sin destinatarios por identificador); bloqueos de Meta por número (`wa_send_blocks`: 131050, 130472, `invalid_number`) y su limpieza al escribir; caché de archivos de Meta entre reinicios (hoy el archivo del encabezado se sube una vez por campaña y proceso); acciones de respuesta distintas de `default` (`reply_hints`, flujo, material); escribir el mensaje en una conversación abierta al enviar (se escribe al responder); `respectHuman`, `exclude_enrolled` y la calidad del número (vendrá de `channel-health`); costo esperado con tasa de entrega; programar por encima del presupuesto; `scheduledLocal` con zona (se acepta `scheduledAt` en milisegundos); variables de catálogo como precio o fecha (la plantilla sólo admite las fuentes de `wa-templates`).

## Sin verificar contra Meta real (diseño §15)

1. Que `biz_opaque_callback_data` vuelva en todos los estados (`sent`, `delivered`, `read`, `failed`) y también cuando la respuesta del envío se perdió (F-19).
2. Que `contacts[0].wa_id` de la respuesta coincida con el `from` del entrante, y la forma `521…` frente a `52…` en México al atribuir.
3. Que la carga de un botón de respuesta rápida vuelva tal cual en `button.payload` (hasta 128 caracteres).
4. Reutilizar el identificador del archivo del encabezado en muchos envíos y su vigencia.
5. Los códigos del apéndice B tal como Meta los manda (al enviar y en el estado) y el límite diario real por nivel.
6. Ritmo sostenido de 10 por segundo sin 130429 con el chat atendiendo a la vez (F-4: banco de 6,500 con estados antes de publicar; primeras difusiones reales con ritmo bajo).

## Pruebas

`test/broadcasts-engine.test.mjs`: migración sobre una base con datos; reglas puras; la unión con `channel-health` con un doble; envío suelto idempotente, en duda sin reenviar y atribución (también que otra persona con la carga o la cita ajena no queda atribuida); de punta a punta con el servidor real y el Meta de mentira: 300 contactos con cada motivo de exclusión, costo contra la tarifa vigente, un mensaje por destinatario, estados por aviso y libro de costos, respuesta por botón y por texto atribuidas con la conversación en el curso de la difusión y el mismo contacto; detención por tasa de fallos y por plantilla pausada (por código y por estado), pausa, reanudación, cancelación, tope diario, programada a su hora y **reinicio a medias**; apagado por omisión, sólo ensayo sin WhatsApp real, permisos y alcance por marca. `test/campaigns.test.mjs` y las de plantillas pasan sin cambios.
