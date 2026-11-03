# TEC Capital · Laboratorio CRM

Aplicación de pruebas multicanal: los participantes crean perfiles y envían mensajes reales a una bandeja de atención compartida. Los canales **WhatsApp, Instagram y Facebook son simulados dentro del laboratorio**. No se conecta ninguna cuenta de Meta.

**[Abrir laboratorio](https://crm-laboratorio-production.up.railway.app)** · [Repositorio público](https://github.com/teccapitalweb/tec-capital-crm-laboratorio)

## Continuar el desarrollo

Empieza por [CLAUDE.md](CLAUDE.md). La guía incluye [estado y decisiones](docs/CONTINUIDAD.md), [arquitectura y contratos](docs/ARQUITECTURA.md), [operación y pruebas](docs/OPERACION_Y_PRUEBAS.md) y [plan detallado de la fase 4](docs/PLAN_FASE_4.md). Distingue la versión funcional publicada v0.5 de las funciones todavía propuestas y no contiene credenciales.

## Operación del equipo · v0.5

Entrar al CRM y abrir **Operación**: Cola de atención, Mis avisos, Horarios y reparto y Macros. En una conversación, **Equipo** abre el contexto privado, notas, transferencias y el historial operativo.

- **Cola de atención humana:** filtros por marca, persona/curso, sin asignar, a mi cargo y fuera de objetivo; prioridad normal, alta o urgente; páginas de 50. Los chats atendidos por reglas no se reparten hasta pedir un asesor o pasar a atención humana. Cerrar la oportunidad o el chat los retira de la cola.
- **Reparto configurable:** por marca, menor carga, presencia conectada y disponibilidad personal. Administración selecciona los integrantes y su límite global de chats abiertos (inicialmente ocho). Si nadie es elegible, el chat permanece en cola. El reparto y los objetivos de atención empiezan desactivados para conservar la operación existente.
- **Horarios:** zona IANA y un intervalo por día, sin cruzar medianoche (se admite 24:00 como final). Los plazos de primera/siguiente respuesta cuentan minutos dentro del horario; los cambios de horario estacional se calculan sobre instantes reales. Cada marca puede registrar **festivos** (días cerrados); no se incluyen turnos personales ni vacaciones por asesor. Los objetivos ya iniciados conservan la política original; las nuevas esperas usan la configuración actual.
- **Transferencias:** solicitud con contexto, aceptación/rechazo/cancelación y vencimiento a las 24 horas. El dueño actual conserva la atención hasta la aceptación. Los chats abiertos y tareas de una misma oportunidad se trasladan juntos. Se revalidan acceso, capacidad, cierre y responsable antes de aceptar. Quitar permisos cancela solicitudes pendientes.
- **Notas y menciones:** privadas por marca, guardadas en la ficha del contacto; se puede avisar a varios integrantes. Notas y avisos no se envían al cliente. Los avisos se guardan, se paginan y se marcan como leídos individualmente.
- **Objetivos de respuesta (SLA):** primera y siguientes respuestas humanas, con alertas por vencimiento al responsable y a administración. Leer el chat o responder automáticamente no satisface el objetivo; una respuesta humana sí. Devolver o transferir no reinicia la espera. Los avisos son internos, no push ni mensajes externos.
- **Macros manuales versionadas:** combinar una plantilla aprobada, avance de etapa, tarea con plazo y nota interna. Se previsualizan todas las acciones, se revalidan datos comerciales y carga al aplicar, y se guardan juntas en una transacción. Los reintentos usan la misma referencia y no duplican efectos. No retroceden etapas, cierran ventas ni ejecutan cobros. Las recetas automáticas y la IA quedan para la siguiente fase.
- **Historial:** asignaciones, transferencias, notas, prioridades, respuestas y ejecución de macros; configuración de horarios/reparto y versiones de macros con autor y fecha. Los formularios conservan el borrador ante conflictos y la configuración en edición no se reemplaza por actualizaciones en vivo.

Para probar: configurar una marca y sus integrantes; abrir dos sesiones de asesores y marcar Disponible/Ausente; pedir «asesor» desde un cliente; tomar o repartir el chat; añadir una nota con mención; transferir y aceptar desde la segunda sesión; crear una macro y aplicarla desde Equipo. La vista previa de una macro no modifica datos ni envía mensajes.

La migración v6 añade tablas de operación sin reescribir catálogo, usuarios, mensajes ni adjuntos. Antes de migrar una base con usuarios se genera `/data/backups/before-crm-v6-*.sqlite`. Esta copia no sustituye el respaldo periódico y la restauración conjunta de SQLite, `uploads/` y `library/`. El trabajador de operación se ejecuta en la misma instancia; la cola no depende de tener abierta una página, pero el reparto requiere una sesión conectada del asesor.

## Respuestas automáticas y conocimiento

Cada marca elige en **Operación → Seguimientos** cómo responde a los clientes: apagado, **sugerir** (el asesor ve un borrador con fuentes sobre el redactor), **plantillas** (lo de siempre: catálogo y conocimiento aprobado) o **autónomo con IA** (además redacta con un proveedor usando sólo conocimiento aprobado; sin clave usa un simulador). En **Catálogo y biblioteca → Conocimiento** el equipo escribe preguntas y respuestas por marca o curso y administración las aprueba. En el panel **Equipo** de cada conversación se ve por qué respondió cada mensaje automático y con qué fuente. Precios y fechas nunca salen del conocimiento: siempre del catálogo.

## Simulador de clientes y catálogo de demostración

En **Operación → Demo** (administración) se crean clientes ficticios —su nombre termina en «· demo»— que escriben por la misma API que un cliente real siguiendo ocho guiones (curioso, precio, listo para inscribirse, molesto, baja, dudas, preguntas fuera de guion, silencio) a tres ritmos. El CRM responde como siempre y la tarjeta de la demo muestra en vivo cuántos resolvió solo, cuántos esperan a una persona, la primera respuesta automática media, las bajas y las etapas. **Detener** los calla; **Archivar** cierra sus chats y oportunidades. **Generar catálogo de demostración** crea hasta 15 marcas con 8 cursos cada una (ediciones publicadas y preventas) pasando por la importación CSV; repetirlo no duplica. `SIMULATOR_DISABLED=1` oculta el módulo.

## Canal simulado realista

Por marca y apagado por omisión (**Operación → Seguimientos → Canal simulado**). Al activarlo, los mensajes del equipo y de la automatización pasan por **enviado → entregado → leído** (o **fallido**, con reintento y bitácora), se aplica la **ventana de servicio de 24 h** (72 h si el cliente llegó por anuncio): fuera de ella sólo pasan plantillas aprobadas —temario, precio y fechas como utilidad, flyer como marketing—, la bienvenida automática lleva **botones de respuesta rápida** y cada flyer aprobado ofrece un **enlace de anuncio** (`/?ad=…`) que abre la conversación del curso con el origen marcado. Nada se conecta a Meta; sirve para ensayar el flujo real antes de tener los accesos.

## Venta con pago simulado

Por marca y apagada por omisión (**Operación → Pagos**). Activa, el equipo puede **Cobrar** desde el chat (pedido con el precio vigente del catálogo, referencia y enlace de pago de prueba) y el motor de respuestas genera el pedido cuando el cliente pide inscribirse. El cliente paga con **tarjeta u OXXO simulados** desde el enlace o envía su **comprobante** por el chat, que entra solo a la cola de validación de Pagos. Confirmar un pago inscribe, descuenta cupo, cierra la oportunidad como **ganada**, avisa al equipo y se lo dice al cliente. No se cobra nada real: el webhook de una pasarela real entrará por el mismo punto cuando existan los accesos.

## Modo presentación

La vista **Presentación** del equipo reúne, en vivo y por marca, lo que la plataforma ya hace: conversaciones (y cuántas llegaron por anuncio), **% resueltas sin intervención humana**, primera respuesta **automática vs humana**, ventas de práctica y cobrado por marca, mensajes por categoría con **costo estimado** (tarifas orientativas, editables con `MESSAGE_RATES`) y un **guion de 10 pasos** que indica si cada pantalla está lista, qué decir y un botón para ir a ella. Tiene pantalla completa para proyectar.

## Conectores: así se enchufarán Meta y la pasarela

El CRM habla con una **interfaz única** de canal y de pago (`docs/CONECTORES.md`). Hoy la cumplen adaptadores simulados; mañana Meta (WhatsApp, Instagram, Messenger) y Stripe o Conekta, cambiando sólo variables de entorno. Los webhooks entran por rutas públicas con **firma verificada** y se aplican **una sola vez**; un proveedor real sin accesos no interrumpe nada: el CRM sigue con el simulado y lo dice. En **Operación → Conectores** (administración) se ve el estado, lo que cada consultora debe entregar y se puede enviar un webhook firmado de prueba.

## Banco de evaluación del motor

En **Catálogo y biblioteca → Evaluación** cada marca tiene casos que dicen qué escribe un cliente y qué debería hacer el motor (intención, acción, fuente y texto). **Ejecutar** corre la misma simulación que «Probar respuesta», sin enviar nada, con el nivel vigente de la marca, y guarda la puntuación y el detalle de cada caso para comparar antes y después de cambiar conocimiento, nivel o proveedor de IA. Cada marca nace con 17 casos.

## Coordinación académica y bitácora de eventos

En **Operación → Coordinación** cada edición del catálogo es una *apertura*: mínimo de alumnos, inscritos que llegan solos al confirmar un pago, persona responsable, grupo de WhatsApp (enlace registrado), sesiones con enlace de videollamada (simulado en el laboratorio), recordatorios a los inscritos, asistencia, materiales y grabaciones, y estados planeada → abierta → en curso → cerrada. La automatización (abrir al llegar al mínimo y recordar sesiones) está **apagada por marca** hasta que administración la active; lo manual funciona siempre. En **Operación → Eventos** (administración) está la bitácora común de hechos del negocio —conversaciones, etapas, pedidos, pagos, inscripciones, mensajes, bajas, aperturas y sesiones— con filtros, entregas a suscriptores con reintento y exportación CSV.

## Verificación en dos pasos (equipo)

En **Mi configuración → Acceso y seguridad** el equipo puede activar un código temporal de una app de autenticación (opcional). Al iniciar sesión se pide después de la contraseña; hay 10 códigos de recuperación de un solo uso. Administración ve quién la tiene en **Equipo** y puede restablecerla. Si el administrador queda bloqueado, el procedimiento de emergencia está en `docs/OPERACION_Y_PRUEBAS.md`.

## Analítica comercial

En **Analítica** (equipo): elige periodo y marca y revisa el embudo de las oportunidades creadas, las ventas de práctica, la actividad diaria, los tiempos de atención humana y el desempeño del equipo (administración ve a todos; cada asesor, solo lo suyo). Los números son de práctica y los tiempos son de reloj.

## Contactos: etiquetas, duplicados y exportación

En **Contactos**: filtra por etiqueta, crea y asigna etiquetas desde la ficha, usa **Duplicados** para ver fichas repetidas (mismo teléfono, correo o nombre) y, como administración, fusiónalas tras revisar qué se mueve. **Exportar** descarga contactos y oportunidades en CSV (sólo administración; contiene datos personales).

## Importación del catálogo por CSV

En **Catálogo y biblioteca** (administración) usa **Importar CSV**. Descarga la plantilla, llénala (una fila por edición) y pégala o cárgala. Columnas: `marca, curso, temario, edicion, inicio, fin, zona_horaria, docente, modalidad, lugar, enlace, cupo, cupo_disponible, precio, moneda, estado, promo_nombre, promo_precio, promo_inicio, promo_fin, promo_estado`. Obligatorias: `marca`, `curso` y `precio` (y `temario` si el curso es nuevo). Fechas como `2026-11-20 18:00` en la hora de `zona_horaria`; modalidad `online`, `presencial` o `hibrida`; estado `borrador` o `publicada`. La vista previa no guarda nada; al aplicar, lo que ya existe se respeta y cada fila informa su resultado. Las marcas deben existir antes.

## Catálogo y biblioteca · v0.4

Entrar en **Catálogo y biblioteca** desde el CRM. Administración gestiona el contenido y los asesores consultan y envían el material aprobado de sus marcas.

- **Cursos:** ficha general, temario, publicación/archivo e historial de versiones. Crear un curso añade una edición en borrador.
- **Ediciones:** fechas y horario con zona IANA, docente, modalidad, lugar, enlace informativo, cupo, precio regular y moneda. El cliente elige la edición; cada edición tiene su conversación y oportunidad independientes. El cupo es informativo: todavía no se reserva ni descuenta automáticamente.
- **Promociones:** precio con centavos y vigencia por edición. Las promociones publicadas de una edición no pueden solaparse, superar el precio regular ni acabar después del inicio del curso. El precio vigente se consulta al preparar y enviar cada respuesta.
- **Flyers:** cargar imágenes o PDF de hasta 4 MB, asociar edición/promoción/canal, caducidad, guardar borrador, aprobar y archivar. Reemplazar un archivo crea una versión nueva; los mensajes anteriores conservan el archivo original. Antes de aprobar, una persona debe revisar que lo escrito en la imagen coincide con los datos: no hay reconocimiento ni corrección automática del texto del flyer.
- **Plantillas:** por marca, curso, edición, canal y escenario; texto con variables, flyer opcional y vista previa. Las marcas reciben seis plantillas iniciales. Los cambios vuelven a borrador y requieren aprobación interna; esta aprobación no sustituye la futura revisión de plantillas de Meta.
- **Chat:** botón Biblioteca y respuestas rápidas con vista previa. El envío comprueba otra vez vigencia, permisos, versiones y disponibilidad; si cambió la información, pide generar una vista previa nueva. Los reintentos no duplican el mensaje.
- **Historial:** conserva el texto, archivo, edición, precio, moneda y promoción exactos enviados. La oportunidad muestra la última oferta compartida. Los contenidos archivados permanecen consultables en el historial.

Variables disponibles: `{{nombre}}`, `{{marca}}`, `{{curso}}`, `{{edicion}}`, `{{fecha}}`, `{{docente}}`, `{{modalidad}}`, `{{precio}}`, `{{precio_regular}}`, `{{promocion}}`, `{{vigencia}}`, `{{temario}}`, `{{enlace}}` y `{{cupo}}`. Usar variables para los datos comerciales; los precios escritos como texto fijo no se actualizan automáticamente.

**Recorrido recomendado:** crear curso → completar y publicar edición → programar promoción si aplica → subir y aprobar flyer → crear, previsualizar y aprobar plantilla → abrir una conversación de esa edición y enviar desde Biblioteca. Si cambia el curso, edición o promoción, el flyer asociado requiere revisión antes de enviarse de nuevo.

La migración v5 es aditiva: genera una edición general para los cursos existentes, conserva sus precios y deja las fechas desconocidas como «Por confirmar». No inventa fechas, docentes ni cupos reales. Importa los seis flyers de demostración sólo cuando siguen coincidiendo con los cursos. Una base con usuarios se respalda primero en `/data/backups/before-crm-v5-*.sqlite`. Los archivos propios se almacenan en `/data/library/`, fuera del repositorio; el respaldo completo debe incluir esa carpeta y `uploads/` además de SQLite. La migración repetida no duplica contenido.

## Seguimiento consistente · v0.3

- Chat y oportunidad muestran la misma etapa comercial. El estado abierto/cerrado del chat se mantiene independiente. `conversations.stage` queda como dato heredado para importar conversaciones antiguas; las lecturas y transiciones actuales usan `opportunities.stage`.
- Las reglas sólo avanzan el interés: una pregunta de precio no retrocede una inscripción solicitada ni reabre una oportunidad cerrada.
- Reabrir una oportunidad cuando ya hay otra activa del mismo contacto/curso devuelve un conflicto explicativo y permite abrir la vigente. No modifica ninguno de los dos históricos.
- Tareas editables: título, fecha, responsable y estado; atajos de reprogramación, cancelación/reapertura y vistas de pendientes, completadas y canceladas. La fecha se muestra en la zona horaria del dispositivo y se guarda como instante UTC.
- Historial por oportunidad: etapas, responsables y cambios de tareas, con autor, fecha, valores anteriores y motivo cuando se proporciona. Importa los eventos de etapas disponibles de v0.2; los cambios de tareas anteriores a esta entrega no pueden reconstruirse.
- Los formularios envían la revisión del registro. Si otra persona ya lo cambió, el servidor devuelve 409 y la interfaz conserva el borrador y ofrece recargar los datos.
- Búsqueda en servidor por nombre, número, curso, marca y texto de mensajes, sin distinguir tildes o mayúsculas. Filtros por marca/canal/estado y páginas de 50 conversaciones; acceso directo a conversaciones antiguas desde la oportunidad. La lupa del chat busca mensajes en todo ese historial, también por páginas.

La migración de esquema v4 añade revisiones e historial sin reescribir cuentas, mensajes ni flyers. Una base existente con usuarios genera primero `/data/backups/before-crm-v4-*.sqlite`; las pruebas comprueban integridad y lectura de ese respaldo. Esto no configura un servicio periódico de respaldo ni prueba la restauración completa de producción con sus adjuntos.

Para probar: editar y posponer una tarea, abrir su oportunidad y revisar el historial, buscar una palabra de un mensaje antiguo y entrar a la lupa del chat. Abrir un formulario en dos sesiones permite comprobar el aviso de edición simultánea.

## Primera entrega del espacio comercial · v0.2

**[Entrar al CRM del equipo](https://crm-laboratorio-production.up.railway.app/crm)** con la cuenta existente. Una persona que todavía tenga rol de cliente puede aceptar una invitación individual sin perder su perfil ni sus chats.

- **Mi día:** seguimientos propios, solicitudes de atención, intereses sin responsable y oportunidades sin próxima tarea.
- **Contactos:** fichas por marca, teléfono/correo opcionales, contactos manuales independientes de las cuentas y notas internas que nunca se envían al cliente.
- **Oportunidades:** varios cursos por contacto, tablero, responsable, motivo de pérdida y próxima acción. «Ganada · prueba» no confirma dinero ni matrícula.
- **Tareas:** programar, editar, reprogramar, cancelar, completar/reabrir y consultar pendientes del equipo. Cerrar una oportunidad cancela sus tareas abiertas.
- **Mi configuración:** nombre, disponibilidad visible y firma que se puede insertar manualmente en un borrador; cambio de contraseña con cierre de sesiones.
- **Equipo:** administración invita asesores por usuario exacto y marcas. Los códigos duran 24 horas, son de un uso y sólo se almacenan como hash. Se pueden revocar; no conceden administración.
- **Recuperación asistida:** administración verifica a la persona por un medio conocido y genera un código de 30 minutos para un asesor o participante. No existe recuperación automática por correo ni recuperación de administradores desde esta interfaz.
- **Permisos:** marcas comprobadas en servidor, eventos, contactos, oportunidades, archivos, cursos y métricas. Cambiar accesos cierra sesiones y libera el trabajo de las marcas retiradas.

La migración v3 conserva perfiles, mensajes y flyers. Los asesores existentes conservan acceso a las marcas que existían al migrar; administración puede reducirlo desde Equipo. Los asesores nuevos sólo reciben las marcas de su invitación. Antes de migrar una base con usuarios se guarda una copia consistente de SQLite en `/data/backups/before-crm-v3-*.sqlite`. Esa copia previa **no sustituye** backups periódicos de base y adjuntos ni un ensayo completo de restauración.

El código administrador de entorno sólo permite crear el primer administrador cuando todavía no existe ninguno. Los antiguos códigos compartidos de asesor dejan de conceder acceso. Para incorporar personas nuevas, un administrador debe iniciar sesión y crear invitaciones. No se cambian contraseñas ni se elevan cuentas existentes automáticamente.

Esta entrega implementó el primer bloque de F0/F1. Siguen pendientes, entre otros: MFA, notificaciones fuera de la aplicación, festivos y turnos personales, paginación del resumen de CRM, supervisores con roles específicos, recetas automáticas editables, integración real de Meta, IA y pagos. Los procesos comerciales continúan simulados.

## Qué puedes probar

- Registro con nombre, usuario y contraseña; identificador de prueba único, sin pedir teléfono real.
- Conversaciones cliente-equipo con WebSocket, escritura, lectura y reconexión.
- Perfiles independientes; un cliente ve sólo sus conversaciones. Asesores atienden las marcas autorizadas y administración conserva la vista general.
- Bandeja por canal y marca, búsqueda por nombre/número/curso/mensajes en el histórico y estados comerciales.
- Imágenes y PDF de hasta 4 MB, descargables sólo por participantes autorizados.
- Respuestas por curso: información, precio, temario, fecha y solicitud de asesor.
- Seis flyers fotográficos de demostración: dos por marca. Vista completa y ampliable en catálogo, envío automático y manual por chat, e imágenes históricas que conservan su versión.
- Control humano que cancela las respuestas automáticas pendientes; exclusión entre asesores.
- Catálogo editable por administradores: crear marcas, crear cursos y actualizar datos.
- Historial persistente en SQLite, trabajos automáticos persistidos y métricas de actividad real.
- Interfaz adaptable a teléfono y computadora, blanca y gris, con distintivos de canal.

**La automatización de esta versión utiliza reglas y plantillas, no un modelo de IA.** Los flyers sí se crearon con generación de imágenes. No hay cobros, inscripciones comerciales ni envíos a WhatsApp reales. Los seis cursos son ejemplos, no ofertas vigentes. No existe límite fijo de siete cuentas; la capacidad debe medirse antes de ampliar el piloto.

### Flyers incluidos

| Marca | Curso ficticio | Precio de ejemplo |
| --- | --- | --- |
| GlobalVet | Plan sanitario para aves | $379 MXN |
| GlobalVet | Nutrición en perros y gatos | $449 MXN |
| OdonTeck | Actualización en odontología | $499 MXN |
| OdonTeck | Estética dental y fotografía clínica | $599 MXN |
| Dermalysse | Fundamentos de la piel | $399 MXN |
| Dermalysse | Diseño de rutinas de cuidado facial | $459 MXN |

Los archivos originales están en `public/flyers/`. En la aplicación se entregan a través de rutas autenticadas; los mensajes conservan el identificador de su imagen al enviarse. Si se edita un curso, su diseño fijo se sustituye automáticamente por una ficha con los datos vigentes para evitar precios contradictorios. Las imágenes de mensajes anteriores no cambian. La ampliación del catálogo añade tres cursos y conserva las cuentas, chats y ediciones existentes.

## Iniciar localmente

Requiere Node.js 24 o superior.

```sh
npm ci
cp .env.example .env
npm start
```

En PowerShell, copia con `Copy-Item .env.example .env`. Abre `http://127.0.0.1:3100`.

Configura un código aleatorio largo en `ADMIN_INVITE_CODE` dentro de `.env` para crear el primer administrador. **No subas ese archivo ni compartas ese código con participantes.** `STAFF_INVITE_CODE` es una variable heredada que ya no se utiliza.

1. Cliente: crear un perfil sin código, elegir un curso y enviar “Hola”.
2. Asesor: aceptar una invitación individual desde `/crm` con su cuenta actual, o usarla al crear su perfil con el usuario exacto invitado.
3. Primer administrador: en una instalación vacía, usar el código inicial al registrarse. Administradores existentes inician sesión normalmente.

El equipo puede cambiar entre la experiencia de cliente y el CRM. Cada participante conserva su usuario y contraseña; la recuperación asistida se gestiona desde Equipo después de verificar identidad.

## Despliegue

El repositorio contiene `Dockerfile` y `railway.json`. Ejecutar **una sola instancia** con un volumen persistente montado en `/data` y estas variables:

| Variable | Valor/uso |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | Puerto asignado o `3100` |
| `DATA_DIR` | `/data` |
| `APP_ORIGIN` | URL pública HTTPS exacta, sin barra final |
| `ADMIN_INVITE_CODE` | Secreto de creación del primer administrador; no reutilizable una vez configurado |
| `STAFF_INVITE_CODE` | Heredado, sin efecto desde v0.2 |

Las cookies de producción requieren HTTPS. El volumen guarda la base de datos y los adjuntos. **GitHub Pages no ejecuta este servidor ni reemplaza la base de datos.** Publicar el código no hace públicas las conversaciones.

Para respaldo consistente, usar la API de backup de SQLite o detener la aplicación antes de copiar la base y los archivos WAL/SHM junto con `uploads/` y `library/`. Los respaldos automáticos y su restauración deben configurarse y ensayarse antes de usar datos comerciales. Nunca subir copias de la base a este repositorio.

## Verificación

```sh
npm run check
npm test
```

Las pruebas levantan un servidor y una base temporal, conectan siete clientes y comprueban entrega, permisos, archivos, versiones de flyer, idempotencia, lectura, atención humana y persistencia tras reinicio. También cubren las tres regresiones comerciales, versiones concurrentes, tareas editables, migraciones hasta v6, permisos del historial y búsqueda con más de 300 conversaciones. El catálogo prueba fechas, monedas, cupos, promociones solapadas/vencidas/programadas, variables, aprobaciones, acceso por marca, vistas previas obsoletas y conservación del precio y los bytes originales tras editar o archivar. Operación comprueba horarios y cambios estacionales, capacidad global, presencia, reparto, transferencia conjunta, permisos de menciones, SLA, paginación con fechas iguales, toma concurrente y macros idempotentes. No usan Meta ni servicios de IA.

## Arquitectura y límites del piloto

Node HTTP + `ws` para comunicación; SQLite en WAL para persistencia; frontend HTML/CSS/JavaScript sin compilación. Contraseñas derivadas con scrypt, sesiones HttpOnly con tokens almacenados como hash, comprobación de origen y autorización de mensajes/archivos en el servidor. Los códigos de equipo sólo se verifican en el servidor.

Todos los asesores pertenecen a la misma empresa; su acceso se limita a las marcas asignadas. Aún no hay MFA, recuperación autónoma por correo, borrado/retención desde interfaz ni notificaciones push. La bandeja busca y pagina de 50 en 50; los mensajes se leen en páginas de 150 y sus coincidencias en páginas de 50. El bootstrap conserva un resumen de las 300 conversaciones más recientes para los contadores de inicio, que todavía no representan totales globales en grandes volúmenes. El resumen de CRM y el catálogo se cargan completos para el volumen del laboratorio; deben paginarse antes de grandes históricos. Los avisos en vivo requieren tener abierta la aplicación.

Usar datos ficticios. Antes de operar con clientes reales se requieren completar retención, respaldos periódicos y restauración, observabilidad, controles de abuso y pruebas de carga, además de evaluar la seguridad de los nuevos flujos. PostgreSQL y una cola compartida reemplazarán SQLite/procesamiento local si se necesitan varias instancias. No desplegar un binario antiguo sobre una base migrada sin verificar compatibilidad: la reversión de esquema requiere restaurar la copia previa de forma controlada y evaluar los datos posteriores.

Consulta [ROADMAP.md](ROADMAP.md) para las siguientes fases.
