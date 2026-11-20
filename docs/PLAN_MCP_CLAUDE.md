# Conector del CRM para Claude (MCP) · 13 nov 2026

Publicado en `main` (13 nov 2026). **Sin esquema nuevo.** Falta usarlo con una llave real en producción.

**20 nov 2026 (sin publicar):** herramientas para **armar recorridos, secuencias y accesos en borrador**, con su propio permiso; ver [Armar borradores](#armar-borradores-recorridos-secuencias-y-accesos). Sin esquema nuevo.

## Para qué

El usuario pidió «un tipo MCP que se pueda conectar contigo» para consultar y modificar ciertos datos del CRM hablando con Claude. MCP (Model Context Protocol) es la forma estándar de darle herramientas a Claude: el CRM publica una dirección, Claude se conecta a ella con una llave y desde entonces puede usar las herramientas que el CRM le ofrece.

Decisiones tomadas con el usuario: primero para **Claude Code** (con una llave), y con los cuatro alcances: consultar cursos y ventas, modificar cursos, cargar respuestas del asistente y ver clientes y conversaciones.

## Cómo funciona

- El conector vive **dentro del propio CRM**, en `POST https://<dominio>/mcp` (MCP por «Streamable HTTP», sin estado). No hay otro servicio que desplegar.
- Claude entra con una **llave de la API del CRM** (`Authorization: Bearer tcw_…`), la misma clase de llave de la API pública: es de **una sola marca**, lleva los permisos que administración elija, sólo se muestra una vez y se **revoca al instante**.
- Cada herramienta exige su permiso. Sin el permiso, Claude recibe un «no tiene el permiso» y nada más.

### Permisos de la llave

| Permiso | Qué deja hacer a Claude |
| --- | --- |
| Aperturas, precios y cupos | Ver cursos, temarios, aperturas, fechas, docentes, precios y cupos |
| Pedidos | Ver pedidos (referencia, curso, importe, estado) |
| Contactos | Buscar contactos con teléfono y correo; ver el nombre en los pedidos |
| Claude: ver conversaciones y mensajes | Listar conversaciones (con el **nombre** de la persona) y leer sus mensajes, que pueden traer teléfonos o correos escritos por el cliente |
| Claude: leer el conocimiento y proponer borradores | Ver el conocimiento del asistente y agregar preguntas y respuestas **como borrador** |
| Claude: MODIFICAR cursos y aperturas | Cambiar fecha y hora, docente, precio, cupo, modalidad, lugar, nombre o estado de una apertura; título, temario y bienvenida de un curso |
| Claude: armar recorridos, secuencias y accesos del curso en BORRADOR (`automation_drafts`) | Leer la guía y las listas de la marca; crear y guardar **borradores** de recorridos, revisarlos y probarlos en el simulador; crear y cambiar secuencias **apagadas**; escribir el mensaje de accesos de una apertura con la entrega **apagada**. No deja ver contactos, teléfonos, pedidos ni mensajes, y nunca publica, activa, enciende, inscribe ni envía |

Los cuatro permisos «Claude:» sólo los usa este conector; la API pública (`/api/v1`) no tiene rutas para ellos.

### Herramientas

Consultar: `resumen`, `listar_cursos`, `ver_curso`, `listar_pedidos`, `buscar_contactos`, `listar_conversaciones`, `ver_conversacion`, `listar_conocimiento`.

Escribir: `proponer_conocimiento`, `actualizar_apertura`, `actualizar_curso`.

Armar borradores (permiso `automation_drafts`): `guia_recorridos`, `listas_de_la_marca`, `listar_recorridos`, `ver_recorrido`, `crear_recorrido`, `actualizar_recorrido`, `revisar_recorrido`, `probar_recorrido`, `listar_secuencias`, `ver_secuencia`, `crear_secuencia`, `actualizar_secuencia`, `listar_accesos`, `escribir_acceso`. Detalle en [Armar borradores](#armar-borradores-recorridos-secuencias-y-accesos).

## Cuidados

- **Alcance por marca.** Toda consulta y todo cambio usa la marca de la llave. Un identificador de otra marca responde «no existe en esta marca».
- **Los cambios pasan por las mismas reglas que la pantalla.** `actualizar_apertura` y `actualizar_curso` se ejecutan por las rutas del catálogo de siempre: mismas validaciones (no publicar con fecha pasada, cupo coherente, promociones en conflicto), historial del catálogo y eventos de precio y cupo.
- **El esquema se hace cumplir.** Cada dato que manda Claude se valida (tipo, valores permitidos, rango) antes de tocar nada: no puede archivar una apertura ni dejar un campo en blanco con un dato mal formado.
- **Revisión vigente.** Para modificar hay que mandar la revisión que devolvió la consulta; si alguien cambió el dato mientras tanto, el cambio se rechaza.
- **A nombre de una persona.** Los cambios se firman con quien creó la llave, que debe seguir siendo administrador de esa marca; si deja de serlo, la llave sólo consulta. Quedan en la bitácora de auditoría (`mcp.edition.update`, `mcp.course.update`, `mcp.knowledge.draft`).
- **El conocimiento entra como borrador.** El asistente no lo usa hasta que una persona lo aprueba en Catálogo → Conocimiento. No admite precios.
- **Sólo modifica; no borra ni archiva.** No hay herramienta para archivar cursos, cobrar, enviar mensajes a clientes ni tocar pedidos. Tampoco para publicar, activar, pausar o archivar un recorrido, iniciarlo en una conversación, encender una secuencia o la entrega de accesos, ni inscribir a nadie.
- **Mensajes de clientes = datos.** Lo que escribió un cliente se entrega marcado como dato, no como instrucción, y las instrucciones del conector piden a Claude confirmar con la persona antes de cualquier cambio.
- **No se usa desde un navegador.** Una petición con cabecera `Origin` se rechaza: una página web no puede usar la llave de alguien.
- **Límites:** 120 peticiones por minuto por llave y 60 llamadas a herramientas por minuto; los intentos con llaves falsas se frenan por IP.
- **Datos personales.** Con los permisos de contactos o conversaciones, nombres, teléfonos y mensajes de clientes pasan por Claude. Crea llaves con esos permisos sólo cuando haga falta y revócalas al terminar.

## Armar borradores (recorridos, secuencias y accesos)

El dueño quiere que una persona que no programa le diga a Claude «arma un recorrido que salude, pregunte el curso, mande la ficha y ofrezca inscribirse» y encuentre en el CRM un **borrador correcto**, listo para que una persona lo revise y lo publique.

| Herramienta | Qué hace | Escribe |
| --- | --- | --- |
| `guia_recorridos` | Forma del grafo; cada tipo de paso (qué hace, sus datos con tipo, valores y límites, sus salidas, si espera respuesta); lo que el servidor todavía no ejecuta; límites, inicios, ajustes y un ejemplo que pasa la revisión. Con `tipos`, sólo el detalle de esos. | No |
| `listas_de_la_marca` | Las mismas listas que recibe el editor (cursos, materiales, etiquetas, personas del equipo, recorridos, archivos, secuencias, plantillas de WhatsApp, datos del contacto) con sus ids reales. | No |
| `listar_recorridos` | Recorridos de la marca (sin archivados salvo `incluirArchivados`): estado, versión publicada, inicio, revisión y cifras agregadas. | No |
| `ver_recorrido` | Un recorrido con su borrador, ajustes, versiones y los mismos errores y avisos de la pantalla. | No |
| `crear_recorrido` | Crea un recorrido **en borrador** (`clientRef` obligatorio: un reintento no crea otro). Devuelve id, revisión, reparaciones y problemas. | Sí |
| `actualizar_recorrido` | Guarda el **borrador** con la revisión vigente, igual que «Guardar». En uno publicado, lo que atiende sigue siendo la versión publicada. Archivado: se rechaza. | Sí |
| `revisar_recorrido` | La revisión de la pantalla sobre el borrador guardado o sobre un grafo, ajustes o inicio enviados (sin guardarlos). | No |
| `probar_recorrido` | El simulador del CRM sobre el borrador con respuestas de ejemplo (hasta 10): lo que vería la persona paso a paso, las notas y cómo terminó. | No |
| `listar_secuencias`, `ver_secuencia` | Secuencias con pasos, ajustes, si están encendidas y su revisión. | No |
| `crear_secuencia` | Crea una secuencia **apagada** (`clientRef` obligatorio). | Sí |
| `actualizar_secuencia` | Cambia una secuencia **apagada** con la revisión vigente; encendida o archivada se rechaza. | Sí |
| `listar_accesos` | Aperturas con su mensaje de accesos, si la entrega está encendida, su revisión y lo que le falta; sólo cuántos inscritos, sin nombres. | No |
| `escribir_acceso` | Escribe el texto de una apertura con la entrega **apagada** y devuelve cómo se vería con datos de ejemplo; si la entrega está encendida, se rechaza. | Sí |

Cómo se garantiza:

- **Rutas permitidas.** `server/lib/mcp-drafts.mjs` llama a los módulos (`chatflows`, `sequences`, `course-access`) por sus rutas, en el mismo proceso, y **sólo** a las de la lista `ROUTES`: leer, crear, guardar el borrador, revisar y probar recorridos; leer, crear y guardar secuencias; leer, escribir y previsualizar el texto de accesos. Publicar, activar, pausar, archivar, duplicar, iniciar en una conversación, encender o apagar, inscribir, enviar y subir archivos no están: `routeAllowed()` los rechaza antes de llegar al módulo.
- **Entrada armada campo por campo.** Lo que llega al módulo se construye con los datos permitidos; nunca se reenvía lo que mandó Claude. Los esquemas no tienen ningún dato de estado (`status`, `enabled`…) y un dato de más se rechaza con «Dato no reconocido», también dentro del grafo, los ajustes y el inicio.
- **Mismas reglas que la pantalla.** Crear, guardar, revisar y probar son las rutas del módulo, con su validación, límites, revisión (`expectedRevision`), idempotencia (`clientRef`) y bitácora (`chatflow.created`, `chatflow.draft`, `sequence.created`…), además de la del conector (`mcp.flow.create`, `mcp.flow.update`, `mcp.sequence.create`, `mcp.sequence.update`, `mcp.access.text`).
- **Alcance por marca.** Las rutas de los módulos comprueban a la persona, y un administrador ve todas las marcas: por eso el conector comprueba **antes** que cada recorrido, secuencia, curso o apertura sea de la marca de la llave.
- **Firma y permiso.** Escribir exige que quien creó la llave siga siendo administrador de la marca **y** tenga el permiso de la pantalla (`automation.manage` para recorridos y secuencias, `sales.access.manage` para los accesos); si no, la llave sólo consulta. Consultar exige que pueda ver la marca (`inbox.view`).
- **Un recorrido publicado no cambia.** Lo que atiende sale de la versión publicada (`chatflow_versions`); el conector sólo escribe el borrador.
- **Sin datos de clientes.** Ninguna de estas herramientas devuelve sesiones, nombres, teléfonos ni mensajes; sólo cifras agregadas. Los nombres y textos del equipo vuelven marcados como datos.
- **Probar no escribe.** El simulador del módulo anota en memoria lo que pasaría: no envía, no inscribe ni mueve conversaciones.
- **Posiciones.** Si ningún paso trae `x`, `y`, el conector los acomoda con el mismo acomodo automático del editor.

Ganchos: `server/index.mjs` entrega los módulos al conector en una línea (`mcp.useModules(name => modules.get(name))`), porque el conector se crea antes que ellos; `server/modules/chatflows/module.mjs` exporta `START_TYPES` y `KEYWORD_MODES` para que el conector acepte exactamente los mismos inicios.

## Conectarlo con un clic

**Sin publicar** (20 nov 2026). Para quien no programa y para las aplicaciones de Claude (web, escritorio y celular), que piden iniciar sesión. Detalle técnico y garantías: [PLAN_MCP_OAUTH.md](PLAN_MCP_OAUTH.md).

1. En el CRM, abre **Ajustes → Asistentes conectados** y pulsa «Copiar dirección» (es `https://<dominio>/mcp`).
2. En la aplicación de Claude, agrega un **conector personalizado** y pega esa dirección. No hace falta llenar nada más.
3. Se abre el CRM en el navegador. Si te lo pide, entra con tu usuario de administración.
4. Elige **una** marca, deja marcados sólo los permisos que necesitas (los que dejan ver datos personales vienen sin marcar) y pulsa **Permitir**. Vuelves a la aplicación y el conector ya funciona.

Para desconectarlo: **Ajustes → Asistentes conectados → Desconectar**. Deja de funcionar al instante. También deja de funcionar solo si pierdes el acceso a esa marca o te suspenden.

Por ahora **sólo administración** puede conectar asistentes, igual que crear una llave de la API. En producción hace falta que el servidor tenga `APP_ORIGIN`; sin ella la conexión con un clic queda apagada. Claude Code también puede conectarse así (`claude mcp add --transport http crm https://<dominio>/mcp`, sin cabecera); la llave de abajo sigue funcionando igual.

## Cómo conectarlo

Con una llave de la API (Claude Code y otros clientes que mandan una cabecera fija):

1. En el CRM: **Operación → Sistema → API y webhooks → Llaves de la API**. Elige la marca, ponle nombre (por ejemplo «Claude») y marca los permisos. Para armar recorridos basta «Claude: armar recorridos, secuencias y accesos del curso en BORRADOR» (grupo Escritura). Copia la llave: sólo se muestra una vez.
2. En una terminal, **fuera de la carpeta del repositorio** (el repositorio es público y la llave no debe quedar en él):

```bash
claude mcp add --transport http --scope user crm-globalvet https://crm-laboratorio-production.up.railway.app/mcp --header "Authorization: Bearer TU_LLAVE"
```

3. Abre Claude Code y pide, por ejemplo: «usa crm-globalvet y dime qué cursos hay y cuándo empiezan», o «arma en crm-globalvet un recorrido que salude, pregunte el curso, mande la ficha y ofrezca inscribirse». La primera vez que quiera modificar algo, Claude te pedirá permiso para usar esa herramienta. Un recorrido queda en borrador en Automatización: publicarlo y activarlo lo haces tú.

Para quitarlo: `claude mcp remove crm-globalvet -s user`, y revoca la llave en el CRM.

Una llave por marca: para otra consultora, crea otra llave y agrégala con otro nombre (`crm-odonteck`).

## Límites de esta primera versión

- Con llave, **sólo Claude Code** (y cualquier cliente MCP que mande una cabecera fija). Para la app de Claude (claude.ai, escritorio y celular), que pide inicio de sesión con OAuth, está [Conectarlo con un clic](#conectarlo-con-un-clic) (sin publicar).
- No crea cursos ni aperturas nuevas (para eso está Catálogo → Importar), no maneja promociones, cupones, pedidos ni mensajes.
- Recorridos: sólo borradores. Revisar un grafo exige un recorrido ya creado (se revisa contra él); probar usa el borrador guardado. No sube archivos a la biblioteca (usa los que ya tiene la marca) ni pide sugerencias con IA. Probar admite hasta 10 respuestas por llamada y cuenta, además, para el límite del simulador (60 por minuto por persona). Si una respuesta se desvía del recorrido, el simulador consulta al asistente de la marca como en la pantalla (con IA, si está encendida).
- Secuencias: sólo apagadas; no muestra inscripciones ni resultados. Accesos: sólo el texto, con la entrega apagada.
- No hay herramienta para aprobar conocimiento: es a propósito.
- Las consultas devuelven como máximo 100 pedidos, 50 contactos, 50 conversaciones y 100 mensajes por llamada.
- **Probado en producción el 20 nov 2026, sólo para armar borradores:** con una llave real de GlobalVet (permiso de borradores) y Claude Code, el asistente leyó la guía y las listas, creó el recorrido «Información general» en borrador, lo revisó sin errores ni avisos y probó tres caminos; el borrador apareció en Automatización y nada se publicó (captura del dueño). Las demás herramientas (cursos, pedidos, contactos, conversaciones, conocimiento) siguen probadas sólo en local.

## Dónde está

- `server/mcp.mjs`: protocolo (`initialize`, `ping`, `tools/list`, `tools/call`), herramientas y permisos.
- `server/lib/mcp-drafts.mjs`: herramientas de borradores, rutas permitidas (`ROUTES`) y comprobaciones de marca y firma.
- `server/lib/flow-guide.mjs`: la guía, generada del modelo compartido (`public/kit/shared/flow-model.js`, `flow-support.js`), y el recorrido de ejemplo.
- `server/integrations.mjs`: permisos nuevos de la llave y `authenticate()` compartido con la API v1.
- `server/index.mjs`: ruta `/mcp`, antes de la API v1 y sin sesión; `mcp.useModules(…)` después de crear los módulos.

## Verificación

- `test/mcp.test.mjs` (2 pruebas): descripción de las herramientas; y de punta a punta: sin llave, llave falsa, sesión del CRM y petición con `Origin` rechazadas; protocolo (versiones, notificaciones, ping, lista, métodos y herramientas desconocidos, lotes); llave de consulta que no ve otra marca ni puede modificar; modificar una apertura (hora local correcta, sólo lo que cambia, bitácora, el asistente ya contesta con el precio nuevo), rechazos (revisión vieja, fecha mal escrita, publicar en el pasado, precio negativo, apertura de otra marca); modificar un curso; conocimiento como borrador y sin precios; conversaciones y contactos sólo de la marca; creador que deja de ser administrador; llave revocada.
- `test/mcp-recorridos.test.mjs` (3 pruebas): herramientas sin datos de estado y rutas permitidas (publicar, activar, pausar, archivar, duplicar, iniciar, encender, inscribir y enviar, rechazadas); esquema por dentro del grafo, los ajustes y el inicio; la guía cubre todos los tipos del modelo y su ejemplo pasa la revisión; y de punta a punta con el servidor real: permiso propio (sin él no entra; con él no ve contactos, pedidos ni mensajes); guía → listas (iguales a las del editor) → crear el borrador (saludo, ¿qué curso?, ficha, botones, inscripción o una persona) → revisar sin errores (igual que la pantalla) → probar con respuestas → sigue en borrador y nada se envió, inscribió ni cambió; reintento con el mismo `clientRef`; grafo con problemas devuelve los de la pantalla; revisión vieja; datos de estado rechazados; recorrido publicado por una persona: cambia el borrador y no la versión publicada; archivado, rechazado; otra marca; secuencias apagadas (encendida por una persona, ya no se toca); accesos con la entrega apagada (encendida, ya no se toca); creador que deja de ser administrador.
- **Cliente real:** Claude Code 2.1 conectado por `--mcp-config` a un servidor local contestó con `resumen` y `listar_cursos`.
