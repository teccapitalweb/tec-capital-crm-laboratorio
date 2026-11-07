# Guía de uso por rol

Para quien va a **usar** el CRM, no a programarlo. Todo es un laboratorio: los datos, los pagos y los canales son de práctica. Qué está encendido y qué no: [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md). Cómo prender una marca de pruebas y verificar todo: [ACTIVACION_Y_VERIFICACION.md](ACTIVACION_Y_VERIFICACION.md). **Para probar en tu computadora con un usuario de cada tipo** (administración, asesores, contadora, coordinador y clientes) y datos de ejemplo: `npm run demo` ([BASE_DE_PRUEBAS.md](BASE_DE_PRUEBAS.md)).

## Entrada

- **Clientes de prueba:** <https://crm-laboratorio-production.up.railway.app/>. Crean un perfil con nombre, usuario y contraseña (no necesitan su número de WhatsApp) y reciben un número de prueba.
- **Equipo:** <https://crm-laboratorio-production.up.railway.app/crm>. Se entra con la cuenta del equipo. Quien se registró como cliente acepta su **invitación individual** que administración le preparó; el código de invitación es personal y no se comparte.
- El selector **Cliente / Equipo** del menú cambia de experiencia a quien tiene acceso al equipo. En celular el menú es una barra de iconos que se desplaza.
- **El menú del equipo está por grupos:** *Atención* (Mi día, Conversaciones, Contactos, Oportunidades, Tareas), *Gestión* (Catálogo y biblioteca, Operación, Equipo), *Resultados* (Mis resultados, Analítica, Actividad, Presentación) y *Cuenta* (Mi configuración). **Operación** se divide en áreas: *Atención* (Cola, Mis avisos, Coordinación, Macros, Horarios y reparto), *Ventas y cobro* (Pagos, Certificados, Finanzas, Campañas, Seguimientos), *Crecimiento* (Pauta, Aliados) y *Sistema* (Preparar marca, Conectores, Eventos, Históricos, Demo). Cada quien ve sólo lo que su rol permite.
- La verificación en dos pasos es opcional: **Mi configuración → Acceso y seguridad**.

## Cliente de prueba

1. **Explorar cursos:** ve los cursos y ediciones vigentes con precio y fecha.
2. **Nueva conversación:** elige curso, edición y canal simulado (WhatsApp, Instagram o Facebook). La atención automática responde con datos del catálogo; si no sabe, avisa a una persona.
3. Puede adjuntar imágenes, pedir un asesor y, si el equipo lo cobra, pagar desde el enlace en una pantalla con el orden de un pago real (resumen, **Tarjeta** u **OXXO**; tarjetas de prueba 4242… que aprueba y 4000 0000 0000 0002 que rechaza; nada se cobra y no se aceptan tarjetas reales) o mandar su comprobante. Detalle: [PLAN_PAGO_SIMULADO.md](PLAN_PAGO_SIMULADO.md).
4. Si escribe «baja» (u otra frase clara de baja), deja de recibir mensajes automáticos y campañas.
5. Después de una sesión puede recibir una encuesta corta, y al terminar su certificado con un enlace público para verificarlo.

## Asesor (atención y ventas)

- **Mi día:** tareas de hoy y chats por atender.
- **Conversaciones:** bandeja por canal con filtros; abrir un chat muestra el contexto (curso, etapa, ventana de servicio). Desde el chat: responder, adjuntar, usar macros, **Equipo** (mencionar o transferir), **Biblioteca** y **Flyer** (material aprobado), **Cobrar** (si Pagos está activo) y **Tomar chat** (la automatización se detiene mientras una persona lo atiende).
- **Etiquetas en la bandeja:** cada hilo muestra las etiquetas del contacto (VIP, Pidió beca…); el selector **Etiquetas** bajo los filtros deja sólo los hilos con esa etiqueta, y el botón **Etiquetas** del chat las pone o quita y crea nuevas al momento. Son las mismas de Contactos, por marca.
- **Agenda de citas:** junto a Programar, el botón **Agendar cita** fija una llamada, videollamada o cita presencial con esa persona: título, duración, hora (atajos o fecha exacta), enlace o lugar y notas para ti. Si activas **«Recordarle la cita al cliente»** se programa un mensaje con la hora (puedes editar el texto) 30 min, 1 h, 3 h o 1 día antes. Sobre el compositor ves las citas del chat; al empezar puedes marcarlas **Se hizo** o **No asistió**, y moverlas o cancelarlas antes (eso retira el recordatorio). Te llega un aviso 15 minutos antes y en **Mi día → Mis citas** ves las tuyas. Si ya tienes otra a esa hora te lo dice. Detalle: [PLAN_AGENDA_CITAS.md](PLAN_AGENDA_CITAS.md).
- **Mensajes programados:** junto a Enviar, el botón **Programar** deja un mensaje listo para que salga solo. Escribes el mensaje (o lo tomas de lo que ya tenías en el compositor), eliges la hora con un atajo o una fecha exacta y listo. Sobre el compositor ves lo que está por salir en ese chat y puedes **Editar**, **Enviar ahora** o **Cancelar**. Por omisión **no sale si el cliente responde antes** (se puede desactivar) ni si la conversación se cerró; si algo impide que salga, queda anotado el motivo. Sale a tu nombre y deja el chat a tu cargo. Sólo texto. Si no puede salir por algo ajeno a ti, te llega un aviso en *Operación → Mis avisos*, y en **Mi día** ves lo tuyo que está por salir. Detalle: [PLAN_MENSAJES_PROGRAMADOS.md](PLAN_MENSAJES_PROGRAMADOS.md).
- **Respuestas rápidas y Recordarme:** en el compositor escribe **/** y el atajo (por ejemplo `/gracias`) y elige con Enter, Tab o un toque: el texto se inserta con el nombre del cliente y el curso, **sin enviarse** hasta que tú lo envíes. Las creas y editas en **Mi configuración → Respuestas rápidas** (personales; administración también las comparte por marca). El botón **Recordarme** deja una tarea de seguimiento en la oportunidad de ese chat (1 hora, hoy 6 p. m., mañana, 3 días o 1 semana) y te avisa en Mi día. Para precios, fechas y cupos usa los botones Precio y Temario: salen del catálogo vigente.
- **Contactos y Personas:** etiquetas, consentimiento, notas internas, duplicados.
- **Oportunidades y Tareas:** la etapa comercial vive en la oportunidad (nuevo interés → interesado → inscripción solicitada → ganada o perdida); cada etapa admite tareas con fecha y responsable.
- **Operación → Cola de atención, Mis avisos, Macros:** prioridad por espera y objetivo de respuesta.
- **Mis resultados:** sus ventas, comisión pendiente, cartera y avisos (ver abajo).

## Responsable de apertura (coordinación)

Administración lo designa en **Operación → Coordinación** (ficha de la apertura). Una apertura es una edición del catálogo con mínimo de alumnos.

1. La venta confirmada inscribe sola a la persona en la apertura y avisa a quien coordina.
2. Al llegar al mínimo la apertura puede abrirse sola (si «Abrir al llegar al mínimo» está activo) o se abre a mano.
3. Programa **sesiones** con enlace de videollamada (simulado en el laboratorio), registra **asistencia**, sube materiales y marca las sesiones realizadas. Los inscritos reciben recordatorios y, según la marca, la encuesta.
4. Al **cerrar** la apertura se emiten los certificados a quien cumplió la asistencia mínima (automático si «Emitir al cerrar la apertura» está activo, o a mano desde la ficha).
5. **Mis resultados → Mis aperturas** resume inscritos frente al mínimo, próxima sesión, certificados y encuesta, y avisa de lo urgente: faltan inscritos con el inicio cerca, sin sesiones, sesión próxima sin enlace, sesión realizada sin asistencia, apertura cerrada sin certificados.

## Vendedor

No es un permiso aparte: vende quien tiene la **oportunidad a su nombre** cuando se confirma el pago. En **Mis resultados** ve:

- **Ventas y comisiones:** ventas netas del periodo, reembolsos, ticket promedio, por curso, últimas ventas, comisión del periodo, pendiente de pago y últimas liquidaciones.
- **Mi cartera:** oportunidades abiertas por etapa, ganadas y perdidas con % de cierre, tareas abiertas y vencidas, chats a su cargo.

Las ventas que cierra el motor de respuestas sin intervención humana no tienen vendedor. La comisión se calcula con la regla vigente al entrar la venta y queda registrada con esa regla.

## Contadora

Administración concede la **función de contadora** en Operación → Finanzas → Acceso, con permiso opcional para marcar comisiones pagadas. Ve **todas** las marcas en Finanzas: libro de ventas, reembolsos (los registra administración), comisiones, liquidaciones, conciliación contra pedidos, exportación CSV y vista imprimible. No ve conversaciones por ese permiso.

## Diseño y aprobación de contenido

Administración concede estas funciones en Catálogo → Contenido. Diseño crea y edita plantillas por evento, variantes y fichas; **aprobación** las deja listas para enviarse. Sólo lo aprobado sale a clientes. Precios, fechas y cupos siempre salen del catálogo vigente, nunca del texto de la plantilla.

## Administración

- **Equipo:** invitaciones individuales, marcas por persona, restablecer la verificación en dos pasos.
- **Nuevo curso en un solo flujo:** Catálogo → Cursos → **Nuevo curso** abre un asistente de cuatro pasos (curso, edición con precio y fecha, imagen, revisar) que crea el curso, publica la edición y aprueba la imagen; no guarda nada hasta el último paso. Detalle: [PLAN_ASISTENTE_CURSO.md](PLAN_ASISTENTE_CURSO.md).
- **Catálogo:** cursos, ediciones, promociones, flyers, plantillas, conocimiento aprobado, banco de evaluación, importación CSV. **La imagen de un curso** es un flyer aprobado de una de sus ediciones (así nunca sale con precio o fecha viejos): en la ficha del curso, **Imagen del curso → Agregar imagen** abre el formulario de flyer con la edición ya elegida; guárdalo como borrador y apruébalo. Si ya hay un flyer aprobado pero no se muestra, la ficha dice por qué (por ejemplo «Edición en borrador»). Archivos: PNG, JPG, WEBP, GIF o PDF de hasta 4 MB.
- **Resumen de la conversación:** en cada chat, arriba, la tarjeta **Resumen** dice en qué quedó (qué busca la persona, de qué preguntó, qué objeciones puso, qué hay pendiente y el siguiente paso sugerido). **Generar** o **Actualizar** lo rehace; avisa cuántos mensajes nuevos hay desde entonces. Al pasar un chat a una persona queda listo solo. Detalle: [PLAN_RESUMEN_CONVERSACION.md](PLAN_RESUMEN_CONVERSACION.md).
- **Aliados (RH):** Operación → **Aliados**. *Postulaciones* es la bandeja de academias que quieren ser Aliado Certificador: las nuevas se contactan en menos de 24 horas (las que se pasan se marcan en rojo), se aprueban o rechazan con nota y se prepara el texto de la invitación para copiar y enviar tú; *Vincular WhatsApp* lleva las solicitudes de marcas que piden ayuda para conectar su WhatsApp. Administración da la función en *Quién lleva RH*. El formulario público `/aliados` está apagado hasta que haya aviso de privacidad revisado. Detalle: [PLAN_ALIADOS.md](PLAN_ALIADOS.md).
- **Pauta (trafiquer):** Operación → **Pauta**. *Campañas* diagnostica cada lanzamiento (¿va a abrir?, ¿le subo?, ¿es Ads o es ventas?) y lleva la cola de acciones atendidas; *Captura diaria* es donde se copia de Meta el acumulado de pauta y mensajes; *Decisiones del gerente* recibe lo que administración decide subir, bajar o pausar; *Reporte* da el costo por mensaje y por alumno. Administración da la función en *Quién lleva la pauta*. Detalle: [PLAN_PAUTA.md](PLAN_PAUTA.md).
- **Preguntas que no supimos responder:** al abrir Catálogo → Conocimiento, arriba aparecen las preguntas de los clientes (últimos 30 días) que el motor no pudo contestar con conocimiento aprobado, agrupadas y de la más repetida a la menos; **Crear respuesta** abre el editor con la pregunta lista. Es la forma de enseñarle al sistema lo que más falta. Cómo recibe contexto la IA: [PLAN_MEMORIA_CONTEXTO.md](PLAN_MEMORIA_CONTEXTO.md).
- **Conocimiento por lote:** Catálogo → Conocimiento → **Importar preguntas (CSV)**: descarga la plantilla, la consultora la llena con sus respuestas reales (sin precios ni fechas), vista previa y se importa como **borrador**; después administración aprueba cada entrada. Guía completa: [GUIA_CONTEXTO_CONSULTORA.md](GUIA_CONTEXTO_CONSULTORA.md). Cuando haya clave de la IA, el uso del mes y su tope se ven en Operación → Seguimientos.
- **Precio y cupo de una edición:** Catálogo → Ediciones → **Precio y cupo** muestra la línea de tiempo (precio que subió o bajó, cupo que se movió, cuándo se agotó o se liberó un lugar) con quién lo hizo. El equipo recibe un aviso en «Mis avisos» cuando se agota, se libera un lugar, quedan pocos (20 % del total) o cambia el precio. Detalle: [PLAN_HISTORIAL_PRECIO_CUPO.md](PLAN_HISTORIAL_PRECIO_CUPO.md).
- **Respuestas rápidas más fáciles:** en Mi configuración → Respuestas rápidas, **Ejemplos listos** agrega 50 respuestas de arranque de consultora de cursos (con buscador, por grupo o todas) con un clic (a las tuyas o, en administración, a una marca); al crear una ves cómo le llegará al cliente y el atajo se sugiere solo; hay búsqueda, filtros y **Duplicar**. Detalle: [PLAN_RESPUESTAS_FACILES.md](PLAN_RESPUESTAS_FACILES.md).
- **Mensaje de fuera de horario:** en Catálogo → Plantillas crea una plantilla con el escenario «Evento · fuera de horario» (puedes usar `{{nombre}}`, `{{marca}}` y `{{apertura}}`), apruébala y asígnala en Contenido → Eventos. Quien escriba con la marca cerrada y deba esperar a una persona recibirá el aviso con la hora de apertura. Detalle: [PLAN_FUERA_DE_HORARIO.md](PLAN_FUERA_DE_HORARIO.md).
- **Preparar marca:** Operación → **Preparar marca** muestra, por marca, qué está listo y qué falta para atender y vender (curso, edición vigente, conocimiento aprobado, asesores, automatización y los extras), con un botón a cada pantalla. Sólo lee; no enciende nada. Detalle: [PLAN_PREPARAR_MARCA.md](PLAN_PREPARAR_MARCA.md).
- **Operación:** horarios y reparto, **Preparar marca**, Pagos, Coordinación, Certificados, Finanzas, Seguimientos (automatización, recetas, respuestas automáticas, canal simulado), **Campañas**, Demo, Conectores, Eventos, Históricos.
- **Mis resultados → Ver a:** el trabajo de cualquier persona del equipo, y el **Rendimiento del equipo** (ventas, cierre, tareas vencidas, tiempo de primera respuesta y avisos de aperturas por persona).
- **Analítica y Modo presentación:** cifras en vivo y el guion de 13 pasos para presentar el proyecto.
- **Interruptores:** todo nace apagado por marca; la tabla con cada uno está en [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md).

## Campañas (administración)

1. **Operación → Campañas → Encender** la marca (y tener la automatización de la marca activa en Seguimientos).
2. **Nueva campaña:** nombre, plantilla **aprobada**, público (etapas, curso, canal, etiquetas, días sin responder) y si exige consentimiento registrado (recomendado).
3. **Calcular la vista previa:** cuántas personas, a quiénes excluye y por qué, el mensaje tal como se verá y el costo estimado.
4. **Programar** (ahora o con fecha) confirmando el número de destinatarios. Si el público cambió, pide revisar de nuevo.
5. El detalle muestra enviados, entregados, leídos, respuestas a 7 días, bajas y omitidos por motivo. **Cancelar** detiene lo que falta; lo ya enviado se conserva.

No se interrumpe a quien atiende una persona, no se escribe a quien pidió la baja y hay una separación mínima entre campañas para la misma persona (por omisión 72 h).

## Notificaciones en el celular y app instalable (equipo)

Cada persona del equipo decide si quiere recibir los avisos de **Mis avisos** (chat asignado, menciones, transferencias, objetivos de respuesta, pagos y comprobantes, aperturas) como notificación aunque tenga el CRM cerrado.

1. **Mi configuración → Notificaciones en este dispositivo → Activar.** El navegador pide permiso; si lo bloqueaste antes, se desbloquea en la configuración del sitio (candado junto a la dirección).
2. **Enviar prueba** confirma que llega. Cada dispositivo se activa por separado (hasta 10 por persona) y se desactiva desde la misma pantalla.
3. Elige qué grupos quieres: chats, objetivos de respuesta, pagos y comprobantes, o aperturas, certificados y seguimientos.
4. Sólo se manda lo que sigue sin leer unos 15 segundos después; si ya lo viste en el CRM, no suena.
5. **Instalar app** (en el mismo panel o en la barra del navegador) deja TEC Capital como aplicación en el escritorio o en la pantalla de inicio. **En iPhone o iPad** (iOS 16.4 o superior) las notificaciones sólo funcionan con la app instalada: Compartir → Añadir a pantalla de inicio, y se activan desde ese icono.

Los clientes no reciben notificaciones push.

## Glosario

- **Marca / consultora:** cada una de las 15 empresas con sus cursos.
- **Curso y edición:** el curso es el contenido; la edición es una fecha concreta con precio, cupo y promoción.
- **Apertura:** una edición en operación (mínimo, responsable, sesiones, asistencia).
- **Receta:** regla de seguimiento (si el cliente calla, enviar plantilla, crear tarea, avisar).
- **Paso:** una acción diferida del motor (un seguimiento o el envío de una campaña a una persona), con reintentos y bitácora.
- **Ventana de servicio:** 24 h desde el último mensaje del cliente (72 h si llegó por anuncio) en las que se puede escribir libremente; fuera, sólo plantillas.
- **Persona:** la identidad única de un cliente a través de varias marcas.
- **Núcleo compartido:** la base futura (Postgres) a la que el CRM ya emite eventos firmados, hoy simulada.
