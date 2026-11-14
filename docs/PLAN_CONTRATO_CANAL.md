# Contrato de canal 1.1 (incremento común X2)

Estado: construido en la rama de integración, **sin publicar**. No cambia nada visible: el CRM guarda y muestra lo mismo que antes; lo nuevo son datos que viajan en el evento normalizado y columnas que se llenan en silencio. Es la base de las difusiones con plantilla (D-1 a D-5), de la identidad por identificador de usuario (I-2), de la salud del número (X3) y de los mensajes completos (C-A3).

Fuente de las decisiones: la conciliación técnica del plan (filas 32, 33 y 34; riesgos F-1 y F-12). Este documento manda sobre los diseños en lo que aquí se fija.

## 1. Qué cambia

| Pieza | Antes (1.0) | Ahora (1.1) |
| --- | --- | --- |
| `metaChannel.parseWebhook` (`server/connectors.mjs`) | Leía texto, archivo, anuncio, número que recibe y el motivo del fallo | Lee además lo de la sección 2. **Sólo añade claves cuando Meta las dio**: un entrante o un estado de hoy se traduce exactamente igual |
| Versión guardada en la bandeja de webhooks | `{v:'1.0', event}` | `{v:'1.1', event}` |
| Lector de la bandeja (`readStoredEvent`) | Tomaba `event` o la forma sin sobre | Acepta 1.0, 1.1, cualquier 1.x y la forma sin sobre; completa el entrante con la forma 1.1 (`withContract`); una carga de otra familia (2.x) queda en cuarentena con `contract_version` |
| Entrante sólo con identificador de usuario (sin teléfono) | Se anotaba «ignorado» y se perdía | Cuarentena `no_phone` con su carga 1.1 completa, para reprocesarlo cuando exista la identidad por identificador (I-2) |
| Avisos de plantillas, número, cuenta y preferencias | No se leían | Eventos `template.update`, `account.update` y `user.preference`; hoy se registran una vez («todavía nada en el CRM atiende…») hasta que X3 y D-3 se apunten |
| Oyentes | No había | `connectors.on(tipo, fn, {order, name})` para `message.status`, `template.update`, `account.update`, `user.preference` |
| `messages` | — | Columnas canónicas de la sección 3, llenadas en el entrante y en el estado |
| Meta de mentira | `test/helpers/fake-meta.mjs` con entrantes de texto y archivo | El mismo archivo, con entrantes 1.1, estados con tarificación y fallo, y avisos |

## 2. Forma del evento normalizado

Sobre `{id, type, data}` de siempre y aplicación única por `(proveedor, id)` en `connector_events`. Claves nuevas (todas opcionales; las de 1.0 se conservan):

```text
message.inbound
  peer:{ids:[{kind:'wa_phone'|'wa_bsuid'|'wa_parent_bsuid', value}], name, username}   sólo si Meta dio identificador de usuario o nombre de usuario
  account:{provider:'meta-whatsapp', externalId:<número que recibe>, scopeId:<cuenta WABA>, displayPhone}   sólo si viene la cuenta (entry.id)
  replyTo:{providerRef}            mensaje citado (context.id)
  forwarded:true                   reenviado o reenviado muchas veces
  interaction:{kind:'button'|'list'|'template_button', id, title, payload, description}
  reaction:{emoji, providerRef}    (el CRM la sigue ignorando como mensaje; la tabla de reacciones es de otro incremento)
  media.voice:true                 nota de voz
  location:{latitude, longitude, name, address} · contacts:[{name, phones}]
  system:{kind, newPhone, newUserId}   aviso de cambio de número o de identificador

message.status
  code (número del fallo) · detail (texto de Meta, recortado) · pricing:{billable, category, type, model}
  callback (biz_opaque_callback_data) · recipient:{phone, userId} · account

template.update  {account, scopeId, templateId, name, language, field:'status'|'quality'|'category', value, previous, reason}
account.update   {account, scopeId, field:'status'|'quality'|'limit'|'name'|'review'|'restriction'|'capability'|'alert', value, previous, details}
user.preference  {account, scopeId, peer:{ids}, category:'marketing_messages', value:'stop'|'resume', at}
```

- Los valores de Meta en mayúsculas (`APPROVED`, `MARKETING`, `TIER_10K`) se guardan en minúsculas.
- Meta no da un identificador por aviso: el `id` se compone de campo, entidad, valor e instante de la entrada (`entry.time`). Un aviso repetido por Meta tiene el mismo `id` y se aplica una sola vez. El de preferencias lleva la **huella** de la persona, no su número, porque el `id` se guarda en claro.
- Los nombres de los campos del identificador de usuario no están confirmados por Meta: se prueban `from_user_id`, `user_id` y `contacts[].user_id` (y sus «parent»). Ajustarlos cuando se vea un webhook real.
- Bitácora de conectores: de un entrante, sólo metadatos (como antes); de un estado y de un aviso de preferencias, el número de la persona **enmascarado** (`…5678`).

**Convivencia en la bandeja.** Lo que ya estaba guardado como 1.0 se procesa igual: `readStoredEvent` lo completa (`peer.ids` con el teléfono de `from`, `account` con el número que recibe). Un despliegue anterior que lea una carga 1.1 también la entiende, porque 1.1 sólo añade claves. Aun así, como dice [PLAN_RECEPCION_DURADERA.md](PLAN_RECEPCION_DURADERA.md), conviene vaciar la bandeja antes de desplegar.

## 2.1 Huella con llave de quien escribe

El carril de la bandeja (`webhook_inbox.lane`, que se queda en la fila aunque la carga se vacíe) y los ids de eventos que dependen de una persona (avisos de preferencias) llevaban o habrían llevado el SHA-256 **sin llave** del teléfono, que se revierte probando todos los números posibles. Ahora usan `server/lib/peer-key.mjs`: HMAC-SHA256 recortado a 16 caracteres con una llave de la instalación.

- **Llave**: `PEER_HASH_KEY` en el entorno (cualquier texto) o, si no existe, `DATA_DIR/peer.key`, creada la primera vez con permisos sólo para su dueño (como `mfa.key`). Nunca va al repositorio (`data/` está ignorado). Un adaptador suelto en una prueba, sin ninguna de las dos, usa una llave al azar de ese proceso.
- `laneOf(kind, provider, ev, peerHash)` exige la huella; `createConnectors` la arma con `dataDir` y se la pasa también al adaptador de Meta.
- **Al arrancar** (`rekeyLanes`, idempotente): un evento terminado, o una cuarentena ya vaciada, pierde la huella (`ev:<proveedor>:<id>`); uno pendiente, reservado o en cuarentena con carga recalcula su carril con la llave vigente.
- **Pendientes al desplegar**: los eventos guardados por la versión anterior quedan, tras el arranque, en el mismo carril que los nuevos de esa persona, así que el orden se conserva. El único hueco es el solape entre el proceso viejo y el nuevo durante el despliegue: lo que el viejo guarde en esos segundos lleva el carril sin llave y puede procesarse a la vez que un evento nuevo de la misma persona, hasta el siguiente arranque. Por eso se mantiene la recomendación de [PLAN_RECEPCION_DURADERA.md](PLAN_RECEPCION_DURADERA.md): vaciar la bandeja antes de desplegar.
- **Si se pierde o cambia la llave** (por ejemplo, otro `DATA_DIR`): el siguiente arranque recalcula los carriles pendientes con la nueva; sólo los ids de avisos de preferencias ya anotados dejarían de reconocerse como duplicados si Meta los reenviara. Restaurar un respaldo no exige restaurar `peer.key`.

## 3. Columnas canónicas de `messages`

Migración `messages/0001-channel-contract` (aditiva, `addColumn`):

| Columna | Qué guarda | Quién la llena |
| --- | --- | --- |
| `content_kind TEXT NOT NULL DEFAULT 'text'` | Tipo del entrante (`text`, `image`, `audio`, `video`, `document`, `sticker`, `location`, `contacts`, `interactive`; lo desconocido, `unsupported`) | `whatsapp.recordChannelFacts` |
| `reply` | JSON de la pulsación (`interaction`) | ídem |
| `reply_to_id` | Mensaje del CRM citado (por su referencia, en la misma conversación) | ídem |
| `forwarded INTEGER NOT NULL DEFAULT 0` | Reenviado | ídem |
| `channel_meta` | Cita que el CRM no tiene, archivo, ubicación, contactos compartidos, aviso de sistema | ídem |
| `fail_code INTEGER` | Código numérico del fallo informado en el estado | `channel.applyStatus` (y se limpia al pasar a entregado o al reintentar) |
| `wa_pricing` | JSON de la tarificación del estado | `channel.applyStatus` |

No se crean `content_type`, `payload` ni `failed_code`. `interactive`, `media_state` y `cycle_id` las añade su dueño (N-2 y B) en su área.

`recordChannelFacts` es un **paso con nombre** del camino del entrante (fila 33): corre dentro de la transacción de `whatsapp.inbound`, justo después de guardar el mensaje, sin abrir otra transacción ni hacer red (F-1). El texto, el archivo y todo lo que ya se guardaba no cambian.

## 4. Oyentes

```js
connectors.on('message.status', (data, { provider, applied }) => …, { order: 300, name: 'costos' });
```

Se llaman después de `channel.applyStatus`, en orden de `order`, **también** cuando el estado no corresponde a un mensaje del chat (un destinatario de difusión no tiene mensaje). Deben ser síncronos y no abrir transacción ni hacer red; lo que devuelven se añade al resultado del evento y un fallo se anota sin detener a los demás. Orden acordado: canal → difusiones (`order: 200`) → costos (`order: 300`).

## 5. Pruebas

- `test/channel-contract.test.mjs`: lectura de cada clave nueva; un entrante y un estado sin datos nuevos dan exactamente las claves de 1.0; ids estables de los avisos; lector tolerante (1.0, 1.1, 1.x, sin sobre, 2.0 en cuarentena); de punta a punta con el Meta de mentira: columnas del entrante (pulsación de plantilla, cita resuelta y no resuelta, reenvío), tarificación y código de fallo del estado, bitácora enmascarada, aviso de plantilla registrado y cuarentena `no_phone`.
- Las pruebas de WhatsApp existentes pasan sin cambios. La única expectativa que cambia es la versión guardada en la bandeja (`test/webhook-inbox-http.test.mjs`: `'1.0'` → `'1.1'`), que cambia a propósito.

## 6. Riesgos al activarlo con un número real

- **Nombres de campos del identificador de usuario** sin confirmar: si Meta usa otros, los entrantes sin teléfono seguirán cayendo en cuarentena `no_identifier` (no se pierden; se reprocesan al corregir el lector).
- **Avisos de cuenta y plantillas**: Meta sólo los manda si la app está suscrita a esos campos del webhook. Mientras nadie los atienda, sólo llenan la bitácora (`connector_events`), una fila por aviso.
- **Volumen**: cada estado con tarificación escribe una columna más en `messages`; no hay filas nuevas.
