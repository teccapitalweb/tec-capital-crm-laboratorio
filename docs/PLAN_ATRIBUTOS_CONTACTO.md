# Atributos de contacto (N-1)

Campos propios de cada marca sobre sus contactos: ciudad, curso de interés, estado de seguimiento… Servidor y pruebas completos; la pantalla de administración está en **vista previa** (`SCREENS_PREVIEW=1`). Depende de [PLAN_FUSION_Y_DATOS_DE_PERSONA.md](PLAN_FUSION_Y_DATOS_DE_PERSONA.md) (I-3a).

## Datos (migración con nombre `attributes/0001-contact-attributes`)

| Tabla | Qué guarda |
| --- | --- |
| `contact_attributes` | Definiciones por marca: `key` inmutable (`^[a-z][a-z0-9_]{1,39}$`), `label`, `type`, `options`, `description`, `personal`, `searchable`, `show_in_chat`, `position`, `status` (activo o archivado), `revision`, `client_ref`. `UNIQUE(brand_id,key)` |
| `contact_attribute_values` | Un valor por contacto y atributo en forma canónica, con `value_num` (número, fecha en ms o sí/no como 1/0) para comparar en SQL |
| `contact_attribute_events` | Historial: quién cambió qué, de qué a qué, desde dónde |
| `contact_attribute_requests` | Respuesta de cada escritura por `clientRef`: un reintento no repite nada |

`type` no lleva `CHECK`: la lista se valida en código y un tipo nuevo no obliga a reconstruir la tabla. Las tres tablas con `contact_id` están registradas en `personData`.

## Tipos y límites

Texto (hasta 500 caracteres), número (decimal con punto), fecha (`AAAA-MM-DD`), lista (hasta 50 opciones) y sí/no. Un valor vacío borra; escribir el mismo valor no hace nada. Hasta 60 datos activos por marca y 50 cambios por petición. Un atributo se archiva, no se borra: sus valores se conservan y deja de aceptar escrituras. La clave y el tipo no cambian; una opción de lista que algún contacto tiene no se puede quitar. `personal` oculta el valor a quien no puede ver teléfono y correo completos, lo quita del evento de dominio y desactiva `searchable`; esa persona tampoco puede escribirlo (403 `permission_denied`, con o sin `expected`, para que el efecto de una escritura no sirva para adivinarlo) y en su lectura no ve ni la fecha ni el origen del valor ni sus cambios en el historial.

**Datos de sistema** (sólo lectura, de su tabla dueña): `nombre`, `telefono`, `correo`, `origen`, `creado`, `consentimiento`, `etiquetas` y, del interés comercial más reciente, `etapa` y `curso_interes`. Sus claves no se pueden usar para un atributo propio.

## Rutas (módulo `server/modules/attributes/`)

| Ruta | Permiso | Cuerpo → respuesta |
| --- | --- | --- |
| `GET /api/attributes?brand=&archived=1` | `contacts.view` | `{brands:[{brandId, brandName, canManage, active, definitions}], system, types, limits}`; sin `brand`, todas las marcas de la persona |
| `GET /api/attributes/:id` | `contacts.view` | `{definition}` |
| `POST /api/attributes` | `contacts.attributes.manage` | `{brandId, key, label, type, options?, description?, personal?, searchable?, showInChat?, clientRef}` → 201 `{definition}` (repetir el `clientRef` → 200 con la misma) |
| `PATCH /api/attributes/:id` | `contacts.attributes.manage` | `{label?, options?, description?, personal?, searchable?, showInChat?, position?, expectedRevision}` → `{definition}` |
| `POST /api/attributes/:id/archive` · `/restore` | `contacts.attributes.manage` | `{expectedRevision}` → `{definition}` (ya en ese estado: `unchanged: true`) |
| `GET /api/attributes/contacts/:id` | `contacts.view` | `{values, system, history}` (últimos 20 cambios) |
| `PUT /api/attributes/contacts/:id` | `contacts.edit` | `{changes:[{key, value, expected?}], clientRef}` → `{changed, values, system, history}` |

Errores con `code`: `attribute_invalid`, `attribute_unknown` (no existe o está archivado), `attribute_read_only` (de sistema), `attribute_exists`, `attribute_reserved`, `attribute_limit`, `attribute_option_in_use`, `stale_record` (revisión o `expected` distintos), `client_ref_conflict`, `permission_denied` (dato personal sin permiso de ver teléfono y correo completos). Una marca ajena responde 404, como el resto del CRM.

## Integración

- **Condiciones** (`server/lib/conditions.mjs`): `attributes.conditionFields(brandId, {alias})` devuelve la familia `attr` para combinar con los campos de quien llama (`defineFields([...mios, ...attributes.conditionFields(marca)])`). Un atributo es `{"field":"attr","key":"ciudad","op":"eq","value":"Puebla"}`. En memoria se evalúa sobre `attributes.record(marca, contacto)`; en SQL, sobre `contacts` con el alias dado (el módulo registra `cond_norm` en la conexión). Las pruebas comprueban que los dos dan el mismo resultado. Incluye los datos de sistema consultables (nombre, correo, origen, alta, consentimiento, etiquetas).
- **Variables** (`server/lib/variables.mjs`): `{{contacto.<clave>}}`, el único token que fija la conciliación técnica. `attributes.variableCatalogue(marca)` y `attributes.variableValues(marca, contacto)`; los cuatro sistemas actuales no cambian de firma.
- **Escritura componible**: `attributes.set(marca, contacto, cambios, {source, sourceId, actorId, conversationId, depth})`, sin transacción propia, para reglas, flujos e importación.
- **Eventos**: tipo `contacto.atributo_cambiado` (registrado con `events.registerTypes`, permiso de llave `contacts`), uno por cambio, con `dedupeKey` por renglón del historial; sin `from`/`to` si el dato es personal. Tiempo real: `attributes.changed` con `{kind: 'definitions' | 'values', …}`.
- **Fusión**: gana el valor del contacto que queda; lo que le falta se llena con el del absorbido; historial y respuestas guardadas pasan al que queda.

## Pantalla

`public/screens/atributos/` («Datos de contacto», grupo Gestión, sólo administración, vista previa): elegir marca, tabla de datos con su uso y estado, crear y editar en una ventana con validación, archivar con confirmación y restaurar, y la lista de datos de sistema. Prueba de navegador: `test/ui/atributos.spec.mjs` en computadora y celular.

## Fuera de este incremento

Importación por CSV y `ensure`, columnas y filtros por atributo en la lista de contactos, el botón «Datos» del chat, la ficha del contacto con sus valores, API pública, reglas y flujos, ordenar con subir y bajar, `replaceWith` al quitar una opción, y los tipos `datetime`, `multiselect` y `url` del diseño original.
