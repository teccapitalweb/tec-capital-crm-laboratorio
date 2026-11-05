# Operación, pruebas y despliegue

Referencia verificada el 30 de octubre de 2026, hora de México: v0.5.0, commit funcional `c7218f15d346e08406a96786db68523e78db4877`. Esta guía no contiene credenciales. Para la ubicación del proyecto y los recursos privados de esta computadora, consultar la guía de traspaso local entregada al usuario.

## Antes de modificar

1. Confirmar que es el repositorio `tec-capital-crm-laboratorio` vigente, no un prototipo con el mismo nombre en `work/`.
2. Leer [CLAUDE.md](../CLAUDE.md), [CONTINUIDAD.md](CONTINUIDAD.md), [ARQUITECTURA.md](ARQUITECTURA.md) y el alcance solicitado por el usuario.
3. Ejecutar `git status --short`, `git branch --show-current`, `git log -5 --oneline` y revisar `package.json`. Respetar cambios ajenos sin sobrescribirlos.
4. Distinguir archivos locales, versión en GitHub y despliegue activo; no siempre coinciden. Los documentos se fecharon contra el commit funcional de referencia.
5. No hacer `git pull`, migraciones, limpieza o restauración a ciegas para “igualar” estados. Primero identificar la diferencia y sus datos afectados.

## Preparar desarrollo local

Node.js **24** es la versión usada en Docker y CI; `package.json` permite versiones superiores compatibles. `node:sqlite` forma parte de Node, no se instala otro paquete SQLite.

```powershell
node --version
npm ci --ignore-scripts
npm run check
npm test
```

Desde la raíz del repo, copiar el ejemplo sólo si no hay `.env`:

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
npm start
```

`npm run dev` añade el modo de observación de Node. La aplicación local abre en `http://127.0.0.1:3100` y el equipo entra por `/crm`. Las variables de la sesión de shell tienen prioridad sobre `.env`; comprobarlas cuando el puerto, origen o directorio de datos no coincidan con lo esperado. No imprimir valores de variables sensibles al diagnosticar.

Para una prueba nueva usa un directorio de datos vacío e independiente. No conectes el servidor local a copias de producción sin necesidad y protección adecuadas. No reutilices el volumen real ni una base de QA de otra ejecución. Si el puerto está ocupado, identifica el proceso o elige otro puerto; no finalices procesos desconocidos.

### Variables

| Variable | Desarrollo | Producción / observaciones |
| --- | --- | --- |
| `PORT` | `3100` u otro libre | Asignado por plataforma o 3100 |
| `HOST` | `127.0.0.1` | `0.0.0.0` |
| `DATA_DIR` | Carpeta local aislada; por defecto `./data` | `/data`, volumen persistente |
| `APP_ORIGIN` | Origen exacto del navegador; si vacío se valida contra el host | URL HTTPS pública exacta, sin barra final |
| `NODE_ENV` | `development` | `production`; activa cookies Secure y HSTS |
| `BACKUP_INTERVAL_HOURS` | `24` por defecto (desactivado en `NODE_ENV=test`) | Horas entre respaldos automáticos; `0` los desactiva |
| `BACKUP_KEEP` | `7` | Respaldos automáticos que se conservan |
| `AI_PROVIDER` | vacío o `simulated` | `claude` activa el SDK oficial; requiere credenciales. Sin él, el nivel autónomo usa el simulador local |
| `AI_MODEL` | `claude-opus-5-5` | Modelo del proveedor; `claude-haiku-5-5` es la opción económica para volumen |
| `ANTHROPIC_API_KEY` | No usar en local salvo prueba aislada | Credencial del proveedor; sólo en el entorno del servidor, nunca en Git |
| `CHANNEL_CONNECTOR` / `PAYMENT_CONNECTOR` | `simulated` | `meta` / `stripe` o `conekta` cuando haya accesos; sin ellos el CRM sigue con el simulado y lo avisa. Ver [CONECTORES.md](CONECTORES.md) |
| `CONNECTOR_WEBHOOK_SECRET` | Opcional | Firma de los webhooks de prueba del simulado y del botón «Probar webhook»; sin él esas rutas responden 404 |
| `META_*`, `STRIPE_*`, `CONEKTA_*` | No usar en local | Accesos de cada proveedor, sólo en el entorno del servidor; la lista exacta está en Operación → Conectores y en CONECTORES.md |
| `MESSAGE_RATES` | vacío (0,80 / 0,16 / 0) | Tarifas orientativas MXN por mensaje saliente para el costo estimado del modo presentación: `marketing=0.80,utility=0.16,service=0`. Nunca es una factura |
| `PUSH_DISABLED` | vacío | `1` apaga las notificaciones push: `/api/push/config` responde `enabled:false`, suscribirse o probar da 503 y el barrido no corre |
| `PUSH_DELAY_MS` | `15000` | Espera antes de enviar un aviso no leído (evita que suene mientras la persona lo ve); `0` en pruebas |
| `PUSH_SUBJECT` | vacío (usa `APP_ORIGIN` o la dirección pública del CRM) | Contacto `sub` de la firma VAPID: una URL https o `mailto:` del equipo, nunca un correo personal |
| `SIMULATOR_DISABLED` | vacío | `1` oculta el simulador de clientes: `/api/simulator` responde 404 y el barrido no corre. Úsalo en un entorno con clientes reales |
| `MFA_KEY` | Opcional | Clave para cifrar los secretos de la verificación en dos pasos; si falta se usa `DATA_DIR/mfa.key`. Guárdala aparte; sin ella, los 2FA no se pueden verificar tras una restauración |
| `MFA_RESET_USER` | Sólo emergencia | Usuario cuya verificación en dos pasos se restablece al arrancar; retirarla después |
| `ADMIN_INVITE_CODE` | Secreto aleatorio privado para inicializar una instalación vacía | Sólo permite crear el primer administrador |
| `STAFF_INVITE_CODE` | No usar | Variable heredada, sin efecto desde v0.2 |

No hay claves de IA/Meta necesarias para esta versión. Generar un código inicial no crea automáticamente un usuario: en una base vacía se registra la primera cuenta con ese código. Una base que ya tiene administrador no concede más administradores por repetirlo.

Los clientes se registran sin código. Los asesores aceptan invitación individual para su usuario exacto, emitida desde Equipo por administración. Una cuenta de cliente puede aceptar esa invitación conservando sus chats. No eleves roles por SQL para resolver una prueba ordinaria.

## Pruebas reproducibles en el repositorio

`npm run check` comprueba sintaxis; no es un linter ni una compilación. `npm test` usa `node --test test/*.test.mjs`, servidores/base temporales y datos ficticios. La referencia funcional v0.5 aprobó **57 pruebas, cero fallos**; con los bloques locales hasta las etiquetas de la bandeja son **159** (ver nota de intermitencia en CONTINUIDAD). Tras un cambio hay que comprobar el nuevo resultado, no citar automáticamente el anterior.

| Archivo | Qué protege |
| --- | --- |
| `test/laboratorio.test.mjs` | Siete clientes, tiempo real, alcance por usuario, origen, adjuntos, idempotencia, lectura, toma humana, sesiones y persistencia |
| `test/catalog.test.mjs` | Ampliación inicial de cursos/flyers sin sobrescribir cursos editados ni conversaciones |
| `test/crm.test.mjs` | Invitaciones, alcance por marca, intereses/tareas, revocación, recuperación y migración |
| `test/followup.test.mjs` | Tres regresiones comerciales, revisiones concurrentes, edición/historial de tareas, búsqueda fuera de 300 chats y migración |
| `test/catalogue.test.mjs` | Ediciones, fechas, centavos, promociones, variables, aprobación, permisos, vistas previas, archivo, snapshots/bytes históricos y reinicio |
| `test/automation.test.mjs` | Motor 4A: migración v7, idempotencia, reintentos, reinicio, carreras de cancelación y pausas (sin servidor; base temporal) |
| `test/automation-http.test.mjs` | Rutas `/api/automation`: sólo administración, revisiones, pausa global (servidor temporal) |
| `test/inboxtags.test.mjs` | Etiquetas en la bandeja por API: etiquetas por hilo con color, filtro por etiqueta combinado con otros filtros, alcance por marca (una etiqueta de otra marca no abre hilos ajenos), valor inválido ignorado, quitar la etiqueta saca el hilo, detalle con etiquetas y nada de esto llega al cliente |
| `test/quickreplies.test.mjs` | Respuestas rápidas: variables permitidas y sustitución; por API: permisos, validación del atajo y del texto, idempotencia, personales y de marca (sólo administración), visibilidad por persona y marca, variables resueltas con la conversación, alcance de la conversación y de la marca, conflictos de revisión, archivado y reutilización del atajo |
| `test/push.test.mjs` | Push: cifrado de ida y vuelta y **vector oficial del RFC 8291**, destinos permitidos, grupos; por API con un receptor local: permisos, clave VAPID firmada y verificada, suscripción validada, envío cifrado e idempotente, preferencias, avisos leídos, historial no reenviado, prueba y su límite, dispositivo caído eliminado, aislamiento entre personas, archivos de la app instalable |
| `test/portal.test.mjs` | Portal por roles por API: acceso (401, 403 de cliente, una asesora no mira a otra, marca sin acceso 404, periodo), cifras de ventas y reembolsos contra el libro sembrado, rendimiento del equipo (orden, atención desde la bitácora, filtro por marca y permisos), comisiones y liquidaciones, cartera, aislamiento entre marcas, administración viendo a otra persona con selector, aperturas coordinadas con avisos (faltan inscritos, sin sesiones, sin enlace), cerradas hace más de 60 días fuera, sólo lectura y esquema sin cambios |
| `test/campaigns.test.mjs` | Campañas por API: permisos, apagado por marca, vista previa sin efectos con motivos de exclusión, confirmación del público, envío idempotente (un mensaje por destinatario aunque el escaneo se repita), respuestas y bajas posteriores, separación mínima, toma humana, segmentos por etiqueta/inactividad/etapa, cancelación de una programada y de una en vuelo |
| `test/legacy.test.mjs` | Históricos IPCIL: fechas e importes del panel, normalización JSON/CSV, vista previa con errores sin escribir, importación idempotente ligada a personas existentes y nuevas, ficha de persona, Finanzas fuera del libro, secuencia de folios, lotes y permisos |
| `test/core.test.mjs` | Núcleo compartido: firma HMAC y tolerancia, esquema SQL, outbox con receptor local (sobres firmados con registros proyectados, reintento ante 5xx, fallo permanente ante 4xx, reintento masivo, reproducción idempotente del historial, ping, permisos) y modo simulado sin URL |
| `test/academics.test.mjs` | Pagos por sesión y encuestas: precio por sesión en catálogo, inscripción por sesión que cubre la primera sesión, cobro manual y con el recordatorio, pago de sesión sin nueva inscripción, condonación y cancelaciones en cascada, encuesta automática y manual, respuesta pública por token (HTML y JSON), resultados, CSV y permisos |
| `test/content.test.mjs` | Contenido: funciones de diseño y aprobación, plantillas por evento (pago, sesión, certificado, grabación, anuncio) con respaldo en texto fijo, variantes por IA validadas, fichas con caché y flyer |
| `test/certificates.test.mjs` | Certificación: QR, elegibilidad por asistencia, emisión automática al cerrar y manual, folios consecutivos, verificación pública (HTML, JSON, SVG), revocación y re-emisión, créditos, aviso al alumno, límite de peticiones |
| `test/persons.test.mjs` | Identidad de persona: normalización, migración v21 con relleno y consentimiento proyectado, misma clienta en dos marcas, alcance, unión por teléfono/correo, candidaturas, baja a nivel persona, fusiones y CSV |
| `test/finance.test.mjs` | Finanzas: comisión y periodos, relleno del libro al migrar, libro por eventos, reglas y recálculo, resumen y conciliación, cruce con Presentación, CSV, función contadora, liquidación y reembolso |
| `test/events.test.mjs` | Eventos de dominio: migración v19, publicación idempotente dentro de la transacción, suscriptores con reintento/espera creciente/fallo permanente, reintento manual, consulta con alcance y CSV (sin servidor; base temporal) |
| `test/coordination.test.mjs` | Coordinación académica: cinco ventas simuladas abren la apertura al llegar al mínimo, avisos, sesiones con enlace simulado, recordatorio a inscritos sin duplicados, asistencia, estados, bajas, recursos, bitácora, CSV y permisos |
| `test/evaluation.test.mjs` | Banco de evaluación: calificación, siembra, ejecución con nivel vigente, caso fallido, revisión, archivo, historial, alcance y permisos |
| `test/connectors.test.mjs` | Conectores: adaptadores Meta/Stripe sin red, webhooks firmados e idempotentes, estados de mensaje y pagos por webhook, prueba desde la interfaz, respaldo al simulado sin accesos |
| `test/presentation.test.mjs` | Modo presentación: tarifas por entorno, cifras (sin intervención, tiempos, ventas, categorías y costo), guion con comprobaciones, alcance por marca, permisos |
| `test/payments.test.mjs` | Venta con pago simulado: apagada por omisión, cobro desde el chat, pago simulado con inscripción y etapa ganada, pedido del motor, comprobantes en cola (rechazo/aceptación), cancelación, vencimiento, permisos |
| `test/channel.test.mjs` | Canal simulado: apagado por omisión, permisos, ventana 24/72 h, estados de entrega, fallo y reintento con bitácora, botones, anuncio, plantillas vs texto libre |
| `test/simulator.test.mjs` | Simulador de clientes: guiones y catálogo demo coherentes; recorrido por API (permisos, catálogo idempotente, demo de ocho perfiles, respuesta humana, detener/archivar) |
| `test/replies.test.mjs` | Motor de respuestas v2: parecido léxico, conocimiento, niveles por marca, bitácora, sugerencias, proveedor simulado |
| `test/mfa.test.mjs` | TOTP (vectores RFC 6238), ventana/reutilización y el flujo completo de 2 pasos |
| `test/holidays.test.mjs` | Festivos: cálculo por zona horaria, validación y API (política, historial, cola) |
| `test/triggers.test.mjs` | Disparadores de recetas `task_overdue` y `waiting_human`: validación, cancelaciones y simulación |
| `test/consent.test.mjs` | Consentimiento y baja: detección, bloqueo en recetas, tope de frecuencia, API, fusión y exportación |
| `test/analytics.test.mjs` | Analítica: embudo, resultados, tiempos de respuesta, privacidad por asesor, permisos y API |
| `test/contacts.test.mjs` | Etiquetas, duplicados, fusión con vista previa y exportación CSV (servidor real) |
| `test/backup.test.mjs` | Respaldo con manifiesto, rotación, programación, detección de adjuntos perdidos/base dañada, ensayo de restauración y rutas |
| `test/catalogue-import.test.mjs` | CSV (comillas, saltos, BOM), fechas por zona IANA, vista previa sin escritura, aplicación idempotente y errores por fila |
| `test/recipes.test.mjs`, `test/recipes-http.test.mjs` | Recetas 4B: validación, simulación sin efectos, no retroactividad, cancelaciones, versiones, ejecución real por API |
| `test/operations.test.mjs` | Minutos hábiles/DST, reparto, presencia, carga, transferencia conjunta, menciones, SLA, macros atómicas, paginación, revocación y reinicio |

Para iterar en un módulo puede ejecutarse, por ejemplo, `node --test test/operations.test.mjs`. Antes de una entrega funcional, ejecutar la suite pertinente y la regresión completa; no ampliar repetidamente las pruebas sin cambios o dudas nuevas.

Cuando una prueba abre su propia conexión `DatabaseSync` sobre la base del servidor temporal para sembrar o inspeccionar filas, debe abrirla con `{timeout:5000}`: el servidor escribe cada segundo desde el tick de eventos y una conexión sin espera falla con `database is locked` (ocurrió una vez en CI, 3 nov 2026). Las conexiones de sólo lectura (`readOnly:true`) no lo necesitan.

Las pruebas automatizadas del repositorio no ejecutan navegador ni demuestran que Railway tenga ese código. La revisión local y la publicada son evidencias diferentes.

## Recorrido de aceptación en navegador

Para probar sin tocar producción, `npm run demo` crea en `data-demo/` una base local con ocho cuentas (administración, dos asesores, contadora, coordinador y tres clientes), la marca GlobalVet con todo encendido y datos de ejemplo; `npm run demo:reset` la recrea. Detalle y credenciales: [BASE_DE_PRUEBAS.md](BASE_DE_PRUEBAS.md).

Para dejar una marca de pruebas funcionando de punta a punta, con orden de encendido, 14 pasos y cierre, usa el runbook [ACTIVACION_Y_VERIFICACION.md](ACTIVACION_Y_VERIFICACION.md); la lista de abajo es la comprobación por módulo.

Usar perfiles/sesiones separados para un administrador, dos asesores de prueba y un cliente. Una pestaña adicional normalmente comparte cookies; usar contextos separados o perfiles distintos. Mantener los datos identificables como prueba.

1. **Acceso y permisos:** cliente entra a `/`, equipo a `/crm`. Un cliente no puede consultar rutas de operación ni adjuntos ajenos. Un asesor no ve una marca que no tiene asignada.
2. **Mensajes:** enviar desde el cliente, observar recepción sin recarga, contestar desde asesor, comprobar reconexión/lectura y un adjunto permitido.
3. **Interés y búsqueda:** pedir inscripción y luego precio sin retroceso de etapa; buscar texto antiguo, editar tarea y revisar historia. Abrir un formulario en dos sesiones y confirmar el conflicto sin perder el borrador.
4. **Catálogo:** en datos de prueba, crear edición futura, promoción válida y flyer/plantilla. Aprobar, previsualizar y enviar. Cambiar precio y verificar que el nuevo envío usa oferta actual y el anterior conserva su archivo/precio.
5. **Operación:** configurar integrantes/horario de una marca de prueba, activar reparto cuando corresponda, pedir asesor y observar elegibilidad/capacidad. Cambiar disponibilidad y comprobar que el excedente queda en cola.
6. **Coordinación:** nota con mención, aviso privado, transferencia aceptada desde la otra sesión y responsable/tareas coherentes entre chats del mismo interés.
7. **Macro:** crear y previsualizar; aplicar una vez, reintentar la misma referencia y verificar un solo mensaje/tarea/nota. Cambiar datos entre preview y ejecución para comprobar que se exige revisar.
8. **SLA y formularios:** lectura/bot no satisfacen respuesta humana; devolver/transferir no reinician espera. Una actualización WS no borra cambios del formulario en edición.
9. **Presentación:** escritorio (incluida una ventana de más de 1800 px: el CRM debe llegar a ambos bordes) y móvil de unos 390 px, modales completos, botones accesibles, sin desplazamiento lateral accidental ni errores de consola en el recorrido.
10. **Cierre de QA:** pausar la macro/receta de prueba, cerrar sus intereses/chats, completar/cancelar sus tareas y suspender asesores técnicos si ya no hacen falta. Conservar auditoría. No borrar registros del equipo para dejar las pantallas vacías.
11. **Demo (administración):** en un entorno de pruebas, generar el catálogo de demostración, iniciar una demo corta a ritmo rápido, comprobar que los clientes «· demo» aparecen en la bandeja y en la cola, responder a uno que espera persona y archivar la demo al terminar. En la base del equipo una demo crea usuarios, chats y oportunidades identificados pero reales para el CRM: avisar antes y archivar después.
12. **Canal simulado (administración):** activarlo sólo en una marca de pruebas; comprobar botones en la vista del cliente, estados enviado/entregado/leído, cierre de ventana (texto libre bloqueado, plantilla permitida), fallo y reintento, y un enlace de anuncio desde un flyer aprobado. Desactivarlo al terminar si la marca atiende clientes reales.
13. **Venta con pago simulado (administración):** activarla en una marca de pruebas; «Cobrar» desde el chat, pagar desde el enlace como cliente de prueba, enviar un adjunto con pedido vigente y aceptarlo o rechazarlo en Pagos; comprobar inscripción, etapa ganada y aviso. Cancelar o dejar vencer los pedidos de prueba al terminar.
14. **Presentación:** abrir la vista Presentación, revisar que el guion marque «Listo» en los pasos que se van a mostrar, probar «Ir a la pantalla» y la pantalla completa; el filtro por marca y periodo debe cambiar las cifras sin recargar.
15. **Conectores (administración):** con `CONNECTOR_WEBHOOK_SECRET` en un entorno de pruebas, enviar un webhook firmado de estado y otro de pago desde la pestaña Conectores y comprobar que el mensaje y el pedido cambian y que repetirlo responde «duplicado». No registrar URLs de webhook en proveedores reales sin instrucción expresa.
16. **Evaluación:** en Catálogo → Evaluación ejecutar el banco de una marca de pruebas antes y después de cambiar conocimiento o nivel; revisar los casos que fallan y su motivo. Es la forma de comprobar el motor (y el proveedor de IA, cuando haya clave) sin escribir a clientes.
30. **Etiquetas en la bandeja (equipo):** en un chat abierto pulsar **Etiquetas**, crear «PRUEBA · lista de espera» y guardar; comprobar que el hilo muestra la etiqueta en la bandeja y en el encabezado del chat, que aparece el selector «Todas las etiquetas» y que al elegirla sólo quedan los hilos de esa etiqueta; quitarla desde el mismo botón y comprobar que el hilo sale del filtro. Como asesora de otra marca, comprobar que no ve la etiqueta ni esos hilos. Borrar o dejar sin uso la etiqueta de prueba al terminar.
29. **Respuestas rápidas y Recordarme (equipo):** en Mi configuración → Respuestas rápidas crear una personal (por ejemplo `/gracias` con `{{nombre}}` y `{{curso}}`); en un chat abierto escribir `/gr`, comprobar que aparece el menú, elegirla con Enter y que el texto queda en el compositor con el nombre del cliente **sin enviarse**; probar flechas, Escape y el botón **Respuestas**; pulsar **Recordarme → En 1 hora** y ver la tarea en Mi día; como administración crear una compartida de la marca de pruebas y comprobar que otra asesora de esa marca la ve y que una de otra marca no. En celular, el menú cabe en pantalla y los botones se tocan con comodidad.
28. **Notificaciones push (cada persona del equipo):** en Mi configuración → «Notificaciones en este dispositivo» pulsar **Activar** y conceder el permiso; **Enviar prueba** debe mostrar la notificación en segundos. Desde otra cuenta asignar un chat a esa persona y, **sin abrir el CRM** en su dispositivo, comprobar que llega el aviso unos 20 s después; tocarlo abre o enfoca el CRM. Quitar un grupo en las preferencias y comprobar que ese tipo de aviso ya no llega. En un iPhone, instalar primero la app en la pantalla de inicio. Probar también **Instalar app** en escritorio.
27. **Rendimiento del equipo (administración):** al final de «Mis resultados» comprobar una fila por persona con ventas netas iguales a las de Finanzas, que «Ver» abre el portal de esa persona y que el filtro de marca cambia las filas; una asesora que abra la dirección `/api/portal/team` debe recibir 403.
26. **Portal por roles:** con una persona de prueba que tenga ventas en el libro, oportunidades a su nombre y una apertura asignada como responsable, abrir «Mis resultados» y comprobar que las cifras coinciden con Finanzas (ventas netas, comisión pendiente), que los avisos de la apertura aparecen y que otra persona del equipo no ve nada de lo ajeno; como administración, usar «Ver a» para revisar a esa persona.
25. **Campañas (administración):** en una marca de pruebas encender Seguimientos y, en Operación → Campañas, las campañas de la marca; crear una campaña con una plantilla aprobada y un segmento acotado (por ejemplo etiqueta o etapa), calcular la vista previa (comprobar que explica las exclusiones y que el mensaje usa la oferta vigente), programar confirmando el número y verificar enviados, respuestas y bajas en el detalle; cancelar una programada. Usar sólo registros propios identificados y cerrar al terminar.
24. **Históricos IPCIL (administración):** en Operación → Históricos pegar el ejemplo del formato para una marca de prueba, revisar la vista previa, importar y comprobar en Contactos → Personas la sección «Históricos IPCIL» de la persona creada y en Finanzas el bloque «Históricos IPCIL» del periodo; quitar el lote al terminar.
23. **Núcleo compartido (administración):** en Operación → Conectores comprobar el panel «Núcleo compartido» en modo simulado (sobres recientes tras cualquier acción del laboratorio); cuando existan `CORE_SINK_URL` y `CORE_SINK_SECRET`, «Probar envío» debe responder 2xx y «Reproducir historial» dejar cero entregas sin entrega y cero fallidas en Eventos.
22. **Pagos por sesión y encuestas:** en Catálogo poner precio por sesión a una edición de prueba y activar Pagos; desde un chat de prueba «Cobrar» con plan por sesión y pagar como cliente; en la ficha de la apertura programar dos sesiones, comprobar que la primera queda cubierta y cobrar la segunda («Cobrar sesión»), pagarla como cliente y ver la fila pagada y el libro de Finanzas; condonar una tercera; marcar una sesión realizada y enviar su encuesta, responderla desde el botón del chat y desde el enlace público en celular, y revisar promedios, NPS, comentario y CSV. Cerrar la encuesta y archivar los registros de prueba al terminar.
21. **Contenido:** en Catálogo → Contenido conceder diseño y aprobación a dos personas de prueba; crear como diseño una plantilla de «Pago confirmado» con sus variables, aprobarla como aprobación y mapearla a la marca de pruebas; confirmar un pago de prueba y comprobar que el mensaje al cliente sale de la plantilla; pedir variantes a una plantilla, aceptar una y verla como borrador; generar la ficha de una edición de prueba y guardarla como flyer. Al terminar, quitar las funciones de prueba y pausar los mapas de la marca de pruebas.
20. **Certificados (administración o responsable):** en una apertura de prueba en curso con una sesión realizada y asistencia registrada, emitir desde la ficha de apertura; abrir el enlace de verificación en una ventana sin sesión y comprobar nombre, curso y estado; abrir el SVG y escanear el QR con un teléfono; revocar con motivo y volver a verificar; probar la emisión automática activándola sólo en la marca de pruebas y cerrando la apertura. Desactivar la emisión automática al terminar.
19. **Personas:** en Contactos → Personas buscar a un cliente de prueba que haya escrito a dos marcas y comprobar que una sola ficha reúne ambas; con una sesión de asesora de una sola marca, comprobar que la ficha enseña sólo esa marca; registrar una baja desde la persona y verificar que el contacto de la otra marca queda sin mensajes; como administración revisar «Por revisar» con dos contactos manuales de prueba con el mismo nombre y fusionarlos tras la vista previa. Dejar los registros de prueba identificados.
18. **Finanzas (administración):** fijar una regla de comisión de prueba, devengar pendientes, revisar que la conciliación quede «correcta» y que el total de ventas coincida con el del modo presentación para el mismo periodo; conceder la función de contadora a una persona de prueba y comprobar que ve todas las marcas sin poder cambiar reglas; marcar una liquidación de prueba con nota y registrar un reembolso parcial de un pedido de prueba; descargar los dos CSV e imprimir el resumen. Al terminar, retirar el acceso de prueba y dejar la regla como estaba.
17. **Coordinación y eventos (administración):** en una marca de pruebas con la venta simulada activa, fijar un mínimo en la apertura de una edición de prueba, activar la automatización de coordinación, confirmar pagos de prueba hasta el mínimo y comprobar que la apertura pasa a «abierta» sola y que la persona responsable recibe el aviso; programar una sesión dentro de la ventana de recordatorio y verificar que cada inscrito de prueba recibe un solo recordatorio; registrar asistencia, marcar la sesión realizada y cerrar la apertura; en Operación → Eventos revisar la bitácora y descargar el CSV. Al terminar, desactivar la automatización y dejar la apertura de prueba cerrada o cancelada.

En producción evitar activar/cambiar políticas de marcas existentes para facilitar QA. Registrar la configuración inicial y comprobar que quedó intacta. Los ensayos destructivos, carga y restauración se hacen en entorno aislado.

## Entorno publicado identificado

| Recurso | Identificador / destino |
| --- | --- |
| GitHub | `teccapitalweb/tec-capital-crm-laboratorio`, `main` |
| Railway project | `4990bdfd-0f8c-476d-845f-7d3cf06f771a` |
| Railway environment | `05d52b01-c144-4bbc-a808-a72976138dd9` |
| Railway service | `8f3f8731-eacf-4997-b730-333b29367b50`, nombre `crm-laboratorio` |
| Volumen | `2008791d-8339-4e64-8f2a-64e2e6f4c315`, `conversaciones-y-archivos`, 1024 MB, `/data` |
| Región observada | `us-west2` |
| Despliegue funcional | `df2ce476-2341-4811-a95d-85debc17636b`, `SUCCESS` |
| Creación / activo | `2026-10-31T00:56:16.915Z` / `2026-10-31T00:56:50.082Z` |
| CRM | <https://crm-laboratorio-production.up.railway.app/crm> |
| Cliente | <https://crm-laboratorio-production.up.railway.app/> |
| Health | <https://crm-laboratorio-production.up.railway.app/api/health> |
| CI funcional | <https://github.com/teccapitalweb/tec-capital-crm-laboratorio/actions/runs/41152821918> |

Estos IDs identifican recursos, no conceden acceso. Usa la sesión existente de GitHub/Railway o autenticación propia del usuario; no copies tokens a documentación. Al verificar Railway sólo fue necesario comprobar los nombres de variables, no leer sus valores.

### Dos detalles que deben revisarse antes del siguiente despliegue

- El archivo `railway.json` declara `DOCKERFILE`, mientras que la descripción del servicio devolvió `RAILPACK` como builder. Existe `Dockerfile` con Node 24. No se resolvió cuál prevaleció en la compilación de referencia: inspeccionar los logs/metadatos efectivos antes de cambiar esa configuración. No corregirla por intuición durante una tarea documental.
- La fuente es `main` y la configuración observada tiene `checkSuites: false`: **el despliegue automático no espera necesariamente a CI**. Un push, incluso sólo de documentación, puede disparar Railway. Ejecutar las pruebas antes de publicar código; considerar configurar una puerta de CI en una tarea de infraestructura, después de verificar compatibilidad.

Se observó una instancia, sin cambios de configuración pendientes. Tracing e instrumentación automática estaban desactivados. Verificar de nuevo porque esos estados pueden cambiar.

## Publicación de una entrega funcional

Publicar sólo dentro del alcance autorizado por el usuario. Para el traspaso documental del 30 de octubre el usuario indicó que Claude continuará en **esta misma computadora**: no hace falta push ni despliegue para leer la guía local.

1. Revisar diff y estado. No añadir `.env`, `data/`, `*.sqlite*`, logs, accesos, cookies ni artefactos con información privada. Usar rutas explícitas al añadir archivos a Git.
2. Si hay una nueva versión funcional, mantener coherentes `package.json`, `package-lock.json` y la versión que devuelve health. La documentación sola no requiere aumentar versión.
3. Ejecutar `npm run check` y las pruebas necesarias. Revisar en navegador los flujos modificados y móvil cuando afecte UI.
4. Crear un commit acotado y publicar en la rama acordada cuando esté autorizado. Revisar antes si un push activa el servicio.
5. Esperar el estado final de CI y de Railway. Un commit subido o una compilación iniciada no prueban disponibilidad.
6. Comprobar `/api/health`, versión, origen HTTPS y el bundle/archivos modificados. Health usa una versión declarada: por sí sola no identifica inequívocamente el commit desplegado.
7. Probar el recorrido autenticado relevante con datos propios, incluyendo su aislamiento y recepción por el cliente. Confirmar limpieza operativa de QA.
8. Reportar commit, resultado de pruebas, URL, evidencia publicada y cualquier límite. Actualizar continuidad con el nuevo corte.

El health esperado de referencia:

```json
{"ok":true,"version":"0.34.0","transport":"websocket","mode":"laboratorio"}
```

## Respaldos y recuperación

**Automático (desde la rama de respaldos):** cada 24 h el servidor guarda `backups/auto-*` (SQLite + `manifest.json`) y conserva las últimas 7. Administración puede lanzar uno manual (`POST /api/backups/run`) y listarlos (`GET /api/backups`). **Siguen en el mismo volumen**: copiar `backups/`, `uploads/` y `library/` fuera de Railway es una tarea pendiente.

**Verificar un respaldo:** `node server/verify-backup.mjs <ruta>/backups/auto-… [<ruta>/data]` comprueba integridad, claves foráneas, conteos y que cada adjunto del manifiesto exista con su tamaño.

**Ensayo de restauración (en un entorno aislado):** crear un directorio nuevo, copiar ahí `laboratorio.sqlite` del respaldo más `uploads/` y `library/`, arrancar con `DATA_DIR` apuntando a él y un puerto libre (las migraciones se aplican solas), comprobar acceso, historial y descarga de archivos. Nunca restaurar sobre producción sin decidir qué hacer con los datos posteriores al respaldo.

**Puerta de CI en Railway:** activar «Wait for CI» en el servicio (no se puede fijar desde el repositorio).

Material anterior del runbook:

La copia previa a migración protege SQLite de ese momento. **No existe en esta entrega un respaldo periódico completo ni un ensayo certificado de restauración de producción.** Para recuperar mensajes con archivos hacen falta DB y medios coherentes.

Contenido necesario: SQLite consistente, `uploads/`, `library/` y referencia exacta del código/versión. **Aparte y con otro acceso:** `mfa.key` (o `MFA_KEY`); no va en los respaldos automáticos. Los flyers demo proceden del código. La configuración/secrets se custodian por separado, fuera de Git y del paquete público.

Procedimiento a diseñar y ensayar en entorno aislado:

1. Fijar versión, hora y punto de recuperación; identificar qué escrituras nuevas podrían perderse. No restaurar sobre producción sin decisión explícita sobre esos datos.
2. Generar una copia consistente mediante API de backup SQLite o `VACUUM INTO`. Si se copia a nivel de archivos, detener completamente el proceso y tratar WAL/SHM correctamente; no copiar sólo `laboratorio.sqlite` mientras escribe.
3. Copiar medios de forma coherente. Para un respaldo simple de este laboratorio, una ventana sin escrituras facilita alinear DB y archivos; un sistema continuo necesita coordinación adicional.
4. Guardar fuera del mismo volumen, con acceso restringido, integridad, retención y registro. No confundir `/data/backups/` con protección ante pérdida del volumen.
5. Restaurar primero en otro directorio/entorno, ejecutar `PRAGMA integrity_check` y comprobar `user_version`, claves foráneas y conteos de referencia.
6. Arrancar con el código compatible y origen/puerto de prueba. Verificar login, historial, descarga de adjuntos/flyers y ausencia de ejecución accidental de campañas/trabajos futuros.
7. Documentar resultado y tiempos. Sólo después preparar la recuperación real y su manejo de datos posteriores.

Con v7 el arranque guarda `backups/before-crm-v7-<timestamp>.sqlite` antes de migrar una base con usuarios y esquema < 8 (el v7 no llegó a publicarse por separado). Revertir código no revierte esquema. No ejecutar una versión antigua contra v6 o posteriores sin comprobar compatibilidad. No borrar WAL/SHM manualmente para intentar arreglar una base.

## Verificación en dos pasos: bloqueos y emergencias

- **Una persona perdió su teléfono:** usa uno de sus 10 códigos de recuperación; si no los tiene, otra persona con rol de administración abre **Equipo → Restablecer 2 pasos** y esa persona la configura de nuevo.
- **La única persona administradora quedó bloqueada:** con acceso al entorno del servidor (Railway), añade la variable `MFA_RESET_USER=<usuario>`, redespliega o reinicia, comprueba en el registro de arranque el mensaje «MFA restablecido para @usuario», **retira la variable** y vuelve a activar el 2FA.
- **Tras restaurar un respaldo:** el archivo `DATA_DIR/mfa.key` (o `MFA_KEY`) debe ser el mismo que cuando se activó el 2FA; si no, los 2FA activos fallan y se restablecen como arriba. Esa clave no está en los respaldos automáticos.
- No hay forma de recuperar un secreto olvidado: se restablece y se vuelve a configurar.

## Diagnóstico rápido

| Síntoma | Revisar primero |
| --- | --- |
| Login no persiste | Origen, HTTPS y cookie Secure; sesión/cuenta activa; entorno correcto |
| 403 al guardar | Cabecera `Origin`, rol actual y marca; no deshabilitar autorización para avanzar |
| Reparto no asigna | Reparto habilitado, horario/zona, modo humano, oportunidad abierta, integrantes, permisos, disponibilidad, WebSocket y límite global |
| Objetivo parece incorrecto | Snapshot de política de esa espera, zona IANA, horario hábil y primera respuesta humana; no sólo reloj local |
| Flyer no se puede enviar | Publicación/vigencia del curso y edición, precio/promoción actual, aprobación, binding y caducidad |
| 409 en formulario o macro | Registro actualizado por otra sesión, oferta cambiante o preview antiguo; preservar borrador y recargar/previsualizar |
| Doble efecto tras reintento | Misma `clientRef` de la acción original, misma identidad/destino, transacción y resultado persistido |
| No llega una respuesta del bot | Nivel de la marca (Operación → Seguimientos: apagado o sugerir no envían), modo humano/cierre, trabajos pendientes, logs del worker, catálogo elegible; la bitácora del panel Equipo explica cada decisión |
| Parece que faltan chats | Filtros/alcance, bandeja paginada frente al resumen de 300; revisar búsqueda en servidor |
| Datos desaparecen al redeploy | Montaje `/data`, `DATA_DIR`, servicio/entorno y volumen correctos; no sembrar una base nueva como arreglo |

No imprimir cookies, hashes de contraseña, contenidos de archivos privados o variables secretas en informes. Describe el estado y redacta cualquier evidencia sensible.
