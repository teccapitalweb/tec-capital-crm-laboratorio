# Identidad por identificador de usuario (incremento I-2)

Estado: construido en la rama de integración, **sin publicar**. Migración con nombre `identity/0002-user-keys`. Fuente de las decisiones: la conciliación técnica (filas 5, 18, 28, 33, 37 y 41; D.7) y el diseño de identidad §3, que manda en lo demás.

## Qué resuelve

Meta ya entrega personas que escriben **sin teléfono visible**: sólo un identificador de usuario propio de la cuenta de negocio (BSUID, p. ej. `MX.1349…`). Antes, ese entrante quedaba en cuarentena `no_phone` y no se atendía. Ahora la persona nace o se reconoce por su identificador, conversa, recibe respuesta por ese identificador y, si su teléfono aparece después, su contacto se completa o se fusiona sin duplicar.

## Piezas

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| Tablas | `identity/0002-user-keys` | `identity_keys` (teléfono canónico con ámbito `''`; identificador con el ámbito de la cuenta de Meta del número), `identity_events` (bitácora, sólo los 4 últimos caracteres), `wa_peer_state` (último mensaje por persona y número), `wa_numbers.waba_id` y `business_id`. Sin `CHECK` sobre `kind` |
| Lógica | `server/lib/identity.mjs` | `resolve` (quién escribe), `adoptable`, `completeContacts`, `touchPeer`/`lastInboundAt`, `bsuidFor`, `displayFor`, `backfillStep`. Todo dentro de la transacción del llamador, sin red |
| Módulo | `server/modules/identity` | Presta la fusión de contactos, encola el relleno, reprocesa la cuarentena y sirve las rutas |
| Entrante | `server/whatsapp.mjs` | Orden de la fila 33: duplicado → `identity.resolve` → atribución de difusión → adopción (`crm.syncConversation(c, {adoptContactId})`) → conversación → mensaje → `wa_peer_state` → asistente |
| Saliente | `whatsapp.outbound`, `metaChannel.send` | Por teléfono (`to`) si se conoce; por identificador (`recipient`) sólo si no. Sin ninguno: «la conversación no tiene destinatario». Error 131062 explicado |
| Ventana | `channel.windowOf` (única fuente) | El último mensaje de la persona es el mayor entre el de la conversación y el de `wa_peer_state` (`channel.usePeer`) |
| Difusiones | `broadcasts`, `audiences` | Quien no tiene teléfono pero sí identificador en el ámbito del número de la campaña recibe con `wa_recipient`; sin ninguno, `no_address`. La respuesta se atribuye también por identificador |

## Quién escribe (diseño §3.4)

| Llega | En la base | Resultado |
| --- | --- | --- |
| Identificador nuevo, sin teléfono | nada | Cliente nuevo con la llave del identificador |
| Identificador conocido | de U | Es U (renueva fechas, usuario y nombre) |
| Identificador conocido + teléfono libre | de U | U recibe el teléfono («apareció») |
| Sólo teléfono | de U | Es U (el camino de antes; también por `wa_identities` mientras el relleno no termina, y «52…» = «521…») |
| Teléfono de U + identificador nuevo; U sin identificador | de U | U recibe su identificador |
| Teléfono de U + identificador nuevo; U ya tenía otro | de U | Cliente nuevo V; el teléfono pasa a V; U conserva su historia y deja de recibir en ese teléfono |
| Identificador de U1 + teléfono de U2 (U2 sin identificador) | dos clientes | Fusión segura de clientes (sobrevive el más antiguo) o, si no es segura, entra con U1, el teléfono se queda con U2 y queda un conflicto y una candidatura `identity_conflict` |
| Identificador de U1 + teléfono de U2 con otro identificador | dos clientes | El teléfono pasa a U1, sin fusión |
| Ni teléfono ni identificador | — | Cuarentena `no_identifier` |

Fusión de clientes **segura** = sin dos conversaciones abiertas del mismo curso, edición y canal; sin identificadores distintos en el mismo ámbito; y en cada marca compartida, sin dos intereses activos del mismo curso y edición. Mueve conversaciones, mensajes, archivos, contactos (con `contacts.mergeInternal`, que mueve todo lo registrado en `host.personData`), llaves, `wa_peer_state` y `wa_identities`; el absorbido queda desactivado.

**El teléfono aparece** (sólo en la marca del número que lo recibió): los contactos del cliente sin teléfono reciben el canónico y su clave, `wa_peer` en sus conversaciones reales abiertas, y si otro contacto de la marca ya tenía ese teléfono y no es de nadie, fusión interna automática (nota, consentimiento más restrictivo, todo lo registrado); si es de otro cliente o no es seguro, conflicto y candidatura. Nunca toca otra marca.

**Adopción**: si el cliente todavía no tiene contacto en la marca y hay uno sin dueño con su teléfono (importado, capturado a mano o por la API), ése pasa a ser el suyo. Cambio a propósito: antes nacía un duplicado con candidatura (`test/identity-phone.test.mjs` se ajustó).

## Relleno y cuarentena

- **Relleno** (§3.9): trabajo `identity.backfill` de la cola de trabajos, encolado una sola vez (`clientRef` fijo) al crear el módulo; por trozos copia `wa_identities` → `identity_keys` (dos clientes con el mismo teléfono: se queda el más antiguo, evento `conflict`) y llena `wa_peer_state`. Idempotente. Las identidades de persona `+521…` ya las corrigió `identity/0001`.
- **Cuarentena**: no hay tabla nueva (fila 5): es la fila `failed` de `webhook_inbox`. Lo `no_phone` de la versión anterior **no se reprocesa solo**: pasar por el entrante un mensaje viejo puede hacer que el asistente conteste días después, así que lo decide administración con `POST /api/identity/quarantine/retry` (también `no_identifier`; responde 409 `channel_off` si WhatsApp real no está conectado). La ruta de siempre `POST /api/connectors/inbox/:seq/retry` sigue sirviendo.

## Rutas

`GET /api/identity` (administración: con y sin teléfono, vínculos de la semana, conflictos, cuarentena) · `POST /api/identity/quarantine/retry` · `GET /api/identity/contacts/:id` (equipo con `contacts.view`: teléfono enmascarado sin `contacts.phone`, usuario, últimos 4 del identificador; el identificador completo sólo para administración).

## Visualización y privacidad

- La lista y el chat reciben `real` y `wa_display` («+52…», «@usuario» o «Número oculto ··a1b2»); `public/app.js` sólo los usa en los cuatro sitios de D.7. El distintivo «sin número», el bloque «WhatsApp» de la ficha, el filtro «Sin teléfono» y la tarjeta «Identidad» en Conectores quedan para la interfaz nueva (las rutas ya existen).
- La búsqueda de la bandeja incluye usuario e identificador **sólo para el equipo** (misma regla que `wa_peer`; hoy el equipo coincide con `contacts.phone`).
- El identificador nunca va completo a la bitácora de conectores, a `identity_events`, a eventos ni a respuestas para quien no es administración.

## Fuera de este incremento

Mensajes de sistema «cambió de número» o «cambió de identificador» (casos 10 y 11: hoy se ignoran como antes), modo escucha y cambio de número (I-11), diagnóstico `shape` en la bitácora, completar llaves con el `user_id`/`wa_id` de la respuesta de un envío (se lee y no se guarda), costos por país desde las dos letras del identificador, `whatsapp` en la API pública y en el conector MCP, la pantalla de fusiones y exportar o borrar los datos de una persona.

## Sin verificar contra Meta real

- **Nombres de los campos** (`from_user_id`, `user_id`, `contacts[].user_id`, `recipient_user_id`, `username`, «parent»): no confirmados (diseño §3.1). Si son otros, los entrantes vuelven a cuarentena `no_identifier` (no se pierden; se reprocesan al corregir el lector).
- **Envío con `recipient`** y la respuesta con `contacts[0].user_id`: sólo probados con el Meta de mentira.
- **Ámbito**: se usa `waba:<entry.id>`; si Meta comparte el identificador entre cuentas del mismo portafolio, hay que llenar `wa_numbers.business_id` y re-etiquetar.
- **Plantillas a un identificador** (error 131062) y ventanas/tarifas por persona sin teléfono: según la documentación, sin prueba real.
- Diseño §9.3 y §10.2: lo que sólo se comprueba con la cuenta real queda en esta lista.

## Pruebas

`test/whatsapp-identity.test.mjs` (servidor real y Meta de mentira): funciones puras; migración sobre base publicada y relleno idempotente; nace, responde por `recipient`, estado, vuelve sin duplicar, ventana por estado del par, búsqueda, el teléfono aparece y se fusiona con el importado (nota y baja), el teléfono cambia de dueño, permisos y enmascarado; cliente de antes que recibe su identificador y «52/521»; fusión no segura con candidatura y segura; dos marcas y dos cuentas; cuarentena por ruta y al arrancar; difusión por identificador con `no_address` y respuesta atribuida. Ajustadas a propósito: la ventana en `whatsapp-real` y `whatsapp-templates` (se atrasa también `wa_peer_state`), el paso 5 de `channel-contract` (el entrante sin teléfono ya entra) y la adopción en `identity-phone`.
