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
| `ADMIN_INVITE_CODE` | Secreto aleatorio privado para inicializar una instalación vacía | Sólo permite crear el primer administrador |
| `STAFF_INVITE_CODE` | No usar | Variable heredada, sin efecto desde v0.2 |

No hay claves de IA/Meta necesarias para esta versión. Generar un código inicial no crea automáticamente un usuario: en una base vacía se registra la primera cuenta con ese código. Una base que ya tiene administrador no concede más administradores por repetirlo.

Los clientes se registran sin código. Los asesores aceptan invitación individual para su usuario exacto, emitida desde Equipo por administración. Una cuenta de cliente puede aceptar esa invitación conservando sus chats. No eleves roles por SQL para resolver una prueba ordinaria.

## Pruebas reproducibles en el repositorio

`npm run check` comprueba sintaxis; no es un linter ni una compilación. `npm test` usa `node --test test/*.test.mjs`, servidores/base temporales y datos ficticios. La referencia funcional v0.5 aprobó **57 pruebas, cero fallos**; con el bloque local 4A son **101** (ver nota de intermitencia en CONTINUIDAD). Tras un cambio hay que comprobar el nuevo resultado, no citar automáticamente el anterior.

| Archivo | Qué protege |
| --- | --- |
| `test/laboratorio.test.mjs` | Siete clientes, tiempo real, alcance por usuario, origen, adjuntos, idempotencia, lectura, toma humana, sesiones y persistencia |
| `test/catalog.test.mjs` | Ampliación inicial de cursos/flyers sin sobrescribir cursos editados ni conversaciones |
| `test/crm.test.mjs` | Invitaciones, alcance por marca, intereses/tareas, revocación, recuperación y migración |
| `test/followup.test.mjs` | Tres regresiones comerciales, revisiones concurrentes, edición/historial de tareas, búsqueda fuera de 300 chats y migración |
| `test/catalogue.test.mjs` | Ediciones, fechas, centavos, promociones, variables, aprobación, permisos, vistas previas, archivo, snapshots/bytes históricos y reinicio |
| `test/automation.test.mjs` | Motor 4A: migración v7, idempotencia, reintentos, reinicio, carreras de cancelación y pausas (sin servidor; base temporal) |
| `test/automation-http.test.mjs` | Rutas `/api/automation`: sólo administración, revisiones, pausa global (servidor temporal) |
| `test/consent.test.mjs` | Consentimiento y baja: detección, bloqueo en recetas, tope de frecuencia, API, fusión y exportación |
| `test/analytics.test.mjs` | Analítica: embudo, resultados, tiempos de respuesta, privacidad por asesor, permisos y API |
| `test/contacts.test.mjs` | Etiquetas, duplicados, fusión con vista previa y exportación CSV (servidor real) |
| `test/backup.test.mjs` | Respaldo con manifiesto, rotación, programación, detección de adjuntos perdidos/base dañada, ensayo de restauración y rutas |
| `test/catalogue-import.test.mjs` | CSV (comillas, saltos, BOM), fechas por zona IANA, vista previa sin escritura, aplicación idempotente y errores por fila |
| `test/recipes.test.mjs`, `test/recipes-http.test.mjs` | Recetas 4B: validación, simulación sin efectos, no retroactividad, cancelaciones, versiones, ejecución real por API |
| `test/operations.test.mjs` | Minutos hábiles/DST, reparto, presencia, carga, transferencia conjunta, menciones, SLA, macros atómicas, paginación, revocación y reinicio |

Para iterar en un módulo puede ejecutarse, por ejemplo, `node --test test/operations.test.mjs`. Antes de una entrega funcional, ejecutar la suite pertinente y la regresión completa; no ampliar repetidamente las pruebas sin cambios o dudas nuevas.

Las pruebas automatizadas del repositorio no ejecutan navegador ni demuestran que Railway tenga ese código. La revisión local y la publicada son evidencias diferentes.

## Recorrido de aceptación en navegador

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
{"ok":true,"version":"0.9.0","transport":"websocket","mode":"laboratorio"}
```

## Respaldos y recuperación

**Automático (desde la rama de respaldos):** cada 24 h el servidor guarda `backups/auto-*` (SQLite + `manifest.json`) y conserva las últimas 7. Administración puede lanzar uno manual (`POST /api/backups/run`) y listarlos (`GET /api/backups`). **Siguen en el mismo volumen**: copiar `backups/`, `uploads/` y `library/` fuera de Railway es una tarea pendiente.

**Verificar un respaldo:** `node server/verify-backup.mjs <ruta>/backups/auto-… [<ruta>/data]` comprueba integridad, claves foráneas, conteos y que cada adjunto del manifiesto exista con su tamaño.

**Ensayo de restauración (en un entorno aislado):** crear un directorio nuevo, copiar ahí `laboratorio.sqlite` del respaldo más `uploads/` y `library/`, arrancar con `DATA_DIR` apuntando a él y un puerto libre (las migraciones se aplican solas), comprobar acceso, historial y descarga de archivos. Nunca restaurar sobre producción sin decidir qué hacer con los datos posteriores al respaldo.

**Puerta de CI en Railway:** activar «Wait for CI» en el servicio (no se puede fijar desde el repositorio).

Material anterior del runbook:

La copia previa a migración protege SQLite de ese momento. **No existe en esta entrega un respaldo periódico completo ni un ensayo certificado de restauración de producción.** Para recuperar mensajes con archivos hacen falta DB y medios coherentes.

Contenido necesario: SQLite consistente, `uploads/`, `library/` y referencia exacta del código/versión. Los flyers demo proceden del código. La configuración/secrets se custodian por separado, fuera de Git y del paquete público.

Procedimiento a diseñar y ensayar en entorno aislado:

1. Fijar versión, hora y punto de recuperación; identificar qué escrituras nuevas podrían perderse. No restaurar sobre producción sin decisión explícita sobre esos datos.
2. Generar una copia consistente mediante API de backup SQLite o `VACUUM INTO`. Si se copia a nivel de archivos, detener completamente el proceso y tratar WAL/SHM correctamente; no copiar sólo `laboratorio.sqlite` mientras escribe.
3. Copiar medios de forma coherente. Para un respaldo simple de este laboratorio, una ventana sin escrituras facilita alinear DB y archivos; un sistema continuo necesita coordinación adicional.
4. Guardar fuera del mismo volumen, con acceso restringido, integridad, retención y registro. No confundir `/data/backups/` con protección ante pérdida del volumen.
5. Restaurar primero en otro directorio/entorno, ejecutar `PRAGMA integrity_check` y comprobar `user_version`, claves foráneas y conteos de referencia.
6. Arrancar con el código compatible y origen/puerto de prueba. Verificar login, historial, descarga de adjuntos/flyers y ausencia de ejecución accidental de campañas/trabajos futuros.
7. Documentar resultado y tiempos. Sólo después preparar la recuperación real y su manejo de datos posteriores.

Con v7 el arranque guarda `backups/before-crm-v7-<timestamp>.sqlite` antes de migrar una base con usuarios y esquema < 8 (el v7 no llegó a publicarse por separado). Revertir código no revierte esquema. No ejecutar una versión antigua contra v6 o posteriores sin comprobar compatibilidad. No borrar WAL/SHM manualmente para intentar arreglar una base.

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
| No llega una respuesta del bot | Modo humano/cierre, trabajos pendientes, logs del worker, catálogo elegible; la IA no existe aún |
| Parece que faltan chats | Filtros/alcance, bandeja paginada frente al resumen de 300; revisar búsqueda en servidor |
| Datos desaparecen al redeploy | Montaje `/data`, `DATA_DIR`, servicio/entorno y volumen correctos; no sembrar una base nueva como arreglo |

No imprimir cookies, hashes de contraseña, contenidos de archivos privados o variables secretas en informes. Describe el estado y redacta cualquier evidencia sensible.
