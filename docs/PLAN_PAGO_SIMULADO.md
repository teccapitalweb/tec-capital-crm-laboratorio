# Pago simulado con aspecto de pasarela

Estado: **implementado** (5 nov 2026, rama `feat/pago-estilo-stripe`, **sin esquema ni versión nueva**: sólo la interfaz del cliente).

Para ver cómo se sentirá pagar cuando haya una pasarela real (Stripe o Conekta, ver [CONECTORES.md](CONECTORES.md)), el enlace de pago de prueba (`/?pay=<pedido>`) ahora abre una pantalla con el orden de un pago real en lugar de tres botones sueltos.

## Qué ve el cliente

1. Un aviso claro de **simulación** (no se cobra nada, no se guarda ninguna tarjeta).
2. El **resumen del pedido**: marca, curso y edición, sesión o plan si aplica, importe grande, promoción, referencia y vigencia.
3. Dos métodos con pestañas:
   - **Tarjeta:** nombre, número, vencimiento y CVC, con formato automático. Dos atajos, «Una que aprueba» (4242 4242 4242 4242) y «Una que rechaza» (4000 0000 0000 0002). Botón **Pagar $importe**.
   - **OXXO:** ficha con referencia y código de barras de ejemplo (derivados del pedido) y el botón «Simular que ya pagué en OXXO».
4. Siempre queda «Enviaré mi comprobante por el chat» (revisión manual, sin cambios).

## Qué hace por dentro

- Reutiliza la acción existente `pay-sim`: `POST /api/payments/orders/:id/pay` con el método (`card` u `oxxo`) y el resultado (`approved` o `declined`). **El servidor no cambia**; el pedido, la venta, la comisión, la inscripción y los avisos siguen igual.
- **Los datos de la tarjeta nunca salen del navegador:** los campos no tienen `name`, no se envían ni se guardan, y sólo se aceptan tres números de tarjeta de prueba. Si alguien escribe otro número, la pantalla dice que es una simulación y pide usar una de prueba, para que nadie teclee una tarjeta real aquí.
- No usa el nombre, el logotipo ni los colores de ningún proveedor: es el orden de un checkout, con el diseño Niebla.
- Archivos: `public/checkout.js` (la pantalla y su validación), `public/checkout.css`, y su registro en `server/index.mjs` e `index.html`. `openPayment` en `app.js` la usa cuando el pedido está pendiente; en los demás estados (pagado, en revisión, vencido) se ve lo de siempre.

## Cuando haya pasarela real

La ficha de **resumen** y la lista de métodos se conservan; en lugar de los campos de tarjeta, el botón **Pagar** llevará a la página de pago de la pasarela (el CRM crea la sesión de pago con la referencia del pedido y sólo confirma con el aviso firmado). El CRM nunca verá números de tarjeta reales. Requisitos por consultora: [CONECTORES.md](CONECTORES.md).

## Fuera de alcance

SPEI (el servidor sólo admite tarjeta y OXXO simulados; añadirlo requiere un método nuevo en el motor de pagos), pago con billetera, recibos descargables y la sesión de pago real contra una pasarela.

## Criterios de salida (cumplidos)

Revisión en navegador local: pedido pendiente abre la pantalla; número no permitido se rechaza con mensaje; tarjeta que rechaza deja el pedido pendiente y avisa; OXXO confirma y el pedido queda pagado; sin desbordamiento a 375 px, letra mínima de 11 px, controles de 40 px o más y contraste AA; 159 pruebas y comprobación de que los archivos nuevos se sirven.
