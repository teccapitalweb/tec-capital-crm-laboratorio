# Plan: agenda de citas

Estado: **implementado en la rama `feat/agenda-citas`** (6 nov 2026), **esquema 33** (una tabla nueva), sin cambio de versión. Sin publicar.

## Para qué

Vender un curso casi siempre pasa por una llamada o una videollamada de asesoría («te explico el temario y vemos si te conviene»). Hasta ahora eso vivía en una tarea suelta o en la cabeza de la asesora. Una **cita** deja claro con quién, cuándo, cuánto dura y cómo, y recuerda a las dos partes.

## Qué hace

- **Botón «Agendar cita»** junto a Programar en el chat (sólo el equipo). Abre un panel flotante con: título (por omisión «Llamada con {nombre}»), **tipo** (llamada, videollamada o presencial), **duración** (15 min a 2 h), **fecha y hora** (atajos: mañana 10:00, lunes 10:00, en 3 días, en 1 semana), **enlace, teléfono o lugar**, **notas para ti** y la casilla **«Recordarle la cita al cliente»**.
- **Recordatorio al cliente (opcional).** Si se activa, se arma un texto con la hora elegida («Hola Ana, te recuerdo nuestra llamada mañana a las 10:00 a.m. Enlace: …»), **editable**, que se programa 30 min, 1 h, 3 h o 1 día antes. Es un **mensaje programado normal** ([PLAN_MENSAJES_PROGRAMADOS.md](PLAN_MENSAJES_PROGRAMADOS.md)): sale a nombre de quien agenda, con las reglas del canal y sin cancelarse porque el cliente responda (precisamente para confirmar). Si la cita es muy pronto para el recordatorio, se agenda la cita y se avisa que no se programó.
- **Lista sobre el compositor** con las citas de ese chat (las pendientes y las dos últimas cerradas). Pendientes: **Editar** y **Cancelar**; cuando ya empezaron: **Se hizo** y **No asistió**. Una cita que ya terminó y sigue sin cerrar lo dice.
- **Mi día → «Mis citas»:** las citas pendientes de la persona, de todas sus marcas, la más próxima primero; cada fila abre el chat. Las que ya terminaron sin cerrar quedan marcadas «ya terminó, ciérrala».
- **Aviso previo:** 15 minutos antes llega un aviso a quien lleva la cita (Operación → Mis avisos y push, grupo «Chats»), con título, cliente, tipo y lugar. Una sola vez por cita y hora: si se mueve, vuelve a avisar.

## Reglas

- La hora es futura (mínimo 1 minuto, máximo 180 días). Al **editar sólo el título o las notas** de una cita en curso no se exige hora futura.
- **Sin empalmes:** si la misma persona ya tiene otra cita a esa hora, el servidor responde 409 y la pantalla pregunta si se agenda de todos modos (`allowOverlap`). Dos citas que se tocan (una termina cuando empieza la otra) no se empalman. Otra persona sí puede tener cita a esa hora.
- **Mover o cancelar** una cita **cancela su recordatorio** (el viejo diría la hora equivocada) y, al mover, se avisa; se puede programar uno nuevo en el mismo paso.
- «Se hizo» y «No asistió» sólo cuando la cita ya empezó; cancelar siempre mientras esté pendiente. Una cita cerrada ya no se edita.
- No se agenda en una conversación cerrada ni en una que atiende otra persona (salvo administración). Hasta 10 citas pendientes por chat.

## Seguridad y datos

- Esquema 33: `appointments` (conversación, marca, quien la lleva, título, hora, duración, tipo, lugar, notas, estado `scheduled/done/no_show/cancelled`, `reminder_id`, `revision`). Respaldo automático antes de migrar (`backups/before-crm-v33-*`).
- **Idempotencia:** crear lleva `clientRef` (un reintento no duplica); editar lleva `expectedRevision`.
- **Alcance:** igual que el chat. Sin sesión 401; cliente 403; otra marca 404. Cualquiera del equipo de la marca **ve** las citas del chat, pero sólo **quien la agendó o administración** la cambia o cierra.
- Las notas son **internas** (el cliente no las ve); el recordatorio sólo lleva lo que la persona escribió.
- Auditoría: `appointment.create`, `.edit`, `.done`, `.no_show`, `.cancelled`.
- Sin llamadas de red dentro de transacciones: el recordatorio se programa antes de insertar la cita y se retira si la inserción fallara (el módulo de mensajes programados abre su propia transacción y no se anidan).

## Límites actuales

- No hay conexión con Google Calendar, Outlook ni videollamadas automáticas: el enlace se pega a mano.
- No hay disponibilidad ni autoagenda para el cliente (que él elija un hueco); la cita la fija el equipo.
- No hay una pantalla propia de calendario (semana/mes); se ve en cada chat y en Mi día.
- Las horas se eligen y se muestran en la zona horaria del navegador de quien agenda.
- El recordatorio al cliente es sólo texto.

Archivos: `server/appointments-schema.mjs`, `server/appointments.mjs`, `server/scheduled.mjs` (`create` y `cancelSystem` para el recordatorio), `server/index.mjs`, `server/push.mjs`, `public/appointments.js`, `public/app.js`, `public/crm.js`, `public/operations.js`, `public/crm.css`; pruebas `test/appointments.test.mjs`.
