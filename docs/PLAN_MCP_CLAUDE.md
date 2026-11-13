# Conector del CRM para Claude (MCP) · 13 nov 2026

Publicado en `main` (13 nov 2026). **Sin esquema nuevo.** Falta usarlo con una llave real en producción.

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

Los tres permisos «Claude:» sólo los usa este conector; la API pública (`/api/v1`) no tiene rutas para ellos.

### Herramientas

Consultar: `resumen`, `listar_cursos`, `ver_curso`, `listar_pedidos`, `buscar_contactos`, `listar_conversaciones`, `ver_conversacion`, `listar_conocimiento`.

Escribir: `proponer_conocimiento`, `actualizar_apertura`, `actualizar_curso`.

## Cuidados

- **Alcance por marca.** Toda consulta y todo cambio usa la marca de la llave. Un identificador de otra marca responde «no existe en esta marca».
- **Los cambios pasan por las mismas reglas que la pantalla.** `actualizar_apertura` y `actualizar_curso` se ejecutan por las rutas del catálogo de siempre: mismas validaciones (no publicar con fecha pasada, cupo coherente, promociones en conflicto), historial del catálogo y eventos de precio y cupo.
- **El esquema se hace cumplir.** Cada dato que manda Claude se valida (tipo, valores permitidos, rango) antes de tocar nada: no puede archivar una apertura ni dejar un campo en blanco con un dato mal formado.
- **Revisión vigente.** Para modificar hay que mandar la revisión que devolvió la consulta; si alguien cambió el dato mientras tanto, el cambio se rechaza.
- **A nombre de una persona.** Los cambios se firman con quien creó la llave, que debe seguir siendo administrador de esa marca; si deja de serlo, la llave sólo consulta. Quedan en la bitácora de auditoría (`mcp.edition.update`, `mcp.course.update`, `mcp.knowledge.draft`).
- **El conocimiento entra como borrador.** El asistente no lo usa hasta que una persona lo aprueba en Catálogo → Conocimiento. No admite precios.
- **Sólo modifica; no borra ni archiva.** No hay herramienta para archivar cursos, cobrar, enviar mensajes a clientes ni tocar pedidos.
- **Mensajes de clientes = datos.** Lo que escribió un cliente se entrega marcado como dato, no como instrucción, y las instrucciones del conector piden a Claude confirmar con la persona antes de cualquier cambio.
- **No se usa desde un navegador.** Una petición con cabecera `Origin` se rechaza: una página web no puede usar la llave de alguien.
- **Límites:** 120 peticiones por minuto por llave y 60 llamadas a herramientas por minuto; los intentos con llaves falsas se frenan por IP.
- **Datos personales.** Con los permisos de contactos o conversaciones, nombres, teléfonos y mensajes de clientes pasan por Claude. Crea llaves con esos permisos sólo cuando haga falta y revócalas al terminar.

## Cómo conectarlo

1. En el CRM: **Operación → Sistema → API y webhooks → Llaves de la API**. Elige la marca, ponle nombre (por ejemplo «Claude») y marca los permisos. Copia la llave: sólo se muestra una vez.
2. En una terminal, **fuera de la carpeta del repositorio** (el repositorio es público y la llave no debe quedar en él):

```bash
claude mcp add --transport http --scope user crm-globalvet https://crm-laboratorio-production.up.railway.app/mcp --header "Authorization: Bearer TU_LLAVE"
```

3. Abre Claude Code y pide, por ejemplo: «usa crm-globalvet y dime qué cursos hay y cuándo empiezan». La primera vez que quiera modificar algo, Claude te pedirá permiso para usar esa herramienta.

Para quitarlo: `claude mcp remove crm-globalvet -s user`, y revoca la llave en el CRM.

Una llave por marca: para otra consultora, crea otra llave y agrégala con otro nombre (`crm-odonteck`).

## Límites de esta primera versión

- **Sólo Claude Code** (y cualquier cliente MCP que mande una cabecera fija). La app de Claude (claude.ai, escritorio y celular) pide inicio de sesión con OAuth para la mayoría de las cuentas; eso sería una segunda entrega.
- No crea cursos ni aperturas nuevas (para eso está Catálogo → Importar), no maneja promociones, cupones, pedidos ni mensajes.
- No hay herramienta para aprobar conocimiento: es a propósito.
- Las consultas devuelven como máximo 100 pedidos, 50 contactos, 50 conversaciones y 100 mensajes por llamada.
- **Sin probar en producción.** Se probó con el cliente real de Claude Code contra un servidor local.

## Dónde está

- `server/mcp.mjs`: protocolo (`initialize`, `ping`, `tools/list`, `tools/call`), herramientas y permisos.
- `server/integrations.mjs`: permisos nuevos de la llave y `authenticate()` compartido con la API v1.
- `server/index.mjs`: ruta `/mcp`, antes de la API v1 y sin sesión.

## Verificación

- `test/mcp.test.mjs` (2 pruebas): descripción de las herramientas; y de punta a punta: sin llave, llave falsa, sesión del CRM y petición con `Origin` rechazadas; protocolo (versiones, notificaciones, ping, lista, métodos y herramientas desconocidos, lotes); llave de consulta que no ve otra marca ni puede modificar; modificar una apertura (hora local correcta, sólo lo que cambia, bitácora, el asistente ya contesta con el precio nuevo), rechazos (revisión vieja, fecha mal escrita, publicar en el pasado, precio negativo, apertura de otra marca); modificar un curso; conocimiento como borrador y sin precios; conversaciones y contactos sólo de la marca; creador que deja de ser administrador; llave revocada.
- **Cliente real:** Claude Code 2.1 conectado por `--mcp-config` a un servidor local contestó con `resumen` y `listar_cursos`.
