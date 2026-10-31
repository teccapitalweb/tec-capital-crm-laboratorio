# Estado del proyecto y decisiones

Documento de entrega para continuar el CRM sin depender del historial del chat. Corte: **30 de octubre de 2026, America/Mexico_City**; el despliegue de referencia ocurrió el 31 de octubre en UTC.

## Producto y alcance acordado

TEC Capital opera varias consultoras que son marcas de su misma empresa. El objetivo es administrar conversaciones y ventas de cursos de unas 15 marcas, con ocho o más cursos por marca. El laboratorio permite practicar con siete personas o más; no tiene un cupo funcional fijo de siete cuentas, aunque su capacidad comercial todavía necesita medirse.

Cada participante crea un perfil con nombre, usuario, contraseña e identificador de prueba. No necesita su número de WhatsApp. El cliente elige curso, edición y canal simulado y conversa en tiempo real con el equipo. Los asesores pueden trabajar sólo con sus marcas; administración tiene alcance general.

El sitio ya está en Railway. Publicar el código en GitHub no reemplaza el servidor ni la persistencia. Este proyecto no funciona como aplicación completa en GitHub Pages.

La intención futura es conectar WhatsApp, Instagram y Messenger oficiales, responder con plantillas, compartir flyers y usar IA con información comercial vigente. **Ninguna conexión de Meta ni IA está habilitada actualmente.** No conviertas un WhatsApp personal ni migres números como parte de este traspaso documental.

## Identificación de la versión publicada

| Dato | Referencia verificada |
| --- | --- |
| Aplicación | `0.5.0` |
| Commit funcional | `c7218f15d346e08406a96786db68523e78db4877` |
| Esquema esperado | `PRAGMA user_version = 6` |
| Rama remota | `main` |
| Railway deployment | `df2ce476-2341-4811-a95d-85debc17636b`, `SUCCESS` |
| Health | `ok: true`, `version: 0.5.0`, `transport: websocket`, `mode: laboratorio` |
| CI | [Ejecución 41152821918](https://github.com/teccapitalweb/tec-capital-crm-laboratorio/actions/runs/41152821918), correcta |
| Pruebas automáticas | 57 aprobadas, 0 fallidas |

Este commit identifica el código funcional. Un commit posterior que añada únicamente esta documentación no implica una versión funcional diferente.

## Entregas completadas

| Entrega | Commit | Resultado |
| --- | --- | --- |
| Base comercial v0.2 | `cab6e14` | Mi día, contactos, oportunidades, tareas, notas, configuración, permisos por marca, invitaciones y recuperación asistida |
| Primera fase de consolidación v0.3 | `31820df` | Tres regresiones comerciales corregidas, tareas editables, búsqueda de históricos, historial y control de concurrencia |
| Segunda fase v0.4 | `7b19322` | Catálogo por edición, promociones, biblioteca aprobada de flyers/plantillas, oferta y archivo históricos |
| Tercera fase v0.5 | `c7218f1` | Cola, reparto, horarios, capacidad, transferencias, menciones, avisos, objetivos de respuesta y macros |

### Consolidación comercial

- Todas las vistas comerciales consultan la etapa de la oportunidad.
- Preguntar un precio no hace retroceder una inscripción solicitada.
- Las reglas no reabren oportunidades cerradas ni confirman ventas.
- Reabrir un interés cuando ya existe otro activo de ese contacto/curso/edición devuelve un conflicto y permite localizar el vigente.
- Tareas con título, fecha, dueño, estado y motivo de cambio; cancelar, completar, reabrir y reprogramar.
- Búsqueda por persona, número de prueba, marca, curso, edición y texto del historial. La búsqueda no se limita al resumen de 300 conversaciones del bootstrap.

### Catálogo y biblioteca

- Curso general separado de sus ediciones. Fechas, zona horaria, docente, modalidad, lugar, enlace, cupos, moneda y precio por edición.
- Promoción con precio y vigencia propios. Control de solapamiento, precio menor al regular y final anterior o igual al inicio de la edición.
- PNG, JPG, WebP, GIF y PDF de hasta 4 MB; borrador, aprobación interna, archivo, caducidad y versión.
- Variables en plantillas; alcance por marca/curso/edición/canal; flyer opcional; vista previa antes del envío.
- Los seis flyers de demostración se importaron cuando seguían coincidiendo con el catálogo. Cada marca nueva recibe seis plantillas de ejemplo.
- Cambiar datos comerciales invalida la correspondencia de un flyer estático. La imagen no se corrige por OCR: la persona que aprueba debe revisarla.
- Los mensajes conservan el precio, texto, edición y archivo exactos que se compartieron. Los archivos reemplazados permanecen disponibles para su historial.
- El cupo es informativo; no se reserva ni descuenta al cambiar una etapa.

### Operación del equipo

- Cola de atención humana por prioridad, espera, marca y responsable; páginas de 50.
- Reparto por menor carga entre integrantes configurados, conectados, disponibles, autorizados y con capacidad. El desempate considera asignaciones previas y el identificador.
- Límite inicial de ocho chats abiertos por integrante, entre todas sus marcas; administración puede ajustarlo.
- Horarios por marca y zona IANA. Objetivos de primera/siguiente respuesta en minutos hábiles. No se cuenta una lectura o respuesta automática como respuesta humana.
- Transferencias con contexto y aceptación/rechazo/cancelación; vencen a las 24 horas. Los chats abiertos y tareas de una oportunidad se trasladan juntos.
- Notas internas con menciones y avisos persistentes. Los clientes no tienen acceso a estos contenidos.
- Macros manuales que combinan plantilla, avance comercial, tarea y nota; versiones, vista previa y ejecución idempotente en una transacción.
- Historial operativo y versiones de configuración. Los borradores de configuración en edición se protegen frente a actualizaciones en vivo.

El reparto y los objetivos de atención se entregaron **desactivados por defecto**. La prueba publicada no cambió la política de las marcas existentes. Verificar el estado actual antes de activar o modificar algo: el equipo puede haberlo configurado después.

## Decisiones de experiencia

La dirección visual elegida por el usuario es **Niebla**: blanco y gris, transparencias suaves, sombras discretas, contornos finos y colores de canal puntuales. Evitar saturar la interfaz con tarjetas de colores. Mantener legibles los distintivos WhatsApp/Instagram/Facebook.

El puesto del vendedor debe indicar qué atender, quién es responsable y cuál es el siguiente paso. Priorizar acciones útiles y vistas compactas. Revisar tanto teléfono como escritorio; no introducir desplazamiento horizontal accidental en formularios o modales.

Todo texto operativo está en español. La simulación debe seguir siendo explícita: “Ganada · prueba” no confirma dinero, inscripción ni entrega de acceso.

## Evidencia de v0.5

Las 57 pruebas de Node cubren mensajería de siete clientes, persistencia, accesos, archivos, catálogo, concurrencia, historial, reparto y macros. CI ejecutó la misma suite en Linux con Node 24.

La revisión local en Edge/Playwright completó configuración de horario/capacidad, cola, nota con mención, transferencia entre dos asesores, creación y aplicación de macro y lectura del cliente. Se revisaron escritorio y ancho móvil de 390 px, sin errores de JavaScript en ese recorrido. Se comprobó que una actualización en vivo no borra el formulario de horario en edición.

En la web publicada se comprobó:

- Bundle público coincidente con el código local.
- Entrada autenticada de administración, dos asesores y un cliente de prueba.
- Solicitud de asesor, toma, nota privada, aviso y transferencia aceptada.
- Vista previa/aplicación de macro, reintento sin duplicados, tarea asignada y mensaje al cliente en tiempo real.
- Registro de respuesta humana, historial y aislamiento de marca/cliente.
- Vista móvil y conservación de la configuración existente.

Al terminar, se pausó la macro técnica, se cerraron oportunidad/chat/tareas y se suspendieron las dos cuentas técnicas de asesor retirando sus marcas. Los registros históricos de QA permanecen deliberadamente; no son ventas ni actividad de clientes reales. Las pruebas no certifican carga comercial, seguridad completa o recuperación de producción.

## Avance local posterior a v0.5: bloques 4A y 4B (31 oct 2026)

Sin publicar ni desplegar; los cambios están en el árbol de trabajo, sin confirmar en Git. Añade el esquema v7 y el motor de pasos durables descrito en [PLAN_FASE_4.md](PLAN_FASE_4.md#4a-implementado-local-31-oct-2026). La versión se subió a `0.6.0` para publicar (ver estado de publicación abajo). Verificación local: `npm run check` y `npm test` con 79 pruebas aprobadas (dos ejecuciones completas seguidas tras añadir 4B; 69 con sólo 4A). En una ejecución anterior falló una vez la prueba de catálogo «vencimientos y material programado…» (espera fija de 1,2 s al trabajo de reglas, en paralelo con el resto de la suite) y no se reprodujo en 6 repeticiones; probable sensibilidad de tiempo bajo carga, no diagnosticada. 4B añade recetas de seguimiento por silencio (esquema v8, ver PLAN_FASE_4); sin interfaz todavía. Tres pruebas existentes se actualizaron de `user_version` 6 a 8. No hay cambios de interfaz, así que no se revisó navegador; tampoco se probó contra Railway.

### Corrección visual: ancho completo en pantallas grandes (31 oct 2026)

El usuario reportó franjas vacías a ambos lados del CRM en su monitor (~1890 px de ancho). Diagnóstico: `.workspace` tenía `max-width:1800px` centrado con bordes laterales, por lo que cualquier ventana mayor de 1800 px dejaba (ancho − 1800)/2 px libres por lado. Se quitó el límite y los bordes en `public/styles.css`. Verificado en navegador emulando 1900 px: el contenedor ocupa 1900 px, sin margen ni desplazamiento horizontal; las 79 pruebas siguen pasando. No se revisó de nuevo móvil ni tableta (el cambio sólo actúa por encima de 1800 px). **Sólo local:** el sitio publicado conserva las franjas hasta el próximo despliegue. Otros límites de ancho existentes (`.entry` 1320 px en el acceso y los de contenido de CRM/catálogo) no se tocaron.

## Publicación v0.6.0 (31 oct 2026)

Publicado por instrucción expresa del usuario: rama `main`, commit funcional `3348ab3` (incluye los commits de 4A/4B, el ajuste de ancho completo y la subida de versión; también el commit documental `9baf1ff`, que hasta entonces sólo existía en local). Esquema esperado: **8**. CI [41222480776](https://github.com/teccapitalweb/tec-capital-crm-laboratorio/actions/runs/41222480776): correcto, 79 pruebas. Railway desplegó automáticamente; `/api/health` devuelve `version: 0.6.0`.

Comprobado en la web publicada, sin iniciar sesión: health 0.6.0; `/recipes.js`, `/recipes.css` y `/operations.js` se sirven con su tipo correcto; `/api/automation` responde 401 sin sesión; el CSS publicado ya no contiene el límite de 1800 px. **No comprobado:** el arranque de la migración v8 sobre la base real (el health sólo prueba que el proceso responde; el respaldo `before-crm-v8-*` debería existir en `/data/backups/`), ni el flujo autenticado de Seguimientos en producción, ni los datos existentes tras migrar. Todo queda desactivado por defecto (ninguna marca tiene la automatización habilitada). Pendiente al retomar: una verificación autenticada con registros de prueba identificados y limpieza al terminar.

## Respaldos periódicos e importación de catálogo (rama `feat/respaldos-e-importacion`, local, 31 oct 2026)

Segundo bloque de mejoras tras v0.6.0. **Sin publicar.** Pruebas locales: 87 aprobadas en dos ejecuciones completas seguidas.

- **Respaldos automáticos** (`server/backup.mjs`): copia consistente de SQLite con `VACUUM INTO` en `DATA_DIR/backups/auto-<AAAAMMDDTHHMMSSZ>/` junto con `manifest.json` (versión, esquema, conteos y lista de adjuntos con tamaño). Se verifica antes de publicarse la copia (integridad, claves foráneas, conteos); una copia que falla se descarta. Cada 24 h por defecto y se conservan las últimas 7 (`BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`; `0` desactiva; en `NODE_ENV=test` están desactivados salvo que se indique). Las copias `before-crm-v*` de migración no se rotan.
- **Verificación y ensayo de restauración:** `node server/verify-backup.mjs <carpeta-del-respaldo> [directorio-de-datos]` (código 0 correcto, 1 con problemas). Una prueba restaura la copia en un directorio nuevo, la abre con las migraciones y comprueba datos e integridad.
- **API de administración:** `GET /api/backups` (lista) y `POST /api/backups/run` (respaldo manual). No hay descarga por HTTP a propósito: exponer la base por la web sería un riesgo.
- **Límite que sigue vigente:** los respaldos viven en el mismo volumen de Railway. **No protegen contra pérdida del volumen.** Falta decidir y automatizar una copia fuera del volumen (con `uploads/` y `library/`).
- **Importación de catálogo por CSV** (`server/catalogue-import.mjs`, `public/catalogue-import.js`): botón «Importar CSV» en el catálogo (administración). Una fila por edición con curso, temario, fechas locales en su zona IANA, precio, cupo y una promoción opcional. La vista previa valida sin escribir nada y muestra qué se crearía y los errores por fila; aplicar exige el hash de la vista previa. La aplicación usa las mismas rutas del catálogo (misma validación, historial y revisiones), es idempotente (curso por marca+título, edición por curso+nombre y promoción por edición+nombre; lo existente no se modifica) y cada fila falla por separado. Un curso nuevo reutiliza su edición inicial en lugar de dejar una vacía. Máximo 500 filas y 1 MB.
- **Limitaciones conocidas de la importación:** no crea marcas (deben existir), no modifica registros existentes, no importa plantillas ni flyers, y un curso puede quedar creado aunque su edición falle (se informa por fila y repetir el archivo lo completa). Línea indicada en errores = línea física del archivo.
- **Prueba estabilizada:** la de catálogo «vencimientos y material programado…» ahora espera por sondeo (hasta 10 s) en vez de 1,2 s fijos.
- **Puerta de CI antes de desplegar: no configurable desde el repositorio.** En Railway, servicio `crm-laboratorio` → Settings → Deploy, activar «Wait for CI» (checkSuites) para que un push con pruebas fallidas no se despliegue. Pendiente de que el usuario o alguien con acceso a Railway lo active; mientras tanto, ejecutar las pruebas antes de cada push.

## Publicación v0.7.0 (31 oct 2026)

Publicado por instrucción expresa del usuario: `main`, commit funcional `0be723a` (respaldos automáticos verificados, importación CSV del catálogo y prueba estabilizada). Esquema sin cambios (8). CI [41225391778](https://github.com/teccapitalweb/tec-capital-crm-laboratorio/actions/runs/41225391778): correcto, 87 pruebas. `/api/health` devuelve `0.7.0`.

Comprobado en la web publicada sin iniciar sesión: versión 0.7.0; `/catalogue-import.js`, `/catalogue.css` y `/recipes.js` responden 200; `/api/backups` y `/api/catalogue/import/template` responden 401 sin sesión. **No comprobado:** que el primer respaldo automático se creara en `/data/backups/auto-*` (se programa 5 s después del arranque), ni la importación y Seguimientos con sesión de administración. Los respaldos siguen en el mismo volumen.

## Contactos: etiquetas, duplicados, fusión y exportación (rama `feat/contactos-etiquetas-fusion`, local, 31 oct 2026)

Esquema **v9**, aditivo (`server/contacts-schema.mjs`, `server/contacts.mjs`, `public/contacts.js`). **Sin publicar.**

- **Etiquetas por marca:** nombre de hasta 30 caracteres, único por marca sin distinguir mayúsculas ni acentos (el mismo nombre puede existir en otra marca), seis colores sobrios (neutral, azul, verde, ámbar, rojo, violeta), máximo 100 por marca y 12 por contacto. El equipo con acceso a la marca las crea y las asigna (`PUT /api/crm/contacts/:id/tags` reemplaza el conjunto, es idempotente); sólo administración las renombra o elimina (eliminar quita sus vínculos). Las etiquetas de otra marca se rechazan. Filtro por etiqueta en la lista de Contactos.
- **Duplicados:** `GET /api/crm/duplicates?brand=` agrupa por teléfono (últimos 10 dígitos, mínimo 7), correo (sin distinguir mayúsculas) y nombre completo de dos o más palabras (sin acentos). Visible para el equipo de esa marca; máximo 100 grupos.
- **Fusión (sólo administración):** `POST /api/crm/contacts/merge-preview` y `/merge`. La vista previa muestra qué se mueve (intereses, notas, etiquetas) y qué datos se completan; aplicar exige `previewToken` (si cualquiera de los dos contactos o sus intereses cambió, devuelve 409). Se mueven oportunidades (con sus tareas y chats), notas y etiquetas; el teléfono y el correo de la ficha principal se completan sólo si estaban vacíos; la ficha eliminada queda guardada en `contact_merges` y se agrega una nota interna con lo unido. **Bloqueos de seguridad:** no se fusionan dos fichas vinculadas a perfiles distintos; si una está vinculada a un perfil, esa debe ser la principal (para no romper el vínculo de sus conversaciones); si ambas tienen un interés activo en el mismo curso y edición, hay que cerrar uno antes. La fusión no se deshace desde la interfaz (el snapshot permite una recuperación manual).
- **Exportación CSV (sólo administración):** `GET /api/crm/export/contacts.csv` (filtros `brand` y `tag`) y `/opportunities.csv`, UTF-8 con BOM, máximo 20 000 filas, sólo marcas autorizadas, `Cache-Control: no-store` y registro en auditoría. Las celdas que empiezan con `=`, `+`, `-`, `@` o tabulación se neutralizan con una comilla para evitar inyección de fórmulas en Excel/Sheets. Contiene datos personales: cuidado al compartirlos.
- **Interfaz:** en Contactos, columna Etiquetas, filtro por etiqueta y botones Duplicados y Exportar (administración); la ficha tiene el editor de etiquetas; fusión en dos pasos (elegir cuál conservar → revisar → confirmar). Revisada en navegador (escritorio y 390 px, sin desbordamiento de la página; la tabla ya se desplazaba horizontalmente dentro de su contenedor en móvil).
- **Pruebas:** `test/contacts.test.mjs` (7, servidor real) cubre permisos por marca, unicidad, límites, duplicados, fusión (token obsoleto, conflictos, perfil vinculado, datos movidos, repetir) y exportación (fórmulas, filtros, BOM, auditoría). Las pruebas de esquema de CRM/seguimiento/operación esperan ahora `user_version` 9.
- **Verificación:** 94 pruebas aprobadas. Una ejecución completa aislada falló en la prueba de operación «avisos con la misma fecha…» (y su suite contenedora) y no se reprodujo en 14 ejecuciones completas posteriores, 6 de ellas con carga doble; no se capturó el detalle del fallo, así que es una **intermitencia sin diagnosticar** (la de catálogo ya se estabilizó). Si reaparece, guardar la salida completa de `npm test`.
- **Pendiente:** fusión de más de dos fichas en un paso, importación de contactos, etiquetas en la bandeja de conversaciones y en filtros de oportunidades, deshacer fusión, exportación programada, límites de frecuencia de exportación.

## Publicación v0.8.0 (31 oct 2026)

Publicado por instrucción expresa del usuario: `main`, commit funcional `3a6899c` (contactos: etiquetas, duplicados, fusión y exportación; esquema **9**). CI [41226787988](https://github.com/teccapitalweb/tec-capital-crm-laboratorio/actions/runs/41226787988): correcto, 94 pruebas. `/api/health` devuelve `0.8.0`.

Comprobado en la web publicada sin iniciar sesión: versión 0.8.0; `/contacts.js`, `/crm.js` y `/crm.css` responden 200; `/api/crm/tags` y `/api/crm/export/contacts.csv` responden 401 sin sesión. **No comprobado:** que la migración v9 se aplicara y dejara su copia `before-crm-v9-*`, que existan respaldos automáticos `auto-*` en `/data/backups/`, y el flujo autenticado (etiquetas, fusión, exportación, importación de catálogo, Seguimientos) en producción. Sigue pendiente la verificación autenticada con registros de prueba identificados, la puerta «Wait for CI» de Railway y una copia de respaldos fuera del volumen.

## Analítica comercial (rama `feat/analitica-comercial`, local, 31 oct 2026)

Sin cambios de esquema (sigue en 9). `server/analytics.mjs`, `public/analytics.js`, `public/analytics.css`; nueva entrada **Analítica** en el menú del equipo. **Sin publicar.**

- **API:** `GET /api/analytics?days=7|30|90|365&brand=&tz=` (equipo de atención; `days` 1–366, `tz` IANA, por defecto America/Mexico_City). Todo se calcula sólo sobre las marcas autorizadas de quien consulta; una marca no autorizada devuelve 404.
- **Definiciones (importantes para interpretar los números):**
  - *Embudo* = **cohorte**: oportunidades **creadas** en el periodo y hasta dónde llegaron (por su etapa actual o por cualquier cambio de etapa registrado en `crm_events`). Conversión = ganadas / creadas de esa cohorte. «Perdidas» y «abiertas» salen de la etapa actual.
  - *Ventas y no continuaron del periodo* (KPI «Ventas de práctica» y tendencia) = cambios de etapa **ocurridos** en el periodo, aunque la oportunidad sea de una cohorte anterior; por eso pueden diferir del embudo. Las ventas son de práctica: no confirman dinero ni matrícula.
  - *Atención humana*: de los eventos `response` de operación (espera desde que el cliente quedó esperando hasta la respuesta humana): mediana y p90 de primera respuesta y de siguientes, y % dentro del objetivo (sólo cuenta los que tenían objetivo activo). Son tiempos de **reloj**, no descuentan horario laboral.
  - *Canales*: conversaciones creadas en el periodo por canal y cuántas están vinculadas a una oportunidad ganada.
  - *Tendencia*: conversaciones, oportunidades y ventas por día en la zona indicada (se agrupa por semana si el periodo supera 90 días).
  - *Desempeño por persona*: oportunidades creadas/ganadas/perdidas según su responsable **actual**, tareas, respuestas humanas. **Administración ve a todo el equipo; cada asesor ve únicamente su propia fila** (`agentsScope: propio`), aunque los agregados de marca sí los ve.
  - *Seguimientos automáticos*: ejecuciones de recetas del periodo por estado.
- **Interfaz:** KPIs, embudo con barras, gráfica de actividad diaria (SVG propio, sin librerías), atención humana, tareas, por marca y por curso (15 cursos principales), canales, motivos de pérdida, equipo y seguimientos automáticos. Selector de periodo; sigue el selector de marca del CRM. Revisada en navegador en escritorio y 390 px sin desbordamiento ni errores de consola nuevos.
- **Pruebas:** `test/analytics.test.mjs` (4): embudo y resultados con datos controlados, tiempos y objetivo, privacidad por asesor, permisos por marca, validación de parámetros y rutas.
- **Límites:** los cálculos se hacen en el momento sobre SQLite (suficiente para el laboratorio; con grandes volúmenes habrá que precalcular o indexar). Sin comparación contra el periodo anterior, sin exportación de reportes, sin horario laboral en los tiempos, y sin valor monetario de pipeline.

## Publicación v0.9.0 (31 oct 2026)

Publicado por instrucción expresa del usuario: `main`, commit funcional `1e811a7` (analítica comercial; esquema sin cambios, **9**). CI [41227579873](https://github.com/teccapitalweb/tec-capital-crm-laboratorio/actions/runs/41227579873): correcto, 98 pruebas. `/api/health` devuelve `0.9.0`.

Comprobado en la web publicada sin iniciar sesión: versión 0.9.0; `/analytics.js`, `/analytics.css` y `/app.js` responden 200; `/api/analytics` responde 401 sin sesión. **No comprobado:** la pantalla Analítica con datos reales de producción y con sesión de administración y de asesor (privacidad por persona), ni los puntos pendientes de v0.8.0 (migración v9, respaldos `auto-*`, flujos autenticados de contactos, importación y Seguimientos).

## Consentimiento, baja y tope de frecuencia (rama `feat/consentimiento-y-baja`, local, 31 oct 2026)

Esquema **v10**, aditivo (`contact_consent`, `contact_consent_events` en `server/contacts-schema.mjs`; lógica en `server/contacts.mjs`). **Sin publicar.** Es el requisito previo que `PLAN_FASE_4.md` pedía antes de cualquier seguimiento proactivo.

- **Estados por contacto:** `unknown` (sin registro, el valor por omisión), `opted_in` (aceptó recibir mensajes) y `opted_out` (pidió la baja), con historial (quién, cuándo, fuente y nota). Fuentes: `staff`, `customer_message` y `merge`.
- **API:** `GET/PUT /api/crm/contacts/:id/consent`. El equipo con acceso a la marca registra consentimiento o baja. **Una baja no la revierte un asesor:** sólo administración, con un motivo de al menos 5 caracteres.
- **Baja pedida por el cliente:** un mensaje corto y claro («BAJA», «STOP», «quiero darme de baja», «no quiero recibir más mensajes», «deja de escribirme», «no me escriban más»…) registra la baja automáticamente, el sistema confirma una vez al cliente que no volverá a enviarle seguimientos y se cancelan los pasos automáticos pendientes de ese contacto (`contact_opted_out`). La detección se limita a mensajes de hasta 120 caracteres y evita frases ambiguas («dar de baja un curso», «cancelar»): puede no reconocer pedidos redactados de otra forma, por lo que el equipo debe seguir registrando bajas a mano. Es una heurística, no una garantía legal.
- **Recetas:** la acción de enviar plantilla se bloquea si el contacto pidió la baja (`contact_opted_out`); la condición opcional «sólo con consentimiento registrado» (`requireConsent`) además exige `opted_in` (`no_consent`). Tarea y aviso interno no se bloquean, porque no escriben al cliente. Se evalúa al programar, en la simulación y justo antes del efecto.
- **Tope de frecuencia:** máximo 2 mensajes automáticos de recetas por contacto en 24 h entre todas sus conversaciones (`frequency_limit`; constante en `recipes.mjs`, todavía no configurable por marca).
- **Fusión de contactos:** la ficha principal hereda el estado más restrictivo y el historial; no se pierde una baja al fusionar.
- **Exportación:** nueva columna `consentimiento` (`sin_registro`, `acepta`, `no_desea`).
- **Interfaz:** bloque «Comunicaciones» en la ficha (estado, nota, historial, registrar consentimiento o baja; reactivación sólo administración) y casilla en el formulario de recetas.
- **Pruebas:** `test/consent.test.mjs` (3): detección de bajas con casos positivos y negativos, recetas (baja, consentimiento exigido, frecuencia, cancelación de pasos pendientes) y API completa con baja por mensaje del cliente, fusión y exportación. Las pruebas de esquema esperan `user_version` 10.
- **Pendiente:** consentimiento por canal (WhatsApp/Instagram/Facebook), caducidad y evidencia (texto del aviso aceptado), reglas de ventana de mensajería de Meta (se verificarán al integrar), envío de difusiones, configuración del tope por marca, y revisar con asesoría legal las políticas de consentimiento y retención antes de clientes reales.

## Publicación v0.10.0 (31 oct 2026)

Publicado por instrucción expresa del usuario: `main`, commit funcional `1c3f17c` (consentimiento, baja y tope de frecuencia; esquema **10**). CI [41228622286](https://github.com/teccapitalweb/tec-capital-crm-laboratorio/actions/runs/41228622286): correcto, 101 pruebas. `/api/health` devuelve `0.10.0`.

Comprobado en la web publicada sin iniciar sesión: versión 0.10.0; `/contacts.js`, `/recipes.js` y `/crm.css` responden 200; `/api/crm/contacts/:id/consent` responde 401 sin sesión. **No comprobado:** que la migración v10 se aplicara y dejara su copia `before-crm-v10-*`, el bloque «Comunicaciones» y la baja por mensaje con sesión real, ni los pendientes acumulados desde v0.8.0 (respaldos `auto-*`, flujos autenticados de contactos, importación, Seguimientos y Analítica). **Cinco versiones publicadas (0.6 a 0.10) sin verificación autenticada en producción.**

## Disparadores nuevos de recetas (rama `feat/disparadores-recetas`, local, 31 oct 2026)

Sin cambios de esquema (sigue en 10): la definición de la receta ya era JSON. Cambios en `server/recipes.mjs` y en la pestaña Seguimientos. **Sin publicar.**

- **Tres disparadores:** `silence` (sin cambios), `task_overdue` («una tarea lleva N minutos vencida») y `waiting_human` («un chat lleva N minutos esperando a una persona»). Minutos de 5 a 43 200.
- **Los dos nuevos son escaladas internas:** sólo admiten acciones de **tarea** y **aviso**; la plantilla (mensaje al cliente) se rechaza al crear la receta, y la condición de consentimiento no aplica. Los avisos de una escalada llegan al responsable de la oportunidad o del chat **y** a administración.
- **`task_overdue`:** candidata cada tarea abierta cuyo vencimiento + N minutos cae después de la publicación (no retroactivo) y dentro de la última semana. Se vincula al chat más reciente de la oportunidad (si no tiene chat, no se programa). Se cancela si la tarea se cierra (`task_closed`) o se reprograma (`task_rescheduled`; la nueva fecha genera una ejecución nueva). **Las tareas creadas por recetas no vuelven a escalar** (evita cadenas infinitas; se detectó con la prueba).
- **`waiting_human`:** usa `service_state.waiting_since` de operación. Se cancela si una persona ya lo atendió (`attended`) o se cierra la conversación; una espera nueva en el mismo chat genera su propia escalada.
- **Simulación:** funciona con una conversación elegida: para `task_overdue` evalúa la primera tarea abierta de su oportunidad; para `waiting_human` el estado de espera del chat. Muestra la hora prevista y las condiciones; no escribe nada.
- **Interfaz:** selector «Cuándo se activa» en el formulario; para las escaladas se ocultan la plantilla y el consentimiento y cambia la etiqueta de minutos. Revisada en navegador (escritorio y 390 px, sin desbordamiento).
- **Pruebas:** `test/triggers.test.mjs` (4): validación, no retroactividad, cancelaciones, reprogramación, espera atendida y simulación sin escribir. Las recetas de silencio no cambiaron y siguen pasando sus pruebas.
- **Pendiente:** esperas entre acciones (secuencias de varios pasos con espera, que exigen un modelo de ejecución con varios pasos por corrida), disparadores de inscripción solicitada y de información, tope de frecuencia configurable por marca, y revalidar que el responsable sigue autorizado en la marca.

## Pendientes reales

0b. **Recetas:** esperas entre acciones (secuencias), disparadores de inscripción/información y oportunidad estancada.
0. **Verificación autenticada de v0.6.0 en producción** (migración v8, respaldo `before-crm-v8-*`, pestaña Seguimientos) con registros de prueba identificados; requiere que el usuario inicie sesión en el navegador.
1. **Fase 4:** 4A y primera entrega de 4B hechos localmente (motor durable y recetas por silencio, API sin interfaz, sin publicar); faltan interfaz y más disparadores de 4B, conocimiento aprobado, evaluación y copiloto. Ver [plan detallado](PLAN_FASE_4.md).
2. **Canales oficiales:** activos de Meta, permisos, webhooks, estados del proveedor y políticas/ventanas vigentes, a verificar al implementar.
3. **Venta real:** pedido, pago, conciliación, matrícula y acceso conectados con los sistemas autorizados.
4. **Catálogo comercial:** las marcas/cursos/fechas reales, sus responsables y piezas aprobadas todavía deben cargarse y validarse.
5. **Operación ampliada:** festivos y turnos personales, etiquetas, deduplicación/fusión de contactos, exportación, supervisores y permisos más detallados.
6. **Antes de clientes reales:** MFA, recuperación de administración, retención, consentimiento, cuotas, observabilidad, respaldo periódico con adjuntos y restauración ensayada.

Los documentos de auditoría antiguos contienen diagnósticos anteriores a estas entregas. Sirven para entender el plan, pero sus listas de carencias no son el inventario actual.
