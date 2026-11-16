# Bandeja nueva: vistas, filtros, contadores y búsqueda (B-I2)

Incremento 2 de la bandeja (diseño de bandeja §3.2–3.4 y §3.15; conciliación técnica, fila 1 —área de migraciones—, fila 9b —búsqueda e índices— y fila 12 —gramática de condiciones—). Se construye sobre el ciclo de vida (B-I1, [PLAN_CICLO_DE_VIDA.md](PLAN_CICLO_DE_VIDA.md)): las vistas leen su estado (`conversations.state`).

- Módulo del servidor: `server/modules/inbox/` (`module.mjs` y `repo.mjs`), rutas bajo `/api/inbox`.
- Migraciones con nombre, área `conversations` (la conciliación reserva `inbox` para la bandeja de webhooks): `conversations/0001-inbox-views` y `conversations/0002-inbox-indexes`.
- Pantalla: `public/screens/bandeja/`, **en vista previa** (`"visibility": "preview"`), grupo «Atención», para administración y asesores con `inbox.view`.
- Pruebas: `test/inbox-views.test.mjs` y el segundo caso de `test/ui/bandeja.spec.mjs` (escritorio y celular).

## Qué hace

La pantalla «Bandeja (nueva)» muestra a la izquierda las **vistas** con su **contador** (en celular, en una ventana que abre el botón «Vistas»), y a la derecha la lista de esa vista, de 40 en 40, con orden, **filtros** con el constructor común, **búsqueda** y las **vistas guardadas**. Cada fila trae nombre, canal (punto de color y nombre), marca y curso, vista previa del último mensaje, estado, quién atiende, «Sin respuesta», etiquetas y no leídos. **Abrir una fila lleva a la conversación en «Conversaciones»**, donde se responde como siempre: este incremento no rehace el hilo, el compositor ni el modelo de mensajes (eso es B-I6).

### Vistas del sistema

«Activas» = estado Abierta o Pendiente (módulo `lifecycle`).

| Clave | Nombre | Qué incluye | Orden natural |
| --- | --- | --- | --- |
| `mine` | Mías | Abiertas, pendientes o esperando primera respuesta, a mi cargo | Actividad |
| `unreplied` | Sin respuesta | Activas en las que la persona espera a alguien del equipo (`service_state.waiting_since`) | Espera más larga primero |
| `unassigned` | Sin asignar | Activas, fuera del asistente y sin responsable | Actividad |
| `unread` | No leídas | Con mensajes de la persona sin leer por el equipo (sin bloqueadas) | Actividad |
| `assistant` | Con el asistente | Activas que atiende el asistente | Actividad |
| `active` | Activas | Abiertas o pendientes | Actividad |
| `pending` | Pendientes | El equipo espera algo de la persona | Actividad |
| `solved` | Resueltas | Cerradas por el equipo | Actividad |
| `expired` | Expiradas | Se cerró la ventana sin resolverlas | Actividad |
| `lost` | Perdidas | Expiradas cuyo último ciclo quedó como perdido (`conversation_cycles.missed`) | Actividad |
| `all` | Todas | Todas menos las bloqueadas | Actividad |

Vista inicial: «Activas» para administración, «Mías» para asesores. La pantalla recuerda la vista, el filtro, el orden y la búsqueda mientras la sesión sigue abierta (`ctx.keep`), no en el navegador.

Órdenes (`sort`): `recent` (por omisión), `oldest` y `waiting` (sólo en «Sin respuesta»). La actividad es `conversations.updated_at`, que ya cambia con cada mensaje.

### Filtros

Gramática común de `server/lib/conditions.mjs` (forma canónica `{version, match, groups:[{match, rules:[{field, op, value}]}]}`; topes de 5 grupos, 8 condiciones y 50 valores). Un campo, un operador o un valor desconocidos responden **400 `invalid_conditions`**; nunca se ignoran.

| Campo | Operadores | Valor |
| --- | --- | --- |
| `state` | `eq`, `neq`, `in`, `not_in` | `open`, `pending`, `solved`, `expired`, `awaiting`, `blocked` |
| `assignee` | `eq`, `neq`, `in`, `not_in`, `empty`, `not_empty` | ids de personas o `me` (se cambia por quien consulta: una vista compartida «Mías…» sirve a cada quien) |
| `handler` | `eq`, `neq`, `in` | `assistant`, `person`, `queue` |
| `brand`, `course`, `edition`, `number` | `in`, `not_in` (`number` también `empty`) | ids |
| `channel` | `in`, `not_in` | `whatsapp`, `instagram`, `facebook` |
| `origin` | `eq`, `in`, `not_in` | `inbound`, `ad`, `broadcast`, `outbound`, `api`, `import`, `lab` |
| `tag` | `any`, `all`, `none`, `empty`, `not_empty` | etiquetas del contacto de la marca |
| `stage` | `any`, `none` | etapa comercial de la oportunidad ligada (la etapa sigue siendo de `opportunities`) |
| `priority` | `eq`, `in` | `normal`, `high`, `urgent` |
| `unread`, `waiting` | `is` | sí o no |
| `activity`, `created` | `after`, `before`, `between`, `in_last_days`, `not_in_last_days` | fecha o días |

Un filtro por otra marca no abre nada: el alcance por marca se aplica antes que cualquier filtro.

### Vistas guardadas

Tabla `inbox_views` (migración `conversations/0001-inbox-views`): nombre, vista de partida (`base`), filtro, orden y visibilidad.

- `visibility: "me"`: sólo la ve su dueño (ni administración). Con `brandId` vacío vale para todas sus marcas.
- `visibility: "all"`: la ve todo el equipo con acceso a su marca (`brandId` obligatorio). **Compartir exige el permiso `inbox.views.share`** en esa marca (hoy sólo administración lo tiene).
- Editar o borrar: el dueño las suyas personales; las compartidas, quien tenga `inbox.views.share` en su marca. Una persona sin permiso ve «Vista compartida por …» sin botones.
- `clientRef` obligatorio al crear: repetir la petición devuelve la misma vista (`200`, `duplicate: true`). Cambiar y borrar llevan `expectedRevision` (`409 stale_record` si otra persona la cambió); repetir el mismo cambio con la misma `clientRef` no choca.
- Borrar es archivar (`archived_at`); repetir el borrado responde `archived: true`.
- Topes: 30 vistas personales por persona y 50 compartidas por marca (`409 limit_reached`).
- Una vista compartida nunca amplía lo que alguien ve: su lista y su contador pasan por las marcas de quien la abre.

### Búsqueda

Un solo cuadro. `GET /api/inbox/search?brand=&q=` (de 2 a 100 caracteres; 60 por minuto por persona) devuelve hasta 40 conversaciones, sin repetir, en este orden:

1. **Personas**: palabras del nombre del contacto, sin acentos ni mayúsculas (`contact_search.name_key`), o teléfono. Quien no tiene `contacts.phone` en una marca sólo encuentra por los **cuatro últimos dígitos**, los que ya ve.
2. **Cursos**: el título contiene lo buscado.
3. **Mensajes**: el texto contiene lo buscado (sin acentos). Como todavía no existe el índice de texto de la Fase 0 (F0-14; la conciliación prohíbe que la bandeja cree el suyo), se revisan como mucho **los 50,000 mensajes más recientes** de todo el CRM; si hay más viejos, la respuesta dice `partial: true` y la pantalla lo avisa («en los mensajes más recientes»).

Cada resultado trae la fila de la lista y qué coincidió (`match.kind`: `contact`, `course` o `message`, con el texto).

## Rutas

| Método y ruta | Permiso | Entrada | Respuesta |
| --- | --- | --- | --- |
| `GET /api/inbox/views` | `inbox.view` | `brand` (opcional, `all` por omisión) | `{system, saved, shareBrands, limits, fields}` |
| `POST /api/inbox/views` | `inbox.view` (+ `inbox.views.share` si `visibility` es `all`) | `{name, brandId?, base, filter, sort, visibility, clientRef}` | `201 {view}` · `200 {view, duplicate}` |
| `PATCH /api/inbox/views/:id` | dueño; en compartidas, `inbox.views.share` | `{expectedRevision, clientRef?, name?, base?, filter?, sort?, visibility?, brandId?}` | `{view}` |
| `DELETE /api/inbox/views/:id` | igual | `{expectedRevision}` | `{archived: true}` |
| `GET /api/inbox/conversations` | `inbox.view` | `brand` (obligatorio: `all` o id), `view` (clave o `saved:<id>`), `filter` (JSON), `sort`, `cursor`, `limit` (40; máx. 100) | `{conversations, nextCursor, view, sort, total?}` (el total sólo en la primera página) |
| `GET /api/inbox/counts` | `inbox.view` | `brand`, `views=a,b,saved:<id>` (por omisión, todas las visibles) | `{counts: {clave: {n, capped}}, at}` |
| `GET /api/inbox/search` | `inbox.view` | `brand`, `q` | `{results: [{conversation, match}], partial}` |
| `GET /api/inbox/filters` | `inbox.view` | `brand` | `{brands, courses, tags, assignees, numbers}` de las marcas propias |

Errores: 401 sin sesión; **404 si la marca, la vista o la conversación no es visible** para quien pregunta (no se distingue de «no existe»); 403 si la ve pero le falta el permiso; 400 con `code` (`invalid_input`, `invalid_conditions`, `invalid_view`, `invalid_cursor`); 409 `stale_record` o `limit_reached`; 429 por límite de búsqueda.

El cursor de la lista va firmado y atado a la consulta que lo produjo (marca, vista, filtro y orden): uno escrito a mano o traído de otra vista responde `400 invalid_cursor`. La llave vive lo que vive el proceso: tras un reinicio, la pantalla vuelve a empezar la lista.

## Alcance por marca y visibilidad

Toda lista, contador, búsqueda y opción de filtro se calcula por cada marca en la que la persona tiene `inbox.view` (`host.access`), con una consulta por marca. Dentro de la marca, hoy cada quien ve todas las conversaciones (valor `all` del diseño §6.3, el único que existe); cuando lleguen los roles con visibilidad `team` y `own` (B-I9), su predicado se añade en el mismo punto del módulo y aplica a lista, contadores y búsqueda a la vez. Las pruebas comprueban que una persona de la marca A nunca ve, cuenta, busca ni filtra conversaciones de la marca B.

## Contadores y cómo se midieron

Cada contador es `SELECT count(*) FROM (SELECT 1 … LIMIT 10000)` por marca: **exacto hasta 9,999** y «9,999+» por encima (`capped: true`), de modo que el costo no crece con la historia.

Banco sintético (guion fuera del repositorio; base temporal con tres marcas, 8 mensajes por conversación, estados repartidos, cuatro asesores; Node 24.18 en la computadora de desarrollo; promedio de 20 repeticiones):

| Base | Las 11 vistas del sistema | Una página (40 filas, completas) | Buscar en mensajes | Buscar personas |
| --- | --- | --- | --- | --- |
| 6,000 conversaciones · 48,000 mensajes | 8.8 ms | 1.7–3.9 ms | 87 ms | 0.2 ms |
| 30,000 conversaciones · 240,000 mensajes | 31 ms | 1.7–15.6 ms | 89 ms (tope de 50,000 mensajes) | 0.2 ms |

Por eso la migración `conversations/0002-inbox-indexes` añade sólo dos índices, cada uno justificado por el banco:

- `messages_unread_customer` (parcial: mensajes de la persona sin leer): «No leídas» y su contador pasaron de 60 ms a 2 ms con 6,000 conversaciones.
- `conversations_inbox_handler (brand_id, state, bot_enabled, assigned_to)`: «Mías», «Sin asignar» y «Con el asistente» pasaron de 30 ms a 1 ms cada una con 30,000 conversaciones (las once vistas, de 117 ms a 31 ms).

Un índice por responsable (`brand_id, assigned_to, state`) se midió y se descartó: ganaba menos de 1 ms. Las vistas por estado usan el índice que ya existía (`conversations_state`). Una prueba (`EXPLAIN QUERY PLAN`) comprueba que «No leídas» usa `messages_unread_customer`; no se afirman tiempos en las pruebas.

## Tiempo real

El módulo tiene un reloj (cada 2 s; 200 ms en pruebas) que lee los números de orden de `messages` y `operation_events` (sólo claves primarias, sin datos de clientes) y emite `inbox.changed` con los ids de cada marca, sólo a quien puede ver esa marca. La pantalla escucha `inbox.changed`, `inbox.upsert` (cambios de estado del ciclo de vida) e `inbox.views` (vistas compartidas): tras 600 ms vuelve a pedir los contadores y, si sólo se ve la primera página, la lista; si ya se cargaron más páginas, ofrece «Actualizar la lista». Además pide los contadores cada 60 s.

## Archivos compartidos que se tocaron

- `server/migrations/registry.mjs`: una línea para el área `conversations` (al final, después de `chatflows`).
- `public/kit/screens.js`: `ctx.openConversation(id)`, que llama a `TC.host.openConversation`.
- `public/app.js`: `openConversation(id)` (cambia a «Conversaciones» y abre esa conversación con `selectConversation`) y su entrada en `window.TC.host`. Es la única forma de abrir una conversación concreta desde una pantalla nueva sin rehacer el hilo.

## Lo que queda para después

- **Hilo, compositor y acciones dentro de la bandeja nueva** (B-I6). Hoy se abre la vista de siempre.
- **Favoritas y Menciones** (`conversation_stars`, avisos de mención), **Objetivo en riesgo**, **Mis equipos**, **Por anuncio**, **Difusiones** (D-6) y **Últimas 24 horas**: vistas del diseño que dependen de piezas que no existen todavía o de otros incrementos.
- **Compartir con personas elegidas** (`selected`, tabla `inbox_view_shares`) y por equipo (`team`).
- **Preferencias por persona** (fijar, ordenar y ocultar vistas; recordar la última vista entre sesiones en `preferences.settings`).
- **No leídas por vista** («42 · 3 sin leer») y el selector de canal con contador.
- **Índice de texto** de mensajes (F0-14): la búsqueda de mensajes lo usará en cuanto exista y dejará de tener el tope de 50,000.
- **Visibilidad `team` y `own`** (roles, B-I9) y la máscara por rol más allá de `contacts.phone`.
- **Atajos de teclado** (§3.13), selección múltiple y acciones masivas (§3.12), enlaces profundos `/crm/c/<id>`.
- Columnas desnormalizadas de M-A (`activity_at`, `last_preview`, `unread_count`): hoy la vista previa y los no leídos se calculan por lote para la página (nunca una consulta por fila); el banco no mostró que hagan falta todavía.

## Preguntas para el dueño

1. ¿«Bandeja (nueva)» debe sustituir a «Conversaciones» cuando tenga su propio hilo (B-I6), o convivir un tiempo?
2. ¿Los asesores deben poder compartir vistas con su equipo, o sólo administración (hoy)?
3. ¿Qué vistas quieren ver primero en el menú de vistas? ¿Falta alguna que usen hoy en su herramienta actual?
4. ¿«Sin respuesta» debe contar también las conversaciones que lleva el asistente cuando la persona pidió hablar con alguien? (Hoy sólo cuenta las que esperan a una persona del equipo.)
