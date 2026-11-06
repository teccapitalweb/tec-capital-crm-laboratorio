# Biblioteca de mensajes rápidos para una consultora de cursos

Instantánea para **revisar el tono y el contenido** sin abrir el CRM. La fuente es `STARTER` en `server/quickreplies.mjs`; si algo no te convence, dime el atajo y lo cambio. En el CRM aparecen en Mi configuración → Respuestas rápidas → **Ejemplos listos** y cada persona las agrega con un clic.

## Criterio de calidad (lo hace cumplir una prueba)

- Se dirige a la persona por su nombre y es breve (entre 30 y 400 caracteres).
- **Escucha antes de vender y no presiona**: pregunta, ofrece ayuda y respeta el «no».
- **No afirma nada que varíe por marca o curso**: ni precios, fechas, cupos, descuentos, garantías, certificados, validez ni grabaciones. Eso sale del catálogo y de las plantillas aprobadas, o lo confirma una persona («lo confirmo con el equipo»).
- Sin números, sin gritos y sin exceso de signos. Sólo usa `{{nombre}}`, `{{nombre_completo}}`, `{{curso}}`, `{{edicion}}`, `{{marca}}` y `{{asesor}}`.
- Insertar nunca envía: la persona la revisa y la manda.

## Saludar

| Atajo | Para qué | Texto |
| --- | --- | --- |
| `/hola` | Saludo inicial | Hola {{nombre}}, soy {{asesor}} de {{marca}}. ¡Gracias por escribirnos! ¿En qué te puedo ayudar con {{curso}}? |
| `/buenosdias` | Saludo con calidez | Buenos días, {{nombre}}. Soy {{asesor}} de {{marca}}. Qué gusto saludarte; cuéntame, ¿cómo te puedo ayudar con {{curso}}? |
| `/gracias` | Agradecer el interés | Hola {{nombre}}, gracias por tu interés en {{curso}}. Soy {{asesor}} de {{marca}} y con gusto te acompaño. |
| `/disculpa` | Disculpa por la espera | Disculpa la espera, {{nombre}}. Ya estoy contigo; soy {{asesor}} de {{marca}}. |

## Descubrir

| Atajo | Para qué | Texto |
| --- | --- | --- |
| `/objetivo` | ¿Qué quieres lograr? | Para recomendarte lo mejor, {{nombre}}, cuéntame: ¿qué te gustaría lograr con {{curso}}? |
| `/perfil` | Conocer su experiencia | {{nombre}}, ¿a qué te dedicas o qué experiencia tienes en el tema? Así te explico si {{curso}} es lo que necesitas. |
| `/cuando` | ¿Para cuándo lo buscas? | ¿Cuándo te gustaría empezar, {{nombre}}? Con eso reviso la edición que mejor te acomode. |
| `/equipo` | ¿Es para ti o para tu equipo? | ¿La capacitación es para ti o para otras personas de tu equipo, {{nombre}}? Si son varias, lo vemos juntos. |
| `/comonos` | ¿Cómo nos conociste? | {{nombre}}, por curiosidad, ¿cómo conociste {{marca}}? Me ayuda a atenderte mejor. |

## Informar

| Atajo | Para qué | Texto |
| --- | --- | --- |
| `/info` | Ofrecer información | Con gusto te cuento todo sobre {{curso}}, {{nombre}}. ¿Prefieres que te comparta el temario, las fechas o cómo inscribirte? |
| `/flyer` | Enviar la información del curso | Te comparto la información de {{curso}} para que la veas con calma, {{nombre}}. Cualquier duda me escribes y te ayudo con gusto. |
| `/temario` | Invitar a revisar el temario | Revisa con calma el temario de {{curso}}, {{nombre}}. Si algún tema te genera duda, me dices y lo platicamos. |
| `/modalidad` | ¿Cómo prefieres tomarlo? | ¿Cómo prefieres llevar el curso, {{nombre}}? Con gusto reviso el horario y la modalidad que mejor se adapten a ti. |
| `/espera` | Pedir un momento | Dame un momento, {{nombre}}, lo reviso y te respondo enseguida. |
| `/confirmar` | Lo confirmo con el equipo | Quiero darte la información correcta, {{nombre}}. Lo confirmo con el equipo de {{marca}} y te respondo por aquí en cuanto lo tenga. |
| `/duda` | Revisar antes de responder | Buena pregunta, {{nombre}}. Déjame revisarlo bien para no darte información a medias; te respondo enseguida. |
| `/datos` | Pedir datos para inscribirlo | Para continuar con tu inscripción a {{curso}}, {{nombre}}, ¿me compartes tu nombre completo y tu correo electrónico? |

## Objeciones

| Atajo | Para qué | Texto |
| --- | --- | --- |
| `/caro` | «Me parece caro» | Te entiendo, {{nombre}}, es una decisión importante. Cuéntame qué te preocupa y revisamos juntos las opciones de pago que sí están disponibles en {{marca}}. |
| `/pensarlo` | «Lo voy a pensar» | Claro, {{nombre}}, tómate tu tiempo. Si te surge cualquier duda mientras decides, aquí estoy. ¿Te parece si te escribo más adelante para saber cómo vas? |
| `/tiempo` | «No tengo tiempo» | Entiendo, {{nombre}}, el tiempo es lo más valioso. Cuéntame cómo es tu semana y reviso si {{curso}} se ajusta a tu ritmo antes de que decidas. |
| `/sirve` | «¿Me sirve este curso?» | Es normal dudar si {{curso}} es para ti, {{nombre}}. Cuéntame tu experiencia y te digo con honestidad si te conviene o si hay otra opción mejor. |
| `/confianza` | «¿Es confiable?» | Haces bien en preguntar, {{nombre}}. Con gusto resuelvo lo que necesites saber de {{marca}} y de {{curso}} para que decidas con tranquilidad. |
| `/comparar` | «Estoy viendo otras opciones» | Qué bien que compares, {{nombre}}. Dime qué otra opción estás viendo y qué es lo más importante para ti, y te ayudo a decidir con claridad. |
| `/nointeresa` | «No me interesa» | Gracias por avisarme, {{nombre}}, lo respeto. Si más adelante te interesa algo de {{marca}}, aquí estaremos. ¡Mucho éxito! |

## Inscripción

| Atajo | Para qué | Texto |
| --- | --- | --- |
| `/inscribir` | Invitar a inscribirse | Si ya lo decidiste, {{nombre}}, te ayudo a inscribirte a {{curso}} ahora mismo. Sólo necesito unos datos y te envío tu enlace de pago. |
| `/edicion` | Confirmar la edición | Antes de continuar, {{nombre}}, confirmo contigo: ¿te inscribo a {{curso}} en la edición {{edicion}}? |
| `/listo` | Ya tengo tus datos | ¡Excelente decisión, {{nombre}}! Ya tengo lo necesario para tu inscripción a {{curso}}. En un momento te comparto los siguientes pasos. |
| `/factura` | Pide factura | Con gusto, {{nombre}}. Confirmo con el equipo de {{marca}} cómo solicitarla y te explico el proceso por aquí. |

## Pagos

| Atajo | Para qué | Texto |
| --- | --- | --- |
| `/pagar` | Ofrecer el enlace de pago | Para inscribirte a {{curso}} puedo enviarte tu enlace de pago aquí mismo, {{nombre}}. ¿Te lo mando? |
| `/metodo` | ¿Cómo prefieres pagar? | ¿Cómo prefieres pagar, {{nombre}}? Dime y te indico los pasos del método disponible que mejor te funcione. |
| `/pendiente` | Recordar un pago pendiente | Hola {{nombre}}, vi que tu pago de {{curso}} sigue pendiente. ¿Tuviste algún problema con el enlace? Si quieres, te ayudo a completarlo. |
| `/fallo` | El pago no pasó | Lamento el inconveniente, {{nombre}}. Cuéntame qué mensaje te apareció y lo revisamos juntos para que puedas completar tu pago sin problema. |
| `/comprobante` | Recibí tu comprobante | Recibí tu comprobante, {{nombre}}. Lo reviso y te confirmo tu inscripción a {{curso}} en cuanto esté validado. |
| `/pagado` | Pago confirmado (úsala sólo si ya lo validaste) | ¡Listo, {{nombre}}! Tu pago quedó confirmado y ya estás inscrito en {{curso}} ({{edicion}}). Bienvenido a {{marca}}. |

## Seguimiento

| Atajo | Para qué | Texto |
| --- | --- | --- |
| `/seguimiento` | Retomar la conversación | Hola {{nombre}}, ¿pudiste revisar la información de {{curso}}? Si tienes alguna duda, aquí estoy para ayudarte. |
| `/sigues` | ¿Todavía te interesa? | Hola {{nombre}}, te escribo para saber si aún te interesa {{curso}}. Si prefieres que no te escribamos más, dímelo y lo respetamos. |
| `/recordatorio` | Recordar lo que quedamos | Hola {{nombre}}, te recuerdo que quedamos de platicar sobre {{curso}}. ¿Sigue siendo buen momento para ti? |
| `/novedades` | Avisar que hay novedades | Hola {{nombre}}, soy {{asesor}} de {{marca}}. Hay novedades sobre {{curso}} que creo que te pueden interesar. ¿Te las cuento por aquí? |
| `/ultimo` | Último mensaje, sin presionar | Hola {{nombre}}, no quiero insistirte. Si ya no es buen momento para {{curso}}, no hay problema: avísame y dejo de escribirte, o dime cuándo prefieres que retomemos. |

## Alumnos

| Atajo | Para qué | Texto |
| --- | --- | --- |
| `/bienvenido` | Bienvenida a un alumno | ¡Bienvenido a {{curso}}, {{nombre}}! Qué gusto tenerte en {{marca}}. Cualquier duda sobre el acceso o el inicio, escríbeme y te ayudo. |
| `/acceso` | Ayuda con el acceso | Vamos a resolverlo, {{nombre}}. ¿Me cuentas qué ves en pantalla cuando intentas entrar a {{curso}}? Si puedes, mándame una captura. |
| `/opinion` | Pedir su opinión | Hola {{nombre}}, ¿cómo te va en {{curso}}? Tu opinión nos ayuda a mejorar; ¿me cuentas qué te ha gustado y qué cambiarías? |
| `/constancia` | Pregunta por su constancia | Gracias por preguntar, {{nombre}}. Reviso con el equipo de {{marca}} cómo va tu constancia de {{curso}} y te confirmo por aquí. |
| `/recomienda` | Pedir una recomendación | Me alegra que {{curso}} te esté sirviendo, {{nombre}}. Si conoces a alguien a quien le pueda ayudar, con gusto lo atiendo igual de bien. |
| `/siguiente` | Ofrecer seguir aprendiendo | Hola {{nombre}}, ¿qué te pareció {{curso}}? Si quieres seguir aprendiendo, con gusto te cuento qué otros cursos de {{marca}} podrían interesarte. |

## Cerrar

| Atajo | Para qué | Texto |
| --- | --- | --- |
| `/dudas` | ¿Te quedó alguna duda? | ¿Te quedó alguna duda, {{nombre}}? Con gusto te ayudo. |
| `/cerrar` | Cerrar la conversación | Quedo atento a lo que necesites, {{nombre}}. Voy a cerrar esta conversación por ahora; puedes escribirnos cuando quieras y retomamos sin problema. |
| `/despedida` | Despedida | Gracias por escribir a {{marca}}, {{nombre}}. Que tengas un excelente día. Soy {{asesor}}; aquí sigo para lo que necesites. |
| `/ausente` | Fuera de horario (manual) | Hola {{nombre}}, ahora estamos fuera de horario en {{marca}}. Te leo y te respondo en cuanto abramos. Soy {{asesor}}. |
| `/error` | Reconocer un error | Tienes razón, {{nombre}}, me equivoqué y te pido una disculpa. Ya lo corrijo y te confirmo por aquí. |

