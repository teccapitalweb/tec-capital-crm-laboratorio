# Plan: respuestas rápidas más fáciles de crear y organizar

Estado: **publicado en `main`** (6 nov 2026, commit `24e10d0`; la biblioteca ampliada a 50 mensajes está en la rama `feat/biblioteca-consultora`, sin publicar), **sin esquema nuevo y sin cambio de versión**.

## Por qué

Las respuestas rápidas del chat (`/atajo`, v0.33.0) ayudan mucho, pero quien las organiza tenía que inventarlas desde cero en un formulario sencillo. Este bloque no crea un módulo aparte: mejora el panel que ya existe en **Mi configuración → Respuestas rápidas** para que armar y mantener la biblioteca cueste poco.

## Qué cambia

- **Ejemplos listos:** 50 respuestas de arranque a nivel consultora de cursos, en nueve grupos (Saludar, Descubrir, Informar, Objeciones, Inscripción, Pagos, Seguimiento, Alumnos, Cerrar); la lista completa y su criterio están en [BIBLIOTECA_RESPUESTAS_RAPIDAS.md](BIBLIOTECA_RESPUESTAS_RAPIDAS.md). Hay buscador, y se agregan una por una, por grupo o todas las que faltan, a «Mis respuestas» o, en administración, al equipo de una marca. Los atajos que ya existen se saltan y se cuentan. Ninguna lleva precios, fechas ni números: eso sale de las plantillas aprobadas y del catálogo.
- **Vista previa en vivo:** al escribir una respuesta se ve cómo le llegará al cliente, con datos de ejemplo (nombre, curso, marca y el primer nombre de quien la crea) y el contador de caracteres.
- **Atajo automático:** al ponerle nombre se sugiere el atajo (sin acentos, en minúsculas, cortado en palabra completa); se puede cambiar.
- **«¿Quién la usa?» con tarjetas** (sólo yo / equipo de una marca) en lugar de una lista desplegable.
- **Organizar:** búsqueda por atajo, nombre o texto, filtros Todas / Mías / Compartidas con su cuenta, **Duplicar** (crea una copia editable) y el texto con las variables resaltadas.
- **Primer uso:** si no hay ninguna, el panel invita a «Empezar con ejemplos».

## Cómo está hecho

`server/quickreplies.mjs` exporta `STARTER` y `GET /api/quick-replies` lo devuelve como `starter`. El resto es `public/quickreplies.js` y estilos `.qr-*` en `public/crm.css`. Agregar un ejemplo usa la misma ruta de siempre (`POST /api/quick-replies`, con `clientRef`), así que valida variables, atajo repetido y el máximo de 100 por dueño. Insertar en el chat sigue sin enviar nada.

## Límites

- Los ejemplos están en el código: cambiarlos o ampliarlos requiere una versión. Una biblioteca editable por la empresa sería un bloque aparte.
- No hay carpetas ni orden manual; se organiza con búsqueda y filtros.
- La vista previa usa datos de ejemplo, no los de una conversación real.
