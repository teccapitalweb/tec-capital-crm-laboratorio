# Plan: chat más rápido (Fase 5, bloque 5)

Estado: **publicado en v0.33.0** (4 nov 2026, esquema 28, 158 pruebas). Pedido del usuario: «métele más cosas para facilitar» el trabajo en el chat. Lo que más usa un asesor de WhatsApp, Instagram o Facebook a diario es contestar rápido lo mismo de siempre y no olvidarse de retomar un chat; ninguna de las dos cosas tenía atajo.

## Qué trae

1. **Respuestas rápidas con «/».** En el compositor del chat se escribe `/` y el atajo (por ejemplo `/gracias`) y aparece un menú con las respuestas que coinciden; **Enter, Tab o un toque** insertan el texto en el compositor, con el nombre del cliente y el curso ya puestos. **Insertar no envía nada**: la persona lo revisa y lo envía por la ruta normal, que ya respeta la ventana de servicio y el canal. Flechas para moverse, Escape para cerrar. El botón **Respuestas** de la fila del chat abre el menú completo (útil en celular).
2. **Personales y de marca.** Cada persona del equipo tiene las suyas; administración puede crear respuestas **compartidas por marca** que ve todo el equipo con acceso a esa marca. Se administran en **Mi configuración → Respuestas rápidas** (crear, editar, archivar, ver cuántas veces se usó). Atajo de 2 a 20 caracteres, nombre corto y texto de hasta 1500 caracteres; hasta 100 por persona o marca. Archivar libera el atajo.
3. **Variables.** Sólo de conversación: `{{nombre}}`, `{{nombre_completo}}`, `{{curso}}`, `{{edicion}}`, `{{marca}}`, `{{asesor}}`. **No hay variables de precio, fecha ni cupo a propósito**: lo comercial sigue saliendo de las plantillas aprobadas y del catálogo vigente (botones Precio, Temario…), nunca de un texto escrito a mano. Una variable desconocida o una llave sin cerrar se rechaza al guardar.
4. **Recordarme.** El botón **Recordarme** del chat crea, en un clic, una tarea de seguimiento en la oportunidad de esa conversación (en 1 hora, hoy a las 6 p. m., mañana a las 9, en 3 días o en 1 semana, con una nota opcional) y aparece en **Mi día**. Usa la API de tareas que ya existe, así que respeta sus reglas (no se puede en una oportunidad ya ganada o perdida).

## Reglas de acceso

Sólo equipo (asesor o administración); cliente 403, sin sesión 401. Las personales son de quien las crea: nadie más las ve ni las usa, ni siquiera administración. Las de marca sólo las administra administración y sólo se usan en conversaciones de esa marca; una asesora no puede usar una respuesta de una marca en la conversación de otra. Para construir el texto se exige poder ver la conversación (misma regla que el resto del chat).

## Esquema 28 (aditivo, respaldo `before-crm-v28-*`)

`quick_replies(id, scope personal|brand, user_id | brand_id, shortcut, title, body, revision, uses, last_used_at, client_ref, archived_at, …)` con atajo único por persona o por marca entre las no archivadas.

## API

`GET /api/quick-replies` (las mías y las de mis marcas, con variables y marcas disponibles); `POST /api/quick-replies` (`clientRef` idempotente); `PATCH /api/quick-replies/:id` (`expectedRevision`); `DELETE /api/quick-replies/:id` (archiva); `POST /api/quick-replies/:id/render` {conversationId} → `{text}` (cuenta un uso; no envía).

## Arreglos de diseño que salieron de la revisión

El nombre del canal «WhatsApp» en el encabezado del chat medía 3,7:1 (verde del distintivo sobre blanco); ahora usa un tono más oscuro del mismo verde (5,5:1) y el distintivo no cambia. Los botones de la fila del chat medían 35 px en celular; ahora 40 px.

## Fuera de alcance (a propósito)

Respuestas con imágenes o adjuntos, atajos que envíen sin revisar, variables comerciales, etiquetas de conversación en la bandeja y filtro por etiqueta (siguiente bloque natural), mensajes programados y mensajes de ausencia o de bienvenida por marca.

## Criterios de salida

Migración 28 aditiva con respaldo previo; pruebas de permisos, validación, visibilidad, variables, revisiones, archivado y reutilización del atajo; revisión en navegador local (menú, teclado, botón, Recordarme y administración) en escritorio y 375 px con la auditoría de diseño; documentación y versión 0.33.0. Publicado por instrucción expresa del usuario.
