# Núcleo compartido: contrato del outbox del CRM

Fase 2 · bloque 2.7, **ruta 1 («núcleo compartido primero, CRM intacto»)**. El CRM sigue operando en SQLite y envía cada hecho del negocio a un núcleo de datos en Postgres/Supabase, el mismo que leerán la Academia y el IPCIL nuevo. Este documento es el contrato entre el CRM (emisor) y el servicio que reciba los sobres (receptor). El esquema del núcleo está en [`nucleo/esquema-v1.sql`](../nucleo/esquema-v1.sql).

**Estado (3 nov 2026):** preparado y probado en el CRM con un receptor local de pruebas. Falta la decisión 7.1 de la visión (base única en Postgres/Supabase) y el acceso al proyecto de Supabase de la Academia para desplegar el receptor y aplicar el esquema. Sin `CORE_SINK_URL` el outbox es **simulado**: no sale nada del servidor.

## Cómo funciona

1. Cada módulo publica sus hechos en el índice de eventos de dominio (`domain_events`, bloque 2.1) dentro de su transacción.
2. El suscriptor `core.outbox` (`server/core.mjs`) está registrado en **todos** los tipos de evento. El reloj de eventos lo llama fuera de transacción, una vez por evento, con reintento: espera creciente de 5 s a 15 min, 5 intentos; un HTTP 4xx del receptor (salvo 408 y 429) es fallo permanente y queda visible en Operación → Eventos y → Conectores.
3. El sobre lleva el evento y una **proyección** de los registros implicados en la forma del esquema del núcleo, con los ids del sistema de origen. El receptor hace «upsert» por `(origen, origen_id)` y guarda el evento por `(origen, origen_seq)`; repetir un sobre no cambia nada.
4. **Reproducción:** Operación → Conectores → «Reproducir historial» crea entregas para todos los eventos que aún no la tienen (los anteriores a la conexión). «Reintentar fallidos» vuelve a encolar los permanentes. «Probar envío» manda un sobre `nucleo.ping` y muestra la respuesta.

## Variables de entorno

| Variable | Uso |
| --- | --- |
| `CORE_SINK_URL` | URL del receptor (POST). Vacía = modo simulado. |
| `CORE_SINK_SECRET` | Secreto HMAC compartido. Sin él los sobres salen sin firma; el receptor debe rechazarlos en producción. |
| `APP_ORIGIN` | Ya existente; se usa para `verificacion_url` de los certificados. |

## Petición HTTP

`POST CORE_SINK_URL` con `Content-Type: application/json` y cabeceras:

| Cabecera | Valor |
| --- | --- |
| `X-Nucleo-Version` | `1` |
| `X-Nucleo-Timestamp` | Milisegundos Unix del envío |
| `X-Nucleo-Signature` | `hex(HMAC-SHA256(secreto, timestamp + "." + cuerpo))` |
| `X-Nucleo-Event` | Id del evento (uuid) |

El receptor debe: verificar la firma con comparación de tiempo constante y tolerancia de 5 minutos sobre la marca de tiempo (función de referencia `verifyCore` en `server/core.mjs`); responder **2xx en menos de 10 s** (si el trabajo es largo, encolar y responder); responder 2xx también cuando el evento ya existía; responder 4xx sólo ante un sobre inválido (firma, formato), nunca por un fallo propio.

## Sobre

```json
{
  "version": "1",
  "id": "uuid del evento",
  "origen": "crm",
  "origen_seq": 1234,
  "tipo": "pago.confirmado",
  "consultora": "globalvet",
  "entidad": {"tipo": "order", "id": "uuid"},
  "ocurrido_en": "2026-11-03T15:00:00.000Z",
  "fuente": "payments",
  "actor_ref": "id de usuario del CRM o null",
  "carga": {"reference": "TC-1A2B3C", "amountCents": 35000, "kind": "course", "plan": "full", "enrollmentId": "…"},
  "registros": {
    "consultoras": [{"origen": "crm", "origen_id": "globalvet", "clave": "globalvet", "nombre": "GlobalVet"}],
    "personas": [{"origen": "crm", "origen_id": "uuid de persona | contacto:<id>", "nombre": "…", "telefono": "+52…", "correo": "…", "consentimiento": "opted_in", "identidades": [{"tipo": "telefono", "valor": "+52…"}], "contactos": [{"consultora": "globalvet", "contacto_id": "…"}]}],
    "cursos": [{"origen": "crm", "origen_id": "aves", "consultora": "globalvet", "titulo": "…", "activo": true}],
    "ediciones": [{"origen": "crm", "origen_id": "edition-aves", "curso": "aves", "consultora": "globalvet", "nombre": "…", "inicia_en": "…", "precio_centavos": 450000, "precio_sesion_centavos": 35000, "moneda": "MXN", "estado_catalogo": "published", "estado_apertura": "open", "minimo_alumnos": 5}],
    "sesiones": [],
    "pagos": [{"origen": "crm", "origen_id": "uuid", "referencia": "TC-1A2B3C", "consultora": "globalvet", "persona": "…", "curso": "aves", "edicion": "edition-aves", "sesion": null, "tipo": "course", "plan": "full", "importe_centavos": 450000, "moneda": "MXN", "metodo": "card", "estado": "paid", "proveedor_ref": "sim_…", "vendedor_ref": "…", "creado_en": "…", "pagado_en": "…"}],
    "inscripciones": [{"origen": "crm", "origen_id": "uuid", "persona": "…", "consultora": "globalvet", "curso": "aves", "edicion": "edition-aves", "pago": "uuid", "estado": "enrolled", "plan": "full", "creada_en": "…"}],
    "certificados": []
  },
  "enviado_en": "2026-11-03T15:00:01.000Z"
}
```

Las referencias entre registros (`persona`, `curso`, `edicion`, `pago`, `inscripcion`, `sesion`) son `origen_id` del CRM; el receptor las resuelve a sus uuid por `(origen='crm', origen_id)`. Orden de «upsert»: consultoras → personas (e identidades) → cursos → ediciones → sesiones → pagos → inscripciones → certificados → eventos.

## Qué lleva cada evento

| Entidad del evento | Registros en el sobre |
| --- | --- |
| `order` (pedido, pago, comprobante, reembolso) | consultora, persona, curso, edición, sesión si es pago por sesión, pago; inscripción cuando la carga la trae |
| `enrollment` | consultora, persona, curso, edición, pago de origen, inscripción |
| `certificate` | lo anterior más el certificado (folio, estado, asistencia, `verificacion_url`) |
| `edition` (apertura) | consultora, curso, edición |
| `session` | consultora, curso, edición, sesión |
| `person`, `contact`, `opportunity`, `conversation`, `resource` | consultora y la persona, curso o edición implicados |
| `message`, `payout`, `survey` | sólo el hecho: **nunca** el texto de mensajes, los comentarios de encuestas, los adjuntos ni los pagos de comisión en detalle |

Los registros reflejan el **estado actual** del CRM en el momento del envío (no una foto al momento del hecho); el hecho en sí va en `tipo` y `carga`. Una persona sin identidad única en el CRM viaja como `contacto:<id>` hasta que exista; cuando se fusionan personas llega `persona.fusionada` con la persona resultante.

## Pasos cuando llegue el acceso

1. Aplicar `nucleo/esquema-v1.sql` en el proyecto de Supabase de la Academia (esquema `nucleo`).
2. Desplegar el receptor (Edge Function o ruta del servicio de la Academia) con la verificación de firma y los «upsert» en el orden indicado. Un receptor mínimo de referencia está en las pruebas (`test/core.test.mjs`).
3. Definir `CORE_SINK_URL` y `CORE_SINK_SECRET` en Railway; en Operación → Conectores usar «Probar envío» y después «Reproducir historial».
4. Vigilar Operación → Eventos (entregas fallidas) los primeros días.

## Límites de esta preparación

- No hay cliente de Postgres en el CRM ni migración del CRM a Postgres (ruta 2, después y módulo por módulo).
- El receptor real no existe todavía; el de las pruebas sólo valida firma y cuenta sobres.
- El esquema v1 cubre lo que el CRM produce hoy; la Academia añadirá sus columnas (p. ej. membresías de clubes) con migraciones versionadas aparte.
