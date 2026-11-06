# Plan: mensajes programados

Estado: **implementado en la rama `feat/mensajes-programados`** (6 nov 2026), **esquema 32** (una tabla nueva), sin cambio de versión. Sin publicar.

## Para qué

Seguir una venta casi siempre es «escríbele mañana a las 9» o «el lunes pregúntale si ya vio el temario». Hasta ahora eso era una tarea con recordatorio y escribir a mano a esa hora. Un **mensaje programado** se deja listo en el chat y sale solo.

## Qué hace

- **Botón «Programar»** junto a Enviar (sólo el equipo; el cliente no lo ve). Abre un panel flotante con el texto (toma el borrador del compositor y se puede cambiar), **atajos de hora** (en 1 hora, mañana 9:00, lunes 9:00, en 3 días) o una fecha y hora exactas, y la casilla **«No enviar si el cliente responde antes»** (activada por omisión).
- **Lista sobre el compositor** con lo que está por salir en ese chat (de quién es, cuándo, el texto) y, si ya salió o no pudo salir, **por qué** (dos filas recientes). Cada pendiente se puede **Editar**, **Enviar ahora** o **Cancelar**.
- **A la hora, sale como un mensaje normal a nombre de quien lo programó** y deja el chat a su cargo (lo mismo que escribir a mano: se apagan el bot y sus pasos pendientes). Pasa por la misma ruta que un envío manual, así que **respeta las reglas del canal** (ventana de servicio de 24 h, etc.).
- Cada 5 segundos el servidor revisa lo vencido (1 s en pruebas). No hace llamadas de red: el envío es una transacción de SQLite.

## Reglas que se comprueban al enviar (no sólo al programar)

Un mensaje programado puede quedar viejo, así que al llegar la hora se vuelve a comprobar y, si algo ya no cuadra, **no sale y queda el motivo**:

| Situación al llegar la hora | Resultado |
|---|---|
| La conversación se cerró | No se envió: «La conversación se cerró antes de la hora» |
| El cliente respondió desde que se programó (y la casilla estaba activa) | No se envió: «El cliente respondió antes de la hora» |
| Quien lo programó ya no tiene la marca | No se envió: «ya no tiene acceso a esta marca» |
| Otra persona atiende ahora el chat (salvo administración) | No se envió: «Otra persona atiende ahora esta conversación» |
| El canal lo rechaza (ventana de 24 h cerrada…) | No se envió, con el motivo del canal |
| Pasaron más de 6 horas de la hora elegida (servidor apagado) | No se envió: no se manda un mensaje viejo |

## Seguridad y datos

- Esquema 32: `scheduled_messages` (una fila por mensaje: texto, hora, autor, estado `pending/sent/cancelled/failed`, motivo, `message_id` cuando sale, `revision`). Respaldo automático antes de migrar (`backups/before-crm-v32-*`).
- **Idempotencia:** crear lleva `clientRef` (un reintento devuelve el mismo registro, no uno nuevo); editar lleva `expectedRevision` (si otra persona lo cambió, 409); al enviar se usa la referencia determinista `sched:<id>`, así que ni un reintento ni dos ciclos seguidos duplican el mensaje.
- **Alcance:** igual que el chat. Sin sesión 401; cliente 403; otra marca 404. Cualquiera del equipo de la marca **ve** lo programado, pero sólo **quien lo programó o administración** lo edita, cancela o envía ya.
- **Límites:** hora futura (mínimo 30 s) y hasta 90 días; 5000 caracteres; 10 pendientes por chat; limitador de ritmo por persona. Auditoría: `scheduled.create`, `.edit`, `.cancel`, `.send_now`.
- El texto es lo que escribió una persona del equipo: no se interpreta ni se mezcla con datos del cliente.

## Límites actuales

- Sólo texto: no programa adjuntos, flyers ni plantillas aprobadas (cuyos precios y fechas salen del catálogo vigente al momento de enviarlos, no de un texto guardado).
- No avisa por notificación cuando algo no sale: queda en la lista del chat, con el motivo.
- Las horas se eligen en la zona horaria del navegador de quien programa.
- No hay vista global de «todo lo programado» ni se muestra en Mi día; sólo en cada chat.

Archivos: `server/scheduled-schema.mjs`, `server/scheduled.mjs`, `server/index.mjs` (cableado, `takeOver`, temporizador), `public/scheduled.js`, `public/app.js`, `public/crm.css`; pruebas `test/scheduled.test.mjs`.
