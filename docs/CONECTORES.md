# Contrato de conectores y requisitos por consultora

Versión del contrato: **1.0** (`server/connectors.mjs`, 2 nov 2026). Este documento explica cómo se conectará el CRM a los proveedores reales de **canal** (Meta: WhatsApp Cloud API, Instagram y Messenger) y de **pago** (Stripe o Conekta), qué debe entregar cada consultora para encenderlos y qué sigue simulado mientras tanto. Nada de lo descrito aquí autoriza por sí mismo a conectar un proveedor: cada activación es una instrucción expresa de dirección y se hace primero en modo prueba.

## 1. Idea general

El CRM no habla con Meta ni con una pasarela directamente: habla con una **interfaz única** (el contrato) que hoy cumplen adaptadores **simulados** y mañana cumplirán los adaptadores reales. Cambiar de proveedor es una variable de entorno; el resto del sistema (bandeja, motor de respuestas, recetas, pagos, analítica, presentación) no cambia.

- `CHANNEL_CONNECTOR = simulated | meta` (por omisión `simulated`).
- `PAYMENT_CONNECTOR = simulated | stripe | conekta` (por omisión `simulated`).
- Si se selecciona un proveedor real pero faltan accesos, el CRM **sigue con el simulado**, lo registra en el arranque y lo muestra en Operación → Conectores («Sin configurar · usa el simulado»). Nunca se interrumpe la operación por una credencial ausente.

## 2. El contrato

### 2.1 Conector de canal

| Método | Qué hace | Simulado hoy | Meta mañana |
| --- | --- | --- | --- |
| `send({id, conversationId, brandId, channel, category, failureRate})` | Entrega un mensaje saliente ya guardado y devuelve `{providerRef, state:'delivered'|'failed', reason?}` | Entrega o falla según la tasa configurada por marca; `providerRef` `simch_…` | Llama a la Cloud API (texto, plantilla, media, botones) y devuelve el `wamid` |
| `verifyWebhook(headers, rawBody)` | Comprueba la firma del proveedor sobre el cuerpo crudo | HMAC-SHA256 con `CONNECTOR_WEBHOOK_SECRET` en `x-lab-signature` | `X-Hub-Signature-256` con `META_APP_SECRET` |
| `parseWebhook(body)` | Traduce el formato del proveedor a eventos normalizados | Ya llegan normalizados | `entry[].changes[].value.statuses[]` → `message.status`; `messages[]` → `message.inbound` (con `referral` del anuncio) |
| `challenge(query)` | Responde la verificación de la URL del webhook | No aplica | `hub.mode=subscribe` + `hub.verify_token` = `META_VERIFY_TOKEN` → devuelve `hub.challenge` |
| `capabilities` | Qué sabe hacer | plantillas, botones, media, lecturas, origen por anuncio | igual |

La entrega corre **fuera de las transacciones de SQLite**: el barrido del canal (`channel.tick`, cada 0,5 s) toma los mensajes «enviados» cuyo retraso venció, llama a `send()` para cada uno y aplica los resultados en una sola transacción. Los estados reportados después por webhook (`message.status`) se localizan por `messages.provider_ref` y **sólo avanzan** (enviado → entregado → leído; «fallido» puede llegar en cualquier momento y un estado posterior lo repara).

### 2.2 Conector de pago

| Método | Qué hace | Simulado hoy | Stripe / Conekta mañana |
| --- | --- | --- | --- |
| `prepareCheckout(order)` | Crea la sesión de cobro y devuelve `{providerRef, url}` | Devuelve nuestro propio enlace `/?pay=<pedido>` (`simpay_…`) | Crea la sesión con `metadata.orderId` y `metadata.reference`; su URL se guarda en `orders.checkout_url` |
| `verifyWebhook(headers, rawBody)` | Firma del proveedor | HMAC con `CONNECTOR_WEBHOOK_SECRET` | Stripe: `Stripe-Signature` (`t=`, `v1=`, tolerancia 5 min). Conekta: se confirma con su documentación al activar |
| `parseWebhook(body)` | Traducción a eventos | Ya normalizados | Stripe: `checkout.session.completed` → `payment.succeeded`; `*_failed` → `payment.failed`. Conekta: `order.paid`, `order.expired`, `charge.declined` |

El enlace que recibe el cliente es **siempre el nuestro** (`/?pay=<pedido>`): es estable, no caduca con la sesión del proveedor y permite mostrar el estado del pedido. Con una pasarela real, esa página ofrecerá «Ir a pagar» hacia `checkout_url`. Un pago se confirma **únicamente** por webhook verificado (o por una persona que acepta un comprobante), nunca por el regreso del navegador. Si el webhook trae importe, debe coincidir con el del pedido; si no, se rechaza y queda registrado.

### 2.3 Eventos normalizados

```json
{"id":"evt_…","type":"message.status","data":{"providerRef":"wamid…","state":"delivered|read|failed","reason":null,"at":1700000000000}}
{"id":"evt_…","type":"message.inbound","data":{"channel":"whatsapp","from":"5215512345678","text":"Hola","providerRef":"wamid…","referral":{"source":"ad","ad":"…"}}}
{"id":"evt_…","type":"payment.succeeded","data":{"orderId":"…","reference":"TC-ABC123","providerRef":"cs_…","method":"card|oxxo|transfer","amountCents":37900}}
{"id":"evt_…","type":"payment.failed","data":{"orderId":"…","providerRef":"…","reason":"…"}}
```

Cada evento se aplica **una sola vez** por `(proveedor, id)` (`connector_events`, índice único); repetirlo responde «duplicado». Los entrantes (`message.inbound`) hoy sólo se registran: el laboratorio no mapea números reales a clientes; eso llega con el primer piloto real.

### 2.4 Rutas

| Ruta | Acceso | Uso |
| --- | --- | --- |
| `GET /api/webhooks/channel/<proveedor>` | pública | Verificación de la URL (Meta) |
| `POST /api/webhooks/channel/<proveedor>` | pública, firma obligatoria | Estados y entrantes |
| `POST /api/webhooks/payment/<proveedor>` | pública, firma obligatoria | Pagos confirmados o fallidos |
| `GET /api/connectors` | administración | Estado de ambos conectores, requisitos, últimos eventos |
| `POST /api/connectors/test` | administración | Evento firmado de prueba contra el webhook simulado |

Las rutas públicas no exigen sesión ni cabecera `Origin` (los proveedores no la mandan), tienen límite de 600 peticiones por minuto por IP, cuerpo máximo de 1 MB y responden 404 cuando el proveedor no tiene su secreto en el entorno (webhooks desactivados).

## 3. Qué debe entregar cada consultora

La lista viva está en `REQUIREMENTS` de `server/connectors.mjs` y se muestra en Operación → Conectores. Resumen:

### Meta (WhatsApp, Instagram, Facebook)

| Entrega | Quién | Variable |
| --- | --- | --- |
| Token permanente de usuario de sistema con permisos `whatsapp_business_messaging`, `whatsapp_business_management`, `pages_messaging`, `instagram_manage_messages` | Consultora (administrador del Business Manager) | `META_ACCESS_TOKEN` |
| Secreto de la app de Meta | Equipo técnico | `META_APP_SECRET` |
| Token de verificación del webhook (lo elegimos nosotros) | Equipo técnico | `META_VERIFY_TOKEN` |
| ID del número de WhatsApp (número dedicado, fuera de la app del celular, con nombre para mostrar aprobado) | Consultora | `META_PHONE_NUMBER_ID` |
| ID de la WABA (empresa verificada; plantillas enviadas a aprobación) | Consultora | `META_WABA_ID` |
| ID de la página de Facebook conectada a la app | Consultora | `META_PAGE_ID` |
| ID de la cuenta profesional de Instagram vinculada a la página | Consultora | `META_IG_ACCOUNT_ID` |

Antes de pedirlo, la consultora debe tener: Business Manager con **empresa verificada**, un número telefónico que pueda dejar de usar en la app WhatsApp Business del celular, página de Facebook y cuenta de Instagram **profesional** vinculada, y decidir qué **plantillas** (utilidad y marketing) enviará a aprobación: en el CRM corresponden a temario, precio, fechas y flyer. La ventana de 24 h, las categorías y el origen por anuncio ya se simulan igual que en Meta, así que el equipo no tendrá que aprender reglas nuevas.

### Stripe

| Entrega | Quién | Variable |
| --- | --- | --- |
| Clave secreta (`sk_test_…` primero, `sk_live_…` después) de la razón social que factura | Consultora o administración | `STRIPE_SECRET_KEY` |
| Secreto del endpoint de webhook (`whsec_…`) registrado para `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` | Equipo técnico | `STRIPE_WEBHOOK_SECRET` |

OXXO y SPEI se habilitan en el panel de Stripe para México. Moneda MXN. La facturación y los recibos los emite la cuenta de Stripe de la consultora.

### Conekta (alternativa)

| Entrega | Quién | Variable |
| --- | --- | --- |
| Llave privada (sandbox primero) | Consultora o administración | `CONEKTA_PRIVATE_KEY` |
| Secreto del webhook | Equipo técnico | `CONEKTA_WEBHOOK_SECRET` |

La verificación de firma de Conekta queda **pendiente de confirmar** con su documentación vigente al activar; hasta entonces su webhook responde 401.

### Lista de verificación por marca

Copia una fila por marca cuando empiece la recolección de accesos.

| Marca | Business Manager verificado | Número dedicado | Página FB | Instagram profesional | Plantillas aprobadas | Pasarela (Stripe/Conekta) | Responsable | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (nombre) | sí / no | sí / no | sí / no | sí / no | utilidad · marketing | cuenta y modo | persona | pendiente / en prueba / activo |

## 4. Cómo se activa un proveedor (cuando dirección lo indique)

1. Guardar las variables **sólo en el entorno del servidor** (Railway → Variables), nunca en Git ni en chats.
2. Poner `CHANNEL_CONNECTOR=meta` o `PAYMENT_CONNECTOR=stripe|conekta` en modo prueba (número de prueba de Meta / claves `test`).
3. Registrar la URL del webhook en el proveedor: `https://<dominio>/api/webhooks/channel/meta` (Meta pedirá el token de verificación) o `https://<dominio>/api/webhooks/payment/stripe`.
4. Comprobar en Operación → Conectores que el proveedor aparece **Configurado** y que llegan eventos; hacer una venta de prueba completa con una marca de pruebas.
5. Sólo entonces pasar a claves/números reales, marca por marca, con alcance por marca en el CRM.

Lo que todavía **no** existe y llega con el primer piloto real: el envío real por la Cloud API (hoy el adaptador de Meta lo declara 501), el mapeo de números reales a clientes del CRM para los entrantes, la creación real de sesiones de Stripe/Conekta y los reembolsos.

## 5. Probar el contrato sin proveedores

Con `CONNECTOR_WEBHOOK_SECRET` definido, Operación → Conectores → **Probar un webhook firmado** construye un evento real del laboratorio (estado del último mensaje saliente o pago de un pedido por referencia), lo firma y lo envía a la ruta pública del proveedor simulado; el resultado y el evento quedan en la bitácora. `test/connectors.test.mjs` cubre la firma y traducción de Meta y Stripe, la idempotencia, los estados de mensaje, los pagos por webhook y el respaldo al simulado cuando faltan accesos.
