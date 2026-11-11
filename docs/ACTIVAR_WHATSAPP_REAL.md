# Activar WhatsApp real con el número de prueba de Meta (guía paso a paso)

Qué hace y sus límites: [PLAN_WHATSAPP_REAL.md](PLAN_WHATSAPP_REAL.md). Esta guía deja funcionando el **número de prueba gratuito** de Meta: sirve para escribir desde hasta cinco teléfonos tuyos y ver todo el recorrido. Para clientes reales hace falta después la empresa verificada y un número propio ([CONECTORES.md](CONECTORES.md)).

**Reglas:** el token y el secreto se escriben **sólo en Railway**. No se pegan en chats, capturas ni en Git. Si uno se expone, se genera otro en Meta.

## Qué vas a necesitar (son cinco datos)

| Dato | Dónde se obtiene | Variable en Railway |
| --- | --- | --- |
| Token de acceso | Meta → tu app → WhatsApp → Configuración de la API | `META_ACCESS_TOKEN` |
| Identificador del número de teléfono | Misma pantalla (son dígitos; **no** es el teléfono) | `META_PHONE_NUMBER_ID` |
| Clave secreta de la app | Meta → tu app → Configuración de la app → Básica | `META_APP_SECRET` |
| Token de verificación | Lo inventas tú: una palabra larga sin espacios | `META_VERIFY_TOKEN` |
| Encendido | — | `CHANNEL_CONNECTOR` = `meta` |

## Paso 1 · Crear la app en Meta

1. Entra a <https://developers.facebook.com> con tu Facebook y acepta ser desarrollador.
2. **Mis apps → Crear app.** Elige el caso de uso de **WhatsApp** (o tipo «Empresa») y asóciala a tu portafolio comercial.
3. En el panel de la app, abre **WhatsApp → Configuración de la API**. Meta crea sola una cuenta de prueba y un **número de prueba**.
4. En «Para», agrega tu teléfono (y hasta cuatro más). A cada uno le llega un código por WhatsApp para confirmarlo.

## Paso 2 · Poner las variables en Railway

En Railway → el servicio del CRM → **Variables**, crea **una variable por dato** (una por renglón, sin pegar dos juntas):

- `META_ACCESS_TOKEN`: el token que muestra «Configuración de la API».
- `META_PHONE_NUMBER_ID`: el «Identificador del número de teléfono».
- `META_APP_SECRET`: la «Clave secreta de la app» (Configuración de la app → Básica → Mostrar).
- `META_VERIFY_TOKEN`: la palabra que inventaste.
- `CHANNEL_CONNECTOR`: `meta`.

Comprueba también que `APP_ORIGIN` sea la dirección pública del CRM (`https://crm-laboratorio-production.up.railway.app`): con ella se arma el enlace de pago que recibe la persona.

Railway vuelve a desplegar solo. Espera a que termine.

## Paso 3 · Comprobar en el CRM

**Operación → Sistema → Conectores → «WhatsApp real · Meta»**:

1. Debe decir **Activo**. Si dice «Faltan datos», la pantalla lista qué variable falta.
2. Pulsa **Probar conexión con Meta**. Si responde con el número y su nombre, el token y el identificador están bien. Si no, el mensaje dice qué pasa (token vencido, identificador equivocado, permiso faltante).
3. En «Asignar un número a una marca», el identificador ya viene escrito: elige la **marca** (por ejemplo GlobalVet) y, si quieres, el curso con el que empieza la conversación. **Asignar número.**

## Paso 4 · Registrar el webhook en Meta

En Meta → tu app → **WhatsApp → Configuración → Webhook**:

1. **URL de devolución de llamada:** la que muestra el CRM en esa misma tarjeta (`https://…/api/webhooks/channel/meta`).
2. **Token de verificación:** la palabra que pusiste en `META_VERIFY_TOKEN`.
3. **Verificar y guardar.** Si falla, casi siempre es que Railway no terminó de desplegar o que la palabra no coincide.
4. En los campos del webhook, **suscríbete a `messages`**.

## Paso 5 · Probar

1. Desde un teléfono de la lista «Para», escribe por WhatsApp al número de prueba: «Hola, ¿cuánto cuesta?».
2. En el CRM, **Conversaciones**: aparece la conversación con tu número y la etiqueta «número real».
3. En tu WhatsApp llega la respuesta del asistente. Prueba «¿Qué temas incluye?» y «Quiero inscribirme».
4. Con la venta de prueba encendida en la marca, te llega el enlace de pago: se abre sin pedir perfil, eliges la tarjeta de prueba que aprueba y la confirmación te llega por WhatsApp.
5. Contesta desde el CRM como asesor: el mensaje te llega al teléfono y sus marcas pasan a entregado y leído.

## Si algo falla

| Lo que ves | Qué significa | Qué hacer |
| --- | --- | --- |
| «El token de Meta venció o no es válido» | El token temporal dura 24 horas | Genera otro en «Configuración de la API» y cámbialo en Railway; para dejarlo fijo, crea un token permanente (abajo) |
| «Meta no encuentra ese número» | `META_PHONE_NUMBER_ID` no es el identificador | Copia el «Identificador del número de teléfono», no el teléfono |
| «No parece un token de Meta» | La variable tiene espacios u otra variable pegada | Deja sólo el token en `META_ACCESS_TOKEN` |
| «No está en la lista de destinatarios permitidos» | El número de prueba sólo escribe a teléfonos confirmados | Agrégalo en «Para» |
| Escribes y no aparece nada en el CRM | El webhook no está suscrito a `messages`, o el número no tiene marca | Revisa el paso 4 y el paso 3; en Conectores → «Últimos eventos recibidos» se ve si llegó y por qué se ignoró |
| «Pasaron más de 24 horas…» | Regla de WhatsApp | La persona debe volver a escribir; las plantillas aprobadas son el siguiente paso |
| Mensaje «No entregado» en el chat | Meta lo rechazó; el motivo queda en el historial de entrega del mensaje | Corrige y pulsa reintentar |

## Token permanente (para que no venza cada día)

En <https://business.facebook.com> → **Configuración del negocio → Usuarios → Usuarios del sistema**: crea un usuario del sistema (administrador), asígnale la app y la cuenta de WhatsApp, y **genera un token** con los permisos `whatsapp_business_messaging` y `whatsapp_business_management`, sin caducidad. Sustituye `META_ACCESS_TOKEN` en Railway.

## Volver atrás

Cambia `CHANNEL_CONNECTOR` a `simulated` (o bórrala) en Railway. Deja de entrar y de salir todo lo real (lo que escriban en ese tiempo no entra al CRM); las conversaciones reales quedan guardadas y sus mensajes nuevos fallan con el motivo «WhatsApp real está apagado». Para pausar un solo número: Conectores → **Pausar**.

## Pasar a clientes reales (después)

1. Verificar la empresa en el Business Manager de la consultora.
2. Agregar un número propio (que deje de usarse en la app de WhatsApp del celular) y aprobar su nombre para mostrar.
3. Poner un método de pago en la cuenta de WhatsApp Business.
4. Asignar ese número a su marca en Conectores.
5. Enviar a aprobación las plantillas para escribir fuera de las 24 horas (pendiente de construir en el CRM).
