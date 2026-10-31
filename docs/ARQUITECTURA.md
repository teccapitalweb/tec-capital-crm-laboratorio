# Arquitectura y contratos del CRM

Referencia: código funcional v0.5.0 (esquema 6) más el bloque local 4A (esquemas 7 y 8, sin publicar; ver [PLAN_FASE_4.md](PLAN_FASE_4.md)). Complementa [CONTINUIDAD.md](CONTINUIDAD.md). Las tablas y rutas siguientes describen lo implementado; las propuestas futuras están separadas en [PLAN_FASE_4.md](PLAN_FASE_4.md).

## Sistema en una vista

```text
Cliente de laboratorio (/)          Equipo (/crm)
          └───────────────┬───────────────┘
                 HTML / CSS / JS
             HTTP JSON + /realtime (WS)
                         │
                  server/index.mjs
        ┌───────────────┼────────────────┐
        CRM/seguimiento   Catálogo       Operación
        contactos/tareas  ofertas        reparto/macros/SLA
        └───────────────┼────────────────┘
                 SQLite + archivos
                         │
                Volumen Railway /data
```

Un proceso Node.js 24 atiende HTTP, WebSocket, reglas y reconciliación operativa. No hay frontend compilado, React, Next, ORM, Redis, PostgreSQL, proveedor de IA ni SDK de Meta. Las dependencias de ejecución son `ws` y `lucide`; SQLite viene de `node:sqlite`. El repositorio se marca `private: true` en npm para evitar publicación accidental del paquete, aunque GitHub es público.

## Mapa de código

| Archivo | Responsabilidad y puntos a conservar |
| --- | --- |
| `server/index.mjs` | Arranque/migraciones, autenticación, sesiones, HTTP, adjuntos, chat, eventos WS, reglas por curso, temporizadores y rutas heredadas |
| `server/database.mjs` | SQLite, esquema inicial, ampliación de catálogo demo hasta v2 y helper síncrono `transaction()` |
| `server/demo-catalog.mjs` | Metadatos y correspondencia de los seis flyers incluidos |
| `server/crm.mjs` | Esquema v3, marcas autorizadas, invitaciones, recuperación, perfiles, contactos y creación de oportunidades/tareas; integra seguimiento |
| `server/followup.mjs` | Esquema v4, etapas, revisiones, historial comercial y edición de tareas; evita regresión automática de etapa |
| `server/conversations.mjs` | Búsqueda histórica con permisos, normalización de acentos y paginación por cursor |
| `server/catalogue-schema.mjs` | Esquema v5, ediciones heredadas, biblioteca, ofertas históricas y plantillas iniciales |
| `server/catalogue.mjs` | Validación de cursos/ediciones/promociones, aprobación, vistas previas y envío de material vigente |
| `server/operations-schema.mjs` | Esquema v6, configuración, estado de atención, transferencias, avisos, macros e idempotencia |
| `server/service-hours.mjs` | Validación del calendario IANA y cálculo de minutos hábiles sobre instantes reales |
| `server/operations.mjs` | Cola, elegibilidad, capacidad, reparto, transferencias, SLA, notas/menciones y macros atómicas |
| `server/automation-schema.mjs` | Esquema v7: ajustes por marca, pausa global, pasos durables, trazas y columnas de reintento en `jobs` |
| `server/automation.mjs` | Motor de pasos diferidos (arrendamientos, reintentos, cancelación, idempotencia, pausas) y rutas `/api/automation` |
| `server/analytics.mjs` | Métricas comerciales agregadas por marca autorizada: embudo por cohorte, resultados, atención humana, tendencia, equipo (privacidad por asesor) |
| `server/contacts-schema.mjs`, `server/contacts.mjs` | Esquema v9 y lógica de etiquetas, duplicados, fusión con vista previa y exportación CSV; rutas bajo `/api/crm` (se atienden antes que `crm.mjs`) |
| `server/backup.mjs`, `server/verify-backup.mjs` | Respaldos automáticos verificados con manifiesto, rotación, verificación de respaldos y rutas `/api/backups` |
| `server/catalogue-import.mjs` | Importación CSV de cursos, ediciones y promociones: análisis sin escritura y aplicación por las rutas del catálogo |
| `server/recipes.mjs` | Recetas de seguimiento (4B): definición validada, versiones, barrido de disparadores, manejador `recipe.run`, simulación y rutas `/api/automation/recipes` |
| `public/analytics.js`, `public/analytics.css` | Pantalla Analítica (KPIs, embudo, gráfica SVG, tablas) |
| `public/contacts.js` | Etiquetas, filtro, duplicados, fusión y exportación dentro de Contactos |
| `public/catalogue-import.js` | Modal «Importar CSV» del catálogo: plantilla, vista previa y resultado por fila |
| `public/recipes.js`, `public/recipes.css` | Pestaña Seguimientos (administración): recetas, simulación, ejecuciones y activación por marca; la monta `operations.js` |
| `public/index.html` | Entrada compartida; carga iconos, módulos CRM/catálogo/operación y finalmente `app.js` |
| `public/app.js`, `public/styles.css` | Estado general, autenticación, navegación, bandeja, chat, WS, adjuntos y estilo Niebla |
| `public/crm.js`, `public/crm.css` | Mi día, contactos, oportunidades, tareas, equipo y preferencias |
| `public/catalogue.js`, `public/catalogue.css` | Cinco apartados del catálogo y biblioteca dentro del chat |
| `public/operations.js`, `public/operations.css` | Cola, avisos, horarios/reparto, macros y panel Equipo de la conversación |
| `public/flyers/` | Seis imágenes demo incluidas; la aplicación las sirve mediante rutas autenticadas |
| `test/*.test.mjs` | Pruebas Node con servidores y bases temporales; revisar como ejemplos ejecutables de los contratos |
| `.github/workflows/verify.yml` | CI en Node 24: instalar, comprobar sintaxis y ejecutar pruebas |
| `Dockerfile`, `railway.json` | Despliegue y volumen; existe una diferencia de builder con la configuración visible del servicio, descrita en el runbook |

Los archivos son deliberadamente sencillos, con bastante código compacto. Antes de modificar un flujo, busca sus usos en servidor y navegador. Extraer módulos gradualmente es razonable; cambiar todo el stack no es un requisito del siguiente bloque.

## Persistencia y migraciones

`DATA_DIR` contiene `laboratorio.sqlite`, `uploads/`, `library/` y `backups/`. SQLite usa WAL, claves foráneas y `busy_timeout=5000`. Los adjuntos de mensajes viven en `uploads/`; las piezas propias del catálogo, en `library/`. Los originales demo siguen en el repositorio.

En el arranque se ejecutan `openDatabase`, `migrateCRM`, `migrateFollowup`, `migrateCatalogue` y `migrateOperations`. Si hay usuarios y el esquema es menor que 11, el arranque actual crea antes una copia consistente `backups/before-crm-v11-<timestamp>.sqlite` (hasta v0.5.0 era `before-crm-v6-`) con `VACUUM INTO`. Los prefijos v3/v4/v5 citados en entregas anteriores corresponden al código de aquellas versiones. No se hace un respaldo nuevo en cada arranque de una base ya en v6.

| Versión de esquema | Incorporación |
| --- | --- |
| 1–2 | Usuarios, sesiones, marcas, cursos, conversaciones, mensajes, adjuntos, trabajos de reglas, auditoría y seis cursos/flyers demo |
| 3 | Permisos por marca, invitaciones, recuperación, preferencias, contactos, oportunidades, tareas y notas |
| 4 | Revisiones e historial comercial; importación del historial de etapas disponible |
| 5 | Ediciones, promociones, archivos de biblioteca, flyers, plantillas, versiones y snapshots de oferta |
| 11 | Festivos por marca: `operation_settings.holidays` |
| 10 | Consentimiento: `contact_consent`, `contact_consent_events` |
| 9 | Contactos: `contact_tags`, `contact_tag_links`, `contact_merges` |
| 8 | Recetas (4B): `automation_recipes`, `automation_recipe_versions`, `automation_runs` |
| 7 | Automatización durable (4A): `automation_settings`, `automation_global`, `automation_steps`, `automation_events`; `jobs.attempts/next_attempt_at/last_error` |
| 6 | Horarios/reparto, capacidad, objetivos de respuesta, transferencias, avisos, macros y sus ejecuciones |

Una migración publicada debe permanecer reproducible. Para el siguiente cambio estructural añade v7, con actualización desde v6, arranque repetido y persistencia tras reinicio. No borres/recrees tablas para incorporar una función. El helper de transacción usa `BEGIN IMMEDIATE`; no admite composición anidada ni espera asíncrona segura.

## Modelo de datos

### Identidad y alcance

- `users`: perfil, nombre/usuario, identificador de prueba, contraseña derivada, rol `customer`, `agent` o `admin`, y suspensión.
- `sessions`: hash de token, usuario y vencimiento. No se almacena el token de cookie en claro.
- `brand_members`: relación usuario–marca. Las consultas deben comprobar permisos actuales, incluso después de revocaciones.
- `team_invites`: hash del código, usuario exacto, marcas, vigencia, uso y revocación. Un uso y 24 horas.
- `recovery_tokens`: recuperación asistida individual, hash, vencimiento de 30 minutos y uso. No recupera administradores desde la interfaz.
- `preferences`: firma y disponibilidad `available`/`away`. Disponibilidad no equivale a presencia conectada.

### Contacto, interés y conversación

```text
marca ── contacto ── oportunidad (curso + edición)
                         │
                  conversation_opportunities
                         │
                una o varias conversaciones
                         │
                     mensajes
```

Un contacto pertenece a una marca; puede vincularse a un perfil mediante `source_user_id` o ser manual. Una persona que interesa a distintas marcas no implica acceso cruzado a sus fichas.

- `opportunities`: etapa comercial, responsable, curso/edición, motivo de pérdida, revisión y última oferta compartida. Hay como máximo un interés activo por contacto/curso/edición. Ganada/perdida son cierres de prueba.
- `conversation_opportunities`: cada conversación enlaza una oportunidad; una oportunidad puede reunir chats de varios canales.
- `conversations`: cliente, marca, curso/edición, canal, modo de atención, estado, responsable y marcas de lectura. El campo heredado `stage` no vuelve a ser la autoridad comercial.
- `messages`: secuencia para paginar, UUID, emisor, texto, adjunto, referencia idempotente y snapshots de flyer/oferta.
- `attachments`: metadatos y archivo protegido por el acceso a su conversación.
- `tasks`: oportunidad/marca, título, responsable, vencimiento, revisión y estado `open`, `done` o `cancelled`.
- `internal_notes`: contacto/marca/autor/texto. No forman parte de los mensajes del cliente.
- `crm_events`: historial por oportunidad con autor, tipo, detalles y secuencia. Conserva los eventos importables de `opportunity_events`; no inventa cambios de tareas anteriores a v0.3.

Cerrar una oportunidad cancela tareas abiertas. Cerrar un chat es una acción diferente. Cambiar el responsable de una oportunidad afecta sus chats abiertos y tareas según las reglas compartidas; no lo resuelvas modificando sólo una columna de conversación.

### Catálogo y oferta

- `courses`: contenido general del curso. Sus campos antiguos de fecha/precio se conservan por compatibilidad.
- `editions`: curso/marca, nombre, inicio/fin, zona IANA, docente, modalidad, ubicación, enlace, precio entero en centavos, moneda, cupos informativos, estado y revisión. Las ediciones heredadas usan `edition-<courseId>`.
- `promotions`: edición/marca, nombre, precio, inicio/fin, estado y revisión. No puede solaparse otra promoción publicada de esa edición ni terminar después del inicio del curso.
- `library_files`: archivo inmutable por UUID, nombre de almacenamiento o `builtin_id`, MIME, tamaño, autor y fecha.
- `flyers`: marca/curso/edición/promoción opcional, archivo, canal, vencimiento, aprobación, revisión y correspondencia comercial guardada en `binding`.
- `content_templates`: alcance por marca/curso/edición/canal, escenario, cuerpo, flyer opcional, estado y revisión.
- `catalogue_events`: versión/snapshot de cada entidad, acción, autor y secuencia.

`messages.commercial_snapshot` conserva la oferta al enviar. `flyer_snapshot` identifica los bytes históricos. `opportunities.offer_snapshot` permite consultar la última oferta del interés. Editar el catálogo nunca debe reescribir esos mensajes.

El precio válido se calcula al preparar y al enviar. Un flyer estático aprobado deja de corresponder si cambia su curso/edición/promoción; también se valida caducidad. La revisión visual del texto dentro de una imagen es humana: no hay OCR. Si no hay flyer válido para respuestas automáticas, existe una ficha SVG de respaldo con los datos actuales.

Variables de plantilla implementadas: `nombre`, `marca`, `curso`, `edicion`, `fecha`, `docente`, `modalidad`, `precio`, `precio_regular`, `promocion`, `vigencia`, `temario`, `enlace`, `cupo`, mediante `{{variable}}`. Las variables desconocidas se rechazan. Un precio escrito literalmente en una plantilla no se convierte automáticamente en variable: revisar su coherencia al aprobar.

### Operación

| Tabla | Datos centrales |
| --- | --- |
| `operation_settings` | Una política por marca: reparto/SLA habilitados, zona, semana de horarios, miembros, objetivos 30/60 minutos iniciales, revisión |
| `routing_limits` | Capacidad global por usuario, inicialmente ocho chats abiertos; revisión |
| `service_state` | Una fila por chat: prioridad, comienzo de espera, primera respuesta humana, vencimiento, snapshot de política, revisión y último responsable |
| `operation_events` | Historial de operación/configuración con marca, conversación opcional, autor y secuencia |
| `transfers` | Origen/destino/contexto, solicitante, estado, decisión y vencimiento; sólo una pendiente por chat |
| `notifications` | Destinatario, marca/chat, tipo, título, lectura y clave de evento; deduplicación por usuario/evento |
| `macros` y `macro_versions` | Acciones manuales configuradas, activación y versiones inmutables |
| `operation_requests` | Resultado por actor y `client_ref`, tipo y destino; permite repetir una petición sin duplicar sus efectos |

Los importes se almacenan como centavos enteros. Los instantes se guardan como milisegundos UTC; los horarios laborales se interpretan con la zona IANA de la marca. No uses la zona del dispositivo para interpretar fechas de una edición al guardar.

## Contratos HTTP

Todas las rutas `/api` salvo health y autenticación inicial requieren sesión. Las mutaciones exigen `Origin` permitido. El cuerpo es JSON, también para adjuntos en base64. Para el payload exacto y respuestas usa los formularios actuales y las pruebas, no supongas una API REST genérica.

| Grupo | Rutas actuales |
| --- | --- |
| Acceso | `POST /api/auth/register`, `/login`, `/recover`, `/logout`; `GET /api/bootstrap` |
| Perfil | `POST /api/profile`, `/api/password`, `/api/team/accept` |
| Equipo | `GET /api/team`; `POST /api/team/invites`, `/api/team/recovery`; `DELETE /api/team/invites/:id`; `PATCH /api/team/members/:id` |
| Contactos | `GET /api/crm`; `POST /api/crm/contacts`; `GET/PATCH /api/crm/contacts/:id`; `POST /api/crm/contacts/:id/notes` |
| Seguimiento | `POST /api/crm/opportunities`, `/api/crm/tasks`; `PATCH` por `/:id`; `GET /api/crm/opportunities/:id/history` |
| Conversaciones | `GET/POST /api/conversations`; `GET /api/conversations/:id`; `GET/POST /api/conversations/:id/messages`; `POST /api/conversations/:id/read`, `/action`, `/template` |
| Archivos | `GET /api/files/:id`, `/api/messages/:id/flyer`, `/api/courses/:id/flyer`, `/api/library/files/:id` |
| Consulta comercial | `GET /api/courses/:id/editions`; `GET /api/catalogue`; `GET /api/conversations/:id/materials` |
| Material al chat | `POST /api/conversations/:id/materials/preview` y `/materials/send` |
| Edición del catálogo | `POST /api/catalogue/files`, `/preview`; `POST /api/catalogue/{courses,editions,promotions,flyers,templates}` y `PATCH` por `/:id` |
| Estado/versiones | `POST /api/catalogue/{entidades}/:id/archive`; `/approve` para flyers/plantillas; `GET /api/catalogue/{course,edition,promotion,flyer,template}/:id/history` |
| Cola/avisos | `GET /api/operations/queue`, `/notifications`; `POST /api/operations/notifications/read` |
| Política/capacidad | `GET/PATCH /api/operations/brands/:id`; `GET /api/operations/brands/:id/history`; `PATCH /api/operations/members/:id/limit` |
| Contexto de chat | `GET /api/operations/conversations/:id` y `/history` |
| Acciones de atención | `POST /api/operations/conversations/:id/{take,release,priority,notes,transfer,macro-preview,macro-run}` |
| Transferencias | `POST /api/operations/transfers/:id/{accept,decline,cancel}` |
| Macros | `GET/POST /api/operations/macros`; `PATCH /api/operations/macros/:id`; `GET /api/operations/macros/:id/history` |
| Automatización (admin) | `GET /api/automation`, `/steps`, `/steps/:id/events`; `POST /steps/:id/retry|cancel`; `PATCH /brands/:id`, `/global` |
| Consentimiento | `GET/PUT /api/crm/contacts/:id/consent` (reactivar una baja: administración con motivo) |
| Analítica | `GET /api/analytics?days=&brand=&tz=` |
| Etiquetas y contactos | `GET/POST /api/crm/tags`; `PATCH/DELETE /api/crm/tags/:id` (admin); `PUT /api/crm/contacts/:id/tags`; `GET /api/crm/duplicates?brand=`; `POST /api/crm/contacts/merge-preview`, `/merge` (admin); `GET /api/crm/export/contacts.csv`, `/opportunities.csv` (admin) |
| Respaldos (admin) | `GET /api/backups`; `POST /api/backups/run` |
| Importación (admin) | `GET /api/catalogue/import/template`; `POST /api/catalogue/import/preview`, `/apply` |
| Recetas (admin) | `GET/POST /api/automation/recipes`; `GET/PATCH /recipes/:id`; `POST /recipes/:id/publish|pause|simulate`; `GET /recipes/:id/history|runs` |
| Compatibilidad y métricas | `POST /api/brands`, `/api/catalog`; `GET /api/metrics` |
| Disponibilidad | `GET /api/health`, público; consulta básica de DB, no diagnóstico completo |

En esta tabla, las alternativas entre llaves son segmentos concretos, no una cadena literal. Las abreviaturas `/login`, `/read`, etc. conservan el prefijo de su fila.

### Paginación y conflictos

- Bandeja: páginas de 50, cursor por `updated_at` e identificador; búsqueda normalizada en servidor, incluido texto antiguo. Bootstrap sólo resume 300 chats.
- Mensajes: páginas de 150 con `before` por secuencia; búsqueda dentro de un chat, páginas de 50.
- Historial comercial/operativo: cursor por secuencia. Avisos: cursor por fecha **y** identificador para no omitir eventos con la misma fecha.
- Cola: páginas de 50 mediante `offset`; parte del filtrado todavía se hace en memoria. No equivale a escalabilidad comprobada.
- `expectedRevision` protege ediciones concurrentes de catálogo/operación. Seguimiento antiguo conserva compatibilidad con peticiones sin revisión; la interfaz actual sí la envía. No afirmes que todos los endpoints la exigen.
- `clientRef` se reutiliza al reintentar la misma acción. En las acciones nuevas tiene 16–100 caracteres alfanuméricos o guiones. Reutilizarla para otra acción/destino debe producir conflicto.
- `previewToken` representa los datos examinados. Si cambian la oferta, macro, conversación o responsabilidad relevantes, se debe previsualizar de nuevo.
- Estados habituales: 400 validación, 401 sin sesión, 403 rol no autorizado, 404 recurso no visible, 409 revisión/estado en conflicto, 429 límite de solicitudes.

Atención: `GET /api/operations/queue` llama a reconciliación. Si el reparto está activo, consultar la cola puede asignar trabajo; no es una lectura sin efectos operativos.

## Eventos, reglas y operación concurrente

Los mensajes se persisten por HTTP; WebSocket en `/realtime` comunica cambios, presencia, escritura y actualizaciones. El navegador vuelve a consultar el estado autorizado. No sustituyas el control en servidor por filtros visuales.

Cuatro temporizadores viven en el proceso (el cuarto, `automation.tick`, cada segundo, no hace nada mientras ninguna marca tenga automatización habilitada):

1. Trabajos de reglas cada 350 ms, hasta 15 vencidos por pasada. Una entrada del cliente suele programar una respuesta unos 700 ms después. `jobs` es durable, y desde 4A reintenta con espera creciente y se cancela tras 5 fallos (`legacy_job_abandoned`); los pasos nuevos usan el motor de `automation.mjs`.
2. Reconciliación operativa cada segundo. Usa configuración y estado persistidos para reparto, vencimientos y avisos.
3. Heartbeat y limpieza de sesiones/límites cada 30 segundos. Una conexión TCP abierta no basta: se comprueba la sesión vigente.

El reparto requiere modo humano, oportunidad abierta, horario elegible, miembro autorizado/configurado, disponibilidad, presencia y capacidad. Si no hay candidato, el chat espera. El responsable y las tareas del interés deben mantenerse coherentes entre canales.

Una transferencia mantiene al responsable original hasta aceptar. Al aceptar se revalida todo; vence en 24 horas. Cambiar permisos cancela transferencias incompatibles. La toma humana cancela trabajos automáticos pendientes; leer un mensaje no satisface el SLA. Una respuesta real de agente sí lo satisface. La espera iniciada conserva su política aunque después se edite el calendario.

Las macros son manuales. Previsualizar valida plantilla/canal/curso/oferta, etapa y asignación. Ejecutar vuelve a validar, aplica acciones y guarda resultado idempotente en una sola transacción. No permite retroceder etapas ni confirmar una venta. Reutiliza estas comprobaciones al construir recetas; no copies sólo el código que inserta mensajes.

## Seguridad existente y límites

Contraseñas con scrypt, cookies `HttpOnly`/`SameSite=Lax` y `Secure` en producción; sesiones de siete días. Validación de origen, cabeceras CSP y autorización actual por marca/propietario. Los archivos comprueban acceso a la conversación o a la biblioteca de la marca; no se sirven carpetas privadas directamente. Adjuntos de hasta 4 MB con comprobación básica de tipo/cabecera; esto no es un análisis antimalware.

No hay MFA, roles de supervisor, recuperación de administración en UI, gestión de consentimiento/baja/retención, antivirus de archivos, cuotas globales, limpieza de huérfanos, trazas distribuidas ni prueba de carga comercial. Los límites en memoria son de una instancia. La publicación de código no publica la DB; introducirla en Git o en un ZIP sí lo haría.

SQLite y el trabajador local requieren **una instancia**. Añadir réplicas sin diseñar datos compartidos, leases, presencia y distribución de eventos causaría inconsistencias. Evalúa PostgreSQL y una cola externa cuando el volumen/alta disponibilidad lo justifiquen; no presupongas que es necesario para un piloto de siete personas.

## Dónde empezar según el cambio

| Necesidad | Primera lectura | Regresión a cubrir |
| --- | --- | --- |
| Cambio de precio/flyer/plantilla | `catalogue.mjs` + `catalogue.test.mjs` | Vigencia, revisión, snapshot y bytes históricos |
| Etapa/tarea/responsable | `followup.mjs`, `crm.mjs` + `followup.test.mjs` | Sin retrocesos del bot, cierre, conflicto, alcance por marca |
| Atención/capacidad/transferencia | `operations.mjs` + `operations.test.mjs` | Grupo entre canales, simultaneidad, revocación y no reiniciar espera |
| Buscador/historial | `conversations.mjs`, rutas de mensajes | Resultados fuera de 300, cursor, permisos, tildes |
| Recetas/IA | Temporizador de `index.mjs`, operaciones y catálogo | Cancelación, duplicados, contexto vigente, fuentes y aislamiento |
| Acceso/despliegue | `index.mjs`, `crm.mjs`, runbook | Sesión/origen, volumen, versión y flujo autenticado |
