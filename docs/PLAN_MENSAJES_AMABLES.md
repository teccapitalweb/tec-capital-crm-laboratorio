# Mensajes del asistente más amables (11 nov 2026)

Publicado en `main` (11 nov 2026). Sin esquema nuevo.

## Para qué

Con el recorrido automático ya funcionando en producción, el usuario pidió que los mensajes sean más amigables, con la información necesaria y que lleven a la inscripción. Los textos anteriores eran correctos pero secos, repetían «de práctica / laboratorio / simulado» en cada mensaje y mostraban datos vacíos («Docente: Por confirmar», «Fecha de práctica por confirmar»).

## Dónde viven ahora

Todos los textos fijos del asistente están en **`server/reply-copy.mjs`**: funciones puras que reciben el contexto del catálogo y devuelven el texto. `server/replies.mjs` decide *qué* responder; `reply-copy.mjs` decide *cómo se dice*. `server/payments.mjs` usa de ahí el mensaje del pedido y la confirmación del pago.

## Reglas de los textos

1. **Los datos salen del catálogo vigente** (precio, promoción, fecha, docente, modalidad). Nunca de un texto fijo.
2. **Lo que no se sabe se omite o se dice claro**: sin docente no hay renglón de docente en la ficha; sin fecha dice «fecha por confirmar».
3. **Cada mensaje abre el siguiente paso**: el precio invita a escribir «Quiero inscribirme»; el temario ofrece precio o fechas; las fechas invitan a inscribirse (o, sin fecha, ofrecen otra cosa).
4. **No prometen lo que el sistema no hace**: no dicen «aparté tu lugar» ni confirman pagos por su cuenta.
5. **Honestidad de laboratorio, una vez y en corto**: donde hay dinero o una oferta se dice que es de prueba («Pago de prueba: no se cobra nada real.»), en lugar de repetirlo en cada renglón.
6. **Sin suponer el género** de la persona («Tu inscripción quedó lista», no «inscrito»).
7. El nombre de pila se usa sólo si parece un nombre (no un alias de usuario).

## Antes y después

| Momento | Antes | Ahora |
|---|---|---|
| Bienvenida | Saludo + «Te comparto la información de… Fecha de práctica por confirmar. Precio de ejemplo… Laboratorio: no constituye una oferta comercial real.» | Saludo del curso + ficha en renglones (inicio, docente, modalidad, precio) + una nota corta de chat de prueba |
| Precio | «El precio de ejemplo de X es $449.00 MXN. Edición general. Sin promoción vigente. Datos de práctica.» | «El precio de X · Edición general es de $449.00 MXN.» + promoción sólo si existe + «escribe «Quiero inscribirme» y te mando tu enlace de pago» |
| Temario | «Temario:» y el texto tal cual | «Esto es lo que verás en X:» en viñetas + «¿Te cuento el precio o las fechas?» |
| Fechas | «Fecha: Por confirmar / Docente: Por confirmar» | Fecha en palabras con su zona («martes, 1 de diciembre de 2026, 7:00 p.m. (hora del centro de México)»), docente y modalidad; invita a inscribirse |
| Inscripción | «¡Qué gusto! Anoté tu interés en X.» + «Pedido de práctica…» | «¡Qué gusto, Ana! Ya tengo listo tu pedido:» + pedido, enlace, vencimiento y opción de transferencia |
| Pago confirmado | «Pago confirmado (laboratorio) · TC-… Quedaste inscrito…» | «✅ ¡Pago confirmado, Ana! Tu inscripción a X quedó lista. Pedido TC-…» + qué sigue |
| Sin respuesta | «Puedo ayudarte con el precio, el temario o la fecha…» | «Esa no la tengo a la mano, pero puedo contarte el precio, el temario o las fechas de X…» |
| Pide asesor / queja / gracias | Frases neutras | Con su nombre y diciendo qué pasa después |

Cambio de comportamiento (uno): una consulta general de pago **sin** respuesta aprobada decía «El equipo revisará tu consulta» sin avisar a nadie. Ahora, si la venta de prueba está activa, dice las formas de pago; si no, pasa el chat a una persona.

## Varias preguntas en un mensaje

Cada respuesta se separó en **cuerpo** (el dato) y **cierre** (el siguiente paso): `priceBody`, `syllabusBody`, `scheduleBody`. Cuando el cliente pregunta dos o tres cosas a la vez («¿qué temas incluye, y tiene certificado?»), `several()` une los cuerpos y pone un solo cierre. Los temas del conocimiento (certificado, grabación, requisitos…) entran con su respuesta aprobada; si un tema no tiene respuesta aprobada, se omite y se contesta lo demás.

## Fechas para el cliente (21 nov 2026)

Tras una prueba real, `{{fecha}}` en un recorrido salía como «23 nov 2026, 7:00 p.m. · America/Mexico_City». Ahora toda fecha del catálogo que se interpola para el cliente usa la redacción de la ficha del asistente (`whenText` en `server/reply-copy.mjs`, que también usa `startText`): «lunes, 23 de noviembre de 2026, 7:00 p.m. (hora del centro de México)», sin hora si sólo se sabe el día (medianoche exacta), y una zona fuera de la lista se dice por su ciudad («hora de Guatemala»), nunca con su identificador. Vale para `{{fecha}}` y `{{vigencia}}` (`templateValues` de `server/catalogue.mjs`: recorridos, reglas, accesos, textos de Contenido y mensajes programados), los materiales de Precio, Fechas e Información (`catalogue.prepare`) y la etiqueta de fecha del catálogo (`dateLabel`), que también ve el equipo. El flyer generado (SVG) usa una versión corta en un renglón: «23 nov 2026, 7:00 p.m. (hora del centro de México)». Pruebas: `test/fecha-amable.test.mjs` y, de punta a punta, en `test/chatflows.test.mjs`.

> **13 nov 2026:** los textos de «sin respuesta» y los mensajes de trato («ok», «sí», «no», «espera», «¿eres un bot?») se ampliaron en [PLAN_ASISTENTE_SIN_CALLEJONES.md](PLAN_ASISTENTE_SIN_CALLEJONES.md).

## Lo que no cambió

- Los **materiales que envía el equipo** con los botones Precio, Temario y Fechas (y los programados) siguen igual: son `catalogue.prepare()`.
- El acuse de «ya pagué», la baja de mensajes y las respuestas del conocimiento aprobado.
- La instantánea comercial de cada mensaje (precio y edición al momento de enviar).

## Cómo personalizar por marca, sin tocar código

- **Saludo de bienvenida:** Catálogo → Cursos → Gestionar → mensaje de bienvenida (admite `{{nombre}}` y `{{curso}}`).
- **Pedido con enlace de pago y pago confirmado** (y otros eventos): Catálogo → **Contenido** → plantilla por evento, aprobada. Si hay plantilla aprobada, gana sobre el texto de `reply-copy.mjs`.
- **Respuestas a preguntas frecuentes:** Catálogo → Conocimiento.

## Estilo: renglones con emoji y negritas (publicado en `main`, 22 nov 2026)

El dueño pidió que los mensajes se vean ordenados y bonitos. Todos los textos fijos siguen un mismo orden y un mismo estilo, **sin cambiar lo que dicen**:

1. Una línea de saludo o la respuesta corta.
2. Los datos en renglones, cada uno con su emoji y su etiqueta: 📅 Inicio, 🧑 Docente, 💻 Modalidad (📍 presencial, 🏫 híbrida), 💳 Precio, 🏁 Termina, 🗓️ Sesiones; 📚 abre el temario; 🎓 marca cada curso de una lista.
3. Un renglón en blanco y **un solo siguiente paso**, con 👉 y lo que hay que escribir en negritas: «👉 Si quieres apartar tu lugar, escribe *Quiero inscribirme* y te mando tu enlace de pago.»

Reglas: **cada parte en su párrafo** (saludo, datos, siguiente paso y nota separados por un renglón en blanco; la pregunta final del saludo de la marca pasa a su propio párrafo si el saludo venía en uno solo; «Te entiendo», «lo que sí puedo contarte» y «si prefieres una persona» van aparte); un emoji por renglón y pocos por mensaje (la prueba lo comprueba); negritas de WhatsApp (`*así*`) sólo en el nombre del curso y en lo que la persona debe escribir; **ningún emoji en los mensajes serios** (pago en revisión, estado del pago, queja o reembolso, baja, pasar con una persona, enlace que falla); las notas de prueba y el intercambio de modo real no cambian. Toques pequeños (segunda pasada, tras la prueba del dueño en WhatsApp real): 📋 en la lista de cursos y en el menú, 👋 al preguntar el curso cuando el número atiende toda la marca, 🎓 al acotar la lista, 🔎 cuando ningún curso tiene el tema, 🙂 en «sin prisa», «lo pienso», «con gusto te recomiendo» y «pago después», 👋 en la despedida, 🙌 en la inscripción con asesor, 💳 en las formas de pago, ⏳ en el último día para pagar, ✅ al anotar los datos de la constancia, 📝 al pedirlos y 🔑 al reenviar accesos; el «responde con el número o el nombre» lleva 👉. 👋 no se añade a la bienvenida porque ese saludo lo escribe la marca; 🎉 en «Ya tengo listo tu pedido», 😊 en «gracias», 👍 en «sí», 🤖 en «¿eres un bot?», 🙂 en «lo pienso», ✅ en «ya está activa» y «todavía hay lugar».

- **Interruptor por marca:** Operación → Seguimientos → «Mensajes con emojis», encendido por omisión (`reply_settings.emojis`, migración con nombre `replies/0002-message-style`; `PATCH /api/replies/brands/:id` con `emojis`). Apagado, los mismos textos salen con viñetas, comillas y sin negritas ni emojis, como antes. El estilo viaja en el contexto del catálogo (`ctx.style.emojis`) a todas las funciones de `server/reply-copy.mjs`; una función llamada sin estilo se comporta como «con emojis» (los pasos de los recorridos y la confirmación del nombre para la constancia no consultan el interruptor y salen con emojis).
- **El chat del laboratorio pinta las negritas** igual que el teléfono (`rich` en `public/app.js`: sólo pares de asteriscos en una misma línea, sobre el texto ya escapado). WhatsApp real las entiende de origen.
- **Verificado:** `test/reply-copy.test.mjs` (los dos estilos, un emoji por renglón, los mensajes serios sin emojis), `test/sales-replies.test.mjs` (el interruptor por marca de punta a punta y un valor inválido), `test/ui/bandeja.spec.mjs` (la ficha llega con negritas), y las pruebas que citaban las viñetas se hicieron independientes del estilo. Revisado a la vista en el servidor local de demostración, en computadora y celular (375 px): ficha de bienvenida con flyer, precio y fechas con negritas y un emoji por renglón, la casilla por marca en Seguimientos, y la lista de chats con la vista previa del último mensaje sin los asteriscos (`unbold` en `public/app.js`).

## Botones de siguiente paso (22 nov 2026)

Hasta ahora sólo la bienvenida ofrecía botones para tocar (Precio · Temario · Fechas). Ahora las respuestas informativas también cierran con botones, para que la persona toque en vez de escribir:

- **Precio:** Temario · Fechas · Quiero inscribirme.
- **Temario:** Precio · Fechas · Quiero inscribirme.
- **Fechas** y **duración:** Precio · Temario · Quiero inscribirme.

A quien ya compró, el tercer botón es «Hablar con asesor» en vez de «Quiero inscribirme». Son como mucho tres (el canal los limita a tres y, fuera de la ventana de 24 h, el conector de Meta cae a texto); los mensajes que pasan a una persona (pago en revisión, queja, descuento de grupo) no llevan botones. Al tocar un botón, su texto llega como un mensaje de la persona y el motor lo lee con las reglas de siempre (`withSteps` en `server/replies.mjs`; el canal simulado los pinta como chips y la bandeja del equipo los muestra en gris). Verificado en `test/sales-replies.test.mjs` (precio, temario y fechas con sus botones; un mensaje que pasa a una persona sin botones) y a la vista en el chat de prueba.

## Flyer del curso al informar (22 nov 2026)

Como haría una persona del equipo, la **primera** respuesta concreta sobre un curso en la conversación acompaña el texto con **el flyer de ese curso**: precio, temario, fechas y duración, y cuando el asistente recomienda **un solo** curso que es el de la conversación. La bienvenida ya lo hacía; ahora también las respuestas informativas, y siempre una sola vez por conversación (si ya salió un flyer, no se repite). La imagen es siempre del curso que la persona consulta, nunca de otro.

- **Reutiliza la cañería que ya existe:** `catalogue.prepare(c, { kind, flyer: true })` elige el flyer aprobado y vigente de esa edición y canal, guarda su *snapshot* (un cambio de precio o de arte no altera lo ya enviado) y en **modo real** nunca manda un flyer de demostración (si la marca no ha subido el suyo, la respuesta sale sólo en texto).
- **Cae a texto** si el curso no tiene flyer aprobado: la respuesta nunca se rompe.
- **Una sola imagen:** con varios cursos recomendados no se adjunta un flyer (sería confuso); cada curso lleva su inicio y precio en el texto.
- **Interruptor por marca** «Flyer del curso al informar» en Operación → Seguimientos (encendido por omisión; `reply_settings.flyer`, migración con nombre `replies/0003-course-flyer`). Apagado: sólo texto, incluida la bienvenida.
- La «primera vez» se mide por `messages.flyer_course_id` (sólo se llena cuando de verdad salió un flyer). En un recorrido manda la opción del recorrido (`withFlyer` del editor), no este interruptor.

Verificado en `test/sales-replies.test.mjs`: la primera respuesta de precio lleva el flyer del curso, la segunda ya no lo repite, y con el interruptor apagado sale sólo texto; más la columna `reply_settings.flyer` encendida por omisión. A la vista en el chat de prueba.

**En los recorridos (23 nov 2026).** La ficha del curso (`course_card`) ya ofrecía la imagen; ahora también los pasos de catálogo **Precio**, **Temario** y **Fechas** tienen la casilla «Enviar también la imagen (flyer) del curso», **apagada por omisión** para no cambiar recorridos ya publicados. El motor (`server/modules/chatflows/engine.mjs` → `env.io.catalogue(kind, { flyer })` en `runtime.mjs`) usa el mismo `catalogue.prepare(c, { kind, flyer })`: conserva el *snapshot*, cae a texto si el curso no tiene flyer y en modo real nunca manda uno de demostración. En Precio la casilla se oculta si se eligió un material propio. El simulador y «Así lo ve la persona» la muestran. Definición del paso en `public/kit/shared/flow-model.js`; verificado en `test/chatflows-engine.test.mjs` y `test/flow-model.test.mjs`. A diferencia de las respuestas del asistente, aquí no hay regla de «una sola vez»: el flyer sale cada vez que el recorrido pasa por un paso que lo tiene encendido, así que conviene encenderlo en un solo paso.

## Verificación

- `test/reply-copy.test.mjs`: cada texto con datos completos, sin datos y con promoción; sin huecos (`undefined`, `{{…}}`), sin promesas falsas y sin género.
- Se ajustaron las pruebas que citaban los textos anteriores (pedido, confirmación, respuesta genérica).
- Visto en el chat a 375 px: los saltos de línea y las viñetas se respetan.
- **Pendiente:** verlo en producción con los datos reales de las ediciones.
