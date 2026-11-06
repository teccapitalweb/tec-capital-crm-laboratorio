# Plan: portal por roles, el IPCIL nuevo dentro del CRM (Fase 5, bloque 2)

Estado: **publicado en v0.30.0** (4 nov 2026, 154 pruebas, sin esquema nuevo). El **rendimiento del equipo** para administración está publicado en v0.31.0. Decisión del usuario: el IPCIL nuevo no se hace como aplicación aparte ni en el repositorio original; se construye como **portal por roles dentro del CRM**, hablando con el resto sólo por datos y eventos del núcleo ([NUCLEO.md](NUCLEO.md)), de modo que pueda separarse después sin migrar datos.

## Principio

Cada persona del equipo ve **su** trabajo: lo que vendió y cuánto le toca, su cartera abierta, las aperturas que coordina y qué requiere atención. No se duplica ninguna regla: las cifras salen del libro de Finanzas (`ledger_entries`, `commission_entries`), de las oportunidades y de la coordinación académica. Es **sólo lectura**: ninguna acción nueva y **sin migración** (el esquema sigue en 26).

## Roles de referencia del panel IPCIL actual y cobertura

| Rol del panel actual | En el CRM hoy | Este bloque |
| --- | --- | --- |
| Vendedor | Dueño de la oportunidad (`owner_id`); la venta confirmada queda en el libro con su `seller_id`; comisión de vendedor por regla | Vista «Ventas y comisiones» y «Mi cartera» |
| Coordinador | Responsable de la apertura (`coordinator_id`) | Vista «Mis aperturas» con avisos de atención |
| Admin | Administración con alcance general | Selector «Ver a» para revisar a cualquier persona del equipo (sólo lectura) |
| Validar | Cola de comprobantes en Pagos | Ya existe; sin cambios |
| Trafiquer | Operación → Pauta (sin publicar; [PLAN_PAUTA.md](PLAN_PAUTA.md)) | Hecho a partir del panel de tráfico de IPCIL |
| RH | Operación → Aliados (sin publicar; [PLAN_ALIADOS.md](PLAN_ALIADOS.md)) | Hecho a partir del panel RH de IPCIL: postulaciones de aliados y solicitudes de WhatsApp |

## Qué muestra

- **Ventas y comisiones** (periodo 7/30/90/365 días): ventas, reembolsos, neto, ticket promedio, por marca y por curso, últimas ventas; comisión devengada y pagada en el periodo, pendiente acumulada y últimas liquidaciones.
- **Mi cartera:** oportunidades abiertas por etapa, ganadas y perdidas del periodo con % de cierre, tareas abiertas y vencidas, chats a mi cargo y los que esperan.
- **Mis aperturas:** aperturas que coordino que no están cerradas o canceladas (y las cerradas en los últimos 60 días): estado, fecha, inscritos frente al mínimo, próxima sesión, sesiones realizadas, certificados emitidos y satisfacción de la encuesta.
- **Rendimiento del equipo** (sólo administración, `GET /api/portal/team`): una fila por persona con ventas netas, cierre, abiertas, tareas vencidas, tiempo mediano de primera respuesta, % dentro de objetivo y avisos de aperturas; «Ver» abre el portal de esa persona.
- **Avisos de coordinación:** faltan inscritos para el mínimo con el inicio a menos de 7 días; abierta o en curso sin sesiones programadas; sesión realizada sin asistencia registrada; sesión en menos de 48 h sin enlace; apertura cerrada con inscritos y sin certificados.

## Reglas de acceso

Sólo equipo (asesor o administración). Cada persona ve únicamente lo suyo; administración puede pedir el de otra persona del equipo con `person`. Sólo se incluyen marcas a las que la persona tiene acceso (alcance por marca en el servidor). Cliente: 403; sin sesión: 401.

## API

`GET /api/portal/me?days=&brand=&person=` devuelve `{person, period, sales, commissions, pipeline, coordination, alerts, people}` (`people` sólo para administración).

## Fuera de alcance (a propósito)

Registrar ventas manuales con comprobante desde el portal (el flujo de venta sigue en el chat y en Pagos), reglas de comisión por persona, nómina o RH, atribución de anuncios del trafiquer. Cada uno necesita reglas del usuario y es un bloque posterior.

## Criterios de salida

Pruebas de alcance (cada persona sólo ve lo suyo, administración ve a otras, cliente sin acceso, marcas sin acceso excluidas), de cifras contra el libro, de avisos y de periodo; revisión en navegador local en escritorio y 375 px con auditoría de diseño en verde; documentación y versión 0.30.0. **No se publica sin «Sí, publicar».**
