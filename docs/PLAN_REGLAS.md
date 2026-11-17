# Reglas por mensaje (incremento N-3)

**Estado:** construido en la rama de integración, sin publicar. Pantalla en vista previa (`visibility: "preview"`). Todo nace apagado: una regla nueva es un borrador y sólo atiende encendida, con la automatización de la marca encendida y su asistente respondiendo solo.

## Qué es

Hasta ahora una marca contestaba sola de dos maneras: el asistente de siempre y los recorridos publicados. Faltaba lo ligero de en medio: una **regla**.

> Cuando un mensaje coincide con estas palabras (contiene, es exactamente, empieza con, se parece) y, si se quiere, con estas condiciones (canal, curso, horario de atención, etiquetas del contacto, primer mensaje de la conversación), haz estas acciones.

Acciones:

| Acción | Clase | Qué hace |
| --- | --- | --- |
| Agregar etiqueta / Quitar etiqueta | silenciosa | `contacts.addTag` / `removeTag` (componibles, dentro de la transacción; respetan el máximo de etiquetas). |
| Responder con un texto | voz | Texto de la marca con datos `{{nombre}}`, `{{curso}}`, `{{precio}}`, `{{fecha}}`, `{{contacto.<clave>}}`… (los mismos de los recorridos). Un importe tecleado se rechaza: el precio sale del catálogo. |
| Enviar un material aprobado | voz | `catalogue.prepare(c, {templateId})`: sólo un material aprobado para la marca, curso, edición y canal; sale con su instantánea comercial. |
| Iniciar un recorrido | voz | Un recorrido publicado y activo de la marca (`chatflows.runtime.start`, `startedBy: 'rule'`). Desde ahí el recorrido atiende los siguientes mensajes. |
| Pasar con una persona | control | A la cola (`replies.escalate`) o a una persona (`operations.assign`), con un aviso opcional. |
| Cambiar el estado | control | «Pendiente» (`lifecycle.pend`) o «Resuelta» (`lifecycle.resolve` y los mismos efectos que «Resolver» del chat). No envía nada. |

Dentro de una regla corren primero las silenciosas, luego las de voz y al final las de control. Entre reglas, **todas** las que coinciden ejecutan sus acciones silenciosas, pero sólo **la primera** que coincide con voz o control habla (diseño §5.5, D3). Una regla puede pedir «no revisar las de abajo».

Ninguna regla confirma un pago, cobra ni escribe precios, fechas o cupos: lo comercial sale del catálogo.

## Orden de atención

Fijado en `server/app/dispatch.mjs` (`ORDER`) y mostrado en la pantalla:

1. **Una persona del equipo tomó el chat** → nada automático (el trabajo del asistente ni siquiera llega al despachador; ya era así).
2. **Un recorrido en curso** → el recorrido toma la respuesta.
3. **Reglas por mensaje**, en el orden de la lista.
4. **Un recorrido publicado que arranca** con ese mensaje.
5. **El asistente de la marca** (incluye la baja con palabras: «baja», «no me escriban» la atiende siempre el asistente; las reglas no corren).

Cómo se logra sin tocar los recorridos: el motor `rules` se registra con `ORDER.rules` (30), antes que `chatflows` (40), y **cede el turno** si hay un recorrido en curso. Si la espera de ese recorrido ya venció, lo termina con «timeout» exactamente como lo haría el recorrido y sigue con las reglas (diseño §3.2, paso 3 «expired → paso 4»). Sin reglas encendidas en la marca, el motor sale en la primera consulta (`hasActive`) y no lee ni escribe nada más: el comportamiento es byte a byte el de antes.

Diferencias con el diseño: no existen todavía los pasos «pulsó un botón con acción» (§3.3, prioridad 5) ni «silencio fuera de horario» (`quiet_outside_hours`); el resto del orden es el mismo.

## Seguridad

- Sólo con `automation.enabledFor(marca)` y el nivel del asistente en «Responder con plantillas» o «Autónomo con IA» (la misma regla que `runtime.brandSpeaks` de los recorridos), con la conversación abierta, el asistente a cargo y nadie del equipo asignado.
- Todo mensaje sale por `host.insertMessage` (ventana de 24 horas, modo escucha, entrega), con `forBrand` para el modo real. Antes de cada mensaje se revisa una vez por mensaje entrante: ventana cerrada (`window_closed`), contacto que pidió la baja (`opted_out`), número en modo escucha (`listen_only`) y el tope de respuestas seguidas (`consecutive_cap`). Si alguno aplica, las acciones de voz quedan «omitidas» con su motivo; las silenciosas y el pase a una persona sí corren.
- **Tope de respuestas seguidas** (por marca, 1 a 20, por omisión 3): cuenta las últimas respuestas de la conversación en `reply_log` que son de reglas; al llegar al tope contesta el asistente y la racha vuelve a empezar. Evita un bucle con otro sistema automático al otro lado.
- **Frecuencia por regla:** «cada vez», «una vez por conversación» o «con un descanso» de 1 a 10 080 minutos. Sólo cuentan las veces en que la regla hizo algo.
- **Cada regla corre en su SAVEPOINT.** Si falla, lo suyo se deshace entero (por ejemplo, la etiqueta que puso), queda anotada como «falló» con su motivo en `last_error`, se avisa a administración (`automation_events`, `rule_error`) y siguen las demás reglas y después el resto del orden. Si fallara el motor entero, `passOnError` hace que el despachador siga con el siguiente motor (un recorrido que arranca) en lugar de saltar al asistente.
- **Sin duplicados:** una fila por regla y por mensaje (`UNIQUE(rule_id, source_key)`); un trabajo que se repite no repite la regla. Los mensajes llevan `client_ref` `rule:<regla>:<mensaje>:<n>` y el recorrido iniciado, `source_key` `rule:<regla>:<mensaje>`.
- **Alcance por marca** en cada consulta de `repo.mjs`: una regla de una marca no existe para otra, ni al atender ni en la API.

## Bitácora y contadores

- Cada mensaje que una regla contesta deja **una fila en `reply_log`** con `intent = 'rule'`, `action` `replied`, `escalated` o `skipped` (sólo cambió el estado), el primer mensaje enviado y `sources = [{type:'rule', id, revision}]` (más `{type:'flow', …}` si inició un recorrido). Actividad y el «por qué respondió» del chat siguen completos.
- `automation_rule_runs`: resultado (`executed`, `partial`, `skipped`, `failed`), si habló y cada acción con su motivo. Se purga a los 90 días (reloj `purga`, cada hora, por trozos de 500).
- En la regla: `executions` (veces que hizo algo), `last_run_at` y `last_error`.

## Datos (migración con nombre `rules/0001-rules`)

Aditiva, tablas propias:

- `automation_rules`: `brand_id`, `title`, `trigger`, `definition` (JSON, versión 1), `status` (`draft`, `active`, `paused`, `archived`), `position`, `revision`, `executions`, `last_run_at`, `last_error`, `client_ref`.
- `automation_rule_runs`: bitácora, `UNIQUE(rule_id, source_key)`.
- `automation_rule_settings`: por marca, `order_revision` (candado del orden) y `max_consecutive`.

La definición:

```json
{
  "v": 1,
  "trigger": { "type": "keyword", "mode": "contains", "words": ["precio", "costo"] },
  "conditions": { "version": 1, "match": "all", "groups": [{ "match": "all", "rules": [
    { "field": "channel", "op": "in", "value": ["whatsapp"] },
    { "field": "hours", "op": "eq", "value": "closed" }
  ] }] },
  "actions": [{ "type": "send_text", "text": "Hola, {{nombre}}. El precio de {{curso}} es {{precio}}." }],
  "options": { "stop": false, "limit": "always" }
}
```

Las condiciones usan la gramática común de `server/lib/conditions.mjs` (campos `channel`, `course`, `hours`, `tags`, `first_message`). Las palabras clave usan `keywordMatch` (contiene, exacto, parecido) y «empieza con» compara palabras completas al inicio; nada que escriba una persona se compila como expresión regular. Límites: 30 palabras de 60 caracteres, 8 acciones, texto de 4 096 caracteres, 16 KB, 100 reglas por marca.

## Rutas y permisos

Lectura: `inbox.view` de la marca. Escritura: `automation.manage` (administración).

| Ruta | Qué hace |
| --- | --- |
| `GET /api/rules` | Marcas que la persona ve. |
| `GET /api/rules?brand=` | Reglas en su orden, ajustes, estado de la marca y el orden de atención. |
| `GET /api/rules/lists?brand=` | Etiquetas, cursos, materiales aprobados, recorridos publicados y personas para el editor. |
| `POST /api/rules` | `{brandId, title, definition, clientRef}` → 201 en borrador y arriba de la lista; el mismo `clientRef` devuelve la misma regla. |
| `GET /api/rules/:id` · `PATCH /api/rules/:id` | Leer; editar con `expectedRevision` (409 `stale_record`). Una regla encendida sólo se guarda si sigue pudiendo ejecutarse. |
| `POST /api/rules/:id/activate` · `/pause` · `/archive` | Con `expectedRevision`. Encender exige referencias listas (409 `rule_not_ready` con `issues`). |
| `PUT /api/rules/order` | `{brandId, ids, expectedOrderRevision}`: la lista completa, con candado. |
| `PATCH /api/rules/settings/:brandId` | `{maxConsecutive, expectedRevision}`. |
| `GET /api/rules/:id/runs?before=` | Bitácora de la regla. |
| `POST /api/rules/test` | `{brandId, text, channel?, courseId?, firstMessage?, tags?, hours?, draft?}` o `{conversationId, text}` → qué pasaría en cada paso del orden y con cada regla. **No escribe ni envía nada.** Con `draft` prueba una definición sin guardar (requiere `automation.manage`). |

Tiempo real v2: `rules.changed` `{brandId, data:{ruleId?}}`.

## Pantalla

`public/screens/reglas/` (menú WhatsApp, junto a Automatización; vista previa): selector de marca, lista con subir y bajar (cada movimiento guarda con el candado del orden), encender, pausar, editar, bitácora y archivar; editor en ventana (Cuándo, Sólo si, Entonces, Frecuencia, y «Probar esta regla»); «Probar con un mensaje»; el panel del orden de atención y el tope de respuestas seguidas. El diseño la ponía como pestaña dentro de Automatización; va como pantalla propia para no tocar la de recorridos, que está publicada.

## Archivos compartidos que cambiaron

- `server/app/dispatch.mjs`: la constante `ORDER` (el orden fijo) y la opción `passOnError` en `register`. Sin motores con esa opción, el despachador se comporta igual que antes.
- `server/migrations/registry.mjs`: una línea para el área `rules`.

## Pruebas

- `test/rules-definition.test.mjs`: forma de la definición, los cuatro modos de palabra clave, condiciones, orden de la lista, «no seguir», textos con datos y el despachador (orden y `passOnError`).
- `test/rules.test.mjs` (servidor real): migración sobre base publicada y persistencia; almacén (clientRef, revisión, referencias, orden, permisos, marca, «Probar» sin efectos); cada acción; orden de la lista; orden de atención contra persona, recorrido en curso, recorrido que arranca y asistente; una vez y descanso (moviendo la hora de la bitácora, sin depender del reloj); tope de respuestas seguidas; automatización apagada, nivel «Sugerir al asesor», baja, contacto dado de baja, ventana cerrada, alcance por marca, regla que falla y su reversión; WhatsApp real con webhook repetido y número en modo escucha.
- `test/ui/reglas.spec.mjs`: crear (con el aviso del importe tecleado), ordenar, encender y probar, con Niebla en la pantalla y en el editor, en computadora y celular.

## Lo que falta

- Disparadores que no son mensajes (atributo, etiqueta, estado, etapa, pedido), reglas «pulsó un botón» y la acción «guardar un dato» (diseño §5.3 y §5.5; incremento N-6).
- Condiciones `intent`, `message_kind`, `from_ad`, `attr`, `clock` y `no_keyword`; `courses.keywords` y «curso nombrado».
- Plantilla de WhatsApp de respaldo con la ventana cerrada y la acción «Enviar plantilla».
- Versiones de una regla y restaurar (`automation_rule_versions`), duplicar, el cortacircuitos por hora de la marca (`hourly_cap`) y «silencio fuera de horario».
- Panel de la conversación con las reglas que corrieron (`GET /api/autocore/conversations/:id`).
- Arrastrar para ordenar (hoy: subir y bajar, que también sirve con teclado y en celular).
- Cuando exista `routing.assign` (conciliación, fila 27), la acción «Pasar con una persona» debe usarlo en lugar de `operations.assign`.
- Probarlo con WhatsApp real de verdad (sólo se probó con el Meta de mentira de las pruebas).
