# Plan: campañas y envíos segmentados (Fase 5, bloque 1)

Estado: **implementado localmente** en la rama `feat/campanas` (4 nov 2026, v0.29.0, esquema 26, 153 pruebas), **sin publicar**. Pedido por el usuario tras comparar con CRM de WhatsApp para academias (Kommo, Leadsales, Callbell, Respond.io, Wati, Clientify): lo que más falta es mandar una plantilla aprobada a un segmento, programada, con resultados. Todo sigue sobre el canal **simulado**; no se conecta ningún proveedor.

## Principio

Una campaña es una **plantilla aprobada** + un **segmento** + una **fecha**. No inventa mensajes ni precios: cada envío se arma con `catalogue.prepare` (oferta vigente de la edición) y lleva su snapshot comercial, igual que una receta. Reutiliza el motor de pasos durables del bloque 4A, así hereda reintentos, arrendamientos, idempotencia, pausa global y apagado por marca.

## Piezas que se reutilizan

| Pieza | Para qué |
| --- | --- |
| `automation.enqueue` (paso `campaign.send`) | Un paso por destinatario, con clave `campaign:<id>:<contacto>`: un reintento o un segundo escaneo no duplica envíos |
| `content_templates` aprobadas + `catalogue.prepare` | Texto, flyer y snapshot vigentes en el momento del envío |
| `contact_tags`, etapa de la oportunidad, curso/edición, `last_inbound` | Criterios del segmento |
| `contact_consent` | Baja siempre excluye; consentimiento registrado se exige por omisión |
| `channel` (categoría utilidad/marketing, ventana, estados entregado/leído) | Costo estimado y métricas de entrega |
| `insertMessage` + `operations.message` | Mensaje real dentro de la conversación del contacto |

## Esquema 26 (migración nueva, aditiva, respaldo `before-crm-v26-*`)

- `campaign_settings(brand_id PK, enabled=0, min_gap_hours=72, pace_seconds=2, max_audience=5000, revision, updated_by, updated_at)`: **apagado por omisión**.
- `campaigns(id, brand_id, title, template_id, segment JSON, require_consent=1, status draft|scheduled|sending|completed|cancelled, scheduled_at, audience_confirmed, revision, client_ref UNIQUE, created_by, created_at, updated_at, started_at, finished_at)`.
- `campaign_recipients(campaign_id, contact_id, conversation_id, step_id, PK(campaign_id,contact_id))`: sólo membresía; el estado vive en el paso, el mensaje y el consentimiento (una sola fuente de verdad, sin contadores que se desajusten).
- `campaign_events(seq, campaign_id, kind, details, actor_id, created_at)`: bitácora (creada, editada, programada, lanzada, cancelada, completada).

## Reglas de elegibilidad (vista previa, lanzamiento y justo antes de cada envío)

1. Contacto de la marca, con conversación en la marca (la más reciente).
2. Sin baja. Si `require_consent`, con consentimiento registrado.
3. Nadie del equipo controla el chat (`assigned_to` vacío y `bot_enabled`): no se interrumpe una atención humana.
4. Separación mínima entre campañas por contacto (`min_gap_hours`) **y** el tope existente de recetas.
5. Plantilla aún aprobada y oferta disponible (`catalogue.prepare`).
6. Campaña no cancelada; marca con campañas y automatización encendidas; sin pausa global.

La vista previa devuelve elegibles, excluidos **por motivo**, 5 destinatarios de ejemplo, el mensaje renderizado y el costo estimado (`MESSAGE_RATES`). **Programar exige confirmar el número de destinatarios vista previa** (`confirmAudience`): si el segmento cambió, hay que revisar de nuevo.

## API (todo administración; alcance por marca)

`GET/PATCH /api/campaigns/settings`, `GET/POST /api/campaigns`, `GET/PATCH /api/campaigns/:id` (`expectedRevision`), `POST …/preview`, `POST …/schedule`, `POST …/cancel`, `GET …/recipients?state=`. Crear usa `clientRef`; programar y cancelar son idempotentes.

## Ciclo de vida

`draft → scheduled → sending → completed`, o `cancelled`. Un escaneo cada segundo (junto al de recetas) lanza las campañas vencidas: resuelve el público, lo registra, encola los pasos espaciados `pace_seconds` y pasa a `sending`; cuando no queda ningún paso pendiente pasa a `completed`. Cancelar cancela los pasos pendientes (los ya enviados no se retiran). Pausa y reanudación se hacen con los interruptores existentes (marca y global), que detienen y reanudan el envío sin perder nada.

## Métricas (calculadas, no almacenadas)

Por campaña: destinatarios, programados, enviados, entregados, leídos, fallidos, omitidos por motivo, **respondieron** (mensaje del cliente en los 7 días siguientes) y **bajas** (baja registrada tras el envío). Costo estimado real = enviados × tarifa de la categoría.

## Interfaz

Pestaña **Campañas** en Operación (después de Seguimientos): lista con estado y avance, asistente de nueva campaña (marca, plantilla, segmento, consentimiento, fecha), vista previa con motivos de exclusión, detalle con embudo de resultados y destinatarios. Paleta y reglas de Niebla; revisión en escritorio y 375 px. Paso 13 del guion de presentación.

## Fuera de alcance (a propósito)

Envío real por Meta, A/B de plantillas, campañas recurrentes, segmentos guardados con nombre, importación de listas externas. Cada uno es un bloque posterior.

## Criterios de salida

Migración con prueba de actualización y persistencia; pruebas de elegibilidad, idempotencia, bajas, separación mínima, toma humana, cancelación y permisos; revisión en navegador local con registros propios; auditoría de diseño en verde; documentación y versión 0.29.0. **No se publica sin «Sí, publicar».**
