# Plantillas de WhatsApp aprobadas por Meta (12 nov 2026)

Rama `feat/plantillas-whatsapp`. **Esquema 39.** Sin publicar. Continúa [PLAN_WHATSAPP_REAL.md](PLAN_WHATSAPP_REAL.md).

## Para qué

WhatsApp sólo deja escribirle libremente a una persona durante las 24 horas siguientes a su último mensaje. Después, lo único que Meta acepta es una **plantilla aprobada**: un texto fijo, con datos variables, que Meta revisó antes. Sin esto, con la ventana cerrada no salía nada: ni un seguimiento del equipo ni la confirmación de un pago tardío.

## Qué hace

**1. Administrar plantillas** (Operación → Sistema → Conectores → «Plantillas de WhatsApp», sólo administración)

- **Escribir** una plantilla por marca con los datos por su nombre: `{{nombre}}`, `{{curso}}`, `{{edicion}}`, `{{marca}}`. El CRM la convierte al formato de Meta (`{{1}}`, `{{2}}`…) y guarda qué dato llena cada posición.
- **Enviar a aprobación**: viaja a Meta con un ejemplo por dato (Meta lo exige).
- **Sincronizar con Meta**: trae el estado (en revisión, aprobada, rechazada con su motivo, pausada).
- **Usar una que ya existe en Meta** (por ejemplo `hello_world`, que viene con el número de prueba): se indica la marca y qué dato llena cada variable.
- Cada plantilla es de **utilidad** (avisos sobre algo que la persona pidió) o de **marketing**, y tiene un uso:
  - **Manual**: la envía una persona del equipo desde el chat.
  - **Aviso**: la manda el CRM solo (ver punto 3).

**2. Enviar una plantilla desde el chat**

Con la ventana cerrada, la barra del chat muestra **«Enviar plantilla»**. Abre las plantillas aprobadas de la marca, ya con los datos de esa persona. Quien la envía queda a cargo de la conversación. Cuando la persona responde, se puede volver a escribir libremente. El texto libre con la ventana cerrada se sigue rechazando, con un mensaje que apunta al botón.

**3. Avisos del negocio con la ventana cerrada**

Un aviso que el CRM genera solo (confirmación de pago, certificado, recordatorio, seguimiento, campaña) no puede salir como texto libre. Si la marca tiene una plantilla de **aviso** aprobada de la misma categoría:

1. Sale la plantilla de aviso («Hola María, tenemos una novedad sobre tu inscripción en… Responde a este mensaje para verla.»). **Una sola por periodo cerrado**, aunque haya varios mensajes pendientes.
2. El mensaje original queda **en espera** (el chat lo muestra así).
3. Cuando la persona responde, los mensajes en espera salen en orden, antes que la respuesta del asistente.
4. Si nadie responde en 7 días (`WA_HOLD_DAYS`), el mensaje caduca y queda «no entregado».

Sin plantilla de aviso aprobada, el mensaje queda «no entregado» con el motivo, como antes. En ningún caso falla la operación del negocio (el pago se registra igual).

Un aviso de utilidad usa la plantilla de aviso de utilidad; uno de marketing (campañas, flyers), la de marketing. Así no se usa una plantilla de utilidad para promocionar, que Meta sanciona.

## Datos (esquema 39)

- `wa_templates(id, brand_id, name, language, category, purpose, body, variables, status, meta_id, reject_reason, revision…)`, con `UNIQUE(name, language)` porque hay una sola cuenta de WhatsApp Business.
- `messages.wa_template`: el mensaje sale como plantilla; guarda nombre, idioma y valores ya resueltos (un cambio posterior a la plantilla no altera lo enviado).
- `messages.wa_hold`: marca de «en espera».

## Variables de entorno

| Variable | Para qué |
| --- | --- |
| `META_WABA_ID` | Obligatoria para enviar a aprobación y sincronizar (no para enviar una plantilla ya aprobada) |
| `WA_HOLD_DAYS` | Días que un mensaje espera antes de caducar; por omisión 7 |

## Cuidados

- **Datos personales**: las variables sólo admiten nombre, curso, edición y marca. No hay teléfono, correo ni datos de pago en una plantilla.
- **Reglas de Meta que el CRM valida antes**: nombre en minúsculas con guion bajo, el texto no empieza ni termina con un dato, proporción razonable entre texto y datos, y los valores viajan sin saltos de línea.
- **Sin duplicados**: el envío desde el chat lleva `clientRef`; el aviso automático tiene una referencia única por conversación y periodo cerrado.
- **Costo**: Meta cobra cada plantilla enviada (las de marketing más que las de utilidad). Por eso el aviso automático sólo existe si administración marca una plantilla como «aviso».
- **Alcance por marca**: el equipo sólo ve y envía las plantillas aprobadas de la marca de la conversación.

## Límites

- Sólo se llena el **texto principal**. Las plantillas con imagen en el encabezado, con datos en botones o de autenticación aparecen al sincronizar pero no se pueden usar.
- Un borrador no se edita: se quita y se escribe de nuevo. Quitar una plantilla la quita del CRM, no de Meta.
- El aviso es genérico («tienes una novedad»). Plantillas específicas por tipo de aviso (por ejemplo «tu pago quedó confirmado» con la referencia) quedan para después.
- El asistente también contesta el mensaje con el que la persona responde al aviso.
- **Sin probar contra Meta de verdad**: todo se verificó con una API de Meta simulada.

## Verificación

- `test/whatsapp-templates.test.mjs` (2 pruebas): formato exacto de lo que viaja a Meta; validaciones al escribir; envío a aprobación y sincronización; adoptar una plantilla existente y rechazar las complejas; envío desde el chat con la ventana cerrada, sin duplicar y con el autor a cargo; aviso único con el mensaje en espera y su salida en orden al responder; rechazo de Meta y reintento; sin plantilla de aviso; caducidad; quitar una plantilla.
- Suite completa: 204 pruebas.
- En el navegador con servidor local y Meta simulado: panel de plantillas (crear, enviar a aprobación, sincronizar) y «Enviar plantilla» en el chat, en computadora y a tamaño de celular.

## Pendiente

1. Probar con Meta de verdad: crear la plantilla de aviso, esperar su aprobación y dejar pasar 24 horas (o usar `hello_world`).
2. Plantillas específicas por tipo de aviso.
3. Encabezados con imagen y botones con enlace.
