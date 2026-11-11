# Mensajes del asistente más amables (11 nov 2026)

Rama `feat/mensajes-amables`. Sin esquema nuevo.

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

## Lo que no cambió

- Los **materiales que envía el equipo** con los botones Precio, Temario y Fechas (y los programados) siguen igual: son `catalogue.prepare()`.
- El acuse de «ya pagué», la baja de mensajes y las respuestas del conocimiento aprobado.
- La instantánea comercial de cada mensaje (precio y edición al momento de enviar).

## Cómo personalizar por marca, sin tocar código

- **Saludo de bienvenida:** Catálogo → Cursos → Gestionar → mensaje de bienvenida (admite `{{nombre}}` y `{{curso}}`).
- **Pedido con enlace de pago y pago confirmado** (y otros eventos): Catálogo → **Contenido** → plantilla por evento, aprobada. Si hay plantilla aprobada, gana sobre el texto de `reply-copy.mjs`.
- **Respuestas a preguntas frecuentes:** Catálogo → Conocimiento.

## Verificación

- `test/reply-copy.test.mjs`: cada texto con datos completos, sin datos y con promoción; sin huecos (`undefined`, `{{…}}`), sin promesas falsas y sin género.
- Se ajustaron las pruebas que citaban los textos anteriores (pedido, confirmación, respuesta genérica).
- Visto en el chat a 375 px: los saltos de línea y las viñetas se respetan.
- **Pendiente:** verlo en producción con los datos reales de las ediciones.
