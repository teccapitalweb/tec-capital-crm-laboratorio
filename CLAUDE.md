# Continuidad para Claude

Este es el repositorio vigente del CRM de TEC Capital. Lee este archivo antes de modificarlo.

## Punto de partida

- Producto: CRM para **15 marcas de una misma empresa**, dedicadas a cursos; alrededor de ocho o más cursos por marca.
- Estado vigente (versión publicada, esquema, pruebas, interruptores, límites y pendientes): **[docs/ESTADO_ACTUAL.md](docs/ESTADO_ACTUAL.md)**. Referencia histórica: v0.5.0, commit `c7218f15d346e08406a96786db68523e78db4877`, esquema SQLite 6.
- CRM del equipo: <https://crm-laboratorio-production.up.railway.app/crm>.
- Experiencia del cliente: <https://crm-laboratorio-production.up.railway.app/>.
- Repositorio: <https://github.com/teccapitalweb/tec-capital-crm-laboratorio>, rama `main`.
- Los mensajes entre perfiles son reales y persistentes dentro del laboratorio. WhatsApp, Instagram y Facebook son **canales simulados**. La conexión real de WhatsApp con Meta está publicada (apagada por omisión y sin probar contra Meta); Claude ya responde en producción. Todavía no hay Instagram/Messenger reales, cobros ni matrícula real. **Propósito actual:** es una simulación para diseñar y presentar el flujo completo; las conexiones reales llegarán cuando las consultoras entreguen sus accesos (ver VISION_PLATAFORMA.md).
- Se conservaron tres marcas y seis cursos de demostración. No confundas los objetivos de 15 marcas/120 cursos con datos comerciales ya cargados.
- Usuario hispanohablante. Comunica con claridad qué cambiaste, qué verificaste y qué falta.

## Orden de lectura

0. [Estado actual](docs/ESTADO_ACTUAL.md): una página con lo vigente. **Empieza aquí.**
0b. [Guía de uso por rol](docs/GUIA_DE_USO.md) y [activación y verificación en producción](docs/ACTIVACION_Y_VERIFICACION.md): qué hace cada pantalla y el runbook para dejar una marca de pruebas funcionando y comprobada.
1. [Estado y decisiones](docs/CONTINUIDAD.md): entregas, diseño, evidencia y pendientes.
2. [Arquitectura y contratos](docs/ARQUITECTURA.md): módulos, datos, rutas e invariantes.
3. [Operación y pruebas](docs/OPERACION_Y_PRUEBAS.md): desarrollo, despliegue, verificaciones y recuperación.
3b. [Diseño y auditoría visual](docs/DISENO_Y_AUDITORIA.md): reglas de Niebla y cómo medirlas.
4. [Plan de la fase 4](docs/PLAN_FASE_4.md): siguiente trabajo propuesto, todavía sin implementar.
4d. [Plan de la Fase 2](docs/PLAN_FASE_2.md): bloques, dependencias, decisiones y criterios de salida para el núcleo único e integración.
4c. [Contrato de conectores](docs/CONECTORES.md): interfaz de canal y pago, webhooks firmados y requisitos por consultora para Meta y la pasarela.
4e. [Núcleo compartido](docs/NUCLEO.md): contrato del outbox del CRM hacia Postgres/Supabase (sobre firmado, proyección de registros, reproducción) y el esquema `nucleo/esquema-v1.sql`.
4f. [Plan de campañas](docs/PLAN_CAMPANAS.md): campañas y envíos segmentados (Fase 5, bloque 1), publicado en v0.29.0 (esquema 26).
4g. [Plan del portal por roles](docs/PLAN_PORTAL_ROLES.md): el IPCIL nuevo dentro del CRM (Fase 5, bloque 2), publicado en v0.30.0 (sin esquema nuevo).
4h. [Plan de notificaciones push y app instalable](docs/PLAN_PUSH.md): Fase 5, bloque 4, publicado en v0.32.0 (esquema 27); falta probar la entrega real en un teléfono.
4i. [Plan del chat más rápido](docs/PLAN_CHAT_RAPIDO.md): respuestas rápidas con «/» y Recordarme (Fase 5, bloque 5), publicado en v0.33.0 (esquema 28).
4j. [Plan de etiquetas en la bandeja](docs/PLAN_ETIQUETAS_BANDEJA.md): chips, filtro por etiqueta y etiquetar desde el chat (Fase 5, bloque 6), publicado en v0.34.0 (sin esquema nuevo).
4l. [Asistente de alta de curso](docs/PLAN_ASISTENTE_CURSO.md): Catálogo → Nuevo curso en cuatro pasos (curso, edición, imagen, revisar); sólo interfaz, rama `feat/asistente-curso`.
4k. [Base de pruebas local](docs/BASE_DE_PRUEBAS.md): `npm run demo` crea una base con un usuario de cada tipo y datos de ejemplo para probar sin tocar producción (herramienta de desarrollo, sin versión ni esquema nuevos; publicada en `main`).
4m. [Preparar marca](docs/PLAN_PREPARAR_MARCA.md): Operación → Preparar marca, lista de verificación por marca (sólo lectura, sin esquema nuevo; publicada en `main`).
4n. [Mensaje de fuera de horario](docs/PLAN_FUERA_DE_HORARIO.md): evento de Contenido con la próxima apertura (sin esquema nuevo; publicado en `main`).
4o. [Respuestas rápidas más fáciles](docs/PLAN_RESPUESTAS_FACILES.md): ejemplos listos (50, [lista](docs/BIBLIOTECA_RESPUESTAS_RAPIDAS.md)), vista previa, búsqueda y duplicar en Mi configuración (sin esquema nuevo; publicado en `main` con 13 ejemplos; la ampliación a 50, rama `feat/biblioteca-consultora`, sin publicar).
4p. [Historial de precio y cupo](docs/PLAN_HISTORIAL_PRECIO_CUPO.md): eventos de precio y cupo, línea de tiempo por edición y avisos; base para llamadas y alertas automáticas (sin esquema nuevo; publicado en `main`).
4q. [Conocimiento por lote y tope de gasto de la IA](docs/PLAN_CONOCIMIENTO_POR_LOTE.md): importar preguntas y respuestas por CSV como borradores, [guía para cargar el contexto](docs/GUIA_CONTEXTO_CONSULTORA.md) y topes mensuales de la IA (sin esquema nuevo; publicado en `main`; la API real se probó en local con la clave del usuario).
4r. [Memoria y contexto de la IA](docs/PLAN_MEMORIA_CONTEXTO.md): selección del conocimiento que recibe la IA, memoria del cliente (sólo de su marca, sin datos de contacto) y preguntas sin respuesta (sin esquema nuevo; publicado en `main`).
4s. [Pauta](docs/PLAN_PAUTA.md): el panel de tráfico («trafiquer») de IPCIL dentro del CRM, Operación → Pauta (**esquema 29**; publicada en `main`).
4t. [Aliados](docs/PLAN_ALIADOS.md): el panel RH de IPCIL dentro del CRM, Operación → Aliados (**esquema 30**; publicado en `main`); formulario público `/aliados` apagado por omisión. Pendiente de IPCIL: comisiones por persona.
4u. [Resumen de conversación](docs/PLAN_RESUMEN_CONVERSACION.md): tarjeta en el chat, por reglas y con IA, y contexto para la IA en chats largos (**esquema 31**; publicado en `main`).
4v. [Mejora de diseño](docs/DISENO_Y_AUDITORIA.md): menú lateral por grupos y Operación por áreas en lugar de 17 pestañas en fila (sólo interfaz; publicado en `main`).
4v2. [Pulido de diseño](docs/DISENO_Y_AUDITORIA.md): Niebla afinado (chat con más conversación, avatares con tono por persona, sombras unificadas, color por etapa, respuesta al cursor); sólo interfaz; publicado en `main`.
4w. [Mensajes programados](docs/PLAN_MENSAJES_PROGRAMADOS.md): botón «Programar» en el chat; salen solos a la hora y las reglas se comprueban al enviar (**esquema 32**; publicado en `main`). Con avisos cuando no salen y panel en Mi día (publicado). Programar materiales del catálogo (temario, precio, fechas, flyer, plantillas aprobadas), armados al enviar (**esquema 37**; publicado en `main`).
4x. [Agenda de citas](docs/PLAN_AGENDA_CITAS.md): «Agendar cita» en el chat, recordatorio opcional al cliente (un mensaje programado), aviso previo y «Mis citas» en Mi día (**esquema 33**; publicado en `main`). Vista semanal «Agenda», sólo lectura (publicada).
4y. [Cupones de descuento](docs/PLAN_CUPONES.md): códigos por marca (porcentaje o monto fijo) que el equipo aplica en Cobrar; los usos se cuentan sobre los pedidos vivos (**esquema 34**; publicado en `main`). El cliente puede escribir su cupón en la pantalla de pago si administración lo permite (**esquema 36**; publicado en `main`).
4zz. [Activar la IA en producción](docs/ACTIVAR_IA_PRODUCCION.md): guía paso a paso (clave sólo en Railway, tope, conocimiento, «Sugerir», evaluación con IA real) y pantalla de estado Operación → Sistema → Inteligencia artificial, sólo lectura y sin secretos (sin esquema nuevo; publicado en `main`).
4z. [API pública y webhooks](docs/PLAN_API_PUBLICA.md): llaves de lectura por marca (`/api/v1`) y destinos de webhooks HTTPS con firma HMAC, reintentos y rechazo de redes internas (**esquema 35**; publicado en `main`, con sus correcciones de seguridad).
4zzz. [Motor de respuestas más preciso](docs/PLAN_MOTOR_PRECISO.md): cómo ahorra tokens el motor (reglas → conocimiento aprobado → Claude), el banco de 49 frases con el que se midió y las reglas de intención que se estrecharon; el chat marca «Automatización · IA» (sin esquema nuevo; publicado en `main`).
4zzzz. [App de prueba para celular](docs/PLAN_APP_DE_PRUEBA.md): el chat del cliente con aspecto de app de mensajería, app instalable «Chat de prueba» que abre el chat y «Invitar a probar» con enlace y QR por curso y canal; no imita a WhatsApp ni a ningún servicio real (sin esquema nuevo; publicado en `main`).
4zzzzz. [Pasarela de prueba a pantalla completa](docs/PLAN_PASARELA_DE_PRUEBA.md): el pago simulado ocupa la pantalla, pasa por «procesando» y termina en aprobado con comprobante de ejemplo o rechazado; sólo interfaz y sin imitar a ninguna pasarela real (publicado en `main`).
4zzzzzz. [Mensajes del asistente más amables](docs/PLAN_MENSAJES_AMABLES.md): todos los textos fijos del asistente en `server/reply-copy.mjs`, sus reglas (datos del catálogo, sin promesas falsas, nota de prueba una sola vez) y cómo personalizarlos por marca sin código y contesta varias preguntas de un mismo mensaje (sin esquema nuevo; publicado en `main`; todo publicado en `main`).
4zzzzzzz. [El asistente aprende de la IA](docs/PLAN_APRENDER_DE_LA_IA.md): las respuestas de Claude aceptadas quedan como borradores de conocimiento (sin datos personales) para aprobar; junto con el selector de nivel legible en Seguimientos, el mensaje para quien prueba y los resultados de la prueba en Actividad (sin esquema nuevo; publicado en `main`).
4zzzzzzzz. [WhatsApp real](docs/PLAN_WHATSAPP_REAL.md): conexión con la API de Meta (Cloud API) que convive con el laboratorio: entrantes de un número real → cliente y conversación, salientes y estados por Meta, un número por marca y pago sin sesión; guía de activación en [ACTIVAR_WHATSAPP_REAL.md](docs/ACTIVAR_WHATSAPP_REAL.md) (**esquema 38**; publicado en `main`; apagado sin `CHANNEL_CONNECTOR=meta`; falta probarlo contra Meta de verdad).
4zzzzzzzzz. [Plantillas de WhatsApp](docs/PLAN_PLANTILLAS_WHATSAPP.md): plantillas aprobadas por Meta para escribir fuera de las 24 horas: administración en Conectores (escribir, enviar a aprobación, sincronizar), «Enviar plantilla» desde el chat y avisos del negocio en espera hasta que la persona responde (**esquema 39**; publicado en `main`; sin probar contra Meta).
4zzzzzzzzzz. [Flujo de bienvenida](docs/PLAN_FLUJO_BIENVENIDA.md): constructor sin código del saludo y el menú con botones por marca (Operación → Ventas y cobro), como capa sobre el motor de respuestas; apagado por omisión (**esquema 40**; publicado en `main`).
4zzzzzzzzzzz. [Aviso de privacidad público](docs/PLAN_AVISO_PRIVACIDAD.md): página estática `/privacidad` que Meta exige para publicar la app de WhatsApp; texto base que la empresa debe revisar; empresa y correo por entorno (sin esquema nuevo; publicado en `main`).
4zzzzzzzzzzzz. [Asistente sin callejones](docs/PLAN_ASISTENTE_SIN_CALLEJONES.md): los mensajes de trato («ok», «sí», «no», «espera», «¿eres un bot?») tienen su respuesta y no cuentan como pregunta sin respuesta; «sí» y «no» se leen contra el último mensaje; y antes de pasar a una persona se le pregunta (sin esquema nuevo; publicado en `main`; falta probarlo en producción y con WhatsApp real).
4zzzzzzzzzzzzz. [Un número de WhatsApp para toda la consultora](docs/PLAN_NUMERO_POR_CONSULTORA.md): el número atiende todos los cursos de la marca; el curso lo decide el anuncio de Meta, lo que la persona escribe o la lista que el asistente le ofrece, y se puede cambiar de curso en el mismo chat (**esquema 41**; publicado en `main`; apagado por número; la llegada por anuncio sólo se probó con un Meta simulado).
4zzzzzzzzzzzzzz. [Conector del CRM para Claude (MCP)](docs/PLAN_MCP_CLAUDE.md): servidor MCP dentro del CRM (`POST /mcp`) para consultar y modificar datos de una marca desde Claude Code con una llave de la API: cursos y aperturas (leer y modificar con revisión), pedidos, contactos, conversaciones y conocimiento en borrador (sin esquema nuevo; rama `feat/mcp-claude`, **sin publicar**; probado con Claude Code contra un servidor local).
4b. [Visión de la plataforma](docs/VISION_PLATAFORMA.md): el CRM como módulo de la plataforma de toda la empresa (IPCIL, Academia, finanzas, canales reales); diagnóstico, arquitectura objetivo y fases.
5. [README](README.md) y [ROADMAP](ROADMAP.md): recorridos del producto y planificación general.

El código y el estado real del repositorio prevalecen si estas notas quedan desactualizadas. Comprueba `git status`, `package.json`, historial de commits y `/api/health` antes de actuar.

## Reglas del proyecto

- Conserva el diseño **Niebla**: blanco, gris, transparencias discretas, bordes finos, tipografía limpia y composición compacta. Los distintivos de canal deben seguir siendo fáciles de reconocer. Revisa escritorio y celular. Reglas medibles (contraste AA con los tokens `--text-2`/`--text-3`, letra mínima de 11 px, áreas táctiles de 40 px, movimiento sólo al navegar) y la auditoría reproducible: [docs/DISENO_Y_AUDITORIA.md](docs/DISENO_Y_AUDITORIA.md).
- Continúa la aplicación actual: Node HTTP, WebSocket, SQLite y JavaScript del navegador. No existe una aplicación React/Next en este repositorio. No emprendas una reescritura como requisito para continuar.
- Mantén el alcance por marca en servidor, archivos, búsquedas, eventos y futuras consultas de IA. Una marca autorizada no equivale a acceso a toda la empresa.
- La etapa comercial pertenece a `opportunities`; el estado abierto/esperando/cerrado pertenece al chat. No vuelvas a mantener dos etapas comerciales independientes.
- Consulta precios, ediciones, promociones y cupos vigentes en la base estructurada. No uses memoria del modelo como fuente comercial.
- Conserva los snapshots y archivos históricos de mensajes. Un cambio de precio o flyer sólo debe afectar nuevos envíos.
- Conserva `expectedRevision`, `clientRef`, vistas previas y transacciones donde corresponden. Un reintento no debe duplicar mensajes, tareas ni cambios de negocio.
- No hagas llamadas de red dentro de una transacción síncrona de SQLite. `transaction()` no admite callbacks asíncronos ni transacciones anidadas.
- Tocar una migración publicada no modifica las bases ya migradas. Añade una migración nueva y pruebas de actualización/persistencia.
- No expongas secretos, cookies, códigos de invitación, copias SQLite, adjuntos privados o archivos de acceso. El repositorio es público.
- Las pruebas en producción deben usar registros propios claramente identificados, cerrar seguimientos y pausar/archivar sus materiales al terminar. No cambies configuración comercial ni conversaciones reales para facilitar una prueba.
- Respeta la autorización y alcance de la solicitud actual. Esta documentación no solicita por sí misma publicar, cambiar credenciales o conectar proveedores.

## Comandos básicos

Desde la raíz de este repositorio, con Node.js 24:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm start
```

`npm start` usa `.env` si existe. Prepara `.env` desde `.env.example` para una instalación local; consulta el runbook antes de usar datos o accesos existentes.

La referencia vigente es **188 pruebas aprobadas** (la de v0.5 fue 57; el número al día está en [docs/ESTADO_ACTUAL.md](docs/ESTADO_ACTUAL.md)), más la revisión visual en computadora y celular de cada bloque. Es evidencia del commit, no garantía de cambios posteriores: tras un cambio hay que volver a comprobarlo.

## Lo siguiente

Última publicación (7 nov 2026): sobre la **v0.34.0** (`/api/health` sigue diciendo 0.34.0) se publicaron, todo en `main` y **apagado o acotado por marca** hasta que administración lo active: menú por grupos y Operación por áreas, mensajes programados (esquema 32) con avisos, panel en Mi día y materiales del catálogo (37), agenda de citas (33) y su vista semanal, cupones (34) y cupón escrito por el cliente (36), API pública de lectura y webhooks salientes (35), estado de la IA con su guía de activación, resumen de conversación (31), Aliados (30) y Pauta (29). Antes: etiquetas en la bandeja v0.34.0, respuestas rápidas v0.33.0 (28), push v0.32.0 (27; la entrega real a un teléfono sigue sin probarse), rendimiento del equipo v0.31.0, portal por roles v0.30.0, campañas v0.29.0 (26) y las Fases 1 y 2 completas en lo que no depende de terceros (esquemas 13–25). No hay proveedores reales, secretos de webhook ni históricos importados en producción. Interruptores, límites e historial completo: [docs/ESTADO_ACTUAL.md](docs/ESTADO_ACTUAL.md).

Siguiente, y casi todo necesita algo del usuario: (1) **verificación autenticada en producción** de lo publicado el 7 nov (el usuario ya confirmó menú, Agenda y «Mis citas»; faltan IA, cupones, API y webhooks, mensajes programados y materiales), siguiendo [docs/ACTIVACION_Y_VERIFICACION.md](docs/ACTIVACION_Y_VERIFICACION.md) (el usuario inicia sesión; no se usan credenciales guardadas); (2) **encender la IA de Claude**: poner la clave en Railway y cargar conocimiento real, con [docs/ACTIVAR_IA_PRODUCCION.md](docs/ACTIVAR_IA_PRODUCCION.md); (3) **reglas de trafiquer y RH** y de comisiones por persona para ampliar el portal; (4) decisión Postgres/Supabase y acceso al proyecto de la Academia para conectar el núcleo real ([PLAN_FASE_2.md](docs/PLAN_FASE_2.md) §2); (5) accesos de las consultoras para Meta y pasarela real. Sin esas piezas, lo que se puede construir sin depender de terceros: constructor de flujos de bienvenida, API de escritura (con idempotencia y consentimiento), programar archivos propios o una secuencia de materiales, vista de mes de la agenda, reabrir conversaciones cerradas en campañas y reportes de cupones por campaña. Acuerda el siguiente paso con el usuario antes de crear rama.

La automatización editable e IA supervisada (4A, 4B, respuestas v2, banco de evaluación) está entregada; falta la prueba con IA real en producción. Los planes históricos siguen en [PLAN_FASE_4.md](docs/PLAN_FASE_4.md), [PLAN_FASE_2.md](docs/PLAN_FASE_2.md), [PLAN_CAMPANAS.md](docs/PLAN_CAMPANAS.md), [PLAN_PORTAL_ROLES.md](docs/PLAN_PORTAL_ROLES.md), [PLAN_PUSH.md](docs/PLAN_PUSH.md) y [PLAN_CHAT_RAPIDO.md](docs/PLAN_CHAT_RAPIDO.md); si contradicen al código, manda el código.
