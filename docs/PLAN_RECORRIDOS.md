# Recorridos de conversación: guardado y motor en el servidor

Incrementos N-0 «Preparación» y la parte de servidor de N-4 «Flujos: modelo y motor» (diseño de automatización §3 y §6; conciliación técnica, filas 2, 3, 12, 20, 27, 28, 31 y 33). Un **recorrido** se guarda, se publica y atiende solo a quien escribe: manda la información del curso, espera, pregunta con botones, sigue según la respuesta, pide un dato, manda los datos para inscribirse y pasa con una persona. **Sin esquema de la escalera nueva**: migración con nombre `chatflows/0001-chatflows`. Todo nace apagado. La pantalla (`public/screens/automatizacion/`) todavía trabaja con datos de ejemplo; conectarla a estas rutas es el encargo siguiente.

## Modelo y versiones

- El grafo, sus 24 tipos de paso, salidas, límites y validación son los de `public/kit/shared/flow-model.js`; el servidor **importa ese archivo** (no una copia) para limpiar (`repairGraph`, `normalizeSettings`) y validar (`validateGraph`, `validateSettings`).
- Tablas: `chatflows` (borrador `draft`, `settings`, `start`, `status` draft|active|paused|archived, `revision` para `expectedRevision`, `client_ref`), `chatflow_versions` (inmutables), `chatflow_sessions` (una viva por conversación, índice único parcial) y `chatflow_events` (bitácora por paso). Ninguna guarda `contact_id`: el contacto se busca por la conversación.
- **Borrador y publicada.** Guardar cambia sólo el borrador. Publicar valida el borrador con las listas reales de la marca (etiquetas, cursos, personas, materiales, datos del contacto) y lo congela como versión `n+1`. Una sesión corre siempre la versión con la que empezó.
- **Inicio** (`start`, se congela con la versión; en el diseño lo decidían las reglas de N-3, que no existen todavía): `manual` (por omisión: sólo desde el chat), `first_message` (primer mensaje de la conversación), `keyword` (`keywords` hasta 30, `mode` contains|exact|fuzzy, con `keywordMatch` de `server/lib/conditions.mjs`) y `any_message`. Orden: palabra clave, primer mensaje, cualquier mensaje; dentro de cada tipo, el más antiguo. Respeta `settings.reentry` y `settings.courseOverrides`.

## Orden de atención (lo que pasa cuando la persona escribe)

Al guardar el mensaje (sin cambios): duplicado, número en pausa o en **modo escucha** (no se crea trabajo), baja (`contacts.recordInbound` → `cancelConversationSteps` → la sesión termina `opt_out`), comprobante de pago (cola humana). Sólo si el asistente está a cargo, sin responsable y la conversación abierta se crea el trabajo de siempre. Después, en `processJob` (`server/index.mjs`), **el despachador** (`server/app/dispatch.mjs`) pregunta a los motores registrados antes que al asistente:

1. Sesión en curso y la marca ya no habla sola (automatización apagada o nivel «Apagado»/«Sugerir»): termina `automation_off`; contesta el asistente.
2. El texto pide la baja: termina `opt_out`; el asistente confirma.
3. La sesión espera una respuesta: botón o número de opción → sigue por esa salida; respuesta válida de una Pregunta → se guarda y sigue; no válida → mensaje de error y otro intento (luego «No válida»). Pide una persona, se queja, pide reembolso o avisa que pagó → **interrupción**: termina `handoff` y el asistente lo pasa a una persona. Otra cosa → **desvío**: contesta el asistente y vuelve a ofrecer los botones; al llegar a `maxMisses` termina `left`. Opción «Responde el asistente» → el asistente contesta esa intención (`forcedIntent`) con el menú a la vista. Con `onUnexpected: repeat|default` se comporta como dice el modelo.
4. Sin sesión: si un recorrido publicado y activo de la marca arranca con ese mensaje, lo atiende.
5. Nadie lo tomó: el asistente de siempre (flujo de bienvenida → intención → conocimiento → IA). Con una sesión viva el flujo de bienvenida no decora la respuesta (`noFlow`). **Sin recorridos publicados todo responde exactamente como antes.**

Cada mensaje que atiende un recorrido deja una fila en `reply_log` con `intent = 'flow'`, `action` replied|escalated y `sources = [{type:'flow', id, version, node}]`.

## Tipos de paso

**Soportados:** Inicio; Mensaje (texto con `{{dato}}`, `{{contacto.clave}}`, `{{var.x}}`, `{{x|respaldo}}`, y material aprobado); Botones (encabezado de texto o flyer del curso, pie, opciones que siguen o que contesta el asistente; tiempo límite por «Sin respuesta»); Pregunta (texto, número, correo, teléfono, fecha, hora, fecha y hora, formato propio; guarda en variable o en un dato propio de la marca); Condición (dato o variable, etiqueta, horario de atención, día y hora, curso, canal; evaluada con `server/lib/conditions.mjs`); Espera (paso duradero); Guardar dato (dato propio de la marca, `source: 'flow'`); Etiquetas; Pasar con una persona (`replies.escalate` y, si se eligió, `operations.assign`); Estado «Resuelta» (`lifecycle.resolve`); Asistente «que siga él»; Ir a otro recorrido (publicado y activo, hasta 5 saltos); Fin; Ficha del curso, Precio, Temario y Fechas y cupo (**siempre del catálogo vigente**, con su instantánea comercial; precio avanza la etapa a «interesado»); Inscripción (recuerda el pedido vigente o crea uno con su enlace si la venta en línea está activa; si no, «Pago manual» o pasa con una persona; **nunca confirma un pago ni marca nada como pagado**); Nota (no se ejecuta).

**Rechazados al publicar** (error `unsupported` con su motivo): Lista, Plantilla de WhatsApp, Suscribir/Dar de baja, Servicio externo, «¿Qué curso te interesa?», Asistente «contestar y seguir» y «recolectar», Estado «Esperando», partes de Mensaje con archivo o material por espacio, encabezado de Botones con archivo, «guardar el botón elegido», Pregunta de archivo o ubicación, guardar en un dato de sistema (nombre, correo, teléfono…), Fechas con lista de sesiones y pasar con «la última persona».

## Seguridad y topes

- **Interruptores** (ninguno nuevo): `automation_settings.enabled` de la marca y sin pausa global, nivel del asistente «Plantillas» o «Autónomo», y el recorrido publicado y `active`. Pausar impide sesiones nuevas (con `stopSessions: true` detiene las vivas); archivar las detiene.
- **Una persona manda:** escribir, tomar, asignar, transferir o cerrar pasan por `cancelConversationSteps`; su gancho (`onConversationCancel`) termina la sesión (`human_takeover`, `closed`, `opt_out`) y cancela sus pasos. Antes de cada paso el motor vuelve a comprobarlo.
- **Ventana de 24 horas** (`channel.windowOf`): un paso que habla con la ventana cerrada termina la sesión `window_closed`. Toda salida es `insertMessage` (ventana, modo escucha del número, entrega) con `forBrand`.
- **Topes:** 25 pasos por avance (luego cede el turno con un paso de 1 s), 200 pasos por sesión, 12 mensajes seguidos sin respuesta de la persona, y volver a un paso en el mismo avance sin esperar a la persona: la sesión termina `error`, avisa y pasa a una persona.
- **Idempotencia:** mensajes con `client_ref = flow:<sesión>:<seq>:<n>`; pasos `flow.wake` con `dedupe_key = flow:<sesión>:<seq>:<delay|timeout|reminder|yield>` y comprobación del `seq` antes del efecto (`session_moved`); `last_input_message_id`; inicio por mensaje con `source_key = msg:<id>`, manual con `manual:<clientRef>`. Un webhook repetido ya no llega al trabajo.
- **Esperas duraderas:** viven en `automation_steps` (arrendamiento de 60 s, reintentos). Tras un reinicio el paso sigue pendiente y corre una vez.
- **Formato propio de una Pregunta:** una sola regla en el modelo compartido (`patternProblem`, `safePattern`, `matchesPattern` de `flow-model.js`) para el editor, publicar, el simulador y el motor: hasta 120 caracteres, sin paréntesis sin escapar (ni grupos ni miradas), sin retrorreferencias, como mucho 3 repeticiones sin tope y {n,m} de hasta 100; el texto se compara sólo si mide hasta 200 caracteres. Un patrón fuera de la regla nunca coincide ni lanza. (La vista previa local del lienzo, `lienzo/sim.js`, todavía evalúa la expresión en el navegador sin esta regla.)
- **Sin red en la transacción.** Un fallo del motor se deshace con un `SAVEPOINT`; el mensaje de la persona ya estaba guardado; la sesión termina `error`, se anota `chatflow_error` en `automation_events`, la persona recibe el aviso de que la atenderá una persona y la conversación pasa a la cola.

## Rutas (`/api/chatflows`; lectura `inbox.view`, escritura `automation.manage`, chat `inbox.reply`)

| Ruta | Cuerpo → respuesta |
| --- | --- |
| `GET /api/chatflows?brand=&archived=1` | `{flows:[resumen], limits, startTypes}`; resumen = `{id, brandId, name, description, status, start, revision, publishedVersion, createdAt, updatedAt, metrics:{sessions, inProgress, completed, handoff, left, dropped, excluded}}` |
| `POST /api/chatflows` | `{brandId, name, description?, graph?, settings?, start?, fromFlowId?, clientRef}` → 201 `{flow, duplicate}`; `flow` = resumen + `graph` + `settings` |
| `GET /api/chatflows/:id` | `{flow, versions:[{version, name, note, publishedBy, publishedAt}], issues:{errors, warnings}}` |
| `PUT /api/chatflows/:id/draft` | `{expectedRevision, graph?, settings?, start?, name?, description?}` → `{flow, issues}`; 409 `stale_record`; 400/413 `flow_limit` |
| `POST /api/chatflows/:id/validate` | `{graph?, settings?, start?}` → `{ok, issues}` |
| `POST /api/chatflows/:id/publish` | `{expectedRevision, note?}` → `{flow, version}`; 422 `flow_invalid` con `details.issues` |
| `POST /api/chatflows/:id/activate` · `/pause` · `/archive` | `{expectedRevision, stopSessions?}` → `{flow, stopped}`; activar sin publicar: 409 `flow_unpublished` |
| `POST /api/chatflows/:id/duplicate` | `{clientRef, name?}` → 201 `{flow, duplicate}` (copia el borrador, sin versiones) |
| `POST /api/chatflows/:id/simulate` | `{graph?, settings?, version?, state?, input?:{text}|{optionId}, courseId?, channel?}` → `{messages:[{from:'flow'|'person'|'assistant', text, buttons, flyer, reason?}], state, trace:[{event, nodeId, port, detail}], waiting:{kind, nodeId, options}|null, ended, outcome, notes}`. No escribe ni envía nada; `state` se devuelve en la siguiente llamada, pero del estado sólo se toman el paso, las variables (acotadas) y los contadores: lo que espera el paso se reconstruye desde el grafo. Probar un grafo sin guardar pide `automation.manage` y la misma validación que publicar (422). 60 por minuto por persona. |
| `GET /api/chatflows/:id/versions/:v` | `{version:{version, name, graph, settings, start, note, publishedBy, publishedAt}}` |
| `GET /api/chatflows/:id/sessions?state=active|ended&before=&limit=` | `{sessions:[{id, flowId, version, conversationId, state, nodeId, waiting, steps, outcome, startedBy, expiresAt, startedAt, updatedAt, endedAt, customerName}]}` |
| `GET /api/chatflows/:id/sessions/:sid` | `{session, events:[{seq, node_id, node_type, event, port, detail, created_at}]}` |
| `GET /api/chatflows/:id/log?limit=` | `{events}` del recorrido, del más reciente al más antiguo |
| `GET · POST · DELETE /api/chatflows/conversations/:cid` | sesión viva (`{session|null}`); iniciar a mano `{flowId, clientRef}` → 201 `{session, duplicate}` (409 si no está con el asistente, la marca no habla sola, la ventana está cerrada o ya hay una sesión); detener → `{stopped}` |

Resultados de sesión: los de `FLOW_RESULTS`/`flowResult` del modelo más `automation_off` y `stopped` (cuentan como «fuera de las tasas»). Tiempo real v2: `chatflows.changed` `{brandId, data:{flowId, kind|sessionId, …}}`.

## Fuera de este encargo

La pantalla; reglas por palabra clave y su panel «Orden de atención» (N-3); materiales con archivo y por espacio (N-2); disparadores por evento o tiempo y secuencias (N-6); llamadas a servicios externos; analítica de recorridos (sólo hay contadores por resultado); restaurar una versión al borrador, exportar e importar; convertir el flujo de bienvenida (sigue igual y, sin sesión viva, sigue decorando al asistente); listas interactivas y plantillas de WhatsApp dentro de un recorrido; recordatorio sin probar contra WhatsApp real.

Pruebas: `test/chatflows-engine.test.mjs` (motor sin base) y `test/chatflows.test.mjs` (migración, almacén, venta de punta a punta, desvíos, tiempo límite, toma humana, baja, ventana cerrada, automatización apagada, fallo del motor, dos marcas, reinicio sin duplicar, inicio manual, webhook repetido y modo escucha con el Meta de mentira).
