# Cimientos de difusiones (D-1)

Estado: construido en la rama de integración, **sin publicar**. No cambia nada visible: las campañas de hoy funcionan igual, no hay pantalla nueva y todo lo nuevo nace vacío o con datos orientativos. Es la base de las difusiones con plantilla (audiencias D-2, plantillas completas D-3, motor y asistente D-5) que se necesitan antes del cambio de número. Depende del contrato de canal 1.1 ([PLAN_CONTRATO_CANAL.md](PLAN_CONTRATO_CANAL.md)).

Fuente: el diseño de difusiones (§1 decisiones D1, D2, D5, D9, D10; §3 modelo de datos; §7 costos) **adaptado a la conciliación técnica**, que manda (filas 1, 28, 36, 38, 40 y 41; riesgos F-1, F-2 y F-6).

## 1. Migración `broadcasts/0001-foundations`

Una sola migración con nombre, marcada `rebuild: true` (el ejecutor apaga las claves foráneas, la aplica en una transacción y exige `PRAGMA foreign_key_check` vacío). Es la **única** reconstrucción de las difusiones (F-2): se hace una vez y antes de la primera campaña real.

| Tabla | Qué cambia | Por qué |
| --- | --- | --- |
| `wa_templates` (reconstruida) | Columnas de §3.6 (`components`, `tpl_type`, calidad, estado detallado, cambios de categoría, fechas de envío y aprobación, baja suave `archived_at`, `updated_by`…), `waba_id TEXT NOT NULL DEFAULT ''` y **`UNIQUE(waba_id, name, language)`** en lugar de `UNIQUE(name, language)`. `category` sin `CHECK` (se valida en código) | Fila 36: el número de prueba y el real viven en cuentas distintas; con la unicidad vieja, sus plantillas chocarían por nombre. Reconstruirla después sería más caro (D-5 le añade la primera clave foránea entrante) |
| `campaigns` (reconstruida) | `kind` (`catalogue` = lo de hoy; `template` = plantilla de Meta), `template_id` opcional, `wa_template_id`, `wa_number`, `content`, `options`, motivo y estado de reanudación, zona, estimación confirmada, lotes, reintento, campaña madre. `status` sin `CHECK` (admite `paused` y `stopped` sin otra reconstrucción) | D1 y D5: un modelo con dos tipos; SQLite no relaja `NOT NULL` ni `CHECK` con `ALTER` |
| `campaign_recipients` (reconstruida) | `id` propio (con valor por omisión, así un `INSERT` de hoy sigue funcionando), `conversation_id` y `step_id` **opcionales**, y la cola por destinatario: `state`, `wa_to`, `wa_recipient` (fila 37: destinatario por identificador de usuario), arrendamiento, referencia del proveedor, instantánea, fallo, fechas de entrega, lectura, respuesta y clic | D2 y D3: una difusión con plantilla no necesita conversación |
| `wa_account` (nueva) | Hechos de cada cuenta de WhatsApp Business: zona de la cuota, límite de mensajería, tope de plantillas, estado del pago, más lo no secreto de la fila 38 (`business_id`, `label`, `mode`, `currency`, `review_status`, `connection_id`). Se crea al primer uso (clave `META_WABA_ID` o `local`) | Fila 38: modelo único de la cuenta; las credenciales irán a `connections` (otro incremento) |
| `wa_rates` (nueva) | Tarifa por mercado (`MX`, `US`… o `*`), categoría y fecha de vigencia, en millonésimas de la moneda, con `verified` y `source` | D9 |
| `wa_pricing_rules` (nueva) | Reglas de Meta fechadas: servicio gratis por número y mes, días y horas de la ventana gratuita por anuncio, si el servicio se cobra, si la utilidad dentro de la ventana es gratis | D9, §7.2 |
| `wa_message_costs` (nueva) | Libro de costos: una fila por mensaje real (`wamid`) con número, marca, mercado, origen (chat o difusión), campaña, categoría (de Meta o del CRM), tipo de precio, si se cobra y cuándo se entregó. **Sin importes** | D10 |

Índices y disparadores de las tablas reconstruidas se conservan (`rebuildTable`); los de otras tablas que las nombran, también. Las filas existentes quedan intactas: las campañas pasan a `kind='catalogue'`, cada destinatario recibe un `id`, y cada plantilla queda con `waba_id=''` y `components` armado a partir de `body` y `variables` (las muestras se completan al editarla, en D-3).

**Semillas orientativas.** Tarifas de México y de «cualquier otro mercado» (marketing 0.7298, utilidad, autenticación y servicio 0.1565 MXN por mensaje entregado) y la regla vigente desde el 1 oct 2026 (1,000 mensajes de servicio gratis al mes por número; después se cobran; entrada por anuncio: hasta 7 días sin costo si se responde en 24 h). Todas con `verified=0` y su origen escrito: **no son la verdad comercial**; son datos que administración sustituye agregando filas nuevas con su fecha. El código no trae ninguna cifra.

No entra aquí (va con su incremento): ajustes por marca de §3.2 (ritmo, horario de silencio, presupuesto), audiencias (§3.3), bloqueos y pistas de respuesta (§3.5), caché de archivos de Meta (§3.6) y salud del número (§3.7 → `channel_health`, X3). La tabla `broadcast_access` **no se crea** (fila 28). La clave de teléfono (§3.4) ya existe (`identity/0001-phone-key`).

## 2. Una difusión no crea oportunidades ni tareas falsas (decisión D2)

Hoy cada conversación nueva crea contacto, oportunidad y la tarea «Dar seguimiento al interés». Una difusión a 6,408 contactos habría creado 6,408 de cada una. Lo que lo evita en estos cimientos:

- `campaign_recipients.conversation_id` es opcional: un destinatario de una difusión con plantilla es sólo un contacto y su envío vive en su fila. La conversación se escribe cuando la persona responde (D-5).
- `server/campaigns.mjs` sólo atiende campañas `kind='catalogue'`: el lanzador y el cierre periódicos, la lista y cada ruta ignoran las de plantilla (para esas rutas no existen: 404). Así ninguna difusión con plantilla pasa por el motor de catálogo, que sí necesita conversación.
- El estado de Meta de un envío de difusión va al libro de costos por la referencia del destinatario, sin tocar conversaciones.

La prueba de punta a punta programa una difusión con plantilla con dos destinatarios sin conversación, deja correr el reloj de campañas y comprueba que no nace ninguna conversación, oportunidad ni tarea, también al llegar sus estados.

## 3. Permisos y eventos

- `server/campaigns.mjs` pregunta con `access` (claves `campaigns.view`, `campaigns.edit` y `campaigns.send` del catálogo) en lugar de «es administración». Hoy sólo administración las tiene: nadie gana ni pierde nada. Sin tablas de función nuevas.
- Costos: ver el medidor y las tarifas pide `settings.costs` (en la marca, o en alguna); agregar tarifas y reglas, administración.
- Evento de dominio nuevo, registrado con `events.registerTypes`: `whatsapp.cuota_servicio` (entidad `wa_number`), una sola vez por número, mes y umbral (80 % y 100 % de los mensajes de servicio gratis). Sin datos personales. No hay eventos por mensaje (F-13).

## 4. Motor de costo: `server/modules/wa-costs/`

Un solo motor (fila 40). `model.mjs` son las reglas sin base ni red; `repo.mjs`, todo el SQL; `module.mjs`, el descriptor, las rutas y las funciones para otros módulos (`host.module('wa-costs')`): `rules`, `rateFor`, `estimate`, `record`, `meter`, `monthSpend`, `freeEntry`, `account`.

**Reglas que aplica** (las cifras salen de las tablas):

| Caso | Costo |
| --- | --- |
| Meta dijo `billable=true` | La tarifa del mercado y la categoría vigente cuando se entregó |
| Meta dijo `billable=false` o un tipo `free_*` | 0; si es de servicio, gasta cuota del número |
| Tipo `free_entry_point` (entrada por anuncio) | 0, sin gastar cuota |
| Servicio sin dato de Meta | Gratis mientras el número tenga cuota en el mes; después, la tarifa (si la regla dice que el servicio se cobra) |
| Marketing, utilidad o autenticación sin dato de Meta | La tarifa (la utilidad gratis dentro de la ventana sólo se sabe por el dato de Meta; sin él se cuenta cobrada: estimación prudente) |
| Mensajes del cliente, conversaciones del laboratorio | No entran al libro |

- **Mercado**: del teléfono de la persona (prefijo más largo: `52`→MX, `1`→US, `57`→CO…; lo demás, `*`). La tarifa del mercado exacto si existe; si no, la de `*`. Gana la fila con la vigencia más reciente que no sea posterior a la entrega.
- **La cuota es del número**, no de la marca, y se cuenta en el mes de la **zona de la cuenta** (`wa_account.timezone`, por omisión Ciudad de México), no en UTC. Se reparte en orden de entrega (por horas; dentro de una hora, primero lo que Meta ya clasificó).
- **Libro** (`record`): oyente de `connectors.on('message.status')` con `order: 300` (después de las difusiones, fila 40). Sólo con `sent`, `delivered` o `read`; localiza el origen (mensaje de una conversación real o destinatario de difusión); la categoría de Meta sustituye a la del CRM; completa lo que faltaba y nunca borra. Síncrono, sin transacción propia ni red (F-1). Es idempotente por la referencia del proveedor.
- **Compatibilidad**: si `MESSAGE_RATES` está definida, sus tres valores sustituyen la tarifa de `*` (laboratorio y demostraciones).
- **Ventana gratuita por anuncio** (`freeEntry`): estimación propia (anuncio → primera respuesta del negocio dentro de las horas de la regla → N días). El dato firme es el `pricing.type` de Meta. **No** se conectó a `channel.windowOf` (cambiaría la ventana que se ve en el chat); lo hará el incremento que toque la interfaz.

**Rutas** (con sesión):

```text
GET  /api/wa-costs/meter?brand=all|<marca>&month=AAAA-MM   medidor: por número (servicio usado de la cuota, por categoría y total), por marca (total y de difusiones), total; ratesVerified
GET  /api/wa-costs/rates                                   tarifas, reglas y la cuenta
POST /api/wa-costs/rates  {market, category, rateMicros, effectiveFrom, currency?, verified?, source?}   (administración)
POST /api/wa-costs/rules  {effectiveFrom, freeServicePerNumber, freeEntryDays, freeEntryReplyHours, serviceCharged?, utilityInWindowFree?, verified?, note?}
```

Nunca se edita ni se borra una fila pasada: una corrección es otra fila con su fecha. Repetir la misma alta devuelve la existente; con otros valores para la misma vigencia, 409.

## 5. Pruebas (`test/broadcasts-foundations.test.mjs`)

- **Actualización sobre una base publicada con datos** (escalera 41 + migraciones con nombre de `main`): campañas (borrador y terminada), destinatario con su paso, bitácora, plantillas con variables, número y un disparador propio de `campaigns`. Después: filas idénticas en sus columnas de antes, ids de destinatario, `components` armado, bitácora intacta, disparadores (propios y de otras tablas) e índices conservados, `foreign_key_check` vacío, claves foráneas otra vez activas (borrar una campaña con bitácora falla), estados nuevos admitidos, destinatario sin conversación admitido, unicidad por cuenta en plantillas, semillas sin confirmar, segunda pasada sin cambios y la misma forma que una base nueva.
- **Reglas**: mercados, mes en la zona (con y sin horario de verano), reparto de la cuota con y sin dato de Meta, entrada por anuncio.
- **De punta a punta** con el Meta de mentira: altas de tarifas y reglas (idempotencia, 409, validación), estados que crean y completan el libro, un estado ajeno que no escribe nada, 1,005 mensajes de servicio → 1,000 gratis y 5 cobrados por número, marketing de México y de Estados Unidos a su tarifa, gasto de difusiones por marca, avisos de cuota del 80 % y el 100 % una sola vez, y la decisión D2.
- `test/campaigns.test.mjs` pasa sin cambios.

## 6. Decisiones donde el diseño era ambiguo

- **Sin `CHECK` en los estados y tipos** de las tablas reconstruidas (`campaigns.kind`, `campaigns.status`, `campaign_recipients.state`, `wa_templates.category`, `wa_message_costs.origin`): se validan en código. Lección de la fila 36 y del hallazgo 8 de identidad: un estado nuevo no debe obligar a otra reconstrucción.
- **`campaign_recipients.id` con valor por omisión** en lugar de «un INSERT sin id debe fallar»: así el código anterior (y una prueba de fusión de datos de persona) sigue funcionando, y no hay filas con `id` nulo.
- **`wa_message_costs.category_source`** (`crm` o `meta`): no estaba en el diseño; permite saber si la categoría la confirmó Meta.
- **Orden del registro de migraciones**: el área `messages` va después de `queues`, para que una base nueva tenga el mismo orden de columnas que una publicada.
- **Tarifas de prueba frente a semillas**: gana la vigencia más reciente; una tarifa con vigencia anterior al 1 oct 2026 no sustituye a la semilla de esa fecha. Para corregir una semilla se agrega una fila con fecha posterior.

## 7. Riesgos al activarlo con un número real

- **Tarifas y reglas sin confirmar**: el medidor dice `ratesVerified: false` hasta que administración agregue tarifas verificadas para México y «cualquier otro». Confirmar con la página de precios de Meta (y la moneda de la cuenta) antes de la primera difusión real.
- **La categoría de Meta manda**: si Meta no envía `pricing` en los estados (cuenta sin precios por mensaje), el libro usa la categoría del CRM y la cuota se estima.
- **Plantillas por cuenta**: las de hoy quedan con `waba_id=''`. Al pasar del número de prueba al real hay que asignarles su cuenta (D-3), o convivirán como si fueran de otra cuenta.
- **Primera reconstrucción en producción**: hacerla con la bandeja de webhooks vacía y después del respaldo automático previo (lo crea el ejecutor). Ensayo de restauración recomendado (F-2).
- **Tope por campaña** (`max_audience` 5,000) frente a la lista de 6,408 (F-6): no cambia aquí; hay que subirlo o partir la difusión.
