# Plan: teléfono canónico (incremento I-1)

Estado: **construido el 13 nov 2026, sin publicar**. Migración con nombre `identity/0001-phone-key` (la escalera sigue en 41). No cambia ninguna pantalla.

## Para qué sirve

El mismo número llegaba escrito de muchas formas (`5512345678` capturado a mano, `+52 55 1234 5678` de un formulario, `5215512345678` de WhatsApp, `14155552671` del proveedor actual) y cada módulo lo comparaba a su manera. La persona capturada a mano o importada y la que escribe por WhatsApp no se reconocían como la misma. Ahora hay **una sola clave de teléfono** y todo el servidor compara con ella.

## La clave

- `contacts.phone_key`: sólo dígitos con código de país. México es `52` más diez dígitos, **sin el 1** que WhatsApp intercala (`525512345678`). Vacía si el contacto no tiene teléfono o lo escrito no es un teléfono.
- `contacts.phone` sigue guardando el teléfono **tal como se capturó**; nada lo reescribe.
- La calcula una sola biblioteca, `server/lib/identity-keys.mjs` (`canonicalPhone`, `phoneKey`). Para la columna: `phoneKey(telefono) ?? ''`. Para lo que entregan Meta o el proveedor (dígitos que ya son el número completo): `{ international: true }`.
- Índice `contacts_phone_key(brand_id, phone_key) WHERE phone_key != ''`. Es parcial: la consulta debe llevar también `AND phone_key != ''` para usarlo. La búsqueda es siempre por marca.
- La identidad de teléfono de una persona (`person_identities`, `persons.phone`) es el mismo valor con «+» delante (`'+' + phone_key`).
- La clave es **interna**: ninguna respuesta del servidor la lleva (`/api/crm` y la ficha del contacto la quitan) y la prueba fija las claves con las que cada ruta sirve un contacto. Es un dato personal igual que el teléfono: quien la exponga más adelante debe aplicarle la misma máscara.

## La migración `identity/0001-phone-key`

Sólo aditiva, dentro de la transacción del ejecutor y con el respaldo previo de siempre (`backups/before-…`).

1. Añade la columna (`TEXT NOT NULL DEFAULT ''`) y el índice.
2. Llena la clave de cada contacto con teléfono. Ni `phone` ni `updated_at` cambian.
3. Corrige lo que la normalización anterior escribía distinto: una identidad de persona `+521` más diez dígitos pasa a `+52` más diez dígitos. Si ese número **ya es de otra persona**, la identidad no se mueve y queda una candidatura («Mismo teléfono +52…») para que administración revise y fusione; si ya era de la misma persona, no se toca. `persons.phone` con esa forma se reescribe siempre (no es único), sin cambiar `revision` ni `updated_at`.

Repetir el cuerpo no cambia nada y, si alguna clave dejó de corresponder a su teléfono, la corrige. Medido en local: 7 000 contactos con sus personas, 0,1 s; 50 000, 0,7 s.

El índice no es único: al llenar la clave afloran los contactos repetidos que antes no se veían. Se revisan por marca en Contactos → Duplicados; para contarlos de una vez: `SELECT brand_id, phone_key, count(*) FROM contacts WHERE phone_key != '' GROUP BY brand_id, phone_key HAVING count(*) > 1`.

## Quién escribe y quién compara

| Sitio | Cómo quedó |
| --- | --- |
| `normalizePhone` (`persons-schema.mjs`) | Delega en `canonicalPhone`; misma firma, devuelve E.164 o `''`. La usan personas (`attach`, edición, visibilidad, búsqueda) e históricos |
| Alta y edición de contacto (`crm.mjs`) | Escriben `phone` y `phone_key` en la misma sentencia |
| Fusión de contactos (`contacts.mjs`) | El teléfono que se hereda llega con su clave |
| Duplicados por teléfono (`contacts.mjs`) | Agrupan por `phone_key` (antes, por los últimos diez dígitos) |
| Históricos de IPCIL (`legacy.mjs`) | El contacto nuevo nace con su clave |
| Entrante real de WhatsApp (`whatsapp.mjs`) | El contacto guarda el teléfono canónico (`+52…`) y su clave; `wa_peer` y `wa_identities` conservan el identificador tal como llegó, que es al que se contesta |
| Búsqueda de personas (`persons.mjs`) | Un teléfono completo se busca por su clave: `+521…` (como lo enseña la cabecera del chat) encuentra a la persona |

`test/identity-phone.test.mjs` incluye dos candados: falla si una sentencia del servidor escribe `contacts.phone` sin `phone_key`, y falla si cambia la lista de campos con la que se sirve un contacto (`/api/crm`, ficha, duplicados, persona, exportación, API pública y conector de Claude).

## Qué cambió en `normalizePhone`

Un teléfono bien escrito da lo mismo que antes. Cambia esto (la prueba compara la versión anterior con la nueva):

- `+521…` y `00 52 1…` ya no conservan el 1: dan `+52` más diez dígitos, igual que `521…` sin «+».
- Se reconocen un extranjero sin «+» (`14155552671`), `01` más diez dígitos y el número que una hoja de cálculo guardó con decimales.
- Dejan de aceptarse: texto con letras alrededor (`55 1234 5678 casa`, `tel:…`), un código de país que no existe y un número de México, Estados Unidos o Canadá que no tenga diez dígitos válidos después del código de país.

## Límites

- **No hay adopción todavía.** Quien se capturó a mano y después escribe por WhatsApp sigue naciendo como segundo contacto: quedan con la misma clave, aparecen en Duplicados y hay una candidatura de persona; se resuelven con la fusión de siempre. Mientras la candidatura esté pendiente, editar en Personas a la que nació por WhatsApp responde «Ese teléfono ya pertenece a otra persona» (así se comportaban ya los conflictos de teléfono). Al revés (primero WhatsApp, después la captura) el contacto nuevo se une solo a la persona. La adopción automática es el incremento I-2.
- `521…` y `52…` del mismo número siguen siendo dos clientes de WhatsApp si Meta entregara los dos identificadores (también I-2).
- Los contactos de WhatsApp anteriores conservan `+521…` en `phone` (su clave ya es la canónica); los nuevos guardan `+52…`. La cabecera del chat sigue mostrando el identificador de WhatsApp.
- Una identidad `+521…` que no se pudo mover (conflicto, o la persona ya tenía la canónica) se queda guardada; sólo la ve administración y ninguna búsqueda vuelve a producirla.
- Lo que no es un teléfono queda sin clave: no cuenta para duplicados ni une personas. Antes bastaban siete dígitos iguales para aparecer en Duplicados.
- No se recalcula la identidad de persona de contactos antiguos cuyo teléfono antes no se reconocía (extranjero sin «+»): se reclama cuando el contacto se vuelve a guardar.
- Diez dígitos sin «+» se leen como un número de México.
- Si se revierte el despliegue, el código anterior sigue funcionando (la columna tiene valor por omisión), pero el contacto que cree queda sin clave y el que edite, con la de antes, hasta que otra migración repita el relleno.
- Históricos: un alumno sin `id` se identifica por nombre, teléfono normalizado y correo; un archivo con `+521…` importado antes de este cambio se duplicaría al reimportarlo. No hay históricos importados en producción.
- No se tocaron: `phone10` de Aliados (valida diez dígitos de una academia, no de un cliente), la búsqueda por texto del conector de Claude y la de Contactos en el navegador.
