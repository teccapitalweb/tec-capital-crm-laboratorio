# Modo real por marca

El CRM nació como laboratorio: el asistente avisa que es un «chat de prueba» con precios de ejemplo y la página de pago deja «pagar» con tarjeta u OXXO simulados, que marcan el pedido como pagado sin cobrar nada. Eso sigue igual para las marcas de demostración. Una marca que atiende **clientes de verdad** (por ejemplo, por WhatsApp real) enciende el **modo real** y se le quita lo de laboratorio sólo a ella. Responde al hallazgo 3 de la revisión independiente del plan maestro (dos defectos del día del corte).

## Qué cambia con el modo real encendido

- **Textos.** Ningún texto armado por el sistema dice «chat de prueba», «precio de ejemplo», «pago de prueba», «simulado», «de práctica» ni «laboratorio:»: ficha y bienvenida, precio, temario, fechas, varias preguntas, objeción, inscripción, formas de pago, enlace de pago (también por sesión), confirmación de pago, comprobante recibido, materiales del catálogo (los envía el equipo, una macro, una receta, una campaña o un mensaje programado), plantillas por evento (fuera de horario, aviso de pago, recordatorios…), flujo de bienvenida, respuestas del conocimiento y de la IA, sugerencias para el equipo, simulador de respuestas, recordatorio de clase, encuesta, certificado emitido y la ficha SVG generada. Precio y fechas siguen saliendo del catálogo vigente.
- **Cómo.** `server/lib/real-mode.mjs` pasa el texto final por `realText`: primero los cambios exactos de `LAB_SWAPS` (en `server/reply-copy.mjs`: las formas de pago dejan de ofrecer tarjeta u OXXO, «Paga aquí» pasa a «Cómo pagar»), luego «Precio de ejemplo:» → «Precio:», y al final quita la oración o el renglón que avisa de la prueba (`LAB_WORDING`, estrecho a propósito: un curso que se llama «Bioseguridad en el laboratorio» no pierde su nombre). Se aplica en los puntos por donde salen los textos: `replies.commit` y su simulación, `catalogue.prepare`, `content.render`, los mensajes de `payments` y los textos fijos de certificados, encuestas y coordinación. Lo que una persona del equipo escribe a mano no se toca.
- **Pago.** La página de pago no lista métodos (`methods: []`) y muestra el pedido y **cómo pagar** con las instrucciones que escribió la marca; si no escribió nada, dice que un asesor le dará los datos por el chat. No inventa cuentas ni datos bancarios, no tiene botón de pagar y nunca muestra «aprobado» por una acción del cliente; tampoco hay comprobante de ejemplo. Forzar `POST /api/payments/orders/:id/pay` (o el de `/api/pay/:id/pay`) responde **409 `real_mode`** y el pedido sigue pendiente; un evento del proveedor simulado (webhook de ensayo) se rechaza.
- **Quién marca pagado.** Mientras no haya pasarela real, el pedido de una marca real lo marca pagado una persona con el permiso **`sales.payments.confirm`** (hoy, administración) desde el detalle del pedido → **Registrar pago recibido**: `POST /api/real-mode/orders/:id/paid {how, reference, note?, expectedRevision, clientRef?}`, con `how` = transferencia, depósito, efectivo, terminal u otro y una referencia de 3 a 80 caracteres. Inscribe, descuenta cupo, cierra la oportunidad como ganada y avisa al cliente, igual que aceptar un comprobante (que sigue disponible). Queda quién y cuándo (`orders.confirmed_by`, auditoría `payment.order.mark_paid`) y cómo (`payment_events` `manual.recorded`; la tabla de pedidos guarda `transfer`, el único método manual que admite). El asistente no confirma pagos en ningún modo.

## Qué no cambia

Con el interruptor apagado (lo normal) todo se comporta exactamente como antes. El chat web de demostración (`/`) sigue siendo de prueba y lo dice en su interfaz. **Decisión:** el modo real es **por marca, no por canal**: si una marca real también se usa en el chat de demostración, sus mensajes salen sin avisos de prueba y su página de pago tampoco acepta pagos simulados. Es lo más seguro: un pago simulado crea venta, inscripción y comisión, y no debe poder ocurrir en una marca con clientes reales.

## Cómo se enciende

*Operación → Ventas y cobro → Pagos → Modo real (clientes de verdad)*: casilla **Atiende clientes reales**, instrucciones de pago para el cliente y **Guardar** (pide confirmación). API: `PATCH /api/real-mode/brands/:id {enabled?, paymentInstructions?, expectedRevision, confirm: true, clientRef?}` con el permiso **`settings.real_mode`** (administración); sin `confirm: true` un cambio del interruptor responde 400 `confirm_required`; con una revisión vieja, 409. Queda en la auditoría (`real_mode.on`, `real_mode.off`, `real_mode.instructions`). Esquema: migración con nombre `real-mode/0001-brand-real-mode` (tabla `brand_real_mode`, una fila por marca; sin fila, laboratorio).

## Lo que la marca debe tener listo antes

*Preparar marca* trae el paso **«Modo real: atiende clientes de verdad»**, con el estado y lo que falta:

1. **WhatsApp real conectado:** un número asignado a la marca ([ACTIVAR_WHATSAPP_REAL.md](ACTIVAR_WHATSAPP_REAL.md)).
2. **Instrucciones de pago:** cuenta o CLABE, titular y concepto, escritas por la marca (no pueden decir «de prueba»).
3. **Catálogo vigente:** al menos una edición publicada con precio y fecha futura.
4. **Textos propios revisados:** plantillas aprobadas, conocimiento aprobado, respuestas rápidas compartidas, bienvenidas de curso y flujo de bienvenida que todavía digan «de prueba» o «de ejemplo». En modo real esas frases se recortan al enviar, pero conviene reescribirlos (las plantillas y el conocimiento de demostración las traen).

## Lo que queda fuera

Pasarela real, facturación, reembolsos reales, Instagram y Messenger. La interfaz del chat de demostración (botón «Abrir pago de prueba» en la burbuja, títulos del equipo como «Cobrar · enlace de pago de prueba»). Imágenes ya generadas: los flyers de demostración (`PRECIO DE EJEMPLO` en el arte de `server/index.mjs`) y el certificado SVG y las páginas públicas de verificación de certificados y de encuestas, que siguen diciendo «de práctica». El enlace de videollamada del calendario simulado. Las plantillas de WhatsApp aprobadas por Meta se envían tal cual (las escribe la marca). Roles configurables: hoy `sales.payments.confirm` y `settings.real_mode` sólo los tiene administración.

Pruebas: `test/real-mode.test.mjs` (textos fijos uno por uno, recorrido de las cadenas de los archivos que hablan con el cliente, migración y punta a punta).
