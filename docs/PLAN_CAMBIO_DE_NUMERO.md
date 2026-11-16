# Cambio de número de WhatsApp: modo escucha, conversaciones recientes y registro (I-11)

Las tres herramientas para mudar el número real de la empresa al CRM sin un corte a ciegas. Diseño de identidad y mudanza §7.5 a §7.8; conciliación técnica, fila I-11, fila 33 (orden del entrante) y la fila de datos de `wa_numbers`. Sin esquema de escalera nuevo: migración con nombre `wa-cutover/0001-listen-mode`.

## Los dos modos de un número

| | **Activo** (`live`, por omisión) | **Escucha** (`listen`) |
| --- | --- | --- |
| Para qué | El CRM atiende el número. | Antes del corte, mientras el proveedor anterior sigue atendiendo: comprobar durante unos días que todo llega. |
| Entrante | Cliente, conversación, mensaje, asistente (como siempre). | Se resuelve quién escribe (la persona nace si es nueva, sin contacto ni conversación), se anota la hora de su último mensaje (`wa_peer_state`) y se cuenta. **No** se guarda el texto ni se descarga el archivo; **no** hay conversación, mensaje, trabajo del asistente, tarea, evento de negocio ni aviso. La bandeja de webhooks vacía la carga al terminar, como siempre. |
| Estados de mensajes | Se casan con el mensaje. | Los que no se casan con nada (los envió el proveedor anterior) sólo se cuentan. |
| Saliente | Todo sale. | **Nada sale** (chat, asistente, plantillas, difusiones, programados, recordatorios de citas), salvo a un teléfono de la **lista de prueba** (`listen_allow`, hasta diez del equipo). Un mensaje así queda «no entregado» con el motivo. Los entrantes de un teléfono de la lista siguen el camino normal, para ensayar una conversación de verdad. |

Los números que ya existían quedan **activos** tras la migración, igual que hoy.

**Contadores** (`wa_listen_days`, por número y día del centro de México): recibidos, personas distintas, estados ajenos y errores; «sin identidad» se lee de la cuarentena de la bandeja (entrantes sin teléfono ni identificador para ese número). De un mensaje en escucha sólo queda su referencia de Meta (para no contarlo dos veces, 35 días) y el cliente interno; nunca el texto ni el teléfono.

## La puerta única de salida

Todo envío a Meta pasa por `meta.send` del adaptador (`server/connectors.mjs`); ahí se pone, una vez, la puerta que fija `server/whatsapp.mjs` con `server/lib/wa-listen.mjs`. Lanza 409 `number_listen_only`. Otros módulos (el motor de difusiones, la API de envío) pueden preguntar antes:

```js
host.services.whatsapp.canSendFrom(phoneNumberId, { to, recipient }); // {ok:true, test?} | {ok:false, code:'number_listen_only', message}
host.services.whatsapp.listenOnly("wa:" + phoneNumberId, phoneKey | null); // true = NO debe salir (409 number_listen_only); la misma regla de la puerta
```

Pendiente para esos frentes: que la difusión y la API de envío pregunten antes de empezar (hoy una difusión por un número en escucha termina con sus destinatarios «fallidos», sin que salga nada) y que la API responda 409 `number_listen_only` (diseño §4.8).

## Acciones (administración con `channels.whatsapp.connect` en la marca del número)

| Ruta | Qué hace |
| --- | --- |
| `GET /api/whatsapp/cutover` | Números de las marcas de la persona: modo, lista de prueba, contadores de 7 días, cuarentena, días en escucha, registro, vuelta atrás ensayada e historial. |
| `POST /api/whatsapp/numbers/:id/mode` | `{mode, listenAllow?, expectedRevision, clientRef?}`. Con revisión, auditoría (`whatsapp.number.listen` / `.live`), historial y aviso en vivo `wa_cutover.changed`. Una ruta propia y no el `PUT` del número: es una acción delicada con su confirmación; el `PUT` conserva su contrato y no toca el modo. |
| `POST /api/whatsapp/numbers/:id/open-recent` | `{hours: 1..24, preview?: true}`. Sólo con el número activo. Para cada quien escribió al número en ese plazo (`wa_peer_state`) y no tiene conversación abierta con él: una conversación **en espera de una persona** (`waiting`, asistente apagado) en el curso por omisión del número, con su contacto y una nota de sistema. No envía nada ni publica eventos. Repetirla no duplica (ni siquiera si el equipo ya cerró alguna: marca por número, persona y cambio de modo). La vista previa no escribe. |
| `POST /api/whatsapp/numbers/:id/register` | `{pin}`. Registra el número en la cuenta de Meta: el corte. El PIN viaja a Meta y **no se guarda, no se registra, no se audita y no aparece en errores** (si Meta lo repitiera, se tapa). Tres intentos por hora por número y cinco por persona; la llamada, fuera de toda transacción. Con el canal simulado responde bien sin llamar a nadie. |

**Pantalla** `public/screens/cambio-numero/` (vista previa, Gestión → Cambio de número, administración): una tarjeta por número con todo lo anterior. Cada acción pide escribir una palabra (ACTIVAR, ESCUCHA, ABRIR, REGISTRAR) y enumera sus consecuencias.

## El día del corte, en lo que toca al CRM (camino A1, diseño §7.7)

1. Días antes: número real dado de alta y en **escucha**, con los teléfonos del equipo en la lista de prueba. Revisar a diario los contadores contra los del proveedor anterior y que la cuarentena esté en cero.
2. Ensayo con la lista de prueba: un envío manual y un recordatorio a un teléfono del equipo.
3. **T0:** «Registrar número» (si el camino lo pide) → «Pasar a activo» → «Abrir conversaciones recientes» (24 h) → respuestas automáticas en «Sugerir» la primera hora.
4. **Vuelta atrás** (antes de T+7 días): «Volver a escucha». Lo que el CRM alcanzó a enviar queda en el CRM.

## Lo que alimenta la puerta de decisión (§7.6)

- **7 · Tres días de escucha sin pendientes:** la tarjeta muestra días completos en escucha, la cuarentena del número y los recibidos y personas por día para comparar; la marca «Tres días de escucha sin pendientes» aparece con tres días o más y la cuarentena en cero.
- **12 · Vuelta atrás ensayada:** «Vuelta atrás ensayada» muestra la fecha del último paso a activo que siguió a uno a escucha (`wa_number_log`).
- **6 · Salud del número** sigue en la pantalla «Salud».

## Sin verificar contra Meta real

- La llamada de registro (`POST /{phone-number-id}/register` con `messaging_product` y `pin`) y sus errores; que registrar un número ya registrado en la misma cuenta no lo afecte; los límites de intentos de Meta.
- Que, en el camino A1, el CRM reciba los webhooks del número mientras el proveedor anterior sigue suscrito a la misma cuenta, y que los estados de sus mensajes lleguen también al CRM (por eso se cuentan).
- La forma real de los entrantes con identificador de usuario durante la escucha (§10.2) y que los conteos coincidan con los del proveedor anterior.

## Pruebas

`test/whatsapp-listen.test.mjs` (funciones puras; migración: los números existentes siguen activos; de punta a punta con el Meta de mentira: escucha sin texto, conversación, respuesta, tarea ni evento, contadores, cuarentena y estados ajenos; nada sale por chat, plantilla, asistente, programado ni difusión; la lista de prueba sí conversa; otra marca no se mezcla; activo y abrir recientes sin duplicar ni enviar; vuelta a escucha; registro con PIN que no queda en la base, el archivo, la auditoría ni la salida del servidor, con su error tapado y su límite; permisos; registro simulado) y `test/ui/cambio-numero.spec.mjs` (escritorio y celular, Niebla sin línea base).
