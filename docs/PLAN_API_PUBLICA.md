# Plan: API pública de lectura y webhooks salientes

Estado: **publicado en `main`** (7 nov 2026), **esquema 35** (tres tablas nuevas), sin cambio de versión. Dos correcciones posteriores a la revisión de seguridad automática (rama `fix/api-seguridad`, sin publicar) están en «Seguridad».

## Para qué

Hasta ahora el CRM sólo hablaba con sus propias pantallas. Para que otro sistema (facturación, un tablero, una automatización, el sitio de la consultora) use sus datos sin entrar al CRM, hacen falta dos cosas: **preguntarle** (API) y que **él avise** cuando algo pasa (webhooks). Esta entrega da las dos, por marca y con permisos mínimos.

## Qué hace

### API v1 (sólo lectura)

- Administración crea **llaves por marca** en *Operación → Sistema → API y webhooks → Llaves de la API*, con los permisos que quiera: `events`, `orders`, `contacts` (con teléfono y correo) y `editions`. El valor de la llave (`tcw_…`) se muestra **una sola vez**; en la base sólo queda su huella SHA-256 y un prefijo para reconocerla. Se puede revocar al instante.
- Se usa con `Authorization: Bearer tcw_…` en `https://<dominio>/api/v1/…`. No lleva sesión ni cookie.
- Rutas (todas `GET`; sólo ven la marca de la llave):

| Ruta | Permiso | Qué devuelve |
|---|---|---|
| `/api/v1/me` | cualquiera | La marca, los permisos de la llave, la versión y los tipos de evento |
| `/api/v1/events?after=<seq>&limit=&type=` | `events` (+ el del dato) | Eventos de dominio en orden, con el mismo sobre que los webhooks; `next` y `hasMore` para seguir donde se quedó. **El contenido (`data`) de cada tipo exige además su permiso**: `orders` (pedidos, pagos, inscripciones, reembolsos, comisiones), `contacts` (conversaciones, etapas, mensajes, bajas, certificados, encuestas, históricos) o `editions` (aperturas, sesiones, cupos, precios, grabaciones). Sin él llega el sobre con `data: {}`, `redacted: true` y `requires`; `GET /api/v1/me` trae el mapa `eventScopes` |
| `/api/v1/orders?after=&status=&limit=` | `orders` | Pedidos (importe final, descuento, cupón, estado, método, fechas); sin referencias del proveedor ni notas |
| `/api/v1/contacts?after=&limit=` | `contacts` | Contactos de la marca con teléfono y correo |
| `/api/v1/editions` | `editions` | Aperturas publicadas con precio, fechas, modalidad y cupo |

- **Paginación:** `limit` de 1 a 200 (100 por omisión). Eventos usan `after=<seq>`; pedidos y contactos usan el cursor `next` (`<updated_at>:<id>`), que se vuelve a mandar como `after`, y se ordenan por última modificación: sirve para **sincronizar cambios** (un pedido que cambia reaparece con su nuevo estado).
- **Límites:** 120 solicitudes por minuto por llave; los intentos con llaves falsas se frenan por IP (429).

### Webhooks salientes

- Administración registra **destinos HTTPS** por marca (hasta 10) con un **filtro de eventos** (todos o una lista de los 38 tipos de [ARQUITECTURA.md](ARQUITECTURA.md) / `GET /api/v1/me`).
- Cuando ocurre un evento de esa marca que coincide, el CRM **lo encola** (una fila por destino y evento; no se duplica) y un temporizador lo **envía por red fuera de cualquier transacción**.
- **Cuerpo** (JSON):

```json
{"id":"evt_43","type":"pago.confirmado","createdAt":"2026-11-07T05:33:22.450Z","brandId":"globalvet",
 "entity":{"kind":"order","id":"…"},"data":{"reference":"TC-1A2B3C","amountCents":34110,"currency":"MXN"},"apiVersion":"1"}
```

- **Cabeceras:** `TC-Event` (tipo), `TC-Delivery` (id de la entrega; **igual en los reintentos**, úsalo para no procesar dos veces), `TC-Timestamp` y `TC-Signature: t=<unix>,v1=<firma>`.
- **Firma:** `v1 = HMAC-SHA-256(secreto, t + "." + cuerpo)` en hexadecimal. El receptor debe recalcularla y rechazar marcas de tiempo con más de 5 minutos de diferencia (hay una función de referencia: `verifyWebhook` en `server/integrations.mjs`).

```js
import {createHmac,timingSafeEqual} from 'node:crypto';
function verify(secret,header,raw){            // header = req.headers['tc-signature']
  const p=Object.fromEntries(header.split(',').map(x=>x.trim().split('=')));
  if(Math.abs(Date.now()/1000-Number(p.t))>300)return false;
  const want=createHmac('sha256',secret).update(p.t+'.'+raw).digest('hex');
  return p.v1&&p.v1.length===want.length&&timingSafeEqual(Buffer.from(p.v1),Buffer.from(want));
}
```

- **Reintentos:** si el destino no responde **2xx** (o tarda más de 8 s) se reintenta con espera creciente (5 s, 10 s… hasta 15 min), hasta **6 intentos**; después la entrega queda **fallida** y se puede **reintentar a mano** desde «Entregas». Tras **15 entregas fallidas seguidas** el destino se **desactiva solo** (con el motivo) hasta que administración lo reactive. Un destino pausado o desactivado no recibe nada nuevo.
- **Probar** envía un evento `webhook.test` firmado y dice qué respondió el destino y en cuánto tiempo. **Rotar secreto** genera uno nuevo (el anterior deja de servir).
- Se limpian las entregas hechas con más de 7 días y las fallidas con más de 30.

## Seguridad

- **Destinos internos rechazados (SSRF).** Sólo HTTPS, sin usuario ni contraseña en la URL, y el dominio debe resolver **únicamente a direcciones públicas**: se rechazan loopback, redes privadas, enlace local (incluido el servicio de metadatos de la nube `169.254.169.254`), CGNAT, multicast, IPv6 local y mapeadas, y los nombres `localhost`, `.local`, `.internal`, `.lan`. **IPv6 se niega por omisión:** sólo se acepta unicast global (`2000::/3`) y, aun ahí, se rechazan `2001::/23` (Teredo y reservadas), `2001:db8::/32` y `3fff::/20` (documentación) y las direcciones 6to4 (`2002::/16`) cuyo IPv4 incrustado sea privado; las IPv4 mapeadas o compatibles se juzgan por su IPv4 (así quedan fuera ULA, enlace local, multicast, NAT64 `64:ff9b::/96`, `::1`…). Se comprueba al registrar **y en cada envío**; no se siguen redirecciones (un 3xx cuenta como falla). Limitación conocida: entre la comprobación y la conexión el DNS podría cambiar (rebinding); el riesgo es bajo porque sólo administración registra destinos, y queda como mejora fijar la IP resuelta.
- `WEBHOOK_ALLOW_PRIVATE=1` **sólo para laboratorio y pruebas** (permite http y direcciones locales). No debe activarse en producción.
- **Secretos:** la llave de la API se guarda como hash; el **secreto de firma de un destino sí se guarda** (hace falta para firmar). Por eso una **copia de la base SQLite contiene secretos de webhooks**: tratarla como sensible, igual que ya se hace con sesiones y claves push. Nada de esto se imprime ni se vuelve a mostrar en la lista (sólo los últimos 4 caracteres del secreto).
- **Alcance:** administración gestiona llaves y destinos de las marcas que ve; la API sólo expone la **marca de la llave** y sólo los permisos elegidos. Clientes y asesores reciben 403 en `/api/integrations`; sin sesión 401.
- **Datos que salen:** los eventos llevan la «carga breve» ya definida para cada tipo (referencias, importes, ids); los contactos salen sólo con el permiso `contacts`. No hay mensajes de chat ni adjuntos en la API. El destino es responsabilidad de quien lo registra: revisa qué eventos le mandas.
- **Permisos de la API de eventos:** el permiso `events` solo no basta para leer el contenido de eventos que llevan pedidos o datos de personas (ver la tabla de rutas); un tipo nuevo de evento queda restringido hasta clasificarlo (hay una prueba que lo exige). Los **webhooks** no se filtran así: los registra administración, que decide qué eventos manda a cada destino.
- Auditoría: `apikey.create`, `apikey.revoke`, `webhook.create`, `.update`, `.rotate`, `.delete`, `.retry`.

## Datos

Esquema 35: `api_keys`, `webhook_endpoints` y `webhook_deliveries` (`UNIQUE(endpoint_id, event_seq)`). Aditivo; respaldo automático antes de migrar (`backups/before-crm-v35-*`). Los webhooks se apoyan en el índice de eventos de dominio ([Fase 2, bloque 2.1](PLAN_FASE_2.md)): el suscriptor `webhooks.out` sólo encola, el envío ocurre aparte.

## Límites actuales

- La API es **sólo de lectura**: no crea contactos, pedidos ni mensajes (sería el siguiente paso, con idempotencia y consentimiento).
- Entrega **al menos una vez**: un destino puede recibir el mismo evento dos veces (por ejemplo si respondió tarde). Hay que deduplicar con `TC-Delivery` o con `id` del evento.
- No hay orden garantizado entre eventos distintos que se reintentan.
- Un destino por URL con un solo secreto; no hay filtros por entidad ni por campos.
- Sin limitación por destino más allá de los 6 intentos; sin panel de métricas global.

Archivos: `server/integrations-schema.mjs`, `server/integrations.mjs`, `server/index.mjs`, `public/integrations.js`, `public/operations.js`, `public/crm.css`; pruebas `test/integrations.test.mjs`.
