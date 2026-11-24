# Relevo del 24 de noviembre de 2026

Nota de traspaso para quien continúe (Codex, Claude u otra persona). Resume dónde quedó todo el 23 y 24 de noviembre de 2026, qué está pendiente y qué **no** hay que tocar. Léela junto con [CLAUDE.md](../CLAUDE.md) y [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md). El código y el repositorio mandan si algo aquí quedara viejo.

## Cómo se trabaja con el dueño

- Hispanohablante, no técnico, escribe rápido y con erratas; delega («lo que tú decidas») pero quiere **ir paso a paso** y que se le diga cuándo algo terminó. Prefiere que las cosas se hagan por el conector MCP cuando se puede.
- **Publicar a producción sólo con su «Sí, publicar»**, uno por push. Flujo: rama (`feat/…`), `npm run check`, `node --test test/*.test.mjs` (820 pruebas), `npm run test:ui` (95 de navegador), prettier, docs al día, pedir «Sí, publicar», `git push origin HEAD:main`, comprobar producción sin sesión (`/api/health`, `/crm` 200, `POST /mcp` sin llave 401) y dejar la rama de trabajo `chore/f0-01-codificacion` apuntando al mismo commit.
- Producción: Railway, `https://crm-laboratorio-production.up.railway.app` (`/crm` equipo, `/` cliente, `/mcp` conector). Esquema `41+35.ad7738ba`, versión 0.34.0.
- Dos reglas de diseño del dueño: **no se pierde ninguna opción y no se inventa ninguna**; configurar debe ser fácil.
- Seguridad: **nunca** tokens, claves, contraseñas ni códigos en el chat ni en capturas; el repositorio es **público**; `data/` está fuera de Git; nunca transcribir números de cuenta ni titulares de la imagen «Datos de pago»; las pruebas en producción usan registros propios y se limpian al terminar.
- El conector MCP de GlobalVet está conectado por OAuth con todos los permisos: sirve para consultar y proponer; aprobar/publicar/encender lo hace una persona en el CRM.

## Lo publicado el 23 y 24 de noviembre (todo en `main`)

| Commit | Qué |
| --- | --- |
| `1982c4a` | La imagen «Datos de pago» acompaña cualquier respuesta aprobada de pagos (antes sólo «cómo pago»). Probado en WhatsApp real. |
| `e5c8964` | Reconocer el curso sin palabras propias («manejo clínico de reptiles» elige el que junta más palabras). |
| `e00e82e` | Bloque de comodidad: `swapPage` conserva desplazamiento y foco; ventanas del equipo con título y acción fijos y a pantalla completa en celular; rastro «Operación · Atención · Coordinación» / «Catálogo · Plantillas»; última pestaña recordada. [PLAN_COMODIDAD.md](PLAN_COMODIDAD.md). |
| `45b11fa` | Buscador de aperturas en Coordinación (curso, apertura, docente, responsable o marca; sin acentos). |
| `789679b` | Editores de plantilla y edición en secciones plegables (`section()` en `catalogue.js`, §13 de `tinta-vistas.css`, manejador global de `invalid` que abre la sección de un campo obligatorio). |
| `3be4ca9` | Secciones plegables en Conocimiento y casos de evaluación. |
| `495cbbe` | (sólo docs, **sin publicar** al escribir esto) Lección de Meta: una cuenta nueva no envía hasta verificar la empresa. |

GlobalVet quedó en **modo real** desde el 23 nov (respuestas sin aviso de prueba, instrucciones e imagen de pago, curso de demostración archivado, 18 cursos activos). Primera apertura con **entrega automática de accesos** encendida y comprobada de punta a punta en WhatsApp real (comprobante → validar en el chat → confirmación → accesos con el enlace del grupo). Las otras 17 aperturas esperan su enlace de grupo en Coordinación.

## Meta / WhatsApp real: dónde quedó (lo más importante)

**Decisión del 24 nov:** todo el WhatsApp real del CRM pasa al portafolio oficial de la empresa, **«TEC Capital Group»**, y se rehizo la app ahí (el número anterior era el de prueba de Meta, sin clientes reales, así que rehacer fue más limpio que mover activos).

Identificadores (no son secretos):

- Portafolio **TEC Capital Group**: `business_id` `1863968658118533`. Creado por la cuenta personal real del director (Ricardo). Administradores con acceso total: el director (activo), el dueño del CRM (Miguel, aceptó) y la persona que creó la app anterior (invitada). Las tres son personas reales; una cuenta con nombre inventado se descartó a propósito.
- App **«CRM TEC Capital Group»**: id `2384922005670166`, **publicada**, caso de uso WhatsApp, política de privacidad `https://crm-laboratorio-production.up.railway.app/privacidad`. Webhook `https://crm-laboratorio-production.up.railway.app/api/webhooks/channel/meta` verificado, con `messages`, `message_template_status_update`, `message_template_quality_update`, `account_update` y `phone_number_*` suscritos.
- Cuenta de WhatsApp de prueba (WABA) `1846947353215170` («Test Messaging Account»); número de prueba **+1 (555) 191-9387**, `phone_number_id` `1472345995965106`. Dos celulares registrados como destinatarios de prueba.
- Railway ya apunta a esta app: `META_APP_SECRET`, `META_PHONE_NUMBER_ID`, `META_WABA_ID` y `META_ACCESS_TOKEN` (**token temporal de 24 h**; véase pendientes). `META_VERIFY_TOKEN` y `CHANNEL_CONNECTOR=meta` sin cambio.
- En el CRM (Operación → Sistema → Conectores): «Probar conexión con Meta» responde bien; «Recibir mensajes reales» hecho (Meta entrega a «CRM TEC Capital Group»); el número nuevo asignado a **GlobalVet** con «Todos los cursos de la marca»; el número de la app vieja (`1513640671823162`) **pausado**.
- **Estado real:** los entrantes **llegan** al CRM y el asistente arma la respuesta, pero los salientes fallan con **131031** («Meta bloqueó la cuenta de WhatsApp Business»). Causa confirmada en WhatsApp Manager: **«Cuenta restringida · Antes de poder enviar mensajes, tendrás que verificar tu negocio»**. Meta exige verificación de la empresa a toda cuenta nueva. No es el webhook, ni el token, ni la autenticación en dos pasos, ni que se escriba primero.
- **Verificación de la empresa enviada el 24 nov 2026** (Meta: ~2 días hábiles). Tipo «No registrada aún» (persona física); nombre legal del director como persona física; su domicilio fiscal tal como aparece en la constancia del SAT; comprobación por **dominio** `teccapitalweb.com` (quedó verificado en el portafolio tras publicar la metaetiqueta `facebook-domain-verification` en el `<head>` de `index.html` del repo `teccapitalweb/teccapitalweb`, GitHub Pages, commits `de4121a` y `82b5478`); documentos: constancia del SAT y la factura de la línea telefónica del negocio (a nombre del director). Los documentos los guarda el dueño fuera del repositorio; **no se copian a ningún lado**.
- Portafolio viejo **«TEC Capital»** (`1160083519702397`, creado el 12 nov por quien hizo la app anterior): conserva la app anterior «CRM TEC Capital» (`1786092769282253`) y su número de prueba. **No borrarlo** hasta que el nuevo envíe; después se puede archivar. El dueño también tiene un portafolio «Helados Otto» en su cuenta personal: es suyo y no se toca salvo que él lo pida.
- Incidente menor: un token temporal de la app nueva apareció en una captura dentro del chat. Es temporal (24 h) y se sustituirá por el permanente; al crear el permanente, **generar un nuevo identificador** en el panel de Meta para invalidar los temporales.

### Qué hacer cuando Meta responda la verificación

1. En WhatsApp Manager (`https://business.facebook.com/wa/manage/home/?business_id=1863968658118533`) la cuenta debe dejar de decir «restringida». En el CRM, abrir la conversación de prueba y **Reintentar** el mensaje «No entregado», o escribir «Hola» al número de prueba desde un celular registrado. Debe contestar el asistente de GlobalVet.
2. **Token permanente**: Meta Business Suite → Configuración → Usuarios → **Usuarios del sistema** → crear uno (administrador) → asignarle la app «CRM TEC Capital Group» y la cuenta de WhatsApp → **Generar token** sin caducidad con `whatsapp_business_messaging` y `whatsapp_business_management` → ponerlo en Railway en `META_ACCESS_TOKEN` (sólo en Railway). Después, en la app → Paso 1. Probar → «Generar nuevo identificador» para invalidar los temporales. Guía: [ACTIVAR_WHATSAPP_REAL.md](ACTIVAR_WHATSAPP_REAL.md), «Token permanente».
3. **Plantillas**: en el CRM → Conectores → plantillas → volver a mandar a aprobación las de GlobalVet (las aprobadas pertenecían a la cuenta vieja).
4. Comprobar con «Probar conexión con Meta» y «Salud» que todo está en verde; luego el ciclo completo (hola → ficha → inscribirme → comprobante → validar → accesos).
5. Si Meta **rechaza** la verificación: el motivo llega por correo y al Centro de seguridad; casi siempre es que el nombre o la dirección no coinciden con el documento, o el documento no es reciente. Corregir y reenviar.
6. **Números reales por consultora** (después): agregar el número en la cuenta de WhatsApp del portafolio, aprobar nombre para mostrar, método de pago en la cuenta, y en el CRM asignarlo a su marca. Un número no puede estar a la vez en la app del celular y en la API.

### Lo que NO hay que tocar en Meta

- En el **Centro de seguridad** del portafolio, los botones «Realizar una acción» de «usuarios sin passkey» y «usuarios con correo público» **quitan administradores** (al director o al dueño del CRM). No son requisitos de WhatsApp.
- «Verifica tu identidad o una organización» en «Autorizaciones y verificaciones» es para anuncios, no para WhatsApp.
- «Conviértete en proveedor de tecnología» es el camino para vender el CRM a terceros (cada cliente conecta su WhatsApp con registro integrado, token por cliente); queda para el futuro y requiere un cambio en el CRM (token por marca/cliente).

## Pendientes del dueño (sin prisa, en orden)

1. Esperar la verificación de Meta y hacer los pasos de arriba (token permanente incluido).
2. Pegar los **enlaces de grupo** de WhatsApp de los otros 17 cursos de GlobalVet en Operación → Coordinación (ya hay buscador) y encender su entrega en Ventas → Accesos. Cuando exista el grupo real de «Estrés en reptiles», cambiar el enlace de prueba que tiene hoy.
3. Aprobar en Ajustes → **Propuestas del asistente** la publicación del recorrido «Entrada por anuncio» (sólo quita la frase «Te comparto la información del curso» del saludo).
4. Seguridad: revocar la llave vieja «Asistente recorridos» en Ajustes → Asistentes conectados; borrar `ADMIN_RECOVERY_CODE` de Railway.
5. Opcional: crear un correo `@teccapitalweb.com` (reenvío desde Spaceship, donde está el dominio) para trámites futuros con Meta.

## Pendientes de desarrollo (ideas acordadas, no empezadas)

- Comodidad, siguiente tramo: repintar sólo la tarjeta afectada en vez de toda la vista; recordar filtro y búsqueda de Operación entre recargas.
- Preparar la llegada de 60 marcas: hacer más rápida el alta de cada consultora («Preparar marca», carga inicial por el conector).
- Seguir afinando el asistente con lo aprendido en WhatsApp real; reportes del dueño.
- Prueba de navegador «propuestas por lote» en celular es inestable cuando corre toda la suite (pasa sola): hacerla determinista.
- Proveedor de tecnología (token por cliente) cuando se quiera vender a terceros.

## Memoria de sesión (fuera del repo)

Las notas del asistente viven en `~/.claude/projects/…/memory/` (índice `MEMORY.md`): contexto del dueño, flujo de trabajo, estado de Meta (`meta-portafolio-oficial.md`), cobros y «Datos de pago», feedback de comodidad. Si quien sigue no es Claude, este documento y CLAUDE.md contienen lo esencial.
