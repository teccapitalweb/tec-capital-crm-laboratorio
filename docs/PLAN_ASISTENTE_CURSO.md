# Asistente para dar de alta un curso

Estado: **implementado** (5 nov 2026, rama `feat/asistente-curso`, **sin esquema, sin servidor nuevo y sin versión nueva**: sólo interfaz del Catálogo).

Antes, dar de alta un curso completo obligaba a saltar entre pestañas: crear el curso, ir a Ediciones para ponerle precio y fecha (el curso nacía con una edición en borrador), y luego a Flyers para subir la imagen y aprobarla. El asistente lo hace en un solo flujo.

## Cómo se usa

**Catálogo y biblioteca → Cursos → Nuevo curso** (administración). Cuatro pasos:

1. **Curso:** marca, título y temario.
2. **Edición:** nombre, inicio y fin (en la zona horaria elegida), docente, modalidad, moneda, lugar, cupo, precio regular y precio por sesión (opcional). Valida lo mismo que el servidor: el precio por sesión no puede superar el regular, el cupo mínimo es 1, el final es posterior al inicio y la zona es válida.
3. **Imagen:** PNG, JPG, WEBP, GIF o PDF de hasta 4 MB, con vista previa. Se puede saltar.
4. **Revisar:** resumen, y tres decisiones: publicar la edición (sólo si la fecha de inicio es futura), confirmar que la imagen coincide con fecha, precio y edición, y aprobar la imagen (si la persona tiene permiso de aprobación; si no, queda como borrador).

«Atrás» conserva lo escrito. **No se guarda nada hasta el último paso**: cancelar no crea nada.

## Qué hace por dentro

Usa las mismas API de siempre, en este orden: crear curso (que trae su edición inicial en borrador), guardar la edición con su precio y estado final, subir el archivo, crear el flyer y aprobarlo. La edición se guarda **antes** que el flyer porque la aprobación exige que los datos de la pieza coincidan con los de la edición. Por eso valen todas las reglas del Catálogo (alcance por marca, flyer con revisión y aprobación, cambios de precio sólo en la edición).

Cada paso se anota: si algo falla a la mitad (por ejemplo, la red), el mensaje dice qué quedó creado y **«Crear curso» continúa donde se quedó sin duplicar el curso**. Lo que ya se creó se puede completar desde las pestañas Cursos, Ediciones y Flyers.

Archivos: `public/coursewizard.js` (el asistente), estilos `.wz-*` en `public/catalogue.css`, enlazado en `catalogue.js`, `index.html` y `server/index.mjs`.

## Fuera de alcance

Promociones (se crean aparte en su pestaña), varias ediciones o varios flyers a la vez, y publicar sin fecha futura (la edición queda como borrador y la pantalla lo explica).

## Criterios de salida (cumplidos)

En el demo local: curso con imagen, edición publicada y flyer aprobado «Listo para enviar» (con la imagen visible en la tarjeta del curso); curso sin fecha ni imagen que queda como borrador; precio por sesión mayor que el regular bloqueado en el paso 2; formato no admitido rechazado; sin desbordamiento a 375 px, letra mínima de 11 px y controles de 40 px. 160 pruebas y comprobación de que el archivo nuevo se sirve.
