# Plan: cupones de descuento

Estado: **publicado en `main`** (6 nov 2026), **esquema 34** (una tabla nueva y tres columnas en `orders`), sin cambio de versión. La segunda entrega, el cupón escrito por el cliente (**esquema 36**, publicada), está descrita abajo.

## Para qué

Para cerrar una venta o sostener una campaña a veces hace falta un incentivo concreto: «con VERANO10 tienes 10 % menos». Un **cupón** es un código por marca que el equipo escribe al cobrar desde el chat y que baja el importe del pedido. Es de práctica, como todo el pago del laboratorio: no cobra dinero real.

## Qué hace

- **Administración** (Operación → Ventas y cobro → Pagos → **Cupones de descuento**) crea, edita, pausa, activa y archiva cupones por marca. Cada cupón tiene: código (3 a 24 letras, números o guiones; se guarda en mayúsculas), nombre para reconocerlo, **tipo** (porcentaje de 1 a 90 % o monto fijo desde $1.00), curso al que aplica (o todos los de la marca), fechas de vigencia opcionales, **usos en total** opcionales y **usos por persona** (1 a 10; 1 por omisión). La lista muestra usos, usos pagados y el estado: Activo, Pausado, Archivado, Aún no vigente, Vencido o Agotado.
- **El equipo** ve en la ventana **Cobrar** un campo «Cupón de descuento (opcional)» con **Aplicar**: dice al instante «Cupón VERANO10: −$44.90. Total para el cliente: $404.10.» o el motivo por el que no aplica (no existe, pausado, vencido, no aplica a este curso, agotado, esa persona ya lo usó, cubre todo el importe). Al crear el pedido se vuelve a validar.
- **El pedido** guarda el importe final (`amount_cents`), el código y el descuento (`coupon_code`, `discount_cents`); el mensaje con el enlace de pago dice «Incluye tu cupón VERANO10 (−$44.90)» y la pantalla donde el cliente paga muestra el cupón. Los totales cobrados (Pagos, Finanzas, comisiones) usan el importe **final**.
- El evento `pedido.creado` y el historial del pedido registran el código, el descuento y el importe de lista.

## Segunda entrega: el cliente escribe su cupón

- **Administración decide qué cupones puede escribir el cliente.** El formulario del cupón tiene la casilla «El cliente puede escribirlo en su pantalla de pago» (apagada por omisión; los cupones existentes quedan sólo para el equipo). Es editable en cualquier momento.
- **En la pantalla de pago** (el enlace que recibe el cliente) aparece **«¿Tienes un cupón?»** sólo si la marca tiene al menos un cupón activo y vigente que el cliente puede escribir y el pedido es de curso completo, está pendiente y no lleva cupón. El cliente escribe el código y pulsa **Aplicar**: el total y el botón de pagar se actualizan, el chat recibe «Aplicaste el cupón… Nuevo total: …» y puede **Quitar** el cupón que él mismo aplicó (un cupón que puso el equipo lo cambia el equipo).
- **El servidor recalcula todo.** El cliente sólo manda un código; cualquier importe que mande se ignora. Se valida con las mismas reglas que el equipo (marca, vigencia, curso o edición, usos totales y por persona) y sólo sirve un cupón con la casilla activada.
- **Una sola respuesta ante cualquier negativa:** «Ese cupón no es válido o no está disponible para este pedido.», sea que el código no exista, esté pausado, vencido, agotado, ya usado por esa persona, sea de otra marca o sea sólo del equipo. Así no se puede usar la pantalla para descubrir códigos. Además hay **límite de intentos** (12 por minuto por persona y 15 por pedido cada 10 minutos).
- **Evento y registro:** el historial del pedido anota `coupon.applied` o `coupon.removed`, y se publica el evento `pedido.cupon_aplicado` (disponible para webhooks; en la API de lectura exige el permiso `orders`). El pedido guarda quién lo aplicó (`coupon_source`: equipo o cliente) y el equipo lo ve en el detalle («Cupón X, lo aplicó el cliente»).
- Sólo mientras el pedido está **pendiente** (no con comprobante en revisión, pagado, cancelado ni vencido) y no en el plan por sesión.

## Reglas

- **Sólo curso completo.** Un cupón no aplica al plan por sesión ni a pedidos de sesión.
- **El bot nunca aplica cupones**: sólo una persona del equipo los escribe (el motor de respuestas sigue creando pedidos al precio vigente).
- **Con un pedido vigente no se cambia el cupón**: hay que cancelar el pedido y cobrar de nuevo (409 con el motivo).
- **Los usos se cuentan sobre los pedidos vivos** (pendientes, en revisión o pagados). Cancelar o dejar vencer un pedido **libera el uso**; no hay una tabla de canjes que pueda desfasarse.
- **El código, el tipo y el valor no se cambian** una vez creado (lo ya dicho a los clientes y lo ya cobrado se apoyan en ellos): se crea otro cupón y se pausa el anterior. Sí se editan el nombre, el curso, las fechas, los usos y el estado; el tope total no puede bajar de los usos ya hechos. Un cupón archivado no se edita ni se usa.
- **El descuento nunca cubre todo el importe** (porcentaje máximo 90 %; un monto igual o mayor al precio se rechaza): no hay pedidos de $0.
- Si el curso tiene una promoción vigente, el cupón se aplica **sobre el precio de la promoción**.

## Seguridad y datos

- Esquema 34: `coupons` (`UNIQUE(brand_id, code)`) y en `orders`: `coupon_id`, `coupon_code`, `discount_cents` (por omisión 0, así que los pedidos anteriores no cambian). Respaldo automático antes de migrar (`backups/before-crm-v34-*`).
- **Alcance:** sólo administración lista, crea y edita (`GET/POST /api/coupons`, `PATCH /api/coupons/:id`); asesores y clientes reciben 403 y sin sesión 401. Los asesores sólo escriben el código en Cobrar, y la vista previa y el pedido validan con las mismas reglas (marca, estado, vigencia, alcance, usos).
- **Idempotencia y transacciones:** la validación y la creación del pedido ocurren en la misma transacción síncrona; el rechazo de un cupón no deja pedidos a medias. `expectedRevision` al editar.
- Auditoría: `coupon.create`, `coupon.update`; el pedido guarda el cupón aplicado.

## Límites actuales

- Un cupón por pedido; no se acumulan.
- No hay códigos únicos por persona ni generación masiva; el código es el mismo para quien lo conozca (se limita con usos totales y por persona).
- No aplica al plan por sesión ni a pagos reales (el laboratorio no cobra; con la pasarela real habrá que enviar el importe final al proveedor).
- El cliente aplica un cupón a un pedido que el equipo ya creó; no hay carrito ni compra directa por su cuenta.
- No hay reporte por campaña; la lista de cupones muestra usos, pagados y descuento pagado.

Archivos: `server/coupons-schema.mjs`, `server/coupons.mjs`, `server/payments.mjs` (`createOrder`, `preview`, mensaje del enlace, vistas), `server/index.mjs`, `public/payments.js`, `public/app.js` (Cobrar), `public/checkout.js`, `public/operations.js`, `public/crm.css`; pruebas `test/coupons.test.mjs`.
