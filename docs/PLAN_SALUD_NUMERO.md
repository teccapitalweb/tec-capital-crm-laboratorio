# Salud del número y de la cuenta de WhatsApp (X3 «Salud»)

Estado, calidad y límite diario de cada número de WhatsApp y de la cuenta de WhatsApp Business, los avisos que Meta manda cuando algo cambia y una pantalla para verlo. El límite diario decide cuántos destinatarios admite una difusión; sin estos avisos, un número restringido sólo se descubría por los fallos. Conciliación técnica, filas 39 y 40; diseño de canales A1; difusiones §3.7 y §7.8.

## Qué hay

- **Módulo** `server/modules/channel-health/` (`module.mjs`, `repo.mjs`). Migración con nombre `channel-health/0001-health` (aditiva, después de `broadcasts/0001`): tablas `channel_health` (una fila por número, `account_ref = 'wa:' + phone_number_id`) y `channel_health_events` (historial; lo de la cuenta va con `brand_id '*'`), y en `wa_account` sólo lo que faltaba (`business_verification`, `restriction`, `restricted_until`, `health_checked_at`, `health_error`, `health_due`, `last_webhook_at`). El límite, la revisión y el pago siguen en `wa_account`. No se crean `wa_number_health` ni `wa-health.mjs`.
- **Adaptador** (`server/connectors.mjs`): `numberInfo(id)` y `accountInfo()`. Primero los campos que ya funcionan (los de «Probar conexión»), después cada grupo ampliado por separado; uno que Meta rechace (error 100) queda «sin dato» y no se vuelve a pedir en ese proceso. El simulado devuelve valores neutros.
- **Consulta a Meta**, siempre fuera de toda transacción (`refresh` falla si se llama dentro de una): el reloj (`timers`, cada minuto, no reentrante, 5 números por pasada) relee cada **15 min** los números con una difusión en curso y cada **6 h** el resto; un aviso pide una relectura que se hace en cuanto pasa **1 min** desde la última consulta del número. «Consultar ahora» repite lo recién leído si la última consulta tiene menos de 10 s, y admite 6 por minuto por persona.
- **Avisos de Meta** (oyente de `connectors.on('account.update')`, síncrono, dentro de la transacción del procesador de webhooks): calidad marcada o desmarcada (`phone_number_quality_update` FLAGGED/UNFLAGGED), nivel (UPGRADE/DOWNGRADE y `business_capability_update`), nombre visible, revisión de la cuenta y verificación, restricción de la cuenta con su fecha de fin (termina sola), bloqueo, y alertas de cuenta. Se aplica lo que el aviso dice con claridad y se pide releer. Un rechazo 131042 (oyente de `message.status`) marca el método de pago como «falta»; un mensaje cobrable entregado después lo devuelve a «correcto».
- **Al equipo**: notificación (tabla `notifications`, tipo `channel_health`) a quien tiene `channels.whatsapp.connect` en la marca del número cuando baja la calidad, cambia el límite, el número se restringe, se bloquea, se desconecta o vuelve, o cambia la cuenta (revisión, restricción, pago, alertas); eventos de dominio `canal.calidad`, `canal.estado`, `canal.cuenta`; tiempo real `channel_health.changed`.
- **Rutas** (encaminadas en `server/index.mjs` antes que `server/whatsapp.mjs`): `GET /api/whatsapp/health` y `POST /api/whatsapp/health/refresh {accountRef?}`. Quien tiene `channels.whatsapp.connect` ve el detalle y el historial de sus marcas; la cuenta y el refresco de todo piden el permiso en **todas** las marcas; el resto del equipo ve sólo el resumen de los números de sus marcas. Sin tokens ni el identificador de la cuenta.
- **Pantalla** `public/screens/salud/` (vista previa, Gestión → Salud, sólo administración con `channels.whatsapp.connect`): tarjeta por número (estado, calidad, nombre visible, límite y lo que queda hoy, qué categorías puede enviar y por qué no, última consulta), la cuenta con su medidor, el historial y «Consultar ahora». Sin WhatsApp real lo dice y no ofrece consultar.

## Para el motor de difusiones

```js
const health = host.module('channel-health');
health.limitsOf('wa:<phone_number_id>'); // {limit, used, remaining, tier, unlimited, estimated, source}
health.canSend('wa:<phone_number_id>', 'marketing' | 'utility' | 'authentication' | 'service'); // {ok, reason?, message?, warning?}
```

- `used`: personas distintas que recibieron una plantilla (chat o difusión) en las últimas 24 h, sumando todos los números (el límite es de la cuenta). Estimación propia, guardada 5 s; la cifra de Meta manda.
- **Sin datos todavía** (Meta aún no informa el nivel): `limit = 250` (el nivel más bajo), `source: 'default'`, y `canSend` deja enviar con `warning: 'no_data'`. Decisión: no frenar una cuenta nueva, pero tampoco suponer más de lo que Meta da a cualquiera.
- Sin límite (`TIER_UNLIMITED`): `limit` y `remaining` en `null`, `unlimited: true`.
- `canSend` frena: número desconocido o apagado; número pendiente, desconectado, restringido o bloqueado (todo, también las respuestas); cuenta bloqueada (todo); cuenta restringida, en revisión o rechazada, sin método de pago o con el límite agotado (todo menos `service`); calidad baja (sólo `marketing`). Calidad media deja enviar con `warning: 'quality_medium'`.
- **Apagado** sin `CHANNEL_CONNECTOR=meta`: no consulta, no aplica avisos, `canSend` → `{ok:true, warning:'simulated'}` y `limitsOf` → sin límite (`source: 'simulated'`): no frena al laboratorio.

`numbersFor(brandIds)` deja lista la forma que pedirá `GET /api/v1/numbers` (identidad y API §4.10); esa ruta pública no se construyó.

## Sin verificar contra Meta real

- Los nombres de los campos ampliados: `status`, `name_status`, `is_official_business_account`, `whatsapp_business_manager_messaging_limit` (con `messaging_limit_tier` de respaldo) del número, y `account_review_status`, `business_verification_status` de la cuenta. Si Meta rechaza uno, queda «sin dato».
- Los valores exactos de estado del número y de los niveles (`TIER_250`, `TIER_2K`, …), y que el número informe el límite de la cuenta (desde octubre de 2025 es por portafolio: si dos números informan distinto, manda la última lectura).
- La forma real de los avisos de cuenta (`account_update` con `restriction_info`, `account_review_update`, `business_capability_update`, `account_alerts`) y que un aviso de reactivación exista; por eso todo aviso pide una relectura.
- Que una restricción del número también impida las respuestas dentro de la ventana (aquí se decidió frenarlas).
- Requisito externo: suscribir en la app de Meta, además de `messages`, los campos `account_update`, `account_review_update`, `account_alerts`, `phone_number_quality_update`, `phone_number_name_update` y `business_capability_update`.

## Pruebas

`test/channel-health.test.mjs` (migración sobre una base existente; lectura de valores; sin datos, transacción y lo usado; reloj no reentrante, mínimo entre consultas y 15 min / 6 h; de punta a punta con el Meta de mentira: consulta inicial, calidad, nivel, restringido y recuperado, cuenta en revisión, restricción con fin, dos marcas, permisos y límite de frecuencia; campos rechazados y Meta caído; apagado) y `test/ui/salud.spec.mjs` (escritorio y celular, Niebla sin línea base).
