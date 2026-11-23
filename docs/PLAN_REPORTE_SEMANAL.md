# Resumen de la semana (reporte para el equipo)

Una tarjeta en lenguaje sencillo, arriba de **Analítica comercial** (Resultados → Analítica), con las cifras de los **últimos 7 días** comparadas con los **7 anteriores**, y botones para **copiar** o **descargar** y presentarlas. No es un panel nuevo: aprovecha las cifras que la analítica ya calcula, pero contadas para que cualquiera las lea de un vistazo.

## Por qué

El CRM ya tenía reportes (embudo, conversión, canales, tiempos de respuesta, desempeño del equipo), pero no había forma de **llevarse o presentar** un resumen. El dueño presenta el avance a las consultoras; esta tarjeta da un texto corto, claro y copiable.

## Qué muestra (por marca, o todas las autorizadas)

Cada renglón trae el número de esta semana y la diferencia contra la anterior (↑ sube, ↓ baja, → igual):

- **Conversaciones nuevas.**
- **Pidieron informes** (oportunidades que llegaron a «interesado»).
- **Pidieron inscribirse** (llegaron a «inscripción»).
- **Inscripciones de práctica** (llegaron a «ganada»; son de práctica, no confirman dinero ni matrícula).
- **El asistente respondió solo**: porcentaje de respuestas automáticas (reglas + IA) sobre las que atendió (reglas + IA + pasadas a una persona), con el conteo.
- **Respuesta del equipo (mediana)**: tiempo de la primera respuesta humana; menos es mejor («más rápido»/«más lento»).

Botones **Copiar** y **Descargar** (.txt) con el mismo texto, para pegarlo en una presentación o un mensaje.

## De dónde salen las cifras

Las mismas definiciones y el mismo alcance por marca que `/api/analytics` (`server/analytics.mjs`). El resumen va **dentro** de esa respuesta, en `weekly` (función `weeklySummary`), así que no hay ruta nueva:

- Conversaciones: `conversations` creadas en la ventana.
- Embudo (interesado / inscripción / inscripciones): `funnel()` sobre las oportunidades creadas en la ventana y sus eventos de etapa.
- Asistente respondió solo: `reply_log` (acción `replied` sin/con «Proveedor de IA:» = reglas/IA; `escalated` = persona).
- Respuesta mediana: `operation_events` de tipo `response`, `kind='first'` (tiempo de reloj, no descuenta horario laboral).

La ventana es de 7 días naturales y la anterior, de 7 a 14 días atrás; la zona horaria es la del panel (por omisión, hora del centro de México).

## Interfaz

`public/analytics.js`: la tarjeta (`weekCard`), el texto para copiar/descargar (`weekText`) y los renglones con su diferencia (`weekRows`); estilos en `public/analytics.css` (`.an-week…`). Sólo administración y asesores ven la analítica; cada asesor ve su propio alcance, igual que el resto del panel.

## Verificación

`test/analytics.test.mjs` («resumen de la semana, 7 días contra los 7 anteriores»): dos conversaciones esta semana contra una la anterior, un interesado y una venta, 80 % del asistente contra 50 %, y la mediana de la primera respuesta; la ventana mide 7 días. Revisión visual en el panel de Analítica, en computadora y celular.

## Lo que no hace

No añade dinero ($) para no dar por confirmada una venta de práctica, no cambia lo que ya mostraba la analítica y no manda el reporte por correo ni lo programa (se copia o se descarga a mano). Si hace falta, el envío automático se puede sumar después.
