# Ciclo de vida de la conversación (B-I1)

Incremento 1 de la bandeja (diseño de bandeja §2; conciliación técnica, filas 20 a 25 y 33). Migración con nombre `lifecycle/0001-lifecycle`; módulo `server/modules/lifecycle/` (con `repo.mjs`); búsqueda única del hilo en `server/lib/conversation-thread.mjs`. Pruebas: `test/lifecycle.test.mjs` y `test/ui/ciclo-de-vida.spec.mjs`.

## El modelo: dos ejes que ya no se mezclan

| Eje | Dónde | Valores | Quién lo cambia |
| --- | --- | --- | --- |
| **Estado** (nuevo) | `conversations.state` | `open` Abierta · `pending` Pendiente (el equipo espera algo de la persona) · `solved` Resuelta · `expired` Expirada · `awaiting` y `blocked` (reservados: «Nuevo chat» y bloqueo, incrementos posteriores) | Este módulo y nadie más |
| **Quién atiende** (de siempre) | `status` + `bot_enabled` + `assigned_to` | Asistente · con asesor · espera asesor · cerrada | Como hoy: tomar, pasar a persona, reactivar reglas, reparto |
| **Etapa comercial** (de siempre) | `opportunities.stage` | sin cambios | sin cambios |

Única liga entre los dos primeros: `status='resolved'` ⇔ `state='solved'`. Pasar al asistente, a una persona o a la cola (`replies.escalate`, «Tomar chat», «Reactivar reglas», reparto) **no** cambia el estado.

Cada atención es un **ciclo** (`conversation_cycles`, la única tabla con autoridad, fila 21): lo abre un mensaje de la persona y lo cierra «Resolver» o la expiración. Guarda origen (`inbound`, `ad`, `broadcast`, `lab`…), primera respuesta, contadores, tiempo en pendiente, quién atendía al cerrar y si se perdió. Un ciclo abierto ⇔ estado `open` o `pending` (salvo una conversación del laboratorio sin mensajes de la persona, que todavía no tiene ciclo).

## Transiciones

| # | De → a | Disparador | Efecto |
| --- | --- | --- | --- |
| T1 | (nueva) → Abierta | Primer mensaje de la persona | Ciclo 1 (`opened_by='customer'`, origen); `previous_id` a la conversación anterior del hilo |
| T3/T8 | Expirada (o `awaiting`) → Abierta | La persona escribe | Ciclo nuevo en la **misma** conversación; `conversacion.reabierta` |
| T4 | Abierta → Pendiente | «Dejar pendiente» | `pending_since` en el ciclo |
| T5 | Pendiente → Abierta | La persona escribe, o «Quitar pendiente» | Suma `pending_ms` |
| T6 | Abierta/Pendiente → Resuelta | «Resolver» (botón nuevo o la acción `resolve` de siempre) | Cierra el ciclo (`solved_agent`); `status='resolved'`, `bot_enabled=0`, cancela trabajos y pasos, `operations.reset` |
| T7 | Abierta/Pendiente → Expirada | Reloj, con la ventana cerrada según `channel.windowOf(c).open` y la expiración encendida en la marca | Cierra el ciclo con «perdido» calculado; **no** toca `status`, `bot_enabled` ni `assigned_to` |
| T9 | Resuelta → Abierta | «Reabrir» con la ventana abierta | Quien reabre la toma (como «Tomar chat»); ciclo nuevo `opened_by='agent'` |
| T10 | Resuelta → Expirada | «Reabrir» con la ventana cerrada | `status='open'`, sin ciclo: en WhatsApp real sólo se puede enviar plantilla |
| T11 | Expirada → Resuelta | «Resolver» | Archiva; el ciclo ya cerrado sigue contando como expirado |

Un mensaje del equipo o del asistente nunca cambia el estado. Toda transición deja `operation_events` con `kind='state'`, sube `service_state.revision` (es el `expectedRevision` de las acciones) y publica `conversacion.estado`; además `conversacion.resuelta`, `conversacion.expirada` o `conversacion.reabierta` cuando corresponde. Resolver, expirar o reabrir **no envían nada** a la persona.

Hilo (comportamiento de hoy, «episodes»): la conversación viva del hilo es ésa; una resuelta no se reabre sola (la persona del laboratorio recibe 409 y abre «Nueva prueba»; en WhatsApp real nace otra conversación con `previous_id`). «Reabrir» responde 409 `newer_thread` si ya hay una más reciente viva.

## «Perdido»

Se calcula una vez, al expirar (T7), y queda en el ciclo:

- `handler_at_close`: `agent` si tenía responsable, `automation` si lo llevaba el asistente, si no `queue`.
- `missed=1` si la persona esperaba a una persona y nadie respondió (`service_state.waiting_since`), o si lo llevaba el asistente y su último mensaje quedó sin ningún saliente después. Si expiró en Pendiente, `missed=0` y `expired_while_pending=1` (se esperaba a la persona).
- `missed_strict=1` si en todo el ciclo no hubo ninguna respuesta.

Con el aviso encendido, el responsable y administración reciben la notificación «Se perdió una conversación» (tipo `missed`).

## Interruptores y valores por omisión (`inbox_settings`, por marca; sin fila = valores por omisión)

| Ajuste | Por omisión | Dónde |
| --- | --- | --- |
| `auto_expire` (expirar a las 24 h) | **apagado** | Pantalla «Ciclo de conversaciones» (vista previa) o `PATCH /api/lifecycle/settings/:brandId` (`settings.inbox`, `expectedRevision`, bitácora) |
| `missed_notify` | encendido | igual |
| `attribution_days` (respuesta atribuida a una campaña) | 7 | igual |
| `thread_mode`, `reopen_policy`, `reopen_owner_days` | `episodes`, `assistant`, 30 | sólo en la tabla; los usa el incremento 5 |

Al **encender** la expiración, lo que ya estaba vencido expira en silencio (ciclo `backfilled=1`, sin eventos ni avisos). El reloj (`lifecycle/reloj`, cada 60 s; 1 s en pruebas) es síncrono, trabaja por lotes de 200, relee cada conversación en su propia transacción y además repara lo escrito por fuera del módulo (`status='resolved'` sin pasar por aquí → Resuelta con cierre `repair`).

Datos existentes: la migración deja `state` (resueltas → Resuelta, el resto Abierta) y `origin`; los ciclos (uno por conversación, `backfilled=1`), contadores y columnas de la ventana los calcula el trabajo `lifecycle.backfill` por trozos, una sola vez. Nada expira al migrar.

## Rutas

`GET /api/lifecycle/conversations/:id` · `POST /api/lifecycle/conversations/:id/state` `{to, expectedRevision, clientRef}` (`inbox.resolve`; chat de otra persona sólo con `inbox.manage_others`; 409 `stale_record`, `collision`, `newer_thread`, `invalid_transition`) · `GET /api/lifecycle/conversations/:id/cycles` · `GET|PATCH /api/lifecycle/settings[/:brandId]`. Tiempo real v2: `inbox.upsert` e `inbox.settings`.

## Fuera de este incremento

Bandeja nueva con vistas y contadores (I2), bloqueo y desbloqueo (T12–T13), «Nuevo chat» con plantilla y `awaiting` (T2), hilo continuo y políticas de reapertura (I5), equipos (I7), roles finos (I9), bitácora de estados y su disparador (dueño: estadísticas, fila 23), y que `operations.reconcile` y la cola miren sólo `state IN ('open','pending')` (hoy una expirada sigue en la cola de espera como antes). Del resto de cimientos (M-A) sólo se añadieron `last_customer_at`, `last_outbound_at` y `window_until`.

## Preguntas abiertas para el dueño

1. ¿Expiración automática en qué marcas y desde cuándo? (Nace apagada.)
2. ¿Cuenta como perdido el chat que nadie tomó y expiró en la cola? (Hoy sí, separado por `handler_at_close='queue'`.)
3. ¿Usarán «Pendiente»? ¿Con recordatorio automático?
4. Al reabrir a mano, ¿debe quedar a cargo de quien reabre (hoy) o volver al asistente?
5. Hilo continuo por número (una sola conversación por persona) en lugar de una nueva tras resolver.
