# Cierre de la venta: del comprobante al acceso

Qué pasa después de que la persona recibe su pedido. **Publicado en `main` el 20 nov 2026** (commits `853a151` y `204b569`); falta probarlo con WhatsApp real. Esquema: una migración con nombre nueva, `course-access/0001-course-access`.

## Qué había y qué faltaba

Ya existía (y no cambia): la persona manda su comprobante por el chat (también por WhatsApp real) y, si tiene un pedido vigente, entra a la cola como comprobante; alguien del equipo lo valida o lo rechaza en Operación → Pagos; al validar se inscribe, se descuenta el cupo, la oportunidad queda ganada y la persona recibe la confirmación.

Faltaban dos cosas, que son este bloque:

1. **Los accesos.** La confirmación decía «el equipo coordinador te enviará los accesos» y ahí se quedaba: alguien tenía que acordarse de escribirlos a mano.
2. **Validar sin salir del chat.** Para validar había que ir a Operación → Pagos y buscar el pedido.

## Cómo funciona ahora

1. **Ventas → Accesos** (pantalla nueva): por cada apertura, administración escribe el mensaje con los accesos (enlace de las clases, material, grupo…) y lo enciende. Hay un texto sugerido, datos que se llenan solos (`{{nombre}}`, `{{curso}}`, `{{edicion}}`, `{{fecha}}`, `{{docente}}`, `{{modalidad}}`, `{{grupo}}`, `{{pedido}}`, `{{marca}}`), vista previa con los datos reales de la apertura y una lista «Antes de encender» con lo que falta.
2. **En el chat**, cuando hay un comprobante por revisar aparece una franja sobre el cuadro de texto: «Ver comprobante», «Validar pago» y «No es válido» (pide el motivo, que recibe la persona). Usa las mismas rutas de pagos de siempre.
3. **Al quedar confirmado el pago**, la persona recibe su confirmación y, enseguida, **el mensaje de accesos**, sin que nadie lo escriba. La confirmación dice «enseguida te mando tus accesos» sólo cuando de verdad van a salir.
4. La franja del chat pasa a decir «Pago confirmado · accesos enviados» (con «Reenviar accesos»), «accesos sin enviar» (con el motivo y «Enviar accesos») o «este curso todavía no tiene accesos escritos».
5. En Accesos se ven las últimas entregas y, si se escribieron los accesos después de que alguien pagó, «Enviar a quienes faltan».

## Reglas

- **Este bloque nunca confirma un pago.** El módulo sólo escucha el hecho `inscripcion.activada`, que publica `server/payments.mjs` dentro de la confirmación. El asistente sigue sin poder confirmar pagos.
- **Apagado por omisión.** Sin texto escrito y encendido en esa apertura no sale nada: todo queda como antes.
- **Un pago de prueba no entrega accesos.** En una marca en laboratorio, si nadie del equipo confirmó (tarjeta u OXXO simulados), la entrega se omite y queda anotado el motivo. La apertura puede permitirlo con «Enviar también con pagos de prueba», para presentar el recorrido completo. Con una persona que valida, o en una marca en modo real, la entrega sale.
- **Una entrega automática por inscripción**, pase lo que pase (índice único); un reenvío repetido con el mismo `clientRef` no duplica el mensaje.
- **Para encender, el texto tiene que poder enviarse tal cual**: sin datos que no existen, sin llaves abiertas, sin «(pega aquí…)» por llenar y, si usa `{{grupo}}`, con el enlace de grupo puesto en Coordinación. Un borrador se guarda como esté.
- **Permisos.** Escribir y encender: `sales.access.manage` (administración). Ver, y enviar o reenviar a una persona: el equipo de la marca con `sales.charge`. Todo por marca.
- **WhatsApp real.** El mensaje de accesos es un aviso del negocio, como la confirmación del pago: se guarda siempre y, si la ventana de 24 horas ya cerró, queda «no entregado» con su motivo. Entonces hay que esperar a que la persona escriba y usar «Reenviar accesos».
- El mensaje enviado queda en la conversación tal como salió; cambiar el texto después sólo afecta a los envíos nuevos.

## Dónde está

| Pieza | Archivos |
| --- | --- |
| Datos | `server/migrations/named/course-access/0001-course-access.mjs` (`course_access`, `course_access_deliveries`) |
| Servidor | `server/modules/course-access/` (`module.mjs`, `repo.mjs`); frase de la confirmación en `server/reply-copy.mjs` y su consulta en `server/payments.mjs` (`useAccessHint`) |
| Pantalla | `public/screens/accesos/` |
| Chat | `public/sale.js`, con su ranura `#conv-sale` en `public/app.js` y estilos en `public/tinta-atencion.css` |
| Preparar marca | paso «Accesos del curso» (Extras): avisa de las aperturas por empezar que todavía no entregan accesos |
| Pruebas | `test/course-access.test.mjs`, `test/ui/cierre-venta.spec.mjs`, `test/ui/accesos.spec.mjs` |

Rutas: `GET /api/course-access?brand=`, `PUT /api/course-access/editions/:id`, `POST …/editions/:id/preview`, `POST …/editions/:id/send-pending`, `POST …/enrollments/:id/send`, `GET …/conversations/:id`. Tiempo real: `course_access.changed`.

## Fuera de este bloque

- Adjuntar archivos al mensaje de accesos (hoy es texto con enlaces).
- Enviar los accesos como plantilla de WhatsApp cuando la ventana ya cerró.
- Leer sola el importe y la fecha del comprobante.
- Registrar el pago de una marca en modo real desde el chat (sigue en Operación → Pagos).
