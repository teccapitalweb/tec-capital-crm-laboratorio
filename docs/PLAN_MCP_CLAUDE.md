# Conector del CRM para Claude (MCP) · 13 nov 2026

Publicado en `main` (13 nov 2026). **Sin esquema nuevo.** Falta usarlo con una llave real en producción.

**20 nov 2026 (sin publicar):** herramientas para **armar recorridos, secuencias y accesos en borrador**, con su propio permiso; ver [Armar borradores](#armar-borradores-recorridos-secuencias-y-accesos). Sin esquema nuevo.

**20 nov 2026 (sin publicar, rama de trabajo):** dos permisos nuevos. «Explícame mis números» (`insights`): cifras agregadas de ventas, atención, recorridos, secuencias, difusiones, WhatsApp y «Preparar marca», sin datos personales y con la regla «menos de 3»; ver [Cifras y resultados](#cifras-y-resultados-insights). Y «preparar configuración en borrador» (`config_drafts`, más las reglas por mensaje bajo `automation_drafts`): aperturas, promociones, textos de contenido, plantillas de WhatsApp, difusiones, segmentos y reglas, siempre en borrador; ver [Preparar configuración en borrador](#preparar-configuración-en-borrador). Sin esquema nuevo.

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
| Claude: armar recorridos, reglas por mensaje, secuencias y accesos del curso en BORRADOR (`automation_drafts`) | Leer la guía y las listas de la marca; crear y guardar **borradores** de recorridos, revisarlos y probarlos en el simulador; crear y guardar **reglas por mensaje en borrador** y probarlas en el simulador de Reglas; crear y cambiar secuencias **apagadas**; escribir el mensaje de accesos de una apertura con la entrega **apagada**. No deja ver contactos, teléfonos, pedidos ni mensajes, y nunca publica, activa, enciende, inscribe ni envía |
| Claude: ver cifras y resultados de la marca (`insights`, lectura) | Cifras **agregadas** de ventas, atención y embudo, rendimiento de recorridos, resultados de secuencias y difusiones, salud y costos de WhatsApp y la lista «Preparar marca». Nunca nombres, teléfonos, correos, mensajes ni referencias de pedidos; regla «menos de 3» |
| Claude: preparar en BORRADOR aperturas, promociones, textos, plantillas de WhatsApp, difusiones y segmentos (`config_drafts`, escritura) | Crear y guardar **en borrador** aperturas y promociones, plantillas de contenido, plantillas de WhatsApp (sin enviarlas a Meta), difusiones (sin programarlas) y segmentos nuevos, con la validación y la vista previa de cada pantalla. Nunca publica, aprueba, envía a Meta, programa ni envía |

Los seis permisos «Claude:» sólo los usa este conector; la API pública (`/api/v1`) no tiene rutas para ellos.

**Por qué estos permisos.** Las reglas por mensaje van con `automation_drafts` porque su pantalla pide el mismo permiso que la de recorridos (`automation.manage`) y su borrador tampoco corre. El resto va en un permiso hermano, `config_drafts`, y no dentro de `automation_drafts`: sus pantallas piden otros permisos (administración en el catálogo, `templates.manage`, `campaigns.edit`, `audiences.edit`) y así una llave que ya existía con `automation_drafts` no gana poderes nuevos sin que administración lo decida. Las cifras van aparte (`insights`, de lectura) porque incluyen ingresos.

### Herramientas

Consultar: `resumen`, `listar_cursos`, `ver_curso`, `listar_pedidos`, `buscar_contactos`, `listar_conversaciones`, `ver_conversacion`, `listar_conocimiento`.

Escribir: `proponer_conocimiento`, `actualizar_apertura`, `actualizar_curso`.

Armar borradores (permiso `automation_drafts`): `guia_recorridos`, `listas_de_la_marca`, `listar_recorridos`, `ver_recorrido`, `crear_recorrido`, `actualizar_recorrido`, `revisar_recorrido`, `probar_recorrido`, `listar_secuencias`, `ver_secuencia`, `crear_secuencia`, `actualizar_secuencia`, `listar_accesos`, `escribir_acceso`; y reglas por mensaje: `listas_de_reglas`, `listar_reglas`, `crear_regla`, `actualizar_regla`, `probar_regla`. Detalle en [Armar borradores](#armar-borradores-recorridos-secuencias-y-accesos) y [Preparar configuración en borrador](#preparar-configuración-en-borrador).

Cifras (permiso `insights`): `cifras_ventas`, `cifras_atencion`, `rendimiento_recorridos`, `resultados_secuencias`, `resultados_difusiones`, `salud_whatsapp`, `que_le_falta_a_la_marca`. Detalle en [Cifras y resultados](#cifras-y-resultados-insights).

Preparar configuración (permiso `config_drafts`): catálogo `listar_borradores_catalogo`, `crear_apertura_borrador`, `actualizar_apertura_borrador`, `crear_promocion_borrador`, `actualizar_promocion_borrador`; contenido `crear_texto_borrador`, `actualizar_texto_borrador`, `probar_texto`; WhatsApp `listar_plantillas_whatsapp`, `ver_plantilla_whatsapp`, `crear_plantilla_whatsapp`, `actualizar_plantilla_whatsapp`, `revisar_plantilla_whatsapp`; difusiones y audiencias `opciones_difusion`, `listar_difusiones`, `crear_difusion_borrador`, `actualizar_difusion_borrador`, `estimar_difusion`, `listar_audiencias`, `campos_de_segmento`, `crear_segmento`, `contar_segmento`.

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

## Cifras y resultados (`insights`)

El dueño quiere preguntarle a Claude «¿cómo vamos este mes?» y recibir cifras correctas, con su periodo y su definición, sin que pase por Claude ningún dato de una persona.

| Herramienta | Qué devuelve | Periodo |
| --- | --- | --- |
| `cifras_ventas` | Ventas, importe, reembolsos, neto y ticket promedio por moneda; serie por día, semana o mes; desglose por curso, apertura y método de pago; pedidos creados, pagados, conversión y por estado; pedidos pendientes ahora; tiempo del primer mensaje al pago (mediana y promedio) | `desde`/`hasta` |
| `cifras_atencion` | Conversaciones abiertas y resueltas (total, por canal, serie); embudo de oportunidades creadas (por curso y motivos de pérdida); tiempos de respuesta del equipo; ahora: esperando a una persona, con el asistente y oportunidades por etapa | `desde`/`hasta` |
| `rendimiento_recorridos` | Sin id: cada recorrido con conversaciones y cómo terminaron. Con id: la pestaña «Rendimiento» (llegaron, siguieron, por qué salida, dónde se fueron, cuánto tardan en contestar) | `desde`/`hasta` (con id) |
| `resultados_secuencias` | Lo que muestra la pantalla de Secuencias: inscritas, enviados, respondieron, sí/no, detenidas por motivo y por paso | Desde que existe (la pantalla no separa por fechas) |
| `resultados_difusiones` | Difusiones creadas en el periodo con destinatarios por estado, respuestas y clics | `desde`/`hasta` |
| `salud_whatsapp` | Números (estado, calidad, límite), plantillas por estado y las que tienen problemas, medidor de costos del mes (entregados por categoría y costo) | `mes` (AAAA-MM) |
| `que_le_falta_a_la_marca` | La lista «Preparar marca» completa, con los pasos que registran los módulos (modo real, accesos del curso) | Al momento |

**Periodo.** `desde` y `hasta` son días `AAAA-MM-DD`, ambos incluidos, en la **zona horaria de la marca** (la de su horario en Operación; si no tiene, `America/Mexico_City`). Por omisión, los últimos 30 días hasta hoy. Se rechaza una fecha mal escrita o inexistente (`2026-02-30`), `hasta` anterior a `desde`, `hasta` en el futuro, `desde` antes de 2020 y más de **366 días**. Cada respuesta trae `periodo` (con la zona) y `definiciones`; las instrucciones del conector piden a Claude decir siempre el periodo y la definición y no completar cifras que no vengan.

**Definiciones.**

- *Venta*: pago confirmado en el periodo, una línea de venta del libro de Finanzas por pedido pagado, en la fecha del pago. *Reembolso*: el que registra administración (resta del neto). *Neto* = ventas − reembolsos, por moneda. *Ticket promedio* = importe de ventas ÷ número de ventas. Finanzas agrupa los días en la zona de la empresa; aquí, en la de la marca.
- *Pedidos creados*: enlaces de pago creados en el periodo, pagados o no; *conversión* = de ésos, cuántos ya están pagados. *Pendientes ahora*: esperando pago y vigentes, o con comprobante en revisión.
- *Tiempo al pago*: de los pedidos pagados en el periodo, del primer mensaje del cliente en esa conversación al pago.
- *Abiertas*: ciclos de atención que empezaron en el periodo (una conversación reabierta cuenta otra vez). *Resueltas*: ciclos cerrados como resueltos, por una persona o por el asistente.
- *Embudo*: oportunidades **creadas** en el periodo y la etapa más alta a la que llegaron, como Resultados; *conversión* = ganadas ÷ creadas.
- *Tiempos de respuesta*: de reloj, desde que el cliente quedó esperando hasta que alguien del equipo contestó (mediana y percentil 90, primera respuesta y siguientes), como Resultados.
- Recorridos, secuencias, difusiones y costos: las mismas cifras que sus pantallas, leídas por sus rutas.

**Regla «menos de 3».** Una cifra pequeña puede identificar a alguien («la única venta por transferencia de este curso»). Por eso, en todo **desglose por algo que no sea el tiempo** (curso, apertura, método de pago, estado del pedido, canal, etapa, motivo, paso, salida, recorrido, secuencia, difusión, lista o segmento, categoría de mensaje), una cifra de **1 o 2** se devuelve como el texto `"menos de 3"` y el importe de ese renglón se oculta (`importe: null`, `importesOcultos: true`); la mediana de respuesta de un paso sólo se da con 3 o más respuestas. El cero se muestra. Los **totales del periodo** y las **series por día, semana o mes** se dan completos. La moneda no cuenta como desglose (las sumas tienen que ir por moneda). Límite conocido: en algunos desgloses el valor oculto se puede deducir restando del total; la regla evita que se lea directo, no sustituye a no dar la llave a quien no deba ver cifras.

**Cómo se garantiza.**

- `server/lib/mcp-insights.mjs`: las consultas SQL propias sólo hacen `count`/`sum`/`min` sobre importes, fechas, estados y canales de la marca de la llave; lo que llega de los módulos se copia campo por campo. Las rutas de módulo que lee están en la lista cerrada `INSIGHT_ROUTES`, sólo `GET` (rendimiento de un recorrido, resultados de una secuencia, lista de difusiones, plantillas y medidor de costos); las sesiones, bitácoras, inscripciones, destinatarios y miembros no están.
- La lista «Preparar marca» la presta el módulo `server/modules/mcp-bridge/` (sólo lectura, sin rutas): es la instancia del servidor, con los pasos que registran los módulos.
- Quien creó la llave debe seguir administrando la marca (las cifras incluyen ingresos); el medidor de costos y las plantillas piden además los permisos de sus pantallas.

## Preparar configuración en borrador

El dueño quiere decirle a Claude «prepara la apertura de marzo con su preventa, el texto de bienvenida, la plantilla de aviso y la difusión a los interesados» y encontrar todo **en borrador**, validado, listo para que una persona lo revise y lo publique.

| Área | Herramientas | Qué queda | Qué NO hace (lo hace una persona) |
| --- | --- | --- | --- |
| Catálogo | `listar_borradores_catalogo`, `crear_apertura_borrador`, `actualizar_apertura_borrador`, `crear_promocion_borrador`, `actualizar_promocion_borrador` | Aperturas de un curso existente y promociones con `status='draft'` (el conector lo fija); sólo se guardan las que siguen en borrador | Publicar, archivar, crear cursos, flyers |
| Contenido | `crear_texto_borrador`, `actualizar_texto_borrador`, `probar_texto` | Plantillas de contenido en borrador; la vista previa con un cliente de prueba | Aprobar, archivar, asignar a un evento |
| Plantillas de WhatsApp | `listar_plantillas_whatsapp`, `ver_plantilla_whatsapp`, `crear_plantilla_whatsapp`, `actualizar_plantilla_whatsapp`, `revisar_plantilla_whatsapp` | Borrador del CRM con encabezado, cuerpo, pie, botones y muestras; avisos, vista previa y «lo que falta para enviar a Meta» del editor. Sólo se guardan en borrador o rechazadas | Enviar a revisión de Meta, sincronizar, adoptar, duplicar, dar de baja, subir archivos, enviar |
| Difusiones y audiencias | `opciones_difusion`, `listar_difusiones`, `crear_difusion_borrador`, `actualizar_difusion_borrador`, `estimar_difusion`, `listar_audiencias`, `campos_de_segmento`, `crear_segmento`, `contar_segmento` | Difusión en borrador (plantilla, número, público, curso, ritmo, ensayo), siempre con consentimiento y en el horario de la marca; su estimación en **cifras** (cuántos la recibirían, por qué no los demás, costo, presupuesto, límite, tiempo, lo que impediría programarla); segmentos **nuevos** y conteos | Programar (y elegir la hora), pausar, reanudar, cancelar; ver destinatarios o miembros; editar, archivar o exportar audiencias; listas con contactos |
| Reglas por mensaje (`automation_drafts`) | `listas_de_reglas`, `listar_reglas`, `crear_regla`, `actualizar_regla`, `probar_regla` | Reglas en borrador (no corren); el simulador de Reglas con un mensaje de ejemplo | Encender, pausar, archivar, reordenar, cambiar ajustes |

**Lo que se dejó fuera, y por qué.**

- **Crear cursos.** La tabla de cursos no tiene borrador: un curso nuevo nace activo y aparece en la lista que ve el cliente y en la que usa el asistente para reconocer el curso. Hacerlo «en borrador» pediría un esquema nuevo; por eso Claude prepara aperturas de cursos que ya existen (el curso lo da de alta una persona con «Nuevo curso»). Tampoco flyers (piden subir un archivo y aprobarlo).
- **Asignar textos a eventos** (Contenido → Eventos): una asignación es viva en cuanto existe; no hay borrador.
- **Respuestas rápidas compartidas**: el equipo las ve y usa en el chat en cuanto existen; su pantalla no tiene borrador.
- **Editar segmentos existentes o listas**: un segmento puede ser el público de una difusión o campaña en curso; cambiarlo cambiaría a quién le llega. Sólo se crean segmentos nuevos. Las listas llevan contactos (datos personales).
- **Fecha de envío de una difusión**: en el CRM la hora se elige al programar, y programar lo hace una persona.

**Cómo se garantiza.**

- **Rutas permitidas.** `server/lib/mcp-config.mjs` llama a las pantallas por sus rutas, en el mismo proceso (`server/lib/mcp-call.mjs`), y **sólo** a las de la lista cerrada `CONFIG_ROUTES`: leer, crear el borrador, guardar el borrador, validar y previsualizar. El catálogo (servicio actual, no módulo) entra por la misma lista. Aprobar, archivar, enviar a revisión, sincronizar, adoptar, duplicar, programar, pausar, reanudar, cancelar, encender, ordenar, exportar, ver miembros o destinatarios y subir archivos no están; las pruebas lo comprueban ruta por ruta.
- **Estado fijado aquí, no por Claude.** Ningún esquema tiene datos de estado (`status`, `enabled`, `approved`, `scheduledAt`…) y un dato de más se rechaza con «Dato no reconocido», también dentro del encabezado o las tandas. Aperturas y promociones se mandan con `status: 'draft'`; textos, plantillas, difusiones y reglas nacen en borrador por su propio módulo. Las difusiones van siempre con `requireConsent: true` y `sendHours: 'brand'`.
- **Sólo lo que está en borrador.** Antes de guardar se lee el estado: una apertura o promoción publicada, un texto aprobado (guardarlo lo devolvería a borrador y dejaría de usarse), una plantilla enviada a Meta, una difusión fuera de borrador o una regla encendida se rechazan con 409. La revisión vigente (`expectedRevision`) evita guardar sobre un cambio que hizo alguien entretanto.
- **Alcance por marca.** Todo id (curso, apertura, promoción, texto, plantilla, difusión, lista o segmento, regla) se comprueba contra la marca de la llave **antes** de llamar a la ruta.
- **Firma y permiso.** Escribe quien creó la llave, que debe seguir administrando la marca y tener el permiso de la pantalla (`templates.manage`, `campaigns.edit`, `audiences.edit`, `automation.manage`; el catálogo y el contenido piden administración). Si no, la llave sólo consulta.
- **Sin datos de clientes.** La estimación de una difusión y el conteo de un segmento devuelven **cuántos**, con la regla «menos de 3», nunca a quién (la muestra de la pantalla, con nombres, no se copia). Un segmento creado o contado desde el conector no puede filtrar por nombre, teléfono, correo ni datos personales: un conteo de 1 diría si alguien es contacto de la marca.
- **Reintentos.** Plantillas, difusiones, segmentos y reglas usan el `clientRef` de su módulo; el catálogo no tiene uno, así que el conector recuerda (en memoria, por llave) lo creado con cada `clientRef`.
- **Bitácora.** Además de la de cada pantalla: `mcp.edition.draft`, `mcp.promotion.draft`, `mcp.content.draft`, `mcp.wa_template.draft`, `mcp.broadcast.draft`, `mcp.segment.create`, `mcp.rule.draft`.

## Cómo conectarlo

1. En el CRM: **Operación → Sistema → API y webhooks → Llaves de la API**. Elige la marca, ponle nombre (por ejemplo «Claude») y marca los permisos. Para armar recorridos basta «Claude: armar recorridos, secuencias y accesos del curso en BORRADOR» (grupo Escritura). Copia la llave: sólo se muestra una vez.
2. En una terminal, **fuera de la carpeta del repositorio** (el repositorio es público y la llave no debe quedar en él):

```bash
claude mcp add --transport http --scope user crm-globalvet https://crm-laboratorio-production.up.railway.app/mcp --header "Authorization: Bearer TU_LLAVE"
```

3. Abre Claude Code y pide, por ejemplo: «usa crm-globalvet y dime qué cursos hay y cuándo empiezan», o «arma en crm-globalvet un recorrido que salude, pregunte el curso, mande la ficha y ofrezca inscribirse». La primera vez que quiera modificar algo, Claude te pedirá permiso para usar esa herramienta. Un recorrido queda en borrador en Automatización: publicarlo y activarlo lo haces tú.

Para quitarlo: `claude mcp remove crm-globalvet -s user`, y revoca la llave en el CRM.

Una llave por marca: para otra consultora, crea otra llave y agrégala con otro nombre (`crm-odonteck`).

## Límites de esta primera versión

- **Sólo Claude Code** (y cualquier cliente MCP que mande una cabecera fija). La app de Claude (claude.ai, escritorio y celular) pide inicio de sesión con OAuth para la mayoría de las cuentas; eso sería una segunda entrega.
- No crea cursos ni aperturas nuevas (para eso está Catálogo → Importar), no maneja promociones, cupones, pedidos ni mensajes.
- Recorridos: sólo borradores. Revisar un grafo exige un recorrido ya creado (se revisa contra él); probar usa el borrador guardado. No sube archivos a la biblioteca (usa los que ya tiene la marca) ni pide sugerencias con IA. Probar admite hasta 10 respuestas por llamada y cuenta, además, para el límite del simulador (60 por minuto por persona). Si una respuesta se desvía del recorrido, el simulador consulta al asistente de la marca como en la pantalla (con IA, si está encendida).
- Secuencias: sólo apagadas; no muestra inscripciones ni resultados. Accesos: sólo el texto, con la entrega apagada.
- No hay herramienta para aprobar conocimiento: es a propósito.
- Cifras: como mucho 366 días por consulta; secuencias sin filtro de fechas (como su pantalla); difusiones, hasta 500 por consulta; `resultados_secuencias`, hasta 50 secuencias. La regla «menos de 3» no impide deducir un valor restando del total en todos los casos.
- Configuración en borrador: no crea cursos, flyers, asignaciones de eventos, respuestas rápidas ni listas, y no edita segmentos existentes (ver [lo que se dejó fuera](#preparar-configuración-en-borrador)). La idempotencia del catálogo vive en memoria: tras reiniciar el servidor, repetir un `clientRef` crearía otra apertura, promoción o texto. Guardar el precio de una apertura en borrador avisa al equipo del cambio de precio, igual que en la pantalla.
- Cifras y configuración en borrador están **probadas sólo en local** (pruebas automáticas), no con una llave real en producción.
- Las consultas devuelven como máximo 100 pedidos, 50 contactos, 50 conversaciones y 100 mensajes por llamada.
- **Probado en producción el 20 nov 2026, sólo para armar borradores:** con una llave real de GlobalVet (permiso de borradores) y Claude Code, el asistente leyó la guía y las listas, creó el recorrido «Información general» en borrador, lo revisó sin errores ni avisos y probó tres caminos; el borrador apareció en Automatización y nada se publicó (captura del dueño). Las demás herramientas (cursos, pedidos, contactos, conversaciones, conocimiento) siguen probadas sólo en local.

## Dónde está

- `server/mcp.mjs`: protocolo (`initialize`, `ping`, `tools/list`, `tools/call`), herramientas y permisos.
- `server/lib/mcp-drafts.mjs`: herramientas de borradores, rutas permitidas (`ROUTES`) y comprobaciones de marca y firma.
- `server/lib/mcp-insights.mjs`: cifras agregadas (`INSIGHT_TOOLS`, `INSIGHT_ROUTES`), periodo y regla «menos de 3».
- `server/lib/mcp-config.mjs`: configuración en borrador (`CONFIG_TOOLS`, `CONFIG_ROUTES`), comprobaciones de marca, estado y firma.
- `server/lib/mcp-call.mjs`: llamada a una ruta en el mismo proceso con lista cerrada, y la regla «menos de 3» (`people`, `FEW`).
- `server/modules/mcp-bridge/`: presta al conector la lectura de «Preparar marca» de la instancia del servidor (sin rutas).
- `server/lib/flow-guide.mjs`: la guía, generada del modelo compartido (`public/kit/shared/flow-model.js`, `flow-support.js`), y el recorrido de ejemplo.
- `server/integrations.mjs`: permisos nuevos de la llave y `authenticate()` compartido con la API v1.
- `server/index.mjs`: ruta `/mcp`, antes de la API v1 y sin sesión; `mcp.useModules(…)` después de crear los módulos.

## Verificación

- `test/mcp.test.mjs` (2 pruebas): descripción de las herramientas; y de punta a punta: sin llave, llave falsa, sesión del CRM y petición con `Origin` rechazadas; protocolo (versiones, notificaciones, ping, lista, métodos y herramientas desconocidos, lotes); llave de consulta que no ve otra marca ni puede modificar; modificar una apertura (hora local correcta, sólo lo que cambia, bitácora, el asistente ya contesta con el precio nuevo), rechazos (revisión vieja, fecha mal escrita, publicar en el pasado, precio negativo, apertura de otra marca); modificar un curso; conocimiento como borrador y sin precios; conversaciones y contactos sólo de la marca; creador que deja de ser administrador; llave revocada.
- `test/mcp-recorridos.test.mjs` (3 pruebas): herramientas sin datos de estado y rutas permitidas (publicar, activar, pausar, archivar, duplicar, iniciar, encender, inscribir y enviar, rechazadas); esquema por dentro del grafo, los ajustes y el inicio; la guía cubre todos los tipos del modelo y su ejemplo pasa la revisión; y de punta a punta con el servidor real: permiso propio (sin él no entra; con él no ve contactos, pedidos ni mensajes); guía → listas (iguales a las del editor) → crear el borrador (saludo, ¿qué curso?, ficha, botones, inscripción o una persona) → revisar sin errores (igual que la pantalla) → probar con respuestas → sigue en borrador y nada se envió, inscribió ni cambió; reintento con el mismo `clientRef`; grafo con problemas devuelve los de la pantalla; revisión vieja; datos de estado rechazados; recorrido publicado por una persona: cambia el borrador y no la versión publicada; archivado, rechazado; otra marca; secuencias apagadas (encendida por una persona, ya no se toca); accesos con la entrega apagada (encendida, ya no se toca); creador que deja de ser administrador.
- `test/mcp-cifras.test.mjs` (2 pruebas): herramientas de sólo lectura con su permiso y rutas sólo `GET` (sesiones, bitácoras, inscripciones, destinatarios y miembros rechazados); la regla «menos de 3»; y de punta a punta con el servidor real y ventas sembradas (cifras esperadas calculadas en la prueba): totales, desglose por método (3 ventas se ven; 1 se oculta con su importe), curso con un solo reembolso oculto, pedidos y conversión, pendientes, mediana y promedio del primer mensaje al pago, otra marca que sólo ve lo suyo, periodo vacío; validación del periodo (fecha inexistente, orden, futuro, más de 366 días, antes de 2020, tipo); atención (abiertas por canal con Instagram oculto, embudo, motivos y etapas); recorridos, secuencias y difusiones (y otra marca rechazada); WhatsApp; «Preparar marca» igual que la pantalla con los pasos de los módulos; ningún nombre, teléfono, correo, referencia de pedido ni nota en ninguna salida; creador que deja de administrar.
- `test/mcp-configuracion.test.mjs` (2 pruebas): esquemas sin datos de estado; lista cerrada (aprobar, archivar, crear cursos, flyers, enviar a Meta, sincronizar, adoptar, programar, pausar, cancelar, destinatarios, miembros, exportar, encender reglas… rechazados); datos de más rechazados; y de punta a punta: apertura y promoción en borrador (hora local, reintento, revisión vieja, publicada rechazada, otra marca), textos (vista previa, dato inexistente, aprobado por una persona ya no se toca), plantilla de WhatsApp (sin enviar a Meta, aprobada ya no se edita, otra marca), segmento (campos personales rechazados) y difusión en borrador con consentimiento y su estimación sin muestra, regla en borrador probada en el simulador (encendida por una persona ya no se toca), bitácora, y al final nada publicado, aprobado, enviado, programado ni encendido por el conector y ningún dato de clientes en las salidas.
- **Cliente real:** Claude Code 2.1 conectado por `--mcp-config` a un servidor local contestó con `resumen` y `listar_cursos`.
