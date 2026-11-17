# Secuencias de seguimiento

Diseño de automatización §5.8 («Secuencias», incremento 6) y conciliación técnica, fila N-6. Guía para el equipo de la marca: [GUIA_SECUENCIAS.md](GUIA_SECUENCIAS.md).

## Por qué

En la historia del propio negocio (sólo conteos), la mediana entre el primer mensaje y la inscripción fue de unos diez días, el 73 % de quienes se inscribieron recibió antes al menos una plantilla de seguimiento, y esos seguimientos se mandaban a mano como difusiones (unas cuatro por persona). El 43 % escribió una vez y nunca más. Una secuencia automatiza ese seguimiento con las mismas protecciones que el resto del CRM.

## Qué se construyó

| Pieza | Dónde |
| --- | --- |
| Migración con nombre `sequences/0001-sequences` (tablas `sequences`, `sequence_enrollments`, `sequence_events`) | `server/migrations/named/sequences/` |
| Módulo `sequences` (rutas, permisos, cableado) | `server/modules/sequences/module.mjs` |
| Motor (paso durable, reglas de alto, barrido, vista previa) | `server/modules/sequences/engine.mjs` |
| Modelo puro (validación, fechas en la zona de la marca, motivos) | `server/modules/sequences/model.mjs` |
| SQL | `server/modules/sequences/repo.mjs` |
| Pantalla en vista previa «Secuencias» (grupo WhatsApp) | `public/screens/secuencias/` |
| Pruebas | `test/sequences-engine.test.mjs` (reloj inyectado), `test/sequences.test.mjs` (servidor real), `test/ui/secuencias.spec.mjs` |

Sin columna de contacto en las tablas nuevas: la persona se lee de la conversación (`conversation_opportunities`), así que no hay tabla nueva que declarar en el registro de datos de persona y una fusión de contactos no deja filas huérfanas. Una sola inscripción viva por (secuencia, conversación): índice único parcial `sequence_active`.

## Definición

- **Secuencia**: nombre, descripción, curso opcional (sólo entran conversaciones de ese curso), hasta 10 pasos y sus ajustes. Nace **apagada**; hasta 50 por marca.
- **Paso**:
  - Cuándo: `{base:'enrolled', amount, unit: minutes|hours|days}` (hasta 90 días después de inscribirse) o `{base:'edition_start', daysBefore: 0–60, at:'HH:MM'}` (N días antes del día en que empieza la edición, 0 = el mismo día, a esa hora de la marca). La fecha de inicio sale **siempre** de `editions.starts_at` de la edición elegida al inscribir (la de la conversación o la próxima publicada del curso); nunca de un texto.
  - Qué envía: plantilla aprobada de WhatsApp (`templateId`), texto (con `{{nombre}}`) o material del catálogo (`materialId`, preparado por `catalogue.prepare`: precio, fechas y cupo del catálogo).
  - Si la ventana de 24 horas está cerrada (sólo texto o material): `template` (plantilla de respaldo), `skip` u `stop`.
  - Condición opcional con la gramática común (`server/lib/conditions.mjs`, los mismos campos de los recorridos: datos, etiquetas, curso, canal, horario). La API la acepta; la pantalla todavía no la edita (la conserva).
- **Ajustes**: quién entra (`manual`, `course_card` = recibió la ficha del curso, `enroll_interest` = preguntó cómo inscribirse), qué hacer si responde (`pause`/`stop`) y si alguien del equipo toma el chat (`pause`/`stop`), horario de envío (`business` = horario de atención de la marca; `daytime` = fuera del horario de silencio de las difusiones), frases de alto y de sí, tope del mes (1–100 000; 500 por omisión), consentimiento para plantillas promocionales (sí por omisión), horas sin escribir para reanudar sola (0–168; 24 por omisión; 0 = sólo a mano) y días para contar una inscripción en resultados (1–60; 7).
- Plantillas, materiales y curso se validan contra **la misma marca** al guardar, y otra vez al enviar (`wa-templates.forConversation`).
- Al inscribir se copian los pasos (`definition`): editar la secuencia no cambia las inscripciones en curso. Los ajustes (frases, topes, pausa o alto) se leen vivos.

## Cómo corre

- Cada mensaje es un paso durable `sequence.send` de la cola de automatización (`automation_steps`): arrendamiento, reintentos y sobrevive a un reinicio. Clave `seq:<inscripción>:<índice>:<schedule_seq>`; `schedule_seq` sube cada vez que se programa (esperas por horario o topes, reanudaciones).
- El mensaje lleva `client_ref = seq:<inscripción>:<índice>`: si el paso se ejecuta dos veces (arrendamiento vencido, reinicio), el mensaje existente se reutiliza y no se envía otro.
- En `commit` (dentro de la transacción del paso, la misma que inserta el mensaje y lo marca hecho) se vuelven a evaluar **todas** las reglas de abajo. Nada de red dentro.
- Todo sale por `host.insertMessage` (la única puerta de salida): ventana, modo escucha, entrega, reintentos y la categoría de costo (`service`, `utility`, `marketing`) que usa `wa-costs`. Texto en modo real pasa por `forBrand` (sin avisos de prueba).
- El siguiente paso se programa al enviar o al omitir el anterior. Un paso que no pudo salir en dos días desde su momento (o, si es relativo al inicio, después del día de inicio) se omite como «ya había pasado su momento».
- Un barrido (`timers: barrido`, cada 5 s) con tope de 100 filas por parte: detiene lo vivo de marcas sin automatización, lee respuestas, reanuda pausas, vuelve a programar inscripciones en curso sin paso vivo (por ejemplo, tras `cancelConversationSteps`) y hace la entrada automática.

## Reglas de alto (cada una se vuelve a mirar justo antes de enviar)

En este orden; la primera que aplica decide:

| Motivo | Cuándo |
| --- | --- |
| `sequence_off` | La secuencia se apagó o archivó (además, apagar o archivar detiene en el acto todo lo vivo). |
| `automation_off` | La automatización de la marca está apagada (pausa global incluida) o su asistente no está en «Plantillas» o «Autónomo». El barrido las detiene aunque la cola no tome el paso. |
| `closed` / `blocked` | La conversación se cerró (`status='resolved'`) o está bloqueada (`state='blocked'`). |
| `opt_out` | Consentimiento `opted_out`, o escribió un mensaje de baja desde el último paso (`contacts.isOptOutText`). |
| `suppressed` | Está en una lista de exclusión de la marca (`audiences.suppressed`). |
| `enrolled` | Pedido pagado del curso (de esta conversación o de la misma persona), inscripción académica vigente u oportunidad del curso ganada. La misma consulta alimenta «se inscribió tras el paso» en resultados. |
| `said_no` | Desde el último paso escribió una frase de alto (por omisión «no, por el momento», «no por ahora», «no me interesa», «ya no me interesa», «no gracias»). |
| `replied` | Respondió otra cosa: pausa (por omisión) o alto. «Sí, deseo inscribirme» y las demás frases de sí se cuentan como `said_yes` y también pausan/detienen. Lo escrito antes del primer paso no cuenta. |
| `human_takeover` | Alguien del equipo controla la conversación (asignada o con el asistente apagado): pausa (por omisión) o alto. El gancho `onConversationCancel` lo aplica en el acto. |
| `edition_started` / `edition_ended` | Terminó el día en que empezó la edición, o la edición terminó. El paso del mismo día de inicio sí sale. |
| `listen_only` | El número real está en modo escucha (`whatsapp.canSendFrom`). |
| `window_closed` | Sólo si el paso dice «detener» con la ventana cerrada. |
| `completed` | Se enviaron u omitieron todos los pasos. |
| `manual` | Alguien del equipo la detuvo. |

Reanudar: una pausa por respuesta o por toma humana se reanuda sola cuando la conversación vuelve a la automatización (sin responsable, asistente encendido, abierta) y la persona lleva `resumeAfterHours` sin escribir; o a mano («reanudar»).

## Protecciones

- **Apagado por omisión**: la marca (`automation_settings.enabled` + asistente que responde solo; sin interruptor nuevo, como dice el diseño §2.2) y cada secuencia.
- **Horario**: `business` usa el horario y los días festivos de la marca (`operations.settings`, `service-hours.mjs`); `daytime`, el horario de silencio de las difusiones de la marca (`campaign_settings.quiet_start/quiet_end`, 21:00–08:00 por omisión) en su zona horaria. Fuera de horario, el paso espera la siguiente apertura.
- **Tope por persona**: 2 mensajes automáticos en 24 horas sumando todas las secuencias de la marca y las difusiones enviadas (`campaign_recipients.sent_at`, sólo en vivo) a la misma persona. Si se llega, el paso espera a que se libere (motivo visible «frecuencia»). El diseño hablaba de 3 al día; se eligió 2 por prudencia (constante `LIMITS.perPersonPerDay`).
- **Tope del mes por secuencia** (en la zona de la marca): al llegar, el paso espera al mes siguiente (o se omite si ya pasó su momento).
- **Consentimiento**: una plantilla de marketing sólo sale a quien tiene `opted_in` (si la secuencia lo exige, que es lo de omisión); quien pidió la baja o está en lista de exclusión no recibe nada, igual que en difusiones.
- **Plantillas**: sólo aprobadas para la marca y sólo por un número real; en el laboratorio (sin número) un paso de plantilla se omite con su motivo.
- **Idempotencia**: `clientRef` al crear y al inscribir a mano; `expectedRevision` al editar, encender, apagar y archivar (409 si cambió).

## Rutas y permisos

Lectura con `inbox.view` de la marca (asesores: sólo ven). Crear, editar, encender, apagar y archivar con `automation.manage` (hoy administración). Inscribir, detener y reanudar en un chat con `inbox.reply` y acceso a la conversación. Una marca ajena responde 404.

```
GET    /api/sequences?brand=&archived=1
POST   /api/sequences                                  {brandId,title,description?,courseId?,steps,settings,clientRef}
GET    /api/sequences/lists?brand=
GET    /api/sequences/:id
PUT    /api/sequences/:id                              {expectedRevision,…}
POST   /api/sequences/:id/enable | disable | archive   {expectedRevision}
POST   /api/sequences/:id/preview                      {}  (no envía ni escribe)
GET    /api/sequences/:id/results
GET    /api/sequences/:id/enrollments?state=&before=
GET    /api/sequences/enrollments/:eid
POST   /api/sequences/enrollments/:eid/stop | resume
GET    /api/sequences/conversations/:cid
POST   /api/sequences/conversations/:cid               {sequenceId, clientRef}
```

Para otros módulos: `host.module('sequences').enroll(conversation, sequenceId, {source, clientRef, userId})` (abre su transacción) y `enrollInTx(...)` (dentro de una ajena, p. ej. un paso de recorrido o una acción de regla). Devuelven `{enrollment, duplicate}` o `{refused: motivo}`. Tiempo real: `sequences.changed`.

## Visibilidad

- **Vista previa**: quién entraría (conversaciones de los últimos 14 días con el disparador, con cuántas quedan fuera y por qué) y quién recibiría su paso ahora (enviar, esperar, omitir, pausar o detener, con motivo). Usa la misma evaluación que el envío, sin escribir nada.
- **Resultados**: inscritas, enviados, respondieron, dijeron sí y no, por estado y motivo de alto, y por paso (enviados, respuestas, sí, no, omitidos por motivo, «se inscribieron en N días después del paso»).
- **Por conversación**: inscripciones activas, en pausa y detenidas con su motivo; bitácora por inscripción; detener y reanudar.

## Archivos fuera del módulo

- `server/migrations/registry.mjs`: una importación y una entrada (`...sequences` al final).
- Lecturas (sin cambios) de `server/modules/chatflows/engine.mjs` (`CONDITION_FIELDS`) y `server/modules/broadcasts/model.mjs` (`inQuietHours`). No se editó `server/app/dispatch.mjs`.

## Pruebas

`node --test test/sequences-engine.test.mjs test/sequences.test.mjs` y `UI_PORT=3399 npx playwright test test/ui/secuencias.spec.mjs`. Cubren: momentos relativos a la inscripción y al inicio de la edición, ventana abierta y cerrada con sus tres respaldos, cada regla de alto cambiada entre programar y enviar, respuesta → pausa/alto/sí/no, horario de atención y de silencio, tope por persona (con difusiones) y del mes, automatización y secuencia apagadas, modo escucha, baja, reinicio y arrendamiento vencido sin duplicar, alcance por marca, revisión y reintento sin duplicar, vista previa sin escrituras, resultados, entrada automática y actualización de una base anterior.

## Lo que falta

- **Entrada desde un recorrido o una regla**: la API del módulo existe (`enrollInTx`), pero el paso «Inscribir en una secuencia» del recorrido y la acción de regla no se añadieron (son de `chatflows` y `rules`, que no se tocaron).
- **Inscribir desde el chat**: las rutas existen; falta el botón en la bandeja.
- **Condición por paso en la pantalla** (la API la acepta).
- La pausa al responder se ve en el barrido (cada 5 s) o al despertar el paso, no en el mismo instante del mensaje (sin gancho en el entrante, a propósito).
- Sin probar contra WhatsApp real (plantillas por Meta).
- `listen_only` detiene la inscripción; durante un cambio de número quizá convenga esperar en su lugar (pregunta abierta).

## Ajustes tras la revisión de seguridad (17 nov 2026)

- **Un «no» o una baja antes del primer paso también detienen:** a quien ya dijo que no, no se le manda ni el primer mensaje. Cualquier otra cosa escrita antes del primer paso sigue sin contar como respuesta.
- **Un paso que agotó sus intentos detiene la inscripción** (motivo «un paso falló varias veces») en lugar de reprogramarse cada pocos segundos.
- **«Recibió la ficha del curso» no incluye archivos sueltos** que mande un recorrido (un reglamento, un PDF): sólo la ficha de verdad.
