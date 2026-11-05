# Plan: etiquetas en la bandeja (Fase 5, bloque 6)

Estado: **implementado localmente** en la rama `feat/etiquetas-bandeja` (5 nov 2026, v0.34.0, **sin esquema nuevo**, 159 pruebas), **sin publicar**. Seguimiento natural del chat más rápido: las etiquetas de Contactos (por ejemplo «VIP», «Pidió beca», «Lista de espera») sólo se veían en la ficha del contacto; con muchas conversaciones, el equipo necesita verlas y filtrar por ellas desde la bandeja.

## Qué trae

1. **Etiquetas en cada hilo.** La bandeja muestra hasta dos etiquetas del contacto bajo el nombre de la marca (y «+N» si hay más). En el encabezado del chat se ven todas.
2. **Filtro por etiqueta.** Un selector «Todas las etiquetas» bajo los filtros de la bandeja (con el número de contactos de cada una; si se ven todas las marcas, indica la marca). Se combina con canal, marca, estado y búsqueda. Cambiar de marca limpia el filtro. Si todavía no hay etiquetas, el selector no aparece.
3. **Etiquetar desde el chat.** El botón **Etiquetas** de la fila del chat abre una ventana con las etiquetas de la marca (casillas) y un campo para crear una nueva al momento. Guarda con la misma API de Contactos, así que valen sus reglas (máximo 12 por contacto y 100 por marca).

## Cómo funciona

Sin migración: las etiquetas ya viven en `contact_tags` y `contact_tag_links`. `conversationPage` agrega al resultado, **sólo para el equipo**, `contact_id` y `tags` de cada hilo (una consulta por página) y acepta `tag=<id>`, que sólo coincide con etiquetas de **la marca de la conversación**. Un valor que no sea un identificador se ignora. El cliente no recibe `tags` ni `contact_id`, y el filtro no le sirve.

## Reglas de acceso

El alcance sigue siendo el de la bandeja: cada persona sólo ve hilos de sus marcas, así que una etiqueta de otra marca no abre hilos ajenos; administración ve todas. Etiquetar exige poder ver el contacto (misma regla que Contactos).

## Fuera de alcance (a propósito)

Filtrar por varias etiquetas a la vez o por «sin etiqueta», etiquetas automáticas por reglas (por ejemplo «llegó por anuncio»), colores editables desde el chat y etiquetar varios hilos de una vez. Cada uno es un bloque pequeño posterior.

## Criterios de salida

Prueba por API de etiquetas por hilo, filtro con alcance por marca, combinación con otros filtros, valor inválido ignorado y que el cliente no reciba nada; revisión en navegador local (chips, filtro, etiquetar desde el chat) en escritorio y 375 px con la auditoría de diseño; documentación y versión 0.34.0. **No se publica sin «Sí, publicar».**
