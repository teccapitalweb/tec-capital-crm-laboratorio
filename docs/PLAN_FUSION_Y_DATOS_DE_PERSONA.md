# Fusión interna de contactos y registro de datos de la persona (I-3a)

Incremento I-3a del plan maestro: el registro `personData` y `contacts.mergeInternal`. Sin esquema nuevo. Lo necesitan los atributos de contacto (N-1), las audiencias (D-2) y la importación: cada uno crea tablas nuevas ligadas al contacto que una fusión no debe dejar atrás.

## El problema que corrige

La fusión manual movía intereses, notas, etiquetas y consentimiento y después borraba el contacto absorbido. No movía pedidos, inscripciones, libro de ventas, certificados, históricos, invitaciones de encuesta ni destinatarios de campaña. Con las claves foráneas activas el borrado fallaba si el absorbido tenía alguno; con una tabla sin clave foránea, quedaban filas huérfanas sin aviso.

## Cómo funciona

- **`server/lib/person-data.mjs`.** `createPersonData({ db })` devuelve el registro. Cada servicio o módulo declara sus tablas con `register({ name, tables, merge, mergePerson?, export?, erase? })`. Un nombre se registra una vez y una tabla tiene un solo dueño. `merge(keepId, mergedId, ctx)` mueve las filas del contacto absorbido y devuelve `{tabla: filas}`; `mergePerson` hace lo mismo con `person_id` en la fusión de personas. `export` y `erase` quedan reservadas para el expediente y la supresión.
- **`contacts.mergeInternal(keepId, mergedId, { user, reason })`.** Componible: no abre transacción ni comprueba permisos. Aplica las reglas de siempre (misma marca, no dos perfiles, no dos intereses activos en el mismo curso y edición), hereda el consentimiento más restrictivo, completa teléfono y correo, llama a cada `merge` del registro, guarda la instantánea en `contact_merges` (con lo movido en `moved.linked`), deja la nota si hay quien fusiona, borra el absorbido y llama a `persons.afterContactMerge`. Si al final alguna tabla registrada sigue señalando al absorbido, lanza `merge_incomplete` y la transacción se deshace. Repetirla con un contacto ya absorbido devuelve la fusión anterior (`repeated: true`) sin escribir nada.
- **La fusión manual** (`POST /api/crm/contacts/merge`) conserva su vista previa y su comprobación de permisos y llama a `mergeInternal`. La vista previa añade `linked`: cuántas filas de las demás tablas registradas se moverán (también entra en la huella de la vista previa).
- **La fusión de personas** (`persons.applyMerge` y `afterContactMerge`) llama a `personData.mergePersons` antes de borrar la persona absorbida: certificados e históricos guardan `person_id` y antes impedían ese borrado.
- **Para los módulos nuevos**, `host.personData`. Un módulo registra sus tablas al crearse; no se edita `contacts.mjs` (no existe `setMergeHook`).

## Tablas registradas

| Dueño | Tablas | Al fusionar contactos |
| --- | --- | --- |
| `contacts` (en `contacts.mjs`) | `opportunities`, `internal_notes`, `contact_tag_links`, `contact_consent`, `contact_consent_events` | Se mueven; etiquetas sin repetir; el consentimiento del absorbido se borra tras heredar el más restrictivo |
| `persons` | `person_identities`, `person_consent_events` | Nada: van con la persona (las une `persons`) |
| `payments` | `orders`, `enrollments` | Se mueven |
| `finance` | `ledger_entries` | Se mueven |
| `certificates` | `certificates` | Se mueven; en fusión de personas, también `person_id` |
| `legacy` | `legacy_records` | Igual que certificados |
| `surveys` | `survey_invites` | Se mueven |
| `campaigns` | `campaign_recipients` | Se mueven; si los dos recibieron la misma campaña se conserva la fila del que queda |
| `attributes` (módulo, N-1) | `contact_attribute_values`, `contact_attribute_events`, `contact_attribute_requests` | Gana el valor del que queda; lo vacío se llena; historial y respuestas pasan ([PLAN_ATRIBUTOS_CONTACTO.md](PLAN_ATRIBUTOS_CONTACTO.md)) |

Los registros de los servicios que ya existían están en `registerExistingTables` (una declaración por servicio), para no tocar esos archivos.

## El candado

`test/person-data.test.mjs` arma el registro como el servidor (servicios actuales, contactos y los módulos de `server/modules/`) y falla si el esquema tiene una tabla con `contact_id` o `person_id` sin dueño. Las excepciones viven en `EXEMPT` con su motivo; hoy sólo `contact_search`, el índice de búsqueda de la lista de contactos que mantienen disparadores y se borra con el contacto. La misma prueba siembra una fila en cada tabla registrada para los dos contactos, fusiona y comprueba que nada señala al absorbido y que las claves foráneas hacia contactos y personas siguen íntegras: una tabla nueva registrada con `contact_id` debe añadir su fila de ejemplo.

## Fuera de este incremento

La pantalla de fusión nueva y sus casos límite (I-3b), la fusión automática cuando aparece el teléfono, el expediente y la supresión (`export`, `erase`, `scopeOf`) y las columnas `conversation_id`/`customer_id` en el candado.
