# Recepción duradera de webhooks, arrendamientos y apagado ordenado (F0-12)

Cimiento de fiabilidad antes de conectar un número real de WhatsApp. **No cambia nada visible.** Dos migraciones con nombre, sólo aditivas: `inbox/0001-webhook-inbox` y `queues/0001-leases`. Sin publicar.

## Qué hace

1. **Recibir es guardar.** La ruta `/api/webhooks/<tipo>/<proveedor>` verifica la firma, guarda cada evento normalizado en `webhook_inbox` (todos los de una petición en una transacción) y responde. Un trabajador los procesa aparte con las mismas funciones de siempre (`apply`, `applyInbound`): la descarga de archivos y el alta del cliente ya no ocurren dentro de la petición, y un evento guardado sobrevive a un reinicio.
2. **La respuesta no cambia.** La petición espera un tiempo acotado a que sus eventos terminen y devuelve los `results` de siempre. Si no terminan a tiempo responde `200` con `result: "en cola: se procesa en segundo plano"` y `queued: true`. Un entrante que falla de forma inesperada ya no responde 503: lo reintenta el servidor, no Meta. Sigue respondiendo 503, sin guardar el entrante, cuando WhatsApp real está elegido pero incompleto.
3. **Orden por carril.** Los eventos de un carril se procesan de uno en uno y en orden de llegada; carriles distintos avanzan a la vez (hasta 8). Carriles: entrante `in:<proveedor>:<número que recibe>:<huella de quien escribe>`, estado `st:<proveedor>:<referencia>`, pago `pay:<proveedor>:<pedido>`, otro `ev:<proveedor>:<id>`. Quien escribe es el primer identificador de `peer.ids` (teléfono o identificador de usuario) y, mientras el contrato 1.1 no llegue, el campo `from`; va como huella **con llave** (HMAC-SHA256 con la llave de la instalación, `PEER_HASH_KEY` o `DATA_DIR/peer.key`; ver [PLAN_CONTRATO_CANAL.md](PLAN_CONTRATO_CANAL.md) §2.1) para no guardar otro teléfono en claro ni algo de lo que se pueda recuperar.
4. **Arrendamientos** en las colas que no los tenían. Una fila se reclama antes de trabajarla y el resultado sólo lo anota quien conserva el arrendamiento: dos procesos no hacen lo mismo a la vez, y lo que deja un proceso muerto se retoma al vencer.
5. **Apagado ordenado.** Con `SIGTERM` o `SIGINT` el servidor deja de aceptar conexiones y para todos los relojes, espera como mucho `SHUTDOWN_GRACE_MS` a lo que está en vuelo (bandeja, envíos del canal, trabajos del asistente), cierra sockets y base, y sale. Lo que tenía reservado en la bandeja y los trabajos que no terminó quedan libres para el arranque siguiente.

## Estados de `webhook_inbox`

| Estado | Significa | Sale de él |
| --- | --- | --- |
| `pending` | Guardado, sin procesar (o esperando reintento en `next_attempt_at`) | Lo reserva el trabajador cuando es la cabeza de su carril |
| `reserved` | Un trabajador lo procesa; arrendamiento de 120 s | `done`, `failed`, o vuelve a `pending` si falla o vence el arrendamiento |
| `done` | Procesado; `result` trae el texto de siempre y `payload` queda vacío | Se borra a los 30 días |
| `failed` | Error permanente (4xx o `permanent`) o 12 intentos agotados (de 2 s a 30 min). Conserva su carga y **no bloquea su carril** | Reproceso manual; la carga se vacía a los 14 días y la fila se borra a los 90 |

**Cuarentena.** Un entrante real sin identificador de quien escribe queda `failed` con `error = no_identifier`, sin anotarse en `connector_events`, para reprocesarlo cuando el código sepa leer su identificador.

## Ver y reprocesar (sólo administración)

- `GET /api/connectors/inbox?state=failed|pending|reserved|done|all&limit=100` → `{stats, items}`. Nunca devuelve la carga (lleva textos y números); `hasPayload` dice si la fila aún se puede reprocesar.
- `POST /api/connectors/inbox/<seq>/retry` → la fila fallida vuelve a `pending` con los intentos en cero. Queda en la auditoría (`connectors.inbox.retry`). 409 si no está fallida o ya no conserva su carga.

Van bajo `/api/connectors` y no bajo `/api/admin` porque ese prefijo lo reclamará el módulo de métricas (F0-09), que podrá exponer lo mismo con `connectors.inbox.stats()` y `connectors.inbox.retry(seq)`.

## Arrendamientos por cola

| Cola | Arrendamiento | Si el proceso muere a la mitad |
| --- | --- | --- |
| Entrega del canal, sólo conversaciones reales (`messages.send_lease_until`, `send_attempts`) | 120 s, tomado antes de llamar a Meta | **Envío en duda**: no se sabe si salió. Ver abajo |
| Entregas de eventos (`domain_deliveries`) | 60 s; cada suscriptor tiene 30 s | Se entrega otra vez al vencer (los suscriptores son idempotentes) |
| Webhooks salientes (`webhook_deliveries`) | 45 s | Se reenvía con el mismo `TC-Delivery` |
| Trabajos del asistente (`jobs`) | 5 min | Se repite la llamada a la IA, no el mensaje |
| Mensajes programados, push | No hace falta | Ya eran atómicos |

**Envío en duda** (`WA_UNCERTAIN_SEND`). `retry`, por omisión: el texto libre se reenvía una vez al vencer la marca y deja una fila `lease_expired` en su historial de entrega. `fail`: no se reenvía; queda «no entregado» con el motivo «No se confirmó si este mensaje salió…» y alguien decide con «Reintentar». En los dos casos **una plantilla nunca se repite sola** (cuesta dinero y la persona la vería dos veces) y al tercer envío en duda seguido se deja de insistir. Mientras una conversación tiene un envío en vuelo no sale nada más de ella, para no desordenarla.

## Variables de entorno

| Variable | Para qué | Por omisión |
| --- | --- | --- |
| `WEBHOOK_INBOX_WAIT_MS` | Cuánto espera la petición del webhook a que sus eventos terminen. `0` = responder en cuanto se guardan. Tope 9 000 | `3000` (`8000` con `NODE_ENV=test`) |
| `WA_UNCERTAIN_SEND` | Qué hacer con un envío de WhatsApp en duda: `retry` o `fail` | `retry` |
| `SHUTDOWN_GRACE_MS` | Cuánto espera el apagado a lo que está en vuelo. Tope 60 000 | `1500` |
| `WEBHOOK_INBOX_PAUSED=1` | **Sólo pruebas** (`NODE_ENV=test`): se guarda y no se procesa | Sin definir |

En producción se recomienda `SHUTDOWN_GRACE_MS=10000` y dar ese mismo margen al servicio entre `SIGTERM` y la terminación forzada (ajuste de Railway; su valor actual está sin verificar).

## Límites conocidos

- Tras una **caída** (no un apagado ordenado), un evento que quedó reservado espera a que venza su arrendamiento: hasta 2 min un entrante y hasta 5 min un trabajo del asistente.
- Se guarda el evento **normalizado**, no el cuerpo de Meta. Lo que `parseWebhook` todavía no lee (identificador de usuario, cuenta) no queda en la fila, así que una cuarentena de hoy no recupera ese dato al reprocesarse. La carga lleva la versión del contrato (`{v, event}`) y el lector acepta las dos formas; **antes de desplegar un cambio de contrato conviene vaciar la bandeja**.
- `retry` puede duplicar un texto libre si Meta lo aceptó justo antes de la caída. Es la opción de hoy; `fail` lo evita a cambio de una revisión manual.
- Cada evento cuesta dos o tres escrituras más que antes (guardar, reservar, anotar).

## Código y verificación

`server/app/webhook-inbox.mjs` (bandeja), `server/app/leases.mjs` (piezas comunes), `server/app/shutdown.mjs` (apagado); cambios acotados en `connectors.mjs`, `channel.mjs`, `events.mjs`, `integrations.mjs` e `index.mjs`.

Pruebas: `test/webhook-inbox.test.mjs` (bandeja con reloj inyectado), `test/webhook-inbox-http.test.mjs` (servidor real y Meta de mentira: en cola, orden por persona, reinicio, cuarentena, 503), `test/queue-leases.test.mjs` (dos trabajadores sobre la misma base y muerte a mitad, por cola), `test/durable-restart.test.mjs` (el servidor muere con un envío en vuelo; trabajo arrendado) y `test/shutdown.test.mjs` (apagado, también de punta a punta). Falta probarlo contra Meta de verdad.
