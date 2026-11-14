# Plan: contactos a escala (incremento B-I3a)

Estado: **construido en la rama de integración, sin publicar**. Migración con nombre `contacts/0001-search` (la escalera sigue en 41). La pantalla nueva nace en vista previa: sólo aparece con `SCREENS_PREVIEW=1`. La vista «Contactos» de siempre no cambia.

## Qué hace

Una lista de contactos que aguanta miles de filas: el servidor busca, filtra, ordena, cuenta y entrega de 50 en 50 con un cursor. La pantalla `contactos` (menú Atención → «Lista de contactos») usa el kit: búsqueda con espera, chips de filtros rápidos, constructor de filtros con la gramática común, tabla con columnas elegibles y «Cargar más», panel del contacto y, en celular, tarjetas y panel a pantalla completa. **Sólo lectura**: crear y editar siguen en la vista actual (el panel lleva «Editar en Contactos»).

## Rutas (módulo `server/modules/directory/`, prefijo `/api/contacts`)

| Ruta | Respuesta |
| --- | --- |
| `GET /api/contacts?brand=all\|<marca>&q=&quick=&filter=&sort=&dir=&cursor=&limit=` | `{contacts:[fila], nextCursor, sort:{by,dir}, total?:{n,capped}}`; `total` sólo en la primera página, exacto hasta 10 000 |
| `GET /api/contacts?brand=…&ids=a,b` (con los mismos `q`, `quick`, `filter`) | `{contacts:[fila]}`: las filas que siguen cumpliendo; las que faltan se quitan de la lista |
| `GET /api/contacts/filters?brand=…` | `{brands, tags, courses, owners, sources, quick}` para el constructor |
| `GET /api/contacts/<id>` | `{contact, consent:{status,source,note,updatedAt,history}, opportunities, conversation, conversations}` |

Una fila: `{id, brandId, brandName, name, phone, phoneMasked, labNumber, email, source, createdAt, activityAt, consent, tags:[{id,name,color}], interests:{total,active}, latest:{stage,course,owner}|null}`.

- `brand` es obligatorio (`all` = las marcas de la persona con `contacts.view`). `sort`: `activity` (por omisión, descendente), `name` (ascendente) o `created`. `limit` de 1 a 50.
- `q`: si sólo lleva dígitos y signos de teléfono (al menos cuatro dígitos) se busca por `phone_key` (completo o un tramo); si no, por palabras en el nombre y el correo, sin acentos ni mayúsculas.
- `quick`: `with_phone`, `opted_in`, `active`, `recent` (alta en 30 días), `mine` (responsable de un interés).
- `filter`: la forma canónica de `server/lib/conditions.mjs`, ámbito contacto: `name`, `email`, `has_phone`, `brand`, `source`, `consent`, `tag`, `stage`, `owner`, `course`, `active_interest`, `created`, `activity`. Una definición mala responde 400 `invalid_conditions` con `details.problems`.
- El cursor lleva el último valor de orden y el id, va atado a la búsqueda y firmado: uno cambiado, de otro orden o de otra búsqueda responde 400 `invalid_cursor` (la pantalla vuelve a empezar la lista).
- `GET /api/crm?parts=opportunities,tasks,…` devuelve sólo esas partes (`contacts`, `opportunities`, `tasks`, `members`, `preferences`); sin `parts`, lo de siempre.

## Permisos y alcance

Cada ruta pasa por `host.access.require(user, 'contacts.view', marca)`: sin el permiso, 403; una marca ajena, 404. Cada consulta va acotada por marca. El teléfono pasa por `host.access.phone` y el correo se enmascara igual cuando falta `contacts.phone`; sin ese permiso, la búsqueda por teléfono sólo compara los cuatro últimos dígitos. `phone_key` nunca sale del servidor.

## Datos

`contacts/0001-search` (después de `identity/0001-phone-key`) crea `contact_search` (una fila por contacto: clave sin acentos de nombre y correo, alta, última actividad y número de cambio) con un índice por marca para cada orden, e `opportunities_contact`. La mantienen disparadores que sólo usan funciones de SQLite (alta, edición y baja del contacto; etiquetas; consentimiento; intereses; conversaciones), así que ningún módulo actual tiene que acordarse de ella. La clave de búsqueda es la misma en SQL y en JavaScript (`server/lib/search-key.mjs`). La última actividad es la fecha más reciente entre el contacto, sus intereses y sus conversaciones.

**En vivo:** un reloj del módulo lee el número de cambio y emite `contacts.changed` (`{ids}`, sin datos personales) a quien ve cada marca; la pantalla vuelve a pedir sólo esas filas y avisa si cambiaron contactos que no están a la vista.

Medido en las pruebas: 5 000 contactos, una página en unas decenas de milisegundos por HTTP; cada orden lee su índice desde el cursor (comparación de pares), sin ordenar en memoria.

## Límites y lo que falta

- La búsqueda por palabras recorre el índice de la marca (sin índice de texto completo); con decenas de miles de contactos por marca conviene `contact_search_fts` (trigramas).
- No hay `columns=`: cada página calcula siempre etiquetas, intereses y consentimiento (tres consultas por página).
- La tabla de letras sin acento es fija; cambiarla exige otra migración que rehaga claves y disparadores. Un nombre guardado con letra y acento separados no se junta en SQL.
- Un aviso en vivo actualiza la fila donde está; si cambió el orden, la pantalla lo dice y ofrece «Actualizar la lista». Un contacto fusionado desaparece en el siguiente aviso de su fila o al recargar.
- La posición se recuerda dentro de la primera página; volver no recarga las páginas siguientes.
- Fuera de este incremento: crear y editar aquí, atributos personalizados, importación, edición en lote, línea de tiempo, archivar y fusionar, y responsable de cabecera del contacto (hoy «responsable» es el de sus intereses).
