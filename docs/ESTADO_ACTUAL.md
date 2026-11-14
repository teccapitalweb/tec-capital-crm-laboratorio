# Estado actual del CRM

Página de referencia corta y vigente. Si algo de aquí contradice al código, **el código manda**: comprueba `git status`, `package.json`, `git log` y `/api/health` antes de actuar. Al publicar un cambio, actualiza esta página (versión, esquema, pruebas y fecha). Última actualización: **13 nov 2026**.

## Identificación

| Dato | Valor |
| --- | --- |
| Producto | CRM de TEC Capital para 15 marcas de cursos (hoy 3 marcas y 6 cursos de demostración cargados) |
| Versión publicada | **0.34.0** en `main` (`/api/health` sigue diciendo 0.34.0). Última publicación, **14 nov 2026 (tarde)**: **tercera tanda** (commit `2383fcc`), sin cambios visibles: contrato del canal 1.1, cimientos de difusiones con motor de costos (reconstruye `campaigns`, `campaign_recipients` y `wa_templates`), importación de contactos por CSV (pantalla en vista previa) y cola de trabajos. Antes, el mismo día: segunda tanda (`8bd17ef`: botón «Cerrar sesión», teléfono canónico, fusión segura, recepción duradera, permisos, kit y tres pantallas en vista previa); el 13 nov, los cimientos y la corrección del arranque |
| Pendiente de publicar | **Cuarta tanda de la construcción** (rama `chore/f0-01-codificacion`; detalle en [CONTINUIDAD.md](CONTINUIDAD.md)), sin cambios visibles: plantillas completas de WhatsApp (encabezado, pie y botones, adopción por lote; pantalla «Plantillas» en vista previa) y audiencias (listas, segmentos y listas de exclusión; pantalla «Audiencias» en vista previa); una migración con nombre más (`41+10.f226e990`). También: **Corrección de la evaluación con IA** (rama `fix/evaluacion-ia`: el puntaje se leía como fracción y daba «Lista para responder» con 5,9 %; en «Sugerir» el banco nunca podía pasar), sin esquema nuevo. También: **Auditoría de celular, ronda 3** (áreas táctiles de 40 px en casillas, horas, resúmenes desplegables, tachar tareas y botones de ícono; tablas que se salían de su panel; sólo CSS), rama `feat/mejora-diseno-3`. Ya publicados desde la v0.34.0 (todos sobre `main`, `/api/health` sigue diciendo 0.34.0): menú por grupos y Operación por áreas, mensajes programados (esquema 32) con avisos, panel en Mi día y **materiales del catálogo** (esquema 37), agenda de citas (33) y vista semanal, cupones (34) y cupón escrito por el cliente (36), API pública y webhooks (35, con su corrección de seguridad), estado de la IA y guía de activación, resumen de conversación (31), Aliados (30), Pauta (29) y lo anterior. El usuario ya confirmó en producción el menú agrupado, Agenda y «Mis citas» con una cita real |
| Esquema SQLite | **41** (un número de WhatsApp para toda la consultora). La escalera `user_version` está **cerrada en la 41** y lo nuevo son **migraciones con nombre** (`server/migrations/named/<área>/`; hoy ninguna): la identidad del esquema es `41`, o `41+N.<huella>` con N migraciones con nombre; la imprime `npm run schema:id` y la devuelve `/api/health` en `schema` (producción: `41`). Respaldo previo al migrar: `backups/before-*` |
| Pruebas | **605** y 19 de navegador en `main`; **616** y **23 de navegador** en la rama de integración (`npm test`, `npm run test:ui`); `npm run check` limpio (codificación, sintaxis, ESLint y formato) |
| CRM del equipo | <https://crm-laboratorio-production.up.railway.app/crm> |
| Experiencia del cliente | <https://crm-laboratorio-production.up.railway.app/> |
| Repositorio | <https://github.com/teccapitalweb/tec-capital-crm-laboratorio>, rama `main` (público: nada de secretos) |
| Tecnología | Node 24 (HTTP + WebSocket), SQLite, JavaScript del navegador. Sin React/Next. Una sola instancia |
| Diseño | Niebla con acento petróleo: [DISENO_Y_AUDITORIA.md](DISENO_Y_AUDITORIA.md) |

**Propósito actual:** simulación para diseñar y presentar el flujo completo. WhatsApp, Instagram, Facebook, pagos, correo y calendario son **simulados**; las conexiones reales llegan cuando las consultoras entreguen accesos ([VISION_PLATAFORMA.md](VISION_PLATAFORMA.md)).

## Qué existe

| Área | Qué hace | Dónde se ve | Detalle |
| --- | --- | --- | --- |
| Conversaciones | Clientes escriben por canales simulados; el equipo atiende con cola, reparto, horarios, transferencias, menciones, macros y avisos | Conversaciones, Operación → Cola | [ARQUITECTURA.md](ARQUITECTURA.md) |
| Catálogo y biblioteca | Cursos, ediciones, promociones, flyers, plantillas aprobadas, conocimiento y banco de evaluación; importación por CSV | Catálogo y biblioteca | README |
| Respuestas automáticas | Motor v2 por marca: apagado, sugerir, plantillas o autónomo con IA (sólo conocimiento aprobado) | Operación → Seguimientos | README |
| Seguimientos | Recetas por silencio, tarea vencida o espera humana, con simulación previa, consentimiento y tope de frecuencia | Operación → Seguimientos | [PLAN_FASE_4.md](PLAN_FASE_4.md) |
| Canal simulado | Estados enviado/entregado/leído/fallido, ventana de 24 h, categorías y costo estimado | Seguimientos → Canal simulado | [CONECTORES.md](CONECTORES.md) |
| Venta y pagos | Pedido con precio vigente, pago simulado (tarjeta, OXXO, transferencia con comprobante), inscripción y pagos por sesión | Operación → Pagos, botón Cobrar | README |
| Coordinación | Aperturas por edición: mínimo, responsable, sesiones con enlace, recordatorios, asistencia, materiales, encuestas, bitácora de eventos | Operación → Coordinación, Eventos | README |
| Certificados | Folio IPCI secuencial, QR, verificación pública, revocación, créditos opcionales | Operación → Certificados, `/verificar/<folio>` | README |
| Finanzas | Libro de ventas por eventos, comisiones con regla, liquidaciones, reembolsos, CSV, vista imprimible | Operación → Finanzas | README |
| Personas y consentimiento | Una identidad entre marcas, baja y consentimiento a nivel persona, fusión con vista previa | Contactos → Personas | README |
| Etiquetas en la bandeja | Las etiquetas de Contactos se ven en cada hilo, se filtra la bandeja por etiqueta y se etiqueta desde el chat | Conversaciones | [PLAN_ETIQUETAS_BANDEJA.md](PLAN_ETIQUETAS_BANDEJA.md) |
| Respuestas rápidas y Recordarme | Escribir `/atajo` en el chat inserta un texto del equipo con el nombre del cliente y el curso (no envía); «Recordarme» deja una tarea de seguimiento en un clic | Chat, Mi configuración → Respuestas rápidas | [PLAN_CHAT_RAPIDO.md](PLAN_CHAT_RAPIDO.md) |
| Notificaciones push y app instalable | Los avisos del equipo llegan al celular o escritorio, cifrados, sólo si cada persona los activa; manifiesto, service worker e iconos para instalar | Mi configuración → Notificaciones en este dispositivo | [PLAN_PUSH.md](PLAN_PUSH.md) |
| Campañas | Plantilla aprobada a un segmento, vista previa con exclusiones, programación, resultados | Operación → Campañas | [PLAN_CAMPANAS.md](PLAN_CAMPANAS.md) |
| Portal por roles | «Mis resultados»: ventas, comisiones, cartera, aperturas y avisos; administración ve a otra persona y el rendimiento del equipo | Menú → Mis resultados | [PLAN_PORTAL_ROLES.md](PLAN_PORTAL_ROLES.md) |
| Analítica y presentación | Embudo, tiempos, atención; tablero en vivo y guion de 13 pasos | Analítica, Modo presentación | README |
| Contenido | Plantillas por evento, variantes por IA validadas y fichas | Catálogo → Contenido | README |
| Conectores y núcleo | Contrato de canal y pago (Meta, Stripe, Conekta) y outbox firmado hacia Postgres/Supabase, ambos simulados | Operación → Conectores | [CONECTORES.md](CONECTORES.md), [NUCLEO.md](NUCLEO.md) |
| Históricos IPCIL | Importación JSON/CSV de alumnos, aperturas, ventas y certificados del panel actual, sólo lectura | Operación → Históricos | README |
| Seguridad y respaldo | Verificación en dos pasos opcional, invitaciones individuales, respaldos periódicos, alcance por marca en servidor | Mi configuración, Equipo | [OPERACION_Y_PRUEBAS.md](OPERACION_Y_PRUEBAS.md) |

## Interruptores: todo nace apagado

Ninguna función por marca está encendida en producción. Apagar un interruptor detiene la función sin borrar datos.

| Función | Dónde se enciende | Apagado, ¿qué pasa? |
| --- | --- | --- |
| Automatización de la marca (necesaria para recetas y campañas) | Operación → Seguimientos → Activar / Desactivar por marca | No se programa ningún paso diferido |
| Pausa global | Seguimientos → «Pausar todo» | Detiene todos los pasos de todas las marcas y los retoma al reanudar |
| Mensaje de fuera de horario | Catálogo → Contenido → Eventos: plantilla aprobada para «Fuera de horario» | No se envía ningún aviso |
| Respuestas automáticas | Seguimientos → «Respuestas automáticas a clientes» (apagado, sugerir, plantillas, autónomo) | «Plantillas» es el comportamiento de siempre |
| Canal simulado | Seguimientos → Canal simulado → Activo | Sin estados de entrega ni ventana de 24 h |
| Pagos | Operación → Pagos → Activa | Sin botón Cobrar ni pedidos |
| Coordinación automatizada | Coordinación → «Automatización por marca»: Automatización activa, Abrir al llegar al mínimo, Cobrar sesiones con el recordatorio, encuesta | Las aperturas se gestionan a mano |
| Emisión de certificados | Certificados → «Emisión por marca»: Emitir al cerrar la apertura, créditos | Sólo emisión manual |
| Campañas | Campañas → Encender / Apagar y Ajustes (separación, ritmo, público máximo) | No se puede programar ni se envía |
| Notificaciones push | Mi configuración → «Notificaciones en este dispositivo» → Activar (cada persona y dispositivo); `PUSH_DISABLED=1` las apaga en el entorno | Los avisos sólo se ven dentro de la aplicación |
| Simulador de clientes | Operación → Demo; `SIMULATOR_DISABLED=1` lo oculta | Sin clientes ficticios |
| Función de contadora | Finanzas → Acceso (administración) | Sólo administración ve Finanzas |
| Función de trafiquer | Pauta → Quién lleva la pauta (administración) | Sólo administración ve Pauta |
| Función de RH | Aliados → Quién lleva RH (administración) | Sólo administración ve Aliados |
| Formulario público de aliados | `ALLY_FORM_ENABLED=1` en el entorno (necesita aviso de privacidad revisado) | `/aliados` responde 404 |
| Funciones de diseño y aprobación | Catálogo → Contenido (administración) | Sólo administración diseña y aprueba |
| Verificación en dos pasos | Mi configuración → Acceso y seguridad (cada persona) | Sólo contraseña |
| Núcleo compartido | `CORE_SINK_URL` y `CORE_SINK_SECRET` en el entorno | Outbox simulado: nada sale del servidor |
| Conectores reales | `CHANNEL_CONNECTOR`, `PAYMENT_CONNECTOR` y sus secretos en el entorno | Todo simulado |
| WhatsApp real (publicado; apagado por omisión) | `CHANNEL_CONNECTOR=meta` + `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_PHONE_NUMBER_ID`; cada número se asigna a su marca en Operación → Conectores | Apagado: nada entra ni sale por Meta |
| IA real | `AI_PROVIDER=claude` y `ANTHROPIC_API_KEY` en el entorno; modelo `AI_MODEL` (por omisión `claude-sonnet-5-5`), topes `AI_MONTHLY_CALL_LIMIT` / `AI_MONTHLY_TOKEN_LIMIT` y `AI_KB_TOP_K` (entradas de conocimiento por llamada, 6) y `AI_SUMMARY_MODEL` (resúmenes, `claude-haiku-5-5`) | Simulador local sin costo |

Variables y respaldos: [OPERACION_Y_PRUEBAS.md](OPERACION_Y_PRUEBAS.md). Secretos: sólo en el entorno de Railway, nunca en el repositorio.

## Límites conocidos (dichos con honestidad)

- Todo es simulación: no hay Meta, pasarela, IA real, calendario real ni facturación. Las cifras son de práctica.
- Las campañas sólo llegan a conversaciones **abiertas** y no se pausan una a una (se cancelan, o se pausa la marca o la automatización global). Reactivar chats cerrados exige decidir cómo reabrirlos respetando la ventana de servicio.
- «Mis resultados» es de sólo lectura. Las ventas se atribuyen a quien tenía la oportunidad al confirmarse el pago; las del motor de respuestas no tienen vendedor.
- Las notificaciones push están verificadas contra el vector oficial del RFC 8291 y un receptor local, pero **la entrega real a un teléfono no se ha probado**. Es la única salida real a internet del laboratorio y es opt-in por dispositivo.
- **Pauta** (trafiquer, publicada) y **Aliados** (RH, sin publicar) ya existen en el CRM a partir del panel de IPCIL; falta lo de **comisiones por persona**. La pauta se captura a mano (no hay conexión con Meta) y Aliados no envía correos: la invitación es un texto para copiar.
- La base es SQLite en un volumen, con una sola instancia. El crecimiento a varias instancias llega con la migración a Postgres.
- La IA real (`AI_PROVIDER=claude`) **se probó en local el 6 nov 2026** con una clave del usuario (copia de la base de demostración, sin tocar producción): respondió con conocimiento aprobado, no inventó precios ni confirmó pagos y el contador de uso cuadró. Sigue **apagada** en producción; falta cargar conocimiento real de las consultoras. Para encenderla paso a paso (clave en Railway, tope, conocimiento, modo «Sugerir», evaluación con IA real) y ver qué falta por marca: [ACTIVAR_IA_PRODUCCION.md](ACTIVAR_IA_PRODUCCION.md) y Operación → Sistema → Inteligencia artificial.
- Faltan por cargar las 15 marcas y unos 120 cursos con sus fechas, responsables y piezas aprobadas. No se inventan.
- La verificación **autenticada en producción** de los bloques recientes (campañas, portal, históricos, finanzas, certificados, coordinación) está pendiente: sólo se verificó sin sesión (archivos servidos, 401, health, CI).

## Qué necesita una decisión o un acceso tuyo

1. **Base única Postgres/Supabase** y acceso al proyecto de la Academia para conectar el núcleo real ([PLAN_FASE_2.md](PLAN_FASE_2.md) §2).
2. **Reglas de trafiquer y RH** y de comisiones por persona (cómo trabaja hoy cada rol del panel IPCIL).
3. **Una sesión de administración** para la verificación autenticada en producción ([ACTIVACION_Y_VERIFICACION.md](ACTIVACION_Y_VERIFICACION.md)).
4. **Clave de API de Claude** en un entorno aislado para probar la IA real.
5. **Accesos de las consultoras** (Meta, pasarela) para pasar de simulado a real.
6. **Catálogo oficial** de marcas y cursos.

## Historial de versiones publicadas

| Versión | Contenido |
| --- | --- |
| 0.2–0.5 | Espacio comercial, seguimiento consistente, catálogo y biblioteca, operación del equipo |
| 0.6 | Motor de automatización durable y recetas por silencio |
| 0.7 | Respaldos periódicos e importación de catálogo por CSV |
| 0.8 | Contactos: etiquetas, duplicados, fusión y exportación |
| 0.9 | Analítica comercial |
| 0.10 | Consentimiento, baja y tope de frecuencia |
| 0.11 | Disparadores nuevos de recetas |
| 0.12 | Festivos por marca |
| 0.13 | Verificación en dos pasos del equipo |
| 0.14 | Refinamiento visual con auditoría medible |
| 0.15–0.20 | Fase 1: motor de respuestas v2, simulador, canal simulado, pago simulado, modo presentación, contrato de conectores, banco de evaluación |
| 0.21–0.28 | Fase 2: eventos y coordinación (esquema 19), Finanzas (20), identidad de persona (21), certificación (22), contenido (23), pagos por sesión y encuestas (24), núcleo compartido (sin esquema) e históricos IPCIL (25) |
| (sin versión) | Ajuste visual «color sobrio»: acento petróleo en toda la aplicación |
| 0.29 | Campañas y envíos segmentados (esquema 26) |
| 0.30 | Portal por roles «Mis resultados» (sin esquema) |
| 0.31 | Rendimiento del equipo para administración y documentación de punta a punta (sin esquema) |
| 0.32 | Notificaciones push y app instalable (esquema 27) |
| 0.33 | Respuestas rápidas con «/» y Recordarme en el chat (esquema 28) |
| 0.34 | Etiquetas en la bandeja: chips, filtro y etiquetar desde el chat (sin esquema) |

El detalle de cada entrega, con evidencia, está en [CONTINUIDAD.md](CONTINUIDAD.md).

## Cómo retomar

```sh
npm ci --ignore-scripts
npm run check
npm test
npm start
```

1. Lee [CLAUDE.md](../CLAUDE.md) y esta página.
2. Un bloque = rama `feat/<bloque>` desde `main` → código con **migración con nombre**, aditiva, si hace falta (la escalera está cerrada; lo nuevo va en `server/modules/` y `public/screens/`: [GUIA_MODULOS.md](GUIA_MODULOS.md)) → prueba nueva y suite completa → revisión en navegador local (escritorio y 375 px) con la auditoría de diseño → documentación y versión → commit.
3. **Publicar sólo con la frase «Sí, publicar»**: avance rápido a `main`, esperar el despliegue, verificar versión, archivos servidos, rutas protegidas y CI, y registrar la publicación en [CONTINUIDAD.md](CONTINUIDAD.md).
4. No cambiar configuración comercial ni conversaciones reales para facilitar una prueba. Pruebas en producción: registros propios identificados, cerrar y archivar al terminar.
