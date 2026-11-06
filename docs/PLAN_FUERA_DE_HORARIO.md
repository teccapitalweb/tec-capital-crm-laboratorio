# Plan: mensaje de fuera de horario por marca

Estado: **publicado en `main`** (6 nov 2026, commit `43cf966`), **sin esquema nuevo y sin cambio de versión**.

## Para qué sirve

Si alguien escribe de noche, en fin de semana o en un festivo y su mensaje tiene que esperar a una persona, hoy no sabe cuándo le van a responder. Ahora la marca puede enviar un aviso automático con la **hora de la próxima apertura**.

La **bienvenida** ya existía: la del curso (primer mensaje) y la «Bienvenida por anuncio» de Contenido. Este bloque agrega la parte que faltaba, el aviso de ausencia.

## Cómo funciona

- Es un **evento más de Contenido** (`away_hours`, «Fuera de horario»): se crea una plantilla con el escenario «Evento · fuera de horario», se aprueba y se asigna en Catálogo → Contenido → Eventos. Reutiliza el flujo de aprobación; **sin plantilla aprobada y asignada no se envía nada** (todo nace apagado).
- Variables: `{{nombre}}`, `{{marca}}` y la nueva `{{apertura}}` (por ejemplo «lunes 9 de noviembre 9:00 a. m.», en la zona horaria de la marca; salta noches, fines de semana y festivos).
- Se usa el horario y los festivos de Operación → Horarios y reparto. Una marca sin horario propio usa el predeterminado (lunes a viernes, 9:00 a 18:00).
- **Cuándo se envía:** al procesar un mensaje del cliente, si el mensaje va a esperar a una persona (se pasa a un asesor, el modo es «sugerir» o las respuestas automáticas están apagadas) y la marca está cerrada en ese momento. Se manda **después** de la respuesta normal, nunca en su lugar.
- **Límite:** una vez cada 12 horas por conversación (por la referencia `away:`), así que no se repite si el cliente insiste.
- Si ya hay un asesor asignado, el motor no interviene, y por tanto tampoco este aviso.

## Archivos

`server/service-hours.mjs` (`nextOpening`, `openingLabel`), `server/replies.mjs` (`away`), `server/content.mjs` (evento), `server/catalogue.mjs` (escenario y variable), `public/catalogue.js` y `public/content.js` (etiquetas), paso nuevo en `server/readiness.mjs`, pruebas en `test/away.test.mjs`.

## Límites

- No hay aviso cuando la respuesta automática resuelve todo (precio, temario, fecha): ahí el cliente ya recibió lo que pidió.
- La próxima apertura se calcula con el horario de la marca; no sabe de turnos personales.
