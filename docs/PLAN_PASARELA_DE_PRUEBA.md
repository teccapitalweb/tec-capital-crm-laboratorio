# Pasarela de prueba a pantalla completa (11 nov 2026)

Publicado en `main` (11 nov 2026; visto en producción: pago aprobado con comprobante y confirmación en el chat). Sólo interfaz; sin esquema ni rutas nuevas. Bloque 2 de [PLAN_APP_DE_PRUEBA.md](PLAN_APP_DE_PRUEBA.md).

## Para qué

El pago simulado ya validaba solo (tarjeta u OXXO de prueba, aprueba o rechaza, confirma la inscripción), pero se abría como una ventana pequeña sobre el chat y, al pagar, se cerraba con un aviso. El usuario pidió que se sienta como una pasarela real: que «te lleve» a pagar y vuelva con el resultado.

## Qué cambia

Al abrir un pedido pendiente («Abrir pago de prueba» o el enlace `/?pay=<pedido>`):

1. **Pantalla completa de pago**: cabecera con candado y la referencia, resumen del pedido, tarjeta u OXXO. En escritorio, una columna centrada sobre fondo liso, como una página de pago alojada.
2. **Procesando**: al pagar, un indicador durante ~1,4 s (mínimo) mientras responde el servidor.
3. **Resultado**:
   - **Aprobado**: comprobante de ejemplo (concepto, monto, referencia, método con los últimos 4 dígitos, fecha y autorización de ejemplo) y «Volver al chat», donde ya está la confirmación.
   - **Rechazado**: se dice que no hubo cargo y que el pedido sigue vigente; «Intentar con otra tarjeta» o «Volver al chat».
   - **Error** (pedido vencido, ya pagado, etc.): el motivo y cómo volver.

El pago sigue yendo por la misma acción de siempre (`POST /api/payments/orders/:id/pay`). No se envían ni guardan datos de tarjeta: sólo se aceptan los números de prueba y del número sólo se usan, en el navegador, los últimos 4 dígitos para el comprobante.

## Ajuste: sin campos de tarjeta

Visto en producción: Chrome ofreció guardar la tarjeta de prueba, porque el formulario parecía un pago real. Se quitaron los campos: la tarjeta de prueba se **elige** (una que aprueba, otra que rechaza). Así el navegador no guarda nada ni ofrece autocompletar una tarjeta real, y nadie puede teclear una por error.

## Límites deliberados

- Es una simulación y lo dice en cada pantalla; el comprobante aclara que no es un documento fiscal ni prueba de un cobro real, y la autorización es decorativa.
- Identidad propia del laboratorio: no copia el nombre, el logotipo ni el diseño de ninguna pasarela real.
- Un pedido que ya no está pendiente se sigue mostrando como ventana normal con su estado.

## Archivos

- `public/checkout.js`: `processing()`, `result()` y `failed()` junto al `html()` de siempre.
- `public/app.js`: `openPayment()` marca el diálogo como `pay-page`; `pay-sim` recorre procesando → resultado; `pay-done` vuelve al chat.
- `public/checkout.css`: `dialog.pay-page` y los estados.

## Verificación

- `test/checkout-states.test.mjs`: los cuatro estados, datos escapados, simulación declarada y ningún número de tarjeta completo.
- En navegador, 375 px y escritorio: rechazo → reintento → aprobado → volver al chat con «Pago confirmado»; sin desbordes.
- **Pendiente:** verlo en producción y en un teléfono real.
